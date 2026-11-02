'use strict';

// TD aggregation and the simulated map-service state, against fixtures whose every count can be
// derived by hand. The point of "planted" numbers is that a miscount cannot hide behind a total
// that merely looks plausible.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TdStats, growthSummary, SAMPLE_CAP } = require('../lib/td-stats');

const START = Date.parse('2026-11-02T10:00:00.000Z');
const SEC = 1000, MIN = 60 * SEC;

// One TD wrapper, shaped as on the real feed: {"CA_MSG": {"time": "<ms>", "area_id": ..., ...}}.
const msg = (type, f = {}) => ({ [`${type}_MSG`]: { time: String(f.time !== undefined ? f.time : START), area_id: f.area || 'LA', msg_type: type, ...(f.descr !== undefined ? { descr: f.descr } : {}), ...(f.from !== undefined ? { from: f.from } : {}), ...(f.to !== undefined ? { to: f.to } : {}), ...(f.extra || {}) } });
const frame = (...events) => JSON.stringify(events);

test('counts frames, bytes, events by type and by area, distinct areas and descriptions', () => {
  const s = new TdStats({ startMs: START });
  const f1 = frame(
    msg('CA', { descr: '1H15', from: '0006', to: '0004' }),
    msg('CA', { descr: '1H15', from: '0004', to: '0002' }),
    msg('CT', { extra: { report_time: '1000' } })
  );
  const f2 = frame(
    msg('CC', { area: 'SB', descr: '2A01', to: '0100' }),
    msg('CB', { descr: '1H15', from: '0002' }),
    msg('SF', { area: 'BM', extra: { address: '01', data: '00' } }),
    msg('SF', { area: 'BM', extra: { address: '02', data: '00' } })
  );
  s.ingest(f1, START + 1000);
  s.ingest(f2, START + 2000);
  const r = s.summary(START + 10 * SEC);
  assert.equal(r.frames, 2);
  assert.equal(r.bytes, Buffer.byteLength(f1) + Buffer.byteLength(f2));
  assert.equal(r.events, 7);
  assert.deepEqual(r.eventsByType, { CA: 2, SF: 2, CB: 1, CC: 1, CT: 1 });
  assert.deepEqual(r.eventsPerArea, { LA: 4, BM: 2, SB: 1 });
  assert.equal(r.areas, 3);
  assert.equal(r.distinctDescriptions, 2);        // 1H15 (three times) and 2A01
  assert.equal(r.cclassEvents, 4);                // 2 CA + 1 CB + 1 CC
  assert.equal(r.parseErrors, 0);
  assert.equal(r.rates.eventsPerSecMean, 0.7);    // 7 events / 10 s
  assert.equal(r.rates.framesPerSecMean, 0.2);
});

test('the event type comes from msg_type, falling back to the wrapper key', () => {
  const s = new TdStats({ startMs: START });
  s.ingest(JSON.stringify([{ CA_MSG: { area_id: 'LA', descr: 'X', from: 'a', to: 'b' } }, { ZZ_MSG: { area_id: 'LA' } }]), START);
  assert.deepEqual(s.summary(START + SEC).eventsByType, { CA: 1, ZZ: 1 });
});

test('state: a step moves the description, a cancel removes it, an interpose writes it', () => {
  const s = new TdStats({ startMs: START });
  s.ingest(frame(msg('CC', { descr: '1H15', to: '0006', time: START })), START);
  assert.deepEqual([...s.occupancy.keys()], ['LA:0006']);
  s.ingest(frame(msg('CA', { descr: '1H15', from: '0006', to: '0004', time: START + 20 * SEC })), START + 20 * SEC);
  assert.deepEqual([...s.occupancy.keys()], ['LA:0004'], 'from berth is vacated, to berth is occupied');
  assert.equal(s.occupancy.get('LA:0004').descr, '1H15');
  s.ingest(frame(msg('CB', { descr: '1H15', from: '0004' })), START + 30 * SEC);
  assert.equal(s.occupancy.size, 0);
  // CB carries `from` only and CC `to` only (verified on the real feed): neither may need the other.
  s.ingest(frame(msg('CB', { from: '9999' })), START + 31 * SEC);   // cancel of an unknown berth is harmless
  assert.equal(s.stateEvents.CB, 2);
  assert.equal(s.stateEvents.skipped, 0);
});

test('state: berths are per area (the same berth id in two areas is two berths)', () => {
  const s = new TdStats({ startMs: START });
  s.ingest(frame(msg('CC', { area: 'LA', descr: '1A11', to: '0001' }), msg('CC', { area: 'SB', descr: '2B22', to: '0001' })), START);
  assert.deepEqual([...s.occupancy.keys()].sort(), ['LA:0001', 'SB:0001']);
});

test('edges count steps; step timing is how long the description sat in the berth it left', () => {
  const s = new TdStats({ startMs: START });
  s.ingest(frame(msg('CC', { descr: 'T1', to: 'A', time: START })), START);
  s.ingest(frame(msg('CA', { descr: 'T1', from: 'A', to: 'B', time: START + 30 * SEC })), START + 30 * SEC);   // 30 s in A
  s.ingest(frame(msg('CA', { descr: 'T1', from: 'B', to: 'C', time: START + 50 * SEC })), START + 50 * SEC);   // 20 s in B
  s.ingest(frame(msg('CC', { descr: 'T2', to: 'A', time: START + 60 * SEC })), START + 60 * SEC);
  s.ingest(frame(msg('CA', { descr: 'T2', from: 'A', to: 'B', time: START + 100 * SEC })), START + 100 * SEC); // 40 s in A
  assert.deepEqual([...s.edges.keys()], ['LA:A>B', 'LA:B>C']);
  assert.equal(s.edges.get('LA:A>B').n, 2);
  assert.deepEqual(s.edges.get('LA:A>B').s, [30, 40]);
  assert.deepEqual(s.edges.get('LA:B>C').s, [20]);
  assert.equal(s.sizes().samples, 3);
});

test('a step whose berth held a DIFFERENT description, or an unknown one, makes an edge but no timing', () => {
  const s = new TdStats({ startMs: START });
  s.ingest(frame(msg('CC', { descr: 'AAAA', to: 'A', time: START })), START);
  s.ingest(frame(msg('CA', { descr: 'BBBB', from: 'A', to: 'B', time: START + 10 * SEC })), START + 10 * SEC);
  s.ingest(frame(msg('CA', { descr: 'CCCC', from: 'X', to: 'Y', time: START + 20 * SEC })), START + 20 * SEC);
  assert.equal(s.edges.size, 2);
  assert.equal(s.sizes().samples, 0);
});

test('timings are not taken from a negative or an hour-plus gap', () => {
  const s = new TdStats({ startMs: START });
  s.ingest(frame(msg('CC', { descr: 'T1', to: 'A', time: START + 100 * SEC })), START);
  s.ingest(frame(msg('CA', { descr: 'T1', from: 'A', to: 'B', time: START + 50 * SEC })), START);   // clock went backwards
  s.ingest(frame(msg('CC', { descr: 'T2', to: 'C', time: START })), START);
  s.ingest(frame(msg('CA', { descr: 'T2', from: 'C', to: 'D', time: START + 3601 * SEC })), START);
  assert.equal(s.sizes().samples, 0);
  assert.equal(s.edges.size, 2);
});

test('the sample ring is capped per edge; the step count keeps counting', () => {
  const s = new TdStats({ startMs: START, sampleCap: 5 });
  for (let i = 0; i < 25; i++) {
    const t = START + i * 100 * SEC;
    s.ingest(frame(msg('CC', { descr: `T${i}`, to: 'A', time: t })), t);
    s.ingest(frame(msg('CA', { descr: `T${i}`, from: 'A', to: 'B', time: t + 10 * SEC })), t);
  }
  const e = s.edges.get('LA:A>B');
  assert.equal(e.n, 25);
  assert.equal(e.s.length, 5);
  assert.equal(s.sizes().samples, 5);
  assert.equal(SAMPLE_CAP, 20, 'the default cap the memory projection is based on');
});

test('hard limits stop any structure growing without end, and say so', () => {
  const s = new TdStats({ startMs: START, limits: { edges: 2, occupancy: 3, descriptions: 2 } });
  for (let i = 0; i < 6; i++) s.ingest(frame(msg('CA', { descr: `D${i}`, from: `F${i}`, to: `T${i}` })), START);
  const sz = s.sizes();
  assert.equal(sz.edges, 2);
  assert.ok(sz.occupancy <= 3);
  assert.equal(sz.descriptions, 2);
  const lim = s.summary(START + SEC).state.limitHits;
  assert.equal(lim.edges, 4);
  assert.ok(lim.occupancy > 0);
  assert.equal(lim.descriptions, 4);
});

test('bad input is counted, never thrown', () => {
  const s = new TdStats({ startMs: START });
  s.ingest('this is not json', START);
  s.ingest('{"not":"an array"}', START);
  s.ingest('"a string"', START);
  s.ingest('null', START);
  s.ingest(JSON.stringify([null, 5, [], 'x', { CA_MSG: null }, { CA_MSG: 'str' }, { CA_MSG: { area_id: 'LA' } }]), START);
  const r = s.summary(START + SEC);
  assert.equal(r.frames, 5);
  assert.equal(r.parseErrors, 1);
  assert.equal(r.nonArrayFrames, 3);        // object, string, null
  assert.equal(r.malformedItems, 4);        // null, 5, [], 'x'
  assert.equal(r.events, 3);                // the three CA_MSG wrappers, even though two carry junk
  assert.equal(r.eventsWithoutArea, 2);
  assert.equal(r.state.events.skipped, 1);  // the LA one has no from/to/descr
});

test('a message without a usable `time` falls back to when it arrived', () => {
  const s = new TdStats({ startMs: START });
  // time 0 (not a real epoch) and 'junk' (not a number) both fall back to the receive time.
  s.ingest(frame(msg('CC', { descr: 'T1', to: 'A', time: 0 })), START + 5 * SEC);
  s.ingest(frame(msg('CA', { descr: 'T1', from: 'A', to: 'B', time: 'junk' })), START + 12 * SEC);
  assert.deepEqual(s.edges.get('LA:A>B').s, [7]);
  // ...and a real one is used as given, even if it disagrees with when the frame arrived.
  s.ingest(frame(msg('CC', { descr: 'T2', to: 'A', time: START + 100 * SEC })), START + 200 * SEC);
  s.ingest(frame(msg('CA', { descr: 'T2', from: 'A', to: 'B', time: START + 130 * SEC })), START + 201 * SEC);
  assert.deepEqual(s.edges.get('LA:A>B').s, [7, 30]);
});

// ---- the series, peaks and gaps -----------------------------------------------------------------

test('per-minute series and the peak minute, with planted counts', () => {
  const s = new TdStats({ startMs: START });
  const ct = n => frame(...Array.from({ length: n }, () => msg('CT')));
  s.ingest(ct(10), START + 5 * SEC);               // minute 0: 10 events, 1 frame
  s.ingest(ct(20), START + 70 * SEC);              // minute 1: 30 events, 2 frames
  s.ingest(ct(10), START + 100 * SEC);
  s.ingest(ct(5), START + 130 * SEC);              // minute 2: 5 events
  const r = s.summary(START + 3 * MIN);            // run ends exactly at the end of minute 2
  const rows = s.series(START + 3 * MIN);
  assert.deepEqual(rows.map(x => x.events), [10, 30, 5]);
  assert.deepEqual(rows.map(x => x.frames), [1, 2, 1]);
  assert.equal(r.peakBucket.events, 30);
  assert.equal(r.peakBucket.eventsPerSec, 0.5);
  assert.equal(r.peakBucket.startedAt, new Date(START + MIN).toISOString());
  assert.equal(r.rates.eventsPerSecMean, 0.25);    // 45 events over 180 s
});

test('a quiet gap shows as empty buckets, not a hole', () => {
  const s = new TdStats({ startMs: START });
  s.ingest(frame(msg('CT')), START + SEC);
  s.ingest(frame(msg('CT')), START + 3 * MIN + SEC);
  const rows = s.series(START + 4 * MIN);
  assert.deepEqual(rows.map(x => x.events), [1, 0, 0, 1]);
  assert.equal(s.summary(START + 4 * MIN).maxGapSecs, 180);
});

test('a feed that goes quiet at the end shows as trailing zero buckets, and says how long it had been quiet', () => {
  const s = new TdStats({ startMs: START });
  s.ingest(frame(msg('CT'), msg('CT')), START + 5 * SEC);
  const r = s.summary(START + 3 * MIN + 30 * SEC);          // ran 3.5 minutes; last frame at 5 s
  const rows = s.series(START + 3 * MIN + 30 * SEC);
  assert.deepEqual(rows.map(x => x.events), [2, 0, 0, 0]);
  assert.equal(rows[3].seconds, 30, 'the last bucket is the partial one');
  assert.equal(r.trailingQuietSecs, 205);
  assert.equal(r.peakBucket.events, 2, 'the busy minute is still the peak');
  // Calling it twice changes nothing.
  assert.deepEqual(s.series(START + 3 * MIN + 30 * SEC).map(x => x.events), [2, 0, 0, 0]);
  // A run that never saw a frame has no series and no quiet time to report.
  const none = new TdStats({ startMs: START });
  assert.deepEqual(none.series(START + MIN), []);
  assert.equal(none.summary(START + MIN).trailingQuietSecs, null);
});

test('end-of-run bookkeeping a few ms past a bucket boundary does not add a bogus "0 s" bucket', () => {
  const s = new TdStats({ startMs: START });
  s.ingest(frame(msg('CT')), START + 5 * SEC);
  // A 60 s measurement whose end was stamped 10 ms late (the DISCONNECT handshake): still ONE bucket.
  assert.equal(s.series(START + MIN + 10).length, 1);
  assert.equal(s.series(START + MIN + 999).length, 1, 'under a second of tail is a sliver');
  // A second or more of genuine tail is a real (partial) bucket.
  const rows = s.series(START + MIN + 1000);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].seconds, 1);
  // The sliver rule scales down for the tiny buckets the tests use (40 ms of a 400 ms bucket).
  const t = new TdStats({ startMs: START, bucketMs: 400 });
  t.ingest(frame(msg('CT')), START + 10);
  assert.equal(t.series(START + 1210).length, 3, '1210 ms in 400 ms buckets: 10 ms tail is a sliver');
  assert.equal(t.series(START + 1240).length, 4, '40 ms is not');
});

test('a final partial bucket does not become the "peak minute"', () => {
  const s = new TdStats({ startMs: START });
  s.ingest(frame(msg('CT'), msg('CT')), START + 10 * SEC);             // minute 0: 2 events
  const burst = frame(...Array.from({ length: 50 }, () => msg('CT')));
  s.ingest(burst, START + 61 * SEC);                                    // partial minute 1, run ends 2 s in
  const r = s.summary(START + 62 * SEC);
  assert.equal(r.peakBucket.events, 2, 'the complete minute wins');
});

test('a run shorter than one bucket still reports a peak (the partial bucket is all there is)', () => {
  const s = new TdStats({ startMs: START });
  s.ingest(frame(msg('CT'), msg('CT')), START + 1 * SEC);
  const r = s.summary(START + 4 * SEC);
  assert.equal(r.peakBucket.events, 2);
  assert.equal(r.peakBucket.seconds, 4);
  assert.equal(r.peakBucket.eventsPerSec, 0.5);
});

test('the busiest second, by wall-clock second', () => {
  const s = new TdStats({ startMs: START });
  s.ingest(frame(msg('CT'), msg('CT'), msg('CT')), START + 1100);        // second +1: 3 events
  s.ingest(frame(msg('CT'), msg('CT'), msg('CT'), msg('CT')), START + 1900); // second +1: 4 more -> 7 in 2 frames
  s.ingest(frame(msg('CT')), START + 2100);                               // second +2: 1
  const r = s.summary(START + 5 * SEC);
  assert.deepEqual(r.peakSecond, { at: new Date(START + SEC).toISOString(), events: 7, frames: 2 });
});

test('frames with NO events still give a peak (zero), never null — a null once crashed the verdict', () => {
  const s = new TdStats({ startMs: START });
  s.ingest('[]', START + 1000);
  s.ingest('[]', START + 3500);
  s.ingest('garbage', START + 3600);
  const r = s.summary(START + 10 * SEC);
  assert.equal(r.frames, 3);
  assert.equal(r.events, 0);
  assert.deepEqual(r.peakSecond, { at: new Date(START + SEC).toISOString(), events: 0, frames: 1 });
  assert.equal(r.peakBucket.events, 0);
  assert.equal(r.rates.eventsPerSecMean, 0);
});

test('state sizes are recorded per bucket, so "is it still growing" can be answered', () => {
  const s = new TdStats({ startMs: START });
  let n = 0;
  const step = at => { n++; s.ingest(frame(msg('CA', { descr: `D${n}`, from: `F${n}`, to: `T${n}` })), at); };
  step(START + SEC); step(START + 2 * SEC);                 // 2 edges in minute 0
  step(START + MIN + SEC);                                  // 3 by the end of minute 1
  const rows = s.series(START + 2 * MIN);
  assert.deepEqual(rows.map(r => r.edges), [2, 3]);
  assert.equal(rows[1].occupancy, 3);
});

test('growthSummary: still growing vs plateaued vs not enough data', () => {
  const rows = edges => edges.map((e, i) => ({ bucket: i, edges: e }));
  const growing = growthSummary(rows([100, 150, 200, 250, 300, 330]));
  assert.equal(growing.enough, true);
  assert.deepEqual([growing.edgesAtThird, growing.edgesAtTwoThirds, growing.edgesAtEnd], [150, 250, 330]);
  assert.equal(growing.lastThirdGrowthPct, 24.24);
  assert.equal(growing.stillGrowing, true);
  const flat = growthSummary(rows([100, 200, 300, 300, 300, 300]));
  assert.equal(flat.lastThirdGrowthPct, 0);
  assert.equal(flat.stillGrowing, false);
  assert.equal(growthSummary(rows([1, 2])).enough, false);
  assert.equal(growthSummary(rows([100, 200, 300, 300, 300, 305])).stillGrowing, false, '1.6% is below the 2% line');
  assert.equal(growthSummary(rows([100, 200, 300, 300, 300, 307])).stillGrowing, true, '2.28% is above it');
});

test('the summary measures its own cost per frame', () => {
  const s = new TdStats({ startMs: START });
  for (let i = 0; i < 50; i++) s.ingest(frame(msg('CT')), START + i);
  const r = s.summary(START + SEC);
  assert.ok(r.ingestMsTotal > 0);
  assert.ok(r.ingestUsPerFrame > 0);
});
