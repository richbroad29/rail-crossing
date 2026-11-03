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

  var api = {
    placeName: placeName, describePlace: describePlace, estimateNote: estimateNote,
    placementWord: placementWord, currentCall: currentCall, callTime: callTime
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.RM = root.RM || {}).describe = api;
})(typeof self !== 'undefined' ? self : this);
