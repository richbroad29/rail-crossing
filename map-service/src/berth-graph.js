'use strict';

// Berth -> map position. TD says WHICH BERTH a train is in and never where that berth is, so:
//
//   1. ANCHORS. SMART ties some berth steps to a timing point. An ARRIVAL (EVENT A/C) puts the
//      station at the step's TOBERTH, a DEPARTURE (B/D) at its FROMBERTH (phase 0: 92% of 3,868
//      station groups agree; the reverse reading 1%). The station's coordinates come from the
//      resolver (NaPTAN by TIPLOC, CRS table as fallback). The other berth of such a step is only
//      a HINT: next to the station, not at it.
//   2. THE GRAPH. Every SMART step is an edge (trusted at once). Every step seen live is an edge
//      too, usable after `minEdgeCount` sightings; a handover between describer areas is the only
//      way an edge can cross an area boundary, and is learned the same way. The learned part is
//      persisted so a restart does not forget it.
//   3. INTERPOLATION. An unanchored berth sits between the nearest anchored berth behind it and the
//      nearest ahead of it (distinct stations), in proportion to the hop counts. Straight chords:
//      phase 2 replaces them with the track model. One side only -> `approx`.
//
// A berth that cannot be placed is `null`: counted by the caller, never drawn.
//
// MEMORY. The graph grows with every new berth the national feed shows (still growing 9% in the last
// third of a measured hour), so it is stored compactly: berths are interned to integers, and edges live
// in parallel typed arrays with per-berth linked lists (out and in), 19 bytes per edge instead of the
// ~250 a Map of arrays costs. Both are bounded (`maxKeys`, `maxEdges`); past a bound new berths/edges
// are ignored and counted, never fatal.

const fs = require('fs');
const path = require('path');

const ARRIVE = new Set(['A', 'C']);
const DEPART = new Set(['B', 'D']);
const SMART = 1;                       // edge flag: seen in SMART (trusted at once)

function grow(arr, size) {
  const n = new arr.constructor(size);
  n.set(arr);
  return n;
}

class BerthGraph {
  /**
   * @param {object} o
   * @param {number} [o.maxHops]
   * @param {number} [o.minEdgeCount]
   * @param {number} [o.maxKeys]          most berths interned
   * @param {number} [o.maxLearnedEdges]  most edges beyond SMART's own
   */
  constructor({ maxHops = 14, minEdgeCount = 2, maxKeys = 250000, maxLearnedEdges = 400000 } = {}) {
    this.maxHops = maxHops;
    this.minEdgeCount = minEdgeCount;
    this.maxKeys = maxKeys;
    this.maxLearnedEdges = maxLearnedEdges;

    this.ids = new Map();      // "AREA:BERTH" -> id
    this.keyOf = [];           // id -> "AREA:BERTH" (the same string object the Map holds)
    this.areaOf = [];          // id -> area (interned: ~200 distinct strings)
    this._areas = new Map();
    this.headOut = new Int32Array(1024).fill(-1);   // id -> first edge leaving it
    this.headIn = new Int32Array(1024).fill(-1);    // id -> first edge arriving at it

    this._cap = 4096;                               // edge slots allocated
    this.edgeCount = 0;
    this.eFrom = new Int32Array(this._cap);
    this.eTo = new Int32Array(this._cap);
    this.eCnt = new Uint16Array(this._cap);         // sightings (saturates at 65535)
    this.eFlag = new Uint8Array(this._cap);
    this.eNextOut = new Int32Array(this._cap);
    this.eNextIn = new Int32Array(this._cap);

    this.stations = [];        // station objects {key,name,lat,lon,crs}
    this.anchors = new Map();  // id -> station index
    this.hints = new Map();
    this.smartEdgeCount = 0;
    this.learnedEdges = 0;     // edges seen live at least once

    this.version = 0;          // bumped whenever a position could have changed
    this.learnedDirty = false;
    this._cache = new Map();
    this.keyOverflow = 0;
    this.edgeOverflow = 0;
  }

  // ---- interning ------------------------------------------------------------------------------

  /** id for (area, berth), creating it; -1 if the key table is full. */
  keyId(area, berth) {
    const k = area + ':' + berth;
    let id = this.ids.get(k);
    if (id !== undefined) return id;
    if (this.keyOf.length >= this.maxKeys) { this.keyOverflow++; return -1; }
    id = this.keyOf.length;
    if (id >= this.headOut.length) {
      const size = Math.min(this.maxKeys + 1, this.headOut.length * 2);
      const o = grow(this.headOut, size), i = grow(this.headIn, size);
      o.fill(-1, this.headOut.length); i.fill(-1, this.headIn.length);
      this.headOut = o; this.headIn = i;
    }
    let a = this._areas.get(area);
    if (a === undefined) { a = area; this._areas.set(a, a); }
    this.ids.set(k, id);
    this.keyOf.push(k); this.areaOf.push(a);
    return id;
  }

  lookup(area, berth) { const id = this.ids.get(area + ':' + berth); return id === undefined ? -1 : id; }

  /** The berth part of id's key. */
  berth(id) { const k = this.keyOf[id]; return k.slice(k.indexOf(':') + 1); }

  // ---- edge storage -----------------------------------------------------------------------------

  _findEdge(a, b) {
    for (let e = this.headOut[a]; e >= 0; e = this.eNextOut[e]) if (this.eTo[e] === b) return e;
    return -1;
  }

  _addEdge(a, b, count, flag) {
    if (this.edgeCount === this._cap) {
      const cap = Math.min(this._cap * 2, this.maxLearnedEdges + this.smartEdgeCount + 1024 * 64);
      if (cap <= this._cap) return -1;
      this.eFrom = grow(this.eFrom, cap); this.eTo = grow(this.eTo, cap); this.eCnt = grow(this.eCnt, cap);
      this.eFlag = grow(this.eFlag, cap); this.eNextOut = grow(this.eNextOut, cap); this.eNextIn = grow(this.eNextIn, cap);
      this._cap = cap;
    }
    const e = this.edgeCount++;
    this.eFrom[e] = a; this.eTo[e] = b; this.eCnt[e] = count; this.eFlag[e] = flag;
    this.eNextOut[e] = this.headOut[a]; this.headOut[a] = e;
    this.eNextIn[e] = this.headIn[b]; this.headIn[b] = e;
    return e;
  }

  _usableEdge(e) { return this.eCnt[e] >= this.minEdgeCount || (this.eFlag[e] & SMART) !== 0; }

  /** For tests and diagnostics: [[toId, count, isSmart], ...] leaving `id`. */
  edgesFrom(id) {
    const out = [];
    for (let e = this.headOut[id]; e >= 0; e = this.eNextOut[e]) out.push([this.eTo[e], this.eCnt[e], (this.eFlag[e] & SMART) !== 0]);
    return out.reverse();
  }

  _reset() {
    this.headOut.fill(-1); this.headIn.fill(-1);
    this.edgeCount = 0; this.smartEdgeCount = 0; this.learnedEdges = 0;
  }

  // ---- anchors and SMART edges ------------------------------------------------------------------

  /**
   * (Re)build anchors, hints and SMART edges from compact SMART rows. Learned edges are kept.
   * @param {object} smart       loadSmart's result
   * @param {function} resolve   STANOX -> station | null
   */
  loadSmart(smart, resolve) {
    // Keep what was learned live; rebuild everything else from the new SMART.
    const learned = [];
    for (let e = 0; e < this.edgeCount; e++) if (this.eCnt[e] > 0) learned.push(this.eFrom[e], this.eTo[e], this.eCnt[e]);
    this._reset();

    const votes = new Map(), hintVotes = new Map();
    const stationIdx = new Map();
    const stations = [];
    const idxOf = st => {
      let i = stationIdx.get(st.key);
      if (i === undefined) { i = stations.length; stations.push(st); stationIdx.set(st.key, i); }
      return i;
    };
    const vote = (m, id, i) => {
      let v = m.get(id);
      if (!v) { v = new Map(); m.set(id, v); }
      v.set(i, (v.get(i) || 0) + 1);
    };

    let used = 0;
    for (let r = 0; r < smart.rows; r++) {
      const area = smart.area[r], from = smart.from[r], to = smart.to[r];
      const fid = from ? this.keyId(area, from) : -1, tid = to ? this.keyId(area, to) : -1;
      if (fid >= 0 && tid >= 0 && fid !== tid && this._findEdge(fid, tid) < 0) {
        if (this._addEdge(fid, tid, 0, SMART) >= 0) this.smartEdgeCount++;
      }
      const ev = smart.event[r];
      let strong = -1, weak = -1;
      if (ARRIVE.has(ev)) { strong = tid; weak = fid; } else if (DEPART.has(ev)) { strong = fid; weak = tid; } else continue;
      const st = smart.stanox[r] ? resolve(smart.stanox[r]) : null;
      if (!st) continue;
      const i = idxOf(st);
      if (strong >= 0) vote(votes, strong, i);
      if (weak >= 0) vote(hintVotes, weak, i);
      used++;
    }
    for (let i = 0; i < learned.length; i += 3) this._learn(learned[i], learned[i + 1], learned[i + 2]);

    const pick = (m, out) => {
      for (const [id, v] of m) {
        // The station named most often wins (ties: the lower station key). Averaging would put a
        // berth claimed by two stations a few km apart in a field between them.
        let best = -1, bestN = -1;
        for (const [i, n] of v) {
          if (n > bestN || (n === bestN && stations[i].key < stations[best].key)) { best = i; bestN = n; }
        }
        out.set(id, best);
      }
    };
    this.stations = stations;
    this.anchors = new Map(); this.hints = new Map();
    pick(votes, this.anchors); pick(hintVotes, this.hints);
    for (const id of this.anchors.keys()) this.hints.delete(id);
    this._bumpVersion();
    return { rowsUsed: used, anchored: this.anchors.size, hinted: this.hints.size, stations: stations.length };
  }

  // ---- learning ----------------------------------------------------------------------------------

  // Add `n` sightings of a -> b. Returns the count BEFORE, or -1 if a new edge could not be stored.
  _learn(a, b, n) {
    let e = this._findEdge(a, b);
    if (e < 0) {
      if (this.edgeCount - this.smartEdgeCount >= this.maxLearnedEdges) { this.edgeOverflow++; return -1; }
      e = this._addEdge(a, b, 0, 0);
      if (e < 0) { this.edgeOverflow++; return -1; }
    }
    const before = this.eCnt[e];
    this.eCnt[e] = Math.min(65535, before + n);
    if (before === 0 && n > 0) this.learnedEdges++;
    return before;
  }

  /** A train stepped (or was handed over) from `a` to `b`. True when that made the edge newly usable. */
  observeEdge(a, b) {
    if (a < 0 || b < 0 || a === b) return false;
    const before = this._learn(a, b, 1);
    if (before < 0) return false;
    this.learnedDirty = true;
    const e = this._findEdge(a, b);
    if (this._usableEdge(e) && !((this.eFlag[e] & SMART) !== 0 || before >= this.minEdgeCount)) { this._bumpVersion(); return true; }
    return false;
  }

  _bumpVersion() { this.version++; this._cache.clear(); }

  // ---- placement ------------------------------------------------------------------------------------

  // BFS along usable edges. Anchors stop the search (they are the nearest station that way).
  _anchorsFrom(start, forward) {
    const found = [];
    const seen = new Set([start]);
    let frontier = [start];
    for (let hops = 1; hops <= this.maxHops && frontier.length; hops++) {
      const nf = [];
      for (const k of frontier) {
        for (let e = forward ? this.headOut[k] : this.headIn[k]; e >= 0; e = forward ? this.eNextOut[e] : this.eNextIn[e]) {
          const n = forward ? this.eTo[e] : this.eFrom[e];
          if (seen.has(n) || !this._usableEdge(e)) continue;
          seen.add(n);
          const s = this.anchors.get(n);
          if (s !== undefined) found.push({ id: n, hops, st: this.stations[s] });
          else nf.push(n);
        }
      }
      frontier = nf;
    }
    return found;
  }

  _compute(id) {
    const a = this.anchors.get(id);
    if (a !== undefined) { const s = this.stations[a]; return { lat: s.lat, lon: s.lon, pl: 's', station: s.name }; }
    const ahead = this._anchorsFrom(id, true), behind = this._anchorsFrom(id, false);
    let best = null;
    for (const b of behind) for (const f of ahead) {
      if (b.st.key === f.st.key) continue; // a loop or reversible line is not "between" a station and itself
      const total = b.hops + f.hops;
      if (!best || total < best.total) best = { b, f, total };
    }
    if (best) {
      const t = best.b.hops / best.total;
      return {
        lat: best.b.st.lat + (best.f.st.lat - best.b.st.lat) * t,
        lon: best.b.st.lon + (best.f.st.lon - best.b.st.lon) * t,
        pl: 'i', between: [best.b.st.name, best.f.st.name]
      };
    }
    const h = this.hints.get(id);
    if (h !== undefined) { const s = this.stations[h]; return { lat: s.lat, lon: s.lon, pl: 'a', station: s.name }; }
    const near = [...ahead, ...behind].sort((x, y) => x.hops - y.hops)[0];
    if (near) return { lat: near.st.lat, lon: near.st.lon, pl: 'a', station: near.st.name };
    return null;
  }

  /** Position of berth `id`, or null. Cached until the graph changes. */
  position(id) {
    if (id < 0 || id >= this.keyOf.length) return null;
    if (this._cache.has(id)) return this._cache.get(id);
    const p = this._compute(id);
    this._cache.set(id, p);
    return p;
  }

  stats() {
    let usable = 0;
    for (let e = 0; e < this.edgeCount; e++) if (this._usableEdge(e)) usable++;
    return { anchored: this.anchors.size, hinted: this.hints.size, edges: this.edgeCount, usableEdges: usable, learnedEdges: this.learnedEdges, keys: this.keyOf.length };
  }

  // ---- persistence of the LEARNED part only (SMART is rebuilt on every start) -----------------------

  serializeLearned() {
    const edges = [];
    for (let e = 0; e < this.edgeCount; e++) if (this.eCnt[e] > 0) edges.push([this.keyOf[this.eFrom[e]], this.keyOf[this.eTo[e]], this.eCnt[e]]);
    let kept = edges;
    if (edges.length > this.maxLearnedEdges) {
      // Over the cap: sightings of 1 never became usable, so they go first.
      kept = edges.filter(x => x[2] >= this.minEdgeCount);
      if (kept.length > this.maxLearnedEdges) kept = kept.sort((x, y) => y[2] - x[2]).slice(0, this.maxLearnedEdges);
    }
    return { version: 1, savedAt: new Date().toISOString(), edges: kept };
  }

  /** Merge a saved graph in. Malformed entries are skipped. Returns how many edges were loaded. */
  loadLearned(doc) {
    if (!doc || doc.version !== 1 || !Array.isArray(doc.edges)) return 0;
    let n = 0;
    const re = /^([A-Z0-9]{1,4}):([A-Z0-9_\-]{1,6})$/;
    for (const e of doc.edges) {
      if (!Array.isArray(e) || typeof e[0] !== 'string' || typeof e[1] !== 'string' || !(e[2] > 0)) continue;
      const ma = re.exec(e[0]), mb = re.exec(e[1]);
      if (!ma || !mb) continue;
      const a = this.keyId(ma[1], ma[2]), b = this.keyId(mb[1], mb[2]);
      if (a < 0 || b < 0 || a === b) continue;
      if (this._learn(a, b, Math.floor(e[2])) < 0) continue;
      n++;
    }
    this._bumpVersion();
    return n;
  }

  /** Atomic save. Returns true if written; never throws (a full disk must not stop the service). */
  saveLearned(file) {
    if (!this.learnedDirty) return false;
    const tmp = file + '.tmp';
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.serializeLearned()));
      fs.renameSync(tmp, file);
      this.learnedDirty = false;
      return true;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) { /* nothing to remove */ }
      this.lastSaveError = e;
      return false;
    }
  }

  loadLearnedFile(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? 0 : -1; }
    try { return this.loadLearned(JSON.parse(text)); } catch (_) { return -1; }
  }
}

module.exports = { BerthGraph };
