'use strict';

// Berths on the track (contract section 9): every berth the model knows gets a SPAN, a polyline along
// the track graph from where trains enter it to where they leave it, for its most common
// (previous -> this -> next) path.
//
// THE TRACK LIBRARY (src/track, contract section 8) is used through exactly these calls:
//
//   track.stationSnaps(tiploc | name)   every platform-track snap of a PLACE (ALWAYS arrays: a single snap routes the wrong way)
//   track.route(snaps, snaps, {avoidSidings, maxLength}) -> route | null
//   track.slice(route, d0, d1)          -> [[lat, lon], ...]
//   track.alongRoute(route, edge, offset, true) -> {d, reversed} | null    (where a point lies along a route)
//   track.signals()                     -> [{edge, offset, ref, direction, side, onWay, dist, ...}]
//   track.snapAlong(route, d)           -> a DIRECTED snap {edge, offset, dir, lat, lon} at d metres along a route   (continuations only)
//   track.walk(snap, metres)            -> a route straight on from a directed snap                                  (continuations only)
//   track.nearestOnTrack(lat, lon, o)   -> snaps near a point                                                        (continuations only)
//   track.route(a, b, {dir on a snap})  a directed route                                                             (continuations only)
//
// RULES, in order:
//   1. Station-anchored berths (SMART) are pinned to the station: an ARRIVAL berth ENDS at the stop (mv.stop =
//      its length), a DEPARTURE berth STARTS there (mv.stop = 0). The stop is the end of route(), which picks the
//      platform track of each station's snap array that makes the shortest path.
//      SMART names the platform each berth uses at its station; where the pack has a snap for that platform, only its
//      snaps are offered to route(), so the two directions land on their own tracks (see _route for the fallback).
//   2. Between two pinned stops route() gives the path; the berths in between are cut from it in
//      proportion to their learned median PASS time (section 10). A berth with no median yet takes the MEAN of the chain's known
//      ones, equal shares only while none is known (section 17.2). The chain is cut over ALL its berths, those another chain
//      already claimed included: they keep the span of the chain that claimed them, but the berths that are left get their true
//      share of the route instead of a stretched one.
//   3. A signal whose OSM `ref` matches the berth id pins a boundary of the berth, ONLY where the match is unambiguous
//      and geometrically consistent: exactly one signal with that id lies on THIS route, it governs the direction of
//      travel (when the data says), it is not wildly far from where the berths' own lengths put the boundary (config
//      maxPinDeviation, 1.5 berth lengths), and the boundaries stay in order along the route. TD names a berth for the signal
//      it stands in rear of, so the signal is at the berth's END (`signalAt: 'end'`); `'start'` is the alternative the
//      measurement tool compares. The rate per TD area is reported by status().
//   4. IMPOSSIBLE SPANS (section 18.2). A chain walk that crosses berths nobody has observed can give one berth the whole
//      station-to-station route (live: 32.8 km for a berth that trains clear in 115 s). A berth gets NO span, and its trains keep
//      their phase-1 positions, when its length over its own learned PASS median, or its chain's route length over the sum of the
//      chain's medians (learned, or the section 17.2 partial fill), exceeds `maxImpliedMps` (default 60 m/s, a little over
//      125 mph). A chain with no learned median at all is cut in equal shares of nothing, so it has no speed to test and is kept.
//      A span that was built before the medians said so is withdrawn the same way, and a berth that stops being impossible gets
//      its span back at the next plan. status().impossible counts the berths and chains by TD area.
//   5. GAP CHAINS (section 18.5). Junction berths, and berths no station-to-station walk crosses, are left between spanned berths:
//      a train passing through them drops off the track and fades back in further on. After the station chains, a run of
//      1..`maxGapBerths` (4) berths with no station-chain span, whose best-previous berth and best-next berth both have one, is routed
//      from the previous span's END to the next span's START (directed, as the section 17.1 continuations are, within
//      2 x the crow distance + 500 m) and cut among the run's berths with the same weights. `rule.start = rule.end = 'gap'`; the
//      spans are passes (stop null), the 18.2 speed rule applies, and a station-chain span is never replaced (a berth that
//      later gets one takes it). The first gap span starts exactly where the previous span ends and the last ends exactly where the
//      next one starts. The pass runs after the station chains are cut, incrementally like them; status().gapChains reports it.
//   6. Span ids are `sp_<hash>` of what defines the span, so they are stable; a berth is re-cut only
//      when learning moves it by more than `recomputeFraction` (10 %) of its length, and then its id
//      changes. Superseded ids stay readable (the page may still hold one).
//
// CONTINUATIONS (section 17.1). Two spans of consecutive berths do not always meet: chains that end and start at different
// snaps of one station, parallel tracks, a train that stepped twice in one SSE batch. continuation(prev, of) answers "the span for
// berth `of`, entered from where span `prev` ended": it STARTS exactly at prev's last point and ends where its own route ends.
//   a. the shortest directed route from prev's end (the way prev runs) to of's end (the way of runs), no reversing, within
//      2 x length(of) + 500 m            -> how 'direct'
//   b. else the same to the nearest reachable non-siding point within 120 m of of's end           -> 'beside'
//   c. else straight on from prev's end for length(of), the smallest turn at each node             -> 'straight'
//   d. else of itself                                                                              -> 'fallback'
// and when prev's end is already within 2 m of of's start the answer IS of ('same'). A continuation has its own stable id (a hash
// of the two ids), resolves on a plain get(id) and can itself be a `prev`, so trains chain them. Only a small record per join is
// kept (bounded LRU, `maxJoins`): the geometry is recomputed when asked for, and an evicted join is rebuilt from its two ids.
//
// COST. The polyline is NOT stored per span: a span is {id, chain, d0, d1, length, stop} and its path
// is cut from the (LRU-cached) route when /span/:id is asked for. Building is incremental: step()
// does chains until its time budget is spent, so a 1 Hz tick is never held up.

const crypto = require('crypto');
const { haversineKm } = require('./geo');

const hash = text => 'sp_' + crypto.createHash('sha1').update(text).digest('hex').slice(0, 10);
const round5 = v => Math.round(v * 1e5) / 1e5;
/** Metres between two {lat, lon} points (flat-earth: only used for a few metres to a few kilometres). */
const metresBetween = (a, b) => Math.hypot((a.lat - b.lat) * 111195, (a.lon - b.lon) * 111195 * Math.cos(a.lat * Math.PI / 180));

/** Normalise a signal ref or berth id into match keys: the exact text, and (when numeric) the signal NUMBER. */
const exactKey = s => 'e' + String(s).toUpperCase().replace(/\s+/g, '');
const numberOf = s => { const m = /^[A-Z]{0,4}0*(\d{1,5})[A-Z]{0,2}$/.exec(String(s).toUpperCase().replace(/\s+/g, '')); return m ? 'n' + parseInt(m[1], 10) : null; };

class SpanBuilder {
  /**
   * @param {object} o
   * @param {object} o.track      the section-8 runtime library: a loaded TrackPack
   * @param {BerthGraph} o.graph
   * @param {TransitStore} o.transit
   * @param {object} o.config     config.spans
   * @param {function} [o.now]
   */
  constructor({ track, graph, transit, config, now = Date.now }) {
    this.track = track; this.graph = graph; this.transit = transit; this.cfg = config; this.now = now;
    this.byBerth = new Map();         // keyId -> span record
    this.byId = new Map();            // id -> span record (current)
    this.retired = new Map();         // id -> span record (superseded; bounded)
    this.queue = [];                  // chains waiting to be cut
    this.chains = new Map();          // chain key -> chain
    this.routes = new Map();          // chain key -> route (LRU)
    this.joins = new Map();           // join id -> join record (LRU: the oldest is first)
    this.endsCache = new Map();       // span id -> {start, end} directed snaps (LRU)
    this.joinStats = { same: 0, direct: 0, beside: 0, straight: 0, fallback: 0, unknownPrev: 0, evicted: 0 };
    this.snaps = new Map();           // station key -> snap array
    this._planned = { graph: -1, transit: -1, at: -Infinity };
    this._sig = null;
    this.hasSignals = typeof track.signals === 'function' && typeof track.alongRoute === 'function';
    this.hasJoins = typeof track.snapAlong === 'function' && typeof track.walk === 'function' && typeof track.nearestOnTrack === 'function';
    this.signalAt = config.signalAt || 'end';
    this.pinLog = [];
    this.gap = { active: false, cursor: 0, seen: new Set(), considered: 0, built: 0, beside: 0, noRoute: 0, tooFast: 0 };       // the section 18.5 pass over this plan
    this.gapTally = { considered: 0, built: 0, beside: 0, noRoute: 0, tooFast: 0 };       // the last COMPLETED pass
    this.impossible = new Map();      // keyId -> 'berth' | 'chain': berths with NO span because the speed it implies is too high (18.2)
    this.stats = { platform: { tried: 0, used: 0, refused: 0 }, chains: 0, built: 0, noRoute: 0, noSnap: 0, recut: 0, kept: 0, shared: 0, byArea: new Map(), rules: { stop: 0, signal: 0, learned: 0, equal: 0 } };
  }

  get size() { return this.byBerth.size; }

  /** A span's bounding box [s, w, n, e], from its canonical id (current or superseded: the record keeps it), or null when unknown. Contract 19.1. */
  bboxOf(id) { const r = this._canon(id); return r && r.box ? r.box : null; }

  forBerth(keyId) { const r = this.byBerth.get(keyId); return r ? { id: r.id, length: r.length, stop: r.stop } : null; }

  // ---- planning: which chains of berths lie between which stops ---------------------------------------------------

  /** Every snap of a station, as the library gives them (arrays, never one snap). */
  _snapsFor(stIdx) {
    const st = this.graph.stations[stIdx];
    if (this.snaps.has(st.key)) return this.snaps.get(st.key);
    let snaps = [];
    try {
      snaps = this.track.stationSnaps(st.key);
      if (!snaps.length && st.name) snaps = this.track.stationSnaps(st.name);
    } catch (_) { snaps = []; }
    if (!snaps.length) this.stats.noSnap++;
    this.snaps.set(st.key, snaps);
    return snaps;
  }

  /** The snaps of the platform SMART names for this berth, or null when none of the station's snaps carries that platform. */
  _platformSnaps(stIdx, platform) {
    if (!platform) return null;
    const want = String(platform).toLowerCase();
    const hit = this._snapsFor(stIdx).filter(sn => sn.platform && String(sn.platform).toLowerCase().split(/[;,/\s]+/).includes(want));
    return hit.length ? hit : null;
  }

  /**
   * Walk the most common path from every departure-anchored berth to the next arrival-anchored one. A chain keeps ALL its berths
   * (`berths`) so the route is cut over the whole of it; only the ones no earlier chain claimed (`build`) get a span from it.
   */
  _plan() {
    const g = this.graph, maxB = this.cfg.maxChainBerths || 14;
    const chains = [];
    const claimed = new Set();
    for (const [start, kind] of [...g.anchorKind].sort((a, b) => a[0] - b[0])) {
      if (kind === 'arr') continue;
      const fromSt = g.anchors.get(start);
      const berths = kind === 'dep' ? [start] : [];
      let cur = start, end = -1;
      for (let hops = 0; hops < maxB; hops++) {
        const nxt = g.bestNext(cur, true);
        if (nxt < 0 || nxt === start || berths.includes(nxt)) break;
        berths.push(nxt);
        const k = g.anchorKind.get(nxt);
        if ((k === 'arr' || k === 'both') && g.anchors.get(nxt) !== fromSt) { end = nxt; break; }
        cur = nxt;
      }
      if (end < 0 || !berths.length) continue;
      const toSt = g.anchors.get(end);
      const key = `${g.stations[fromSt].key}>${g.stations[toSt].key}:${g.keyOf[berths[0]]}`;
      const fresh = berths.filter(b => !claimed.has(b));
      this.stats.shared += berths.length - fresh.length;
      if (!fresh.length) continue;
      for (const b of fresh) claimed.add(b);
      chains.push({ key, fromSt, toSt, berths, build: new Set(fresh), firstIsDep: kind === 'dep', fromPlat: g.anchorPlat.get(start) || '', toPlat: g.anchorPlat.get(end) || '' });
    }
    this.stats.byArea = new Map();                              // the rule-3 tally describes THIS plan
    for (const c of chains) this.chains.set(c.key, c);          // older chains stay: superseded spans still resolve their paths
    this.queue = chains.slice();
    this.stats.chains = chains.length;
    this._planned = { graph: g.version, transit: this.transit.version, at: this.now() };
    this.gap = { active: true, cursor: 0, seen: new Set(), considered: 0, built: 0, beside: 0, noRoute: 0, tooFast: 0 };
  }

  _needsPlan() {
    const p = this._planned;
    if (p.graph === -1) return true;
    if (p.graph === this.graph.version && p.transit === this.transit.version) return false;
    return this.now() - p.at >= (this.cfg.replanSecs || 600) * 1000;
  }

  // ---- signals (rule 3) -------------------------------------------------------------------------------------------------

  _signalIndex() {
    if (this._sig) return this._sig;
    const m = new Map();
    const add = (k, s) => { if (!k) return; const l = m.get(k); if (l) l.push(s); else m.set(k, [s]); };
    let all = [];
    try { all = this.track.signals(); } catch (_) { all = []; }
    for (const s of all) {
      if (!s.ref) continue;
      add(exactKey(s.ref), s);
      const n = numberOf(s.ref);
      if (n) add(n, s);
    }
    this._sig = m;
    return m;
  }

  /** The candidate keys for a berth id: its exact text, and (for an all-digit id) its number. */
  _keysFor(berth) {
    const keys = [exactKey(berth)];
    if (/^\d{1,5}$/.test(berth)) keys.push('n' + parseInt(berth, 10));
    return keys;
  }

  _areaStats(area) {
    let a = this.stats.byArea.get(area);
    if (!a) { a = { berths: 0, idMatch: 0, onRoute: 0, unique: 0, pinned: 0, rejected: { ambiguous: 0, direction: 0, implausible: 0, order: 0 } }; this.stats.byArea.set(area, a); }
    return a;
  }

  /**
   * For boundary k (0..n) of the chain, the one unambiguous signal position along the route, or null.
   * Boundary k is the END of berth k-1 (signalAt 'end') or the START of berth k ('start').
   */
  _signalFor(chain, route, k) {
    const g = this.graph, n = chain.berths.length;
    const berthIx = this.signalAt === 'end' ? k - 1 : k;
    if (berthIx < 0 || berthIx >= n) return null;
    const id = chain.berths[berthIx];
    const area = g.areaOf[id], berth = g.berth(id);
    const A = this._areaStats(area);
    A.berths++;
    const seen = new Set();
    let cands = [];
    for (const key of this._keysFor(berth)) for (const s of this._signalIndex().get(key) || []) if (!seen.has(s)) { seen.add(s); cands.push(s); }
    if (cands.length) A.idMatch++;
    const on = [];
    for (const s of cands) {
      const r = this.track.alongRoute(route, s.edge, s.offset, true);
      if (r) on.push({ s, d: r.d, reversed: r.reversed });
    }
    if (!on.length) return null;
    A.onRoute++;
    // It must govern the direction of travel, where the data says which way it faces.
    const facing = on.filter(c => !(c.s.onWay && ((c.s.direction === 'forward' && c.reversed) || (c.s.direction === 'backward' && !c.reversed))));
    if (!facing.length) { A.rejected.direction++; return null; }
    // Unambiguous: every remaining candidate is the same signal position (two mapped nodes for one signal are not a conflict).
    facing.sort((a, b) => a.d - b.d);
    if (facing[facing.length - 1].d - facing[0].d > 30) { A.rejected.ambiguous++; return null; }
    A.unique++;
    return { d: facing[0].d, area };
  }

  // ---- building -----------------------------------------------------------------------------------------------------

  _lengthOf(route) { return Number.isFinite(route.length) ? route.length : 0; }

  _route(chain) {
    const hit = this.routes.get(chain.key);
    if (hit) { this.routes.delete(chain.key); this.routes.set(chain.key, hit); return hit; }
    if (chain.gap) return this._gapRoute(chain);
    const a = this._snapsFor(chain.fromSt), b = this._snapsFor(chain.toSt);
    if (!a.length || !b.length) return null;
    const g = this.graph, sa = g.stations[chain.fromSt], sb = g.stations[chain.toSt];
    const crow = haversineKm(sa, sb) * 1000;
    const opts = { avoidSidings: true, maxLength: crow * (this.cfg.maxDetour || 3) + 2000 };
    const go = (x, y) => { try { return this.track.route(x, y, opts) || null; } catch (_) { return null; } };
    let r = go(a, b);
    // SMART names the platform the trains use. Use only that platform's tracks where the pack knows them, so the two
    // directions end up on their own tracks; fall back to the shortest route if that is not a sane route (the platform
    // numbering of SMART and OSM do not always agree).
    const pa = this._platformSnaps(chain.fromSt, chain.fromPlat), pb = this._platformSnaps(chain.toSt, chain.toPlat);
    if (r && (pa || pb)) {
      this.stats.platform.tried++;
      const pr = go(pa || a, pb || b);
      if (pr && pr.length <= r.length * (this.cfg.platformDetour || 1.3) + 200) { if (pr.length !== r.length || pr.from !== r.from || pr.to !== r.to) this.stats.platform.used++; r = pr; }
      else this.stats.platform.refused++;
    }
    if (r) {
      this.routes.set(chain.key, r);
      while (this.routes.size > (this.cfg.routeCacheEntries || 300)) this.routes.delete(this.routes.keys().next().value);
    }
    return r;
  }

  _cut(chain, route) {
    const n = chain.berths.length;
    const L = this._lengthOf(route);
    if (!(L > 0)) return null;
    const meds = chain.berths.map(b => this.transit.passMedian(b));
    const known = meds.filter(m => m !== null && m > 0);
    const fill = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;       // a berth with no median yet is an average one
    const w = meds.map(m => (m !== null && m > 0 ? m : fill));
    const learned = known.length === n;
    const cw = [0];
    for (let i = 0; i < n; i++) cw.push(cw[i] + w[i]);
    const anchor = new Map([[0, 0], [n, L]]);                        // boundary index -> metres along the route (the two stops)
    const how = new Array(n + 1).fill(null);                         // what fixed each boundary: 'stop' | 'signal'
    how[0] = how[n] = 'stop';
    if (chain.gap) how.fill('gap');                                  // a gap run is cut wholly from its two end spans (rule.start = rule.end = 'gap')
    if (this.hasSignals && !chain.gap) {
      // Candidate pins, then the largest set that keeps the boundaries in order (a stray match is dropped, not trusted).
      const pins = [];
      const slack = (this.cfg.maxPinDeviation || 1.5) * (L / n);
      for (let k = 1; k < n; k++) {
        const sg = this._signalFor(chain, route, k);
        if (!sg || !(sg.d > 5 && sg.d < L - 5)) continue;
        const prop = L * cw[k] / cw[n];
        // Geometrically consistent: not wildly far from where the berths' own lengths put this boundary (a coincidental id elsewhere on the route is).
        if (Math.abs(sg.d - prop) > slack) { this._areaStats(sg.area).rejected.implausible++; continue; }
        pins.push({ k, d: sg.d, area: sg.area, prop });
      }
      const best = new Array(pins.length).fill(1), prev = new Array(pins.length).fill(-1);
      let top = -1;
      for (let i = 0; i < pins.length; i++) {
        for (let j = 0; j < i; j++) if (pins[j].d + 5 < pins[i].d && best[j] + 1 > best[i]) { best[i] = best[j] + 1; prev[i] = j; }
        if (top < 0 || best[i] > best[top]) top = i;
      }
      const keep = new Set();
      for (let i = top; i >= 0; i = prev[i]) keep.add(i);
      pins.forEach((p, i) => {
        if (keep.has(i)) {
          anchor.set(p.k, p.d); how[p.k] = 'signal'; this._areaStats(p.area).pinned++;
          if (this.cfg.logPins) this.pinLog.push({ area: p.area, chain: chain.key, k: p.k, d: p.d, prop: p.prop, L, n, learned });     // for dev/spans-report.js
        }
        else this._areaStats(p.area).rejected.order++;
      });
    }
    // Boundaries between anchors share the stretch in proportion to the weights.
    const bound = new Array(n + 1);
    const idx = [...anchor.keys()].sort((a, b) => a - b);
    for (let s = 0; s + 1 < idx.length; s++) {
      const a = idx[s], b = idx[s + 1];
      for (let j = a; j <= b; j++) bound[j] = anchor.has(j) ? anchor.get(j) : anchor.get(a) + (anchor.get(b) - anchor.get(a)) * ((cw[j] - cw[a]) / (cw[b] - cw[a]));
    }
    return { L, bound, how, cutBy: learned ? 'learned' : known.length ? 'partial' : 'equal', meds, sumSecs: known.length ? cw[n] : 0 };
  }

  /** `spans.maxImpliedMps`: the fastest a berth's (or chain's) span may imply, in m/s. Absent = 60; a huge value turns the rule off. */
  _maxMps() { const v = this.cfg.maxImpliedMps; return Number.isFinite(v) && v > 0 ? v : 60; }

  /**
   * The bounding box [s, w, n, e] of the route between d0 and d1, four numbers (contract 19.1): the polyline is cut once here and dropped.
   * It is what lets a bbox filter ask "could the page be drawing this train in the box" without the path. Null when the library cannot cut it.
   */
  _boxOf(route, d0, d1) {
    let pts;
    try { pts = this.track.slice(route, d0, d1); } catch (_) { return null; }
    if (!Array.isArray(pts) || !pts.length) return null;
    let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
    for (const p of pts) {
      const la = p[0], lo = p[1];
      if (!(Number.isFinite(la) && Number.isFinite(lo))) return null;
      if (la < s) s = la; if (la > n) n = la;
      if (lo < w) w = lo; if (lo > e) e = lo;
    }
    return [s, w, n, e];
  }

  _build(chain) {
    const g = this.graph;
    const out = { noRoute: false, tooFast: false, built: 0 };
    const route = this._route(chain);
    if (!route) { this.stats.noRoute++; out.noRoute = true; return out; }
    const cut = this._cut(chain, route);
    if (!cut) { this.stats.noRoute++; out.noRoute = true; return out; }
    const n = chain.berths.length;
    const maxMps = this._maxMps();
    const chainFast = cut.sumSecs > 0 && cut.L / cut.sumSecs > maxMps;
    for (let i = 0; i < n; i++) {
      const keyId = chain.berths[i];
      if (chain.build && !chain.build.has(keyId)) continue;                 // claimed by an earlier chain: that span stands
      const d0 = cut.bound[i], d1 = cut.bound[i + 1], len = d1 - d0;
      if (!(len > 0)) continue;
      const m = cut.meds[i];
      const why = chainFast ? 'chain' : (m !== null && m > 0 && len / m > maxMps) ? 'berth' : null;
      if (why) {
        out.tooFast = true;
        if (chain.gap) this._retireGap(keyId); else this._withdraw(keyId, why);          // a gap chain's own berths are not "impossible": status() counts station chains
        continue;
      }
      if (!chain.gap) this.impossible.delete(keyId);
      const last = i === n - 1, first = i === 0 && chain.firstIsDep;
      const stop = chain.gap ? null : last ? len : first ? 0 : null;
      const rule = { start: cut.how[i], end: cut.how[i + 1], cutBy: cut.cutBy };
      const old = this.byBerth.get(keyId);
      if (old && chain.gap && !old.gap) continue;                           // a station-chain span is never replaced by a gap span
      if (old) {
        const moved = Math.abs(len - old.length) / old.length > (this.cfg.recomputeFraction || 0.1) || Math.abs(d0 - old.d0) / old.length > (this.cfg.recomputeFraction || 0.1) || old.chainKey !== chain.key;
        if (!moved) { this.stats.kept++; if (chain.gap) this.gap.seen.add(keyId); continue; }
        this.byId.delete(old.id);
        this.retired.set(old.id, old);
        while (this.retired.size > Math.max(1000, (this.cfg.maxSpans || 120000) / 4)) this.retired.delete(this.retired.keys().next().value);
        this.stats.recut++;
      } else if (this.byBerth.size >= (this.cfg.maxSpans || 120000)) continue;
      const id = hash(`${g.keyOf[keyId]}|${chain.key}|${Math.round(d0)}|${Math.round(d1)}|${Math.round(cut.L)}`);
      const rec = { id, keyId, chainKey: chain.key, d0, d1, length: len, stop, rule, box: this._boxOf(route, d0, d1) };
      if (chain.gap) { rec.gap = true; this.gap.seen.add(keyId); }
      this.byBerth.set(keyId, rec); this.byId.set(id, rec);
      this.stats.built++; out.built++;
    }
    return out;
  }

  /**
   * `this.chains` must not grow with every replan (gap chain keys carry span ids, which change): drop a chain once no current or retained
   * (superseded, still readable) span and no queued chain refers to it. Called at the end of each completed gap pass.
   */
  _pruneChains() {
    const live = new Set(this.queue.map(c => c.key));
    for (const r of this.byBerth.values()) live.add(r.chainKey);
    for (const r of this.retired.values()) live.add(r.chainKey);
    for (const k of [...this.chains.keys()]) if (!live.has(k)) { this.chains.delete(k); this.routes.delete(k); }
  }

  /** A gap span (18.5) is retired: superseded, its id stays readable. A station-chain span is left alone. */
  _retireGap(keyId) {
    const old = this.byBerth.get(keyId);
    if (!old || !old.gap) return;
    this.byBerth.delete(keyId); this.byId.delete(old.id);
    this.retired.set(old.id, old);
    while (this.retired.size > Math.max(1000, (this.cfg.maxSpans || 120000) / 4)) this.retired.delete(this.retired.keys().next().value);
    this.stats.recut++;
  }

  // ---- gap chains (section 18.5) --------------------------------------------------------------------------------------

  /** The directed route from the previous span's end to the next span's start, or null. Cached with the station routes. */
  _gapRoute(chain) {
    try {
      const P = this._canon(chain.prevId), N = this._canon(chain.nextId);
      const pe = P ? this._ends(P) : null, ne = N ? this._ends(N) : null;
      if (!pe || !ne) return null;
      const crow = metresBetween(pe.end, ne.start);
      const maxLength = 2 * crow + (this.cfg.joinDetourM || 500);
      const minLen = this.cfg.minGapMetres === undefined ? 10 : this.cfg.minGapMetres;     // a "hole" of a few metres is not one: spans of millimetres only strand a train
      let r = this.track.route(pe.end, ne.start, { avoidSidings: false, maxLength }) || null;
      if (!r || !(r.length > minLen)) {
        // The 17.1 (b) "beside" step: parallel tracks and opposite running leave no directed route, so go to the nearest reachable point
        // within `besideMetres` of where the next span starts, staying on a running line (the step into that berth then gets a continuation).
        let near = [];
        try { near = this.track.nearestOnTrack(ne.start.lat, ne.start.lon, { k: 8, maxDist: this.cfg.besideMetres || 120, avoidSidings: true }) || []; } catch (_) { near = []; }
        r = near.length ? this.track.route(pe.end, near, { avoidSidings: false, maxLength }) || null : null;
        if (!r || !(r.length > minLen)) return null;
        r.gapBeside = true;                                  // remembered on the (cached) route: a rebuilt chain object must still count as beside
      }
      this.routes.set(chain.key, r);
      while (this.routes.size > (this.cfg.routeCacheEntries || 300)) this.routes.delete(this.routes.keys().next().value);
      return r;
    } catch (_) { return null; }
  }

  /** Is this berth cut by a station chain (a gap span does not count: it is the thing being planned)? */
  _hasStationSpan(keyId) { const r = this.byBerth.get(keyId); return !!r && !r.gap; }

  /**
   * If berth `u` starts a run of 1..maxGapBerths berths with no station-chain span, between a berth that has one (u's best-previous) and
   * a berth that has one (the best-next out of the run), build the gap chain over it. Never throws.
   */
  _gapFrom(u, maxGap) {
    const g = this.graph, gp = this.gap;
    if (this._hasStationSpan(u) || gp.seen.has(u)) return;
    const P = g.bestNext(u, false);
    if (P < 0 || P === u || !this._hasStationSpan(P)) return;
    const run = [u];
    let N = -1, cur = u;
    for (;;) {
      const nx = g.bestNext(cur, true);
      if (nx < 0 || nx === P || run.includes(nx)) return;
      if (this._hasStationSpan(nx)) { N = nx; break; }
      if (run.length >= maxGap) return;
      run.push(nx); cur = nx;
    }
    const pr = this.byBerth.get(P), nr = this.byBerth.get(N);
    gp.considered++;
    const chain = { key: `gap:${pr.id}>${nr.id}:${g.keyOf[u]}`, gap: true, berths: run, build: new Set(run), prevId: pr.id, nextId: nr.id, firstIsDep: false };
    this.chains.set(chain.key, chain);
    const r = this._build(chain);
    const rt = this.routes.get(chain.key);
    if (r.built && rt && rt.gapBeside) gp.beside++;
    if (r.noRoute) gp.noRoute++;
    else if (r.tooFast && !r.built) gp.tooFast++;
    if (r.built) gp.built++;
  }

  /** Run the gap pass for up to `until` (epoch ms); on its last berth, withdraw the gap spans this pass did not (re)build. */
  _gapStep(until) {
    const g = this.graph, gp = this.gap;
    const maxGap = this.cfg.maxGapBerths === undefined ? 4 : this.cfg.maxGapBerths;
    const n = g.keyOf.length;
    if (maxGap > 0 && this.hasJoins) {
      let i = 0;
      while (gp.cursor < n) {
        this._gapFrom(gp.cursor++, maxGap);
        if ((++i & 63) === 0 && Date.now() >= until) break;
      }
      if (gp.cursor < n) return;
    }
    for (const rec of [...this.byBerth.values()]) if (rec.gap && !gp.seen.has(rec.keyId)) this._retireGap(rec.keyId);
    this.gapTally = { considered: gp.considered, built: gp.built, beside: gp.beside, noRoute: gp.noRoute, tooFast: gp.tooFast };
    this._pruneChains();
    gp.active = false;
  }

  /** Section 18.2: this berth gets no span. One it already had is superseded (its id stays readable) and its trains fall back to phase 1. */
  _withdraw(keyId, why) {
    this.impossible.set(keyId, why);
    const old = this.byBerth.get(keyId);
    if (!old) return;
    this.byBerth.delete(keyId); this.byId.delete(old.id);
    this.retired.set(old.id, old);
    while (this.retired.size > Math.max(1000, (this.cfg.maxSpans || 120000) / 4)) this.retired.delete(this.retired.keys().next().value);
    this.stats.recut++;
  }

  /** Cut chains until `budgetMs` is spent. Returns the number of chains cut. Never throws. */
  step(budgetMs = this.cfg.stepBudgetMs || 15) {
    try {
      if (this._needsPlan()) this._plan();
      const t0 = Date.now();
      let n = 0;
      while (this.queue.length && Date.now() - t0 < budgetMs) { this._build(this.queue.shift()); n++; }
      if (!this.queue.length && this.gap.active) { this._gapStep(t0 + budgetMs); n++; }
      return n;
    } catch (_) { return 0; }
  }

  /** Run to completion (tests, tools). */
  settle() { let guard = 0; while ((this._needsPlan() || this.queue.length || this.gap.active) && guard++ < 100000) this.step(1e9); }

  // ---- reading ------------------------------------------------------------------------------------------------------

  /** GET /span/:id -> {id, length, path, stop} or null. Current and superseded ids both resolve, and so does the id of a continuation. */
  get(id) {
    const rec = this.byId.get(id) || this.retired.get(id);
    if (!rec) {
      const j = this.joins.get(id);
      return j && j.end ? this._joinBody(j) : null;
    }
    const chain = this.chains.get(rec.chainKey);
    const route = chain ? this._route(chain) : this.routes.get(rec.chainKey);
    if (!route) return null;
    let pts;
    try { pts = this.track.slice(route, rec.d0, rec.d1); } catch (_) { return null; }
    if (!Array.isArray(pts) || pts.length < 2) return null;
    return { id: rec.id, length: Math.round(rec.length), path: pts.map(p => [round5(p[0]), round5(p[1])]), stop: rec.stop === null ? null : Math.round(rec.stop) };
  }

  // ---- continuations (section 17.1) ---------------------------------------------------------------------------------

  _canon(id) { return this.byId.get(id) || this.retired.get(id) || null; }

  /** Both ends of a span as DIRECTED snaps, cut from its chain's route (small LRU: it is cheap to recompute). */
  _ends(rec) {
    const hit = this.endsCache.get(rec.id);
    if (hit) { this.endsCache.delete(rec.id); this.endsCache.set(rec.id, hit); return hit; }
    const chain = this.chains.get(rec.chainKey);
    const route = chain ? this._route(chain) : this.routes.get(rec.chainKey);
    if (!route) return null;
    let e;
    try { e = { start: this.track.snapAlong(route, rec.d0), end: this.track.snapAlong(route, rec.d1) }; } catch (_) { return null; }
    if (!e.start || !e.end) return null;
    this.endsCache.set(rec.id, e);
    while (this.endsCache.size > (this.cfg.endsCacheEntries || 4096)) this.endsCache.delete(this.endsCache.keys().next().value);
    return e;
  }

  /** Where a span (canonical, or a continuation) ends, as a directed snap; null when the id is unknown or its record is gone. */
  _endOf(id) {
    const j = this.joins.get(id);
    if (j && j.end) { this.joins.delete(id); this.joins.set(id, j); return j.end; }          // it is being used: keep it
    const rec = this._canon(id);
    const e = rec ? this._ends(rec) : null;
    return e ? e.end : null;
  }

  /** Route from `pe` (a directed snap) to the end of span `of` by rules a-c, or null. {route, how}. */
  _solve(pe, of, oe) {
    const T = this.track, cfg = this.cfg;
    const maxLength = of.length * 2 + (cfg.joinDetourM || 500);
    const go = to => { try { return T.route(pe, to, { avoidSidings: false, maxLength }) || null; } catch (_) { return null; } };
    let r = go(oe.end);
    if (r) return { route: r, how: 'direct' };
    // Stay on the train's own track: the nearest reachable point beside where the berth ends, on any running line.
    let near = [];
    try { near = T.nearestOnTrack(oe.end.lat, oe.end.lon, { k: 8, maxDist: cfg.besideMetres || 120, avoidSidings: true }) || []; } catch (_) { near = []; }
    if (near.length) { r = go(near); if (r) return { route: r, how: 'beside' }; }
    try { r = T.walk(pe, of.length) || null; } catch (_) { r = null; }
    return r ? { route: r, how: 'straight' } : null;
  }

  _joinId(prevId, ofId) { return hash(`j|${prevId}|${ofId}`); }

  /**
   * The span for berth `ofId` entered from span `prevId`: {id, length, stop, how, prevKnown}, or null when `ofId` is not a span.
   * `id` is `ofId` itself for 'same' (prev already ends where of starts), 'fallback' (no continuation could be made) and an unknown
   * prev (never issued, or evicted: prevKnown false); otherwise the continuation's own id.
   */
  continuation(prevId, ofId) {
    const of = this._canon(ofId);
    if (!of) return null;
    const own = how => ({ id: of.id, length: of.length, stop: of.stop, how, prevKnown: true });
    if (!this.hasJoins || !prevId || prevId === ofId) return own('same');
    const key = this._joinId(prevId, ofId);
    const hit = this.joins.get(key);
    if (hit) {
      this.joins.delete(key); this.joins.set(key, hit);
      return hit.end ? { id: hit.id, length: hit.length, stop: hit.stop, how: hit.how, prevKnown: true } : own(hit.how);
    }
    let rec = null;
    try {
      const pe = this._endOf(prevId);
      if (!pe) { this.joinStats.unknownPrev++; return { ...own('fallback'), prevKnown: false }; }
      const oe = this._ends(of);
      if (!oe) rec = { id: key, how: 'fallback', end: null };
      else if (metresBetween(pe, oe.start) <= (this.cfg.sameMetres === undefined ? 2 : this.cfg.sameMetres)) rec = { id: key, how: 'same', end: null };
      else {
        const sol = this._solve(pe, of, oe);
        if (!sol) rec = { id: key, how: 'fallback', end: null };
        else {
          const len = sol.route.length, end = this.track.snapAlong(sol.route, len);
          rec = { id: key, how: sol.how, length: len, stop: of.stop === null ? null : of.stop === 0 ? 0 : len, end };
          const pc = this._canon(prevId);
          rec.prev = pc ? pc.id : prevId; rec.of = of.id;                 // share the canonical id strings: one copy in memory
        }
      }
    } catch (_) { rec = { id: key, how: 'fallback', end: null }; }
    this.joinStats[rec.how]++;
    this.joins.set(key, rec);
    while (this.joins.size > (this.cfg.maxJoins || 50000)) { this.joins.delete(this.joins.keys().next().value); this.joinStats.evicted++; }
    return rec.end ? { id: rec.id, length: rec.length, stop: rec.stop, how: rec.how, prevKnown: true } : own(rec.how);
  }

  /** The polyline of a continuation, recomputed from its two ids (nothing but the small record is kept). Null if an input is gone. */
  _joinBody(j) {
    try {
      const of = this._canon(j.of), pe = of ? this._endOf(j.prev) : null, oe = pe ? this._ends(of) : null;
      if (!oe) return null;
      const sol = this._solve(pe, of, oe);
      if (!sol || sol.how !== j.how || Math.abs(sol.route.length - j.length) > 0.5) return null;      // immutable per id: never a different answer
      const pts = this.track.slice(sol.route, 0, sol.route.length);
      if (!Array.isArray(pts) || pts.length < 2) return null;
      return { id: j.id, length: Math.round(j.length), path: pts.map(p => [round5(p[0]), round5(p[1])]), stop: j.stop === null ? null : Math.round(j.stop) };
    } catch (_) { return null; }
  }

  /**
   * GET /span/:id?after=:prev -> {body, stable} or null (unknown id). `stable` is false when the answer may change later (the prev is
   * not known yet, or no continuation could be made), so the caller does not cache it as immutable.
   */
  getAfter(id, after) {
    if (!after) { const b = this.get(id); return b ? { body: b, stable: true } : null; }
    const c = this.continuation(after, id);
    if (!c) { const b = this.get(id); return b ? { body: b, stable: true } : null; }        // not a canonical id (e.g. a continuation's own): ?after does not apply
    const body = c.id === id ? this.get(id) : this.get(c.id);
    if (!body) { const b = this.get(id); return b ? { body: b, stable: false } : null; }
    return { body, stable: c.prevKnown && c.how !== 'fallback' };
  }

  /** For the recorder: the continuation's body when prev -> of needs one (a span line to write), else null. */
  continuationBody(prevId, ofId) {
    const c = this.continuation(prevId, ofId);
    return c && c.id !== ofId ? this.get(c.id) : null;
  }

  /** How many berths have a span, and by which rule fixed their boundaries and cut. */
  rules() {
    const r = { berths: this.byBerth.size, stopPinned: 0, signalPinned: 0, cutLearned: 0, cutPartial: 0, cutEqual: 0, bothEndsFixed: 0 };
    for (const rec of this.byBerth.values()) {
      const { start, end, cutBy } = rec.rule;
      if (start === 'stop' || end === 'stop') r.stopPinned++;
      if (start === 'signal' || end === 'signal') r.signalPinned++;
      if (start && end) r.bothEndsFixed++;
      if (cutBy === 'learned') r.cutLearned++; else if (cutBy === 'partial') r.cutPartial++; else r.cutEqual++;
    }
    return r;
  }

  status() {
    const s = this.stats, j = this.joinStats;
    const areas = {};
    let tried = 0, pinned = 0;
    for (const [a, v] of s.byArea) { tried += v.berths; pinned += v.pinned; areas[a] = { ...v, rate: v.berths ? Math.round(1000 * v.pinned / v.berths) / 1000 : null }; }
    const imp = { maxImpliedMps: this._maxMps(), berths: 0, byBerth: 0, byChain: 0, byArea: {} };
    for (const [k, why] of this.impossible) {
      const a = this.graph.areaOf[k] || '?';
      const e = imp.byArea[a] || (imp.byArea[a] = { berths: 0, byBerth: 0, byChain: 0 });
      imp.berths++; e.berths++;
      if (why === 'chain') { imp.byChain++; e.byChain++; } else { imp.byBerth++; e.byBerth++; }
    }
    return {
      berthsWithSpans: this.byBerth.size, impossible: imp,
      gapChains: { ...this.gapTally, berths: [...this.byBerth.values()].filter(r => r.gap).length, running: this.gap.active }, chains: s.chains, queued: this.queue.length, built: s.built, noRoute: s.noRoute, noSnap: s.noSnap, recut: s.recut, kept: s.kept, sharedBerths: s.shared,
      rules: this.rules(),
      joins: { same: j.same, direct: j.direct, beside: j.beside, straight: j.straight, fallback: j.fallback },
      joinStore: { size: this.joins.size, max: this.cfg.maxJoins || 50000, unknownPrev: j.unknownPrev, evicted: j.evicted },
      platforms: s.platform,
      signals: this.hasSignals ? { signalAt: this.signalAt, boundariesTried: tried, pinned, rate: tried ? Math.round(1000 * pinned / tried) / 1000 : null, byArea: areas } : 'not available from the track library'
    };
  }
}

module.exports = { SpanBuilder, exactKey, numberOf };
