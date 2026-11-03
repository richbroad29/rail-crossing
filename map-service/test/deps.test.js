'use strict';

// A missing dependency must FAIL, fast and loudly, never hang (the phase-1 review finding: with
// node_modules absent `npm test` sat for ten minutes in the reconnect loop).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { requireDeps, declared } = require('../src/deps');
const { TdIngest } = require('../src/td-ingest');
const stomp = require('../src/stomp');
const { config, tmpDir, rmrf, captureLog } = require('./helpers');
const log = require('../src/log');

const ROOT = path.join(__dirname, '..');

test('requireDeps: passes when everything resolves; otherwise ONE sentence naming what is missing and how to fix it', () => {
  assert.deepEqual(requireDeps(), ['stompit']);
  assert.deepEqual(declared(), ['stompit']);
  assert.throws(() => requireDeps({ names: ['stompit', 'nope-a', 'nope-b'], resolve: n => { if (n.startsWith('nope')) throw new Error('x'); } }),
    e => e.code === 'MISSING_DEPENDENCY' && /Missing dependencies: nope-a, nope-b\. Run "npm ci"/.test(e.message));
  assert.throws(() => requireDeps({ names: ['one'], resolve: () => { throw new Error('x'); } }), /Missing dependency: one\./);
});

/** A copy of the service WITHOUT node_modules, in a temp folder. */
function bare() {
  const dir = tmpDir('bare-');
  for (const d of ['bin', 'src', 'config']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  return dir;
}

test('THE EXECUTABLE without node_modules exits 2 within seconds, saying so (it used to start and retry forever)', async () => {
  const dir = bare();
  try {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.join(dir, 'bin', 'rail-map.js')], { encoding: 'utf8', timeout: 20000, env: { ...process.env, MAP_DATA_DIR: tmpDir('d-') } });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /ERROR start: Missing dependency: stompit\. Run "npm ci"/);
    assert.ok(Date.now() - t0 < 10000);
  } finally { rmrf(dir); }
});

test('`npm test`\'s pretest check (scripts/check-deps.js) exits 2 with a sentence when node_modules is missing, 0 when present', () => {
  const dir = bare();
  try {
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(path.join(ROOT, 'scripts', 'check-deps.js'), path.join(dir, 'scripts', 'check-deps.js'));
    const bad = spawnSync(process.execPath, [path.join(dir, 'scripts', 'check-deps.js')], { encoding: 'utf8', timeout: 10000 });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /Missing dependency: stompit/);
    const good = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-deps.js')], { encoding: 'utf8', timeout: 10000 });
    assert.equal(good.status, 0, good.stderr);
  } finally { rmrf(dir); }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.pretest, 'node scripts/check-deps.js');
  assert.match(pkg.scripts.test, /--test-timeout=\d+/, 'a hang in any test fails the run instead of waiting forever');
});

test('App.start() rejects at once with MISSING_DEPENDENCY when a dependency is missing, instead of starting a feed that can never connect', () => {
  const dir = bare();
  try {
    const code = `
      const { loadConfig } = require('./src/config'); const { App } = require('./src/app');
      const c = loadConfig({ env: {}, argv: [], overrides: { port: 0 } });
      new App({ config: c.config, dataDir: process.argv[1], fake: { host: '127.0.0.1', port: 1, refDir: process.argv[1] } }).start()
        .then(() => { console.log('STARTED'); process.exit(0); }, e => { console.log('REJECTED ' + e.code); process.exit(0); });`;
    const r = spawnSync(process.execPath, ['-e', code, tmpDir('d-')], { cwd: dir, encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /REJECTED MISSING_DEPENDENCY/);
  } finally { rmrf(dir); }
});

test('the TD loop treats a missing stompit as FATAL: one error line, no endless backoff', async () => {
  const cap = captureLog();
  stomp._resetForTest();
  try {
    let attempts = 0;
    const ing = new TdIngest({
      config: { ...config().td, backoffMinMs: 5, backoffMaxMs: 10 }, creds: { user: 'u', pass: 'password' }, host: '127.0.0.1', port: 1, onEvent: () => {},
      open: async () => { attempts++; throw Object.assign(new Error('the "stompit" package is not installed (run "npm ci")'), { kind: 'missing-dependency' }); },
      sleep: () => new Promise(r => setTimeout(r, 5))
    });
    const fatal = new Promise(r => ing.once('fatal', r));
    ing.start();
    await Promise.race([fatal, new Promise((_, rej) => setTimeout(() => rej(new Error('no fatal event: the loop kept retrying')), 3000))]);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(attempts, 1, 'tried once, then stopped');
    assert.equal(ing.running, false);
    assert.ok(ing.fatal);
    assert.equal(cap.lines.filter(l => /ERROR td: .*live feed is OFF/.test(l)).length, 1);
    await ing.stop();
  } finally { cap.restore(); log.resetForTest(); stomp._resetForTest(); }
});

test('stomp.defaultConnect classifies a missing stompit as kind "missing-dependency" (not a network error)', async () => {
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function (request, ...rest) { if (request === 'stompit') { const e = new Error("Cannot find module 'stompit'"); e.code = 'MODULE_NOT_FOUND'; throw e; } return origLoad.call(this, request, ...rest); };
  stomp._resetForTest();
  try {
    await assert.rejects(stomp.openSession({ creds: { user: 'u', pass: 'password' }, host: '127.0.0.1', port: 1, connectTimeoutMs: 500 }), e => e.kind === 'missing-dependency');
  } finally { Module._load = origLoad; stomp._resetForTest(); }
});
