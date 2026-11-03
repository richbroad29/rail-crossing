'use strict';

// Learned transit times (contract section 10): how long trains spend in a berth.
//
// Per berth, per class (express / stopping / ecs / freight / other, from the headcode) and per
// behaviour (the train CALLS in this berth's station, or PASSES), a streaming estimate over the last
// `ringSize` samples: median and p10/p90. Samples over `maxSeconds` (30 min: a held train, not a
// transit) are excluded. Bounded: a ring of at most 200 Uint16 seconds per series (allocated small
// and doubled), at most `maxEntries` series, each persisted as its samples in time order.
//
// A sample is only taken when the train ENTERED the berth by a step (the caller checks), so a train
// interposed mid-berth never contributes a partial time.

const fs = require('fs');
const path = require('path');

const CLASSES = ['express', 'stopping', 'ecs', 'freight', 'other'];
const BEHAVIOURS = ['calls', 'passes'];

/** Headcode first character: 1 express passenger, 2 ordinary passenger, 5 empty coaching stock, 4/6/7/8 freight, else other. */
function classOf(hc) {
  switch (typeof hc === 'string' ? hc.charAt(0) : '') {
    case '1': return 'express';
    case '2': return 'stopping';
    case '5': return 'ecs';
    case '4': case '6': case '7': case '8': return 'freight';
    default: return 'other';
  }
}

class Series {
  constructor() { this.buf = new Uint16Array(8); this.n = 0; this.head = 0; this.est = null; this.cap = 8; }
}

/** Linear-interpolated percentile (p in 0..1) of an ascending array. */
function percentile(sorted, p) {
  const n = sorted.length;
  if (!n) return null;
  const x = p * (n - 1), lo = Math.floor(x), hi = Math.ceil(x);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (x - lo);
}

class TransitStore {
  constructor({ ringSize = 200, minSamples = 5, maxSeconds = 1800, maxEntries = 60000 } = {}) {
    this.ringSize = ringSize; this.minSamples = minSamples; this.maxSeconds = maxSeconds; this.maxEntries = maxEntries;
    this.map = new Map();            // keyId*16 + cls*2 + beh -> Series
    this.version = 0;
    this.dirty = false;
    this.stats = { samples: 0, excluded: 0, dropped: 0 };
  }

  get size() { return this.map.size; }
  _key(keyId, cls, beh) { return keyId * 16 + CLASSES.indexOf(cls) * 2 + BEHAVIOURS.indexOf(beh); }

  /** @returns {boolean} whether the sample was kept */
  add(keyId, cls, beh, secs) {
    if (!(keyId >= 0) || CLASSES.indexOf(cls) < 0 || BEHAVIOURS.indexOf(beh) < 0) return false;
    if (!(secs >= 0) || secs > this.maxSeconds) { this.stats.excluded++; return false; }
    const k = this._key(keyId, cls, beh);
    let s = this.map.get(k);
    if (!s) {
      if (this.map.size >= this.maxEntries) { this.stats.dropped++; return false; }
      s = new Series(); this.map.set(k, s);
    }
    const v = Math.min(65535, Math.round(secs));
    if (s.n < this.ringSize) {
      if (s.n === s.cap) { const nc = Math.min(this.ringSize, s.cap * 2), nb = new Uint16Array(nc); nb.set(s.buf); s.buf = nb; s.cap = nc; }
      s.buf[s.n++] = v;
    } else { s.buf[s.head] = v; s.head = (s.head + 1) % this.ringSize; }
    s.est = null;
    this.stats.samples++; this.version++; this.dirty = true;
    return true;
  }

  /** {median, p10, p90, n} in seconds, or null while fewer than `minSamples`. */
  estimate(keyId, cls, beh) {
    const s = this.map.get(this._key(keyId, cls, beh));
    if (!s || s.n < this.minSamples) return null;
    if (!s.est) {
      const a = Array.from(s.buf.subarray(0, s.n)).sort((x, y) => x - y);
      s.est = { median: percentile(a, 0.5), p10: percentile(a, 0.1), p90: percentile(a, 0.9), n: s.n };
    }
    return s.est;
  }

  /** The non-stopping median for a berth, for cutting spans (section 9): the best-sampled non-freight class that PASSES. */
  passMedian(keyId) {
    let best = null;
    for (const cls of ['express', 'stopping', 'other', 'ecs']) {
      const e = this.estimate(keyId, cls, 'passes');
      if (e && (!best || e.n > best.n)) best = e;
    }
    return best ? best.median : null;
  }

  /** Samples of a series in time order (tests, persistence). */
  samples(keyId, cls, beh) {
    const s = this.map.get(this._key(keyId, cls, beh));
    if (!s) return [];
    if (s.n < this.ringSize) return Array.from(s.buf.subarray(0, s.n));
    return [...Array.from(s.buf.subarray(s.head, s.n)), ...Array.from(s.buf.subarray(0, s.head))];
  }

  // ---- persistence (berth names, not ids: ids do not survive a restart) ------------------------------------

  serialize(graph) {
    const entries = [];
    for (const [k] of this.map) {
      const keyId = Math.floor(k / 16), r = k % 16;
      const name = graph.keyOf[keyId];
      if (!name) continue;
      entries.push([name, CLASSES[r >> 1], BEHAVIOURS[r & 1], this.samples(keyId, CLASSES[r >> 1], BEHAVIOURS[r & 1])]);
    }
    return { version: 1, ringSize: this.ringSize, entries };
  }

  load(doc, graph) {
    if (!doc || doc.version !== 1 || !Array.isArray(doc.entries)) return 0;
    const re = /^([A-Z0-9]{1,4}):([A-Z0-9_\-]{1,6})$/;
    let n = 0;
    for (const e of doc.entries) {
      if (!Array.isArray(e) || typeof e[0] !== 'string' || !Array.isArray(e[3])) continue;
      const m = re.exec(e[0]);
      if (!m || CLASSES.indexOf(e[1]) < 0 || BEHAVIOURS.indexOf(e[2]) < 0) continue;
      const id = graph.keyId(m[1], m[2]);
      if (id < 0) continue;
      let any = false;
      for (const v of e[3].slice(-this.ringSize)) if (typeof v === 'number' && this.add(id, e[1], e[2], v)) any = true;
      if (any) n++;
    }
    this.stats.samples = 0; this.dirty = false;
    return n;
  }

  loadFile(file, graph) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? 0 : -1; }
    try { return this.load(JSON.parse(text), graph); } catch (_) { return -1; }
  }

  /** Atomic save when changed. Never throws. */
  saveFile(file, graph) {
    if (!this.dirty) return false;
    const tmp = file + '.tmp';
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.serialize(graph)));
      fs.renameSync(tmp, file);
      this.dirty = false;
      return true;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) { /* none */ }
      this.lastSaveError = e;
      return false;
    }
  }
}

module.exports = { TransitStore, classOf, percentile, CLASSES, BEHAVIOURS };
