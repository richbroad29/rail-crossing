'use strict';

// Smoke test for corpus-fetcher: loads the on-disk CORPUS file, verifies the
// map is populated, and checks a few known TIPLOC lookups. Requires that
// backend/data/corpus/corpus-latest.json.gz exists (downloaded separately).

const fs = require('fs');
const path = require('path');
const corpus = require('../src/corpus-fetcher');
const { _cleanDisplayName } = corpus;

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

// Pure-function tests run unconditionally — no CORPUS file needed.
check('cleanDisplayName: trailing single paren group', _cleanDisplayName('VICTORIA (C)'), 'VICTORIA');
check('cleanDisplayName: multiple paren groups', _cleanDisplayName('VICTORIA (C) (TPS INDIC. ONLY)'), 'VICTORIA');
check('cleanDisplayName: embedded paren group', _cleanDisplayName('WIMBLEDON (LUL) DEPOT'), 'WIMBLEDON DEPOT');
check('cleanDisplayName: plain name untouched', _cleanDisplayName('LITTLEHAMPTON'), 'LITTLEHAMPTON');
check('cleanDisplayName: ampersand untouched', _cleanDisplayName('PORTSMOUTH & SOUTHSEA'), 'PORTSMOUTH & SOUTHSEA');
check('cleanDisplayName: empty in → empty out', _cleanDisplayName(''), '');
check('cleanDisplayName: null in → empty out', _cleanDisplayName(null), '');
check('cleanDisplayName: only parens collapses to empty', _cleanDisplayName('(C)'), '');

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

  // No entry in the live-loaded map should retain a paren — cleaner is applied at load time.
  // We can't iterate the private map, but we can spot-check via resolveTiploc on TIPLOCs
  // whose raw NLCDESC is known to contain parens. VICTRIC ("VICTORIA (C) (TPS INDIC. ONLY)")
  // was observed in the live API output during deployment.
  const victoria = corpus.resolveTiploc('VICTRIC');
  checkTruthy('VICTRIC resolves to a non-empty name', victoria);
  check('Cleaned VICTRIC has no "("', victoria.includes('('), false);
  check('Cleaned VICTRIC has no ")"', victoria.includes(')'), false);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
