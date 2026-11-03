'use strict';

// The streamed CIF index and the phase-1 service match, on small constructed timetables whose
// answers are known, including midnight and STP overlay / cancel.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { buildCifIndex, targetDays } = require('../src/cif-index');
const { london, dayNumOf } = require('../src/time');
const { tmpDir, rmrf } = require('./helpers');

const MON = '2026-11-02';                     // a Monday, GMT (London = UTC)
const at = (date, hh, mm) => { const [y, m, d] = date.split('-').map(Number); return Date.UTC(y, m - 1, d, hh, mm); };
const loc = (type, tiploc, arr, dep, pass, platform) => ({ location_type: type, tiploc_code: tiploc, ...(arr ? { arrival: arr } : {}), ...(dep ? { departure: dep } : {}), ...(pass ? { pass } : {}), ...(platform ? { platform } : {}) });

function sched({ uid = 'C00001', stp = 'P', hc = '1H15', start = '2026-05-17', end = '2026-12-12', days = '1111111', toc = 'SN', cat = 'OO', pwr = 'EMU', load = '377', speed = '075', status = 'P', locs, tx = 'Create' }) {
  return JSON.stringify({ JsonScheduleV1: {
    CIF_train_uid: uid, CIF_stp_indicator: stp, transaction_type: tx, atoc_code: toc, schedule_days_runs: days, schedule_start_date: start, schedule_end_date: end, train_status: status,
    schedule_segment: locs ? { signalling_id: hc, CIF_train_category: cat, CIF_power_type: pwr, CIF_timing_load: load, CIF_speed: speed, schedule_location: locs } : undefined
  } });
}

function writeCif(dir, lines, { gz = true } = {}) {
  const f = path.join(dir, gz ? 'cif.json.gz' : 'cif.json');
  const text = ['{"JsonTimetableV1":{"classification":"public"}}', ...lines].join('\n') + '\n';
  fs.writeFileSync(f, gz ? zlib.gzipSync(text) : text);
  return f;
}

const AREA = new Map([['LA', new Set(['PSLDAWH', 'STHWICK'])]]);
const names = { LITTLEH: 'Littlehampton', PSLDAWH: 'Portslade', VICTRIC: 'London Victoria', MIDNGHT: 'Midnight Jn' };
const ctx = { areaTiplocs: AREA, namer: t => names[t] || t };

const eastbound = (over = {}) => sched({
  locs: [loc('LO', 'LITTLEH', null, '0930', null, '2'), loc('LI', 'STHWICK', '0941', '0942', null, '1'), loc('LI', 'PSLDAWH', '0945', '0946', null, '2'), loc('LT', 'VICTRIC', '1115', null, null, '14')], ...over
});

async function build(lines, nowMs, opts) {
  const dir = tmpDir();
  try {
    const f = writeCif(dir, lines, opts);
    return await buildCifIndex(f, { dayNums: targetDays(nowMs) });
  } finally { rmrf(dir); }
}

test('indexes a schedule and matches it: same headcode, passes a timing point in the train\'s TD area, within 45 min', async () => {
  const now = at(MON, 9, 44);
  const idx = await build([eastbound()], now);
  assert.equal(idx.schedules, 1);
  const m = idx.match('1H15', 'LA', now, ctx);
  assert.ok(m);
  assert.deepEqual(idx.svc(m.rec, ctx.namer), { uid: 'C00001', toc: 'SN', o: 'Littlehampton', d: 'London Victoria', dep: '09:30', arr: '11:15', cat: 'OO', pwr: 'EMU', load: '377' });
  assert.equal(idx.match('1H16', 'LA', now, ctx), null, 'another headcode');
  assert.equal(idx.match('1H15', 'LB', now, ctx), null, 'a TD area the route does not touch');
});

test('"nearest such point" and the 45-minute window: the booked time at the closest in-area point decides', async () => {
  const idx = await build([eastbound()], at(MON, 9, 0));
  // In-area points are Southwick 09:42 and Portslade 09:46.
  assert.ok(idx.match('1H15', 'LA', at(MON, 9, 1), ctx), '41 min before Southwick: inside');
  assert.equal(idx.match('1H15', 'LA', at(MON, 8, 56), ctx), null, '46 min before: outside');
  assert.ok(idx.match('1H15', 'LA', at(MON, 10, 30), ctx), '44 min after Portslade 09:46: inside');
  assert.equal(idx.match('1H15', 'LA', at(MON, 10, 32), ctx), null, '46 min after: outside');
});

test('a train in an area whose only points are elsewhere does not match, however close in time', async () => {
  const idx = await build([eastbound()], at(MON, 9, 44));
  const far = { ...ctx, areaTiplocs: new Map([['ZZ', new Set(['SOMEWHERE'])]]) };
  assert.equal(idx.match('1H15', 'ZZ', at(MON, 9, 44), far), null);
});

test('STP overlay: an O schedule for the same uid replaces the permanent one for the days it applies', async () => {
  const base = eastbound();
  const overlay = sched({ stp: 'O', start: MON, end: MON, hc: '1H15', locs: [loc('LO', 'LITTLEH', null, '1030'), loc('LI', 'PSLDAWH', '1045', '1046', null, '1'), loc('LT', 'VICTRIC', '1215')] });
  const now = at(MON, 10, 45);
  const idx = await build([base, overlay], now);
  const m = idx.match('1H15', 'LA', now, ctx);
  assert.ok(m, 'the overlay timing matches 10:45');
  assert.equal(m.rec.stp, 'O');
  assert.equal(idx.match('1H15', 'LA', at(MON, 9, 44), ctx), null, 'the permanent 09:45 timing is replaced today');
  // The next day the overlay does not apply and the permanent timetable is back.
  const idx2 = await build([base, overlay], at('2026-11-03', 9, 44));
  assert.equal(idx2.match('1H15', 'LA', at('2026-11-03', 9, 44), ctx).rec.stp, 'P');
});

test('STP cancel: a C schedule removes the uid for its days only', async () => {
  const cancel = sched({ stp: 'C', start: MON, end: MON, locs: null });
  const now = at(MON, 9, 44);
  const idx = await build([eastbound(), cancel], now);
  assert.equal(idx.match('1H15', 'LA', now, ctx), null, 'cancelled today');
  assert.ok(idx.match('1H15', 'LA', at('2026-11-03', 9, 44), ctx), 'running tomorrow');
});

test('STP priority is by rank, not file order (a P after a C does not resurrect the train)', async () => {
  const cancel = sched({ stp: 'C', start: MON, end: MON, locs: null });
  const now = at(MON, 9, 44);
  const idx = await build([cancel, eastbound()], now);
  assert.equal(idx.match('1H15', 'LA', now, ctx), null);
});

test('days_runs, start and end dates decide whether a schedule is in force', async () => {
  const now = at(MON, 9, 44);
  assert.equal((await build([eastbound({ days: '0111111' })], now)).match('1H15', 'LA', now, ctx), null, 'does not run on Mondays');
  assert.equal((await build([eastbound({ end: '2026-11-01' })], now)).match('1H15', 'LA', now, ctx), null, 'ended yesterday');
  assert.equal((await build([eastbound({ start: '2026-11-03' })], now)).match('1H15', 'LA', now, ctx), null, 'starts tomorrow');
  assert.ok((await build([eastbound({ start: MON, end: MON })], now)).match('1H15', 'LA', now, ctx), 'a one-day schedule on its day');
});

test('MIDNIGHT: times unwrap across 00:00, and before 05:00 yesterday\'s schedules are still indexed', async () => {
  const night = sched({ uid: 'C00002', hc: '6O44', start: MON, end: MON, locs: [loc('LO', 'MIDNGHT', null, '2350'), loc('LI', 'PSLDAWH', '0010', '0011'), loc('LT', 'VICTRIC', '0030')] });
  // Built at 02:00 on Tuesday: today=Tue, tomorrow=Wed, and yesterday=Mon (hour < 5).
  const built = at('2026-11-03', 2, 0);
  const idx = await build([night], built);
  assert.deepEqual(idx.days.map(d => d.date), ['2026-11-02', '2026-11-03', '2026-11-04']);
  // The Monday schedule calls at Portslade at 00:11 TUESDAY: 1451 minutes on Monday's clock.
  const m = idx.match('6O44', 'LA', at('2026-11-03', 0, 12), ctx);
  assert.ok(m, 'matched 00:12 Tuesday against Monday\'s timetable');
  assert.equal(m.dayDate, '2026-11-02');
  assert.equal(idx.svc(m.rec, ctx.namer).arr, '00:30', 'destination arrival shown as a wall-clock time');
  assert.equal(idx.match('6O44', 'LA', at(MON, 23, 40), ctx).dayDate, '2026-11-02', 'and 11:40 pm Monday, 31 min before');
  assert.equal(idx.match('6O44', 'LA', at(MON, 23, 5), ctx), null, 'but not 66 min early');
  // Wrapped times are stored increasing.
  const b = m.rec.off;
  assert.ok(idx.pool[b + 5 * 1 + 2] > idx.pool[b + 2], 'dep at the second point is later than at the first');
});

test('a schedule from a build after 05:00 does not index yesterday; prune() drops yesterday at 05:00', async () => {
  const night = sched({ uid: 'C00002', hc: '6O44', start: MON, end: MON, locs: [loc('LO', 'MIDNGHT', null, '2350'), loc('LI', 'PSLDAWH', '0010', '0011'), loc('LT', 'VICTRIC', '0030')] });
  const idx = await build([night], at('2026-11-03', 2, 0));
  assert.equal(idx.days.length, 3);
  assert.equal(idx.prune(at('2026-11-03', 4, 59)), 0);
  assert.equal(idx.prune(at('2026-11-03', 5, 1)), 1);
  assert.deepEqual(idx.days.map(d => d.date), ['2026-11-03', '2026-11-04']);
  const idx2 = await build([night], at('2026-11-03', 9, 0));
  assert.equal(idx2.days.length, 2, 'built mid-morning: today and tomorrow only');
});

test('two DIFFERENT services equally close are a guess, so no match; clearly different distances pick the nearer', async () => {
  const a = sched({ uid: 'A00001', locs: [loc('LO', 'LITTLEH', null, '0900'), loc('LI', 'PSLDAWH', '0910', '0911'), loc('LT', 'VICTRIC', '1000')] });
  const b = sched({ uid: 'B00001', locs: [loc('LO', 'LITTLEH', null, '0900'), loc('LI', 'PSLDAWH', '0910', '0911'), loc('LT', 'VICTRIC', '1000')] });
  const now = at(MON, 9, 12);
  assert.equal((await build([a, b], now)).match('1H15', 'LA', now, ctx), null);
  const c = sched({ uid: 'C00009', locs: [loc('LO', 'LITTLEH', null, '0930'), loc('LI', 'PSLDAWH', '0940', '0941'), loc('LT', 'VICTRIC', '1030')] });
  const m = (await build([a, c], now)).match('1H15', 'LA', now, ctx);
  assert.equal(m.rec.uid, 'A00001');
});

test('the same service twice (two day sets, one uid) is not a tie', async () => {
  const now = at(MON, 23, 58);
  const nightly = sched({ uid: 'D00001', hc: '6X01', locs: [loc('LO', 'LITTLEH', null, '2330'), loc('LI', 'PSLDAWH', '2358', '2359'), loc('LT', 'VICTRIC', '0030')] });
  const idx = await build([nightly], now);
  assert.ok(idx.match('6X01', 'LA', now, ctx));
});

test('buses, ships, junk lines, a truncated final line and non-Create records are tolerated and counted', async () => {
  const lines = [eastbound({ uid: 'C00010', status: 'B' }), 'this is not json', '{"JsonScheduleV1":', '{"JsonScheduleV1":{"CIF_train_uid":5}}',
    '{"JsonAssociationV1":{"x":1}}', '{"TiplocV1":{"tiploc_code":"ABC"}}', '', eastbound({ uid: 'C00011', tx: 'Delete' }),
    eastbound({ uid: 'C00012' }), sched({ uid: 'C00013', hc: '', locs: [loc('LO', 'A', null, '0900'), loc('LT', 'B', '0910')] }),
    sched({ uid: 'C00014', locs: [loc('LO', 'LITTLEH', null, '0930')] }), sched({ uid: 'C00015', locs: [{ location_type: 'LI' }, null, loc('LI', 'X', 'zz', 'yy')] }),
    '{"JsonScheduleV1":{"CIF_train_uid":"C000'];
  const now = at(MON, 9, 44);
  const idx = await build(lines, now);
  assert.equal(idx.schedules, 1);
  assert.ok(idx.match('1H15', 'LA', now, ctx));
  assert.ok(idx.stats.badLines >= 3);
});

test('a damaged gzip rejects (so the caller keeps the last good file) rather than yielding a half index', async () => {
  const dir = tmpDir();
  try {
    const f = writeCif(dir, [eastbound()]);
    const buf = fs.readFileSync(f);
    fs.writeFileSync(f, buf.subarray(0, Math.floor(buf.length / 2)));
    await assert.rejects(buildCifIndex(f, { dayNums: targetDays(at(MON, 9, 0)) }));
    await assert.rejects(buildCifIndex(path.join(dir, 'missing.json.gz'), { dayNums: [1] }));
  } finally { rmrf(dir); }
});

test('detail(): every calling and passing point with times, platforms and names', async () => {
  const s = sched({ locs: [loc('LO', 'LITTLEH', null, '0930', null, '2'), loc('LI', 'STHWICK', null, null, '0941'), loc('LI', 'PSLDAWH', '0945', '0946', null, '2'), loc('LT', 'VICTRIC', '1115', null, null, '14')] });
  const now = at(MON, 9, 44);
  const idx = await build([s], now);
  const d = idx.detail(idx.match('1H15', 'LA', now, ctx).rec, ctx.namer);
  assert.deepEqual(d.calls.map(c => [c.tiploc, c.name, c.arr, c.dep, c.pass, c.platform]), [
    ['LITTLEH', 'Littlehampton', null, '09:30', null, '2'], ['STHWICK', 'STHWICK', null, null, '09:41', null],
    ['PSLDAWH', 'Portslade', '09:45', '09:46', null, '2'], ['VICTRIC', 'London Victoria', '11:15', null, null, '14']]);
  assert.deepEqual([d.uid, d.stp, d.toc, d.headcode, d.category, d.power, d.timingLoad, d.speedMph], ['C00001', 'P', 'SN', '1H15', 'OO', 'EMU', '377', 75]);
  assert.deepEqual(d.origin, { name: 'Littlehampton', time: '09:30' });
  assert.deepEqual(d.destination, { name: 'London Victoria', time: '11:15' });
});

test('London time helpers across the clock change (BST ends 2026-10-25 02:00)', () => {
  const a = london(Date.UTC(2026, 9, 25, 0, 30)), b = london(Date.UTC(2026, 9, 25, 1, 30)), c = london(Date.UTC(2026, 6, 1, 23, 30));
  assert.deepEqual([a.hour, a.minute, a.date], [1, 30, '2026-10-25']);
  assert.deepEqual([b.hour, b.minute, b.date], [1, 30, '2026-10-25']);
  assert.deepEqual([c.date, c.hour], ['2026-07-02', 0], 'late evening UTC in summer is already tomorrow in London');
  assert.equal(london(at(MON, 12, 0)).dow, 0, 'Monday is 0');
  assert.equal(dayNumOf('2026-11-03') - dayNumOf(MON), 1);
});

test('schedules that run on none of the indexed days are skipped without a full parse (and counted); the rest are unaffected', async () => {
  const other = [eastbound({ uid: 'X00001', start: '2027-02-01', end: '2027-03-01' }), eastbound({ uid: 'X00002', end: '2026-10-01' }), eastbound({ uid: 'X00003', days: '0000011' })];
  const now = at(MON, 9, 44);
  const broken = '{"JsonScheduleV1":{"CIF_train_uid":"BROKEN","schedule_start_date":"2026-05-17","schedule_end_date":"2026-12-12","schedule_days_runs":"1111111",';
  const idx = await build([...other, eastbound({ uid: 'C00001' }), broken], now);
  assert.equal(idx.stats.prefiltered, 3, 'future, expired and weekend-only schedules skipped by their dates and mask alone');
  assert.equal(idx.stats.badLines, 1, 'a damaged line that WOULD run today still counts as bad rather than vanishing');
  assert.equal(idx.schedules, 1);
  assert.equal(idx.match('1H15', 'LA', now, ctx).rec.uid, 'C00001');
});
