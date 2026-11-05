// Plain-English descriptions of what the API tells us about a train. Pure: no DOM.
// Browser: window.RM.describe. Node: require().
(function (root) {
  'use strict';

  var classes = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('./classes.js') : root.RM.classes;

  // The contract does not fix whether a place is a name or {crs, name}; accept both.
  function placeName(p) {
    if (p == null) return null;
    if (typeof p === 'string') return classes.titleCase(p);
    return p.name ? classes.titleCase(p.name) : (p.crs || null);
  }

  // "At Brighton", "Between Hove and Portslade", "Near Worthing".
  function describePlace(place) {
    if (!place) return 'Position unknown';
    if (place.kind === 'station') {
      var s = placeName(place.station);
      return s ? 'At ' + s + ' station' : 'At a station';
    }
    if (place.kind === 'between' && place.between && place.between.length === 2) {
      var a = placeName(place.between[0]), b = placeName(place.between[1]);
      if (a && b) return 'Between ' + a + ' and ' + b;
    }
    if (place.kind === 'near') {
      var n = placeName(place.station);
      return n ? 'Near ' + n : 'Somewhere on the line';
    }
    return 'Somewhere on the line';
  }

  // Why a position is marked as estimated, in words a passenger would use. null when it is exact.
  function estimateNote(pl) {
    if (pl === 'i') {
      return 'This position is estimated. The signalling system only says which short section of track the train is in, ' +
        'so we have placed it along the line between its stations.';
    }
    if (pl === 'a') {
      return 'This is a rough position. We know the general area the train is in, but not exactly where.';
    }
    return null;
  }
  function placementWord(pl) {
    return pl === 's' ? 'at a station' : pl === 'i' ? 'estimated along the line' : pl === 'a' ? 'rough' : 'unknown';
  }

  // Which calling point is the train at, or heading for? Matched by name, because that is all the
  // detail response gives us for places. Returns { index, here } or null when nothing matches.
  function currentCall(calls, place) {
    if (!calls || !calls.length || !place) return null;
    function find(p) {
      var n = placeName(p);
      if (!n) return -1;
      var low = n.toLowerCase();
      for (var i = 0; i < calls.length; i++) {
        if (calls[i].name && classes.titleCase(calls[i].name).toLowerCase() === low) return i;
      }
      return -1;
    }
    if (place.kind === 'station') { var i = find(place.station); return i >= 0 ? { index: i, here: true } : null; }
    if (place.kind === 'between' && place.between && place.between.length === 2) {
      var a = find(place.between[0]), b = find(place.between[1]);
      if (a >= 0 && b >= 0) return { index: Math.max(a, b), here: false, from: Math.min(a, b) };
      return null;
    }
    return null;
  }

  // The one time to show against a calling point, with what it means.
  function callTime(c) {
    if (c.dep && c.arr && c.dep !== c.arr) return { text: c.arr + ' / ' + c.dep, label: 'arrives ' + c.arr + ', leaves ' + c.dep };
    if (c.dep) return { text: c.dep, label: 'leaves ' + c.dep };
    if (c.arr) return { text: c.arr, label: 'arrives ' + c.arr };
    if (c.pass) return { text: c.pass, label: 'passes through without stopping at ' + c.pass, passing: true };
    return { text: '', label: '' };
  }


  // ---- lateness, next station, calling points, station boards (phase 2) -------------------------------
  // `late` is signed minutes, positive = late (assumption recorded in the page notes: the contract says
  // "signed minutes"; TRUST's variation is positive for late and negative for early).
  function latePill(late) {
    if (typeof late !== 'number' || !isFinite(late)) return null;
    var m = Math.round(late);
    if (m === 0) return { kind: 'ok', text: 'On time' };
    if (m > 0) return { kind: m >= 5 ? 'bad' : 'late', text: m + (m === 1 ? ' min late' : ' min late') };
    return { kind: 'early', text: -m + ' min early' };
  }
  // "Next: Hove 14:06, expected 14:07" (or "on time" when they agree). null when there is no next call.
  function nextLine(next) {
    if (!next || !next.name) return null;
    var name = classes.titleCase(next.name);
    if (!next.time) return 'Next: ' + name;
    if (next.exp && next.exp !== next.time) return 'Next: ' + name + ' ' + next.time + ', expected ' + next.exp;
    return 'Next: ' + name + ' ' + next.time + ', on time';
  }
  // What to show for one calling point, as plain data: { booked, passing, status: [..], expected, platform }.
  // actual* are what happened; exp* what is now expected (booked plus current lateness, never in the past).
  function callStatus(c) {
    var t = callTime(c);
    var out = { booked: t.text, bookedLabel: t.label, passing: !!t.passing, cancelled: !!c.cancelled, done: null, expected: null,
      platform: null, platformChanged: false, platformWas: null };
    if (c.cancelled) return withPlatform(out, c);
    if (c.actualDep) out.done = 'Left ' + c.actualDep;
    else if (c.actualArr) out.done = 'Arrived ' + c.actualArr;
    else if (c.actualPass) out.done = 'Passed ' + c.actualPass;
    if (!out.done) {
      var exp = c.expArr || c.expDep;
      var booked = c.arr || c.dep || c.pass;
      if (exp && exp !== booked) out.expected = 'Expected ' + exp;
      else if (exp) out.expected = 'On time';
    }
    return withPlatform(out, c);
  }
  function withPlatform(out, c) {
    if (c.platformActual && c.platform && c.platformActual !== c.platform) {
      out.platform = 'Platform ' + c.platformActual; out.platformChanged = true; out.platformWas = c.platform;
    } else if (c.platformActual) out.platform = 'Platform ' + c.platformActual;
    else if (c.platform) out.platform = 'Platform ' + c.platform;
    else out.platform = out.passing ? 'Passes' : '';
    return out;
  }

  var KIND_LABEL = { dep: 'Departures', arr: 'Arrivals', pass: 'Passing' };
  // A station board row, as plain data. kind says which tab it is shown on.
  function boardRow(r) {
    var cls = classes.classInfo(r.hc), plain = null;
    if (cls.key === 'freight') plain = 'Freight';
    else if (cls.key === 'ecs') plain = 'Empty train';
    else if (cls.key === 'special') plain = 'Special working';
    var shown = r.actual || r.expected || r.booked;
    var status, tone;
    if (r.cancelled) { status = 'Cancelled'; tone = 'bad'; }
    else if (r.actual) {
      status = (r.kind === 'arr' ? 'Arrived ' : r.kind === 'pass' ? 'Passed ' : 'Left ') + r.actual;
      tone = 'done';
    } else {
      var l = typeof r.late === 'number' ? Math.round(r.late) : null;
      if (r.expected && r.expected !== r.booked) { status = 'Expected ' + r.expected; tone = l != null && l >= 5 ? 'bad' : 'late'; }
      else { status = 'On time'; tone = 'ok'; }
    }
    return {
      trainId: r.trainId || null, hc: r.hc, kind: r.kind, time: shown, booked: r.booked, status: status, tone: tone,
      platform: r.platform || null, plain: plain, cls: cls, toc: r.toc || null,
      place: r.kind === 'arr' ? 'from ' + classes.titleCase(r.o || '') : classes.titleCase(r.d || ''),
      route: classes.titleCase(r.o || '') + ' to ' + classes.titleCase(r.d || '')
    };
  }
  function boardRows(board, kind) {
    return (board || []).filter(function (r) { return r.kind === kind; }).map(boardRow);
  }
  function recentRow(r) {
    var l = typeof r.late === 'number' ? Math.round(r.late) : null;
    return { hc: r.hc, text: (r.kind === 'arr' ? 'Arrived ' : r.kind === 'pass' ? 'Passed ' : 'Left ') + r.time,
      late: l != null && l !== 0 ? (l > 0 ? l + ' min late' : -l + ' min early') : (l === 0 ? 'on time' : null) };
  }

  var api = {
    latePill: latePill, nextLine: nextLine, callStatus: callStatus, boardRow: boardRow, boardRows: boardRows, recentRow: recentRow, KIND_LABEL: KIND_LABEL,
    placeName: placeName, describePlace: describePlace, estimateNote: estimateNote,
    placementWord: placementWord, currentCall: currentCall, callTime: callTime
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.RM = root.RM || {}).describe = api;
})(typeof self !== 'undefined' ? self : this);
