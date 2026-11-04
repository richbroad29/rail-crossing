#!/usr/bin/env node
'use strict';

// Cuts small real-data fixtures out of a built pack, for the offline tests. Written through the same
// writer as the real pack, so the tests also exercise the real format.
//
//   node track/make-fixture.js box PACK OUT.bin [S,W,N,E]
//       every edge with a vertex in the box. The default box is the Brighton / Hove / Portslade /
//       Hassocks corner of Sussex: the Hove - Brighton - Preston Park triangle, Clayton Tunnel, a throat
//       with parallel tracks and sidings.
//   node track/make-fixture.js routes PACK OUT.bin.gz [BUFFER_METRES]       (an OUT ending .gz is written gzipped: the committed fixture is)
//       the corridors of the station pairs in test/track-pairs.js: every edge within BUFFER_METRES
//       (default 15: a four-track main line is within 15 m) of the shortest route between each pair (so parallel tracks, crossovers and
//       sidings beside the route stay in), plus every edge within 150 m of the pairs' stations. Signals are left out (the other fixture carries some).

const path = require('path');
const { loadPack } = require('../src/track/pack');
const { writePack } = require('./lib/assemble');
const { cutPack } = require('./lib/cut');
const F = require('../src/track/format');

const [mode, packFile, outFile, arg] = process.argv.slice(2);
if (!['box', 'routes'].includes(mode) || !packFile || !outFile) { console.error('usage: node track/make-fixture.js box|routes PACK OUT.bin [S,W,N,E | BUFFER_METRES]'); process.exit(2); }
const pack = loadPack(packFile);
const s = pack.s;
let edges = new Set(), keepStation, note;

if (mode === 'box') {
  const [S, W, N, E] = (arg || '50.825,-0.245,50.930,-0.120').split(',').map(Number);
  const inBox = (la, lo) => la >= S * 1e7 && la <= N * 1e7 && lo >= W * 1e7 && lo <= E * 1e7;
  for (let e = 0; e < pack.nEdges; e++) for (let v = pack.evo[e]; v < pack.evo[e + 1]; v++) if (inBox(s.VLAT[v], s.VLON[v])) { edges.add(e); break; }
  keepStation = (i) => inBox(s.STLAT[i], s.STLON[i]);
  note = 'cut from a real track pack for tests; box S,W,N,E = ' + [S, W, N, E].join(',');
} else {
  const { PAIRS } = require('../test/track-pairs');
  const buffer = Number(arg || 15);
  const names = new Set();
  const addNear = (lat, lon, r) => { for (const x of pack.nearestOnTrack(lat, lon, { maxDist: r, k: 400 })) edges.add(x.edge); };
  for (const p of PAIRS) {
    names.add(p.a); names.add(p.b);
    const A = pack.stationSnaps(p.a), B = pack.stationSnaps(p.b);
    const r = pack.route(A, B, { avoidSidings: true });
    if (!r) throw new Error(`no route for ${p.a} - ${p.b}`);
    for (const sn of A.concat(B)) addNear(sn.lat, sn.lon, Math.max(buffer, 120));
    const step = buffer * 0.8;
    for (let d = 0; d <= r.length + step; d += step) { const q = pack.pointAt(r, Math.min(d, r.length)); addNear(q.lat, q.lon, buffer); }
    for (const piece of r.pieces) edges.add(piece.e);
  }
  keepStation = (i) => names.has(pack.str(s.STNAME[i]));
  note = `corridors of the ${PAIRS.length} station pairs in test/track-pairs.js, ${buffer} m either side of the shortest route`;
}

const { sections, counts } = cutPack(pack, edges, keepStation, { signals: mode === 'box' });
const meta = { fixture: true, note, format: F.VERSION, source: pack.meta.sources, packDate: pack.meta.packDate };
const gz = outFile.endsWith('.gz');
const rawFile = gz ? outFile.slice(0, -3) : outFile;
const w = writePack(rawFile, sections, { metaJson: JSON.stringify(meta), built: 0 });
let finalBytes = w.bytes;
if (gz) {
  const fs = require('fs');
  fs.writeFileSync(outFile, require('zlib').gzipSync(fs.readFileSync(rawFile), { level: 9 }));
  fs.unlinkSync(rawFile);
  finalBytes = fs.statSync(outFile).size;
}
console.log(`${path.basename(outFile)}: ${finalBytes} bytes (${w.bytes} raw); ${counts.edges} edges, ${counts.nodes} nodes, ${counts.stations} stations, ${counts.snaps} snaps, ${counts.signals} signals`);
