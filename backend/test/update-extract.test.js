'use strict';

// Fix 3 — same-day STP=C cancellations via the daily UPDATE extract.
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
const { parseScheduleFile, applyUpdateExtract } = require('../src/schedule-parser');
const { londonDateStamp } = require('../src/time-utils');

const crossingsConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'config', 'crossings.json'), 'utf-8')
);

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

  console.log();
  if (fail > 0) { console.error(`${fail} FAILED, ${pass} passed`); process.exit(1); }
  else { console.log(`All ${pass} tests passed.`); }
})().catch(err => { console.error('Test runner error:', err); process.exit(1); });
