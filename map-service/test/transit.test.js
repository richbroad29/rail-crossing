'use strict';

// Learned transit times (contract section 10) and the motion plan built on them (section 11).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { TransitStore, classOf, percentile } = require('../src/transit');
const { MotionPlanner } = require('../src/motion');
const { BerthGraph } = require('../src/berth-graph');
const { config, tmpDir, rmrf, getJson, until } = require('./helpers');
const { startRig, NOW } = require('./rig');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('class from the headcode: 1 express, 2 stopping, 5 ecs, 4/6/7/8 freight, the rest other', () => {
  assert.deepEqual(['1H15', '2K22', '5Z10', '4M23', '6V01', '7A00', '8X11', '0Z00', '3Q00', '9Z99', '', undefined].map(classOf),
    ['express', 'stopping', 'ecs', 'freight', 'freight', 'freight', 'freight', 'other', 'other', 'other', 'other', 'other']);
});

test('median, p10 and p90 of planted samples 1..100 (linear interpolation) and nothing below minSamples', () => {
  const s = new TransitStore({ minSamples: 5 });
  for (let v = 1; v <= 4; v++) s.add(7, 'express', 'passes', v);
  assert.equal(s.estimate(7, 'express', 'passes'), null, '4 samples: not enough yet');
  for (let v = 5; v <= 100; v++) s.add(7, 'express', 'passes', v);
  const e = s.estimate(7, 'express', 'passes');
  assert.equal(e.n, 100);
  close(e.median, 50.5); close(e.p10, 10.9); close(e.p90, 90.1);
  // Separate series per class and behaviour.
  assert.equal(s.estimate(7, 'stopping', 'passes'), null);
  assert.equal(s.estimate(7, 'express', 'calls'), null);
  assert.equal(s.estimate(8, 'express', 'passes'), null);
});

test('OUTLIERS over 30 minutes are excluded (a held train is not a transit); negatives and junk too', () => {
  const s = new TransitStore({ minSamples: 3, maxSeconds: 1800 });
  for (const v of [30, 31, 32, 33, 34]) s.add(1, 'stopping', 'passes', v);
  assert.equal(s.add(1, 'stopping', 'passes', 1801), false);
  assert.equal(s.add(1, 'stopping', 'passes', 90000), false);
  assert.equal(s.add(1, 'stopping', 'passes', -4), false);
  assert.equal(s.add(1, 'stopping', 'passes', NaN), false);
  assert.equal(s.add(1, 'stopping', 'passes', 1800), true, '30 minutes exactly is kept');
  assert.equal(s.stats.excluded, 4);
  const e = s.estimate(1, 'stopping', 'passes');
  assert.equal(e.n, 6);
  close(e.median, 32.5, 1e-9);
  assert.equal(s.add(-1, 'express', 'passes', 5), false);
  assert.equal(s.add(1, 'bogus', 'passes', 5), false);
});

test('BOUNDED: a ring of the last 200; the oldest samples fall out; entries are capped', () => {
  const s = new TransitStore({ ringSize: 200, minSamples: 5 });
  for (let v = 1; v <= 500; v++) s.add(3, 'express', 'passes', v);
  const e = s.estimate(3, 'express', 'passes');
  assert.equal(e.n, 200);
  close(e.median, 400.5);                          // samples 301..500
  assert.equal(s.samples(3, 'express', 'passes')[0], 301, 'chronological: the oldest kept is 301');
  assert.equal(s.samples(3, 'express', 'passes').at(-1), 500);
});

test('EVICTION (section 17.5): at the cap the LEAST RECENTLY UPDATED series goes, a new series is always kept, and reading changes nothing', () => {
  const cap = new TransitStore({ maxEntries: 50, minSamples: 1 });
  for (let k = 0; k < 50; k++) cap.add(k, 'express', 'passes', 10 + k);
  assert.equal(cap.size, 50);
  // Series 0 is the oldest; update it (it becomes the newest) and READ series 1 (it must not).
  cap.add(0, 'express', 'passes', 99);
  assert.ok(cap.estimate(1, 'express', 'passes'));
  for (let k = 50; k < 60; k++) assert.equal(cap.add(k, 'express', 'passes', 5), true, 'a new series is kept at the cap');
  assert.equal(cap.size, 50);
  assert.equal(cap.stats.evicted, 10);
  assert.deepEqual(cap.samples(0, 'express', 'passes'), [10, 99], 'the series updated most recently survived with its samples');
  for (let k = 1; k <= 10; k++) assert.deepEqual(cap.samples(k, 'express', 'passes'), [], `series ${k} was the least recently updated (a read does not count)`);
  assert.equal(cap.estimate(1, 'express', 'passes'), null);
  assert.deepEqual(cap.samples(11, 'express', 'passes'), [21]);
  assert.equal(cap.add(3, 'express', 'passes', 11), true, 'an evicted series simply starts again');
  assert.deepEqual(cap.samples(3, 'express', 'passes'), [11]);
  // A freed slot is reused: the memory does not grow with churn.
  const before = cap.bytes();
  for (let k = 1000; k < 3000; k++) cap.add(k, 'stopping', 'calls', 7);
  assert.ok(cap.bytes() <= before + 40 * 256 * 20, `bytes grew from ${before} to ${cap.bytes()} through 2000 evictions`);
  assert.equal(cap.size, 50);
});

test('COMPACT STORAGE: a series moves up 8 -> 32 -> 100 -> 200 samples without losing or reordering any, and the ring keeps the last 200', () => {
  const s = new TransitStore({ ringSize: 200, minSamples: 5 });
  const all = [];
  for (let v = 1; v <= 450; v++) {
    s.add(7, 'ecs', 'calls', v % 1800); all.push(v);
    if ([5, 8, 9, 32, 33, 100, 101, 199, 200, 201, 450].includes(v)) assert.deepEqual(s.samples(7, 'ecs', 'calls'), all.slice(-200), `after ${v} samples`);
  }
  assert.deepEqual(s.pools.map(p => p.live), [0, 0, 0, 1], 'the smaller slots were released as the series grew');
  assert.equal(s.estimate(7, 'ecs', 'calls').n, 200);
  // A small ring size: one pool, the ring from the start.
  const t = new TransitStore({ ringSize: 4, minSamples: 1 });
  for (let v = 1; v <= 10; v++) t.add(1, 'express', 'passes', v);
  assert.deepEqual(t.samples(1, 'express', 'passes'), [7, 8, 9, 10]);
  assert.equal(t.pools.length, 1);
  // The cost: a few samples take a small slot, not a typed array each.
  const c = new TransitStore();
  for (let k = 0; k < 20000; k++) for (let i = 0; i < 6; i++) c.add(k, 'express', 'passes', 30);
  assert.ok(c.bytes() / c.size < 130, `${c.bytes() / c.size} B per 6-sample series`);
});

test('percentile helper: interpolates, handles one and no values', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([7], 0.9), 7);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
});

test('passMedian: the best-sampled non-freight PASSING class', () => {
  const s = new TransitStore({ minSamples: 3 });
  for (let i = 0; i < 4; i++) s.add(1, 'express', 'passes', 20);
  for (let i = 0; i < 9; i++) s.add(1, 'stopping', 'passes', 40);
  for (let i = 0; i < 30; i++) s.add(1, 'freight', 'passes', 200);
  for (let i = 0; i < 30; i++) s.add(1, 'stopping', 'calls', 300);
  assert.equal(s.passMedian(1), 40);
  assert.equal(s.passMedian(2), null);
});

test('persistence: berth NAMES not ids; restored in order; bad entries skipped; atomic', () => {
  const dir = tmpDir();
  try {
    const g1 = new BerthGraph();
    const id = g1.keyId('LA', '0006');
    const a = new TransitStore({ minSamples: 3 });
    [10, 20, 30, 40].forEach(v => a.add(id, 'express', 'calls', v));
    const f = path.join(dir, 'state', 'transit.json');
    assert.equal(a.saveFile(f, g1), true);
    assert.equal(a.saveFile(f, g1), false);
    assert.ok(!fs.existsSync(f + '.tmp'));
    const g2 = new BerthGraph();
    g2.keyId('ZZ', '9999');                               // different ids in the new process
    const b = new TransitStore({ minSamples: 3 });
    assert.equal(b.loadFile(f, g2), 1);
    const id2 = g2.lookup('LA', '0006');
    assert.deepEqual(b.samples(id2, 'express', 'calls'), [10, 20, 30, 40]);
    assert.equal(b.estimate(id2, 'express', 'calls').median, 25);
    fs.writeFileSync(f, JSON.stringify({ version: 1, entries: [null, ['LA:0006', 'express', 'calls', 'x'], ['bad', 'express', 'calls', [1]], ['LA:0007', 'wat', 'calls', [1]], ['LA:0008', 'ecs', 'passes', [5, 'z', 6]]] }));
    const c = new TransitStore({ minSamples: 1 });
    assert.equal(c.loadFile(f, new BerthGraph()), 1);
    fs.writeFileSync(f, 'nonsense');
    assert.equal(new TransitStore().loadFile(f, new BerthGraph()), -1);
  } finally { rmrf(dir); }
});

test('PERSISTENCE ROUND TRIP (section 17.5): a full store saves one series per line and loads back sample for sample, with its recency order', () => {
  const dir = tmpDir();
  try {
    const g1 = new BerthGraph();
    const a = new TransitStore({ maxEntries: 40, minSamples: 3 });
    const ids = [];
    for (let i = 0; i < 70; i++) ids.push(g1.keyId('LA', String(1000 + i)));        // 70 berths, 40 series survive
    for (let i = 0; i < 70; i++) { const n = i % 7 === 0 ? 250 : (i % 5) + 3; for (let j = 0; j < n; j++) a.add(ids[i], i % 2 ? 'stopping' : 'express', i % 3 ? 'passes' : 'calls', (i * 7 + j) % 600); }
    a.add(ids[35], 'stopping', 'passes', 12);                                       // re-touch an old survivor: it is now the NEWEST
    assert.equal(a.size, 40);
    assert.ok(a.stats.evicted >= 30);
    const f = path.join(dir, 'transit.json');
    assert.equal(a.saveFile(f, g1), true);
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(text.split('\n').length >= 40, 'one series per line');
    assert.equal(JSON.parse(text).entries.length, 40, 'and it is still one valid JSON document');
    const g2 = new BerthGraph();
    for (let i = 0; i < 5; i++) g2.keyId('ZZ', String(9000 + i));                  // ids differ in the new process
    const b = new TransitStore({ maxEntries: 40, minSamples: 3 });
    assert.equal(b.loadFile(f, g2), 40);
    const live = [...a.map.keys()];
    for (const k of live) {
      const keyId = Math.floor(k / 16), r = k % 16, cls = ['express', 'stopping', 'ecs', 'freight', 'other'][r >> 1], beh = ['calls', 'passes'][r & 1];
      assert.deepEqual(b.samples(g2.lookup('LA', g1.berth(keyId)), cls, beh), a.samples(keyId, cls, beh), `berth ${g1.berth(keyId)}`);
    }
    assert.equal(b.dirty, false);
    assert.equal(b.estimate(g2.lookup('LA', g1.berth(ids[35])), 'stopping', 'passes') !== null, true);
    // Recency survived: loading into a SMALLER store keeps the newest series (the re-touched ids[35] last in the file, so it is kept).
    const c = new TransitStore({ maxEntries: 5, minSamples: 1 });
    assert.equal(c.loadFile(f, g2) >= 5, true);
    assert.equal(c.size, 5);
    assert.ok(c.samples(g2.lookup('LA', g1.berth(ids[35])), 'stopping', 'passes').length > 0, 'the newest series is among the 5 kept');
    // A one-line file (the layout before this one) still loads; a damaged line in the new layout is skipped, not fatal.
    fs.writeFileSync(f, JSON.stringify(a.serialize(g1)));
    const d = new TransitStore({ maxEntries: 40, minSamples: 3 });
    assert.equal(d.loadFile(f, g2), 40);
    const lines = text.split('\n'); lines[3] = '[garbage'; fs.writeFileSync(f, lines.join('\n'));
    const e = new TransitStore({ maxEntries: 40, minSamples: 3 });
    assert.equal(e.loadFile(f, g2), 39);
    fs.writeFileSync(f, '{"version":2}\n[1]\n');
    assert.equal(new TransitStore().loadFile(f, g2), -1);
  } finally { rmrf(dir); }
});

// ---- the learner, through the real model and service ---------------------------------------------------------------

test('LEARNING in the service: only a berth entered by a STEP is timed; calls vs passes comes from the matched schedule and the SMART station', async () => {
  const rig = await startRig();
  try {
    const g = rig.app.graph, tr = rig.app.transit;
    const t = (s, ...ev) => { rig.clock.now = NOW + s * 1000; rig.td(ev); };
    // 1H15 calls at Southwick (anchor: arrival berth 0006). Interposed INTO 0008, stepped to 0006 at +10 s, on to 0004 at +70 s.
    t(0, ['CC', 'LA', '1H15', null, '0008']);
    t(10, ['CA', 'LA', '1H15', '0008', '0006']);
    t(70, ['CA', 'LA', '1H15', '0006', '0004']);
    await rig.settle();
    const b0006 = g.lookup('LA', '0006'), b0008 = g.lookup('LA', '0008');
    assert.deepEqual(tr.samples(b0006, 'express', 'calls'), [60], 'Southwick: a call, 60 s in the berth');
    assert.deepEqual(tr.samples(b0008, 'express', 'calls'), [], 'interposed into 0008: its time in 0008 is partial, never sampled');
    assert.deepEqual(tr.samples(b0008, 'express', 'passes'), []);
    // An unmatched train through the same anchored berth: behaviour unknown, so no sample.
    t(100, ['CC', 'LA', '2K22', null, '0008']);
    t(110, ['CA', 'LA', '2K22', '0008', '0006']);
    t(150, ['CA', 'LA', '2K22', '0006', '0004']);
    await rig.settle();
    assert.deepEqual(tr.samples(b0006, 'stopping', 'calls'), []);
    assert.deepEqual(tr.samples(b0006, 'stopping', 'passes'), []);
    // An UNANCHORED berth (0003, between Aldrington and Portslade) is simply passed through, whatever the schedule says.
    t(200, ['CC', 'LA', '2K23', null, '0001']);
    t(210, ['CA', 'LA', '2K23', '0001', '0003']);
    t(225, ['CA', 'LA', '2K23', '0003', '0005']);
    await rig.settle();
    const b0003 = g.lookup('LA', '0003');
    assert.ok(!g.anchors.has(b0003), 'the fixture berth really is unanchored');
    assert.deepEqual(tr.samples(b0003, 'stopping', 'passes'), [15]);
  } finally { await rig.stop(); }
});

// ---- motion plans --------------------------------------------------------------------------------------------------------

function planner({ span = { id: 'sp_test', length: 600, stop: null }, info = { beh: 'passes', dwellSecs: null }, store = new TransitStore({ minSamples: 3 }) } = {}) {
  const spans = { forBerth: id => (id === 5 ? span : null) };
  return { store, p: new MotionPlanner({ spans, transit: store, berthInfo: () => info, config: config().motion }) };
}
const train = (over = {}) => ({ keyId: 5, hc: '1H15', at: 1_000_000, ...over });
const feed = (store, cls, beh, vals) => vals.forEach(v => store.add(5, cls, beh, v));

test('MOTION PLAN: t0 is the step time, eta = t0 + learned median, and no span means no plan', () => {
  const { store, p } = planner();
  feed(store, 'express', 'passes', [50, 60, 60, 60, 70]);
  const r = p.plan(train(), 1_000_500);                 // received half a second after the step
  assert.deepEqual(r.mv, { sp: 'sp_test', t0: 1_000_000, eta: 1_060_000, stop: null, dwell: null, held: false }, 't0 is the step time, not the receive time');
  assert.equal(p.plan(train({ keyId: 6 }), 1_000_000), null, 'a berth without a span keeps phase-1 lat/lon only');
});

test('HELD rule: now > eta + max(30 s, p90 - median); exactly at the threshold is not yet held', () => {
  // median 60, p90 70: spread 10 s < 30 s grace -> held after eta + 30 s.
  const a = planner(); feed(a.store, 'express', 'passes', [50, 60, 60, 60, 70]);
  const eta = 1_060_000;
  assert.equal(a.p.plan(train(), eta + 30_000).mv.held, false, 'exactly eta + 30 s');
  assert.equal(a.p.plan(train(), eta + 30_001).mv.held, true);
  assert.equal(a.p.plan(train(), eta + 30_001).heldAt, eta + 30_000);
  // A wide spread widens the grace: samples 0..100 -> median 50, p90 90: spread 40 s > 30.
  const b = planner(); feed(b.store, 'express', 'passes', Array.from({ length: 101 }, (_, i) => i));
  const etaB = 1_000_000 + 50_000;
  assert.equal(b.p.plan(train(), etaB + 40_000).mv.held, false);
  assert.equal(b.p.plan(train(), etaB + 40_001).mv.held, true);
  assert.equal(b.p.plan(train(), etaB + 31_000).mv.held, false, 'the 30 s floor alone would have called this held');
  // A step resets it: a new t0 gives a new eta.
  assert.equal(b.p.plan(train({ at: etaB + 100_000 }), etaB + 100_001).mv.held, false);
});

test('a train that CALLS: eta includes the dwell, from the "calls" median, or passes + booked dwell until that is learned; stop from the span', () => {
  const span = { id: 'sp_stn', length: 400, stop: 400 };
  const info = { beh: 'calls', dwellSecs: 120 };
  const a = planner({ span, info });
  feed(a.store, 'express', 'calls', [150, 150, 150, 150, 150]);
  let mv = a.p.plan(train(), 1_000_000).mv;
  assert.deepEqual([mv.eta, mv.stop, mv.dwell], [1_150_000, 400, 120]);
  const b = planner({ span, info });
  feed(b.store, 'express', 'passes', [30, 30, 30, 30, 30]);
  mv = b.p.plan(train(), 1_000_000).mv;
  assert.equal(mv.eta, 1_000_000 + (30 + 120) * 1000, 'learned passing time + booked dwell');
  const c = planner({ span, info });                  // nothing learned: span length over the class speed (30 m/s express) + dwell
  mv = c.p.plan(train(), 1_000_000).mv;
  assert.equal(mv.eta, 1_000_000 + Math.round((400 / 30 + 120) * 1000));
  // Not calling here: no stop, no dwell, even though the span has a stop point.
  const d = planner({ span, info: { beh: 'passes', dwellSecs: null } });
  mv = d.p.plan(train(), 1_000_000).mv;
  assert.deepEqual([mv.stop, mv.dwell], [null, null]);
});

test('the class of the train picks the series: a freight train does not borrow the express median', () => {
  const a = planner(); feed(a.store, 'express', 'passes', [10, 10, 10, 10, 10]); feed(a.store, 'freight', 'passes', [90, 90, 90, 90, 90]);
  assert.equal(a.p.plan(train({ hc: '1H15' }), 1_000_000).mv.eta, 1_010_000);
  assert.equal(a.p.plan(train({ hc: '6V01' }), 1_000_000).mv.eta, 1_090_000);
});

test('IN THE SERVICE: a berth with a span puts mv on the wire; held flips by itself when the clock passes it, as an update', async () => {
  const rig = await startRig();
  try {
    const g = rig.app.graph;
    rig.td([['CC', 'LA', '2K22', null, '0003']]);
    await rig.settle();
    const keyId = g.lookup('LA', '0003');
    // Plant a span provider and a learned median of 60 s for this berth, then re-issue the train.
    rig.app.spans = { step() {}, forBerth: id => (id === keyId ? { id: 'sp_planted', length: 500, stop: null } : null) };
    for (let i = 0; i < 6; i++) rig.app.transit.add(keyId, 'stopping', 'passes', 60);
    const t = [...rig.app.model.byId.values()].find(x => x.hc === '2K22');
    rig.app.model._touch(t);
    await rig.settle(1200);
    let train = (await getJson(rig.port, '/map/v1/trains')).json.trains.find(x => x.hc === '2K22');
    assert.deepEqual(Object.keys(train.mv).sort(), ['dwell', 'eta', 'held', 'sp', 'stop', 't0']);
    assert.deepEqual([train.mv.sp, train.mv.t0, train.mv.eta, train.mv.held], ['sp_planted', NOW, NOW + 60_000, false]);
    // Clock past eta + 30 s with no step: the service re-issues the train, held.
    rig.clock.now = NOW + 91_000;
    await rig.settle(1300);
    train = (await getJson(rig.port, '/map/v1/trains')).json.trains.find(x => x.hc === '2K22');
    assert.equal(train.mv.held, true);
    // A step into the next berth: a fresh plan (not held, new t0), or none if that berth has no span.
    rig.td([['CA', 'LA', '2K22', '0003', '0005']]);
    await rig.settle(1200);
    train = (await getJson(rig.port, '/map/v1/trains')).json.trains.find(x => x.hc === '2K22');
    assert.equal(train.mv, undefined, 'no span on the next berth: phase-1 lat/lon only');
  } finally { await rig.stop(); }
});

// ---- contract section 16: a departure berth starts standing -------------------------------------------------------------

test('SECTION 16: on a DEPARTURE berth a train that calls has stop 0 and dwell 0, never null; an arrival berth keeps the stop point and the booked dwell; a pass stays null', () => {
  const dep = { id: 'sp_dep', length: 600, stop: 0 }, arr = { id: 'sp_arr', length: 600, stop: 580 }, mid = { id: 'sp_mid', length: 600, stop: null };
  const calls = { beh: 'calls', dwellSecs: 90 }, passes = { beh: 'passes', dwellSecs: null };
  // departure berth, calling train: stop 0 / dwell 0 even though the booked dwell is 90 s (the train is ALREADY standing there) and even when no dwell is known
  for (const info of [calls, { beh: 'calls', dwellSecs: null }]) {
    const { p } = planner({ span: dep, info });
    const mv = p.plan(train(), 1_000_000).mv;
    assert.equal(mv.stop, 0); assert.equal(mv.dwell, 0);
    assert.ok(mv.stop !== null && mv.dwell !== null);
  }
  // arrival berth: the platform stop point, and the booked dwell
  const a = planner({ span: arr, info: calls }).p.plan(train(), 1_000_000).mv;
  assert.deepEqual([a.stop, a.dwell], [580, 90]);
  // a train that passes the departure berth at speed: null, null
  const pass = planner({ span: dep, info: passes }).p.plan(train(), 1_000_000).mv;
  assert.deepEqual([pass.stop, pass.dwell], [null, null]);
  const m = planner({ span: mid, info: passes }).p.plan(train(), 1_000_000).mv;
  assert.deepEqual([m.stop, m.dwell], [null, null]);
});

// ---- contract section 17.4: departures wait for their booked departure ----------------------------------------------------

test('SECTION 17.4: on a DEPARTURE berth dwell = seconds from t0 to the expected departure (never negative, at most 3600) and eta = t0 + dwell + the PASS run time; stop stays 0', () => {
  const dep = { id: 'sp_dep', length: 600, stop: 0 };
  const at = 1_000_000, plan = (departAt, extra = {}) => planner({ span: dep, info: { beh: 'calls', dwellSecs: 90, departAt }, ...extra }).p.plan(train(), at + 1000);
  // nothing learned: the run is span length over the class speed (express 30 m/s -> 20 s)
  let r = plan(at + 20 * 60_000);
  assert.deepEqual([r.mv.stop, r.mv.dwell, r.mv.eta, r.mv.held], [0, 1200, at + (1200 + 20) * 1000, false]);
  // a learned PASS median is the run (the 'calls' median includes the standing time, so it is NOT used on top of dwell)
  const learned = planner({ span: dep, info: { beh: 'calls', dwellSecs: 90, departAt: at + 600_000 } });
  feed(learned.store, 'express', 'passes', [40, 40, 40, 40, 40]); feed(learned.store, 'express', 'calls', [900, 900, 900, 900, 900]);
  r = learned.p.plan(train(), at + 1000);
  assert.deepEqual([r.mv.dwell, r.mv.eta], [600, at + (600 + 40) * 1000], 'dwell + pass run, not the 900 s calls median');
  // another class's pass median stands in when this class has none; freight's does not
  const other = planner({ span: dep, info: { beh: 'calls', dwellSecs: 90, departAt: at + 60_000 } });
  feed(other.store, 'stopping', 'passes', [50, 50, 50, 50, 50]);
  assert.equal(other.p.plan(train(), at).mv.eta, at + (60 + 50) * 1000);
  const frt = planner({ span: dep, info: { beh: 'calls', dwellSecs: 90, departAt: at + 60_000 } });
  feed(frt.store, 'freight', 'passes', [500, 500, 500, 500, 500]);
  assert.equal(frt.p.plan(train(), at).mv.eta, at + (60 + 20) * 1000, 'the fallback speed, not the freight median');
  // clamps: due already (or overdue) is 0, never negative; a very long wait is capped at an hour
  assert.equal(plan(at - 5 * 60_000).mv.dwell, 0);
  assert.equal(plan(at).mv.dwell, 0);
  assert.equal(plan(at + 5 * 3600_000).mv.dwell, 3600);
  assert.equal(plan(at + 5 * 3600_000).mv.eta, at + (3600 + 20) * 1000);
  // held: only once the departure AND the run are past by the grace (a train standing at the platform is not held)
  const p1 = planner({ span: dep, info: { beh: 'calls', dwellSecs: 90, departAt: at + 600_000 } }).p;
  assert.equal(p1.plan(train(), at + 500_000).mv.held, false, 'standing, 100 s before it is due');
  assert.equal(p1.plan(train(), at + 600_000 + 20_000 + 30_000).mv.held, false);
  const late = p1.plan(train(), at + 600_000 + 20_000 + 30_001);
  assert.equal(late.mv.held, true); assert.equal(late.heldAt, at + (600 + 20 + 30) * 1000);
  // the expected departure unknown (no booked departure): as before, dwell 0 and the learned calls median
  const old = planner({ span: dep, info: { beh: 'calls', dwellSecs: 90 } });
  feed(old.store, 'express', 'calls', [150, 150, 150, 150, 150]);
  assert.deepEqual([old.p.plan(train(), at).mv.dwell, old.p.plan(train(), at).mv.eta], [0, at + 150_000]);
  // a PASS on a departure berth and a call on an ARRIVAL berth ignore departAt
  assert.deepEqual([planner({ span: dep, info: { beh: 'passes', dwellSecs: null, departAt: at + 600_000 } }).p.plan(train(), at).mv.dwell], [null]);
  const arr = planner({ span: { id: 'sp_arr', length: 600, stop: 580 }, info: { beh: 'calls', dwellSecs: 90, departAt: at + 600_000 } }).p.plan(train(), at).mv;
  assert.deepEqual([arr.stop, arr.dwell], [580, 90]);
});

test('SECTION 17.4 in the service: departAt is the booked departure plus the TRUST lateness (only when the planner asks); dwell and eta ride the wire', async () => {
  const rig = await startRig();
  try {
    rig.clock.now = NOW - 5 * 60_000;                                    // 09:39: 1H15 is booked to leave Southwick at 09:42
    rig.td([['CC', 'LA', '1H15', null, '0006']]);
    await until(() => rig.app.model.byId.size === 1, 2000, 'the train');
    const key = rig.app.graph.lookup('LA', '0006');
    const tr = [...rig.app.model.byId.values()][0];
    const base = rig.app._berthInfo(tr, key, true);
    assert.equal(base.beh, 'calls');
    assert.equal(base.departAt, NOW - 2 * 60_000, 'booked 09:42, no TRUST yet');
    assert.equal(rig.app._berthInfo(tr, key).departAt, undefined, 'only the planner asks for it');
    tr.svc.act = { runDay: tr.svc.dayNum, lateMins: 4 };                 // TRUST says 4 minutes late
    assert.equal(rig.app._berthInfo(tr, key, true).departAt, NOW + 2 * 60_000);
    tr.svc.act = { runDay: tr.svc.dayNum, lateMins: -1 };
    assert.equal(rig.app._berthInfo(tr, key, true).departAt, NOW - 3 * 60_000, 'early is earlier');
    tr.svc.act = null;
    rig.app.spans = { step() {}, forBerth: id => (id === key ? { id: 'sp_depart', length: 500, stop: 0 } : null) };
    rig.app.model._touch(tr);
    await rig.settle(1300);
    const t = (await getJson(rig.port, '/map/v1/trains')).json.trains.find(x => x.hc === '1H15');
    assert.strictEqual(t.mv.stop, 0);
    assert.strictEqual(t.mv.dwell, 180, 'three minutes from the step to 09:42');
    assert.equal(t.mv.eta, Math.round(t.mv.t0 + (180 + 500 / 30) * 1000), 'eta is the dwell plus the run (span length over the express fallback speed)');
  } finally { await rig.stop(); }
});

test('SECTION 16 on the wire: a calling train on a departure berth is sent with mv.stop 0 and mv.dwell 0', async () => {
  const rig = await startRig();
  try {
    rig.td([['CC', 'LA', '1H15', null, '0006']]);                       // 1H15 calls at Southwick; 0006 is its berth
    await until(() => rig.app.model.byId.size === 1, 2000, 'the train');
    const key = rig.app.graph.lookup('LA', '0006');
    rig.app.spans = { step() {}, forBerth: id => (id === key ? { id: 'sp_depart', length: 500, stop: 0 } : null) };
    rig.app.model._touch([...rig.app.model.byId.values()][0]);
    await rig.settle(1300);
    const t = (await getJson(rig.port, '/map/v1/trains')).json.trains.find(x => x.hc === '1H15');
    assert.equal(t.svc.uid, 'C00001', 'matched, and it calls at Southwick');
    assert.strictEqual(t.mv.stop, 0); assert.strictEqual(t.mv.dwell, 0);
  } finally { await rig.stop(); }
});
