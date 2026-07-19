#!/usr/bin/env node
'use strict';

// Derive per-berth time-to/from-crossing distributions (lower-quartile / median
// / upper-quartile) for the observer strip-map, from the TD berth-step logs.
//
// The crossing instant for a traversal is the CA step OUT of the protecting
// berth (from == protecting). For every BEFORE (approach) berth we take the most
// recent instant the train ENTERED it (to == berth) at/just-before that step
// → "time to crossing". For every AFTER (cleared) berth we take the soonest
// instant the train ENTERED it at/just-after that step → "time since crossing".
// "Entered berth b" mirrors what the live B1 feed shows as a train's position
// (the `to` of its latest CA step).
//
// Usage:  node derive-ttc.js [path-to-td-log-dir]   (defaults to ".")

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIR = process.argv[2] || '.';
const CAP_S = 1200; // ignore enter<->pass intervals > 20 min (headcode reuse / log gaps)

// Approach (before) and cleared (after) chains per direction, matching
// observe.js CHAIN order. crossStep = the CA step that passes the crossing
// (out of the protecting berth into the first clear berth).
const PLAN = {
  east: {
    crossStep: '0004>0002',
    before: [
      { b: '0016' }, { b: '0014' }, { b: '0012' }, { b: '0010' },
      { b: '0008' }, { b: '0006', role: 'approach' }, { b: '0004', role: 'protecting' },
    ],
    after: [
      { b: '0002', role: 'clear' }, { b: 'T686' }, { b: 'T684' },
    ],
  },
  west: {
    crossStep: '0005>0007',
    before: [
      { b: 'T682' }, { b: 'T677' }, { b: '0001' },
      { b: '0003', role: 'approach' }, { b: '0005', role: 'protecting' },
    ],
    after: [
      { b: '0007', role: 'clear' }, { b: '0009' }, { b: '0011' },
      { b: '0013' }, { b: '0015' }, { b: '0017' },
    ],
  },
};

function readLines(file) {
  let buf = fs.readFileSync(path.join(DIR, file));
  if (file.endsWith('.gz')) buf = zlib.gunzipSync(buf);
  return buf.toString('utf8').split('\n');
}

const files = fs.readdirSync(DIR)
  .filter(f => /^td-\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(f))
  .sort();
if (!files.length) { console.error('No td-*.jsonl[.gz] files in ' + path.resolve(DIR)); process.exit(1); }

// group CA berth-steps by day|headcode
const groups = new Map(); // key -> [{t, from, to}]
for (const file of files) {
  for (const line of readLines(file)) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.event !== 'CA' || !o.from || !o.to || !o.desc) continue;
    const t = Date.parse(o.ts); if (!Number.isFinite(t)) continue;
    const key = (o.ts || '').slice(0, 10) + '|' + o.desc;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ t, from: o.from, to: o.to });
  }
}

// collect samples: samples[dir].before[berth] = [secs to crossing]; .after[berth] = [secs since crossing]
const samples = {};
for (const dir of Object.keys(PLAN)) {
  samples[dir] = { before: {}, after: {} };
  for (const x of PLAN[dir].before) samples[dir].before[x.b] = [];
  for (const x of PLAN[dir].after) samples[dir].after[x.b] = [];
}

for (const [, evs] of groups) {
  evs.sort((a, b) => a.t - b.t);
  for (const dir of Object.keys(PLAN)) {
    const [pf, pt] = PLAN[dir].crossStep.split('>');
    const passes = evs.filter(e => e.from === pf && e.to === pt).map(e => e.t);
    for (const tp of passes) {
      // BEFORE: latest enter at/before the pass
      for (const node of PLAN[dir].before) {
        let best = -Infinity;
        for (const e of evs) { if (e.to === node.b && e.t <= tp && e.t > best) best = e.t; }
        if (best === -Infinity) continue;
        const d = (tp - best) / 1000;
        if (d >= 0 && d <= CAP_S) samples[dir].before[node.b].push(d);
      }
      // AFTER: soonest enter at/after the pass
      for (const node of PLAN[dir].after) {
        let best = Infinity;
        for (const e of evs) { if (e.to === node.b && e.t >= tp && e.t < best) best = e.t; }
        if (best === Infinity) continue;
        const d = (best - tp) / 1000;
        if (d >= 0 && d <= CAP_S) samples[dir].after[node.b].push(d);
      }
    }
  }
}

// nearest-rank percentile (matches fit-transit.js convention)
function pct(s, p) { if (!s.length) return null; const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1)))); return s[i]; }
function statRow(node, arr) {
  const s = arr.slice().sort((a, b) => a - b);
  return {
    b: node.b, role: node.role || null, n: s.length,
    q1: s.length ? Math.round(pct(s, 25)) : null,
    med: s.length ? Math.round(pct(s, 50)) : null,
    q3: s.length ? Math.round(pct(s, 75)) : null,
  };
}

const out = {
  generatedAt: new Date().toISOString(),
  crossingId: 'portslade',
  daysScanned: files.length,
  dateRange: [files[0].match(/\d{4}-\d{2}-\d{2}/)[0], files[files.length - 1].match(/\d{4}-\d{2}-\d{2}/)[0]],
  capSecs: CAP_S,
  note: 'before.* = q1/med/q3 seconds from entering the berth to passing the crossing; after.* = seconds from passing the crossing to entering the berth',
  before: {}, after: {},
};
for (const dir of Object.keys(PLAN)) {
  out.before[dir] = PLAN[dir].before.map(n => statRow(n, samples[dir].before[n.b]));
  out.after[dir] = PLAN[dir].after.map(n => statRow(n, samples[dir].after[n.b]));
}

// human summary to stderr, JSON to stdout
function mmss(x) { if (x == null) return '—'; const m = Math.floor(x / 60), r = x % 60; return r ? (m ? m + 'm' + String(r).padStart(2, '0') + 's' : r + 's') : (m ? m + 'm' : '0s'); }
function printRows(rows) { for (const r of rows) console.error(`  ${r.b.padEnd(5)}${(r.role || '').padEnd(11)} n=${String(r.n).padStart(4)}  Q1=${mmss(r.q1).padStart(7)}  med=${mmss(r.med).padStart(7)}  Q3=${mmss(r.q3).padStart(7)}`); }
console.error(`\nScanned ${files.length} day(s): ${out.dateRange[0]} … ${out.dateRange[1]}  (cap ${CAP_S}s)`);
for (const dir of Object.keys(PLAN)) {
  console.error(`\n${dir.toUpperCase()}BOUND — time TO crossing (approach berths)`); printRows(out.before[dir]);
  console.error(`${dir.toUpperCase()}BOUND — time SINCE crossing (cleared berths)`); printRows(out.after[dir]);
}
console.error('');
console.log(JSON.stringify(out, null, 2));
