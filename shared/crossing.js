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
var downForMs = null;
var downForRange = null;
var lastError = '';
var trainHistory = [];
var crossingId = '';
var lastPassedTrain = null;
var closuresVisible = 3;

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
    var url = API_BASE + '/crossing/' + crossingId;
    var response = await fetch(url);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    var data = await response.json();
    vpsClosures = data.upcomingClosures || [];
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

function renderClosures() {
  var now = new Date();
  var relevant = [];
  for (var i = 0; i < closurePeriods.length; i++) {
    var p = closurePeriods[i];
    if (p.end.getTime() > now.getTime() - 60000) relevant.push(p);
  }
  if (!relevant.length) {
    $('closureList').innerHTML = '<div class="empty">No upcoming closures</div>';
    $('showMoreBtn').classList.add('hidden');
    return;
  }
  var showing = Math.min(closuresVisible, relevant.length);
  var html = '';
  for (var i = 0; i < showing; i++) {
    var p = relevant[i];
    var isCurrent = now >= p.start && now <= p.end;
    // Measure from the PREDICTED close, not the confirmed `start`. Everything the user
    // sees (header countdown, the time on this row, the Down For card) targets the
    // predicted close, and `start` sits earlier by the safety-net margin — measuring
    // from it would overstate the closure and disagree with the Down For card.
    // Formatted with fmtDuration so this pill and the "Down For" card round the same
    // way — they were showing "~5 min" and "~4m 50s" side by side for one closure.
    var duration = fmtDuration(p.end - (p.predictedStart || p.start)).replace('~', '');
    html += '<div class="closure-card' + (isCurrent ? ' closure-active' : '') + '">';
    html += '<div class="closure-hdr">';
    if (isCurrent) {
      html += '<span class="closure-time" style="color:#FCA5A5">NOW \u2014 ' + fmtShort(p.end) + '</span>';
      html += '<span class="closure-pill closure-pill-active">Closed ' + duration + ' \u00B7 opens in ' + fmtCountdown(p.end.getTime() - now.getTime()) + '</span>';
    } else {
      var w = p.window || { imminent: false, halfWidthSecs: 120 };
      // Show the PREDICTED close time/countdown (matches the header countdown);
      // isCurrent above still gates on the confirmed start.
      var pStart = p.predictedStart || p.start;
      var secsUntil = pStart.getTime() - now.getTime();
      if (w.imminent) {
        html += '<div class="closure-time-group"><span class="closure-time closure-imminent">Any moment now</span></div>';
        html += '<span class="closure-pill">Closed ' + duration + ' \u00B7 any moment now</span>';
      } else {
        var band = w.halfWidthSecs > 0
          ? '<span class="closure-uncertainty">\u00B1' + fmtUncertainty(w.halfWidthSecs) + '</span>'
          : '';
        html += '<div class="closure-time-group"><span class="closure-time">' + fmtShort(pStart) + '</span>' + band + '</div>';
        html += '<span class="closure-pill">Closed ' + duration + ' \u00B7 ' + fmtWhen(secsUntil, w.halfWidthSecs >= 60) + '</span>';
      }
    }
    html += '</div>';
    var hasUncertain = false;
    for (var j = 0; j < p.trains.length; j++) {
      if (p.trains[j].isUncertain) hasUncertain = true;
    }
    if (hasUncertain) {
      html += '<div style="font-size:9px;color:#F59E0B;margin-bottom:4px">\u26A0 Timing uncertain \u2014 train delayed with no estimate</div>';
    }
    for (var j = 0; j < p.trains.length; j++) {
      var t = p.trains[j];
      var dirColor = t.direction === 'east' ? '#38BDF8' : '#FB923C';
      var arrow = t.direction === 'east' ? '\u2192' : '\u2190';
      var statusHtml;
      if (t.isUncertain) {
        statusHtml = '<span class="train-status train-status-delayed">Delayed</span>';
      } else if (t.isDelayed && t.delayMins > 0) {
        statusHtml = '<span class="train-status train-status-delayed">+' + t.delayMins + 'm</span>';
      } else {
        statusHtml = '<span class="train-status train-status-ontime">On time</span>';
      }
      html += '<div class="closure-train">';
      html += '<span style="color:' + dirColor + ';font-weight:700;flex-shrink:0">' + arrow + '</span>';
      var typeLabel = '';
      if (t.trainType === 'freight') {
        // Confidence ladder: TD sighting today (live confirmation) beats recent
        // history; recent history beats schedule-only. A Q-flagged freight with
        // a low historical run rate is the typical false-positive culprit.
        if (t.tdSeen) {
          typeLabel = ' (freight \u2014 confirmed)';
        } else if (t.runsAsRequired && t.recentRunRate !== null && t.recentRunRate < 0.3) {
          typeLabel = ' (freight \u2014 usually doesn\u2019t run)';
        } else if (t.runsAsRequired) {
          typeLabel = ' (freight \u2014 may not run)';
        } else {
          typeLabel = ' (freight)';
        }
      }
      html += '<span class="closure-train-route">' + t.origin + ' \u2192 ' + t.destination + typeLabel + '</span>';
      html += '<span class="closure-train-time">' + fmtShort(t.bestTime) + '</span>';
      html += statusHtml;
      html += '</div>';
    }
    html += '</div>';
  }
  $('closureList').innerHTML = html;
  if (relevant.length > closuresVisible) {
    $('showMoreBtn').textContent = 'Show More';
    $('showMoreBtn').classList.remove('hidden');
    $('showMoreBtn').disabled = false;
    $('showMoreBtn').style.opacity = '';
    $('showMoreBtn').style.cursor = '';
  } else if (closuresVisible > 3 && closuresVisible >= relevant.length && relevant.length > 0) {
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
  renderClosures();
}

function updateStatus() {
  var now = new Date();
  var t = now.getTime();
  // THE prediction — the same call the observer app makes, so the two can never show a
  // different state for the same moment. Everything below this line is presentation.
  var pr = PREDICT.derive(closurePeriods, now);
  var status = pr.status, msg = 'No upcoming closures found';
  var currentClosure = pr.current, upcoming = pr.upcoming;
  nextCloseTime = pr.nextCloseTime; nextOpenTime = pr.nextOpenTime;
  downForMs = pr.downForMs; downForRange = pr.downForRange;
  if (currentClosure) {
    var openMs = currentClosure.end.getTime() - t;
    msg = 'Barriers likely DOWN. ' + (openMs <= 0 ? 'Reopens soon' : 'Reopens in ~' + fmtCountdown(openMs));
    $('statusTime').textContent = 'Opens ~' + fmtShort(currentClosure.end);
    $('statusTime').classList.remove('hidden');
    $('statusCard').classList.add('pulse');
  } else {
    $('statusCard').classList.remove('pulse');
    if (upcoming) {
      var ms = nextCloseTime.getTime() - t;
      if (status === 'CLOSING_SOON') { msg = ms <= 0 ? 'Closing soon' : 'Closing in ~' + fmtCountdown(ms); }
      else { msg = 'Next closure in ~' + fmtCountdown(ms); }
    } else { msg = 'No more closures expected today'; }
    $('statusTime').classList.add('hidden');
  }
  var c = getColors(status);
  var card = $('statusCard');
  card.style.background = c.bg; card.style.color = c.text; card.style.boxShadow = c.glow;
  $('statusTitle').textContent = status === 'CLOSED' ? 'BARRIERS DOWN' : status === 'CLOSING_SOON' ? 'CLOSING SOON' : 'CROSSING CLEAR';
  $('statusMsg').textContent = msg;
  var arm = $('barrierArm'), bar = $('armBar'), la = $('lightA'), lb = $('lightB');
  var stripes = document.querySelectorAll('.stripe');
  if (status === 'CLOSED') {
    arm.style.transform = 'rotate(0deg)'; bar.setAttribute('fill', '#DC2626');
    stripes.forEach(function(s) { s.setAttribute('fill', '#FFF'); });
    la.setAttribute('opacity', '1'); la.className = 'blink-a';
    lb.setAttribute('opacity', '1'); lb.className = 'blink-b';
  } else if (status === 'CLOSING_SOON') {
    arm.style.transform = 'rotate(-30deg)'; bar.setAttribute('fill', '#F59E0B');
    stripes.forEach(function(s) { s.setAttribute('fill', '#000'); });
    la.setAttribute('opacity', '0'); la.className = ''; lb.setAttribute('opacity', '0'); lb.className = '';
  } else {
    arm.style.transform = 'rotate(-80deg)'; bar.setAttribute('fill', '#16A34A');
    stripes.forEach(function(s) { s.setAttribute('fill', '#15803d'); });
    la.setAttribute('opacity', '0'); la.className = ''; lb.setAttribute('opacity', '0'); lb.className = '';
  }
  if (nextCloseTime) { $('nextCloseCountdown').textContent = fmtSoon(nextCloseTime.getTime() - t); $('nextCloseCountdown').style.color = '#F59E0B'; $('nextCloseTime').textContent = fmtShort(nextCloseTime); }
  else { $('nextCloseCountdown').textContent = '--'; $('nextCloseCountdown').style.color = '#475569'; $('nextCloseTime').textContent = ''; }
  if (nextOpenTime) { $('nextOpenCountdown').textContent = fmtSoon(nextOpenTime.getTime() - t); $('nextOpenCountdown').style.color = '#16A34A'; $('nextOpenTime').textContent = fmtShort(nextOpenTime); }
  else { $('nextOpenCountdown').textContent = '--'; $('nextOpenCountdown').style.color = '#475569'; $('nextOpenTime').textContent = ''; }
  if (downForMs !== null && downForMs > 0) { $('closureLength').textContent = fmtDownFor(downForMs); $('closureLength').style.color = '#94A3B8'; $('closureLengthSub').textContent = downForRange; }
  else { $('closureLength').textContent = '--'; $('closureLength').style.color = '#475569'; $('closureLengthSub').textContent = ''; }
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
// Seconds to the crossing for ranking: the live figure, so a stopper dwelling at
// Southwick doesn't outrank a fast that will actually get here first. Falls back to the
// static berth median for anything eta() can't place.
function fbRank(t){
  var e = PREDICT.eta(t);
  return (e && e.secs != null) ? e.secs : (t.prox ? t.prox.rank : 100000);
}
// Pick the app's best-guess train: opening → the just-passed train; else the
// nearest approaching one.
function fbSuggest(type, enriched){
  if(type==='opening'){
    var passed = enriched.filter(function(t){ return t.prox && t.prox.stage==='passed'; });
    if(passed.length){ passed.sort(function(a,b){ return a.ageSecs-b.ageSecs; }); return passed[0]; }
  }
  var appr = enriched.filter(function(t){ return t.prox && t.prox.stage==='approach'; });
  appr.sort(function(a,b){ return fbRank(a)-fbRank(b); });
  return appr[0] || null;
}
function fbSortKey(type, t){
  if(!t.prox) return 100000 + (t.ageSecs||0);                          // off-chain: last
  if(t.prox.stage==='passed') return (type==='opening') ? (t.ageSecs||0) : 90000+(t.ageSecs||0);
  return fbRank(t);                                                    // approaching: by eta
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
  refreshData();
  setInterval(updateStatus, 1000);
  setInterval(refreshData, 30000);
}
