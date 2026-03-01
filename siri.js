async function main() {

var CROSSING_ID = 'portslade';
var TOKEN = '314e8e0f-87f4-4b59-a04e-8abd3187d5a9';
var WURL = 'https://lite.realtime.nationalrail.co.uk/OpenLDBWS/ldb12.asmx';
var Q = String.fromCharCode(34);
var CONFIG_URL = 'https://richbroad29.github.io/rail-crossing/shared/crossings.json';

var cfgReq = new Request(CONFIG_URL);
var allConfig = JSON.parse(await cfgReq.loadString());
var CFG = allConfig[CROSSING_ID];

if (!CFG) {
  Script.setShortcutOutput('Sorry, crossing config not found for ' + CROSSING_ID);
  Script.complete();
  return;
}

function soap(t) {
  var m = t === 'a' ? 'GetArrBoardWithDetailsRequest' : 'GetDepBoardWithDetailsRequest';
  var x = '<?xml version=' + Q + '1.0' + Q + '?>';
  x += '<soap:Envelope xmlns:soap=' + Q + 'http://www.w3.org/2003/05/soap-envelope' + Q;
  x += ' xmlns:typ=' + Q + 'http://thalesgroup.com/RTTI/2013-11-28/Token/types' + Q;
  x += ' xmlns:ldb=' + Q + 'http://thalesgroup.com/RTTI/2021-11-01/ldb/' + Q + '>';
  x += '<soap:Header><typ:AccessToken><typ:TokenValue>' + TOKEN + '</typ:TokenValue></typ:AccessToken></soap:Header>';
  x += '<soap:Body><ldb:' + m + '><ldb:numRows>15</ldb:numRows>';
  x += '<ldb:crs>' + CFG.station + '</ldb:crs><ldb:timeWindow>120</ldb:timeWindow>';
  x += '</ldb:' + m + '></soap:Body></soap:Envelope>';
  return x;
}

function pTime(s) {
  if (!s || s.indexOf(':') < 0) return null;
  var n = new Date();
  var p = s.split(':');
  var d = new Date(n.getFullYear(), n.getMonth(), n.getDate(), parseInt(p[0]), parseInt(p[1]), 0);
  if (d.getTime() < n.getTime() - 21600000) d.setDate(d.getDate() + 1);
  return d;
}

function cd(ms) {
  if (ms <= 0) return 'right now';
  var s = Math.floor(ms / 1000);
  var m = Math.floor(s / 60);
  if (m > 60) {
    var h = Math.floor(m / 60);
    var rm = m % 60;
    if (rm === 0) return h + (h === 1 ? ' hour' : ' hours');
    return h + (h === 1 ? ' hour ' : ' hours ') + rm + ' minutes';
  }
  if (m > 0) return m + (m === 1 ? ' minute' : ' minutes');
  return s + ' seconds';
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
  if (lower.indexOf('brighton') >= 0) return true;
  if (lower.indexOf('hove') >= 0) return true;
  if (lower.indexOf('london') >= 0) return true;
  if (lower.indexOf('gatwick') >= 0) return true;
  if (lower.indexOf('croydon') >= 0) return true;
  if (lower.indexOf('haywards') >= 0) return true;
  return false;
}

function parseXml(xml, type) {
  var trains = [];
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
    var tm = pTime(bt);
    if (!tm) continue;
    var origBlock = sv.indexOf(':origin>');
    var destBlock = sv.indexOf(':destination>');
    var fr = '?', to = '?';
    if (origBlock >= 0) { fr = getVal(sv.substring(origBlock, origBlock + 200), 'locationName') || '?'; }
    if (destBlock >= 0) { to = getVal(sv.substring(destBlock, destBlock + 200), 'locationName') || '?'; }
    var dir = 'east';
    if (type === 'a') { if (isEastOrigin(fr)) dir = 'west'; }
    else { if (isEastOrigin(to)) dir = 'east'; else dir = 'west'; }
    trains.push({fr:fr, to:to, tm:tm, dir:dir, tp:type, k:(sch||'')+(to||'')});
  }
  return trains;
}

async function getTrains() {
  var all = [];
  var types = ['a', 'd'];
  for (var i = 0; i < 2; i++) {
    try {
      var r = new Request(WURL);
      r.method = 'POST';
      r.headers = {'Content-Type':'application/soap+xml;charset=utf-8'};
      r.body = soap(types[i]);
      var xml = await r.loadString();
      var parsed = parseXml(xml, types[i]);
      for (var p = 0; p < parsed.length; p++) all.push(parsed[p]);
    } catch(e) {}
  }
  var sorted = all.slice().sort(function(a,b){return a.tm - b.tm;});
  var res = [];
  for (var d = 0; d < sorted.length; d++) {
    var tr = sorted[d];
    var isDupe = false;
    for (var e = 0; e < res.length; e++) {
      var ex = res[e];
      if (ex.to === tr.to && Math.abs(ex.tm.getTime() - tr.tm.getTime()) <= 120000) {
        if (ex.dir === 'east' && tr.tp === 'a') res[e] = tr;
        else if (ex.dir === 'west' && tr.tp === 'd') res[e] = tr;
        isDupe = true;
        break;
      }
    }
    if (!isDupe) res.push(tr);
  }
  res.sort(function(a,b){return a.tm - b.tm;});
  return res;
}

function closures(trains) {
  if (!trains.length) return [];
  var per = [], cs = null, ce = null;
  for (var i = 0; i < trains.length; i++) {
    var cl = new Date(trains[i].tm.getTime() - CFG.closeBefore * 60000);
    var op = new Date(trains[i].tm.getTime() + CFG.openAfter * 60000);
    if (cs === null) { cs = cl; ce = op; }
    else if (cl.getTime() - ce.getTime() <= CFG.consecutiveWindow * 60000) { ce = new Date(Math.max(ce.getTime(), op.getTime())); }
    else { per.push({s:cs, e:ce}); cs = cl; ce = op; }
  }
  if (cs) per.push({s:cs, e:ce});
  return per;
}

var trains = [];
try { trains = await getTrains(); } catch(e) {}

var now = new Date();
var per = closures(trains);
var speech = '';

if (trains.length === 0) {
  speech = 'Sorry, I could not get live train data for ' + CFG.name + ' right now.';
} else {
  var cur = null, up = null;
  for (var i = 0; i < per.length; i++) {
    if (now >= per[i].s && now <= per[i].e) { cur = per[i]; break; }
    if (per[i].s > now && !up) up = per[i];
  }

  if (cur) {
    var opensIn = cd(cur.e.getTime() - now.getTime());
    speech = 'The crossing is likely closed right now. ';
    speech += 'Barriers should open in about ' + opensIn + '.';
    var nextClosure = null;
    for (var nc = 0; nc < per.length; nc++) {
      if (per[nc].s.getTime() > cur.e.getTime()) { nextClosure = per[nc]; break; }
    }
    if (nextClosure) {
      speech += ' It will then close again in about ' + cd(nextClosure.s.getTime() - now.getTime()) + '.';
    }
  } else if (up) {
    var closesIn = cd(up.s.getTime() - now.getTime());
    var duration = cd(up.e.getTime() - up.s.getTime());
    speech = 'The crossing is open. ';
    speech += 'It will likely close in about ' + closesIn + ' for about ' + duration + '.';
    var nextAfter = null;
    for (var na = 0; na < per.length; na++) {
      if (per[na].s.getTime() > up.e.getTime()) { nextAfter = per[na]; break; }
    }
    if (nextAfter) {
      speech += ' After that it will close again about ' + cd(nextAfter.s.getTime() - up.e.getTime()) + ' later.';
    }
  } else {
    speech = 'The crossing is open. No more closures are expected in the next couple of hours.';
  }
}

if (config.runsInApp) {
  var alert = new Alert();
  alert.title = CFG.name;
  alert.message = speech;
  alert.addAction('OK');
  await alert.present();
}

Script.setShortcutOutput(speech);
Script.complete();

}
await main();
