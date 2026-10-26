#!/usr/bin/env node
'use strict';
/**
 * Derive the berth→berth transit table that the prediction engine projects with.
 *
 *   node scripts/derive-transits.js [--days N] [--until YYYY-MM-DD] [--out data/transits.json]
 *   node scripts/derive-transits.js --queued-only --until 2026-07-26     (add/replace ONLY the
 *        queued section of the existing --out file; every other byte of it is left alone)
 *
 * QUEUED CELLS (step 2, 2026-10-26)
 * ---------------------------------
 * `portslade.queued.<dir>.<class>["B>XING"]` is the same row measured ONLY on runs that were
 * QUEUED when they struck B: a same-direction train within td.<dir>.queueMaxAhead berths
 * ahead at that instant (lib/td-runs.markAhead — the definition backtest-transits.js scored,
 * and the one crossing-state records at each live strike). A queued train's own timings are
 * not the clear-run timings: east stopping 0008>XING is +73s with the leader 1 berth ahead
 * and +41s at 2 (backtest 6a). The engine uses these to give a queued train a countdown from
 * its own median instead of a hold. Only rows to XING are kept — nothing else reads them.
 *
 * WHAT IS STORED, AND WHY ONLY THIS
 * ---------------------------------
 * Only the empirical part: how long a train of a given class takes to get from one
 * berth to another (and to the road crossing). Nothing about close or open offsets is
 * baked in. The runtime projects an anchor strike from the freshest berth using these
 * transits and then runs the EXISTING close/open logic on that projected time — so
 * re-anchoring a class or recalibrating an offset needs no regeneration here. Re-run
 * this only to fold in more observed running.
 *
 * The matrix is stored pairwise (every berth to every downstream berth, plus the
 * crossing) rather than as a single berth→crossing column, because a standard deviation
 * cannot be subtracted: the spread of 0010→0008 is not sd(0010→X) − sd(0008→X). Keeping
 * the pairs measured directly means any berth can anchor any class without regeneration.
 *
 * CLASSIFICATION mirrors crossing-state._eastClass, but is inferred from TD alone here
 * (platform dwell for "calls at Portslade", berth-0006 occupancy for "calls at
 * Southwick") because the schedule join isn't available offline. Verified equivalent:
 * the 0006 test reproduces the CIF Southwick flag with 0 mismatches in 93 runs.
 */
const fs = require('fs');
const path = require('path');
// Run extraction, classification and the berth-pair walk live in lib/td-runs.js, shared with
// backtest-transits.js so the backtest scores exactly the rows this script builds.
const { CHAIN, XING, runsByDay, listDayFiles, markAhead, pairsOf, median, sd } = require('./lib/td-runs');

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const DAYS = parseInt(argOf('--days', '0'), 10);
const OUT = argOf('--out', path.join(__dirname, '..', 'data', 'transits.json'));
const LOGDIR = argOf('--logdir', path.join(__dirname, '..', 'data', 'logs', 'td'));
const UNTIL = argOf('--until', null);
const QUEUED_ONLY = args.includes('--queued-only');
const CONFIG = argOf('--config', path.join(__dirname, '..', 'config', 'crossings.json'));

// NAMING WARNING. `XING` is NOT a synthetic mid-crossing point — it is the CLEAR-BERTH
// STRIKE, i.e. the moment the train steps 0004→0002 (east) or 0005→0007 (west), which is
// the front of the train just past the road. Every run below is detected by that step and
// its timestamp is stored as ins[XING], so `transit['0003>XING']` means "0003 strike to
// clear-berth strike". Two consequences worth knowing before reading any of this:
//   - The table ALREADY supports projecting the barrier-UP time. Barrier-up is the clear
//     strike + openLagSecs (rear-of-train circuit clear), so b>XING + openLagSecs is the
//     whole calculation. Nothing needs regenerating to add it.
//   - crossingLeadSecs in crossings.json is measured BACK from this point, which is why
//     _closeAnchor derives an offset as transit[berth>XING] − crossingLeadSecs.
// The name cost a full analysis on 2026-08-05: it was read as a mid-crossing node, leading
// to "the clear berths have no transit cells" — which is false. Left as XING rather than
// renamed because crossings.json and _closeAnchor key off the string.
(async () => {
  // `days` in the output counts every file considered, stubs included — as it always has.
  let files = listDayFiles(LOGDIR);
  if (UNTIL) files = files.filter(f => f.slice(3, 13) <= UNTIL);
  if (DAYS > 0) files = files.slice(-DAYS);
  const samples = {};                       // dir -> class -> "A>B" -> [secs]
  let runs = 0;
  const allRuns = [];                       // kept for the queued pass, which needs neighbours

  for await (const day of runsByDay(LOGDIR, { days: DAYS, until: UNTIL })) {
    for (const run of day.runs) {
      allRuns.push(run);
      for (const { key, secs } of pairsOf(run)) {
        ((samples[run.dirn] = samples[run.dirn] || {})[run.cls] = samples[run.dirn][run.cls] || {});
        (samples[run.dirn][run.cls][key] = samples[run.dirn][run.cls][key] || []).push(secs);
      }
      runs++;
    }
  }

  const table = {};
  let cells = 0;
  for (const dirn of Object.keys(samples)) {
    for (const k of Object.keys(samples[dirn])) {
      for (const key of Object.keys(samples[dirn][k])) {
        const v = samples[dirn][k][key];
        if (v.length < 15) continue;                  // too thin to project from
        ((table[dirn] = table[dirn] || {})[k] = table[dirn][k] || {});
        table[dirn][k][key] = { secs: Math.round(median(v)), sdSecs: Math.round(sd(v)), n: v.length };
        cells++;
      }
    }
  }

  // Queued cells: each run's strike at B, kept only when a train was within maxAhead of it then.
  const cfgTd = (JSON.parse(fs.readFileSync(CONFIG, 'utf8')).portslade || {}).td || {};
  const maxAhead = {};
  for (const d of ['east', 'west']) {
    const v = (cfgTd[d === 'east' ? 'eastbound' : 'westbound'] || {}).queueMaxAhead;
    maxAhead[d] = (typeof v === 'number' && v >= 0) ? v : 2;
  }
  markAhead(allRuns);
  const qs = {};
  for (const r of allRuns) {
    for (const b of CHAIN[r.dirn]) {
      const a = r.ahead[b];
      if (r.ins[b] === undefined || a === Infinity || a > maxAhead[r.dirn]) continue;
      const secs = (r.xt - r.ins[b]) / 1000;
      if (secs <= 0 || secs > 1800) continue;         // pairsOf's sanity filter
      ((qs[r.dirn] = qs[r.dirn] || {})[r.cls] = qs[r.dirn][r.cls] || {});
      (qs[r.dirn][r.cls][`${b}>${XING}`] = qs[r.dirn][r.cls][`${b}>${XING}`] || []).push(secs);
    }
    r.cands = null;
  }
  const queued = {
    _comment: 'Queued-at-strike medians (step 2): the B>XING row measured only on runs with a ' +
      'same-direction train within maxAhead berths ahead when they struck B (lib/td-runs.markAhead). ' +
      'Read by crossing-state._queuedEstimate. Cells with n<15 are omitted rather than guessed.',
    generatedAt: new Date().toISOString(),
    until: UNTIL || (files.length ? files[files.length - 1].slice(3, 13) : null),
    days: files.length,
    runs: allRuns.length,
    maxAhead
  };
  let qcells = 0;
  for (const d of Object.keys(qs)) for (const k of Object.keys(qs[d])) for (const key of Object.keys(qs[d][k])) {
    const v = qs[d][k][key];
    if (v.length < 15) continue;
    ((queued[d] = queued[d] || {})[k] = queued[d][k] || {});
    queued[d][k][key] = { secs: Math.round(median(v)), sdSecs: Math.round(sd(v)), n: v.length };
    qcells++;
  }

  if (QUEUED_ONLY) {
    // Leave every other byte of the live table alone: only the queued section is replaced.
    const doc = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    doc.portslade.queued = queued;
    fs.writeFileSync(OUT, JSON.stringify(doc, null, 1));
    console.log(`derive-transits --queued-only: ${files.length} days, ${allRuns.length} runs, ${qcells} queued cells -> ${OUT}`);
    return;
  }
  table.queued = queued;

  const doc = {
    _comment: 'Generated by scripts/derive-transits.js — measured berth→berth transits only. ' +
      'No close/open offsets are baked in; the runtime applies those live from crossings.json, ' +
      'so recalibrating an offset or re-anchoring a class needs no regeneration. Re-run only to ' +
      'fold in more observed running. Cells with n<15 are omitted rather than guessed.',
    generatedAt: new Date().toISOString(),
    days: files.length,
    runs,
    portslade: table
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1));
  console.log(`derive-transits: ${files.length} days, ${runs} runs, ${cells} cells + ${qcells} queued -> ${OUT}`);
})().catch(e => { console.error(e); process.exit(1); });
