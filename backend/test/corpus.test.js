'use strict';

// Smoke test for corpus-fetcher: loads the on-disk CORPUS file, verifies the
// map is populated, and checks a few known TIPLOC lookups. Requires that
// backend/data/corpus/corpus-latest.json.gz exists (downloaded separately).

const fs = require('fs');
const path = require('path');
const corpus = require('../src/corpus-fetcher');

const TARGET = path.join(__dirname, '..', 'data', 'corpus', 'corpus-latest.json.gz');

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
  if (actual) {
    console.log(`  PASS  ${label} (got: ${actual})`);
    pass++;
  } else {
    console.log(`  FAIL  ${label} (got: ${actual})`);
    fail++;
  }
}

(async () => {
  if (!fs.existsSync(TARGET)) {
    console.error(`SKIP  CORPUS file not on disk at ${TARGET}`);
    console.error('      Run download first or scp from VPS to test locally.');
    process.exit(0);
  }

  const size = await corpus.loadCorpusFromDisk();
  checkTruthy('Map has thousands of entries', size > 1000);

  // Sample TIPLOC seen in the head dump during verification.
  check('FENTON resolves to FENTON MANOR', corpus.resolveTiploc('FENTON'), 'FENTON MANOR');

  // Unknown TIPLOC falls through to raw value.
  check('Unknown TIPLOC returns raw input', corpus.resolveTiploc('ZZZTOTALLYFAKE'), 'ZZZTOTALLYFAKE');

  // Null/empty is passed through unchanged.
  check('null in → null out', corpus.resolveTiploc(null), null);
  check('empty string in → empty string out', corpus.resolveTiploc(''), '');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
