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
//   POSSIBLE     on a route but outside its last junction, with no timetable or board entry saying it will
//                cross (design §5.1, D13): not timed; it becomes APPROACHING once inside the junction;
//   CROSSED      made the clear step in the last few minutes: kept, the barrier may still be down for it;
//   UNCONFIRMED  last placed before a gap in the feed (an outage, or a restart whose downtime was as long): it
//                may have moved anywhere unseen, so it is neither timed nor listed until it moves again;
//   anything else (off the routes, backing out of the approach, a label that never stepped) is not timed.
// OUTAGE AND RESTART (design §5.11, §5.12, D7, D23; step 5). While any area the routes cross is silent past its
// limit (feed-health.js), while a fresh start has not yet replayed the logged last hour (restoreFromLog) and
// loaded the timetable, and for a settling time after a gap, the engine publishes no closures, no countdowns and
// no forecasts — only `unavailable`, with the agreed message. Its own state keeps updating underneath.
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
const { parseLondonWallClock } = require('../time-utils');
const { FeedHealth, OUTAGE_MESSAGE } = require('./feed-health');

const CROSSED_KEEP_MS = 10 * 60e3;     // a train is kept this long after its clear step (barrier-up lags are < 1 min)
const STALL_DEFAULT_SECS = 300;        // a berth with too few trains for a measured stall threshold
const HELD_MAX_MS = 10 * 60e3;         // a train past its trigger berth longer than this (and 3x the threshold) is a left-over label
const DEADLINE_BUFFER_MS = 2 * 60e3;   // allowance past the latest a forecast train should have appeared
const BEST_TIME_FLOOR_MS = 30e3;       // as the classic timing: never a crossing time in the past
// After a gap in the feed, how long predictions wait for the trains that entered unseen to make a step and show
// themselves (an entry placed before the gap counts only once it moves). PROVISIONAL — set from the cut sweep.
const RECOVERY_SETTLE_MS = 120e3;

// The steps in towards the crossing along each direction's approach chain (td.<dir>.approachChain, nearest last, then
// the clear step's from-berth), as AREA:BERTH pairs: a label moving along them is a train (tracker APPROACH_STEPS_TRAIN).
function approachStepsOf(config) {
  const td = (config && config.td) || {}, out = [];
  for (const d of Object.keys(config.directions || {})) {
    const c = td[d] || {};
    const chain = (c.approachChain || []).slice();
    if (c.clear && c.clear.from && chain[chain.length - 1] !== c.clear.from) chain.push(c.clear.from);
    for (let i = 1; i < chain.length; i++) out.push([`${td.area}:${chain[i - 1]}`, `${td.area}:${chain[i]}`]);
  }
  return out;
}

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
      knownSteps: this.routes ? this.routes.steps : [],
      approachSteps: approachStepsOf(config)
    });
    this.timing = new ClosureTiming(id, config);
    this.links = new Map();           // entry record → { id, expectedMs }
    this.forecast = [];               // the timing's trains the berths have not seen, as last selected
    this.view = [];                   // the tracked trains as last classified
    // Outage and restart (step 5). Until restoreFromLog has run (index.js, at startup, before the feed) and a
    // timetable has arrived, the engine is still starting and publishes nothing.
    this.health = new FeedHealth(this.routesFile.areas || [], this.routesFile.feedHealth || {}, Date.now());
    this.startedAt = Date.now();
    this.rebuilt = null;              // { events, sources, from, to, lastRx } once the logged last hour is replayed
    this.scheduleLoaded = false;
    this.settleMs = RECOVERY_SETTLE_MS;
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
  // The board poll's cancelled services (design §5.5): a train the berths have whose stop at the crossing's station
  // is cancelled runs through it. Replaced on every poll, as the board itself is.
  updateLdbCancelled(services) { this.ldbCancelled = Array.isArray(services) ? services : []; }
  updateScheduleTrains(trains) { this.scheduleLoaded = true; this.timing.updateScheduleTrains(trains || []); }

  // Every berth event the listener emits (index.js / engines.js fan each out to every engine): the
  // tracker takes those of the routes' areas, the copied timing those of the crossing's own area.
  recordTdEvent(evt) {
    if (!evt) return false;
    if (this.ownsTdArea(evt.area)) this.health.heard(evt.area, Date.parse(evt.ts), Date.now());
    return this._takeEvent(evt);
  }

  _takeEvent(evt) {
    let taken = false;
    if (this.ownsTdArea(evt.area)) { this.tracker.event(evt); taken = true; this.timing._markDirty(); }
    if (this.timing.recordTdEvent(evt)) taken = true;
    return taken;
  }

  // An area's heartbeat (td-listener 'heartbeat', every 30 s per area): proof the feed is alive when no train moves.
  recordTdHeartbeat(hb) {
    if (!hb || !this.ownsTdArea(hb.area)) return false;
    this.health.heard(hb.area, Date.parse(hb.ts), Date.now());
    return true;
  }

  // The areas whose logged last hour a restart replays (restart-log.js).
  restoreAreas() { return [...this.areas]; }

  // Restart (design §5.12): replay the logged berth events of the last hour (oldest first, as td-listener emitted
  // them) through the live path, so every train on the approach is back where it was, before the feed is heard
  // again. They are history, so they are not proof the feed is alive now. `lastRxMs`: when the previous process
  // last heard the feed; a downtime past an area's silence limit is a gap like an outage (feed-health.js). An
  // empty replay is a cold start, and is still a start: the engine then waits only for the timetable and the feed.
  restoreFromLog(events, { lastRxMs = null, sources = {}, fromMs = null, toMs = null } = {}) {
    const list = Array.isArray(events) ? events : [];
    let last = null;
    for (const e of list) { this._takeEvent(e); const t = Date.parse(e.ts); if (Number.isFinite(t) && (last === null || t > last)) last = t; }
    // The old process heard the feed at least until its last logged event, whatever its national log says.
    const from = Number.isFinite(lastRxMs) ? (last !== null ? Math.max(lastRxMs, last) : lastRxMs) : last;
    if (from !== null) this.health.markRestart(from);
    this.rebuilt = { events: list.length, sources, from: fromMs, to: toMs, lastRx: from };
    return this.rebuilt;
  }

  // Why the engine cannot predict now, or null. In order: still starting (the logged hour not yet replayed, no
  // timetable yet, or an area not yet heard since the start), an area silent past its limit, or the settling
  // time after a gap. `since` is when this spell began (wall ms).
  availability(nowMs = Date.now()) {
    const fp = this.health.problem(nowMs);
    if (fp && fp.reason === 'feed') return fp;
    if (!this.rebuilt || !this.scheduleLoaded || fp) {
      return { reason: 'starting', since: this.startedAt, ...(fp ? { areas: fp.areas } : {}),
        waiting: [!this.rebuilt && 'restore', !this.scheduleLoaded && 'timetable', fp && 'feed'].filter(Boolean) };
    }
    const rec = this.health.lastRecovery();
    if (rec && nowMs < rec.toWall + this.settleMs) return { reason: 'recovering', since: rec.fromWall, until: rec.toWall + this.settleMs, areas: [rec.area] };
    return null;
  }

  // The copied timing seeds its day's sightings from the crossing area's log, as today's engine does (index.js).
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
      // Placed before a gap in the feed: it may have moved on, crossed or left unseen. It counts again when it
      // moves (the tracker's step out of this berth, or its skipped-berth rule, picks it up).
      if (Object.values(on).some(n => n >= 0) && this.health.placedBeforeBlind(e.key.split(':')[0], e.lastMove)) {
        out.push({ id: e.id, entry: e, headcode: e.headcode || null, label: e.label, dir: null, state: 'unconfirmed', berth: e.key, expectedMs: null });
        continue;
      }
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
          berth: e.key, toCrossing: pick.n, inBerthSecs: Math.round(inBerth), expectedMs: secs === null ? null : t + secs * 1000,
          ranThrough: this._ranThrough(pick.d, e.path) });
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
            out.push({ id: e.id, entry: e, headcode: e.headcode || null, headcodes: [...new Set(e.labels.filter(isHeadcode).reverse())], label: e.label, dir: c.dir, state: 'crossed', berth: e.key, expectedMs: e.path[i][1],
              ranThrough: this._ranThrough(c.dir, e.path.slice(0, i + 1)) });
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
    // Outside the last junction a train is only POSSIBLE unless its timetable or board says it crosses
    // (design §5.1, D13): TB's main line carries every train for Brighton, few of which come to Portslade.
    for (const v of this.view) if (v.state === 'approaching' && !v.linked && !this.routes.isCertain(v.dir, v.berth)) v.state = 'possible';
  }

  // The timing's merged list, cut to the trains the berths have (linked entries), plus a train made from
  // the berths for every approaching train the timing does not otherwise have: one no timetable or board
  // entry is (design §5.4: timed as the class that brings the barrier down earliest, the classic timing's
  // 'fast'), or one whose entry the timing dropped. A train on the approach is never left untimed.
  _select(merged, now) {
    const kept = merged.filter(m => m.bfId != null);
    this._applyRunThrough(kept);
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

  // The stations the timing's class rule reads (below) that this path shows the train running through.
  _ranThrough(d, path) {
    const sch = this.config.schedule || {};
    const read = [sch.tiploc_approach_call, sch.tiploc_station].filter(Boolean);
    const all = read.length ? this.routes.ranThrough(d, path) : new Set();
    return new Set(read.filter(x => all.has(x)));
  }

  // Run-through (design §5.5): a train booked to stop that the berths show running through is timed as not
  // stopping there. Only the two stops the timing's class rule reads matter: the station inside the approach
  // berth (schedule.tiploc_approach_call, Portslade's Southwick: stoppingLocal -> stopping, anchored at 0008
  // instead of 0006 + 100 s) and the crossing's own station (schedule.tiploc_station -> fast). The berths that
  // show it, and their thresholds, are learned (routes file runThrough, with its earlier berth). The merged
  // trains are fresh copies every recompute, so the timetable and board entries themselves are never changed.
  //
  // Darwin (design §5.5, westbound's only signal: Portslade's stop is in the clear-step berth itself): a train on the
  // berths whose stop at the crossing's station the board lists as cancelled runs through it — timed as fast. 36 of 37
  // westbound run-throughs over 44 days had that cancellation in the 10 min before; 8 of 3,758 stoppers had it too
  // (they close early, the safe side). Matched by UID, else by headcode within 30 min of its booked time here.
  _applyRunThrough(kept) {
    const sch = this.config.schedule || {};
    const byId = new Map(this.view.map(v => [v.id, v]));
    for (const m of kept) {
      const v = byId.get(m.bfId);
      const ran = new Set(v && v.dir === m.direction && v.ranThrough ? v.ranThrough : []);
      if (sch.tiploc_station && this._stopCancelled(m)) { ran.add(sch.tiploc_station); m.stopCancelled = true; }
      if (!ran.size) continue;
      m.ranThrough = [...ran];
      if (sch.tiploc_approach_call && ran.has(sch.tiploc_approach_call)) m.callsAtApproach = false;
      if (sch.tiploc_station && ran.has(sch.tiploc_station)) { m.callsAtStation = false; m.runThroughStation = true; }
    }
  }

  _stopCancelled(m) {
    const list = this.ldbCancelled || [];
    if (!list.length) return false;
    const ref = m.scheduledTime || m.bestTime;
    const refMs = ref instanceof Date ? ref.getTime() : (ref ? Date.parse(ref) : NaN);
    for (const c of list) {
      if (!c || c.isCancelled === false) continue;
      if (m.uid && c.uid) { if (m.uid === c.uid) return true; continue; }
      if (!m.headcode || c.trainid !== m.headcode) continue;
      const t = parseLondonWallClock(c.sta || c.std || '');
      if (t && Number.isFinite(refMs) && Math.abs(t.getTime() - refMs) <= 30 * 60e3) return true;
    }
    return false;
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
    const un = this.availability(now);
    if (un) {
      // Design §6 "Feed down or rebuilding": the message, and nothing else — no closure, countdown or forecast.
      Object.assign(api, { state: 'UNAVAILABLE', currentClosure: null, nextClosure: null, upcomingClosures: [], closureCount: 0,
        nextCloseTime: null, nextOpenTime: null });
      api.unavailable = { reason: un.reason, since: new Date(un.since).toISOString(), message: OUTAGE_MESSAGE,
        ...(un.areas && un.areas.length ? { areas: un.areas } : {}), ...(un.until ? { until: new Date(un.until).toISOString() } : {}),
        ...(un.waiting ? { waiting: un.waiting } : {}) };
      api.berthFirst = { forecast: [], trains: [] };
      return api;
    }
    api.berthFirst = {
      forecast: this.forecast.filter(f => Date.parse(f.expectedCrossing) > now - 10 * 60e3),
      trains: this.view.filter(v => v.state !== 'crossed' && v.state !== 'unconfirmed').map(v => ({
        id: v.id, label: v.label, headcode: v.headcode, direction: v.dir, state: v.state, berth: v.berth,
        expected: v.expectedMs ? new Date(v.expectedMs).toISOString() : null, linked: !!v.linked,
        unidentified: !!v.entry.unidentified, ...(v.ranThrough && v.ranThrough.size ? { ranThrough: [...v.ranThrough] } : {})
      }))
    };
    return api;
  }

  // Extra fields for the shadow log line (engines.js), beyond the closures every engine logs.
  shadowDetail() {
    const counts = {};
    for (const v of this.view) counts[v.state] = (counts[v.state] || 0) + 1;
    const un = this.availability(Date.now());
    return { trains: counts, unlinkedApproaching: this.view.filter(v => v.state === 'approaching' && !v.linked).length, tracker: this.tracker.stats,
      ...(un ? { unavailable: un.reason } : {}) };
  }

  // For GET /health: whether this engine can predict, why not, and each area's silence (design §5.11).
  feedHealth(nowMs = Date.now()) {
    const un = this.availability(nowMs);
    return {
      engine: 'berth-first', available: !un,
      ...(un ? { reason: un.reason, since: new Date(un.since).toISOString() } : {}),
      restored: this.rebuilt ? { events: this.rebuilt.events, sources: this.rebuilt.sources } : null,
      timetable: this.scheduleLoaded,
      areas: this.health.status(nowMs).areas
    };
  }
}

module.exports = { BerthFirstEngine };
