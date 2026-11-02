'use strict';

// What the NATIONAL TD feed looks like, and what a map service holding its state would cost.
//
// Two jobs in one pass over each frame:
//   1. Volume: STOMP messages, body bytes, events by type and by area, distinct areas and
//      descriptions, a per-bucket series (default one minute) with its peak, and the busiest
//      second.
//   2. A stand-in for the map service's state, so the process's memory is realistic when
//      td-measure reads its peak RSS: berth occupancy (area:berth -> description, time), the berth
//      graph (area:from>to with a step count) and a bounded ring of step timings per edge.
//      Semantics follow the proof-of-concept's train-map.js, as verified on the real feed:
//        CA  step       the description moves from `from` to `to`
//        CB  cancel     the description in `from` is removed   (carries `from` only)
//        CC  interpose  a description is written into `to`      (carries `to` only)
//
// Pure and clock-free: callers say when each frame arrived, so tests plant exact counts.
//
// Deliberately NOT done: pruning occupancy by age. The real service will probably prune (the
// proof of concept drops berths unseen for 45 min), which would make this smaller; leaving it out
// errs on the side of overstating memory, which is the safe direction for a "does it fit" check.
// It is still bounded — by the number of distinct berths — and the hard limits below stop any
// structure growing without end on malformed input.

const SAMPLE_CAP = 20;                  // step timings kept per edge
const MAX_STEP_SECS = 3600;             // a "step" slower than an hour is not a timing sample
const GROWTH_THRESHOLD_PCT = 2;         // edges still growing if +2% over the final third
const LIMITS = Object.freeze({ occupancy: 500000, edges: 500000, descriptions: 500000 });

const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
const sortedObject = map => Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));

class TdStats {
  /**
   * @param {object} o
   * @param {number} o.startMs     when measuring began (bucket 0 starts here)
   * @param {number} [o.bucketMs]  series resolution; default one minute
   * @param {number} [o.sampleCap] step timings kept per edge
   * @param {object} [o.limits]    overrides for LIMITS (tests)
   */
  constructor({ startMs, bucketMs = 60000, sampleCap = SAMPLE_CAP, limits = {} } = {}) {
    if (!Number.isFinite(startMs)) throw new TypeError('TdStats needs startMs');
    this.startMs = startMs;
    this.bucketMs = bucketMs;
    this.sampleCap = sampleCap;
    this.limits = { ...LIMITS, ...limits };

    this.frames = 0;
    this.bytes = 0;
    this.events = 0;
    this.parseErrors = 0;
    this.nonArrayFrames = 0;
    this.malformedItems = 0;
    this.noAreaEvents = 0;
    this.byType = new Map();
    this.byArea = new Map();
    this.descriptions = new Set();

    this.occupancy = new Map(); // "AREA:BERTH" -> {descr, at}
    this.edges = new Map();     // "AREA:FROM>TO" -> {n, s: number[]}
    this.sampleCount = 0;
    this.stateEvents = { CA: 0, CB: 0, CC: 0, skipped: 0 };
    this.limitHits = { occupancy: 0, edges: 0, descriptions: 0 };

    this.firstFrameAt = null;
    this.lastFrameAt = null;
    this.maxGapMs = 0;
    this.buckets = [];
    this._cur = null;
    this._sec = null; this._secEvents = 0; this._secFrames = 0;
    this.peakSecond = { events: 0, frames: 0, atMs: null };
    this.ingestNs = 0n;
  }

  /** Process one STOMP message body that arrived at `atMs`. Never throws. */
  ingest(body, atMs) {
    const t0 = process.hrtime.bigint();
    try { this._ingest(body, atMs); }
    finally { this.ingestNs += process.hrtime.bigint() - t0; }
  }

  _ingest(body, atMs) {
    this.frames++;
    const size = Buffer.byteLength(body);
    this.bytes += size;
    if (this.firstFrameAt === null) this.firstFrameAt = atMs;
    else this.maxGapMs = Math.max(this.maxGapMs, atMs - this.lastFrameAt);
    this.lastFrameAt = atMs;

    const bucket = this._bucketFor(atMs);
    bucket.frames++;
    bucket.bytes += size;

    let events = 0, cclass = 0;
    let parsed;
    try { parsed = JSON.parse(body); } catch (_) { this.parseErrors++; }
    if (parsed !== undefined) {
      if (!Array.isArray(parsed)) this.nonArrayFrames++;
      else {
        for (const wrapper of parsed) {
          if (wrapper === null || typeof wrapper !== 'object' || Array.isArray(wrapper)) { this.malformedItems++; continue; }
          for (const key of Object.keys(wrapper)) {
            events++;
            const msg = wrapper[key];
            const isObj = msg !== null && typeof msg === 'object';
            const kind = (isObj && typeof msg.msg_type === 'string' && msg.msg_type) || (key.endsWith('_MSG') ? key.slice(0, -4) : key);
            bump(this.byType, kind);
            const area = isObj && typeof msg.area_id === 'string' ? msg.area_id : '';
            if (area) bump(this.byArea, area); else this.noAreaEvents++;
            if (kind === 'CA' || kind === 'CB' || kind === 'CC') {
              cclass++;
              if (isObj) this._state(kind, area, msg, atMs);
            }
          }
        }
      }
    }
    this.events += events;
    bucket.events += events;
    bucket.cclass += cclass;
    this._second(atMs, events);
  }

  _bucketFor(atMs) {
    const idx = Math.max(0, Math.floor((atMs - this.startMs) / this.bucketMs));
    if (this._cur && idx <= this._cur.index) return this._cur;
    // Close the previous bucket with the state sizes as they stood, and fill any quiet gap so the
    // series has no holes (the feed is never quiet, but a stalled run should show as zeros).
    let i = this._cur ? this._cur.index + 1 : 0;
    for (; i <= idx; i++) {
      if (this._cur) this._cur.sizes = this.sizes();
      this._cur = { index: i, frames: 0, events: 0, cclass: 0, bytes: 0, sizes: null };
      this.buckets.push(this._cur);
    }
    return this._cur;
  }

  _second(atMs, events) {
    const s = Math.floor(atMs / 1000);
    if (s !== this._sec) { this._flushSecond(); this._sec = s; this._secEvents = 0; this._secFrames = 0; }
    this._secEvents += events;
    this._secFrames++;
  }

  _flushSecond() {
    if (this._sec === null) return;
    // The first second seen always becomes the peak, even at zero events: a run whose frames
    // carried no events must still report "busiest second: 0", not null.
    if (this.peakSecond.atMs === null || this._secEvents > this.peakSecond.events) {
      this.peakSecond = { events: this._secEvents, frames: this._secFrames, atMs: this._sec * 1000 };
    }
  }

  _state(kind, area, msg, atMs) {
    const descr = typeof msg.descr === 'string' ? msg.descr.trim() : '';
    if (descr) {
      if (this.descriptions.size < this.limits.descriptions || this.descriptions.has(descr)) this.descriptions.add(descr);
      else this.limitHits.descriptions++;
    }
    const t = Number(msg.time);
    const at = Number.isFinite(t) && t > 0 ? t : atMs;
    if (!area) { this.stateEvents.skipped++; return; }

    if (kind === 'CA') {
      if (!msg.from || !msg.to || !descr) { this.stateEvents.skipped++; return; }
      this.stateEvents.CA++;
      const fromKey = `${area}:${msg.from}`;
      const prev = this.occupancy.get(fromKey);
      this.occupancy.delete(fromKey);
      this._occupy(`${area}:${msg.to}`, descr, at);
      // How long this description sat in `from` is the step's timing — the number a map needs to
      // animate a train between berths, and the thing the per-edge sample ring exists to hold.
      let dt = null;
      if (prev && prev.descr === descr) {
        const secs = (at - prev.at) / 1000;
        if (secs >= 0 && secs <= MAX_STEP_SECS) dt = secs;
      }
      this._edge(`${area}:${msg.from}>${msg.to}`, dt);
    } else if (kind === 'CB') {
      if (!msg.from) { this.stateEvents.skipped++; return; }
      this.stateEvents.CB++;
      this.occupancy.delete(`${area}:${msg.from}`);
    } else {
      if (!msg.to || !descr) { this.stateEvents.skipped++; return; }
      this.stateEvents.CC++;
      this._occupy(`${area}:${msg.to}`, descr, at);
    }
  }

  _occupy(key, descr, at) {
    if (!this.occupancy.has(key) && this.occupancy.size >= this.limits.occupancy) { this.limitHits.occupancy++; return; }
    this.occupancy.set(key, { descr, at });
  }

  _edge(key, dt) {
    let e = this.edges.get(key);
    if (!e) {
      if (this.edges.size >= this.limits.edges) { this.limitHits.edges++; return; }
      e = { n: 0, s: [] };
      this.edges.set(key, e);
    }
    e.n++;
    if (dt === null) return;
    if (e.s.length < this.sampleCap) { e.s.push(dt); this.sampleCount++; }
    else e.s[e.n % this.sampleCap] = dt;   // a ring: the oldest-ish sample is overwritten
  }

  /** The sizes of everything held, for "is it still growing". */
  sizes() {
    return {
      occupancy: this.occupancy.size,
      edges: this.edges.size,
      samples: this.sampleCount,
      descriptions: this.descriptions.size,
      areas: this.byArea.size
    };
  }

  // Buckets are created when a frame arrives, so a feed that goes quiet leaves the series ending
  // early. Pad it to the end of the run with empty buckets: trailing zeros are exactly how a
  // stalled feed should show up.
  _padTo(endMs) {
    if (!this._cur) return;     // no frame ever arrived: an empty series says "no data"
    // The last bucket to create is the one holding endMs — unless that is only a sliver (a few ms
    // past a boundary, from end-of-run bookkeeping), which would show up as a bogus "0 s" row.
    const span = endMs - this.startMs;
    const sliverMs = Math.min(1000, this.bucketMs / 10);
    let last = Math.floor(span / this.bucketMs);
    if (span - last * this.bucketMs < sliverMs) last -= 1;
    last = Math.max(0, last);
    while (this._cur.index < last) {
      if (!this._cur.sizes) this._cur.sizes = this.sizes();
      this._cur = { index: this._cur.index + 1, frames: 0, events: 0, cclass: 0, bytes: 0, sizes: null };
      this.buckets.push(this._cur);
    }
  }

  /** Per-bucket rows, flat, for the JSON report. Call after the last frame (or via summary()). */
  series(endMs) {
    if (endMs !== undefined) this._padTo(endMs);
    if (this._cur && !this._cur.sizes) this._cur.sizes = this.sizes();
    return this.buckets.map(b => {
      const startOfBucket = this.startMs + b.index * this.bucketMs;
      const lenMs = Math.min(this.bucketMs, Math.max(1, (endMs === undefined ? startOfBucket + this.bucketMs : endMs) - startOfBucket));
      return {
        bucket: b.index,
        startedAt: new Date(startOfBucket).toISOString(),
        seconds: Math.round(lenMs / 100) / 10,
        frames: b.frames, events: b.events, cclass: b.cclass, bytes: b.bytes,
        eventsPerSec: round2(b.events / (lenMs / 1000)),
        occupancy: b.sizes ? b.sizes.occupancy : null,
        edges: b.sizes ? b.sizes.edges : null
      };
    });
  }

  summary(endMs) {
    this._flushSecond();
    const durationSecs = Math.max(0.001, (endMs - this.startMs) / 1000);
    const series = this.series(endMs);
    // Peak among COMPLETE buckets: a final partial bucket's rate is noisy. If nothing is
    // complete (a very short run), the partial one is all there is.
    const complete = series.filter(r => r.seconds >= this.bucketMs / 1000 - 0.05);
    const pool = complete.length ? complete : series;
    const peak = pool.reduce((best, r) => (!best || r.eventsPerSec > best.eventsPerSec ? r : best), null);
    const ingestMs = Number(this.ingestNs) / 1e6;
    return {
      durationSecs: round2(durationSecs),
      frames: this.frames,
      bytes: this.bytes,
      events: this.events,
      cclassEvents: this.eventsOf('CA', 'CB', 'CC'),
      eventsByType: sortedObject(this.byType),
      eventsPerArea: sortedObject(this.byArea),
      areas: this.byArea.size,
      distinctDescriptions: this.descriptions.size,
      parseErrors: this.parseErrors,
      nonArrayFrames: this.nonArrayFrames,
      malformedItems: this.malformedItems,
      eventsWithoutArea: this.noAreaEvents,
      rates: {
        framesPerSecMean: round2(this.frames / durationSecs),
        eventsPerSecMean: round2(this.events / durationSecs),
        cclassPerSecMean: round2(this.eventsOf('CA', 'CB', 'CC') / durationSecs),
        bodyKBPerSecMean: round2(this.bytes / 1024 / durationSecs),
        bodyMBPerHour: round2((this.bytes / 1048576) / (durationSecs / 3600))
      },
      peakBucket: peak && { startedAt: peak.startedAt, seconds: peak.seconds, eventsPerSec: peak.eventsPerSec, events: peak.events, frames: peak.frames },
      peakSecond: this.peakSecond.atMs === null ? null : { at: new Date(this.peakSecond.atMs).toISOString(), events: this.peakSecond.events, frames: this.peakSecond.frames },
      maxGapSecs: round2(this.maxGapMs / 1000),
      // How long the feed had been quiet when measuring stopped (null if nothing ever arrived).
      trailingQuietSecs: this.lastFrameAt === null ? null : round2(Math.max(0, endMs - this.lastFrameAt) / 1000),
      state: {
        ...this.sizes(),
        sampleCap: this.sampleCap,
        events: { ...this.stateEvents },
        limitHits: { ...this.limitHits }
      },
      ingestMsTotal: round2(ingestMs),
      ingestUsPerFrame: this.frames ? round2((ingestMs * 1000) / this.frames) : 0
    };
  }

  eventsOf(...kinds) { return kinds.reduce((n, k) => n + (this.byType.get(k) || 0), 0); }
}

const round2 = n => Math.round(n * 100) / 100;

/**
 * Is the berth graph still growing at the end of the run? `series` is TdStats#series() rows.
 * Edges at one-third, two-thirds and the end, and the growth over the final third as a percentage
 * of the end value. A graph that is still learning means peak RSS is a floor, not a ceiling.
 */
function growthSummary(series) {
  const rows = series.filter(r => r.edges !== null);
  if (rows.length < 3) return { enough: false };
  // k thirds of the way through, in integer arithmetic (n * (2/3) in floats can land a hair
  // above a whole number and pick the wrong row).
  const at = k => rows[Math.min(rows.length - 1, Math.max(0, Math.ceil((rows.length * k) / 3) - 1))].edges;
  const third = at(1), twoThirds = at(2), end = rows[rows.length - 1].edges;
  const lastThirdPct = end > 0 ? round2(((end - twoThirds) / end) * 100) : 0;
  return {
    enough: true, edgesAtThird: third, edgesAtTwoThirds: twoThirds, edgesAtEnd: end,
    lastThirdGrowthPct: lastThirdPct, stillGrowing: lastThirdPct >= GROWTH_THRESHOLD_PCT
  };
}

module.exports = { TdStats, growthSummary, SAMPLE_CAP, LIMITS, GROWTH_THRESHOLD_PCT, MAX_STEP_SECS };
