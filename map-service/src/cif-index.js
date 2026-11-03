'use strict';

// A compact, streamed index of the CIF timetable, and the phase-1 service match.
//
// The full file (~120 MB gzipped, several hundred thousand schedules) is read line by line and never
// held. Only schedules that run on a TARGET day (today, tomorrow, and yesterday when built before
// 05:00) are kept, resolved per day by STP priority (C cancel > N new > O overlay > P permanent),
// and each kept schedule's calling/passing points are packed into one Int16Array:
//
//     5 values per point:  tiplocId, arr, dep, pass, platformId      (-1 = absent)
//
// Times are whole minutes since the schedule's own midnight, UNWRAPPED across 00:00 (a train that
// calls at 23:58 and 00:03 has 1438 and 1443), so one schedule is monotonic and `now - midnight`
// compares directly. TIPLOCs and platforms are interned. Memory is measured by dev/measure-memory.js.
//
// Match (contract §4): same headcode; a schedule active on one of the day sets whose route passes a
// timing point in the train's current TD area; the booked time at the nearest such point closest to
// now, within `windowMins`. Two different services equally close -> no match. No match -> null.

const readline = require('readline');
const { openText } = require('./reference');
const { london, dayNumOf, dowOfDayNum, dateOfDayNum, hhmm } = require('./time');

const STP_RANK = { P: 0, O: 1, N: 2, C: 3 };
const CHUNK = 1 << 20;
const STRIDE = 5;
const MAX_LINE = 4 * 1024 * 1024;

const timeMins = t => {
  if (typeof t !== 'string' || t.length < 4) return -1;
  const h = +t.slice(0, 2), m = +t.slice(2, 4);
  if (!(h >= 0 && h < 24 && m >= 0 && m < 60)) return -1;
  return h * 60 + m;
};

class Interner {
  constructor() { this.map = new Map(); this.list = []; }
  id(s) {
    let i = this.map.get(s);
    if (i === undefined) { i = this.list.length; this.map.set(s, i); this.list.push(s); }
    return i;
  }
}

class CifIndex {
  constructor() {
    this.tiplocs = new Interner();
    this.platforms = new Interner();
    this.platforms.id('');                  // platform id 0 = none
    this.pool = new Int16Array(0);
    this.scheds = [];                       // compact records
    this.days = [];                         // [{date, dayNum, byHc: Map<hc, recIdx[]>, count}]
    this.builtAt = 0;
    this.gen = 0;
    this._areaCache = new Map();
    this._areaSource = null;
  }

  get schedules() { return this.scheds.length; }

  /** Drop day sets that are no longer reachable (yesterday after `untilHour`), freeing their lists. */
  prune(nowMs, untilHour = 5) {
    const l = london(nowMs);
    const before = this.days.length;
    this.days = this.days.filter(d => (l.dayNum - d.dayNum) * 1440 + l.minutes <= 1440 + untilHour * 60);
    return before - this.days.length;
  }

  _areaIds(area, areaTiplocs) {
    if (this._areaSource !== areaTiplocs) { this._areaCache.clear(); this._areaSource = areaTiplocs; }
    let ids = this._areaCache.get(area);
    if (ids === undefined) {
      ids = new Set();
      const set = areaTiplocs && areaTiplocs.get(area);
      if (set) for (const t of set) { const i = this.tiplocs.map.get(t); if (i !== undefined) ids.add(i); }
      this._areaCache.set(area, ids);
    }
    return ids;
  }

  _booked(pool, off, i) {
    const b = off + i * STRIDE;
    const dep = pool[b + 2], pass = pool[b + 3], arr = pool[b + 1];
    return dep >= 0 ? dep : pass >= 0 ? pass : arr;
  }

  /**
   * @param {string} hc            headcode
   * @param {string} area          TD area the train is in now
   * @param {number} nowMs
   * @param {{areaTiplocs:Map, namer:function, window?:number}} ctx
   * @returns {{rec:object, dist:number, dayDate:string}|null}
   */
  match(hc, area, nowMs, ctx) {
    if (!hc || !this.days.length) return null;
    const ids = this._areaIds(area, ctx.areaTiplocs);
    if (!ids.size) return null;
    const window = ctx.window || 45;
    const l = london(nowMs);
    let best = null, second = null;
    for (const day of this.days) {
      const list = day.byHc.get(hc);
      if (!list) continue;
      const rel = (l.dayNum - day.dayNum) * 1440 + l.minutes;
      for (const ri of list) {
        const rec = this.scheds[ri];
        let d = Infinity;
        for (let i = 0; i < rec.n; i++) {
          if (!ids.has(this.pool[rec.off + i * STRIDE])) continue;
          const t = this._booked(this.pool, rec.off, i);
          if (t < 0) continue;
          const dist = Math.abs(t - rel);
          if (dist < d) d = dist;
        }
        if (d > window) continue;
        const cand = { rec, dist: d, dayDate: day.date };
        if (!best || d < best.dist) { second = best; best = cand; }
        else if (!second || d < second.dist) second = cand;
      }
    }
    if (!best) return null;
    // Two DIFFERENT services equally close is a guess, and a wrong destination is worse than none.
    if (second && second.rec.uid !== best.rec.uid && Math.abs(second.dist - best.dist) < 0.5) return null;
    return best;
  }

  _name(namer, id) { const t = this.tiplocs.list[id]; return namer(t) || t; }

  /** The compact `svc` object for a Train. */
  svc(rec, namer) {
    const p = this.pool, last = rec.off + (rec.n - 1) * STRIDE;
    const dep = this._booked(p, rec.off, 0);
    const arrRaw = p[last + 1] >= 0 ? p[last + 1] : this._booked(p, rec.off, rec.n - 1);
    return {
      uid: rec.uid, toc: rec.toc,
      o: this._name(namer, p[rec.off]), d: this._name(namer, p[last]),
      dep: hhmm(dep), arr: hhmm(arrRaw), cat: rec.cat, pwr: rec.pwr, load: rec.load
    };
  }

  /** The full `service` object for /train/:id. */
  detail(rec, namer) {
    const p = this.pool, base = rec.off, last = base + (rec.n - 1) * STRIDE;
    const calls = [];
    for (let i = 0; i < rec.n; i++) {
      const b = base + i * STRIDE;
      calls.push({
        name: this._name(namer, p[b]), tiploc: this.tiplocs.list[p[b]],
        arr: hhmm(p[b + 1]), dep: hhmm(p[b + 2]), pass: hhmm(p[b + 3]),
        platform: p[b + 4] > 0 ? this.platforms.list[p[b + 4]] : null
      });
    }
    const speed = Number(rec.speed);
    return {
      uid: rec.uid, stp: rec.stp, toc: rec.toc, headcode: rec.hc, category: rec.cat, power: rec.pwr,
      timingLoad: rec.load, speedMph: Number.isFinite(speed) && speed > 0 ? speed : null,
      origin: { name: this._name(namer, p[base]), time: hhmm(this._booked(p, base, 0)) },
      destination: { name: this._name(namer, p[last]), time: hhmm(p[last + 1] >= 0 ? p[last + 1] : this._booked(p, base, rec.n - 1)) },
      calls
    };
  }
}

/**
 * Stream a CIF file into a CifIndex.
 * @param {string} file
 * @param {{dayNums:number[], yieldEvery?:number, collect?:function, collectEvery?:number}} opts  the London day numbers to index; `collect` (a gc) is called every `collectEvery` lines
 * @returns {Promise<CifIndex & {stats:object}>}
 */
async function buildCifIndex(file, { dayNums, yieldEvery = 1500, collect = null, collectEvery = 6000 }) {
  const index = new CifIndex();
  const chunks = [];
  let cur = new Int16Array(CHUNK), curUsed = 0;
  chunks.push(cur);
  const strs = new Map();
  const intern = s => { let e = strs.get(s); if (e === undefined) { e = s; strs.set(s, s); } return e; };

  const recs = [];                                      // provisional, all non-cancel candidates
  const bestByDay = dayNums.map(() => new Map());       // uid -> { rank, ri } (ri -1 = cancelled)
  const stats = { lines: 0, schedules: 0, prefiltered: 0, candidates: 0, cancels: 0, badLines: 0, skippedLong: 0 };

  const addPoints = locs => {
    // Reserve worst case in the chunk, write, then keep what was used.
    const need = locs.length * STRIDE;
    if (need > CHUNK) return null;
    if (curUsed + need > CHUNK) { cur = new Int16Array(CHUNK); curUsed = 0; chunks.push(cur); }
    const start = curUsed, chunkNo = chunks.length - 1;
    let n = 0, prev = -1, offset = 0;
    const unwrap = t => {
      if (t < 0) return -1;
      let v = t + offset;
      if (prev >= 0 && v < prev - 720) { offset += 1440; v = t + offset; }
      prev = v;
      return v;
    };
    for (const loc of locs) {
      if (!loc || typeof loc.tiploc_code !== 'string' || !loc.tiploc_code) continue;
      const type = loc.location_type;
      if (type !== 'LO' && type !== 'LI' && type !== 'LT') continue;
      const arr = timeMins(loc.arrival), dep = timeMins(loc.departure), pass = timeMins(loc.pass);
      if (arr < 0 && dep < 0 && pass < 0) continue;
      const b = curUsed + n * STRIDE;
      cur[b] = index.tiplocs.id(loc.tiploc_code);
      cur[b + 1] = unwrap(arr);
      cur[b + 2] = unwrap(dep);
      cur[b + 3] = unwrap(pass);
      cur[b + 4] = typeof loc.platform === 'string' && loc.platform.trim() ? index.platforms.id(loc.platform.trim().slice(0, 4)) : 0;
      n++;
    }
    if (n < 2) return null;
    curUsed += n * STRIDE;
    return { chunkNo, off: start, n };
  };

  // Which target days does a schedule with these dates and this days-of-week mask run on?
  const daysFor = (start, end, runs) => {
    const sn = dayNumOf(start), en = dayNumOf(end);
    const out = [];
    for (let d = 0; d < dayNums.length; d++) {
      const dn = dayNums[d];
      if (Number.isFinite(sn) && dn < sn) continue;
      if (Number.isFinite(en) && dn > en) continue;
      if (runs[dowOfDayNum(dn)] !== '1') continue;
      out.push(d);
    }
    return out;
  };
  // Most of the full file is schedules that run on none of our days. Their three scheduling fields
  // are read straight off the line, so those never pay for a JSON.parse (CPU, and a garbage object
  // per line, which is what drives the transient heap). If any field cannot be found the line takes
  // the full parse as before.
  const grab = (line, key) => {
    const k = `"${key}":"`;
    const i = line.indexOf(k);
    if (i < 0) return null;
    const j = line.indexOf('"', i + k.length);
    return j < 0 ? null : line.slice(i + k.length, j);
  };

  const rl = readline.createInterface({ input: openText(file), crlfDelay: Infinity });
  let sinceYield = 0;
  for await (const line of rl) {
    stats.lines++;
    if (++sinceYield >= yieldEvery) { sinceYield = 0; await new Promise(r => setImmediate(r)); }
    if (collect && stats.lines % collectEvery === 0) collect();      // keep the parse's garbage from piling up on the heap
    if (line.length > MAX_LINE) { stats.skippedLong++; continue; }
    if (line.charCodeAt(0) !== 123 || line.indexOf('"JsonScheduleV1"') < 0) continue;
    const pre = { s: grab(line, 'schedule_start_date'), e: grab(line, 'schedule_end_date'), r: grab(line, 'schedule_days_runs') };
    if (pre.s !== null && pre.e !== null && pre.r !== null && !daysFor(pre.s.slice(0, 10), pre.e.slice(0, 10), pre.r).length) { stats.schedules++; stats.prefiltered++; continue; }
    let s;
    try { s = JSON.parse(line).JsonScheduleV1; } catch (_) { stats.badLines++; continue; }
    if (!s || typeof s !== 'object' || typeof s.CIF_train_uid !== 'string') { stats.badLines++; continue; }
    stats.schedules++;
    if (s.transaction_type !== undefined && s.transaction_type !== 'Create') continue;
    if (s.train_status === 'B' || s.train_status === 'S') continue;  // bus / ship: never in TD
    const start = typeof s.schedule_start_date === 'string' ? s.schedule_start_date.slice(0, 10) : '';
    const end = typeof s.schedule_end_date === 'string' ? s.schedule_end_date.slice(0, 10) : '';
    const runs = typeof s.schedule_days_runs === 'string' ? s.schedule_days_runs : '';
    const dayIdx = daysFor(start, end, runs);
    if (!dayIdx.length) continue;
    const stp = STP_RANK[s.CIF_stp_indicator] === undefined ? 'P' : s.CIF_stp_indicator;
    const rank = STP_RANK[stp];
    const uid = s.CIF_train_uid;

    if (stp === 'C') {
      stats.cancels++;
      for (const d of dayIdx) { const m = bestByDay[d], b = m.get(uid); if (!b || rank >= b.rank) m.set(uid, { rank, ri: -1 }); }
      continue;
    }
    let seg = s.schedule_segment;
    if (Array.isArray(seg)) seg = seg[0];
    if (!seg || typeof seg !== 'object' || !Array.isArray(seg.schedule_location)) continue;
    const hc = typeof seg.signalling_id === 'string' ? seg.signalling_id.trim() : '';
    if (!hc || hc.length > 8) continue;
    const pts = addPoints(seg.schedule_location);
    if (!pts) continue;
    stats.candidates++;
    const ri = recs.length;
    recs.push({
      uid: intern(uid), stp, hc: intern(hc), toc: intern(typeof s.atoc_code === 'string' ? s.atoc_code : ''),
      cat: intern(typeof seg.CIF_train_category === 'string' ? seg.CIF_train_category : ''),
      pwr: intern(typeof seg.CIF_power_type === 'string' ? seg.CIF_power_type : ''),
      load: intern(typeof seg.CIF_timing_load === 'string' ? seg.CIF_timing_load.trim() : ''),
      speed: intern(typeof seg.CIF_speed === 'string' ? seg.CIF_speed.trim() : ''),
      chunkNo: pts.chunkNo, off: pts.off, n: pts.n, keep: false
    });
    for (const d of dayIdx) { const m = bestByDay[d], b = m.get(uid); if (!b || rank >= b.rank) m.set(uid, { rank, ri }); }
  }

  // Winners only, compacted into one exactly-sized pool.
  let total = 0;
  for (const m of bestByDay) for (const b of m.values()) if (b.ri >= 0 && !recs[b.ri].keep) { recs[b.ri].keep = true; total += recs[b.ri].n; }
  const pool = new Int16Array(total * STRIDE);
  const remap = new Int32Array(recs.length).fill(-1);
  let w = 0;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (!r.keep) continue;
    pool.set(chunks[r.chunkNo].subarray(r.off, r.off + r.n * STRIDE), w * STRIDE);
    remap[i] = index.scheds.length;
    index.scheds.push({ uid: r.uid, stp: r.stp, hc: r.hc, toc: r.toc, cat: r.cat, pwr: r.pwr, load: r.load, speed: r.speed, off: w * STRIDE, n: r.n });
    w += r.n;
  }
  chunks.length = 0; cur = null; recs.length = 0;
  index.pool = pool;
  for (let d = 0; d < dayNums.length; d++) {
    const byHc = new Map();
    let count = 0;
    for (const b of bestByDay[d].values()) {
      if (b.ri < 0) continue;
      const ni = remap[b.ri];
      const hc = index.scheds[ni].hc;
      const l = byHc.get(hc);
      if (l) l.push(ni); else byHc.set(hc, [ni]);
      count++;
    }
    index.days.push({ date: dateOfDayNum(dayNums[d]), dayNum: dayNums[d], byHc, count });
  }
  index.builtAt = Date.now();
  index.stats = stats;
  return index;
}

/** The day numbers to index when building at `nowMs`: today, tomorrow, and yesterday before `untilHour`. */
function targetDays(nowMs, untilHour = 5) {
  const l = london(nowMs);
  const days = [l.dayNum, l.dayNum + 1];
  if (l.hour < untilHour) days.unshift(l.dayNum - 1);
  return days;
}

module.exports = { CifIndex, buildCifIndex, targetDays, STRIDE };
