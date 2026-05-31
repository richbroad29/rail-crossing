'use strict';

// Fix 4 — CR / TI / TA records are counted (not applied), and applying them is
// immaterial to Portslade predictions. We assert (a) the skip counts are
// reported at parse time, and (b) a Change-en-Route location on a traversing
// train neither breaks nor alters that train's prediction.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseScheduleFile, getLastParseStats } = require('../src/schedule-parser');

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

const ALWAYS = { schedule_start_date: '2020-01-01', schedule_end_date: '2035-12-31', schedule_days_runs: '1111111' };

// Portslade-traversing service WITH a CR (change-en-route) location mid-route.
const traversingWithCR = {
  JsonScheduleV1: {
    transaction_type: 'Create', CIF_train_uid: 'X12345', CIF_stp_indicator: 'P', ...ALWAYS,
    atoc_code: 'ZZ',
    schedule_segment: {
      signalling_id: '1X12', CIF_train_category: '', CIF_power_type: 'E',
      schedule_location: [
        { tiploc_code: 'SOTON', departure: '1000', location_type: 'LO' },
        { tiploc_code: 'SHRHMBS', pass: '1030', location_type: 'LI' },
        { tiploc_code: 'SHRHMBS', location_type: 'CR' }, // change-en-route marker
        { tiploc_code: 'HOVE', arrival: '1040', location_type: 'LT' }
      ]
    }
  }
};

// TIPLOC reference records (TI = Create, TA = Update).
const tiRecord = { TiplocV1: { transaction_type: 'Create', tiploc_code: 'NEWTIP1', tps_description: 'NEW PLACE' } };
const taRecord = { TiplocV1: { transaction_type: 'Update', tiploc_code: 'HOVE', tps_description: 'HOVE' } };

function writeJsonl(records) {
  const p = path.join(os.tmpdir(), `rcx-skip-${process.pid}.jsonl`);
  fs.writeFileSync(p, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

(async () => {
  console.log('\nFix 4 — CR / TI / TA counted, not applied\n');

  const file = writeJsonl([tiRecord, traversingWithCR, taRecord]);
  const results = await parseScheduleFile(file, crossingsConfig);

  // (a) Prediction is unaffected by the CR — the train still traverses.
  const portslade = results.portslade || [];
  const t = portslade.find(x => x.uid === 'X12345');
  check('CR did not break traversal — X12345 still predicted', !!t, true);
  check('crossing time interpolated from LI times (unaffected by CR)',
    t ? t.estimatedCrossingTime : null, '10:37');

  // (b) Skip counts are reported.
  const stats = getLastParseStats();
  check('TI (TIPLOC insert) counted', stats.tiInsert, 1);
  check('TA (TIPLOC amend/delete) counted', stats.taAmend, 1);
  check('CR-en-route location counted', stats.crLocations, 1);
  check('CR on a traversing train counted', stats.crOnTraversing, 1);

  try { fs.unlinkSync(file); } catch {}

  console.log();
  if (fail > 0) { console.error(`${fail} FAILED, ${pass} passed`); process.exit(1); }
  else { console.log(`All ${pass} tests passed.`); }
})().catch(err => { console.error('Test runner error:', err); process.exit(1); });
