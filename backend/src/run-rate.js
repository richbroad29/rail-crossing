'use strict';

// Compute historical run-rate for freight headcodes by scanning past TD logs.
//
// "Run rate" is the fraction of *applicable* days in a lookback window on which
// the headcode appeared at least once in our TD area (LA). A Q-pathed freight
// with a low run rate is unlikely to run today either — we surface this so the
// frontend can downgrade the prediction.
//
// Applicability is determined by the schedule_days_runs bit pattern carried on
// each CIF entry. If a train only runs Mon–Fri, weekends in the lookback don't
// count against its run rate. If the pattern is unknown, every calendar day
// counts.
//
// Costs: one filesystem scan over the last N days of TD logs at startup and on
// daily CIF refresh. Each file is up to a few MB; scan is grep-and-count, not
// JSON-parse, so it's fast.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const LOG_DIR = path.join(__dirname, '..', 'data', 'logs', 'td');
const LOOKBACK_DAYS = 14;

// Look up a TD log path for an ISO date (YYYY-MM-DD). Tries plain then .gz.
function logPathsForDate(dateStr) {
  const plain = path.join(LOG_DIR, `td-${dateStr}.jsonl`);
  const gz = path.join(LOG_DIR, `td-${dateStr}.jsonl.gz`);
  if (fs.existsSync(plain)) return { path: plain, gz: false };
  if (fs.existsSync(gz)) return { path: gz, gz: true };
  return null;
}

// Read a JSONL log (gzipped or not) and return the set of unique headcodes
// observed in CA/CB/CC events. Headcodes appear in the `desc` field.
function readHeadcodesFromLog(filePath, isGz) {
  let raw;
  try {
    const buf = fs.readFileSync(filePath);
    raw = isGz ? zlib.gunzipSync(buf).toString('utf-8') : buf.toString('utf-8');
  } catch (err) {
    return null;
  }
  const seen = new Set();
  const lines = raw.split('\n');
  for (const line of lines) {
    if (!line) continue;
    // Cheap substring lookup before JSON parse — most lines won't be relevant.
    const i = line.indexOf('"desc":"');
    if (i < 0) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const desc = obj && obj.desc;
    if (typeof desc === 'string' && desc.length > 0) seen.add(desc);
  }
  return seen;
}

// Day-of-week index for a YYYY-MM-DD string with CIF convention (Mon=0..Sun=6).
function cifDayIndex(dateStr) {
  const jsDay = new Date(dateStr + 'T00:00:00Z').getUTCDay(); // 0=Sun
  return jsDay === 0 ? 6 : jsDay - 1;
}

// daysPattern is a 7-char string like "1111100" (Mon..Sun). Empty/missing
// means "no day filter — every day in the lookback counts".
function isApplicable(daysPattern, dateStr) {
  if (!daysPattern || daysPattern.length !== 7) return true;
  return daysPattern[cifDayIndex(dateStr)] === '1';
}

// Build the last-N-days "headcode → daysSeen / daysApplicable" map for a set
// of headcodes of interest. Skips today (still in progress).
function computeRunRates(headcodeToDaysPattern, opts = {}) {
  const lookback = opts.lookbackDays || LOOKBACK_DAYS;
  const today = new Date();
  const result = {};
  // Initialise so every requested headcode appears in the output, even with 0/0.
  for (const head of headcodeToDaysPattern.keys()) {
    result[head] = { seen: 0, applicable: 0, rate: null };
  }

  for (let offset = 1; offset <= lookback; offset++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - offset);
    const ds = d.toISOString().slice(0, 10);
    const fileInfo = logPathsForDate(ds);
    if (!fileInfo) continue; // No log for that day → skip silently
    const headcodes = readHeadcodesFromLog(fileInfo.path, fileInfo.gz);
    if (!headcodes) continue;

    for (const [head, daysPattern] of headcodeToDaysPattern) {
      if (!isApplicable(daysPattern, ds)) continue;
      result[head].applicable++;
      if (headcodes.has(head)) result[head].seen++;
    }
  }

  for (const head of Object.keys(result)) {
    const r = result[head];
    r.rate = r.applicable > 0 ? r.seen / r.applicable : null;
  }

  return result;
}

module.exports = { computeRunRates, _readHeadcodesFromLog: readHeadcodesFromLog };
