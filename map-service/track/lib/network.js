'use strict';

// The national overview: every passenger- or freight-carrying running line (class main and branch,
// tunnels INCLUDED and drawn exactly like open track), none of the sidings, yards, crossovers or
// depot spurs. The base map tiles drop branch lines from about zoom 8 and carry no rail below 8, so
// the page draws this instead. Two simplification levels, each its own GeoJSON (gzipped):
//   lo: ~100 m deviation, for zoom <= 7
//   hi: ~15 m deviation, for zoom 8..11
// Edges are chained through degree-2 nodes (same class) into long polylines first, because simplifying
// a 40 km chain is far cheaper in bytes than simplifying 300 short edges that each keep both ends.

const zlib = require('zlib');
const F = require('../../src/track/format');
const { simplify } = require('./graph');
const { DEG7 } = require('../../src/track/geom');

const OVERVIEW_CLASSES = [F.CLS.MAIN, F.CLS.BRANCH];

/** Merge selected edges into chains. Returns [{cls, la: number[], lo: number[]}] in 1e-7 degrees. */
function chains(pack, classes) {
  const sel = [];
  for (let e = 0; e < pack.nEdges; e++) if (classes.includes(pack.ecls[e])) sel.push(e);
  const at = new Map();                                  // node -> [edge...]
  const add = (n, e) => { const l = at.get(n); if (l) l.push(e); else at.set(n, [e]); };
  for (const e of sel) { add(pack.efrom[e], e); add(pack.eto[e], e); }
  const used = new Set();
  const out = [];
  const verts = (e, rev) => {
    const la = [], lo = [];
    for (let v = pack.evo[e]; v < pack.evo[e + 1]; v++) { la.push(pack.vlat[v]); lo.push(pack.vlon[v]); }
    if (rev) { la.reverse(); lo.reverse(); }
    return { la, lo };
  };
  // continue from `node` (the end of the current chain) via the only other edge there, if node has exactly two selected edges of one class
  const next = (node, cur, cls) => {
    const l = at.get(node);
    if (!l || l.length !== 2) return null;
    const o = l[0] === cur ? l[1] : l[1] === cur ? l[0] : null;
    if (o === null || o === cur || used.has(o) || pack.ecls[o] !== cls) return null;
    return o;
  };
  for (const e0 of sel) {
    if (used.has(e0)) continue;
    used.add(e0);
    const cls = pack.ecls[e0];
    const v0 = verts(e0, false);
    let la = v0.la, lo = v0.lo;
    // extend forward from e0's `to` node
    let tail = pack.eto[e0], cur = e0;
    for (;;) {
      const o = next(tail, cur, cls);
      if (o === null) break;
      used.add(o);
      const rev = pack.efrom[o] !== tail;
      const v = verts(o, rev);
      la = la.concat(v.la.slice(1)); lo = lo.concat(v.lo.slice(1));
      tail = rev ? pack.efrom[o] : pack.eto[o]; cur = o;
    }
    // extend backward from e0's `from` node
    let head = pack.efrom[e0]; cur = e0;
    for (;;) {
      const o = next(head, cur, cls);
      if (o === null) break;
      used.add(o);
      const rev = pack.eto[o] !== head;           // we want o oriented so that it ends at `head`
      const v = verts(o, rev);
      la = v.la.slice(0, -1).concat(la); lo = v.lo.slice(0, -1).concat(lo);
      head = rev ? pack.eto[o] : pack.efrom[o]; cur = o;
    }
    out.push({ cls, la, lo });
  }
  return out;
}

/**
 * Build one overview level.
 * @returns {{geojson: object, gz: Buffer, lines: number, points: number}}
 */
function overview(pack, toleranceM, decimals) {
  const ch = chains(pack, OVERVIEW_CLASSES);
  const byCls = { main: [], branch: [] };
  let points = 0;
  const q = 10 ** decimals;
  for (const c of ch) {
    const keep = simplify(c.la, c.lo, toleranceM);
    const line = [];
    let last = null;
    for (const i of keep) {
      const p = [Math.round(c.lo[i] * DEG7 * q) / q, Math.round(c.la[i] * DEG7 * q) / q];
      if (last && last[0] === p[0] && last[1] === p[1]) continue;
      line.push(p); last = p;
    }
    if (line.length < 2) continue;
    points += line.length;
    byCls[F.CLS_NAMES[c.cls]].push(line);
  }
  const geojson = {
    type: 'FeatureCollection',
    attribution: '© OpenStreetMap contributors (ODbL)',
    features: Object.entries(byCls).map(([k, lines]) => ({ type: 'Feature', properties: { class: k }, geometry: { type: 'MultiLineString', coordinates: lines } }))
  };
  const json = Buffer.from(JSON.stringify(geojson), 'utf8');
  const gz = zlib.gzipSync(json, { level: 9 });
  return { geojson, json, gz, lines: ch.length, points };
}

module.exports = { overview, chains, OVERVIEW_CLASSES };
