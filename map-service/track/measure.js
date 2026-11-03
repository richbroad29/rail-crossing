#!/usr/bin/env node
'use strict';

// Measures the runtime library on a real pack: load time, memory, and route() latency over random
// station pairs. Run with --expose-gc for clean memory numbers:
//   node --expose-gc track/measure.js PACK [--pairs 1000] [--radius 50]

const { loadPack } = require('../src/track/pack');

const file = process.argv[2];
if (!file) { console.error('usage: node --expose-gc track/measure.js PACK [--pairs N] [--radius KM]'); process.exit(2); }
const opt = (name, d) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : d; };
const gc = () => { if (global.gc) { global.gc(); global.gc(); } };
const mb = n => Math.round(n / 1e5) / 10;

gc();
const base = process.memoryUsage();
const t0 = process.hrtime.bigint();
const pack = loadPack(file);
const loadMs = Number(process.hrtime.bigint() - t0) / 1e6;
gc();
const after = process.memoryUsage();
console.log(`node ${process.version}: load ${loadMs.toFixed(0)} ms`);
console.log(`baseline rss ${mb(base.rss)} MB; after load rss ${mb(after.rss)} MB (delta ${mb(after.rss - base.rss)} MB); arrayBuffers ${mb(after.arrayBuffers - base.arrayBuffers)} MB; heapUsed delta ${mb(after.heapUsed - base.heapUsed)} MB; typed arrays held ${mb(pack.bytesHeld())} MB`);
console.log(`graph: ${pack.nNodes} nodes, ${pack.nEdges} edges, ${pack.nVertices} vertices, ${pack.stationCount()} stations, ${pack.s.SGEDGE.length} signals`);

// route latency
const pairs = opt('--pairs', 1000), radiusKm = opt('--radius', 50);
const stations = pack.stationTiplocs().map(t => pack.station(t)).filter(s => s.snaps.some(x => x.primary));
let seed = 12345;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const km = (a, b) => Math.hypot((a.lon - b.lon) * 111.19 * Math.cos(a.lat * Math.PI / 180), (a.lat - b.lat) * 111.19);
const ms = [], msGeom = [];
let none = 0, n = 0;
while (n < pairs) {
  const a = stations[Math.floor(rnd() * stations.length)], b = stations[Math.floor(rnd() * stations.length)];
  const d = km(a, b);
  if (a === b || d > radiusKm || d < 1) continue;
  const sa = a.snaps.find(x => x.primary), sb = b.snaps.find(x => x.primary);
  const t = process.hrtime.bigint();
  const r = pack.route(sa, sb, { avoidSidings: true });
  const t1 = process.hrtime.bigint();
  ms.push(Number(t1 - t) / 1e6);
  n++;
  if (!r) { none++; continue; }
  pack.pointAt(r, r.length / 2);                      // forces the route's geometry
  msGeom.push(Number(process.hrtime.bigint() - t) / 1e6);
}
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
console.log(`route() over ${pairs} random station pairs within ${radiusKm} km (avoidSidings): p50 ${q(ms, 0.5).toFixed(2)} ms, p95 ${q(ms, 0.95).toFixed(2)} ms, p99 ${q(ms, 0.99).toFixed(2)} ms, max ${q(ms, 1).toFixed(1)} ms; no route for ${none}`);
console.log(`route() + geometry (pointAt): p50 ${q(msGeom, 0.5).toFixed(2)} ms, p95 ${q(msGeom, 0.95).toFixed(2)} ms`);
// nearestOnTrack
const nt = [];
for (let i = 0; i < 5000; i++) { const s = stations[Math.floor(rnd() * stations.length)]; const t = process.hrtime.bigint(); pack.nearestOnTrack(s.lat + (rnd() - 0.5) * 0.004, s.lon + (rnd() - 0.5) * 0.006, { maxDist: 300 }); nt.push(Number(process.hrtime.bigint() - t) / 1e6); }
console.log(`nearestOnTrack(300 m): p50 ${q(nt, 0.5).toFixed(3)} ms, p95 ${q(nt, 0.95).toFixed(3)} ms`);
gc();
const end = process.memoryUsage();
console.log(`after routing (route state allocated): rss ${mb(end.rss)} MB (delta ${mb(end.rss - base.rss)} MB), typed arrays held ${mb(pack.bytesHeld())} MB; heapTotal ${mb(end.heapTotal)} heapUsed ${mb(end.heapUsed)} external ${mb(end.external)} arrayBuffers ${mb(end.arrayBuffers)}`);
