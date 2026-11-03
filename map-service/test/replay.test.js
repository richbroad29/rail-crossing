'use strict';

// End to end: a real TD log, through the fake NROD, the real STOMP client and the real service;
// and the real executable under a real SIGTERM.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { runReplay, summarise, spotCheck } = require('../dev/replay-report');
const { FakeNrod } = require('../dev/fake-nrod');
const { FIX, REAL, haveReal, fixtureRefDir, tmpDir, rmrf, get, getJson, until, sleep } = require('./helpers');
const { haversineKm } = require('../src/geo');
const SMALL = { reference: { minRows: { smart: 10, corpus: 10, naptan: 10, cif: 1 } } };   // the fixtures are small extracts
const R = require('../src/reference');
const { BerthGraph } = require('../src/berth-graph');

test('FIXTURE REPLAY: 800 real LA events through the fake NROD and the real service', async () => {
  const refDir = fixtureRefDir();
  const res = await runReplay({ file: path.join(FIX, 'td-la-fixture.jsonl'), refDir, speed: 'max', overrides: SMALL });
  try {
    assert.equal(res.sent.events, 800);
    assert.equal(res.stats.CA + res.stats.CB + res.stats.CC, 800, 'every event reached the model');
    assert.equal(res.stats.malformed, 0);
    const s = summarise(res, 'LA');
    assert.ok(s.trains > 30, `${s.trains} trains`);
    assert.ok(s.atSight.placed / s.trains > 0.9, `${s.atSight.placed}/${s.trains} placed`);
    // Identity: renumbering happened (the real log has CB+CC pairs on one berth).
    assert.ok(res.stats.renumbered > 0);
    // Every placed train sits exactly where the graph says its berth is.
    const g = res.app.graph;
    for (const t of res.app.model.placed()) {
      const p = g.position(t.keyId);
      assert.deepEqual([t.lat, t.lon], [p.lat, p.lon]);
    }
  } finally { await res.stop(); rmrf(refDir); }
});

test('FIXTURE REPLAY: a placed train served over HTTP is where SMART says (Portslade 0002/0005, Southwick 0006)', async () => {
  const refDir = fixtureRefDir();
  const res = await runReplay({ file: path.join(FIX, 'td-la-fixture.jsonl'), refDir, speed: 'max', overrides: SMALL });
  try {
    const g = res.app.graph;
    const near = (berth, name, lat, lon) => {
      const p = g.position(g.lookup('LA', berth));
      assert.equal(p.station, name);
      assert.ok(haversineKm(p, { lat, lon }) < 0.001, `${berth} at ${name}`);
    };
    near('0002', 'Portslade', 50.83568251454, -0.20533641991);
    near('0005', 'Portslade', 50.83568251454, -0.20533641991);
    near('0006', 'Southwick', 50.83251623943, -0.23596179586);
  } finally { await res.stop(); rmrf(refDir); }
});

test('REAL DAY REPLAY: td-2026-11-01 (3,774 events) with the real SMART/CORPUS/NaPTAN (skipped without the reference files)', { skip: !haveReal || !fs.existsSync(path.join(REAL, 'td-2026-11-01.jsonl')) }, async () => {
  const res = await runReplay({ file: path.join(REAL, 'td-2026-11-01.jsonl'), refDir: REAL, speed: 'max' });
  try {
    assert.equal(res.sent.events, 3774);
    assert.equal(res.stats.CA + res.stats.CB + res.stats.CC, 3774);
    const s = summarise(res, 'LA');
    assert.ok(s.trains >= 200, `${s.trains} LA trains`);
    assert.ok(s.atSight.placed / s.trains > 0.95, `placed ${s.atSight.placed}/${s.trains}`);
    assert.ok(s.berthsVisited.total >= 70 && s.berthsVisited.unplaced <= 3, JSON.stringify(s.berthsVisited));
    // Spot checks against SMART: each station-placed train sits at the station SMART's arrival/departure rows name.
    const checks = await spotCheck(res, { smartFile: path.join(REAL, 'smart-latest.json.gz') });
    assert.equal(checks.length, 5);
    for (const c of checks) assert.ok(c.smartRows.length >= 1, `${c.berth} (${c.placedAt}) has a SMART row anchoring it`);
  } finally { await res.stop(); }
});

test('THE EXECUTABLE: bin/rail-map.js in fake mode serves, learns, and on SIGTERM saves the graph and exits 0', async () => {
  const refDir = fixtureRefDir(), dataDir = tmpDir('proc-');
  const fake = new FakeNrod({ mode: 'replay', file: path.join(FIX, 'td-la-fixture.jsonl'), speed: 'max' });
  const stompPort = await fake.start();
  const port = 35000 + Math.floor(Math.random() * 2000);
  let out = '';
  const cfgFile = path.join(dataDir, '..', `cfg-${process.pid}.json`);
  fs.writeFileSync(cfgFile, JSON.stringify(SMALL));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'rail-map.js'), `--fake=127.0.0.1:${stompPort}`, `--ref-dir=${refDir}`], {
    env: { ...process.env, PORT: String(port), MAP_DATA_DIR: dataDir, MAP_ENV_FILE: '/nonexistent/.env', MAP_CONFIG_FILE: cfgFile }, stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  const exited = new Promise(r => child.on('exit', (code, sig) => r({ code, sig })));
  try {
    await until(() => out.includes('http: listening'), 8000, 'listening');
    await fake.done;
    await until(async () => true, 10);
    let h;
    for (let i = 0; i < 40; i++) { h = (await getJson(port, '/map/v1/health')).json; if (h.model.trains > 5) break; await sleep(100); }
    assert.ok(h.model.trains > 5, JSON.stringify(h));
    assert.equal(h.feeds.td.connected, true);
    assert.ok(h.model.learnedEdges > 0);
    let trains;
    for (let i = 0; i < 40; i++) { trains = (await getJson(port, '/map/v1/trains')).json; if (trains.trains.length > 0) break; await sleep(100); }   // the snapshot is rebuilt once a second
    assert.ok(trains.trains.length > 0);
    child.kill('SIGTERM');
    const { code } = await exited;
    assert.equal(code, 0);
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'state', 'learned-graph.json'), 'utf8'));
    assert.equal(saved.version, 1);
    assert.ok(saved.edges.length > 0, 'the learned graph was saved on SIGTERM');
    assert.ok(out.includes('SIGTERM: shutting down'));
    assert.ok(!/at .*\.js:\d+/.test(out), 'no stack trace in the output');
    // Nothing was written outside the data folder.
    assert.deepEqual(fs.readdirSync(dataDir).sort(), ['state']);
    // A restart restores it.
    const g = new BerthGraph();
    assert.equal(g.loadLearnedFile(path.join(dataDir, 'state', 'learned-graph.json')), saved.edges.length);
  } finally { try { child.kill('SIGKILL'); } catch (_) { /* gone */ } await fake.stop(); rmrf(refDir); rmrf(dataDir); rmrf(cfgFile); }
});

test('the executable refuses a non-loopback fake host and a missing reference folder, with a sentence and exit 2', async () => {
  for (const args of [['--fake=10.1.2.3:61613', '--ref-dir=/tmp'], ['--fake=127.0.0.1:61613'], ['--bogus']]) {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'rail-map.js'), ...args], { env: { ...process.env, MAP_DATA_DIR: tmpDir('x-') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    const code = await new Promise(r => child.on('exit', c => r(c)));
    assert.equal(code, 2, args.join(' '));
    assert.match(out, /^ERROR start: /m);
  }
});
