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
//
// RULES, in order:
//   1. Station-anchored berths (SMART) are pinned to the station: an ARRIVAL berth ENDS at the stop (mv.stop =
//      its length), a DEPARTURE berth STARTS there (mv.stop = 0). The stop is the end of route(), which picks the
//      platform track of each station's snap array that makes the shortest path.
//      SMART names the platform each berth uses at its station; where the pack has a snap for that platform, only its
//      snaps are offered to route(), so the two directions land on their own tracks (see _route for the fallback).
//   2. Between two pinned stops route() gives the path; the berths in between are cut from it in
//      proportion to their learned median PASS time (section 10), equal shares until every berth in the chain has one.
//   3. A signal whose OSM `ref` matches the berth id pins a boundary of the berth, ONLY where the match is unambiguous
//      and geometrically consistent: exactly one signal with that id lies on THIS route, it governs the direction of
//      travel (when the data says), it is not wildly far from where the berths' own lengths put the boundary (config
//      maxPinDeviation, 1.5 berth lengths), and the boundaries stay in order along the route. TD names a berth for the signal
//      it stands in rear of, so the signal is at the berth's END (`signalAt: 'end'`); `'start'` is the alternative the
//      measurement tool compares. The rate per TD area is reported by status().
//   4. Span ids are `sp_<hash>` of what defines the span, so they are stable; a berth is re-cut only
//      when learning moves it by more than `recomputeFraction` (10 %) of its length, and then its id
//      changes. Superseded ids stay readable (the page may still hold one).
//
// COST. The polyline is NOT stored per span: a span is {id, chain, d0, d1, length, stop} and its path
// is cut from the (LRU-cached) route when /span/:id is asked for. Building is incremental: step()
// does chains until its time budget is spent, so a 1 Hz tick is never held up.

const crypto = require('crypto');
const { haversineKm } = require('./geo');

const hash = text => 'sp_' + crypto.createHash('sha1').update(text).digest('hex').slice(0, 10);
const round5 = v => Math.round(v * 1e5) / 1e5;

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
    this.snaps = new Map();           // station key -> snap array
    this._planned = { graph: -1, transit: -1, at: -Infinity };
    this._sig = null;
    this.hasSignals = typeof track.signals === 'function' && typeof track.alongRoute === 'function';
    this.signalAt = config.signalAt || 'end';
    this.pinLog = [];
    this.stats = { platform: { tried: 0, used: 0, refused: 0 }, chains: 0, built: 0, noRoute: 0, noSnap: 0, recut: 0, kept: 0, shared: 0, byArea: new Map(), rules: { stop: 0, signal: 0, learned: 0, equal: 0 } };
  }

  get size() { return this.byBerth.size; }

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
      chains.push({ key, fromSt, toSt, berths: fresh, firstIsDep: kind === 'dep' && fresh[0] === berths[0], fromPlat: g.anchorPlat.get(start) || '', toPlat: g.anchorPlat.get(end) || '' });
    }
    this.stats.byArea = new Map();                              // the rule-3 tally describes THIS plan
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
    const learned = meds.every(m => m !== null && m > 0);
    const w = learned ? meds : meds.map(() => 1);
    const cw = [0];
    for (let i = 0; i < n; i++) cw.push(cw[i] + w[i]);
    const anchor = new Map([[0, 0], [n, L]]);                        // boundary index -> metres along the route (the two stops)
    const how = new Array(n + 1).fill(null);                         // what fixed each boundary: 'stop' | 'signal'
    how[0] = how[n] = 'stop';
    if (this.hasSignals) {
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
    return { L, bound, how, cutBy: learned ? 'learned' : 'equal' };
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
      const rule = { start: cut.how[i], end: cut.how[i + 1], cutBy: cut.cutBy };
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
      const rec = { id, keyId, chainKey: chain.key, d0, d1, length: len, stop, rule };
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

  /** How many berths have a span, and by which rule fixed their boundaries and cut. */
  rules() {
    const r = { berths: this.byBerth.size, stopPinned: 0, signalPinned: 0, cutLearned: 0, cutEqual: 0, bothEndsFixed: 0 };
    for (const rec of this.byBerth.values()) {
      const { start, end, cutBy } = rec.rule;
      if (start === 'stop' || end === 'stop') r.stopPinned++;
      if (start === 'signal' || end === 'signal') r.signalPinned++;
      if (start && end) r.bothEndsFixed++;
      if (cutBy === 'learned') r.cutLearned++; else r.cutEqual++;
    }
    return r;
  }

  status() {
    const s = this.stats;
    const areas = {};
    let tried = 0, pinned = 0;
    for (const [a, v] of s.byArea) { tried += v.berths; pinned += v.pinned; areas[a] = { ...v, rate: v.berths ? Math.round(1000 * v.pinned / v.berths) / 1000 : null }; }
    return {
      berthsWithSpans: this.byBerth.size, chains: s.chains, queued: this.queue.length, built: s.built, noRoute: s.noRoute, noSnap: s.noSnap, recut: s.recut, kept: s.kept, sharedBerths: s.shared,
      rules: this.rules(),
      platforms: s.platform,
      signals: this.hasSignals ? { signalAt: this.signalAt, boundariesTried: tried, pinned, rate: tried ? Math.round(1000 * pinned / tried) / 1000 : null, byArea: areas } : 'not available from the track library'
    };
  }
}

module.exports = { SpanBuilder, exactKey, numberOf };
