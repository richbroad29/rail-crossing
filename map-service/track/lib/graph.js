'use strict';

// OSM ways -> the track graph. See track/FORMAT.md and contract section 8 for the rules.
//
//  * Nodes of the graph are junctions and ends: a point that ends a way, or that two ways share, or
//    that a way visits twice. A railway=diamond_crossing node shared by two ways that both pass
//    straight through it is NOT a junction (the tracks cross, they do not connect).
//  * Edges are the stretches of way between graph nodes, keeping the way's own direction.
//  * Tunnels are track like any other. The TUNNEL flag (tunnel=*, covered=yes, layer<0) is metadata
//    only; nothing here or downstream filters on it.
//  * Components under 200 m of track are dropped; so are light_rail components that touch no rail.

const F = require('../../src/track/format');
const { KY, DEG7, kxAt } = require('../../src/track/geom');
const { lowerBound } = require('./osm-extract');

const MIN_COMPONENT_M = 200;

const yes = v => v === 'yes' || v === 'true' || v === '1';

function classify(tags) {
  const svc = tags.service, use = tags.usage;
  if (svc === 'crossover') return F.CLS.CROSSOVER;
  if (svc === 'siding' || svc === 'spur') return F.CLS.SIDING;
  if (svc === 'yard') return F.CLS.YARD;
  if (use === 'main') return F.CLS.MAIN;
  if (use === 'branch') return F.CLS.BRANCH;
  if (use === 'industrial' || use === 'military' || use === 'tourism' || use === 'test') return F.CLS.OTHER;
  return F.CLS.BRANCH;       // untagged: a running line of unknown standing
}

function electrification(tags) {
  const v = tags.electrified;
  if (!v) return F.ELEC.UNKNOWN;
  if (v === 'no') return F.ELEC.NONE;
  if (/contact_line|overhead|^yes$/.test(v)) return F.ELEC.OVERHEAD;
  if (/^rail$|third/.test(v)) return F.ELEC.THIRD_RAIL;
  return F.ELEC.OTHER;
}

/** maxspeed in mph (u8), 0 if unknown. OSM in Britain says "60 mph"; a bare number is km/h. */
function maxspeedMph(tags) {
  const v = tags.maxspeed;
  if (!v) return 0;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(mph|km\/h)?/.exec(v);
  if (!m) return 0;
  let n = Number(m[1]);
  if (m[2] !== 'mph') n = n * 0.621371;
  return Math.max(0, Math.min(255, Math.round(n)));
}

function isTunnel(tags) {
  const t = tags.tunnel;
  if (t && t !== 'no') return true;
  if (yes(tags.covered)) return true;
  const layer = tags.layer;
  if (layer && layer.split(';').some(x => Number(x) < 0)) return true;
  return false;
}

function flags(tags) {
  let f = 0;
  if (isTunnel(tags)) f |= F.FLG.TUNNEL;
  if (tags.bridge && tags.bridge !== 'no') f |= F.FLG.BRIDGE;
  if (tags.railway === 'light_rail') f |= F.FLG.LIGHT_RAIL;
  return f;
}

/** Douglas-Peucker on integer lat/lon vertex arrays; returns the kept indices (ascending), ends always kept. */
function simplify(la, lo, tolM) {
  const n = la.length;
  if (n <= 2) return n === 2 ? [0, 1] : [0];
  const kx = kxAt(la[n >> 1]);
  const x = new Float64Array(n), y = new Float64Array(n);
  for (let i = 0; i < n; i++) { x[i] = (lo[i] - lo[0]) * DEG7 * kx; y[i] = (la[i] - la[0]) * DEG7 * KY; }
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [0, n - 1];
  const tol2 = tolM * tolM;
  while (stack.length) {
    const b = stack.pop(), a = stack.pop();
    if (b - a < 2) continue;
    const dx = x[b] - x[a], dy = y[b] - y[a], len2 = dx * dx + dy * dy;
    let worst = -1, wi = -1;
    for (let i = a + 1; i < b; i++) {
      let d2;
      if (len2 === 0) { const ex = x[i] - x[a], ey = y[i] - y[a]; d2 = ex * ex + ey * ey; }
      else {
        let t = ((x[i] - x[a]) * dx + (y[i] - y[a]) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = x[i] - (x[a] + t * dx), ey = y[i] - (y[a] + t * dy);
        d2 = ex * ex + ey * ey;
      }
      if (d2 > worst) { worst = d2; wi = i; }
    }
    if (worst > tol2) { keep[wi] = 1; stack.push(a, wi, wi, b); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

class DSU {
  constructor(n) { this.p = new Int32Array(n).map((_, i) => i); }
  find(a) { while (this.p[a] !== a) { this.p[a] = this.p[this.p[a]]; a = this.p[a]; } return a; }
  union(a, b) { a = this.find(a); b = this.find(b); if (a !== b) this.p[a] = b; }
}

/**
 * @param {object} ex output of osm-extract.extract
 * @param {{tolerance?: number, log?: Function}} opts tolerance is the polyline simplification in metres
 * @returns graph: node arrays, edge arrays, per-edge original way index, strings, stats
 */
function buildGraph(ex, { tolerance = 1.0, log = () => {} } = {}) {
  const { ways, refs, wanted, lat, lon } = ex;
  const stats = { railWays: 0, skippedWays: 0, lightRailEdgesDropped: 0, fragmentsDropped: 0, fragmentMetresDropped: 0, duplicateEdges: 0 };

  // --- rail ways, node indices ---
  const rail = [];
  for (const w of ways) {
    const t = w.tags;
    if (t.railway !== 'rail' && t.railway !== 'light_rail') continue;
    if (yes(t.disused) || yes(t.abandoned) || t.construction || yes(t['railway:preserved'])) { stats.skippedWays++; continue; }
    if (w.len < 2) { stats.skippedWays++; continue; }
    rail.push(w);
  }
  stats.railWays = rail.length;
  let total = 0; for (const w of rail) total += w.len;
  const wn = new Int32Array(total);                 // concatenated wanted-indices per rail way
  const wStart = new Int32Array(rail.length + 1);
  let p = 0;
  rail.forEach((w, i) => {
    wStart[i] = p;
    for (let k = 0; k < w.len; k++) wn[p++] = lowerBound(wanted, refs[w.start + k]);
  });
  wStart[rail.length] = p;

  const occ = new Uint16Array(wanted.length), isEnd = new Uint8Array(wanted.length), diamond = new Uint8Array(wanted.length);
  for (let i = 0; i < rail.length; i++) {
    for (let k = wStart[i]; k < wStart[i + 1]; k++) { const n = wn[k]; if (occ[n] < 65535) occ[n]++; }
    isEnd[wn[wStart[i]]] = 1; isEnd[wn[wStart[i + 1] - 1]] = 1;
  }
  let diamonds = 0;
  for (const s of ex.special) if (s.tags.railway === 'diamond_crossing' || (s.tags.railway === 'railway_crossing' && !s.tags['railway:switch'])) { const n = lowerBound(wanted, s.id); if (wanted[n] === s.id) { diamond[n] = 1; diamonds++; } }
  stats.diamondCrossings = diamonds;
  const isJunction = n => isEnd[n] === 1 || occ[n] >= 3 || (occ[n] === 2 && !diamond[n]);

  // --- edges ---
  const gnode = new Int32Array(wanted.length).fill(-1);
  const nodeW = [];                                 // graph node -> wanted index
  const gn = (n) => { if (gnode[n] < 0) { gnode[n] = nodeW.length; nodeW.push(n); } return gnode[n]; };
  const eFrom = [], eTo = [], eWay = [], eS = [], eE = [];
  const seen = new Map();
  for (let i = 0; i < rail.length; i++) {
    let s = wStart[i];
    const end = wStart[i + 1] - 1;
    for (let k = s + 1; k <= end; k++) {
      if (k !== end && !isJunction(wn[k])) continue;
      const a = gn(wn[s]), b = gn(wn[k]);
      if (a === b && k - s < 3) { s = k; continue; }          // a degenerate loop of one segment
      // identical ways drawn twice: same ends and same interior
      const key = a + ':' + b + ':' + (k - s) + ':' + (k - s > 1 ? wn[s + 1] : '');
      const dupOf = seen.get(key);
      let dup = false;
      if (dupOf !== undefined && dupOf.some(j => { let same = true; for (let q = 0; q <= k - s; q++) if (wn[eS[j] + q] !== wn[s + q]) { same = false; break; } return same; })) dup = true;
      if (dup) stats.duplicateEdges++;
      else {
        eFrom.push(a); eTo.push(b); eWay.push(i); eS.push(s); eE.push(k);
        const list = seen.get(key); if (list) list.push(eFrom.length - 1); else seen.set(key, [eFrom.length - 1]);
      }
      s = k;
    }
  }
  const E0 = eFrom.length;
  log(`graph: ${rail.length} ways -> ${E0} raw edges, ${nodeW.length} nodes (${stats.duplicateEdges} duplicate edges, ${diamonds} diamond-crossing nodes)`);

  // --- components, fragments ---
  const dsu = new DSU(nodeW.length);
  const lens = new Float64Array(E0);
  for (let e = 0; e < E0; e++) {
    dsu.union(eFrom[e], eTo[e]);
    let L = 0;
    for (let k = eS[e]; k < eE[e]; k++) {
      const a = wn[k], b = wn[k + 1];
      const kx = kxAt((lat[a] + lat[b]) / 2);
      const dy = (lat[b] - lat[a]) * DEG7 * KY, dx = (lon[b] - lon[a]) * DEG7 * kx;
      L += Math.sqrt(dx * dx + dy * dy);
    }
    lens[e] = L;
  }
  const compLen = new Float64Array(nodeW.length), compRail = new Uint8Array(nodeW.length);
  for (let e = 0; e < E0; e++) {
    const c = dsu.find(eFrom[e]);
    compLen[c] += lens[e];
    if (rail[eWay[e]].tags.railway === 'rail') compRail[c] = 1;
  }
  const keepE = new Uint8Array(E0);
  for (let e = 0; e < E0; e++) {
    const c = dsu.find(eFrom[e]);
    if (compLen[c] < MIN_COMPONENT_M) { stats.fragmentMetresDropped += lens[e]; continue; }
    if (!compRail[c]) { stats.lightRailEdgesDropped++; continue; }
    keepE[e] = 1;
  }
  const seenComp = new Set();
  for (let e = 0; e < E0; e++) if (!keepE[e]) seenComp.add(dsu.find(eFrom[e]));
  stats.fragmentsDropped = seenComp.size;

  // --- compact nodes, simplify, assemble ---
  const newNode = new Int32Array(nodeW.length).fill(-1);
  const nLat = [], nLon = [];
  const useNode = (g) => { if (newNode[g] < 0) { newNode[g] = nLat.length; nLat.push(lat[nodeW[g]]); nLon.push(lon[nodeW[g]]); } return newNode[g]; };
  const edges = { from: [], to: [], way: [], vstart: [0], vlat: [], vlon: [], rawEdge: [] };
  let rawVertices = 0;
  const signalEdge = new Map();                      // wanted node index -> new edge index (for on-way signals)
  const sigNodes = new Set();
  for (const s of ex.special) if (s.tags.railway === 'signal') { const n = lowerBound(wanted, s.id); if (wanted[n] === s.id) sigNodes.add(n); }
  const newEdgeOf = new Int32Array(E0).fill(-1);
  for (let e = 0; e < E0; e++) {
    if (!keepE[e]) continue;
    const n = eE[e] - eS[e] + 1;
    const la = new Int32Array(n), lo = new Int32Array(n);
    for (let q = 0; q < n; q++) { la[q] = lat[wn[eS[e] + q]]; lo[q] = lon[wn[eS[e] + q]]; }
    rawVertices += n;
    const keep = simplify(la, lo, tolerance);
    const idx = edges.from.length;
    newEdgeOf[e] = idx;
    edges.from.push(useNode(eFrom[e])); edges.to.push(useNode(eTo[e])); edges.way.push(eWay[e]); edges.rawEdge.push(e);
    for (const q of keep) { edges.vlat.push(la[q]); edges.vlon.push(lo[q]); }
    edges.vstart.push(edges.vlat.length);
    for (let q = 1; q < n - 1; q++) if (sigNodes.has(wn[eS[e] + q])) signalEdge.set(wn[eS[e] + q], idx);
  }
  // signals that sit exactly on a junction node belong to every edge there; pick the first kept
  for (let e = 0; e < E0; e++) {
    if (!keepE[e]) continue;
    for (const q of [eS[e], eE[e]]) if (sigNodes.has(wn[q]) && !signalEdge.has(wn[q])) signalEdge.set(wn[q], newEdgeOf[e]);
  }
  stats.rawVertices = rawVertices;
  stats.keptVertices = edges.vlat.length;
  stats.rawEdges = E0;
  log(`graph: kept ${edges.from.length} edges, ${nLat.length} nodes; vertices ${rawVertices} -> ${edges.vlat.length} at ${tolerance} m; dropped ${stats.fragmentsDropped} fragments/light-rail islands (${Math.round(stats.fragmentMetresDropped)} m)`);
  return { nLat, nLon, edges, rail, tagsOf: i => rail[i].tags, signalEdge, stats, wanted };
}

module.exports = { buildGraph, classify, electrification, maxspeedMph, flags, isTunnel, simplify, MIN_COMPONENT_M };
