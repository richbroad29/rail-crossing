'use strict';

// Fix 3 — the daily UPDATE extract laid over the full timetable.
//
// (Its premise, "same-day STP=C cancellations within the hour", was wrong: an update appears only
// the next morning, by which time the 04:00 full already contains it. Since 2026-11-20 an update is
// applied only if its header says it is newer than the full — tested at the end of this file.)
//
// Builds a synthetic full extract (two Portslade-traversing trains) and a
// synthetic update extract, then asserts applyUpdateExtract overlays it without
// a full re-download:
//   - a C overlay for a uid present in the full extract removes that uid;
//   - an unrelated uid is retained;
//   - an N overlay introducing a new traversing uid is added;
//   - a bare Delete does NOT remove a train (conservative, catch-every-closure).

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { parseScheduleFile, applyUpdateExtract } = require('../src/schedule-parser');
const { londonDateStamp } = require('../src/time-utils');
const { updateDecision, applyNewerUpdate } = require('../src/timetable-update');
const { readHeader } = require('../src/cif-archive');
const { newestUpdateDay } = require('../src/cif-fetcher');

const crossingsConfig = require('../src/crossing-definitions').loadCrossings();

let pass = 0, fail = 0;
function check(label, actual, expected) {
  if (actual === expected) { console.log(`  PASS  ${label}`); pass++; }
  else {
    console.log(`  FAIL  ${label}`);
    console.log(`          got:      ${actual}`);
    console.log(`          expected: ${expected}`);
    fail++;
  }
}

const TODAY = londonDateStamp();
const ALWAYS = { schedule_start_date: '2020-01-01', schedule_end_date: '2035-12-31', schedule_days_runs: '1111111' };

// A Portslade-traversing eastbound service (SHRHMBS west → HOVE east).
function traversingSchedule(uid, headcode, stp, tt) {
  return {
    JsonScheduleV1: {
      transaction_type: tt || 'Create',
      CIF_train_uid: uid,
      CIF_stp_indicator: stp || 'P',
      ...ALWAYS,
      atoc_code: 'ZZ',
      schedule_segment: {
        signalling_id: headcode,
        CIF_train_category: '',
        CIF_power_type: 'D',
        CIF_operating_characteristics: '',
        schedule_location: [
          { tiploc_code: 'SOTON', departure: '1000', location_type: 'LO' },
          { tiploc_code: 'SHRHMBS', pass: '1030' },
          { tiploc_code: 'HOVE', arrival: '1040', location_type: 'LT' }
        ]
      }
    }
  };
}

// A location-less STP cancellation, as CIF issues them.
function cancellationSchedule(uid) {
  return {
    JsonScheduleV1: {
      transaction_type: 'Create',
      CIF_train_uid: uid,
      CIF_stp_indicator: 'C',
      ...ALWAYS
    }
  };
}

function deleteSchedule(uid) {
  return {
    JsonScheduleV1: {
      transaction_type: 'Delete',
      CIF_train_uid: uid,
      CIF_stp_indicator: 'P',
      ...ALWAYS
    }
  };
}

function writeJsonl(name, records) {
  const p = path.join(os.tmpdir(), `rcx-${name}-${process.pid}.jsonl`);
  fs.writeFileSync(p, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

// A gzipped extract with the header Network Rail puts on line 1 (type + sequence), as cif-archive reads it.
function writeExtract(name, type, sequence, records) {
  const header = { JsonTimetableV1: { classification: 'public', timestamp: Math.floor(Date.now() / 1000), owner: 'Network Rail',
    Sender: { organisation: 'Rockshore', application: 'NTROD', component: 'SCHEDULE' }, Metadata: { type, sequence } } };
  const p = path.join(os.tmpdir(), `rcx-${name}-${process.pid}.json.gz`);
  fs.writeFileSync(p, zlib.gzipSync([header, ...records].map(r => JSON.stringify(r)).join('\n') + '\n'));
  return p;
}

function uids(trains) {
  return new Set((trains.portslade || []).map(t => t.uid));
}

(async () => {
  console.log('\nFix 3 — STP=C same-day cancellation via UPDATE extract\n');

  const fullFile = writeJsonl('full', [
    traversingSchedule('X12345', '6X12', 'P'),
    traversingSchedule('Y67890', '1Y67', 'P')
  ]);

  const base = await parseScheduleFile(fullFile, crossingsConfig);
  const baseUids = uids(base);
  check('full extract predicts X12345', baseUids.has('X12345'), true);
  check('full extract predicts Y67890', baseUids.has('Y67890'), true);

  // Update: cancel X12345, add new Z, delete Y67890 (must be ignored).
  const updateFile = writeJsonl('update', [
    cancellationSchedule('X12345'),
    traversingSchedule('Z11111', '6Z11', 'N'),
    deleteSchedule('Y67890')
  ]);

  const { trains, stats } = await applyUpdateExtract(updateFile, crossingsConfig, base);
  const after = uids(trains);

  check('C overlay removes the cancelled uid X12345', after.has('X12345'), false);
  check('unrelated uid Y67890 is retained', after.has('Y67890'), true);
  check('N overlay adds the new traversing uid Z11111', after.has('Z11111'), true);
  check('bare Delete did NOT remove Y67890 (conservative)', after.has('Y67890'), true);

  check('stats: one cancellation applied', stats.cancelled, 1);
  check('stats: one overlay applied', stats.overlays, 1);
  check('stats: one delete seen', stats.deletes, 1);
  check('stats: cancelledIds names the suppressed service',
    stats.cancelledIds.some(c => c.uid === 'X12345'), true);

  // Base must be untouched (idempotent re-apply).
  check('base predictions unchanged after apply', uids(base).has('X12345'), true);

  for (const f of [fullFile, updateFile]) { try { fs.unlinkSync(f); } catch {} }

  // ---- Which update is applied: by its header's sequence, not its name (2026-11-20) ---------------
  // NROD names an update for the day whose changes it carries and publishes it ~00:30 UTC the next
  // morning, so the live code's hourly fetch of TODAY's name applied a six-day-old file over a fresh
  // full. An update is now applied only if it is newer than the full it would be laid over.
  console.log('\nUpdate applied only if newer than the full\n');

  check('decision: older than the full -> stale', updateDecision(5295, 5289), 'stale');
  check('decision: same sequence as the full -> same', updateDecision(5295, 5295), 'same');
  check('decision: newer than the full -> apply', updateDecision(5295, 5296), 'apply');
  check('decision: full sequence unknown -> unknown', updateDecision(null, 5296), 'unknown');
  check('decision: update sequence unknown -> unknown', updateDecision(5295, NaN), 'unknown');

  const full2 = writeExtract('full2', 'full', 5295, [traversingSchedule('X12345', '6X12', 'P'), traversingSchedule('Y67890', '1Y67', 'P')]);
  const base2 = await parseScheduleFile(full2, crossingsConfig);
  check('fixture: the full header is read', (await readHeader(full2)).sequence, 5295);
  const cancelX = [cancellationSchedule('X12345')];
  // One run of the live path's wiring, with the real header reader and the real applyUpdateExtract.
  async function run(updateSeq, fullSeq, type = 'update') {
    const file = writeExtract(`upd-${updateSeq}-${type}`, type, updateSeq, cancelX);
    let applied = 0, after = null;
    try {
      const r = await applyNewerUpdate({
        fullSeq, readHeader, download: async () => ({ path: file, bytes: 0, day: 'wed' }),
        apply: async f => { applied++; after = (await applyUpdateExtract(f, crossingsConfig, base2)).trains; }
      });
      return { applied, after, decision: r.decision };
    } finally { try { fs.unlinkSync(file); } catch {} }
  }
  const stale = await run(5289, 5295);
  check('stale update (5289 over full 5295): not applied', stale.applied, 0);
  const same = await run(5295, 5295);
  check('same sequence as the full: not applied', same.applied, 0);
  const newer = await run(5296, 5295);
  check('newer update (5296 over full 5295): applied once', newer.applied, 1);
  check('newer update: its cancellation takes effect', newer.after && uids(newer.after).has('X12345'), false);
  check('newer update: the other train stays', newer.after && uids(newer.after).has('Y67890'), true);
  const unknown = await run(5296, null);
  check('full sequence unknown: not applied', unknown.applied, 0);
  let threw = false;
  try { await run(5296, 5295, 'full'); } catch (e) { threw = /not an update extract/.test(e.message); }
  check('a full served under an update name: refused', threw, true);
  try { fs.unlinkSync(full2); } catch {}

  // The newest published update is YESTERDAY's weekday in London, across both clock changes.
  check('Thu 19 Nov midday -> wed', newestUpdateDay(new Date('2026-11-19T12:00:00Z')), 'wed');
  check('Fri 20 Nov 00:10, before publication -> thu (still last week\'s; sequence check skips it)',
    newestUpdateDay(new Date('2026-11-20T00:10:00Z')), 'thu');
  check('Sun 25 Oct 23:30 GMT, the 25-hour day -> sat', newestUpdateDay(new Date('2026-10-25T23:30:00Z')), 'sat');
  check('Sun 29 Mar 00:30 GMT, before clocks go forward -> sat', newestUpdateDay(new Date('2026-03-29T00:30:00Z')), 'sat');
  check('Mon 30 Mar 00:30 BST -> sun', newestUpdateDay(new Date('2026-03-29T23:30:00Z')), 'sun');

  console.log();
  if (fail > 0) { console.error(`${fail} FAILED, ${pass} passed`); process.exit(1); }
  else { console.log(`All ${pass} tests passed.`); }
})().catch(err => { console.error('Test runner error:', err); process.exit(1); });
