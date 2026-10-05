#!/usr/bin/env node
'use strict';
/**
 * Backtest candidate transit predictors against historical TD running.
 *
 *   nice -n 19 node scripts/backtest-transits.js [--cutoff 2026-07-26] [--recent 2026-09-27]
 *                                                [--csv /tmp/backtest-rows.csv] [--logdir DIR]
 *
 * Read-only. Uses lib/td-runs.js — the SAME run extraction, classification and berth-pair
 * walk that built data/transits.json — so every row scored here is a row of the live table.
 *
 * OUT OF SAMPLE. Everything is fit on runs up to --cutoff (default: the live table's own
 * generation date) and scored only on runs after it. Scoring a split table on the data it
 * was fit to would flatter the split, because more parameters always fit better in-sample.
 *
 * NO LOOK-AHEAD. "Queued" is decided from where the other trains were at the instant of the
 * strike being projected from — what the live system could actually know. The rolling mean
 * only uses transits that had COMPLETED before the strike it predicts from.
 *
 * PREDICTORS (each predicts a row's transit, from a strike at the row's FROM berth)
 *   BASE     the row's median — what production does today
 *   QSPLIT   the row's median conditioned on queued-at-strike (#1). Falls back to BASE when
 *            the conditioned cell is thinner than n=15, the table's own rule.
 *   ROLL5    mean of the last 5 completed transits of the same row (Rich's idea 2)
 *   SHRINK   BASE + w x (ROLL5 - BASE), w fit per direction on the training window (#3)
 *   INFLATE  BASE + 1 sd — Rich's idea 1 taken literally, to measure the cost claimed for it
 *
 * ERROR = actual - predicted. NEGATIVE = the train arrived SOONER than predicted, i.e. the
 * barrier comes down before the app says: the unsafe side, reported as "early>30s".
 *
 * HOLD SIMULATIONS (test window, train-seconds, as held-report.js counts them)
 *   S1  the close countdown as live: projection from each berth to the class's close ANCHOR,
 *       held once now > strike + prediction + k x sd, until the next strike. k is #2's grace.
 *       S1 BASE k=0 over --recent should resemble held-report.js's unstruck+upstream rate —
 *       that is the check that this simulator describes the live system.
 *   S2  the same, projecting to the CROSSING from every berth, anchor or not — the view in
 *       which a queued train's lost time shows up, and so the one #1 is judged on.
 */
const fs = require('fs');
const path = require('path');
const { CHAIN, XING, ORDER, runsByDay, pairsOf, median, sd } = require('./lib/td-runs');

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const LOGDIR = argOf('--logdir', path.join(__dirname, '..', 'data', 'logs', 'td'));
const CUTOFF = argOf('--cutoff', '2026-07-26');
const RECENT = argOf('--recent', '2026-09-27');
const CSV = argOf('--csv', null);
const TABLE = argOf('--table', path.join(__dirname, '..', 'data', 'transits.json'));
const CONFIG = argOf('--config', path.join(__dirname, '..', 'config', 'crossings.json'));
const MIN_N = 15;
const STRIKE_TTL_MS = 20 * 60 * 1000;     // crossing-state CLOSE_STRIKE_TTL_MS
const KS = [0, 0.5, 1, 1.5, 2, 3];

const anchors = (() => {
  const ct = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).portslade.timing.closeTrigger;
  const a = {};
  for (const d of ['east', 'west']) {
    a[d] = {};
    for (const [cls, spec] of Object.entries((ct[d] && ct[d].classes) || {})) if (spec.berth) a[d][cls] = spec.berth;
  }
  return a;
})();

const pct = (v, p) => { if (!v.length) return NaN; const s = v.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f0 = x => (isFinite(x) ? String(Math.round(x)) : '-');
const f1 = x => (isFinite(x) ? x.toFixed(1) : '-');
const f2 = x => (isFinite(x) ? x.toFixed(2) : '-');
// Node's console.log takes %s/%d but not widths, so columns are padded by hand.
// Negative width = left-aligned.
const out = cells => console.log('  ' + cells.map(([v, w]) => (w < 0 ? String(v).padEnd(-w) : String(v).padStart(w))).join(' '));

(async () => {
  // ---------------------------------------------------------------- load every run
  const runs = [];
  for await (const day of runsByDay(LOGDIR)) for (const r of day.runs) { r.day = day.day; runs.push(r); }
  if (!runs.length) { console.error('No runs found under', LOGDIR); process.exit(2); }

  // ---------------------------------------------------------------- queued-at-strike
  // Mirrors crossing-state._blockedByAhead: a same-direction train further along the chain
  // (fresh within the strike TTL), or standing on the crossing berth, at the instant of the
  // strike. Only trains that completed a run are visible here — a train that never crossed
  // (terminated, reversed) is in liveTrains but not in this list, so this slightly UNDER-counts.
  const byDir = { east: [], west: [] };
  for (const r of runs) byDir[r.dirn].push(r);
  for (const d of ['east', 'west']) byDir[d].sort((a, b) => a.xt - b.xt);
  const lowerBound = (arr, t) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].xt < t) lo = m + 1; else hi = m; } return lo; };
  // Same-direction runs that could be in the way at any instant in [from, to] — the window the
  // live test would look across, widened to cover a whole approach so it is found once per run.
  const candidates = (run, from, to) => {
    const arr = byDir[run.dirn], out = [];
    for (let i = lowerBound(arr, from - 30 * 60000); i < arr.length && arr[i].xt <= to + 30 * 60000; i++) if (arr[i] !== run) out.push(arr[i]);
    return out;
  };
  // HOW MANY BERTHS AHEAD the nearest same-direction train is, for a train at chain index myIdx at
  // time t; Infinity when nothing is in the way. The crossing berth (0002 east / 0007 west) counts
  // as one step past the last chain berth. "Queued" under today's live rule is simply < Infinity,
  // so N = any reproduces the old yes/no exactly; a distance limit N is <= N.
  function nearestAhead(run, myIdx, t, cands) {
    const chain = CHAIN[run.dirn], xIdx = chain.length;
    let best = Infinity;
    for (const o of cands) {
      if (o.xt < t - 30 * 60000 || o.xt > t + 30 * 60000) continue;
      if (t >= o.xt) {
        const left = o.outTs !== null ? o.outTs : o.xt + 120000;
        if (t < left) best = Math.min(best, xIdx - myIdx);   // on the crossing berth: in the way
        continue;
      }
      let idx = -1, seen = 0;
      for (let j = 0; j < chain.length; j++) { const s = o.ins[chain[j]]; if (s !== undefined && s <= t) { idx = j; seen = s; } }
      if (idx > myIdx && t - seen <= STRIKE_TTL_MS) best = Math.min(best, idx - myIdx);
    }
    return best;
  }
  for (const r of runs) {
    r.q = {}; r.ahead = {};
    const strikes = CHAIN[r.dirn].filter(b => r.ins[b] !== undefined).map(b => r.ins[b]);
    r.cands = candidates(r, Math.min(...strikes), r.xt);
    CHAIN[r.dirn].forEach((b, idx) => {
      if (r.ins[b] === undefined) return;
      r.ahead[b] = nearestAhead(r, idx, r.ins[b], r.cands);
      r.q[b] = r.ahead[b] < Infinity;
    });
    if (r.day <= CUTOFF) r.cands = null;      // only the test window's hold simulation needs it again
  }

  // ---------------------------------------------------------------- samples
  // One per (run, row). `at` = the strike predicted FROM, `done` = when the transit completed.
  // Lean on purpose: ~30k runs x up to 28 pairs on a 1 GB box that is also serving the live app.
  // r.samp indexes only the pairs the hold simulations look up — those ending at the crossing or
  // at the run's own close anchor — rather than all of them.
  const samples = [];
  for (const r of runs) {
    r.samp = {};
    const anchor = anchors[r.dirn][r.cls];
    for (const p of pairsOf(r)) {
      const smp = { dirn: r.dirn, cls: r.cls, key: p.key, to: p.to, ahead: r.ahead[p.from],
        secs: p.secs, at: r.ins[p.from], done: r.ins[p.to], q: !!r.q[p.from], train: r.day <= CUTOFF };
      samples.push(smp);
      if (p.to === XING || p.to === anchor) r.samp[p.key] = smp;
    }
  }
  const rowKey = s => `${s.dirn}|${s.cls}|${s.key}`;

  // ---------------------------------------------------------------- fit on training only
  const groups = new Map();
  const push = (k, v) => { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(v); };
  for (const s of samples) if (s.train) { push(rowKey(s), s.secs); push(rowKey(s) + '|q' + (s.q ? 1 : 0), s.secs); }
  const fit = new Map();
  for (const [k, v] of groups) if (v.length >= MIN_N) fit.set(k, { med: median(v), sd: sd(v), n: v.length });

  // ROLL5: per row, transits ordered by completion; for each sample, the last 5 completed
  // strictly before its own strike.
  const byRow = new Map();
  for (const s of samples) { const k = rowKey(s); if (!byRow.has(k)) byRow.set(k, []); byRow.get(k).push(s); }
  for (const list of byRow.values()) {
    const comp = list.slice().sort((a, b) => a.done - b.done);
    const doneT = comp.map(s => s.done);
    for (const s of list) {
      let lo = 0, hi = doneT.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (doneT[m] < s.at) lo = m + 1; else hi = m; }
      const win = comp.slice(Math.max(0, lo - 5), lo).map(x => x.secs);
      s.roll5 = win.length ? win.reduce((a, b) => a + b, 0) / win.length : null;
    }
  }

  // SHRINK weight per direction: least squares of residual on rolling deviation, training only.
  const W = {};
  for (const d of ['east', 'west']) {
    let sxy = 0, sxx = 0;
    for (const s of samples) {
      if (!s.train || s.dirn !== d || s.roll5 === null) continue;
      const b = fit.get(rowKey(s)); if (!b) continue;
      const x = s.roll5 - b.med, y = s.secs - b.med; sxy += x * y; sxx += x * x;
    }
    W[d] = sxx ? Math.max(0, Math.min(1, sxy / sxx)) : 0;
  }

  const predict = {
    BASE: s => { const b = fit.get(rowKey(s)); return b ? b.med : null; },
    QSPLIT: s => { const c = fit.get(rowKey(s) + '|q' + (s.q ? 1 : 0)); if (c) return c.med; const b = fit.get(rowKey(s)); return b ? b.med : null; },
    ROLL5: s => { const b = fit.get(rowKey(s)); if (!b) return null; return s.roll5 !== null ? s.roll5 : b.med; },
    SHRINK: s => { const b = fit.get(rowKey(s)); if (!b) return null; return s.roll5 !== null ? b.med + W[s.dirn] * (s.roll5 - b.med) : b.med; },
    INFLATE: s => { const b = fit.get(rowKey(s)); return b ? b.med + b.sd : null; }
  };
  const spread = {   // the sd a grace is measured in, matched to the predictor's own cell
    BASE: s => { const b = fit.get(rowKey(s)); return b ? b.sd : null; },
    QSPLIT: s => { const c = fit.get(rowKey(s) + '|q' + (s.q ? 1 : 0)); if (c) return c.sd; const b = fit.get(rowKey(s)); return b ? b.sd : null; },
    ROLL5: s => { const b = fit.get(rowKey(s)); return b ? b.sd : null; },
    SHRINK: s => { const b = fit.get(rowKey(s)); return b ? b.sd : null; }
  };
  const NAMES = ['BASE', 'QSPLIT', 'ROLL5', 'SHRINK', 'INFLATE'];
  const LABEL = { BASE: 'BASE    median (today)', QSPLIT: '#1 QSPLIT queued/clear', ROLL5: '#3 ROLL5 last-5 mean ',
    SHRINK: '#3 SHRINK blended     ', INFLATE: 'idea-1 literal +1 sd  ' };

  const test = samples.filter(s => !s.train && fit.get(rowKey(s)));
  const trainRuns = runs.filter(r => r.day <= CUTOFF), testRuns = runs.filter(r => r.day > CUTOFF);
  const days = rs => new Set(rs.map(r => r.day)).size;

  // ---------------------------------------------------------------- header + consistency
  console.log('BACKTEST — train <= %s: %d days, %d runs | test > %s: %d days, %d runs',
    CUTOFF, days(trainRuns), trainRuns.length, CUTOFF, days(testRuns), testRuns.length);
  for (const d of ['east', 'west']) {
    const tr = trainRuns.filter(r => r.dirn === d), te = testRuns.filter(r => r.dirn === d);
    const qShare = rs => { let n = 0, q = 0; for (const r of rs) for (const b in r.q) { n++; if (r.q[b]) q++; } return n ? 100 * q / n : NaN; };
    console.log('  %s: %d train / %d test runs; strikes made while queued: %s%% train, %s%% test',
      d, tr.length, te.length, f1(qShare(tr)), f1(qShare(te)));
  }
  try {
    const live = JSON.parse(fs.readFileSync(TABLE, 'utf8')).portslade;
    const diffs = [];
    for (const d of Object.keys(live)) for (const cls of Object.keys(live[d])) for (const key of Object.keys(live[d][cls])) {
      const b = fit.get(`${d}|${cls}|${key}`); if (b) diffs.push(Math.abs(Math.round(b.med) - live[d][cls][key].secs));
    }
    console.log('consistency: refit BASE vs %s over %d cells — median |diff| %ss, max %ss %s',
      path.basename(TABLE), diffs.length, f0(median(diffs)), f0(Math.max(...diffs)),
      Math.max(...diffs) <= 3 ? '(matches the live table)' : '(differs)');
    if (Math.max(...diffs) > 3) {
      console.log('  The live table was built from every TD file up to its generation date. A mismatch here means the');
      console.log('  training window is not the same set of files (some rotated away, or a different --cutoff), so BASE');
      console.log('  below is a close stand-in for production rather than production itself. Every predictor is fit on');
      console.log('  the SAME window, so the comparison between them is unaffected.');
    }
  } catch (e) { console.log('consistency: no live table to compare (%s)', e.message); }

  // ---------------------------------------------------------------- 1. accuracy
  const score = (list, name) => {
    const errs = []; for (const s of list) { const p = predict[name](s); if (p !== null) errs.push(s.secs - p); }
    const n = errs.length; if (!n) return null;
    const abs = errs.map(Math.abs);
    return { n, mae: abs.reduce((a, b) => a + b, 0) / n, bias: errs.reduce((a, b) => a + b, 0) / n,
      p90: pct(abs, 0.9), early: 100 * errs.filter(e => e < -30).length / n, late: 100 * errs.filter(e => e > 30).length / n };
  };
  const accTable = (title, filt) => {
    console.log('\n%s', title);
    out([['', -6], ['', -24], ['n', 7], ['MAE', 6], ['bias', 6], ['p90', 5], ['early>30s', 10], ['late>30s', 9]]);
    for (const d of ['east', 'west']) {
      const list = test.filter(s => s.dirn === d && filt(s));
      for (const name of NAMES) {
        const r = score(list, name); if (!r) continue;
        out([[name === 'BASE' ? d.toUpperCase() : '', -6], [LABEL[name], -24], [r.n, 7], [f1(r.mae), 6], [f1(r.bias), 6],
          [f0(r.p90), 5], [f1(r.early) + '%', 10], [f1(r.late) + '%', 9]]);
      }
    }
  };
  console.log('\n=== 1. ACCURACY, test window. error = actual - predicted transit (s). early = train arrived >30s SOONER than predicted (unsafe side).');
  accTable('-- rows TO THE CROSSING (B>XING) — what the close and open countdowns are derived from', s => s.to === XING);
  accTable("-- rows TO EACH CLASS'S CLOSE ANCHOR (B>anchor) — what the pre-anchor close projects with", s => anchors[s.dirn][s.cls] === s.to);
  accTable('-- ALL rows of the table', () => true);

  console.log('\n-- to the crossing, split by queued-at-strike (the split #1 makes)');
  out([['', -13], ['', -24], ['n', 7], ['MAE', 6], ['bias', 6], ['p90', 5], ['early>30s', 10]]);
  for (const d of ['east', 'west']) for (const q of [true, false]) {
    const list = test.filter(s => s.dirn === d && s.to === XING && s.q === q);
    for (const name of ['BASE', 'QSPLIT']) {
      const r = score(list, name); if (!r) continue;
      out([[name === 'BASE' ? `${d} ${q ? 'queued' : 'clear'}` : '', -13], [LABEL[name], -24], [r.n, 7], [f1(r.mae), 6],
        [f1(r.bias), 6], [f0(r.p90), 5], [f1(r.early) + '%', 10]]);
    }
  }

  // ---------------------------------------------------------------- 2. premise for #3
  console.log('\n=== 2. PREMISE FOR #3 — do consecutive trains on the same row run alike?');
  console.log('  lag-1 correlation of BASE residuals (z-scored per row), test window. ~0 = independent: a rolling mean only adds noise.');
  for (const d of ['east', 'west']) {
    const all = [], near = [];
    for (const [k, list] of byRow) {
      if (!k.startsWith(d + '|')) continue;
      const b = fit.get(k); if (!b || !b.sd) continue;
      const ts = list.filter(s => !s.train).sort((a, c) => a.at - c.at);
      for (let i = 1; i < ts.length; i++) {
        const pair = [(ts[i - 1].secs - b.med) / b.sd, (ts[i].secs - b.med) / b.sd];
        all.push(pair); if (ts[i].at - ts[i - 1].at <= 3600000) near.push(pair);
      }
    }
    const corr = ps => { const n = ps.length; if (n < 3) return NaN;
      const mx = ps.reduce((a, p) => a + p[0], 0) / n, my = ps.reduce((a, p) => a + p[1], 0) / n;
      let sxy = 0, sxx = 0, syy = 0; for (const [x, y] of ps) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
      return sxy / Math.sqrt(sxx * syy); };
    console.log('  %s: r = %s over %d pairs | within 60 min: r = %s over %d pairs | SHRINK weight fit on training: w = %s',
      d, f2(corr(all)), all.length, f2(corr(near)), near.length, f2(W[d]));
  }

  // ---------------------------------------------------------------- 3/4. hold simulations
  const testDays = days(testRuns), recentRuns = testRuns.filter(r => r.day >= RECENT), recentDays = days(recentRuns);
  // Walk a run's struck berths in order; for each step the run spent at berth B before its next
  // strike, project from B to `target` and charge held/soon time against that stay.
  function simulate(run, target, name, k) {
    const order = ORDER[run.dirn];
    const struck = order.filter(b => run.ins[b] !== undefined);
    const tIdx = order.indexOf(target);
    const out = { eps: 0, held: 0, soon: 0, wasted: 0, heldQ: 0, heldC: 0 };
    for (let i = 0; i + 1 < struck.length; i++) {
      const B = struck[i], next = struck[i + 1];
      if (order.indexOf(B) >= tIdx) break;
      const s = run.samp[`${B}>${target}`];             // the real sample: its own roll5 and queued flag
      if (!s) continue;
      const p = predict[name](s), sdv = spread[name](s);
      if (p === null || sdv === null || !isFinite(p)) continue;
      const due = run.ins[B] + p * 1000, expiry = due + k * sdv * 1000, left = run.ins[next];
      const held = Math.max(0, left - expiry) / 1000;
      const soon = Math.max(0, Math.min(left, expiry) - due) / 1000;
      out.soon += soon;
      if (held > 0) { out.eps++; out.held += held; out.wasted += soon; if (s.q) out.heldQ += held; else out.heldC += held; }
    }
    return out;
  }
  const holdTable = (title, targetOf, runSet, nDays, names, ks, showQ) => {
    console.log('\n%s', title);
    out([['', -6], ['', -24], ['k', 4], ['held eps/d', 11], ['held s/d', 9], ['soon s/d', 9], ['wasted', 7]]
      .concat(showQ ? [['held s/d: queued', 17], ['clear', 7]] : []));
    for (const d of ['east', 'west']) {
      let first = true;
      for (const name of names) for (const k of (Array.isArray(ks) ? ks : ks[name])) {
        const kk = Array.isArray(ks) ? ks : ks[name];
        const tot = { eps: 0, held: 0, soon: 0, wasted: 0, heldQ: 0, heldC: 0 };
        for (const r of runSet) {
          if (r.dirn !== d) continue;
          const tg = targetOf(r); if (!tg || r.ins[tg] === undefined) continue;
          const o = simulate(r, tg, name, k); for (const x in tot) tot[x] += o[x];
        }
        out([[first ? d.toUpperCase() : '', -6], [k === kk[0] ? LABEL[name] : '', -24], [f1(k), 4],
          [f1(tot.eps / nDays), 11], [f0(tot.held / nDays), 9], [f0(tot.soon / nDays), 9], [f0(tot.wasted / nDays), 7]]
          .concat(showQ ? [[f0(tot.heldQ / nDays), 17], [f0(tot.heldC / nDays), 7]] : []));
        first = false;
      }
    }
  };
  console.log('\n=== 3. HOLDS — S1, the close countdown as live (projection to the class anchor). Train-seconds per day.');
  console.log('  k = #2\'s grace, in sd of the projected row. "soon" = time past the prediction but inside the grace, when');
  console.log('  the countdown reads "any moment now". "wasted" = the part of that spent on a train that then went held anyway:');
  console.log('  "any moment now" shown for a train that was actually stopped. That is what a larger k costs.');
  holdTable(`-- test window (${testDays} days)`, r => anchors[r.dirn][r.cls], testRuns, testDays,
    ['BASE', 'QSPLIT', 'ROLL5', 'SHRINK'], { BASE: KS, QSPLIT: [0, 1, 2], ROLL5: [0, 1, 2], SHRINK: [0, 1, 2] }, false);
  if (recentDays) holdTable(`-- since ${RECENT} (${recentDays} days): BASE k=0 here is the one to set beside held-report.js unstruck+upstream`,
    r => anchors[r.dirn][r.cls], recentRuns, recentDays, ['BASE'], [0], false);

  console.log('\n=== 4. HOLDS — S2, projecting to the CROSSING from every berth (anchor or not), split by queued-at-strike.');
  console.log('  This is where a queued train\'s lost time lands, so it is the view #1 is judged on. Today queued trains are');
  console.log('  instead held for their WHOLE queue by a separate rule (queuedBound) — held-report.js shows that cost directly.');
  holdTable(`-- test window (${testDays} days)`, () => XING, testRuns, testDays, ['BASE', 'QSPLIT'], [0, 1, 2], true);

  // ---------------------------------------------------------------- 5. per row
  // Every row the app actually projects with: to the crossing from each berth, and to each
  // class's close anchor. Rows thinner than 30 test samples are marked — a winner there is noise.
  console.log('\n=== 5. PER ROW — every row the app projects with (to the crossing, and to the class anchor). Test-window MAE (s).');
  out([['', -5], ['class', -14], ['row', -10], ['use', -7], ['test n', 7], ['BASE', 6], ['QSPLIT', 7], ['ROLL5', 6],
    ['SHRINK', 7], ['best', -7], ['vs BASE', 8]]);
  const chainPos = (d, k) => { const [a, b] = k.split('>'); return ORDER[d].indexOf(b) * 100 + ORDER[d].indexOf(a); };
  const rowsUsed = [...byRow.keys()].filter(k => {
    const [d, cls, key] = k.split('|'), to = key.split('>')[1];
    return fit.get(k) && (to === XING || anchors[d][cls] === to);
  }).sort((a, b) => {
    const [da, ca, ka] = a.split('|'), [db, cb, kb] = b.split('|');
    return da !== db ? (da < db ? -1 : 1) : ca !== cb ? (ca < cb ? -1 : 1) : chainPos(da, ka) - chainPos(db, kb);
  });
  for (const k of rowsUsed) {
    const [d, cls, key] = k.split('|'), to = key.split('>')[1];
    const tl = byRow.get(k).filter(x => !x.train);
    const sc = {}; for (const n of ['BASE', 'QSPLIT', 'ROLL5', 'SHRINK']) { const r = score(tl, n); sc[n] = r ? r.mae : NaN; }
    const best = ['QSPLIT', 'ROLL5', 'SHRINK'].reduce((m, n) => (sc[n] < sc[m] ? n : m), 'BASE');
    out([[d, -5], [cls, -14], [key, -10], [to === XING ? 'xing' : 'anchor', -7], [tl.length + (tl.length < 30 ? '*' : ''), 7],
      [f1(sc.BASE), 6], [f1(sc.QSPLIT), 7], [f1(sc.ROLL5), 6], [f1(sc.SHRINK), 7], [best, -7],
      [best === 'BASE' ? '' : (sc[best] - sc.BASE > 0 ? '+' : '') + f1(sc[best] - sc.BASE), 8]]);
  }
  console.log('  * fewer than 30 test samples: treat that row\'s winner as noise.');

  // ---------------------------------------------------------------- 6. queue sweep
  // Which definition of "queued" picks out the trains a leader actually slows? Today's live rule
  // (_blockedByAhead) counts ANY same-direction train anywhere further along the chain. C20
  // measured its 77s penalty on a much tighter group: pairs close enough to merge. Here the
  // train ahead only counts if it is at most N berths ahead, and each N is judged three ways.
  const NS = [1, 2, 3, 4, Infinity];
  const nLabel = N => (N === Infinity ? 'any' : 'N=' + N);
  // `ahead` is Infinity when nothing is in the way, and Infinity <= Infinity is true — so the
  // comparison is never written bare. Under N = any this is exactly the old yes/no.
  const isQ = (ahead, N) => ahead !== Infinity && ahead <= N;
  console.log('\n=== 6. QUEUE SWEEP — which definition of "queued" picks out the trains a leader actually slows?');
  console.log('  N: the train ahead only counts if it is at most N berths ahead; the crossing berth (0002 east / 0007');
  console.log('  west) is one step past the last chain berth. "any" is today\'s live rule (_blockedByAhead).');

  // 6a ------------------------------------------------------------------------------------
  // By EXACT distance, not "within N": a cumulative median hides dilution until the delayed trains
  // fall below half the group, so it cannot show where the delay stops. Each distance is compared
  // with trains that had nothing ahead at all. N is then the furthest distance that still pays.
  console.log('\n-- 6a. Queue penalty BY DISTANCE on the row that sets each class\'s close (anchor -> crossing), training window.');
  console.log('  "none ahead" = median with no train in the way. Each distance: its median minus that, then n and the');
  console.log('  share of the class\'s anchor strikes at that distance. "-" = under 15 trains, too thin to read.');
  const DIST = [[1, 1], [2, 2], [3, 3], [4, Infinity]];
  out([['', -5], ['class', -14], ['row', -10], ['none ahead', 14]].concat(DIST.map(([a]) => [a === 4 ? '4+ ahead' : `${a} ahead`, 17])));
  for (const d of ['east', 'west']) {
    for (const [cls, A] of Object.entries(anchors[d])) {
      const rs = trainRuns.filter(r => r.dirn === d && r.cls === cls && r.ins[A] !== undefined)
        .map(r => ({ secs: (r.xt - r.ins[A]) / 1000, ahead: r.ahead[A] })).filter(x => x.secs > 0 && x.secs <= 1800);
      if (!rs.length) continue;
      const none = rs.filter(x => x.ahead === Infinity).map(x => x.secs);
      const base = none.length >= MIN_N ? median(none) : NaN;
      const cells = DIST.map(([lo, hi]) => {
        const g = rs.filter(x => x.ahead !== Infinity && x.ahead >= lo && x.ahead <= hi).map(x => x.secs);
        const share = f0(100 * g.length / rs.length) + '%';
        if (g.length < MIN_N || !isFinite(base)) return [g.length ? `- n${g.length}` : '', 17];
        const gap = median(g) - base;
        return [`${gap >= 0 ? '+' : ''}${f0(gap)}s n${g.length} ${share}`, 17];
      });
      out([[d, -5], [cls, -14], [`${A}>XING`, -10], [isFinite(base) ? `${f0(base)}s n${none.length}` : '-', 14]].concat(cells));
    }
  }

  // 6b ------------------------------------------------------------------------------------
  // QSPLIT at each N, rows to the crossing, fit on training and scored on test exactly as section 1.
  const xTrain = samples.filter(x => x.train && x.to === XING), xTest = test.filter(x => x.to === XING);
  const fitN = new Map();
  for (const N of NS) {
    const g = new Map();
    for (const x of xTrain) { const k = `${rowKey(x)}|${N}|${isQ(x.ahead, N) ? 1 : 0}`; if (!g.has(k)) g.set(k, []); g.get(k).push(x.secs); }
    for (const [k, v] of g) if (v.length >= MIN_N) fitN.set(k, median(v));
  }
  const predN = (x, N) => { const v = fitN.get(`${rowKey(x)}|${N}|${isQ(x.ahead, N) ? 1 : 0}`); return v !== undefined ? v : fit.get(rowKey(x)).med; };
  const errStats = (list, pf) => {
    const e = list.map(x => x.secs - pf(x)); const n = e.length; if (!n) return null;
    return { n, mae: e.reduce((a, b) => a + Math.abs(b), 0) / n, bias: e.reduce((a, b) => a + b, 0) / n,
      early: 100 * e.filter(v => v < -30).length / n };
  };
  const split6b = (title, rowFilter) => {
    console.log('\n' + title);
    out([['', -5], ['', -10], ['flagged', 8], ['queued n', 9], ['MAE', 6], ['bias', 6], ['early', 7],
      ['clear n', 8], ['MAE', 6], ['bias', 6], ['early', 7], ['all MAE', 8]]);
    for (const d of ['east', 'west']) {
      const lst = xTest.filter(x => x.dirn === d && rowFilter(x));
      if (!lst.length) continue;
      const b = errStats(lst, x => fit.get(rowKey(x)).med);
      out([[d.toUpperCase(), -5], ['BASE', -10], ['', 8], ['', 9], ['', 6], ['', 6], ['', 7], ['', 8], ['', 6], ['', 6], ['', 7], [f1(b.mae), 8]]);
      for (const N of NS) {
        const pf = x => predN(x, N);
        const q = errStats(lst.filter(x => isQ(x.ahead, N)), pf), c = errStats(lst.filter(x => !isQ(x.ahead, N)), pf), a = errStats(lst, pf);
        const cell = (r, w) => (r ? [[r.n, w], [f1(r.mae), 6], [f1(r.bias), 6], [f1(r.early) + '%', 7]] : [['-', w], ['', 6], ['', 6], ['', 7]]);
        out([['', -5], ['QSPLIT ' + (N === Infinity ? 'any' : N), -10], [f1(100 * (q ? q.n : 0) / lst.length) + '%', 8]]
          .concat(cell(q, 9), cell(c, 8), [[f1(a.mae), 8]]));
      }
    }
  };
  console.log('\n-- 6b. Split prediction to the crossing at each N, test window. Error in s; early = unsafe-miss %;');
  console.log('  flagged = share of these predictions made while the definition called the train queued.');
  split6b('   from each class\'s ANCHOR (the row that sets the close; the queue state is read where it matters)',
    x => x.key === `${anchors[x.dirn][x.cls]}>${XING}`);
  split6b('   from EVERY berth (a queue read far out says little about the queue at the anchor)', () => true);

  // 6c ------------------------------------------------------------------------------------
  // "Train held" the queued rule would produce at each N. Every 10 s through each approach — from
  // the first chain strike until the train crosses — ask what the live rule asks:
  //   queued now     a train within N berths ahead at this instant (_blockedByAhead), and
  //   cleared ahead  C20's second half (_crossedAheadSinceStrike): once a train ahead performs its
  //                  clear step after this train's anchor strike, held until this train crosses.
  //                  For finite N it only applies if the train was within N at its anchor strike —
  //                  the stale-anchor problem it guards against only arises for a train queued then.
  // The 'any' total over --recent is the check: it should sit near held-report.js's queued +
  // queued+unstruck seconds per day. If it does not, this section is not describing the live rule.
  const STEP = 10000;
  function queueHeld(run) {
    const chain = CHAIN[run.dirn], st = chain.map(b => run.ins[b]);
    const first = Math.min(...st.filter(x => x !== undefined));
    const A = anchors[run.dirn][run.cls];
    let caStart = Infinity;
    if (A && run.ins[A] !== undefined) {
      for (const o of run.cands) if (o.xt > run.ins[A] && o.xt < run.xt && o.xt < caStart) caStart = o.xt;
    }
    const aheadAtAnchor = A && run.ins[A] !== undefined ? run.ahead[A] : Infinity;
    const res = NS.map(() => ({ now: 0, ca: 0 }));
    for (let t = first; t < run.xt; t += STEP) {
      let myIdx = -1;
      for (let j = 0; j < st.length; j++) if (st[j] !== undefined && st[j] <= t) myIdx = j;
      const steps = (myIdx >= 0 && t - st[myIdx] <= STRIKE_TTL_MS) ? nearestAhead(run, myIdx, t, run.cands) : Infinity;
      NS.forEach((N, i) => {
        if (isQ(steps, N)) res[i].now += STEP / 1000;
        else if (t >= caStart && isQ(aheadAtAnchor, N)) res[i].ca += STEP / 1000;
      });
    }
    return res;
  }
  console.log('\n-- 6c. "Train held" the queued rule would produce at each N — train-seconds per day, checked every 10 s.');
  console.log('  queued now = a train within N berths ahead at that moment; cleared ahead = C20\'s second half (held until');
  console.log('  it crosses once a train ahead clears after its anchor strike), for trains within N at that strike.');
  // Totalled as it goes rather than kept per run: this box is also serving the live app.
  const tot = { east: NS.map(() => ({ now: 0, ca: 0, rec: 0 })), west: NS.map(() => ({ now: 0, ca: 0, rec: 0 })) };
  for (const r of testRuns) {
    const h = queueHeld(r), isRecent = r.day >= RECENT;
    h.forEach((x, i) => { const T = tot[r.dirn][i]; T.now += x.now; T.ca += x.ca; if (isRecent) T.rec += x.now + x.ca; });
  }
  out([['', -5], ['', -5], ['queued now', 11], ['cleared ahead', 14], ['total', 8], ['', 4], [`since ${RECENT}`, 17]]);
  const both = NS.map(() => 0);
  for (const d of ['east', 'west']) {
    NS.forEach((N, i) => {
      const { now, ca, rec } = tot[d][i];
      both[i] += rec;
      out([[i === 0 ? d.toUpperCase() : '', -5], [N === Infinity ? 'any' : String(N), -5], [f0(now / testDays), 11],
        [f0(ca / testDays), 14], [f0((now + ca) / testDays), 8], ['', 4], [recentDays ? f0(rec / recentDays) : '-', 17]]);
    });
  }
  if (recentDays) {
    console.log('  BOTH directions since %s: %s train-s/day under today\'s rule (any). Set that beside held-report.js:',
      RECENT, f0(both[NS.length - 1] / recentDays));
    console.log('  its queued + queued+unstruck seconds divided by its days. Same ballpark = this simulates the live rule.');
    console.log('  At each N, the share of that left:  ' + NS.map((N, i) => `${nLabel(N)} ${f0(100 * both[i] / (both[NS.length - 1] || 1))}%`).join('  '));
  }

  // ---------------------------------------------------------------- CSV
  if (CSV) {
    const lines = ['dirn,class,row,to_anchor,to_xing,train_n,base_med,base_sd,q_med,c_med,test_n,' +
      NAMES.map(n => `${n}_mae,${n}_bias`).join(',')];
    for (const [k, list] of [...byRow.entries()].sort()) {
      const b = fit.get(k); if (!b) continue;
      const [d, cls, key] = k.split('|'), to = key.split('>')[1];
      const tl = list.filter(s => !s.train);
      const qm = fit.get(k + '|q1'), cm = fit.get(k + '|q0');
      const cols = NAMES.map(n => { const r = score(tl, n); return r ? `${f1(r.mae)},${f1(r.bias)}` : ','; });
      lines.push([d, cls, key, anchors[d][cls] === to ? 1 : 0, to === XING ? 1 : 0, b.n, f0(b.med), f0(b.sd),
        qm ? f0(qm.med) : '', cm ? f0(cm.med) : '', tl.length].concat(cols).join(','));
    }
    fs.writeFileSync(CSV, lines.join('\n') + '\n');
    console.log('\nper-row detail: %d rows -> %s', lines.length - 1, CSV);
  }
})().catch(e => { console.error(e); process.exit(1); });
