'use strict';

// Continuation spans (contract section 17.1) on a REAL track library built from planted ways (test/track-synth.js): directed
// routing, snapAlong / walk, and SpanBuilder.continuation(prev, of) with each rule, the 2 m "same" rule, chaining, unknown ids, the
// join LRU and rebuild-on-demand. Canonical spans are planted straight into a builder (a record on a route), so each case has an
// exact answer; the service wiring (HTTP, the recorder) is tested at the end.

const test = require('node:test');
const assert = require('node:assert/strict');
const { synth, at } = require('./track-synth');
const { tmpDir, rmrf, config } = require('./helpers');
const { SpanBuilder } = require('../src/spans');
const { BerthGraph } = require('../src/berth-graph');
const { TransitStore } = require('../src/transit');
const { DEG7 } = require('../src/track/geom');

// x east, y north, metres. The stem W-J, two legs J-K (upper rises to y=150, lower falls to y=-300), the stem K-E, a separate
// parallel track 25 m north of the stem that is NOT connected to it (so a train on it cannot reach the stem), and a far island.
const LAYOUT = {
  points: {
    W: [0, 0], J: [1000, 0], U1: [1500, 150], U2: [2500, 150], L1: [1500, -300], L2: [2500, -300], K: [3000, 0], E: [4000, 0],
    P1: [0, 25], P2: [1500, 25], F1: [0, 2000], F2: [1000, 2000]
  },
  ways: [
    { pts: ['W', 'J'], tags: { name: 'stem', usage: 'main' } },
    { pts: ['J', 'U1', 'U2', 'K'], tags: { name: 'upper', usage: 'main' } },
    { pts: ['J', 'L1', 'L2', 'K'], tags: { name: 'lower', usage: 'main' } },
    { pts: ['K', 'E'], tags: { name: 'stem east', usage: 'main' } },
    { pts: ['P1', 'P2'], tags: { name: 'parallel', usage: 'main' } },
    { pts: ['F1', 'F2'], tags: { name: 'far', usage: 'main' } }
  ]
};

let dir, pack;
test.before(() => { dir = tmpDir('cont-'); pack = synth(dir, LAYOUT).pack; });
test.after(() => rmrf(dir));

const ll = (x, y) => { const p = at(x, y); return [p.lat7 * DEG7, p.lon7 * DEG7]; };
const snap = (x, y, d) => { const s = pack.nearestOnTrack(...ll(x, y), { maxDist: 15 }); return d === undefined ? s : { ...s, dir: d }; };
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b} (±${eps})`);
const metres = (p, x, y) => { const [la, lo] = ll(x, y); return Math.hypot((p[0] - la) * 111195, (p[1] - lo) * 111195 * Math.cos(la * Math.PI / 180)); };
const nameOf = e => pack.edgeInfo(e).name;

function builder(cfg = {}) {
  return new SpanBuilder({ track: pack, graph: new BerthGraph(), transit: new TransitStore(), config: { ...config().spans, ...cfg }, now: () => 1e12 });
}
let seq = 0;
/** Plant a canonical span: the free route from (ax, ay) to (bx, by), the whole of it. */
function plant(sb, ax, ay, bx, by, stop = null) {
  const route = pack.route(snap(ax, ay), snap(bx, by));
  assert.ok(route, `planted route ${ax},${ay} -> ${bx},${by}`);
  const id = 'sp_' + (++seq).toString(16).padStart(10, '0'), chainKey = `c${seq}`;
  sb.chains.set(chainKey, { key: chainKey, berths: [], build: new Set() });
  sb.routes.set(chainKey, route);
  const len = route.length;
  sb.byId.set(id, { id, keyId: seq, chainKey, d0: 0, d1: len, length: len, stop: stop === 'end' ? len : stop, rule: {} });
  return { id, route, len };
}

// ---- the track library: directed routes, snapAlong, walk ---------------------------------------------------------------------

test('route: a directed SOURCE only leaves the way it faces, a directed GOAL is only reached travelling its way, same-edge runs included', () => {
  // Upper leg at x=1250 towards K (dir 0, the way's own direction) to the east stem at x=3500.
  const up = snap(1250, 75), goal = snap(3500, 0);
  assert.equal(nameOf(up.edge), 'upper');
  const free = pack.route(up, goal), fwd = pack.route({ ...up, dir: 0 }, goal);
  near(fwd.length, free.length, 1e-6, 'facing the way it would go anyway: the same route');
  assert.equal(pack.route({ ...up, dir: 1 }, goal), null, 'facing J: the only way on is a reversal at J (heel to heel onto the lower leg, or back down the stem), which is not allowed');
  // Goal direction: arrive on the east stem heading east (0) is what the route does; heading west (1) cannot be reached.
  assert.ok(pack.route(up, { ...goal, dir: 0 }));
  assert.equal(pack.route(up, { ...goal, dir: 1 }), null);
  // Same edge: east then west along the stem.
  const a = snap(300, 0), b = snap(700, 0);
  near(pack.route({ ...a, dir: 0 }, { ...b, dir: 0 }).length, 400, 0.5);
  assert.equal(pack.route({ ...a, dir: 1 }, b), null, 'a train facing west cannot run east along the same edge');
  assert.equal(pack.route(a, { ...b, dir: 1 }), null, 'nor arrive at a point heading west by running east');
  assert.equal(pack.route({ ...b, dir: 0 }, { ...a, dir: 0 }), null, 'a point behind it on the same edge, with no loop to come back round');
  near(pack.route({ ...b, dir: 1 }, { ...a, dir: 1 }).length, 400, 0.5, 'but facing west it is ahead');
  // Equal offsets: either direction is fine (nothing to run).
  assert.ok(pack.route({ ...a, dir: 1 }, { ...a, dir: 1 }));
  // Directed ends in arrays: the directed pair that works is the one used.
  const r = pack.route([{ ...a, dir: 1 }, { ...a, dir: 0 }], [{ ...b, dir: 0 }]);
  assert.equal(r.from.dir, 0);
});

test('snapAlong: a directed snap at a distance along a route (edge, offset, dir, position); the END of the earlier edge at a boundary', () => {
  const route = pack.route(snap(500, 0), snap(1250, 75));      // stem x500..1000, then up the upper leg
  const s0 = pack.snapAlong(route, 0), mid = pack.snapAlong(route, 300), atJ = pack.snapAlong(route, 500), end = pack.snapAlong(route, route.length), past = pack.snapAlong(route, 1e6);
  assert.equal(nameOf(s0.edge), 'stem'); assert.equal(s0.dir, 0); assert.ok(metres([s0.lat, s0.lon], 500, 0) < 0.3);
  assert.ok(metres([mid.lat, mid.lon], 800, 0) < 0.3);
  assert.equal(nameOf(atJ.edge), 'stem', 'at the junction: the end of the stem');
  assert.ok(metres([atJ.lat, atJ.lon], 1000, 0) < 0.3);
  assert.equal(nameOf(end.edge), 'upper'); assert.equal(end.dir, 0);
  assert.deepEqual([past.edge, past.offset], [end.edge, end.offset], 'clamped to the route');
  // A route that runs AGAINST the way: dir 1, offsets decreasing.
  const west = pack.route(snap(900, 0), snap(200, 0));
  const w = pack.snapAlong(west, 100);
  assert.equal(w.dir, 1); assert.ok(metres([w.lat, w.lon], 800, 0) < 0.3);
  // Usable as an end of route(): a snap along a route, with its dir, routes onward in that direction only.
  assert.ok(pack.route({ ...mid, dir: mid.dir }, snap(3500, 0)));
  assert.equal(pack.snapAlong({ pieces: [], length: 0 }, 0), null);
});

test('walk: straight on from a directed snap, the smallest turn at each node, never a siding; stops where the track ends', () => {
  // East along the stem through J: the upper leg (17 degrees off) beats the lower (31).
  const w = pack.walk(snap(800, 0, 0), 1000);
  assert.equal(w.length, 1000);
  assert.deepEqual(w.pieces.map(p => nameOf(p.e)), ['stem', 'upper']);
  near(w.pieces[0].b, w.pieces[0].a + 200, 0.5);
  // Westwards on the parallel track: runs out after 800 m, however far it was asked to go.
  const p = pack.walk(snap(800, 25, 1), 5000);
  near(p.length, 800, 0.5);
  // Nothing to walk: at the very end of a track.
  const end = pack.snapAlong(pack.route(snap(100, 25), snap(1500, 25)), 1e6);
  assert.equal(pack.walk(end, 100), null);
  assert.throws(() => pack.walk({ edge: 0, offset: 0 }, 10), TypeError, 'a walk needs a directed snap');
  // Its route works with slice / pointAt / snapAlong like any other.
  assert.equal(pack.slice(w, 0, w.length).length >= 3, true);
  assert.equal(pack.snapAlong(w, w.length).dir, 0);
});

test('walk: a siding is never taken, even when it is the straightest way on', () => {
  const d2 = tmpDir('walk-');
  try {
    const lay = { points: { A: [0, 0], J: [500, 0], S: [1500, 0], M1: [1000, 150], M2: [2000, 150] }, ways: [
      { pts: ['A', 'J'], tags: { name: 'approach', usage: 'main' } }, { pts: ['J', 'S'], tags: { name: 'siding', service: 'siding' } }, { pts: ['J', 'M1', 'M2'], tags: { name: 'main', usage: 'main' } }
    ] };
    const p2 = synth(d2, lay).pack;
    const from = { ...p2.nearestOnTrack(...ll(250, 0), { maxDist: 10 }), dir: 0 };
    const w = p2.walk(from, 1200);
    assert.deepEqual(w.pieces.map(x => p2.edgeInfo(x.e).name), ['approach', 'main']);
  } finally { rmrf(d2); }
});

// ---- continuations -----------------------------------------------------------------------------------------------------------

test('SAME: prev ends where of starts (within 2 m): the answer is of itself, and no join is stored as a geometry', () => {
  const sb = builder();
  const a = plant(sb, 100, 0, 400, 0), b = plant(sb, 400, 0, 900, 0), c = plant(sb, 401.5, 0, 900, 0), d = plant(sb, 404, 0, 900, 0);
  let r = sb.continuation(a.id, b.id);
  assert.deepEqual([r.id, r.how, r.prevKnown], [b.id, 'same', true]);
  near(r.length, b.len, 1e-9);
  r = sb.continuation(a.id, c.id);
  assert.deepEqual([r.id, r.how], [c.id, 'same'], '1.5 m apart is the same place');
  r = sb.continuation(a.id, d.id);
  assert.notEqual(r.id, d.id); assert.equal(r.how, 'direct', '4 m apart is not');
  assert.equal(sb.continuation(a.id, a.id).how, 'same', 'a span after itself');
  assert.equal(sb.continuationBody(a.id, b.id), null, 'nothing to write for a same');
  assert.deepEqual(sb.status().joins, { same: 2, direct: 1, beside: 0, straight: 0, fallback: 0 });
  // The tolerance is configurable.
  const sb2 = builder({ sameMetres: 6 });
  const e = plant(sb2, 100, 0, 400, 0), f = plant(sb2, 404, 0, 900, 0);
  assert.equal(sb2.continuation(e.id, f.id).how, 'same');
});

test('DIRECT: the continuation starts at prev\'s END, ends at of\'s end, across a junction; stop 0 / null / length by of\'s stop', () => {
  const sb = builder();
  const prev = plant(sb, 100, 0, 900, 0);                           // ends on the stem at x=900
  const ofRun = plant(sb, 1250, 75, 3500, 0), ofArr = plant(sb, 1250, 75, 3500, 0, 'end'), ofDep = plant(sb, 1250, 75, 3500, 0, 0);
  const c = sb.continuation(prev.id, ofRun.id);
  assert.equal(c.how, 'direct');
  assert.match(c.id, /^sp_[0-9a-f]{10}$/); assert.notEqual(c.id, ofRun.id);
  const body = sb.get(c.id);
  assert.deepEqual(Object.keys(body).sort(), ['id', 'length', 'path', 'stop']);
  assert.equal(body.id, c.id);
  assert.ok(metres(body.path[0], 900, 0) < 1, 'starts exactly where prev ends');
  assert.ok(metres(body.path.at(-1), 3500, 0) < 1, 'ends where of ends');
  near(body.length, 100 + (2 * Math.hypot(500, 150) + 1000) + 500, 3, 'stem to J, the upper leg, then to x=3500');
  assert.equal(body.stop, null, 'of is a pass');
  // stop rules
  assert.equal(sb.continuation(prev.id, ofDep.id).stop, 0, 'a departure berth stays "starts standing here"');
  const arr = sb.continuation(prev.id, ofArr.id);
  near(arr.stop, arr.length, 1e-9); near(sb.get(arr.id).stop, sb.get(arr.id).length, 1);
  // The same query is the same id, and the same body (immutable per id); the id resolves on a plain get.
  assert.equal(sb.continuation(prev.id, ofRun.id).id, c.id);
  assert.deepEqual(sb.get(c.id), body);
  assert.equal(sb.getAfter(ofRun.id, prev.id).stable, true);
  assert.deepEqual(sb.getAfter(ofRun.id, prev.id).body, body);
  assert.equal(sb.continuationBody(prev.id, ofRun.id).id, c.id);
  // Directed: of runs WEST on the stem (900 -> 600) and prev ends at x=100 facing east. A directed (a) cannot do it; the nearest
  // reachable point beside of's end takes over (rule b), and it is still on the stem.
  const west = plant(sb, 900, 0, 600, 0);
  const w = sb.continuation(plant(sb, 0, 0, 100, 0).id, west.id);
  assert.equal(w.how, 'beside');
  assert.ok(metres(sb.get(w.id).path.at(-1), 600, 0) < 1);
});

test('BESIDE: no directed route, so the nearest reachable point within 120 m of of\'s end on the train\'s OWN track (not of\'s track)', () => {
  const sb = builder();
  const prev = plant(sb, 100, 25, 800, 25);                          // on the parallel track, which cannot reach the stem
  const of = plant(sb, 700, 0, 950, 0);                              // a span on the stem
  const c = sb.continuation(prev.id, of.id);
  assert.equal(c.how, 'beside');
  const body = sb.get(c.id);
  assert.ok(metres(body.path[0], 800, 25) < 1);
  assert.ok(metres(body.path.at(-1), 950, 25) < 1.5, `it ends on the parallel track beside of's end, not on the stem (${body.path.at(-1)})`);
  near(body.length, 150, 1.5);
  assert.equal(body.stop, null);
  // The join's end is where it really ends: the NEXT continuation starts there (chaining, below).
  assert.ok(metres([sb._endOf(c.id).lat, sb._endOf(c.id).lon], 950, 25) < 1.5);
});

test('STRAIGHT: nothing reachable near of\'s end: straight on from prev\'s end for length(of), along the track', () => {
  const sb = builder();
  const prev = plant(sb, 100, 25, 800, 25);
  const of = plant(sb, 0, 2000, 500, 2000);                          // on the far island: unreachable, and nothing reachable within 120 m of it
  const c = sb.continuation(prev.id, of.id);
  assert.equal(c.how, 'straight');
  near(c.length, 500, 0.5);
  const body = sb.get(c.id);
  assert.ok(metres(body.path[0], 800, 25) < 1 && metres(body.path.at(-1), 1300, 25) < 1.5);
  near(body.length, 500, 1);
  // The track ends 700 m on: a longer berth walks as far as there is track, and says so in its length (the END is the route's own).
  const long = plant(sb, 0, 2000, 900, 2000);
  const c2 = sb.continuation(prev.id, long.id);
  assert.equal(c2.how, 'straight'); near(c2.length, 700, 0.5);
  assert.ok(metres(sb.get(c2.id).path.at(-1), 1500, 25) < 1.5);
  assert.equal(sb.status().joins.straight, 2);
});

test('FALLBACK: no route, nothing near, nowhere to walk (prev ends at the end of the track): of itself, counted, not cached as stable', () => {
  const sb = builder();
  const prev = plant(sb, 100, 25, 1500, 25);                         // ends at the very end of the parallel track
  const of = plant(sb, 0, 2000, 500, 2000);
  const c = sb.continuation(prev.id, of.id);
  assert.deepEqual([c.id, c.how], [of.id, 'fallback']);
  assert.equal(sb.continuationBody(prev.id, of.id), null);
  assert.equal(sb.getAfter(of.id, prev.id).stable, false);
  assert.deepEqual(sb.getAfter(of.id, prev.id).body.id, of.id);
  assert.equal(sb.status().joins.fallback, 1, 'counted once (the second ask is a hit on the record)');
});

test('UNKNOWN prev (never issued, or evicted): of itself, never stable; unknown of: null; a track library without the join calls: always of', () => {
  const sb = builder();
  const of = plant(sb, 400, 0, 900, 0);
  const c = sb.continuation('sp_deadbeef00', of.id);
  assert.deepEqual([c.id, c.prevKnown], [of.id, false]);
  assert.equal(sb.getAfter(of.id, 'sp_deadbeef00').stable, false);
  assert.equal(sb.status().joinStore.unknownPrev, 2);
  assert.equal(sb.continuation(of.id, 'sp_nosuchspan'), null);
  assert.equal(sb.getAfter('sp_nosuchspan', of.id), null);
  assert.equal(sb.getAfter('sp_nosuchspan', null), null);
  assert.equal(sb.get('sp_nosuchspan'), null);
  const plain = new SpanBuilder({ track: { signals: () => [] }, graph: new BerthGraph(), transit: new TransitStore(), config: config().spans, now: () => 1e12 });
  assert.equal(plain.hasJoins, false);
  assert.equal(plain.continuation('sp_a', 'sp_b'), null, 'of is unknown there');
});

test('CHAINS: a continuation can be a prev, and starts exactly where the previous continuation ENDS (not where its berth\'s span ends)', () => {
  const sb = builder();
  const a = plant(sb, 100, 25, 800, 25);                             // on the parallel track
  const b = plant(sb, 700, 0, 950, 0);                               // stem spans: each continuation lands beside, on the parallel track
  const c = plant(sb, 950, 0, 990, 0);
  const d = plant(sb, 0, 2000, 500, 2000);                           // far island: straight on
  const j1 = sb.continuation(a.id, b.id), j2 = sb.continuation(j1.id, c.id), j3 = sb.continuation(j2.id, d.id);
  assert.deepEqual([j1.how, j2.how, j3.how].join(), 'beside,beside,straight');
  assert.equal(new Set([j1.id, j2.id, j3.id, a.id, b.id, c.id, d.id]).size, 7);
  const p1 = sb.get(j1.id).path, p2 = sb.get(j2.id).path, p3 = sb.get(j3.id).path;
  assert.ok(metres(p2[0], 950, 25) < 1.5 && p2[0][0] === p1.at(-1)[0] && p2[0][1] === p1.at(-1)[1], 'the second starts at the first\'s last point');
  assert.ok(Math.hypot(p3[0][0] - p2.at(-1)[0], p3[0][1] - p2.at(-1)[1]) < 1e-5, 'and the third at the second\'s');
  // The 2 m test is against the END OF THE DRAWN span: the first continuation ends on the PARALLEL track (y=25), while b's own span
  // ends at y=0, 25 m away: a span starting where b ENDED is not "same" for a train that was drawn on j1.
  const e = plant(sb, 950, 0, 960, 0);
  assert.equal(sb.continuation(b.id, e.id).how, 'same', 'after the canonical b it would join up');
  assert.notEqual(sb.continuation(j1.id, e.id).how, 'same', 'after the drawn j1 it does not');
  // Every join resolves on a plain get.
  for (const j of [j1, j2, j3]) assert.equal(sb.get(j.id).id, j.id);
});

test('JOIN LRU: bounded; the least recently used join goes; an evicted join is REBUILT from its two ids to the identical id and body; a plain get of an evicted id is gone', () => {
  const sb = builder({ maxJoins: 3 });
  const prev = plant(sb, 100, 25, 800, 25);
  const ofs = [plant(sb, 700, 0, 950, 0), plant(sb, 700, 0, 940, 0), plant(sb, 700, 0, 930, 0), plant(sb, 700, 0, 920, 0), plant(sb, 700, 0, 910, 0)];
  const first = sb.continuation(prev.id, ofs[0].id), body0 = sb.get(first.id);
  sb.continuation(prev.id, ofs[1].id); sb.continuation(prev.id, ofs[2].id);
  sb.continuation(prev.id, ofs[0].id);                                // touch the first: now the second is the oldest
  sb.continuation(prev.id, ofs[3].id); sb.continuation(prev.id, ofs[4].id);
  assert.equal(sb.joins.size, 3);
  assert.equal(sb.status().joinStore.evicted, 2);
  assert.ok(sb.joins.has(sb._joinId(prev.id, ofs[4].id)) && sb.joins.has(sb._joinId(prev.id, ofs[3].id)));
  assert.ok(sb.joins.has(first.id), 'the one that was touched survived');
  assert.equal(sb.joins.has(sb._joinId(prev.id, ofs[1].id)), false, 'the least recently used is gone');
  assert.equal(sb.joins.has(sb._joinId(prev.id, ofs[2].id)), false);
  const second = sb._joinId(prev.id, ofs[1].id);
  assert.equal(sb.get(second), null, 'plain get of an evicted continuation id: unknown');
  // Asked again with its two ids it is rebuilt: same id, same body.
  const again = sb.continuation(prev.id, ofs[1].id);
  assert.equal(again.id, second);
  assert.equal(sb.get(second).id, second);
  const re0 = sb.continuation(prev.id, ofs[0].id);
  assert.equal(re0.id, first.id);
  assert.deepEqual(sb.get(re0.id), body0, 'a rebuilt join is byte-identical');
  // A chain whose OLD join was evicted: asking with the evicted id as prev is "unknown prev" (of itself), by contract.
  const tiny = builder({ maxJoins: 1 });
  const p = plant(tiny, 100, 25, 800, 25), b = plant(tiny, 700, 0, 950, 0), c = plant(tiny, 950, 0, 990, 0);
  const j1 = tiny.continuation(p.id, b.id);
  tiny.continuation(p.id, c.id);                                      // evicts j1
  assert.equal(tiny.continuation(j1.id, c.id).prevKnown, false);
});

test('JOINS are cheap to hold: a record is a handful of fields, and the ends cache is bounded too', () => {
  const sb = builder({ endsCacheEntries: 3 });
  const prev = plant(sb, 100, 25, 800, 25);
  for (let i = 0; i < 6; i++) sb.continuation(prev.id, plant(sb, 700, 0, 950 - i, 0).id);
  assert.ok(sb.endsCache.size <= 3);
  const rec = [...sb.joins.values()][0];
  assert.deepEqual(Object.keys(rec).sort(), ['end', 'how', 'id', 'length', 'of', 'prev', 'stop']);
  assert.deepEqual(Object.keys(rec.end).sort(), ['dir', 'edge', 'lat', 'lon', 'offset']);
});
