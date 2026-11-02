'use strict';

// Resource sampling for td-measure: this process's memory and CPU, and the machine's headroom.
//
// Two jobs. (1) Evidence: peak RSS is the projection for the map service, and the lowest
// MemAvailable seen says how much room the box really had. (2) Protection: this runs on the
// server that catches every barrier closure, so the sampler is also what notices — within one
// sample — that the measurement itself is eating into the crossing service's headroom, and says
// so while there is still something to stop.
//
// All the readers are injected, so the arithmetic is tested with planted readings.

const v8 = require('v8');
const { readMeminfo } = require('./machine');
const { WARN_RESERVE_MB } = require('./memory-fit');

const MB = 1048576;
const round1 = n => Math.round(n * 10) / 10;
const round2 = n => Math.round(n * 100) / 100;

// Stop if the machine's available memory (which already has OUR usage taken out of it) falls
// below the same 150 MB floor the memory-fit verdict uses. This is the live safety stop, not the
// verdict: the verdict also adds an allowance for what td-measure does not model, so it can call
// FAIL long before this fires. This fires only when carrying on would eat into the headroom the
// crossing service needs — something to lose, and nothing more to learn.
const MEMORY_FLOOR_MB = WARN_RESERVE_MB;
// Stop before V8 does it for us: at the heap limit the process aborts with no report. The run
// command sets --max-old-space-size=256, so the limit is real and finite.
const HEAP_GUARD_FRACTION = 0.85;

class ResourceSampler {
  /**
   * @param {object} [o]
   * @param {function} [o.now]
   * @param {function} [o.memoryUsage]    like process.memoryUsage
   * @param {function} [o.cpuUsage]       like process.cpuUsage (microseconds, cumulative)
   * @param {function} [o.meminfo]        () -> {memAvailableMB, ...} | null
   * @param {number}   [o.heapLimitBytes]
   */
  constructor(o = {}) {
    this.now = o.now || Date.now;
    this.memoryUsage = o.memoryUsage || process.memoryUsage;
    this.cpuUsage = o.cpuUsage || (() => process.cpuUsage());
    this.meminfo = o.meminfo || (() => readMeminfo());
    this.heapLimitBytes = o.heapLimitBytes || v8.getHeapStatistics().heap_size_limit;
    this.samples = [];
    this.startedAt = this.now();
    this.startCpu = this.cpuUsage();
    this._lastCpu = this.startCpu;
    this._lastAt = this.startedAt;
    this.startAvailableMB = null;
  }

  _avail() { const m = this.meminfo(); return m && typeof m.memAvailableMB === 'number' ? m.memAvailableMB : null; }

  /** Call once before connecting: MemAvailable with this process still at its baseline. */
  begin() {
    this.startAvailableMB = this._avail();
    return this.startAvailableMB;
  }

  /** Take one reading. */
  sample() {
    const at = this.now();
    const m = this.memoryUsage();
    const cpu = this.cpuUsage();
    const wallUs = Math.max(1, (at - this._lastAt) * 1000);
    const cpuUs = (cpu.user - this._lastCpu.user) + (cpu.system - this._lastCpu.system);
    this._lastCpu = cpu;
    this._lastAt = at;
    const avail = this._avail();
    const rssMB = m.rss / MB;
    const s = {
      at,
      rssMB: round1(rssMB),
      heapUsedMB: round1(m.heapUsed / MB),
      heapTotalMB: round1(m.heapTotal / MB),
      externalMB: round1((m.external || 0) / MB),
      arrayBuffersMB: round1((m.arrayBuffers || 0) / MB),
      // % of ONE core over the interval since the previous sample.
      cpuPercent: round1((cpuUs / wallUs) * 100),
      memAvailableMB: avail === null ? null : round1(avail),
      // Available memory as it would be had this process not been running: add our own RSS back.
      memAvailableWithoutUsMB: avail === null ? null : round1(avail + rssMB),
      heapFraction: round2(m.heapUsed / this.heapLimitBytes)
    };
    this.samples.push(s);
    return s;
  }

  /** The reason to stop now, or null. {rule, message}. */
  guard(s) {
    if (s.memAvailableMB !== null && s.memAvailableMB < MEMORY_FLOOR_MB) {
      return { rule: 'memory-floor', message: `the machine's available memory fell to ${s.memAvailableMB} MB (floor ${MEMORY_FLOOR_MB} MB) with this measurement running` };
    }
    if (s.heapFraction >= HEAP_GUARD_FRACTION) {
      return { rule: 'heap-cap', message: `this process's heap reached ${Math.round(s.heapFraction * 100)}% of its ${Math.round(this.heapLimitBytes / MB)} MB limit` };
    }
    return null;
  }

  /**
   * Evidence for the report. `availableForVerdictMB` is the LOWEST of: MemAvailable at the start,
   * and (MemAvailable + our RSS) at every sample — i.e. the least room a map service would have
   * had over the run. It is conservative on purpose: at the start the first term already has our
   * baseline RSS taken out, and only another process growing during the run can make the second lower.
   */
  summary(endMs) {
    const end = endMs === undefined ? this.now() : endMs;
    const last = this.cpuUsage();
    const wallUs = Math.max(1, (end - this.startedAt) * 1000);
    const user = last.user - this.startCpu.user, system = last.system - this.startCpu.system;
    const peak = key => (this.samples.length ? Math.max(...this.samples.map(s => s[key])) : null);
    const withoutUs = this.samples.map(s => s.memAvailableWithoutUsMB).filter(v => v !== null);
    const avail = this.samples.map(s => s.memAvailableMB).filter(v => v !== null);
    const candidates = [this.startAvailableMB, ...withoutUs].filter(v => typeof v === 'number');
    return {
      samples: this.samples.length,
      peakRssMB: peak('rssMB'),
      peakHeapUsedMB: peak('heapUsedMB'),
      peakExternalMB: peak('externalMB'),
      peakArrayBuffersMB: peak('arrayBuffersMB'),
      heapLimitMB: round1(this.heapLimitBytes / MB),
      memAvailableStartMB: this.startAvailableMB,
      memAvailableMinMB: avail.length ? Math.min(...avail) : null,
      availableForVerdictMB: candidates.length ? round1(Math.min(...candidates)) : null,
      cpu: {
        userSecs: round2(user / 1e6),
        systemSecs: round2(system / 1e6),
        percentOfOneCoreMean: round2(((user + system) / wallUs) * 100),
        percentPeakInterval: this.samples.length ? Math.max(...this.samples.map(s => s.cpuPercent)) : null
      }
    };
  }

  /** One row per started minute (the highest RSS and lowest availability in it), for the JSON report. */
  series() {
    const rows = new Map();
    for (const s of this.samples) {
      const minute = Math.floor((s.at - this.startedAt) / 60000);
      const r = rows.get(minute) || { minute, rssMBMax: 0, heapUsedMBMax: 0, memAvailableMBMin: null, cpuPercentMax: 0 };
      r.rssMBMax = Math.max(r.rssMBMax, s.rssMB);
      r.heapUsedMBMax = Math.max(r.heapUsedMBMax, s.heapUsedMB);
      if (s.memAvailableMB !== null) r.memAvailableMBMin = r.memAvailableMBMin === null ? s.memAvailableMB : Math.min(r.memAvailableMBMin, s.memAvailableMB);
      r.cpuPercentMax = Math.max(r.cpuPercentMax, s.cpuPercent);
      rows.set(minute, r);
    }
    return [...rows.values()];
  }
}

module.exports = { ResourceSampler, MEMORY_FLOOR_MB, HEAP_GUARD_FRACTION };
