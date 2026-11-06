'use strict';

// Contract 19.1: a train is in a box when the page could DRAW it there. Its REACH box is the box of its signalled point, its current mv
// span and the span of the mv it last had on a different berth, padded; the bbox filters test that, not the signalled point. Each case
// is planted so the OLD rule (the signalled lat, lon in the box) gives the other answer.

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeModel, smartRows } = require('./helpers');
const { Snapshot } = require('../src/snapshot');
const { SseHub } = require('../src/sse');
const { inBbox, reachHits } = require('../src/geo');

const T0 = 1_000_000_000_000;
const ev = (type, area, descr, from, to, ts) => ({ type, area, descr, from, to, ts });
const PAD = 200;                                         // spans.reachPadM, the default

/**
 * A model with berths 0001, 0003 and 0005 placed, a planted motion plan per berth and a planted box per span id.
 * `plan[berth]` is a span id or absent (no mv); `box[id]` is [s, w, n, e].
 */
function world() {
  const w = makeModel({ now: () => T0 });
  const stations = { 1: { key: 'A', name: 'A', lat: 51.0, lon: -1.0, crs: 'AAA' }, 2: { key: 'B', name: 'B', lat: 51.1, lon: -0.9, crs: 'BBB' } };
  w.graph.loadSmart(smartRows([['LA', '0001', '0003', '1', 'B'], ['LA', '0003', '0005', '2', 'A']]), s => stations[s] || null);
  w.plan = {}; w.box = {};
  w.model.motion = { plan: t => { const sp = w.plan[w.graph.berth(t.keyId)]; return sp ? { mv: { sp, t0: t.at, eta: t.at + 60000, stop: null, dwell: null, held: false }, heldAt: Infinity, extendAt: null } : null; } };
  w.model.spanBox = id => w.box[id] || null;
  w.model.reachPadM = PAD;
  w.step = (from, to, ts) => w.model.apply(ev('CA', 'LA', '1H15', from, to, ts));
  w.train = () => [...w.model.byId.values()][0];
  w.reach = () => w.model.reachOf(w.train());
  return w;
}
/** The box the model makes from [s, w, n, e]: padded by PAD metres, in degrees of latitude and of longitude at the highest latitude. */
function padded([s, w, n, e]) { const dLat = PAD / 111195, dLon = dLat / Math.cos(Math.max(Math.abs(s), Math.abs(n)) * Math.PI / 180); return [s - dLat, w - dLon, n + dLat, e + dLon]; }
const near = (a, b, msg) => { assert.equal(a.length, 4, msg); a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-9, `${msg}: [${i}] ${v} vs ${b[i]}`)); };

test('19.1 reach box: a train without an mv is its signalled point, not padded; with an mv it is point + current span + previous span, padded', () => {
  const w = world();
  w.model.apply(ev('CC', 'LA', '1H15', null, '0001', T0));
  const t = w.train();
  assert.ok(t.placed);
  assert.deepEqual(w.reach(), [t.lat, t.lon, t.lat, t.lon], 'no mv: the point itself, exactly what the old rule tested');
  assert.equal(w.model.reachOf({ placed: false }), null, 'an unplaced train has no reach');

  // An mv on 0001 whose span runs 5 km north-east of the point: the box takes in the point AND the span, with the pad.
  w.plan['0001'] = 'spA'; w.box.spA = [t.lat + 0.01, t.lon + 0.02, t.lat + 0.05, t.lon + 0.06];
  w.model._touch(t);
  near(w.reach(), padded([t.lat, t.lon, t.lat + 0.05, t.lon + 0.06]), 'point + current span');

  // Step to 0003 (a different berth) with its own span: the span it was on is the previous one and is still in the box.
  w.plan['0003'] = 'spB'; w.box.spB = [t.lat + 0.1, t.lon + 0.1, t.lat + 0.12, t.lon + 0.13];
  w.step('0001', '0003', T0 + 5000);
  const here = w.train(), b = w.box;
  near(w.reach(), padded([Math.min(here.lat, b.spA[0], b.spB[0]), Math.min(here.lon, b.spA[1], b.spB[1]), Math.max(here.lat, b.spA[2], b.spB[2]), Math.max(here.lon, b.spA[3], b.spB[3])]), 'point + current + previous');
});

test('19.1 previous span: a same-berth re-issue does not change it; a step moves current into previous (one deep); losing the mv clears it', () => {
  const w = world();
  // Four spans far apart in latitude, so every combination has its own union box.
  const SPAN = { spA: [51.2, -1.3, 51.21, -1.29], spB: [51.3, -1.3, 51.31, -1.29], spB2: [51.4, -1.3, 51.41, -1.29], spC: [51.5, -1.3, 51.51, -1.29] };
  Object.assign(w.box, SPAN);
  /** The reach must be EXACTLY the padded union of the signalled point and these spans. */
  const is = (msg, ...ids) => {
    const t = w.train(), u = [t.lat, t.lon, t.lat, t.lon];
    for (const id of ids) { const b = SPAN[id]; u[0] = Math.min(u[0], b[0]); u[1] = Math.min(u[1], b[1]); u[2] = Math.max(u[2], b[2]); u[3] = Math.max(u[3], b[3]); }
    near(w.reach(), padded(u), msg);
  };
  w.model.apply(ev('CC', 'LA', '1H15', null, '0001', T0));
  w.plan['0001'] = 'spA'; w.model._touch(w.train());
  is('first mv: A only', 'spA');
  assert.equal(w.train().prevSp, null, 'the first mv has no previous');

  w.plan['0003'] = 'spB'; w.step('0001', '0003', T0 + 1000);
  is('after the step: current B, previous A', 'spA', 'spB');
  assert.equal(w.train().prevSp, 'spA');

  // The span of THIS berth is rebuilt (a re-issue on the same berth, 18.3, or a recut): current changes, previous stands.
  w.plan['0003'] = 'spB2'; w.model._touch(w.train());
  is('same berth: current B2, previous still A', 'spA', 'spB2');
  w.model._touch(w.train());
  is('and again', 'spA', 'spB2');
  assert.equal(w.train().prevSp, 'spA');

  // The train loses its mv (this berth no longer has a span): current AND previous are gone. It gets one again: no previous.
  delete w.plan['0003']; w.model._touch(w.train());
  const t = w.train();
  assert.deepEqual(w.reach(), [t.lat, t.lon, t.lat, t.lon], 'no mv: the point again');
  assert.deepEqual([t.mvSp, t.prevSp], [null, null]);
  w.plan['0003'] = 'spB2'; w.model._touch(t);
  is('a new mv after losing one has no previous: A was cleared', 'spB2');

  // A step on from there: previous is B2 and nothing older.
  w.plan['0005'] = 'spC'; w.step('0003', '0005', T0 + 9000);
  is('current C, previous B2', 'spB2', 'spC');
});

test('19.1 the change set keeps the OLD reach box, the one before the first change of the batch', () => {
  const w = world();
  w.box.spA = [51.2, -1.3, 51.21, -1.29];
  w.model.apply(ev('CC', 'LA', '1H15', null, '0001', T0));
  w.plan['0001'] = 'spA'; w.model._touch(w.train());
  const before = w.reach().slice();
  w.cs.take();
  w.plan['0003'] = 'spB'; w.box.spB = [51.6, -1.0, 51.61, -0.99];
  w.step('0001', '0003', T0 + 1000);
  w.step('0003', '0005', T0 + 2000);
  const id = w.train().id;
  assert.deepEqual(w.cs.take().get(id).obox, before, 'however many changes followed, the box clients last had');
  assert.notDeepEqual(w.reach(), before);
  // A train never sent before has no old box.
  w.model.apply(ev('CC', 'LA', '2K22', null, '0001', T0 + 3000));
  const fresh = [...w.model.byId.values()].find(t => t.hc === '2K22');
  assert.equal(w.cs.take().get(fresh.id).obox, null);
});

test('19.1 snapshot: a train signalled OUTSIDE the box but drawn across it is returned (the old rule drops it); a box nowhere near it is not', () => {
  const w = world();
  const snap = new Snapshot({ model: w.model, now: () => 5000 });
  w.model.apply(ev('CC', 'LA', '1H15', null, '0001', T0));
  const t = w.train();
  // The span runs 6 km north of the signalled point; the request is a small box 5 km north of it.
  w.plan['0001'] = 'spA'; w.box.spA = [t.lat + 0.001, t.lon, t.lat + 0.06, t.lon + 0.001];
  w.model._touch(t);
  snap.rebuild(false);
  const R = { s: t.lat + 0.045, w: t.lon - 0.01, n: t.lat + 0.055, e: t.lon + 0.01 };
  assert.equal(inBbox(t.lat, t.lon, R), false, 'the OLD rule: signalled point outside');
  const ids = box => JSON.parse(snap.body(box)).trains.map(x => x.id);
  assert.deepEqual(ids(R), [t.id], 'the new rule: its span crosses the box');
  assert.deepEqual(ids({ s: t.lat + 0.2, w: t.lon - 0.01, n: t.lat + 0.21, e: t.lon + 0.01 }), [], 'a box beyond the span and its pad');
  assert.equal(ids({ s: t.lat - 0.01, w: t.lon - 0.01, n: t.lat + 0.0005, e: t.lon + 0.01 }).length, 1, 'the signalled point is still in');
  // The pad: a box 150 m beyond the span's end is in, 400 m is not.
  const endLat = t.lat + 0.06, m = 1 / 111195;
  assert.equal(ids({ s: endLat + 150 * m, w: t.lon - 0.01, n: endLat + 1, e: t.lon + 0.01 }).length, 1, 'inside the 200 m pad');
  assert.equal(ids({ s: endLat + 400 * m, w: t.lon - 0.01, n: endLat + 1, e: t.lon + 0.01 }).length, 0, 'outside it');
  // After a step, the PREVIOUS span still counts: a box that touches only it is in.
  w.plan['0003'] = 'spB'; w.box.spB = [t.lat + 0.3, t.lon + 0.3, t.lat + 0.31, t.lon + 0.31];
  w.step('0001', '0003', T0 + 1000);
  snap.rebuild(false);
  assert.deepEqual(ids(R), [t.id], 'a box that only the previous span crosses');
  // No bbox at all is still everything.
  assert.equal(JSON.parse(snap.body(null)).trains.length, 1);
});

test('19.1 SSE updates: upsert when the reach starts to touch a box; remove when it stops, though the signalled point never was in it', () => {
  const w = world();
  const snap = new Snapshot({ model: w.model, now: () => 5000 });
  const hub = new SseHub({ model: w.model, snapshot: snap, config: { maxSseClients: 5, coarseBboxDeg2: 25, coarseIntervalSecs: 10, pingSecs: 20, sseMaxBufferBytes: 1e6 }, now: () => 1, mono: () => 1 });
  w.model.apply(ev('CC', 'LA', '1H15', null, '0001', T0));
  const t = w.train();
  const R = { s: t.lat + 0.045, w: t.lon - 0.01, n: t.lat + 0.055, e: t.lon + 0.01 };
  assert.deepEqual(hub._update(w.cs.take(), R), { upsert: [], remove: [] }, 'a train with no mv, not in the box');

  w.plan['0001'] = 'spA'; w.box.spA = [t.lat + 0.001, t.lon, t.lat + 0.06, t.lon + 0.001];       // a span arrives: the page now draws it across R
  w.model._touch(t);
  let u = hub._update(w.cs.take(), R);
  assert.equal(u.upsert.length, 1, 'upserted when its reach starts to touch the box');
  assert.deepEqual(u.remove, []);

  delete w.plan['0001']; w.model._touch(t);                                                        // the mv goes: it is drawn nowhere but its point
  u = hub._update(w.cs.take(), R);
  assert.deepEqual(u, { upsert: [], remove: [t.id] }, 'removed when its reach stops touching it');

  // A tap sees the same changes as a client with that box (what a recording would have got).
  const got = [];
  hub.addTap({ bbox: R, onUpdate: x => got.push(x) });
  w.plan['0001'] = 'spA'; w.model._touch(t);
  hub.flush(w.cs.take());
  assert.equal(got.length, 1);
  assert.equal(got[0].upsert.length, 1);
  // And a train that goes while its reach touches the box is removed from it.
  w.model._evict(t);
  hub.flush(w.cs.take());
  assert.deepEqual(got[1].remove, [t.id]);
});

test('19.1 reachHits: touching edges count; a failing box lookup never stops a train being served', () => {
  assert.ok(reachHits([1, 1, 2, 2], { s: 2, w: 2, n: 3, e: 3 }), 'a shared corner');
  assert.ok(!reachHits([1, 1, 2, 2], { s: 2.0001, w: 0, n: 3, e: 3 }));
  assert.ok(!reachHits([1, 1, 2, 2], { s: 0, w: 2.0001, n: 3, e: 3 }));
  assert.ok(reachHits([1, 1, 2, 2], { s: 0, w: 0, n: 3, e: 3 }), 'a box inside the request');
  assert.ok(reachHits([0, 0, 3, 3], { s: 1, w: 1, n: 2, e: 2 }), 'a request inside the box');
  const w = world();
  w.model.spanBox = () => { throw new Error('boom'); };
  w.model.apply(ev('CC', 'LA', '1H15', null, '0001', T0));
  w.plan['0001'] = 'spA'; w.model._touch(w.train());
  const r = w.reach(), t = w.train();
  near(r, padded([t.lat, t.lon, t.lat, t.lon]), 'the point, padded');
  assert.ok(w.model.trainJson(t).includes('"mv"'), 'and the train is still served with its mv');
});
