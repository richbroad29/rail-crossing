'use strict';

// "Train held" — how often, for how long, and under WHICH rule.
//
// Reads the cat:"held" episode lines the backend writes to data/logs/<date>.jsonl
// (logger.logHeld, live since 740d4fc). Read-only: it does not touch the running
// service, its state, or the logs.
//
// Run on the VPS, from the repo root or backend/:
//   node backend/scripts/held-report.js
//   node backend/scripts/held-report.js 'data/logs/2026-10-*.jsonl'   (narrow the window)
//
// The question it exists to answer is which rule to act on, because the three are not
// interchangeable: a noise margin on `expired` removes 'unstruck' holds and does nothing
// at all to 'queued' ones, where nothing is late and the barrier is simply going to drop
// again behind the train in front. The reasons field is a SET for that reason — a hold
// reading 'queued+unstruck' survives a tolerance on expiry, so the per-rule totals below
// are an upper bound on what any single change can remove, not an estimate of it.
//
// `how` matters for the durations: 'released' is the train moving, 'gone' is it leaving
// the merged list at the 3-min sighting grace. Mixed together, that grace's own three
// minutes lands in the tail and reads as how long trains actually stand.

const fs = require('fs');
const path = require('path');
const os = require('os');

function resolveFiles(pattern) {
  if (pattern) {
    const dir = path.dirname(pattern);
    const re = new RegExp('^' + path.basename(pattern)
      .replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return fs.readdirSync(dir).filter(f => re.test(f)).sort().map(f => path.join(dir, f));
  }
  const dirs = [
    path.join(process.cwd(), 'data', 'logs'),
    path.join(process.cwd(), 'backend', 'data', 'logs'),
    path.join(os.homedir(), 'rail-crossing', 'backend', 'data', 'logs')
  ];
  const dir = dirs.find(d => fs.existsSync(d));
  if (!dir) { console.error('No data/logs directory found. Pass a glob explicitly.'); process.exit(2); }
  return fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()
    .map(f => path.join(dir, f));
}

const files = resolveFiles(process.argv[2]);
if (!files.length) {
  // Zero FILES is not zero holds. Say which, or "no episodes" sends someone off to check TD.
  console.log('No log files matched %s — nothing was read, so this says nothing about holds.',
    process.argv[2] ? `'${process.argv[2]}'` : 'the default location');
  console.log('Files are named data/logs/YYYY-MM-DD.jsonl; only * works as a wildcard.');
  process.exit(0);
}
const starts = new Map();
const ends = [];
const perDay = new Map();
let bogus = 0;

// An episode whose `since` is nowhere near the day it was logged on is not a hold — it is a
// unit-test run. The suite drives _computeClosures off a fixed 2023 epoch and, unless the
// block stubs the logger, that reaches the REAL log: `npm test` on the box writes held lines
// dated three years ago, with durations to match. Dropped loudly rather than silently,
// because the same shape would also be a genuine clock problem worth knowing about.
const SANE_MS = 2 * 24 * 3600 * 1000;
function sane(day, r) {
  const since = Date.parse(r.since);
  const dayMs = Date.parse(day + 'T00:00:00Z');
  if (!isFinite(since) || !isFinite(dayMs)) return false;
  return Math.abs(since - dayMs) <= SANE_MS;
}

for (const fn of files) {
  const day = path.basename(fn).replace('.jsonl', '');
  let text;
  try { text = fs.readFileSync(fn, 'utf8'); } catch (e) { continue; }
  for (const line of text.split('\n')) {
    // Loose pre-filter, then a real parse — a substring test on the exact key spelling
    // would be defeated by any change in how the line is serialised.
    if (line.indexOf('held') === -1) continue;
    let r;
    try { r = JSON.parse(line); } catch (e) { continue; }
    if (!r || r.cat !== 'held') continue;
    if (!sane(day, r)) { bogus++; continue; }
    const key = r.headcode + '|' + r.since;
    if (r.phase === 'start') starts.set(key, { day, r });
    else if (r.phase === 'end') {
      ends.push({ day, r });
      perDay.set(day, (perDay.get(day) || 0) + 1);
    }
  }
}

const ended = new Set(ends.map(e => e.r.headcode + '|' + e.r.since));
let unterminated = 0;
for (const k of starts.keys()) if (!ended.has(k)) unterminated++;

console.log('files read: %d   %s -> %s', files.length,
  files.length ? path.basename(files[0]) : '-',
  files.length ? path.basename(files[files.length - 1]) : '-');
console.log('completed episodes: %d', ends.length);
console.log('unterminated (service stopped mid-hold): %d', unterminated);
if (bogus) {
  console.log('SKIPPED %d line(s) dated far from their log file — almost certainly a', bogus);
  console.log('        `npm test` run on this box, which writes held lines off a 2023 fixture.');
}

if (!ends.length) {
  console.log('\nNo completed held episodes in these files.');
  console.log('Before reading that as "it rarely happens", check TD is actually feeding —');
  console.log('with no berth data nothing can be held, so the count is hollow rather than low.');
  process.exit(0);
}

console.log('\n--- episodes per day ---');
for (const d of [...perDay.keys()].sort()) console.log('  %s  %s', d, String(perDay.get(d)).padStart(4));

function table(title, keyOf) {
  const agg = new Map();
  for (const { r } of ends) {
    const k = keyOf(r) || '(none)';
    const cur = agg.get(k) || { n: 0, s: 0, max: 0 };
    const d = r.durationSecs || 0;
    agg.set(k, { n: cur.n + 1, s: cur.s + d, max: Math.max(cur.max, d) });
  }
  const tot = [...agg.values()].reduce((a, v) => a + v.s, 0) || 1;
  console.log('\n--- %s ---', title);
  for (const [k, v] of [...agg.entries()].sort((a, b) => b[1].s - a[1].s)) {
    console.log('  %s %s episodes  %ss total (%s%%)  mean %ss  max %ss',
      k.padEnd(22), String(v.n).padStart(4), String(v.s).padStart(7),
      (100 * v.s / tot).toFixed(1).padStart(5), String(Math.round(v.s / v.n)).padStart(5),
      String(v.max).padStart(5));
  }
}

table('by rule (this is the decision)', r => r.reasons);
table('by how it ended', r => r.how);
table('by direction', r => r.direction);
table('by class', r => r.trainClass);

console.log('\n--- duration shape ---');
const buckets = [[0, 10], [10, 20], [20, 30], [30, 60], [60, 120], [120, 300], [300, Infinity]];
for (const [lo, hi] of buckets) {
  const n = ends.filter(e => (e.r.durationSecs || 0) >= lo && (e.r.durationSecs || 0) < hi).length;
  const label = hi === Infinity ? lo + 's+' : lo + 's-' + hi + 's';
  console.log('  %s %s  %s', label.padEnd(10), String(n).padStart(4), '#'.repeat(Math.min(40, n)));
}

const short = ends.filter(e => (e.r.durationSecs || 0) < 30).length;
console.log('\nunder 30s: %d of %d (%d%%) — the knife-edge holds a noise margin would remove',
  short, ends.length, Math.round(100 * short / ends.length));
