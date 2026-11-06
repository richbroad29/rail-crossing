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
  const every = json(await get('/map/v1/trains')).trains;
  const some = json(await get('/map/v1/trains?bbox=50.8,-0.3,50.95,0.0')).trains;
  assert.ok(some.length < every.length);
  // CONTRACT 19.1: every train whose point is in the box is sent; others only when their span reaches it (not within ~0.5 deg)
  const inside = every.filter((t) => t.lat >= 50.8 && t.lat <= 50.95 && t.lon >= -0.3 && t.lon <= 0.0).map((t) => t.id).sort();
  const sent = new Set(some.map((t) => t.id));
  inside.forEach((id) => assert.ok(sent.has(id), id + ' is in the box but was not sent'));
  some.forEach((t) => assert.ok(t.lat >= 50.3 && t.lat <= 51.45 && t.lon >= -0.8 && t.lon <= 0.5));
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

// ---- phase 2 (CONTRACT sections 8, 9, 11, 14) --------------------------------------------------------------------
test('phase 2: trains carry a motion plan whose span can be fetched, is immutable, and chains end to start', async () => {
  const trains = json(await get('/map/v1/trains')).trains;
  const withMv = trains.filter((t) => t.mv);
  assert.ok(withMv.length > trains.length * 0.8, 'most trains have a plan');
  trains.filter((t) => !t.mv).forEach((t) => assert.equal(t.pl, 'a', 'only rough-position trains lack a span'));
  const t = withMv[0];
  ['sp', 't0', 'eta', 'stop', 'dwell', 'held'].forEach((k) => assert.ok(k in t.mv, k));
  assert.match(t.mv.sp, /^sp_[0-9a-f]{8}$/);
  assert.ok(t.mv.eta > t.mv.t0 && t.mv.t0 <= t.at + 1);
  const r = await get('/map/v1/span/' + t.mv.sp);
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'public, max-age=604800, immutable');
  const sp = json(r);
  assert.equal(sp.id, t.mv.sp); assert.ok(sp.length > 20 && sp.path.length >= 2);
  sp.path.forEach((p) => assert.ok(Array.isArray(p) && p.length === 2 && Math.abs(p[0]) < 90));
  assert.ok('stop' in sp);
  assert.equal((await get('/map/v1/span/sp_00000000')).status, 404);
});

test('phase 2: svc.late and svc.next on passenger trains; calls carry actual, expected, platform changes and cancelled calls', async () => {
  const trains = json(await get('/map/v1/trains')).trains;
  const p = trains.find((t) => t.svc && t.svc.next);
  assert.ok(p, 'a passenger train with a next call');
  assert.equal(typeof p.svc.late, 'number');
  ['name', 'time', 'exp'].forEach((k) => assert.match(String(p.svc.next[k]), k === 'name' ? /./ : /^\d\d:\d\d$/));
  const d = json(await get('/map/v1/train/' + p.id));
  const keys = new Set(); d.service.calls.forEach((c) => Object.keys(c).forEach((k) => keys.add(k)));
  ['actualArr', 'actualDep', 'expArr', 'platformActual'].forEach((k) => assert.ok(keys.has(k), k));
  d.recentBerths.forEach((b) => assert.match(b.sp, /^sp_/));
});

test('phase 2: /station/:crs board; /network at two levels', async () => {
  const b = json(await get('/map/v1/station/BTN'));
  assert.equal(b.station.crs, 'BTN'); assert.ok(Array.isArray(b.board) && Array.isArray(b.recent));
  b.board.forEach((r) => {
    ['trainId', 'hc', 'uid', 'toc', 'o', 'd', 'kind', 'booked', 'expected', 'actual', 'platform', 'late', 'cancelled'].forEach((k) => assert.ok(k in r, k));
    assert.ok(['arr', 'dep', 'pass'].includes(r.kind));
  });
  assert.ok(b.board.some((r) => r.kind === 'dep'));
  assert.equal((await get('/map/v1/station/ZZZ')).status, 404);
  const lo = json(await get('/map/v1/network?level=lo')), hi = json(await get('/map/v1/network?level=hi'));
  assert.equal(lo.type, 'FeatureCollection'); assert.equal(lo.features.length, hi.features.length);
  const pts = (g) => g.features.reduce((n, f) => n + f.geometry.coordinates.length, 0);
  assert.ok(pts(lo) < pts(hi) * 0.7, 'the lo level is coarser: ' + pts(lo) + ' vs ' + pts(hi));
  assert.equal((await get('/map/v1/network?level=hi')).headers['cache-control'], 'public, max-age=86400');
  // the branch lines the tile layer lost at zoom 8-9 are in BOTH levels, running right up to their termini
  const st = json(await get('/map/v1/stations?bbox=50.5,-1.5,51.6,0.7')).stations, by = {}; st.forEach((s) => { by[s.crs] = s; });
  [lo, hi].forEach((g, i) => ['EGR', 'UCK', 'CAT', 'SEF', 'HRH'].forEach((c) => {
    const near = g.features.some((f) => f.geometry.coordinates.some(([lon, lat]) => Math.hypot((lon - by[c].lon) * 70000, (lat - by[c].lat) * 111000) < 60));
    assert.ok(near, c + ' has a line to it in the ' + (i ? 'hi' : 'lo') + ' level');
  }));
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
