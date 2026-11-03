'use strict';

// VSTP: Create / Delete merged over the CIF by the same STP rules, parsed defensively.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { VstpOverlay, parseVstp } = require('../src/vstp');
const { tmpDir, rmrf } = require('./helpers');
const T = require('./trust-helpers');

const AREA_LA = T.ctxFor(null);
const ctx = { areaTiplocs: new Map([['LA', new Set(['LTLHMPT', 'STHWICK', 'PSLDAWH'])]]), namer: t => t, window: 45 };
const VLOCS = [T.vloc('LTLHMPT', { dep: '093000', platform: '2' }), T.vloc('STHWICK', { arr: '094100', dep: '094200' }), T.vloc('PSLDAWH', { arr: '094500', dep: '094600' }), T.vloc('VICTRIC', { arr: '111500' })];

async function world(cifLines = [T.sched({ uid: 'C00001', hc: '1H15', locs: T.LA_ROUTE })]) {
  const cif = await T.buildIdx(cifLines);
  const ov = new VstpOverlay({ now: () => T.NOW });
  cif.overlay = ov;
  return { cif, ov, send: m => ov.onBody(typeof m === 'string' ? m : JSON.stringify(m)) };
}
const matchUid = (cif, hc, now = T.NOW) => { const m = cif.match(hc, 'LA', now, ctx); return m ? m.rec.uid : null; };

test('a VSTP Create makes a service that did not exist: matched, named, with its platform', async () => {
  const w = await world();
  assert.equal(matchUid(w.cif, '1Z99'), null);
  w.send(T.vstpCreate({ uid: 'V12345', hc: '1Z99', locs: VLOCS }));
  assert.equal(matchUid(w.cif, '1Z99'), 'V12345');
  const m = w.cif.match('1Z99', 'LA', T.NOW, ctx);
  assert.deepEqual(w.cif.svc(m.rec, t => ({ LTLHMPT: 'Littlehampton', VICTRIC: 'London Victoria' }[t] || t)), { uid: 'V12345', toc: 'SN', o: 'Littlehampton', d: 'London Victoria', dep: '09:30', arr: '11:15', cat: 'XX', pwr: 'EMU', load: '', });
  const det = w.cif.detail(m.rec, t => t);
  assert.deepEqual(det.calls.map(c => [c.tiploc, c.arr, c.dep, c.platform]), [['LTLHMPT', null, '09:30', '2'], ['STHWICK', '09:41', '09:42', null], ['PSLDAWH', '09:45', '09:46', null], ['VICTRIC', '11:15', null, null]]);
  assert.equal(w.cif.find('V12345', T.DAYNUM).uid, 'V12345', 'findable by uid and day, as a TRUST activation does');
});

test('STP rules: a VSTP N beats the permanent CIF schedule of the same uid; C cancels; the other days are untouched', async () => {
  const w = await world();
  assert.equal(matchUid(w.cif, '1H15'), 'C00001');
  // New schedule, same uid, different headcode, today only: N outranks P.
  w.send(T.vstpCreate({ uid: 'C00001', hc: '1H88', stp: 'N', locs: VLOCS }));
  assert.equal(matchUid(w.cif, '1H88'), 'C00001');
  assert.equal(matchUid(w.cif, '1H15'), null, 'the permanent one is overridden today');
  assert.equal(w.cif.find('C00001', T.DAYNUM).hc, '1H88');
  // Tomorrow is untouched (the N runs on 2026-11-02 only).
  const tom = w.cif.days.find(d => d.dayNum === T.DAYNUM + 1);
  assert.equal(w.cif.recsFor(tom, '1H15').length, 1);
  assert.equal(w.cif.recsFor(tom, '1H88').length, 0);
  // A cancel (C) beats everything for that day.
  w.send(T.vstpCreate({ uid: 'C00001', hc: '', stp: 'C', locs: [] }));
  assert.equal(matchUid(w.cif, '1H88'), null);
  assert.equal(matchUid(w.cif, '1H15'), null);
  assert.equal(w.cif.find('C00001', T.DAYNUM), null);
});

test('an O (overlay) does NOT beat an N: the STP ranking is C > N > O > P', async () => {
  const w = await world();
  w.send(T.vstpCreate({ uid: 'V00001', hc: '1V01', stp: 'N', locs: VLOCS }));
  w.send(T.vstpCreate({ uid: 'V00001', hc: '1V02', stp: 'O', locs: VLOCS }));
  assert.equal(matchUid(w.cif, '1V01'), 'V00001');
  assert.equal(matchUid(w.cif, '1V02'), null);
});

test('a VSTP Delete removes it, and the CIF schedule it had overridden comes back', async () => {
  const w = await world();
  w.send(T.vstpCreate({ uid: 'C00001', hc: '1H88', stp: 'N', locs: VLOCS }));
  assert.equal(matchUid(w.cif, '1H15'), null);
  w.send(T.vstpDelete({ uid: 'C00001', stp: 'N' }));
  assert.equal(matchUid(w.cif, '1H88'), null);
  assert.equal(matchUid(w.cif, '1H15'), 'C00001', 'restored');
  assert.equal(w.ov.size, 0);
  assert.equal(w.ov.counts.deletedRecords, 1);
  // Deleting what is not there is counted, harmlessly.
  w.send(T.vstpDelete({ uid: 'NOPE00' }));
  assert.equal(w.ov.counts.deleteMisses, 1);
});

test('days-of-week and date range decide which days a VSTP schedule runs', async () => {
  const w = await world();
  w.send(T.vstpCreate({ uid: 'V00002', hc: '1V02', start: '2026-11-03', end: '2026-11-03', locs: VLOCS }));   // tomorrow only
  assert.equal(matchUid(w.cif, '1V02'), null, 'not today');
  assert.equal(w.cif.recsFor(w.cif.days.find(d => d.dayNum === T.DAYNUM + 1), '1V02').length, 1);
  w.send(T.vstpCreate({ uid: 'V00003', hc: '1V03', days: '0100000', locs: VLOCS }));     // Tuesdays only; today is Monday
  assert.equal(matchUid(w.cif, '1V03'), null);
});

test('a re-sent Create replaces the earlier one', async () => {
  const w = await world();
  w.send(T.vstpCreate({ uid: 'V00004', hc: '1V04', locs: VLOCS }));
  w.send(T.vstpCreate({ uid: 'V00004', hc: '1V05', locs: VLOCS }));
  assert.equal(w.ov.size, 1);
  assert.equal(matchUid(w.cif, '1V04'), null);
  assert.equal(matchUid(w.cif, '1V05'), 'V00004');
});

test('MALFORMED VSTP is counted and skipped: never a throw, never a half-made schedule', async () => {
  const w = await world();
  const good = T.vstpCreate({ uid: 'V00005', hc: '1V05', locs: VLOCS });
  const bads = [
    'not json', '{}', '[]', 'null', '42', '"x"',
    { VSTPCIFMsgV1: {} },
    { VSTPCIFMsgV1: { Schedule: { transaction_type: 'Frobnicate' } } },
    { VSTPCIFMsgV1: { Schedule: { transaction_type: 'Create' } } },
    JSON.parse(JSON.stringify(good), (k, v) => (k === 'schedule_start_date' ? 'tomorrow' : v)),
    JSON.parse(JSON.stringify(good), (k, v) => (k === 'signalling_id' ? '' : v)),
    JSON.parse(JSON.stringify(good), (k, v) => (k === 'schedule_location' ? [] : v)),
    JSON.parse(JSON.stringify(good), (k, v) => (k === 'schedule_location' ? [null, 7, 'x'] : v)),
    JSON.parse(JSON.stringify(good), (k, v) => (k === 'CIF_stp_indicator' ? 'Z' : v)),
    JSON.parse(JSON.stringify(good), (k, v) => (k === 'schedule_end_date' ? '2020-01-01' : v)),
    { VSTPCIFMsgV1: { Schedule: { transaction_type: 'Delete' } } }
  ];
  for (const b of bads) assert.doesNotThrow(() => w.send(b));
  assert.equal(w.ov.size, 0, 'nothing half-made was stored');
  assert.equal(w.ov.counts.badBodies, 1, 'only the non-JSON one is a bad body');
  assert.ok(Object.keys(w.ov.counts.bad.toJSON()).length >= 5, JSON.stringify(w.ov.counts.bad));
  w.send(good);
  assert.equal(w.ov.size, 1);
  // Unknown fields on a Schedule are counted by name.
  w.send(T.vstpCreate({ uid: 'V00006', hc: '1V06', locs: VLOCS, extraSchedule: { surprise_field: 1 } }));
  assert.equal(w.ov.counts.unknownFields.toJSON().surprise_field, 1);
});

test('a single schedule_location object (not an array) and HHMM times are accepted', async () => {
  const msg = T.vstpCreate({ uid: 'V00007', hc: '1V07', locs: VLOCS });
  msg.VSTPCIFMsgV1.Schedule.schedule_segment.schedule_location = VLOCS.map(l => ({ ...l, scheduled_arrival_time: l.scheduled_arrival_time.slice(0, 4), scheduled_departure_time: l.scheduled_departure_time.slice(0, 4) }));
  const p = parseVstp(msg);
  assert.equal(p.op, 'create');
  assert.deepEqual(p.spec.pts[1].slice(0, 3), ['STHWICK', 9 * 60 + 41, 9 * 60 + 42]);
});

test('times past midnight are unwrapped like the CIF index does', () => {
  const locs = [T.vloc('LTLHMPT', { dep: '235800' }), T.vloc('STHWICK', { arr: '000300', dep: '000400' }), T.vloc('PSLDAWH', { arr: '001000' })];
  const p = parseVstp(T.vstpCreate({ uid: 'V00008', hc: '1V08', locs }));
  assert.deepEqual(p.spec.pts.map(x => x[2] >= 0 ? x[2] : x[1]), [1438, 1444, 1450]);
});

test('BOUNDED: at most maxSchedules (the soonest-ending is evicted first), expired ones pruned', () => {
  const ov = new VstpOverlay({ maxSchedules: 20, now: () => T.NOW });
  for (let i = 0; i < 100; i++) ov.onBody(JSON.stringify(T.vstpCreate({ uid: `V${String(i).padStart(5, '0')}`, hc: '1V09', start: '2026-11-02', end: i % 2 ? '2026-11-02' : '2026-12-30', locs: VLOCS })));
  assert.equal(ov.size, 20);
  assert.ok(ov.counts.evicted >= 80);
  assert.ok(ov.recs.filter(r => r.end > T.DAYNUM + 10).length >= 10, 'the long-lived ones survive');
  const before = ov.size;
  const n = ov.prune(Date.UTC(2026, 11, 20));
  assert.equal(before - n, ov.recs.length);
  assert.ok(n > 0);
});

test('persistence: saved atomically, restored on start, malformed entries skipped', () => {
  const dir = tmpDir();
  try {
    const f = path.join(dir, 'state', 'vstp.json');
    const a = new VstpOverlay({ now: () => T.NOW });
    a.onBody(JSON.stringify(T.vstpCreate({ uid: 'V00010', hc: '1V10', locs: VLOCS })));
    assert.equal(a.saveFile(f), true);
    assert.equal(a.saveFile(f), false, 'nothing new to save');
    assert.ok(!fs.existsSync(f + '.tmp'));
    const b = new VstpOverlay({ now: () => T.NOW });
    assert.equal(b.loadFile(f), 1);
    assert.equal(b.recs[0].uid, 'V00010');
    assert.deepEqual(b.recs[0].spec.pts[0], a.recs[0].spec.pts[0]);
    fs.writeFileSync(f, JSON.stringify({ version: 1, schedules: [null, { uid: 'x' }, { uid: 'ok', stp: 'N', start: 1, end: 2, pts: [['A', 1, 2, -1, ''], ['B', 3, 4, -1, '']] }, { uid: 'bad', stp: 'Q', start: 1, end: 2, pts: [] }] }));
    const c = new VstpOverlay({ now: () => T.NOW });
    assert.equal(c.loadFile(f), 1);
    fs.writeFileSync(f, '{broken');
    assert.equal(new VstpOverlay().loadFile(f), -1);
    assert.equal(new VstpOverlay().loadFile(path.join(dir, 'absent.json')), 0);
  } finally { rmrf(dir); }
});
