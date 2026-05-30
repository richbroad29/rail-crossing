'use strict';

// Smoke test for run-rate.js using a real TD log fetched from the VPS.
// We pulled td-2026-05-29.jsonl into backend/data/logs/td/ for this purpose.
// Today's calendar date is set via TODAY env in CI; we override the
// "today" reference by stubbing Date if needed. For a simpler approach we
// just trust whatever the system date is and check internal helpers.

const fs = require('fs');
const path = require('path');
const { _readHeadcodesFromLog, computeRunRates } = require('../src/run-rate');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS  ${label}`);
    pass++;
  } else {
    console.log(`  FAIL  ${label}`);
    console.log(`          got:      ${actual}`);
    console.log(`          expected: ${expected}`);
    fail++;
  }
}
function checkTruthy(label, actual) {
  if (actual) { console.log(`  PASS  ${label} (got: ${actual})`); pass++; }
  else { console.log(`  FAIL  ${label} (got: ${actual})`); fail++; }
}

const LOG = path.join(__dirname, '..', 'data', 'logs', 'td', 'td-2026-05-29.jsonl');

if (!fs.existsSync(LOG)) {
  console.error(`SKIP  TD log not on disk at ${LOG}`);
  console.error('      scp from VPS to test locally.');
  process.exit(0);
}

// 1. Headcode extraction from a single log.
const set = _readHeadcodesFromLog(LOG, false);
checkTruthy('Headcode set has at least 100 entries', set && set.size > 100);

// 6O40 (Q-pathed) did NOT run on 29 May per our investigation. 6O68 did.
check('6O40 absent from 29 May TD log', set.has('6O40'), false);
check('6O68 present in 29 May TD log', set.has('6O68'), true);
check('1H21 (passenger) present', set.has('1H21'), true);

// 2. computeRunRates initialises every requested headcode in output map.
const requested = new Map([
  ['6O40', '0111100'],  // Tue-Fri
  ['6O68', '1111100'],  // Mon-Fri
  ['NEVER', '1111111'], // every day
]);
const rates = computeRunRates(requested, { lookbackDays: 14 });
checkTruthy('rates has 6O40 entry', rates['6O40']);
checkTruthy('rates has 6O68 entry', rates['6O68']);
checkTruthy('rates has NEVER entry', rates['NEVER']);

// NEVER should never have a hit.
check('NEVER seen == 0', rates['NEVER'].seen, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
