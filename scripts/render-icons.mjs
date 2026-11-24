#!/usr/bin/env node
// Makes every icon file from the one drawing, shared/icon.svg (the 2026-11 rebrand mark "U2": UK
// level crossing lights in sea blue on a post, on a sand tile):
//
//   shared/icon-180.png           iPhone home screen (apple-touch-icon). Full-bleed sand, no rounded
//                                 tile: iOS rounds the corners itself and paints any transparency black.
//   shared/icon-192.png, -512.png the web-app manifests ("any"); the 512 is also the og:image.
//   shared/icon-maskable-512.png  Android adaptive icon: full-bleed sand, the drawing shrunk into the
//                                 central safe circle (radius 40%) so no launcher mask can clip it.
//   favicon.ico                   at the site root, 16 + 32 + 48 px. Browsers and link-preview tools
//                                 ask for /favicon.ico before reading any <link>; it used to 404.
//
// Run on the Mac (needs Google Chrome) after changing shared/icon.svg:  node scripts/render-icons.mjs
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const svg = readFileSync(join(ROOT, 'shared', 'icon.svg'), 'utf8');
// The sand tile is the first <rect> in the drawing. Full-bleed versions drop it and paint the whole
// square instead, so a launcher's own corner mask is the only rounding.
const TILE = /<rect x="0\.6" y="0\.6" width="62\.8" height="62\.8" rx="13\.5" fill="(#[0-9A-Fa-f]{6})"[^>]*\/>/;
const m = svg.match(TILE);
if (!m) throw new Error('shared/icon.svg: cannot find the sand tile <rect> (has the drawing changed?)');
const SAND = m[1];
const bare = svg.replace(TILE, '');
const uri = s => 'data:image/svg+xml;base64,' + Buffer.from(s).toString('base64');

// What to draw for each file: the size, and the drawing's scale on a full-bleed ground (null = the
// rounded tile on transparent).
const JOBS = [
  { file: 'shared/icon-180.png', size: 180, bleed: 1 },
  { file: 'shared/icon-192.png', size: 192, bleed: null },
  { file: 'shared/icon-512.png', size: 512, bleed: null },
  { file: 'shared/icon-maskable-512.png', size: 512, bleed: 0.74 },
  { ico: 16, bleed: null }, { ico: 32, bleed: null }, { ico: 48, bleed: null }
];
const html = j => {
  const s = j.size || j.ico;
  const img = j.bleed ? uri(bare) : uri(svg);
  const inner = j.bleed ? Math.round(s * j.bleed) : s;
  return `<!doctype html><html><head><style>html,body{margin:0;background:transparent}
#c{width:${s}px;height:${s}px;display:flex;align-items:center;justify-content:center;background:${j.bleed ? SAND : 'transparent'}}
#c img{width:${inner}px;height:${inner}px;display:block}</style></head><body><div id="c"><img src="${img}"></div></body></html>`;
};

const port = 9700 + Math.floor(Math.random() * 200);
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'icons-'))}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let target;
for (let i = 0; i < 100 && !target; i++) {
  await sleep(150);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch {}
}
if (!target) { console.error('Chrome did not start'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.readyState === 1 ? r() : ws.addEventListener('open', r));
let id = 0; const waiting = {};
ws.addEventListener('message', e => { const d = JSON.parse(e.data); if (d.id && waiting[d.id]) { waiting[d.id](d); delete waiting[d.id]; } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; waiting[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });

const icoParts = [];
try {
  await send('Page.enable');
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  for (const j of JOBS) {
    const s = j.size || j.ico;
    await send('Emulation.setDeviceMetricsOverride', { width: s, height: s, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(html(j)).toString('base64') });
    await sleep(600);
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: s, height: s, scale: 1 } });
    const png = Buffer.from(shot.result.data, 'base64');
    if (j.file) { writeFileSync(join(ROOT, j.file), png); console.log(`${j.file}  ${s}x${s}  ${png.length} bytes`); }
    else icoParts.push({ size: s, png });
  }
} finally { ws.close(); chrome.kill(); }

// favicon.ico: an ICONDIR header, one 16-byte entry per size, then each image as PNG (allowed in ICO
// since Windows Vista; every current browser reads it).
const head = Buffer.alloc(6 + 16 * icoParts.length);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(icoParts.length, 4);
let offset = head.length;
icoParts.forEach((p, i) => {
  const o = 6 + 16 * i;
  head.writeUInt8(p.size >= 256 ? 0 : p.size, o); head.writeUInt8(p.size >= 256 ? 0 : p.size, o + 1);
  head.writeUInt8(0, o + 2); head.writeUInt8(0, o + 3);
  head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
  head.writeUInt32LE(p.png.length, o + 8); head.writeUInt32LE(offset, o + 12);
  offset += p.png.length;
});
const ico = Buffer.concat([head, ...icoParts.map(p => p.png)]);
writeFileSync(join(ROOT, 'favicon.ico'), ico);
console.log(`favicon.ico  ${icoParts.map(p => p.size).join(' + ')} px  ${ico.length} bytes`);
