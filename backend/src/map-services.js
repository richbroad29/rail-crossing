'use strict';

// Headcode → today's service (origin, destination, operator, times) for the live train map.
//
// TD gives a train's four-character description and nothing else. The CIF schedule the backend
// already parses every day knows what each headcode is running as; this keeps a small index of
// the schedules that touch the map region, collected during that same streaming pass (no second
// read of the 120 MB file). See parseScheduleFile's `hooks.onSchedule`.
//
// A headcode is not unique across the day, so a lookup only answers when exactly the right
// time window contains "now": from 20 min before the origin departure to 30 min after the
// destination arrival. Outside every window it answers nothing rather than a guess — a wrong
// destination on a train is worse than none.

const { cifTimeToMins, minsToTimeStr } = require('./schedule-parser');

const STP_RANK = { P: 0, O: 1, N: 2, C: 3 };
const BEFORE_MINS = 20;
const AFTER_MINS = 30;

const LONDON_HM = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', hourCycle: 'h23', hour: '2-digit', minute: '2-digit'
});

function londonMinsNow(ms) {
  const parts = Object.fromEntries(LONDON_HM.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

class MapServices {
  /**
   * @param {object} opts
   * @param {function} opts.inRegion     TIPLOC → bool
   * @param {function} opts.resolveName  TIPLOC → display name
   */
  constructor({ inRegion, resolveName }) {
    this.inRegion = inRegion;
    this.resolveName = resolveName || (t => t);
    this.byHeadcode = new Map();
    this._pending = null;
    this.builtAt = null;
  }

  begin() { this._pending = new Map(); }

  /** Called by the schedule parser for every schedule active today. */
  collect(fields, locations) {
    if (!this._pending || !fields || !fields.headcode || !fields.uid) return;
    if (!locations.some(l => this.inRegion(l.tiploc_code))) return;
    const first = locations[0];
    const last = locations[locations.length - 1];
    const dep = cifTimeToMins(first.departure || first.public_departure);
    let arr = cifTimeToMins(last.arrival || last.public_arrival);
    if (dep === null || arr === null) return;
    if (arr < dep - 1) arr += 1440;  // runs past midnight
    const entry = {
      uid: fields.uid, stp: fields.stp, headcode: fields.headcode, operator: fields.operator,
      trainType: fields.trainType, origin: first.tiploc_code, destination: last.tiploc_code, dep, arr
    };
    const prev = this._pending.get(fields.uid);
    if (!prev || (STP_RANK[entry.stp] || 0) >= (STP_RANK[prev.stp] || 0)) this._pending.set(fields.uid, entry);
  }

  /** Swap the collected index in. Returns how many services it holds. */
  commit() {
    if (!this._pending) return this.size();
    const next = new Map();
    for (const e of this._pending.values()) {
      if (e.stp === 'C') continue;  // cancelled for today
      if (!next.has(e.headcode)) next.set(e.headcode, []);
      next.get(e.headcode).push(e);
    }
    this.byHeadcode = next;
    this._pending = null;
    this.builtAt = new Date().toISOString();
    return this.size();
  }

  abort() { this._pending = null; }

  size() {
    let n = 0;
    for (const l of this.byHeadcode.values()) n += l.length;
    return n;
  }

  lookup(headcode, nowMs) {
    const list = this.byHeadcode.get(headcode);
    if (!list) return null;
    const m = londonMinsNow(nowMs);
    let best = null;
    // The index is rebuilt at 04:00, so before then it still holds YESTERDAY's day and a train
    // running after midnight sits at 1440+ minutes on it. Test both readings of the clock.
    for (const now of [m, m + 1440]) {
      for (const e of list) {
        if (now < e.dep - BEFORE_MINS || now > e.arr + AFTER_MINS) continue;
        // Several in-window candidates: the one that started most recently is the one running.
        if (!best || (e.dep <= now && (best.dep > now || e.dep > best.dep))) best = e;
      }
      if (best) break;
    }
    if (!best) return null;
    return {
      origin: this.resolveName(best.origin),
      destination: this.resolveName(best.destination),
      operator: best.operator || null,
      departs: minsToTimeStr(best.dep),
      arrives: minsToTimeStr(best.arr),
      uid: best.uid
    };
  }
}

module.exports = { MapServices, londonMinsNow };
