'use strict';

// Where the logged "Train held" time actually went — and how much of it could have been on
// screen at all.
//
// held-report.js sums each episode's durationSecs. Before the 'closed' ending (2026-10-25)
// that was the time the ENGINE had the train flagged held, which is not the time anyone saw
// "Train held": the app shows it only on closures that have not started (the header countdown
// for the next one, closure-card.js for each upcoming card). Once the train strikes its
// protecting berth (0004 east / 0005 west) its closure is under way and its card reads
// "Closed"; once it has crossed, the card is gone. Reproduced 2026-10-25: a queued train
// stayed flagged held after its own crossing until it dropped off the merged list, so the
// 'gone' episodes (half of all logged held time, 10–19 Oct) carried time nobody saw. Logs
// written after the 'closed' ending shipped should show almost nothing outside `before`.
//
// This splits every episode against the TD log for the same train:
//   before   — start of hold → its protecting-berth strike. The ONLY part that can show.
//              An upper bound even so: a period's card carries its first train's flag.
//   down     — protecting strike → its crossing (0004→0002 / 0005→0007). Barriers down.
//   after    — after it crossed.
//   no xing  — no crossing found for that headcode within 30 min. Unsplit.
//
// Read-only. Runs from the repo root, including as a copy outside the checkout:
//   node backend/scripts/held-split.js 'backend/data/logs/2026-10-1*.jsonl'
//   node /tmp/held-split.js 'backend/data/logs/2026-10-1*.jsonl'          (from ~/rail-crossing)
// TD files are read from <held log dir>/td unless --tddir is given.

const fs = require('fs');
const path = require('path');

// The shared TD reader, so "a crossing" here is the same clear step derive-transits and the
// backtest use. Found next to this file, or under the cwd when run as a copy.
const LIB = [path.join(__dirname, 'lib', 'td-runs.js'),
  path.join(process.cwd(), 'backend', 'scripts', 'lib', 'td-runs.js'),
  path.join(process.cwd(), 'scripts', 'lib', 'td-runs.js')].find(p => fs.existsSync(p));
if (!LIB) { console.error('Cannot find scripts/lib/td-runs.js — run from the repo root.'); process.exit(2); }
const { CLEAR, readDay, listDayFiles } = require(LIB);

const argOf = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const pattern = process.argv[2];
if (!pattern || pattern.startsWith('--')) {
  console.error("Usage: node held-split.js 'backend/data/logs/2026-10-1*.jsonl' [--tddir DIR]");
  process.exit(2);
}
const dir = path.dirname(pattern);
const re = new RegExp('^' + path.basename(pattern)
  .replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => re.test(f)).sort() : [];
if (!files.length) {
  console.log("No log files matched '%s' — nothing was read.", pattern);
  process.exit(0);
}
const TDDIR = argOf('--tddir', path.join(dir, 'td'));

// Same test-pollution filter as held-report.js: a `since` days away from its file is a unit
// test writing through the real logger, not a hold.
const SANE_MS = 2 * 24 * 3600 * 1000;
const eps = [];
const days = new Set();
for (const fn of files) {
  const day = fn.replace('.jsonl', '');
  days.add(day);
  for (const line of fs.readFileSync(path.join(dir, fn), 'utf8').split('\n')) {
    if (line.indexOf('held') === -1) continue;
    let r; try { r = JSON.parse(line); } catch (e) { continue; }
    if (!r || r.cat !== 'held' || r.phase !== 'end') continue;
    const s = Date.parse(r.since);
    if (!isFinite(s) || Math.abs(s - Date.parse(day + 'T00:00:00Z')) > SANE_MS) continue;
    if (!CLEAR[r.direction]) continue;
    eps.push({ hc: r.headcode, dirn: r.direction, rule: r.reasons || '(none)', how: r.how,
               cls: r.trainClass, s, e: s + (r.durationSecs || 0) * 1000 });
  }
}
if (!eps.length) { console.log('No completed held episodes in %d file(s).', files.length); process.exit(0); }

// TD: only the two steps that matter, only for headcodes that were held. TD files roll at
// 23:00Z, so read one either side of the held window.
const want = new Set(eps.map(x => x.hc));
const sorted = [...days].sort();
const lo = new Date(Date.parse(sorted[0]) - 86400000).toISOString().slice(0, 10);
const hi = new Date(Date.parse(sorted[sorted.length - 1]) + 2 * 86400000).toISOString().slice(0, 10);
let tdFiles = [];
try { tdFiles = listDayFiles(TDDIR).filter(f => f.slice(3, 13) >= lo && f.slice(3, 13) <= hi); } catch (e) { /* none */ }
if (!tdFiles.length) { console.log('No TD files in %s for %s..%s — cannot split.', TDDIR, lo, hi); process.exit(0); }

(async () => {
  const steps = new Map();                     // headcode -> [{ t, kind: 'prot'|'xing', dirn }]
  for (const fn of tdFiles) {
    let recs; try { recs = await readDay(path.join(TDDIR, fn)); } catch (e) { continue; }
    for (const r of recs) {
      if (!want.has(r.desc)) continue;
      for (const dirn of ['east', 'west']) {
        const [prot, xing] = CLEAR[dirn];
        let kind = null;
        if (r.from === prot && r.to === xing) kind = 'xing';
        else if (r.to === prot) kind = 'prot';
        if (!kind) continue;
        if (!steps.has(r.desc)) steps.set(r.desc, []);
        steps.get(r.desc).push({ t: Date.parse(r.ts), kind, dirn });
      }
    }
  }
  for (const v of steps.values()) v.sort((a, b) => a.t - b.t);

  const WIN = 30 * 60 * 1000;
  const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)) / 1000;
  let matched = 0;
  const afterGone = [];
  for (const x of eps) {
    const v = (steps.get(x.hc) || []).filter(z => z.dirn === x.dirn);
    // The crossing this hold belongs to: the first one at or after the hold began; failing
    // that, one just before it (a hold that only started after the train had crossed).
    let xing = v.find(z => z.kind === 'xing' && z.t >= x.s && z.t <= x.e + WIN);
    if (!xing) xing = [...v].reverse().find(z => z.kind === 'xing' && z.t < x.s && x.s - z.t <= WIN);
    x.split = { before: 0, down: 0, after: 0, noxing: 0 };
    if (!xing) { x.split.noxing = (x.e - x.s) / 1000; continue; }
    matched++;
    const prot = [...v].reverse().find(z => z.kind === 'prot' && z.t <= xing.t && xing.t - z.t <= WIN);
    const p = prot ? prot.t : xing.t;
    x.split.before = overlap(x.s, x.e, -Infinity, p);
    x.split.down = overlap(x.s, x.e, p, xing.t);
    x.split.after = overlap(x.s, x.e, xing.t, Infinity);
    if (x.how === 'gone') afterGone.push(x.split.after);
  }

  const nDays = days.size;
  const fmt = s => (String(Math.round(s)) + 's').padStart(8);
  const pc = (s, tot) => ((100 * s / (tot || 1)).toFixed(0) + '%').padStart(4);
  const COLS = ['before', 'down', 'after', 'noxing'];
  function table(title, keyOf) {
    const agg = new Map();
    for (const x of eps) {
      const k = keyOf(x);
      const a = agg.get(k) || { n: 0, before: 0, down: 0, after: 0, noxing: 0 };
      a.n++; for (const c of COLS) a[c] += x.split[c];
      agg.set(k, a);
    }
    console.log('\n--- %s ---', title);
    console.log('  %s  %s  %s  %s  %s  %s', ''.padEnd(26), '   n', 'before (can show)'.padStart(17),
      'barriers down'.padStart(17), 'after crossing'.padStart(17), 'no crossing found'.padStart(17));
    const rows = [...agg.entries()].sort((a, b) =>
      COLS.reduce((t, c) => t + b[1][c], 0) - COLS.reduce((t, c) => t + a[1][c], 0));
    for (const [k, a] of rows) {
      const tot = COLS.reduce((t, c) => t + a[c], 0);
      console.log('  %s  %s  %s  %s  %s  %s', k.padEnd(26), String(a.n).padStart(4),
        ...COLS.map(c => (fmt(a[c]) + ' ' + pc(a[c], tot)).padStart(17)));
    }
  }

  const sum = c => eps.reduce((t, x) => t + x.split[c], 0);
  const all = COLS.reduce((t, c) => t + sum(c), 0);
  console.log('held files: %d (%s -> %s)   TD files: %d', files.length, files[0], files[files.length - 1], tdFiles.length);
  console.log('episodes: %d   matched to their crossing: %d (%d%%)', eps.length, matched, Math.round(100 * matched / eps.length));
  console.log('\nlogged held time:        %ss  (%s s/day)', Math.round(all), Math.round(all / nDays));
  console.log('  before protecting berth %ss  (%s s/day)  %s  <- the most that can have been on screen',
    Math.round(sum('before')), Math.round(sum('before') / nDays), pc(sum('before'), all));
  console.log('  barriers down           %ss  (%s s/day)  %s', Math.round(sum('down')), Math.round(sum('down') / nDays), pc(sum('down'), all));
  console.log('  after crossing          %ss  (%s s/day)  %s', Math.round(sum('after')), Math.round(sum('after') / nDays), pc(sum('after'), all));
  console.log('  no crossing found       %ss  (%s s/day)  %s', Math.round(sum('noxing')), Math.round(sum('noxing') / nDays), pc(sum('noxing'), all));

  table('by how it ended', x => x.how);
  table('by rule', x => x.rule);
  table('by direction + class', x => x.dirn + ' ' + x.cls);

  if (afterGone.length) {
    const s = afterGone.slice().sort((a, b) => a - b);
    console.log('\n"gone" holds, time still flagged after the train crossed: median %ss, 90th pct %ss (n=%d)',
      Math.round(s[s.length >> 1]), Math.round(s[Math.floor(s.length * 0.9)]), s.length);
  }
})();
