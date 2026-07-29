'use strict';
/*
 * Crossing Observer — v1 field data-collection tool (Boundary Road, Portslade).
 *
 * Captures the human-observed CLOSE (red lights start) and OPEN (booms fully up)
 * instants at ms precision, attributes each to a single train from the live B1
 * feed, and stores everything locally (IndexedDB) for CSV/JSON export. Read-only
 * on the backend; offline-first (a tap stores the timestamp immediately).
 *
 * v1.2 — approach STRIP-MAP. The berth chain + per-berth gaps below were derived
 * purely from TD timestamps (from→to step sequence + median dwell per berth), so
 * the diagram is spaced by typical JOURNEY TIME (not geographic distance — that
 * needs speed we don't have). Summing the gaps to the crossing gives an estimated
 * time-to-crossing. The chain is seeded from one day's log; re-derive over more
 * days (ideally server-side) to refine the gaps — order is stable topology.
 *
 * v1.4 — each approach berth also carries a `ttc` {q1, med, q3}: the lower-
 * quartile / median / upper-quartile seconds from a train ENTERING that berth to
 * PASSING the crossing, measured over 28 days of TD logs (backend
 * scripts/derive-ttc.js). Shown per berth on the map, and the median drives the
 * live "approaching ~Nm" labels/ordering (falling back to summed gaps if absent).
 *
 * v1.5 — cleared (post-crossing) berths carry `tac` {q1, med, q3}: seconds from
 * PASSING the crossing to ENTERING that berth (same 28-day derivation). Rendered
 * with a leading "+" (time SINCE the crossing) to distinguish from the approach
 * countdown. The crossing reference for both is the train stepping out of the
 * protecting berth — i.e. the TRAIN on the crossing, not the barrier.
 *
 * v2 — the berth chain, the position maths, the live-train enrichment and the OPEN/CLOSE
 * PREDICTION all come from shared/predict.js, the same core the public app runs. This app
 * used to own a private copy of the chain and no prediction at all, so the two could
 * disagree about the same crossing at the same moment. Now they cannot: a mismatch between
 * this panel and railcrossing.uk is a bug, not a difference of implementation.
 */

(function () {
  var API_BASE = 'https://api.railcrossing.uk';
  var CROSSING_ID = 'portslade';
  var POLL_MS = 2500;
  var PRED_POLL_MS = 30000;   // matches the public app's refresh cadence

  // Berth chain + index, from the shared core. See shared/predict.js for the derivation.
  var CHAIN = PREDICT.CHAIN, CHAININ = PREDICT.CHAININ;

  // Off-chain berths that nonetheless lead to the crossing, with the median
  // observed seconds-to-crossing (derived from TD timestamps). Used only to order
  // "Other trains in the area" by proximity — trains far out on the Portslade line
  // (beyond the drawn chain) sort by this; trains on unrelated LA lines have no
  // entry and fall back to recency. Seeded from one day; refine via derive-chain.
  var BERTH_ETA = {
    east: { '0020': 751, '0024': 860, '0203': 870, '0202': 903, '0026': 905, '0028': 995, '0040': 999, '0032': 1054, '0030': 1055, '0042': 1065, '0034': 1093, '0022': 1129, '0036': 1140, 'A030': 1146, '0038': 1157 },
    west: {}
  };
  function offChainEta(d, berth) { var m = BERTH_ETA[d]; var v = m && m[berth]; return typeof v === 'number' ? v : null; }

  // ---- pure helpers ----
  var trainKind = PREDICT.trainKind, proximity = PREDICT.proximity;
  function dirWord(d) { return d === 'east' ? 'Eastbound' : d === 'west' ? 'Westbound' : 'Direction unknown'; }
  function dirArrow(d) { return d === 'east' ? '▶' : d === 'west' ? '◀' : '·'; }

  // Position of a train in words, recomputed on every render rather than only when the
  // train steps berth — the same fix as the public app's picker, and for the same reason:
  // berth dwells run to nearly three minutes, so a label pinned to the berth is a label
  // that doesn't move. Wording is second-level here (this is a stopwatch tool, not a
  // passer-by's phone); the arithmetic underneath is the shared PREDICT.eta.
  function posLabel(t, nowMs) {
    var p = t.prox || proximity(t.berth, t.direction);
    if (!p) return null;
    var e = PREDICT.eta(t, nowMs);
    if (!e) return p.stage === 'passed' ? 'Passed' : 'Approaching';
    if (p.stage === 'passed') return 'Passed (+' + fmtEta(e.sinceSecs) + ')';
    if (e.overdueSecs > 600) return 'Held near the crossing';
    if (e.overdueSecs > 120) return 'Held (' + fmtEta(e.overdueSecs) + ' overdue)';
    if (p.role === 'protecting' && e.secs <= 20) return 'At the crossing';
    if (e.secs <= 5) return 'Any moment';
    return (e.secs <= 90 ? 'Close (' : 'Approaching (') + fmtEta(e.secs) + ')';
  }
  function isApproaching(t) { return (t.prox || proximity(t.berth, t.direction)) !== null; }
  function fmtEta(s) { if (s == null) return ''; if (s < 60) return s + 's'; var m = Math.floor(s / 60), r = s % 60; return r ? (m + 'm' + (r < 10 ? '0' + r : r) + 's') : (m + 'm'); }
  // Compact per-berth crossing time: bold median + the lower–upper quartile range.
  // after=true prefixes "+" (time SINCE the crossing) vs the approach countdown.
  function fmtTtc(t, after) {
    if (!t || t.med == null) return '';
    var m = '<b>' + (after ? '+' : '') + fmtEta(t.med) + '</b>';
    return (t.q1 != null && t.q3 != null) ? (m + ' <span class="iqr">' + fmtEta(t.q1) + '–' + fmtEta(t.q3) + '</span>') : m;
  }

  function identity(t) {
    var kind = trainKind(t.headcode), hasOD = t.origin || t.destination;
    var od = (t.origin || '?') + ' → ' + (t.destination || '?');
    if (kind === 'freight') return hasOD ? ('Freight · ' + od) : 'Freight (not in timetable)';
    if (kind === 'ecs') return hasOD ? ('Empty stock · ' + od) : 'Empty stock';
    return hasOD ? od : 'Train (not in timetable)';
  }
  function shortName(t) { return t.destination ? t.destination.split(/[ (,]/)[0] : t.headcode; }

  function suggestForClose(trains) {
    var cand = trains.filter(function (t) { var p = t.prox; return p && p.stage === 'approach'; });
    if (!cand.length) return null;
    cand.sort(function (a, b) { return liveRank(a) - liveRank(b); });
    return cand[0];
  }
  function suggestForOpen(trains) {
    var cleared = trains.filter(function (t) { var p = t.prox; return p && p.stage === 'passed'; });
    if (cleared.length) { cleared.sort(function (a, b) { return (a.ageSecs || 0) - (b.ageSecs || 0); }); return cleared[0]; }
    var appr = trains.filter(isApproaching);
    appr.sort(function (a, b) { return (a.ageSecs || 0) - (b.ageSecs || 0); });
    return appr[0] || null;
  }

  function categoryOf(rec) {
    if (rec.isSkip || rec.eventType !== 'CLOSE') return null;
    if (!rec.train) return 'other';
    if (rec.episodeTrains && rec.episodeTrains.length > 1) return 'consec';
    var d = rec.train.direction;
    if (d === 'east') return rec.train.stopping === true ? 'east_stop' : 'east_fast';
    if (d === 'west') return 'west';
    return 'other';
  }
  var CAT_LABELS = { east_stop: 'East · stopping', east_fast: 'East · fast/through', west: 'Westbound', consec: 'Consecutive' };

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function hms(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
  function fmtOffset(ms) { var s = ms >= 0 ? '+' : '-', a = Math.abs(ms); return a < 1000 ? (s + a + 'ms') : (s + (a / 1000).toFixed(1) + 's'); }
  function ageStr(t) { return (t.ageSecs != null ? t.ageSecs + 's ago' : ''); }

  function csvCell(v) { if (v === null || v === undefined) return ''; var s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function toCsv(records) {
    var cols = ['id', 'eventId', 'eventType', 'observed', 'isSkip', 'tCapturedDevice', 'tCorrected', 'tCorrectedISO', 'crossingId',
      'headcode', 'direction', 'stopping', 'suggestedHeadcode', 'suggestionAccepted', 'confidence', 'priorState',
      'episodeIndex', 'episodeRole', 'durationMs', 'hasSkip', 'episodeTrains', 'snapshotCount', 'note',
      // The prediction as it stood at the capture instant, and the gap to what was observed.
      'predictedState', 'predictedCloseTime', 'predictedOpenTime', 'predictedDownForSecs', 'deltaVsPredictedSecs',
      'sentToSheet', 'deleted', 'createdAt'];
    var lines = [cols.join(',')];
    records.forEach(function (r) {
      var p = r.pred || {};
      lines.push([r.id, r.eventId || '', r.eventType, r.observed === false ? 'no' : 'yes', r.isSkip ? 'yes' : 'no',
        r.tCapturedDevice, r.tCorrected, r.tCorrected ? new Date(r.tCorrected).toISOString() : '', r.crossingId,
        r.train ? r.train.headcode : '', r.train ? r.train.direction : '', r.train ? r.train.stopping : '',
        r.suggestedHeadcode || '', r.suggestionAccepted ? 'yes' : 'no', r.confidence || '', r.priorState || '',
        r.episodeIndex || '', r.episodeRole || '', r.durationMs != null ? r.durationMs : '', r.hasSkip ? 'yes' : 'no',
        (r.episodeTrains || []).join(' '), (r.liveSnapshot || []).length, r.note || '',
        p.predictedState || '', p.predictedCloseTime || '', p.predictedOpenTime || '',
        p.predictedDownForSecs != null ? p.predictedDownForSecs : '', p.deltaVsPredictedSecs != null ? p.deltaVsPredictedSecs : '',
        r.postedAt ? 'yes' : 'no', r.deleted ? 'yes' : '', r.createdAt].map(csvCell).join(','));
    });
    return lines.join('\n');
  }

  // ---- IndexedDB ----
  var DB_NAME = 'crossing-observer', STORE = 'observations', db = null;
  function openDb() { return new Promise(function (res, rej) { var q = indexedDB.open(DB_NAME, 1); q.onupgradeneeded = function (e) { var d = e.target.result; if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true }); }; q.onsuccess = function (e) { db = e.target.result; res(db); }; q.onerror = function () { rej(q.error); }; }); }
  function tx(m) { return db.transaction(STORE, m).objectStore(STORE); }
  function dbAdd(r) { return new Promise(function (s, j) { var q = tx('readwrite').add(r); q.onsuccess = function () { s(q.result); }; q.onerror = function () { j(q.error); }; }); }
  function dbPut(r) { return new Promise(function (s, j) { var q = tx('readwrite').put(r); q.onsuccess = function () { s(q.result); }; q.onerror = function () { j(q.error); }; }); }
  function dbDel(i) { return new Promise(function (s, j) { var q = tx('readwrite').delete(i); q.onsuccess = function () { s(); }; q.onerror = function () { j(q.error); }; }); }
  function dbAll() { return new Promise(function (s, j) { var q = tx('readonly').getAll(); q.onsuccess = function () { s(q.result || []); }; q.onerror = function () { j(q.error); }; }); }

  // ---- runtime state ----
  var liveTrains = [];
  var clockOffsetMs = 0, lastRtt = 0, lastPollAt = 0, lastPollOk = false;
  var episodeSet = {}, lastCaptureId = null, pending = null, showElsewhere = false;
  var barrierUp = null;                          // null = unknown (ask arrival state)
  var endArmed = false;                          // "End session" tapped once, awaiting confirm
  var ARRIVAL_KEY = 'observer-arrival-' + CROSSING_ID;
  var SESSION_END_KEY = 'observer-session-end-' + CROSSING_ID;
  // ---- prediction state (the public app's, via the shared core) ----
  var CFG = null;                 // shared/crossings.json entry — confidence-window tiers
  var predPeriods = [];           // backend closures, mapped
  var predTrains = [];            // the closures' trains, for the headcode → bestTime join
  var pred = null;                // last PREDICT.derive result
  var predAt = 0, predOk = false;

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function toast(msg) { var e = $('toast'); e.textContent = msg; e.classList.remove('hidden'); clearTimeout(toast._t); toast._t = setTimeout(function () { e.classList.add('hidden'); }, 1800); }
  function correctedNow() { return Date.now() + clockOffsetMs; }
  function partition() { var a = [], r = []; liveTrains.forEach(function (t) { (isApproaching(t) ? a : r).push(t); }); return { appr: a, rest: r }; }
  // Order off-chain trains by proximity: those with a derived time-to-crossing
  // first (nearest → furthest), then trains with no path to Portslade by recency.
  function byProximity(list) {
    return list.slice().sort(function (a, b) {
      var ea = offChainEta(a.direction, a.berth), eb = offChainEta(b.direction, b.berth);
      if (ea != null && eb != null) return ea - eb;
      if (ea != null) return -1;
      if (eb != null) return 1;
      var aa = a.ageSecs == null ? 1e9 : a.ageSecs, ba = b.ageSecs == null ? 1e9 : b.ageSecs;
      return aa - ba;
    });
  }

  // Scheduled + live Portslade time for a headcode, out of the predicted closures. The
  // public app's fbTimes does exactly this against the same payload — it is what gives
  // PREDICT.eta the backend's own predicted crossing time for a train.
  function joinTimes(hc) {
    for (var i = 0; i < predTrains.length; i++) {
      if (predTrains[i].headcode === hc) return { sched: predTrains[i].scheduledTime || null, live: predTrains[i].bestTime || null };
    }
    return { sched: null, live: null };
  }
  // Seconds to the crossing for ranking: the live figure, so a stopper dwelling at
  // Southwick doesn't outrank a fast that will actually get here first.
  function liveRank(t) {
    var e = PREDICT.eta(t);
    return (e && e.secs != null) ? e.secs : (t.prox ? t.prox.rank : 100000);
  }

  // ---- live feed poll (B1) ----
  function poll() {
    var t0 = Date.now();
    fetch(API_BASE + '/crossing/' + CROSSING_ID + '/live', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        var t1 = Date.now();
        if (typeof data.serverTime === 'number') { lastRtt = t1 - t0; clockOffsetMs = Math.round(data.serverTime - (t0 + lastRtt / 2)); }
        // Enriched, not raw: an enriched train is a superset of the feed record and carries
        // its chain position, berth-entry instant and predicted crossing time, which is what
        // the labels, the ranking and the feedback payload all need.
        var raw = Array.isArray(data.trains) ? data.trains : [];
        liveTrains = raw.map(function (t) { return PREDICT.enrich(t, joinTimes); });
        liveTrains.forEach(function (t) { if (t.headcode) episodeSet[t.headcode] = true; });
        lastPollAt = Date.now(); lastPollOk = true;
        renderStrip(); renderElsewhere(); renderStatus(); if (pending) renderPicker();
      })
      .catch(function () { lastPollOk = false; renderStatus(); });
  }

  // ---- prediction poll (the same endpoint and the same core as the public app) ----
  function pollPrediction() {
    fetch(API_BASE + '/crossing/' + CROSSING_ID, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        predPeriods = PREDICT.buildClosures(data.upcomingClosures, CFG);
        predTrains = PREDICT.parseTrains(data);
        predAt = Date.now(); predOk = true;
        renderPrediction();
      })
      .catch(function () { predOk = false; renderPrediction(); });
  }
  // Re-derived every second, because the passage of time alone changes the answer.
  //
  // On the DEVICE clock, not the server-corrected one, even though this app has the
  // correction available. The panel's claim is "this is what the public app is showing",
  // and the public app has only the device clock — deriving from a better clock here would
  // make the two disagree in exactly the situation the panel is meant to detect. The
  // correction is applied where it is physically necessary instead: the capture timestamp
  // and the observed-minus-predicted delta (see predStamp).
  function renderPrediction() {
    pred = predPeriods.length ? PREDICT.derive(predPeriods, new Date()) : null;
    var age = predAt ? Math.round((Date.now() - predAt) / 1000) : null;
    $('predAge').textContent = !predOk ? 'offline' : (age != null ? age + 's ago' : '—');
    $('predAge').className = 'pred-age' + (!predOk || (age != null && age > 90) ? ' bad' : '');
    var st = pred ? pred.status : null;
    $('predState').textContent = PREDICT.stateLabel(st) || 'no prediction';
    $('predState').className = 'pred-state' + (st ? ' is-' + st.toLowerCase() : '');
    var t = Date.now();
    setPredCard('predClose', 'predCloseAt', pred && pred.nextCloseTime, t);
    setPredCard('predOpen', 'predOpenAt', pred && pred.nextOpenTime, t);
    var dfm = pred && pred.downForMs;
    $('predDown').textContent = (dfm != null && dfm > 0) ? PREDICT.fmtDownFor(dfm) : '--';
    $('predDownRange').textContent = (dfm != null && dfm > 0) ? pred.downForRange : '';
  }
  function setPredCard(valId, subId, when, nowMs) {
    $(valId).textContent = when ? PREDICT.fmtSoon(when.getTime() - nowMs) : '--';
    $(subId).textContent = when ? PREDICT.fmtShort(when) : '';
  }
  // The prediction as it stood at the instant of a capture, plus the number this whole
  // exercise exists to produce: observed minus predicted, in seconds. Positive = the
  // barrier moved LATER than the app said.
  function predStamp(type, tCorrected) {
    if (!pred) return { predictedState: '', predictedCloseTime: '', predictedOpenTime: '', predictedDownForSecs: '', deltaVsPredictedSecs: '' };
    var target = type === 'CLOSE'
      ? (pred.current ? (pred.current.predictedStart || pred.current.start) : pred.nextCloseTime)
      : (pred.current ? pred.current.end : (pred.upcoming ? pred.upcoming.end : null));
    return {
      predictedState: PREDICT.stateLabel(pred.status),
      predictedCloseTime: pred.nextCloseTime ? pred.nextCloseTime.toISOString() : '',
      predictedOpenTime: pred.nextOpenTime ? pred.nextOpenTime.toISOString() : '',
      predictedDownForSecs: pred.downForMs != null ? Math.round(pred.downForMs / 1000) : '',
      deltaVsPredictedSecs: target ? Math.round((tCorrected - target.getTime()) / 1000) : ''
    };
  }

  // ---- capture (single alternating action) ----
  // The barrier is a 2-state machine; the one button always offers the only
  // valid next transition. barrierUp===null means we don't yet know the state
  // (fresh log) and must ask for it on arrival.
  // The full enriched feed, frozen at the capture instant with each train's position label
  // as it read AT THAT MOMENT. Positions keep moving afterwards; the recorded one must not,
  // or the calibration row describes a train's position minutes after the barrier moved.
  function buildSnapshot() {
    return liveTrains.map(function (t) {
      var c = Object.assign({}, t);
      c.posLabel = posLabel(t) || 'Elsewhere in the area';
      return c;
    });
  }
  function setArrival(up) {
    barrierUp = up;
    try { localStorage.setItem(ARRIVAL_KEY, up ? 'up' : 'down'); localStorage.removeItem(SESSION_END_KEY); } catch (e) { }
    endArmed = false;
    renderCaptureControls(); toast('Barrier set ' + (up ? 'UP ▲' : 'DOWN ▼'));
  }
  // End the session: forget which way the barrier is, so the next visit starts from the
  // "when you arrived, was the barrier…" question again.
  //
  // Nulling barrierUp is not enough — recomputeState() re-derives it from the last event in
  // the log on every refresh, so it would come straight back. A timestamp marker is what
  // makes it stick: events before it belong to a finished session and no longer imply a
  // current state. NOTHING is deleted. The captures, the tally and the export are all
  // untouched; this ends a session, it does not discard one.
  //
  // Two taps to confirm, and no confirm() dialog — a modal dialog blocks the page, and this
  // app's whole job is being ready for a barrier that moves without warning.
  function endSession() {
    if (!endArmed) {
      endArmed = true; renderCaptureControls();
      clearTimeout(endSession._t);
      endSession._t = setTimeout(function () { endArmed = false; renderCaptureControls(); }, 4000);
      return;
    }
    endArmed = false;
    try { localStorage.setItem(SESSION_END_KEY, String(Date.now())); localStorage.removeItem(ARRIVAL_KEY); } catch (e) { }
    barrierUp = null; episodeSet = {}; lastCaptureId = null;
    if (pending) { pending = null; $('attrPanel').classList.add('hidden'); }
    renderCaptureControls(); refreshLocal(); toast('Session ended — captures kept');
  }
  function sessionEndedAt() {
    try { var v = parseInt(localStorage.getItem(SESSION_END_KEY) || '', 10); return isFinite(v) ? v : 0; } catch (e) { return 0; }
  }
  function capture() {
    if (barrierUp === null) { toast('First set the barrier state on arrival'); return; }
    var type = barrierUp ? 'CLOSE' : 'OPEN';
    if (navigator.vibrate) navigator.vibrate(35);
    var btn = $('btnAction'); btn.classList.remove('flash'); void btn.offsetWidth; btn.classList.add('flash');
    var tDev = Date.now();
    var sug = type === 'CLOSE' ? suggestForClose(liveTrains) : suggestForOpen(liveTrains);
    var rec = {
      eventType: type, observed: true, isSkip: false, priorState: barrierUp ? 'up' : 'down',
      tCapturedDevice: tDev, tCorrected: tDev + clockOffsetMs, crossingId: CROSSING_ID,
      train: sug ? { headcode: sug.headcode, direction: sug.direction, stopping: sug.stopping } : null,
      suggestedHeadcode: sug ? sug.headcode : null, suggestionAccepted: false, confidence: null,
      episodeTrains: type === 'OPEN' ? Object.keys(episodeSet) : [], liveSnapshot: buildSnapshot(),
      // What the app was predicting at this instant, frozen with the observation. Without
      // it the timestamp says when the barrier moved but not what we got wrong.
      pred: predStamp(type, tDev + clockOffsetMs),
      // Ties the tap-time row and the post-Save row together in the sheet.
      eventId: (tDev + clockOffsetMs) + '-' + Math.random().toString(36).slice(2, 7),
      note: '', offsetMs: clockOffsetMs, createdAt: Date.now()
    };
    if (type === 'CLOSE') { episodeSet = {}; liveTrains.forEach(function (t) { if (t.headcode) episodeSet[t.headcode] = true; }); }
    barrierUp = (type === 'OPEN');               // optimistic flip; refreshLocal reconciles from DB
    try { localStorage.removeItem(ARRIVAL_KEY); } catch (e) { }
    renderCaptureControls();
    dbAdd(rec).then(function (id) { rec.id = id; lastCaptureId = id; openAttr(rec); refreshLocal(); fbSend(rec, false); });
  }
  // Skip = "a transition happened here I didn't capture": logs the expected event
  // as UNOBSERVED (time approximate, no train) and advances the state.
  function skip() {
    if (barrierUp === null) { toast('First set the barrier state on arrival'); return; }
    var type = barrierUp ? 'CLOSE' : 'OPEN';
    if (navigator.vibrate) navigator.vibrate([20, 40, 20]);
    var tDev = Date.now();
    var rec = {
      eventType: type, observed: false, isSkip: true, priorState: barrierUp ? 'up' : 'down',
      tCapturedDevice: tDev, tCorrected: tDev + clockOffsetMs, crossingId: CROSSING_ID,
      train: null, suggestedHeadcode: null, suggestionAccepted: false, confidence: null,
      episodeTrains: type === 'OPEN' ? Object.keys(episodeSet) : [], liveSnapshot: buildSnapshot(),
      pred: predStamp(type, tDev + clockOffsetMs),
      eventId: (tDev + clockOffsetMs) + '-' + Math.random().toString(36).slice(2, 7),
      note: 'missed (skipped) — time approximate', offsetMs: clockOffsetMs, createdAt: Date.now()
    };
    if (type === 'CLOSE') { episodeSet = {}; liveTrains.forEach(function (t) { if (t.headcode) episodeSet[t.headcode] = true; }); }
    barrierUp = (type === 'OPEN');
    try { localStorage.removeItem(ARRIVAL_KEY); } catch (e) { }
    renderCaptureControls();
    dbAdd(rec).then(function (id) { rec.id = id; lastCaptureId = id; refreshLocal(); fbSend(rec, true); toast('Marked a missed ' + type); });
  }
  function renderCaptureControls() {
    var arrival = $('arrivalPrompt'), main = $('capMain');
    if (!arrival || !main) return;
    // No known barrier state means there is no session to end, so disarm — otherwise a
    // half-tapped "End session" survives in the hidden panel into the next session.
    if (barrierUp === null) {
      arrival.classList.remove('hidden'); main.classList.add('hidden');
      endArmed = false; $('btnEnd').textContent = 'End session'; $('btnEnd').classList.remove('armed');
      return;
    }
    arrival.classList.add('hidden'); main.classList.remove('hidden');
    var type = barrierUp ? 'CLOSE' : 'OPEN', btn = $('btnAction');
    btn.classList.toggle('is-close', type === 'CLOSE');
    btn.classList.toggle('is-open', type === 'OPEN');
    $('capLabel').textContent = type;
    $('capSub').textContent = type === 'CLOSE' ? 'red lights start — barrier going down' : 'booms fully up — barrier going up';
    $('stateInd').innerHTML = barrierUp
      ? 'Barrier is <b class="up">UP ▲</b> — tap when the red lights start'
      : 'Barrier is <b class="down">DOWN ▼</b> — tap when the booms are fully up';
    $('btnSkip').textContent = 'Missed the ' + type + ' — skip ▸';
    var eb = $('btnEnd');
    eb.textContent = endArmed ? 'Tap again to end the session' : 'End session';
    eb.classList.toggle('armed', endArmed);
  }

  // ---- feedback sheet ----
  // Observer captures go to the SAME Google Sheet tab as the public app's feedback, through
  // the shared PREDICT.feedbackPayload, so a row means the same thing whichever app recorded
  // it — the Source column says which. Posted twice on one eventId: once at the tap (so an
  // abandoned attribution is still on record) and again on Save, which the Apps Script
  // upserts onto the same row.
  //
  // CLOSE/OPEN map to closing/opening because that is the public app's vocabulary for the
  // Event column, and one column should not speak two languages.
  function fbEventFor(rec) {
    var snap = {};
    (rec.liveSnapshot || []).forEach(function (t) { if (t.headcode) snap[t.headcode] = t; });
    return {
      eventId: rec.eventId,
      type: rec.eventType === 'CLOSE' ? 'closing' : 'opening',
      tsISO: new Date(rec.tCorrected).toISOString(),
      crossing: CROSSING_ID, crossingName: (CFG && CFG.name) || CROSSING_ID,
      predictedState: (rec.pred && rec.pred.predictedState) || '',
      snapshot: snap,
      guess: rec.suggestedHeadcode ? (snap[rec.suggestedHeadcode] || null) : null
    };
  }
  // The observer-only columns. Everything here is either unavailable to the public app
  // (a human's confidence, a note, a missed transition) or only meaningful beside a
  // human-observed instant (the delta against what we predicted).
  function fbExtraFor(rec, ep) {
    var p = rec.pred || {};
    var m = (ep && ep[rec.id]) || {};
    return {
      source: 'observer',
      observed: !rec.isSkip && rec.observed !== false,
      confidence: rec.confidence || '',
      note: rec.note || '',
      episodeIndex: m.episodeIndex || '',
      closureDurationMs: m.durationMs != null ? m.durationMs : '',
      deviceOffsetMs: rec.offsetMs != null ? rec.offsetMs : '',
      predictedCloseTime: p.predictedCloseTime || '',
      predictedOpenTime: p.predictedOpenTime || '',
      predictedDownForSecs: p.predictedDownForSecs != null ? p.predictedDownForSecs : '',
      deltaVsPredictedSecs: p.deltaVsPredictedSecs != null ? p.deltaVsPredictedSecs : ''
    };
  }
  // Fire-and-forget, exactly as the public app posts: no-cors, so the response is opaque
  // and cannot be checked. postedAt therefore means "the request left the device", not
  // "the sheet has it" — the local DB and the CSV export stay the record of truth, and the
  // export note surfaces anything that never got sent.
  function fbSend(rec, completed, ep) {
    if (!CFG || !CFG.feedbackUrl || !rec.eventId) return;
    var payload = PREDICT.feedbackPayload(fbEventFor(rec), completed ? (rec.train ? rec.train.headcode : null) : null,
                                          completed, fbExtraFor(rec, ep));
    if (!payload) return;
    if (completed) payload.notSure = !rec.train;
    fetch(CFG.feedbackUrl, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function () { markPosted(rec.id); })
      .catch(function () { });
  }
  function markPosted(id) {
    if (id == null) return;
    dbAll().then(function (all) {
      var rec = all.filter(function (r) { return r.id === id; })[0];
      if (!rec || rec.postedAt) return;
      rec.postedAt = Date.now(); dbPut(rec).then(refreshLocal);
    });
  }

  // ---- attribution ----
  function openAttr(rec) {
    pending = { id: rec.id, eventType: rec.eventType, train: rec.train ? Object.assign({}, rec.train) : null, confidence: rec.confidence, note: rec.note || '', suggestedHeadcode: rec.suggestedHeadcode };
    $('attrTitle').textContent = 'Which train caused this ' + rec.eventType + '?';
    $('attrTime').textContent = hms(rec.tCorrected);
    var sug = rec.suggestedHeadcode ? liveTrains.filter(function (t) { return t.headcode === rec.suggestedHeadcode; })[0] : null;
    if (sug) { var p = posLabel(sug); $('attrSuggest').innerHTML = 'Suggested: <b>' + identity(sug) + '</b><br>' + dirWord(sug.direction) + (p ? ' · ' + p : '') + ' · <span class="mono">' + sug.headcode + '</span>'; }
    else $('attrSuggest').innerHTML = 'No clear approaching train — pick from the list, or mark Unknown.';
    $('attrNote').value = pending.note;
    renderConf(); renderPicker(); $('attrPanel').classList.remove('hidden'); $('attrPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function renderConf() { var b = document.querySelectorAll('.conf-btn'); for (var i = 0; i < b.length; i++) b[i].classList.toggle('sel', b[i].dataset.conf === pending.confidence); }
  function pickRow(t) {
    var sel = pending.train && pending.train.headcode === t.headcode, p = posLabel(t);
    var row = el('div', 'pick' + (sel ? ' sel' : '') + (t.headcode === pending.suggestedHeadcode ? ' suggested' : ''));
    row.innerHTML = '<span class="dir">' + dirArrow(t.direction) + '</span><span class="pick-main"><span class="pick-id">' + identity(t) + '</span><span class="pick-sub">' + dirWord(t.direction) + (p ? ' · ' + p : '') + '</span></span><span class="meta"><span class="mono">' + t.headcode + '</span><br>' + (t.berth || '?') + ' · ' + ageStr(t) + '</span>';
    row.onclick = function () { pending.train = { headcode: t.headcode, direction: t.direction, stopping: t.stopping }; renderPicker(); };
    return row;
  }
  function renderPicker() {
    var box = $('attrPicker'); box.innerHTML = ''; var parts = partition();
    if (!liveTrains.length) { box.innerHTML = '<div class="empty">No trains in feed — mark Unknown or add a note.</div>'; return; }
    parts.appr.sort(function (a, b) {
      if (a.headcode === pending.suggestedHeadcode) return -1; if (b.headcode === pending.suggestedHeadcode) return 1;
      return liveRank(a) - liveRank(b);
    });
    if (parts.appr.length) { box.appendChild(el('div', 'pick-group', 'On the Portslade approach')); parts.appr.forEach(function (t) { box.appendChild(pickRow(t)); }); }
    if (parts.rest.length) {
      var tog = el('div', 'pick-toggle', (showElsewhere ? '▾ ' : '▸ ') + 'Elsewhere in area (' + parts.rest.length + ')');
      tog.onclick = function () { showElsewhere = !showElsewhere; renderPicker(); }; box.appendChild(tog);
      if (showElsewhere) byProximity(parts.rest).forEach(function (t) { box.appendChild(pickRow(t)); });
    }
  }
  function saveAttr() {
    if (!pending) return; var id = pending.id;
    dbAll().then(function (all) {
      var rec = all.filter(function (r) { return r.id === id; })[0]; if (!rec) return;
      rec.train = pending.train ? Object.assign({}, pending.train) : null;
      rec.suggestionAccepted = !!(rec.train && rec.suggestedHeadcode && rec.train.headcode === rec.suggestedHeadcode);
      rec.confidence = pending.confidence; rec.note = $('attrNote').value.trim();
      dbPut(rec).then(function () {
        $('attrPanel').classList.add('hidden'); pending = null; refreshLocal();
        fbSend(rec, true, computeEpisodes(chrono(activeOf(all))));
        toast('Saved');
      });
    });
  }

  // ---- state / episodes ----
  function activeOf(all) { return all.filter(function (r) { return !r.deleted; }); }
  function chrono(list) { return list.slice().sort(function (a, b) { return a.createdAt - b.createdAt; }); }
  // Current barrier state = the resulting state of the last event of THIS session (every
  // event, observed or skipped, sets a definite state by its type). Events from before the
  // last "End session" are history, not state — the barrier has moved any number of times
  // since. No event this session → arrival memory (localStorage), else unknown.
  function recomputeState(ac) {
    var since = sessionEndedAt();
    var mine = since ? ac.filter(function (r) { return r.createdAt > since; }) : ac;
    if (!mine.length) { var s = null; try { s = localStorage.getItem(ARRIVAL_KEY); } catch (e) { } barrierUp = s === 'up' ? true : s === 'down' ? false : null; return; }
    barrierUp = mine[mine.length - 1].eventType === 'OPEN';
  }
  // Pair CLOSE→OPEN into closure episodes → {id: {episodeIndex, role, durationMs,
  // hasSkip}}. An OPEN with no preceding CLOSE (barrier already down on arrival)
  // is its own episode with unknown duration.
  function computeEpisodes(ac) {
    var byId = {}, idx = 0, cur = null;
    ac.forEach(function (r) {
      if (r.eventType === 'CLOSE') {
        cur = { i: ++idx, closeId: r.id, closeT: r.tCorrected, hasSkip: !!r.isSkip };
        byId[r.id] = { episodeIndex: cur.i, role: 'close', durationMs: null, hasSkip: cur.hasSkip };
      } else if (cur) {
        if (r.isSkip) cur.hasSkip = true;
        var dur = (cur.closeT != null && r.tCorrected != null) ? (r.tCorrected - cur.closeT) : null;
        byId[r.id] = { episodeIndex: cur.i, role: 'open', durationMs: dur, hasSkip: cur.hasSkip };
        if (byId[cur.closeId]) byId[cur.closeId].hasSkip = cur.hasSkip;
        cur = null;
      } else {
        byId[r.id] = { episodeIndex: ++idx, role: 'open', durationMs: null, hasSkip: !!r.isSkip };
      }
    });
    return byId;
  }
  function fmtDur(ms) { if (ms == null) return ''; var s = Math.round(ms / 1000); if (s < 60) return s + 's'; var m = Math.floor(s / 60), r = s % 60; return m + 'm' + (r < 10 ? '0' + r : r) + 's'; }

  // ---- recent / tally / export ----
  function refreshLocal() {
    dbAll().then(function (all) {
      var active = activeOf(all), ac = chrono(active), ep = computeEpisodes(ac);
      recomputeState(ac); renderCaptureControls();
      renderRecent(active.slice().sort(function (a, b) { return b.createdAt - a.createdAt; }), ep);
      renderTally(active); renderExport(all);
    });
  }
  function renderRecent(all, ep) {
    var box = $('recentList'), recent = all.slice(0, 8);
    if (!recent.length) { box.innerHTML = '<div class="empty">No captures yet.</div>'; return; }
    box.innerHTML = '';
    recent.forEach(function (r) {
      var m = ep[r.id] || {};
      var who = r.isSkip ? 'missed — not observed' : (r.train ? (r.train.headcode + ' ' + dirArrow(r.train.direction)) : (r.note ? 'note' : 'unknown'));
      var dur = (m.role === 'open' && m.durationMs != null) ? ' · closed ' + fmtDur(m.durationMs) : '';
      var div = el('div', 'rec' + (r.isSkip ? ' rec-skip' : ''), '<span class="tag ' + (r.eventType === 'CLOSE' ? 'tag-close' : 'tag-open') + '">' + (r.isSkip ? 'SKIP' : r.eventType) + '</span><span class="rt">' + (r.isSkip ? '~' : '') + hms(r.tCorrected) + '</span><span class="rmeta">' + who + (r.confidence ? ' · ' + r.confidence : '') + dur + '</span><span class="ractions"></span>');
      var act = div.querySelector('.ractions');
      if (!r.isSkip) { var e = el('button', null, 'Edit'); e.onclick = function () { openAttr(r); }; act.appendChild(e); }
      var d = el('button', null, 'Del'); d.onclick = function () { delObs(r.id); }; act.appendChild(d);
      box.appendChild(div);
    });
  }
  function renderTally(all) {
    var c = { east_stop: 0, east_fast: 0, west: 0, consec: 0, other: 0 };
    all.forEach(function (r) { var k = categoryOf(r); if (k) c[k]++; });
    var box = $('tally'); box.innerHTML = '';
    Object.keys(CAT_LABELS).forEach(function (k) { box.appendChild(el('div', 'tally-cell', '<div class="tally-n">' + c[k] + '</div><div class="tally-l">' + CAT_LABELS[k] + '</div>')); });
    if (c.other) { var n = el('div', 'info-text', c.other + ' CLOSE event(s) unattributed/other'); n.style.gridColumn = '1 / -1'; box.appendChild(n); }
  }
  function renderExport(all) {
    var active = activeOf(all), del = all.length - active.length;
    $('storedCount').textContent = active.length + ' stored' + (del ? (' · ' + del + ' removed') : '');
    var ne = active.filter(function (r) { return !r.exportedAt; }).length;
    // A capture is stored locally whatever the network does. Say plainly when one never
    // reached the sheet, so a session in a bad-signal spot doesn't look like it synced.
    var ns = active.filter(function (r) { return !r.postedAt; }).length;
    $('exportNote').textContent = [
      ne ? (ne + ' not yet exported') : (all.length ? 'all exported' : 'nothing to export yet'),
      ns ? (ns + ' not sent to the sheet — the export below still has them') : ''
    ].filter(Boolean).join(' · ');
  }
  // Soft-delete: never erase — mark the record so the export keeps a full trail.
  function delObs(id) {
    dbAll().then(function (all) {
      var rec = all.filter(function (r) { return r.id === id; })[0]; if (!rec) return;
      rec.deleted = true; rec.deletedAt = Date.now();
      dbPut(rec).then(function () { if (lastCaptureId === id) lastCaptureId = null; refreshLocal(); toast('Removed (kept in export)'); });
    });
  }
  function undoLast() { if (lastCaptureId == null) { toast('Nothing to undo'); return; } delObs(lastCaptureId); }
  function download(name, mime, text) { var b = new Blob([text], { type: mime }), u = URL.createObjectURL(b), a = el('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 1000); }
  function stamp() { var d = new Date(); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()); }
  function exportAs(kind) {
    dbAll().then(function (all) {
      if (!all.length) { toast('Nothing to export'); return; }
      all.sort(function (a, b) { return a.createdAt - b.createdAt; });
      var ep = computeEpisodes(chrono(activeOf(all)));   // derive episode links / durations at export time
      var enriched = all.map(function (r) {
        var m = ep[r.id] || {};
        return Object.assign({}, r, { episodeIndex: m.episodeIndex || null, episodeRole: m.role || null, durationMs: m.durationMs != null ? m.durationMs : null, hasSkip: !!m.hasSkip });
      });
      if (kind === 'csv') download('observer-' + CROSSING_ID + '-' + stamp() + '.csv', 'text/csv', toCsv(enriched));
      else download('observer-' + CROSSING_ID + '-' + stamp() + '.json', 'application/json', JSON.stringify(enriched, null, 2));
      var now = Date.now(); Promise.all(all.map(function (r) { r.exportedAt = now; return dbPut(r); })).then(refreshLocal);
    });
  }

  // ---- rendering: clock, status, strip-map, elsewhere ----
  function renderClock() { $('clock').textContent = hms(correctedNow()); }
  function renderStatus() {
    var dot = $('netDot'), txt = $('netText'), age = lastPollAt ? Math.round((Date.now() - lastPollAt) / 1000) : null;
    if (!lastPollOk && age === null) { dot.className = 'dot dot-warn'; txt.textContent = 'connecting…'; }
    else if (!lastPollOk || (age != null && age > 8)) { dot.className = 'dot dot-bad'; txt.textContent = 'feed offline (capture still works)'; }
    else { dot.className = 'dot dot-ok'; txt.textContent = 'live'; }
    $('offsetText').textContent = 'offset ' + fmtOffset(clockOffsetMs);
    $('pollAge').textContent = age != null ? ('feed ' + age + 's') : 'feed --';
  }
  function gapPx(g) { return Math.max(12, Math.min(60, Math.round((g || 60) * 0.4))); }
  function splitChain(d) { var pre = [], post = [], x = false; CHAIN[d].forEach(function (n) { if (n.x) { x = true; return; } (x ? post : pre).push(n); }); return { pre: pre, post: post }; }
  function trainsAt(d, b) { return liveTrains.filter(function (t) { return t.direction === d && t.berth === b; }); }
  function nodeEl(d, n) {
    var pills = trainsAt(d, n.b).map(function (t) { return '<span class="tpill">' + dirArrow(d) + ' ' + shortName(t) + '</span>'; }).join('');
    var timing = n.ttc ? fmtTtc(n.ttc, false) : (n.tac ? fmtTtc(n.tac, true) : '');
    var ttc = timing ? '<span class="bttc">' + timing + '</span>' : '';
    return el('div', 'bnode' + (n.role ? ' role-' + n.role : ''),
      '<span class="bdot"></span><span class="btext"><span class="blabel">' + n.b + (n.role ? ' · ' + n.role : '') + '</span>' + ttc + '</span><span class="bpills">' + pills + '</span>');
  }
  // flow 'down' = train travels top→bottom (dwell in the upper node spaces to the
  // next); 'up' = travels bottom→top (dwell in the lower node spaces to the next).
  function colBand(d, nodes, flow) {
    var col = el('div', 'xcol');
    nodes.forEach(function (n, i) {
      col.appendChild(nodeEl(d, n));
      if (i < nodes.length - 1) { var g = flow === 'down' ? n.gap : nodes[i + 1].gap; var sp = el('div', 'bgap'); sp.style.height = gapPx(g) + 'px'; col.appendChild(sp); }
    });
    return col;
  }
  // Both directions share one horizontal BOUNDARY ROAD bar. Eastbound runs
  // DOWN (approach above the bar, cleared below); westbound runs UP (approach
  // below, cleared above) — so the two flows are mirror images meeting at the bar.
  function renderStrip() {
    var box = $('approachView'); box.innerHTML = '';
    var e = splitChain('east'), w = splitChain('west');
    var head = el('div', 'xhead');
    head.appendChild(el('div', 'xhcell', 'Eastbound ▼'));
    head.appendChild(el('div', 'xhcell', 'Westbound ▲'));
    box.appendChild(head);
    var top = el('div', 'xband xtop');
    top.appendChild(colBand('east', e.pre, 'down'));               // east approach (above, descending)
    top.appendChild(colBand('west', w.post.slice().reverse(), 'up')); // west cleared (above)
    box.appendChild(top);
    box.appendChild(el('div', 'xbar', '║  BOUNDARY ROAD CROSSING  ║'));
    var bot = el('div', 'xband xbot');
    bot.appendChild(colBand('east', e.post, 'down'));              // east cleared (below)
    bot.appendChild(colBand('west', w.pre.slice().reverse(), 'up'));  // west approach (below, ascending)
    box.appendChild(bot);
    if (!liveTrains.some(isApproaching)) box.appendChild(el('div', 'info-text', 'No trains on the Portslade chain right now — they appear on a berth as they enter area LA.'));
  }
  function renderElsewhere() {
    var rest = byProximity(partition().rest);
    $('elsewhereCount').textContent = rest.length ? (rest.length + ' in wider area') : '';
    var box = $('liveList');
    if (!rest.length) { box.innerHTML = '<div class="empty">Nothing else in the area.</div>'; return; }
    box.innerHTML = '';
    rest.forEach(function (t) {
      var eta = offChainEta(t.direction, t.berth);
      var sub = dirWord(t.direction) + (eta != null ? ' · ~' + fmtEta(eta) + ' to crossing (est)' : '');
      box.appendChild(el('div', 'train', '<span class="dir">' + dirArrow(t.direction) + '</span><span class="pick-main"><span class="pick-id">' + identity(t) + '</span><span class="pick-sub">' + sub + '</span></span><span class="right"><span class="mono">' + t.headcode + '</span><br>' + (t.berth || '?') + ' · ' + ageStr(t) + '</span>'));
    });
  }

  // ---- init ----
  function init() {
    $('btnAction').onclick = capture;
    $('btnSkip').onclick = skip;
    $('btnEnd').onclick = endSession;
    $('arrUp').onclick = function () { setArrival(true); };
    $('arrDown').onclick = function () { setArrival(false); };
    $('attrSave').onclick = saveAttr;
    $('attrUnknown').onclick = function () { if (pending) { pending.train = null; renderPicker(); } };
    $('undoBtn').onclick = undoLast;
    $('exportCsv').onclick = function () { exportAs('csv'); };
    $('exportJson').onclick = function () { exportAs('json'); };
    var cb = document.querySelectorAll('.conf-btn');
    for (var i = 0; i < cb.length; i++) cb[i].onclick = (function (b) { return function () { if (pending) { pending.confidence = b.dataset.conf; renderConf(); } }; })(cb[i]);
    renderClock(); setInterval(renderClock, 250);
    renderStatus(); setInterval(renderStatus, 1000);
    openDb().then(function () { refreshLocal(); }).catch(function (e) { toast('Storage error: ' + e.message); });
    // Config first: the confidence-window tiers come from the same shared/crossings.json the
    // public app reads. The prediction poll starts either way — the tiers only affect the ±
    // band, which this panel doesn't show, so a config failure must not cost us a prediction.
    fetch('../../shared/crossings.json', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (all) { CFG = all[CROSSING_ID] || null; })
      .catch(function () { })
      .then(function () { pollPrediction(); setInterval(pollPrediction, PRED_POLL_MS); });
    renderPrediction(); setInterval(renderPrediction, 1000);
    poll(); setInterval(poll, POLL_MS);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () { });
  }
  document.addEventListener('DOMContentLoaded', init);
})();
