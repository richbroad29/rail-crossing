'use strict';

// Continuation spans (contract section 17.1) through the service: GET /span/:id?after=:prev, and the recorder's continuation `span`
// lines. The service's track library here is a fake (stations on a hashed point each, straight routes) that has the join calls, so
// every join is a straight 'direct' run; the geometry of each join rule is tested on real planted track in continuations.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { startRig, NOW } = require('./rig');
const { getJson, until } = require('./helpers');
const { LineMaker } = require('../src/record');

function joinFake() {
  const station = key => { const h = [...key].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 1000, 7); return { lat: 51 + (h % 37) * 0.001, lon: -1 + h * 0.0004 }; };
  const lerp = (r, d) => { const t = r.length ? d / r.length : 0; return [r.fromPt.lat + (r.toPt.lat - r.fromPt.lat) * t, r.fromPt.lon + (r.toPt.lon - r.fromPt.lon) * t]; };
  return {
    stationSnaps: key => [{ tiploc: key, platform: null, primary: true, edge: 1, offset: 0, ...station(key) }],
    route(a, b) {
      const x = [].concat(a)[0], y = [].concat(b)[0];
      const len = Math.hypot((x.lat - y.lat) * 111195, (x.lon - y.lon) * 111195 * Math.cos(x.lat * Math.PI / 180));
      return { length: len, pieces: [{ e: 1, dir: 0, a: 0, b: len }], from: x, to: y, fromPt: x, toPt: y };
    },
    slice: (r, d0, d1) => [lerp(r, d0), lerp(r, d1)],
    snapAlong(r, d) { const [lat, lon] = lerp(r, Math.max(0, Math.min(r.length, d))); return { edge: 1, offset: d, dir: 0, lat, lon }; },
    walk: () => null,
    nearestOnTrack: () => []
  };
}
const WIDE = { record: { bbox: [50.5, -1.5, 51.5, 0.0], segmentSecs: 600 } };

/**
 * Three spanned berths of one TD area, from different chains, such that each step between them is a real gap (the previous span
 * ends more than 5 m from where the next starts), so each step is a join the service must make.
 */
function threeChains(rig) {
  const sb = rig.app.spans, g = rig.app.graph;
  sb.settle();
  const byChain = new Map();
  for (const [k, rec] of sb.byBerth) if (g.areaOf[k] === 'LA' && !byChain.has(rec.chainKey)) byChain.set(rec.chainKey, k);
  const keys = [...byChain.values()];
  const gap = (a, b) => { const ea = sb._ends(sb._canon(sb.forBerth(a).id)).end, eb = sb._ends(sb._canon(sb.forBerth(b).id)).start; return Math.hypot((ea.lat - eb.lat) * 111195, (ea.lon - eb.lon) * 70000); };
  for (const a of keys) for (const b of keys) for (const c of keys) if (a !== b && b !== c && a !== c && [[a, b], [b, c], [c, a], [b, a], [c, b], [a, c]].every(([x, y]) => gap(x, y) > 5)) return [a, b, c];
  throw new Error('no three spanned LA berths with gaps between them');
}

function readRecord(rig) {
  const dir = path.join(rig.dataDir, 'record');
  return fs.readdirSync(dir).sort().map(f => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)));
}

test('HTTP: /span/:id?after=:prev serves the continuation (immutable), validates after, treats an unknown prev as of itself (not cached), and plain /span/:id is unchanged', async () => {
  const rig = await startRig({ track: joinFake() });
  try {
    const sb = rig.app.spans, [kA, kB] = threeChains(rig);
    const A = sb.forBerth(kA), B = sb.forBerth(kB);
    const plain = await getJson(rig.port, `/map/v1/span/${B.id}`);
    assert.equal(plain.status, 200);
    assert.equal(plain.headers['cache-control'], 'public, max-age=604800, immutable');
    const r = await getJson(rig.port, `/map/v1/span/${B.id}?after=${A.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'public, max-age=604800, immutable');
    assert.deepEqual(Object.keys(r.json).sort(), ['id', 'length', 'path', 'stop']);
    assert.notEqual(r.json.id, B.id, 'a continuation has its own id');
    assert.deepEqual(r.json.path[0], sb.get(A.id).path.at(-1), 'it starts where A ends');
    assert.deepEqual(r.json.path.at(-1), plain.json.path.at(-1), 'and ends where B ends');
    const byId = await getJson(rig.port, `/map/v1/span/${r.json.id}`);
    assert.deepEqual(byId.json, r.json, 'the continuation id resolves on a plain GET');
    assert.equal(byId.headers['cache-control'], 'public, max-age=604800, immutable');
    // unknown prev: of itself, 200, and NOT cached as immutable (it may be known a moment later)
    const unk = await getJson(rig.port, `/map/v1/span/${B.id}?after=sp_0123456789`);
    assert.equal(unk.status, 200); assert.deepEqual(unk.json, plain.json); assert.equal(unk.headers['cache-control'], 'no-store');
    // validation
    for (const bad of ['after=', 'after=xx', 'after=sp_', 'after=sp_0123456789abcdef0', `after=${A.id}&after=${A.id}`, 'after=..%2f']) assert.equal((await getJson(rig.port, `/map/v1/span/${B.id}?${bad}`)).status, 400, bad);
    assert.equal((await getJson(rig.port, `/map/v1/span/sp_0123456789?after=${A.id}`)).status, 404, 'unknown id is still 404');
    const other = await getJson(rig.port, `/map/v1/span/${B.id}?other=1`);
    assert.equal(other.status, 200); assert.deepEqual(other.json, plain.json, 'unrelated parameters are ignored');
    const h = (await getJson(rig.port, '/map/v1/health')).json.diagnostics.spans;
    assert.equal(h.joins.direct, 1);
    assert.deepEqual(Object.keys(h.joins).sort(), ['beside', 'direct', 'fallback', 'same', 'straight']);
  } finally { await rig.stop(); }
});

test('RECORDER: a continuation `span` line {id, after, of, length, path, stop} precedes the line that references the new span; a CHAIN of two continuations names the DRAWN id of the previous berth', async () => {
  const rig = await startRig({ track: joinFake(), overrides: WIDE });
  try {
    const g = rig.app.graph, sb = rig.app.spans, [k1, k2, k3] = threeChains(rig);
    const b = k => g.berth(k), S = k => sb.forBerth(k).id;
    rig.td([['CC', 'LA', '2K22', null, b(k1)]]); await rig.settle(300);
    rig.clock.now = NOW + 5000; rig.td([['CA', 'LA', '2K22', b(k1), b(k2)]]); await rig.settle(300);
    rig.clock.now = NOW + 9000; rig.td([['CA', 'LA', '2K22', b(k2), b(k3)]]); await rig.settle(300);
    const [lines] = readRecord(rig);
    const conts = lines.filter(l => l.event === 'span' && l.data.after);
    assert.equal(conts.length, 2, 'one for k1 -> k2, one for k2 -> k3');
    assert.deepEqual(Object.keys(conts[0].data), ['id', 'after', 'of', 'length', 'path', 'stop']);
    assert.deepEqual([conts[0].data.after, conts[0].data.of], [S(k1), S(k2)]);
    assert.equal(conts[0].data.id, sb.continuation(S(k1), S(k2)).id);
    assert.deepEqual(conts[0].data, { ...sb.get(conts[0].data.id), after: S(k1), of: S(k2) }, 'the line is what GET /span/<of>?after=<after> serves, plus after and of');
    // THE CHAIN: the second continuation is after the DRAWN previous span (the first continuation), not the canonical S(k2).
    assert.deepEqual([conts[1].data.after, conts[1].data.of], [conts[0].data.id, S(k3)]);
    assert.equal(conts[1].data.id, sb.continuation(conts[0].data.id, S(k3)).id);
    assert.deepEqual(conts[1].data.path[0], conts[0].data.path.at(-1), 'the second starts where the first ended');
    assert.notEqual(conts[1].data.id, sb.continuation(S(k2), S(k3)).id, 'which is not the join a canonical prev would give');
    // Each continuation line comes before the first line whose train references the new span; mv.sp still names the berth's own span.
    for (const c of conts) {
      const iC = lines.indexOf(c), iUse = lines.findIndex(l => l.event === 'update' && l.data.upsert.some(t => t.mv && t.mv.sp === c.data.of));
      assert.ok(iC >= 0 && iUse > iC, 'span line before the update that references the new berth');
    }
    // Once per segment: another train taking the same step reuses the line.
    rig.td([['CC', 'LA', '3M33', null, b(k1)]]); await rig.settle(300);
    rig.clock.now = NOW + 12000; rig.td([['CA', 'LA', '3M33', b(k1), b(k2)]]); await rig.settle(300);
    assert.equal(readRecord(rig)[0].filter(l => l.event === 'span' && l.data.after).length, 2);
  } finally { await rig.stop(); }
});

test('RECORDER: the drawn-span state is reset with each segment, bounded, forgotten when a train has no span or is removed, and not advanced by a block the file refused', async () => {
  const rig = await startRig({ track: joinFake(), overrides: WIDE });
  try {
    const g = rig.app.graph, sb = rig.app.spans, [k1, k2, k3] = threeChains(rig);
    const b = k => g.berth(k), S = k => sb.forBerth(k).id;
    rig.td([['CC', 'LA', '2K22', null, b(k1)]]); await rig.settle(300);
    rig.clock.now = NOW + 5000; rig.td([['CA', 'LA', '2K22', b(k1), b(k2)]]); await rig.settle(300);
    // 700 s later: a new segment, opened by the step into k3 (so its snapshot already has the train on k3's own span). The next step
    // continues from k3's drawn span, which in THIS file is k3's own span: the first segment's continuations are unknown to a reader
    // of this file alone, so none of them may be named.
    rig.clock.now = NOW + 700_000; rig.td([['CA', 'LA', '2K22', b(k2), b(k3)]]); await rig.settle(300);
    rig.clock.now = NOW + 705_000; rig.td([['CA', 'LA', '2K22', b(k3), b(k1)]]); await rig.settle(300);
    const [first, second] = readRecord(rig);
    const c1 = first.filter(l => l.event === 'span' && l.data.after), c2 = second.filter(l => l.event === 'span' && l.data.after);
    assert.equal(c1.length, 1);
    assert.equal(c2.length, 1);
    assert.deepEqual([c2[0].data.after, c2[0].data.of], [S(k3), S(k1)], 'after = the canonical k3 span: nothing earlier in this segment');
    assert.ok(!JSON.stringify(second).includes(c1[0].data.id), 'the first segment\'s continuation is not in the second file');
  } finally { await rig.stop(); }
  const body = id => ({ id, length: 1, path: [[0, 0], [0, 1]], stop: null });
  const tr = (id, sp) => JSON.stringify({ id, hc: '1A00', ...(sp ? { mv: { sp, t0: 1 } } : {}), lat: 1, lon: 1 });
  const upd = (t, ...trains) => ({ serverTime: t, upsert: trains, remove: [] });
  // bounded: a cap of one train; the older one is forgotten, so its next step is drawn on its own span (no line)
  const joins = [];
  const m = new LineMaker(body, (a, o) => { joins.push(a); return body('sp_j' + joins.length); }, 1);
  m.update(upd(1, tr('tA', 'sp_a0'), tr('tB', 'sp_b0')), () => true);
  m.update(upd(2, tr('tA', 'sp_a1'), tr('tB', 'sp_b1')), () => true);
  assert.deepEqual(joins, ['sp_b0'], 'only the remembered train got a continuation');
  // a train with no span now starts afresh; so does a removed one
  joins.length = 0;
  m.update(upd(3, tr('tB', null)), () => true);
  m.update(upd(4, tr('tB', 'sp_b2')), () => true);
  assert.equal(joins.length, 0, 'drawn afresh after a gap in spans');
  m.update(upd(5, tr('tB', 'sp_b3')), () => true);
  assert.deepEqual(joins, ['sp_b2'], 'and remembered again from there');
  m.update({ serverTime: 6, upsert: [], remove: ['tB'] }, () => true);
  joins.length = 0;
  m.update(upd(7, tr('tB', 'sp_b4')), () => true);
  assert.equal(joins.length, 0, 'a removed train is forgotten');
  // a block the file refused is not remembered: the next line must still carry the continuation, with the same after
  const m2 = new LineMaker(body, () => body('sp_cccccccccc'), 10);
  m2.update(upd(1, tr('tC', 'sp_a0')), () => true);
  let refused = '', kept = '';
  m2.update(upd(2, tr('tC', 'sp_a1')), t => { refused = t; return false; });
  assert.match(refused, /"after":"sp_a0"/);
  m2.update(upd(3, tr('tC', 'sp_a1')), t => { kept = t; return true; });
  assert.match(kept, /"id":"sp_cccccccccc","after":"sp_a0","of":"sp_a1"/, 'written again, with the same after');
  m2.reset();
  assert.equal(m2.drawn.size, 0); assert.equal(m2.seen.size, 0);
  // a snapshot seeds the state
  const m3 = new LineMaker(body, () => body('sp_dddddddddd'), 10);
  m3.snapshot(JSON.stringify({ serverTime: 1, feedStale: false, trains: [JSON.parse(tr('tD', 'sp_a0')), JSON.parse(tr('tE', null))] }), 1, () => true);
  let out = '';
  m3.update(upd(2, tr('tD', 'sp_a1'), tr('tE', 'sp_e1')), t => { out = t; return true; });
  assert.match(out, /"after":"sp_a0","of":"sp_a1"/);
  assert.equal((out.match(/"after"/g) || []).length, 1, 'tE had no span in the snapshot');
});

test('RECORDER: /debug/record writes the same continuation lines as the rolling record', async () => {
  const rig = await startRig({ track: joinFake(), overrides: WIDE });
  try {
    const g = rig.app.graph, sb = rig.app.spans, [k1, k2] = threeChains(rig);
    rig.td([['CC', 'LA', '2K22', null, g.berth(k1)]]); await rig.settle(1300);
    const pending = new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: rig.port, path: '/map/v1/debug/record?secs=1', agent: false }, res => { let s = ''; res.on('data', d => { s += d; }); res.on('end', () => resolve(s.split('\n').filter(Boolean).map(l => JSON.parse(l)))); });
      r.on('error', reject); r.end();
    });
    await until(() => rig.app.debugTaps === 1, 2000, 'the tap');
    rig.td([['CA', 'LA', '2K22', g.berth(k1), g.berth(k2)]]);
    const lines = await pending;
    const c = lines.filter(l => l.event === 'span' && l.data.after);
    assert.equal(c.length, 1);
    assert.deepEqual([c[0].data.after, c[0].data.of], [sb.forBerth(k1).id, sb.forBerth(k2).id]);
  } finally { await rig.stop(); }
});
