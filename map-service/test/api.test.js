'use strict';

// Every endpoint's exact shape against the contract (section 5), errors, gzip, bbox, search.

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { startRig } = require('./rig');
const { get, getJson, sleep, until } = require('./helpers');

const keys = o => Object.keys(o).sort();
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const dp5 = v => Math.abs(v * 1e5 - Math.round(v * 1e5)) < 1e-6;

// Shape checks, one per contract type. Exact key sets: an extra or missing field fails.
function checkTrain(t, { svc } = {}) {
  assert.deepEqual(keys(t), ['area', 'at', 'berth', 'hc', 'hdg', 'id', 'lat', 'lon', 'pl', ...(t.svc ? ['svc'] : [])].sort());
  assert.equal(typeof t.id, 'string'); assert.equal(typeof t.hc, 'string');
  assert.ok(isNum(t.lat) && isNum(t.lon) && dp5(t.lat) && dp5(t.lon), 'coordinates rounded to 5 dp');
  assert.ok(t.hdg === null || (Number.isInteger(t.hdg) && t.hdg >= 0 && t.hdg < 360));
  assert.equal(typeof t.area, 'string'); assert.equal(typeof t.berth, 'string');
  assert.ok(Number.isInteger(t.at));
  assert.ok(['s', 'i', 'a'].includes(t.pl));
  if (t.svc) checkSvc(t.svc);
  if (svc === true) assert.ok(t.svc, 'expected a service match');
  if (svc === false) assert.equal(t.svc, undefined);
}
function checkSvc(s) {
  assert.deepEqual(keys(s), ['arr', 'cat', 'd', 'dep', 'load', 'o', 'pwr', 'toc', 'uid']);
  for (const k of ['arr', 'dep']) assert.match(s[k], /^\d\d:\d\d$/);
  for (const k of ['uid', 'toc', 'o', 'd', 'cat', 'pwr', 'load']) assert.equal(typeof s[k], 'string');
}
function checkTrains(j) {
  assert.deepEqual(keys(j), ['feedStale', 'serverTime', 'trains']);
  assert.ok(Number.isInteger(j.serverTime)); assert.equal(typeof j.feedStale, 'boolean'); assert.ok(Array.isArray(j.trains));
  j.trains.forEach(t => checkTrain(t));
}
const checkError = (r, status) => {
  assert.equal(r.status, status);
  assert.match(r.headers['content-type'], /^application\/json/);
  assert.deepEqual(keys(r.json), ['error']);
  assert.equal(typeof r.json.error, 'string');
  assert.ok(r.json.error.length > 5 && !/\bat .*\(.*:\d+:\d+\)|node_modules|TypeError|Error:/.test(r.json.error), 'a plain sentence, never a stack trace');
};

async function world() {
  const rig = await startRig();
  rig.td([
    ['CC', 'LA', '1H15', null, '0002'],        // Portslade (anchor, with a timetable match)
    ['CC', 'LA', '2K22', null, '0003'],        // between Aldrington and Portslade
    ['CC', 'LA', '9Z99', null, '9999'],        // a berth nothing knows: unplaceable
    ['CC', 'A2', '3M33', null, '0630']         // Pluckley, Kent: far from the others
  ]);
  await until(() => rig.app.model.byId.size === 4, 2000, 'four trains');
  await rig.settle();
  const trains = (await getJson(rig.port, '/map/v1/trains')).json.trains;
  const byHc = Object.fromEntries(trains.map(t => [t.hc, t]));
  return { rig, byHc };
}

test('GET /health: exact shape, plain numbers, and it is truthful', async () => {
  const { rig } = await world();
  try {
    const r = await getJson(rig.port, '/map/v1/health');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^application\/json/);
    const h = r.json;
    assert.deepEqual(keys(h), ['clients', 'diagnostics', 'feeds', 'heapMB', 'model', 'reference', 'rssMB', 'status', 'uptimeSecs']);
    assert.ok(['ok', 'degraded', 'starting'].includes(h.status));
    assert.equal(h.status, 'ok');
    assert.ok(isNum(h.uptimeSecs) && isNum(h.rssMB) && isNum(h.heapMB) && h.rssMB > 10);
    assert.deepEqual(keys(h.feeds), ['td', 'trust', 'vstp']);
    assert.deepEqual(keys(h.feeds.td), ['connected', 'lastMessageAt', 'messagesPerMin', 'staleSecs']);
    assert.deepEqual(keys(h.feeds.trust), ['activations', 'connected', 'lastMessageAt', 'messagesPerMin', 'staleSecs']);
    assert.deepEqual(keys(h.feeds.vstp), ['connected', 'lastMessageAt', 'messagesPerMin', 'schedules', 'staleSecs']);
    assert.equal(h.feeds.trust.connected, true); assert.equal(h.feeds.vstp.connected, true);
    assert.deepEqual(keys(h.diagnostics), ['record', 'spans', 'track', 'transit', 'trust', 'vstp']);
    assert.equal(h.feeds.td.connected, true);
    assert.deepEqual(keys(h.reference), ['cif', 'corpus', 'naptan', 'smart']);
    for (const k of ['smart', 'corpus', 'naptan']) { assert.deepEqual(keys(h.reference[k]), ['loadedAt', 'rows']); assert.ok(h.reference[k].rows > 10); assert.ok(isNum(h.reference[k].loadedAt)); }
    assert.deepEqual(keys(h.reference.cif), ['loadedAt', 'schedules']);
    assert.equal(h.reference.cif.schedules, 1);
    assert.deepEqual(keys(h.model), ['anchoredBerths', 'learnedEdges', 'placed', 'trains', 'unplaced']);
    assert.deepEqual([h.model.trains, h.model.placed, h.model.unplaced], [4, 3, 1]);
    assert.ok(h.model.anchoredBerths > 50);
    assert.deepEqual(h.clients, { sse: 0 });
  } finally { await rig.stop(); }
});

test('GET /health reports "starting" before reference data is loaded, "degraded" when TD is stale', async () => {
  const rig = await startRig({ start: false });
  try {
    // Hold the app back: listen, but do not load anything.
    await new Promise(r => rig.app.server.listen(0, '127.0.0.1', r));
    rig.app.port = rig.app.server.address().port; rig.app.listening = true;
    let r = await getJson(rig.app.port, '/map/v1/health');
    assert.equal(r.json.status, 'starting');
    assert.equal(r.json.feeds.td.connected, false);
    assert.equal(r.json.reference.smart.rows, 0);
  } finally { await rig.stop(); }
  const rig2 = await startRig();
  try {
    assert.equal((await getJson(rig2.port, '/map/v1/health')).json.status, 'ok');
    rig2.clock.now += 10 * 60 * 1000;                          // ten minutes with no TD
    rig2.app.td.lastMessageAt = rig2.clock.now - 10 * 60 * 1000;
    const h = (await getJson(rig2.port, '/map/v1/health')).json;
    assert.equal(h.status, 'degraded');
    assert.ok(h.feeds.td.staleSecs >= 600);
    const t = (await getJson(rig2.port, '/map/v1/trains'));
    await sleep(1200);
    assert.equal((await getJson(rig2.port, '/map/v1/trains')).json.feedStale, true, 'the page is told the feed is stale');
  } finally { await rig2.stop(); }
});

test('GET /trains: every PLACED train, exact Train shape, the unplaceable one counted but not drawn', async () => {
  const { rig, byHc } = await world();
  try {
    const r = await getJson(rig.port, '/map/v1/trains');
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.match(r.headers['content-type'], /^application\/json/);
    assert.ok(!Object.keys(r.headers).some(h => h.startsWith('access-control-')), 'CORS is Caddy\'s job');
    checkTrains(r.json);
    assert.deepEqual(r.json.trains.map(t => t.hc).sort(), ['1H15', '2K22', '3M33']);
    assert.equal(r.json.feedStale, false);
    assert.deepEqual([byHc['1H15'].pl, byHc['2K22'].pl], ['s', 'i']);
    assert.deepEqual([byHc['1H15'].area, byHc['1H15'].berth], ['LA', '0002']);
    assert.ok(Math.abs(byHc['1H15'].lat - 50.83568) < 1e-4 && Math.abs(byHc['1H15'].lon - -0.20534) < 1e-4, 'Portslade, from NaPTAN');
    assert.equal(byHc['1H15'].at, rig.clock.now, 'at = the feed time it entered the berth');
    assert.deepEqual(keys(byHc['1H15'].svc), ['arr', 'cat', 'd', 'dep', 'load', 'o', 'pwr', 'toc', 'uid']);
    assert.deepEqual(byHc['1H15'].svc, { uid: 'C00001', toc: 'SN', o: 'Littlehampton', d: 'London Victoria', dep: '09:30', arr: '11:15', cat: 'OO', pwr: 'EMU', load: '377' });
    assert.equal(byHc['2K22'].svc, undefined, 'no service match: no svc key, never a guess');
  } finally { await rig.stop(); }
});

test('GET /trains?bbox=S,W,N,E filters; no bbox is all of GB', async () => {
  const { rig } = await world();
  try {
    const sussex = (await getJson(rig.port, '/map/v1/trains?bbox=50.7,-0.4,50.95,-0.1')).json;
    checkTrains(sussex);
    assert.deepEqual(sussex.trains.map(t => t.hc).sort(), ['1H15', '2K22']);
    const kent = (await getJson(rig.port, '/map/v1/trains?bbox=51.0,0.5,51.3,0.9')).json;
    assert.deepEqual(kent.trains.map(t => t.hc), ['3M33']);
    const none = (await getJson(rig.port, '/map/v1/trains?bbox=55,-4,56,-3')).json;
    assert.deepEqual(none.trains, []);
    assert.equal((await getJson(rig.port, '/map/v1/trains?bbox=-90,-180,90,180')).json.trains.length, 3);
    // edges inclusive
    assert.equal((await getJson(rig.port, '/map/v1/trains?bbox=51.15647301958,0.74739597705,51.15647301958,0.74739597705')).json.trains.length, 1);
  } finally { await rig.stop(); }
});

test('bad bbox values are 400 with a plain sentence', async () => {
  const { rig } = await world();
  try {
    for (const q of ['', 'abc', '1,2,3', '1,2,3,4,5', '1,2,3,x', '5,0,4,1', '1,5,2,4', '-91,0,0,1', '0,0,91,1', '0,-181,1,0', 'Infinity,0,1,1', '1,,2,3', '%00']) {
      for (const path of ['/map/v1/trains', '/map/v1/stations', '/map/v1/stream']) {
        const r = await getJson(rig.port, `${path}?bbox=${q}`);
        checkError(r, 400);
      }
    }
  } finally { await rig.stop(); }
});

test('gzip: compressed when the client accepts it, identical content, plain otherwise', async () => {
  const { rig } = await world();
  try {
    const plain = await get(rig.port, '/map/v1/trains', { headers: { 'Accept-Encoding': 'identity' } });
    assert.equal(plain.headers['content-encoding'], undefined);
    const gz = await get(rig.port, '/map/v1/trains', { headers: { 'Accept-Encoding': 'gzip, deflate' } });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.match(gz.headers.vary, /Accept-Encoding/);
    assert.equal(zlib.gunzipSync(gz.body).toString(), plain.body.toString());
    const gzBox = await get(rig.port, '/map/v1/trains?bbox=50.7,-0.4,50.95,-0.1', { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(JSON.parse(zlib.gunzipSync(gzBox.body)).trains.length, 2);
    assert.equal(Number(gzBox.headers['content-length']), gzBox.body.length);
    // Errors are small and plain.
    const err = await get(rig.port, '/map/v1/nothing', { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(err.status, 404);
  } finally { await rig.stop(); }
});

test('GET /train/:id: exact shape, service detail, place, recent berths, trail', async () => {
  const { rig, byHc } = await world();
  try {
    // Give 1H15 a history: step Aldrington -> (between) -> Portslade over time.
    rig.clock.now += 60_000; rig.td([['CA', 'LA', '1H15', '0002', '0004']]);
    rig.clock.now += 60_000; rig.td([['CA', 'LA', '1H15', '0004', '0006']]);
    await rig.settle();
    const id = byHc['1H15'].id;
    const r = await getJson(rig.port, `/map/v1/train/${id}`);
    assert.equal(r.status, 200);
    const d = r.json;
    assert.deepEqual(keys(d), ['firstSeenAt', 'place', 'previousHeadcodes', 'recentBerths', 'service', 'speedMphEstimate', 'trail', 'train']);
    checkTrain(d.train, { svc: true });
    assert.equal(d.train.id, id);
    assert.deepEqual([d.train.area, d.train.berth, d.train.pl], ['LA', '0006', 's']);
    assert.deepEqual(d.previousHeadcodes, []);
    assert.equal(d.firstSeenAt, byHc['1H15'].at);
    assert.deepEqual(d.recentBerths.map(b => b.berth), ['0002', '0004', '0006']);
    d.recentBerths.forEach(b => { assert.deepEqual(keys(b), ['area', 'at', 'berth', 'sp']); assert.ok(Number.isInteger(b.at)); assert.equal(b.sp, null, 'no track pack: no span'); });
    assert.equal(d.trail.length, 3);
    d.trail.forEach(p => { assert.equal(p.length, 3); assert.ok(isNum(p[0]) && isNum(p[1]) && Number.isInteger(p[2])); });
    assert.deepEqual(d.place, { kind: 'station', station: 'Southwick' });
    assert.ok(d.speedMphEstimate === null || isNum(d.speedMphEstimate));
    // The timetable section.
    assert.deepEqual(keys(d.service), ['calls', 'category', 'destination', 'headcode', 'lastReport', 'origin', 'power', 'speedMph', 'stp', 'timingLoad', 'toc', 'uid']);
    assert.equal(d.service.lastReport, null, 'no TRUST report: null');
    assert.deepEqual([d.service.uid, d.service.stp, d.service.toc, d.service.headcode, d.service.category, d.service.power, d.service.timingLoad, d.service.speedMph], ['C00001', 'P', 'SN', '1H15', 'OO', 'EMU', '377', 75]);
    assert.deepEqual(d.service.origin, { name: 'Littlehampton', time: '09:30' });
    assert.deepEqual(d.service.destination, { name: 'London Victoria', time: '11:15' });
    d.service.calls.forEach(c => { assert.deepEqual(keys(c), ['actualArr', 'actualDep', 'actualPass', 'arr', 'cancelled', 'dep', 'expArr', 'expDep', 'name', 'pass', 'platform', 'platformActual', 'tiploc', 'variation']); assert.equal(c.cancelled, false); assert.equal(c.actualArr, null); });
    assert.deepEqual(d.service.calls.map(c => c.tiploc), ['LTLHMPT', 'STHWICK', 'PSLDAWH', 'VICTRIC']);
    // Interpolated and unmatched trains.
    const d2 = (await getJson(rig.port, `/map/v1/train/${byHc['2K22'].id}`)).json;
    assert.equal(d2.service, null);
    assert.deepEqual(d2.place, { kind: 'between', between: ['Aldrington', 'Portslade'] });
  } finally { await rig.stop(); }
});

test('GET /train/:id: renumbering shows previousHeadcodes; unknown, unplaced and malformed ids are 404', async () => {
  const { rig, byHc } = await world();
  try {
    rig.td([['CB', 'LA', '2K22', '0003']]); rig.td([['CC', 'LA', '2K23', null, '0003']]);
    await rig.settle();
    const d = (await getJson(rig.port, `/map/v1/train/${byHc['2K22'].id}`)).json;
    assert.equal(d.train.hc, '2K23');
    assert.deepEqual(d.previousHeadcodes, ['2K22']);
    for (const id of ['nope', 'tzzzzzz', '../etc/passwd', 'a%2Fb', 'x'.repeat(40), '%E0%A4%A', '']) checkError(await getJson(rig.port, `/map/v1/train/${id}`), id === '%E0%A4%A' ? 400 : 404);
    const unplaced = [...rig.app.model.byId.values()].find(t => t.hc === '9Z99');
    checkError(await getJson(rig.port, `/map/v1/train/${unplaced.id}`), 404);     // not drawn, so not detailed
  } finally { await rig.stop(); }
});

test('GET /stations: exact shape, bbox filter, cacheable for a day', async () => {
  const { rig } = await world();
  try {
    const r = await getJson(rig.port, '/map/v1/stations?bbox=50.8,-0.3,50.9,-0.15');
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'public, max-age=86400');
    assert.deepEqual(keys(r.json), ['stations']);
    r.json.stations.forEach(s => { assert.deepEqual(keys(s), ['crs', 'lat', 'lon', 'name', 'tiploc']); assert.equal(typeof s.tiploc, 'string'); assert.ok(isNum(s.lat) && isNum(s.lon)); });
    const names = r.json.stations.map(s => s.name);
    assert.ok(names.includes('Portslade') && names.includes('Southwick'), names.join());
    const pld = r.json.stations.find(s => s.name === 'Portslade');
    assert.deepEqual([pld.tiploc, pld.crs], ['PSLDAWH', 'PLD']);
    const all = (await getJson(rig.port, '/map/v1/stations')).json.stations;
    assert.ok(all.length > r.json.stations.length);
  } finally { await rig.stop(); }
});

test('GET /search: headcode prefix, station name, CRS; at most 20; plain errors', async () => {
  const { rig } = await world();
  try {
    let r = (await getJson(rig.port, '/map/v1/search?q=1h')).json;
    assert.deepEqual(keys(r), ['stations', 'trains']);
    assert.equal(r.trains.length, 1);
    assert.deepEqual(keys(r.trains[0]), ['d', 'hc', 'id', 'o']);
    assert.deepEqual([r.trains[0].hc, r.trains[0].o, r.trains[0].d], ['1H15', 'Littlehampton', 'London Victoria']);
    r = (await getJson(rig.port, '/map/v1/search?q=2K')).json;
    assert.deepEqual([r.trains[0].hc, r.trains[0].o, r.trains[0].d], ['2K22', null, null]);
    r = (await getJson(rig.port, '/map/v1/search?q=Ports')).json;
    assert.equal(r.stations[0].name, 'Portslade');
    assert.deepEqual(keys(r.stations[0]), ['crs', 'lat', 'lon', 'name']);
    r = (await getJson(rig.port, '/map/v1/search?q=PLD')).json;
    assert.equal(r.stations[0].crs, 'PLD');
    r = (await getJson(rig.port, '/map/v1/search?q=zzzzzz')).json;
    assert.deepEqual(r, { trains: [], stations: [] });
    r = (await getJson(rig.port, '/map/v1/search?q=a')).json;
    assert.ok(r.trains.length + r.stations.length <= 20);
    checkError(await getJson(rig.port, '/map/v1/search'), 400);
    checkError(await getJson(rig.port, '/map/v1/search?q='), 400);
    checkError(await getJson(rig.port, '/map/v1/search?q=' + 'x'.repeat(41)), 400);
  } finally { await rig.stop(); }
});

test('errors: unknown paths 404, wrong methods 405, long URLs 414, a thrown handler 500 - always {error}, never a stack', async () => {
  const { rig } = await world();
  try {
    checkError(await getJson(rig.port, '/map/v1/nothing'), 404);
    checkError(await getJson(rig.port, '/other'), 404);
    checkError(await getJson(rig.port, '/'), 404);
    checkError(await getJson(rig.port, '/map/v1/train/'), 404);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await getJson(rig.port, '/map/v1/health', { method });
      checkError(r, 405);
      assert.match(r.headers.allow, /GET/);
    }
    checkError(await getJson(rig.port, '/map/v1/trains?x=' + 'a'.repeat(3000)), 414);
    // Trailing slash tolerated.
    assert.equal((await getJson(rig.port, '/map/v1/health/')).status, 200);
    // A handler that throws becomes a 500 sentence and the service lives on.
    const real = rig.app.health; rig.app.health = () => { throw new TypeError('secret internals at /srv/app.js:12:3'); };
    const r = await getJson(rig.port, '/map/v1/health');
    checkError(r, 500);
    assert.ok(!r.body.toString().includes('secret'));
    rig.app.health = real;
    assert.equal((await getJson(rig.port, '/map/v1/health')).status, 200);
    // An async failure too.
    const realSearch = rig.app.search; rig.app.search = () => { throw new Error('async boom'); };
    checkError(await getJson(rig.port, '/map/v1/search?q=a'), 500);
    rig.app.search = realSearch;
  } finally { await rig.stop(); }
});

test('HEAD returns headers and no body', async () => {
  const { rig } = await world();
  try {
    const r = await get(rig.port, '/map/v1/health', { method: 'HEAD', headers: { 'Accept-Encoding': 'identity' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 0);
    assert.ok(Number(r.headers['content-length']) > 100);
  } finally { await rig.stop(); }
});
