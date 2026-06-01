const logger = require('./logger');
const { londonMinsToDate } = require('./time-utils');

// States: OPEN, CLOSING_SOON, CLOSED, OPENING_SOON
const CLOSING_SOON_WINDOW_MS = 5 * 60 * 1000; // Show "closing soon" 5 min before

// --- Late-running re-attachment (see _mergeTrains) ---
// A real, approaching train must never show an expired time or drop off the
// list, so a projected crossing is floored to now + this epsilon.
const BEST_TIME_EPSILON_MS = 30 * 1000;
// A TD-sighted (confirmed-live) train is kept until this long past its
// projected crossing, so a late-runner is never removed while still en route.
const SIGHTING_DROP_GRACE_MS = 3 * 60 * 1000;
// Un-sighted schedule trains are dropped once the *scheduled* crossing is this
// far in the past (the train has either run already or won't — no live signal).
const SCHEDULE_PAST_GRACE_MS = 10 * 60 * 1000;
// Within this lead of the *scheduled* crossing, an un-sighted train is treated
// as a no-show; a sighted train switches to sighting-based projection.
const TD_LOCK_LEAD_MS = 60 * 1000;
// Fallback "first TD sighting → crossing" lead if config omits areaEntryLeadSecs.
// Biased low so projections fire early rather than late (catch-every-closure).
// These are deliberately ROUGH and intentionally too short: the 'sighting' fires
// when a headcode first appears ANYWHERE in area LA — often many berths (i.e.
// minutes) before the crossing — so the true lead is larger and variable. (The
// ~112s westbound figure these were seeded from is crossing-section occupancy,
// not sighting-to-crossing.) Precision is not needed: this path only fires for
// trains whose scheduled time has already passed, and the now+epsilon clamp
// guarantees they show as imminent rather than expiring, so too-short only makes
// the prediction fire early (the safe direction). This whole projection is a
// stopgap pending position-based triggering — do NOT tune these against TD logs.
const DEFAULT_AREA_ENTRY_LEAD_SECS = { east: 150, west: 112 };

class CrossingState {
  constructor(crossingId, config) {
    this.id = crossingId;
    this.config = config;
    this.timing = config.timing;

    // Data sources
    this.ldbTrains = [];           // From LDBSVWS polling
    this.scheduleTrains = [];      // From CIF schedule file
    this.tdEvents = [];            // Phase 2: from TD berth steps

    // headcode → Date of first TD sighting in our area today. Trains entering
    // our (narrow) TD area give only ~1 min of warning before Portslade, but
    // a sighting is a definitive "this train is actually running today" signal
    // — used to upgrade Q-freight predictions from "may not run" to confirmed.
    this.tdSeenToday = new Map();
    this.tdSeenDay = null; // ISO date string for which tdSeenToday applies

    // Computed state
    this.closurePeriods = [];
    this.state = 'OPEN';
    this.lastStateChange = new Date();

    // Train history (for feedback correlation)
    this.trainHistory = [];
    this.lastPassedTrain = null;
  }

  // Record a TD sighting (called from td-listener for each CA/CB event we
  // care about). We only need the headcode and the time — the berth itself
  // doesn't matter for "is the train running today".
  recordTdSighting(headcode, when) {
    if (!headcode) return;
    const ts = when instanceof Date ? when : new Date(when);
    if (!Number.isFinite(ts.getTime())) return;
    const day = ts.toISOString().slice(0, 10);
    if (this.tdSeenDay !== day) {
      this.tdSeenToday.clear();
      this.tdSeenDay = day;
    }
    // Keep the FIRST sighting of the day — used as proof of running.
    if (!this.tdSeenToday.has(headcode)) {
      this.tdSeenToday.set(headcode, ts);
      // Recompute so any CIF entry with this headcode picks up tdSeen=true.
      this._recompute();
    }
  }

  // Update LDB trains (called every 30s from poller)
  updateLdbTrains(trains) {
    this.ldbTrains = trains;
    this._updateTrainHistory(trains);
    this._recompute();
  }

  // Update schedule trains (called once at startup / daily)
  updateScheduleTrains(trains) {
    this.scheduleTrains = trains;
    this._recompute();
  }

  // Phase 2: Record a TD berth event
  recordTdEvent(event) {
    this.tdEvents.push({ ...event, timestamp: new Date() });
    // Keep only last hour
    const cutoff = Date.now() - 3600000;
    this.tdEvents = this.tdEvents.filter(e => e.timestamp.getTime() > cutoff);
    logger.logTd(this.id, event);
    this._recompute();
  }

  // Merge and deduplicate trains from all sources
  // Dedup strategy: LDB (LDBSVWS) takes priority. For each CIF train:
  //   1. If LDB has same UID → drop CIF (UID is canonical, globally unique)
  //   2. Else if LDB has same headcode within ±5 min → drop CIF
  //   3. Else include CIF as source:"cif"
  // Fallback to direction+time only when both UID and headcode missing.
  _mergeTrains() {
    const now = new Date();
    const merged = [];

    const ldbByUid = new Map();
    const ldbByHeadcode = new Map(); // headcode -> [trains]

    for (const t of this.ldbTrains) {
      const train = {
        ...t,
        bestTime: new Date(t.bestTime),
        scheduledTime: t.scheduledTime ? new Date(t.scheduledTime) : null,
        confidence: 'high'
      };
      merged.push(train);
      if (t.uid) ldbByUid.set(t.uid, train);
      if (t.headcode) {
        if (!ldbByHeadcode.has(t.headcode)) ldbByHeadcode.set(t.headcode, []);
        ldbByHeadcode.get(t.headcode).push(train);
      }
    }

    for (const t of this.scheduleTrains) {
      const estTime = this._scheduleTimeToDate(t.estimatedCrossingMins);
      if (!estTime) continue;

      const tdSighting = t.headcode ? this.tdSeenToday.get(t.headcode) : null;

      // The 'sighting' event fires on ANY CA/CB step in TD area LA and carries
      // only { headcode, ts } — NOT the approach berth. So it means "entered
      // the LA area", a per-direction transit *before* the crossing, not the
      // crossing itself. Project forward by that nominal lead.
      const leadMs = this._getAreaEntryLeadMs(t.direction);
      const projectedFromSighting = tdSighting ? tdSighting.getTime() + leadMs : null;

      // Drop trains that have clearly gone:
      //  - Sighted (confirmed live): keep until SIGHTING_DROP_GRACE_MS past the
      //    *projected* crossing, so a late-runner is never removed mid-approach.
      //  - Un-sighted: drop once the *scheduled* crossing is SCHEDULE_PAST_GRACE_MS
      //    stale (already ran, or a no-show). This preserves the old behaviour.
      if (tdSighting) {
        if (now.getTime() > projectedFromSighting + SIGHTING_DROP_GRACE_MS) continue;
      } else if (estTime.getTime() < now.getTime() - SCHEDULE_PAST_GRACE_MS) {
        continue;
      }

      // 1. UID match (canonical, both sides expose CIF train UID)
      if (t.uid && ldbByUid.has(t.uid)) continue;

      // 2. Headcode + time match (fallback when UID missing on either side)
      let covered = false;
      if (t.headcode && ldbByHeadcode.has(t.headcode)) {
        for (const m of ldbByHeadcode.get(t.headcode)) {
          if (Math.abs(m.bestTime.getTime() - estTime.getTime()) <= 300000) {
            covered = true;
            break;
          }
        }
      }
      if (covered) continue;

      // 3. Last-resort direction+time match (loose, for headcode-less services)
      if (!t.headcode) {
        const looseHit = merged.some(m =>
          m.direction === t.direction &&
          Math.abs(m.bestTime.getTime() - estTime.getTime()) <= 180000
        );
        if (looseHit) continue;
      }

      // Late-minute drop: within TD_LOCK_LEAD_MS of the scheduled crossing,
      // require a TD sighting to keep the prediction. On-time trains enter
      // our LA berths ~60–90s before crossing, so a missing sighting at T−60s
      // is strong evidence the train isn't running (typical Q-path no-show).
      // We re-add automatically on the next recompute if TD eventually sights
      // the headcode (the recordTdSighting hook triggers _recompute).
      // NOTE: this drop only fires for genuinely-absent (un-sighted) trains —
      // the sighted late-running path below is left intact.
      if (!tdSighting && (estTime.getTime() - now.getTime()) < TD_LOCK_LEAD_MS) {
        continue;
      }

      // bestTime: normally the scheduled crossing. But once the scheduled time
      // has effectively passed (or we're inside the T−60s window) AND TD has
      // sighted the train, the schedule time is stale — a late-runner would
      // show an expired/disappearing prediction. Project from the sighting
      // instead and mark it low-confidence.
      let bestTime = estTime;
      let confidence = t.trainType === 'freight' ? 'low' : 'medium';
      let etaText = 'Timetabled';
      if (tdSighting && (estTime.getTime() - now.getTime()) < TD_LOCK_LEAD_MS) {
        bestTime = new Date(projectedFromSighting);
        confidence = 'low';
        etaText = 'Live (TD)';
      }

      // Never emit a crossing time in the past — a real approaching train must
      // not show an expired prediction or fall off the list.
      const floorMs = now.getTime() + BEST_TIME_EPSILON_MS;
      if (bestTime.getTime() < floorMs) bestTime = new Date(floorMs);

      merged.push({
        origin: t.origin,
        destination: t.destination,
        operator: t.operator,
        direction: t.direction,
        bestTime,
        scheduledTime: estTime,
        headcode: t.headcode,
        uid: t.uid,
        trainType: t.trainType,
        delayMins: 0,
        isUncertain: true,
        etaText,
        source: 'cif',
        confidence,
        runsAsRequired: !!t.runsAsRequired,
        recentRunRate: typeof t.recentRunRate === 'number' ? t.recentRunRate : null,
        recentRunSeen: t.recentRunSeen || 0,
        recentRunApplicable: t.recentRunApplicable || 0,
        tdSeen: !!tdSighting,
        tdSeenAt: tdSighting ? tdSighting.toISOString() : null,
        dedupKey: `cif|${t.uid || t.headcode || ''}|${t.estimatedCrossingMins}`
      });
    }

    merged.sort((a, b) => a.bestTime - b.bestTime);
    return merged;
  }

  // Convert schedule minutes-since-midnight to Date for today (Europe/London wall-clock)
  _scheduleTimeToDate(mins) {
    return londonMinsToDate(mins);
  }

  // Nominal "entered TD area LA → crossing" transit for a direction, in ms.
  // Config: timing.areaEntryLeadSecs (per-direction object or single number);
  // falls back to DEFAULT_AREA_ENTRY_LEAD_SECS. Used to project a late-running
  // train's crossing from its TD sighting (see _mergeTrains).
  _getAreaEntryLeadMs(direction) {
    const cfg = this.timing && this.timing.areaEntryLeadSecs;
    let secs;
    if (cfg && typeof cfg === 'object') secs = cfg[direction];
    else if (typeof cfg === 'number') secs = cfg;
    if (typeof secs !== 'number') {
      secs = DEFAULT_AREA_ENTRY_LEAD_SECS[direction];
      if (typeof secs !== 'number') secs = 120;
    }
    return secs * 1000;
  }

  // Compute closure periods from merged train list
  _computeClosures(trains) {
    if (!trains.length) return [];

    const periods = [];
    let start = null, end = null, currentTrains = [];

    for (const t of trains) {
      const cb = this._getCloseBefore(t.direction);
      const oa = this._getOpenAfter(t.direction);

      const closeTime = new Date(t.bestTime.getTime() - cb * 60000);
      const openTime = new Date(t.bestTime.getTime() + oa * 60000);

      if (start === null) {
        start = closeTime;
        end = openTime;
        currentTrains = [t];
      } else if (closeTime.getTime() - end.getTime() <= this.timing.consecutiveWindow * 60000) {
        // Merge with current period
        end = new Date(Math.max(end.getTime(), openTime.getTime()));
        currentTrains.push(t);
      } else {
        // New period
        periods.push(this._makePeriod(start, end, currentTrains));
        start = closeTime;
        end = openTime;
        currentTrains = [t];
      }
    }

    if (start) {
      periods.push(this._makePeriod(start, end, currentTrains));
    }

    return periods;
  }

  _makePeriod(start, end, trains) {
    // Determine reason
    let reason = 'single_train';
    if (trains.length > 1) reason = 'merged_consecutive';

    // Count sources
    const sources = new Set(trains.map(t => t.source));
    const hasFreight = trains.some(t => t.trainType === 'freight');
    const hasEcs = trains.some(t => t.trainType === 'ecs');

    return {
      start: start.toISOString(),
      end: end.toISOString(),
      durationMins: Math.round((end - start) / 60000),
      reason,
      trainCount: trains.length,
      hasFreight,
      hasEcs,
      sources: [...sources],
      trains: trains.map(t => ({
        direction: t.direction,
        origin: t.origin,
        destination: t.destination,
        operator: t.operator,
        bestTime: t.bestTime.toISOString(),
        scheduledTime: t.scheduledTime?.toISOString(),
        headcode: t.headcode,
        uid: t.uid || null,
        trainType: t.trainType,
        delayMins: t.delayMins || 0,
        etaText: t.etaText,
        confidence: t.confidence,
        source: t.source,
        runsAsRequired: !!t.runsAsRequired,
        recentRunRate: typeof t.recentRunRate === 'number' ? t.recentRunRate : null,
        recentRunSeen: t.recentRunSeen || 0,
        recentRunApplicable: t.recentRunApplicable || 0,
        tdSeen: !!t.tdSeen,
        tdSeenAt: t.tdSeenAt || null
      }))
    };
  }

  _getCloseBefore(direction) {
    const cb = this.timing.closeBefore;
    if (typeof cb === 'object') return cb[direction] || 1.5;
    return cb || 1.5;
  }

  _getOpenAfter(direction) {
    const oa = this.timing.openAfter;
    if (typeof oa === 'object') return oa[direction] || 0.5;
    return oa || 0.5;
  }

  // Recompute everything
  _recompute() {
    const merged = this._mergeTrains();
    this.closurePeriods = this._computeClosures(merged);

    const now = new Date();
    const oldState = this.state;

    // Determine current state
    const currentClosure = this.closurePeriods.find(p =>
      now >= new Date(p.start) && now <= new Date(p.end)
    );

    if (currentClosure) {
      this.state = 'CLOSED';
    } else {
      // Check if closing soon
      const nextClosure = this.closurePeriods.find(p => new Date(p.start) > now);
      if (nextClosure && (new Date(nextClosure.start) - now) <= CLOSING_SOON_WINDOW_MS) {
        this.state = 'CLOSING_SOON';
      } else {
        this.state = 'OPEN';
      }
    }

    if (this.state !== oldState) {
      this.lastStateChange = now;
      logger.logState(this.id, oldState, this.state, 'recompute');
    }
  }

  // Update train history (for feedback)
  _updateTrainHistory(newTrains) {
    for (const t of newTrains) {
      const key = t.dedupKey;
      const idx = this.trainHistory.findIndex(h => h.dedupKey === key);
      if (idx >= 0) {
        this.trainHistory[idx] = t;
      } else {
        this.trainHistory.push(t);
      }
    }
    // Prune history older than 1 hour
    const cutoff = new Date(Date.now() - 3600000);
    this.trainHistory = this.trainHistory.filter(t =>
      new Date(t.bestTime) > cutoff
    );
  }

  // Get the full state for the API
  getApiState() {
    const now = new Date();
    const upcoming = this.closurePeriods.filter(p => new Date(p.end) > now);
    const current = upcoming.find(p => now >= new Date(p.start) && now <= new Date(p.end));
    const next = upcoming.find(p => new Date(p.start) > now);

    return {
      crossingId: this.id,
      name: this.config.name,
      road: this.config.road,
      state: this.state,
      lastStateChange: this.lastStateChange.toISOString(),
      currentClosure: current || null,
      nextClosure: next || null,
      upcomingClosures: upcoming.slice(0, 200),
      nextCloseTime: next ? next.start : null,
      nextOpenTime: current ? current.end : (next ? next.end : null),
      trainSources: {
        ldb: this.ldbTrains.length,
        cif: this.scheduleTrains.filter(t => {
          const est = this._scheduleTimeToDate(t.estimatedCrossingMins);
          return est && est > now;
        }).length
      },
      lastRefresh: new Date().toISOString()
    };
  }
}

module.exports = CrossingState;
