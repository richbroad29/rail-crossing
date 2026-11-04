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

const STITCH_M = 1.0;          // a dangling end this close to another running edge, on the same level, is joined to it

/** The level a way runs on: tunnel, bridge and layer. Two ways are on the same level only if all three agree. */
function levelKey(t) {
  const layer = t.layer ? Number(String(t.layer).split(';')[0]) : 0;
  return (isTunnel(t) ? 'T' : '-') + (t.bridge && t.bridge !== 'no' ? 'B' : '-') + (Number.isFinite(layer) ? layer : 0);
}

/** Metres from point (la, lo) to the segment a-b (all 1e-7 degree integers), and the fraction along it. */
function pointSegment(la, lo, a_la, a_lo, b_la, b_lo) {
  const kx = kxAt(la);
  const ax = (a_lo - lo) * DEG7 * kx, ay = (a_la - la) * DEG7 * KY, bx = (b_lo - lo) * DEG7 * kx, by = (b_la - la) * DEG7 * KY;
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { d: Math.hypot(ax + t * dx, ay + t * dy), t };
}

/**
 * @param {object} ex output of osm-extract.extract
 * @param {{tolerance?: number, log?: Function}} opts tolerance is the polyline simplification in metres
 * @returns graph: node arrays, edge arrays, per-edge original way index, strings, stats
 */
function buildGraph(ex, { tolerance = 1.0, stitch = true, log = () => {} } = {}) {
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

  // --- vertices of an edge: its slice of the way, unless stitching has rewritten it ---
  const override = new Map();       // edge -> {la, lo, id}  (id = wanted index of the OSM node, or -1 for an inserted vertex)
  const vertsOf = (e) => {
    const o = override.get(e);
    if (o) return o;
    const n = eE[e] - eS[e] + 1;
    const la = new Int32Array(n), lo = new Int32Array(n), id = new Int32Array(n);
    for (let q = 0; q < n; q++) { const w = wn[eS[e] + q]; la[q] = lat[w]; lo[q] = lon[w]; id[q] = w; }
    return { la, lo, id };
  };
  const levelOfEdge = (e) => levelKey(rail[eWay[e]].tags);

  // --- stitching: a dangling end within 1 m of another running edge, on the SAME level, is joined to it ---
  // OSM mappers sometimes end a way a few centimetres short of the track it should meet. Joining across levels
  // would be worse than the gap: a bridge over a line, or a line over a dive-under, is within a metre of the one
  // below it in plan and must never connect, so tunnel, bridge and layer must all agree.
  const stitches = [];
  stats.stitchJoined = 0; stats.stitchMergedWithNode = 0; stats.stitchRefusedOtherLevel = 0; stats.stitchCandidates = 0;
  if (stitch) {
    const degree = new Uint32Array(nodeW.length);
    for (let e = 0; e < eFrom.length; e++) { degree[eFrom[e]]++; degree[eTo[e]]++; }
    const ownEdge = new Map();                      // dangling node -> its only edge
    for (let e = 0; e < eFrom.length; e++) { if (degree[eFrom[e]] === 1) ownEdge.set(eFrom[e], e); if (degree[eTo[e]] === 1) ownEdge.set(eTo[e], e); }
    const CELL_LA = 2000, CELL_LO = 3200;           // ~22 m
    const cellKey = (la, lo) => Math.floor((la - 49e7) / CELL_LA) * 1e6 + Math.floor((lo + 10e7) / CELL_LO);
    const dMap = new Map();
    for (const [d] of ownEdge) { const w = nodeW[d]; const k = cellKey(lat[w], lon[w]); const l = dMap.get(k); if (l) l.push(d); else dMap.set(k, [d]); }
    const best = new Map();                         // dangling node -> {edge, d}
    const seenRefused = new Set();
    for (let e = 0; e < eFrom.length; e++) {
      const V = vertsOf(e);
      for (let q = 0; q + 1 < V.la.length; q++) {
        const c0 = Math.floor((Math.min(V.la[q], V.la[q + 1]) - 49e7) / CELL_LA) - 1, c1 = Math.floor((Math.max(V.la[q], V.la[q + 1]) - 49e7) / CELL_LA) + 1;
        const x0 = Math.floor((Math.min(V.lo[q], V.lo[q + 1]) + 10e7) / CELL_LO) - 1, x1 = Math.floor((Math.max(V.lo[q], V.lo[q + 1]) + 10e7) / CELL_LO) + 1;
        for (let cy = c0; cy <= c1; cy++) for (let cx = x0; cx <= x1; cx++) {
          const list = dMap.get(cy * 1e6 + cx);
          if (!list) continue;
          for (const d of list) {
            if (ownEdge.get(d) === e || eFrom[e] === d || eTo[e] === d) continue;
            const w = nodeW[d];
            const r = pointSegment(lat[w], lon[w], V.la[q], V.lo[q], V.la[q + 1], V.lo[q + 1]);
            if (r.d > STITCH_M) continue;
            if (levelOfEdge(e) !== levelOfEdge(ownEdge.get(d))) { const key = d + ':' + e; if (!seenRefused.has(key)) { seenRefused.add(key); stats.stitchRefusedOtherLevel++; stitches.push({ kind: 'refused-other-level', lat: lat[w] * DEG7, lon: lon[w] * DEG7, dist: r.d, levels: [levelOfEdge(ownEdge.get(d)), levelOfEdge(e)] }); } continue; }
            const cur = best.get(d);
            if (!cur || r.d < cur.d) best.set(d, { edge: e, d: r.d });
          }
        }
      }
    }
    stats.stitchCandidates = best.size;
    const family = new Map();                       // original edge -> every edge it has been split into
    const famOf = (e) => family.get(e) || [e];
    const dangling = [...best.entries()].sort((a, b) => a[0] - b[0]);
    for (const [d, c] of dangling) {
      if (degree[d] !== 1) continue;
      const E = ownEdge.get(d), w = nodeW[d], dla = lat[w], dlo = lon[w];
      // re-find the target among the pieces its edge has been split into so far
      let tgt = null;
      for (const f of famOf(c.edge)) {
        const V = vertsOf(f);
        for (let q = 0; q + 1 < V.la.length; q++) {
          const r = pointSegment(dla, dlo, V.la[q], V.lo[q], V.la[q + 1], V.lo[q + 1]);
          if (r.d <= STITCH_M && (!tgt || r.d < tgt.d)) tgt = { f, q, d: r.d };
        }
      }
      if (!tgt) continue;
      const F = tgt.f, V = vertsOf(F), n = V.la.length;
      const distTo = (i) => Math.hypot((V.la[i] - dla) * DEG7 * KY, (V.lo[i] - dlo) * DEG7 * kxAt(dla));
      if (distTo(0) <= 0.5 || distTo(n - 1) <= 0.5) {
        // it ends on (or against) the end node of F: merge the two nodes
        const N = distTo(0) <= distTo(n - 1) ? eFrom[F] : eTo[F];
        const VE = vertsOf(E);
        const copy = { la: Int32Array.from(VE.la), lo: Int32Array.from(VE.lo), id: Int32Array.from(VE.id) };
        const atStart = eFrom[E] === d;
        const i = atStart ? 0 : copy.la.length - 1;
        copy.la[i] = lat[nodeW[N]]; copy.lo[i] = lon[nodeW[N]]; copy.id[i] = nodeW[N];
        override.set(E, copy);
        if (atStart) eFrom[E] = N; else eTo[E] = N;
        degree[d] = 0; degree[N]++;
        stats.stitchMergedWithNode++;
        stitches.push({ kind: 'merged', lat: dla * DEG7, lon: dlo * DEG7, dist: tgt.d });
        continue;
      }
      // otherwise split F at the dangling end, which becomes a three-way junction
      let at = tgt.q + 1;                           // index of the vertex that starts the second half
      let la1, lo1, id1, la2, lo2, id2;
      const near = (i) => distTo(i) <= 0.3 && i > 0 && i < n - 1;
      if (near(tgt.q)) at = tgt.q + 0;              // a vertex of F is already there: reuse it (moved onto the dangling end)
      else if (near(tgt.q + 1)) at = tgt.q + 1;
      const reuse = near(tgt.q) || near(tgt.q + 1);
      const cut = reuse ? at : tgt.q + 1;
      la1 = Array.from(V.la.subarray(0, cut)); lo1 = Array.from(V.lo.subarray(0, cut)); id1 = Array.from(V.id.subarray(0, cut));
      la1.push(dla); lo1.push(dlo); id1.push(w);
      la2 = [dla]; lo2 = [dlo]; id2 = [w];
      const rest = reuse ? cut + 1 : cut;
      for (let i = rest; i < n; i++) { la2.push(V.la[i]); lo2.push(V.lo[i]); id2.push(V.id[i]); }
      const F2 = eFrom.length;
      eFrom.push(d); eTo.push(eTo[F]); eWay.push(eWay[F]); eS.push(-1); eE.push(-1);
      eTo[F] = d;
      override.set(F, { la: Int32Array.from(la1), lo: Int32Array.from(lo1), id: Int32Array.from(id1) });
      override.set(F2, { la: Int32Array.from(la2), lo: Int32Array.from(lo2), id: Int32Array.from(id2) });
      let root = c.edge;
      for (const [k, v] of family) if (v.includes(F)) { root = k; break; }
      const fam = family.get(root) || [root]; fam.push(F2); family.set(root, fam);
      degree[d] = 3;
      stats.stitchJoined++;
      stitches.push({ kind: 'joined', lat: dla * DEG7, lon: dlo * DEG7, dist: tgt.d, level: levelOfEdge(E) });
    }
    log(`stitching: ${stats.stitchJoined} dangling ends joined to a running edge, ${stats.stitchMergedWithNode} merged into an end node, ${stats.stitchRefusedOtherLevel} candidate joins refused because the levels differ (bridge/tunnel/layer)`);
  }

  // --- components, fragments ---
  const E1 = eFrom.length;
  const dsu = new DSU(nodeW.length);
  const lens = new Float64Array(E1);
  for (let e = 0; e < E1; e++) {
    dsu.union(eFrom[e], eTo[e]);
    const V = vertsOf(e);
    let L = 0;
    for (let k = 0; k + 1 < V.la.length; k++) {
      const kx = kxAt((V.la[k] + V.la[k + 1]) / 2);
      const dy = (V.la[k + 1] - V.la[k]) * DEG7 * KY, dx = (V.lo[k + 1] - V.lo[k]) * DEG7 * kx;
      L += Math.sqrt(dx * dx + dy * dy);
    }
    lens[e] = L;
  }
  const compLen = new Float64Array(nodeW.length), compRail = new Uint8Array(nodeW.length);
  for (let e = 0; e < E1; e++) {
    const c = dsu.find(eFrom[e]);
    compLen[c] += lens[e];
    if (rail[eWay[e]].tags.railway === 'rail') compRail[c] = 1;
  }
  const keepE = new Uint8Array(E1);
  for (let e = 0; e < E1; e++) {
    const c = dsu.find(eFrom[e]);
    if (compLen[c] < MIN_COMPONENT_M) { stats.fragmentMetresDropped += lens[e]; continue; }
    if (!compRail[c]) { stats.lightRailEdgesDropped++; continue; }
    keepE[e] = 1;
  }
  const seenComp = new Set();
  for (let e = 0; e < E1; e++) if (!keepE[e]) seenComp.add(dsu.find(eFrom[e]));
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
  const newEdgeOf = new Int32Array(E1).fill(-1);
  for (let e = 0; e < E1; e++) {
    if (!keepE[e]) continue;
    const V = vertsOf(e);
    const n = V.la.length, la = V.la, lo = V.lo;
    rawVertices += n;
    const keep = simplify(la, lo, tolerance);
    const idx = edges.from.length;
    newEdgeOf[e] = idx;
    edges.from.push(useNode(eFrom[e])); edges.to.push(useNode(eTo[e])); edges.way.push(eWay[e]); edges.rawEdge.push(e);
    for (const q of keep) { edges.vlat.push(la[q]); edges.vlon.push(lo[q]); }
    edges.vstart.push(edges.vlat.length);
    for (let q = 1; q < n - 1; q++) if (V.id[q] >= 0 && sigNodes.has(V.id[q])) signalEdge.set(V.id[q], idx);
  }
  // signals that sit exactly on a junction node belong to every edge there; pick the first kept
  for (let e = 0; e < E1; e++) {
    if (!keepE[e]) continue;
    const V = vertsOf(e);
    for (const q of [0, V.id.length - 1]) if (V.id[q] >= 0 && sigNodes.has(V.id[q]) && !signalEdge.has(V.id[q])) signalEdge.set(V.id[q], newEdgeOf[e]);
  }
  stats.rawVertices = rawVertices;
  stats.keptVertices = edges.vlat.length;
  stats.rawEdges = E1;
  log(`graph: kept ${edges.from.length} edges, ${nLat.length} nodes; vertices ${rawVertices} -> ${edges.vlat.length} at ${tolerance} m; dropped ${stats.fragmentsDropped} fragments/light-rail islands (${Math.round(stats.fragmentMetresDropped)} m)`);
  return { nLat, nLon, edges, rail, tagsOf: i => rail[i].tags, signalEdge, stats, wanted, stitches, levelKey };
}

module.exports = { buildGraph, levelKey, classify, electrification, maxspeedMph, flags, isTunnel, simplify, MIN_COMPONENT_M };
