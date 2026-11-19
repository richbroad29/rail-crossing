'use strict';
// feed-logger.js: VSTP + TRUST are logged one message per line, by London date, and rotated.
const fs = require('fs'), os = require('os'), path = require('path');
const F = require('../src/feed-logger');

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`); }
}

console.log('\nfeed-logger\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedlog-'));
F._setLogRootForTest(dir);

// TRUST frames are arrays of messages: one line each, each keeping the receive time.
{
  const lines = F._linesFor('trust', JSON.stringify([{ header: { msg_type: '0001' } }, { header: { msg_type: '0003' } }]), 'RX');
  check('a TRUST frame of two messages is two lines', lines.length, 2);
  check('  ...each { rx, msg } with the message untouched', JSON.parse(lines[1]), { rx: 'RX', msg: { header: { msg_type: '0003' } } });
  const v = F._linesFor('vstp', JSON.stringify({ VSTPCIFMsgV1: { schedule: {} } }), 'RX');
  check('a VSTP frame is one line', v.length, 1);
  check('an unparseable frame is kept raw, not dropped', JSON.parse(F._linesFor('vstp', '{oops', 'RX')[0]).raw, '{oops');
}

// Written to the London date's file: 23:30 UTC on 1 Jul is already 2 Jul in London (BST).
{
  F._initStateForTest('trust');
  F._recordForTest('trust', JSON.stringify([{ a: 1 }]), new Date('2026-07-01T23:30:00Z'));
  check('summer: a message at 23:30 UTC goes in the next London day\'s file',
    fs.existsSync(path.join(dir, 'trust', 'trust-2026-07-02.jsonl')), true);
}

// Rotation: earlier days gzipped, today left plain, very old pruned.
(async () => {
  const t = path.join(dir, 'trust');
  fs.writeFileSync(path.join(t, 'trust-2026-11-18.jsonl'), '{}\n');
  fs.writeFileSync(path.join(t, 'trust-2026-11-19.jsonl'), '{}\n');
  fs.writeFileSync(path.join(t, 'trust-2026-01-01.jsonl.gz'), '');
  fs.writeFileSync(path.join(t, 'unrelated.txt'), '');
  await F.rotate(new Date('2026-11-19T12:00:00Z'));
  const files = fs.readdirSync(t).sort();
  // trust is kept F.KEEP_DAYS.trust (60) days: 1 Jan and the 2 Jul file written above are both older.
  check('rotation: yesterday gzipped, today plain, older than the keep period pruned, other files left alone', files,
    ['trust-2026-11-18.jsonl.gz', 'trust-2026-11-19.jsonl', 'unrelated.txt']);
  fs.mkdirSync(path.join(dir, 'td-all'));
  fs.writeFileSync(path.join(dir, 'td-all', 'td-all-2026-11-18.jsonl'), '{}\n');
  await F.rotate(new Date('2026-11-19T12:00:00Z'));
  check('rotation also gzips the national C-Class log', fs.readdirSync(path.join(dir, 'td-all')), ['td-all-2026-11-18.jsonl.gz']);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log();
  if (fail > 0) { console.error(`${fail} FAILED, ${pass} passed`); process.exit(1); }
  else { console.log(`All ${pass} tests passed.`); process.exit(0); }
})();
