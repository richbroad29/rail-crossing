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
  const cap = new TransitStore({ maxEntries: 50 });
  for (let k = 0; k < 200; k++) cap.add(k, 'express', 'passes', 10);
  assert.equal(cap.size, 50);
  assert.equal(cap.stats.dropped, 150);
  assert.equal(cap.add(3, 'express', 'passes', 11), true, 'an existing series still takes samples at the cap');
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
