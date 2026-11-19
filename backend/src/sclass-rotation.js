'use strict';

// Bounded, rotated store for the S-Class logs, mirroring td-rotation.js so the
// new capture cannot grow without limit. Kept as a separate module (rather than
// editing td-rotation) so the live C-Class log path is untouched. Handles the
// raw `sclass-YYYY-MM-DD.jsonl`, decoded `barrier-YYYY-MM-DD.jsonl`, and area-
// tagged `cclass-<AREA>-YYYY-MM-DD.jsonl` files in data/logs/sclass/, and the nationwide
// `survey-YYYY-MM-DD.jsonl` (raw S-Class of every other area, ~620 MB a day raw, ~45 MB gzipped):
// gzip every day before today, prune after the shared KEEP_DAYS (retention.js). Gzipping waited
// 7 days until 2026-11-19; with the nationwide capture permanent, that would leave ~4 GB raw.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream');

const LOG_DIR = path.join(__dirname, '..', 'data', 'logs', 'sclass');
const GZIP_AFTER_DAYS = 0;   // any day before today: the London-dated file is complete by 03:10
const PRUNE_AFTER_DAYS = require('./retention').KEEP_DAYS;

function parseDateFromName(name) {
  const m = name.match(/^(?:sclass|barrier|survey|cclass-[A-Za-z0-9]+)-(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/);
  if (!m) return null;
  return new Date(m[1] + 'T00:00:00Z');
}

// Every file alike since 2026-11-19 (survey files were 60 days, the rest 180).
function pruneAfterDays() {
  return PRUNE_AFTER_DAYS;
}

function gzipFile(src) {
  return new Promise((resolve, reject) => {
    const dst = src + '.gz';
    pipeline(fs.createReadStream(src), zlib.createGzip(), fs.createWriteStream(dst), err => {
      if (err) return reject(err);
      fs.unlink(src, unlinkErr => {
        if (unlinkErr) return reject(unlinkErr);
        resolve(dst);
      });
    });
  });
}

async function runOnce() {
  if (!fs.existsSync(LOG_DIR)) return { gzipped: 0, pruned: 0 };
  const todayStr = new Date().toISOString().slice(0, 10);
  const today = new Date(todayStr + 'T00:00:00Z');
  const files = fs.readdirSync(LOG_DIR);
  let gzipped = 0;
  let pruned = 0;
  for (const f of files) {
    const d = parseDateFromName(f);
    if (!d) continue;
    const ageDays = (today - d) / 86400000;
    const full = path.join(LOG_DIR, f);
    if (ageDays > pruneAfterDays(f)) {
      console.log(`S-Class rotation: pruning ${f} (age ${Math.floor(ageDays)}d)`);
      try { fs.unlinkSync(full); pruned++; }
      catch (e) { console.error('S-Class rotation prune failed:', e.message); }
      continue;
    }
    if (ageDays > GZIP_AFTER_DAYS && f.endsWith('.jsonl')) {
      console.log(`S-Class rotation: gzipping ${f} (age ${Math.floor(ageDays)}d)`);
      try { await gzipFile(full); gzipped++; }
      catch (e) { console.error('S-Class rotation gzip failed:', e.message); }
    }
  }
  if (gzipped || pruned) {
    console.log(`S-Class rotation done: ${gzipped} gzipped, ${pruned} pruned`);
  }
  return { gzipped, pruned };
}

function msUntilNext0310Local() {
  // 03:10 — ten minutes after td-rotation's 03:00 run, to avoid overlapping I/O.
  const now = new Date();
  const target = new Date(now);
  target.setHours(3, 10, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target - now;
}

function start() {
  const initial = msUntilNext0310Local();
  console.log(`S-Class rotation: first run in ${Math.round(initial / 60000)} min`);
  setTimeout(function tick() {
    runOnce().catch(e => console.error('S-Class rotation failed:', e.message));
    setTimeout(tick, 24 * 3600 * 1000);
  }, initial);
}

module.exports = { start, runOnce, _parseDateFromName: parseDateFromName, _pruneAfterDays: pruneAfterDays,
  _gzipAfterDays: GZIP_AFTER_DAYS };
