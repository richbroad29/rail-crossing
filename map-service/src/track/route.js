'use strict';

// Routing over the track graph, and the geometry of a route.
//
// Search states are DIRECTED EDGES (edge * 2 + reversed), not nodes, for two reasons a plain node graph
// cannot express: a train cannot turn from one leg of a junction straight onto the other (heel to heel,
// a deflection near 180 degrees), and it cannot reverse along the track it just used. Both are one
// comparison per relaxation against the edge-end bearings the pack precomputes at load.
//
// State d = (edge e, direction) means "travelling along e in that direction, about to reach its far
// node"; its g is the metres from the start snap to that far node. A* by length; the heuristic is the
// straight-line distance from that node to the goal point, scaled with the SMALLER longitude scale of
// the two latitudes so it never overestimates.

const F = require('./format');
const { KY, DEG7, kxAt, bearing7, angDiff, RAD } = require('./geom');

const DEFAULT_MAX_DEFLECTION = 100;

class RouteState {
  constructor(pack) {
    const n = pack.nEdges * 2;
    this.st = new Uint32Array(n);          // gen*2 = reached in this search, gen*2+1 = closed
    this.g = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.gen = 0;
    this.cap = 1 << 14;
    this.hf = new Float64Array(this.cap);
    this.hs = new Int32Array(this.cap);
    this.size = 0;
  }
  bytes() { return this.st.byteLength + this.g.byteLength + this.parent.byteLength + this.hf.byteLength + this.hs.byteLength; }
  push(f, s) {
    if (this.size === this.cap) {
      this.cap *= 2;
      const hf = new Float64Array(this.cap); hf.set(this.hf); this.hf = hf;
      const hs = new Int32Array(this.cap); hs.set(this.hs); this.hs = hs;
    }
    const { hf, hs } = this;
    let i = this.size++;
    while (i > 0) { const p = (i - 1) >> 1; if (hf[p] <= f) break; hf[i] = hf[p]; hs[i] = hs[p]; i = p; }
    hf[i] = f; hs[i] = s;
  }
  pop() {           // returns the state; its f is left in this.lastF
    const { hf, hs } = this;
    const s = hs[0]; this.lastF = hf[0];
    const n = --this.size;
    if (n > 0) {
      const f = hf[n], t = hs[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && hf[c + 1] < hf[c]) c++;
        if (hf[c] >= f) break;
        hf[i] = hf[c]; hs[i] = hs[c]; i = c;
      }
      hf[i] = f; hs[i] = t;
    }
    return s;
  }
}

function routeBetween(pack, from, to, opts) {
  const froms = Array.isArray(from) ? from : [from], tos = Array.isArray(to) ? to : [to];
  for (const x of froms.concat(tos)) if (!x || !Number.isFinite(x.edge) || !Number.isFinite(x.offset)) throw new TypeError('route(): each end must be a snap ({edge, offset, ...}) or an array of them');
  if (!froms.length || !tos.length) return null;
  const { efrom, eto, ecls, adjo, adj, vcum, evo, bStart, bEnd } = pack;
  const lenOf = e => vcum[evo[e + 1] - 1];
  const srcs = froms.map(f => ({ snap: f, e: f.edge, o: Math.max(0, Math.min(lenOf(f.edge), f.offset)) }));
  const goals = tos.map(t => ({ snap: t, e: t.edge, o: Math.max(0, Math.min(lenOf(t.edge), t.offset)), lat: Math.round(t.lat * 1e7), lon: Math.round(t.lon * 1e7) }));
  const goalsAt = new Map();
  for (const g of goals) { const l = goalsAt.get(g.e); if (l) l.push(g); else goalsAt.set(g.e, [g]); }
  const srcEdges = new Set(srcs.map(s => s.e));
  const maxLen = opts.maxLength === undefined ? Infinity : opts.maxLength;
  const mk = (length, pieces, src, goal) => ({ length, pieces: pieces.filter(p => Math.abs(p.b - p.a) > 1e-6 || pieces.length === 1), from: src.snap, to: goal.snap, _geom: null });

  // the same edge: a straight run along it (always the shortest between two points of one edge)
  let best = null, bestCost = maxLen;
  for (const s of srcs) for (const g of goalsAt.get(s.e) || []) {
    const c = Math.abs(g.o - s.o);
    if (c < bestCost) { bestCost = c; best = { direct: true, s, g }; }
  }

  const rs = pack._route || (pack._route = new RouteState(pack));
  const gen = ++rs.gen;
  const { st, g: gArr, parent } = rs;
  rs.size = 0;
  const avoid = !!opts.avoidSidings;
  const maxDefl = opts.maxDeflection === undefined ? DEFAULT_MAX_DEFLECTION : opts.maxDeflection;
  const { NLAT, NLON } = pack.s;
  const h = (node) => {
    const la = NLAT[node], lo = NLON[node];
    let m = Infinity;
    for (const g of goals) {
      const kx = KY * Math.cos(Math.max(Math.abs(la), Math.abs(g.lat)) * DEG7 * RAD);
      const dy = (g.lat - la) * DEG7 * KY, dx = (g.lon - lo) * DEG7 * kx;
      const d = dx * dx + dy * dy;
      if (d < m) m = d;
    }
    return Math.sqrt(m);
  };
  const endNode = d => ((d & 1) ? efrom[d >> 1] : eto[d >> 1]);
  const startBearing = d => ((d & 1) ? (bEnd[d >> 1] + 180) % 360 : bStart[d >> 1]);
  const endBearing = d => ((d & 1) ? (bStart[d >> 1] + 180) % 360 : bEnd[d >> 1]);
  const usable = (e) => !avoid || srcEdges.has(e) || goalsAt.has(e) || (ecls[e] !== F.CLS.SIDING && ecls[e] !== F.CLS.YARD);

  const startOf = new Map();                          // start state -> source it came from
  const reach = (s, cost, par) => {
    st[s] = gen * 2; gArr[s] = cost; parent[s] = par;
    rs.push(cost + h(endNode(s)), s);
  };
  for (const s of srcs) {
    for (const dir of [0, 1]) {
      const d = s.e * 2 + dir, cost = dir ? s.o : lenOf(s.e) - s.o;
      if (cost >= bestCost) continue;
      if (st[d] === gen * 2 && gArr[d] <= cost) continue;
      startOf.set(d, s);
      reach(d, cost, -1);
    }
  }
  let bestPrev = -2, bestDir = 0, bestGoal = null;
  while (rs.size) {
    const d = rs.pop();
    if (st[d] === gen * 2 + 1) continue;
    if (rs.lastF >= bestCost) break;
    st[d] = gen * 2 + 1;
    const gd = gArr[d];
    const node = endNode(d);
    const inBearing = endBearing(d);
    for (let i = adjo[node]; i < adjo[node + 1]; i++) {
      const d2 = adj[i];                         // (edge << 1) | reversed, leaving `node`
      if (d2 === (d ^ 1)) continue;              // straight back along the same edge
      const e2 = d2 >> 1;
      if (!usable(e2)) continue;
      if (angDiff(inBearing, startBearing(d2)) > maxDefl) continue;
      const gl = goalsAt.get(e2);
      if (gl) {
        const len2 = lenOf(e2);
        for (const g of gl) {
          const cost = gd + ((d2 & 1) ? len2 - g.o : g.o);
          if (cost < bestCost) { bestCost = cost; bestPrev = d; bestDir = d2 & 1; bestGoal = g; best = { direct: false }; }
        }
        continue;
      }
      const ng = gd + lenOf(e2);
      if (ng >= bestCost) continue;
      const cur = st[d2];
      if (cur === gen * 2 + 1) continue;
      if (cur === gen * 2 && gArr[d2] <= ng) continue;
      reach(d2, ng, d);
    }
  }
  if (!best) return null;
  if (best.direct) return mk(bestCost, [{ e: best.s.e, dir: best.g.o >= best.s.o ? 0 : 1, a: best.s.o, b: best.g.o }], best.s, best.g);

  // Rebuild the pieces: the goal edge, the chain of whole edges, the start edge.
  const lenB = lenOf(bestGoal.e);
  const pieces = [{ e: bestGoal.e, dir: bestDir, a: bestDir ? lenB : 0, b: bestGoal.o }];
  let src = null;
  for (let d = bestPrev; d !== -1; d = parent[d]) {
    const e = d >> 1, len = lenOf(e), dir = d & 1;
    if (parent[d] === -1) { src = startOf.get(d); pieces.push({ e, dir, a: src.o, b: dir ? 0 : len }); }
    else pieces.push({ e, dir, a: dir ? len : 0, b: dir ? 0 : len });
  }
  pieces.reverse();
  return mk(bestCost, pieces, src, bestGoal);
}

// ---- geometry of a route ---------------------------------------------------------------------------

/** Position (1e-7 degrees, fractional) at `off` metres along edge e. */
function atOffset(pack, e, off) {
  const { evo, vcum, vlat, vlon } = pack;
  const a = evo[e], b = evo[e + 1] - 1;
  let lo = a, hi = b;
  if (off <= 0) return [vlat[a], vlon[a], a];
  if (off >= vcum[b]) return [vlat[b], vlon[b], b - 1];
  while (hi - lo > 1) { const m = (lo + hi) >>> 1; if (vcum[m] <= off) lo = m; else hi = m; }
  const span = vcum[lo + 1] - vcum[lo];
  const t = span > 0 ? (off - vcum[lo]) / span : 0;
  return [vlat[lo] + t * (vlat[lo + 1] - vlat[lo]), vlon[lo] + t * (vlon[lo + 1] - vlon[lo]), lo];
}

function geomOf(pack, route) {
  if (route._geom) return route._geom;
  const la = [], lo = [], cum = [];
  let base = 0;
  const { evo, vcum, vlat, vlon } = pack;
  for (const p of route.pieces) {
    const lowOff = Math.min(p.a, p.b), highOff = Math.max(p.a, p.b);
    const pts = [];                                   // [lat7, lon7, offset] ascending in offset
    const s = atOffset(pack, p.e, lowOff), t = atOffset(pack, p.e, highOff);
    pts.push([s[0], s[1], lowOff]);
    for (let v = evo[p.e] + 1; v < evo[p.e + 1] - 1; v++) if (vcum[v] > lowOff && vcum[v] < highOff) pts.push([vlat[v], vlon[v], vcum[v]]);
    pts.push([t[0], t[1], highOff]);
    if (p.b < p.a) pts.reverse();
    for (const q of pts) {
      const c = base + Math.abs(q[2] - p.a);
      if (cum.length && Math.abs(c - cum[cum.length - 1]) < 1e-9 && la[la.length - 1] === q[0] * DEG7 && lo[lo.length - 1] === q[1] * DEG7) continue;
      la.push(q[0] * DEG7); lo.push(q[1] * DEG7); cum.push(c);
    }
    base += Math.abs(p.b - p.a);
  }
  route._geom = { lat: Float64Array.from(la), lon: Float64Array.from(lo), cum: Float64Array.from(cum) };
  return route._geom;
}

function segIndex(cum, d) {                            // i such that cum[i] <= d < cum[i+1], clamped to a valid segment
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >>> 1; if (cum[m] <= d) lo = m; else hi = m; }
  return lo;
}

function interp(G, i, d) {
  const span = G.cum[i + 1] - G.cum[i];
  const t = span > 0 ? Math.max(0, Math.min(1, (d - G.cum[i]) / span)) : 0;
  return [G.lat[i] + t * (G.lat[i + 1] - G.lat[i]), G.lon[i] + t * (G.lon[i + 1] - G.lon[i])];
}

function bearingAt(G, i) {
  // the nearest segment with length (a zero-length one has no direction)
  for (let j = i; j + 1 < G.cum.length; j++) if (G.cum[j + 1] > G.cum[j]) return bearing7(Math.round(G.lat[j] * 1e7), Math.round(G.lon[j] * 1e7), Math.round(G.lat[j + 1] * 1e7), Math.round(G.lon[j + 1] * 1e7));
  for (let j = i - 1; j >= 0; j--) if (G.cum[j + 1] > G.cum[j]) return bearing7(Math.round(G.lat[j] * 1e7), Math.round(G.lon[j] * 1e7), Math.round(G.lat[j + 1] * 1e7), Math.round(G.lon[j + 1] * 1e7));
  return null;
}

/** {lat, lon, bearing} at distance d (metres, clamped to the route) along it. */
function pointOnRoute(pack, route, d) {
  const G = geomOf(pack, route);
  if (G.cum.length === 1) return { lat: G.lat[0], lon: G.lon[0], bearing: null };
  const dd = Math.max(0, Math.min(route.length, d));
  const i = segIndex(G.cum, dd);
  const [lat, lon] = interp(G, i, dd);
  return { lat, lon, bearing: bearingAt(G, i) };
}

/** The polyline [[lat, lon], ...] between distances d0 and d1 along the route (reversed if d0 > d1). */
function sliceRoute(pack, route, d0, d1) {
  const G = geomOf(pack, route);
  const rev = d0 > d1;
  const a = Math.max(0, Math.min(route.length, rev ? d1 : d0)), b = Math.max(0, Math.min(route.length, rev ? d0 : d1));
  const out = [];
  if (G.cum.length === 1) { out.push([G.lat[0], G.lon[0]]); return out; }
  const i0 = segIndex(G.cum, a), i1 = segIndex(G.cum, b);
  out.push(interp(G, i0, a));
  for (let i = i0 + 1; i <= i1; i++) if (G.cum[i] > a && G.cum[i] < b) out.push([G.lat[i], G.lon[i]]);
  if (b > a) out.push(interp(G, i1, b));
  return rev ? out.reverse() : out;
}

/**
 * Metres along `route` of the point at `offset` metres along `edge`, or null when the route does not run over that part of that
 * edge (a signal on another track, or beside the route's stretch). Offsets are the edge's own (from its first node), as in a snap.
 */
function alongRoute(pack, route, edge, offset, withDir = false) {
  let base = 0;
  for (const p of route.pieces) {
    const lo = Math.min(p.a, p.b), hi = Math.max(p.a, p.b), len = hi - lo;
    if (p.e === edge && offset >= lo - 0.5 && offset <= hi + 0.5) {
      const d = base + Math.abs(Math.max(lo, Math.min(hi, offset)) - p.a);
      return withDir ? { d, reversed: p.b < p.a } : d;          // reversed: the route runs against the edge's own direction here
    }
    base += len;
  }
  return null;
}

module.exports = { routeBetween, sliceRoute, pointOnRoute, alongRoute };
