var API_BASE = 'https://api.railcrossing.uk';
var BASE_URL = 'https://railcrossing.uk/';

var CFG = null;
var trains = [];
var closurePeriods = [];
var vpsClosures = []; // raw backend-computed closures from the last fetch (authoritative timing)
var nextCloseTime = null;
var nextOpenTime = null;
// "Down For" card: how long the barrier is expected to be down for the closure the
// other two cards refer to — the CURRENT one while closed, otherwise the next one.
var lastError = '';
var trainHistory = [];
var crossingId = '';
var lastPassedTrain = null;
var closuresVisible = 3;
// How many closures the backend holds (it now sends only as many as we asked for), and how
// old the last payload is — the latter bounds how long we'll honour a holdingOpen period,
// so a device that has lost the backend can't sit on BARRIERS DOWN forever.
var closureTotal = 0;
var lastPayloadAt = 0;
var payloadAgeMs = Infinity;

var isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
var isAndroid = /Android/.test(navigator.userAgent);
var lastRefreshTs = null;

function $(id) { return document.getElementById(id); }
// The formatters, the closure mapping and the prediction itself all live in
// shared/predict.js, and the observer app renders the same values from the same
// functions — so neither app can drift into its own idea of what the barrier is doing.
// Aliased here so the call sites below read as they always did. Do NOT reintroduce a
// local copy of any of these: a second implementation is exactly the failure this file
// was split to prevent.
var fmtTime = PREDICT.fmtTime, fmtShort = PREDICT.fmtShort, fmtCountdown = PREDICT.fmtCountdown,
    fmtUncertainty = PREDICT.fmtUncertainty, fmtWhen = PREDICT.fmtWhen, fmtSoon = PREDICT.fmtSoon,
    fmtDuration = PREDICT.fmtDuration, fmtDownFor = PREDICT.fmtDownFor;
// How long the crossing stays clear from `time`: the gap to the first predicted close after
// it. Walks the period list rather than reading derive(), which surfaces only the FIRST
// upcoming closure — while the crossing is clear the relevant one is the second, because the
// first is the closure we are counting down to. Null when the backend sent nothing beyond it.
function gapToNextCloseAfter(time) {
  for (var i = 0; i < closurePeriods.length; i++) {
    var s = closurePeriods[i].predictedStart || closurePeriods[i].start;
    if (s.getTime() > time) return s.getTime() - time;
  }
  return null;
}
// ---- the two-slot event timeline ------------------------------------------------------
// Must match the .55s transition on .cards-track in crossing.css.
var CARD_SHIFT_MS = 550;
var cardLeftKind = null;   // 'open' | 'close' — what is in the left slot right now
var cardShiftEnd = 0;      // while now < this, an animation owns the DOM; don't touch it

// One card = one upcoming event: when it happens, over how long the state it starts lasts.
function buildEventCard(kind, pr, closedForMs, openForMs) {
  if (kind === 'open') {
    return { kind: 'open', at: pr.nextOpenTime, held: pr.openHeld,
             sub: pr.openHeld ? 'until train clears'
                              : (openForMs > 0 ? 'Open for ' + fmtDownFor(openForMs) : '') };
  }
  return { kind: 'close', at: pr.nextCloseTime, held: pr.closeHeld,
           sub: pr.closeHeld ? 'train held'
                             : (closedForMs > 0 ? 'Closed for ' + fmtDownFor(closedForMs) : '') };
}

// fmtEta renders a held value as "≥ 1m 40s" and a live one as the plain countdown; the
// sub-line says so in words when held, because a bound has no duration to promise.
function fillEventCard(slot, ev, t) {
  $('c' + slot + 'label').textContent = ev ? (ev.kind === 'open' ? 'Next Open' : 'Next Close') : '';
  var v = $('c' + slot + 'value');
  if (!ev || !ev.at) {
    v.textContent = ev ? '--' : ''; v.style.color = '#475569';
    $('c' + slot + 'sub').textContent = ''; return;
  }
  v.textContent = PREDICT.fmtEta(ev.at.getTime() - t, ev.held);
  v.style.color = ev.held ? '#94A3B8' : (ev.kind === 'open' ? '#16A34A' : '#F59E0B');
  $('c' + slot + 'sub').textContent = ev.sub;
}

// The slots are positional: slot 0 is whatever happens NEXT. While the barriers are down
// that is the open; while the crossing is clear it is the close. So the pair swaps order
// exactly when an event happens, and the swap is animated as a push rather than a redraw —
// the spent card slides out left, the other takes its place, and the following event comes
// in from the right.
//
// The trigger is the left slot changing KIND, which is precisely "an event has happened":
// CROSSING CLEAR -> CLOSING SOON leaves it alone (nothing has happened yet), CLOSING SOON ->
// BARRIERS DOWN flips it. Nothing here reads the status directly for that reason.
function renderEventCards(pr, t, closedForMs, openForMs) {
  var kinds = pr.status === 'CLOSED' ? ['open', 'close'] : ['close', 'open'];
  var evs = [buildEventCard(kinds[0], pr, closedForMs, openForMs),
             buildEventCard(kinds[1], pr, closedForMs, openForMs)];
  var track = $('cardsTrack');
  // Mid-animation: leave the DOM alone. The shifted strip is showing slots 1 and 2, which
  // ARE the current pair, so arriving here late costs nothing but a second of countdown.
  if (t < cardShiftEnd) return;
  if (cardShiftEnd) {
    cardShiftEnd = 0;
    track.style.transition = 'none';        // snap back without animating the return
    track.classList.remove('shifted');
    track.offsetHeight;                     // reflow, so the removal is not transitioned
    track.style.transition = '';
  }
  // No animation without a real browser: the audit harnesses run this file against a stub
  // DOM with no rAF and no working timers, and must still get the right text in the slots.
  var canAnimate = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function';
  var shift = canAnimate && cardLeftKind !== null && cardLeftKind !== kinds[0];
  cardLeftKind = kinds[0];
  if (!shift) {
    fillEventCard(0, evs[0], t); fillEventCard(1, evs[1], t); fillEventCard(2, null, t);
    return;
  }
  // Stage the arriving card off-screen, then push. Slot 1 already holds evs[0] — it is the
  // same event, one position along — so the strip stays continuous through the move.
  fillEventCard(2, evs[1], t);
  cardShiftEnd = t + CARD_SHIFT_MS;
  window.requestAnimationFrame(function () { track.classList.add('shifted'); });
}

function getColors(st) {
  switch(st) {
    case 'CLOSED': return {bg:'#DC2626',text:'#FFF',glow:'0 0 30px rgba(220,38,38,.5)'};
    case 'CLOSING_SOON': return {bg:'#F59E0B',text:'#000',glow:'0 0 30px rgba(245,158,11,.5)'};
    case 'OPEN': return {bg:'#16A34A',text:'#FFF',glow:'0 0 30px rgba(22,163,74,.5)'};
    default: return {bg:'#6B7280',text:'#FFF',glow:'none'};
  }
}

// Direction-dependent config helpers — supports both old flat values and new {east, west} objects
function getCloseBefore(direction) {
  if (CFG.closeBefore && typeof CFG.closeBefore === 'object') return CFG.closeBefore[direction] || 1.5;
  return CFG.closeBefore || 1.5;
}
function getOpenAfter(direction, train) {
  // Freight trains take longer to clear — use openAfterFreight if set (calibrated from feedback)
  if (train && train.trainType === 'freight' && CFG.openAfterFreight != null) return CFG.openAfterFreight;
  if (CFG.openAfter && typeof CFG.openAfter === 'object') return CFG.openAfter[direction] || 0.75;
  return CFG.openAfter || 0.75;
}

async function fetchNationalRail() {
  lastError = '';
  vpsClosures = [];
  try {
    // Ask only for as many closures as we can currently display. The default response used
    // to carry the whole day — 22 periods, 18.4 KB measured, of which the page shows three
    // — and that payload was the reason the poll had to be slow. `?limit=` is what makes a
    // 10s refresh cheaper than the old 30s one; Show More raises it (see showMoreClosures).
    var url = API_BASE + '/crossing/' + crossingId + '?limit=' + Math.max(6, closuresVisible + 1);
    var response = await fetch(url);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    var data = await response.json();
    vpsClosures = data.upcomingClosures || [];
    // How many the backend HAS, which is no longer the same as how many it sent.
    closureTotal = typeof data.closureCount === 'number' ? data.closureCount : vpsClosures.length;
    payloadAgeMs = 0;
    lastPayloadAt = Date.now();
    return parseVpsResponse(data);
  } catch(e) {
    console.error('VPS API error:', e);
    lastError = e.message;
    return [];
  }
}

// Both of these are thin wrappers over the shared core — see shared/predict.js.
// Convert the VPS /crossing/<id> JSON into the train-array shape the rest of the app
// expects (backend already deduped + sorted).
function parseVpsResponse(data) { return PREDICT.parseTrains(data); }
// Build display periods straight from the backend's pre-computed closures.
function buildClosuresFromVps(closures) { return PREDICT.buildClosures(closures, CFG); }

var refreshSvgArrow = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 8a6 6 0 11-1.5-4"/><path d="M14 2v4h-4"/></svg>';
var refreshSvgTick = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.5 3.5 6.5-8"/></svg>';

function setRefreshState(state) {
  var btn = $('refreshBtn');
  if (!btn) return;
  if (state === 'loading') {
    btn.classList.remove('refresh-done');
    btn.innerHTML = refreshSvgArrow;
    btn.classList.remove('refreshing');
    void btn.offsetWidth;
    btn.classList.add('refreshing');
  } else if (state === 'done') {
    btn.classList.remove('refreshing');
    btn.classList.add('refresh-done');
    btn.innerHTML = refreshSvgTick;
    setTimeout(function() { setRefreshState('idle'); }, 1500);
  } else {
    btn.classList.remove('refreshing', 'refresh-done');
    btn.innerHTML = refreshSvgArrow;
  }
}

async function refreshData() {
  try {
    setRefreshState('loading');
    $('errorBox').classList.add('hidden');
    var liveTrains = await fetchNationalRail();
    if (liveTrains.length > 0) {
      trains = liveTrains;
      for (var th = 0; th < trains.length; th++) {
        var t = trains[th];
        var found = false;
        for (var hi = 0; hi < trainHistory.length; hi++) {
          if (trainHistory[hi].dedupKey === t.dedupKey) { found = true; trainHistory[hi] = t; break; }
        }
        if (!found) trainHistory.push(t);
      }
      var cutoff = new Date(new Date().getTime() - 3600000);
      trainHistory = trainHistory.filter(function(t) { return t.bestTime > cutoff; });
      lastRefreshTs = new Date();
    } else {
      trains = [];
      // The old "Data: LIVE" card is gone — LIVE was the expected state ~always and
      // told the user nothing. Only the failure cases are worth surfacing, and the
      // error box already does that; "no data" now gets its own message there.
      $('errorBox').textContent = lastError
        ? 'Error: ' + lastError
        : 'No live data — showing nothing rather than a stale guess.';
      $('errorBox').classList.remove('hidden');
    }
    // Render the backend's pre-computed closures — they carry the authoritative,
    // TD clear-step-anchored OPEN time (and hold-until-cleared). buildClosuresFromVps
    // safely returns [] when the backend sent none.
    closurePeriods = buildClosuresFromVps(vpsClosures);
    renderClosures();
    renderDebugPanel();
    setRefreshState('done');
  } catch(e) {
    console.error('Refresh error:', e);
    $('errorBox').textContent = 'Error: ' + e.message;
    $('errorBox').classList.remove('hidden');
    setRefreshState('idle');
  }
}

// The card markup itself lives in shared/closure-card.js, because the observer renders the
// SAME view and a second copy would let the two apps disagree about one closure — see the
// note at the top of that file. This function now owns only what is specific to the public
// app: which periods are relevant, and the Show More control.
function renderClosures() {
  var now = new Date();
  var relevant = CLOSURE_CARD.relevant(closurePeriods, now);
  if (!relevant.length) {
    $('closureList').innerHTML = '<div class="empty">No upcoming closures</div>';
    $('showMoreBtn').classList.add('hidden');
    return;
  }
  $('closureList').innerHTML = CLOSURE_CARD.listHtml(closurePeriods, now, closuresVisible);
  // "Are there more?" is now the BACKEND's count, not the length of what it sent — the
  // response is capped at what we asked for, so `relevant.length` can no longer answer it
  // and Show More would have hidden itself the moment the cap bound.
  var haveMore = Math.max(closureTotal, relevant.length);
  if (haveMore > closuresVisible) {
    $('showMoreBtn').textContent = 'Show More';
    $('showMoreBtn').classList.remove('hidden');
    $('showMoreBtn').disabled = false;
    $('showMoreBtn').style.opacity = '';
    $('showMoreBtn').style.cursor = '';
  } else if (closuresVisible > 3 && closuresVisible >= haveMore && relevant.length > 0) {
    $('showMoreBtn').textContent = 'Return later for further closures';
    $('showMoreBtn').classList.remove('hidden');
    $('showMoreBtn').disabled = true;
    $('showMoreBtn').style.opacity = '.5';
    $('showMoreBtn').style.cursor = 'default';
  } else {
    $('showMoreBtn').classList.add('hidden');
  }
}

function showMoreClosures() {
  closuresVisible += 5;
  // The backend now sends only what we asked for, so "show more" needs more fetching, not
  // just more rendering. Refresh immediately rather than waiting for the next tick.
  renderClosures();
  refreshData();
}

function updateStatus() {
  var now = new Date();
  var t = now.getTime();
  payloadAgeMs = lastPayloadAt ? (t - lastPayloadAt) : Infinity;
  // THE prediction — the same call the observer app makes, so the two can never show a
  // different state for the same moment. Everything below this line is presentation.
  var pr = PREDICT.derive(closurePeriods, now, payloadAgeMs);
  var status = pr.status, msg = '';
  var currentClosure = pr.current, upcoming = pr.upcoming;
  nextCloseTime = pr.nextCloseTime; nextOpenTime = pr.nextOpenTime;
  if (currentClosure) {
    var openMs = currentClosure.end.getTime() - t;
    // One headline and one countdown line, the same shape in every state — the card used to
    // carry a third line here (the reopen clock time) and nowhere else, which is what made
    // it change height on every state change. The clock time is still on the Next Open card.
    //
    // A held open has no time to reopen at — the train hasn't cleared the crossing, so we
    // genuinely don't know. Say that rather than counting down to a bound (register #14).
    if (pr.openHeld) { msg = 'Opening once the train is clear'; }
    else { msg = openMs <= 0 ? 'Opening soon' : 'Opening in ~' + fmtCountdown(openMs); }
    $('statusCard').classList.add('pulse');
  } else {
    $('statusCard').classList.remove('pulse');
    if (upcoming) {
      var ms = nextCloseTime.getTime() - t;
      // Held: a train is stopped short of the point that triggers the barrier, so the
      // countdown is a floor, not a prediction. Deliberately worded WITHOUT the berth —
      // "0006" means nothing to someone at the roadside. The observer, which is a field
      // tool, does name it. "≥" carries the floor in the space of one line: the long form
      // wrapped on a phone, and a line that sometimes wraps is a card that changes size.
      // Past the bound, fmtHeld reads "held", so drop the number rather than print "for held".
      if (pr.closeHeld) { msg = ms > 0 ? 'Train held — no closure for ' + PREDICT.fmtHeld(ms) : 'Train held on approach'; }
      else if (status === 'CLOSING_SOON') { msg = ms <= 0 ? 'Closing soon' : 'Closing in ~' + fmtCountdown(ms); }
      else { msg = 'Next closure in ~' + fmtCountdown(ms); }
    } else { msg = 'No more closures expected today'; }
  }
  var c = getColors(status);
  var card = $('statusCard');
  card.style.background = c.bg; card.style.color = c.text; card.style.boxShadow = c.glow;
  $('statusTitle').textContent = status === 'CLOSED' ? 'BARRIERS DOWN' : status === 'CLOSING_SOON' ? 'CLOSING SOON' : 'CROSSING CLEAR';
  $('statusMsg').textContent = msg;
  // Two booms, mirrored, so one angle drives both with the sign flipped. CLOSING_SOON sits
  // at 55° — nearer "up" than "down" on purpose: the old 30° drew a boom most of the way
  // down while the barrier was physically still up, which reads as "already closed".
  //
  // Angle only — the boom is the SAME length in every state and runs off the top of the
  // frame when raised (see the note on the svg). Do not reintroduce a scale here: shrinking
  // the boom as it rises keeps it in frame but draws a stubby half-boom, which reads as a
  // broken barrier rather than a raised one.
  var deg = status === 'CLOSED' ? 0 : status === 'CLOSING_SOON' ? 55 : 80;
  var barFill = status === 'CLOSED' ? '#DC2626' : status === 'CLOSING_SOON' ? '#F59E0B' : '#16A34A';
  var stripeFill = status === 'CLOSED' ? '#FFF' : status === 'CLOSING_SOON' ? '#000' : '#15803d';
  $('barrierArmL').style.transform = 'rotate(-' + deg + 'deg)';
  $('barrierArmR').style.transform = 'rotate(' + deg + 'deg)';
  document.querySelectorAll('.arm-bar').forEach(function(b) { b.setAttribute('fill', barFill); });
  document.querySelectorAll('.stripe').forEach(function(s) { s.setAttribute('fill', stripeFill); });
  // setAttribute('class'), NOT .className: on an SVG element className is a read-only
  // SVGAnimatedString, so `el.className = 'blink-a'` silently does nothing — which is why
  // the wig-wag lights appeared but never actually blinked.
  var lit = status === 'CLOSED';
  $('lightA').setAttribute('opacity', lit ? '1' : '0');
  $('lightB').setAttribute('opacity', lit ? '1' : '0');
  $('lightA').setAttribute('class', lit ? 'blink-a' : '');
  $('lightB').setAttribute('class', lit ? 'blink-b' : '');
  // Neither duration comes from pr.downForMs: that describes whichever closure is CURRENT,
  // which is the wrong one for a card about the NEXT one. "Closed for" is the length of the
  // upcoming closure; "Open for" is the gap from the reopen to the close after it.
  var closedForMs = upcoming ? upcoming.end.getTime() - (upcoming.predictedStart || upcoming.start).getTime() : null;
  var openForMs = nextOpenTime ? gapToNextCloseAfter(nextOpenTime.getTime()) : null;
  renderEventCards(pr, t, closedForMs, openForMs);
  renderClosures();

  var allForHistory = trainHistory.length > 0 ? trainHistory : trains;
  for (var lt = 0; lt < allForHistory.length; lt++) {
    if (allForHistory[lt].bestTime <= now) {
      if (!lastPassedTrain || allForHistory[lt].bestTime > lastPassedTrain.bestTime) {
        lastPassedTrain = allForHistory[lt];
      }
    }
  }
}

function renderDebugPanel() {
  var panel = $('debugPanel');
  if (!panel) return;
  if (window.location.search.indexOf('debug=1') < 0) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  var html = '<div class="dbg-hdr">DEBUG</div>';
  html += '<div class="dbg-row">Last refresh: ' + (lastRefreshTs ? fmtTime(lastRefreshTs) : '—') + '</div>';
  html += '<div class="dbg-row">Trains in last refresh: ' + trains.length + '</div>';

  if (CFG) {
    var cb = CFG.closeBefore, oa = CFG.openAfter;
    var cbStr = (typeof cb === 'object') ? 'E:' + cb.east + 'm W:' + cb.west + 'm' : cb + 'm';
    var oaStr = (typeof oa === 'object') ? 'E:' + oa.east + 'm W:' + oa.west + 'm' : oa + 'm';
    html += '<div class="dbg-row">closeBefore: ' + cbStr + ' · openAfter: ' + oaStr + '</div>';
  }

  html += '<div class="dbg-divider"></div>';

  if (!trains.length) {
    html += '<div class="dbg-row dbg-muted">No trains</div>';
  } else {
    for (var i = 0; i < trains.length; i++) {
      var t = trains[i];
      var cl = new Date(t.bestTime.getTime() - getCloseBefore(t.direction) * 60000);
      var op = new Date(t.bestTime.getTime() + getOpenAfter(t.direction, t) * 60000);
      var arrow = t.direction === 'east' ? '→' : '←';
      html += '<div class="dbg-row">' +
        fmtShort(t.scheduledTime || t.bestTime) + ' ' + arrow + ' ' +
        t.origin + ' → ' + t.destination +
        ' &nbsp;[' + fmtShort(cl) + '–' + fmtShort(op) + ']' +
        '</div>';
    }
  }

  panel.innerHTML = html;
}

// ============================================================================
// Barrier feedback — train picker.
// Tapping "Closing/Opening now" FREEZES the event moment (timestamp + a snapshot
// of every live train's position/times), then asks which train caused it.
// Positions keep updating live for identification, but the DATA recorded is the
// event-moment snapshot. Berth topology + time-to-crossing are ported from the
// observer app's 28-day TD derivation (Portslade-specific).
// ============================================================================
function fbArrow(d){ return d==='east'?'▶':d==='west'?'◀':'·'; }
function fbEsc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
// A gap in words. Coarse above two minutes (where the estimate can't support seconds),
// exact below it — which is the whole window in which someone is actually standing at the
// barrier choosing a train, and the reason this ticks at all.
function fbGap(secs){
  if(secs >= 120) return '~'+Math.round(secs/60)+' min';
  if(secs >= 60) return Math.floor(secs/60)+'m '+(secs%60)+'s';
  return secs+'s';
}
// The berth chain and the position maths are in shared/predict.js (PREDICT.proximity /
// PREDICT.eta) so the observer app measures distance-to-crossing exactly the same way.
// Only the WORDING is this app's: a passer-by wants "Approaching (~3 min)", the field
// observer wants seconds. That is the one thing the two apps are meant to differ on.
//
// Recomputed every second against `nowMs` rather than once per berth step. It used to be
// the latter, and the labels were effectively frozen: on the 2026-07-27 recording an
// eastbound train held "Approaching (~3 min)" for 177 s and then "About to pass the
// crossing" for another 166 s, so across the 10–30 s it takes to pick a train nothing
// moved at all — and the "~3 min" was still on screen when the train was 20 s out.
function fbPosLabel(t, nowMs){
  if(!t || !t.prox) return 'Elsewhere in the area';
  var e = PREDICT.eta(t, nowMs);
  // "Just" is a claim too — a train that cleared nine minutes ago is still on the chain,
  // and calling that "just passed" invites attributing an open event to the wrong train.
  if(t.prox.stage==='passed'){
    return (e.sinceSecs <= 180 ? 'Just passed the crossing (' : 'Passed the crossing (')+fbGap(e.sinceSecs)+' ago)';
  }
  // Overdue against its own predicted crossing time by more than a couple of minutes:
  // held at a signal, or sitting in a platform. Don't keep insisting it is imminent.
  if(e.overdueSecs > 120) return 'Held near the crossing';
  // "At the crossing" is a claim about where the train IS, so only make it when the berth
  // feed agrees — the protecting berth is the last one before the crossing. Both time
  // estimates will occasionally run a train's countdown to zero while it is still two
  // minutes out (measured on the 2026-07-27 recording: 14 such samples for the predicted
  // time, 17 for the berth median), and the berth is the half of this we actually know.
  if(t.prox.role === 'protecting' && e.secs <= 20) return 'At the crossing now';
  if(e.secs <= 5) return 'Any moment now';
  if(e.secs <= 90) return 'About to pass the crossing ('+fbGap(e.secs)+')';
  return 'Approaching ('+fbGap(e.secs)+')';
}
// Scheduled + live Portslade time for a headcode, joined from the closure trains.
function fbTimes(hc){
  var pool = trainHistory.length ? trainHistory : trains;
  for(var i=0;i<pool.length;i++){ if(pool[i].headcode===hc) return { sched: pool[i].scheduledTime||null, live: pool[i].bestTime||null }; }
  return { sched:null, live:null };
}
function fbEnrich(lt){
  var t = PREDICT.enrich(lt, fbTimes);
  t.posLabel = fbPosLabel(t);   // frozen at the event moment — this is what gets recorded
  return t;
}
function fetchLive(){
  return fetch(API_BASE+'/crossing/'+crossingId+'/live')
    .then(function(r){ return r.ok ? r.json() : { trains:[] }; })
    .then(function(d){ return d.trains || []; })
    .catch(function(){ return []; });
}
// The backend's trigger table (GET /crossing/:id/triggers), fetched once — it is static
// per deploy. It is what lets the picker rank trains against the instants the predictor
// actually fires on rather than against the crossing. Absent (old backend, failed fetch)
// the ranking degrades to distance-from-crossing, which is still correct in the ordinary
// case; see PREDICT.eventRank for why the reference point matters.
var fbTriggers = null;
function fbFetchTriggers(){
  fetch(API_BASE+'/crossing/'+crossingId+'/triggers', { cache:'no-store' })
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(d){ fbTriggers = d; })
    .catch(function(){ fbTriggers = null; });
}
// Which train an event belongs to, and the order the picker lists them in. Both are
// PREDICT.eventRank so the observer and this app cannot disagree about the same event —
// the ranking used to be `ageSecs` in both, separately, and was wrong in both.
function fbSuggest(type, enriched){
  return PREDICT.suggestForEvent(type, enriched, Date.now(), fbTriggers);
}
function fbSortKey(type, t){
  var r = PREDICT.eventRank(type, t, Date.now(), fbTriggers);
  return r == null ? 100000 + (t.ageSecs||0) : r;                      // off-chain: last
}

var fbEvent = null;      // frozen event snapshot { type, tsISO, predictedState, snapshot, order, guess }
var fbLive = {};         // headcode -> latest enriched train, for the live position line only
var fbPollTimer = null;
var fbTickTimer = null;
var fbMsgTimer = null;

function openFeedbackPicker(type){
  var tsISO = new Date().toISOString();   // freeze the event moment at the tap, before the fetch
  fetchLive().then(function(live){
    var enriched = live.map(fbEnrich);
    var order = enriched.slice().sort(function(a,b){ return fbSortKey(type,a)-fbSortKey(type,b); }).map(function(t){ return t.headcode; });
    var guess = fbSuggest(type, enriched);
    if(guess){ order = order.filter(function(h){ return h!==guess.headcode; }); order.unshift(guess.headcode); }
    var snap = {}; enriched.forEach(function(t){ snap[t.headcode] = t; });
    fbEvent = { eventId: tsISO+'-'+Math.random().toString(36).slice(2,7), type:type, tsISO:tsISO,
                crossing:crossingId, crossingName:CFG.name,
                predictedState:$('statusTitle').textContent, snapshot:snap, order:order, guess:guess };
    fbLive = {}; enriched.forEach(function(t){ fbLive[t.headcode] = t; });
    var m = $('fbMsg'); m.classList.remove('fb-shown'); m.classList.add('hidden'); clearTimeout(fbMsgTimer);
    renderFbPicker();
    fbOpenPicker();
    if(fbPollTimer) clearInterval(fbPollTimer);
    if(fbTickTimer) clearInterval(fbTickTimer);
    fbPollTimer = setInterval(fbPollLive, 2500);   // new berth positions
    fbTickTimer = setInterval(fbTickPositions, 1000);  // the countdown between them
    fbPost(fbBuildPayload(null, false));  // capture the event at button-tap, even if never completed
  });
}
function fbPollLive(){
  if(!fbEvent){ fbStopTimers(); return; }
  fetchLive().then(function(live){
    live.forEach(function(lt){ fbLive[lt.headcode] = PREDICT.enrich(lt, fbTimes); });
    renderFbPicker();
  });
}
// The per-second update. Touches ONLY the position line's text — re-rendering the whole
// picker every second would rebuild the candidate buttons under the user's finger while
// they are reaching for one.
function fbTickPositions(){
  if(!fbEvent){ fbStopTimers(); return; }
  var now = Date.now();
  fbEvent.order.slice(0, 3).forEach(function(hc){
    var el = $('fbPos-'+hc); if(!el) return;
    el.textContent = fbPosLabel(fbLive[hc] || fbEvent.snapshot[hc], now);
  });
}
function fbStopTimers(){
  if(fbPollTimer){ clearInterval(fbPollTimer); fbPollTimer = null; }
  if(fbTickTimer){ clearInterval(fbTickTimer); fbTickTimer = null; }
}
function fbMinOf(hhmm){ var m=/^(\d{1,2}):(\d{2})/.exec(hhmm||''); return m ? (parseInt(m[1],10)*60 + parseInt(m[2],10)) : null; }
// Direction-appropriate time for the card's right column: westbound departure,
// eastbound arrival, with a lateness tag vs schedule. Returns { time, tag, cls }.
function fbTimeParts(t){
  var isWest = t.direction==='west';
  var live = isWest ? t.liveDep : t.liveArr;
  var liveReal = isWest ? t.liveDepReal : t.liveArrReal;
  var sched = isWest ? t.schedDep : t.schedArr;
  var time = live || sched || t.liveStr || t.schedStr || '';
  if(!time) return { time:'', tag:'', cls:'' };
  // No real estimate means we are showing the timetable, so say so. Comparing the
  // fallback against schedule would find them equal and label a train of unknown
  // lateness "on time" — the worst answer, and it poisons the calibration set.
  if(!liveReal) return { time:time, tag:'timetabled', cls:'' };
  var lm = fbMinOf(liveReal), sm = fbMinOf(sched);
  if(lm!=null && sm!=null){
    var d = lm - sm;
    if(d===0) return { time:time, tag:'on time', cls:'fb-on' };
    return { time:time, tag:Math.abs(d)+'m '+(d>0?'late':'early'), cls:'fb-late' };
  }
  return { time:time, tag:'', cls:'' };
}
function fbCardHtml(hc, isGuess){
  var t = fbEvent.snapshot[hc]; if(!t) return '';
  // Position is the one thing on the card that is LIVE — everything else is the frozen
  // event-moment snapshot, because that is what gets recorded. fbTickPositions() rewrites
  // this line by id every second.
  var pos = fbPosLabel(fbLive[hc] || t);
  var typeTag = t.type==='freight'?'Freight · ':t.type==='ecs'?'Empty · ':'';
  var tm = fbTimeParts(t);
  var timeHtml = tm.time
    ? '<span class="fb-cand-time">'+fbEsc(tm.time)+(tm.tag?'<span class="fb-cand-late '+tm.cls+'">'+fbEsc(tm.tag)+'</span>':'')+'</span>'
    : '<span class="fb-cand-time fb-cand-tunk">–</span>';
  return '<button class="fb-cand'+(isGuess?' fb-cand-guess':'')+'" onclick="fbSubmit(\''+hc+'\')">'+
    (isGuess?'<div class="fb-guess-tag">Our guess</div>':'')+
    '<div class="fb-cand-top">'+
      '<span class="fb-cand-route">'+fbArrow(t.direction)+' '+fbEsc(typeTag+t.route)+'</span>'+
      timeHtml+
    '</div>'+
    '<div class="fb-cand-pos" id="fbPos-'+fbEsc(hc)+'">'+fbEsc(pos)+'</div>'+
    '</button>';
}
function renderFbPicker(){
  if(!fbEvent) return;
  var verb = fbEvent.type==='closing' ? 'closing' : 'opening';
  // The instruction has to name the direction of time, not just "the train you can
  // see": at a close the causing train has not reached the crossing yet, at an open
  // it already has, and "the train you can see" pointed at the wrong one half the time.
  var sub = fbEvent.type==='closing'
    ? 'Tap the train that next crosses the crossing — it helps us learn the exact timings'
    : 'Tap the train that just crossed the crossing — it helps us learn the exact timings';
  var order = fbEvent.order.slice(0, 3);
  var cards = order.map(function(hc){ return fbCardHtml(hc, fbEvent.guess && hc===fbEvent.guess.headcode); }).join('');
  if(!cards) cards = '<div class="fb-none">No trains detected nearby right now — tap below to just log the time.</div>';
  $('fbPicker').innerHTML =
    '<div class="fb-picker-hdr">Which train is '+verb+' the barrier?</div>'+
    '<div class="fb-picker-sub">'+sub+'</div>'+
    '<div class="fb-cands">'+cards+'</div>'+
    '<button class="fb-notsure" onclick="fbSubmit(null)">Not sure / no train visible</button>';
}
// Build the feedback payload. Shared by the button-tap capture (completed=false, no
// selection yet) and the final submission (completed=true). eventId ties them to one
// row so a later selection updates the row already written at button-tap. The shape
// lives in shared/predict.js so an observer-recorded row means the same thing as a
// public-app one, column for column.
function fbBuildPayload(hc, completed){
  // `source` distinguishes these rows from the observer's, which land in the same tab.
  return PREDICT.feedbackPayload(fbEvent, hc, completed, { source:'public' });
}
function fbPost(payload){
  if(!payload) return;
  fetch(CFG.feedbackUrl, { method:'POST', mode:'no-cors', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) }).catch(function(){});
}
function fbSubmit(hc){
  var e = fbEvent; if(!e) return;
  var payload = fbBuildPayload(hc, true);         // completed — updates the button-tap row by eventId
  var sel = hc ? e.snapshot[hc] : null;
  fbStopTimers();
  fbClosePicker();                                // roll the picker up
  var when = fmtShort(new Date(e.tsISO));
  // Optimistic confirmation — reveals as one blind as the picker collapses.
  fbRevealMsg('Thanks! Recorded the '+e.type+' at '+when+(sel?' ('+sel.route+').':'.'));
  fbEvent = null;
  fbPost(payload);
}
function fbCancel(){
  fbStopTimers();
  fbEvent = null; fbClosePicker();
}
// Blind-style reveal/collapse for BOTH the picker and the confirmation, so the whole
// flow is one smooth motion. (fb-shown, NOT fb-open — fb-open is the green "Barriers
// Opening Now" button class.)
function fbOpenPicker(){ var p=$('fbPicker'); p.classList.remove('hidden'); void p.offsetHeight; p.classList.add('fb-shown'); }
function fbClosePicker(){ var p=$('fbPicker'); p.classList.remove('fb-shown'); setTimeout(function(){ p.classList.add('hidden'); p.innerHTML=''; }, 400); }
function fbRevealMsg(txt){
  var m=$('fbMsg'); m.textContent=txt; m.classList.remove('hidden'); void m.offsetHeight; m.classList.add('fb-shown');
  clearTimeout(fbMsgTimer);
  fbMsgTimer = setTimeout(function(){ m.classList.remove('fb-shown'); setTimeout(function(){ m.classList.add('hidden'); }, 360); }, 6000);
}

function showModal(type) {
  var title = '', body = '';
  var appUrl = BASE_URL + crossingId + '/';
  var crossingShort = CFG.name.replace(' Level Crossing', '');
  var shareIcon = '<svg style="display:inline-block;vertical-align:middle;margin:0 3px" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#38BDF8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14v5a2 2 0 002 2h12a2 2 0 002-2v-5"/><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/></svg>';
  var dotsIcon = '<svg style="display:inline-block;vertical-align:middle;margin:0 3px" width="16" height="16" viewBox="0 0 24 24" fill="#38BDF8"><circle cx="12" cy="5" r="2.5"/><circle cx="12" cy="12" r="2.5"/><circle cx="12" cy="19" r="2.5"/></svg>';
  if (type === 'homescreen') {
    if (isIOS) {
      title = 'Add App to Home Screen \u2014 iPhone';
      body = '<ol><li>Make sure you are viewing this page in <strong>Safari</strong></li>';
      body += '<li>Tap the <strong>Share button</strong> ' + shareIcon + ' at the bottom</li>';
      body += '<li>Scroll down and tap <strong>"Add to Home Screen"</strong></li>';
      body += '<li>Name it <strong>"' + crossingShort + ' Crossing"</strong> or whatever you prefer</li>';
      body += '<li>Tap <strong>Add</strong></li></ol>';
      body += '<p>The app will appear on your home screen and open full-screen.</p>';
    } else if (isAndroid) {
      title = 'Add App to Home Screen \u2014 Android';
      body = '<ol><li>Open this page in <strong>Chrome</strong></li>';
      body += '<li>Tap the <strong>three-dot menu</strong> ' + dotsIcon + ' in the top right</li>';
      body += '<li>Tap <strong>"Add to Home screen"</strong> or <strong>"Install app"</strong></li>';
      body += '<li>Name it <strong>"' + crossingShort + ' Crossing"</strong></li>';
      body += '<li>Tap <strong>Add</strong></li></ol>';
    } else {
      title = 'Add App to Home Screen';
      body = '<p><strong>iPhone (Safari):</strong></p><ol><li>Tap the Share button ' + shareIcon + '</li><li>Tap "Add to Home Screen"</li><li>Tap Add</li></ol>';
      body += '<p><strong>Android (Chrome):</strong></p><ol><li>Tap the three-dot menu ' + dotsIcon + '</li><li>Tap "Add to Home screen"</li><li>Tap Add</li></ol>';
    }
  }
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = body;
  $('modalOverlay').classList.add('show');
}

function closeModal(e) {
  if (e && e.stopPropagation) e.stopPropagation();
  $('modalOverlay').classList.remove('show');
}

async function initCrossing(id) {
  crossingId = id;
  try {
    var configUrl = BASE_URL + 'shared/crossings.json';
    var resp = await fetch(configUrl);
    var allConfig = await resp.json();
    CFG = allConfig[id];
    if (!CFG) { $('statusMsg').textContent = 'Unknown crossing: ' + id; return; }
  } catch(e) {
    $('statusMsg').textContent = 'Failed to load config: ' + e.message;
    return;
  }

  $('crossingName').textContent = CFG.name;
  $('crossingRoad').textContent = CFG.road;
  document.title = CFG.name;

  var roadLabel = $('roadLabel');
  if (roadLabel) roadLabel.textContent = CFG.road.toUpperCase();

  setRefreshState('idle');
  fbFetchTriggers();   // static per deploy, and only the feedback picker reads it — fire
                       // and forget, never blocking the first render on it
  refreshData();
  setInterval(updateStatus, 1000);
  // 10s, not 30s. A berth strike can move a predicted close by over a minute (one measured
  // at −74s the instant the train struck its first chain berth), and the backend recomputes
  // within a tick of the strike — so the poll interval WAS the staleness. It got cheaper at
  // the same time: ?limit= dropped the response from ~18.4 KB to ~5 KB, so 10s costs about
  // 1.8 MB/h per open tab against 2.2 MB/h for the old 30s poll. Faster and cheaper.
  setInterval(refreshData, 10000);
}
