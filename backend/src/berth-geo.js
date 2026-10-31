'use strict';

// Berth → map position, for the live train map (proof of concept).
//
// TD reports WHICH BERTH a train is in, never where that berth is. Nobody publishes berth
// coordinates, so they are built here from three things, in order of trust:
//
//   1. SMART (NROD reference data) ties some berth steps to a timing point: "the step 0006→0004
//      in area LA is an arrival at STANOX 87xxx". CORPUS turns the STANOX into a CRS code and
//      config/map-stations.json turns the CRS into coordinates. Such a berth is ANCHORED: it is at
//      the station. For an arrival the train is stepping INTO the platform berth, so the anchored
//      berth is the step's `to`; for a departure it is stepping OUT of it, so it is the `from`.
//      The berth on the other side of the step is only a HINT — it is next to the station, not at
//      it — and is used if nothing better places it.
//   2. The berth GRAPH: every step a train makes (from → to) is an edge. SMART's own rows seed it
//      and the live feed fills in the rest within an hour or so of traffic, persisted to disk so
//      a restart does not forget it. Handovers between describer areas are learned too, from a
//      description cancelled in one area and interposed in the next.
//   3. INTERPOLATION: a berth with no station of its own is placed between the nearest anchored
//      berth behind it and the nearest ahead of it, in proportion to the hop counts. Between two
//      stations a train therefore moves along the straight chord, signal by signal. That cuts
//      corners on curves — snapping to track geometry is the obvious next step and not needed to
//      prove the idea.
//
// Pure: no I/O except the explicit load/save of the learned graph, so it can be tested on a
// fixture with a planted answer.

const fs = require('fs');

// SMART EVENT codes: A/C = arrive (up/down), B/D = depart (up/down).
const ARRIVE = new Set(['A', 'C']);
const DEPART = new Set(['B', 'D']);

function key(area, berth) { return `${area}:${berth}`; }

function haversineM(a, b) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Initial bearing a → b, degrees clockwise from north, or null if the points coincide.
function bearingDeg(a, b) {
  if (!a || !b) return null;
  if (Math.abs(a.lat - b.lat) < 1e-7 && Math.abs(a.lon - b.lon) < 1e-7) return null;
  const toRad = d => d * Math.PI / 180;
  const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat))
    - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

class BerthGeo {
  /**
   * @param {object} opts
   * @param {object} opts.stations     CRS → { name, lat, lon }
   * @param {object} [opts.interpolation] { maxHops, minEdgeCount }
   */
  constructor({ stations, interpolation = {} }) {
    this.stations = stations || {};
    this.maxHops = interpolation.maxHops || 14;
    this.minEdgeCount = interpolation.minEdgeCount || 2;

    this.anchors = new Map();   // key → { lat, lon, crs, name }
    this.hints = new Map();     // key → { lat, lon, crs, name }   (adjacent to a station)
    this.next = new Map();      // key → Map(key → count)
    this.prev = new Map();      // key → Map(key → count)
    this.smartEdges = new Set(); // "a>b" — trusted regardless of count
    this.areas = new Set();     // TD areas with at least one anchored berth

    this._cache = new Map();    // key → position (or null), rebuilt lazily
    this._dirty = true;
    this._learnedDirty = false;
  }

  // ---- anchors ------------------------------------------------------------------------------

  /**
   * @param {Array} rows  SMART rows: { td, from, to, stanox, event }
   * @param {function} stanoxToCrs  STANOX → CRS or null
   * @param {function} [inArea]     optional filter (td) → bool
   */
  loadSmart(rows, stanoxToCrs, inArea = () => true) {
    const votes = new Map();  // key → Map(crs → n)   strong
    const hintVotes = new Map();
    const vote = (m, k, crs) => {
      if (!m.has(k)) m.set(k, new Map());
      const v = m.get(k);
      v.set(crs, (v.get(crs) || 0) + 1);
    };

    let used = 0;
    for (const r of rows) {
      if (!r.td || !inArea(r.td)) continue;
      if (r.from && r.to) this._addSmartEdge(key(r.td, r.from), key(r.td, r.to));
      const crs = stanoxToCrs(r.stanox);
      if (!crs || !this.stations[crs]) continue;
      let strong = null, weak = null;
      if (ARRIVE.has(r.event)) { strong = r.to; weak = r.from; }
      else if (DEPART.has(r.event)) { strong = r.from; weak = r.to; }
      else continue;
      if (strong) vote(votes, key(r.td, strong), crs);
      if (weak) vote(hintVotes, key(r.td, weak), crs);
      used++;
    }

    const pick = (m, out) => {
      for (const [k, v] of m) {
        // The station named most often wins. Averaging would put a berth claimed by two
        // stations a few km apart in a field between them; the mode puts it at one of them.
        let best = null, bestN = -1;
        for (const [crs, n] of v) if (n > bestN || (n === bestN && crs < best)) { best = crs; bestN = n; }
        const s = this.stations[best];
        out.set(k, { lat: s.lat, lon: s.lon, crs: best, name: s.name });
      }
    };
    this.anchors.clear(); this.hints.clear();
    pick(votes, this.anchors);
    pick(hintVotes, this.hints);
    for (const k of this.anchors.keys()) this.hints.delete(k);
    this.areas = new Set([...this.anchors.keys()].map(k => k.split(':')[0]));
    this._dirty = true;
    return { rowsUsed: used, anchored: this.anchors.size, hinted: this.hints.size, areas: [...this.areas] };
  }

  // ---- graph --------------------------------------------------------------------------------

  _bump(map, a, b, n) {
    if (!map.has(a)) map.set(a, new Map());
    const m = map.get(a);
    const before = m.get(b) || 0;
    m.set(b, before + n);
    return before;
  }

  _addSmartEdge(a, b) {
    if (a === b) return;
    this.smartEdges.add(`${a}>${b}`);
    this._bump(this.next, a, b, 0);
    this._bump(this.prev, b, a, 0);
  }

  _usable(a, b, count) {
    return count >= this.minEdgeCount || this.smartEdges.has(`${a}>${b}`);
  }

  /**
   * Record that a train stepped from `fromKey` to `toKey`. Returns true when the edge has just
   * become usable for interpolation (so positions need recomputing).
   */
  observeEdge(fromKey, toKey) {
    if (!fromKey || !toKey || fromKey === toKey) return false;
    const before = this._bump(this.next, fromKey, toKey, 1);
    this._bump(this.prev, toKey, fromKey, 1);
    this._learnedDirty = true;
    const nowUsable = this._usable(fromKey, toKey, before + 1);
    const wasUsable = this._usable(fromKey, toKey, before);
    // Only a change in which edges are USABLE can move a position: an edge still below
    // minEdgeCount is invisible to the search, so counting it changes nothing yet.
    if (nowUsable && !wasUsable) { this._dirty = true; return true; }
    return false;
  }

  // BFS along usable edges; returns [{ key, hops }] of the anchors found at the smallest hop
  // distance at which any anchor appears, plus further distinct-station anchors up to maxHops.
  _anchorsFrom(start, adj) {
    const found = [];
    const seen = new Set([start]);
    let frontier = [start];
    for (let hops = 1; hops <= this.maxHops && frontier.length; hops++) {
      const nextFrontier = [];
      for (const k of frontier) {
        const m = adj.get(k);
        if (!m) continue;
        for (const [n, c] of m) {
          if (seen.has(n)) continue;
          const usable = adj === this.next ? this._usable(k, n, c) : this._usable(n, k, c);
          if (!usable) continue;
          seen.add(n);
          if (this.anchors.has(n)) found.push({ key: n, hops, a: this.anchors.get(n) });
          else nextFrontier.push(n);   // do not search THROUGH a station: it is the nearest one
        }
      }
      frontier = nextFrontier;
    }
    return found;
  }

  _compute(k) {
    const a = this.anchors.get(k);
    if (a) return { lat: a.lat, lon: a.lon, placement: 'station', crs: a.crs, station: a.name };

    const ahead = this._anchorsFrom(k, this.next);
    const behind = this._anchorsFrom(k, this.prev);

    // The closest PAIR of different stations either side. Requiring different stations stops a
    // berth on a loop or a reversible line from being "interpolated" between a station and itself.
    let best = null;
    for (const b of behind) {
      for (const f of ahead) {
        if (b.a.crs === f.a.crs) continue;
        const total = b.hops + f.hops;
        if (!best || total < best.total) best = { b, f, total };
      }
    }
    if (best) {
      const t = best.b.hops / best.total;
      return {
        lat: best.b.a.lat + (best.f.a.lat - best.b.a.lat) * t,
        lon: best.b.a.lon + (best.f.a.lon - best.b.a.lon) * t,
        placement: 'interpolated',
        between: [best.b.a.crs, best.f.a.crs]
      };
    }

    // One side only, or both sides the same station: the berth is near that station but we
    // cannot say which side. The SMART hint (a berth adjacent to a station step) is the better
    // guess when there is one.
    const h = this.hints.get(k);
    if (h) return { lat: h.lat, lon: h.lon, placement: 'approx', crs: h.crs, station: h.name };
    const near = [...ahead, ...behind].sort((x, y) => x.hops - y.hops)[0];
    if (near) return { lat: near.a.lat, lon: near.a.lon, placement: 'approx', crs: near.a.crs, station: near.a.name };
    return null;
  }

  _rebuildIfDirty() {
    if (!this._dirty) return;
    this._cache.clear();
    this._dirty = false;
  }

  /** Position of a berth, or null if it cannot be placed yet. */
  position(area, berth) {
    if (!area || !berth) return null;
    this._rebuildIfDirty();
    const k = key(area, berth);
    if (this._cache.has(k)) return this._cache.get(k);
    const p = this._compute(k);
    this._cache.set(k, p);
    return p;
  }

  /** Every berth the graph or SMART knows, with its position if it has one. */
  listBerths() {
    const keys = new Set([...this.anchors.keys(), ...this.hints.keys(), ...this.next.keys(), ...this.prev.keys()]);
    const out = [];
    for (const k of keys) {
      const [area, berth] = k.split(':');
      out.push({ area, berth, pos: this.position(area, berth) });
    }
    return out;
  }

  stats() {
    let edges = 0, usable = 0;
    for (const [a, m] of this.next) for (const [b, c] of m) { edges++; if (this._usable(a, b, c)) usable++; }
    return { anchored: this.anchors.size, hinted: this.hints.size, edges, usableEdges: usable, areas: [...this.areas].sort() };
  }

  // ---- persistence of the LEARNED graph -----------------------------------------------------
  //
  // Only counts from the live feed are saved; SMART edges are rebuilt from SMART on every start.

  serializeLearned() {
    const edges = [];
    for (const [a, m] of this.next) for (const [b, c] of m) if (c > 0) edges.push([a, b, c]);
    return { version: 1, savedAt: new Date().toISOString(), edges };
  }

  loadLearned(obj) {
    if (!obj || obj.version !== 1 || !Array.isArray(obj.edges)) return 0;
    let n = 0;
    for (const [a, b, c] of obj.edges) {
      if (typeof a !== 'string' || typeof b !== 'string' || !(c > 0) || a === b) continue;
      this._bump(this.next, a, b, c);
      this._bump(this.prev, b, a, c);
      n++;
    }
    this._dirty = true;
    return n;
  }

  saveLearnedIfDirty(file) {
    if (!this._learnedDirty) return false;
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.serializeLearned()));
    fs.renameSync(tmp, file);
    this._learnedDirty = false;
    return true;
  }

  loadLearnedFromFile(file) {
    try { return this.loadLearned(JSON.parse(fs.readFileSync(file, 'utf8'))); }
    catch (e) { if (e.code !== 'ENOENT') console.error('Berth graph load failed:', e.message); return 0; }
  }
}

module.exports = { BerthGeo, bearingDeg, haversineM, berthKey: key };
