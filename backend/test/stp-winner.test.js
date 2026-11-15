'use strict';
// Which version of a train runs today is decided per TRAIN, before any crossing is consulted
// (schedule-parser.js noteRank / collectWinners). Two made-up crossings on different stretches of
// line, so the rule is shown to be crossing-neutral rather than Portslade-shaped:
//   alpha — Portslade's own definition (between HOVE and SHRHMBS)
//   beta  — the same definition moved to between BRHM and FORD, with no station settings
// A Brighton → Havant train crosses both; a Littlehampton → Havant train crosses only beta.
//
// Regression for 12 Nov 2026: a location-less STP cancellation and a replacement that did not
// cross were both discarded before the STP contest, so the permanent schedule won by default.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseScheduleFile, applyUpdateExtract, getLastParseStats } = require('../src/schedule-parser');

const portslade = require('../src/crossing-definitions').loadCrossings().portslade;
const WEST_OF_BETA = ['BRHM', 'CHCHSTR', 'SBOURNE', 'EMSWTH', 'HAVANT'];
const EAST_OF_BETA = ['FORD', 'LTLHMJN', 'LTLHMPT', 'WORTHNG', 'SHRHMBS', 'FSHRSGT', 'PSLDAWH', 'HOVE', 'BRGHTN'];
const beta = {
  ...portslade,
  schedule: {
    tiplocsBefore: { east: WEST_OF_BETA, west: EAST_OF_BETA },
    interpolation: {
      east: { from: 'BRHM', to: 'FORD', fraction: 0.5 },
      west: { from: 'FORD', to: 'BRHM', fraction: 0.5 }
    }
  }
};
const crossingsConfig = { alpha: portslade, beta };

let pass = 0, fail = 0;
const check = (label, got, want) => {
  if (got === want) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}\n          got:      ${got}\n          expected: ${want}`); fail++; }
};

const ALWAYS = { schedule_start_date: '2020-01-01', schedule_end_date: '2035-12-31', schedule_days_runs: '1111111' };
const FUTURE = { schedule_start_date: '2035-01-01', schedule_end_date: '2035-12-31', schedule_days_runs: '1111111' };

function record(uid, headcode, stp, locations, dates = ALWAYS) {
  return {
    JsonScheduleV1: {
      transaction_type: 'Create', CIF_train_uid: uid, CIF_stp_indicator: stp, ...dates,
      atoc_code: 'SN', train_status: 'P',
      schedule_segment: {
        signalling_id: headcode, CIF_train_category: 'OO', CIF_power_type: 'EMU',
        CIF_operating_characteristics: '', schedule_location: locations
      }
    }
  };
}
// As CIF issues them: a segment, but no locations.
const cancel = (uid, headcode, dates = ALWAYS) => record(uid, headcode, 'C', [], dates);

// Brighton → Havant: crosses alpha (HOVE→SHRHMBS) then beta (FORD→BRHM). `h` = start hour.
const brightonHavant = h => [
  { tiploc_code: 'BRGHTN', departure: `${h}00`, location_type: 'LO' },
  { tiploc_code: 'HOVE', arrival: `${h}03`, departure: `${h}04` },
  { tiploc_code: 'SHRHMBS', arrival: `${h}12`, departure: `${h}13` },
  { tiploc_code: 'FORD', arrival: `${h}30`, departure: `${h}31` },
  { tiploc_code: 'BRHM', arrival: `${h}35`, departure: `${h}36` },
  { tiploc_code: 'HAVANT', arrival: `${h}55`, location_type: 'LT' }
];
// Littlehampton → Havant: crosses beta only.
const littlehamptonHavant = h => [
  { tiploc_code: 'LTLHMPT', departure: `${h}10`, location_type: 'LO' },
  { tiploc_code: 'FORD', arrival: `${h}14`, departure: `${h}15` },
  { tiploc_code: 'BRHM', arrival: `${h}19`, departure: `${h}20` },
  { tiploc_code: 'HAVANT', arrival: `${h}40`, location_type: 'LT' }
];
// Brighton → Lewes: crosses neither.
const brightonLewes = h => [
  { tiploc_code: 'BRGHTN', departure: `${h}00`, location_type: 'LO' },
  { tiploc_code: 'FALMER', arrival: `${h}06`, departure: `${h}07` },
  { tiploc_code: 'LEWES', arrival: `${h}14`, location_type: 'LT' }
];

function writeJsonl(name, records) {
  const p = path.join(os.tmpdir(), `rcx-stp-${name}-${process.pid}.jsonl`);
  fs.writeFileSync(p, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}
const at = (trains, crossing, uid) =>
  (trains[crossing] || []).filter(t => t.uid === uid).map(t => `${t.stp}@${t.estimatedCrossingTime}`).join(',') || 'none';

(async () => {
  console.log('\nThe version of a train that runs today is decided before any crossing\n');

  const full = writeJsonl('full', [
    cancel('U00001', '1A01'),                               // the cancellation comes FIRST in the file
    record('U00001', '1A01', 'P', brightonHavant('10')),
    record('U00002', '1A02', 'P', brightonHavant('11')),
    record('U00002', '1A02', 'O', littlehamptonHavant('11')),  // replacement: beta only
    record('U00003', '1A03', 'P', brightonHavant('12')),
    record('U00003', '1A03', 'O', brightonHavant('13')),       // replacement: both, retimed
    record('U00004', '1A04', 'P', brightonHavant('14')),       // control: untouched
    record('U00005', '1A05', 'P', brightonHavant('15')),
    record('U00005', '1A05', 'O', brightonLewes('15'), FUTURE), // not active today: no effect
    cancel('U00006', '1A06', FUTURE),
    record('U00006', '1A06', 'P', brightonHavant('16')),        // future cancellation: no effect today
    record('U00007', '1A07', 'P', brightonHavant('17')),        // withdrawn later, by the update
    record('U00008', '1A08', 'P', brightonHavant('18')),
    record('U00008', '1A08', 'O', brightonLewes('18'))          // replacement: crosses neither
  ]);
  const base = await parseScheduleFile(full, crossingsConfig);

  check('cancelled (C listed before P): gone from alpha', at(base, 'alpha', 'U00001'), 'none');
  check('cancelled (C listed before P): gone from beta', at(base, 'beta', 'U00001'), 'none');
  check('replaced via Littlehampton: gone from alpha, which it no longer crosses', at(base, 'alpha', 'U00002'), 'none');
  check('replaced via Littlehampton: beta has the REPLACEMENT', at(base, 'beta', 'U00002'), 'O@11:18');
  check('replaced on the same route, retimed: alpha has the replacement', at(base, 'alpha', 'U00003'), 'O@13:07');
  check('replaced on the same route, retimed: beta has the replacement', at(base, 'beta', 'U00003'), 'O@13:34');
  check('control: alpha keeps it', at(base, 'alpha', 'U00004'), 'P@14:07');
  check('control: beta keeps it', at(base, 'beta', 'U00004'), 'P@14:34');
  check('a replacement not active today changes nothing (alpha)', at(base, 'alpha', 'U00005'), 'P@15:07');
  check('a cancellation not active today changes nothing (beta)', at(base, 'beta', 'U00006'), 'P@16:34');
  check('replaced by a route crossing neither: gone from alpha', at(base, 'alpha', 'U00008'), 'none');
  check('replaced by a route crossing neither: gone from beta', at(base, 'beta', 'U00008'), 'none');

  const stats = getLastParseStats();
  check('withdrawn traversals counted: 1A01×2, 1A02×1, 1A08×2', stats.withdrawnCount, 5);
  check('reasons recorded', stats.withdrawn.map(w => `${w.headcode}:${w.crossingId}:${w.by}`).sort().join(' '),
    '1A01:alpha:cancelled 1A01:beta:cancelled 1A02:alpha:replaced 1A08:alpha:replaced 1A08:beta:replaced');
  check('the results object still has exactly the two crossings as keys', Object.keys(base).join(), 'alpha,beta');

  // The update extract follows the same rule, starting from the full parse's winners.
  const upd = writeJsonl('upd', [
    record('U00007', '1A07', 'O', brightonLewes('17')),        // replacement crossing neither → withdraw
    record('U00002', '1A02', 'P', brightonHavant('11')),        // lower than the base's O → no resurrection
    cancel('U00004', '1A04')                                    // a plain cancellation, as before
  ]);
  const { trains: after, stats: u } = await applyUpdateExtract(upd, crossingsConfig, base);

  check('update: non-crossing replacement withdraws it from alpha', at(after, 'alpha', 'U00007'), 'none');
  check('update: ...and from beta', at(after, 'beta', 'U00007'), 'none');
  check('update: a lower-ranked P does not bring back 1A02 at alpha', at(after, 'alpha', 'U00002'), 'none');
  check('update: 1A02 at beta is still the replacement', at(after, 'beta', 'U00002'), 'O@11:18');
  check('update: cancellation still works', at(after, 'alpha', 'U00004') + '/' + at(after, 'beta', 'U00004'), 'none/none');
  check('update: stats count trains, not traversals', `${u.cancelled} cancelled, ${u.replaced} replaced`, '1 cancelled, 1 replaced');
  check('update: untouched trains survive', at(after, 'alpha', 'U00003'), 'O@13:07');
  check('base is not mutated by the update', at(base, 'alpha', 'U00007'), 'P@17:07');

  console.log();
  if (fail) { console.error(`${fail} FAILED, ${pass} passed`); process.exit(1); }
  console.log(`All ${pass} tests passed.`);
})();
