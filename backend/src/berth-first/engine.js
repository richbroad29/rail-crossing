'use strict';

// The berth-first engine (docs/berth-first-design.md; docs/berth-first-v1-plan.md §2, step 4).
//
// Closures come only from trains the berths have seen (design §1, D1). Its parts:
//   tracker.js   follows every train berth by berth across the crossing's areas;
//   routes.js    the learned routes: which way a train is going, how far it is from the crossing;
//   link.js      which timetable or board entry a tracked train is;
//   timing.js    today's closure timing, copied (decision 2), told which trains to time.
// What it decides, every recompute, for each train the tracker has:
//   APPROACHING  on a route in, not moving away from the crossing: its timetable/board entry (or, with
//                none, a train made from what the berths know) goes to the timing;
//   STALLED      on a route in but past its berth's stall threshold BEFORE the berth that brings the barrier
//                down (design §5.6): not timed, listed as Delayed; it re-enters APPROACHING when it moves.
//                At or after that berth the barrier is already down, so it stays timed ("Train held"),
//                unless it has not moved for HELD_MAX_MS and 3x the threshold: then it is a left-over label
//                (a lost step left a copy behind: 3S93's stale copy in Portslade's 0005, 19 Nov) — STALE;
//   CROSSED      made the clear step in the last few minutes: kept, the barrier may still be down for it;
//   anything else (off the routes, backing out of the approach, a label that never stepped) is not timed.
// A timetable or board train the berths have NOT seen is a FORECAST and never makes a closure (D14). It is
// listed on its own (api.berthFirst.forecast) with the time the timing would give it — "around HH:MM" — and
// becomes NOT YET SEEN once it is past the latest moment the berths should have shown it (design §5.8; v1
// has no status check, so that is the safe default and its berths still bring it back, D5).
//
// Inputs are its own copies (engines.js). It must never reach back into the serving engine.

const { BerthTracker, isHeadcode } = require('./tracker');
const { compileRoutes } = require('./routes');
const { linkEntries } = require('./link');
const ClosureTiming = require('./timing');
const { trainTypeOf } = require('../train-type');

const CROSSED_KEEP_MS = 10 * 60e3;     // a train is kept this long after its clear step (barrier-up lags are < 1 min)
const STALL_DEFAULT_SECS = 300;        // a berth with too few trains for a measured stall threshold
const HELD_MAX_MS = 10 * 60e3;         // a train past its trigger berth longer than this (and 3x the threshold) is a left-over label
const DEADLINE_BUFFER_MS = 2 * 60e3;   // allowance past the latest a forecast train should have appeared
const BEST_TIME_FLOOR_MS = 30e3;       // as the classic timing: never a crossing time in the past

class BerthFirstEngine {
  constructor(id, config, routesFile) {
    this.id = id;
    this.config = config;
    this.engine = 'berth-first';
    this.routesFile = routesFile || { areas: [] };
    this.areas = new Set(this.routesFile.areas || []);
    this.routes = this.routesFile.directions ? compileRoutes(this.routesFile) : null;
    this.tracker = new BerthTracker({
      sameBerths: this.routes ? this.routes.sameBerths : [],
      preferArea: this.routes ? this.routes.preferArea : null,
      knownSteps: this.routes ? this.routes.steps : []
    });
    this.timing = new ClosureTiming(id, config);
    this.links = new Map();           // entry record → { id, expectedMs }
    this.forecast = [];               // the timing's trains the berths have not seen, as last selected
    this.view = [];                   // the tracked trains as last classified
    const engine = this;
    this.timing.bf = {
      entry: rec => engine.links.get(rec) || null,
      select: (merged, now) => engine._select(merged, now)
    };
    // Every recompute of the timing, however it was triggered (a poll, its own TD events, the hold tick),
    // first brings the links up to date with the tracker.
    const recompute = this.timing._recompute.bind(this.timing);
    this.timing._recompute = () => { engine._relink(new Date()); recompute(); };
  }

  get state() { return this.timing.state; }
  get ldbTrains() { return this.timing.ldbTrains; }
  get scheduleTrains() { return this.timing.scheduleTrains; }

  ownsTdArea(area) { return this.areas.has(area); }

  updateLdbTrains(trains) { this.timing.updateLdbTrains(trains || []); }
  updateScheduleTrains(trains) { this.timing.updateScheduleTrains(trains || []); }

  // Every berth event the listener emits (index.js / engines.js fan each out to every engine): the
  // tracker takes those of the routes' areas, the copied timing those of the crossing's own area.
  recordTdEvent(evt) {
    if (!evt) return false;
    let taken = false;
    if (this.ownsTdArea(evt.area)) { this.tracker.event(evt); taken = true; this.timing._markDirty(); }
    if (this.timing.recordTdEvent(evt)) taken = true;
    return taken;
  }

  // Restart rebuild is step 5; until then the copied timing seeds its sightings as today's does.
  seedSightings(entries) { return this.timing.seedSightings(entries); }

  _recompute() { this.timing._recompute(); }

  // ---- classification and linking ----
  _classify(now) {
    const t = now.getTime();
    const out = [];
    if (!this.routes) return out;
    this.tracker.tick(t);
    for (const e of this.tracker.trains()) {
      const on = this.routes.onRoute(e.key);
      const last = e.path.length > 1 ? e.path[e.path.length - 2][0] : null;
      let pick = null;
      for (const [d, n] of Object.entries(on)) {
        if (n < 0) continue;
        const heading = last ? this.routes.heading(d, last, e.key) : 0;
        const cand = { d, n, heading };
        // A train moving towards the crossing on d beats one that merely sits on a berth of d.
        if (!pick || (cand.heading > pick.heading) || (cand.heading === pick.heading && cand.n < pick.n)) pick = cand;
      }
      if (pick && pick.heading >= 0) {
        const inBerth = (t - e.enteredAt) / 1000;
        const thr = this.routes.stallSecs(pick.d, e.key) || STALL_DEFAULT_SECS;
        let state = 'approaching';
        if (inBerth > thr) {
          state = pick.n > this._triggerN(pick.d) ? 'stalled'
            : (inBerth * 1000 > HELD_MAX_MS && inBerth > 3 * thr ? 'stale' : 'approaching');
        }
        const secs = this.routes.secsToClear(pick.d, e.key, inBerth);
        out.push({ id: e.id, entry: e, headcode: e.headcode || null, headcodes: [...new Set(e.labels.filter(isHeadcode).reverse())], label: e.label, dir: pick.d, state,
          berth: e.key, toCrossing: pick.n, inBerthSecs: Math.round(inBerth), expectedMs: secs === null ? null : t + secs * 1000 });
        continue;
      }
      if (pick && pick.heading < 0) {
        out.push({ id: e.id, entry: e, headcode: e.headcode || null, label: e.label, dir: pick.d, state: 'reversing', berth: e.key, expectedMs: null });
        continue;
      }
      // Crossed in the last few minutes?
      for (const c of this.routes.clears) {
        for (let i = e.path.length - 1; i > 0; i--) {
          if (t - e.path[i][1] > CROSSED_KEEP_MS) break;
          if (e.path[i][0] === c.to && e.path[i - 1][0] === c.from) {
            out.push({ id: e.id, entry: e, headcode: e.headcode || null, headcodes: [...new Set(e.labels.filter(isHeadcode).reverse())], label: e.label, dir: c.dir, state: 'crossed', berth: e.key, expectedMs: e.path[i][1] });
            i = 0;
          }
        }
      }
    }
    return out;
  }

  // How many berths before the clear step the train strikes the berth that brings the barrier down:
  // the crossing's approach berth (td.<dir>.approach.from), as today's timing anchors it. 0 if unknown.
  _triggerN(d) {
    if (this._trig && d in this._trig) return this._trig[d];
    this._trig = this._trig || {};
    const td = this.config.td || {}, a = td[d] && td[d].approach && td[d].approach.from;
    const n = a ? this.routes.onRoute(`${td.area}:${a}`)[d] : undefined;
    this._trig[d] = typeof n === 'number' ? n : 0;
    return this._trig[d];
  }

  _relink(now) {
    this.view = this._classify(now);
    const timed = this.view.filter(v => v.state === 'approaching' || v.state === 'crossed');
    this.links = linkEntries(timed, this.timing.ldbTrains, this.timing.scheduleTrains);
    const linkedIds = new Set([...this.links.values()].map(l => l.id));
    for (const v of this.view) v.linked = linkedIds.has(v.id);
  }

  // The timing's merged list, cut to the trains the berths have (linked entries), plus a train made from
  // the berths for every approaching train the timing does not otherwise have: one no timetable or board
  // entry is (design §5.4: timed as the class that brings the barrier down earliest, the classic timing's
  // 'fast'), or one whose entry the timing dropped. A train on the approach is never left untimed.
  _select(merged, now) {
    const kept = merged.filter(m => m.bfId != null);
    this.forecast = merged.filter(m => m.bfId == null).map(m => this._forecastRow(m, now)).filter(Boolean);
    const have = new Set(kept.map(m => m.bfId));
    for (const v of this.view) {
      if (v.state !== 'approaching' || have.has(v.id)) continue;
      const floor = now.getTime() + BEST_TIME_FLOOR_MS;
      const best = new Date(Math.max(v.expectedMs || floor, floor));
      const hc = v.headcode || v.label;
      kept.push({
        origin: '', destination: '', operator: '', direction: v.dir, bestTime: best, scheduledTime: null,
        headcode: hc, uid: null, trainType: v.headcode ? trainTypeOf(v.headcode) : 'passenger',
        delayMins: 0, isUncertain: true, etaText: 'Live (berths)', source: 'berth', callsAtStation: null,
        callsAtApproach: null, confidence: 'medium', tdSeen: true, tdSeenAt: null,
        unidentified: !v.headcode, bfId: v.id, dedupKey: `berth|${v.id}`
      });
    }
    return kept;
  }

  // A forecast row: the timing's own estimate for a train not on the berths, and whether it is overdue.
  _forecastRow(m, now) {
    const cross = m.bestTime instanceof Date ? m.bestTime.getTime() : Date.parse(m.bestTime);
    if (!Number.isFinite(cross)) return null;
    let close = null;
    try { close = this.timing._computeCloseTime(m, now); } catch (e) { close = null; }
    const due = cross - this._appearLeadMs(m.direction) + DEADLINE_BUFFER_MS;
    return {
      headcode: m.headcode || null, uid: m.uid || null, direction: m.direction, source: m.source,
      expectedCrossing: new Date(cross).toISOString(), expectedClose: close ? new Date(close).toISOString() : null,
      state: now.getTime() > due ? 'notYetSeen' : 'forecast', origin: m.origin || null, destination: m.destination || null
    };
  }

  // How long before its crossing a train in direction d is on the berths at the latest: the shortest
  // route's p10 from first sighting (a starting platform's from departure), at least 3 min.
  _appearLeadMs(d) {
    this._lead = this._lead || {};
    if (d in this._lead) return this._lead[d];
    const x = (this.routesFile.directions || {})[d];
    let mins = Infinity;
    for (const r of (x && x.routes) || []) {
      const v = r.startingPlatform ? r.startingPlatform.minsFromDeparture && r.startingPlatform.minsFromDeparture.p10 : r.horizonMins && r.horizonMins.p10;
      if (typeof v === 'number' && v < mins) mins = v;
    }
    this._lead[d] = Math.max(3, Number.isFinite(mins) ? mins : 3) * 60e3;
    return this._lead[d];
  }

  getApiState(limit) {
    const api = this.timing.getApiState(limit);
    api.engine = 'berth-first';
    const now = Date.now();
    api.berthFirst = {
      forecast: this.forecast.filter(f => Date.parse(f.expectedCrossing) > now - 10 * 60e3),
      trains: this.view.filter(v => v.state !== 'crossed').map(v => ({
        id: v.id, label: v.label, headcode: v.headcode, direction: v.dir, state: v.state, berth: v.berth,
        expected: v.expectedMs ? new Date(v.expectedMs).toISOString() : null, linked: !!v.linked,
        unidentified: !!v.entry.unidentified
      }))
    };
    return api;
  }

  // Extra fields for the shadow log line (engines.js), beyond the closures every engine logs.
  shadowDetail() {
    const counts = {};
    for (const v of this.view) counts[v.state] = (counts[v.state] || 0) + 1;
    return { trains: counts, unlinkedApproaching: this.view.filter(v => v.state === 'approaching' && !v.linked).length, tracker: this.tracker.stats };
  }
}

module.exports = { BerthFirstEngine };
