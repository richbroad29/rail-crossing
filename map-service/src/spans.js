'use strict';

// Berths on the track (contract section 9): every berth the model knows gets a SPAN, a polyline along
// the track graph from where trains enter it to where they leave it, for its most common
// (previous -> this -> next) path.
//
// THE TRACK LIBRARY BOUNDARY. This module is written against the runtime API of contract section 8
// and nothing else (no pack format, no internals). The assumptions, in one place so the integration
// is a one-line adapter if any is wrong:
//
//   track.nearestOnTrack(lat, lon, {maxDistM, avoidSidings}) -> snap | null        (snap is OPAQUE)
//   track.route(snapFrom, snapTo, {avoidSidings: true})      -> route | null        (route is OPAQUE)
//   track.slice(route, d0, d1)                               -> [[lat, lon], ...]   (metres along the route)
//   track.pointAt(route, d)                                  -> {lat, lon, bearing}
//   the route's length in metres is `route.length` (number), or `track.routeLength(route)` if the
//   library provides that function (used in preference).
//   OPTIONAL (rule 3, signals): track.signalAlong(route, area, berth) -> metres along the route of an
//   OSM signal whose `ref` matches the berth id in that TD area, or null. Absent = rule 3 is off and
//   the match rate is reported as "not available".
//
// RULES, in order:
//   1. Station-anchored berths (SMART) are pinned to the station's snap: an ARRIVAL berth ENDS at the
//      stop (mv.stop = its length), a DEPARTURE berth STARTS there (mv.stop = 0).
//   2. Between two pinned stops route() gives the path; the berths in between are cut from it in
//      proportion to their learned median PASS time (section 10), equal shares until every berth in
//      the chain has one.
//   3. A signal ref that matches a berth id within the same TD area pins that berth's START there
//      (when the library offers it); the match rate is reported per area.
//   4. Span ids are `sp_<hash>` of what defines the span, so they are stable; a berth is re-cut only
//      when learning moves it by more than `recomputeFraction` (10 %) of its length, and then its id
//      changes. Superseded ids stay readable (the page may still hold one).
//
// COST. The polyline is NOT stored per span: a span is {id, chain, d0, d1, length, stop} and its path
// is cut from the (LRU-cached) route when /span/:id is asked for. Building is incremental: step()
// does chains until its time budget is spent, so a 1 Hz tick is never held up.

const crypto = require('crypto');

const hash = text => 'sp_' + crypto.createHash('sha1').update(text).digest('hex').slice(0, 10);
const round5 = v => Math.round(v * 1e5) / 1e5;

class SpanBuilder {
  /**
   * @param {object} o
   * @param {object} o.track      the section-8 runtime library (or the in-test fake)
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
    this.snaps = new Map();           // station key -> snap | null
    this._planned = { graph: -1, transit: -1, at: -Infinity };
    this.stats = { chains: 0, built: 0, noRoute: 0, noSnap: 0, recut: 0, kept: 0, shared: 0, signalPins: 0, signalTried: 0, signalByArea: new Map() };
    this.hasSignals = typeof track.signalAlong === 'function';
  }

  get size() { return this.byBerth.size; }

  forBerth(keyId) { const r = this.byBerth.get(keyId); return r ? { id: r.id, length: r.length, stop: r.stop } : null; }

  // ---- planning: which chains of berths lie between which stops ---------------------------------------------------

  _stationKey(st) { return st.key; }

  _snapFor(stIdx) {
    const st = this.graph.stations[stIdx];
    if (this.snaps.has(st.key)) return this.snaps.get(st.key);
    let snap = null;
    try { snap = this.track.nearestOnTrack(st.lat, st.lon, { maxDistM: this.cfg.maxStationSnapM || 300, avoidSidings: true }) || null; } catch (_) { snap = null; }
    if (!snap) this.stats.noSnap++;
    this.snaps.set(st.key, snap);
    return snap;
  }

  /** Walk the most common path from every departure-anchored berth to the next arrival-anchored one. */
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
      chains.push({ key, fromSt, toSt, berths: fresh, firstIsDep: kind === 'dep' && fresh[0] === berths[0] });
    }
    for (const c of chains) this.chains.set(c.key, c);          // older chains stay: superseded spans still resolve their paths
    this.queue = chains.slice();
    this.stats.chains = chains.length;
    this._planned = { graph: g.version, transit: this.transit.version, at: this.now() };
  }

  _needsPlan() {
    const p = this._planned;
    if (p.graph === -1) return true;
    if (p.graph === this.graph.version && p.transit === this.transit.version) return false;
    return this.now() - p.at >= (this.cfg.replanSecs || 600) * 1000;
  }

  // ---- building -----------------------------------------------------------------------------------------------------

  _lengthOf(route) {
    if (typeof this.track.routeLength === 'function') { const v = this.track.routeLength(route); if (Number.isFinite(v)) return v; }
    return Number.isFinite(route.length) ? route.length : 0;
  }

  _route(chain) {
    const hit = this.routes.get(chain.key);
    if (hit) { this.routes.delete(chain.key); this.routes.set(chain.key, hit); return hit; }
    const a = this._snapFor(chain.fromSt), b = this._snapFor(chain.toSt);
    if (!a || !b) return null;
    let r = null;
    try { r = this.track.route(a, b, { avoidSidings: true }) || null; } catch (_) { r = null; }
    if (r) {
      this.routes.set(chain.key, r);
      while (this.routes.size > (this.cfg.routeCacheEntries || 300)) this.routes.delete(this.routes.keys().next().value);
    }
    return r;
  }

  _cut(chain, route) {
    const g = this.graph, n = chain.berths.length;
    const L = this._lengthOf(route);
    if (!(L > 0)) return null;
    const meds = chain.berths.map(b => this.transit.passMedian(b));
    const learned = meds.every(m => m !== null && m > 0);
    const w = learned ? meds : meds.map(() => 1);
    const total = w.reduce((x, y) => x + y, 0);
    const bound = [0];
    let acc = 0;
    for (let i = 0; i < n; i++) { acc += w[i]; bound.push(i === n - 1 ? L : (acc / total) * L); }
    // Rule 3: a matching signal pins the START of its berth.
    if (this.hasSignals) {
      for (let i = 1; i < n; i++) {
        const area = g.areaOf[chain.berths[i]], berth = g.berth(chain.berths[i]);
        let a = this.stats.signalByArea.get(area); if (!a) { a = { tried: 0, pinned: 0 }; this.stats.signalByArea.set(area, a); }
        a.tried++; this.stats.signalTried++;
        let d = null;
        try { d = this.track.signalAlong(route, area, berth); } catch (_) { d = null; }
        if (Number.isFinite(d) && d > bound[i - 1] + 1 && d < bound[i + 1] - 1) { bound[i] = d; a.pinned++; this.stats.signalPins++; }
      }
    }
    return { L, bound };
  }

  _build(chain) {
    const g = this.graph;
    const route = this._route(chain);
    if (!route) { this.stats.noRoute++; return; }
    const cut = this._cut(chain, route);
    if (!cut) { this.stats.noRoute++; return; }
    const n = chain.berths.length;
    for (let i = 0; i < n; i++) {
      const keyId = chain.berths[i];
      const d0 = cut.bound[i], d1 = cut.bound[i + 1], len = d1 - d0;
      if (!(len > 0)) continue;
      const last = i === n - 1, first = i === 0 && chain.firstIsDep;
      const stop = last ? len : first ? 0 : null;
      const old = this.byBerth.get(keyId);
      if (old) {
        const moved = Math.abs(len - old.length) / old.length > (this.cfg.recomputeFraction || 0.1) || Math.abs(d0 - old.d0) / old.length > (this.cfg.recomputeFraction || 0.1) || old.chainKey !== chain.key;
        if (!moved) { this.stats.kept++; continue; }
        this.byId.delete(old.id);
        this.retired.set(old.id, old);
        while (this.retired.size > Math.max(1000, (this.cfg.maxSpans || 120000) / 4)) this.retired.delete(this.retired.keys().next().value);
        this.stats.recut++;
      } else if (this.byBerth.size >= (this.cfg.maxSpans || 120000)) continue;
      const id = hash(`${g.keyOf[keyId]}|${chain.key}|${Math.round(d0)}|${Math.round(d1)}|${Math.round(cut.L)}`);
      const rec = { id, keyId, chainKey: chain.key, d0, d1, length: len, stop };
      this.byBerth.set(keyId, rec); this.byId.set(id, rec);
      this.stats.built++;
    }
  }

  /** Cut chains until `budgetMs` is spent. Returns the number of chains cut. Never throws. */
  step(budgetMs = this.cfg.stepBudgetMs || 15) {
    try {
      if (this._needsPlan()) this._plan();
      const t0 = Date.now();
      let n = 0;
      while (this.queue.length && Date.now() - t0 < budgetMs) { this._build(this.queue.shift()); n++; }
      return n;
    } catch (_) { return 0; }
  }

  /** Run to completion (tests, tools). */
  settle() { let guard = 0; while ((this._needsPlan() || this.queue.length) && guard++ < 100000) this.step(1e9); }

  // ---- reading ------------------------------------------------------------------------------------------------------

  /** GET /span/:id -> {id, length, path, stop} or null. Current and superseded ids both resolve. */
  get(id) {
    const rec = this.byId.get(id) || this.retired.get(id);
    if (!rec) return null;
    const chain = this.chains.get(rec.chainKey);
    const route = chain ? this._route(chain) : this.routes.get(rec.chainKey);
    if (!route) return null;
    let pts;
    try { pts = this.track.slice(route, rec.d0, rec.d1); } catch (_) { return null; }
    if (!Array.isArray(pts) || pts.length < 2) return null;
    return { id: rec.id, length: Math.round(rec.length), path: pts.map(p => [round5(p[0]), round5(p[1])]), stop: rec.stop === null ? null : Math.round(rec.stop) };
  }

  status() {
    const s = this.stats;
    const areas = {};
    for (const [a, v] of s.signalByArea) areas[a] = { tried: v.tried, pinned: v.pinned, rate: v.tried ? Math.round(1000 * v.pinned / v.tried) / 1000 : null };
    return {
      berthsWithSpans: this.byBerth.size, chains: s.chains, queued: this.queue.length, built: s.built, noRoute: s.noRoute, noSnap: s.noSnap, recut: s.recut, kept: s.kept, sharedBerths: s.shared,
      signals: this.hasSignals ? { tried: s.signalTried, pinned: s.signalPins, rate: s.signalTried ? Math.round(1000 * s.signalPins / s.signalTried) / 1000 : null, byArea: areas } : 'not available from the track library'
    };
  }
}

module.exports = { SpanBuilder };
