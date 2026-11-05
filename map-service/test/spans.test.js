'use strict';

// Spans (contract section 9) against the REAL track library API (section 8). The unit tests use a small fake that behaves like the
// real library at the calls spans.js makes (arrays of station snaps, route over arrays, slice, alongRoute, signals) so every rule
// has a planted answer; the last tests run the real library on a real cut of the Sussex pack (test/fixtures/track-sussex.bin).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SpanBuilder, numberOf, exactKey } = require('../src/spans');
const { BerthGraph } = require('../src/berth-graph');
const { TransitStore } = require('../src/transit');
const { loadPack } = require('../src/track');
const { haversineKm } = require('../src/geo');
const { config, smartRows } = require('./helpers');

const ST = { 111: { key: 'AAA', name: 'Alpha', lat: 51.0, lon: -1.0, crs: 'AAA' }, 222: { key: 'BBB', name: 'Bravo', lat: 51.0, lon: -0.6, crs: 'BBB' } };
const resolve = sx => ST[sx] || null;
const LATLON = { AAA: { lat: 51.0, lon: -1.0 }, BBB: { lat: 51.0, lon: -0.6 } };

/**
 * A fake of the real library: stations are points on a straight line; a station has one snap, or two platform snaps ('1', '2') when
 * `platforms` is set (platform 2 is 50 m further, so the shortest route never picks it by itself); a route is the straight line.
 * `signals`: [{ref, d (metres along the route), onRoute (default true), direction, onWay}].
 */
function fakeTrack({ noRoute = false, noSnap = false, platforms = false, signals = null, routeScale = 1 } = {}) {
  const calls = { route: [], stationSnaps: [] };
  const lib = {
    calls,
    stationSnaps(nameOrTiploc) {
      calls.stationSnaps.push(nameOrTiploc);
      const key = LATLON[nameOrTiploc] ? nameOrTiploc : null;
      if (noSnap || !key) return [];
      const p = LATLON[key];
      if (!platforms) return [{ tiploc: key, platform: null, primary: true, edge: 1, offset: 0, lat: p.lat, lon: p.lon }];
      return [{ tiploc: key, platform: '1', primary: false, edge: 1, offset: 0, lat: p.lat, lon: p.lon, extra: 0 }, { tiploc: key, platform: '2', primary: false, edge: 1, offset: 0, lat: p.lat, lon: p.lon, extra: 50 }];
    },
    route(a, b, opts) {
      calls.route.push({ a, b, opts });
      assert.ok(Array.isArray(a) && Array.isArray(b), 'routes are ALWAYS between arrays of snaps, never single snaps');
      assert.equal(opts.avoidSidings, true);
      assert.ok(opts.maxLength > 0, 'a search bound is always given');
      if (noRoute) return null;
      let best = null;
      for (const x of a) for (const y of b) {
        const len = (haversineKm(x, y) * 1000 + (x.extra || 0) + (y.extra || 0)) * routeScale;
        if (!best || len < best.length) best = { length: len, pieces: [{ e: 1, dir: 0, a: 0, b: len }], from: x, to: y, fromPt: x, toPt: y };
      }
      return best;
    },
    slice(route, d0, d1) { return [lib._at(route, d0), lib._at(route, d1)]; },
    _at(route, d) { const t = d / route.length; return [route.fromPt.lat + (route.toPt.lat - route.fromPt.lat) * t, route.fromPt.lon + (route.toPt.lon - route.fromPt.lon) * t]; }
  };
  if (signals) {
    lib.signals = () => signals.map((s, i) => ({ edge: s.onRoute === false ? 2 : 1, offset: s.d, ref: s.ref, direction: s.direction || 'unknown', side: 'left', onWay: !!s.onWay, dist: 1, lat: 0, lon: 0, kind: 1, id: i }));
    lib.alongRoute = (route, edge, offset, withDir) => (edge === 1 ? (withDir ? { d: offset, reversed: !!route.reversed } : offset) : null);
  }
  return lib;
}

const ROWS = [['LA', '0001', '0003', '111', 'D'], ['LA', '0003', '0005', '', ''], ['LA', '0005', '0007', '', ''], ['LA', '0007', '0009', '222', 'A']];

function world({ rows = ROWS, track = fakeTrack(), medians = {}, cfg = {} } = {}) {
  const graph = new BerthGraph({ maxHops: 14, minEdgeCount: 2 });
  graph.loadSmart(smartRows(rows), resolve);
  const transit = new TransitStore({ minSamples: 3 });
  const setMedians = m => { for (const [b, v] of Object.entries(m)) for (let i = 0; i < 5; i++) transit.add(graph.lookup('LA', b), 'express', 'passes', v); };
  setMedians(medians);
  const sb = new SpanBuilder({ track, graph, transit, config: { ...config().spans, ...cfg }, now: () => 1e12 });
  return { graph, transit, sb, track, setMedians, id: b => graph.lookup('LA', b) };
}
const L = haversineKm(LATLON.AAA, LATLON.BBB) * 1000;

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
  assert.deepEqual(w.sb.rules(), { berths: 5, stopPinned: 2, signalPinned: 0, cutLearned: 0, cutEqual: 5, bothEndsFixed: 0 });
});

test('the library is used ONLY through arrays of station snaps: by TIPLOC, falling back to the name', () => {
  const t = fakeTrack();
  const w = world({ track: t });
  w.sb.settle();
  assert.deepEqual(t.calls.stationSnaps.sort(), ['AAA', 'BBB']);
  assert.equal(t.calls.route.length, 1);
  // A station the pack knows only by NAME is found by name.
  const byName = fakeTrack();
  const asked = [];
  const orig = byName.stationSnaps;
  byName.stationSnaps = k => { asked.push(k); return k === 'Alpha' ? orig('AAA') : orig(k); };
  const g = world({ track: byName });
  const savedKey = ST[111].key; ST[111].key = 'NOTINPACK';
  try { g.sb.settle(); } finally { ST[111].key = savedKey; }
  assert.deepEqual(asked.filter(k => k !== 'BBB'), ['NOTINPACK', 'Alpha'], 'the TIPLOC first, then the name');
  assert.equal(g.sb.size, 5, 'and the chain was built from the name match');
});

test('PLATFORM: the platform SMART names selects that platform\'s snaps, so two directions can land on their own tracks', () => {
  const rows = [['LA', '0001', '0003', '111', 'D', '2'], ['LA', '0003', '0005', '', ''], ['LA', '0005', '0007', '222', 'A', '2']];
  const t = fakeTrack({ platforms: true });
  const w = world({ rows, track: t });
  w.sb.settle();
  // Unconstrained, the shortest route uses platform 1 at both ends; SMART says 2 at both, which is only 100 m longer.
  const last = t.calls.route.at(-1);
  assert.deepEqual([last.a.map(s => s.platform), last.b.map(s => s.platform)], [['2'], ['2']]);
  assert.equal(w.sb.stats.platform.used, 1);
  assert.ok(Math.abs(w.sb.byBerth.get(w.id('0007')).d1 - (L + 100)) < 1, 'the route used is the platform-2 route (100 m longer)');
});

test('PLATFORM: a platform the pack does not have, or a platform route that is a wild detour, falls back to the shortest route', () => {
  // SMART says platform 9: no snap has it.
  const t = fakeTrack({ platforms: true });
  const w = world({ rows: [['LA', '0001', '0003', '111', 'D', '9'], ['LA', '0003', '0005', '222', 'A', '9']], track: t });
  w.sb.settle();
  assert.equal(w.sb.size, 3);
  assert.equal(w.sb.stats.platform.tried, 0);
  // Platform 2 exists but its route is more than 1.3x + 200 m longer: refused.
  const t2 = fakeTrack({ platforms: true });
  const lib = t2.route.bind(t2);
  t2.route = (a, b, o) => { const r = lib(a, b, o); if (r && a.length === 1 && a[0].platform === '2') { r.length *= 3; r.pieces[0].b = r.length; } return r; };
  const w2 = world({ rows: [['LA', '0001', '0003', '111', 'D', '2'], ['LA', '0003', '0005', '222', 'A', '2']], track: t2 });
  w2.sb.settle();
  assert.equal(w2.sb.stats.platform.refused, 1);
  assert.ok(Math.abs(w2.sb.byBerth.get(w2.id('0005')).d1 - L) < 1, 'the plain shortest route');
});

test('PROPORTIONAL to the learned median PASS time once every berth in the chain has one', () => {
  const w = world({ medians: { '0001': 10, '0003': 20, '0005': 30, '0007': 20, '0009': 20 } });
  w.sb.settle();
  [['0001', 10], ['0003', 20], ['0005', 30], ['0007', 20], ['0009', 20]].forEach(([b, m]) => assert.ok(Math.abs(w.sb.forBerth(w.id(b)).length - L * m / 100) < 1, `${b}`));
  assert.equal(w.sb.rules().cutLearned, 5);
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
  assert.equal(Object.keys(w.sb.byBerth.get(w.id('0003'))).sort().join(), ['chainKey', 'd0', 'd1', 'id', 'keyId', 'length', 'rule', 'stop'].join());
});

test('IDS are stable while nothing changes, and change when learning moves a berth by more than 10 % of its length', () => {
  const all = { '0001': 100, '0003': 100, '0005': 100, '0007': 100, '0009': 100 };
  const w = world({ medians: all });
  w.sb.settle();
  const ids = () => Object.fromEntries(Object.keys(all).map(b => [b, w.sb.forBerth(w.id(b)).id]));
  const before = ids();
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
  const c = world({ track: { stationSnaps() { throw new Error('boom'); }, route() { throw new Error('boom'); }, slice() { throw new Error('boom'); } } });
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
  assert.equal(w.sb.forBerth(w.id('0009')).stop, null, 'the outgoing chain starts AFTER the stop berth: 0009 is an ordinary berth');
  assert.ok(Math.abs(w.sb.byBerth.get(w.id('0009')).d0) < 1e-6, 'and it starts at the stop point (route offset 0)');
  assert.ok(w.sb.forBerth(w.id('0013')).stop > 0, 'the return chain ends at Alpha');
});

// ---- rule 3: signals --------------------------------------------------------------------------------------------------

test('RULE 3: a signal whose number matches the berth id pins the berth\'s END (the TD berth stands in rear of its signal); the berths between re-share', () => {
  const pin = L * 0.3;
  const w = world({ track: fakeTrack({ signals: [{ ref: 'AW003', d: pin }] }) });      // berth 0003 <-> signal AW003
  w.sb.settle();
  assert.ok(Math.abs(w.sb.byBerth.get(w.id('0003')).d1 - pin) < 1e-6, 'berth 0003 ends at the signal');
  assert.ok(Math.abs(w.sb.byBerth.get(w.id('0005')).d0 - pin) < 1e-6, 'the next berth starts there');
  // 0001 and 0003 share 0..pin equally; 0005, 0007, 0009 share pin..L.
  assert.ok(Math.abs(w.sb.byBerth.get(w.id('0001')).length - pin / 2) < 1e-6);
  assert.ok(Math.abs(w.sb.byBerth.get(w.id('0007')).length - (L - pin) / 3) < 1e-6);
  const st = w.sb.status();
  assert.deepEqual([st.signals.boundariesTried, st.signals.pinned], [4, 1]);
  assert.equal(st.signals.byArea.LA.rate, 0.25);
  assert.equal(st.rules.signalPinned, 2, 'two berths have a signal-fixed boundary');
  // 'start' reading: the signal is at the START of its berth.
  const s = world({ track: fakeTrack({ signals: [{ ref: 'AW003', d: pin }] }), cfg: { signalAt: 'start' } });
  s.sb.settle();
  assert.ok(Math.abs(s.sb.byBerth.get(s.id('0003')).d0 - pin) < 1e-6);
});

test('RULE 3: the id matches by exact text or by signal NUMBER (letters and leading zeros ignored); a different number does not match', () => {
  assert.equal(numberOf('AW204'), 'n204'); assert.equal(numberOf('T 205'), 'n205'); assert.equal(numberOf('SN091'), 'n91'); assert.equal(numberOf('GP6060'), 'n6060'); assert.equal(numberOf('KJ8/11'), null);
  assert.equal(exactKey('a 010'), 'eA010');
  const pin = L * 0.5;
  for (const [ref, expected] of [['AW003', 1], ['T3', 1], ['3', 1], ['003A', 1], ['AW004', 0], ['AW0030', 0]]) {
    const w = world({ track: fakeTrack({ signals: [{ ref, d: pin }] }) });
    w.sb.settle();
    assert.equal(w.sb.status().signals.pinned, expected, ref);
  }
  // A non-numeric berth id matches by exact text only.
  const w = world({ rows: [['LA', 'A010', 'A012', '111', 'D'], ['LA', 'A012', 'A014', '', ''], ['LA', 'A014', 'A016', '222', 'A']], track: fakeTrack({ signals: [{ ref: 'A 012', d: L * 0.4 }, { ref: 'XX014', d: L * 0.8 }] }) });
  w.sb.settle();
  assert.equal(w.sb.status().signals.pinned, 1, 'A 012 matches berth A012; XX014 does not match A014');
});

test('RULE 3: AMBIGUOUS (two different signals with that number on the route) is not pinned; two nodes of ONE signal are', () => {
  const two = world({ track: fakeTrack({ signals: [{ ref: 'AW003', d: L * 0.3 }, { ref: 'BX3', d: L * 0.35 + 100 }] }) });
  two.sb.settle();
  assert.equal(two.sb.status().signals.pinned, 0);
  assert.equal(two.sb.status().signals.byArea.LA.rejected.ambiguous, 1);
  const one = world({ track: fakeTrack({ signals: [{ ref: 'AW003', d: L * 0.3 }, { ref: 'AW003', d: L * 0.3 + 10 }] }) });
  one.sb.settle();
  assert.equal(one.sb.status().signals.pinned, 1);
});

test('RULE 3: a signal that is not ON THIS ROUTE, one facing the other way, and one wildly far from where the berths put it are all ignored', () => {
  const off = world({ track: fakeTrack({ signals: [{ ref: 'AW003', d: L * 0.3, onRoute: false }] }) });
  off.sb.settle();
  const A = off.sb.status().signals.byArea.LA;
  assert.deepEqual([A.idMatch, A.onRoute, A.pinned], [1, 0, 0], 'the id matches somewhere in the country but not on this route');
  // Facing the other way: the route runs against the edge, the signal faces forward along the edge.
  const t = fakeTrack({ signals: [{ ref: 'AW003', d: L * 0.3, direction: 'forward', onWay: true }] });
  const r = t.route.bind(t); t.route = (a, b, o) => Object.assign(r(a, b, o), { reversed: true });
  const wrong = world({ track: t });
  wrong.sb.settle();
  assert.equal(wrong.sb.status().signals.pinned, 0);
  assert.equal(wrong.sb.status().signals.byArea.LA.rejected.direction, 1);
  // The same signal with a route in its direction: pinned. A direction that is not trusted (not on the way) never blocks.
  const ok = world({ track: fakeTrack({ signals: [{ ref: 'AW003', d: L * 0.3, direction: 'forward', onWay: true }] }) });
  ok.sb.settle(); assert.equal(ok.sb.status().signals.pinned, 1);
  const loose = fakeTrack({ signals: [{ ref: 'AW003', d: L * 0.3, direction: 'forward', onWay: false }] });
  const r2 = loose.route.bind(loose); loose.route = (a, b, o) => Object.assign(r2(a, b, o), { reversed: true });
  const lw = world({ track: loose }); lw.sb.settle(); assert.equal(lw.sb.status().signals.pinned, 1);
  // Wildly far: berth 0003's end expected near 0.4 L, the matching signal sits at 0.95 L (> 1.5 berth lengths away).
  const far = world({ track: fakeTrack({ signals: [{ ref: 'AW003', d: L * 0.95 }] }) });
  far.sb.settle();
  assert.equal(far.sb.status().signals.pinned, 0);
  assert.equal(far.sb.status().signals.byArea.LA.rejected.implausible, 1);
});

test('RULE 3: pins that contradict each other\'s ORDER along the route are not all trusted: the largest consistent set is kept', () => {
  // 0003 -> signal at 0.7 L, 0005 -> signal at 0.45 L: only one of the two can be right.
  const w = world({ track: fakeTrack({ signals: [{ ref: 'AW003', d: L * 0.7 }, { ref: 'AW005', d: L * 0.45 }, { ref: 'AW007', d: L * 0.8 }] }), cfg: { maxPinDeviation: 5 } });
  w.sb.settle();
  const st = w.sb.status().signals;
  assert.equal(st.pinned, 2, 'AW005 then AW007 are in order; AW003 is the odd one out');
  assert.equal(st.byArea.LA.rejected.order, 1);
  const bounds = ['0001', '0003', '0005', '0007', '0009'].map(b => w.sb.byBerth.get(w.id(b)));
  for (let i = 1; i < bounds.length; i++) assert.ok(Math.abs(bounds[i].d0 - bounds[i - 1].d1) < 1e-6 && bounds[i].length > 0, 'boundaries stay in order, no gaps');
});

test('without signals() in the library the status says so and the cut is equal shares', () => {
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

// ---- the REAL library on a real cut of the Sussex pack -----------------------------------------------------------------

const FIX = path.join(__dirname, 'fixtures', 'track-sussex.bin');
function realWorld({ signals = null, cfg = {} } = {}) {
  const pack = loadPack(FIX);
  const hove = pack.station('HOVE'), btn = pack.station('BRGHTN');
  const stations = { 1: { key: 'HOVE', name: hove.name, lat: hove.lat, lon: hove.lon, crs: 'HOV' }, 2: { key: 'BRGHTN', name: btn.name, lat: btn.lat, lon: btn.lon, crs: 'BTN' } };
  const graph = new BerthGraph({ maxHops: 14, minEdgeCount: 2 });
  graph.loadSmart(smartRows([['BR', '0101', '0103', '1', 'D'], ['BR', '0103', '0105', '', ''], ['BR', '0105', '0107', '', ''], ['BR', '0107', '0109', '2', 'A']]), s => stations[s] || null);
  let track = pack;
  if (signals) track = Object.create(pack, { signals: { value: () => signals(pack) } });
  const sb = new SpanBuilder({ track, graph, transit: new TransitStore(), config: { ...config().spans, ...cfg }, now: () => 1e12 });
  return { pack, graph, sb, id: b => graph.lookup('BR', b) };
}

test('REAL LIBRARY: Hove to Brighton in four berths: the spans tile the route exactly, end at the real platform stops, and lie on the real track', () => {
  const w = realWorld();
  w.sb.settle();
  assert.equal(w.sb.size, 4 + 1, 'five berths: 0101 0103 0105 0107 0109');
  const recs = ['0101', '0103', '0105', '0107', '0109'].map(b => w.sb.byBerth.get(w.id(b)));
  const routeLen = w.sb.routes.values().next().value.length;
  assert.ok(routeLen > 2000 && routeLen < 2500, `Hove to Brighton is about 2.2 km, got ${routeLen}`);
  assert.ok(Math.abs(recs.reduce((n, r) => n + r.length, 0) - routeLen) < 1e-6, 'the berths tile the route');
  for (let i = 1; i < recs.length; i++) assert.ok(Math.abs(recs[i].d0 - recs[i - 1].d1) < 1e-6);
  assert.equal(recs[0].stop, 0); assert.ok(Math.abs(recs[4].stop - recs[4].length) < 1e-6);
  // The span paths join up end to end and begin / end at real snaps of the two stations.
  const paths = recs.map(r => w.sb.get(r.id).path);
  for (let i = 1; i < paths.length; i++) { const a = paths[i - 1].at(-1), b = paths[i][0]; assert.ok(haversineKm({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }) * 1000 < 1, `span ${i} starts where span ${i - 1} ends`); }
  const near = (pt, snaps) => Math.min(...snaps.map(s => haversineKm({ lat: pt[0], lon: pt[1] }, s) * 1000));
  assert.ok(near(paths[0][0], w.pack.stationSnaps('HOVE')) < 1, 'the first span starts at a Hove platform stop');
  assert.ok(near(paths[4].at(-1), w.pack.stationSnaps('BRGHTN')) < 1, 'the last ends at a Brighton platform stop');
  // Every vertex is on the track: within 1.5 m of the pack's own nearest track point.
  for (const p of paths.flat()) { const sn = w.pack.nearestOnTrack(p[0], p[1], { maxDist: 5 }); assert.ok(sn && sn.dist < 1.5, `${p} is ${sn && sn.dist} m from track`); }
  assert.ok(w.sb.stats.platform.tried === 0, 'no SMART platform in this planted graph: the shortest platform pair');
});

test('REAL LIBRARY, rule 3: a signal planted ON the real route (found with the library\'s own alongRoute) pins its berth; one on another track does not', () => {
  const planted = {};
  const w = realWorld({ signals: pack => {
    // a signal 40 % of the way along Hove -> Brighton: find the route piece and the offset on its edge
    const r = pack.route(pack.stationSnaps('HOVE'), pack.stationSnaps('BRGHTN'), { avoidSidings: true });
    let d = r.length * 0.4, piece = null;
    for (const p of r.pieces) { const len = Math.abs(p.b - p.a); if (d <= len) { piece = p; break; } d -= len; }
    const offset = piece.a + (piece.b > piece.a ? d : -d);
    planted.d = r.length * 0.4;
    const other = r.pieces.find(p => p.e !== piece.e) || piece;
    return [
      { edge: piece.e, offset, ref: 'T105', direction: 'unknown', side: 'left', onWay: false, dist: 2, lat: 0, lon: 0, kind: 1 },      // berth 0105 -> its end
      { edge: pack.nEdges - 1, offset: 1, ref: 'T103', direction: 'unknown', side: 'left', onWay: false, dist: 2, lat: 0, lon: 0, kind: 1 } // a signal on some other edge entirely
    ];
  }, cfg: { maxPinDeviation: 5 } });
  w.sb.settle();
  const st = w.sb.status().signals;
  assert.equal(st.pinned, 1);
  assert.ok(Math.abs(w.sb.byBerth.get(w.id('0105')).d1 - planted.d) < 0.5, `berth 0105 ends at the signal (${w.sb.byBerth.get(w.id('0105')).d1} vs ${planted.d})`);
  assert.equal(st.byArea.BR.idMatch, 2);
  assert.equal(st.byArea.BR.onRoute, 1, 'the other signal has the right number but is not on this route');
});

// ---- through the service: the App's own wiring ------------------------------------------------------------------------

test('IN THE SERVICE: with a track library injected, spans exist for chains of real SMART berths; /span/:id is immutable; trains on them carry mv', async () => {
  const { startRig, NOW } = require('./rig');
  const { getJson } = require('./helpers');
  // The fake library knows stations by TIPLOC through a deterministic hash: a point on a line per station.
  const lib = fakeTrack();
  lib.stationSnaps = key => { const h = [...key].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 1000, 7); return [{ tiploc: key, platform: null, primary: true, edge: 1, offset: 0, lat: 51 + (h % 37) * 0.001, lon: -1 + h * 0.0004 }]; };
  const rig = await startRig({ track: lib });
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
    rig.td([['CC', area, '2K22', null, berth]]);
    await rig.settle(1300);
    const t = (await getJson(rig.port, '/map/v1/trains')).json.trains.find(x => x.hc === '2K22');
    assert.equal(t.mv.sp, rec.id);
    assert.equal(t.mv.t0, NOW);
    assert.ok(t.mv.eta > t.mv.t0 && t.mv.held === false);
    assert.equal((await getJson(rig.port, '/map/v1/health')).json.diagnostics.spans.berthsWithSpans, sb.size);
  } finally { await rig.stop(); }
  const none = await startRig();
  try {
    assert.equal(none.app.spans, null);
    assert.equal((await getJson(none.port, '/map/v1/span/sp_0123456789')).status, 404);
  } finally { await none.stop(); }
});
