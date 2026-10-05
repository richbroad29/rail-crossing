'use strict';
/**
 * Run extraction from the TD logs — ONE implementation, shared by everything that reads
 * historical running: derive-transits.js (which builds data/transits.json, the table the
 * live projection uses) and backtest-transits.js (which scores candidate predictors against
 * the same runs).
 *
 * Lifted verbatim out of derive-transits.js on 2026-10-05 so the backtest could not drift
 * from the table it is evaluating. A backtest with its own idea of what a "run", a "class" or
 * a "berth pair" is would be scoring a different table from the one in production, and its
 * conclusions would not transfer. derive-transits.js output is byte-identical before and after
 * the move (checked on a synthetic fixture).
 *
 * See derive-transits.js for the WHY of the classification and the XING naming warning.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

const CHAIN = {
  east: ['0016', '0014', '0012', '0010', '0008', '0006', '0004'],
  west: ['T682', 'T677', '0001', '0003', '0005']
};
const CLEAR = { east: ['0004', '0002'], west: ['0005', '0007'] };
// XING is the CLEAR-BERTH STRIKE (0004→0002 east, 0005→0007 west), not a mid-crossing
// point. See the naming warning in derive-transits.js.
const XING = 'XING';
const ORDER = { east: CHAIN.east.concat([XING]), west: CHAIN.west.concat([XING]) };

// Mirrors crossing-state._classOf, inferred from TD alone (platform dwell for "calls at
// Portslade", 0006 occupancy for "calls at Southwick").
function classify(dirn, hc, dwellSecs, sec0006) {
  const hcFirst = hc[0];
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

function listDayFiles(logdir) {
  return fs.readdirSync(logdir).filter(f => /^td-\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(f)).sort();
}

// Runs, one day at a time, stitched to the previous file because logs roll at 23:00Z and an
// approach can straddle two files. A run is detected by its clear step; `ins` holds the LAST
// strike into each chain berth within 30 min before it, plus ins[XING].
//   yields { file, day, runs: [{ hc, dirn, cls, ins, xt, outTs, dwell, sec6 }] }
async function* runsByDay(logdir, { days = 0 } = {}) {
  let files = listDayFiles(logdir);
  if (days > 0) files = files.slice(-days);
  let prev = [];
  for (const fn of files) {
    let cur;
    try { cur = await readDay(path.join(logdir, fn)); } catch (e) { continue; }
    if (cur.length < 500) { prev = cur; continue; }   // rotation stub / dead day

    const byHc = new Map();
    for (const r of prev.concat(cur)) {
      if (!byHc.has(r.desc)) byHc.set(r.desc, []);
      byHc.get(r.desc).push(r);
    }
    for (const v of byHc.values()) v.sort((a, b) => (a.ts < b.ts ? -1 : 1));

    const runs = [];
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
        const outTs = outStep ? Date.parse(outStep.ts) : null;
        const dwell = outStep ? (outTs - xt) / 1000 : null;
        const sec6 = (ins['0006'] && ins['0004']) ? (ins['0004'] - ins['0006']) / 1000 : null;
        runs.push({ hc: r.desc, dirn, cls: classify(dirn, r.desc, dwell, sec6), ins, xt, outTs, dwell, sec6 });
      }
    }
    yield { file: fn, day: fn.slice(3, 13), runs };
    prev = cur.slice(-4000);
  }
}

// Every measured berth pair in a run, in chain order, with derive-transits' sanity filter.
function pairsOf(run) {
  const order = ORDER[run.dirn];
  const out = [];
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      const a = order[i], b = order[j];
      if (run.ins[a] === undefined || run.ins[b] === undefined) continue;
      const secs = (run.ins[b] - run.ins[a]) / 1000;
      if (secs <= 0 || secs > 1800) continue;
      out.push({ from: a, to: b, key: `${a}>${b}`, secs });
    }
  }
  return out;
}

const median = v => { const s = v.slice().sort((a, b) => a - b); const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sd = v => { const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length); };

module.exports = { CHAIN, CLEAR, XING, ORDER, classify, readDay, listDayFiles, runsByDay, pairsOf, median, sd };
