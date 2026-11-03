'use strict';
// Shared plumbing for the browser checks: start the mock service and a static file server, launch
// Chrome, open the page. Run through run.js (it sets RM_VISUAL=1); these scripts are deliberately
// NOT unit tests and are not picked up by `node --test map/test/*.test.js`.
if (!process.env.RM_VISUAL) {
  console.log('This is a browser check, not a unit test. Run:  node map/test/visual/run.js   (see README.md)');
  process.exit(0);
}
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const REPO = path.resolve(__dirname, '../../..');
const CFG = {
  chrome: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  out: process.env.OUT || path.join(__dirname, 'out'),
  mockPort: +(process.env.MOCK_PORT || 3100),
  webPort: +(process.env.WEB_PORT || 8080),
  trains: +(process.env.TRAINS || 1500)
};
fs.mkdirSync(CFG.out, { recursive: true });
const API = 'http://localhost:' + CFG.mockPort;
const PAGE = 'http://127.0.0.1:' + CFG.webPort + '/map/index.html?api=' + API;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
function startStatic() {
  const srv = http.createServer((req, res) => {
    const p = path.normalize(path.join(REPO, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!p.startsWith(REPO) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((r) => srv.listen(CFG.webPort, '127.0.0.1', () => r(srv)));
}
function startMock() {
  const child = spawn(process.execPath, [path.join(REPO, 'map/dev/mock-api.js'), '--port', String(CFG.mockPort), '--count', String(CFG.trains), '--national'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((resolve, reject) => {
    child.stderr.on('data', (d) => { if (/mock map API on/.test(String(d))) resolve(child); });
    child.on('exit', (c) => reject(new Error('mock exited ' + c)));
    setTimeout(() => reject(new Error('mock did not start')), 60000);
  });
}
async function servers() {
  const [web, mock] = await Promise.all([startStatic(), startMock()]);
  return { stop() { web.close(); mock.kill(); } };
}
const setMock = (q) => fetch(API + '/__mock/set?' + q).then((r) => r.json());

async function launch() {
  return chromium.launch({ executablePath: CFG.chrome, headless: true });
}
// Open the page and wait until trains have arrived.
async function open(browser, opts = {}, hash = '', query = '') {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }, opts));
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => { if (!(r.failure() && /ABORTED/.test(r.failure().errorText))) errors.push('requestfailed: ' + r.url().slice(0, 100)); });
  await page.goto(PAGE + query + hash, { waitUntil: 'load' });
  await page.waitForFunction(() => window.RM && RM.debug && RM.debug.store && RM.debug.store.size > 0, null, { timeout: 30000 });
  return { page, ctx, errors };
}
const shot = (page, name) => page.screenshot({ path: path.join(CFG.out, name + '.png') }).then(() => path.join(CFG.out, name + '.png'));

module.exports = { CFG, API, PAGE, servers, startStatic, setMock, launch, open, shot, REPO };
