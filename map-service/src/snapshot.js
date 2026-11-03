'use strict';

// The precomputed snapshot. Rebuilt at most once a second, and only when something changed, from the
// per-train JSON strings the model already caches. A request then costs a bbox filter over parallel
// arrays plus a string join; the whole-GB body and its gzip are built once per version and shared.
//
// serverTime and feedStale are those of the moment the snapshot was built (<= 1 s old), which is what
// lets the bodies be cached and compressed once instead of per request.

const zlib = require('zlib');
const { inBbox } = require('./geo');

class Snapshot {
  constructor({ model, now = Date.now, gzipCacheEntries = 64 }) {
    this.model = model; this.now = now;
    this.version = 0;
    this.builtAt = now();
    this.feedStale = true;
    this.lats = []; this.lons = []; this.jsons = []; this.ids = [];
    this.count = 0;
    this._allBody = null; this._allGz = null; this._gzPending = null;
    this._boxCache = new Map();
    this.maxBox = gzipCacheEntries;
  }

  rebuild(feedStale) {
    const lats = [], lons = [], jsons = [];
    for (const t of this.model.placed()) {
      const j = this.model.trainJson(t);
      if (j === null) continue;
      lats.push(t.lat); lons.push(t.lon); jsons.push(j);
    }
    this.lats = lats; this.lons = lons; this.jsons = jsons; this.count = jsons.length;
    this.feedStale = !!feedStale;
    this.builtAt = this.now();
    this.version++;
    this._allBody = null; this._allGz = null; this._gzPending = null;
    this._boxCache.clear();
  }

  _wrap(joined) {
    return `{"serverTime":${this.builtAt},"feedStale":${this.feedStale},"trains":[${joined}]}`;
  }

  /** The /trains (and SSE snapshot) body for a box, or the whole of GB when `bbox` is null. */
  body(bbox) {
    if (!bbox) {
      if (this._allBody === null) this._allBody = this._wrap(this.jsons.join(','));
      return this._allBody;
    }
    const out = [];
    for (let i = 0; i < this.count; i++) if (inBbox(this.lats[i], this.lons[i], bbox)) out.push(this.jsons[i]);
    return this._wrap(out.join(','));
  }

  /** gzip of body(bbox), computed once per snapshot version per box (small bounded cache). */
  gz(bbox, key) {
    if (!bbox) {
      if (this._allGz) return Promise.resolve(this._allGz);
      if (!this._gzPending) {
        const v = this.version;
        this._gzPending = gzip(this.body(null)).then(b => { if (v === this.version) this._allGz = b; return b; });
      }
      return this._gzPending;
    }
    const hit = this._boxCache.get(key);
    if (hit) return hit;
    const v = this.version;
    const p = gzip(this.body(bbox)).catch(e => { this._boxCache.delete(key); throw e; });
    if (this._boxCache.size >= this.maxBox) this._boxCache.delete(this._boxCache.keys().next().value);
    this._boxCache.set(key, p);
    p.then(() => { if (v !== this.version) this._boxCache.delete(key); }, () => {});
    return p;
  }
}

function gzip(text) {
  return new Promise((resolve, reject) => zlib.gzip(text, { level: 6 }, (e, b) => (e ? reject(e) : resolve(b))));
}

module.exports = { Snapshot, gzip };
