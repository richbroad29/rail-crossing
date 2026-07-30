const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { londonMinsToDate } = require('./time-utils');

// Measured berth→berth transits (scripts/derive-transits.js). Purely empirical: no close
// or open offsets are baked in, so recalibrating an offset or re-anchoring a class needs
// no regeneration here. Absent file ⇒ projection disabled and every path falls back to
// the bestTime estimates, so a crossing without a table behaves exactly as before.
let TRANSITS = {};
try {
  TRANSITS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'transits.json'), 'utf8'));
} catch (e) {
  console.warn('transits.json not loaded (' + e.code + ') — berth projection disabled');
}

// States: OPEN, CLOSING_SOON, CLOSED, OPENING_SOON
//
// MUST match the frontend's own CLOSING_SOON threshold (shared/crossing.js on `main`,
// `if (ms <= 90000)` in updateStatus). The frontend ignores this `state` field and
// derives its own from the periods, so the only consumer here is the state log — and
// a log that disagrees with what the user saw is worse than no log. It was 5 min,
// which made the log read CLOSING_SOON while the app still showed "next closure in
// ~5 min". Keep the two in step if either changes.
const CLOSING_SOON_WINDOW_MS = 90 * 1000;

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

// --- TD-triggered open (clear-step anchor) ---
// When TD shows a train performing the crossing CLEAR step (config td.<dir>.clear),
// the barrier's OPEN is anchored to that physical event + a per-direction/class lag
// (timing.openLagSecs), rather than the bestTime + openAfter fallback. Opening is
// deterministic — the barrier auto-raises on the departure-side track circuit
// clearing — so the clear step is ground truth. Recorded clear steps expire after
// this TTL (checked on both write and read) so a headcode reused later in the day
// can never match a stale crossing from earlier on.
const CLEAR_STEP_TTL_MS = 20 * 60 * 1000;
// --- TD-triggered close (approach strike-in anchor) ---
// When TD shows a train stepping INTO the approach-side berth (config
// td.<dir>.approach.from — 0006 east / 0003 west), the barrier's CLOSE start can
// be anchored to that physical strike + a per-direction/class lag (timing.closeTrigger).
// Unlike the clear step (which moves a period's END), a close strike moves a period's
// START, so recording one recomputes. Recorded strikes expire after this TTL so a
// headcode reused later in the day can't match a stale approach from earlier on.
const CLOSE_STRIKE_TTL_MS = 20 * 60 * 1000;
// Max berth-strike steps retained per train in the B1 live map (feeds the feedback
// picker's calibration capture). Bounded so a long-dwelling headcode can't grow it.
const BERTH_HISTORY_MAX = 30;
// While a TD-sighted train has NOT yet performed its clear step, the closure must
// never end (the train hasn't physically cleared). Its end is floored this far into
// the future so the barrier stays closed/pending until the real clear step lands.
// Bounded in practice by the merged-list drop grace, so a sighted no-show can't hold
// the barrier indefinitely.
const OPEN_HOLD_FLOOR_MS = 60 * 1000;
// --- Last-known train cache (see this.knownTrains) ---
// How long a train's record stays available after its source last reported it. Long
// enough to cover a feedback tap well after the train has gone, bounded so a headcode
// reused later in the day can't resolve to this morning's working.
const KNOWN_TRAIN_TTL_MS = 45 * 60 * 1000;
// Mirror of OPEN_HOLD_FLOOR_MS for the close side: while TD shows a train still short
// of its close-anchor berth, the gated (CLOSED) onset is held this far into the future
// so a drifting bestTime can't close the barrier for a train we can see isn't there.
// Short, because it must release promptly once the train does reach the anchor.
const CLOSE_HOLD_FLOOR_MS = 30 * 1000;

class CrossingState {
  constructor(crossingId, config) {
    this.id = crossingId;
    this.config = config;
    this.timing = config.timing;
    // Measured berth→berth transits for this crossing. config.transits wins so a test (or
    // a second crossing) can supply its own; otherwise the generated file. Empty ⇒ no
    // projection, and every path falls back to the bestTime estimates.
    this.transits = config.transits || TRANSITS[crossingId] || {};

    // Data sources
    this.ldbTrains = [];           // From LDBSVWS polling
    this.scheduleTrains = [];      // From CIF schedule file

    // B1 live-position map: headcode → { berth, fromBerth, event, lastSeen(ms) }.
    // Updated on every TD berth step (the TD feed is area-wide for LA), pruned by
    // TTL on read. Serves the observer app AND — since the position-based projection
    // shipped — feeds the prediction, so an on-chain step marks the state dirty
    // (see recordTdBerth and _markDirty).
    this.liveTrains = new Map();

    // headcode → Date of first TD sighting in our area today. Trains entering
    // our (narrow) TD area give only ~1 min of warning before Portslade, but
    // a sighting is a definitive "this train is actually running today" signal
    // — used to upgrade Q-freight predictions from "may not run" to confirmed.
    this.tdSeenToday = new Map();
    this.tdSeenDay = null; // ISO date string for which tdSeenToday applies

    // headcode → { ts(ms), direction } of the train's most recent CROSSING CLEAR
    // step (config td.<dir>.clear). Drives TD-triggered open: a period's end is
    // anchored to its FINAL train's clear step + openLagSecs. Pruned by TTL so a
    // reused headcode can't match a stale crossing from earlier in the day.
    this.clearStepSeen = new Map();

    // headcode → { ts(ms), direction } of the train's most recent APPROACH
    // strike-in (stepping into config td.<dir>.approach.from — 0006 east / 0003
    // west). Drives TD-triggered close: a period's START is anchored to this
    // strike + a per-direction/class lag (timing.closeTrigger). Pruned by TTL so a
    // reused headcode can't match a stale approach from earlier in the day.
    this.closeStrikeSeen = new Map();

    // headcode → { train, sourceSeenMs } — the last record we held for a train while one
    // of its SOURCES (LDB board / CIF schedule) still reported it.
    //
    // Exists for the feedback picker. An LDB board lists only services still to call, so
    // a departed train matches nothing but its CIF entry, and CIF entries carry no
    // schedArr/schedDep/liveArr/liveDep at all — those fields are LDB-only. An OPEN tap is
    // attributed to a just-cleared train by definition, so all four calibration anchors
    // were being lost for precisely the events that need them. _matchKnownTrain falls back
    // here so they survive the departure.
    this.knownTrains = new Map();

    // Computed state
    this.closurePeriods = [];
    this.state = 'OPEN';
    this.lastStateChange = new Date();

    // Set when a TD event has changed something a prediction depends on, cleared when the
    // coalesced recompute runs. See _markDirty.
    this._dirtyScheduled = false;
  }

  // Request a recompute, coalescing everything that arrives in the same tick into one.
  //
  // Why coalesce rather than recompute inline: td-listener parses each STOMP frame into an
  // ARRAY and emits one 'sighting' per message synchronously, and each of those runs all
  // four recorders. A recompute measured at ~13 ms against a real 234-train day, so
  // recomputing per message would block the event loop for N x 13 ms per frame — with the
  // HTTP API queued behind it. Coalescing makes it one recompute per frame however many
  // messages it carried.
  //
  // It also fixes an ordering wrinkle: previously three recorders each recomputed
  // independently, so recordTdClearStep's recompute ran before recordTdCloseStrike had
  // written closeStrikeSeen — one recompute against a half-updated state, corrected by the
  // next. Deferring to the end of the tick means every recompute sees a consistent snapshot.
  //
  // setImmediate, not process.nextTick: a pending API response should go out before we
  // spend 13 ms of CPU. The try/catch matters because a throw inside a deferred callback
  // has no caller to catch it and would take the process down.
  _markDirty() {
    if (this._dirtyScheduled) return;
    this._dirtyScheduled = true;
    setImmediate(() => {
      this._dirtyScheduled = false;
      try {
        this._recompute();
      } catch (err) {
        console.error(`[${this.id}] deferred recompute failed:`, err && err.message);
      }
    });
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
      this._markDirty();
    }
  }

  // Rebuild today's first-sighting map from the day's TD log at startup.
  //
  // tdSeenToday is memory-only, so a restart wipes it and every train then in area LA
  // gets its "first sighting" stamped at boot. Any whose scheduled crossing has already
  // passed is then re-projected as imminent and floored into the near future,
  // resurrecting trains that ran long ago. Observed 2026-07-26 21:42:13, 1.3s after a
  // deploy: two CIF services that never ran were merged into a real closure and held
  // BARRIERS DOWN for 5m31s.
  //
  // Seeding restores the real first-sighting times, so the existing grace rules retire
  // those trains exactly as they would have without the restart. Deliberately does NOT
  // recompute per entry — this runs before the first poll and would otherwise rebuild
  // the closure list once per headcode.
  seedSightings(entries) {
    let n = 0;
    for (const e of entries) {                       // caller supplies chronological order
      if (!e || !e.headcode || !e.ts) continue;
      const ts = e.ts instanceof Date ? e.ts : new Date(e.ts);
      if (!Number.isFinite(ts.getTime())) continue;
      const day = ts.toISOString().slice(0, 10);
      if (this.tdSeenDay !== day) { this.tdSeenToday.clear(); this.tdSeenDay = day; }
      if (this.tdSeenToday.has(e.headcode)) continue;
      this.tdSeenToday.set(e.headcode, ts);
      n++;
    }
    return n;
  }

  // B1: record a TD berth step into the live-position map. Called from the same
  // 'sighting' hook as recordTdSighting, with the enriched payload that now
  // carries the berth.
  //
  // This used to say the live map "must not touch predictions", which stopped being true on
  // 2026-07-26 when the projection started reading it. It now marks the state dirty for an
  // on-chain step — see the note at the bottom of this method.
  recordTdBerth(evt) {
    if (!evt || !evt.headcode) return;
    const ms = evt.ts ? new Date(evt.ts).getTime() : Date.now();
    if (!Number.isFinite(ms)) return;
    const berth = evt.to || null;
    // Accumulate a per-train berth-strike history (each new berth = one strike;
    // consecutive same-berth events are deduped). Bounded, carried on the live-map
    // entry, and dropped with the train when it is TTL-pruned from getLiveTrains.
    const prev = this.liveTrains.get(evt.headcode);
    let history = prev && prev.history ? prev.history : [];
    if (berth && (history.length === 0 || history[history.length - 1].berth !== berth)) {
      history = history.concat([{ berth, ts: new Date(ms).toISOString(), event: evt.event || null }]);
      if (history.length > BERTH_HISTORY_MAX) history = history.slice(history.length - BERTH_HISTORY_MAX);
    }
    this.liveTrains.set(evt.headcode, {
      berth,                        // the berth the train just stepped INTO
      fromBerth: evt.from || null,
      event: evt.event || null,
      lastSeen: ms,
      history
    });
    // Register #13. The projection is computed FROM this map (_strikeOrProjection ->
    // _chainIndex -> liveTrains), so a step that moves a train along its approach chain has
    // just made a sharper estimate available. Without this the new position waited for the
    // next LDB poll — up to 30 s — and the countdown lurched instead of tightening.
    //
    // Gated on the berth being on a configured approach chain: _chainIndex returns null for
    // anything else, so an off-chain step cannot change a prediction and recomputing for it
    // would be pure cost. Measured on 2026-07-29 that gate is the difference between 7,672
    // and 1,234 recompute requests a day.
    //
    // A step from a chain berth to an off-chain berth that is not the clear step
    // deliberately does NOT mark dirty: the projection then keeps the last known chain
    // position, which beats falling back to a timetable estimate, and the next LDB poll
    // reconciles it anyway.
    if (berth && this._matchCloseStrikeBerth(berth)) this._markDirty();
  }

  // TD-triggered open: record a train performing the crossing CLEAR step. Only the
  // configured clear transitions (td.eastbound.clear / td.westbound.clear) count;
  // every other berth step is ignored here (the B1 live map handles those). Unlike
  // recordTdBerth, a clear step moves a closure's END, so this DOES recompute.
  recordTdClearStep(evt) {
    if (!evt || !evt.headcode || !evt.from || !evt.to) return;
    const direction = this._matchClearStep(evt.from, evt.to);
    if (!direction) return;
    const ms = evt.ts ? new Date(evt.ts).getTime() : Date.now();
    if (!Number.isFinite(ms)) return;
    this.clearStepSeen.set(evt.headcode, { ts: ms, direction });
    this._pruneClearSteps(ms);
    this._markDirty();
  }

  // Which direction's crossing clear step (from→to) is, or null if it isn't one.
  _matchClearStep(from, to) {
    const td = this.config && this.config.td;
    if (!td) return null;
    const e = td.eastbound && td.eastbound.clear;
    if (e && e.from === from && e.to === to) return 'east';
    const w = td.westbound && td.westbound.clear;
    if (w && w.from === from && w.to === to) return 'west';
    return null;
  }

  _pruneClearSteps(nowMs) {
    for (const [headcode, s] of this.clearStepSeen) {
      if (nowMs - s.ts > CLEAR_STEP_TTL_MS) this.clearStepSeen.delete(headcode);
    }
  }

  // TD-triggered close: record a train stepping INTO any berth on a direction's
  // approach chain (td.<dir>.approachChain). One of those berths anchors the closure
  // START, and WHICH one depends on the train's class — eastbound berth 0006 contains
  // Southwick, so a service calling there strikes it ~160s before reaching 0004 while
  // one that doesn't strikes it ~49s before. Recording the whole chain lets
  // _computeCloseTime pick the right anchor per class, and lets the CLOSED backstop see
  // whether a train is still upstream of its anchor.
  //
  // Matched on the destination berth ONLY: the two directions use disjoint berths, so
  // entering one is unambiguous; the per-train direction gate in _freshStrike is the
  // second guard. Unlike recordTdBerth, a strike moves a closure's start, so this DOES
  // recompute — but only for berths that can actually anchor something, otherwise every
  // step of the chain would trigger a full recompute.
  recordTdCloseStrike(evt) {
    if (!evt || !evt.headcode || !evt.to) return;
    const dir = this._matchCloseStrikeBerth(evt.to);
    if (!dir) return;
    const ms = evt.ts ? new Date(evt.ts).getTime() : Date.now();
    if (!Number.isFinite(ms)) return;
    this.closeStrikeSeen.set(this._strikeKey(evt.headcode, evt.to),
      { ts: ms, direction: dir, headcode: evt.headcode, berth: evt.to });
    this._pruneCloseStrikes(ms);
    if (this._isAnchorBerth(dir, evt.to)) this._markDirty();
  }

  _strikeKey(headcode, berth) { return `${headcode}|${berth}`; }

  // Which direction's approach chain contains berth `to`, or null if none does.
  // Falls back to the legacy single approach.from berth when no chain is configured,
  // so a crossing without approachChain behaves exactly as before.
  _matchCloseStrikeBerth(to) {
    const td = this.config && this.config.td;
    if (!td) return null;
    for (const dir of ['east', 'west']) {
      const cfg = td[dir === 'east' ? 'eastbound' : 'westbound'];
      if (!cfg) continue;
      if (Array.isArray(cfg.approachChain)) {
        if (cfg.approachChain.includes(to)) return dir;
      } else if (cfg.approach && cfg.approach.from === to) {
        return dir;
      }
    }
    return null;
  }

  // Is this berth one that some class actually anchors its close to? Used to avoid
  // recomputing on every chain step. Unknown config ⇒ true (recompute, the safe side).
  _isAnchorBerth(direction, berth) {
    const ct = this.timing && this.timing.closeTrigger && this.timing.closeTrigger[direction];
    if (!ct) return true;
    if (ct.classes) return Object.values(ct.classes).some(c => c && c.berth === berth);
    const cfg = this.config.td[direction === 'east' ? 'eastbound' : 'westbound'];
    return !!(cfg && cfg.approach && cfg.approach.from === berth);
  }

  _pruneCloseStrikes(nowMs) {
    for (const [key, s] of this.closeStrikeSeen) {          // key is `headcode|berth`
      if (nowMs - s.ts > CLOSE_STRIKE_TTL_MS) this.closeStrikeSeen.delete(key);
    }
  }

  // TTL (ms) after which a train that hasn't stepped is dropped from the live
  // map. Config: crossing `live.ttlSecs`; default 4 min (rough area-transit guess).
  _getLiveTtlMs() {
    const secs = this.config && this.config.live && this.config.live.ttlSecs;
    return (typeof secs === 'number' ? secs : 240) * 1000;
  }

  // Find a known train (LDB first, then CIF schedule, then the last-known cache) by
  // headcode, for enriching a live berth sighting with direction / origin / destination
  // and the four Portslade times.
  //
  // The cache fallback is what keeps the feedback picker honest: an LDB board only lists
  // services that are still to call, so a train that has departed matches nothing but its
  // CIF entry — and CIF entries carry no schedArr/schedDep/liveArr/liveDep at all. Since
  // an OPEN event is always attributed to a train that has just left, those anchors were
  // being lost for precisely the events the calibration depends on.
  _matchKnownTrain(headcode) {
    if (!headcode) return null;
    for (const t of this.ldbTrains) if (t.headcode === headcode) return t;
    for (const t of this.scheduleTrains) if (t.headcode === headcode) return t;
    const cached = this.knownTrains.get(headcode);
    return cached ? cached.train : null;
  }

  // One of the four Portslade times: whatever a source is reporting right now, else the
  // last non-empty value we held for this train. An OPEN tap is attributed to a train
  // that has just left, so without this its estimates are blank exactly when the
  // calibration needs them.
  _lastKnownField(headcode, match, field) {
    if (match && match[field]) return match[field];
    const cached = this.knownTrains.get(headcode);
    return (cached && cached.train && cached.train[field]) || null;
  }

  // Fields carried forward when a source stops reporting them. A blanked estimate is
  // not new information about the timetable — it means the event has happened — so the
  // last value we actually saw is still the best answer for the feedback picker.
  static get STICKY_FIELDS() { return ['schedArr', 'schedDep', 'liveArr', 'liveDep']; }

  // Cache every train a source reported this cycle, and expire stale entries.
  _rememberTrains(merged, nowMs) {
    for (const t of merged) {
      if (!t.headcode) continue;
      const prev = this.knownTrains.get(t.headcode);
      const train = { ...t };
      if (prev && prev.train) {
        for (const k of CrossingState.STICKY_FIELDS) {
          if (!train[k] && prev.train[k]) train[k] = prev.train[k];
        }
      }
      this.knownTrains.set(t.headcode, { train, sourceSeenMs: nowMs });
    }
    for (const [hc, e] of this.knownTrains) {
      if (nowMs - e.sourceSeenMs > KNOWN_TRAIN_TTL_MS) this.knownTrains.delete(hc);
    }
  }

  // B1: current trains in the TD area, pruned by TTL and enriched from CIF/LDB.
  //  - direction: from the headcode→known-train join; "unknown" if no match
  //    (never guessed from raw berths).
  //  - stopping: true if the train is on the PLD LDB board (boards only list
  //    calling services); otherwise "unknown" — never false (a non-stopping
  //    fast simply isn't on the board, so absence ≠ non-stopping).
  getLiveTrains(now = Date.now()) {
    const ttl = this._getLiveTtlMs();
    const out = [];
    for (const [headcode, t] of this.liveTrains) {
      if (now - t.lastSeen > ttl) { this.liveTrains.delete(headcode); continue; }
      const match = this._matchKnownTrain(headcode);
      // On the board now, or on it when we last saw this train — an LDB-sourced cached
      // record is proof it was a calling service, so a departure shouldn't downgrade a
      // known `true` back to "unknown" in the feedback payload.
      const onBoard = this.ldbTrains.some(x => x.headcode === headcode) ||
        (match && typeof match.source === 'string' && match.source.startsWith('ldb'));
      out.push({
        headcode,
        berth: t.berth,
        fromBerth: t.fromBerth,
        event: t.event,
        direction: match && match.direction ? match.direction : 'unknown',
        stopping: onBoard ? true : 'unknown',
        origin: match ? (match.origin || null) : null,
        destination: match ? (match.destination || null) : null,
        // Four Portslade times (LDB sta/std/eta/etd) and the recent berth-strike
        // history — both feed the feedback picker. Resolved FIELD BY FIELD, not by
        // picking one record: Darwin does not drop a departed service from the board,
        // it keeps the row and BLANKS the estimates — liveArr as the train arrives,
        // liveDep as it leaves. So the live match still wins the record lookup while
        // holding nothing, and a record-level cache fallback never fires. Observed
        // 2026-07-26: 1N34 crossed with both live fields already empty.
        schedArr: this._lastKnownField(headcode, match, 'schedArr'),
        schedDep: this._lastKnownField(headcode, match, 'schedDep'),
        liveArr: this._lastKnownField(headcode, match, 'liveArr'),
        liveDep: this._lastKnownField(headcode, match, 'liveDep'),
        history: (t.history || []).map(h => ({ berth: h.berth, ts: h.ts, event: h.event })),
        lastSeen: t.lastSeen,
        ageSecs: Math.round((now - t.lastSeen) / 1000)
      });
    }
    out.sort((a, b) => b.lastSeen - a.lastSeen); // most recently seen first
    return out;
  }

  // Update LDB trains (called every 30s from poller)
  updateLdbTrains(trains) {
    this.ldbTrains = trains;
    this._recompute();
  }

  // Update schedule trains (called once at startup / daily)
  updateScheduleTrains(trains) {
    this.scheduleTrains = trains;
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

      // Where do we think this train reaches the road?
      //
      // FIRST CHOICE — measured, from where TD actually has it. A berth on our own
      // approach chain plus the transit for its class is a real position-based estimate
      // and it sharpens on every step.
      //
      // FALLBACK — the old area-entry projection: the 'sighting' event fires on ANY CA/CB
      // step in area LA and carries no berth, so it only means "somewhere in LA". That is
      // a poor estimate and, worse, it drives the drop rule below: measured over 10 days,
      // first-sighting→crossing is a median 2,329s eastbound against a 330s deadline, so
      // 95% of trains would breach it. Only reached now when we have no berth for the
      // train, which is precisely when we genuinely don't know where it is.
      const projected = this._projectBerth(t, 'XING', now);
      const leadMs = this._getAreaEntryLeadMs(t.direction);
      const projectedFromSighting = projected ? projected.ts
        : (tdSighting ? tdSighting.getTime() + leadMs : null);

      // Drop trains that have clearly gone:
      //  - Sighted (confirmed live): keep until SIGHTING_DROP_GRACE_MS past the
      //    *projected* crossing, so a late-runner is never removed mid-approach.
      //  - Un-sighted: drop once the *scheduled* crossing is SCHEDULE_PAST_GRACE_MS
      //    stale (already ran, or a no-show). This preserves the old behaviour.
      if (tdSighting || projected) {
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
      if (projected) {
        // We can see the train. A measured position beats the timetable outright, so use
        // it whether or not the scheduled time has passed.
        bestTime = new Date(projected.ts);
        confidence = 'medium';
        etaText = 'Live (berth)';
      } else if (tdSighting && (estTime.getTime() - now.getTime()) < TD_LOCK_LEAD_MS) {
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
        callsAtStation: t.callsAtStation,
        callsAtApproach: t.callsAtApproach,
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

    // Keep a last-known record of everything the sources reported, for the feedback
    // picker to fall back on once a train has left the board.
    this._rememberTrains(merged, now.getTime());

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

  // Does this train CALL at the crossing station?
  //  - LDB source ⇒ yes. Boards list calling services only.
  //  - CIF source ⇒ read it from the schedule's calling pattern (`callsAtStation`,
  //    set by schedule-parser). Previously every CIF entry was treated as
  //    non-stopping, which silently mislabelled any passenger service beyond the
  //    ~2 h LDB window. `null` (unknowable) keeps the old conservative answer.
  _isStopping(t) {
    if (typeof t.source === 'string' && t.source.startsWith('ldb')) return true;
    return t.callsAtStation === true;
  }

  // Whether `bestTime` for this train is a real LDB DEPARTURE, as opposed to a CIF
  // interpolated crossing time. The westbound stopping rule subtracts a departure
  // lead, so it must only run on trains where bestTime actually means a departure —
  // feeding it an interpolated crossing time would silently anchor to the wrong event.
  _hasLiveDeparture(t) {
    return typeof t.source === 'string' && t.source.startsWith('ldb');
  }

  // Does this train also call at the station inside the approach berth (Southwick)?
  // Read from the CIF schedule, which covers the whole day, then applied to LDB-sourced
  // trains too by UID (headcode as fallback) — LDB only tells us about THIS station's
  // board, so it cannot answer this on its own. Returns true/false/null(unknown).
  _callsAtApproachStop(t) {
    if (t.callsAtApproach != null) return t.callsAtApproach;
    for (const s of this.scheduleTrains) {
      if (s.callsAtApproach == null) continue;
      if (t.uid && s.uid && t.uid === s.uid) return s.callsAtApproach;
    }
    if (t.headcode) {
      for (const s of this.scheduleTrains) {
        if (s.callsAtApproach == null) continue;
        if (s.headcode === t.headcode) return s.callsAtApproach;
      }
    }
    return null;
  }

  // Which eastbound timing class a train belongs to. The classes exist because approach
  // berth 0006 contains Southwick: a service calling there occupies 0006 ~3x longer,
  // so the same strike means a very different time-to-crossing. See closeTrigger._comment.
  //   freight       6xxx/7xxx — ~100s slower than fast passenger at every berth
  //   ecs           5xxx
  //   stoppingLocal calls Portslade AND Southwick   (1N/1S/2Y Brighton services)
  //   stopping      calls Portslade, NOT Southwick  (1H Victoria semi-fasts)
  //   fast          calls neither
  // An unknown Southwick answer falls to 'stoppingLocal', whose 0006 anchor is the
  // one number with field calibration behind it.
  _eastClass(t) {
    if (t.trainType === 'freight') return 'freight';
    if (t.trainType === 'ecs') return 'ecs';
    if (!this._isStopping(t)) return 'fast';
    return this._callsAtApproachStop(t) === false ? 'stopping' : 'stoppingLocal';
  }

  // The single approach berth for a direction (td.<dir>.approach.from). Used by the
  // westbound rule and by legacy flat east configs; strikes are always keyed by berth.
  _approachBerth(direction) {
    const cfg = this.config && this.config.td &&
      this.config.td[direction === 'east' ? 'eastbound' : 'westbound'];
    return cfg && cfg.approach ? cfg.approach.from : undefined;
  }

  // Measured transit for this train's class between two berths, or null when we have no
  // sample. `XING` is a valid destination (the road crossing / clear step).
  _transit(t, from, to) {
    const byDir = this.transits[t.direction];
    if (!byDir) return null;
    const k = t.direction === 'east' ? this._eastClass(t)
      : (this._isStopping(t) ? 'stopping' : (t.trainType === 'freight' ? 'freight'
        : t.trainType === 'ecs' ? 'ecs' : 'fast'));
    const cell = (byDir[k] || {})[`${from}>${to}`];
    return cell && typeof cell.secs === 'number' ? cell : null;
  }

  // PROJECTED arrival of a train at `berth`, from wherever TD last saw it, using measured
  // transits for its class. This is the sharpening step: every berth the train strikes
  // gives a fresher origin and a tighter spread, and the projection is replaced outright
  // by the real event once it happens.
  //
  // Returns { ts, sdSecs, projected:true, from } or null when we can't project — no live
  // position, no transit sample, or the train is already past `berth`.
  _projectBerth(t, berth, now) {
    if (!t.headcode) return null;
    const live = this.liveTrains.get(t.headcode);
    if (!live || !live.berth || !live.lastSeen) return null;
    if (now.getTime() - live.lastSeen > this._getLiveTtlMs()) return null;
    if (live.berth === berth) return null;              // already there; caller wants the real strike
    const cell = this._transit(t, live.berth, berth);
    if (!cell) return null;
    return { ts: live.lastSeen + cell.secs * 1000, sdSecs: cell.sdSecs, projected: true, from: live.berth };
  }

  // The strike a prediction should use for `berth`: the real one if it has happened,
  // otherwise a projection from the train's current position. Callers that gate a STATE
  // (rather than display a prediction) must use _freshStrike directly — a projection is
  // an estimate, never confirmation.
  _strikeOrProjection(t, berth, now) {
    return this._freshStrike(t, now, berth) || this._projectBerth(t, berth, now);
  }

  // The berth this train's close is anchored to — its class anchor where configured,
  // otherwise the direction's single approach berth.
  _anchorBerthFor(t) {
    const a = this._closeAnchor(t);
    return a ? a.berth : this._approachBerth(t.direction);
  }

  // The close-anchor spec { berth, offsetSecs } for a train, or null when the crossing
  // isn't using per-class anchors (legacy single-berth config).
  _closeAnchor(t) {
    const ct = this.timing && this.timing.closeTrigger && this.timing.closeTrigger[t.direction];
    if (!ct || !ct.classes) return null;
    const spec = ct.classes[t.direction === 'east' ? this._eastClass(t) : null];
    return spec && spec.berth && typeof spec.offsetSecs === 'number' ? spec : null;
  }

  // The train's fresh, direction-matched strike at `berth` (or null). A strike matches
  // only if its recorded direction equals the train's and it is within the TTL. With no
  // berth given, falls back to the legacy per-headcode key (crossings without a chain).
  _freshStrike(t, now, berth) {
    if (!t.headcode) return null;
    const key = berth ? this._strikeKey(t.headcode, berth) : t.headcode;
    const struck = this.closeStrikeSeen.get(key);
    if (struck && struck.direction === t.direction &&
        (now.getTime() - struck.ts) <= CLOSE_STRIKE_TTL_MS) return struck;
    return null;
  }

  // PREDICTED close time (display / countdown target) for a single train. Strike-based
  // once the approach berth has struck; otherwise the live-bestTime prediction. Gated on
  // timing.closeTrigger — absent ⇒ the legacy bestTime − closeBefore, which preserves
  // other crossings and gives a clean rollback.
  //
  //  - EAST: per-class anchor berth + offset (closeTrigger.east.classes — see _eastClass
  //    and the config comment for why 0006 cannot serve every class). Before that berth
  //    strikes, the prediction LEADS the crossing by predictedLeadSecs (~180s, measured),
  //    NOT closeBefore.east (90s). Legacy flat east config (freightSecs/stoppingSecs/
  //    otherSecs on a single approach berth) is still honoured for other crossings.
  //  - WEST stopping passenger → max(strike + stoppingMinAfterStrikeSecs, departure − 45s);
  //    before the strike, departure − 45s. bestTime IS the LDB departure for westbound.
  //  - WEST freight / non-stopping → strike+otherSecs; before the strike, bestTime − closeBefore.west.
  _computeCloseTime(t, now) {
    const ct = this.timing && this.timing.closeTrigger;
    const cbFallback = () => new Date(t.bestTime.getTime() - this._getCloseBefore(t.direction) * 60000);
    if (!ct) return cbFallback();

    const stopping = this._isStopping(t);

    if (t.direction === 'east') {
      const c = ct.east || {};
      const anchor = this._closeAnchor(t);
      if (anchor) {
        // Real strike if it has happened, else project it from wherever TD has the train
        // now. Either way the SAME rule runs on it, so recalibrating offsetSecs moves the
        // projection with it — the engine is the close logic, fed an estimated input.
        const struck = this._strikeOrProjection(t, anchor.berth, now);
        if (struck) return new Date(struck.ts + anchor.offsetSecs * 1000);
      } else {
        // Legacy flat config: one approach berth, class picked by type only. Projected
        // too, so a crossing on the older config shape gets the same sharpening.
        const struck = this._strikeOrProjection(t, this._approachBerth('east'), now);
        const secs = t.trainType === 'freight' ? c.freightSecs
                   : (t.trainType === 'passenger' && stopping) ? c.stoppingSecs
                   : c.otherSecs;                        // non-stopping / ECS / unknown
        if (struck && typeof secs === 'number') return new Date(struck.ts + secs * 1000);
      }
      // Pre-strike east prediction leads the crossing by predictedLeadSecs (measured
      // ~2–3.5 min), not closeBefore — so the countdown doesn't lurch when the strike lands.
      const lead = typeof c.predictedLeadSecs === 'number' ? c.predictedLeadSecs
                 : this._getCloseBefore('east') * 60;
      return new Date(t.bestTime.getTime() - lead * 1000);
    }

    // west — still a single approach berth (0003); no Southwick-equivalent on this side.
    const c = ct.west || {};
    const struck = this._strikeOrProjection(t, this._approachBerth('west'), now);
    if (t.trainType === 'passenger' && stopping && this._hasLiveDeparture(t)) {
      // bestTime IS the LDB departure for westbound (extractTrain: et=etd||eta), so
      // dep − lead is meaningful. The _hasLiveDeparture guard keeps a CIF-sourced
      // westbound caller OUT of this branch: its bestTime is an interpolated CROSSING
      // time, and subtracting a departure lead from it would anchor to the wrong event.
      // Such a train falls through to the baseline below — same as before this became
      // classifiable at all, so no regression, just no longer silently mislabelled.
      const depMinus = new Date(t.bestTime.getTime() - c.stoppingDepartureLeadSecs * 1000);
      if (struck) {
        const floor = struck.ts + c.stoppingMinAfterStrikeSecs * 1000;
        return new Date(Math.max(floor, depMinus.getTime())); // whichever is LATER
      }
      return depMinus;                                   // prediction: departure − 45s
    }
    // west freight / non-stopping / ECS / unknown
    if (struck && typeof c.otherSecs === 'number') return new Date(struck.ts + c.otherSecs * 1000);
    return cbFallback();                                 // baseline until the 0003 strike
  }

  // Where a train currently is on its direction's approach chain: the index in
  // td.<dir>.approachChain of the berth it last stepped into, or null when we don't
  // know (no live position, no chain configured, or it is somewhere else in the TD area).
  _chainIndex(t) {
    const cfg = this.config && this.config.td &&
      this.config.td[t.direction === 'east' ? 'eastbound' : 'westbound'];
    const chain = cfg && cfg.approachChain;
    if (!Array.isArray(chain) || !t.headcode) return null;
    const live = this.liveTrains.get(t.headcode);
    if (!live || !live.berth) return null;
    const i = chain.indexOf(live.berth);
    return i === -1 ? null : i;
  }

  // Is the train known to be still UPSTREAM of the berth its close anchors to? If so the
  // anchor strike simply hasn't happened yet, and firing the bestTime backstop would
  // close the barrier off a timetable estimate for a train we can SEE is not there yet.
  // That is exactly what produced the 2026-07-24 21:42 false CLOSED. Unknown position ⇒
  // false (allow the backstop) — a train we cannot see must still be able to close.
  _upstreamOfAnchor(t) {
    const anchor = this._closeAnchor(t);
    const berth = anchor ? anchor.berth : this._approachBerth(t.direction);
    if (!berth) return false;
    const cfg = this.config.td[t.direction === 'east' ? 'eastbound' : 'westbound'];
    const chain = cfg && cfg.approachChain;
    if (!Array.isArray(chain)) return false;
    const anchorIdx = chain.indexOf(berth);
    const hereIdx = this._chainIndex(t);
    if (anchorIdx === -1 || hereIdx === null) return false;
    return hereIdx < anchorIdx;
  }

  // CONFIRMED close time (gated CLOSED onset) for a single train. Strike-based when
  // struck (identical to the predicted time); otherwise a conservative backstop from the
  // LIVE bestTime (bestTime − safetyNetSecs[dir]), set SMALLER than the anchor's typical
  // lead so the precise strike normally wins and the backstop only fires on a genuinely
  // missed/dropped strike. Never uses scheduledTime — bestTime is the live estimate.
  //
  // The backstop is additionally POSITION-GATED: while TD shows the train still upstream
  // of its anchor berth, the backstop is held off, because we can see the anchor is still
  // to come. Only bestTime drift can put the backstop that early, and bestTime is the
  // least reliable input we have (eastbound crossing→bestTime sd ~55s). Measured missed-
  // strike rate is 0.093%, so deferring to position costs almost nothing.
  _confirmedCloseTime(t, now) {
    const ct = this.timing && this.timing.closeTrigger;
    if (!ct) return this._computeCloseTime(t, now);      // no trigger: confirmed == baseline

    const anchor = this._closeAnchor(t);
    const berth = anchor ? anchor.berth : this._approachBerth(t.direction);
    if (this._freshStrike(t, now, berth)) {
      return this._computeCloseTime(t, now);             // struck: gated onset == predicted
    }

    const c = ct[t.direction] || {};
    if (typeof c.safetyNetSecs === 'number') {
      let backstop = t.bestTime.getTime() - c.safetyNetSecs * 1000;
      // A backstop LATER than the predicted close means the countdown reaches zero while
      // the app still says the crossing is clear. Eastbound that is deliberate — it is
      // what makes the "Soon" state live (safetyNetSecs 145 < predictedLeadSecs 180) —
      // and is opted into per direction. Westbound it was an accident of two unrelated
      // config values (safetyNetSecs 90 vs closeBefore 150), giving every CIF-sourced
      // westbound a 60s window of "clear" after its own predicted barrier-down.
      //
      // Clamping rather than raising safetyNetSecs.west, because one number cannot serve
      // both westbound classes: stoppers predict off departure−45 and non-stoppers off
      // bestTime−150, so raising it to 150 would fix the latter and make CLOSED fire ~2
      // min early for the former.
      if (!c.confirmedMayFollowPredicted) {
        backstop = Math.min(backstop, this._computeCloseTime(t, now).getTime());
      }
      if (this._upstreamOfAnchor(t)) {
        // TD shows the train still short of its anchor berth, so the anchor strike is
        // genuinely still to come — HOLD the gated close in the near future rather than
        // let a drifting bestTime fire CLOSED early. Floored (not just "skip the
        // backstop"): falling through to _computeCloseTime would return the pre-strike
        // prediction bestTime − predictedLeadSecs, which is EARLIER than the backstop
        // now that safetyNet < predictedLead — i.e. the gate would have made CLOSED fire
        // sooner, the exact opposite of its purpose. Releases as soon as the train
        // reaches the anchor, or the strike lands and re-anchors properly.
        return new Date(Math.max(backstop, now.getTime() + CLOSE_HOLD_FLOOR_MS));
      }
      return new Date(backstop);
    }
    return this._computeCloseTime(t, now);               // no backstop configured
  }

  // Predicted open (barrier-up) for a train — the grouping/merge end key, and the
  // basis for a period's raw end before _anchorEndToClearStep runs.
  //
  // A train we have WATCHED clear the crossing is not a prediction any more, so its
  // recorded clear step wins over bestTime + openAfter. This matters because the
  // merge key decides grouping: a train whose bestTime keeps drifting later (an LDB
  // arrival estimate goes stale once the train has actually passed) would otherwise
  // keep projecting an open time into the future and drag the FOLLOWING train into
  // its period, holding the barrier "down" across a gap where it has really lifted.
  // Observed live 2026-07-25: 1S27 cleared 19:07:39 but kept a 19:10:30 openPred off
  // a stale estimate, merging 2Y62 in and producing 2m03s of false barriers-down.
  //
  // Keyed on headcode + TTL only, exactly like _anchorEndToClearStep — deliberately
  // NO direction test, so a train whose direction join missed can't be sidelined.
  // Shortening is safe: callers take max() over the group and _anchorEndToClearStep
  // still owns the final train's end, so an intermediate clear can't end a period early.
  _openPred(t, now) {
    const lagSecs = this._getOpenLagSecs(t.direction, t.trainType);
    const cleared = t.headcode ? this.clearStepSeen.get(t.headcode) : null;
    if (cleared && now && (now.getTime() - cleared.ts) <= CLEAR_STEP_TTL_MS) {
      if (lagSecs != null) return new Date(cleared.ts + lagSecs * 1000);
    }
    // Deliberately NOT projected. Tried and measured worse: this is the GROUPING key, and
    // feeding it an estimate churns which trains merge, so predictedStart (the group
    // minimum) starts coming from the wrong train. Replaying 2026-07-25, projecting here
    // pushed westbound stopper error at T−300s from 62s to 84s while adding nothing
    // eastbound. Grouping wants a stable key more than a sharp one; the displayed open
    // is projected in _anchorEndToClearStep instead, where it can't reorder anything.
    return new Date(t.bestTime.getTime() + this._getOpenAfter(t.direction) * 60000);
  }

  // Compute closure periods from merged train list (sorted by bestTime). Uses the
  // direction-aware grouping when timing.mergeOppositeMaxGapSecs is configured; else
  // the legacy single-window grouping (unchanged for other crossings / rollback).
  _computeClosures(trains, now = new Date()) {
    if (!trains.length) return [];
    if (this.timing && typeof this.timing.mergeOppositeMaxGapSecs === 'number') {
      return this._computeClosuresDirectional(trains, now);
    }

    const periods = [];
    let predStart = null, confStart = null, end = null, currentTrains = [];

    for (const t of trains) {
      const closeTime = this._computeCloseTime(t, now);       // predicted (grouping key)
      const confClose = this._confirmedCloseTime(t, now);     // gated CLOSED onset
      const openTime = this._openPred(t, now);

      if (predStart === null) {
        predStart = closeTime;
        confStart = confClose;
        end = openTime;
        currentTrains = [t];
      } else if (closeTime.getTime() - end.getTime() <= this.timing.consecutiveWindow * 60000) {
        // Merge with current period
        end = new Date(Math.max(end.getTime(), openTime.getTime()));
        currentTrains.push(t);
      } else {
        // New period — anchor the finalised period's end to its final train's clear step
        periods.push(this._makePeriod(confStart, this._anchorEndToClearStep(end, currentTrains, now), currentTrains, predStart));
        predStart = closeTime;
        confStart = confClose;
        end = openTime;
        currentTrains = [t];
      }
    }

    if (predStart) {
      periods.push(this._makePeriod(confStart, this._anchorEndToClearStep(end, currentTrains, now), currentTrains, predStart));
    }

    return periods;
  }

  // Direction-aware grouping (Change 3). Walk trains sorted by bestTime; for each
  // boundary compare this train's predicted close against the previous train's raw
  // predicted open:
  //   gapSecs = (thisClose − prevOpenPred) / 1000        (barrier-up seconds between)
  //   same direction → split ALWAYS, except a true time overlap (gapSecs < 0)
  //   opposite direction → merge iff gapSecs ≤ mergeOppositeMaxGapSecs (incl. overlap)
  // A group is a maximal run where every internal boundary merges (transitive along
  // the chain). Each period carries start = the group's earliest CONFIRMED close (drives
  // CLOSED) and predictedStart = the group's earliest PREDICTED close (drives the
  // countdown / closing-soon); the end is the clear-step-anchored latest predicted open.
  _computeClosuresDirectional(trains, now) {
    const maxGap = this.timing.mergeOppositeMaxGapSecs;
    const ann = trains.map(t => ({
      train: t,
      predClose: this._computeCloseTime(t, now),
      confClose: this._confirmedCloseTime(t, now),
      openPred: this._openPred(t, now),
      struck: !!this._freshStrike(t, now, this._anchorBerthFor(t))
    }));

    const groups = [];
    let cur = null;
    for (const a of ann) {
      if (!cur) { cur = [a]; groups.push(cur); continue; }
      const prev = cur[cur.length - 1];
      const gapSecs = (a.predClose.getTime() - prev.openPred.getTime()) / 1000;
      const sameDir = a.train.direction === prev.train.direction;
      const merge = sameDir ? (gapSecs < 0) : (gapSecs <= maxGap);
      if (merge) cur.push(a);
      else { cur = [a]; groups.push(cur); }
    }

    return groups.map(g => {
      const groupTrains = g.map(a => a.train);
      const predStart = new Date(Math.min(...g.map(a => a.predClose.getTime())));
      const confStart = new Date(Math.min(...g.map(a => a.confClose.getTime())));
      const maxOpenPred = new Date(Math.max(...g.map(a => a.openPred.getTime())));
      const end = this._anchorEndToClearStep(maxOpenPred, groupTrains, now);
      // Is the close that actually gates this period anchored to a physical berth
      // strike, or still a timetable estimate? Read off the train that SET confStart,
      // since that is the one the CLOSED state follows.
      const driver = g.reduce((m, a) => (a.confClose < m.confClose ? a : m), g[0]);
      return this._makePeriod(confStart, end, groupTrains, predStart, driver.struck);
    });
  }

  // start = CONFIRMED close (gated CLOSED onset). predictedStart = PREDICTED close
  // (countdown / closing-soon target); defaults to start for the legacy/no-trigger path.
  // closeConfirmed = the gating close is anchored to a physical berth strike rather than
  // a timetable estimate, so the client can show it without a confidence band instead of
  // inferring that from start === predictedStart, which is only a coincidence of the
  // current arithmetic.
  _makePeriod(start, end, trains, predictedStart = start, closeConfirmed = false) {
    // Determine reason
    let reason = 'single_train';
    if (trains.length > 1) reason = 'merged_consecutive';

    // Count sources
    const sources = new Set(trains.map(t => t.source));
    const hasFreight = trains.some(t => t.trainType === 'freight');
    const hasEcs = trains.some(t => t.trainType === 'ecs');

    return {
      start: start.toISOString(),
      predictedStart: (predictedStart || start).toISOString(),
      closeConfirmed: !!closeConfirmed,
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

  // Per-direction/class OPEN lag (seconds) applied AFTER the TD clear step. Config
  // timing.openLagSecs.<direction>.<passenger|freight>. Class is 'freight' only for
  // trainType 'freight'; ECS and non-stopping passenger use the 'passenger' value
  // (interim, errs late = safe for an opener). Returns null when unconfigured, which
  // disables the clear-step anchor for the crossing (pure bestTime fallback).
  _getOpenLagSecs(direction, trainType) {
    const cfg = this.timing && this.timing.openLagSecs;
    if (!cfg || typeof cfg !== 'object') return null;
    const byDir = cfg[direction];
    if (!byDir || typeof byDir !== 'object') return null;
    const cls = trainType === 'freight' ? 'freight' : 'passenger';
    const secs = byDir[cls];
    return typeof secs === 'number' ? secs : null;
  }

  // Anchor a finalised period's END to the TD clear step of its FINAL train.
  //  - Cleared (clear step recorded, fresh): end = clearStep + openLagSecs[dir][class].
  //    Overrides the bestTime-based end in BOTH directions — earlier if the train ran
  //    early, later if it ran late (the late-running extend is the point of the feature).
  //  - Sighted but NOT yet cleared: never open before it clears — hold the end to the
  //    near future (floored), even if the bestTime-based end has already passed.
  //  - Not TD-sighted: unchanged (bestTime + openAfter fallback).
  // Only the FINAL train is consulted, so an intermediate train's clear step in a
  // merged period can neither shorten nor open the period. Gated entirely on
  // timing.openLagSecs, so crossings without it keep the pure fallback behaviour.
  // The merge grouping upstream still uses the raw bestTime ends, so a late-running
  // extend here only stretches this period's tail (it won't re-group followers).
  _anchorEndToClearStep(end, trains, now) {
    if (!this.timing || !this.timing.openLagSecs) return end;
    const finalTrain = trains[trains.length - 1];
    if (!finalTrain || !finalTrain.headcode) return end;

    const cleared = this.clearStepSeen.get(finalTrain.headcode);
    if (cleared && (now.getTime() - cleared.ts) <= CLEAR_STEP_TTL_MS) {
      const lagSecs = this._getOpenLagSecs(finalTrain.direction, finalTrain.trainType);
      if (lagSecs != null) return new Date(cleared.ts + lagSecs * 1000);
      return end; // configured direction/class missing a value — safe fallback
    }

    // No clear step yet. PROJECT one from wherever TD has the train, and reopen at
    // projectedClear + the same openLagSecs the real anchor would use — so the estimate
    // sharpens berth by berth instead of sitting on a placeholder. Replaces the old
    // `now + OPEN_HOLD_FLOOR_MS` floor, which trailed the clock and made the reopen
    // countdown tick BACKWARDS as it was recomputed.
    const lagSecs = this._getOpenLagSecs(finalTrain.direction, finalTrain.trainType);
    const proj = this._projectBerth(finalTrain, 'XING', now);
    if (proj && lagSecs != null) {
      // Never in the past: the train demonstrably has not cleared, so the barrier cannot
      // be up. A stale projection (train held at a signal past its expected transit) is
      // floored rather than allowed to expire the closure.
      return new Date(Math.max(proj.ts + lagSecs * 1000, now.getTime() + OPEN_HOLD_FLOOR_MS));
    }

    // No projection available (no live position, or no transit sample for this class):
    // fall back to the old behaviour — hold into the near future so a TD-sighted train
    // can never have its closure end before it has cleared.
    if (this.tdSeenToday.has(finalTrain.headcode)) {
      const floorMs = now.getTime() + OPEN_HOLD_FLOOR_MS;
      if (end.getTime() < floorMs) return new Date(floorMs);
    }
    return end;
  }

  // Recompute everything
  _recompute() {
    const now = new Date();
    const merged = this._mergeTrains();
    this.closurePeriods = this._computeClosures(merged, now);

    const oldState = this.state;
    this.state = this._deriveState(now);

    if (this.state !== oldState) {
      this.lastStateChange = now;
      logger.logState(this.id, oldState, this.state, 'recompute');
    }
  }

  // Derive the live state from the computed closure periods at `now`.
  //  - CLOSED is gated on the CONFIRMED close (p.start = strike-based, or the conservative
  //    backstop) so the crossing never shows CLOSED straight off the timetable before the
  //    approach strike (or safety net) confirms it.
  //  - CLOSING_SOON uses the PREDICTED close (p.predictedStart) so the countdown / soon
  //    banner reflects the display prediction (which leads the confirmed close).
  // Since confirmedClose ≤ predictedClose (equal once struck), CLOSED never precedes the
  // period start test, and the countdown never passes zero before CLOSED shows.
  _deriveState(now) {
    const closeTarget = (p) => new Date(p.predictedStart || p.start);
    const currentClosure = this.closurePeriods.find(p =>
      now >= new Date(p.start) && now <= new Date(p.end)
    );
    if (currentClosure) return 'CLOSED';

    // Pick the next period by whether it has STARTED, not by whether its predicted
    // close is still ahead. Since safetyNet < predictedLead eastbound, there is a window
    // where predictedStart has passed but the gating start has not; keying off
    // closeTarget skipped such a period entirely and reported OPEN moments before the
    // barrier came down — in exactly the window the state log exists to capture.
    const nextClosure = this.closurePeriods.find(p => new Date(p.start) > now);
    if (nextClosure && (closeTarget(nextClosure) - now) <= CLOSING_SOON_WINDOW_MS) {
      return 'CLOSING_SOON';
    }
    return 'OPEN';
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
      // Derived per request. closurePeriods only changes on _recompute (LDB poll / TD
      // event), but the passage of time alone changes which period is current — so a
      // stored value goes stale between events while currentClosure/nextClosure below
      // are evaluated against request time, and the two disagreed.
      state: this._deriveState(now),
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
