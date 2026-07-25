'use strict';
// callsAt(): a station ABSENT from a CIF schedule means the train does not call there.
// Absence was previously reported as "unknown", which made every Littlehampton–Victoria
// service fall back to the wrong eastbound timing class (they carry PSLDAWH but no
// FSHRSGT entry at all). Shapes below are taken from the real extract.
const { parseScheduleFile } = require('../src/schedule-parser');
const path = require('path');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  if (actual === expected) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}\n          got:      ${actual}\n          expected: ${expected}`); fail++; }
}

// callsAt is internal; exercise it through buildCrossingEntry via a tiny synthetic feed.
const os = require('os'), fs = require('fs'), zlib = require('zlib');
const cfg = {
  t: {
    name: 'T', road: 'R',
    schedule: {
      tiploc_station: 'PSLDAWH',
      tiploc_approach_call: 'FSHRSGT',
      tiplocs_west: ['SHRHMBS'], tiplocs_east: ['HOVE'],
      interpolation: { eastbound: { from: 'SHRHMBS', to: 'HOVE', fraction: 0.7 },
                       westbound: { from: 'HOVE', to: 'SHRHMBS', fraction: 0.3 } }
    },
    timing: {}
  }
};
const sched = (id, locs) => JSON.stringify({ JsonScheduleV1: {
  CIF_train_uid: id, schedule_start_date: '2000-01-01', schedule_end_date: '2099-01-01',
  schedule_days_runs: '1111111', transaction_type: 'Create', CIF_stp_indicator: 'P',
  train_status: 'P', schedule_segment: { signalling_id: id, CIF_train_category: 'OO',
    schedule_location: locs } } });
const L = (tiploc, arr, dep, pas) => ({ tiploc_code: tiploc, record_identity: 'LI',
  arrival: arr || undefined, departure: dep || undefined, pass: pas || undefined });

(async () => {
  const file = path.join(os.tmpdir(), `cp-test-${process.pid}.json.gz`);
  fs.writeFileSync(file, zlib.gzipSync([
    // calls Portslade, Fishersgate absent entirely  → the 1H Victoria pattern
    sched('AAA', [L('SHRHMBS','0843','0844'), L('PSLDAWH','0848','0848H'), L('HOVE','0851','0852')]),
    // calls both                                     → the 2Y local pattern
    sched('BBB', [L('SHRHMBS','0843','0844'), L('FSHRSGT','0846','0846H'),
                  L('PSLDAWH','0848','0848H'), L('HOVE','0851','0852')]),
    // passes Portslade without calling
    sched('CCC', [L('SHRHMBS','0843','0844'), L('PSLDAWH',null,null,'0848'), L('HOVE','0851','0852')]),
  ].join('\n')));

  const out = await parseScheduleFile(file, cfg);
  const by = Object.fromEntries((out.t || []).map(t => [t.headcode, t]));
  fs.unlinkSync(file);

  check('calls Portslade (arr/dep present)', by.AAA && by.AAA.callsAtStation, true);
  check('Fishersgate ABSENT ⇒ does not call there (not unknown)', by.AAA && by.AAA.callsAtApproach, false);
  check('calls both', by.BBB && by.BBB.callsAtApproach, true);
  check('passes Portslade (pass only) ⇒ does not call', by.CCC && by.CCC.callsAtStation, false);

  console.log();
  if (fail > 0) { console.error(`${fail} FAILED, ${pass} passed`); process.exit(1); }
  else { console.log(`All ${pass} tests passed.`); }
})().catch(e => { console.error('Test runner error:', e); process.exit(1); });
