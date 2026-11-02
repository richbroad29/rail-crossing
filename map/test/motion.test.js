'use strict';
// The position function (glide) and the store that feeds the GPU buffers.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../motion.js');

const T = (id, lon, lat, extra) => Object.assign({ id, hc: '2A12', lat, lon, hdg: 90, area: 'LA', berth: '0004', at: 1, pl: 's' }, extra);
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, a + ' vs ' + b);

test('lerpAngle turns the short way round', () => {
  near(M.lerpAngle(350, 10, 0.5), 0);
  near(M.lerpAngle(10, 350, 0.5), 0);
  near(M.lerpAngle(90, 180, 0.5), 135);
  near(M.lerpAngle(0, 180, 0), 0);
  near(M.lerpAngle(300, 20, 1), 20);
  near(M.lerpAngle(20, 300, 1), 300);
});

test('the glide eases from the old position to the new over 1.5 s', () => {
  const s = M.createStore();
  s.applySnapshot([T('a', 0, 50)], 0);
  s.applyUpdate([T('a', 0.01, 50.01)], null, 1000);
  const r = s.get('a');
  const at = (t) => { M.glideModel.sample(r, t); return [r.cx, r.cy]; };
  assert.deepEqual(at(1000), [0, 50]);
  const mid = at(1750);
  near(mid[0], 0.005); near(mid[1], 50.005);                       // halfway in time = halfway in space
  const early = at(1300), late = at(2200);
  assert.ok(early[0] < 0.005 * (300 / 750), 'ease-in: slower than linear at the start');
  assert.ok(late[0] > 0.005 + 0.005 * (450 / 750), 'ease-out: ahead of linear near the end');
  assert.deepEqual(at(2500), [0.01, 50.01]);
  assert.deepEqual(at(99999), [0.01, 50.01]);
});

test('positions are monotonic along the glide', () => {
  const s = M.createStore();
  s.applySnapshot([T('a', 0, 50)], 0);
  s.applyUpdate([T('a', 1, 50)], null, 0);
  const r = s.get('a');
  let prev = -1;
  for (let t = 0; t <= 1500; t += 50) { M.glideModel.sample(r, t); assert.ok(r.cx >= prev); prev = r.cx; }
});

test('a new target mid-glide continues from where the train is drawn, never jumping back', () => {
  const s = M.createStore();
  s.applySnapshot([T('a', 0, 50)], 0);
  s.applyUpdate([T('a', 0.02, 50)], null, 0);
  const r = s.get('a');
  M.glideModel.sample(r, 750);
  const drawn = r.cx;
  s.applyUpdate([T('a', 0.03, 50)], null, 750);
  M.glideModel.sample(r, 750);
  near(r.cx, drawn);                                               // no jump at the moment of retarget
  M.glideModel.sample(r, 750 + 1500);
  near(r.cx, 0.03);
});

test('an unchanged position starts no new glide and does not restart an old one', () => {
  const s = M.createStore();
  s.applySnapshot([T('a', 0, 50)], 0);
  s.applyUpdate([T('a', 0.02, 50)], null, 0);
  const r = s.get('a'); const t0 = r.t0;
  s.applyUpdate([T('a', 0.02, 50, { at: 99 })], null, 700);       // same place, newer timestamp
  assert.equal(r.t0, t0);
  assert.equal(r.at, 99, 'other fields still update');
});

test('heading glides the short way and "no heading" stays without one', () => {
  const s = M.createStore();
  s.applySnapshot([T('a', 0, 50, { hdg: 350 })], 0);
  s.applyUpdate([T('a', 0, 50.01, { hdg: 10 })], null, 0);
  const r = s.get('a');
  M.glideModel.sample(r, 750);
  assert.ok(r.ch >= 355 || r.ch <= 5, 'passes through north, not through south: ' + r.ch);
  s.applyUpdate([T('a', 0, 50.02, { hdg: null })], null, 5000);
  M.glideModel.sample(r, 5750);
  assert.ok(Number.isNaN(r.ch));
});

test('reduced motion: no glide at all', () => {
  const s = M.createStore({ reducedMotion: () => true });
  s.applySnapshot([T('a', 0, 50)], 0);
  s.applyUpdate([T('a', 0.01, 50.01)], null, 100);
  const r = s.get('a');
  M.glideModel.sample(r, 100);
  assert.deepEqual([r.cx, r.cy], [0.01, 50.01]);
  assert.equal(s.isAnimating(100), false);
});

test('a train that appears is drawn where it is, with no glide from nowhere', () => {
  const s = M.createStore();
  s.applySnapshot([T('a', 0.5, 51)], 0);
  const r = s.get('a');
  M.glideModel.sample(r, 0);
  assert.deepEqual([r.cx, r.cy], [0.5, 51]);
  assert.equal(s.isAnimating(1), false);
});

test('a huge jump (different place) does not glide across the country', () => {
  const s = M.createStore();
  s.applySnapshot([T('a', 0, 50)], 0);
  s.applyUpdate([T('a', -4, 56)], null, 10);
  const r = s.get('a');
  M.glideModel.sample(r, 20);
  assert.deepEqual([r.cx, r.cy], [-4, 56]);
});

test('isAnimating is true only while a glide is running', () => {
  const s = M.createStore();
  s.applySnapshot([T('a', 0, 50)], 0);
  s.applyUpdate([T('a', 0.01, 50)], null, 1000);
  assert.equal(s.isAnimating(1500), true);
  assert.equal(s.isAnimating(2500), false);
});

test('a snapshot replaces the set; keep protects one id; updates add and remove', () => {
  const s = M.createStore();
  s.applySnapshot([T('a', 0, 50), T('b', 0, 51)], 0);
  s.applySnapshot([T('b', 0, 51), T('c', 0, 52)], 1, 'a');
  assert.deepEqual([...['a', 'b', 'c']].filter((i) => s.has(i)), ['a', 'b', 'c']);
  s.applySnapshot([T('c', 0, 52)], 2);
  assert.deepEqual([...['a', 'b', 'c']].filter((i) => s.has(i)), ['c']);
  s.applyUpdate([T('d', 1, 1)], ['c'], 3);
  assert.deepEqual([...['a', 'b', 'c', 'd']].filter((i) => s.has(i)), ['d']);
  assert.equal(s.size, 1);
});

test('malformed trains are skipped, not thrown on', () => {
  const s = M.createStore();
  s.applySnapshot([null, {}, { id: 'x' }, { id: 'y', lat: 'a', lon: 1 }, T('ok', 0, 50)], 0);
  assert.equal(s.size, 1);
});

test('class counts follow the headcodes', () => {
  const s = M.createStore();
  s.applySnapshot([T('a', 0, 50, { hc: '1A00' }), T('b', 0, 50, { hc: '2A00' }), T('c', 0, 50, { hc: '2B00' }),
    T('d', 0, 50, { hc: '6V00' }), T('e', 0, 50, { hc: '????' })], 0);
  const c = s.counts();
  assert.deepEqual([c.express, c.stopping, c.freight, c.other, c.total], [1, 2, 1, 1, 5]);
  s.applyUpdate([T('a', 0, 50, { hc: '5Z00' })], null, 1);      // renumbered
  assert.equal(s.counts().ecs, 1);
  assert.equal(s.counts().express, 0);
});

test('fill writes position, angle, colour and kind into the buffers', () => {
  const s = M.createStore();
  s.applySnapshot([
    T('solid', 1, 50, { hc: '1A00', hdg: 90, pl: 's' }),
    T('interp', 2, 51, { hc: '2A00', hdg: 180, pl: 'i' }),
    T('approx', 3, 52, { hc: '6A00', hdg: null, pl: 'a' })
  ], 0);
  const b = s.fill(0, null);
  assert.equal(b.n, 3);
  const row = (i) => ({ lon: b.pos[2 * i], lat: b.pos[2 * i + 1], ang: b.ang[i], kind: b.kind[i], rgb: [b.col[4 * i], b.col[4 * i + 1], b.col[4 * i + 2]], rec: b.order[i].id });
  const byId = {}; for (let i = 0; i < b.n; i++) byId[row(i).rec] = row(i);
  assert.equal(byId.solid.kind, 0);
  assert.equal(byId.solid.ang, -90, 'deck turns anticlockwise, headings run clockwise');
  assert.equal(byId.interp.kind, M.KIND_EST);
  assert.equal(byId.approx.kind, M.KIND_EST | M.KIND_APPROX | M.KIND_NODIR);
  assert.deepEqual(byId.solid.rgb, M.hexToRgb('#2f7cf6'));
  assert.deepEqual([byId.interp.lon, byId.interp.lat], [2, 51]);
  assert.equal(b.na, 1);
  assert.deepEqual([b.apos[0], b.apos[1]], [3, 52]);
});

test('hidden classes are left out, except the one being inspected', () => {
  const s = M.createStore();
  s.applySnapshot([T('a', 0, 50, { hc: '1A00' }), T('b', 0, 50, { hc: '2A00' })], 0);
  assert.equal(s.fill(0, { express: true }).n, 1);
  assert.equal(s.fill(0, { express: true }, 'a').n, 2);
  assert.equal(s.fill(0, { express: true, stopping: true }).n, 0);
});

test('the buffers handed out alternate, so the GPU sees a changed array each frame', () => {
  const s = M.createStore();
  s.applySnapshot([T('a', 0, 50)], 0);
  const b1 = s.fill(0, null), b2 = s.fill(0, null), b3 = s.fill(0, null);
  assert.notEqual(b1.pos, b2.pos);
  assert.equal(b1.pos, b3.pos);
});

test('the buffers grow for thousands of trains without losing any', () => {
  const s = M.createStore();
  const many = Array.from({ length: 5000 }, (_, i) => T('t' + i, i / 1000, 50 + i / 10000));
  s.applySnapshot(many, 0);
  const b = s.fill(0, null);
  assert.equal(b.n, 5000);
  const seen = new Set(); for (let i = 0; i < b.n; i++) seen.add(b.order[i].id);
  assert.equal(seen.size, 5000);
});

test('a filling frame allocates no per-train objects (buffers are reused)', () => {
  const s = M.createStore();
  s.applySnapshot(Array.from({ length: 2000 }, (_, i) => T('t' + i, i / 1000, 50)), 0);
  s.fill(0, null); s.fill(0, null);
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 200; i++) s.fill(i * 16, null);
  const grew = process.memoryUsage().heapUsed - before;
  assert.ok(grew < 4 * 1024 * 1024, '200 frames of 2,000 trains grew the heap by ' + grew + ' bytes');
});

test('trainSizePx is monotonic, bounded and readable at both ends', () => {
  let prev = 0;
  for (let z = 3; z <= 20; z += 0.25) { const v = M.trainSizePx(z); assert.ok(v >= prev); prev = v; }
  assert.ok(M.trainSizePx(5) >= 10);
  assert.ok(M.trainSizePx(18) <= 80);
  assert.equal(M.trainSizePx(1), M.trainSizePx(4));
  assert.equal(M.trainSizePx(30), M.trainSizePx(18));
});

test('a different motion model can be dropped in (phase 2 seam)', () => {
  const calls = [];
  const model = {
    retarget(rec, lon, lat, hdg, now) { calls.push('retarget'); rec.tx = lon; rec.ty = lat; rec.th = hdg; rec.t0 = now; rec.dur = 1; },
    sample(rec) { calls.push('sample'); rec.cx = 42; rec.cy = 43; rec.ch = 44; }
  };
  const s = M.createStore({ model });
  s.applySnapshot([T('a', 0, 50)], 0);
  s.applyUpdate([T('a', 1, 51)], null, 5);
  const b = s.fill(10, null);
  assert.deepEqual([b.pos[0], b.pos[1]], [42, 43]);
  assert.ok(calls.includes('retarget') && calls.includes('sample'));
});
