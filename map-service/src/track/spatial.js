'use strict';

// A sparse grid over every track segment, built at load from the vertex arrays (it is derived data, so
// the pack does not carry it). Cells are about 450 m square; only occupied cells exist, held as three
// typed arrays (sorted keys, offsets, segment ids), so it costs a few MB for the whole of Britain.
//
// A "segment" is identified by the index of its first vertex v: it runs v -> v+1 inside one edge.

const CELL_LAT = 0.004 * 1e7;        // 1e-7 degrees
const CELL_LON = 0.007 * 1e7;
const LAT0 = 49.0 * 1e7;
const LON0 = -10.0 * 1e7;
const CX = 2048;                      // cells per row in the key
const SEG_BITS = 2 ** 24;             // composite = key * 2^24 + segment, exact in a double

class Grid {
  /**
   * @param {Int32Array} vlat @param {Int32Array} vlon @param {Uint32Array} evo edge -> first vertex (n+1)
   */
  constructor(vlat, vlon, evo) {
    const V = vlat.length, E = evo.length - 1;
    if (V >= SEG_BITS) throw new Error('track pack too large for the grid index');
    this.segEdge = new Uint32Array(V);
    let n = 0;
    for (let e = 0; e < E; e++) for (let v = evo[e]; v < evo[e + 1]; v++) { this.segEdge[v] = e; if (v + 1 < evo[e + 1]) n++; }

    // Two passes over the same traversal (count, then fill) so the temporary array is exactly the size needed.
    const traverse = (push) => {
      for (let e = 0; e < E; e++) {
        for (let v = evo[e]; v + 1 < evo[e + 1]; v++) {
          // Amanatides-Woo traversal in cell space: every cell the segment passes through.
          const x0 = (vlon[v] - LON0) / CELL_LON, y0 = (vlat[v] - LAT0) / CELL_LAT;
          const x1 = (vlon[v + 1] - LON0) / CELL_LON, y1 = (vlat[v + 1] - LAT0) / CELL_LAT;
          let cx = Math.floor(x0), cy = Math.floor(y0);
          const ex = Math.floor(x1), ey = Math.floor(y1);
          push(cx, cy, v);
          if (cx === ex && cy === ey) continue;
          const dx = x1 - x0, dy = y1 - y0;
          const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
          const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity, tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
          let tx = dx > 0 ? (cx + 1 - x0) * tdx : dx < 0 ? (x0 - cx) * tdx : Infinity;
          let ty = dy > 0 ? (cy + 1 - y0) * tdy : dy < 0 ? (y0 - cy) * tdy : Infinity;
          let guard = 0;
          while ((cx !== ex || cy !== ey) && guard++ < 100000) {
            if (tx < ty) { cx += sx; tx += tdx; } else { cy += sy; ty += tdy; }
            push(cx, cy, v);
          }
        }
      }
    };
    const inFrame = (cx, cy) => cx >= 0 && cx < CX && cy >= 0;   // outside the frame (49N..., 10W..4E) is not Britain
    let m = 0;
    traverse((cx, cy) => { if (inFrame(cx, cy)) m++; });
    const comp = new Float64Array(m);
    let w0 = 0;
    traverse((cx, cy, v) => { if (inFrame(cx, cy)) comp[w0++] = (cy * CX + cx) * SEG_BITS + v; });
    const sorted = comp.sort();
    // unpack into keys / offsets / segs, dropping duplicates
    const keys = [], offs = [];
    const segs = new Uint32Array(m);
    let w = 0, last = -1;
    for (let i = 0; i < m; i++) {
      const c = sorted[i];
      if (i && c === sorted[i - 1]) continue;
      const key = Math.floor(c / SEG_BITS);
      if (key !== last) { keys.push(key); offs.push(w); last = key; }
      segs[w++] = c - key * SEG_BITS;
    }
    offs.push(w);
    this.keys = Uint32Array.from(keys);
    this.offs = Uint32Array.from(offs);
    this.segs = segs.slice(0, w);
  }

  /** Calls fn(v) for every segment in every occupied cell touching the box (1e-7 degrees). */
  forBox(la0, lo0, la1, lo1, fn) {
    const cx0 = Math.max(0, Math.floor((lo0 - LON0) / CELL_LON)), cx1 = Math.min(CX - 1, Math.floor((lo1 - LON0) / CELL_LON));
    const cy0 = Math.max(0, Math.floor((la0 - LAT0) / CELL_LAT)), cy1 = Math.floor((la1 - LAT0) / CELL_LAT);
    const keys = this.keys;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = cy * CX + cx;
        let lo = 0, hi = keys.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (keys[mid] < key) lo = mid + 1; else hi = mid; }
        if (lo < keys.length && keys[lo] === key) for (let i = this.offs[lo]; i < this.offs[lo + 1]; i++) fn(this.segs[i]);
      }
    }
  }
}

module.exports = { Grid };
