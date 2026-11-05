'use strict';

// Learned transit times (contract section 10): how long trains spend in a berth.
//
// Per berth, per class (express / stopping / ecs / freight / other, from the headcode) and per
// behaviour (the train CALLS in this berth's station, or PASSES), a streaming estimate over the last
// `ringSize` samples: median and p10/p90. Samples over `maxSeconds` (30 min: a held train, not a
// transit) are excluded.
//
// A sample is only taken when the train ENTERED the berth by a step (the caller checks), so a train
// interposed mid-berth never contributes a partial time.
//
// BOUNDED AND COMPACT (section 17.5). At most `maxEntries` series; when a new series arrives at the cap the LEAST RECENTLY UPDATED
// one is evicted (a rarely seen series, which never reaches `minSamples` anyway, goes first; live, 24 000 of the first 60 000 series
// had fewer than 5 samples). A series is NOT an object: it is a slot (two header words, then its samples as Uint16 seconds) in one of
// a few pools of paged Uint16Arrays, whose slot sizes grow 8 -> 32 -> 100 -> ringSize samples, so a series with a handful of samples
// costs tens of bytes where a typed array of its own cost about 250. The map holds one number per series (pool + slot); its insertion
// order IS the recency order (an update re-inserts), so the oldest key is the one to evict. Reads (estimate) never touch the order.
// Measured cost at the defaults is in the test and in the report: about 60 B for a small series, 440 B for a full one, plus the
// median cache (bounded).

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

/** Linear-interpolated percentile (p in 0..1) of an ascending array. */
function percentile(sorted, p) {
  const n = sorted.length;
  if (!n) return null;
  const x = p * (n - 1), lo = Math.floor(x), hi = Math.ceil(x);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (x - lo);
}

const PAGE_BITS = 8, PAGE_SLOTS = 1 << PAGE_BITS;           // slots per page: pages are allocated as the pool grows, not up front
const HEADER = 2;                                          // [n, head] ahead of the samples

/** Fixed-size slots of Uint16, in pages, with a free list. */
class Pool {
  constructor(cap) { this.cap = cap; this.stride = cap + HEADER; this.pages = []; this.free = []; this.next = 0; this.live = 0; }
  alloc() {
    let slot;
    if (this.free.length) slot = this.free.pop();
    else { slot = this.next++; if ((slot >> PAGE_BITS) >= this.pages.length) this.pages.push(new Uint16Array(PAGE_SLOTS * this.stride)); }
    const pg = this.pages[slot >> PAGE_BITS], b = (slot & (PAGE_SLOTS - 1)) * this.stride;
    pg[b] = 0; pg[b + 1] = 0;
    this.live++;
    return slot;
  }
  release(slot) { this.free.push(slot); this.live--; }
  bytes() { return this.pages.length * PAGE_SLOTS * this.stride * 2; }
}

class TransitStore {
  constructor({ ringSize = 200, minSamples = 5, maxSeconds = 1800, maxEntries = 100000, estCacheEntries = 8192 } = {}) {
    this.ringSize = ringSize; this.minSamples = minSamples; this.maxSeconds = maxSeconds; this.maxEntries = maxEntries;
    this.pools = [8, 32, 100].filter(c => c < ringSize).map(c => new Pool(c));
    this.pools.push(new Pool(ringSize));
    this.map = new Map();            // keyId*16 + cls*2 + beh -> handle (slot * 8 + pool index); insertion order = least recently updated first
    this.estCache = new Map();       // key -> estimate (bounded; dropped when the series takes a sample)
    this.estCacheEntries = estCacheEntries;
    this.version = 0;
    this.dirty = false;
    this.stats = { samples: 0, excluded: 0, evicted: 0 };
  }

  get size() { return this.map.size; }
  _key(keyId, cls, beh) { return keyId * 16 + CLASSES.indexOf(cls) * 2 + BEHAVIOURS.indexOf(beh); }

  /** Approximate bytes held: the pooled samples, plus about 40 B per series for the map and 100 B per cached estimate. */
  bytes() { let n = this.map.size * 40 + this.estCache.size * 100; for (const p of this.pools) n += p.bytes(); return n; }

  _evictOldest() {
    const k = this.map.keys().next().value;
    const h = this.map.get(k);
    this.pools[h & 7].release(h >> 3);
    this.map.delete(k); this.estCache.delete(k);
    this.stats.evicted++;
  }

  /** @returns {boolean} whether the sample was kept */
  add(keyId, cls, beh, secs) {
    if (!(keyId >= 0) || CLASSES.indexOf(cls) < 0 || BEHAVIOURS.indexOf(beh) < 0) return false;
    if (!(secs >= 0) || secs > this.maxSeconds) { this.stats.excluded++; return false; }
    const k = this._key(keyId, cls, beh);
    let h = this.map.get(k);
    if (h === undefined) {
      if (this.map.size >= this.maxEntries) this._evictOldest();
      h = this.pools[0].alloc() * 8;
    } else this.map.delete(k);                         // re-inserted below: this series is now the most recently updated
    const v = Math.min(65535, Math.round(secs));
    let tier = h & 7, slot = h >> 3, pool = this.pools[tier];
    let pg = pool.pages[slot >> PAGE_BITS], b = (slot & (PAGE_SLOTS - 1)) * pool.stride;
    const n = pg[b];
    if (n < pool.cap) { pg[b + HEADER + n] = v; pg[b] = n + 1; }
    else if (tier + 1 < this.pools.length) {           // full: move up to the next size
      const np = this.pools[tier + 1], ns = np.alloc(), npg = np.pages[ns >> PAGE_BITS], nb = (ns & (PAGE_SLOTS - 1)) * np.stride;
      for (let i = 0; i < n; i++) npg[nb + HEADER + i] = pg[b + HEADER + i];
      npg[nb + HEADER + n] = v; npg[nb] = n + 1;
      pool.release(slot);
      h = ns * 8 + tier + 1;
    } else {                                           // the biggest slot is full: a ring, the oldest sample is overwritten
      const head = pg[b + 1];
      pg[b + HEADER + head] = v; pg[b + 1] = (head + 1) % pool.cap;
    }
    this.map.set(k, h);
    this.estCache.delete(k);
    this.stats.samples++; this.version++; this.dirty = true;
    return true;
  }

  /** {median, p10, p90, n} in seconds, or null while fewer than `minSamples`. Reading never changes the recency order. */
  estimate(keyId, cls, beh) {
    const k = this._key(keyId, cls, beh);
    const h = this.map.get(k);
    if (h === undefined) return null;
    const pool = this.pools[h & 7], slot = h >> 3, pg = pool.pages[slot >> PAGE_BITS], b = (slot & (PAGE_SLOTS - 1)) * pool.stride;
    const n = pg[b];
    if (n < this.minSamples) return null;
    let est = this.estCache.get(k);
    if (!est) {
      const a = new Uint16Array(n);
      for (let i = 0; i < n; i++) a[i] = pg[b + HEADER + i];
      a.sort();                                        // numeric for a typed array
      est = { median: percentile(a, 0.5), p10: percentile(a, 0.1), p90: percentile(a, 0.9), n };
      if (this.estCache.size >= this.estCacheEntries) this.estCache.clear();
      this.estCache.set(k, est);
    }
    return est;
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
    const h = this.map.get(this._key(keyId, cls, beh));
    if (h === undefined) return [];
    const pool = this.pools[h & 7], slot = h >> 3, pg = pool.pages[slot >> PAGE_BITS], b = (slot & (PAGE_SLOTS - 1)) * pool.stride;
    const n = pg[b], head = pg[b + 1], out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = pg[b + HEADER + ((head + i) % n)];        // head is 0 until the ring is full, so this is time order either way
    return out;
  }

  // ---- persistence (berth names, not ids: ids do not survive a restart) ------------------------------------
  //
  // One JSON document, but with ONE SERIES PER LINE, written and read a line at a time: the national set is millions of samples, and
  // building (or parsing) the whole document at once would put a transient of several times its size on the heap, at the very moment
  // (boot, hourly save) the service has the least headroom. The file is still plain valid JSON, and a single-line file from before
  // this layout loads as before. Least recently updated series come first, so loading restores the recency order.

  _entries(graph, fn) {
    for (const k of this.map.keys()) {
      const keyId = Math.floor(k / 16), r = k % 16;
      const name = graph.keyOf[keyId];
      if (!name) continue;
      fn([name, CLASSES[r >> 1], BEHAVIOURS[r & 1], this.samples(keyId, CLASSES[r >> 1], BEHAVIOURS[r & 1])]);
    }
  }

  serialize(graph) {
    const entries = [];
    this._entries(graph, e => entries.push(e));
    return { version: 1, ringSize: this.ringSize, entries };
  }

  _loadEntry(e, graph) {
    const re = /^([A-Z0-9]{1,4}):([A-Z0-9_\-]{1,6})$/;
    if (!Array.isArray(e) || typeof e[0] !== 'string' || !Array.isArray(e[3])) return false;
    const m = re.exec(e[0]);
    if (!m || CLASSES.indexOf(e[1]) < 0 || BEHAVIOURS.indexOf(e[2]) < 0) return false;
    const id = graph.keyId(m[1], m[2]);
    if (id < 0) return false;
    let any = false;
    for (const v of e[3].slice(-this.ringSize)) if (typeof v === 'number' && this.add(id, e[1], e[2], v)) any = true;
    return any;
  }

  load(doc, graph) {
    if (!doc || doc.version !== 1 || !Array.isArray(doc.entries)) return 0;
    let n = 0;
    for (const e of doc.entries) if (this._loadEntry(e, graph)) n++;
    this.stats.samples = 0; this.dirty = false;
    return n;
  }

  loadFile(file, graph) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? 0 : -1; }
    try {
      if (text.indexOf('\n') < 0 || text.indexOf('\n') === text.length - 1) return this.load(JSON.parse(text), graph);      // the one-line layout
      let at = text.indexOf('\n'), n = 0;
      if (!/^\{"version":1,/.test(text) || !/"entries":\[$/.test(text.slice(0, at))) return -1;
      while (at < text.length) {
        let end = text.indexOf('\n', at + 1);
        if (end < 0) end = text.length;
        let line = text.slice(at + 1, end);
        at = end;
        if (line.charCodeAt(line.length - 1) === 44) line = line.slice(0, -1);      // the comma between series
        if (line.charCodeAt(0) !== 91) continue;                                    // the closing "]}" (or junk)
        try { if (this._loadEntry(JSON.parse(line), graph)) n++; } catch (_) { /* a damaged line is skipped, not fatal */ }
      }
      this.stats.samples = 0; this.dirty = false;
      return n;
    } catch (_) { return -1; }
  }

  /** Atomic save when changed, streamed a line at a time in ~1 MB writes. Never throws. */
  saveFile(file, graph) {
    if (!this.dirty) return false;
    const tmp = file + '.tmp';
    let fd = null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fd = fs.openSync(tmp, 'w');
      let buf = `{"version":1,"ringSize":${this.ringSize},"entries":[\n`, first = true;
      this._entries(graph, e => {
        buf += (first ? '' : ',\n') + JSON.stringify(e); first = false;
        if (buf.length > 1048576) { fs.writeSync(fd, buf); buf = ''; }
      });
      fs.writeSync(fd, buf + '\n]}\n');
      fs.closeSync(fd); fd = null;
      fs.renameSync(tmp, file);
      this.dirty = false;
      return true;
    } catch (e) {
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* gone */ } }
      try { fs.unlinkSync(tmp); } catch (_) { /* none */ }
      this.lastSaveError = e;
      return false;
    }
  }
}

module.exports = { TransitStore, classOf, percentile, CLASSES, BEHAVIOURS };
