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
// --- Last-known train cache (see this.knownTrains) ---
// How long a train's record stays available after its source last reported it. Long
// enough to cover a feedback tap well after the train has gone, bounded so a headcode
// reused later in the day can't resolve to this morning's working.
const KNOWN_TRAIN_TTL_MS = 45 * 60 * 1000;
// How many closure periods getApiState returns by default. Was 200 — effectively the whole
// day, 18.4 KB measured, of which the apps display three (public, expandable) and two
// (observer). 89% of every poll was periods nobody was going to look at, and that payload
// is what made a fast poll expensive: at 200 a 10s poll costs 6.6 MB/h per open tab, at 6
// it costs 1.8 MB/h — less than the old 30s poll while refreshing three times as often.
// `?limit=` raises it for "Show More"; `closureCount` tells the client how many exist.
const DEFAULT_CLOSURE_LIMIT = 6;

// --- HELD countdowns (register #14) -------------------------------------------------
//
// There used to be two constants here: OPEN_HOLD_FLOOR_MS (60s) and CLOSE_HOLD_FLOOR_MS
// (30s), floors on how close to `now` a predicted open/close was allowed to sit while we
// waited for the physical trigger. Both are gone, and nothing replaces them with another
// number, because the right value was never arbitrary — it was already measured and
// already in the config:
//
//   close  cannot happen sooner than closeTrigger.<dir>.classes.<class>.offsetSecs after
//          an anchor strike that has not happened yet   (east 20-100s, west 10-61s)
//   open   cannot happen sooner than openLagSecs[<dir>][<class>] after a clear step that
//          has not happened yet                         (east 35/70s, west 18/30s)
//
// Both are the class's own lag from its own trigger, so a held countdown reads as a real
// lower bound and joins continuously to the live value the instant the trigger fires
// (strike + offset ~= now + offset). See _closeTimeInfo and _periodEndInfo.
//
// What made the old floors load-bearing was not the countdown but the STATE: a period
// whose `end` slipped into the past stopped being current in three separate places and
// the app declared the crossing clear with a train still on it. That is now gated on the
// clear step rather than on the clock — see the holdingOpen flag and its three readers.

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

    // "prevHeadcode|nextHeadcode" → ts(ms) of a boundary the overlap pass has already
    // coalesced. Hysteresis for _coalesceOverlapping: a pair we have merged stays merged
    // until the barrier is KNOWN to have lifted between them, so the grouping cannot flap
    // as the two moving estimates either side of it drift past each other. TTL-pruned on
    // write. See _coalesceOverlapping for why a physical event, not a threshold.
    this.coalescedPairs = new Map();

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
    // Prune HERE, on the write, and at the longest horizon any reader uses — not in
    // getLiveTrains, which is a read that two different consumers make for two different
    // reasons (register #14). The map is now a position MEMORY; each reader applies its own
    // tolerance: display and projection want a fresh position (live.ttlSecs, 240s), the
    // CLOSED gate wants to know whether a strike has been missed and is happy with a much
    // older one (CLOSE_STRIKE_TTL_MS, 20 min). Pruning at the shorter of those inside a read
    // is what let a /live poll change what the prediction said.
    this._pruneLiveTrains(ms);
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

  // Drop remembered positions past the longest horizon any reader uses. Called on the
  // write path only — see the note in recordTdBerth for why not on read.
  _pruneLiveTrains(nowMs) {
    const horizon = Math.max(this._getLiveTtlMs(), CLOSE_STRIKE_TTL_MS);
    for (const [headcode, t] of this.liveTrains) {
      if (nowMs - t.lastSeen > horizon) this.liveTrains.delete(headcode);
    }
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
  // A READ. It must not mutate this.liveTrains — see _upstreamOfAnchor. This loop used to
  // delete entries past the display TTL, which meant serving GET /crossing/:id/live (every
  // 2.5s from the observer) destroyed the position evidence the CLOSED gate depends on, and
  // the app's behaviour changed according to whether anyone had the observer open. Filtering
  // here, pruning on the write path (recordTdBerth), and each reader applying its own
  // staleness tolerance is the whole fix (register #14).
  getLiveTrains(now = Date.now()) {
    const ttl = this._getLiveTtlMs();
    const out = [];
    for (const [headcode, t] of this.liveTrains) {
      if (now - t.lastSeen > ttl) continue;               // stale for DISPLAY; still remembered
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
        // The class the PREDICTION used, plus the two flags that decide it. Surfaced so a
        // barrier observation is recorded against the predictor's own discriminator instead
        // of one reconstructed afterwards — an analyst can otherwise only infer "does it stop
        // at the crossing" from protecting-berth dwell, which needs the train to have already
        // crossed and so is unavailable at the moment of a close. trainClass is null when we
        // cannot place the train at all (direction unknown), never a guess.
        trainClass: match && match.direction ? this._classOf(match) : null,
        // Tri-state on purpose: true / false / null, where null means unknowable (no schedule
        // match). Must not collapse to false — "we don't know" and "it doesn't call" select
        // different close anchors.
        //
        // `onBoard` first, mirroring _isStopping: an LDB board lists only CALLING services, so
        // being on it IS the answer, and the LDB poller never sets callsAtStation. Reporting
        // null for LDB trains would leave the field blank for exactly the near-term services
        // the calibration cares about, while _isStopping was answering true all along — the
        // field has to agree with what the predictor used.
        callsAtStation: onBoard ? true
          : (match && match.callsAtStation != null ? match.callsAtStation : null),
        callsAtApproach: match ? this._callsAtApproachStop(match) : null,
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

      // A runs-as-required path with a measured run rate of ZERO, never sighted today, is a
      // timetable entry for a train that does not run. Dropped outright rather than held,
      // because a phantom in the list also bridges merges: on 2026-08-03 the 06:41 group was
      // [1H13, 1N14, 6O40] and the phantom 6O40 sat between two real trains. Requires BOTH
      // conditions — a sighting overrides the rate (a train TD can see is running whatever
      // its history says), and a null rate means no data, not zero.
      if (t.runsAsRequired && t.recentRunRate === 0 && !tdSighting) continue;

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

  // The train's class, for BOTH directions — the single definition of the discriminator the
  // prediction actually uses. Eastbound splits four ways because Southwick sits inside the
  // approach berth (see _eastClass); westbound has no equivalent, so it splits on whether the
  // train calls at the crossing station.
  //
  // This used to be inlined in _transit while _closeAnchor called _eastClass directly — two
  // copies that could drift, and nothing outside could ask "which class did you use?". It is
  // now also surfaced on the B1 live feed so a barrier observation is recorded against the
  // class the predictor picked, rather than one re-derived afterwards by an analyst.
  // `forceClass` is the introspection path, used by getTriggers to ask "what would this rule
  // be FOR class X" without a real train to classify. Explicit, because the alternative was
  // a stub object shaped to fall through the heuristics into the class you wanted — which
  // silently resolved every eastbound class to `fast` when first written, and would have
  // put four of the five map markers in the wrong place.
  _classOf(t) {
    if (t.forceClass) return t.forceClass;
    if (t.direction === 'east') return this._eastClass(t);
    if (this._isStopping(t)) return 'stopping';
    return t.trainType === 'freight' ? 'freight' : t.trainType === 'ecs' ? 'ecs' : 'fast';
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
    const cell = (byDir[this._classOf(t)] || {})[`${from}>${to}`];
    return cell && typeof cell.secs === 'number' ? cell : null;
  }

  // PROJECTED arrival of a train at `berth`, from wherever TD last saw it, using measured
  // transits for its class. This is the sharpening step: every berth the train strikes
  // gives a fresher origin and a tighter spread, and the projection is replaced outright
  // by the real event once it happens.
  //
  // Returns { ts, sdSecs, projected:true, expired, from } or null when we can't project —
  // no live position, no transit sample, or the train is already past `berth`.
  //
  // `expired` is the difference between a projection and a strike, and it is why the close
  // countdown used to walk through zero with no trigger behind it (register #14). A recorded
  // strike is monotone: it happened, and nothing can falsify it. A projection has a shelf
  // life — the instant `now` passes it with no strike, the train has falsified it BY NOT
  // ARRIVING, and continuing to serve it means serving a time in the past. Measured on the
  // 0008 dwell: median 71s, sd 14, so a train still there at 180s is 7.8 sd out. It is not
  // running late, it is STOPPED, and there is nothing in the data that says when it will
  // move. Callers must not fabricate one — see _closeTimeInfo / _periodEndInfo, which
  // switch to the class's own lower bound and say so.
  //
  // `ts` is left UNTOUCHED when expired, deliberately: _mergeTrains drives the
  // late-runner drop rule off it (projected + SIGHTING_DROP_GRACE_MS), and that grace is
  // what stops a held closure lasting forever. Flooring ts here would extend it.
  _projectBerth(t, berth, now) {
    if (!t.headcode) return null;
    const live = this.liveTrains.get(t.headcode);
    if (!live || !live.berth || !live.lastSeen) return null;
    if (now.getTime() - live.lastSeen > this._getLiveTtlMs()) return null;
    if (live.berth === berth) return null;              // already there; caller wants the real strike
    const cell = this._transit(t, live.berth, berth);
    if (!cell) return null;
    const ts = live.lastSeen + cell.secs * 1000;
    return { ts, sdSecs: cell.sdSecs, projected: true, expired: ts < now.getTime(), from: live.berth };
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
    // _classOf, not `east ? _eastClass : null`. A no-op today — west has no `classes` block,
    // so the guard above returns first and the old expression's `null` was never reached. But
    // it means adding west per-class anchors (register #12) works instead of being silently
    // ignored, which the hard-coded null would have caused.
    const spec = ct.classes[this._classOf(t)];
    if (!spec || !spec.berth) return null;

    // An explicit offsetSecs wins (east is calibrated per class from barrier observations).
    if (typeof spec.offsetSecs === 'number') return spec;

    // Otherwise DERIVE it: offset = transit[berth>XING] - crossingLeadSecs. Two reasons to
    // compute this rather than store the arithmetic's result. The transit table is regenerated
    // from TD data (scripts/derive-transits.js), so a hand-copied constant would silently drift
    // away from the measurement it came from. And it collapses one calibrated number
    // (crossingLeadSecs, the observed barrier lead before the crossing) plus a measured table
    // into every class, instead of four magic numbers that have to be recomputed by hand
    // whenever either input moves.
    if (typeof ct.crossingLeadSecs !== 'number') return null;
    const cell = this._transit(t, spec.berth, 'XING');
    if (!cell) return null;                              // no sample for this class+berth
    return { berth: spec.berth, offsetSecs: Math.round(cell.secs - ct.crossingLeadSecs),
             derived: true, transitSecs: cell.secs, transitSd: cell.sdSecs };
  }

  // Has TD seen this headcode AT ALL today? Deliberately not TTL-gated and not direction-
  // matched: the question is "does this train exist in the real world", not "where is it
  // now". tdSeenToday is seeded from the day's TD log at boot (seedSightings), so a restart
  // does not make every train look unsighted. Either map counts — they are fed by the same
  // TD events but written by different hooks, and a train with a known BERTH has
  // self-evidently been seen.
  _everSighted(t) {
    if (!t.headcode) return false;
    return this.tdSeenToday.has(t.headcode) || this.liveTrains.has(t.headcode);
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
  //  - WEST stopping passenger → max(strike + minAfterStrikeSecs, departure − 45s);
  //    before the strike, departure − 45s. bestTime IS the LDB departure for westbound.
  //  - WEST freight / non-stopping → strike+otherSecs; before the strike, bestTime − closeBefore.west.
  //
  // Thin wrapper over _closeTimeInfo, which carries the `held` flag alongside the time.
  // Kept because several callers only want the Date, and re-deriving `held` at each of
  // them would be the same predicate written four times.
  _computeCloseTime(t, now) {
    return this._closeTimeInfo(t, now).at;
  }

  // { at: Date, held: bool }. `held` means the anchor strike has NOT happened and the
  // projection of it has expired, so `at` is a LOWER BOUND (now + the class's own offset),
  // not a prediction — the client renders it as "held" rather than counting it down.
  _closeTimeInfo(t, now) {
    const ct = this.timing && this.timing.closeTrigger;
    const cbFallback = () => ({ at: new Date(t.bestTime.getTime() - this._getCloseBefore(t.direction) * 60000), held: false });
    if (!ct) return cbFallback();

    const stopping = this._isStopping(t);

    // Apply a class offset to its anchor. Three cases, and the third is register #14:
    //   real strike       -> strike + offset. Known to the second, monotone, not held.
    //   live projection   -> projected strike + offset. A genuine prediction; it sharpens
    //                        on every berth step and is replaced by the real strike.
    //   EXPIRED projection-> the train should have struck by now and hasn't, so we no longer
    //                        know when it will. Serve the only remaining true statement —
    //                        the close cannot come sooner than `offset` after a strike, and
    //                        the strike has not happened — and flag it as a bound.
    // The third case joins continuously to the first: holding at now+offset means that when
    // the strike finally lands, strike+offset is where the countdown already was.
    const anchored = (struck, offsetSecs, floorSecs) => {
      const held = !!(struck && struck.expired);
      const base = held ? now.getTime() : struck.ts;
      return {
        at: new Date(Math.max(base + offsetSecs * 1000, base + (floorSecs || 0) * 1000)),
        held
      };
    };

    // Final guard on every UNSTRUCK fall-back path below, and the last hole in #14.
    // `anchored` above only fires when we can still project; once the position is older
    // than the live TTL _projectBerth returns null rather than an expired projection, so
    // the code dropped to the timetable lead — and for a train held long enough, that lead
    // is already in the past, which is the "Soon with no trigger" symptom all over again
    // (reproduced at a 300s dwell). But we have not actually lost the train: the CLOSED
    // gate can still place it short of its anchor for a full 20 minutes. Whenever it can,
    // the same bound holds — no strike means no close for at least the class's own offset.
    const boundIfUpstream = (info) => {
      if (info.held) return info;
      const spec = this._closeAnchor(t);
      if (!spec || typeof spec.offsetSecs !== 'number') return info;
      if (this._freshStrike(t, now, spec.berth)) return info;
      if (!this._upstreamOfAnchor(t, now)) return info;   // can't place it ⇒ no claim to make
      const floor = now.getTime() + spec.offsetSecs * 1000;
      return info.at.getTime() >= floor ? info : { at: new Date(floor), held: true };
    };

    if (t.direction === 'east') {
      const c = ct.east || {};
      const anchor = this._closeAnchor(t);
      if (anchor) {
        // Real strike if it has happened, else project it from wherever TD has the train
        // now. Either way the SAME rule runs on it, so recalibrating offsetSecs moves the
        // projection with it — the engine is the close logic, fed an estimated input.
        const struck = this._strikeOrProjection(t, anchor.berth, now);
        if (struck) return anchored(struck, anchor.offsetSecs);
      } else {
        // Legacy flat config: one approach berth, class picked by type only. Projected
        // too, so a crossing on the older config shape gets the same sharpening.
        const struck = this._strikeOrProjection(t, this._approachBerth('east'), now);
        const secs = t.trainType === 'freight' ? c.freightSecs
                   : (t.trainType === 'passenger' && stopping) ? c.stoppingSecs
                   : c.otherSecs;                        // non-stopping / ECS / unknown
        if (struck && typeof secs === 'number') return anchored(struck, secs);
      }
      // Pre-strike east prediction leads the crossing by predictedLeadSecs (measured
      // ~2–3.5 min), not closeBefore — so the countdown doesn't lurch when the strike lands.
      const lead = typeof c.predictedLeadSecs === 'number' ? c.predictedLeadSecs
                 : this._getCloseBefore('east') * 60;
      return boundIfUpstream({ at: new Date(t.bestTime.getTime() - lead * 1000), held: false });
    }

    // ---- west: berth-anchored per class, same shape as east (register #12) --------------
    //
    // This used to be `departure − 45s`. bestTime IS the LDB departure for westbound
    // (extractTrain: et=etd||eta), which made it meaningful — but Darwin publishes it to the
    // MINUTE, so the close moved in 60s jumps while the period end moved smoothly off the
    // second-precision berth projection. Once they disagreed by more than their gap the order
    // inverted and a closure was predicted to OPEN before it CLOSED (#12), with "Down For"
    // blank. The jumps were also plainly janky on screen for a single train.
    //
    // Measured over n=771 westbound crossings (berth strikes and ldb estimates against the
    // true crossing, the TD 0005→0007 step), as a predictor of the crossing:
    //     0005 strike   sd 19.6s        liveDep   sd 48.8s
    //     0003 strike   sd 21.7s        schedDep  sd 253s
    // Berths beat the departure estimate 2.5x. 0003 over 0005 despite the marginally worse sd
    // because it fires early enough to be useful and stays feasible for every class.
    //
    // Deliberately NO dwell term, though the west platform sits inside the protecting berth and
    // it looks like there should be one. Three measurements say otherwise: CIF booked dwell has
    // only two values (30/60s) against realised 0-180s; refitting on booked gave sd 61s, WORSE
    // than the old rule; and subtracting LIVE dwell doubled sd (13.5→25.8s) because it is the
    // difference of two minute-rounded times. A raw 0005→XING sd of 19.6s cannot contain
    // minutes of dwell variance — there is nothing left to remove.
    //
    // Pre-strike (TD cannot place the train at all) keeps a bestTime-based lead, mirroring
    // east's predictedLeadSecs — see the note at the fall-through below. Dropping straight to
    // cbFallback() there was a silent regression: it moved an unplaceable west train's close
    // 105s earlier and re-merged the periods the clear-step merge key exists to separate.
    const c = ct.west || {};
    const anchor = this._closeAnchor(t);            // resolves via _classOf, so west.classes works
    if (anchor) {
      const struck = this._strikeOrProjection(t, anchor.berth, now);
      if (struck) {
        // Floor a short way after the strike. An offset is positive by construction (it is
        // transit[berth>XING] − lead, and a berth whose offset went negative was moved to an
        // earlier anchor in config), but it can be very small — `fast` derives +2s — and a
        // projection carries error, so this stops a close landing on top of, or before, the
        // strike that anchored it. It BINDS for fast (2s -> 10s), which is deliberate: at that
        // margin our own pipeline latency is the larger term anyway.
        return anchored(struck, anchor.offsetSecs, c.minAfterStrikeSecs);
      }
    }

    // No berth anchor and no position: lead bestTime, exactly as east does pre-strike. WHICH
    // lead depends on what bestTime MEANS, and it differs by source — this is why the old code
    // had a _hasLiveDeparture guard, and removing it was wrong:
    //   LDB westbound  bestTime = etd||eta, i.e. the DEPARTURE estimate -> lead by ~46s
    //                  (crossing is dep+46s measured, and the close is crossing-92s)
    //   CIF westbound  bestTime = an interpolated CROSSING time          -> lead by the full 92s
    // Subtracting a departure lead from an interpolated crossing time would anchor to the wrong
    // event, which is the trap the original guard was protecting against.
    const isDeparture = typeof t.source === 'string' && t.source.startsWith('ldb');
    const lead = isDeparture
      ? (typeof c.predictedDepartureLeadSecs === 'number' ? c.predictedDepartureLeadSecs : null)
      : (typeof c.crossingLeadSecs === 'number' ? c.crossingLeadSecs : null);
    if (lead !== null) return boundIfUpstream({ at: new Date(t.bestTime.getTime() - lead * 1000), held: false });
    return boundIfUpstream(cbFallback());
  }

  // Where a train currently is on its direction's approach chain: the index in
  // td.<dir>.approachChain of the berth it last stepped into, or null when we don't
  // know (no live position, no chain configured, or it is somewhere else in the TD area).
  //
  // `maxAgeMs` is the caller's own staleness tolerance, because the two callers want
  // genuinely different things and conflating them was a bug (register #14). A PROJECTION
  // needs a recent position — a 10-minute-old berth says nothing about where the train is
  // now — so it passes the live display TTL. The CLOSED gate is asking a different
  // question: "do we have any reason to believe the anchor strike has already happened?"
  // A position from 10 minutes ago, with no strike recorded since, is strong evidence that
  // it has NOT, because approach strikes miss 14 times in 15,064 crossings (0.093%). So
  // the gate passes the strike TTL — the same window over which it would trust a strike
  // record, since trusting the absence of one is the same fact.
  _chainIndex(t, maxAgeMs, now) {
    const cfg = this.config && this.config.td &&
      this.config.td[t.direction === 'east' ? 'eastbound' : 'westbound'];
    const chain = cfg && cfg.approachChain;
    if (!Array.isArray(chain) || !t.headcode) return null;
    const live = this.liveTrains.get(t.headcode);
    if (!live || !live.berth) return null;
    if (maxAgeMs != null) {
      const nowMs = now instanceof Date ? now.getTime() : (now || Date.now());
      if (nowMs - live.lastSeen > maxAgeMs) return null;
    }
    const i = chain.indexOf(live.berth);
    return i === -1 ? null : i;
  }

  // Is the train known to be still UPSTREAM of the berth its close anchors to? If so the
  // anchor strike simply hasn't happened yet, and firing the bestTime backstop would
  // close the barrier off a timetable estimate for a train we can SEE is not there yet.
  // That is exactly what produced the 2026-07-24 21:42 false CLOSED. Unknown position ⇒
  // false (allow the backstop) — a train we cannot see must still be able to close.
  //
  // Register #14: this gate used to be decided by WHO HAD CALLED THE API. It read
  // liveTrains, and getLiveTrains DELETED entries past the 240s display TTL as a side
  // effect of serving GET /crossing/:id/live — which the observer polls every 2.5s. So a
  // train held short of its anchor for over 4 minutes stopped being "visibly upstream",
  // the gate opened, and CLOSED fired off bestTime with no strike anywhere — but only if
  // someone happened to have the observer open. Reproduced deterministically before the
  // fix. Now: the read no longer mutates (see getLiveTrains), and this asks for the
  // position on the strike TTL rather than the display TTL.
  //
  // Deliberately NO timer on the hold. It releases on the train's own next berth step —
  // the moment it reaches the anchor, hereIdx stops being upstream and the strike lands
  // anyway — so a held closure resolves itself on a physical event rather than expiring.
  _upstreamOfAnchor(t, now) {
    const anchor = this._closeAnchor(t);
    const berth = anchor ? anchor.berth : this._approachBerth(t.direction);
    if (!berth) return false;
    const cfg = this.config.td[t.direction === 'east' ? 'eastbound' : 'westbound'];
    const chain = cfg && cfg.approachChain;
    if (!Array.isArray(chain)) return false;
    const anchorIdx = chain.indexOf(berth);
    const hereIdx = this._chainIndex(t, CLOSE_STRIKE_TTL_MS, now);
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
      // Never TD-sighted today ⇒ the same hold, for a stronger reason. _upstreamOfAnchor can
      // only answer for a train TD has PLACED; one it has never seen at all falls through it
      // and the bestTime backstop fires unopposed, so CLOSED comes straight off the timetable.
      // That is the hole the 2026-07-26 restart incident came through (see seedSightings), but
      // a restart was never required to reach it. Observed unprompted 2026-08-03: 1H92
      // (06:41:38, 146s before the real train 1H07 reached 0006) and 6O40 (08:19:07), both
      // tdSeen:false, both driving BARRIERS DOWN. Audited against the raw TD log, a real
      // sighted train covered each closure, so holding loses no closure — it only stops one
      // being asserted from the timetable and attributed to a phantom.
      //
      // Holding rather than dropping the period keeps the countdown: the prediction is
      // untouched, so an unsighted train still reaches CLOSING_SOON.
      if (this._upstreamOfAnchor(t, now) || !this._everSighted(t)) {
        // TD shows the train still short of its anchor berth, so the anchor strike is
        // genuinely still to come — HOLD the gated close rather than let a drifting
        // bestTime fire CLOSED early. Floored (not just "skip the backstop"): falling
        // through to _computeCloseTime would return the pre-strike prediction
        // bestTime − predictedLeadSecs, which is EARLIER than the backstop now that
        // safetyNet < predictedLead — i.e. the gate would have made CLOSED fire sooner,
        // the exact opposite of its purpose.
        //
        // The floor used to be a flat now+30s, which still let CLOSED fire up to two
        // minutes before the train's own predicted close. It is now the two things that
        // are actually true while the anchor is unstruck, whichever is later:
        //   - the predicted close itself — CLOSED must not precede the countdown, and
        //   - now + offsetSecs — the close cannot come sooner than the class's own lag
        //     after a strike that has not happened (register #14; same bound the
        //     predicted close holds at, so the two agree while held).
        // Releases as soon as the train reaches the anchor, or the strike lands and
        // re-anchors properly. No timer: a physical event ends the hold, not a clock.
        const offsetSecs = anchor && typeof anchor.offsetSecs === 'number' ? anchor.offsetSecs : 0;
        const held = Math.max(
          backstop,
          this._closeTimeInfo(t, now).at.getTime(),
          now.getTime() + offsetSecs * 1000
        );
        // An unsighted train has no confirmed close AT ALL, so its bound must stay strictly
        // ahead of `now`. Without this, a crossing configured without per-class anchors has
        // offsetSecs 0, the hold lands exactly on `now`, and CLOSED fires regardless.
        // safetyNetSecs is the direction's own missed-strike lag. Applied ONLY to the
        // unsighted case, so the upstream hold keeps its existing value everywhere else.
        if (!this._everSighted(t)) {
          const lag = typeof c.safetyNetSecs === 'number' ? c.safetyNetSecs : 60;
          return new Date(Math.max(held, now.getTime() + lag * 1000));
        }
        return new Date(held);
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
    // RUNG 2 (2026-08-05) — project the clear step from wherever TD has the train now.
    //
    // This used to read "deliberately NOT projected", on the grounds that grouping wants a
    // stable key more than a sharp one: replaying 2026-07-25, projecting here pushed
    // westbound stopper error at T−300s from 62s to 84s. That evidence is kept but no longer
    // decisive, for three measured reasons:
    //
    //  1. It was a SECOND-ORDER result. Projecting did not make the open worse; it changed
    //     which trains merged, which changed the group minimum, which moved the CLOSE. The
    //     finding was "grouping is fragile to key changes", not "a projected open is bad".
    //  2. The baseline it was measured against was broken. openAfter was +30s in BOTH
    //     directions with no provenance, against a measured east median of −21s
    //     (station-anchored, n=100) — so every east closure ran ~50s long and the A/B was
    //     scored against a key that was already wrong.
    //  3. The projection is accurate, and it TIGHTENS as the train advances. Leave-one-out
    //     over 8 days / 2,921 train-days, p50 absolute error predicting the clear strike:
    //       east stopping       0016 26s → 0008 18s → 0006 16s → 0004 10s
    //       east stoppingLocal  0016 52s → 0008 36s → 0006 35s → 0004 20s
    //       west stopping       T677 33s → 0001 22s → 0003 12s → 0005  9s
    //     At the anchor berths that matter that is at or inside the 20s merge threshold, and
    //     3–5× better than the constant it replaces. It is also STABLER: it does not move
    //     when Darwin revises bestTime by ±2 min, which is what makes the base grouping pass
    //     flip (register C1: 11 of 112 trains, 9 within 10 min of the closure).
    //
    // `XING` in transits.json IS the clear-berth strike (the 0004→0002 / 0005→0007 step —
    // see the naming warning in derive-transits.js), so barrier-up is that projection plus
    // openLagSecs, the rear-of-train circuit clear. No new data was needed for this.
    //
    // Read straight off _projectBerth rather than via bestTime, deliberately: bestTime is
    // only TD-projected for CIF trains (_mergeTrains), so going through it would leave every
    // LDBSVWS train — most near-term passenger traffic — on the timetable rung forever.
    //
    // An EXPIRED projection must not be used as-is — it puts the open in the past. It must not
    // fall through to the timetable rung either: that can move the open EARLIER, and a train we
    // can see has not cleared cannot have an earlier barrier-up. Falling through made this key
    // jump ~40s BACKWARDS mid-approach, the wrong direction for a grouping key. Held at
    // now + openLagSecs — the only thing still true while the clear step is outstanding, and the
    // same bound the close holds at (boundIfUpstream). Monotone: the key never walks back.
    if (lagSecs != null && now) {
      const proj = this._projectBerth(t, 'XING', now);
      if (proj) {
        return new Date(proj.expired
          ? now.getTime() + lagSecs * 1000
          : proj.ts + lagSecs * 1000);
      }
    }

    // RUNG 3 — timetable fallback, anchored per source. Only reached with no live berth.
    return new Date(t.bestTime.getTime() + this._getOpenAfterSecs(t.direction, t.source) * 1000);
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
        // `?? 1.5` so a crossing that omits consecutiveWindow falls back rather than
        // comparing against NaN (which is false, i.e. never merges — a silent behaviour
        // change). Portslade omits it: it uses the directional grouping above, and the key
        // sat in its config for weeks looking live while nothing read it.
      } else if (closeTime.getTime() - end.getTime() <= (this.timing.consecutiveWindow ?? 1.5) * 60000) {
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
    const ann = trains.map(t => {
      const ci = this._closeTimeInfo(t, now);
      return {
        train: t,
        predClose: ci.at,
        closeHeld: ci.held,
        confClose: this._confirmedCloseTime(t, now),
        openPred: this._openPred(t, now),
        struck: !!this._freshStrike(t, now, this._anchorBerthFor(t))
      };
    });

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

    this._coalesceOverlapping(groups, now);

    return groups.map(g => {
      const groupTrains = g.map(a => a.train);
      const predStart = new Date(Math.min(...g.map(a => a.predClose.getTime())));
      const confStart = new Date(Math.min(...g.map(a => a.confClose.getTime())));
      const maxOpenPred = new Date(Math.max(...g.map(a => a.openPred.getTime())));
      const endInfo = this._periodEndInfo(maxOpenPred, groupTrains, now);
      // Is the close that actually gates this period anchored to a physical berth
      // strike, or still a timetable estimate? Read off the train that SET confStart,
      // since that is the one the CLOSED state follows.
      const driver = g.reduce((m, a) => (a.confClose < m.confClose ? a : m), g[0]);
      // closePending: the close that gates this period is a HELD lower bound, not a
      // prediction — the client renders it as held rather than counting it down.
      const closer = g.reduce((m, a) => (a.predClose < m.predClose ? a : m), g[0]);
      return this._makePeriod(confStart, endInfo.at, groupTrains, predStart, driver.struck,
        { closePending: !!closer.closeHeld, holdingOpen: endInfo.holdingOpen });
    });
  }

  // Register #15 — re-ask the grouping question against the ANCHORED ends.
  //
  // The grouping above compares each train's close with the previous train's RAW openPred
  // (bestTime + openAfter, or a recorded clear step). The end a user actually sees is
  // computed afterwards by _periodEndInfo, which can push it much later — hold-until-
  // cleared, or the open-lag bound while a train sits short of the crossing. Nothing then
  // re-checked the grouping, so the API could assert both "barrier lifts at 18:46:03" and
  // "barrier drops at 18:45:51". Observed in the field 2026-08-01 and reproduced against
  // the shipped config: BARRIERS DOWN, next close +28s, next open +40s.
  //
  // Merge-only, and iterated to a fixed point because merging changes which train is
  // final, and therefore the end. It cannot split a group the base pass produced, so it
  // is NOT the measured-worse "projecting the merge key" (which fed an estimate to the
  // grouping key itself and churned which trains merged in both directions, pushing
  // westbound stopper error 62s -> 84s). This only ever joins two periods that would
  // otherwise render as barrier-up-then-instantly-down.
  //
  // Physically: Boundary Road is MCB-CCTV. A signaller watching a second train's close
  // land inside the first train's hold does not raise and immediately re-lower — they
  // hold. One closure is what actually happens on the ground.
  _coalesceOverlapping(groups, now) {
    // Bounded by the number of merges possible; each pass removes at least one group.
    for (let guard = groups.length; guard > 0 && groups.length > 1; guard--) {
      let merged = false;
      for (let i = 0; i < groups.length - 1; i++) {
        const prev = groups[i], next = groups[i + 1];
        const prevTrains = prev.map(a => a.train);
        const prevEnd = this._periodEndInfo(
          new Date(Math.max(...prev.map(a => a.openPred.getTime()))), prevTrains, now).at.getTime();
        // The next period's barrier-down moment, whichever of its two closes comes first:
        // predictedStart drives the countdown, start drives CLOSED, and either landing
        // before the previous end is the inversion.
        // The next period's barrier-down moment, whichever of its two closes comes first:
        // predictedStart drives the countdown, start drives CLOSED, and either landing
        // before the previous end is the inversion.
        //
        // REVERTED 2026-08-05. Making this pass apply the 20s / true-overlap rule against the
        // anchored end — so the rule decided once, on displayed quantities — replayed WORSE:
        // over all 6,538 recorded samples of 3 Aug the grouping changed in 83.4% of them and
        // the dominant direction was MORE merging (4,642 samples with fewer periods against
        // 246 with more). _periodEndInfo pushes the anchored end later than the raw openPred
        // (hold-until-cleared, open-lag floors), so every gap shrinks. 263 unit tests passed
        // throughout and caught none of it. See the merge-rule note in memory before retrying:
        // the approach needs the hysteresis below replaced with a confirmation rule first,
        // because moving all merging into this pass makes that latch universal.
        const nextClose = Math.min(
          ...next.map(a => Math.min(a.predClose.getTime(), a.confClose.getTime())));
        if (nextClose > prevEnd) continue;
        if (this._barrierKnownToLift(prev, next, now)) continue;
        groups[i] = prev.concat(next);
        groups.splice(i + 1, 1);
        this._rememberCoalesced(prev, next, now);
        merged = true;
        break;
      }
      if (!merged) break;
    }
    // Hysteresis. Without it this pass can flap: while a train is held the end bound moves
    // with the clock and sweeps across the following close (merge), and an LDB revision
    // moving that close by a minute sweeps it back (split). That is C1's failure mode —
    // merged<->split oscillating 5-6x per pair, wrong 72-82% of the time — and the fix
    // there was the same one as here: let a PHYSICAL event decide, not an arithmetic
    // threshold on two moving estimates. A pair we have already coalesced stays coalesced
    // until the earlier train's clear step is recorded, i.e. until the barrier is known to
    // have lifted between them.
    for (let i = 0; i < groups.length - 1; i++) {
      const prev = groups[i], next = groups[i + 1];
      if (!this._wasCoalesced(prev, next, now)) continue;
      if (this._barrierKnownToLift(prev, next, now)) continue;
      groups[i] = prev.concat(next);
      groups.splice(i + 1, 1);
      i--;
    }
  }

  // Do we have physical evidence the barrier came up between these two groups? Only a
  // recorded clear step counts: the earlier group's final train has cleared, and the later
  // group's close falls after that clear step + its open lag. Anything else is two
  // estimates being compared, which is what we are trying to stop deciding this.
  _barrierKnownToLift(prev, next, now) {
    const finalTrain = prev[prev.length - 1].train;
    if (!finalTrain || !finalTrain.headcode) return false;
    const cleared = this.clearStepSeen.get(finalTrain.headcode);
    if (!cleared || (now.getTime() - cleared.ts) > CLEAR_STEP_TTL_MS) return false;
    const lagSecs = this._getOpenLagSecs(finalTrain.direction, finalTrain.trainType) || 0;
    const liftedAt = cleared.ts + lagSecs * 1000;
    const nextClose = Math.min(
      ...next.map(a => Math.min(a.predClose.getTime(), a.confClose.getTime())));
    return nextClose > liftedAt;
  }

  _coalesceKey(prev, next) {
    return `${prev[prev.length - 1].train.headcode || '?'}|${next[0].train.headcode || '?'}`;
  }
  _rememberCoalesced(prev, next, now) {
    this.coalescedPairs.set(this._coalesceKey(prev, next), now.getTime());
    for (const [k, ts] of this.coalescedPairs) {
      if (now.getTime() - ts > CLEAR_STEP_TTL_MS) this.coalescedPairs.delete(k);
    }
  }
  _wasCoalesced(prev, next, now) {
    const ts = this.coalescedPairs.get(this._coalesceKey(prev, next));
    return ts != null && (now.getTime() - ts) <= CLEAR_STEP_TTL_MS;
  }

  // start = CONFIRMED close (gated CLOSED onset). predictedStart = PREDICTED close
  // (countdown / closing-soon target); defaults to start for the legacy/no-trigger path.
  // closeConfirmed = the gating close is anchored to a physical berth strike rather than
  // a timetable estimate, so the client can show it without a confidence band instead of
  // inferring that from start === predictedStart, which is only a coincidence of the
  // current arithmetic.
  // closePending / holdingOpen (register #14) say that the corresponding time is a HELD
  // LOWER BOUND rather than a prediction: the physical trigger has not fired and the
  // projection of it has expired, so the value is "no sooner than this", recomputed against
  // now. Two consequences for a client: render it as held rather than counting it down, and
  // — for holdingOpen — keep treating the period as current past its `end`, because the
  // closure ends when the clear step lands, not when the clock runs out.
  _makePeriod(start, end, trains, predictedStart = start, closeConfirmed = false, held = {}) {
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
      closePending: !!held.closePending,
      holdingOpen: !!held.holdingOpen,
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

  // Legacy MINUTES form. typeof, not `||` — an explicit 0 is a legitimate value and
  // `oa[direction] || 0.5` silently turned it into +30s, which would have made an east
  // setting of 0 a no-op.
  _getOpenAfter(direction) {
    const oa = this.timing.openAfter;
    if (oa && typeof oa === 'object') {
      return typeof oa[direction] === 'number' ? oa[direction] : 0.5;
    }
    return typeof oa === 'number' ? oa : 0.5;
  }

  // Far-out OPEN fallback in SECONDS — the BOTTOM rung of the barrier-up ladder, used only
  // until TD gives us a clear step (and, once the missing middle rung lands, only until we
  // can project one). Seconds to match every other timing constant in this config
  // (openLagSecs, safetyNetSecs, crossingLeadSecs, predictedLeadSecs); openAfter's minutes
  // are the legacy outlier, kept as the fallback so other crossings and the rollback path
  // are untouched.
  //
  // Portslade 2026-08-05: east 0s, west +35s. Measured against the clear-step-anchored open
  // over the 3 Aug audit as east median −21s / west +55s (n=100) — but deliberately rounded,
  // because that sample is STATION-anchored (LDB bestTime dominates near-term passenger)
  // while CIF trains carry a CROSSING-anchored bestTime, so no single value is strictly
  // correct for both and false precision would be misleading. Both signs read correctly
  // against the geometry: eastbound crosses the road BEFORE reaching the platform (so its
  // barrier is up at or before its station time), westbound departs the platform and then
  // crosses (so its barrier is up after).
  // Split by what THIS TRAIN'S bestTime is anchored to, because one offset cannot serve both
  // sources and the gap between them is ~60s eastbound:
  //   CIF   → bestTime is estimatedCrossingMins, or _projectBerth('XING') once a berth
  //           exists, both at/near the crossing ⇒ the open is bestTime + openLagSecs.
  //   LDBSV → bestTime is Darwin's time at Portslade STATION. Eastbound the crossing is
  //           BEFORE the platform, so the barrier is already up when bestTime arrives and
  //           the offset is NEGATIVE. Applying the CIF value here would land it 61s late.
  // Tested on 'cif' rather than on the LDB label because the poller has used both 'ldb' and
  // 'ldbsv'; anything that is not CIF is station-anchored. Accepts the older flat
  // per-direction shape too, so other crossings and the rollback path are untouched.
  _getOpenAfterSecs(direction, source) {
    const oas = this.timing.openAfterSecs;
    if (oas && typeof oas === 'object') {
      const bucket = source === 'cif' ? oas.crossingAnchored : oas.stationAnchored;
      if (bucket && typeof bucket[direction] === 'number') return bucket[direction];
      if (typeof oas[direction] === 'number') return oas[direction];
    }
    if (typeof oas === 'number') return oas;
    return this._getOpenAfter(direction) * 60;
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

  // Anchor a finalised period's END to the TD clear step of its FINAL train. Thin wrapper
  // over _periodEndInfo for callers that only want the Date.
  _anchorEndToClearStep(end, trains, now) {
    return this._periodEndInfo(end, trains, now).at;
  }

  // { at: Date, holdingOpen: bool }.
  //  - Cleared (clear step recorded, fresh): end = clearStep + openLagSecs[dir][class].
  //    Overrides the bestTime-based end in BOTH directions — earlier if the train ran
  //    early, later if it ran late (the late-running extend is the point of the feature).
  //  - Sighted but NOT yet cleared: the barrier physically cannot be up, so the period is
  //    HOLDING OPEN — `at` is a lower bound and the flag says so.
  //  - Not TD-sighted: unchanged (bestTime + openAfter fallback).
  // Only the FINAL train is consulted, so an intermediate train's clear step in a
  // merged period can neither shorten nor open the period. Gated entirely on
  // timing.openLagSecs, so crossings without it keep the pure fallback behaviour.
  //
  // The old code floored a held end at `now + 60s` (OPEN_HOLD_FLOOR_MS). Two things were
  // wrong with that. The number was arbitrary — sized to exceed the client's poll interval
  // rather than measured — and because it was recomputed against `now` every pass, the
  // "Next Open" countdown SAT FROZEN at 60s instead of decaying, which is also how it
  // overtook the following period's close (register #15). The bound is now the class's own
  // measured openLagSecs: the barrier cannot rise until that long after a clear step that
  // has not happened. East passenger 35s, west passenger 18s — n=11, 31 Jul.
  //
  // What made the flat floor load-bearing was never the countdown, it was the STATE: an
  // `end` in the past stops the period being current, and the app declares the crossing
  // clear with a train still on it. That is what holdingOpen fixes, at its three readers —
  // which is what lets the bound here be the honest small number instead of a safe big one.
  //
  // Cannot hold forever: _mergeTrains drops a sighted train SIGHTING_DROP_GRACE_MS (3 min)
  // past its projected crossing, and a period with no trains ceases to exist.
  _periodEndInfo(end, trains, now) {
    const plain = (at) => ({ at, holdingOpen: false });
    if (!this.timing || !this.timing.openLagSecs) return plain(end);
    const finalTrain = trains[trains.length - 1];
    if (!finalTrain || !finalTrain.headcode) return plain(end);

    const cleared = this.clearStepSeen.get(finalTrain.headcode);
    if (cleared && (now.getTime() - cleared.ts) <= CLEAR_STEP_TTL_MS) {
      const lagSecs = this._getOpenLagSecs(finalTrain.direction, finalTrain.trainType);
      if (lagSecs != null) return plain(new Date(cleared.ts + lagSecs * 1000));
      return plain(end); // configured direction/class missing a value — safe fallback
    }

    // No clear step yet. PROJECT one from wherever TD has the train, and reopen at
    // projectedClear + the same openLagSecs the real anchor would use — so the estimate
    // sharpens berth by berth instead of sitting on a placeholder.
    const lagSecs = this._getOpenLagSecs(finalTrain.direction, finalTrain.trainType);
    const proj = this._projectBerth(finalTrain, 'XING', now);
    if (proj && lagSecs != null) {
      const at = proj.ts + lagSecs * 1000;
      // A live projection is a real prediction and is used as-is. An EXPIRED one (the train
      // should have crossed by now and has not) has been falsified, so fall back to the
      // bound: at least one open lag from now, and holding until the clear step lands.
      if (!proj.expired && at > now.getTime()) return plain(new Date(at));
      return { at: new Date(now.getTime() + lagSecs * 1000), holdingOpen: true };
    }

    // No projection available (no live position, or no transit sample for this class):
    // a TD-sighted train that has not cleared still holds the period, on the same bound.
    if (this.tdSeenToday.has(finalTrain.headcode)) {
      const floorMs = now.getTime() + (lagSecs != null ? lagSecs * 1000 : 0);
      if (end.getTime() < floorMs) return { at: new Date(floorMs), holdingOpen: true };
    }
    return plain(end);
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
    const currentClosure = this.closurePeriods.find(p => this._isCurrent(p, now));
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

  // Is this period the one we are IN? The end test is `holdingOpen ? still open : clock`,
  // and that distinction is the whole point of the flag (register #14).
  //
  // A period whose end is a HELD bound has not finished when that bound passes — the train
  // has not performed its clear step, so the barrier is physically still down. Testing the
  // clock alone dropped the period at three separate sites (here, the getApiState filter,
  // and PREDICT.derive on the client), each of which would then report the crossing CLEAR
  // with a train on it. That false-clear is the reason the old code floored the end at a
  // flat 60s; gating on the trigger instead is what lets the bound be the measured open lag.
  //
  // Bounded by _mergeTrains dropping a sighted train 3 min past its projected crossing: the
  // period loses its trains and ceases to exist, so a hold cannot outlive the train.
  _isCurrent(p, now) {
    const t = now instanceof Date ? now.getTime() : now;
    return t >= Date.parse(p.start) && (p.holdingOpen || t <= Date.parse(p.end));
  }

  // Every close and open TRIGGER, with its position on the approach chain. Serves the
  // observer's strip map (a field tool: "where on the ground does the barrier actually
  // start moving?").
  //
  // The PLACEMENT is computed here, not in the app, and that is the point. A trigger is
  // "berth B + N seconds", so where it sits between the drawn berths depends on the same
  // per-class transit table the prediction uses — and a copy of that table in the frontend
  // would drift away from the predictor the first time either is recalibrated. Config
  // change, deploy, map moves. Nothing to keep in step by hand.
  //
  // Walks the chain from the anchor berth, spending `offsetSecs` against each measured leg,
  // and reports where it runs out: { from, to, fraction }. This is the same arithmetic the
  // close rule performs, read positionally instead of temporally.
  //
  // Note what the numbers say: every east class fires 137-149s before the train reaches the
  // crossing and every west class at 92s (west offsets are DERIVED as transit − 92), yet
  // they land in different gaps — a Southwick stopper's 0006 is 246s from the road, a
  // fast's is 96s. Same instant-before-crossing, different place on the ground. That is
  // real, and it is why the anchor berth is per class in the first place.
  getTriggers() {
    const td = this.config.td || {};
    const ct = (this.timing && this.timing.closeTrigger) || {};
    const out = { crossingId: this.id, close: [], open: [], chain: {}, clear: {} };

    for (const direction of ['east', 'west']) {
      const dirCfg = td[direction === 'east' ? 'eastbound' : 'westbound'];
      if (!dirCfg) continue;
      const chain = Array.isArray(dirCfg.approachChain) ? dirCfg.approachChain : [];
      out.chain[direction] = chain.concat(['XING']);
      out.clear[direction] = dirCfg.clear || null;

      const c = ct[direction] || {};
      const classes = c.classes || {};
      for (const [cls, spec] of Object.entries(classes)) {
        if (!spec || !spec.berth) continue;
        // Resolve the offset exactly as _closeAnchor does — explicit where east calibrated
        // one, derived from transit − crossingLeadSecs where west did not — by asking
        // _closeAnchor itself with a stub train, so the two can never disagree.
        const anchor = this._closeAnchor({ direction, trainType: cls === 'freight' ? 'freight' : 'passenger',
                                           forceClass: cls });
        let offsetSecs = anchor && anchor.berth === spec.berth ? anchor.offsetSecs : null;
        if (offsetSecs === null && typeof spec.offsetSecs === 'number') offsetSecs = spec.offsetSecs;
        if (offsetSecs === null) continue;               // no sample for this class+berth
        if (typeof c.minAfterStrikeSecs === 'number') offsetSecs = Math.max(offsetSecs, c.minAfterStrikeSecs);

        const toXing = this._transit({ direction, forceClass: cls }, spec.berth, 'XING');
        out.close.push({
          direction, trainClass: cls, berth: spec.berth, offsetSecs,
          derived: !!(anchor && anchor.derived),
          transitToCrossingSecs: toXing ? toXing.secs : null,
          transitSdSecs: toXing ? toXing.sdSecs : null,
          sampleN: toXing ? toXing.n : null,
          // Seconds before the train reaches the crossing that this trigger fires.
          firesSecsBeforeCrossing: toXing ? toXing.secs - offsetSecs : null,
          place: this._placeOnChain(direction, cls, spec.berth, offsetSecs)
        });
      }

      // OPEN triggers: the clear step + the measured per-class open lag. Position is the
      // client's to draw — the transit table only measures the approach, so the observer
      // places these on its own post-crossing (tac) axis from the same lag value.
      const lags = (this.timing && this.timing.openLagSecs && this.timing.openLagSecs[direction]) || {};
      for (const [cls, secs] of Object.entries(lags)) {
        if (typeof secs !== 'number') continue;
        out.open.push({
          direction, trainClass: cls, lagSecs: secs,
          clearStep: dirCfg.clear || null,
          clearBerth: dirCfg.clear ? dirCfg.clear.to : null
        });
      }
    }
    return out;
  }

  // Walk `offsetSecs` of measured travel downstream from `berth`, and report where it runs
  // out as a fraction of the leg it lands in. Returns null when the legs aren't measured.
  _placeOnChain(direction, cls, berth, offsetSecs) {
    const chain = (this.config.td[direction === 'east' ? 'eastbound' : 'westbound'] || {}).approachChain;
    if (!Array.isArray(chain)) return null;
    const nodes = chain.concat(['XING']);
    let i = nodes.indexOf(berth);
    if (i === -1) return null;
    let remaining = offsetSecs;
    while (i < nodes.length - 1) {
      const leg = this._transit({ direction, forceClass: cls }, nodes[i], nodes[i + 1]);
      if (!leg) return null;
      if (remaining <= leg.secs) {
        return { from: nodes[i], to: nodes[i + 1],
                 fraction: leg.secs > 0 ? remaining / leg.secs : 0, legSecs: leg.secs };
      }
      remaining -= leg.secs;
      i++;
    }
    // Past the crossing — a rule that fires after its own train has crossed. Should not
    // happen (offsets are chosen to stay feasible) but the map must not silently drop it.
    return { from: 'XING', to: 'XING', fraction: 0, legSecs: 0, beyondCrossing: true };
  }

  // Get the full state for the API
  getApiState(limit = DEFAULT_CLOSURE_LIMIT) {
    const now = new Date();
    const upcoming = this.closurePeriods.filter(p => p.holdingOpen || new Date(p.end) > now);
    const current = upcoming.find(p => this._isCurrent(p, now));
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
      upcomingClosures: upcoming.slice(0, limit),
      closureCount: upcoming.length,
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
