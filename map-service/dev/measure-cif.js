#!/usr/bin/env node
'use strict';

// What does the CIF index cost, and what is the worst moment (a daily refresh, while the old index is
// still being served)? Run under the real heap cap:
//
//   node --max-old-space-size=192 dev/measure-cif.js --cif=/path/cif-latest.json.gz
//
// Prints heap and RSS after loading the first index, then peak and settled figures while a second one
// is built beside it, then after the first is released.

const { buildCifIndex, targetDays } = require('../src/cif-index');

const opt = {};
for (const a of process.argv.slice(2)) { const m = /^--([a-z]+)=(.*)$/.exec(a); if (m) opt[m[1]] = m[2]; }
if (!opt.cif) { console.error('usage: measure-cif.js --cif=FILE'); process.exit(2); }

const mb = n => Math.round(n / 1048576);
const snap = label => {
  if (global.gc) global.gc();
  const m = process.memoryUsage();
  console.log(`${label.padEnd(44)} rss ${String(mb(m.rss)).padStart(4)} MB   heapUsed ${String(mb(m.heapUsed)).padStart(4)} MB   external+arrayBuffers ${String(mb(m.external + m.arrayBuffers)).padStart(3)} MB`);
};

(async () => {
  const days = targetDays(opt.now ? Number(opt.now) : Date.now());
  snap('start');
  let peak = 0;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
  const t0 = Date.now();
  let a = await buildCifIndex(opt.cif, { dayNums: days });
  console.log(`first parse: ${((Date.now() - t0) / 1000).toFixed(1)} s, ${a.stats.lines} lines, ${a.schedules} schedules kept, days ${a.days.map(d => `${d.date}:${d.count}`).join(' ')}`);
  console.log(`   peak RSS during the first parse: ${mb(peak)} MB`);
  snap('index loaded');
  peak = 0;
  const t1 = Date.now();
  let b = await buildCifIndex(opt.cif, { dayNums: days });
  console.log(`second parse beside the first: ${((Date.now() - t1) / 1000).toFixed(1)} s; peak RSS ${mb(peak)} MB`);
  snap('both indexes held (refresh moment)');
  a = null;
  snap('old index released');
  clearInterval(timer);
  console.log(`pool ${(b.pool.byteLength / 1048576).toFixed(1)} MB, ${b.scheds.length} records, ${b.tiplocs.list.length} TIPLOCs`);
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
