'use strict';

// `how:"gone"` holds — did the train actually cross, or never run?
//
// A held close ends one of two ways. `released` is the train moving: the anchor struck, or the
// road ahead cleared. `gone` is the train leaving the merged list at the 3-minute sighting grace
// with the hold never released — the user saw "Train held" for several minutes and then the
// closure vanished. Over 2026-10-10..19 those were 8% of episodes but 52.8% of all held time.
//
// Which of two things happened decides how much it matters, and the two are opposite:
//   never crossed  -> a closure we showed that was never going to happen       (goal 2)
//   crossed anyway -> a real closure shown late, or dropped before it happened (goal 1, top)
//
// The discriminator is physical: the crossing clear step in the TD log, east 0004->0002 and west
// 0005->0007 (config td.<dir>.clear). For each gone episode we look for that headcode's next
// clear step and report the gap from the moment the hold ended.
//
// READ-ONLY. Touches no running state, writes nothing, and takes both logs as globs:
//
//   node backend/scripts/gone-holds.js 'backend/data/logs/2026-10-1*.jsonl' \
//                                      'backend/data/logs/td/td-2026-10-*.jsonl*'
//   node backend/scripts/gone-holds.js --self-test
//
// Run it from ~/rail-crossing; the globs are resolved relative to the current folder.
// Pass the TD glob with a trailing * — files older than about a week are gzipped, and a plain
// `*.jsonl` silently reads only the last few days. That alone turned a ten-day count into two.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// td.<dir>.clear for Portslade. Read from the config so a berth change cannot silently
// invalidate this script, with the shipped pair as the answer we expect to get.
function clearPairs() {
  const cfgPath = path.join(__dirname, '..', 'config', 'crossings.json');
  const td = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).portslade.td;
  return [
    { direction: 'east', from: td.eastbound.clear.from, to: td.eastbound.clear.to },
    { direction: 'west', from: td.westbound.clear.from, to: td.westbound.clear.to },
  ];
}

function expand(pattern) {
  const dir = path.dirname(pattern);
  const base = path.basename(pattern);
  const rx = new RegExp('^' + base.split('*').map(s =>
    s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter(n => rx.test(n)).sort().map(n => path.join(dir, n));
}

function* lines(file) {
  const raw = file.endsWith('.gz')
    ? zlib.gunzipSync(fs.readFileSync(file))
    : fs.readFileSync(file);
  for (const l of raw.toString('utf8').split('\n')) {
    const t = l.trim();
    if (t.startsWith('{')) { try { yield JSON.parse(t); } catch { /* skip */ } }
  }
}

// The gone episodes, and every crossing clear step, from whatever the globs matched.
function load(heldGlob, tdGlob) {
  const pairs = clearPairs();
  const gone = [], clears = [];
  for (const f of expand(heldGlob)) {
    for (const r of lines(f)) {
      if (r.cat === 'held' && r.phase === 'end' && r.how === 'gone') gone.push(r);
    }
  }
  for (const f of expand(tdGlob)) {
    for (const r of lines(f)) {
      const p = pairs.find(x => r.from === x.from && r.to === x.to);
      if (p) clears.push({ headcode: r.desc, ts: Date.parse(r.ts), direction: p.direction });
    }
  }
  clears.sort((a, b) => a.ts - b.ts);
  return { gone, clears };
}

// Did this train cross, and when relative to the hold ending?
//
// Searched from `since` (when the hold STARTED), not from the end, because a train can cross
// during the hold without the hold being credited for it — that is one of the outcomes worth
// separating. Direction must match: a headcode is reused in both directions on the same day.
// Capped at 6h so a next-day working under the same headcode is not counted as this one.
const WINDOW_MS = 6 * 3600 * 1000;
function crossingFor(ep, clears) {
  const since = Date.parse(ep.since), ended = Date.parse(ep.ts);
  let best = null;
  for (const c of clears) {
    if (c.headcode !== ep.headcode) continue;
    if (c.direction !== ep.direction) continue;
    if (c.ts < since || c.ts > since + WINDOW_MS) continue;
    if (best === null || c.ts < best.ts) best = c;
  }
  return best ? { ts: best.ts, afterEndSecs: Math.round((best.ts - ended) / 1000) } : null;
}

function classify(ep, x) {
  if (!x) return 'never crossed';
  if (x.afterEndSecs < -1) return 'crossed BEFORE the hold ended';   // hold should have released
  if (x.afterEndSecs <= 180) return 'crossed within 3 min of being dropped';
  return 'crossed LATER than 3 min after being dropped';
}

function pct(n, d) { return d ? (100 * n / d).toFixed(1) + '%' : '-'; }

function report(gone, clears) {
  if (!gone.length) {
    console.log('No how:"gone" episodes in the held files matched. Check the glob, and that');
    console.log('the backend has been running 740d4fc or later (held logging starts there).');
    return;
  }
  const days = new Set(gone.map(e => e.ts.slice(0, 10))).size;
  const totSecs = gone.reduce((a, e) => a + (e.durationSecs || 0), 0);
  console.log('how:"gone" held episodes: ' + gone.length
    + '  over ' + days + ' days  (' + (gone.length / days).toFixed(1) + '/day)');
  console.log('held time in them       : ' + Math.round(totSecs / days) + ' s/day'
    + '   mean episode ' + Math.round(totSecs / gone.length) + 's');
  console.log('crossing clear steps read: ' + clears.length);
  console.log();

  const buckets = new Map();
  const rows = [];
  for (const ep of gone) {
    const x = crossingFor(ep, clears);
    const k = classify(ep, x);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push({ ep, x });
    rows.push({ ep, x, k });
  }
  console.log('WHAT ACTUALLY HAPPENED TO THE TRAIN');
  console.log('  ' + 'outcome'.padEnd(44) + 'episodes'.padStart(9) + 'share'.padStart(8)
    + 'held s/day'.padStart(12));
  const order = ['never crossed', 'crossed BEFORE the hold ended',
    'crossed within 3 min of being dropped', 'crossed LATER than 3 min after being dropped'];
  for (const k of order) {
    const b = buckets.get(k) || [];
    if (!b.length) continue;
    const s = b.reduce((a, r) => a + (r.ep.durationSecs || 0), 0);
    console.log('  ' + k.padEnd(44) + String(b.length).padStart(9)
      + pct(b.length, gone.length).padStart(8) + String(Math.round(s / days)).padStart(12));
  }
  console.log();
  console.log('  goal 1 (a REAL closure shown late or dropped) = the two "crossed ... dropped" rows');
  console.log('  goal 2 (a closure that was never going to happen) = "never crossed"');
  console.log();

  const by = (fn, label) => {
    const m = new Map();
    for (const r of rows) {
      const k = fn(r); if (!m.has(k)) m.set(k, { n: 0, crossed: 0 });
      m.get(k).n++; if (r.k !== 'never crossed') m.get(k).crossed++;
    }
    console.log(label);
    for (const [k, v] of [...m].sort((a, b) => b[1].n - a[1].n)) {
      console.log('  ' + String(k).padEnd(28) + String(v.n).padStart(5)
        + '   crossed: ' + pct(v.crossed, v.n));
    }
    console.log();
  };
  by(r => (r.ep.trainClass || '?') + ' ' + (r.ep.direction || '?'), 'BY CLASS AND DIRECTION');
  by(r => r.ep.reasons || '?', 'BY HOLD REASON');

  const late = rows.filter(r => r.k === 'crossed LATER than 3 min after being dropped')
    .sort((a, b) => b.x.afterEndSecs - a.x.afterEndSecs).slice(0, 10);
  if (late.length) {
    console.log('WORST "crossed later" cases — a real closure the app had stopped showing');
    for (const r of late) {
      console.log('  ' + new Date(r.ep.ts).toISOString() + '  ' + r.ep.headcode
        + '/' + r.ep.direction + ' ' + (r.ep.trainClass || '')
        + '  held ' + r.ep.durationSecs + 's, crossed ' + r.x.afterEndSecs + 's after it vanished');
    }
  }
}

// ---- self-test: a fixture with a planted answer -----------------------------------------
// CLAUDE.md's rule — prove the joiner finds what we put there before trusting it on real data.
// Each case plants one known outcome and we assert the classification comes back.
function selfTest() {
  const T = Date.parse('2026-10-15T08:00:00Z');
  const iso = ms => new Date(ms).toISOString();
  const ep = (hc, dir, sinceOff, endOff) => ({
    cat: 'held', phase: 'end', how: 'gone', headcode: hc, direction: dir,
    trainClass: 'stopping', reasons: 'queued', durationSecs: (endOff - sinceOff) / 1000,
    since: iso(T + sinceOff), ts: iso(T + endOff) });
  const clears = [
    { headcode: 'AAAA', direction: 'east', ts: T + 900000 },   // 300s after its hold ended
    { headcode: 'BBBB', direction: 'east', ts: T + 650000 },   // 50s after  -> within 3 min
    { headcode: 'CCCC', direction: 'east', ts: T + 400000 },   // before the hold ended
    { headcode: 'DDDD', direction: 'west', ts: T + 900000 },   // WRONG direction for the episode
    { headcode: 'EEEE', direction: 'east', ts: T + 8 * 3600000 }, // outside the 6h window
  ];
  const cases = [
    [ep('AAAA', 'east', 0, 600000), 'crossed LATER than 3 min after being dropped'],
    [ep('BBBB', 'east', 0, 600000), 'crossed within 3 min of being dropped'],
    [ep('CCCC', 'east', 0, 600000), 'crossed BEFORE the hold ended'],
    [ep('DDDD', 'east', 0, 600000), 'never crossed'],
    [ep('EEEE', 'east', 0, 600000), 'never crossed'],
    [ep('FFFF', 'east', 0, 600000), 'never crossed'],
  ];
  let pass = 0, fail = 0;
  for (const [e, want] of cases) {
    const got = classify(e, crossingFor(e, clears));
    if (got === want) { console.log('  PASS  ' + e.headcode + ' -> ' + got); pass++; }
    else { console.log('  FAIL  ' + e.headcode + ' -> ' + got + '  (wanted ' + want + ')'); fail++; }
  }
  const p = clearPairs();
  const shipped = p.find(x => x.direction === 'east');
  const ok = shipped.from === '0004' && shipped.to === '0002';
  console.log((ok ? '  PASS  ' : '  FAIL  ') + 'east clear pair read from config is 0004->0002 (got '
    + shipped.from + '->' + shipped.to + ')');
  ok ? pass++ : fail++;
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

const argv = process.argv.slice(2);
if (argv[0] === '--self-test') selfTest();
else if (argv.length < 2) {
  console.error('usage: gone-holds.js <held-glob> <td-glob>   (or --self-test)');
  console.error("  e.g. 'backend/data/logs/2026-10-1*.jsonl' 'backend/data/logs/td/td-2026-10-*.jsonl*'");
  process.exit(2);
} else {
  const { gone, clears } = load(argv[0], argv[1]);
  report(gone, clears);
}
