#!/usr/bin/env node
'use strict';

// What the transit store (src/transit.js) costs in memory, measured on a real saved transit-times.json (contract section 17.5):
//
//   node --expose-gc dev/measure-transit.js /path/to/transit-times.json [maxEntries]
//
// Loads every series into a store with the given cap (default 200000, so nothing is evicted), forces a collection, and prints the heap
// plus ArrayBuffer growth per series, the pooled-sample bytes, and how the series divide between slot sizes.

const fs = require('fs');
const { TransitStore } = require('../src/transit');

if (typeof global.gc !== 'function') { console.error('run with: node --expose-gc dev/measure-transit.js FILE [maxEntries]'); process.exit(2); }
const file = process.argv[2];
if (!file) { console.error('usage: node --expose-gc dev/measure-transit.js transit-times.json [maxEntries]'); process.exit(2); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const heap = async () => { for (let i = 0; i < 4; i++) { global.gc(); await sleep(50); } const m = process.memoryUsage(); return m.heapUsed + m.arrayBuffers; };

(async () => {
  let doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const names = new Map();
  const rows = doc.entries.map(e => { if (!names.has(e[0])) names.set(e[0], names.size); return [names.get(e[0]), e[1], e[2], e[3]]; });
  doc = null;
  const base = await heap();
  const s = new TransitStore({ maxEntries: Number(process.argv[3]) || 200000 });
  for (const r of rows) for (const v of r[3]) s.add(r[0], r[1], r[2], v);
  const used = (await heap()) - base;
  const samples = rows.reduce((n, r) => n + r[3].length, 0);
  console.log(`${s.size} series, ${samples} samples, ${s.stats.evicted} evicted`);
  console.log(`heap + arraybuffers: ${(used / 1048576).toFixed(1)} MB = ${(used / s.size).toFixed(0)} B per series (bytes() estimate ${(s.bytes() / 1048576).toFixed(1)} MB)`);
  console.log('slot sizes (samples: series, MB):', s.pools.map(p => `${p.cap}: ${p.live}, ${(p.bytes() / 1048576).toFixed(2)}`).join('   '));
  const full = s.pools.map(p => 40 + p.stride * 2);
  console.log(`per series by slot size: ${s.pools.map((p, i) => `${p.cap} -> ~${full[i]} B`).join(', ')}; a full cap of ${s.maxEntries} series would be at most ${(s.maxEntries * full[full.length - 1] / 1048576).toFixed(0)} MB`);
})();
