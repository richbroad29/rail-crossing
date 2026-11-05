'use strict';

// What the runtime derives from the stored graph, in one place so the BUILDER can compute it once and
// store it in the pack (format 2) and the READER can compute it for a format-1 pack.
//
//   VCUM   f32 per vertex   metres from the start of its edge
//   EBST   f32 per edge     tangent bearing at the first node (degrees), to the first vertex 15 m in
//   EBEN   f32 per edge     the same at the last node
//   GSEGE  u32 per vertex   the edge a segment (identified by its first vertex) belongs to
//   GKEY, GOFF, GSEG        the sparse grid: sorted occupied-cell keys, offsets, segment ids (spatial.js)

const { KY, DEG7, kxAt, bearing7 } = require('./geom');
const { buildGridArrays } = require('./spatial');

const DERIVED = ['VCUM', 'EBST', 'EBEN', 'GKEY', 'GOFF', 'GSEG', 'GSEGE'];

function edgeGeometry(vlat, vlon, evo) {
  const E = evo.length - 1, V = vlat.length;
  const vcum = new Float32Array(V), bStart = new Float32Array(E), bEnd = new Float32Array(E);
  for (let e = 0; e < E; e++) {
    const a = evo[e], b = evo[e + 1];
    let acc = 0;
    vcum[a] = 0;
    for (let v = a + 1; v < b; v++) {
      const kx = kxAt((vlat[v - 1] + vlat[v]) / 2);
      const dy = (vlat[v] - vlat[v - 1]) * DEG7 * KY, dx = (vlon[v] - vlon[v - 1]) * DEG7 * kx;
      acc += Math.sqrt(dx * dx + dy * dy);
      vcum[v] = acc;
    }
    // tangent bearings at each end, measured to the first vertex >= 15 m in (stable against OSM wiggle at a switch)
    let j = a + 1;
    while (j < b - 1 && vcum[j] < 15) j++;
    bStart[e] = b - a >= 2 ? bearing7(vlat[a], vlon[a], vlat[j], vlon[j]) : 0;
    j = b - 2;
    while (j > a && acc - vcum[j] < 15) j--;
    bEnd[e] = b - a >= 2 ? bearing7(vlat[j], vlon[j], vlat[b - 1], vlon[b - 1]) : 0;
  }
  return { vcum, bStart, bEnd };
}

/** All derived data as pack sections (by id). */
function deriveSections(vlat, vlon, evo) {
  const g = edgeGeometry(vlat, vlon, evo);
  const grid = buildGridArrays(vlat, vlon, evo);
  return { VCUM: g.vcum, EBST: g.bStart, EBEN: g.bEnd, GKEY: grid.keys, GOFF: grid.offs, GSEG: grid.segs, GSEGE: grid.segEdge };
}

module.exports = { deriveSections, edgeGeometry, DERIVED };
