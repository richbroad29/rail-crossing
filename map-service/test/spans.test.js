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
function fakeTrack({ noRoute = false, noSnap = false, platforms = false, signals = null, routeScale = 1, joins = false, noJoinRoute = false, noDirected = false, near = false } = {}) {
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
      assert.ok(opts.maxLength > 0, 'a search bound is always given');
      const station = opts.avoidSidings === true;
      if (station) assert.ok(Array.isArray(a) && Array.isArray(b), 'station routes are ALWAYS between arrays of snaps, never single snaps');
      else if (noJoinRoute) return null;               // a directed join (17.1, 18.5): single directed snaps
      else if (noDirected && !Array.isArray(b)) return null;      // parallel tracks: no DIRECTED route, but a route to a nearby point exists
      if (noRoute && station) return null;
      let best = null;
      for (const x of Array.isArray(a) ? a : [a]) for (const y of Array.isArray(b) ? b : [b]) {
        const len = (haversineKm(x, y) * 1000 + (x.extra || 0) + (y.extra || 0)) * routeScale;
        if (!best || len < best.length) best = { length: len, pieces: [{ e: 1, dir: 0, a: 0, b: len }], from: x, to: y, fromPt: x, toPt: y };
      }
      if (best && !station && best.length > opts.maxLength) return null;
      return best;
    },
    slice(route, d0, d1) { return [lib._at(route, d0), lib._at(route, d1)]; },
    _at(route, d) { const t = d / route.length; return [route.fromPt.lat + (route.toPt.lat - route.fromPt.lat) * t, route.fromPt.lon + (route.toPt.lon - route.fromPt.lon) * t]; }
  };
  if (joins) {          // what spans.js needs for continuations and gap chains: directed snaps along a route
    lib.snapAlong = (route, d) => { const [lat, lon] = lib._at(route, Math.max(0, Math.min(route.length, d))); return { edge: 1, offset: d, dir: 0, lat, lon }; };
    lib.walk = () => null;
    lib.nearestOnTrack = (lat, lon) => (near ? [{ edge: 1, offset: 0, lat, lon }] : []);
  }
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
  assert.deepEqual(w.sb.rules(), { berths: 5, stopPinned: 2, signalPinned: 0, cutLearned: 0, cutPartial: 0, cutEqual: 5, bothEndsFixed: 0 });
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
  const NO_SPEED_LIMIT = { maxImpliedMps: 1e9 };       // these medians are seconds on a 28 km fake route: the cut is the subject, not 18.2
  const w = world({ medians: { '0001': 10, '0003': 20, '0005': 30, '0007': 20, '0009': 20 }, cfg: NO_SPEED_LIMIT });
  w.sb.settle();
  [['0001', 10], ['0003', 20], ['0005', 30], ['0007', 20], ['0009', 20]].forEach(([b, m]) => assert.ok(Math.abs(w.sb.forBerth(w.id(b)).length - L * m / 100) < 1, `${b}`));
  assert.equal(w.sb.rules().cutLearned, 5);
  // One berth unlearned: it takes the MEAN of the known medians (section 17.2), not equal shares for the whole chain.
  const w2 = world({ medians: { '0001': 10, '0003': 20, '0005': 30, '0007': 20 }, cfg: NO_SPEED_LIMIT });
  w2.sb.settle();
  [['0001', 10], ['0003', 20], ['0005', 30], ['0007', 20], ['0009', 20]].forEach(([b, m]) => assert.ok(Math.abs(w2.sb.forBerth(w2.id(b)).length - L * m / 100) < 1, `partial ${b}`));
  assert.deepEqual([w2.sb.rules().cutLearned, w2.sb.rules().cutPartial, w2.sb.rules().cutEqual], [0, 5, 0]);
  assert.equal(w2.sb.byBerth.get(w2.id('0005')).rule.cutBy, 'partial');
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
  assert.equal(Object.keys(w.sb.byBerth.get(w.id('0003'))).sort().join(), ['box', 'chainKey', 'd0', 'd1', 'id', 'keyId', 'length', 'rule', 'stop'].join());
  assert.equal(w.sb.byBerth.get(w.id('0003')).box.length, 4, 'a span carries its bounding box (19.1): four numbers, never the polyline');
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

// ---- contract section 18.2: impossible spans -------------------------------------------------------------------------------

test('18.2 a berth whose span implies more than maxImpliedMps over ITS OWN pass median gets no span; the rest of the chain keeps its own', () => {
  // L is ~28 km over five berths. 0003 clears in 40 s, the others in 200 s.
  const meds = { '0001': 200, '0003': 40, '0005': 200, '0007': 200, '0009': 200 };
  const w = world({ medians: meds });
  w.sb.settle();
  assert.equal(w.sb.size, 5, 'cut in proportion to the medians every berth implies the same speed (route / sum of medians = 33 m/s)');
  assert.equal(w.sb.status().impossible.berths, 0);
  // Pinned boundaries are what make one berth long and quick: 0001 ends 1 km along and 0003 ends 12 km along (signal refs 1 and 3 = the
  // berth ids), so 0003 is 11 km that trains clear in 40 s (275 m/s) while 0001 is 1 km in 200 s and 0005 5.3 km in 200 s.
  const track = fakeTrack({ signals: [{ ref: '1', d: 1000 }, { ref: '3', d: 12000 }] });
  const pinned = world({ track, medians: meds, cfg: { maxPinDeviation: 100 } });
  pinned.sb.settle();
  assert.equal(pinned.sb.forBerth(pinned.id('0003')), null, '11 km in 40 s: no span');
  assert.equal(pinned.sb.byBerth.get(pinned.id('0003')), undefined);
  assert.ok(pinned.sb.forBerth(pinned.id('0001')), 'its neighbours are judged on their own medians');
  const imp = pinned.sb.status().impossible;
  assert.deepEqual([imp.maxImpliedMps, imp.berths, imp.byBerth, imp.byChain], [60, 1, 1, 0]);
  assert.deepEqual(imp.byArea, { LA: { berths: 1, byBerth: 1, byChain: 0 } }, 'counted by TD area');
});

test('18.2 a chain whose route length over the sum of its medians is too fast gets no spans at all; unlearned chains are not judged', () => {
  const fast = { '0001': 10, '0003': 10, '0005': 10, '0007': 10, '0009': 10 };       // 28 km in 50 s
  const w = world({ medians: fast });
  w.sb.settle();
  assert.equal(w.sb.size, 0);
  const imp = w.sb.status().impossible;
  assert.deepEqual([imp.berths, imp.byBerth, imp.byChain], [5, 0, 5]);
  assert.equal(w.sb.status().berthsWithSpans, 0);
  // the PARTIAL fill counts: one learned berth stands for the chain's mean
  const partial = world({ medians: { '0003': 10 } });
  partial.sb.settle();
  assert.equal(partial.sb.size, 0, 'one berth at 10 s: five berths of 10 s = 28 km in 50 s');
  assert.equal(partial.sb.status().impossible.byChain, 5);
  // nothing learned: equal shares of nothing, no speed to test
  const none = world();
  none.sb.settle();
  assert.equal(none.sb.size, 5);
  assert.equal(none.sb.status().impossible.berths, 0);
  // a plausible chain (28 km in 840 s = 33 m/s) is kept
  const ok = world({ medians: { '0001': 200, '0003': 40, '0005': 200, '0007': 200, '0009': 200 } });
  ok.sb.settle();
  assert.equal(ok.sb.size, 5);
});

test('18.2 maxImpliedMps is the knob: a huge value turns the rule off, a lower one removes more; absent means 60', () => {
  const meds = { '0001': 100, '0003': 100, '0005': 100, '0007': 100, '0009': 100 };      // 28 km in 500 s = 56 m/s
  const at = cfg => { const w = world({ medians: meds, cfg }); w.sb.settle(); return w.sb.size; };
  assert.equal(at({}), 5, '56 m/s is under the default 60');
  assert.equal(at({ maxImpliedMps: 50 }), 0);
  assert.equal(at({ maxImpliedMps: 1e9 }), 5);
  assert.equal(at({ maxImpliedMps: undefined }), 5);
});

test('18.2 a span built before the medians said it was impossible is withdrawn (its id stays readable); when the medians recover it comes back', () => {
  const slow = { '0001': 200, '0003': 200, '0005': 200, '0007': 200, '0009': 200 };
  const w = world({ medians: slow });
  w.sb.settle();
  const before = w.sb.forBerth(w.id('0003'));
  assert.ok(before);
  // trains start clearing every berth in 10 s: the ring buffer (200) is replaced by quick samples
  for (const b of Object.keys(slow)) for (let i = 0; i < 400; i++) w.transit.add(w.id(b), 'express', 'passes', 10);
  w.sb._planned.at = -Infinity; w.sb.settle();
  assert.equal(w.sb.forBerth(w.id('0003')), null, 'withdrawn: its trains fall back to phase-1 positions');
  assert.equal(w.sb.size, 0);
  assert.ok(w.sb.get(before.id), 'the id a page already holds still resolves');
  assert.equal(w.sb.status().impossible.byChain, 5);
  for (const b of Object.keys(slow)) for (let i = 0; i < 400; i++) w.transit.add(w.id(b), 'express', 'passes', 200);
  w.sb._planned.at = -Infinity; w.sb.settle();
  assert.ok(w.sb.forBerth(w.id('0003')), 'and it comes back');
  assert.equal(w.sb.status().impossible.berths, 0);
});

// ---- contract section 18.5: gap chains ---------------------------------------------------------------------------------------

/**
 * Chain 1: AAA 0001 > 0003 > 0005 (arrives BBB). Chain 2: BBB 0021 > 0022 > 0023 > 0025 (arrives AAA), so 0023 starts half way along it.
 * The gap: 0003 > g1 > ... > gk > 0023, berths no station-to-station walk crosses (0003's best-next is 0005, not g1).
 */
function gapWorld(gaps, { track = fakeTrack({ joins: true }), medians = {}, cfg = {}, extraRows = [] } = {}) {
  const rows = [['LA', '0001', '0003', '111', 'D'], ['LA', '0003', '0005', '222', 'A'], ['LA', '0021', '0022', '222', 'D'], ['LA', '0022', '0023', '', ''], ['LA', '0023', '0025', '111', 'A'],
    ...extraRows];
  let prev = '0003';
  for (const g of gaps) { rows.push(['LA', prev, g, '', '']); prev = g; }
  if (gaps.length) rows.push(['LA', prev, '0023', '', '']);
  const w = world({ rows, track, medians, cfg });
  w.sb.settle();
  return w;
}
const near = (a, b, eps = 2e-5) => Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
const pathOf = (w, b) => w.sb.get(w.sb.forBerth(w.id(b)).id).path;

test('18.5 SINGLE-BERTH HOLE: a berth between two spanned berths gets a gap span that starts where the previous span ends and ends where the next one starts', () => {
  const w = gapWorld(['0031']);
  const sp = w.sb.forBerth(w.id('0031'));
  assert.ok(sp, 'the hole is filled');
  const rec = w.sb.byBerth.get(w.id('0031'));
  assert.deepEqual([rec.rule.start, rec.rule.end, sp.stop], ['gap', 'gap', null], 'a pass: no stop');
  const prev = pathOf(w, '0003'), mine = pathOf(w, '0031'), next = pathOf(w, '0023');
  assert.ok(near(prev[prev.length - 1], mine[0]), 'starts exactly where 0003 ends');
  assert.ok(near(mine[mine.length - 1], next[0]), 'ends exactly where 0023 starts');
  assert.ok(sp.length > 4000 && sp.length < 5200, `${sp.length} m: the 4.7 km between them`);
  assert.deepEqual([w.sb.size, w.sb.status().gapChains.built, w.sb.status().gapChains.berths], [8, 1, 1]);
  assert.equal(w.sb.byBerth.get(w.id('0003')).gap, undefined, 'the station chain berths are untouched');
});

test('18.5 MULTI-BERTH HOLE: up to maxGapBerths berths tile the route end to end; a longer hole, or a lower limit, gets none', () => {
  const w = gapWorld(['0031', '0033', '0035', '0037']);
  const gs = ['0031', '0033', '0035', '0037'];
  const paths = gs.map(b => pathOf(w, b));
  const prev = pathOf(w, '0003'), next = pathOf(w, '0023');
  assert.ok(near(prev[prev.length - 1], paths[0][0]));
  for (let i = 0; i + 1 < gs.length; i++) assert.ok(near(paths[i][paths[i].length - 1], paths[i + 1][0]), `${gs[i]} meets ${gs[i + 1]}`);
  assert.ok(near(paths[3][paths[3].length - 1], next[0]));
  const total = gs.reduce((a, b) => a + w.sb.forBerth(w.id(b)).length, 0);
  assert.ok(total > 4000 && total < 5200);
  gs.forEach(b => assert.equal(w.sb.byBerth.get(w.id(b)).rule.start, 'gap'));
  assert.equal(w.sb.status().gapChains.built, 1, 'one chain');
  // five berths is more than the default 4; three berths under a limit of 2
  const five = gapWorld(['0031', '0033', '0035', '0037', '0039']);
  for (const b of ['0031', '0033', '0035', '0037', '0039']) assert.equal(five.sb.forBerth(five.id(b)), null);
  assert.equal(five.sb.status().gapChains.considered, 0);
  const lim = gapWorld(['0031', '0033', '0035'], { cfg: { maxGapBerths: 2 } });
  assert.equal(lim.sb.forBerth(lim.id('0031')), null);
  const three = gapWorld(['0031', '0033', '0035'], { cfg: { maxGapBerths: 3 } });
  assert.ok(three.sb.forBerth(three.id('0031')) && three.sb.forBerth(three.id('0035')));
  assert.equal(gapWorld(['0031'], { cfg: { maxGapBerths: 0 } }).sb.size, 7, 'maxGapBerths 0 turns the pass off');
});

test('18.5 weights: the run is cut in proportion to its berths\' learned pass medians (the 17.2 weights)', () => {
  const w = gapWorld(['0031', '0033'], { medians: { '0031': 300, '0033': 100 } });
  const a = w.sb.forBerth(w.id('0031')).length, b = w.sb.forBerth(w.id('0033')).length;
  assert.ok(Math.abs(a / b - 3) < 0.01, `${a} : ${b}`);
});

test('18.5 NO ROUTE between the two spans: no gap spans, counted, no throw; a hole with a missing library is skipped', () => {
  const w = gapWorld(['0031'], { track: fakeTrack({ joins: true, noJoinRoute: true }) });
  assert.equal(w.sb.forBerth(w.id('0031')), null);
  assert.deepEqual([w.sb.status().gapChains.noRoute, w.sb.status().gapChains.built], [1, 0]);
  assert.equal(w.sb.size, 7, 'the station chains stand');
  const noJoins = gapWorld(['0031'], { track: fakeTrack() });                       // no snapAlong: the pass cannot run
  assert.equal(noJoins.sb.forBerth(noJoins.id('0031')), null);
  assert.equal(noJoins.sb.status().gapChains.considered, 0);
});

test('18.5 BESIDE (amendment): when no directed route exists the gap routes to the nearest reachable point near the next span\'s start, as 17.1 (b); with that unavailable too it is noRoute', () => {
  const w = gapWorld(['0031'], { track: fakeTrack({ joins: true, noDirected: true, near: true }) });
  assert.ok(w.sb.forBerth(w.id('0031')), 'built from the beside route');
  const st = w.sb.status().gapChains;
  assert.deepEqual([st.built, st.beside, st.noRoute], [1, 1, 0]);
  const prev = pathOf(w, '0003'), mine = pathOf(w, '0031');
  assert.ok(near(prev[prev.length - 1], mine[0]), 'still starts exactly where the previous span ends');
  // no nearby point either: no route
  const none = gapWorld(['0031'], { track: fakeTrack({ joins: true, noDirected: true }) });
  assert.equal(none.sb.forBerth(none.id('0031')), null);
  assert.deepEqual([none.sb.status().gapChains.noRoute, none.sb.status().gapChains.beside], [1, 0]);
  // a directed route wins when there is one
  assert.equal(gapWorld(['0031'], { track: fakeTrack({ joins: true, near: true }) }).sb.status().gapChains.beside, 0);
});

test('CHAINS stay bounded: replans do not accumulate chains nothing refers to; once the superseded spans are gone so are their chains', () => {
  const w = gapWorld(['0031', '0033']);
  const size0 = w.sb.chains.size;
  const live = () => { const k = new Set(); for (const r of w.sb.byBerth.values()) k.add(r.chainKey); for (const r of w.sb.retired.values()) k.add(r.chainKey); return k; };
  for (let round = 0; round < 6; round++) {
    // learning moves the station berths a lot each time, so the spans (and with them the gap chain's key) change
    for (const b of ['0001', '0003', '0005', '0021', '0022', '0023', '0025']) for (let i = 0; i < 400; i++) w.transit.add(w.id(b), 'express', 'passes', b === '0003' ? 300 + 200 * round : 300);
    w.sb._planned.at = -Infinity; w.sb.settle();
    assert.ok(w.sb.byBerth.get(w.id('0031')), 'the gap is still spanned');
    for (const k of w.sb.chains.keys()) assert.ok(live().has(k), `chain ${k} is referenced by a current or retained span`);
  }
  assert.ok(w.sb.chains.size > size0 || w.sb.retired.size === 0, 'superseded spans keep their chains readable while they are retained');
  w.sb.retired.clear();                                                       // they age out
  w.sb._planned.at = -Infinity; w.sb._planned.transit = -2; w.sb.settle();
  assert.equal(w.sb.chains.size, size0, 'nothing but the current chains is left');
});

test('18.5 a hole of a few metres is not a hole: the previous span ends where the next starts, so there is nothing to draw and no span is made', () => {
  // chain 2 with a single arrival berth right where chain 1 ends: P end == N start
  const w = gapWorld(['0031'], { cfg: { minGapMetres: 1e9 } });
  assert.equal(w.sb.forBerth(w.id('0031')), null, 'a route no longer than minGapMetres is refused');
  assert.equal(w.sb.status().gapChains.noRoute, 1);
  const ok = gapWorld(['0031'], { cfg: { minGapMetres: 10 } });
  assert.ok(ok.sb.forBerth(ok.id('0031')), 'the 4.7 km hole of the other tests is still filled');
});

test('18.5 + 18.2: a gap that would imply more than maxImpliedMps gets no span and is counted as tooFast; it is not an "impossible" station berth', () => {
  const w = gapWorld(['0031'], { medians: { '0031': 5 } });                   // 4.7 km in 5 s
  assert.equal(w.sb.forBerth(w.id('0031')), null);
  const st = w.sb.status();
  assert.deepEqual([st.gapChains.tooFast, st.gapChains.built], [1, 0]);
  assert.equal(st.impossible.berths, 0);
  const slow = gapWorld(['0031'], { medians: { '0031': 200 } });                // 24 m/s: fine
  assert.ok(slow.sb.forBerth(slow.id('0031')));
  // a station berth that 18.2 withdrew is offered to the gap pass too (here the same geometry, so the same verdict: still too fast)
  const fakeSig = fakeTrack({ joins: true, signals: [{ ref: '1', d: 1000 }, { ref: '3', d: 12000 }] });
  const both = gapWorld([], { track: fakeSig, medians: { '0001': 200, '0003': 40, '0005': 400 }, cfg: { maxPinDeviation: 100 } });
  assert.equal(both.sb.forBerth(both.id('0003')), null, '18.2 removed it');
  assert.equal(both.sb.status().impossible.byBerth, 1);
  assert.equal(both.sb.status().gapChains.considered, 1, 'and the gap pass looked at the hole');
  assert.equal(both.sb.status().gapChains.tooFast, 1);
});

test('18.5 never replaces a station-chain span: a berth a station chain later claims takes the station span, and a gap span whose hole closed is withdrawn', () => {
  const w = gapWorld(['0031']);
  const gapId = w.sb.forBerth(w.id('0031')).id;
  assert.equal(w.sb.byBerth.get(w.id('0031')).gap, true);
  // SMART now says trains arrive at BBB in 0031: a station chain claims it
  w.graph.loadSmart(smartRows([['LA', '0001', '0003', '111', 'D'], ['LA', '0003', '0031', '222', 'A'], ['LA', '0021', '0022', '222', 'D'], ['LA', '0022', '0023', '', ''], ['LA', '0023', '0025', '111', 'A'],
    ['LA', '0031', '0023', '', '']]), resolve);
  w.sb._planned.at = -Infinity; w.sb.settle();
  const rec = w.sb.byBerth.get(w.id('0031'));
  assert.ok(rec && rec.gap !== true, 'the station chain 0001 > 0003 > 0031 now spans it');
  assert.equal(rec.rule.end, 'stop');
  assert.ok(w.sb.get(gapId), 'the superseded id still resolves');
  // the hole closes without a station chain: the route vanishes, the gap span is withdrawn at the end of the pass
  const w2 = gapWorld(['0031']);
  const id2 = w2.sb.forBerth(w2.id('0031')).id;
  w2.sb.track = fakeTrack({ joins: true, noJoinRoute: true }); w2.sb.routes.clear();
  w2.sb._planned.at = -Infinity; w2.sb._planned.graph = -2; w2.sb.settle();
  assert.equal(w2.sb.forBerth(w2.id('0031')), null);
  assert.ok(w2.sb.get(id2) === null || w2.sb.get(id2).id === id2, 'a retired id never resolves to a different span');
});

test('18.5 a gap span survives a replan unchanged (same id), and a continuation can start from it like from any span', () => {
  const w = gapWorld(['0031']);
  const id = w.sb.forBerth(w.id('0031')).id;
  w.sb._planned.at = -Infinity; w.sb._planned.transit = -2; w.sb.settle();
  assert.equal(w.sb.forBerth(w.id('0031')).id, id, 'kept, not recut');
  assert.ok(w.sb.continuation(id, w.sb.forBerth(w.id('0023')).id), 'resolves as a prev');
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

// ---- section 17.2: a chain is cut over ALL its berths -----------------------------------------------------------------------

test('WHOLE-CHAIN CUT (17.2): berths another chain already claimed still take their share of the route, so the berths left are not stretched', () => {
  // Chain 1: 0001 > 0003 > 0005 > 0007 (Alpha to Bravo). Chain 2 starts at 0021, joins chain 1 at 0005: its berths are
  // 0021, 0023, 0005, 0007, of which 0005 and 0007 are claimed. The route is the same 28 km.
  const rows = [['LA', '0001', '0003', '111', 'D'], ['LA', '0003', '0005', '', ''], ['LA', '0005', '0007', '222', 'A'], ['LA', '0021', '0023', '111', 'D'], ['LA', '0023', '0005', '', '']];
  const w = world({ rows });
  w.sb.settle();
  const rec = b => w.sb.byBerth.get(w.id(b));
  assert.equal(w.sb.chains.size, 2);
  const [c1, c2] = [...w.sb.chains.values()];
  assert.deepEqual(c2.berths.map(b => w.graph.berth(b)), ['0021', '0023', '0005', '0007'], 'the whole chain is kept, claimed berths included');
  assert.deepEqual([...c2.build].map(b => w.graph.berth(b)), ['0021', '0023'], 'but only the unclaimed ones are built from it');
  // Cut over four berths: a quarter each. (Cut over the two unclaimed alone, each would be HALF the route.)
  for (const b of ['0021', '0023']) assert.ok(Math.abs(rec(b).length - L / 4) < 1, `${b} ${rec(b).length}`);
  assert.equal(rec('0021').chainKey, c2.key); assert.equal(rec('0005').chainKey, c1.key, 'a claimed berth keeps the span of the chain that claimed it');
  assert.ok(Math.abs(rec('0005').length - L / 4) < 1);
  assert.equal(rec('0021').stop, 0, 'chain 2 starts at a departure berth');
  assert.equal(rec('0023').stop, null);
  assert.equal(w.sb.size, 6, 'every berth has exactly one span');
  assert.equal(w.sb.stats.shared, 2);
  // Learned medians shape the whole cut too: chain 2's unclaimed berths have none, the claimed ones do -> 'partial'.
  const w2 = world({ rows, medians: { '0005': 10, '0007': 50 }, cfg: { maxImpliedMps: 1e9 } });
  w2.sb.settle();
  assert.equal(w2.sb.byBerth.get(w2.id('0021')).rule.cutBy, 'partial');
  assert.equal(w2.sb.rules().cutPartial, w2.sb.size - 0 - w2.sb.rules().cutEqual - w2.sb.rules().cutLearned);
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

// ---- contract section 16: recentBerths[].sp and the recording's `span` lines ----------------------------------------------

function hashedFake() {
  const lib = fakeTrack();
  lib.stationSnaps = key => { const h = [...key].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 1000, 7); return [{ tiploc: key, platform: null, primary: true, edge: 1, offset: 0, lat: 51 + (h % 37) * 0.001, lon: -1 + h * 0.0004 }]; };
  return lib;
}
const WIDE = { record: { bbox: [50.5, -1.5, 51.5, 0.0], segmentSecs: 600 } };      // the fake library puts every station inside this box

/** A chain of at least three spanned LA berths, in order, from the built spans. */
function spannedChain(rig) {
  const sb = rig.app.spans; sb.settle();
  for (const c of sb.chains.values()) { const l = c.berths.filter(b => sb.byBerth.has(b)); if (l.length >= 3 && l.length === c.berths.length) return c.berths; }
  throw new Error('no chain of three spanned berths');
}

test('SECTION 16: /train/:id recentBerths[] each carry sp, the span id that berth was traversed on (null where it has none)', async () => {
  const { startRig } = require('./rig');
  const { getJson } = require('./helpers');
  const rig = await startRig({ track: hashedFake() });
  try {
    const g = rig.app.graph, chain = spannedChain(rig);
    const [a, b, c] = chain.map(k => g.berth(k));
    const area = g.areaOf[chain[0]];
    rig.td([['CC', area, '2K22', null, a]]); rig.td([['CA', area, '2K22', a, b]]); rig.td([['CA', area, '2K22', b, c]]);
    await rig.settle(1300);
    const t = (await getJson(rig.port, '/map/v1/trains')).json.trains.find(x => x.hc === '2K22');
    const d = (await getJson(rig.port, `/map/v1/train/${t.id}`)).json;
    assert.deepEqual(d.recentBerths.map(x => x.berth), [a, b, c]);
    d.recentBerths.forEach((x, i) => {
      assert.deepEqual(Object.keys(x).sort(), ['area', 'at', 'berth', 'sp']);
      assert.equal(x.sp, rig.app.spans.forBerth(chain[i]).id, `berth ${x.berth}`);
      assert.match(x.sp, /^sp_[0-9a-f]{10}$/);
    });
    assert.equal(d.recentBerths.at(-1).sp, t.mv.sp, 'the current berth\'s sp is the train\'s mv.sp');
    // A berth with no span: sp is null, and the key is still there.
    const none = [...g.keyOf.keys()].find(k => g.areaOf[k] === area && !rig.app.spans.byBerth.has(k));
    rig.td([['CC', area, '3M33', null, g.berth(none)]]);
    await rig.settle(1300);
    const t2 = (await getJson(rig.port, '/map/v1/trains')).json.trains.find(x => x.hc === '3M33');
    const d2 = (await getJson(rig.port, `/map/v1/train/${t2.id}`)).json;
    assert.deepEqual(d2.recentBerths.map(x => x.sp), [null]);
  } finally { await rig.stop(); }
});

/** Check a parsed recording: {t, event, data} everywhere; every sp referenced is announced by an EARLIER span line, once. */
function checkRecording(lines, rig) {
  const announced = new Set();
  let spanLines = 0;
  for (const l of lines) {
    assert.deepEqual(Object.keys(l), ['t', 'event', 'data']);
    assert.ok(Number.isInteger(l.t));
    if (l.event === 'span') {
      assert.deepEqual(Object.keys(l.data).sort(), ['id', 'length', 'path', 'stop']);
      assert.ok(!announced.has(l.data.id), `span ${l.data.id} announced twice`);
      assert.deepEqual(l.data, rig.app.spans.get(l.data.id), 'the span line is the span that /span/:id serves');
      announced.add(l.data.id); spanLines++;
      continue;
    }
    const trains = l.event === 'snapshot' ? l.data.trains : l.event === 'update' ? l.data.upsert : [];
    for (const t of trains) if (t.mv) assert.ok(announced.has(t.mv.sp), `${l.event} references ${t.mv.sp} before any span line announced it`);
  }
  return spanLines;
}

test('SECTION 16: the rolling record writes a `span` line the first time each span id appears in a SEGMENT, before the line that uses it; each segment replays alone', async () => {
  const fs = require('fs'), path = require('path');
  const { startRig, NOW } = require('./rig');
  const rig = await startRig({ track: hashedFake(), overrides: WIDE });
  try {
    const g = rig.app.graph, chain = spannedChain(rig);
    const area = g.areaOf[chain[0]], B = i => g.berth(chain[i]);
    rig.td([['CC', area, '2K22', null, B(0)]]); await rig.settle(150);
    rig.clock.now = NOW + 5000; rig.td([['CA', area, '2K22', B(0), B(1)]]); await rig.settle(150);
    rig.clock.now = NOW + 9000; rig.td([['CA', area, '2K22', B(1), B(2)]]); await rig.settle(150);
    rig.clock.now = NOW + 10000; rig.td([['CA', area, '2K22', B(2), B(1)]]); await rig.settle(150);          // back into a span already announced in this segment
    // a new segment, 700 s later: the train sits in B(1): its span must be announced AGAIN, in the new file
    rig.clock.now = NOW + 700_000; rig.td([['CA', area, '2K22', B(1), B(2)]]); await rig.settle(150);
    const dir = path.join(rig.dataDir, 'record');
    const files = fs.readdirSync(dir).sort();
    assert.equal(files.length, 2);
    const parse = f => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const first = parse(files[0]), second = parse(files[1]);
    assert.ok(checkRecording(first, rig) >= 3, 'the first segment announced the spans of B0, B1 and B2');
    assert.ok(checkRecording(second, rig) >= 1, 'the second segment is self-contained');
    const ids = a => a.filter(l => l.event === 'span').map(l => l.data.id);
    assert.equal(new Set(ids(first)).size, ids(first).length, 'once per id per segment');
    assert.ok(ids(second).includes(rig.app.spans.forBerth(chain[2]).id));
    // The first reference to a new id is preceded immediately by its span line (before the update that carries it).
    const iUpd = first.findIndex(l => l.event === 'update' && l.data.upsert.some(t => t.mv && t.mv.sp === rig.app.spans.forBerth(chain[1]).id));
    assert.ok(iUpd > 0 && first[iUpd - 1].event === 'span' && first[iUpd - 1].data.id === rig.app.spans.forBerth(chain[1]).id);
    assert.equal(first.filter(l => l.event === 'update' && l.data.upsert.some(t => t.mv && t.mv.sp === rig.app.spans.forBerth(chain[1]).id)).length >= 2, true, 'and the later reference needed no second span line');
  } finally { await rig.stop(); }
});

test('SECTION 16: /debug/record streams the same {t, event, data} lines, with span lines ahead of their first use', async () => {
  const http = require('http');
  const { startRig } = require('./rig');
  const { until } = require('./helpers');
  const rig = await startRig({ track: hashedFake(), overrides: WIDE });
  try {
    const g = rig.app.graph, chain = spannedChain(rig);
    const area = g.areaOf[chain[0]], B = i => g.berth(chain[i]);
    rig.td([['CC', area, '2K22', null, B(0)]]); await rig.settle(1300);                          // already in a span when the stream opens: the snapshot needs it
    const pending = new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: rig.port, path: '/map/v1/debug/record?secs=1', agent: false }, res => { let b = ''; res.on('data', d => { b += d; }); res.on('end', () => resolve(b.split('\n').filter(Boolean).map(l => JSON.parse(l)))); });
      r.on('error', reject); r.end();
    });
    await until(() => rig.app.debugTaps === 1, 2000, 'the tap');
    rig.td([['CA', area, '2K22', B(0), B(1)]]);
    const lines = await pending;
    assert.equal(lines[0].event, 'span', 'the snapshot\'s train is already on a span: announced first');
    assert.equal(lines.find(l => l.event === 'snapshot').data.trains[0].mv.sp, lines[0].data.id);
    assert.equal(lines.at(-1).event, 'end');
    checkRecording(lines.filter(l => l.event !== 'end'), rig);
    assert.ok(lines.filter(l => l.event === 'span').length >= 2, 'the next span was announced when the train entered it');
  } finally { await rig.stop(); }
});

// ---- contract section 19.1: a span record carries its bounding box --------------------------------------------------------------

test('19.1 a span record carries its bounding box: the box of the polyline /span/:id serves, computed once at build, four numbers, and it survives retirement', () => {
  const all = { '0001': 100, '0003': 100, '0005': 100, '0007': 100, '0009': 100 };
  const w = world({ medians: all });
  w.sb.settle();
  const r = w.sb.byBerth.get(w.id('0003'));
  const pts = w.sb.get(r.id).path;
  const want = [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))];
  const got = w.sb.bboxOf(r.id);
  assert.equal(got.length, 4);
  got.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-5, `box[${i}] ${v} vs ${want[i]}`));
  assert.ok(got[1] < got[3], 'it spans the berth along the line (west < east)');
  assert.equal(w.sb.bboxOf('sp_nope'), null);
  // Learning moves 0003 by far more than 10 %: its span is superseded, and the superseded id still answers with ITS box (a train may still be drawn on it).
  const oldId = r.id, oldBox = got.slice();
  for (let i = 0; i < 200; i++) w.transit.add(w.id('0003'), 'express', 'passes', 400);
  w.sb._planned.at = -Infinity; w.sb.settle();
  const now = w.sb.forBerth(w.id('0003')).id;
  assert.notEqual(now, oldId);
  assert.equal(w.sb.byId.has(oldId), false);
  assert.deepEqual(w.sb.bboxOf(oldId), oldBox, 'a retired span keeps its box');
  assert.notDeepEqual(w.sb.bboxOf(now), oldBox, 'and the new span has its own');
});

test('19.1 gap-chain spans carry a box too (they are built by the same step), and a library that cannot cut gives null, never a throw', () => {
  const w = gapWorld(['0031']);
  w.sb.settle();
  const rec = w.sb.byBerth.get(w.id('0031'));
  assert.ok(rec.gap);
  assert.equal(w.sb.bboxOf(rec.id).length, 4);
  const t = fakeTrack();
  t.slice = () => { throw new Error('boom'); };
  const c = world({ track: t });
  assert.doesNotThrow(() => c.sb.settle());
  assert.equal(c.sb.bboxOf(c.sb.forBerth(c.id('0003')).id), null);
});
