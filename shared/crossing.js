var API_BASE = 'https://api.railcrossing.uk';
var BASE_URL = 'https://railcrossing.uk/';

var CFG = null;
var trains = [];
var closurePeriods = [];
var vpsClosures = []; // raw backend-computed closures from the last fetch (authoritative timing)
var nextCloseTime = null;
var nextOpenTime = null;
var lastError = '';
var trainHistory = [];
var crossingId = '';
var lastPassedTrain = null;
var closuresVisible = 3;

var isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
var isAndroid = /Android/.test(navigator.userAgent);
var lastRefreshTs = null;

function $(id) { return document.getElementById(id); }
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
// A countdown that has reached/passed zero but whose state hasn't advanced yet
// (waiting on the berth strike, or a train running later than its live estimate)
// reads "Soon" rather than "0s" / "NOW" or a negative value.
function fmtSoon(ms) { return ms <= 0 ? 'Soon' : fmtCountdown(ms); }
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

// Convert the VPS /crossing/<id> JSON into the train-array shape the rest of the app expects.
// Pulls trains from upcomingClosures (backend already deduped + sorted).
function parseVpsResponse(data) {
  var results = [];
  var seen = {};
  var closures = data.upcomingClosures || [];
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

// Build display periods straight from the backend's pre-computed closures.
// The backend owns the authoritative timing — crucially the TD clear-step-anchored
// OPEN (period end) and the "hold the closure open until the train has physically
// cleared" behaviour — neither of which the client can reproduce (it has no berth-
// step feed, only each train's bestTime). So we render the backend's periods
// verbatim (start/end parsed to Dates) and only attach the client-side confidence
// window for display. buildClosuresFromVps([]) safely returns [] when the backend
// sent no pre-computed closures.
function buildClosuresFromVps(closures) {
  var periods = [];
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
    var p = { start: new Date(c.start), predictedStart: new Date(c.predictedStart || c.start), end: new Date(c.end), trains: mapped };
    p.window = getWindowTier(p);
    periods.push(p);
  }
  return periods;
}

function getWindowTier(closure) {
  var cfg = CFG || {};
  var cw = cfg.confidenceWindows || {};
  var now = new Date();
  var secsToStart = (closure.start.getTime() - now.getTime()) / 1000;

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
      $('dataMode').textContent = 'LIVE';
      $('dataMode').style.color = '#22D3EE';
    } else {
      trains = [];
      if (lastError) {
        $('dataMode').textContent = 'ERROR';
        $('dataMode').style.color = '#FCA5A5';
        $('errorBox').textContent = 'Error: ' + lastError;
        $('errorBox').classList.remove('hidden');
      } else {
        $('dataMode').textContent = 'OFFLINE';
        $('dataMode').style.color = '#FCA5A5';
      }
    }
    // Render the backend's pre-computed closures — they carry the authoritative,
    // TD clear-step-anchored OPEN time (and hold-until-cleared). buildClosuresFromVps
    // safely returns [] when the backend sent none.
    closurePeriods = buildClosuresFromVps(vpsClosures);
    $('lastRefreshTime').textContent = fmtShort(new Date());
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
    var duration = Math.round((p.end - p.start) / 60000);
    html += '<div class="closure-card' + (isCurrent ? ' closure-active' : '') + '">';
    html += '<div class="closure-hdr">';
    if (isCurrent) {
      html += '<span class="closure-time" style="color:#FCA5A5">NOW \u2014 ' + fmtShort(p.end) + '</span>';
      html += '<span class="closure-pill closure-pill-active">~' + duration + ' min \u00B7 opens ' + fmtCountdown(p.end.getTime() - now.getTime()) + '</span>';
    } else {
      var w = p.window || { imminent: false, halfWidthSecs: 120 };
      // Show the PREDICTED close time/countdown (matches the header countdown);
      // isCurrent above still gates on the confirmed start.
      var pStart = p.predictedStart || p.start;
      var secsUntil = pStart.getTime() - now.getTime();
      if (w.imminent) {
        html += '<div class="closure-time-group"><span class="closure-time closure-imminent">Any moment now</span></div>';
        html += '<span class="closure-pill">~' + duration + ' min</span>';
      } else {
        html += '<div class="closure-time-group"><span class="closure-time">' + fmtShort(pStart) + '</span><span class="closure-uncertainty">\u00B1' + fmtUncertainty(w.halfWidthSecs) + '</span></div>';
        var countdownStr = w.halfWidthSecs >= 60 ? fmtCountdownRough(secsUntil) : fmtSoon(secsUntil);
        html += '<span class="closure-pill">~' + duration + ' min \u00B7 in ' + countdownStr + '</span>';
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
  var status = 'OPEN', msg = 'No upcoming closures found';
  nextCloseTime = null; nextOpenTime = null;
  var currentClosure = null, upcoming = null;
  var t = now.getTime();
  for (var i = 0; i < closurePeriods.length; i++) {
    var p = closurePeriods[i];
    // Find BOTH the current closure and the next upcoming one (don't stop at the
    // current) — so while CLOSED we can still show the countdown to the next close.
    if (!currentClosure && t >= p.start.getTime() && t <= p.end.getTime()) { currentClosure = p; }
    else if (!upcoming && p.start.getTime() > t) { upcoming = p; }
  }
  if (currentClosure) {
    status = 'CLOSED';
    nextOpenTime = currentClosure.end;
    // Even while down, surface the countdown to the NEXT closure if another is coming
    // (back-to-back closures are a useful heads-up). Targets the predicted close.
    if (upcoming) nextCloseTime = upcoming.predictedStart || upcoming.start;
    var openMs = currentClosure.end.getTime() - t;
    msg = 'Barriers likely DOWN. ' + (openMs <= 0 ? 'Reopens soon' : 'Reopens in ~' + fmtCountdown(openMs));
    $('statusTime').textContent = 'Opens ~' + fmtShort(currentClosure.end);
    $('statusTime').classList.remove('hidden');
    $('statusCard').classList.add('pulse');
  } else {
    $('statusCard').classList.remove('pulse');
    if (upcoming) {
      // Close countdown / closing-soon target the PREDICTED close (barrier-down);
      // the CLOSED state itself gates on the confirmed start (the loop above).
      var closeTarget = upcoming.predictedStart || upcoming.start;
      var ms = closeTarget.getTime() - t;
      nextCloseTime = closeTarget; nextOpenTime = upcoming.end;
      // CLOSING_SOON fires 90 s before the predicted closure (barrier-down) time.
      if (ms <= 90000) { status = 'CLOSING_SOON'; msg = ms <= 0 ? 'Closing soon' : 'Closing in ~' + fmtCountdown(ms); }
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
var FB_CHAIN = {
  east: [
    { b:'0016', gap:132, ttc:671 }, { b:'0014', gap:74, ttc:537 }, { b:'0012', gap:37, ttc:462 },
    { b:'0010', gap:143, ttc:422 }, { b:'0008', gap:75, ttc:278 },
    { b:'0006', gap:142, role:'approach', ttc:206 }, { b:'0004', gap:79, role:'protecting', ttc:64 },
    { x:true }, { b:'0002', gap:115, role:'clear' }, { b:'T686', gap:53 }, { b:'T684' }
  ],
  west: [
    { b:'T682', gap:90 }, { b:'T677', gap:126, ttc:336 }, { b:'0001', gap:45, ttc:201 },
    { b:'0003', gap:36, role:'approach', ttc:152 }, { b:'0005', gap:115, role:'protecting', ttc:115 },
    { x:true }, { b:'0007', gap:43, role:'clear' }, { b:'0009', gap:70 }, { b:'0011', gap:140 },
    { b:'0013', gap:144 }, { b:'0015', gap:84 }, { b:'0017' }
  ]
};
var FB_IN = {};
Object.keys(FB_CHAIN).forEach(function(d){
  var idx = {}, xi = -1;
  FB_CHAIN[d].forEach(function(n,i){ if(n.x) xi = i; else idx[n.b] = i; });
  FB_IN[d] = { idx:idx, xi:xi };
});
function fbTrainKind(hc){ if(!hc) return 'passenger'; var c=hc.charAt(0); if(c==='6'||c==='7') return 'freight'; if(c==='5') return 'ecs'; if(c==='3') return 'test'; return 'passenger'; }
function fbArrow(d){ return d==='east'?'▶':d==='west'?'◀':'·'; }
function fbMins(s){ return '~'+Math.max(1, Math.round(s/60))+' min'; }
function fbEtaToXing(d,i){ var c=FB_IN[d]; if(i<0||i>=c.xi) return 0; var s=0; for(var j=i;j<c.xi;j++){ s+=(FB_CHAIN[d][j].gap||60); } return s; }
function fbEsc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
// Layman position for a berth+direction. null → off the Portslade chain.
function fbProximity(berth, direction){
  var c = FB_IN[direction]; if(!c) return null;
  var i = c.idx[berth]; if(i===undefined) return null;
  if(i > c.xi) return { stage:'passed', label:'Just passed the crossing', etaSecs:null, rank:9999 };
  var node = FB_CHAIN[direction][i];
  var eta = (node.ttc != null) ? node.ttc : fbEtaToXing(direction,i);
  var label = eta<=75 ? 'About to pass the crossing' : 'Approaching ('+fbMins(eta)+')';
  return { stage:'approach', label:label, etaSecs:eta, rank:eta };
}
// Scheduled + live Portslade time for a headcode, joined from the closure trains.
function fbTimes(hc){
  var pool = trainHistory.length ? trainHistory : trains;
  for(var i=0;i<pool.length;i++){ if(pool[i].headcode===hc) return { sched: pool[i].scheduledTime||null, live: pool[i].bestTime||null }; }
  return { sched:null, live:null };
}
function fbEnrich(lt){
  var tm = fbTimes(lt.headcode);
  var prox = fbProximity(lt.berth, lt.direction);
  // Recent berth-strike history for this train (server-provided; each { berth, ts }).
  // Captured as-of the event snapshot for calibration; empty until the backend ships it.
  var strikes = (lt.history || []).map(function(h){ return { berth:h.berth||h.to||'', ts:h.ts||'', event:h.event||'' }; });
  return {
    headcode: lt.headcode, direction: lt.direction||'',
    route: (lt.origin||'?')+' → '+(lt.destination||'?'),
    type: fbTrainKind(lt.headcode), berth: lt.berth||'', ageSecs: lt.ageSecs||0,
    prox: prox, posLabel: prox?prox.label:'Elsewhere in the area',
    // Four Portslade times from the live feed (backend-provided; HH:MM): scheduled &
    // live (estimated) arrival & departure. Blank until the backend ships them — the
    // single closure-join time (schedStr/liveStr) is a display fallback.
    schedArr: lt.schedArr||'', schedDep: lt.schedDep||'', liveArr: lt.liveArr||'', liveDep: lt.liveDep||'',
    schedStr: tm.sched?fmtShort(tm.sched):'', liveStr: tm.live?fmtShort(tm.live):'',
    strikes: strikes
  };
}
function fetchLive(){
  return fetch(API_BASE+'/crossing/'+crossingId+'/live')
    .then(function(r){ return r.ok ? r.json() : { trains:[] }; })
    .then(function(d){ return d.trains || []; })
    .catch(function(){ return []; });
}
// Pick the app's best-guess train: opening → the just-passed train; else the
// nearest approaching one.
function fbSuggest(type, enriched){
  if(type==='opening'){
    var passed = enriched.filter(function(t){ return t.prox && t.prox.stage==='passed'; });
    if(passed.length){ passed.sort(function(a,b){ return a.ageSecs-b.ageSecs; }); return passed[0]; }
  }
  var appr = enriched.filter(function(t){ return t.prox && t.prox.stage==='approach'; });
  appr.sort(function(a,b){ return a.prox.rank-b.prox.rank; });
  return appr[0] || null;
}
function fbSortKey(type, t){
  if(!t.prox) return 100000 + (t.ageSecs||0);                          // off-chain: last
  if(t.prox.stage==='passed') return (type==='opening') ? (t.ageSecs||0) : 90000+(t.ageSecs||0);
  return t.prox.rank;                                                  // approaching: by eta
}

var fbEvent = null;      // frozen event snapshot { type, tsISO, predictedState, snapshot, order, guess }
var fbLivePos = {};      // headcode -> latest { posLabel } for live display only
var fbPollTimer = null;

function openFeedbackPicker(type){
  fetchLive().then(function(live){
    var enriched = live.map(fbEnrich);
    var order = enriched.slice().sort(function(a,b){ return fbSortKey(type,a)-fbSortKey(type,b); }).map(function(t){ return t.headcode; });
    var guess = fbSuggest(type, enriched);
    if(guess){ order = order.filter(function(h){ return h!==guess.headcode; }); order.unshift(guess.headcode); }
    var snap = {}; enriched.forEach(function(t){ snap[t.headcode] = t; });
    fbEvent = { type:type, tsISO:new Date().toISOString(), predictedState:$('statusTitle').textContent, snapshot:snap, order:order, guess:guess };
    fbLivePos = {}; enriched.forEach(function(t){ fbLivePos[t.headcode] = { posLabel:t.posLabel }; });
    var m = $('fbMsg'); m.classList.remove('fb-msg-show'); m.classList.add('hidden');
    renderFbPicker();
    fbOpenPicker();
    if(fbPollTimer) clearInterval(fbPollTimer);
    fbPollTimer = setInterval(fbPollLive, 2500);
  });
}
function fbPollLive(){
  if(!fbEvent){ if(fbPollTimer){ clearInterval(fbPollTimer); fbPollTimer=null; } return; }
  fetchLive().then(function(live){
    live.forEach(function(lt){ var p=fbProximity(lt.berth, lt.direction); fbLivePos[lt.headcode] = { posLabel: p?p.label:'Elsewhere in the area' }; });
    renderFbPicker();
  });
}
function fbMinOf(hhmm){ var m=/^(\d{1,2}):(\d{2})/.exec(hhmm||''); return m ? (parseInt(m[1],10)*60 + parseInt(m[2],10)) : null; }
// Direction-appropriate time for the card's right column: westbound departure,
// eastbound arrival, with a lateness tag vs schedule. Returns { time, tag, cls }.
function fbTimeParts(t){
  var isWest = t.direction==='west';
  var live = isWest ? t.liveDep : t.liveArr;
  var sched = isWest ? t.schedDep : t.schedArr;
  var time = live || sched || t.liveStr || t.schedStr || '';
  if(!time) return { time:'', tag:'', cls:'' };
  var lm = fbMinOf(live), sm = fbMinOf(sched);
  if(lm!=null && sm!=null){
    var d = lm - sm;
    if(d===0) return { time:time, tag:'on time', cls:'fb-on' };
    return { time:time, tag:Math.abs(d)+'m '+(d>0?'late':'early'), cls:'fb-late' };
  }
  return { time:time, tag:'', cls:'' };
}
function fbCardHtml(hc, isGuess){
  var t = fbEvent.snapshot[hc]; if(!t) return '';
  var pos = (fbLivePos[hc] && fbLivePos[hc].posLabel) || t.posLabel;
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
    '<div class="fb-cand-pos">'+fbEsc(pos)+'</div>'+
    '</button>';
}
function renderFbPicker(){
  if(!fbEvent) return;
  var verb = fbEvent.type==='closing' ? 'closing' : 'opening';
  var order = fbEvent.order.slice(0, 3);
  var cards = order.map(function(hc){ return fbCardHtml(hc, fbEvent.guess && hc===fbEvent.guess.headcode); }).join('');
  if(!cards) cards = '<div class="fb-none">No trains detected nearby right now — tap below to just log the time.</div>';
  $('fbPicker').innerHTML =
    '<div class="fb-picker-hdr">Which train is '+verb+' the barrier?</div>'+
    '<div class="fb-picker-sub">Tap the train you can see — it helps us learn the exact timings.</div>'+
    '<div class="fb-cands">'+cards+'</div>'+
    '<button class="fb-notsure" onclick="fbSubmit(null)">Not sure / no train visible</button>';
}
function fbSubmit(hc){
  var e = fbEvent; if(!e) return;
  var sel = hc ? e.snapshot[hc] : null;
  var g = e.guess;
  var payload = {
    crossing: crossingId, crossingName: CFG.name,
    eventTimestamp: e.tsISO, event: e.type, predictedState: e.predictedState,
    ourGuessHeadcode: g?g.headcode:'', ourGuessRoute: g?g.route:'', ourGuessDirection: g?g.direction:'',
    ourGuessType: g?g.type:'',
    ourGuessSchedArr: g?g.schedArr:'', ourGuessSchedDep: g?g.schedDep:'', ourGuessLiveArr: g?g.liveArr:'', ourGuessLiveDep: g?g.liveDep:'',
    ourGuessPosition: g?g.posLabel:'', ourGuessBerth: g?g.berth:'',
    ourGuessBerthHistory: g?JSON.stringify(g.strikes||[]):'',
    submittedAt: new Date().toISOString(),
    selectedHeadcode: sel?sel.headcode:'', selectedRoute: sel?sel.route:'', selectedDirection: sel?sel.direction:'',
    selectedType: sel?sel.type:'',
    selectedSchedArr: sel?sel.schedArr:'', selectedSchedDep: sel?sel.schedDep:'', selectedLiveArr: sel?sel.liveArr:'', selectedLiveDep: sel?sel.liveDep:'',
    selectedPosition: sel?sel.posLabel:'', selectedBerth: sel?sel.berth:'',
    selectedBerthHistory: sel?JSON.stringify(sel.strikes||[]):'',
    wasOurGuess: !!(sel && g && sel.headcode===g.headcode), notSure: !hc
  };
  if(fbPollTimer){ clearInterval(fbPollTimer); fbPollTimer = null; }
  fbClosePicker();
  var when = fmtShort(new Date(e.tsISO));
  fbShowMsg('Sending…');
  fetch(CFG.feedbackUrl, { method:'POST', mode:'no-cors', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) })
    .then(function(){ $('fbMsg').textContent = 'Thanks! Recorded the '+e.type+' at '+when+(sel?' ('+sel.route+').':'.'); fbAutoHideMsg(); fbEvent=null; })
    .catch(function(){ $('fbMsg').textContent = 'Thanks! Noted (offline).'; fbAutoHideMsg(); fbEvent=null; });
}
function fbCancel(){
  if(fbPollTimer){ clearInterval(fbPollTimer); fbPollTimer = null; }
  fbEvent = null; fbClosePicker();
}
// Blind-style reveal/collapse + fading confirmation, so the whole flow is smooth.
function fbOpenPicker(){ var p=$('fbPicker'); p.classList.remove('hidden'); void p.offsetHeight; p.classList.add('fb-open'); }
function fbClosePicker(){ var p=$('fbPicker'); p.classList.remove('fb-open'); setTimeout(function(){ p.classList.add('hidden'); p.innerHTML=''; }, 380); }
function fbShowMsg(txt){ var m=$('fbMsg'); m.textContent=txt; m.classList.remove('hidden'); void m.offsetHeight; m.classList.add('fb-msg-show'); }
function fbAutoHideMsg(){ setTimeout(function(){ var m=$('fbMsg'); m.classList.remove('fb-msg-show'); setTimeout(function(){ m.classList.add('hidden'); }, 320); }, 6000); }

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
