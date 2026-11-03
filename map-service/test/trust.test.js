'use strict';

// TRUST activation matching, movements, cancellation and the derived journey, on constructed
// timetables whose answers are known (planted answers), plus abuse: nothing may throw.

const test = require('node:test');
const assert = require('node:assert/strict');
const { TrustState } = require('../src/trust');
const { derive } = require('../src/progress');
const { config } = require('./helpers');
const T = require('./trust-helpers');

const LA = () => T.sched({ uid: 'C00001', hc: '1H15', locs: T.LA_ROUTE });
const KENT = () => T.sched({ uid: 'K00002', hc: '1H15', locs: T.KENT_ROUTE, toc: 'SE' });
const ID_LA = T.trainId('1H15'), ID_KENT = T.trainId('1H15', '02', '87');

async function world(lines = [LA(), KENT()], { now = T.NOW, cfg = {} } = {}) {
  const cif = await T.buildIdx(lines, now);
  const clock = { now };
  const events = [];
  const ctx = T.ctxFor(cif);
  const trust = new TrustState({ config: { ...config().trust, ...cfg }, now: () => clock.now, context: () => ctx, onChange: (a, k) => events.push([a.id, k]) });
  const feed = (...msgs) => trust.onBody(JSON.stringify(msgs), clock.now);
  return { cif, ctx, trust, clock, feed, events };
}
const actLA = (id = ID_LA) => T.activation({ id, uid: 'C00001', originStanox: T.STANOX.LTLHMPT, depMs: T.at(9, 30) });
const actKent = (id = ID_KENT) => T.activation({ id, uid: 'K00002', originStanox: T.STANOX.ASHFKY, depMs: T.at(9, 20) });

test('activation: a TD headcode in an area the activation covers matches its EXACT schedule', async () => {
  const w = await world();
  w.feed(actLA());
  const m = w.trust.match('1H15', 'LA', T.NOW, w.ctx);
  assert.equal(m.rec.uid, 'C00001');
  assert.equal(m.act.id, ID_LA);
  assert.equal(m.tier, 0, 'origin STANOX is in the area: strongest evidence');
  assert.equal(w.trust.match('1H16', 'LA', T.NOW, w.ctx), null, 'another headcode');
  assert.equal(w.trust.match('1H15', 'ZZ', T.NOW, w.ctx), null, 'an area the schedule never touches');
});

test('DUPLICATE HEADCODES in two areas: each area gets its own activation, never the other', async () => {
  const w = await world();
  w.feed(actLA(), actKent());
  assert.equal(w.trust.match('1H15', 'LA', T.NOW, w.ctx).rec.uid, 'C00001');
  assert.equal(w.trust.match('1H15', 'A2', T.NOW, w.ctx).rec.uid, 'K00002');
  assert.equal(w.trust.match('1H15', 'ZZ', T.NOW, w.ctx), null);
});

test('the same headcode twice in one area on one day: the booked time decides; far from both is no match', async () => {
  const evening = T.sched({ uid: 'C00009', hc: '1H15', locs: [T.loc('LO', 'LTLHMPT', null, '1730'), T.loc('LI', 'STHWICK', '1741', '1742'), T.loc('LI', 'PSLDAWH', '1745', '1746'), T.loc('LT', 'VICTRIC', '1915')] });
  const w = await world([LA(), evening]);
  w.feed(actLA(), T.activation({ id: T.trainId('1H15', '02', '88'), uid: 'C00009', originStanox: T.STANOX.LTLHMPT, depMs: T.at(17, 30) }));
  assert.equal(w.trust.match('1H15', 'LA', T.at(9, 44), w.ctx).rec.uid, 'C00001');
  assert.equal(w.trust.match('1H15', 'LA', T.at(17, 40), w.ctx).rec.uid, 'C00009');
  assert.equal(w.trust.match('1H15', 'LA', T.at(13, 0), w.ctx), null, 'three hours from either');
});

test('two different services equally good: no match (a wrong destination is worse than none)', async () => {
  const twin = T.sched({ uid: 'C00007', hc: '1H15', locs: T.LA_ROUTE });
  const w = await world([LA(), twin]);
  w.feed(actLA(), T.activation({ id: T.trainId('1H15', '02', '89'), uid: 'C00007', originStanox: T.STANOX.LTLHMPT, depMs: T.at(9, 30) }));
  assert.equal(w.trust.match('1H15', 'LA', T.NOW, w.ctx), null);
});

test('LATE TD APPEARANCE: an activation sent long before keeps matching until its day ends', async () => {
  const w = await world();
  w.clock.now = T.at(2, 0);                                    // sent in the small hours
  w.feed(actLA());
  assert.equal(w.trust.match('1H15', 'LA', T.at(2, 0), w.ctx), null, 'seven hours early: the time window refuses');
  w.clock.now = T.at(9, 40);
  assert.equal(w.trust.match('1H15', 'LA', T.at(9, 40), w.ctx).rec.uid, 'C00001', 'the train appears in TD hours after its activation');
  w.clock.now = Date.UTC(2026, 10, 3, 5, 0);                   // next morning, past the expiry (04:00)
  w.trust.prune(w.clock.now);
  assert.equal(w.trust.size, 0, 'expired at the end of its day');
  assert.equal(w.trust.match('1H15', 'LA', T.NOW, w.ctx), null);
});

test('the activation arriving AFTER the train is in TD notifies, so the caller can re-match', async () => {
  const w = await world();
  w.feed(actLA());
  assert.deepEqual(w.events[0], [ID_LA, 'activation']);
});

test('RENUMBERED train: a change of identity moves the activation to its new headcode', async () => {
  const w = await world();
  w.feed(actLA());
  w.feed(T.changeIdentity({ id: ID_LA, revised: T.trainId('1H17', '02', '86') }));
  assert.equal(w.trust.match('1H15', 'LA', T.NOW, w.ctx), null, 'the old headcode no longer matches');
  const m = w.trust.match('1H17', 'LA', T.NOW, w.ctx);
  assert.equal(m.rec.uid, 'C00001');
  assert.equal(m.act.previousHc, '1H15');
  // A late movement under the OLD id still lands on the same train.
  w.feed(T.movement({ id: ID_LA, stanox: T.STANOX.STHWICK, evt: 'DEPARTURE', actual: T.at(9, 45), planned: T.at(9, 42), variation: 3 }));
  assert.equal(m.act.lateMins, 3);
  assert.deepEqual(w.events.filter(e => e[1] === 'identity').length, 1);
});

test('MOVEMENT: actual time, signed variation, platform; the train is late, and EARLY is negative', async () => {
  const w = await world();
  w.feed(actLA());
  w.feed(T.movement({ id: ID_LA, stanox: T.STANOX.STHWICK, evt: 'ARRIVAL', actual: T.at(9, 44, 10), planned: T.at(9, 41), variation: 3, platform: '2' }));
  const act = w.trust.acts.get(ID_LA);
  assert.equal(act.lateMins, 3);
  const d = derive(w.ctx, act.rec || w.trust.resolve(act, w.ctx), act, w.trust, T.NOW, T.DAYNUM);
  const sw = d.calls[1];
  assert.equal(sw.actualArr, '09:44');
  assert.equal(sw.variation, 3);
  assert.equal(sw.platformActual, '2');
  assert.equal(sw.actualDep, null);
  assert.equal(d.late, 3);
  // Early at the next point (a later report: the latest by actual time sets the train's lateness).
  w.feed(T.movement({ id: ID_LA, stanox: T.STANOX.PSLDAWH, evt: 'ARRIVAL', actual: T.at(9, 44, 30), planned: T.at(9, 46), variation: 2, status: 'EARLY' }));
  assert.equal(act.lateMins, -2);
  const d2 = derive(w.ctx, w.trust.resolve(act, w.ctx), act, w.trust, T.NOW, T.DAYNUM);
  assert.equal(d2.late, -2);
  assert.equal(d2.calls[2].variation, -2);
  // A report that arrives out of order (an earlier actual time) does not change the train's lateness.
  w.feed(T.movement({ id: ID_LA, stanox: T.STANOX.LTLHMPT, evt: 'DEPARTURE', actual: T.at(9, 30), planned: T.at(9, 30), variation: 0 }));
  assert.equal(act.lateMins, -2);
});

test('a re-sent (corrected) movement REPLACES the earlier one rather than adding a second', async () => {
  const w = await world();
  w.feed(actLA());
  const m = { id: ID_LA, stanox: T.STANOX.STHWICK, evt: 'DEPARTURE', actual: T.at(9, 45), planned: T.at(9, 42), variation: 3 };
  w.feed(T.movement(m));
  w.feed(T.movement({ ...m, actual: T.at(9, 44), variation: 2 }));
  const act = w.trust.acts.get(ID_LA);
  assert.equal(act.evN, 1);
  assert.equal(derive(w.ctx, w.trust.resolve(act, w.ctx), act, w.trust, T.NOW, T.DAYNUM).calls[1].actualDep, '09:44');
});

test('a pass report (a point with only a pass time) becomes actualPass, not a departure', async () => {
  const w = await world([KENT()]);
  w.feed(actKent());
  w.feed(T.movement({ id: ID_KENT, stanox: T.STANOX.HEADCRN, evt: 'DEPARTURE', actual: T.at(9, 51), planned: T.at(9, 50), variation: 1 }));
  const act = w.trust.acts.get(ID_KENT);
  const c = derive(w.ctx, w.trust.resolve(act, w.ctx), act, w.trust, T.NOW, T.DAYNUM).calls[2];
  assert.equal(c.actualPass, '09:51');
  assert.equal(c.actualDep, null);
});

test('CANCELLATION: calls after the cancellation point are cancelled; AT ORIGIN cancels all and stops matching; REINSTATEMENT lifts it', async () => {
  const w = await world();
  w.feed(actLA());
  const act = w.trust.acts.get(ID_LA);
  w.feed(T.movement({ id: ID_LA, stanox: T.STANOX.STHWICK, evt: 'ARRIVAL', actual: T.at(9, 41), planned: T.at(9, 41), variation: 0 }));
  w.feed(T.cancellation({ id: ID_LA, stanox: T.STANOX.STHWICK, type: 'ON CALL' }));
  let d = derive(w.ctx, w.trust.resolve(act, w.ctx), act, w.trust, T.NOW, T.DAYNUM);
  assert.deepEqual(d.calls.map(c => c.cancelled), [false, false, true, true]);
  assert.equal(d.next, null, 'nothing left to be next');
  w.feed(T.reinstatement({ id: ID_LA, stanox: T.STANOX.STHWICK }));
  d = derive(w.ctx, w.trust.resolve(act, w.ctx), act, w.trust, T.NOW, T.DAYNUM);
  assert.deepEqual(d.calls.map(c => c.cancelled), [false, false, false, false]);
  w.feed(T.cancellation({ id: ID_LA, stanox: T.STANOX.LTLHMPT, type: 'AT ORIGIN' }));
  d = derive(w.ctx, w.trust.resolve(act, w.ctx), act, w.trust, T.NOW, T.DAYNUM);
  assert.ok(d.calls.slice(2).every(c => c.cancelled));
  assert.equal(w.trust.match('1H15', 'LA', T.NOW, w.ctx), null, 'a train cancelled at origin is not in TD');
});

test('NEXT STATION: skips passes and cancelled calls, follows the last report, never earlier than now', async () => {
  const route = [T.loc('LO', 'LTLHMPT', null, '0930', null, '2'), T.loc('LI', 'STHWICK', '0941', '0942'), T.loc('LI', 'ALDTON', null, null, '0944'), T.loc('LI', 'PSLDAWH', '0945', '0946'), T.loc('LT', 'BRGHTN', '1000', null, null, '5')];
  const w = await world([T.sched({ uid: 'C00005', hc: '1H15', locs: route })]);
  w.feed(T.activation({ id: ID_LA, uid: 'C00005', originStanox: T.STANOX.LTLHMPT, depMs: T.at(9, 30) }));
  const act = w.trust.acts.get(ID_LA);
  const rec = w.trust.resolve(act, w.ctx);
  // Nothing reported, 09:35: the next call is Southwick; the pass at Aldrington is never "next".
  let d = derive(w.ctx, rec, act, w.trust, T.at(9, 35), T.DAYNUM);
  assert.equal(w.ctx.cif.tiplocAt(rec, d.next.index), 'STHWICK');
  assert.equal(d.next.time, '09:41'); assert.equal(d.next.exp, null, 'lateness unknown: no expected time');
  // Departed Southwick 3 min late: the next STATION is Portslade (Aldrington is a pass); expected = booked + 3.
  w.feed(T.movement({ id: ID_LA, stanox: T.STANOX.STHWICK, evt: 'DEPARTURE', actual: T.at(9, 45), planned: T.at(9, 42), variation: 3 }));
  d = derive(w.ctx, rec, act, w.trust, T.at(9, 43), T.DAYNUM);
  assert.equal(w.ctx.cif.tiplocAt(rec, d.next.index), 'PSLDAWH');
  assert.deepEqual([d.next.time, d.next.exp], ['09:45', '09:48']);
  // Never earlier than now: at 09:50 the booked-plus-lateness 09:48 has passed.
  d = derive(w.ctx, rec, act, w.trust, T.at(9, 50), T.DAYNUM);
  assert.equal(d.next.exp, '09:50');
  assert.equal(d.calls[3].expArr, '09:50'); assert.equal(d.calls[3].expDep, '09:50');
  assert.equal(d.calls[1].expDep, null, 'a point already left has no expected time');
  // A CANCELLED call is skipped too: change of origin at Portslade cancels Southwick, so with no report yet the next call is Portslade.
  const w2 = await world([T.sched({ uid: 'C00005', hc: '1H15', locs: route })]);
  w2.feed(T.activation({ id: ID_LA, uid: 'C00005', originStanox: T.STANOX.LTLHMPT, depMs: T.at(9, 30) }));
  const a2 = w2.trust.acts.get(ID_LA), r2 = w2.trust.resolve(a2, w2.ctx);
  assert.equal(w2.ctx.cif.tiplocAt(r2, derive(w2.ctx, r2, a2, w2.trust, T.at(9, 35), T.DAYNUM).next.index), 'STHWICK');
  w2.feed(T.changeOrigin({ id: ID_LA, stanox: T.STANOX.PSLDAWH }));
  const d2 = derive(w2.ctx, r2, a2, w2.trust, T.at(9, 35), T.DAYNUM);
  assert.deepEqual(d2.calls.map(c => c.cancelled), [true, true, true, false, false]);
  assert.equal(w2.ctx.cif.tiplocAt(r2, d2.next.index), 'PSLDAWH');
});

test('MOVEMENTS BEFORE THE ACTIVATION are kept briefly and applied when it arrives', async () => {
  const w2 = await world([T.sched({ uid: 'C00003', hc: '1H15', locs: T.LA_ROUTE.map(l => ({ ...l, tiploc_code: l.tiploc_code === 'STHWICK' ? 'ALDTON' : l.tiploc_code })) })]);
  // A movement at a STANOX the schedule does not visit cannot be inferred: orphaned, then replayed.
  w2.feed(T.movement({ id: ID_LA, stanox: T.STANOX.BRGHTN, evt: 'DEPARTURE', actual: T.at(9, 45), planned: T.at(9, 42), variation: 4 }));
  assert.equal(w2.trust.counts.movementsOrphaned, 1);
  w2.feed(T.activation({ id: ID_LA, uid: 'C00003', originStanox: T.STANOX.LTLHMPT, depMs: T.at(9, 30) }));
  assert.equal(w2.trust.acts.get(ID_LA).lateMins, 4);
  assert.equal(w2.trust.counts.orphansReplayed, 1);
});

test('AFTER A RESTART a movement for an unknown train is resolved against the timetable (inferred activation)', async () => {
  const w = await world([LA(), KENT()]);
  w.feed(T.movement({ id: ID_LA, stanox: T.STANOX.STHWICK, evt: 'DEPARTURE', actual: T.at(9, 45), planned: T.at(9, 42), variation: 3 }));
  const act = w.trust.acts.get(ID_LA);
  assert.ok(act && act.inferred, 'an activation was inferred');
  assert.equal(act.uid, 'C00001', 'the Sussex schedule, not the Kent one with the same headcode');
  assert.equal(act.lateMins, 3);
  assert.equal(w.trust.counts.inferred, 1);
  // A movement nothing can place is negatively cached, not retried every time.
  const unknown = T.trainId('9Z99');
  w.feed(T.movement({ id: unknown, stanox: T.STANOX.STHWICK, actual: T.at(9, 45), planned: T.at(9, 42), variation: 0 }));
  w.feed(T.movement({ id: unknown, stanox: T.STANOX.STHWICK, actual: T.at(9, 46), planned: T.at(9, 43), variation: 0 }));
  assert.equal(w.trust.counts.inferFailed, 1, 'the second attempt was skipped');
});

test('UNKNOWN message types and fields are COUNTED by name, never thrown on', async () => {
  const w = await world();
  w.feed({ header: { msg_type: '0004' }, body: { train_id: ID_LA } },
    { header: { msg_type: '0008' }, body: { train_id: ID_LA, loc_stanox: '86471' } },
    { header: { msg_type: '9999' }, body: {} },
    { header: {}, body: {} },
    { header: { msg_type: '0003' }, body: { loc_stanox: '86471', actual_timestamp: String(T.NOW), brand_new_field: 1 } },
    null, 7, 'text', [], { header: 5, body: 6 });
  const c = w.trust.counts;
  assert.equal(c.unknownTypes.toJSON()['0004'], 1);
  assert.equal(c.unknownTypes.toJSON()['9999'], 1);
  assert.equal(c.types.toJSON()['0008'], 1);
  assert.equal(c.unknownFields.toJSON()['0003.brand_new_field'], 1);
  assert.ok(c.badItems >= 4);
  assert.equal(c.errors, 0);
  // Bad bodies.
  for (const b of ['not json', '{"a":1}', '', null, undefined, 42, 'x'.repeat(5000000)]) w.trust.onBody(b, T.NOW);
  assert.ok(w.trust.counts.badBodies >= 6);
  assert.equal(w.trust.size, 0);
});

test('FUZZ: random garbage in every field of every message type never throws and never corrupts state', async () => {
  const w = await world();
  w.feed(actLA());
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const junk = [null, undefined, '', ' ', 'x', '0003', 0, -1, 1e20, NaN, true, false, [], {}, [1], { a: 1 }, 'F'.repeat(300), '86471', '9999999999999', '-5', 'LATE', 'true'];
  const types = ['0001', '0002', '0003', '0005', '0006', '0007', '0008', '0004', 'zzzz'];
  const fields = ['train_id', 'train_uid', 'loc_stanox', 'actual_timestamp', 'planned_timestamp', 'timetable_variation', 'variation_status', 'event_type', 'platform', 'canx_type', 'revised_train_id', 'current_train_id', 'tp_origin_stanox', 'tp_origin_timestamp', 'origin_dep_timestamp', 'train_terminated'];
  for (let i = 0; i < 4000; i++) {
    const body = {};
    for (const f of fields) if (rnd() < 0.5) body[f] = junk[Math.floor(rnd() * junk.length)];
    if (rnd() < 0.3) body.train_id = [ID_LA, ID_KENT, 'ABCDEFGHIJ'][Math.floor(rnd() * 3)];
    const msg = { header: { msg_type: types[Math.floor(rnd() * types.length)] }, body };
    assert.doesNotThrow(() => w.trust.onBody(JSON.stringify([msg]), T.NOW + Math.floor(rnd() * 1000)));
  }
  assert.equal(w.trust.counts.errors, 0);
  const m = w.trust.match('1H15', 'LA', T.NOW, w.ctx);
  assert.ok(m === null || m.rec.uid === 'C00001' || m.rec.uid === 'K00002');
});

test('BOUNDED: activations capped, orphans capped, finished trains dropped, per-train events capped', async () => {
  const w = await world([LA()], { cfg: { maxActivations: 40, maxOrphanTrains: 10, finishedKeepSecs: 600 } });
  for (let i = 0; i < 200; i++) w.feed(T.activation({ id: T.trainId(`1A${String(i % 100).padStart(2, '0')}`, '02', String(10 + Math.floor(i / 100))), uid: `C${String(i).padStart(5, '0')}`, originStanox: T.STANOX.LTLHMPT, depMs: T.at(9, 30) }));
  assert.ok(w.trust.size <= 40, `${w.trust.size} activations`);
  assert.equal(w.trust.counts.evicted, 160);
  for (let i = 0; i < 50; i++) w.feed(T.movement({ id: T.trainId(`2B${String(i).padStart(2, '0')}`), stanox: T.STANOX.BRGHTN, actual: T.at(9, 40), planned: T.at(9, 40) }));
  assert.ok(w.trust.orphans.size <= 10);
  // A finished train is dropped an hour after it terminated.
  const w2 = await world([LA()]);
  w2.feed(actLA());
  w2.feed(T.movement({ id: ID_LA, stanox: T.STANOX.PSLDAWH, evt: 'ARRIVAL', actual: T.at(9, 45), planned: T.at(9, 45), terminated: true }));
  w2.trust.prune(T.at(10, 0));
  assert.equal(w2.trust.size, 1, 'kept for the board');
  w2.trust.prune(T.at(11, 0));
  assert.equal(w2.trust.size, 0);
  // Events per train are capped.
  const w3 = await world([LA()]);
  w3.feed(actLA());
  for (let i = 0; i < 600; i++) w3.feed(T.movement({ id: ID_LA, stanox: 80000 + i, actual: T.at(9, 40), planned: T.at(9, 40) + i * 1000 }));
  assert.ok(w3.trust.acts.get(ID_LA).evN <= 400);
});

test('a movement with an absurd timestamp (a day and a half off) is counted and ignored', async () => {
  const w = await world();
  w.feed(actLA());
  w.feed(T.movement({ id: ID_LA, stanox: T.STANOX.STHWICK, actual: T.NOW - 40 * 3600000, planned: T.NOW }));
  assert.equal(w.trust.counts.movementsStale, 1);
  assert.equal(w.trust.acts.get(ID_LA).evN, 0);
});
