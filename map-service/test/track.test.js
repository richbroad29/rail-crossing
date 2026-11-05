'use strict';

// The track model: the builder's pipeline on planted ways with known answers (through a real PBF
// written by test/track-synth.js), the pack format, and the runtime library; then a few facts about
// real track from a 31 KB cut of the real pack (test/fixtures/track-sussex.bin, made by
// track/make-fixture.js): the Hove / Brighton / Preston Park triangle and Clayton Tunnel.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { synth, at } = require('./track-synth');
const { tmpDir, rmrf } = require('./helpers');
const { loadPack, TrackPack } = require('../src/track/pack');
const F = require('../src/track/format');
const { dist7, DEG7, KY: KYm, kxAt } = require('../src/track/geom');
const KXm = KYm * Math.cos(51 * Math.PI / 180);
const { writePack, StringTable } = require('../track/lib/assemble');
const { overview } = require('../track/lib/network');
const { snapStations, stationSections } = require('../track/lib/stations');
const { snapSignals } = require('../track/lib/signals');
const { simplify } = require('../track/lib/graph');

const FIX = path.join(__dirname, 'fixtures', 'track-sussex.bin');
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} vs ${b} (±${eps})`);
const named = (pack, e) => pack.edgeInfo(e).name;

// Layout A, in metres east/north of the origin:
//
//   W ---- J ==upper (via U1,U2, y=+150)== K ---- E ~~LR~~ LRC      stem W-J and K-E main, K-E is a TUNNEL
//             \\==lower (via L1,L2, y=-300)==//
//   a 100 m fragment far east (dropped), an isolated light_rail island (dropped), a light_rail spur E-LRC (kept),
//   a diamond crossing at X (two straight ways that do NOT connect), a plain crossing at X2 (they do).
const LAYOUT_A = {
  points: {
    W: [0, 0], J: [1000, 0], U1: [1500, 150], U2: [2500, 150], L1: [1500, -300], L2: [2500, -300], K: [3000, 0], E: [4000, 0], LRC: [4500, 0],
    F1: [6000, 0], F2: [6100, 0], LI1: [6000, 500], LI2: [6600, 500],
    D1a: [1500, -1000], X: [2000, -1000], D1b: [2500, -1000], D2a: [2000, -1500], D2b: [2000, -500],
    C1a: [5500, -1000], X2: [6000, -1000], C1b: [6500, -1000], C2a: [6000, -1500], C2b: [6000, -500]
  },
  ways: [
    { pts: ['W', 'J'], tags: { name: 'stem', usage: 'main', maxspeed: '60 mph', electrified: 'contact_line' } },
    { pts: ['J', 'U1', 'U2', 'K'], tags: { name: 'upper', usage: 'main' } },
    { pts: ['J', 'L1', 'L2', 'K'], tags: { name: 'lower', usage: 'branch' } },
    { pts: ['K', 'E'], tags: { name: 'tunnel stem', usage: 'main', tunnel: 'yes' } },
    { pts: ['E', 'LRC'], tags: { name: 'light spur', railway: 'light_rail' } },
    { pts: ['F1', 'F2'], tags: { name: 'fragment' } },
    { pts: ['LI1', 'LI2'], tags: { name: 'light island', railway: 'light_rail' } },
    { pts: ['D1a', 'X', 'D1b'], tags: { name: 'diamond 1' } },
    { pts: ['D2a', 'X', 'D2b'], tags: { name: 'diamond 2' } },
    { pts: ['C1a', 'X2', 'C1b'], tags: { name: 'crossing 1' } },
    { pts: ['C2a', 'X2', 'C2b'], tags: { name: 'crossing 2' } }
  ],
  nodeTags: { X: { railway: 'railway_crossing' } }
};

// Layout B: a long arc of main track and a short cut on a siding between P and Q; an OSM platform
// beside the apex of the arc.
const LAYOUT_B = {};
// main: P -> (500,600) -> M -> (1500,600) -> Q (a long arc), siding: straight P -> Q
LAYOUT_B.points = { W0: [-500, 0], P: [0, 0], A1: [500, 600], M1: [900, 1200], M2: [1100, 1200], A2: [1500, 600], Q: [2000, 0], E0: [2500, 0], S1: [1000, 0], PA: [920, 1203.4], PB: [1080, 1203.4] };
LAYOUT_B.ways = [
  { pts: ['W0', 'P'], tags: { name: 'stem west', usage: 'main' } },
  { pts: ['P', 'A1', 'M1', 'M2', 'A2', 'Q'], tags: { name: 'main arc', usage: 'main' } },
  { pts: ['P', 'S1', 'Q'], tags: { name: 'siding cut', service: 'siding' } },
  { pts: ['Q', 'E0'], tags: { name: 'stem east', usage: 'main' } },
  { pts: ['PA', 'PB'], tags: { railway: 'platform', ref: '2' } }
];

let dir, A, B;
test.before(() => { dir = tmpDir('track-'); A = synth(dir, LAYOUT_A); B = synth(dir, LAYOUT_B, { perBlock: 1000 }); });
test.after(() => rmrf(dir));

// ---- the builder pipeline on planted ways --------------------------------------------------------

test('64-bit ids and both blob-classification paths read the same railway', () => {
  const a2 = synth(dir, LAYOUT_A, { perBlock: 10000 });          // one block each: the fallback (unsorted-style) path
  assert.equal(a2.pack.nEdges, A.pack.nEdges);
  assert.equal(a2.pack.nNodes, A.pack.nNodes);
  assert.ok(A.ex.wanted[0] > 2 ** 32, 'ids beyond 32 bits survived');
  assert.equal(A.ex.ways.filter(w => w.tags.highway).length, 0, 'a non-rail way is not extracted');
});

test('junctions split ways; the 100 m fragment and the isolated light-rail island are dropped; the light-rail spur is kept and flagged', () => {
  const names = new Set();
  for (let e = 0; e < A.pack.nEdges; e++) names.add(named(A.pack, e));
  assert.ok(!names.has('fragment'), 'fragment under 200 m dropped');
  assert.ok(!names.has('light island'), 'light_rail touching no rail dropped');
  assert.ok(names.has('light spur'));
  const spur = [...Array(A.pack.nEdges).keys()].find(e => named(A.pack, e) === 'light spur');
  assert.equal(A.pack.edgeInfo(spur).lightRail, true);
  assert.equal(A.graph.stats.fragmentsDropped, 2);
  // J joins stem, upper, lower; K joins upper, lower, tunnel stem
  const deg = {};
  for (let n = 0; n < A.pack.nNodes; n++) deg[A.pack.edgesAt(n).length] = (deg[A.pack.edgesAt(n).length] || 0) + 1;
  assert.ok(deg[3] >= 2, 'two three-way junctions');
});

test('edge attributes: class, tunnel flag, maxspeed, electrification, length', () => {
  const info = n => A.pack.edgeInfo([...Array(A.pack.nEdges).keys()].find(e => named(A.pack, e) === n));
  assert.equal(info('stem').clsName, 'main');
  assert.equal(info('lower').clsName, 'branch');
  assert.equal(info('stem').maxspeedMph, 60);
  assert.equal(info('stem').electrified, 'overhead');
  assert.equal(info('tunnel stem').tunnel, true);
  assert.equal(info('stem').tunnel, false);
  near(info('stem').length, 1000, 1, 'stem length');
});

test('a railway_crossing node does not connect the two ways that cross there; an untagged shared node does', () => {
  const p = A.pack;
  const d1 = p.nearestOnTrack(...ll(1700, -1000), { maxDist: 5 }), d2 = p.nearestOnTrack(...ll(2000, -700), { maxDist: 5 });
  assert.ok(d1 && d2 && d1.edge !== d2.edge);
  assert.equal(p.route(d1, d2, { maxDeflection: 180 }), null, 'diamond: no connection even with no turn limit');
  const c1 = p.nearestOnTrack(...ll(5700, -1000), { maxDist: 5 }), c2 = p.nearestOnTrack(...ll(6000, -700), { maxDist: 5 });
  const r = p.route(c1, c2);
  assert.ok(r, 'a real junction connects them (a 90 degree turn is within the limit)');
  near(r.length, 300 + 300, 2);
});

/** [lat, lon] of metres-east/north in the test frame. */
function ll(x, y) { const p = at(x, y); return [p.lat7 * DEG7, p.lon7 * DEG7]; }

// ---- nearestOnTrack -----------------------------------------------------------------------------

test('nearestOnTrack: distance, offset, bearing, maxDist', () => {
  const s = A.pack.nearestOnTrack(...ll(500, 20));
  assert.equal(named(A.pack, s.edge), 'stem');
  near(s.dist, 20, 0.2); near(s.offset, 500, 0.5); near(s.bearing, 90, 0.5);
  assert.equal(A.pack.nearestOnTrack(...ll(500, 20), { maxDist: 10 }), null);
  const t = A.pack.nearestOnTrack(...ll(0, -40));      // beyond the start of the stem: clamps to its end, at the node
  near(t.offset, 0, 0.5); near(t.dist, 40, 0.3);
});

test('nearestOnTrack: avoidSidings, classes, bearing, k', () => {
  const p = B.pack;
  const q = ll(1000, -20);                              // beside the siding cut, far from the main arc
  assert.equal(named(p, p.nearestOnTrack(...q).edge), 'siding cut');
  assert.equal(p.nearestOnTrack(...q, { avoidSidings: true, maxDist: 300 }), null);
  assert.equal(p.nearestOnTrack(...q, { classes: [F.CLS.MAIN], maxDist: 300 }), null);
  assert.equal(p.nearestOnTrack(...q, { bearing: 0, bearingTol: 30 }), null, 'track runs east-west, not north-south');
  assert.ok(p.nearestOnTrack(...q, { bearing: 270, bearingTol: 10 }), 'either direction along the track counts');
  const two = A.pack.nearestOnTrack(...ll(2000, -100), { k: 3, maxDist: 400 });
  assert.ok(two.length >= 2 && two[0].dist <= two[1].dist);
  assert.equal(new Set(two.map(x => x.edge)).size, two.length);
});

// ---- route ---------------------------------------------------------------------------------------

test('route: takes the shorter leg of a loop, by length', () => {
  const p = A.pack;
  const from = p.nearestOnTrack(...ll(500, 0)), to = p.nearestOnTrack(...ll(3500, 0));
  const r = p.route(from, to);
  const used = r.pieces.map(x => named(p, x.e));
  assert.ok(used.includes('upper') && !used.includes('lower'), used.join(','));
  const upperLen = 2 * Math.hypot(500, 150) + 1000;      // J-U1, U1-U2, U2-K
  near(r.length, 500 + (Math.hypot(500, 150) * 2 + 1000) + 500, 3, 'route length');
  assert.ok(upperLen > 0);
});

test('route: no heel-to-heel turn at a junction, unless the limit is lifted; no reversing along the track just used', () => {
  const p = A.pack;
  const up = p.nearestOnTrack(...ll(1750, 150 * 0.5 + 25), { maxDist: 60 }), lo = p.nearestOnTrack(...ll(1250, -150), { maxDist: 80 });
  assert.equal(named(p, up.edge), 'upper'); assert.equal(named(p, lo.edge), 'lower');
  assert.equal(p.route(up, lo), null, 'upper leg to lower leg needs a reversal at J or K');
  const r = p.route(up, lo, { maxDeflection: 180 });
  assert.ok(r && r.length > 0 && r.length < 2500);
  // to a point behind you on the same edge is a straight run, no turn involved
  const a = p.nearestOnTrack(...ll(300, 0)), b = p.nearestOnTrack(...ll(700, 0));
  near(p.route(a, b).length, 400, 0.5); near(p.route(b, a).length, 400, 0.5);
});

test('route: avoidSidings takes the long way round on main track; without it the siding cut wins', () => {
  const p = B.pack;
  const from = p.nearestOnTrack(...ll(-300, 0), { maxDist: 5 }), to = p.nearestOnTrack(...ll(2300, 0), { maxDist: 5 });
  assert.equal(named(p, from.edge), 'stem west'); assert.equal(named(p, to.edge), 'stem east');
  const plain = p.route(from, to), avoid = p.route(from, to, { avoidSidings: true });
  assert.ok(plain.pieces.some(x => named(p, x.e) === 'siding cut'), 'unrestricted: via the siding');
  near(plain.length, 300 + 2000 + 300, 1);
  assert.ok(avoid.pieces.some(x => named(p, x.e) === 'main arc') && !avoid.pieces.some(x => named(p, x.e) === 'siding cut'), 'avoidSidings: the arc, never the siding');
  assert.ok(avoid.length > plain.length + 500);
  // the ends themselves may sit on a siding: only the edges the ends are on are exempt
  const s1 = p.nearestOnTrack(...ll(100, 0), { maxDist: 5 }), s2 = p.nearestOnTrack(...ll(1900, 0), { maxDist: 5 });
  assert.equal(named(p, s1.edge), 'siding cut');
  near(p.route(s1, s2, { avoidSidings: true }).length, 1800, 1);
});

test('route: arrays of snaps pick the best pair; unreachable is null; maxLength gives up', () => {
  const p = A.pack;
  const from = p.nearestOnTrack(...ll(500, 0));
  const tos = [p.nearestOnTrack(...ll(3500, 0)), p.nearestOnTrack(...ll(1200, -5), { maxDist: 100 })];
  const r = p.route(from, tos);
  assert.equal(r.to, tos[1], 'the nearer of the two targets');
  const island = p.nearestOnTrack(...ll(1700, -1000), { maxDist: 5 });
  assert.equal(p.route(from, island, { maxDeflection: 180 }), null);
  assert.equal(p.route(from, tos[0], { maxLength: 100 }), null);
  assert.throws(() => p.route({}, from), TypeError);
});

// ---- slice / pointAt -----------------------------------------------------------------------------

test('pointAt and slice: consistent with the route length, endpoints and bearing', () => {
  const p = A.pack;
  const from = p.nearestOnTrack(...ll(500, 0)), to = p.nearestOnTrack(...ll(3500, 0));
  const r = p.route(from, to);
  const a = p.pointAt(r, 0), b = p.pointAt(r, r.length), over = p.pointAt(r, r.length + 99), under = p.pointAt(r, -5);
  near(dist7(Math.round(a.lat * 1e7), Math.round(a.lon * 1e7), Math.round(from.lat * 1e7), Math.round(from.lon * 1e7)), 0, 0.05);
  near(dist7(Math.round(b.lat * 1e7), Math.round(b.lon * 1e7), Math.round(to.lat * 1e7), Math.round(to.lon * 1e7)), 0, 0.05);
  assert.deepEqual(over, b); assert.deepEqual(under, a);
  near(a.bearing, 90, 0.5);
  const full = p.slice(r, 0, r.length);
  const polyLen = pts => pts.slice(1).reduce((s, q, i) => s + dist7(Math.round(pts[i][0] * 1e7), Math.round(pts[i][1] * 1e7), Math.round(q[0] * 1e7), Math.round(q[1] * 1e7)), 0);
  near(polyLen(full), r.length, 0.5, 'whole slice');
  for (const [d0, d1] of [[100, 900], [700, 2300], [2000, 2001], [0, 5]]) near(polyLen(p.slice(r, d0, d1)), d1 - d0, 0.5, `slice ${d0}-${d1}`);
  const fwd = p.slice(r, 600, 1500), back = p.slice(r, 1500, 600);
  assert.deepEqual(back, fwd.slice().reverse(), 'd0 > d1 reverses');
  // pointAt advances by exactly the distance asked
  let prev = p.pointAt(r, 0);
  for (let d = 37; d < r.length; d += 37) {
    const q = p.pointAt(r, d);
    const step = dist7(Math.round(prev.lat * 1e7), Math.round(prev.lon * 1e7), Math.round(q.lat * 1e7), Math.round(q.lon * 1e7));
    assert.ok(step <= 37.05 && step > 30, `step ${step} at ${d}`);
    prev = q;
  }
});

test('a route that runs against the way direction still reads in travel order', () => {
  const p = A.pack;
  const east = p.route(p.nearestOnTrack(...ll(500, 0)), p.nearestOnTrack(...ll(900, 0)));
  const west = p.route(p.nearestOnTrack(...ll(900, 0)), p.nearestOnTrack(...ll(500, 0)));
  near(p.pointAt(east, 0).bearing, 90, 0.5);
  near(p.pointAt(west, 0).bearing, 270, 0.5);
  near(p.pointAt(west, 0).lon, p.pointAt(east, 400).lon, 1e-6);
});

// ---- the overview -------------------------------------------------------------------------------

test('overview: running lines only, tunnels drawn like any other track, lo is coarser than hi', () => {
  const hi = overview(B.pack, 15, 5), lo = overview(B.pack, 100, 4);
  const lines = o => o.geojson.features.flatMap(f => f.geometry.coordinates.map(c => [f.properties.class, c]));
  assert.ok(lines(hi).every(([cls]) => cls === 'main' || cls === 'branch'));
  assert.equal(lines(hi).length, 1, 'the siding cut is not in the overview, only the main arc');
  const oa = overview(A.pack, 15, 5);
  const allPts = oa.geojson.features.flatMap(f => f.geometry.coordinates.flat());
  const east = Math.max(...allPts.map(c => c[0]));
  assert.ok(east > at(3900, 0).lon7 * DEG7, 'the tunnel stem K-E reaches the overview exactly like open track');
  assert.deepEqual(oa.geojson.features.map(f => Object.keys(f.properties)), [['class'], ['class']], 'no tunnel property or styling');
  assert.ok(lo.points <= hi.points);
  assert.equal(zlib.gunzipSync(oa.gz).length, oa.json.length);
  const dev = overview(A.pack, 100, 4);
  assert.ok(dev.points <= oa.points);
});

test('simplify keeps the ends, and every dropped vertex lies within the tolerance of what was kept', () => {
  const la = [], lo = [];
  for (let i = 0; i <= 100; i++) { const p = at(i * 10, 8 * Math.sin(i / 4)); la.push(p.lat7); lo.push(p.lon7); }
  const LA = Int32Array.from(la), LO = Int32Array.from(lo);
  const keep = simplify(LA, LO, 1);
  assert.equal(keep[0], 0); assert.equal(keep[keep.length - 1], 100);
  assert.ok(keep.length < 101 && keep.length > 6, `kept ${keep.length}`);
  const xy = i => [(LO[i] - LO[0]) * DEG7 * KXm, (LA[i] - LA[0]) * DEG7 * KYm];
  for (let i = 0; i <= 100; i++) {
    let k = 0; while (keep[k + 1] < i && k + 1 < keep.length - 1) k++;
    const [ax, ay] = xy(keep[k]), [bx, by] = xy(keep[Math.min(k + 1, keep.length - 1)]), [px, py] = xy(i);
    const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
    assert.ok(Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) <= 1.02, `vertex ${i}`);
  }
  assert.deepEqual(simplify(LA, LO, 50), [0, 100]);
});

// ---- the format ----------------------------------------------------------------------------------

test('format round-trip: every section, META, both overviews, station and signal accessors', () => {
  const p = A.pack;
  // rebuild a string table that holds the graph's strings and the test's, in one intern order
  const strings = new StringTable();
  for (let i = 1; i < p.s.STRO.length - 1; i++) strings.intern(p.str(i));
  const st = [{ tiploc: 'TESTAAA', name: 'Test A', lat7: at(500, 10).lat7, lon7: at(500, 10).lon7, snaps: [{ edge: 0, offset: 12.5, dist: 3.25, platform: '1;2', lo: 5, hi: 90, flag: F.SNAP.PRIMARY | F.SNAP.PLATFORM }] },
    { tiploc: 'TESTBBB', name: 'Béta (ünïcode)', lat7: at(900, 0).lat7, lon7: at(900, 0).lon7, snaps: [] }];
  const S = Object.assign({}, p.s, stationSections(st, strings));
  Object.assign(S, { SGEDGE: Uint32Array.of(1), SGOFF: Float32Array.of(7.5), SGDIST: Float32Array.of(2), SGLAT: Int32Array.of(at(500, 5).lat7), SGLON: Int32Array.of(at(500, 5).lon7), SGREF: Uint32Array.of(strings.intern('SN123')), SGDIR: Uint8Array.of(F.SIGDIR.FORWARD), SGSIDE: Uint8Array.of(F.SIGSIDE.LEFT), SGKIND: Uint8Array.of(F.SIGKIND.MAIN | F.SIGKIND.ON_WAY) });
  Object.assign(S, strings.build());
  const lo = overview(p, 100, 4), hi = overview(p, 15, 5);
  const file = path.join(dir, 'rt.bin');
  const w = writePack(file, S, { metaJson: JSON.stringify({ hello: 'world', n: 3 }), networkLo: lo.gz, networkHi: hi.gz, built: 1234567890123 });
  assert.equal(fs.statSync(file).size, w.bytes);
  assert.equal(fs.readFileSync(file).subarray(0, 4).toString('latin1'), F.MAGIC);
  assert.equal(fs.readFileSync(file).readUInt32LE(4), F.VERSION);
  const back = loadPack(file);
  for (const id of Object.keys(S)) {
    if (id === 'ELEN') continue;
    assert.deepEqual(back.s[id], S[id], `section ${id}`);
  }
  assert.deepEqual(back.meta, { hello: 'world', n: 3 });
  assert.equal(back.sha256(), w.sha256, 'the pack hash (the overview ETag) is the file hash');
  assert.equal(Buffer.compare(back.network('lo'), lo.gz), 0);
  assert.equal(Buffer.compare(back.network('hi'), hi.gz), 0);
  const a = back.station('TESTAAA');
  assert.equal(a.name, 'Test A');
  assert.deepEqual([a.snaps.length, a.snaps[0].platform, a.snaps[0].primary, a.snaps[0].fromPlatform, a.snaps[0].lo, a.snaps[0].hi, a.snaps[0].dist], [1, '1;2', true, true, 5, 90, 3.25]);
  const b = back.station('TESTBBB');
  assert.equal(b.name, 'Béta (ünïcode)'); assert.deepEqual(b.snaps, []);
  assert.equal(back.station('NOPE'), null);
  const sg = back.signals();
  assert.deepEqual([sg.length, sg[0].ref, sg[0].direction, sg[0].side, sg[0].kind, sg[0].onWay], [1, 'SN123', 'forward', 'left', F.SIGKIND.MAIN, true]);
  // a reloaded pack answers like the one it was built from
  const x = p.nearestOnTrack(...ll(500, 20)), y = back.nearestOnTrack(...ll(500, 20));
  assert.deepEqual([y.edge, y.offset, y.dist], [x.edge, x.offset, x.dist]);
  // skipping a section leaves it out of memory
  assert.equal(loadPack(file, { skip: ['SGEDGE'] }).s.SGEDGE, undefined);
});

test('format: wrong magic, future version, truncation and bad section bounds are refused with a plain message', () => {
  const file = path.join(dir, 'rt.bin');
  const good = fs.readFileSync(file);
  const bad = (name, mutate, re) => {
    const b = Buffer.from(good); mutate(b);
    const f = path.join(dir, name); fs.writeFileSync(f, b);
    assert.throws(() => loadPack(f), re, name);
  };
  bad('magic.bin', b => b.write('XXXX', 0, 'latin1'), /wrong magic/);
  bad('version.bin', b => b.writeUInt32LE(F.VERSION + 1, 4), /format version/);
  fs.writeFileSync(path.join(dir, 'trunc.bin'), good.subarray(0, good.length - 100));
  assert.throws(() => loadPack(path.join(dir, 'trunc.bin')), /truncated or corrupt/);
  fs.writeFileSync(path.join(dir, 'tiny.bin'), good.subarray(0, 10));
  assert.throws(() => loadPack(path.join(dir, 'tiny.bin')), /too short/);
  bad('range.bin', b => b.writeDoubleLE(1e12, F.HEADER_BYTES + 16), /runs past the end/);
  // a missing required section
  const S = Object.assign({}, A.pack.s); delete S.EVO;
  assert.throws(() => new TrackPack(S, {}), /required section EVO/);
});

// ---- station snaps -------------------------------------------------------------------------------

test('station snap rules: nearest running edge within 300 m; siding-only and far stations stay unsnapped; platform tracks from OSM platforms', () => {
  const rows = [
    { tiploc: 'NEARMAI', name: 'Near main', lat: ll(1000, 1260)[0], lon: ll(1000, 1260)[1] },   // 60 m off the main arc's apex, with a platform beside it
    { tiploc: 'SIDING1', name: 'Siding only', lat: ll(1000, -30)[0], lon: ll(1000, -30)[1] },   // only the siding cut is within 300 m
    { tiploc: 'FARAWAY', name: 'Far', lat: ll(1000, 3000)[0], lon: ll(1000, 3000)[1] }
  ];
  const r = snapStations(B.pack, { rows }, B.ex);
  const by = Object.fromEntries(r.stations.map(s => [s.tiploc, s]));
  const prim = by.NEARMAI.snaps.find(s => s.flag & F.SNAP.PRIMARY);
  assert.equal(named(B.pack, prim.edge), 'main arc');
  near(prim.dist, 60, 1);
  assert.deepEqual(r.unsnapped.sort(), ['FARAWAY Far', 'SIDING1 Siding only']);
  assert.equal(r.stats.snapped, 1); assert.equal(r.stats.unsnapped, 2);
  const plat = by.NEARMAI.snaps.find(s => s.flag & F.SNAP.PLATFORM);
  assert.ok(plat, 'the OSM platform beside the track produced a platform snap');
  assert.equal(plat.platform, '2');
  assert.ok(plat.lo < plat.offset && plat.offset < plat.hi);
  near(plat.dist, 3.2, 1.2);
});

test('station snap: the section arrays carry the snaps and the unsnapped station has none', () => {
  const rows = [{ tiploc: 'NEARMAI', name: 'Near main', lat: ll(1000, 1260)[0], lon: ll(1000, 1260)[1] }, { tiploc: 'FARAWAY', name: 'Far', lat: ll(1000, 3000)[0], lon: ll(1000, 3000)[1] }];
  const r = snapStations(B.pack, { rows }, B.ex);
  const strings = new StringTable();
  const s = stationSections(r.stations, strings);
  assert.deepEqual(Array.from(s.STSNO), [0, r.stations[0].snaps.length, r.stations[0].snaps.length]);
  assert.ok(s.SNFLG.some(f => f & F.SNAP.PRIMARY));
});

test('signals: on-way ones keep their direction tag, beside-track ones record a side, refless and far ones are not stored', () => {
  // a track with three signal nodes: on the way (tagged forward), 6 m to its left (north, travelling east) and no ref / 200 m away
  const lay = {
    points: { A: [0, 0], S: [500, 0], B: [1000, 0], T: [300, 6], U: [400, 3], V: [200, 200] },
    ways: [{ pts: ['A', 'S', 'B'], tags: { usage: 'main', name: 'line' } }],
    nodeTags: {
      S: { railway: 'signal', ref: 'AB12', 'railway:signal:direction': 'forward', 'railway:signal:main': 'UK-NR:colour_light' },
      T: { railway: 'signal', ref: 'AB13', 'railway:signal:direction': 'backward', 'railway:signal:distant': 'UK-NR:colour_light' },
      U: { railway: 'signal', 'railway:signal:main': 'UK-NR:colour_light' },
      V: { railway: 'signal', ref: 'FAR1' }
    }
  };
  const x = synth(dir, lay);
  const strings = new StringTable();
  for (let i = 1; i < x.pack.s.STRO.length - 1; i++) strings.intern(x.pack.str(i));
  const r = snapSignals(x.pack, x.graph, x.ex, strings);
  assert.deepEqual([r.stats.signalNodes, r.stats.withRef, r.stats.onWay, r.stats.snappedOffWay, r.stats.unsnapped], [4, 3, 1, 1, 1]);
  const s = r.sections;
  const refs = Array.from(s.SGREF).map(i => strings.list[i]);
  assert.deepEqual(refs.sort(), ['AB12', 'AB13']);
  const i12 = refs.indexOf('AB12'), i13 = refs.indexOf('AB13');
  const bySignal = ref => { const j = Array.from(s.SGREF).findIndex(k => strings.list[k] === ref); return { dir: s.SGDIR[j], side: s.SGSIDE[j], kind: s.SGKIND[j], dist: s.SGDIST[j], off: s.SGOFF[j] }; };
  const on = bySignal('AB12'), beside = bySignal('AB13');
  assert.equal(on.dir, F.SIGDIR.FORWARD); assert.equal(on.side, F.SIGSIDE.ON); assert.ok(on.kind & F.SIGKIND.ON_WAY && on.kind & F.SIGKIND.MAIN); near(on.off, 500, 0.5);
  assert.equal(beside.dir, F.SIGDIR.UNKNOWN, 'a direction tag on a node that is not on the way means nothing');
  assert.equal(beside.side, F.SIGSIDE.LEFT, 'north of an eastbound edge is its left');
  assert.ok(beside.kind & F.SIGKIND.DISTANT); near(beside.dist, 6, 0.2); near(beside.off, 300, 0.5);
  assert.ok(i12 >= 0 && i13 >= 0);
});

// ---- real track: the Sussex fixture ---------------------------------------------------------------

test('real track: the fixture loads, holds the stations of the corner of Sussex, and every snap is on a real edge', () => {
  const p = loadPack(FIX);
  assert.ok(p.nEdges > 200 && p.nEdges < 2000);
  for (const t of ['PSLDAWH', 'STHWICK', 'BRGHTN', 'HOVE', 'PRSP', 'HASOCKS']) assert.ok(p.station(t), t);
  for (const t of p.stationTiplocs()) for (const sn of p.station(t).snaps) assert.ok(sn.edge < p.nEdges && sn.offset >= 0 && sn.offset <= p.length(sn.edge) + 1e-3, t);
  const ps = p.station('PSLDAWH');
  const prim = ps.snaps.find(s => s.primary);
  assert.ok(prim.dist <= 300 && prim.cls !== F.CLS.SIDING && prim.cls !== F.CLS.YARD);
  assert.deepEqual(ps.snaps.filter(s => s.platform).map(s => s.platform).sort(), ['1', '2'], 'Portslade has two platform tracks');
  const sw = p.station('STHWICK').snaps.filter(s => s.platform).map(s => s.platform).sort();
  assert.deepEqual(sw, ['1', '2']);
  assert.ok(p.station('BRGHTN').snaps.filter(s => s.platform).length >= 8, 'Brighton throat: platform tracks are separate');
  const sg = p.signals();
  assert.ok(sg.length > 0 && sg.every(s => s.ref && s.dist < 25));
});

test('real track: Hove -> Preston Park takes the Hove curve, not Brighton; the sides of the triangle are consistent', () => {
  const p = loadPack(FIX);
  const S = t => p.station(t).snaps;
  const hpp = p.route(S('HOVE'), S('PRSP')), hb = p.route(S('HOVE'), S('BRGHTN')), pb = p.route(S('PRSP'), S('BRGHTN'));
  assert.ok(hpp && hb && pb);
  assert.ok(hpp.length > 2000 && hpp.length < 2700, `Hove-Preston Park ${hpp.length}`);
  assert.ok(hb.length > 1800 && hb.length < 2500 && pb.length > 1700 && pb.length < 2300);
  // a train cannot run Hove -> Brighton -> Preston Park without reversing in the terminus, so the curve is the only way
  assert.ok(hpp.length < hb.length + pb.length - 1500, 'much shorter than via Brighton');
  const brightonEdges = new Set(S('BRGHTN').filter(s => s.platform).map(s => s.edge));
  assert.ok(!hpp.pieces.some(x => brightonEdges.has(x.e)), 'the route does not enter a Brighton platform track');
  // and the reverse is the same distance
  near(p.route(S('PRSP'), S('HOVE')).length, hpp.length, 0.5);
});

test('real track: Clayton Tunnel is present, flagged as a tunnel, and joins Hassocks to Preston Park', () => {
  const p = loadPack(FIX);
  const mid = [50.9026, -0.1590];                         // the middle of the tunnel
  const tun = p.nearestOnTrack(...mid, { maxDist: 60, k: 4 }).filter(x => p.edgeInfo(x.edge).tunnel);
  assert.ok(tun.length >= 1, 'a tunnel-flagged edge runs through Clayton Tunnel');
  assert.ok(p.edgeInfo(tun[0].edge).length > 1000, 'a long edge, not a stub');
  assert.equal(p.edgeInfo(tun[0].edge).name, 'Brighton Main Line');
  // connected at both ends: it has onward edges at both its nodes
  const e = p.edgeInfo(tun[0].edge);
  assert.ok(p.edgesAt(e.from).length >= 2 && p.edgesAt(e.to).length >= 2, 'tunnel edge joins track at both portals');
  const r = p.route(p.station('HASOCKS').snaps, p.station('PRSP').snaps, { avoidSidings: true });
  assert.ok(r, 'Hassocks and Preston Park are connected');
  assert.ok(r.length > 8800 && r.length < 9400, `length ${r.length}`);
  const inTunnel = r.pieces.filter(x => p.edgeInfo(x.e).tunnel).reduce((s, x) => s + Math.abs(x.b - x.a), 0);
  assert.ok(inTunnel > 1500, `route runs ${Math.round(inTunnel)} m in tunnel`);
  assert.ok(tun.some(t => r.pieces.some(x => x.e === t.edge)), 'and the route runs through one of the tunnel edges at that spot');
});

test('real track: avoidSidings and fragments on real data - the Brighton route never uses a siding', () => {
  const p = loadPack(FIX);
  const r = p.route(p.station('HASOCKS').snaps, p.station('BRGHTN').snaps, { avoidSidings: true });
  assert.ok(r);
  assert.ok(!r.pieces.some(x => { const c = p.ecls[x.e]; return c === F.CLS.SIDING || c === F.CLS.YARD; }));
});

// ---- stitching ------------------------------------------------------------------------------------

test('stitching: a dangling end within 1 m of a running edge on the SAME level joins it; across levels it never does', () => {
  const lay = {
    points: {
      M0: [0, 0], M1: [1000, 0],
      B0: [500, 300], B1: [500, 0.6],                       // branch ending 0.6 m short of the main line: joined (T junction)
      C0: [2000, 0], C1a: [2500, 0], C1b: [2500, 0], C2: [3000, 0],   // two ways ending on the same coordinates, different nodes: merged
      R0: [700, 300], R1: [700, 0.4],                       // a bridge ending 0.4 m from the line: NOT joined
      U0: [800, -300], U1: [800, -0.4],                     // a tunnel ending 0.4 m from the line: NOT joined
      G0: [900, 300], G1: [900, 1.5]                        // 1.5 m short: too far, NOT joined
    },
    ways: [
      { pts: ['M0', 'M1'], tags: { name: 'main', usage: 'main' } },
      { pts: ['B0', 'B1'], tags: { name: 'branch', usage: 'branch' } },
      { pts: ['C0', 'C1a'], tags: { name: 'c1', usage: 'main' } },
      { pts: ['C1b', 'C2'], tags: { name: 'c2', usage: 'main' } },
      { pts: ['R0', 'R1'], tags: { name: 'bridge', bridge: 'yes', layer: '1', usage: 'branch' } },
      { pts: ['U0', 'U1'], tags: { name: 'tunnel', tunnel: 'yes', layer: '-1', usage: 'branch' } },
      { pts: ['G0', 'G1'], tags: { name: 'gap', usage: 'branch' } }
    ]
  };
  const x = synth(dir, lay);
  const p = x.pack, st = x.graph.stats;
  assert.equal(st.stitchJoined, 1, 'the T gap');
  assert.equal(st.stitchMergedWithNode, 1, 'the end-to-end gap');
  assert.equal(st.stitchRefusedOtherLevel, 2, 'the bridge and the tunnel were candidates and were refused');
  const snap = (xm, ym) => p.nearestOnTrack(...ll(xm, ym), { maxDist: 5 });
  const reach = (a, b) => p.route(snap(...a), snap(...b), { maxDeflection: 180 });
  assert.ok(reach([500, 150], [200, 0]), 'branch -> main: joined');
  near(reach([500, 150], [200, 0]).length, 150 + 300, 3);
  assert.ok(reach([2200, 0], [2800, 0]), 'the two end-to-end ways are one track');
  assert.equal(reach([700, 150], [200, 0]), null, 'a bridge is not joined to the line beneath it');
  assert.equal(reach([800, -150], [200, 0]), null, 'a tunnel is not joined to the line above it');
  assert.equal(reach([900, 150], [200, 0]), null, '1.5 m is a gap, not a join');
  // the split edge keeps its geometry: the main line is still 1000 m end to end and the junction node has three edges
  const m = x.pack.nearestOnTrack(...ll(200, 0), { maxDist: 5 });
  near(p.route(m, snap(900, 0)).length, 700, 1.5);
  assert.ok(x.graph.stitches.some(s => s.kind === 'joined'));
});

// ---- route accuracy against published distances ---------------------------------------------------

// 24 real station pairs across Sussex, London, Kent, Berkshire and Glasgow (test/track-pairs.js; each row cites the
// ELR mileage tables the distance comes from), routed with the snap arrays the service uses (pack.stationSnaps: every
// platform track of every TIPLOC of the station). A route must be within 10% of the published rail distance, or 250 m,
// whichever is larger: the mileages are for the station building and the pack's stop point is mid-platform.
// The corridors fixture is gzipped (test/fixtures/track-routes.bin.gz, made by track/make-fixture.js routes).
const { PAIRS } = require('./track-pairs');
let corridors;
function loadCorridors() {
  if (!corridors) {
    const f = path.join(dir, 'track-routes.bin');
    fs.writeFileSync(f, zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'track-routes.bin.gz'))));
    corridors = loadPack(f);
  }
  return corridors;
}

test('route accuracy: 24 real station pairs are within 10% of the published rail distance', () => {
  const p = loadCorridors();
  assert.ok(PAIRS.length >= 20);
  const bad = [];
  for (const pair of PAIRS) {
    const r = p.route(p.stationSnaps(pair.a), p.stationSnaps(pair.b), { avoidSidings: true });
    const km = r ? r.length / 1000 : null;
    if (km === null || Math.abs(km - pair.km) > Math.max(0.1 * pair.km, 0.25)) bad.push(`${pair.a} - ${pair.b}: route ${km && km.toFixed(2)} km, published ${pair.km.toFixed(2)} km (${pair.src})`);
  }
  assert.deepEqual(bad, []);
});

test('route accuracy: the pairs run through Clayton Tunnel and the Thameslink core tunnels', () => {
  const p = loadCorridors();
  const used = (a, b) => p.route(p.stationSnaps(a), p.stationSnaps(b), { avoidSidings: true }).pieces.map(x => p.edgeInfo(x.e));
  assert.ok(used('Haywards Heath', 'Brighton').some(e => e.tunnel && e.length > 1000), 'Clayton Tunnel');
  assert.ok(used('London St Pancras International', 'London Blackfriars').filter(e => e.tunnel).reduce((s, e) => s + e.length, 0) > 1500, 'Thameslink core in tunnel');
  assert.ok(used('Reading', 'London Paddington').length > 30);
});

test('route accuracy: the 100 degree turn limit does not decide any of the 24 results (100 and 150 agree to the metre)', () => {
  const p = loadCorridors();
  for (const pair of PAIRS) {
    const a = p.route(p.stationSnaps(pair.a), p.stationSnaps(pair.b), { avoidSidings: true, maxDeflection: 100 });
    const b = p.route(p.stationSnaps(pair.a), p.stationSnaps(pair.b), { avoidSidings: true, maxDeflection: 150 });
    near(a.length, b.length, 1, `${pair.a} - ${pair.b}`);
  }
});

test('route accuracy: routing from ONE snap on ONE track per station can be wildly off, which is why stationSnaps exists', () => {
  const p = loadCorridors();
  let off = 0;
  for (const pair of PAIRS) {
    const ta = p.stationTiplocs().find(t => p.station(t).name === pair.a), tb = p.stationTiplocs().find(t => p.station(t).name === pair.b);
    const sa = p.station(ta).snaps.filter(s => s.primary), sb = p.station(tb).snaps.filter(s => s.primary);
    const r = sa.length && sb.length ? p.route(sa, sb, { avoidSidings: true }) : null;
    if (!r || r.length / 1000 > 1.5 * pair.km) off++;
  }
  assert.ok(off >= 1, 'a single primary snap is direction-blind: it sits on whichever track is nearest, not the one the train uses');
});

test('stationSnaps: groups every TIPLOC of a station, never another town\'s namesake', () => {
  const p = loadCorridors();
  const cj = p.stationSnaps('Clapham Junction');
  assert.ok(new Set(cj.map(s => s.tiploc)).size >= 5, 'Clapham Junction has five TIPLOCs in NaPTAN');
  assert.deepEqual([...new Set(p.stationSnaps('CLPHMJC').map(s => s.tiploc))].sort(), [...new Set(cj.map(s => s.tiploc))].sort(), 'by TIPLOC or by name');
  assert.ok(new Set(p.stationSnaps('London Bridge').map(s => s.tiploc)).size >= 2);
  assert.deepEqual(p.stationSnaps('No Such Station'), []);
});
