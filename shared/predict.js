/*
 * shared/predict.js — the prediction core shared by BOTH front-ends.
 *
 * Why this file exists: the public app (portslade/index.html + shared/crossing.js) and
 * the observer (portslade/observe/) must never disagree about what the barrier is about
 * to do. Before this file the observer had no prediction at all, and each app carried its
 * own copy of the Portslade berth chain — so the two could drift apart silently, and one
 * of them would be lying to whoever was standing at the crossing. Everything the two apps
 * must agree on lives here. Everything about how either of them LOOKS does not: the label
 * wording stays in each app, because "Approaching (~3 min)" is for a passer-by and
 * "Approaching (~3m20s)" is for someone with a stopwatch. Shared maths, separate prose.
 *
 * DOM-free and framework-free on purpose — a plain global, no build step (the repo has
 * none), so it loads via <script> in both apps and inside the audit replay harness.
 *
 * The BACKEND owns the authoritative timing — the TD clear-step-anchored open, the
 * strike-anchored close, hold-until-cleared. This file maps those pre-computed periods
 * and derives the display state from them. It does not re-predict anything.
 */
(function (root) {
  'use strict';

  // CLOSING_SOON fires this far ahead of the PREDICTED close (barrier-down) time.
  var CLOSING_SOON_MS = 90000;

  // ---- formatters -----------------------------------------------------------------
  function fmtTime(d) { if (!d) return '--:--'; return d.toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
  function fmtShort(d) { if (!d) return ''; return d.toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'}); }
  function fmtCountdown(ms) {
    if (ms <= 0) return 'NOW';
    var s = Math.floor(ms / 1000), m = Math.floor(s / 60), sec = s % 60;
    return m > 0 ? m + 'm ' + sec + 's' : sec + 's';
  }
  function fmtUncertainty(secs) {
    if (secs % 60 === 0) return (secs / 60) + ' min';
    return secs + 's';
  }
  function fmtCountdownRough(ms) {
    var m = Math.round(ms / 60000);
    return m <= 0 ? 'now' : '~' + m + ' min';
  }
  // The "when" half of a closure pill, as a phrase rather than a bare value — the
  // template used to prefix "in " unconditionally, so a countdown sitting at or past
  // zero rendered "in now". Past zero it is "any moment now", not a time. `rough` is
  // driven by the confidence window: when the window is a minute or wider, second
  // precision is a lie. The window is no longer DRAWN as a ± band (2026-08-14) — this is
  // now the only place it reaches the user, as the difference between "in 3m 20s" and
  // "in ~3 min", which is the honest way to spend it.
  function fmtWhen(ms, rough) {
    if (ms <= 0) return 'any moment now';
    if (!rough) return 'in ' + fmtCountdown(ms);
    return ms < 60000 ? 'in under a minute' : 'in ' + fmtCountdownRough(ms);
  }
  // A countdown that has reached/passed zero but whose state hasn't advanced yet reads
  // "Soon" rather than "0s" / "NOW" or a negative value.
  //
  // After register #14 this is a much narrower case than it was. It used to be reached by
  // any train whose projected trigger had quietly expired — a train STOPPED short of the
  // crossing would show "Soon", i.e. "the barrier is about to drop", when the truth was the
  // opposite: nothing was going to happen for at least a hundred seconds. The backend now
  // holds such a countdown at a lower bound and flags it (see fmtHeld), so "Soon" is left
  // meaning only what it was designed to mean: the trigger HAS fired and we are inside the
  // gap before the state catches up.
  function fmtSoon(ms) { return ms <= 0 ? 'Soon' : fmtCountdown(ms); }
  // A countdown whose trigger has NOT fired. The value is a lower bound recomputed against
  // now, so it does not tick down — rendering it as a bare countdown would read as a hung
  // clock. Prefixed instead, and the caller pairs it with a "held" note.
  function fmtHeld(ms) { return ms <= 0 ? 'held' : '≥ ' + fmtCountdown(ms); }
  // The countdown for a close/open card: held bound or live countdown, whichever applies.
  function fmtEta(ms, held) { return held ? fmtHeld(ms) : fmtSoon(ms); }
  // A duration (not a countdown) — reads as a length of time, to the nearest 10 s:
  // "~50s", "~2m 40s", "~3m". Ten seconds is about the resolution the underlying
  // prediction can honestly support, so don't tighten it without better calibration.
  function fmtDuration(ms) {
    var s = Math.max(10, Math.round(ms / 10000) * 10);
    if (s < 60) return '~' + s + 's';
    var m = Math.floor(s / 60), sec = s % 60;
    return sec === 0 ? '~' + m + 'm' : '~' + m + 'm ' + sec + 's';
  }
  // The "Down For" card version of the same duration. Two differences from the pill
  // above, both because this one is read on its own rather than inside a sentence:
  // no leading "~" (a tilde against a bare number just read as noise; the uncertainty
  // used to be carried by the ± band on the closure row, which no longer exists — see
  // fmtWhen for where the window goes now), and a whole-minute value
  // spells its unit out — "3m" alone was easy to scan as seconds. Mixed values stay
  // compact ("2m 40s"); spelling those out overflows the card. Same 10 s rounding, so
  // the card and the pill can never disagree.
  function fmtDownFor(ms) {
    var s = Math.max(10, Math.round(ms / 10000) * 10);
    if (s < 60) return s + ' secs';
    var m = Math.floor(s / 60), sec = s % 60;
    if (sec === 0) return m + (m === 1 ? ' min' : ' mins');
    return m + 'm ' + sec + 's';
  }

  // ---- closure mapping ------------------------------------------------------------
  // Build display periods straight from the backend's pre-computed closures.
  // The backend owns the authoritative timing — crucially the TD clear-step-anchored
  // OPEN (period end) and the "hold the closure open until the train has physically
  // cleared" behaviour — neither of which a client can reproduce (it has no berth-step
  // feed, only each train's bestTime). So we render the backend's periods verbatim
  // (start/end parsed to Dates) and only attach the client-side confidence window for
  // display. buildClosures([]) safely returns [] when the backend sent none.
  function buildClosures(closures, cfg) {
    var periods = [];
    closures = closures || [];
    for (var i = 0; i < closures.length; i++) {
      var c = closures[i];
      if (!c || !c.start || !c.end) continue;
      var ts = c.trains || [];
      var mapped = [];
      for (var j = 0; j < ts.length; j++) {
        var t = ts[j];
        var delayMins = t.delayMins || 0;
        mapped.push({
          origin: t.origin,
          destination: t.destination,
          operator: t.operator,
          direction: t.direction,
          bestTime: new Date(t.bestTime),
          scheduledTime: t.scheduledTime ? new Date(t.scheduledTime) : null,
          delayMins: delayMins,
          isDelayed: delayMins > 0,
          isUncertain: !!t.isUncertain,
          etaText: t.etaText,
          source: t.source,
          headcode: t.headcode,
          trainType: t.trainType,
          tdBerth: t.tdBerth,
          runsAsRequired: !!t.runsAsRequired,
          recentRunRate: typeof t.recentRunRate === 'number' ? t.recentRunRate : null,
          tdSeen: !!t.tdSeen
        });
      }
      // start = CONFIRMED close (drives the CLOSED/DOWN state). predictedStart =
      // PREDICTED close (drives the countdown / closing-soon); backend adds it — fall
      // back to start for older payloads. end = raw predicted open (drives reopen).
      var p = { start: new Date(c.start), predictedStart: new Date(c.predictedStart || c.start), end: new Date(c.end), trains: mapped,
                // Backend flag: this close is anchored to a physical berth strike, not a
                // timetable estimate. Absent on older payloads, so default false.
                closeConfirmed: !!c.closeConfirmed,
                // Register #14. The corresponding time is a HELD LOWER BOUND, not a
                // prediction: the physical trigger has not fired and the projection of it
                // has expired, so the backend is saying "no sooner than this", recomputed
                // against now. closePending -> render the close as held, don't count it
                // down. holdingOpen -> ALSO keep treating the period as current past its
                // end (see derive), because the closure ends when the train performs its
                // clear step, not when the clock runs out. Both absent on older payloads.
                closePending: !!c.closePending,
                holdingOpen: !!c.holdingOpen };
      p.window = getWindowTier(p, cfg);
      periods.push(p);
    }
    return periods;
  }

  function getWindowTier(closure, cfg, now) {
    cfg = cfg || {};
    var cw = cfg.confidenceWindows || {};
    now = now || new Date();
    var secsToStart = (closure.start.getTime() - now.getTime()) / 1000;

    // The backend has anchored this close to a berth strike, so it knows the time to the
    // second. Any ± band would be inventing doubt we do not have — this was the widest
    // gap between what the app knew and what it showed (±2 min beside an exact time).
    // Not `imminent`: that tier means "too close to give a time", the opposite of this.
    if (closure.closeConfirmed) return { imminent: false, tier: 'confirmed', halfWidthSecs: 0 };

    for (var i = 0; i < closure.trains.length; i++) {
      var t = closure.trains[i];
      if (t.tdBerth === 'imminent')   return { imminent: true,  tier: 'td_imminent',   halfWidthSecs: 0 };
      if (t.tdBerth === 'protecting') return { imminent: false, tier: 'td_protecting', halfWidthSecs: cw.td_protecting_secs || 30 };
      if (t.tdBerth === 'approach')   return { imminent: false, tier: 'td_approach',   halfWidthSecs: cw.td_approach_secs  || 60 };
    }

    var hasLdb = closure.trains.some(function(t) { return !t.source || t.source === 'ldb' || t.source === 'ldbsv'; });
    if (hasLdb && secsToStart <= 300) {
      return { imminent: false, tier: 'ldb', halfWidthSecs: cw.ldb_near_secs || 90 };
    }
    return { imminent: false, tier: 'schedule', halfWidthSecs: cw.schedule_secs || 120 };
  }

  // Flatten the closures' trains into one deduped, time-sorted list — the shape the
  // apps keep as history and join feedback taps against.
  function parseTrains(data) {
    var results = [];
    var seen = {};
    var closures = (data && data.upcomingClosures) || [];
    for (var i = 0; i < closures.length; i++) {
      var ts = closures[i].trains || [];
      for (var j = 0; j < ts.length; j++) {
        var t = ts[j];
        var key = t.dedupKey || ((t.headcode || '') + '|' + t.bestTime + '|' + t.destination);
        if (seen[key]) continue;
        seen[key] = true;
        var delayMins = t.delayMins || 0;
        results.push({
          origin: t.origin,
          destination: t.destination,
          operator: t.operator,
          direction: t.direction,
          bestTime: new Date(t.bestTime),
          scheduledTime: t.scheduledTime ? new Date(t.scheduledTime) : null,
          delayMins: delayMins,
          isDelayed: delayMins > 0,
          isUncertain: !!t.isUncertain,
          isRealtime: true,
          etaText: t.etaText,
          dedupKey: key,
          source: t.source,
          headcode: t.headcode,
          trainType: t.trainType,
          tdBerth: t.tdBerth,
          runsAsRequired: !!t.runsAsRequired,
          recentRunRate: typeof t.recentRunRate === 'number' ? t.recentRunRate : null,
          recentRunSeen: t.recentRunSeen || 0,
          recentRunApplicable: t.recentRunApplicable || 0,
          tdSeen: !!t.tdSeen,
          tdSeenAt: t.tdSeenAt || null
        });
      }
    }
    results.sort(function(a, b) { return a.bestTime - b.bestTime; });
    return results;
  }

  // ---- state derivation -----------------------------------------------------------
  // THE prediction, as both apps must show it. Pure: periods in, facts out, no strings
  // about how to phrase it and no DOM. Returns
  //   { status, current, upcoming, nextCloseTime, nextOpenTime, downForMs, downForRange }
  // status is the backend's vocabulary: OPEN | CLOSING_SOON | CLOSED.
  // How stale the backend payload may be while we still honour holdingOpen. A held period
  // has no meaningful end — it lasts until the train clears — so a device that has lost the
  // backend would otherwise sit on BARRIERS DOWN indefinitely. Past this we fall back to the
  // clock. 90s matches the threshold the observer already marks its own feed bad at.
  var HOLD_TRUST_MS = 90000;

  // WHERE A HELD COUNTDOWN IS MEASURED FROM.
  //
  // A bound is "no sooner than the class lag from the moment the backend last looked". Held
  // against `now` it is not a bound at all — it loses a second a second between polls, so
  // an 18s open bound reads 18, 17 … 9, 8 across one 10s poll cycle and then jumps back.
  // That is a countdown wearing a "≥", which is the exact thing the ≥ exists to deny. The
  // backend re-stamps its bounds on the clock now (HOLD_TICK_MS there); this is the same
  // fix one layer up, for the gap between two polls.
  //
  // Pinned, not frozen. Past HELD_FRESH_MS we have genuinely lost touch with the backend,
  // the stamp really is ageing, and the value goes back to decaying — down to "held", as it
  // always did. 15s is one 10s poll plus margin, so a healthy app never reaches it.
  var HELD_FRESH_MS = 15000;
  function heldRef(t, payloadAgeMs) {
    return t - Math.min(payloadAgeMs > 0 ? payloadAgeMs : 0, HELD_FRESH_MS);
  }

  function derive(periods, now, payloadAgeMs) {
    var t = (now || new Date()).getTime();
    var trustHold = !(payloadAgeMs > HOLD_TRUST_MS);
    var current = null, upcoming = null;
    periods = periods || [];
    for (var i = 0; i < periods.length; i++) {
      var p = periods[i];
      // Find BOTH the current closure and the next upcoming one (don't stop at the
      // current) — so while CLOSED we can still show the countdown to the next close.
      //
      // The end test is `holdingOpen ? still down : clock` (register #14). A period whose
      // end is a held bound has NOT finished when that bound passes: the train has not
      // performed its clear step, so the barrier is physically still down. Testing the
      // clock alone is what reported the crossing CLEAR with a train on it — the failure
      // the backend's flat 60s end floor existed to paper over.
      var stillDown = (p.holdingOpen && trustHold) || t <= p.end.getTime();
      if (!current && t >= p.start.getTime() && stillDown) { current = p; }
      else if (!upcoming && p.start.getTime() > t) { upcoming = p; }
    }
    var out = { status: 'OPEN', current: current, upcoming: upcoming,
                nextCloseTime: null, nextOpenTime: null, downForMs: null, downForRange: null,
                // Is the corresponding countdown a held lower bound rather than a live
                // prediction? Presentation reads these; the numbers are unchanged.
                closeHeld: false, openHeld: false,
                // The instant a held countdown must be measured from — see heldRef. Every
                // renderer of a ≥ value uses this in place of `now`, so the four places a
                // bound can appear cannot disagree about how old it is.
                heldRef: heldRef(t, payloadAgeMs),
                // Invariants the backend is supposed to guarantee. Populated rather than
                // silently repaired: the observer exists to surface a disagreement between
                // the two apps and the backend, and quietly clamping here would hide
                // exactly the class of bug it is deployed to catch. The public app ignores
                // them.
                warnings: [] };
    if (current) {
      out.status = 'CLOSED';
      out.nextOpenTime = current.end;
      out.openHeld = !!current.holdingOpen;
      // Even while down, surface the countdown to the NEXT closure if another is coming
      // (back-to-back closures are a useful heads-up). Targets the predicted close.
      if (upcoming) {
        out.nextCloseTime = upcoming.predictedStart || upcoming.start;
        out.closeHeld = !!upcoming.closePending;
        // Register #15: the barrier cannot drop before it has risen. The backend now
        // coalesces periods whose anchored ends overlap, so this should be unreachable —
        // which is the reason to report it rather than assume it.
        if (out.nextCloseTime.getTime() < current.end.getTime()) {
          out.warnings.push('next close precedes current open');
        }
      }
      // "Down For" describes the closure we're IN — it pairs with Next Open.
      setDownFor(out, current);
    } else if (upcoming) {
      // Close countdown / closing-soon target the PREDICTED close (barrier-down);
      // the CLOSED state itself gates on the confirmed start (the loop above).
      var closeTarget = upcoming.predictedStart || upcoming.start;
      out.nextCloseTime = closeTarget;
      out.nextOpenTime = upcoming.end;
      out.closeHeld = !!upcoming.closePending;
      setDownFor(out, upcoming);
      // A held close is not "closing soon" — the trigger has not fired and the value is a
      // floor, so promoting it to the amber state would claim an imminence we do not have.
      if (!out.closeHeld && closeTarget.getTime() - t <= CLOSING_SOON_MS) out.status = 'CLOSING_SOON';
    }
    return out;
  }
  // How long the barrier is down for a period, measured from the PREDICTED close (the
  // barrier-down estimate the countdown targets) to the period end — not from `start`,
  // which is the conservative confirmed-close gate and would overstate the duration.
  function setDownFor(out, p) {
    var from = p.predictedStart || p.start;
    out.downForMs = p.end.getTime() - from.getTime();
    out.downForRange = fmtShort(from) + '–' + fmtShort(p.end);
  }

  // The state in the words a user sees. Lives here because it is recorded into a single
  // sheet column by both apps — the public app has always written these words, so the
  // observer must write them too rather than the internal OPEN/CLOSING_SOON/CLOSED.
  function stateLabel(status) {
    return status === 'CLOSED' ? 'BARRIERS DOWN'
      : status === 'CLOSING_SOON' ? 'CLOSING SOON'
      : status === 'OPEN' ? 'CROSSING CLEAR' : '';
  }

  // ---- Portslade berth chain ------------------------------------------------------
  // Derived berth chain toward/through the crossing. gap = median seconds a train
  // dwells in that berth (≈ time to the next berth). role marks the confirmed
  // Portslade berths; {x:true} is the crossing itself (after protecting).
  // ttc = {q1,med,q3} seconds from ENTERING this approach berth to passing the
  // crossing; tac = {q1,med,q3} seconds from passing the crossing to entering this
  // cleared berth (both over 28 days of TD logs — backend derive-ttc.js). The crossing
  // reference for both is the train stepping out of the protecting berth — i.e. the
  // TRAIN on the crossing, not the barrier.
  var CHAIN = {
    east: [
      { b: '0016', gap: 132, ttc: { q1: 613, med: 671, q3: 743 } },
      { b: '0014', gap: 74, ttc: { q1: 479, med: 537, q3: 608 } },
      { b: '0012', gap: 37, ttc: { q1: 402, med: 462, q3: 531 } },
      { b: '0010', gap: 143, ttc: { q1: 362, med: 422, q3: 488 } },
      { b: '0008', gap: 75, ttc: { q1: 201, med: 278, q3: 346 } },
      { b: '0006', gap: 142, role: 'approach', ttc: { q1: 122, med: 206, q3: 270 } },
      { b: '0004', gap: 79, role: 'protecting', ttc: { q1: 55, med: 64, q3: 122 } },
      { x: true },
      { b: '0002', gap: 115, role: 'clear' },
      { b: 'T686', gap: 53, tac: { q1: 107, med: 116, q3: 128 } },
      { b: 'T684', tac: { q1: 159, med: 170, q3: 186 } }
    ],
    west: [
      { b: 'T682', gap: 90 },
      { b: 'T677', gap: 126, ttc: { q1: 311, med: 336, q3: 385 } },
      { b: '0001', gap: 45, ttc: { q1: 185, med: 201, q3: 258 } },
      { b: '0003', gap: 36, role: 'approach', ttc: { q1: 142, med: 152, q3: 164 } },
      { b: '0005', gap: 115, role: 'protecting', ttc: { q1: 107, med: 115, q3: 125 } },
      { x: true },
      { b: '0007', gap: 43, role: 'clear' },
      { b: '0009', gap: 70, tac: { q1: 41, med: 42, q3: 45 } },
      { b: '0011', gap: 140, tac: { q1: 103, med: 111, q3: 181 } },
      { b: '0013', gap: 144, tac: { q1: 198, med: 258, q3: 317 } },
      { b: '0015', gap: 84, tac: { q1: 349, med: 412, q3: 467 } },
      { b: '0017', gap: 47, tac: { q1: 437, med: 496, q3: 554 } }
    ]
  };
  // Precompute, per direction: berth → node index, and the crossing index.
  var CHAININ = {};
  Object.keys(CHAIN).forEach(function (d) {
    var idx = {}, xi = -1;
    CHAIN[d].forEach(function (n, i) { if (n.x) xi = i; else idx[n.b] = i; });
    CHAININ[d] = { idx: idx, xi: xi };
  });

  // Sum of gaps from node index i up to (and including) the protecting berth — the
  // estimated seconds from entering berth i to reaching the crossing. Fallback for the
  // few chain berths with no measured ttc.
  function etaToCrossing(d, i) {
    var c = CHAININ[d]; if (!c || i < 0 || i >= c.xi) return 0;
    var s = 0; for (var j = i; j < c.xi; j++) { s += (CHAIN[d][j].gap || 60); } return s;
  }

  // Where a train is on its chain. Returns null when the berth isn't on the Portslade
  // chain (or the direction is unknown) → "elsewhere in the area".
  //   { stage:'approach'|'passed', role, index, etaSecs, sinceSecs, rank }
  // etaSecs/sinceSecs are the STATIC per-berth medians. Callers wanting a countdown that
  // actually moves use PREDICT.eta() — see the note there for why a median alone isn't
  // good enough.
  function proximity(berth, direction) {
    var c = CHAININ[direction]; if (!c) return null;
    var i = c.idx[berth]; if (i === undefined) return null;
    var node = CHAIN[direction][i];
    if (i > c.xi) {
      // tac = seconds from the crossing to ENTERING this berth, so it is the floor on
      // "how long ago did it cross". The clear berth itself has none: stepping into it
      // IS the crossing, so that floor is zero.
      var since = (node.tac && node.tac.med != null) ? node.tac.med : 0;
      return { stage: 'passed', role: node.role || null, index: i, etaSecs: null, sinceSecs: since, rank: 9999 };
    }
    var eta = (node.ttc && node.ttc.med != null) ? node.ttc.med : etaToCrossing(direction, i);
    return { stage: 'approach', role: node.role || null, index: i, etaSecs: eta, sinceSecs: null, rank: eta };
  }

  // How far a train is from the crossing RIGHT NOW, as of nowMs. Returns
  //   { secs, sinceSecs, basis:'predicted'|'berth', overdueSecs }
  // or null when the train isn't on the chain.
  //
  // Why this is not just "the berth's median minus time in the berth": eastbound berth
  // 0006 contains Southwick station. A service that calls there sits in the berth ~160 s
  // longer than one that runs through, so the berth median describes two populations at
  // once and fits neither. Measured on the 2026-07-27 recording, a median-decay countdown
  // for 2Y21 reached zero 134 s before the train actually reached the crossing — and did
  // it confidently.
  //
  // So when the train is joined to a closure we use the BACKEND's own predicted crossing
  // time (bestTime), which is class-aware and position-projected, and which the closure
  // list and the header countdown are already showing. Same recording: bestTime lands
  // within ~±30 s for most trains inside T-120 s. Two wins — better numbers, and the
  // picker stops being a third independent estimate that contradicts the two on screen.
  //
  // The berth median stays as the fallback for a train with no closure join at all
  // (unmatched freight, direction "unknown"), where it is the only thing we have. Past
  // zero it reports overdueSecs and the caller says so, rather than counting negative or
  // parking on a confident "now".
  function eta(t, nowMs) {
    if (!t || !t.prox) return null;
    nowMs = nowMs || Date.now();
    var inBerthSecs = t.strikeAtMs ? Math.max(0, (nowMs - t.strikeAtMs) / 1000) : 0;
    if (t.prox.stage === 'passed') {
      return { secs: null, sinceSecs: Math.round((t.prox.sinceSecs || 0) + inBerthSecs),
               basis: 'berth', overdueSecs: 0 };
    }
    var secs;
    if (t.bestTime) {
      secs = Math.round((t.bestTime.getTime() - nowMs) / 1000);
      return { secs: Math.max(0, secs), sinceSecs: null, basis: 'predicted',
               overdueSecs: secs < 0 ? -secs : 0 };
    }
    secs = Math.round((t.prox.etaSecs || 0) - inBerthSecs);
    return { secs: Math.max(0, secs), sinceSecs: null, basis: 'berth',
             overdueSecs: secs < 0 ? -secs : 0 };
  }

  // ---- which train an observed barrier event belongs to ----
  //
  // One rule for both events: rank every candidate by how far it is from the trigger that
  // fires THIS event, counting distance on either side of it. For a CLOSE that is the
  // train's own per-class close trigger (0008+55, 0006+100, …); for an OPEN it is the
  // clear step plus the class open lag. Both are published by GET /crossing/:id/triggers,
  // so the picker points at the same physical instants the predictor fires on.
  //
  // The key this replaced was `ageSecs`, the age of the train's last berth step — and a
  // train keeps stepping after it crosses (west 0007→0009→0011→0013, east 0002→T686), so
  // each step reset it. At the 2026-08-01 17:43:36 barrier-up, 1H46 had crossed 175 s
  // earlier but stepped into 0013 36 s earlier, while 1N47 had crossed 51 s earlier and
  // was standing in 0002. `ageSecs` chose 1H46 — and the app was at that moment rendering
  // "Passed (+4m54s)" beside the train it recommended. The observation went into the sheet
  // against the wrong train.
  //
  // Why the trigger and not simply "nearest the crossing": the open trigger sits AFTER the
  // crossing (clear step + 18–40 s), so a train 20 s short of the road ranks worse than one
  // 80 s past it. That is the physical truth — the barrier cannot rise before a train has
  // cleared — and the asymmetry comes out of the calibrated lag rather than a hand-set
  // constant. With no triggers to hand the reference degrades to the crossing itself, which
  // is still strictly better than the step age.

  // Signed seconds until the train reaches the crossing: positive ahead of it, negative
  // once past. null when the train isn't on the chain at all.
  function secsToCrossing(t, nowMs) {
    var e = eta(t, nowMs);
    if (!e) return null;
    return e.secs != null ? e.secs : -(e.sinceSecs || 0);
  }

  // Where this event's trigger sits for this train, in signed seconds-before-crossing.
  // CLOSE: the class's own firesSecsBeforeCrossing. OPEN: minus the class's open lag,
  // since that trigger is that many seconds AFTER the crossing. 0 when we can't tell,
  // which makes the reference the crossing itself.
  function triggerRef(type, t, triggers) {
    if (!triggers || !t) return 0;
    var dir = t.direction, i, list;
    if (type === 'opening' || type === 'OPEN') {
      // The backend keys open lags by passenger/freight only (see _getOpenLagSecs), not by
      // the five close classes, so collapse to the same two buckets it uses.
      var cls = ((t.trainClass || t.type) === 'freight') ? 'freight' : 'passenger';
      list = triggers.open || [];
      for (i = 0; i < list.length; i++) {
        if (list[i].direction === dir && list[i].trainClass === cls) {
          return typeof list[i].lagSecs === 'number' ? -list[i].lagSecs : 0;
        }
      }
      return 0;
    }
    list = triggers.close || [];
    for (i = 0; i < list.length; i++) {
      if (list[i].direction === dir && list[i].trainClass === t.trainClass) {
        return typeof list[i].firesSecsBeforeCrossing === 'number' ? list[i].firesSecsBeforeCrossing : 0;
      }
    }
    return 0;
  }

  // Seconds between this train and the trigger that fires this event. null off-chain, so
  // callers can sort those last rather than inventing a distance for them.
  //
  // Two things are physically impossible and the distance alone does not rule them out: a
  // barrier does not close for a train that has already gone, and it does not rise for one
  // that has not yet arrived. Those trains are ranked into a band ABOVE every eligible one
  // (INELIGIBLE_BAND) instead of being dropped, so they still appear in the picker and can
  // still be chosen when nothing else is on the chain — which is the case that matters when
  // the berth feed is lagging. The 2026-07-27 replay is what caught this: without the guard
  // a CLOSE was attributed to a train that had crossed 25 s earlier.
  //
  // Note `secs` is clamped at zero by eta() and `sinceSecs` is only set for a passed train,
  // so s < 0 is exactly prox.stage === 'passed' — the same test the berth-based filter this
  // replaced was making, now expressed once for both apps.
  var INELIGIBLE_BAND = 90000;
  function eventRank(type, t, nowMs, triggers) {
    var s = secsToCrossing(t, nowMs);
    if (s == null) return null;
    var opening = (type === 'opening' || type === 'OPEN');
    var rank = Math.abs(s - triggerRef(type, t, triggers));
    var possible = opening ? (s <= 0) : (s >= 0);
    return possible ? rank : INELIGIBLE_BAND + Math.min(rank, 9999);
  }

  // The app's best guess at which train an observed event belongs to: nearest its trigger.
  //
  // The two events differ in what they do when nothing eligible is on the chain, and the
  // asymmetry is deliberate — it is the behaviour both apps already had, kept because a
  // wrong suggestion is worse than none. A picker default gets accepted: every one of the
  // 15 rows in the 1 Aug session carries wasOurGuess=TRUE, including the one Rich then
  // annotated as the wrong train.
  //  - OPEN falls back to an approaching train. A barrier that has just risen means a train
  //    HAS cleared, so if none shows as cleared the berth feed is behind and the train about
  //    to be named is very likely the right one.
  //  - CLOSE does not fall back. No approaching train means the one causing the close has
  //    not been sighted in our berths yet; the trains that HAVE been sighted are the ones
  //    that already went, and naming one of those is a guess with nothing behind it. The
  //    2026-07-27 replay produced exactly that — a close attributed to a train 2 s past the
  //    road. They stay in the list (see eventRank) so a human can still pick one.
  function suggestForEvent(type, trains, nowMs, triggers) {
    var allowIneligible = (type === 'opening' || type === 'OPEN');
    var best = null, bestRank = Infinity;
    (trains || []).forEach(function (t) {
      var r = eventRank(type, t, nowMs, triggers);
      if (r == null || r >= bestRank) return;
      if (r >= INELIGIBLE_BAND && !allowIneligible) return;
      best = t; bestRank = r;
    });
    return best;
  }

  // ---- live-train enrichment (feedback / attribution) -----------------------------
  function trainKind(hc) { if (!hc) return 'passenger'; var c = hc.charAt(0); if (c === '6' || c === '7') return 'freight'; if (c === '5') return 'ecs'; if (c === '3') return 'test'; return 'passenger'; }
  // Extract HH:MM from a feed time (full ISO like 2026-07-24T08:29:00, or already HH:MM).
  function hhmm(t) { if (!t) return ''; var m = String(t).match(/(\d{2}):(\d{2})/); return m ? m[0] : ''; }

  // Turn one /live train into the record the pickers display and the sheet records.
  // `join(headcode)` is supplied by the caller and returns { sched, live } Dates from
  // its own closure history — the two apps keep different pools, the join shape is the
  // same. Berth-strike history comes straight from the feed.
  function enrich(lt, join) {
    // NOTE: this object is what a barrier observation RECORDS — the observer snapshots it at the
    // moment of a capture and feedbackPayload reads fields straight off it. So adding a field
    // here is only half a change: it also needs a column in shared/apps-script-feedback.gs, or
    // it gets collected and then silently discarded at the sheet.
    var tm = (join && join(lt.headcode)) || { sched: null, live: null };
    var prox = proximity(lt.berth, lt.direction);
    var strikes = (lt.history || []).map(function (h) { return { berth: h.berth || h.to || '', ts: h.ts || '', event: h.event || '' }; });
    return {
      headcode: lt.headcode, direction: lt.direction || '',
      route: (lt.origin || '?') + ' → ' + (lt.destination || '?'),
      type: trainKind(lt.headcode), berth: lt.berth || '', ageSecs: lt.ageSecs || 0,
      // Feed fields passed straight through, so an enriched train is a superset of the raw
      // one and callers never need to keep both.
      origin: lt.origin || null, destination: lt.destination || null,
      stopping: lt.stopping, fromBerth: lt.fromBerth || null, event: lt.event || null,
      lastSeen: lt.lastSeen || null,
      // The class the BACKEND's prediction used, and the two flags that decide it. Recorded
      // with every barrier observation so calibration groups trains exactly the way the
      // predictor groups them. `type` above is this app's own guess from the headcode's first
      // character; trainClass is the real thing and the two can legitimately disagree.
      // Tri-state is preserved: null means unknowable, which is not the same as false.
      trainClass: lt.trainClass || null,
      callsAtStation: lt.callsAtStation === undefined ? null : lt.callsAtStation,
      callsAtApproach: lt.callsAtApproach === undefined ? null : lt.callsAtApproach,
      prox: prox,
      // When this train stepped into its current berth, on the DEVICE clock: the feed's
      // ageSecs is server-computed, so subtracting it from local "now" at the moment the
      // response lands gives a device-consistent instant with no clock-skew correction
      // needed. Drives the live countdown in eta().
      strikeAtMs: Date.now() - (lt.ageSecs || 0) * 1000,
      // Four Portslade times from the live feed (backend-provided): scheduled & live
      // (estimated) arrival & departure.
      schedArr: hhmm(lt.schedArr), schedDep: hhmm(lt.schedDep),
      // The REAL live estimate, blank when the feed gives none. Kept separate from the
      // display value below because the two must not be confused: a train that has lost
      // its estimate was being shown — and logged — as "on time", since the fallback made
      // live equal scheduled. This is the field the calibration payload carries, so a
      // "live" column in the sheet always means an actual live estimate.
      liveArrReal: hhmm(lt.liveArr), liveDepReal: hhmm(lt.liveDep),
      // Display value: falls back to scheduled so the card is never blank.
      liveArr: hhmm(lt.liveArr) || hhmm(lt.schedArr), liveDep: hhmm(lt.liveDep) || hhmm(lt.schedDep),
      schedStr: tm.sched ? fmtShort(tm.sched) : '', liveStr: tm.live ? fmtShort(tm.live) : '',
      // The backend's own predicted crossing time for this train, when it is joined to a
      // closure. Drives the live position countdown — see PREDICT.eta().
      bestTime: tm.live || null,
      strikes: strikes
    };
  }

  // ---- feedback payload -----------------------------------------------------------
  // One payload shape for BOTH apps, so a row in the sheet means the same thing however
  // it was recorded. `evt` is the frozen event { eventId, type, tsISO, predictedState,
  // snapshot, guess }; `hc` is the selected headcode (null = not sure); `extra` carries
  // the recorder-specific columns (source, confidence, note, prediction snapshot…).
  // eventId ties the button-tap post and the final submission to one row, so a later
  // selection updates the row already written at the tap.
  // A tri-state flag as a sheet cell. true/false survive as booleans; null, undefined and
  // the feed's literal "unknown" all become blank. Writing false for "we don't know" would
  // silently merge two different states that select different close anchors.
  function tri(v) {
    if (v === true || v === false) return v;
    return '';
  }
  function feedbackPayload(evt, hc, completed, extra) {
    if (!evt) return null;
    var sel = hc ? evt.snapshot[hc] : null;
    var g = evt.guess;
    var out = {
      eventId: evt.eventId, completed: !!completed,
      crossing: evt.crossing, crossingName: evt.crossingName,
      eventTimestamp: evt.tsISO, event: evt.type, predictedState: evt.predictedState,
      ourGuessHeadcode: g?g.headcode:'', ourGuessRoute: g?g.route:'', ourGuessDirection: g?g.direction:'',
      ourGuessType: g?g.type:'',
      ourGuessSchedArr: g?g.schedArr:'', ourGuessSchedDep: g?g.schedDep:'', ourGuessLiveArr: g?g.liveArrReal:'', ourGuessLiveDep: g?g.liveDepReal:'',
      ourGuessPosition: g?g.posLabel:'', ourGuessBerth: g?g.berth:'',
      ourGuessBerthHistory: g?JSON.stringify(g.strikes||[]):'',
      ourGuessStopping: tri(g && g.stopping), ourGuessClass: (g && g.trainClass) || '',
      ourGuessCallsAtStation: tri(g && g.callsAtStation), ourGuessCallsAtApproach: tri(g && g.callsAtApproach),
      submittedAt: new Date().toISOString(),
      selectedHeadcode: sel?sel.headcode:'', selectedRoute: sel?sel.route:'', selectedDirection: sel?sel.direction:'',
      selectedType: sel?sel.type:'',
      selectedSchedArr: sel?sel.schedArr:'', selectedSchedDep: sel?sel.schedDep:'', selectedLiveArr: sel?sel.liveArrReal:'', selectedLiveDep: sel?sel.liveDepReal:'',
      selectedPosition: sel?sel.posLabel:'', selectedBerth: sel?sel.berth:'',
      selectedBerthHistory: sel?JSON.stringify(sel.strikes||[]):'',
      selectedStopping: tri(sel && sel.stopping), selectedClass: (sel && sel.trainClass) || '',
      selectedCallsAtStation: tri(sel && sel.callsAtStation), selectedCallsAtApproach: tri(sel && sel.callsAtApproach),
      wasOurGuess: !!(sel && g && sel.headcode===g.headcode), notSure: !!(completed && !hc)
    };
    if (extra) { for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k]; } }
    return out;
  }

  root.PREDICT = {
    CLOSING_SOON_MS: CLOSING_SOON_MS,
    CHAIN: CHAIN, CHAININ: CHAININ,
    fmtTime: fmtTime, fmtShort: fmtShort, fmtCountdown: fmtCountdown, fmtUncertainty: fmtUncertainty,
    fmtCountdownRough: fmtCountdownRough, fmtWhen: fmtWhen, fmtSoon: fmtSoon,
    fmtHeld: fmtHeld, fmtEta: fmtEta, heldRef: heldRef,
    fmtDuration: fmtDuration, fmtDownFor: fmtDownFor,
    buildClosures: buildClosures, getWindowTier: getWindowTier, parseTrains: parseTrains,
    derive: derive, stateLabel: stateLabel,
    proximity: proximity, etaToCrossing: etaToCrossing, eta: eta,
    secsToCrossing: secsToCrossing, triggerRef: triggerRef,
    eventRank: eventRank, suggestForEvent: suggestForEvent,
    trainKind: trainKind, hhmm: hhmm, enrich: enrich, feedbackPayload: feedbackPayload
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
