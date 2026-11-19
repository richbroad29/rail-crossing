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
  // trust is kept F.KEEP_DAYS.trust (90) days: 1 Jan and the 2 Jul file written above are both older.
  check('rotation: yesterday gzipped, today plain, older than the keep period pruned, other files left alone', files,
    ['trust-2026-11-18.jsonl.gz', 'trust-2026-11-19.jsonl', 'unrelated.txt']);
  fs.mkdirSync(path.join(dir, 'td-all'));
  fs.writeFileSync(path.join(dir, 'td-all', 'td-all-2026-11-18.jsonl'), '{}\n');
  await F.rotate(new Date('2026-11-19T12:00:00Z'));
  check('rotation also gzips the national C-Class log', fs.readdirSync(path.join(dir, 'td-all')), ['td-all-2026-11-18.jsonl.gz']);

  // One policy: every feed kept 90 days (retention.js).
  check('every feed kept 90 days', JSON.stringify(F.KEEP_DAYS), JSON.stringify({ vstp: 90, trust: 90, 'td-all': 90 }));

  // The daily app log (<date>.jsonl in the log root): pruned past 90 days, never gzipped.
  fs.writeFileSync(path.join(dir, '2026-08-21.jsonl'), '{}\n');   // 90 days before 19 Nov: kept
  fs.writeFileSync(path.join(dir, '2026-08-20.jsonl'), '{}\n');   // 91 days: pruned
  fs.writeFileSync(path.join(dir, '2026-11-18.jsonl'), '{}\n');   // yesterday: kept plain
  fs.writeFileSync(path.join(dir, 'notes-2026-01-01.jsonl'), ''); // not a daily log: left alone
  await F.rotate(new Date('2026-11-19T12:00:00Z'));
  const root = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') || f.endsWith('.gz')).sort();
  check('daily app log: older than 90 days pruned, the rest left plain, other files alone', root,
    ['2026-08-21.jsonl', '2026-11-18.jsonl', 'notes-2026-01-01.jsonl']);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log();
  if (fail > 0) { console.error(`${fail} FAILED, ${pass} passed`); process.exit(1); }
  else { console.log(`All ${pass} tests passed.`); process.exit(0); }
})();
