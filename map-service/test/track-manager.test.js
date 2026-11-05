'use strict';

// The track pack on the server: verified against its manifest, loaded fast, refreshed from the GitHub release, last good kept.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { TrackManager } = require('../src/track-manager');
const { loadConfig } = require('../src/config');
const log = require('../src/log');
const { config, tmpDir, rmrf, captureLog, sleep, getJson, get } = require('./helpers');
const { startRig } = require('./rig');

const FIX = path.join(__dirname, 'fixtures', 'track-sussex.bin');
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const cfg = (over = {}) => ({ ...config().track, minEdges: 100, retryMinSecs: 900, ...over });

/** A fake GitHub: /releases lists what `releases()` says; /asset/<name> serves `files[name]`. */
async function github({ releases, files }) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url.startsWith('/releases')) {
      if (typeof releases === 'number') { res.writeHead(releases); res.end('nope'); return; }
      const base = `http://127.0.0.1:${srv.address().port}/asset/`;
      const list = releases().map(r => ({ ...r, assets: (r.assets || []).map(n => ({ name: n, browser_download_url: base + n })) }));
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(list)); return;
    }
    const name = decodeURIComponent(req.url.slice('/asset/'.length));
    const body = files[name];
    if (!body) { res.writeHead(404); res.end('missing'); return; }
    res.writeHead(200, { 'content-length': body.length }); res.end(body);
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { hits, url: `http://127.0.0.1:${srv.address().port}/releases`, close: () => new Promise(r => { srv.closeAllConnections(); srv.close(r); }) };
}

const manifestFor = (buf, date, over = {}) => Buffer.from(JSON.stringify({ file: `track-pack-${date}.bin`, sha256: sha(buf), bytes: buf.length, format: 2, packDate: date, ...over }));
const release = (date, assets) => ({ tag_name: `track-pack-${date}`, draft: false, assets: assets || [`track-pack-${date}.bin`, `track-pack-${date}.manifest.json`] });
const place = (dir, date, buf, mf) => {
  fs.mkdirSync(path.join(dir, 'track'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'track', `track-pack-${date}.bin`), buf);
  if (mf) fs.writeFileSync(path.join(dir, 'track', `track-pack-${date}.manifest.json`), mf);
};

test('start-up loads the newest pack on disk that verifies: no download needed', async () => {
  const cap = captureLog();
  const dir = tmpDir();
  try {
    const bin = fs.readFileSync(FIX);
    place(dir, '20261001', bin, manifestFor(bin, '20261001'));
    place(dir, '20261101', bin, manifestFor(bin, '20261101'));
    const m = new TrackManager({ config: cfg(), dataDir: dir, download: false });
    const loaded = [];
    m.on('loaded', (p, i) => loaded.push(i.packDate));
    await m.start();
    assert.deepEqual(loaded, ['20261101']);
    assert.equal(m.pack.derivedFromPack, true, 'format 2: nothing derived at load');
    assert.ok(m.info.loadMs < 2000);
    const st = m.status();
    assert.deepEqual([st.loaded, st.file, st.packDate, st.sha256, st.bytes], [true, 'track-pack-20261101.bin', '20261101', sha(bin), bin.length]);
    assert.ok(st.bytesHeld > 1000);
    m.stop();
  } finally { cap.restore(); log.resetForTest(); rmrf(dir); }
});

test('a pack that fails verification is skipped for an older good one: bad hash, wrong size, no manifest, garbage, a future format', async () => {
  const cap = captureLog();
  const dir = tmpDir();
  try {
    const bin = fs.readFileSync(FIX);
    place(dir, '20260901', bin, manifestFor(bin, '20260901'));                                              // the good one
    const future = Buffer.from(bin); future.writeUInt32LE(3, 4);
    place(dir, '20261001', future, manifestFor(future, '20261001'));                                        // verifies, but a format we do not know
    place(dir, '20261002', bin, manifestFor(bin, '20261002', { sha256: 'a'.repeat(64) }));                  // hash does not match
    place(dir, '20261003', bin, manifestFor(bin, '20261003', { bytes: bin.length + 1 }));                   // size does not match
    place(dir, '20261004', bin);                                                                            // no manifest at all
    place(dir, '20261005', Buffer.from('not a pack at all'), manifestFor(Buffer.from('not a pack at all'), '20261005'));
    const m = new TrackManager({ config: cfg(), dataDir: dir, download: false });
    await m.start();
    assert.equal(m.info.packDate, '20260901');
    const text = cap.lines.join('\n');
    for (const n of ['20261005', '20261004', '20261003', '20261002', '20261001']) assert.ok(text.includes(`track-pack-${n}.bin is unusable`), n);
    assert.match(text, /SHA-256 in its manifest/); assert.match(text, /no manifest/); assert.match(text, /its manifest says/); assert.match(text, /format version 3/);
  } finally { cap.restore(); log.resetForTest(); rmrf(dir); }
});

test('a pack with far too few edges (a stub) is refused', async () => {
  const dir = tmpDir();
  try {
    const bin = fs.readFileSync(FIX);
    place(dir, '20261101', bin, manifestFor(bin, '20261101'));
    const m = new TrackManager({ config: cfg({ minEdges: 100000 }), dataDir: dir, download: false });
    assert.equal(await m.loadFromDisk(), false);
    assert.match(m.lastError, /only \d+ edges/);
  } finally { rmrf(dir); }
});

test('REFRESH: downloads the newest track-pack release (ignoring drafts, other tags and releases missing an asset), verifies the manifest hash, loads, then installs', async () => {
  const cap = captureLog();
  const dir = tmpDir();
  const bin = fs.readFileSync(FIX);
  const gh = await github({
    releases: () => [
      { tag_name: 'v1.2.3', assets: [] },
      { ...release('20261201'), draft: true },
      release('20261130', ['track-pack-20261130.bin']),                  // no manifest asset
      release('20261110'), release('20261001')
    ],
    files: { 'track-pack-20261110.bin': bin, 'track-pack-20261110.manifest.json': manifestFor(bin, '20261110') }
  });
  try {
    const m = new TrackManager({ config: cfg(), dataDir: dir, urls: { releases: gh.url } });
    const loaded = [];
    m.on('loaded', (p, i) => loaded.push([i.packDate, i.bytes]));
    assert.equal(await m.check(), true);
    assert.deepEqual(loaded, [['20261110', bin.length]]);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'track')).sort(), ['track-pack-20261110.bin', 'track-pack-20261110.manifest.json']);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'track', 'track-pack-20261110.bin')), bin);
    assert.ok(gh.hits.every(u => u.startsWith('/releases') || u.includes('20261110')), 'nothing else was downloaded');
    // Already current: no download.
    const before = gh.hits.length;
    assert.equal(await m.check(), false);
    assert.equal(gh.hits.length, before + 1, 'only the release list was fetched');
    assert.match(cap.lines.join('\n'), /track: installed track-pack-20261110\.bin/);
  } finally { cap.restore(); log.resetForTest(); await gh.close(); rmrf(dir); }
});

test('REFRESH: a hash mismatch, a wrong size, a format we do not know and a failed list are each ONE log line, nothing is installed, the last good pack keeps serving and no file is left', async () => {
  const cap = captureLog();
  const dir = tmpDir();
  const bin = fs.readFileSync(FIX);
  const future = Buffer.from(bin); future.writeUInt32LE(9, 4);
  let mode = 'badhash';
  const files = {
    'track-pack-20261201.bin': bin, 'track-pack-20261201.manifest.json': manifestFor(bin, '20261201', { sha256: 'b'.repeat(64) }),
    'track-pack-20261202.bin': bin, 'track-pack-20261202.manifest.json': manifestFor(bin, '20261202', { bytes: 5 }),
    'track-pack-20261203.bin': future, 'track-pack-20261203.manifest.json': manifestFor(future, '20261203')
  };
  const gh = await github({ releases: () => (mode === 'list500' ? [] : [release(mode === 'badhash' ? '20261201' : mode === 'badsize' ? '20261202' : '20261203')]), files });
  try {
    place(dir, '20261001', bin, manifestFor(bin, '20261001'));
    const m = new TrackManager({ config: cfg(), dataDir: dir, urls: { releases: gh.url } });
    await m.loadFromDisk();
    const good = m.pack;
    for (const md of ['badhash', 'badsize', 'future']) {
      mode = md;
      m.nextRetryAt = 0;
      assert.equal(await m.check(), false, md);
      assert.equal(m.pack, good, `${md}: still the last good pack`);
      assert.deepEqual(fs.readdirSync(path.join(dir, 'track')).sort(), ['track-pack-20261001.bin', 'track-pack-20261001.manifest.json'], `${md}: no stray or partial files`);
      assert.ok(m.nextRetryAt > Date.now(), `${md}: a retry is scheduled with backoff`);
    }
    assert.equal(cap.lines.filter(l => /track: refresh failed/.test(l)).length, 3);
    assert.ok(cap.lines.some(l => /SHA-256/.test(l)) && cap.lines.some(l => /its manifest says 5/.test(l)) && cap.lines.some(l => /format version 9/.test(l)));
    assert.ok(cap.lines.every(l => !/at .*\.js:\d+/.test(l)), 'no stack traces');
  } finally { cap.restore(); log.resetForTest(); await gh.close(); rmrf(dir); }
  // The release list itself failing.
  const bad = await github({ releases: 500, files: {} });
  const dir2 = tmpDir();
  try {
    const m = new TrackManager({ config: cfg(), dataDir: dir2, urls: { releases: bad.url } });
    assert.equal(await m.check(), false);
    assert.match(m.lastError, /HTTP 500/);
    assert.equal(m.pack, null);
    assert.equal(m.failures, 1);
  } finally { await bad.close(); rmrf(dir2); }
});

test('only the newest `keepPacks` packs are kept on disk', async () => {
  const dir = tmpDir();
  const bin = fs.readFileSync(FIX);
  const gh = await github({ releases: () => [release('20261201')], files: { 'track-pack-20261201.bin': bin, 'track-pack-20261201.manifest.json': manifestFor(bin, '20261201') } });
  try {
    for (const d of ['20260801', '20260901', '20261001']) place(dir, d, bin, manifestFor(bin, d));
    const m = new TrackManager({ config: cfg({ keepPacks: 2 }), dataDir: dir, urls: { releases: gh.url } });
    await m.loadFromDisk();
    assert.equal(await m.check(), true);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'track')).filter(n => n.endsWith('.bin')).sort(), ['track-pack-20261001.bin', 'track-pack-20261201.bin']);
  } finally { await gh.close(); rmrf(dir); }
});

test('--track-pack FILE (development): that file is loaded as it is and nothing is ever downloaded or written', async () => {
  const dir = tmpDir();
  const gh = await github({ releases: () => [release('20261201')], files: {} });
  try {
    const m = new TrackManager({ config: cfg(), dataDir: dir, fixedFile: FIX, urls: { releases: gh.url } });
    await m.start();
    assert.ok(m.pack);
    assert.equal(await m.check(), false);
    assert.equal(gh.hits.length, 0, 'no network at all');
    assert.equal(fs.existsSync(path.join(dir, 'track')), false, 'nothing written');
    m.stop();
    const broken = new TrackManager({ config: cfg(), dataDir: dir, fixedFile: path.join(dir, 'nope.bin') });
    assert.equal(await broken.loadFromDisk(), false);
    assert.match(broken.lastError, /ENOENT|no such/i);
  } finally { await gh.close(); rmrf(dir); }
});

// ---- the command line, and the service ---------------------------------------------------------------------------------------

test('command line: --track-pack=FILE and --track-pack FILE both work; a missing value is refused with a sentence', () => {
  const a = loadConfig({ env: {}, argv: ['--track-pack=/tmp/x.bin'] });
  assert.equal(a.trackPack, '/tmp/x.bin');
  const b = loadConfig({ env: {}, argv: ['--track-pack', '/tmp/y.bin', '--fake=127.0.0.1:1', '--ref-dir=/tmp'] });
  assert.equal(b.trackPack, '/tmp/y.bin');
  assert.equal(loadConfig({ env: {}, argv: [] }).trackPack, null);
  assert.throws(() => loadConfig({ env: {}, argv: ['--track-pack'] }), /--track-pack needs a file/);
  assert.throws(() => loadConfig({ env: {}, argv: ['--track-pack', '--fake'] }), /needs a file/);
  assert.throws(() => loadConfig({ env: {}, argv: ['--bogus'] }), /Known: .*--track-pack=FILE/);
});

test('IN THE SERVICE: with --track-pack the pack loads at start, spans build, /network serves the overview with an ETag, health says what is loaded', async () => {
  const { gunzipSync } = require('zlib');
  const rig = await startRig({ overrides: { track: { enabled: true } } , start: false });
  try {
    rig.app._trackPackFile = FIX;
    await rig.app.start();
    await rig.stompSrv.waitForSubscribe(3);
    assert.ok(rig.app.track && rig.app.spans, 'pack and span builder exist');
    const h = (await getJson(rig.port, '/map/v1/health')).json;
    assert.equal(h.diagnostics.track.loaded, true);
    assert.match(h.diagnostics.track.file, /track-sussex\.bin/);
    assert.equal(typeof h.diagnostics.spans, 'object');
    // /network: the fixture has no overview layers, so 404 with a sentence; with a pack that has one, gzip bytes and an ETag.
    const r = await getJson(rig.port, '/map/v1/network?level=hi');
    assert.equal(r.status, 404);
    assert.equal((await getJson(rig.port, '/map/v1/network?level=zz')).status, 404);
    const gz = require('zlib').gzipSync(JSON.stringify({ type: 'FeatureCollection', features: [] }));
    rig.app.track.network = lvl => (lvl === 'lo' ? gz : null);
    rig.app.track.sha256 = () => 'abcdef0123456789abcdef';
    const ok = await get(rig.port, '/map/v1/network?level=lo');
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['content-encoding'], 'gzip');
    assert.equal(ok.headers['cache-control'], 'public, max-age=86400');
    assert.equal(ok.headers.etag, '"abcdef0123456789-lo"');
    assert.deepEqual(JSON.parse(gunzipSync(ok.body).toString()), { type: 'FeatureCollection', features: [] });
    const nm = await get(rig.port, '/map/v1/network?level=lo', { headers: { 'If-None-Match': '"abcdef0123456789-lo"' } });
    assert.equal(nm.status, 304);
  } finally { await rig.stop(); }
});

test('IN THE SERVICE: a pack with no overview and no pack at all both leave the map working; a swapped-in pack rebuilds the spans', async () => {
  const rig = await startRig();
  try {
    assert.equal(rig.app.track, null);
    assert.equal((await getJson(rig.port, '/map/v1/network')).status, 404);
    const { loadPack } = require('../src/track');
    rig.app._setTrack(loadPack(FIX));
    assert.ok(rig.app.spans);
    const first = rig.app.spans;
    rig.app._setTrack(loadPack(FIX));
    assert.notEqual(rig.app.spans, first, 'a new pack gets a fresh builder');
    assert.equal((await getJson(rig.port, '/map/v1/health')).status, 200);
  } finally { await rig.stop(); }
});
