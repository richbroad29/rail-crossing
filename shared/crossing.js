var API_BASE = 'https://rail-crossing-api.richardbroad29.workers.dev';
var BASE_URL = 'https://richbroad29.github.io/rail-crossing/';

var CFG = null;
var trains = [];
var closurePeriods = [];
var nextCloseTime = null;
var nextOpenTime = null;
var apiMode = 'loading';
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
function getOpenAfter(direction) {
  if (CFG.openAfter && typeof CFG.openAfter === 'object') return CFG.openAfter[direction] || 0.75;
  return CFG.openAfter || 0.75;
}

function parseTimeStr(timeStr) {
  if (!timeStr || timeStr.indexOf(':') < 0) return null;
  var now = new Date();
  var parts = timeStr.split(':');
  var h = parseInt(parts[0]), m = parseInt(parts[1]);
  var d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
  if (d.getTime() < now.getTime() - 6 * 3600000) d.setDate(d.getDate() + 1);
  return d;
}

function getVal(str, tag) {
  var i = str.indexOf(':' + tag + '>');
  if (i < 0) i = str.indexOf('<' + tag + '>');
  if (i < 0) return null;
  var start = i + tag.length + 2;
  var end = str.indexOf('<', start);
  if (end < 0) return null;
  return str.substring(start, end);
}

function isEastOrigin(str) {
  if (!str) return false;
  var lower = str.toLowerCase();
  return lower.indexOf('brighton') >= 0 || lower.indexOf('hove') >= 0 ||
    lower.indexOf('london') >= 0 || lower.indexOf('gatwick') >= 0 ||
    lower.indexOf('croydon') >= 0 || lower.indexOf('haywards') >= 0;
}

// Parse combined GetArrDepBoardWithDetails XML response
// Filters out bus services using serviceType tag
function parseTrains(xml) {
  var results = [];
  var parts = xml.split('service>');
  for (var i = 0; i < parts.length; i++) {
    var sv = parts[i];
    if (sv.indexOf(':sta>') < 0 && sv.indexOf(':std>') < 0 &&
        sv.indexOf('<sta>') < 0 && sv.indexOf('<std>') < 0) continue;
    if (sv.toLowerCase().indexOf('iscancelled>true') >= 0) continue;
    // Skip bus services
    if (sv.indexOf('serviceType>bus') >= 0) continue;

    var sta = getVal(sv, 'sta');
    var eta = getVal(sv, 'eta');
    var std = getVal(sv, 'std');
    var etd = getVal(sv, 'etd');

    // Parse origin/destination
    var origBlock = sv.indexOf(':origin>');
    if (origBlock < 0) origBlock = sv.indexOf('<origin>');
    var destBlock = sv.indexOf(':destination>');
    if (destBlock < 0) destBlock = sv.indexOf('<destination>');
    var origin = '?', dest = '?';
    if (origBlock >= 0) { origin = getVal(sv.substring(origBlock, origBlock + 200), 'locationName') || '?'; }
    if (destBlock >= 0) { dest = getVal(sv.substring(destBlock, destBlock + 200), 'locationName') || '?'; }

    var operMatch = sv.indexOf(':operator>');
    if (operMatch < 0) operMatch = sv.indexOf('<operator>');
    var operator = '?';
    if (operMatch >= 0) { operator = getVal(sv.substring(Math.max(0, operMatch - 5), operMatch + 100), 'operator') || '?'; }

    // Direction: if origin is an east station (Brighton, London etc), train is heading west
    var direction = isEastOrigin(origin) ? 'west' : 'east';

    // Pick reference time based on direction and crossing geometry:
    // Eastbound trains approach from west, cross THEN arrive at platform → use arrival time
    // Westbound trains depart platform, THEN cross heading west → use departure time
    var sch, et;
    if (direction === 'east') {
      sch = sta || std;
      et = eta || etd;
    } else {
      sch = std || sta;
      et = etd || eta;
    }

    var bt = sch;
    var isUncertain = false;
    if (et && et !== 'On time' && et !== 'Delayed' && et.indexOf(':') >= 0) {
      bt = et;
    } else if (et === 'Delayed') {
      isUncertain = true;
    }
    var bestTime = parseTimeStr(bt);
    if (!bestTime) continue;

    var delayMins = 0;
    if (et && et.indexOf(':') >= 0 && sch) {
      var e2 = parseTimeStr(et), s2 = parseTimeStr(sch);
      if (e2 && s2) delayMins = Math.round((e2 - s2) / 60000);
    }

    results.push({
      origin: origin, destination: dest, scheduledTime: parseTimeStr(sch),
      bestTime: bestTime, isRealtime: !!(et && et !== 'On time' && et.indexOf(':') >= 0), isDelayed: delayMins > 0,
      isUncertain: isUncertain,
      delayMins: delayMins, etaText: et || 'On time', direction: direction,
      operator: operator, dedupKey: (sch || '') + (dest || '')
    });
  }

  results.sort(function(a, b) { return a.bestTime - b.bestTime; });
  return results;
}

// Legacy parser for old arr/dep endpoints (used by fallback)
function parseXmlLegacy(xml, type) {
  var results = [];
  var parts = xml.split('service>');
  for (var i = 0; i < parts.length; i++) {
    var sv = parts[i];
    if (sv.indexOf(':sta>') < 0 && sv.indexOf(':std>') < 0) continue;
    if (sv.toLowerCase().indexOf('iscancelled>true') >= 0) continue;
    var sta = getVal(sv, 'sta');
    var eta = getVal(sv, 'eta');
    var std = getVal(sv, 'std');
    var etd = getVal(sv, 'etd');
    var sch = sta || std;
    var et = eta || etd;
    var bt = sch;
    var isUncertain = false;
    if (et && et !== 'On time' && et !== 'Delayed' && et.indexOf(':') >= 0) {
      bt = et;
    } else if (et === 'Delayed') {
      isUncertain = true;
    }
    var bestTime = parseTimeStr(bt);
    if (!bestTime) continue;
    var origBlock = sv.indexOf(':origin>');
    var destBlock = sv.indexOf(':destination>');
    var origin = '?', dest = '?';
    if (origBlock >= 0) { origin = getVal(sv.substring(origBlock, origBlock + 200), 'locationName') || '?'; }
    if (destBlock >= 0) { dest = getVal(sv.substring(destBlock, destBlock + 200), 'locationName') || '?'; }
    var operMatch = sv.indexOf(':operator>');
    var operator = '?';
    if (operMatch >= 0) { operator = getVal(sv.substring(Math.max(0, operMatch - 5), operMatch + 100), 'operator') || '?'; }
    var direction = 'east';
    if (type === 'arr') { if (isEastOrigin(origin)) direction = 'west'; }
    else { if (isEastOrigin(dest)) direction = 'east'; else direction = 'west'; }
    var delayMins = 0;
    if (et && et.indexOf(':') >= 0 && sch) {
      var e2 = parseTimeStr(et), s2 = parseTimeStr(sch);
      if (e2 && s2) delayMins = Math.round((e2 - s2) / 60000);
    }
    results.push({
      origin:origin, destination:dest, scheduledTime:parseTimeStr(sch),
      bestTime:bestTime, isRealtime:true, isDelayed:delayMins>0,
      isUncertain:isUncertain,
      delayMins:delayMins, etaText:et||'On time', direction:direction,
      operator:operator, dedupKey:(sch||'')+(dest||'')
    });
  }
  return results;
}

function deduplicateTrains(trainList) {
  var sorted = trainList.slice().sort(function(a,b) { return a.bestTime - b.bestTime; });
  var results = [];
  for (var i = 0; i < sorted.length; i++) {
    var t = sorted[i];
    var isDupe = false;
    for (var j = 0; j < results.length; j++) {
      var r = results[j];
      if (r.destination === t.destination && Math.abs(r.bestTime.getTime() - t.bestTime.getTime()) <= 120000) {
        isDupe = true;
        break;
      }
    }
    if (!isDupe) results.push(t);
  }
  results.sort(function(a,b) { return a.bestTime - b.bestTime; });
  return results;
}

async function fetchNationalRail() {
  lastError = '';
  try {
    // Primary: single combined call (requires updated worker)
    var url = API_BASE + '/?station=' + CFG.station;
    var response = await fetch(url);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    var xml = await response.text();
    var svcs = parseTrains(xml);
    if (svcs.length > 0) return svcs;
    // If parseTrains found nothing, the response might be from old worker — fall through
  } catch(e) {
    console.warn('NR API (combined) error:', e);
    lastError = e.message;
  }

  // Fallback: legacy dual-call for old worker that doesn't support combined endpoint
  console.log('Falling back to legacy arr/dep calls');
  var results = [];
  var types = ['arr', 'dep'];
  for (var i = 0; i < 2; i++) {
    var type = types[i];
    try {
      var url2 = API_BASE + '/?station=' + CFG.station + '&type=' + type;
      var response2 = await fetch(url2);
      if (!response2.ok) throw new Error('HTTP ' + response2.status);
      var xml2 = await response2.text();
      var svcs2 = parseXmlLegacy(xml2, type);
      for (var j = 0; j < svcs2.length; j++) results.push(svcs2[j]);
    } catch(e) { console.warn('NR API (' + type + ') error:', e); lastError = e.message; }
  }
  if (!results.length && !lastError) lastError = 'No train data returned';
  return deduplicateTrains(results);
}

function computeClosures(trainList) {
  if (!trainList.length) return [];
  var sorted = trainList.slice().sort(function(a,b) { return a.bestTime - b.bestTime; });
  var periods = [], cs = null, ce = null, ct = [];
  for (var i = 0; i < sorted.length; i++) {
    var t = sorted[i];
    var cb = getCloseBefore(t.direction);
    var oa = getOpenAfter(t.direction);
    var cl = new Date(t.bestTime.getTime() - cb * 60000);
    var op = new Date(t.bestTime.getTime() + oa * 60000);
    if (cs === null) { cs = cl; ce = op; ct = [t]; }
    else if (cl.getTime() - ce.getTime() <= CFG.consecutiveWindow * 60000) {
      ce = new Date(Math.max(ce.getTime(), op.getTime()));
      ct.push(t);
    }
    else { var pb = {start:cs, end:ce, trains:ct}; pb.window = getWindowTier(pb); periods.push(pb); cs = cl; ce = op; ct = [t]; }
  }
  if (cs) { var pf = {start:cs, end:ce, trains:ct}; pf.window = getWindowTier(pf); periods.push(pf); }
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

  var hasLdb = closure.trains.some(function(t) { return !t.source || t.source === 'ldb'; });
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
      apiMode = 'live';
      lastRefreshTs = new Date();
      $('dataMode').textContent = 'LIVE';
      $('dataMode').style.color = '#22D3EE';
    } else {
      trains = [];
      if (lastError) {
        apiMode = 'error';
        $('dataMode').textContent = 'ERROR';
        $('dataMode').style.color = '#FCA5A5';
        $('errorBox').textContent = 'Error: ' + lastError;
        $('errorBox').classList.remove('hidden');
      } else {
        apiMode = 'offline';
        $('dataMode').textContent = 'OFFLINE';
        $('dataMode').style.color = '#FCA5A5';
      }
    }
    closurePeriods = computeClosures(trains);
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
      var secsUntil = p.start.getTime() - now.getTime();
      if (w.imminent) {
        html += '<div class="closure-time-group"><span class="closure-time closure-imminent">Any moment now</span></div>';
        html += '<span class="closure-pill">~' + duration + ' min</span>';
      } else {
        html += '<div class="closure-time-group"><span class="closure-time">' + fmtShort(p.start) + '</span><span class="closure-uncertainty">\u00B1' + fmtUncertainty(w.halfWidthSecs) + '</span></div>';
        var countdownStr = w.halfWidthSecs >= 60 ? fmtCountdownRough(secsUntil) : fmtCountdown(secsUntil);
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
      html += '<span class="closure-train-route">' + t.origin + ' \u2192 ' + t.destination + '</span>';
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
    if (t >= p.start.getTime() && t <= p.end.getTime()) { currentClosure = p; break; }
    if (p.start.getTime() > t && !upcoming) { upcoming = p; }
  }
  if (currentClosure) {
    status = 'CLOSED';
    nextOpenTime = currentClosure.end;
    msg = 'Barriers likely DOWN. Reopens in ~' + fmtCountdown(currentClosure.end.getTime() - t);
    $('statusTime').textContent = 'Opens ~' + fmtShort(currentClosure.end);
    $('statusTime').classList.remove('hidden');
    $('statusCard').classList.add('pulse');
  } else {
    $('statusCard').classList.remove('pulse');
    if (upcoming) {
      var ms = upcoming.start.getTime() - t;
      nextCloseTime = upcoming.start; nextOpenTime = upcoming.end;
      if (ms <= 180000) { status = 'CLOSING_SOON'; msg = 'Closing in ~' + fmtCountdown(ms); }
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
  if (nextCloseTime) { $('nextCloseCountdown').textContent = fmtCountdown(Math.max(0, nextCloseTime.getTime() - t)); $('nextCloseCountdown').style.color = '#F59E0B'; $('nextCloseTime').textContent = fmtShort(nextCloseTime); }
  else { $('nextCloseCountdown').textContent = '--'; $('nextCloseCountdown').style.color = '#475569'; $('nextCloseTime').textContent = ''; }
  if (nextOpenTime) { $('nextOpenCountdown').textContent = fmtCountdown(Math.max(0, nextOpenTime.getTime() - t)); $('nextOpenCountdown').style.color = '#16A34A'; $('nextOpenTime').textContent = fmtShort(nextOpenTime); }
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
      var op = new Date(t.bestTime.getTime() + getOpenAfter(t.direction) * 60000);
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

function sendFeedback(state) {
  var now = new Date();
  var currentStatus = $('statusTitle').textContent;
  var lastTrain = lastPassedTrain;
  var nextTrain = null;
  var allTrains = trainHistory.length > 0 ? trainHistory : trains;
  for (var i = 0; i < allTrains.length; i++) {
    if (allTrains[i].bestTime > now && !nextTrain) nextTrain = allTrains[i];
  }
  var payload = {
    timestamp: now.toISOString(),
    crossing: crossingId,
    crossingName: CFG.name,
    event: state,
    predicted: currentStatus,
    lastTrainTime: lastTrain ? fmtShort(lastTrain.bestTime) : '',
    lastTrainDirection: lastTrain ? lastTrain.direction : '',
    lastTrainRoute: lastTrain ? (lastTrain.origin + ' > ' + lastTrain.destination) : '',
    lastTrainSecsAgo: lastTrain ? Math.round((now - lastTrain.bestTime) / 1000) : '',
    nextTrainTime: nextTrain ? fmtShort(nextTrain.bestTime) : '',
    nextTrainDirection: nextTrain ? nextTrain.direction : '',
    nextTrainRoute: nextTrain ? (nextTrain.origin + ' > ' + nextTrain.destination) : '',
    nextTrainSecsAway: nextTrain ? Math.round((nextTrain.bestTime - now) / 1000) : ''
  };
  $('fbMsg').textContent = 'Sending...';
  $('fbMsg').classList.remove('hidden');
  fetch(CFG.feedbackUrl, {
    method: 'POST', mode: 'no-cors',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload)
  }).then(function() {
    var label = state === 'closing' ? 'barriers closing' : 'barriers opening';
    $('fbMsg').textContent = 'Thanks! Recorded ' + label + ' at ' + fmtShort(now) + '.';
    setTimeout(function() { $('fbMsg').classList.add('hidden'); }, 5000);
  }).catch(function() {
    $('fbMsg').textContent = 'Thanks! Feedback noted (offline).';
    setTimeout(function() { $('fbMsg').classList.add('hidden'); }, 5000);
  });
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
