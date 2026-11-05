'use strict';

// TRUST train movements (/topic/TRAIN_MVT_ALL_TOC), contract section 14.
//
// A frame body is a JSON array of {header:{msg_type}, body:{...}}. The types that matter:
//   0001 activation   train_id, train_uid, schedule dates, origin STANOX   -> links a TRUST train to its EXACT schedule
//   0002 cancellation train_id, canx_type, loc_stanox                      -> calls from there on are cancelled
//   0003 movement     arrival / departure / pass at a STANOX               -> actual time, variation, platform
//   0005 reinstatement                                                      -> the cancellation is lifted
//   0006 change of origin                                                   -> calls before the new origin are cancelled
//   0007 change of identity  train_id -> revised_train_id                   -> the same train under a new headcode
//   0008 change of location  counted only (not applied)
// Anything else, and any field we do not know, is COUNTED by name (bounded) and ignored. Nothing
// here throws: a malformed message costs one counter.
//
// MATCHING a TD headcode to an activation is the hard part (see match()):
//   * headcodes are NOT unique nationally: the activation's train_id[2..6) is only a candidate key;
//   * the TD area must COVER the activation: via SMART, the area <-> STANOX table. Evidence, strongest
//     first: the origin STANOX or a STANOX that has already reported lies in the area (tier 0); else
//     the booked route has a timing point whose STANOX is in the area (tier 1);
//   * the booked time at that point must be near now (matchWindowMins);
//   * two DIFFERENT activations equally good -> no match (a wrong destination is worse than none);
//   * the activation usually arrives BEFORE the train appears in TD (it stays indexed until the end
//     of its day), and sometimes after: the caller re-matches that headcode when one arrives;
//   * a renumbered train: a 0007 moves the activation to its new headcode and the caller re-matches
//     both; the TD renumbering itself re-runs the match under the new headcode;
//   * after a restart every activation sent earlier today is lost (the subscription is not durable),
//     so a movement for an unknown train_id is resolved against the timetable (headcode + STANOX +
//     planned time) into an "inferred" activation, rate-limited and negatively cached.
//
// MEMORY. An activation is a small object; its movements are packed into one Int32Array (5 words
// per event, growing by doubling). Activations expire at the end of their day (plus a few hours
// for trains running past midnight), finished ones after `finishedKeepSecs`, and there is a hard cap.

const { london } = require('./time');
const { NameCounts } = require('./vstp');

const TRAIN_ID = /^[0-9A-Z]{10}$/;
const W = 5;                  // words per event: stanox, plannedSec, actualSec, flags, variation
const F_DEP = 1, F_OFFROUTE = 2, F_TERM = 4;     // flags; bits 3-4: status; bits 8+: platform id
const ST_ONTIME = 0, ST_LATE = 1, ST_EARLY = 2, ST_OFF = 3;

const KNOWN = {
  '0001': ['schedule_source', 'train_file_address', 'schedule_end_date', 'train_id', 'tp_origin_timestamp', 'tp_origin_stanox', 'origin_dep_timestamp', 'train_service_code', 'toc_id', 'd1266_record_number',
    'train_call_type', 'train_uid', 'train_call_mode', 'schedule_type', 'sched_origin_stanox', 'schedule_wtt_id', 'schedule_start_date', 'train_category'],
  '0002': ['train_file_address', 'train_service_code', 'orig_loc_stanox', 'toc_id', 'dep_timestamp', 'division_code', 'loc_stanox', 'canx_timestamp', 'canx_reason_code', 'train_id', 'orig_loc_timestamp', 'canx_type'],
  '0003': ['event_type', 'gbtt_timestamp', 'original_loc_stanox', 'planned_timestamp', 'timetable_variation', 'original_loc_timestamp', 'current_train_id', 'delay_monitoring_point', 'next_report_run_time',
    'reporting_stanox', 'actual_timestamp', 'correction_ind', 'event_source', 'train_file_address', 'platform', 'division_code', 'train_terminated', 'train_id', 'offroute_ind', 'variation_status',
    'train_service_code', 'toc_id', 'loc_stanox', 'auto_expected', 'direction_ind', 'route', 'planned_event_type', 'next_report_stanox', 'line_ind'],
  '0005': ['train_file_address', 'train_service_code', 'orig_loc_stanox', 'toc_id', 'dep_timestamp', 'division_code', 'loc_stanox', 'train_id', 'current_train_id', 'original_loc_timestamp', 'original_loc_stanox'],
  '0006': ['train_file_address', 'train_service_code', 'orig_loc_stanox', 'toc_id', 'dep_timestamp', 'division_code', 'loc_stanox', 'train_id', 'reason_code', 'original_loc_timestamp', 'coo_timestamp', 'original_loc_stanox', 'current_train_id'],
  '0007': ['train_file_address', 'train_service_code', 'revised_train_id', 'train_id', 'event_timestamp', 'toc_id'],
  '0008': ['train_file_address', 'train_service_code', 'toc_id', 'dep_timestamp', 'division_code', 'loc_stanox', 'train_id', 'original_loc_timestamp', 'reporting_stanox', 'event_type', 'original_loc_stanox', 'current_train_id']
};
for (const k of Object.keys(KNOWN)) KNOWN[k] = new Set(KNOWN[k]);

const str = v => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const int = v => { const n = parseInt(str(v), 10); return Number.isFinite(n) ? n : NaN; };
const ms = v => { const n = Number(str(v)); return Number.isFinite(n) && n > 1e11 ? n : NaN; };
const stanoxOf = v => { const t = str(v); return /^\d{1,5}$/.test(t) ? parseInt(t, 10) : 0; };

/** The act's day number from an activation body (origin day, else origin departure, else the DD in the train_id). */
function runDayOf(b, trainId, nowMs) {
  const t = str(b.tp_origin_timestamp);
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) { const n = Math.round(Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 1, +t.slice(8, 10)) / 86400000); if (Number.isFinite(n)) return n; }
  const dep = ms(b.origin_dep_timestamp);
  if (Number.isFinite(dep)) return london(dep).dayNum;
  const dd = int(trainId.slice(8, 10));
  const today = london(nowMs).dayNum;
  if (dd >= 1 && dd <= 31) for (const off of [0, -1, 1, -2, 2]) { if (new Date((today + off) * 86400000).getUTCDate() === dd) return today + off; }
  return today;
}

class TrustState {
  /**
   * @param {object} o
   * @param {object} o.config      config.trust
   * @param {function} [o.now]
   * @param {function():object} o.context   () => { cif, stanoxOf(tiploc)->int, areaStanox: Map<area,Set<int>>, tiplocsOfStanox(int)->[tiploc] } (any may be missing)
   * @param {function(act, kind)} [o.onChange]   kind: 'activation' | 'movement' | 'cancel' | 'identity'
   */
  constructor({ config, now = Date.now, context = () => ({}), onChange = null }) {
    this.cfg = config; this.now = now; this.context = context; this.onChange = onChange;
    this.acts = new Map();             // train_id -> act (also every superseded id of a renumbered train)
    this.byHc = new Map();             // headcode -> Set<act>
    this.byUidDay = new Map();         // "uid|day" -> act
    this.orphans = new Map();          // train_id -> {at, evs: []}  movements that arrived before their activation
    this.negative = new Map();         // train_id -> expiry of a failed inference
    this._plats = ['']; this._platIdx = new Map([['', 0]]);
    this._inferBudget = { sec: 0, n: 0 };
    this.counts = {
      frames: 0, items: 0, badBodies: 0, badItems: 0, errors: 0,
      types: new NameCounts(30), unknownTypes: new NameCounts(30), unknownFields: new NameCounts(config.maxUnknownKeys || 60), bad: new NameCounts(30),
      activations: 0, reactivations: 0, movements: 0, movementsApplied: 0, movementsOrphaned: 0, movementsStale: 0, cancels: 0, cancelsUnknown: 0,
      reinstatements: 0, changeOfOrigin: 0, identityChanges: 0, inferred: 0, inferFailed: 0, orphansReplayed: 0, evicted: 0, expired: 0, unresolved: 0
    };
  }

  get size() { return this.acts.size; }

  // ---- frames -------------------------------------------------------------------------------------------

  /** One STOMP frame body. Never throws. */
  onBody(body, receivedAt = this.now()) {
    const c = this.counts;
    c.frames++;
    if (typeof body !== 'string' || body.length > (this.cfg.maxBodyBytes || 4194304)) { c.badBodies++; return; }
    let arr;
    try { arr = JSON.parse(body); } catch (_) { c.badBodies++; return; }
    if (!Array.isArray(arr)) { c.badBodies++; return; }
    for (const item of arr) {
      try { this.onItem(item, receivedAt); } catch (_) { c.errors++; }
    }
  }

  onItem(item, nowMs) {
    const c = this.counts;
    if (!item || typeof item !== 'object' || !item.header || typeof item.header !== 'object' || !item.body || typeof item.body !== 'object') { c.badItems++; return; }
    c.items++;
    const type = str(item.header.msg_type);
    c.types.add(type || '(none)');
    const b = item.body;
    const known = KNOWN[type];
    if (!known) { c.unknownTypes.add(type || '(none)'); return; }
    for (const k of Object.keys(b)) if (!known.has(k)) c.unknownFields.add(`${type}.${k}`);
    switch (type) {
      case '0001': this.activate(b, nowMs); break;
      case '0002': this.cancel(b, nowMs); break;
      case '0003': this.movement(b, nowMs); break;
      case '0005': this.reinstate(b); break;
      case '0006': this.changeOrigin(b); break;
      case '0007': this.changeIdentity(b); break;
      default: break;                                  // 0008: counted above, not applied
    }
  }

  _notify(act, kind) { if (this.onChange) { try { this.onChange(act, kind); } catch (_) { this.counts.errors++; } } }

  // ---- activation ----------------------------------------------------------------------------------------------

  _expiry(runDay) { return (runDay + 1) * 86400000 + (this.cfg.expireHourNextDay || 4) * 3600000; }

  _plat(p) {
    p = str(p).slice(0, 4);
    let i = this._platIdx.get(p);
    if (i === undefined) { if (this._plats.length >= 250) return 0; i = this._plats.length; this._plats.push(p); this._platIdx.set(p, i); }
    return i;
  }

  activate(b, nowMs) {
    const c = this.counts;
    const id = str(b.train_id);
    if (!TRAIN_ID.test(id)) { c.bad.add('activation: bad train_id'); return null; }
    const uid = str(b.train_uid).replace(/\s+/g, ' ');
    if (!uid) { c.bad.add('activation: no train_uid'); return null; }
    const runDay = runDayOf(b, id, nowMs);
    const depMs = ms(b.origin_dep_timestamp);
    let act = this.acts.get(id);
    if (act) {
      c.reactivations++;
      this._unindex(act);
    } else {
      if (this.acts.size >= (this.cfg.maxActivations || 60000)) this._evictOne();
      act = { id, hc: id.slice(2, 6), uid: '', runDay, originStanox: 0, originDepSec: -1, expireAt: 0, rec: null, recSrc: null, recVer: -1, ev: null, evN: 0,
        lateMins: null, last: null, cancel: null, coo: 0, terminated: false, finishedAt: 0, inferred: false, aliases: null, activatedAt: nowMs, toc: str(b.toc_id), schedType: '' };
      this.acts.set(id, act);
      c.activations++;
    }
    act.uid = uid; act.runDay = runDay; act.inferred = false;
    act.originStanox = stanoxOf(b.tp_origin_stanox) || stanoxOf(b.sched_origin_stanox);
    act.originDepSec = Number.isFinite(depMs) ? this._sec(depMs, runDay) : -1;
    act.expireAt = this._expiry(runDay);
    act.schedType = str(b.schedule_type);
    act.rec = null; act.recVer = -1;
    this._index(act);
    // Movements that raced ahead of this activation.
    const o = this.orphans.get(id);
    if (o) { this.orphans.delete(id); for (const e of o.evs) this._apply(act, e); c.orphansReplayed += o.evs.length; }
    this._notify(act, 'activation');
    return act;
  }

  _index(act) {
    let s = this.byHc.get(act.hc); if (!s) { s = new Set(); this.byHc.set(act.hc, s); } s.add(act);
    this.byUidDay.set(`${act.uid}|${act.runDay}`, act);
  }

  _unindex(act) {
    const s = this.byHc.get(act.hc);
    if (s) { s.delete(act); if (!s.size) this.byHc.delete(act.hc); }
    const k = `${act.uid}|${act.runDay}`;
    if (this.byUidDay.get(k) === act) this.byUidDay.delete(k);
  }

  _drop(act) {
    this._unindex(act);
    for (const k of [act.id, ...(act.aliases || [])]) if (this.acts.get(k) === act) this.acts.delete(k);
  }

  _evictOne() {
    let w = null;
    for (const [k, a] of this.acts) if (k === a.id && (!w || a.expireAt < w.expireAt)) w = a;
    if (w) { this._drop(w); this.counts.evicted++; }
  }

  /** Expire finished and out-of-day activations, old orphans and negative-cache entries. */
  prune(nowMs = this.now()) {
    let n = 0;
    for (const [k, a] of [...this.acts]) {
      if (k !== a.id) continue;                        // an alias of a renumbered train: visited under its current id
      const finished = a.finishedAt && nowMs - a.finishedAt > (this.cfg.finishedKeepSecs || 3600) * 1000;
      if (nowMs > a.expireAt || finished) { this._drop(a); n++; }
    }
    this.counts.expired += n;
    const keep = (this.cfg.orphanKeepSecs || 900) * 1000;
    for (const [k, o] of this.orphans) if (nowMs - o.at > keep) this.orphans.delete(k);
    for (const [k, t] of this.negative) if (nowMs > t) this.negative.delete(k);
    return n;
  }

  // ---- movements --------------------------------------------------------------------------------------------------

  _sec(epochMs, runDay) {
    const l = london(epochMs);
    return Math.round((l.dayNum - runDay) * 86400 + l.minutes * 60);
  }

  _decodeMovement(b, nowMs) {
    const stanox = stanoxOf(b.loc_stanox);
    const actual = ms(b.actual_timestamp);
    if (!stanox || !Number.isFinite(actual)) return null;
    if (Math.abs(actual - nowMs) > 36 * 3600000) { this.counts.movementsStale++; return null; }
    const st = str(b.variation_status).toUpperCase();
    const status = st === 'LATE' ? ST_LATE : st === 'EARLY' ? ST_EARLY : st === 'OFF ROUTE' ? ST_OFF : ST_ONTIME;
    const v = int(b.timetable_variation);
    return {
      stanox, dep: str(b.event_type).toUpperCase() === 'DEPARTURE', actual, planned: ms(b.planned_timestamp), status,
      variation: Number.isFinite(v) ? v : 0, platform: str(b.platform), terminated: str(b.train_terminated).toLowerCase() === 'true',
      offroute: str(b.offroute_ind).toLowerCase() === 'true'
    };
  }

  movement(b, nowMs) {
    const c = this.counts;
    c.movements++;
    const id = str(b.train_id), cur = str(b.current_train_id);
    const ev = this._decodeMovement(b, nowMs);
    if (!ev) return;
    let act = this.acts.get(id) || (cur && this.acts.get(cur)) || null;
    if (!act && TRAIN_ID.test(id)) act = this._infer(id, ev, nowMs);
    if (!act) {
      if (!TRAIN_ID.test(id)) { c.bad.add('movement: bad train_id'); return; }
      this._orphan(id, ev, nowMs);
      return;
    }
    this._apply(act, ev);
    this._notify(act, 'movement');
  }

  _orphan(id, ev, nowMs) {
    const c = this.counts;
    let o = this.orphans.get(id);
    if (!o) {
      if (this.orphans.size >= (this.cfg.maxOrphanTrains || 5000)) this.orphans.delete(this.orphans.keys().next().value);
      o = { at: nowMs, evs: [] }; this.orphans.set(id, o);
    }
    if (o.evs.length < 40) o.evs.push(ev);
    c.movementsOrphaned++;
  }

  _apply(act, e) {
    const run = act.runDay;
    const actualSec = this._sec(e.actual, run);
    const plannedSec = Number.isFinite(e.planned) ? this._sec(e.planned, run) : -1;
    const flags = (e.dep ? F_DEP : 0) | (e.offroute ? F_OFFROUTE : 0) | (e.terminated ? F_TERM : 0) | (e.status << 3) | (this._plat(e.platform) << 8);
    // A re-sent (corrected) report replaces the earlier one for the same stanox / kind / planned time.
    let slot = -1;
    for (let i = 0; i < act.evN; i++) {
      const b = i * W;
      if (act.ev[b] === e.stanox && (act.ev[b + 3] & F_DEP) === (e.dep ? F_DEP : 0) && act.ev[b + 1] === plannedSec) { slot = i; break; }
    }
    if (slot < 0) {
      if (act.evN >= 400) return;                      // a pathological train: bounded
      if (!act.ev) act.ev = new Int32Array(8 * W);
      else if ((act.evN + 1) * W > act.ev.length) {
        const n = new Int32Array(act.ev.length * 2); n.set(act.ev); act.ev = n;
      }
      slot = act.evN++;
    }
    const b = slot * W;
    act.ev[b] = e.stanox; act.ev[b + 1] = plannedSec; act.ev[b + 2] = actualSec; act.ev[b + 3] = flags; act.ev[b + 4] = e.variation;
    this.counts.movementsApplied++;
    if (!act.last || actualSec >= act.last.actualSec) {
      act.last = { stanox: e.stanox, dep: e.dep, actualSec, actual: e.actual, offroute: e.offroute };
      if (e.status === ST_LATE) act.lateMins = e.variation;
      else if (e.status === ST_EARLY) act.lateMins = -e.variation;
      else if (e.status === ST_ONTIME) act.lateMins = 0;
    }
    if (e.terminated) { act.terminated = true; act.finishedAt = e.actual; }
  }

  /** The events of an act as plain objects (for derivation and tests). */
  events(act) {
    const out = [];
    for (let i = 0; i < act.evN; i++) {
      const b = i * W, f = act.ev[b + 3];
      out.push({ stanox: act.ev[b], plannedSec: act.ev[b + 1], actualSec: act.ev[b + 2], dep: !!(f & F_DEP), offroute: !!(f & F_OFFROUTE), terminated: !!(f & F_TERM), status: (f >> 3) & 3, platform: this._plats[f >> 8] || '', variation: act.ev[b + 4] });
    }
    return out;
  }

  // ---- the other message types ------------------------------------------------------------------------------------

  cancel(b, nowMs) {
    const c = this.counts;
    const act = this.acts.get(str(b.train_id));
    if (!act) { c.cancelsUnknown++; return; }
    c.cancels++;
    act.cancel = { type: str(b.canx_type).toUpperCase(), stanox: stanoxOf(b.loc_stanox), at: nowMs };
    if (act.cancel.type === 'AT ORIGIN') { act.finishedAt = act.finishedAt || nowMs; }
    this._notify(act, 'cancel');
  }

  reinstate(b) {
    const act = this.acts.get(str(b.train_id)) || this.acts.get(str(b.current_train_id));
    if (!act) return;
    this.counts.reinstatements++;
    act.cancel = null; act.finishedAt = act.terminated ? act.finishedAt : 0;
    this._notify(act, 'cancel');
  }

  changeOrigin(b) {
    const act = this.acts.get(str(b.train_id));
    if (!act) return;
    this.counts.changeOfOrigin++;
    act.coo = stanoxOf(b.loc_stanox);
    this._notify(act, 'cancel');
  }

  changeIdentity(b) {
    const old = str(b.train_id), neu = str(b.revised_train_id);
    const act = this.acts.get(old);
    if (!act || !TRAIN_ID.test(neu) || neu === old) { if (!act) this.counts.bad.add('identity: unknown train'); return; }
    this.counts.identityChanges++;
    const oldHc = act.hc;
    this._unindex(act);
    act.aliases = act.aliases || []; if (act.aliases.length < 5) act.aliases.push(old);
    act.id = neu; act.hc = neu.slice(2, 6);
    this.acts.set(neu, act);                           // the old id stays a key: late movements still arrive under it
    act.previousHc = oldHc;
    this._index(act);
    this._notify(act, 'identity');
  }

  // ---- inference after a restart -----------------------------------------------------------------------------------

  _infer(id, ev, nowMs) {
    const c = this.counts, cfg = this.cfg;
    const neg = this.negative.get(id);
    if (neg && nowMs < neg) return null;
    const sec = Math.floor(nowMs / 1000);
    if (this._inferBudget.sec !== sec) this._inferBudget = { sec, n: 0 };
    if (this._inferBudget.n >= (cfg.inferPerSecond || 20)) return null;
    this._inferBudget.n++;
    const ctx = this.context();
    const rec = ctx.cif && ctx.stanoxOf ? this._findRec(ctx, id.slice(2, 6), ev) : null;
    if (!rec) {
      c.inferFailed++;
      if (this.negative.size < 20000) this.negative.set(id, nowMs + (cfg.inferNegativeSecs || 600) * 1000);
      return null;
    }
    const act = { id, hc: id.slice(2, 6), uid: rec.rec.uid, runDay: rec.dayNum, originStanox: 0, originDepSec: -1, expireAt: this._expiry(rec.dayNum), rec: null, recSrc: null, recVer: -1,
      ev: null, evN: 0, lateMins: null, last: null, cancel: null, coo: 0, terminated: false, finishedAt: 0, inferred: true, aliases: null, activatedAt: nowMs, toc: '', schedType: '' };
    if (this.acts.size >= (cfg.maxActivations || 60000)) this._evictOne();
    this.acts.set(id, act);
    this._index(act);
    c.inferred++;
    this._notify(act, 'activation');
    return act;
  }

  /** The unique schedule with this headcode that has a timing point at ev.stanox booked near ev.planned (or the actual time). */
  _findRec(ctx, hc, ev) {
    const refMs = Number.isFinite(ev.planned) ? ev.planned : ev.actual;
    const l = london(refMs);
    let best = null, second = null;
    for (const dayNum of [l.dayNum, l.dayNum - 1]) {
      const day = ctx.cif.dayOf(dayNum);
      if (!day) continue;
      const rel = (l.dayNum - dayNum) * 1440 + l.minutes;
      for (const rec of ctx.cif.recsFor(day, hc)) {
        let d = Infinity;
        for (let i = 0; i < rec.n; i++) {
          const p = ctx.cif.point(rec, i);
          if (ctx.stanoxOf(p.tiploc) !== ev.stanox) continue;
          const t = ev.dep ? (p.dep >= 0 ? p.dep : p.pass >= 0 ? p.pass : p.arr) : (p.arr >= 0 ? p.arr : p.pass >= 0 ? p.pass : p.dep);
          if (t < 0) continue;
          d = Math.min(d, Math.abs(t - rel));
        }
        if (d > 15) continue;
        const cand = { rec, dayNum, d };
        if (!best || d < best.d) { second = best; best = cand; } else if (!second || d < second.d) second = cand;
      }
    }
    if (!best) return null;
    if (second && second.rec.uid !== best.rec.uid && Math.abs(second.d - best.d) < 3) return null;
    return best;
  }

  // ---- resolving and matching -----------------------------------------------------------------------------------------

  /** The schedule record for an activation (cached; re-resolved when the CIF index or the VSTP overlay changed). */
  resolve(act, ctx = this.context()) {
    const cif = ctx.cif;
    if (!cif) return null;
    const ver = cif.overlay ? cif.overlay.version : 0;
    if (act.rec && act.recSrc === cif && act.recVer === ver) return act.rec;
    act.rec = cif.find(act.uid, act.runDay) || null;
    act.recSrc = cif; act.recVer = ver;
    if (!act.rec) this.counts.unresolved++;
    return act.rec;
  }

  actFor(uid, dayNum) { return this.byUidDay.get(`${uid}|${dayNum}`) || null; }

  /**
   * @returns {{act, rec, dist, tier, dayNum}|null}
   */
  match(hc, area, nowMs, ctx = this.context()) {
    const set = this.byHc.get(hc);
    if (!set || !set.size || !ctx.cif) return null;
    const areaSet = ctx.areaStanox && ctx.areaStanox.get(area);
    if (!areaSet || !areaSet.size) return null;
    const window = this.cfg.matchWindowMins || 90;
    const l = london(nowMs);
    let best = null, second = null;
    for (const act of set) {
      if (nowMs > act.expireAt) continue;
      if (act.cancel && act.cancel.type === 'AT ORIGIN') continue;
      const rec = this.resolve(act, ctx);
      if (!rec) continue;
      const rel = (l.dayNum - act.runDay) * 1440 + l.minutes;
      let dist = Infinity, evidence = false;
      // route: the nearest booked point inside the area
      for (let i = 0; i < rec.n; i++) {
        if (!areaSet.has(ctx.stanoxOf(ctx.cif.tiplocAt(rec, i)))) continue;       // cheap test first: most points are elsewhere
        const p = ctx.cif.point(rec, i);
        const t = p.dep >= 0 ? p.dep : p.pass >= 0 ? p.pass : p.arr;
        if (t >= 0) dist = Math.min(dist, Math.abs(t - rel));
      }
      // evidence: the origin, or a STANOX that has reported, is in the area
      if (areaSet.has(act.originStanox) && act.originDepSec >= 0) { evidence = true; dist = Math.min(dist, Math.abs(act.originDepSec / 60 - rel)); }
      else if (areaSet.has(act.originStanox)) evidence = true;
      for (let i = 0; i < act.evN; i++) {
        const b = i * W;
        if (areaSet.has(act.ev[b])) { evidence = true; dist = Math.min(dist, Math.abs(act.ev[b + 2] / 60 - rel)); }
      }
      if (!(dist <= window)) continue;
      const cand = { act, rec, dist, tier: evidence ? 0 : 1, dayNum: act.runDay };
      const better = (a, b) => (a.tier !== b.tier ? a.tier < b.tier : a.dist < b.dist);
      if (!best || better(cand, best)) { second = best; best = cand; }
      else if (!second || better(cand, second)) second = cand;
    }
    if (!best) return null;
    if (second && second.act !== best.act && second.rec.uid !== best.rec.uid && second.tier === best.tier && Math.abs(second.dist - best.dist) < (this.cfg.ambiguityMins || 2)) return null;
    return best;
  }

  status() {
    const c = this.counts;
    return {
      activations: this.acts.size, orphanTrains: this.orphans.size,
      frames: c.frames, items: c.items, activated: c.activations, movements: c.movements, movementsApplied: c.movementsApplied, orphaned: c.movementsOrphaned,
      inferred: c.inferred, inferFailed: c.inferFailed, cancels: c.cancels, identityChanges: c.identityChanges, unresolved: c.unresolved,
      types: c.types.toJSON(), unknownTypes: c.unknownTypes.toJSON(), unknownFields: c.unknownFields.toJSON(), bad: c.bad.toJSON(), badBodies: c.badBodies, badItems: c.badItems, errors: c.errors
    };
  }
}

module.exports = { TrustState, W, F_DEP, TRAIN_ID, runDayOf };
