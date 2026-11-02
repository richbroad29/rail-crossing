'use strict';
// The mock server answers exactly as CONTRACT.md section 5 says (so tests against it mean something),
// and the page's own files obey the security rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const PORT = 3197;
let child;
function get(p, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p, headers }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}
const json = (r) => JSON.parse(r.body);

test.before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '../dev/mock-api.js'), '--port', String(PORT), '--count', '40', '--national', '--max-sse', '1', '--tick', '200', '--stepms', '200'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  for (let i = 0; i < 60; i++) {
    try { await get('/map/v1/health'); return; } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('mock did not start');
});
test.after(() => { if (child) child.kill(); });

test('GET /trains: shape of the response and of a Train', async () => {
  const r = await get('/map/v1/trains');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /application\/json/);
  assert.equal(r.headers['cache-control'], 'no-store');
  const d = json(r);
  assert.equal(typeof d.serverTime, 'number');
  assert.equal(typeof d.feedStale, 'boolean');
  assert.ok(d.trains.length >= 30);
  d.trains.forEach((t) => {
    assert.match(t.id, /^t[0-9a-z]+$/);
    assert.equal(typeof t.hc, 'string');
    assert.ok(typeof t.lat === 'number' && typeof t.lon === 'number');
    assert.ok(t.hdg === null || (t.hdg >= 0 && t.hdg < 360));
    assert.ok(['s', 'i', 'a'].includes(t.pl));
    assert.match(t.berth, /^\d{4}$/);
    assert.equal(typeof t.at, 'number');
    if (t.svc) {
      ['uid', 'toc', 'o', 'd', 'dep', 'arr', 'cat', 'pwr', 'load'].forEach((k) => assert.ok(k in t.svc, k));
      assert.match(t.svc.dep, /^\d\d:\d\d$/);
    }
  });
});

test('GET /trains?bbox filters; a bad bbox is a plain-sentence 400', async () => {
  const all = json(await get('/map/v1/trains')).trains.length;
  const some = json(await get('/map/v1/trains?bbox=50.5,-1.5,51.5,0.5')).trains;
  assert.ok(some.length < all);
  some.forEach((t) => assert.ok(t.lat >= 50.5 && t.lat <= 51.5 && t.lon >= -1.5 && t.lon <= 0.5));
  const bad = await get('/map/v1/trains?bbox=1,2,3');
  assert.equal(bad.status, 400);
  assert.equal(typeof json(bad).error, 'string');
  assert.ok(!/at .*\.js:\d+/.test(bad.body), 'no stack trace');
});

test('GET /train/:id: the detail shape; 404 for an unknown id', async () => {
  const t = json(await get('/map/v1/trains')).trains.find((x) => x.svc);
  const r = await get('/map/v1/train/' + t.id);
  assert.equal(r.status, 200);
  const d = json(r);
  ['train', 'previousHeadcodes', 'firstSeenAt', 'recentBerths', 'trail', 'service', 'place', 'speedMphEstimate'].forEach((k) => assert.ok(k in d, k));
  assert.ok(d.recentBerths.length <= 20);
  d.trail.forEach((p) => assert.equal(p.length, 3));
  assert.ok(['station', 'between', 'near'].includes(d.place.kind));
  ['uid', 'stp', 'toc', 'headcode', 'category', 'power', 'timingLoad', 'speedMph', 'origin', 'destination', 'calls'].forEach((k) => assert.ok(k in d.service, k));
  assert.ok(d.service.calls.length >= 2);
  d.service.calls.forEach((c) => ['name', 'tiploc', 'arr', 'dep', 'pass', 'platform'].forEach((k) => assert.ok(k in c, k)));
  const nf = await get('/map/v1/train/nope');
  assert.equal(nf.status, 404);
  assert.equal(typeof json(nf).error, 'string');
});

test('GET /stations and /search', async () => {
  const s = json(await get('/map/v1/stations?bbox=50.7,-1,51,0.3'));
  assert.ok(s.stations.length > 5 && s.stations.length < 200);
  assert.deepEqual(Object.keys(s.stations[0]).sort(), ['crs', 'lat', 'lon', 'name', 'tiploc']);
  const r = await get('/map/v1/stations');
  assert.equal(r.headers['cache-control'], 'public, max-age=86400');
  const q = json(await get('/map/v1/search?q=brig'));
  assert.ok(q.stations.some((x) => x.crs === 'BTN'));
  const hc = json(await get('/map/v1/trains')).trains[0].hc;
  const q2 = json(await get('/map/v1/search?q=' + hc.slice(0, 2)));
  assert.ok(q2.trains.length >= 1);
  assert.deepEqual(Object.keys(q2.trains[0]).sort(), ['d', 'hc', 'id', 'o']);
  assert.ok(q2.trains.length <= 20 && q2.stations.length <= 20);
});

test('GET /health', async () => {
  const d = json(await get('/map/v1/health'));
  ['status', 'uptimeSecs', 'rssMB', 'heapMB', 'feeds', 'reference', 'model', 'clients'].forEach((k) => assert.ok(k in d, k));
});

function openStream(extra) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/map/v1/stream' + (extra || '') }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; if (res.resolve) res.resolve(buf); });
      resolve({ req, res, text: () => buf });
    });
  });
}
test('GET /stream: snapshot first, then 503 when the cap is reached, and fault flags work', async () => {
  const a = await openStream('?bbox=49.5,-9,61,2.5');
  assert.equal(a.res.statusCode, 200);
  assert.match(a.res.headers['content-type'], /text\/event-stream/);
  await new Promise((r) => setTimeout(r, 300));
  assert.match(a.text(), /^event: snapshot\ndata: \{"serverTime":\d+,"feedStale":false,"trains":\[/);
  const b = await get('/map/v1/stream');
  assert.equal(b.status, 503);
  assert.equal(typeof json(b).error, 'string');
  await new Promise((r) => setTimeout(r, 1000));
  assert.match(a.text(), /event: update\ndata: \{"serverTime":\d+,"upsert":\[/);
  a.req.destroy();

  await get('/__mock/set?stale=1');
  assert.equal(json(await get('/map/v1/trains')).feedStale, true);
  await get('/__mock/set?stale=0&down=1');
  assert.equal((await get('/map/v1/trains')).status, 503);
  await get('/__mock/set?down=0');
  assert.equal((await get('/map/v1/trains')).status, 200);
});

// ---- security rules for the page's own files --------------------------------------------------------
const MAPDIR = path.join(__dirname, '..');
const pageFiles = fs.readdirSync(MAPDIR).filter((f) => f.endsWith('.js'));

test('no page script writes markup: no innerHTML, outerHTML, insertAdjacentHTML, document.write or eval', () => {
  pageFiles.forEach((f) => {
    const src = fs.readFileSync(path.join(MAPDIR, f), 'utf8').replace(/\/\/.*$/gm, '');
    [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function\(/].forEach((re) => {
      assert.ok(!re.test(src), f + ' contains ' + re);
    });
  });
});

test('every third-party tag is pinned to an exact version with an SRI hash', () => {
  const html = fs.readFileSync(path.join(MAPDIR, 'index.html'), 'utf8');
  const tags = html.match(/<(?:script|link)[^>]+unpkg\.com[^>]*>/g) || [];
  assert.equal(tags.length, 3);
  tags.forEach((t) => {
    assert.match(t, /unpkg\.com\/[a-z.-]+@\d+\.\d+\.\d+\//, 'exact version: ' + t);
    assert.match(t, /integrity="sha384-[A-Za-z0-9+/]{64}"/, 'SRI: ' + t);
    assert.match(t, /crossorigin="anonymous"/);
  });
  assert.ok(!/https?:\/\/(?!unpkg\.com|tiles\.openfreemap\.org)[^"'\s]*\.(js|css)/.test(html.replace(/<a [^>]*>/g, '')), 'no other third-party code');
});

test('every local script and stylesheet tag carries a ?v= cache token', () => {
  const html = fs.readFileSync(path.join(MAPDIR, 'index.html'), 'utf8');
  const local = html.match(/(?:src|href)="[A-Za-z0-9_-]+\.(?:js|css)(?:\?v=\d+)?"/g) || [];
  assert.ok(local.length >= 10);
  local.forEach((t) => assert.match(t, /\?v=\d+"/, t));
  // and every script file on disk that the page loads is actually in the HTML
  pageFiles.forEach((f) => assert.ok(html.includes('"' + f + '?v='), f + ' is not loaded by index.html'));
});
