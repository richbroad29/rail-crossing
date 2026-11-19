'use strict';

// Timetable archive (src/cif-archive.js): files are named from their own header, an update is kept
// once per sequence however many weekday names return it, a full is copied in once a week, and
// pruning keeps fulls a week longer than updates. Everything happens in a temp folder, no network.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const A = require('../src/cif-archive');

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cif-archive-'));
const archive = path.join(tmp, 'archive');
A._setArchiveDirForTest(archive);

const ts = iso => Math.floor(Date.parse(iso) / 1000);
function cif(file, type, sequence, iso) {
  const header = JSON.stringify({ JsonTimetableV1: { classification: 'public', timestamp: ts(iso), Metadata: { type, sequence } } });
  fs.writeFileSync(file, zlib.gzipSync(header + '\n{"TiplocV1":{}}\n'));
}

// What Network Rail served on 19 Nov 2026: each name holds the day whose changes it carries,
// published 00:30 UTC the next morning — so 'thu' is still LAST week's file.
const served = { mon: [5293, '2026-11-17'], tue: [5294, '2026-11-18'], wed: [5295, '2026-11-19'],
  thu: [5289, '2026-11-13'], fri: [5290, '2026-11-14'], sat: [5291, '2026-11-15'], sun: [5292, '2026-11-16'] };
const download = async (day, dst) => {
  if (day === 'sat' && served.satFails) throw new Error('HTTP 503');
  const [seq, date] = served[day];
  cif(dst, 'update', seq, date + 'T00:30:35Z');
  return { path: dst };
};

(async () => {
  console.log('\nTimetable archive\n');
  const full = path.join(tmp, 'cif-latest.json.gz');
  cif(full, 'full', 5295, '2026-11-19T00:31:47Z');

  check('header read from the file itself', await A.readHeader(full), { type: 'full', sequence: 5295, date: '2026-11-19' });

  let r = await A.runOnce({ download, fullFile: full, today: '2026-11-19' });
  check('first run: the full snapshot is archived', r.full, 'cif-full-2026-11-19-5295.json.gz');
  check('first run: all seven updates, named by their own date and sequence', r.updates.sort(), [
    'cif-update-2026-11-13-5289.json.gz', 'cif-update-2026-11-14-5290.json.gz', 'cif-update-2026-11-15-5291.json.gz',
    'cif-update-2026-11-16-5292.json.gz', 'cif-update-2026-11-17-5293.json.gz', 'cif-update-2026-11-18-5294.json.gz',
    'cif-update-2026-11-19-5295.json.gz']);
  check('no temp files left behind', fs.readdirSync(archive).filter(f => !f.startsWith('cif-')), []);

  // Next day: only 'thu' is new. A failing weekday is logged and skipped, the rest still archived.
  served.thu = [5296, '2026-11-20']; served.satFails = true;
  cif(full, 'full', 5296, '2026-11-20T00:31:00Z');
  r = await A.runOnce({ download, fullFile: full, today: '2026-11-20' });
  check('next day: only the new sequence is added', r.updates, ['cif-update-2026-11-20-5296.json.gz']);
  check('next day: no second full within the week', r.full, null);

  // A week later the full is due again.
  cif(full, 'full', 5302, '2026-11-26T00:31:00Z');
  r = await A.runOnce({ download, fullFile: full, today: '2026-11-26' });
  check('seven days on: a new full is archived', r.full, 'cif-full-2026-11-26-5302.json.gz');

  // Pruning: past 90 days goes, except the full that is the base of the oldest kept update.
  // On 26 Nov the update of 28 Aug (90 days) is kept, so its base, the full of 20 Aug (98 days), stays.
  cif(path.join(archive, 'cif-update-2026-08-20-5200.json.gz'), 'update', 5200, '2026-08-20T00:30:00Z');
  cif(path.join(archive, 'cif-update-2026-08-28-5208.json.gz'), 'update', 5208, '2026-08-28T00:30:00Z');
  cif(path.join(archive, 'cif-full-2026-08-20-5200.json.gz'), 'full', 5200, '2026-08-20T00:30:00Z');
  cif(path.join(archive, 'cif-full-2026-08-10-5190.json.gz'), 'full', 5190, '2026-08-10T00:30:00Z');
  fs.writeFileSync(path.join(archive, 'notes.txt'), '');
  r = await A.runOnce({ download, fullFile: full, today: '2026-11-26' });
  check('prune: old update and the older full go; the base of the oldest kept update stays',
    r.pruned.sort(), ['cif-full-2026-08-10-5190.json.gz', 'cif-update-2026-08-20-5200.json.gz']);
  // Two days later (window starts 30 Aug) a newer full of 27 Aug is the base, so 20 Aug goes.
  cif(path.join(archive, 'cif-full-2026-08-27-5207.json.gz'), 'full', 5207, '2026-08-27T00:30:00Z');
  r = await A.runOnce({ download, fullFile: full, today: '2026-11-28' });
  check('prune: once a newer full is the base, the old one goes (with the update now past 90 days)',
    r.pruned.sort(), ['cif-full-2026-08-20-5200.json.gz', 'cif-update-2026-08-28-5208.json.gz']);
  check('prune: the 27 Aug full stays as the base of the window', fs.existsSync(path.join(archive, 'cif-full-2026-08-27-5207.json.gz')), true);
  check('prune: unrelated files left alone', fs.existsSync(path.join(archive, 'notes.txt')), true);

  // A wrong file in the full's place is refused, not archived as a full.
  cif(full, 'update', 9999, '2026-12-10T00:30:00Z');
  r = await A.runOnce({ download, fullFile: full, today: '2026-12-10' });
  check('a non-full file in the full slot is not archived', r.full, null);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
