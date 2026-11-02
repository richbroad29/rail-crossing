'use strict';

// Bounded-memory accumulators for the format facts. Every one of them has a cap on how many
// distinct values it will remember, so a file that is not what we think it is (a million distinct
// "EVENT" values) cannot blow the heap; what overflows is counted, not kept.

const { str } = require('./norm');

/** Counts distinct values, remembering at most `cap` of them. */
class Counter {
  constructor(cap = 200) {
    this.cap = cap;
    this.counts = new Map();
    this.overflow = 0;
  }

  add(key) {
    const c = this.counts.get(key);
    if (c !== undefined) this.counts.set(key, c + 1);
    else if (this.counts.size < this.cap) this.counts.set(key, 1);
    else this.overflow++;
  }

  get total() {
    let t = this.overflow;
    for (const v of this.counts.values()) t += v;
    return t;
  }

  /** [[key, count], ...], most frequent first, ties by key. */
  entries() {
    return [...this.counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  /** { key: count } in frequency order ('' shown as "(empty)"; values past the cap as "(other)"). */
  toObject() {
    const o = {};
    for (const [k, v] of this.entries()) o[k === '' ? '(empty)' : k] = v;
    if (this.overflow) o['(other)'] = this.overflow;
    return o;
  }
}

/**
 * Exact order statistics over a stream of numbers, kept as value -> count. BERTHOFFSET is a handful
 * of distinct integer seconds, so this stays tiny; if it ever is not, the distinct values past
 * `maxDistinct` are counted in `overflow` and the summary says it is approximate.
 */
class NumberHistogram {
  constructor(maxDistinct = 20000) {
    this.maxDistinct = maxDistinct;
    this.counts = new Map();
    this.count = 0;
    this.overflow = 0;
    this._index = null;
  }

  add(x) {
    const c = this.counts.get(x);
    if (c !== undefined) { this.counts.set(x, c + 1); this.count++; }
    else if (this.counts.size < this.maxDistinct) { this.counts.set(x, 1); this.count++; }
    else { this.overflow++; return; }
    this._index = null;
  }

  _build() {
    if (!this._index) {
      const values = [...this.counts.keys()].sort((a, b) => a - b);
      const cumulative = [];
      let run = 0;
      for (const v of values) { run += this.counts.get(v); cumulative.push(run); }
      this._index = { values, cumulative };
    }
    return this._index;
  }

  /** The k-th smallest value, k counted from 0. */
  _kth(k) {
    const { values, cumulative } = this._build();
    let lo = 0, hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] > k) hi = mid; else lo = mid + 1;
    }
    return values[lo];
  }

  /** Quantile q in [0,1] by linear interpolation between neighbouring order statistics. */
  quantile(q) {
    if (!this.count) return null;
    const pos = q * (this.count - 1);
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    const a = this._kth(lo), b = this._kth(hi);
    return a + (b - a) * (pos - lo);
  }

  summary() {
    if (!this.count) return { count: 0, min: null, p10: null, median: null, p90: null, max: null };
    const r = x => Math.round(x * 10) / 10;
    const out = {
      count: this.count,
      min: r(this.quantile(0)),
      p10: r(this.quantile(0.1)),
      median: r(this.quantile(0.5)),
      p90: r(this.quantile(0.9)),
      max: r(this.quantile(1))
    };
    if (this.overflow) { out.overflow = this.overflow; out.approximate = true; }
    return out;
  }
}

/**
 * Which keys the rows have, and how often each is present (the key exists) and non-empty (its value
 * is not blank). The two differ on purpose: PLATFORM is a legitimate key that is often blank.
 */
class FieldStats {
  constructor(maxNames = 60) {
    this.maxNames = maxNames;
    this.rows = 0;
    this.present = new Map();
    this.nonEmpty = new Map();
    this.namesPastCap = 0;
  }

  observe(row) {
    this.rows++;
    for (const k of Object.keys(row)) {
      let p = this.present.get(k);
      if (p === undefined) {
        if (this.present.size >= this.maxNames) { this.namesPastCap++; continue; }
        p = 0;
      }
      this.present.set(k, p + 1);
      if (str(row[k]) !== '') this.nonEmpty.set(k, (this.nonEmpty.get(k) || 0) + 1);
    }
  }

  /**
   * [{ name, present, nonEmpty }], most-present first; keys present equally often stay in the order
   * the file first showed them (the sort is stable), which for SMART is the documented column order.
   */
  summary() {
    return [...this.present]
      .map(([name, present]) => ({ name, present, nonEmpty: this.nonEmpty.get(name) || 0 }))
      .sort((a, b) => b.present - a.present);
  }
}

module.exports = { Counter, NumberHistogram, FieldStats };
