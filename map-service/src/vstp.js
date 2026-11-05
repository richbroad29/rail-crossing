'use strict';

// VSTP (very short term planning): schedules created or deleted the same day, from /topic/VSTP_ALL.
// A message is one JSON object, {"VSTPCIFMsgV1": {"Schedule": {...}}}. Create and Delete are merged
// over the CIF timetable with the SAME STP rules the CIF uses (C cancel > N new > O overlay > P
// permanent, per uid per day): the overlay's records have exactly the shape of the CIF index's own
// (`uid, stp, hc, toc, ... off, n`), but carry their own point pool, TIPLOC names and platform list,
// because the CIF index (and its interned ids) is rebuilt every night and VSTP is not.
//
// Code defensively: the shapes are documented on the Open Rail Data wiki, not guaranteed. Anything
// unexpected is COUNTED (by name, bounded) and skipped; nothing here throws.
//
// Bounded: at most `maxSchedules` records (oldest-ending evicted first), at most `maxPoints` points
// per record; expired records (ended before yesterday) are pruned; the lot persists to one small JSON.

const fs = require('fs');
const path = require('path');
const { dayNumOf, london } = require('./time');
const { STP_RANK, STRIDE, timeMins } = require('./cif-index');

const CANCELLED = 'cancelled';
const s = v => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const first = (...vs) => { for (const v of vs) if (v !== undefined && v !== null && v !== '') return v; return undefined; };
const dateNum = v => {
  const t = s(v);
  if (/^\d{8}$/.test(t)) return dayNumOf(`${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`);
  return dayNumOf(t.slice(0, 10));
};

/** Bounded counter map: at most `max` distinct names, the rest pooled under "(other)". */
class NameCounts {
  constructor(max = 60) { this.max = max; this.m = new Map(); }
  add(k) { k = String(k).slice(0, 60); if (!this.m.has(k) && this.m.size >= this.max) k = '(other)'; this.m.set(k, (this.m.get(k) || 0) + 1); }
  toJSON() { return Object.fromEntries(this.m); }
  get size() { return this.m.size; }
}

const KNOWN_SCHEDULE = new Set(['transaction_type', 'schedule_id', 'schedule_start_date', 'schedule_end_date', 'schedule_days_runs', 'applicable_timetable', 'CIF_bank_holiday_running',
  'CIF_train_uid', 'train_status', 'CIF_stp_indicator', 'schedule_segment', 'new_schedule_segment']);

/**
 * One VSTP message body (already JSON.parsed) -> {op:'create', spec} | {op:'delete', uid, start, end, stp} | null.
 * `counts` (optional) receives {unknownFields, bad} counters.
 */
function parseVstp(obj, { maxPoints = 400, counts = null } = {}) {
  const bad = why => { if (counts) counts.bad.add(why); return null; };
  const root = obj && typeof obj === 'object' ? first(obj.VSTPCIFMsgV1, obj) : null;
  const sc = root && typeof root === 'object' ? root.Schedule : null;
  if (!sc || typeof sc !== 'object') return bad('no Schedule');
  if (counts) for (const k of Object.keys(sc)) if (!KNOWN_SCHEDULE.has(k)) counts.unknownFields.add(k);
  const tx = s(sc.transaction_type).toLowerCase();
  const uid = s(first(sc.CIF_train_uid, sc.train_uid)).replace(/\s+/g, ' ');
  const stp = s(sc.CIF_stp_indicator).toUpperCase() || 'N';
  if (STP_RANK[stp] === undefined) return bad('bad stp');
  const start = dateNum(sc.schedule_start_date), end = dateNum(sc.schedule_end_date);
  if (tx === 'delete') {
    if (!uid) return bad('delete without uid');
    return { op: 'delete', uid, start: Number.isFinite(start) ? start : null, end: Number.isFinite(end) ? end : null, stp: sc.CIF_stp_indicator ? stp : null };
  }
  if (tx !== 'create' && tx !== 'update') return bad(`transaction ${tx || '(none)'}`);
  if (!uid) return bad('create without uid');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return bad('bad dates');
  const status = s(sc.train_status).toUpperCase();
  if (status === 'B' || status === 'S') return bad('bus or ship');
  const runs = /^[01]{7}$/.test(s(sc.schedule_days_runs)) ? s(sc.schedule_days_runs) : '1111111';
  if (stp === 'C') return { op: 'create', spec: { uid, stp, hc: '', toc: '', cat: '', pwr: '', load: '', speed: '', start, end, runs, pts: [] } };
  let seg = sc.schedule_segment;
  if (Array.isArray(seg)) seg = seg[0];
  if (!seg || typeof seg !== 'object') return bad('no segment');
  const hc = s(seg.signalling_id);
  if (!hc || hc.length > 8) return bad('bad headcode');
  let locs = seg.schedule_location;
  if (locs && !Array.isArray(locs) && typeof locs === 'object') locs = [locs];
  if (!Array.isArray(locs) || locs.length < 2) return bad('no locations');
  if (locs.length > maxPoints) return bad('too many points');
  const pts = [];
  let prev = -1, offset = 0;
  const unwrap = t => {
    if (t < 0) return -1;
    let v = t + offset;
    if (prev >= 0 && v < prev - 720) { offset += 1440; v = t + offset; }
    prev = v;
    return v;
  };
  for (const loc of locs) {
    if (!loc || typeof loc !== 'object') continue;
    const l = loc.location && typeof loc.location === 'object' ? loc.location : {};
    const tip = s(first(l.tiploc && l.tiploc.tiploc_id, l.tiploc_id, loc.tiploc_code, loc.tiploc));
    if (!tip || tip.length > 8) continue;
    const arr = timeMins(s(first(loc.scheduled_arrival_time, loc.public_arrival_time, loc.arrival)));
    const dep = timeMins(s(first(loc.scheduled_departure_time, loc.public_departure_time, loc.departure)));
    const pass = timeMins(s(first(loc.scheduled_pass_time, loc.pass)));
    if (arr < 0 && dep < 0 && pass < 0) continue;
    pts.push([tip, unwrap(arr), unwrap(dep), unwrap(pass), s(first(loc.CIF_platform, loc.platform)).slice(0, 4)]);
  }
  if (pts.length < 2) return bad('fewer than two timed points');
  return { op: 'create', spec: {
    uid, stp, hc, toc: s(seg.atoc_code), cat: s(seg.CIF_train_category), pwr: s(seg.CIF_power_type), load: s(seg.CIF_timing_load), speed: s(seg.CIF_speed),
    start, end, runs, pts
  } };
}

function makeRec(spec, addedAt) {
  const n = spec.pts.length;
  const pool = new Int16Array(n * STRIDE);
  const tip = [], plat = [''];
  for (let i = 0; i < n; i++) {
    const [t, arr, dep, pass, pl] = spec.pts[i];
    let ti = tip.indexOf(t); if (ti < 0) { ti = tip.length; tip.push(t); }
    let pi = 0; if (pl) { pi = plat.indexOf(pl); if (pi < 0) { pi = plat.length; plat.push(pl); } }
    const b = i * STRIDE;
    pool[b] = ti; pool[b + 1] = arr; pool[b + 2] = dep; pool[b + 3] = pass; pool[b + 4] = pi;
  }
  return { uid: spec.uid, stp: spec.stp, hc: spec.hc, toc: spec.toc, cat: spec.cat, pwr: spec.pwr, load: spec.load, speed: spec.speed, off: 0, n, pool, tip, plat, vstp: true, start: spec.start, end: spec.end, runs: spec.runs, addedAt, spec };
}

const dow = dn => (new Date(dn * 86400000).getUTCDay() + 6) % 7;

class VstpOverlay {
  constructor({ maxSchedules = 6000, maxPoints = 400, now = Date.now, onChange = null } = {}) {
    this.onChange = onChange;                 // () => void, after any change to the merged timetable
    this.maxSchedules = maxSchedules; this.maxPoints = maxPoints; this.now = now;
    this.recs = [];                     // insertion order
    this.version = 0;
    this._days = new Map();             // dayNum -> {ver, winners, byHc}
    this.counts = { creates: 0, deletes: 0, deletedRecords: 0, deleteMisses: 0, replaced: 0, evicted: 0, expired: 0, frames: 0, badBodies: 0, errors: 0,
      bad: new NameCounts(), unknownFields: new NameCounts(), unknownTypes: new NameCounts() };
    this.dirty = false;
    this.lastSaveError = null;
  }

  get size() { return this.recs.length; }

  // ---- messages --------------------------------------------------------------------------------------

  /** A raw frame body. Never throws. */
  onBody(body) {
    const c = this.counts;
    c.frames++;
    if (typeof body !== 'string' || body.length > 2 * 1024 * 1024) { c.badBodies++; return; }
    let obj;
    try { obj = JSON.parse(body); } catch (_) { c.badBodies++; return; }
    try {
      const items = Array.isArray(obj) ? obj : [obj];
      for (const it of items) this.apply(parseVstp(it, { maxPoints: this.maxPoints, counts: c }));
    } catch (_) { c.errors++; }
  }

  apply(p) {
    if (!p) return false;
    if (p.op === 'create') return this.add(p.spec);
    if (p.op === 'delete') return this.remove(p);
    return false;
  }

  add(spec) {
    if (this.recs.length >= this.maxSchedules) this._evict();
    // A re-sent Create for the same (uid, stp, start) replaces the earlier one.
    const i = this.recs.findIndex(r => r.uid === spec.uid && r.stp === spec.stp && r.start === spec.start);
    const rec = makeRec(spec, this.now());
    if (i >= 0) { this.recs[i] = rec; this.counts.replaced++; } else this.recs.push(rec);
    this.counts.creates++;
    this._changed();
    return true;
  }

  remove({ uid, start = null, end = null, stp = null }) {
    this.counts.deletes++;
    const keep = [];
    let n = 0;
    for (const r of this.recs) {
      const hit = r.uid === uid && (stp === null || r.stp === stp) && (start === null || r.start === start) && (end === null || r.end === end);
      if (hit) n++; else keep.push(r);
    }
    if (!n) { this.counts.deleteMisses++; return false; }
    this.recs = keep; this.counts.deletedRecords += n;
    this._changed();
    return true;
  }

  _evict() {
    // The record that ends soonest goes first (it is the least likely to matter), ties oldest first.
    let w = 0;
    for (let i = 1; i < this.recs.length; i++) if (this.recs[i].end < this.recs[w].end) w = i;
    this.recs.splice(w, 1); this.counts.evicted++;
  }

  /** Drop records that ended before yesterday. */
  prune(nowMs = this.now()) {
    const today = london(nowMs).dayNum;
    const before = this.recs.length;
    this.recs = this.recs.filter(r => r.end >= today - 1);
    const n = before - this.recs.length;
    if (n) { this.counts.expired += n; this._changed(); }
    return n;
  }

  _changed() {
    this.version++; this.dirty = true;
    if (this._days.size > 8) this._days.clear();
    if (this.onChange) { try { this.onChange(); } catch (_) { this.counts.errors++; } }
  }

  // ---- the merge --------------------------------------------------------------------------------------

  runsOn(r, dayNum) { return dayNum >= r.start && dayNum <= r.end && r.runs[dow(dayNum)] === '1'; }

  _day(dayNum) {
    let d = this._days.get(dayNum);
    if (d && d.ver === this.version) return d;
    const winners = new Map();                 // uid -> rec | CANCELLED
    for (const r of this.recs) {
      if (!this.runsOn(r, dayNum)) continue;
      const cur = winners.get(r.uid);
      const curRank = cur === undefined ? -1 : cur === CANCELLED ? 3 : STP_RANK[cur.stp];
      // Higher STP wins; on a tie the later arrival (this loop is in arrival order).
      if (STP_RANK[r.stp] >= curRank) winners.set(r.uid, r.stp === 'C' ? CANCELLED : r);
    }
    const byHc = new Map();
    for (const r of winners.values()) {
      if (r === CANCELLED) continue;
      const l = byHc.get(r.hc); if (l) l.push(r); else byHc.set(r.hc, [r]);
    }
    d = { ver: this.version, winners, byHc };
    this._days.set(dayNum, d);
    return d;
  }

  /** The VSTP winner for (day, uid): a record, 'cancelled', or null. */
  winner(dayNum, uid) { const w = this._day(dayNum).winners.get(uid); return w === undefined ? null : w; }

  /** Does VSTP suppress a CIF record (uid, stp) on this day? Returns the winner if so, else null. */
  beats(dayNum, uid, cifStp) {
    const w = this.winner(dayNum, uid);
    if (w === null) return null;
    const rank = w === CANCELLED ? 3 : STP_RANK[w.stp];
    return rank >= STP_RANK[cifStp] ? w : null;
  }

  byHc(dayNum, hc) { return this._day(dayNum).byHc.get(hc) || []; }
  *eachDay(dayNum) { for (const r of this._day(dayNum).byHc.values()) yield* r; }

  // ---- persistence ---------------------------------------------------------------------------------------

  serialize() { return { version: 1, savedAt: new Date(this.now()).toISOString(), schedules: this.recs.map(r => r.spec) }; }

  load(doc) {
    if (!doc || doc.version !== 1 || !Array.isArray(doc.schedules)) return 0;
    let n = 0;
    for (const sp of doc.schedules) {
      if (!sp || typeof sp.uid !== 'string' || !Array.isArray(sp.pts) || sp.pts.length < 2 || sp.pts.length > this.maxPoints) continue;
      if (!(STP_RANK[sp.stp] !== undefined) || !Number.isFinite(sp.start) || !Number.isFinite(sp.end)) continue;
      if (!sp.pts.every(p => Array.isArray(p) && typeof p[0] === 'string')) continue;
      if (this.recs.length >= this.maxSchedules) break;
      this.recs.push(makeRec({ ...sp, runs: /^[01]{7}$/.test(sp.runs) ? sp.runs : '1111111' }, this.now()));
      n++;
    }
    this._changed(); this.dirty = false;
    return n;
  }

  loadFile(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? 0 : -1; }
    try { const n = this.load(JSON.parse(text)); this.prune(); return n; } catch (_) { return -1; }
  }

  /** Atomic save when changed. Never throws. */
  saveFile(file) {
    if (!this.dirty) return false;
    const tmp = file + '.tmp';
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.serialize()));
      fs.renameSync(tmp, file);
      this.dirty = false;
      return true;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) { /* none */ }
      this.lastSaveError = e;
      return false;
    }
  }

  status() {
    const c = this.counts;
    return { schedules: this.recs.length, creates: c.creates, deletes: c.deletes, deletedRecords: c.deletedRecords, evicted: c.evicted, expired: c.expired,
      bad: c.bad.toJSON(), unknownFields: c.unknownFields.toJSON(), badBodies: c.badBodies, errors: c.errors };
  }
}

module.exports = { VstpOverlay, parseVstp, makeRec, NameCounts, CANCELLED };
