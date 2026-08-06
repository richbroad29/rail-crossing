#!/usr/bin/env node
'use strict';
/**
 * Derive the berth→berth transit table that the prediction engine projects with.
 *
 *   node scripts/derive-transits.js [--days N] [--out data/transits.json]
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
const zlib = require('zlib');
const readline = require('readline');

const args = process.argv.slice(2);
const argOf = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const DAYS = parseInt(argOf('--days', '0'), 10);
const OUT = argOf('--out', path.join(__dirname, '..', 'data', 'transits.json'));
const LOGDIR = path.join(__dirname, '..', 'data', 'logs', 'td');

const CHAIN = {
  east: ['0016', '0014', '0012', '0010', '0008', '0006', '0004'],
  west: ['T682', 'T677', '0001', '0003', '0005']
};
const CLEAR = { east: ['0004', '0002'], west: ['0005', '0007'] };

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
const XING = 'XING';

function classify(dirn, dwellSecs, sec0006) {
  const hcFirst = classify.hc[0];
  if ('67'.includes(hcFirst)) return 'freight';
  if (hcFirst === '5') return 'ecs';
  if (dirn === 'west') return (dwellSecs === null || dwellSecs > 25) ? 'stopping' : 'fast';
  if (!(dwellSecs !== null && dwellSecs >= 60)) return 'fast';
  return (sec0006 !== null && sec0006 >= 90) ? 'stoppingLocal' : 'stopping';
}

async function readDay(file) {
  const out = [];
  const stream = file.endsWith('.gz')
    ? fs.createReadStream(file).pipe(zlib.createGunzip())
    : fs.createReadStream(file);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch (e) { continue; }
    if (r.area !== 'LA' || !r.desc) continue;
    out.push(r);
  }
  return out;
}

(async () => {
  let files = fs.readdirSync(LOGDIR).filter(f => /^td-\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(f)).sort();
  if (DAYS > 0) files = files.slice(-DAYS);

  const samples = {};                       // dir -> class -> "A>B" -> [secs]
  let prev = [], runs = 0;

  for (const fn of files) {
    let cur;
    try { cur = await readDay(path.join(LOGDIR, fn)); } catch (e) { continue; }
    if (cur.length < 500) { prev = cur; continue; }   // rotation stub / dead day

    const byHc = new Map();                 // stitched with the previous file: logs roll
    for (const r of prev.concat(cur)) {     // at 23:00Z, so an approach can straddle two
      if (!byHc.has(r.desc)) byHc.set(r.desc, []);
      byHc.get(r.desc).push(r);
    }
    for (const v of byHc.values()) v.sort((a, b) => (a.ts < b.ts ? -1 : 1));

    for (const r of cur) {
      for (const dirn of ['east', 'west']) {
        const [ca, cb] = CLEAR[dirn];
        if (r.from !== ca || r.to !== cb) continue;
        const ev = byHc.get(r.desc) || [];
        const xt = Date.parse(r.ts);
        const ins = {};
        for (const b of CHAIN[dirn]) {
          const c = ev.filter(v => v.to === b && Date.parse(v.ts) < xt && xt - Date.parse(v.ts) < 1800000);
          if (c.length) ins[b] = Date.parse(c[c.length - 1].ts);
        }
        if (!Object.keys(ins).length) continue;
        ins[XING] = xt;

        const outStep = ev.find(v => v.from === cb && Date.parse(v.ts) > xt && Date.parse(v.ts) - xt < 1800000);
        const dwell = outStep ? (Date.parse(outStep.ts) - xt) / 1000 : null;
        const sec6 = (ins['0006'] && ins['0004']) ? (ins['0004'] - ins['0006']) / 1000 : null;
        classify.hc = r.desc;
        const k = classify(dirn, dwell, sec6);

        const order = CHAIN[dirn].concat([XING]);
        for (let i = 0; i < order.length; i++) {
          for (let j = i + 1; j < order.length; j++) {
            const a = order[i], b = order[j];
            if (ins[a] === undefined || ins[b] === undefined) continue;
            const secs = (ins[b] - ins[a]) / 1000;
            if (secs <= 0 || secs > 1800) continue;
            const key = `${a}>${b}`;
            ((samples[dirn] = samples[dirn] || {})[k] = samples[dirn][k] || {});
            (samples[dirn][k][key] = samples[dirn][k][key] || []).push(secs);
          }
        }
        runs++;
      }
    }
    prev = cur.slice(-4000);
  }

  const median = v => { const s = v.slice().sort((a, b) => a - b); const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const sd = v => { const m = v.reduce((a, b) => a + b, 0) / v.length;
    return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length); };

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
  console.log(`derive-transits: ${files.length} days, ${runs} runs, ${cells} cells -> ${OUT}`);
})().catch(e => { console.error(e); process.exit(1); });
