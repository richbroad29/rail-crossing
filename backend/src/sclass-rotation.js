'use strict';

// Bounded, rotated store for the S-Class logs, mirroring td-rotation.js so the
// new capture cannot grow without limit. Kept as a separate module (rather than
// editing td-rotation) so the live C-Class log path is untouched. Handles both
// the raw `sclass-YYYY-MM-DD.jsonl` and decoded `barrier-YYYY-MM-DD.jsonl` files
// in data/logs/sclass/: gzip after 7 days, prune after 180 days.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream');

const LOG_DIR = path.join(__dirname, '..', 'data', 'logs', 'sclass');
const GZIP_AFTER_DAYS = 7;
const PRUNE_AFTER_DAYS = 180;

function parseDateFromName(name) {
  const m = name.match(/^(?:sclass|barrier)-(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/);
  if (!m) return null;
  return new Date(m[1] + 'T00:00:00Z');
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
    if (ageDays > PRUNE_AFTER_DAYS) {
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

module.exports = { start, runOnce };
