'use strict';

// Logging and redaction, credentials parsing, configuration, bbox parsing, the snapshot caches, the
// fake NROD, and the systemd unit.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const log = require('../src/log');
const { parseEnv, redact, secretsFor, feedCredentials } = require('../src/env');
const { loadConfig, parseFake } = require('../src/config');
const { parseBbox, inBbox, bboxDeg2, bearingDeg, haversineKm } = require('../src/geo');
const { Snapshot } = require('../src/snapshot');
const { FakeNrod, Synthetic, readSmartChains, mulberry32 } = require('../dev/fake-nrod');
const { FIX, tmpDir, rmrf, fixtureRefDir, makeModel, sleep } = require('./helpers');
const net = require('net');

const PASS = 'p$i$d"x\\y';
const USER = 'rich@example.com';

test('log: one plain line, secrets redacted in every form, newlines collapsed, long lines cut, no stack', () => {
  const lines = [];
  log.setSink(l => lines.push(l));
  try {
    log.addSecrets(secretsFor({ user: USER, pass: PASS }));
    log.info(`login ${USER} with ${PASS} / ${JSON.stringify(PASS)} / ${Buffer.from(`${USER}:${PASS}`).toString('base64')} / ${encodeURIComponent(PASS)}`);
    log.warn('two\nlines\r\nand\ttabs');
    log.error('x'.repeat(5000));
    const e = new Error('boom'); e.code = 'EFAIL';
    log.error(`failed (${log.errText(e)})`);
    log.warn(log.errText(null) + log.errText('plain') + log.errText({}));
    const all = lines.join('\n');
    for (const secret of [PASS, USER, JSON.stringify(PASS).slice(1, -1), encodeURIComponent(PASS), Buffer.from(`${USER}:${PASS}`).toString('base64')]) assert.ok(!all.includes(secret), `leaked: ${secret}`);
    assert.ok(lines.every(l => !l.includes('\n')));
    assert.ok(lines[2].length <= 610);
    assert.equal(lines[3], 'ERROR failed (boom [EFAIL])');
    assert.ok(lines[0].startsWith('INFO '));
    log.setSink(() => { throw new Error('stdout closed'); });
    assert.doesNotThrow(() => log.info('into a broken sink'));
  } finally { log.setSink(null); log.resetForTest(); }
});

test('env: read literally like systemd (a `$` stays a `$`), quotes stripped, comments and junk ignored', () => {
  const e = parseEnv(`# comment\nNR_FEED_USER=${USER}\nNR_FEED_PASS=${PASS}\nexport QUOTED="abc def"\nSINGLE='x=y'\n  SPACED  =  v \nbad line\n=novalue\n1BAD=x\nEMPTY=\n`);
  assert.equal(e.NR_FEED_PASS, PASS);
  assert.deepEqual([e.NR_FEED_USER, e.QUOTED, e.SINGLE, e.SPACED, e.EMPTY], [USER, 'abc def', 'x=y', 'v', '']);
  assert.equal(e['1BAD'], undefined);
  assert.deepEqual(feedCredentials(e, 'f'), { user: USER, pass: PASS });
  assert.throws(() => feedCredentials({ NR_FEED_USER: 'a' }, '/x/.env'), /NR_FEED_USER and NR_FEED_PASS must both be set in \/x\/\.env/);
  assert.equal(redact(`a ${PASS} b`, [PASS]), 'a *** b');
});

test('config: defaults, PORT, MAP_DATA_DIR, MAP_ENV_FILE, MAP_CONFIG_FILE, and fake mode is loopback-only', () => {
  const d = loadConfig({ env: {}, argv: [] });
  assert.equal(d.config.port, 3100);
  assert.equal(d.config.host, '127.0.0.1');
  assert.match(d.dataDir, /rail-map-data$/);
  assert.match(d.envFile, /rail-crossing\/backend\/\.env$/);
  assert.equal(d.fake, null);
  assert.equal(d.config.http.maxSseClients, 300);
  assert.equal(d.config.model.maxIdleSecs, 2700);
  assert.equal(d.config.model.cancelledKeepSecs, 120);
  assert.equal(d.config.model.handoverSecs, 90);
  assert.equal(d.config.http.coarseBboxDeg2, 25);
  const e = loadConfig({ env: { PORT: '4000', MAP_DATA_DIR: '/tmp/x', MAP_ENV_FILE: '/tmp/e' }, argv: [] });
  assert.deepEqual([e.config.port, e.dataDir, e.envFile], [4000, '/tmp/x', '/tmp/e']);
  assert.throws(() => loadConfig({ env: { PORT: 'abc' }, argv: [] }), /PORT/);
  assert.throws(() => loadConfig({ env: { PORT: '70000' }, argv: [] }), /PORT/);
  const f = loadConfig({ env: {}, argv: ['--fake=127.0.0.1:5555', '--ref-dir=/tmp/ref'] });
  assert.deepEqual(f.fake, { host: '127.0.0.1', port: 5555, refDir: '/tmp/ref' });
  assert.equal(loadConfig({ env: { MAP_FAKE_NROD: 'localhost:6000', MAP_REF_DIR: '/tmp/r' }, argv: [] }).fake.port, 6000);
  assert.equal(parseFake(true).port, 61613);
  for (const bad of ['10.0.0.1:61613', 'publicdatafeeds.networkrail.co.uk:61618', 'evil.example', '127.0.0.1.evil.com:1', '0.0.0.0:1']) assert.throws(() => parseFake(bad), /must be on this machine/);
  assert.throws(() => parseFake('127.0.0.1:99999'), /port/);
  assert.throws(() => loadConfig({ env: {}, argv: ['--fake'] }), /--ref-dir/);
  assert.throws(() => loadConfig({ env: {}, argv: ['--nonsense'] }), /Unknown argument/);
  assert.throws(() => loadConfig({ env: {}, argv: ['positional'] }), /Unknown argument/);
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ http: { maxSseClients: 7 } }));
    const m = loadConfig({ env: { MAP_CONFIG_FILE: path.join(dir, 'c.json') }, argv: [] });
    assert.equal(m.config.http.maxSseClients, 7);
    assert.equal(m.config.http.pingSecs, 20, 'merged, not replaced');
    assert.throws(() => loadConfig({ env: { MAP_CONFIG_FILE: path.join(dir, 'missing.json') }, argv: [] }), /MAP_CONFIG_FILE/);
  } finally { rmrf(dir); }
});

test('bbox parsing: four finite in-range numbers, S<=N, W<=E', () => {
  assert.deepEqual(parseBbox('50.7,-0.4,50.95,-0.1'), { s: 50.7, w: -0.4, n: 50.95, e: -0.1 });
  assert.deepEqual(parseBbox(' 1 , 2 , 3 , 4 '), { s: 1, w: 2, n: 3, e: 4 });
  for (const bad of [null, undefined, '', 'a,b,c,d', '1,2,3', '1,2,3,4,5', '5,0,4,1', '1,5,2,4', '-91,0,0,1', '0,0,91,1', '0,-181,1,0', '0,0,1,181', 'NaN,0,1,1', '1e999,0,1,1', 'x'.repeat(200)]) assert.equal(parseBbox(bad), null, String(bad));
  const b = parseBbox('0,0,10,10');
  assert.ok(inBbox(0, 0, b) && inBbox(10, 10, b) && !inBbox(10.01, 5, b));
  assert.equal(bboxDeg2(b), 100);
});

test('geo: bearing and distance', () => {
  const a = { lat: 51, lon: 0 };
  assert.ok(Math.abs(bearingDeg(a, { lat: 52, lon: 0 }) - 0) < 0.01);
  assert.ok(Math.abs(bearingDeg(a, { lat: 51, lon: 1 }) - 90) < 0.5);
  assert.ok(Math.abs(bearingDeg(a, { lat: 50, lon: 0 }) - 180) < 0.01);
  assert.equal(bearingDeg(a, { lat: 51.00001, lon: 0 }), null, 'closer than 20 m: no heading');
  assert.equal(bearingDeg(null, a), null);
  assert.ok(Math.abs(haversineKm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 111.19) < 0.1);
});

test('headings: a step produces a heading from the previous position; a berth that does not move keeps the last one', () => {
  const { model: m, graph: g } = makeModel();
  const st = { 1: { key: 'A', name: 'A', lat: 51.0, lon: -1.0, crs: 'AAA' }, 2: { key: 'B', name: 'B', lat: 51.0, lon: -0.9, crs: 'BBB' } };
  g.loadSmart({ rows: 2, area: ['LA', 'LA'], from: ['0000', '0001'], to: ['0001', '0002'], stanox: ['1', '2'], event: ['A', 'A'] }, s => st[s] || null);
  m.apply({ type: 'CC', area: 'LA', descr: 'TEST', to: '0001', ts: 1 });
  assert.equal(m.byId.values().next().value.hdg, null, 'an interposed train has no heading yet');
  m.apply({ type: 'CA', area: 'LA', descr: 'TEST', from: '0001', to: '0002', ts: 2 });
  const t = m.byId.values().next().value;
  assert.ok(Math.abs(t.hdg - 90) <= 1, `eastbound is ~90, got ${t.hdg}`);
  m.apply({ type: 'CB', area: 'LA', descr: 'TEST', from: '0002', ts: 3 });
  m.apply({ type: 'CC', area: 'LA', descr: 'TEST2', to: '0002', ts: 4 });     // renumbered: same train, no step
  assert.ok(Math.abs(m.byId.values().next().value.hdg - 90) <= 1, 'heading survives a renumbering');
});

test('snapshot: rebuilt per version; whole-GB body and gzip are cached; the per-box gzip cache is bounded and cleared on rebuild', async () => {
  const { model: m, graph: g } = makeModel();
  const st = { 1: { key: 'A', name: 'A', lat: 51.0, lon: -1.0, crs: 'AAA' } };
  g.loadSmart({ rows: 1, area: ['LA'], from: ['0000'], to: ['0001'], stanox: ['1'], event: ['A'] }, s => st[s] || null);
  const snap = new Snapshot({ model: m, now: () => 5000, gzipCacheEntries: 3 });
  m.apply({ type: 'CC', area: 'LA', descr: 'AAAA', to: '0001', ts: 1 });
  snap.rebuild(false);
  const body = JSON.parse(snap.body(null));
  assert.deepEqual([body.serverTime, body.feedStale, body.trains.length], [5000, false, 1]);
  assert.equal(snap.body(null), snap.body(null));
  const gz1 = await snap.gz(null), gz2 = await snap.gz(null);
  assert.equal(gz1, gz2, 'the same Buffer: compressed once per version');
  assert.equal(zlib.gunzipSync(gz1).toString(), snap.body(null));
  for (let i = 0; i < 10; i++) await snap.gz({ s: i, w: -5, n: i + 1, e: 5 }, `k${i}`);
  assert.ok(snap._boxCache.size <= 3, `box cache holds ${snap._boxCache.size}`);
  snap.rebuild(true);
  assert.equal(snap._boxCache.size, 0);
  assert.equal(JSON.parse(snap.body(null)).feedStale, true);
  assert.equal(snap.body({ s: 0, w: 0, n: 1, e: 1 }), '{"serverTime":5000,"feedStale":true,"trains":[]}');
});

test('fake NROD: listens on loopback only; synthetic mode walks real SMART berth steps', async () => {
  const refDir = fixtureRefDir();
  const fake = new FakeNrod({ mode: 'synthetic', smart: path.join(refDir, 'smart-latest.json.gz'), rate: 200, trains: 20, port: 0 });
  try {
    const port = await fake.start();
    assert.equal(fake.server.server.address().address, '127.0.0.1');
    // It is not reachable on another interface address: connecting to the machine's non-loopback address fails.
    const other = Object.values(require('os').networkInterfaces()).flat().find(i => i && !i.internal && i.family === 'IPv4');
    if (other) await assert.rejects(new Promise((res, rej) => { const s = net.connect({ host: other.address, port, timeout: 500 }, () => { s.destroy(); res(); }); s.on('error', rej); s.on('timeout', () => { s.destroy(); rej(new Error('timeout')); }); }));
    const chains = await readSmartChains(path.join(refDir, 'smart-latest.json.gz'));
    assert.ok(chains.has('LA'));
    const gen = new Synthetic({ adj: chains, trains: 10, seed: 3 });
    const evs = gen.events(200, 1000);
    assert.equal(evs.length, 200);
    for (const e of evs) {
      const [k, msg] = Object.entries(e)[0];
      assert.ok(['CA_MSG', 'CB_MSG', 'CC_MSG'].includes(k));
      assert.ok(msg.area_id && msg.descr && msg.time === '1000');
      if (k === 'CA_MSG') assert.ok(chains.get(msg.area_id).get(msg.from).includes(msg.to), 'a real SMART step');
    }
    assert.deepEqual(mulberry32(5)(), mulberry32(5)(), 'deterministic');
  } finally { await fake.stop(); rmrf(refDir); }
});

test('deploy/rail-map.service has the settings the lead asked for', () => {
  const u = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'rail-map.service'), 'utf8');
  for (const line of ['User=ubuntu', 'WorkingDirectory=/home/ubuntu/rail-map/map-service', 'ExecStart=/usr/bin/node --max-old-space-size=192 bin/rail-map.js',
    'MemoryMax=300M', 'CPUWeight=50', 'Nice=10', 'Restart=on-failure', 'RestartSec=10']) assert.ok(u.split('\n').includes(line), line);
  for (const v of ['MAP_ENV_FILE', 'MAP_DATA_DIR', 'PORT']) assert.match(u, new RegExp(`^Environment=${v}=`, 'm'));
});

test('nothing in src/ imports from backend/ or writes outside MAP_DATA_DIR by construction', () => {
  const dir = path.join(__dirname, '..', 'src');
  for (const f of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/require\(['"][^'"]*backend[^'"]*['"]\)/.test(text), `${f} imports from backend/`);
  }
  // The only writers: refdata (under <dataDir>/ref), the graph (the state file), download (its dest + .tmp).
  const writers = fs.readdirSync(dir).filter(f => /writeFile|createWriteStream|renameSync|mkdirSync/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.deepEqual(writers.sort(), ['app.js', 'berth-graph.js', 'download.js', 'record.js', 'refdata.js', 'transit.js', 'vstp.js']);
});
