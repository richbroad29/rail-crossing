'use strict';

// The end-to-end test rig shared by td-measure.run.test.js and feeds-check.test.js: a fake STOMP
// server, a fake /health, a throwaway .env with a password that has every awkward character in it,
// an out folder, captured stdout/stderr and a fake signal emitter. Everything it creates is
// registered in the caller's `cleanups` array, which the test file's afterEach drains.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { FakeStompServer } = require('./fake-stomp-server');
const { FakeHealth } = require('./fake-health');

const LOGIN = 'tester@example.com';
const PASS = 'p$ss"w\\rd:x';

/**
 * @param {function[]} cleanups  the caller's cleanup list
 * @param {object} baseOpts      script-specific options merged into every run's `opts`
 *                               (td-measure: {minutes: 1}; feeds-check: {minutes: {...}, only: null})
 */
function makeRig(cleanups, baseOpts) {
  return async function rig({ stompOpts, healthBody, healthUp = true, pass = PASS, interlockPoll = 40, extraDeps = {}, extraOpts = {} } = {}) {
    const srv = new FakeStompServer({ login: LOGIN, passcode: PASS, ...stompOpts });
    await srv.listen();
    cleanups.push(() => srv.close());
    const health = new FakeHealth(healthBody);
    await health.listen();
    if (!healthUp) await health.close(); else cleanups.push(() => health.close());

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase0-run-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, `NR_FEED_USER=${LOGIN}\nNR_FEED_PASS=${pass}\n`);

    const out = [], err = [], exits = [];
    const signals = new EventEmitter();
    const opts = {
      envFile, healthUrl: health.url, tdLogDir: path.join(dir, 'tdlogs'), outDir: path.join(dir, 'out'),
      interlock: true, stomp: { host: '127.0.0.1', port: srv.port }, debug: false, ...baseOpts, ...extraOpts
    };
    const deps = {
      durationMs: 1200, sampleMs: 40, bucketMs: 400, settleMs: 0, interlockConfig: { pollMs: interlockPoll },
      signals, stdout: { write: s => out.push(s) }, stderr: { write: s => err.push(s) }, forceExit: c => exits.push(c),
      ...extraDeps
    };
    const readReport = () => {
      const files = fs.existsSync(opts.outDir) && fs.statSync(opts.outDir).isDirectory() ? fs.readdirSync(opts.outDir) : [];
      const json = files.find(f => f.endsWith('.json'));
      return json ? JSON.parse(fs.readFileSync(path.join(opts.outDir, json), 'utf8')) : null;
    };
    const readText = () => {
      const files = fs.existsSync(opts.outDir) && fs.statSync(opts.outDir).isDirectory() ? fs.readdirSync(opts.outDir) : [];
      const txt = files.find(f => f.endsWith('.txt'));
      return txt ? fs.readFileSync(path.join(opts.outDir, txt), 'utf8') : null;
    };
    const filesText = () => (fs.existsSync(opts.outDir) && fs.statSync(opts.outDir).isDirectory()
      ? fs.readdirSync(opts.outDir).map(f => fs.readFileSync(path.join(opts.outDir, f), 'utf8')).join('\n') : '');
    return { srv, health, dir, opts, deps, out, err, exits, signals, readReport, readText, filesText, text: () => out.join('') + err.join('') };
  };
}

const check = (report, id) => report.checks.find(c => c.id === id);

/** Assert that none of the credentials (in any of the forms they might leak in) is in `text`. */
function noSecrets(text) {
  const basic = Buffer.from(`${LOGIN}:${PASS}`).toString('base64');
  for (const s of [LOGIN, PASS, JSON.stringify(PASS).slice(1, -1), basic, encodeURIComponent(PASS)]) {
    assert.ok(!text.includes(s), `secret leaked: ${s.slice(0, 6)}...`);
  }
}

module.exports = { makeRig, check, noSecrets, LOGIN, PASS };
