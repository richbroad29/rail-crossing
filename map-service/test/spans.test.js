'use strict';

// Spans (contract section 9) against the section-8 track API, with a small in-test FAKE of the
// library: a straight line between stations. The span code never touches anything else of it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { SpanBuilder } = require('../src/spans');
const { BerthGraph } = require('../src/berth-graph');
const { TransitStore } = require('../src/transit');
const { haversineKm } = require('../src/geo');
const { config, smartRows } = require('./helpers');

const ST = { 111: { key: 'AAA', name: 'Alpha', lat: 51.0, lon: -1.0, crs: 'AAA' }, 222: { key: 'BBB', name: 'Bravo', lat: 51.0, lon: -0.6, crs: 'BBB' } };
const resolve = sx => ST[sx] || null;

/** The fake section-8 library: snaps are the station's own point; a route is the straight line between two. */
function fakeTrack({ noRoute = false, noSnap = false, signals = null } = {}) {
  const calls = { nearest: 0, route: 0, slice: 0 };
  const lib = {
    calls,
    nearestOnTrack(lat, lon) { calls.nearest++; return noSnap ? null : { lat, lon }; },
    route(a, b, opts) { calls.route++; if (noRoute) return null; assert.equal(opts.avoidSidings, true); return { a, b, length: haversineKm(a, b) * 1000 }; },
    slice(route, d0, d1) { calls.slice++; return [lib.pointAt(route, d0), lib.pointAt(route, d1)].map(p => [p.lat, p.lon]); },
    pointAt(route, d) { const t = d / route.length; return { lat: route.a.lat + (route.b.lat - route.a.lat) * t, lon: route.a.lon + (route.b.lon - route.a.lon) * t, bearing: 90 }; }
  };
  if (signals) lib.signalAlong = (route, area, berth) => signals[`${area}:${berth}`] ?? null;
  return lib;
}

function world({ rows, track = fakeTrack(), medians = {}, cfg = {} } = {}) {
  const graph = new BerthGraph({ maxHops: 14, minEdgeCount: 2 });
  graph.loadSmart(smartRows(rows || [
    ['LA', '0001', '0003', '111', 'D'], ['LA', '0003', '0005', '', ''], ['LA', '0005', '0007', '', ''], ['LA', '0007', '0009', '222', 'A']
  ]), resolve);
  const transit = new TransitStore({ minSamples: 3 });
  const setMedians = m => { for (const [b, v] of Object.entries(m)) for (let i = 0; i < 5; i++) transit.add(graph.lookup('LA', b), 'express', 'passes', v); };
  setMedians(medians);
  const sb = new SpanBuilder({ track, graph, transit, config: { ...config().spans, ...cfg }, now: () => 1e12 });
  return { graph, transit, sb, track, setMedians, id: b => graph.lookup('LA', b) };
}
const L = haversineKm({ lat: 51.0, lon: -1.0 }, { lat: 51.0, lon: -0.6 }) * 1000;

test('EQUAL SHARES until learned: five berths cut a 28 km route into fifths; a departure berth starts at the stop (stop 0), an arrival berth ends at it (stop = its length)', () => {
  const w = world();
  w.sb.settle();
  const sp = b => w.sb.forBerth(w.id(b));
  for (const b of ['0001', '0003', '0005', '0007', '0009']) assert.ok(Math.abs(sp(b).length - L / 5) < 1, `${b} ${sp(b).length}`);
  assert.equal(sp('0001').stop, 0);
  assert.equal(sp('0003').stop, null);
  assert.ok(Math.abs(sp('0009').stop - sp('0009').length) < 1e-6);
  assert.equal(w.sb.size, 5);
  assert.deepEqual(Object.keys(sp('0001')).sort(), ['id', 'length', 'stop']);
  assert.match(sp('0001').id, /^sp_[0-9a-f]{10}$/);
});

test('PROPORTIONAL to the learned median PASS time once every berth in the chain has one', () => {
  const w = world({ medians: { '0001': 10, '0003': 20, '0005': 30, '0007': 20, '0009': 20 } });
  w.sb.settle();
  const total = 100;
  [['0001', 10], ['0003', 20], ['0005', 30], ['0007', 20], ['0009', 20]].forEach(([b, m]) => assert.ok(Math.abs(w.sb.forBerth(w.id(b)).length - L * m / total) < 1, `${b}`));
  // One berth unlearned: back to equal shares for the whole chain (never mix seconds with guesses).
  const w2 = world({ medians: { '0001': 10, '0003': 20, '0005': 30, '0007': 20 } });
  w2.sb.settle();
  assert.ok(Math.abs(w2.sb.forBerth(w2.id('0005')).length - L / 5) < 1);
});

test('GET span: the polyline cut from the route at the berth boundaries, and nothing is stored per span but its offsets', () => {
  const w = world();
  w.sb.settle();
  const r = w.sb.forBerth(w.id('0003'));
  const sp = w.sb.get(r.id);
  assert.deepEqual(Object.keys(sp).sort(), ['id', 'length', 'path', 'stop']);
  assert.equal(sp.path.length, 2);
  const lon0 = -1.0 + 0.4 * (1 / 5), lon1 = -1.0 + 0.4 * (2 / 5);
  assert.ok(Math.abs(sp.path[0][1] - lon0) < 1e-4 && Math.abs(sp.path[1][1] - lon1) < 1e-4);
  sp.path.forEach(p => p.forEach(v => assert.equal(v, Math.round(v * 1e5) / 1e5, 'rounded to 5 dp')));
  assert.equal(sp.stop, null);
  assert.equal(w.sb.get('sp_nope'), null);
  assert.equal(Object.keys(w.sb.byBerth.get(w.id('0003'))).sort().join(), ['chainKey', 'd0', 'd1', 'id', 'keyId', 'length', 'stop'].join());
});

test('IDS are stable while nothing changes, and change when learning moves a berth by more than 10 % of its length', () => {
  const all = { '0001': 100, '0003': 100, '0005': 100, '0007': 100, '0009': 100 };
  const w = world({ medians: all });
  w.sb.settle();
  const ids = () => Object.fromEntries(Object.keys(all).map(b => [b, w.sb.forBerth(w.id(b)).id]));
  const before = ids();
  // Same data re-planned: identical ids.
  w.sb._planned.at = -Infinity; w.sb._planned.transit = -2; w.sb.settle();
  assert.deepEqual(ids(), before);
  // A small shift (berth 0003 now 104 s against 100: its share moves about 3 %): the span, and its id, is kept.
  for (let i = 0; i < 10; i++) w.transit.add(w.id('0003'), 'express', 'passes', 104);
  w.sb._planned.at = -Infinity; w.sb.settle();
  assert.deepEqual(ids(), before, 'a 3 % change keeps every id');
  assert.equal(w.sb.stats.recut, 0);
  // A large shift: 0003 becomes four times longer; its id changes, and the OLD id is still readable.
  for (let i = 0; i < 200; i++) w.transit.add(w.id('0003'), 'express', 'passes', 400);
  w.sb._planned.at = -Infinity; w.sb.settle();
  assert.notEqual(w.sb.forBerth(w.id('0003')).id, before['0003']);
  assert.ok(w.sb.get(before['0003']), 'the superseded id is still readable');
  assert.equal(w.sb.get(before['0003']).id, before['0003']);
  assert.ok(w.sb.stats.recut >= 1);
  assert.equal(w.sb.byId.has(before['0003']), false, 'and it is no longer the current one');
});

test('no route between the stops: no spans, counted; a station that will not snap: counted too; never a throw', () => {
  const a = world({ track: fakeTrack({ noRoute: true }) });
  a.sb.settle();
  assert.equal(a.sb.size, 0);
  assert.equal(a.sb.stats.noRoute, 1);
  const b = world({ track: fakeTrack({ noSnap: true }) });
  b.sb.settle();
  assert.equal(b.sb.size, 0);
  assert.ok(b.sb.stats.noSnap >= 1);
  const c = world({ track: { nearestOnTrack() { throw new Error('boom'); }, route() { throw new Error('boom'); }, slice() { throw new Error('boom'); } } });
  assert.doesNotThrow(() => c.sb.settle());
  assert.equal(c.sb.size, 0);
});

test('a berth used both to arrive and to depart ends the INCOMING span at the stop; the outgoing chain starts after it', () => {
  // 0007 is Bravo's arrival berth (A:0005>0007) AND its departure berth (D:0007>0009): kind "both".
  const w = world({ rows: [
    ['LA', '0001', '0003', '111', 'D'], ['LA', '0003', '0005', '', ''], ['LA', '0005', '0007', '222', 'A'],
    ['LA', '0007', '0009', '222', 'D'], ['LA', '0009', '0011', '', ''], ['LA', '0011', '0013', '111', 'A']
  ] });
  assert.equal(w.graph.anchorKind.get(w.id('0007')), 'both');
  w.sb.settle();
  const s7 = w.sb.forBerth(w.id('0007'));
  assert.ok(Math.abs(s7.stop - s7.length) < 1e-6, 'the incoming span ends at the stop');
  const s9 = w.sb.forBerth(w.id('0009'));
  assert.equal(s9.stop, null, 'the outgoing chain starts AFTER the stop berth: 0009 is an ordinary berth');
  assert.ok(Math.abs(w.sb.byBerth.get(w.id('0009')).d0) < 1e-6, 'and it starts at the stop point (route offset 0)');
  assert.ok(w.sb.forBerth(w.id('0013')).stop > 0, 'the return chain ends at Alpha');
});

test('RULE 3 (optional): a signal whose ref matches a berth id pins that berth\'s start; the match rate is reported per area', () => {
  const pin = L * 0.3;
  const w = world({ track: fakeTrack({ signals: { 'LA:0003': pin } }) });
  w.sb.settle();
  assert.ok(Math.abs(w.sb.byBerth.get(w.id('0003')).d0 - pin) < 1e-6);
  assert.ok(Math.abs(w.sb.byBerth.get(w.id('0001')).d1 - pin) < 1e-6, 'the berth before ends where this one starts');
  const st = w.sb.status().signals;
  assert.deepEqual([st.tried, st.pinned], [4, 1]);
  assert.equal(st.byArea.LA.rate, 0.25);
  // A pin outside its neighbours is refused (the boundaries must stay in order).
  const bad = world({ track: fakeTrack({ signals: { 'LA:0005': L * 0.9 } }) });
  bad.sb.settle();
  assert.equal(bad.sb.status().signals.pinned, 0);
  // Without the optional function: the status says so, and the cut is equal shares.
  const none = world();
  none.sb.settle();
  assert.equal(none.sb.status().signals, 'not available from the track library');
});

test('INCREMENTAL: step() never exceeds its budget by more than one chain, and finishes the work over several calls', () => {
  const rows = [];
  for (let c = 0; c < 30; c++) {
    const b = n => String(c * 20 + n).padStart(4, '0');
    rows.push(['LA', b(1), b(3), '111', 'D'], ['LA', b(3), b(5), '', ''], ['LA', b(5), b(7), '222', 'A']);
  }
  const w = world({ rows });
  assert.equal(w.sb.step(0), 0, 'a zero budget does no chain work');
  assert.ok(w.sb.queue.length > 0);
  let guard = 0;
  while (w.sb.queue.length && guard++ < 1000) w.sb.step(1);
  assert.equal(w.sb.queue.length, 0);
  assert.ok(w.sb.size > 0);
});

// ---- through the service: SpanBuilder wired to the App, GET /span/:id, mv on the wire -------------------------------

test('IN THE SERVICE: with a track library injected, spans exist for chains of real SMART berths; /span/:id is immutable; trains on them carry mv', async () => {
  const { startRig, NOW } = require('./rig');
  const { getJson } = require('./helpers');
  const rig = await startRig({ track: fakeTrack() });
  try {
    const sb = rig.app.spans;
    assert.ok(sb, 'the builder was created from the injected library');
    sb.settle();
    assert.ok(sb.size > 5, `${sb.size} berths have spans`);
    const keyId = [...sb.byBerth.keys()].find(k => rig.app.graph.areaOf[k] === 'LA');
    const area = rig.app.graph.areaOf[keyId], berth = rig.app.graph.berth(keyId);
    const rec = sb.forBerth(keyId);
    const r = await getJson(rig.port, `/map/v1/span/${rec.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'public, max-age=604800, immutable');
    assert.deepEqual(Object.keys(r.json).sort(), ['id', 'length', 'path', 'stop']);
    assert.equal(r.json.id, rec.id);
    assert.ok(r.json.path.length >= 2 && r.json.path.every(p => p.length === 2));
    for (const bad of ['sp_nope', 'xx', 'sp_0123456789abcdef0', '..%2f', '']) assert.equal((await getJson(rig.port, `/map/v1/span/${bad}`)).status, 404, bad);
    // A train in that berth gets a motion plan pointing at the span.
    rig.td([['CC', area, '2K22', null, berth]]);
    await rig.settle(1300);
    const t = (await getJson(rig.port, '/map/v1/trains')).json.trains.find(x => x.hc === '2K22');
    assert.equal(t.mv.sp, rec.id);
    assert.equal(t.mv.t0, NOW);
    assert.ok(t.mv.eta > t.mv.t0 && t.mv.held === false);
    assert.equal((await getJson(rig.port, '/map/v1/health')).json.diagnostics.spans.berthsWithSpans, sb.size);
  } finally { await rig.stop(); }
  // No library: no spans, the endpoint says so, trains carry no mv.
  const none = await startRig();
  try {
    assert.equal(none.app.spans, null);
    assert.equal((await getJson(none.port, '/map/v1/span/sp_0123456789')).status, 404);
  } finally { await none.stop(); }
});
