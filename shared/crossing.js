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

var isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
var isAndroid = /Android/.test(navigator.userAgent);

function $(id) { return document.getElementById(id); }
function fmtTime(d) { if (!d) return '--:--'; return d.toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
function fmtShort(d) { if (!d) return ''; return d.toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'}); }
function fmtCountdown(ms) {
  if (ms <= 0) return 'NOW';
  var s = Math.floor(ms / 1000), m = Math.floor(s / 60), sec = s % 60;
  return m > 0 ? m + 'm ' + sec + 's' : sec + 's';
}
function getColors(st) {
  switch(st) {
    case 'CLOSED': return {bg:'#DC2626',text:'#FFF',glow:'0 0 30px rgba(220,38,38,.5)'};
    case 'CLOSING_SOON': return {bg:'#F59E0B',text:'#000',glow:'0 0 30px rgba(245,158,11,.5)'};
    case 'OPEN': return {bg:'#16A34A',text:'#FFF',glow:'0 0 30px rgba(22,163,74,.5)'};
    default: return {bg:'#6B7280',text:'#FFF',glow:'none'};
  }
}

function buildSoap(type) {
  var method = type === 'arr' ? 'GetArrBoardWithDetailsRequest' : 'GetDepBoardWithDetailsRequest';
  var s = '<?xml version=' + Q + '1.0' + Q + '?>';
  s += '<soap:Envelope xmlns:soap=' + Q + 'http://www.w3.org/2003/05/soap-envelope' + Q;
  s += ' xmlns:typ=' + Q + 'http://thalesgroup.com/RTTI/2013-11-28/Token/types' + Q;
  s += ' xmlns:ldb=' + Q + 'http://thalesgroup.com/RTTI/2021-11-01/ldb/' + Q + '>';
  s += '<soap:Header><typ:AccessToken><typ:TokenValue>' + NR_TOKEN + '</typ:TokenValue></typ:AccessToken></soap:Header>';
  s += '<soap:Body><ldb:' + method + '><ldb:numRows>15</ldb:numRows>';
  s += '<ldb:crs>' + CFG.station + '</ldb:crs><ldb:timeWindow>120</ldb:timeWindow>';
  s += '</ldb:' + method + '></soap:Body></soap:Envelope>';
  return s;
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

function parseXml(xml, type) {
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
    if (et && et !== 'On time' && et !== 'Delayed' && et.indexOf(':') >= 0) bt = et;
    var bestTime = parseTimeStr(bt);
    if (!bestTime) continue;
    var origBlock = sv.indexOf(':origin>');
    var destBlock = sv.indexOf(':destination>');
    var origin = '?', dest = '?';
    if (origBlock >= 0) { origin = getVal(sv.substring(origBlock, origBlock + 200), 'locationName') || '?'; }
    if (destBlock >= 0) { dest = getVal(sv.substring(destBlock, destBlock + 200), 'locationName') || '?'; }
    var operMatch = sv.indexOf(':operator>');
    var operator = '?';
    if (operMatch >= 0) { operator = getVal(sv.substring(operMatch - 5, operMatch + 100), 'operator') || '?'; }
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
      delayMins:delayMins, etaText:et||'On time', direction:direction,
      operator:operator, type:type, dedupKey:(sch||'')+(dest||'')
    });
  }
  return results;
}

async function fetchNationalRail() {
  var results = [];
  var types = ['arr', 'dep'];
  for (var i = 0; i < 2; i++) {
    var type = types[i];
    try {
      var soapBody = buildSoap(type);
      var response;
      try {
        response = await fetch(NR_ENDPOINT, {method:'POST', headers:{'Content-Type':'application/soap+xml;charset=utf-8'}, body:soapBody});
      } catch(e) {
        response = await fetch(CORS_PROXY + encodeURIComponent(NR_ENDPOINT), {method:'POST', headers:{'Content-Type':'application/soap+xml;charset=utf-8'}, body:soapBody});
      }
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var xml = await response.text();
      var svcs = parseXml(xml, type);
      for (var j = 0; j < svcs.length; j++) results.push(svcs[j]);
    } catch(e) { console.warn('NR API (' + type + ') error:', e); lastError = e.message; }
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
        if (r.direction === 'east' && t.type === 'arr') results[j] = t;
        else if (r.direction === 'west' && t.type === 'dep') results[j] = t;
        isDupe = true;
        break;
      }
    }
    if (!isDupe) results.push(t);
  }
  results.sort(function(a,b) { return a.bestTime - b.bestTime; });
  return results;
}

function computeClosures(trainList) {
  if (!trainList.length) return [];
  var sorted = trainList.slice().sort(function(a,b) { return a.bestTime - b.bestTime; });
  var periods = [], cs = null, ce = null;
  for (var i = 0; i < sorted.length; i++) {
    var t = sorted[i];
    var cl = new Date(t.bestTime.getTime() - CFG.closeBefore * 60000);
    var op = new Date(t.bestTime.getTime() + CFG.openAfter * 60000);
    if (cs === null) { cs = cl; ce = op; }
    else if (cl.getTime() - ce.getTime() <= CFG.consecutiveWindow * 60000) { ce = new Date(Math.max(ce.getTime(), op.getTime())); }
    else { periods.push({start:cs, end:ce}); cs = cl; ce = op; }
  }
  if (cs) periods.push({start:cs, end:ce});
  return periods;
}

async function refreshData() {
  try {
    $('errorBox').classList.add('hidden');
    var liveTrains = await fetchNationalRail();
    if (liveTrains.length > 0) {
      trains = deduplicateTrains(liveTrains);
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
      $('apiStatus').className = 'api-status api-live';
      $('apiStatus').textContent = 'Live Data Connected';
      $('dataMode').textContent = 'LIVE';
      $('dataMode').style.color = '#22D3EE';
    } else {
      trains = [];
      apiMode = 'offline';
      $('apiStatus').className = 'api-status api-error';
      $('apiStatus').textContent = 'Offline' + (lastError ? ' (' + lastError + ')' : '');
      $('dataMode').textContent = 'OFFLINE';
      $('dataMode').style.color = '#FCA5A5';
    }
    closurePeriods = computeClosures(trains);
    $('lastRefreshTime').textContent = fmtShort(new Date());
    renderTrains();
  } catch(e) {
    console.error('Refresh error:', e);
    $('errorBox').textContent = 'Error: ' + e.message;
    $('errorBox').classList.remove('hidden');
  }
}

function renderTrains() {
  var now = new Date();
  var upcoming = trains.filter(function(t) { return t.bestTime > new Date(now.getTime() - 60000); }).slice(0, 6);
  if (!upcoming.length) { $('trainList').innerHTML = '<div class="empty">No upcoming trains</div>'; return; }
  var html = '';
  for (var i = 0; i < upcoming.length; i++) {
    var t = upcoming[i];
    var ms = t.bestTime.getTime() - now.getTime();
    var isPast = ms < -30000;
    var dirColor = t.direction === 'east' ? '#38BDF8' : '#FB923C';
    var arrow = t.direction === 'east' ? '&rarr;' : '&larr;';
    var delayBadge = t.isDelayed && t.delayMins > 0 ? '<span class="delay-badge">+' + t.delayMins + 'm</span>' : '';
    var liveDot = t.isRealtime ? '<span class="live-dot">&#9679; LIVE</span>' : '';
    var etaColor = t.etaText === 'On time' ? '#6EE7B7' : t.isDelayed ? '#FCD34D' : '#94A3B8';
    html += '<div class="train-row" style="opacity:' + (isPast ? .35 : 1) + '">';
    html += '<div class="train-dir" style="color:' + dirColor + ';font-weight:700">' + arrow + '</div>';
    html += '<div class="train-info">';
    html += '<div class="train-route">' + t.origin + ' &rarr; ' + t.destination + '</div>';
    html += '<div class="train-meta">' + t.operator + liveDot + delayBadge + ' &middot; <span style="color:' + etaColor + '">' + t.etaText + '</span></div>';
    html += '</div>';
    html += '<div class="train-time">';
    html += '<div class="train-time-val">' + fmtShort(t.bestTime) + '</div>';
    html += '<div class="train-countdown" style="color:' + (ms > 0 ? '#94A3B8' : '#EF4444') + '">' + (ms > 0 ? fmtCountdown(ms) : 'passed') + '</div>';
    html += '</div></div>';
  }
  $('trainList').innerHTML = html;
}

function updateStatus() {
  var now = new Date();
  $('clock').textContent = fmtTime(now);
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
  renderTrains();
}

function sendFeedback(state) {
  var now = new Date();
  var currentStatus = $('statusTitle').textContent;
  var lastTrain = null, nextTrain = null;
  var allTrains = trainHistory.length > 0 ? trainHistory : trains;
  for (var i = 0; i < allTrains.length; i++) {
    if (allTrains[i].bestTime <= now) lastTrain = allTrains[i];
    if (allTrains[i].bestTime > now && !nextTrain) nextTrain = allTrains[i];
  }
  var payload = {
    timestamp: now.toISOString(),
    crossing: crossingId,
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
  if (type === 'homescreen') {
    if (isIOS) {
      title = 'Add to Home Screen \u2014 iPhone';
      body = '<ol><li>Make sure you are viewing this page in <strong>Safari</strong></li>';
      body += '<li>Tap the <strong>Share button</strong> (square with arrow) at the bottom</li>';
      body += '<li>Scroll down and tap <strong>"Add to Home Screen"</strong></li>';
      body += '<li>Name it <strong>"Crossing"</strong> or whatever you prefer</li>';
      body += '<li>Tap <strong>Add</strong></li></ol>';
      body += '<p>The app will appear on your home screen and open full-screen.</p>';
    } else if (isAndroid) {
      title = 'Add to Home Screen \u2014 Android';
      body = '<ol><li>Open this page in <strong>Chrome</strong></li>';
      body += '<li>Tap the <strong>three-dot menu</strong> in the top right</li>';
      body += '<li>Tap <strong>"Add to Home screen"</strong> or <strong>"Install app"</strong></li>';
      body += '<li>Name it <strong>"Crossing"</strong></li>';
      body += '<li>Tap <strong>Add</strong></li></ol>';
    } else {
      title = 'Add to Home Screen';
      body = '<p><strong>iPhone (Safari):</strong></p><ol><li>Tap Share button</li><li>Tap "Add to Home Screen"</li><li>Tap Add</li></ol>';
      body += '<p><strong>Android (Chrome):</strong></p><ol><li>Tap three-dot menu</li><li>Tap "Add to Home screen"</li><li>Tap Add</li></ol>';
    }
  } else if (type === 'voice') {
    if (isIOS) {
      title = 'Add to Siri \u2014 iPhone';
      body = '<p>Ask the crossing status hands-free:</p><ol>';
      body += '<li>Install <strong><a href="https://apps.apple.com/app/scriptable/id1405459188" target="_blank" style="color:#38BDF8">Scriptable</a></strong> from the App Store (free)</li>';
      body += '<li>Open Scriptable, create a new script called <strong>"Crossing Siri"</strong></li>';
      body += '<li>Paste these 3 lines:<div style="background:#0F172A;padding:8px;border-radius:6px;margin:6px 0;font-family:monospace;font-size:10px;word-break:break-all;color:#6EE7B7">';
      body += "var r = new Request('https://raw.githubusercontent.com/richbroad29/rail-crossing/main/siri.js');<br>";
      body += "var code = await r.loadString();<br>";
      body += "await eval('(async()=>{' + code + '})()');</div></li>";
      body += '<li>Open the <strong>Shortcuts</strong> app, create a new shortcut</li>';
      body += '<li>Name it <strong>"Is the crossing open"</strong></li>';
      body += '<li>Add action: search <strong>Scriptable</strong> &rarr; <strong>Run Script</strong> &rarr; select "Crossing Siri"</li>';
      body += '<li>Add action: <strong>Speak Text</strong> &rarr; set to Shortcut Input</li>';
      body += '<li>In the Scriptable action, turn off <strong>"Run In App"</strong></li></ol>';
      body += '<p>Now say <strong>"Hey Siri, is the crossing open"</strong>!</p>';
    } else if (isAndroid) {
      title = 'Add to Google Assistant \u2014 Android';
      body = '<ol><li>Open the <strong>Google app</strong></li>';
      body += '<li>Profile &rarr; <strong>Settings</strong> &rarr; <strong>Google Assistant</strong> &rarr; <strong>Routines</strong></li>';
      body += '<li>Create a new routine</li>';
      body += '<li>Trigger: <strong>"Is the crossing open"</strong></li>';
      body += '<li>Action: <strong>Open website</strong> &rarr; <div style="background:#0F172A;padding:8px;border-radius:6px;margin:6px 0;font-family:monospace;font-size:10px;color:#6EE7B7">' + appUrl + '</div></li></ol>';
      body += '<p>Say <strong>"Hey Google, is the crossing open"</strong>!</p>';
    } else {
      title = 'Voice Assistant Setup';
      body = '<p>Open this page on your phone for device-specific instructions.</p>';
    }
  }
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = body;
  $('modalOverlay').classList.remove('hidden');
}

function closeModal(e) {
  if (e && e.target && e.target.id !== 'modalOverlay') return;
  $('modalOverlay').classList.add('hidden');
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

  if (!isIOS) {
    var vbl = $('voiceBtnLabel');
    if (vbl) vbl.textContent = 'Add to Google Assistant';
  }

  refreshData();
  setInterval(updateStatus, 1000);
  setInterval(refreshData, 60000);
}
