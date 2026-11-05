'use strict';

// Downloads and reference-data refresh: auth-hop rules, failure handling, and last-good fallback.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const dl = require('../src/download');
const log = require('../src/log');
const { RefData } = require('../src/refdata');
const { FIX, config, tmpDir, rmrf, captureLog, sleep } = require('./helpers');
const { london } = require('../src/time');

const PASS = 'p$i$d"x\\y';                       // a `$` a shell would eat, a quote and a backslash
const USER = 'rich@example.com';
const BASIC = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');

function serve(handler) {
  return new Promise(resolve => {
    const seen = [];
    const srv = http.createServer((req, res) => { seen.push({ url: req.url, headers: req.headers }); handler(req, res, seen); });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, port: srv.address().port, close: () => new Promise(r => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(r); }) }));
  });
}

// ---- download.js ---------------------------------------------------------------------------------------

test('auth goes on the FIRST hop only: a redirect to another host never receives the login', async () => {
  const dir = tmpDir();
  const b = await serve((req, res) => { res.writeHead(200, { 'content-length': 5 }); res.end('hello'); });
  const a = await serve((req, res) => { res.writeHead(302, { location: `http://localhost:${b.port}/file` }); res.end(); });
  try {
    const r = await dl.downloadFile({ url: `http://127.0.0.1:${a.port}/x`, dest: path.join(dir, 'f'), auth: { user: USER, pass: PASS } });
    assert.equal(fs.readFileSync(path.join(dir, 'f'), 'utf8'), 'hello');
    assert.equal(a.seen[0].headers.authorization, BASIC, 'the first hop got the login');
    assert.equal(b.seen[0].headers.authorization, undefined, 'the second host did not');
    assert.equal(r.redirects, 1);
    assert.deepEqual(r.hosts, [`127.0.0.1:${a.port}`, `localhost:${b.port}`]);
  } finally { await a.close(); await b.close(); rmrf(dir); }
});

test('the login is refused for a host that is not on the allow-list, and for plain http to a non-loopback host; nothing is sent', async () => {
  const dir = tmpDir();
  const a = await serve((req, res) => { res.writeHead(200); res.end('x'); });
  try {
    await assert.rejects(dl.downloadFile({ url: `http://127.0.0.1:${a.port}/x`, dest: path.join(dir, 'f'), auth: { user: USER, pass: PASS }, authHosts: ['datafeeds.networkrail.co.uk'] }), e => e.code === 'INSECURE' && !e.message.includes(PASS));
    assert.equal(a.seen.length, 0, 'no request was made');
    await assert.rejects(dl.downloadFile({ url: 'http://example.invalid/x', dest: path.join(dir, 'f'), auth: { user: USER, pass: PASS } }), e => e.code === 'INSECURE');
    await assert.rejects(dl.downloadFile({ url: 'http://datafeeds.networkrail.co.uk/x', dest: path.join(dir, 'f'), auth: { user: USER, pass: PASS } }), e => e.code === 'INSECURE', 'allowed host but plain http');
    assert.equal(fs.existsSync(path.join(dir, 'f')), false);
  } finally { await a.close(); rmrf(dir); }
});

test('NROD hosts are the only ones in the default allow-list (plus loopback for tests)', () => {
  assert.deepEqual(dl.NROD_AUTH_HOSTS.filter(h => h.endsWith('.networkrail.co.uk')).sort(), ['datafeeds.networkrail.co.uk', 'publicdatafeeds.networkrail.co.uk']);
  assert.deepEqual(dl.NROD_AUTH_HOSTS.filter(h => !h.endsWith('.networkrail.co.uk')).sort(), ['127.0.0.1', '::1', '[::1]', 'localhost']);
});

test('a public download (NaPTAN) sends no Authorization header at all', async () => {
  const dir = tmpDir();
  const a = await serve((req, res) => { res.writeHead(200); res.end('csv'); });
  try {
    await dl.downloadFile({ url: `http://127.0.0.1:${a.port}/n`, dest: path.join(dir, 'n.csv') });
    assert.equal(a.seen[0].headers.authorization, undefined);
  } finally { await a.close(); rmrf(dir); }
});

test('more than 3 redirects is refused', async () => {
  const dir = tmpDir();
  const a = await serve((req, res) => { res.writeHead(302, { location: '/again' }); res.end(); });
  try {
    await assert.rejects(dl.downloadFile({ url: `http://127.0.0.1:${a.port}/x`, dest: path.join(dir, 'f') }), e => e.code === 'REDIRECTS');
  } finally { await a.close(); rmrf(dir); }
});

test('failures leave no file and no temp file, and the message names neither the login nor the password', async () => {
  const dir = tmpDir();
  const dest = path.join(dir, 'f');
  const cases = {
    401: (req, res) => { res.writeHead(401); res.end(`bad login for ${USER}`); },
    403: (req, res) => { res.writeHead(403); res.end('<html>forbidden</html>'); },
    404: (req, res) => { res.writeHead(404); res.end('nope'); },
    500: (req, res) => { res.writeHead(500); res.end('boom'); },
    truncated: (req, res) => { res.writeHead(200, { 'content-length': 100 }); res.write('0123456789'); setTimeout(() => res.destroy(), 20); },
    empty: (req, res) => { res.writeHead(200, { 'content-length': 0 }); res.end(); }
  };
  try {
    for (const [name, h] of Object.entries(cases)) {
      const a = await serve(h);
      try {
        await assert.rejects(dl.downloadFile({ url: `http://127.0.0.1:${a.port}/x`, dest, auth: { user: USER, pass: PASS }, idleTimeoutMs: 2000 }),
          e => {
            const shown = log.clean(e.message);
            assert.ok(!e.message.includes(PASS) && !e.message.includes('Authorization') && !e.message.includes(BASIC), `${name}: no secret in "${e.message}"`);
            return e instanceof dl.DownloadError && shown.length > 10;
          }, name);
      } finally { await a.close(); }
      assert.equal(fs.existsSync(dest), false, `${name}: no destination file`);
      assert.deepEqual(fs.readdirSync(dir), [], `${name}: no temp file left`);
    }
  } finally { rmrf(dir); }
});

test('a stalled download is abandoned after the idle timeout', async () => {
  const dir = tmpDir();
  const a = await serve((req, res) => { res.writeHead(200, { 'content-length': 100 }); res.write('x'); /* then silence */ });
  try {
    await assert.rejects(dl.downloadFile({ url: `http://127.0.0.1:${a.port}/x`, dest: path.join(dir, 'f'), idleTimeoutMs: 200 }), e => e.code === 'TIMEOUT');
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { await a.close(); rmrf(dir); }
});

test('a download that fails the instant it starts leaves NO temp file (the write stream opens asynchronously: the old cleanup raced it)', async () => {
  // The server sends headers promising 100 bytes and drops the connection at once. The client's pipeline fails before the temp
  // file's open has finished; unlinking immediately found nothing and the open then created the file. About 1 run in 5 left a .tmp.
  const dir = tmpDir();
  const a = await serve((req, res) => { res.writeHead(200, { 'content-length': 100 }); res.flushHeaders(); setImmediate(() => res.socket.destroy()); });
  try {
    for (let i = 0; i < 150; i++) await assert.rejects(dl.downloadFile({ url: `http://127.0.0.1:${a.port}/x`, dest: path.join(dir, `f${i}`), idleTimeoutMs: 2000 }));
    await sleep(100);
    assert.deepEqual(fs.readdirSync(dir), [], 'not one temp or destination file was left behind');
  } finally { await a.close(); rmrf(dir); }
});

test('a full or unwritable output folder is a DISK error, not a crash', async () => {
  const dir = tmpDir();
  const a = await serve((req, res) => { res.writeHead(200); res.end('data'); });
  try {
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, 'x');
    await assert.rejects(dl.downloadFile({ url: `http://127.0.0.1:${a.port}/x`, dest: path.join(blocker, 'sub', 'f') }), e => e.code === 'DISK');
  } finally { await a.close(); rmrf(dir); }
});

// ---- RefData: refresh and last-good fallback ---------------------------------------------------------------------

const goodCorpus = () => JSON.stringify({ TIPLOCDATA: Array.from({ length: 30 }, (_, i) => ({ NLC: i, STANOX: String(10000 + i), TIPLOC: `TIP${i}`, '3ALPHA': 'AAA', NLCDESC: `PLACE ${i}` })) });

// Every dataset points at the local server: a test must never reach the real NROD, even by mistake.
const allUrls = port => Object.fromEntries(['smart', 'corpus', 'naptan', 'cif'].map(n => [n, `http://127.0.0.1:${port}/${n}`]));

async function refSetup({ minRows = 5, handler }) {
  const dir = tmpDir();
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, `NR_FEED_USER=${USER}\nNR_FEED_PASS=${PASS}\n`);
  const srv = await serve(handler);
  const cfg = config({ reference: { minRows: { smart: minRows, corpus: minRows, naptan: minRows, cif: minRows }, retryMinSecs: 900 } });
  const ref = new RefData({ config: cfg, dataDir: dir, envFile, urls: allUrls(srv.port), downloadOpts: { idleTimeoutMs: 2000 } });
  const file = path.join(dir, 'ref', 'corpus-latest.json.gz');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lastGood = zlib.gzipSync(goodCorpus());
  fs.writeFileSync(file, lastGood);
  await ref.loadFromDisk();
  return { dir, ref, srv, file, lastGood, cleanup: async () => { await srv.close(); rmrf(dir); } };
}

test('a refresh that fails (HTTP 500, garbage, too few rows, truncated) keeps the last good data in memory AND on disk', async () => {
  const cap = captureLog();
  let mode = '500';
  const { ref, srv, file, lastGood, dir, cleanup } = await refSetup({
    minRows: 20,
    handler: (req, res) => {
      if (mode === '500') { res.writeHead(500); res.end('server error'); }
      else if (mode === 'garbage') { res.writeHead(200); res.end('<html>this is not corpus</html>'); }
      else if (mode === 'few') { res.writeHead(200); res.end(JSON.stringify({ TIPLOCDATA: [{ TIPLOC: 'ONLY', STANOX: '1' }] })); }
      else if (mode === 'truncated') { const b = zlib.gzipSync(goodCorpus()); res.writeHead(200, { 'content-length': b.length }); res.end(b.subarray(0, b.length - 20)); }
    }
  });
  try {
    const before = ref.data.corpus;
    assert.equal(before.rows, 30);
    for (const m of ['500', 'garbage', 'few', 'truncated']) {
      mode = m;
      ref.state.corpus.nextRetryAt = 0;
      assert.equal(await ref.refresh('corpus'), false, m);
      assert.equal(ref.data.corpus, before, `${m}: the loaded data is untouched`);
      assert.deepEqual(fs.readFileSync(file), lastGood, `${m}: the file on disk is untouched`);
      assert.deepEqual(fs.readdirSync(path.dirname(file)), ['corpus-latest.json.gz'], `${m}: no .new or .tmp left behind`);
      assert.ok(ref.state.corpus.nextRetryAt > Date.now(), `${m}: a retry is scheduled, not an immediate hammer`);
    }
    assert.equal(srv.seen[0].headers.authorization, BASIC, 'the literal password, `$` and all, went to the (allowed) first hop');
    const text = cap.lines.join('\n');
    assert.ok(text.includes('refresh failed') && text.includes('keeping the last good copy'));
    assert.ok(!text.includes(PASS) && !text.includes(USER), 'nothing in the log carries the login');
    assert.equal(cap.lines.filter(l => l.includes('refresh failed')).length, 4, 'one plain line per failure');
  } finally { cap.restore(); log.resetForTest(); await cleanup(); }
});

test('a good refresh swaps the data in and replaces the file only after it has been loaded', async () => {
  const cap = captureLog();
  const bigger = JSON.stringify({ TIPLOCDATA: Array.from({ length: 50 }, (_, i) => ({ NLC: i, STANOX: String(20000 + i), TIPLOC: `NEW${i}`, '3ALPHA': 'BBB', NLCDESC: `NEW ${i}` })) });
  const { ref, file, cleanup } = await refSetup({ handler: (req, res) => { const b = zlib.gzipSync(bigger); res.writeHead(200, { 'content-length': b.length }); res.end(b); } });
  try {
    const loaded = [];
    ref.on('loaded', n => loaded.push(n));
    assert.equal(await ref.refresh('corpus'), true);
    assert.equal(ref.data.corpus.rows, 50);
    assert.deepEqual(loaded, ['corpus']);
    assert.equal(zlib.gunzipSync(fs.readFileSync(file)).toString(), bigger);
    assert.equal(ref.state.corpus.lastError, null);
  } finally { cap.restore(); log.resetForTest(); await cleanup(); }
});

test('a corrupt file ON DISK at start is reported and replaced by a download; nothing is loaded from it', async () => {
  const cap = captureLog();
  const { ref, dir, file, srv, cleanup } = await refSetup({ handler: (req, res) => { res.writeHead(200); res.end(zlib.gzipSync(goodCorpus())); } });
  try {
    const ref2 = new RefData({ config: ref.config, dataDir: dir, envFile: path.join(dir, '.env'), urls: allUrls(srv.port) });
    fs.writeFileSync(file, 'garbage, not gzip, not json');
    await ref2.loadFromDisk();
    assert.equal(ref2.data.corpus, undefined);
    assert.ok(cap.lines.some(l => l.includes('corpus on disk is unusable')));
    assert.equal(await ref2.refresh('corpus'), true);
    assert.equal(ref2.data.corpus.rows, 30);
  } finally { cap.restore(); log.resetForTest(); await cleanup(); }
});

test('without credentials a refresh fails politely (a sentence, no throw) and the service carries on', async () => {
  const cap = captureLog();
  const { ref, dir, cleanup } = await refSetup({ handler: (req, res) => { res.writeHead(200); res.end('x'); } });
  try {
    ref.envFile = path.join(dir, 'nonexistent.env');
    assert.equal(await ref.refresh('corpus'), false);
    assert.match(ref.state.corpus.lastError, /Cannot read the credentials file/);
    assert.equal(ref.data.corpus.rows, 30);
  } finally { cap.restore(); log.resetForTest(); await cleanup(); }
});

test('FAKE mode: reads the reference folder, never downloads, never writes, never reads credentials', async () => {
  const dir = tmpDir(), data = tmpDir();
  try {
    fs.copyFileSync(path.join(FIX, 'corpus-fixture.json'), path.join(dir, 'corpus-latest.json.gz'));
    const ref = new RefData({ config: config({ reference: { minRows: { corpus: 5 } } }), dataDir: data, refDir: dir, envFile: '/nonexistent/.env' });
    await ref.loadFromDisk();
    assert.ok(ref.data.corpus.rows > 10);
    assert.equal(await ref.refresh('corpus'), false);
    await ref.checkDue();
    assert.deepEqual(fs.readdirSync(data), [], 'nothing written to the data folder');
    assert.deepEqual(fs.readdirSync(dir), ['corpus-latest.json.gz']);
  } finally { rmrf(dir); rmrf(data); }
});

test('refresh slots: daily 04:40 London, weekly NaPTAN on Sunday 04:20', () => {
  const ref = new RefData({ config: config(), dataDir: '/nonexistent' });
  const at = (d, h, m) => Date.UTC(2026, 10, d, h, m);              // November 2026: GMT, so London = UTC
  const k = (name, ms) => ref.slotKeyAt(name, ms);
  assert.equal(k('smart', at(2, 4, 39)), k('smart', at(1, 12, 0)), 'before 04:40 the current slot is still yesterday\'s');
  assert.equal(k('smart', at(2, 4, 40)), k('smart', at(2, 23, 0)) , 'from 04:40 it is today\'s');
  assert.equal(k('smart', at(2, 4, 40)) - k('smart', at(2, 4, 39)), 1);
  // CIF runs after the crossing service\'s 04:00 load: 04:50.
  assert.equal(k('cif', at(2, 4, 49)) + 1, k('cif', at(2, 4, 50)));
  // Weekly: 2026-11-01 is a Sunday. The slot key is constant Sunday 04:20 -> next Sunday 04:19.
  const sunSlot = k('naptan', at(1, 4, 20));
  assert.equal(k('naptan', at(1, 4, 19)) + 7, sunSlot);
  assert.equal(k('naptan', at(5, 12, 0)), sunSlot, 'Thursday still belongs to the Sunday slot');
  assert.equal(k('naptan', at(8, 4, 20)), sunSlot + 7);
});

test('the scheduler downloads a missing file at once, and a stale one only once its slot has passed since it was written', async () => {
  const cap = captureLog();
  let hits = 0;
  const { ref, dir, file, cleanup } = await refSetup({ handler: (req, res) => { hits++; res.writeHead(200); res.end(zlib.gzipSync(goodCorpus())); } });
  try {
    // 1. file written just now -> its slot is done: not due.
    ref.stopped = false;
    await ref.checkDue();
    const corpusHits = hits;
    // checkDue also tries the other (absent) datasets, which have no server: they fail politely.
    assert.equal(ref.state.corpus.doneSlot, ref.slotKeyAt('corpus', Date.now()));
    // 2. pretend the file was written two days ago -> due.
    ref.state.corpus.doneSlot = ref.slotKeyAt('corpus', Date.now()) - 2;
    ref.state.corpus.nextRetryAt = 0;
    await ref.checkDue();
    assert.ok(hits > corpusHits, 'a download happened');
    assert.equal(ref.state.corpus.doneSlot, ref.slotKeyAt('corpus', Date.now()));
  } finally { cap.restore(); log.resetForTest(); await cleanup(); }
});
