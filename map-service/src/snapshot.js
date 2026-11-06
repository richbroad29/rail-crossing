'use strict';

// The precomputed snapshot. Rebuilt at most once a second, and only when something changed, from the
// per-train JSON strings the model already caches. A request then costs a bbox filter over parallel
// arrays plus a string join (the box of each train is where the page could draw it, contract 19.1); the whole-GB body and its gzip are built once per version and shared.
//
// serverTime and feedStale are those of the moment the snapshot was built (<= 1 s old), which is what
// lets the bodies be cached and compressed once instead of per request.

const zlib = require('zlib');

class Snapshot {
  constructor({ model, now = Date.now, gzipCacheEntries = 64 }) {
    this.model = model; this.now = now;
    this.version = 0;
    this.builtAt = now();
    this.feedStale = true;
    this.boxes = new Float64Array(0); this.jsons = [];       // boxes: s, w, n, e per train (its REACH box, contract 19.1), four numbers a row
    this.count = 0;
    this._allBody = null; this._allGz = null; this._gzPending = null;
    this._boxCache = new Map();
    this.maxBox = gzipCacheEntries;
  }

  rebuild(feedStale) {
    const boxes = new Float64Array(this.model.byId.size * 4), jsons = [];
    for (const t of this.model.placed()) {
      const j = this.model.trainJson(t);       // builds the reach box as well
      if (j === null) continue;
      boxes.set(t.reach, jsons.length * 4); jsons.push(j);
    }
    this.boxes = boxes; this.jsons = jsons; this.count = jsons.length;
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
    // A train is in the box when it could be DRAWN there, not only when it is signalled there: its reach box touches the request's.
    const b = this.boxes, S = bbox.s, W = bbox.w, N = bbox.n, E = bbox.e;
    for (let i = 0, k = 0; i < this.count; i++, k += 4) if (b[k] <= N && b[k + 2] >= S && b[k + 1] <= E && b[k + 3] >= W) out.push(this.jsons[i]);
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
