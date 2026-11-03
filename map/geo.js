// Pure helpers shared by the page modules: bounding boxes, distances, number and time wording,
// deep-link parsing and the ?api= override. No DOM, no globals — loads in the browser as a plain
// <script> (window.RM.geo) and in node:test via require().
(function (root) {
  'use strict';

  // Great Britain, with a little sea around it. Everything the page asks the API for is clamped
  // to this so a stray pinch-zoom over the Atlantic cannot produce a nonsense request.
  var GB_BBOX = [49.5, -9.0, 61.0, 2.5];          // [south, west, north, east]

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // ---- bounding boxes: always [south, west, north, east], the order the API takes ----------------
  function clampBbox(b) {
    var s = clamp(Math.min(b[0], b[2]), GB_BBOX[0], GB_BBOX[2]);
    var n = clamp(Math.max(b[0], b[2]), GB_BBOX[0], GB_BBOX[2]);
    var w = clamp(Math.min(b[1], b[3]), GB_BBOX[1], GB_BBOX[3]);
    var e = clamp(Math.max(b[1], b[3]), GB_BBOX[1], GB_BBOX[3]);
    return [s, w, n, e];
  }
  function padBbox(b, f) {
    var dh = (b[2] - b[0]) * f, dw = (b[3] - b[1]) * f;
    return clampBbox([b[0] - dh, b[1] - dw, b[2] + dh, b[3] + dw]);
  }
  function bboxContains(outer, inner) {
    return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
  }
  function bboxArea(b) { return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]); }
  function bboxToString(b) {
    return b.map(function (v) { return (Math.round(v * 1e4) / 1e4).toString(); }).join(',');
  }
  // MapLibre's LngLatBounds -> our [S,W,N,E]
  function boundsToBbox(bounds) {
    return [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()];
  }
  function inBbox(b, lat, lon) { return lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3]; }

  // ---- distance and direction --------------------------------------------------------------------
  function haversineKm(lat1, lon1, lat2, lon2) {
    var R = 6371, rad = Math.PI / 180;
    var dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  // Initial bearing from point 1 to point 2, degrees clockwise from north, 0..360.
  function bearing(lat1, lon1, lat2, lon2) {
    var rad = Math.PI / 180;
    var y = Math.sin((lon2 - lon1) * rad) * Math.cos(lat2 * rad);
    var x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) -
      Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lon2 - lon1) * rad);
    return (Math.atan2(y, x) / rad + 360) % 360;
  }
  var POINTS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  function compass(deg) {
    if (deg == null || !isFinite(deg)) return null;
    return POINTS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
  }

  // ---- wording -----------------------------------------------------------------------------------
  function fmtAgo(ms) {
    if (ms == null || !isFinite(ms)) return 'unknown';
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return s + ' seconds ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago');
    var h = Math.floor(m / 60);
    return h + (h === 1 ? ' hour ago' : ' hours ago') + (m % 60 ? ' ' + (m % 60) + ' min' : '');
  }
  // Short form for the status line: "3 s", "2 min".
  function fmtAgeShort(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + ' s';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' min';
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }
  function fmtCount(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function fmtMph(mph) {
    if (mph == null || !isFinite(mph)) return null;
    return Math.round(mph) + ' mph';
  }

  // ---- deep links: #t=<train id> and #s=<CRS> ----------------------------------------------------
  // Ids are opaque to us, so be strict about what we will put into a request path: a link someone
  // sends you must not be able to smuggle anything else in.
  var ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
  var CRS_RE = /^[A-Za-z]{3}$/;
  function parseHash(hash) {
    var out = { t: null, s: null };
    if (typeof hash !== 'string') return out;
    var h = hash.charAt(0) === '#' ? hash.slice(1) : hash;
    h.split('&').forEach(function (pair) {
      var i = pair.indexOf('=');
      if (i < 1) return;
      var k = pair.slice(0, i), v = pair.slice(i + 1);
      try { v = decodeURIComponent(v); } catch (e) { return; }
      if (k === 't' && ID_RE.test(v) && !out.t) out.t = v;
      else if (k === 's' && CRS_RE.test(v) && !out.s) out.s = v.toUpperCase();
    });
    return out;
  }
  function buildHash(sel) {
    if (sel && sel.t && ID_RE.test(sel.t)) return '#t=' + encodeURIComponent(sel.t);
    if (sel && sel.s && CRS_RE.test(sel.s)) return '#s=' + sel.s.toUpperCase();
    return '';
  }

  // ---- ?api= override ----------------------------------------------------------------------------
  // Development only: point the page at a service on this machine. Anything that is not plainly
  // a loopback host is ignored, so a crafted link cannot make the page send its users' requests
  // (and their map position) to someone else's server.
  var LOOPBACK = { 'localhost': 1, '127.0.0.1': 1, '[::1]': 1 };
  function resolveApiBase(search, defaultBase) {
    var raw = null;
    try { raw = new URLSearchParams(search || '').get('api'); } catch (e) { return defaultBase; }
    if (!raw) return defaultBase;
    var u;
    try { u = new URL(raw); } catch (e) { return defaultBase; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return defaultBase;
    if (u.username || u.password) return defaultBase;
    if (!Object.prototype.hasOwnProperty.call(LOOPBACK, u.hostname)) return defaultBase;
    return u.origin;
  }

  var api = {
    GB_BBOX: GB_BBOX, clamp: clamp, clampBbox: clampBbox, padBbox: padBbox, bboxContains: bboxContains,
    bboxArea: bboxArea, bboxToString: bboxToString, boundsToBbox: boundsToBbox, inBbox: inBbox,
    haversineKm: haversineKm, bearing: bearing, compass: compass,
    fmtAgo: fmtAgo, fmtAgeShort: fmtAgeShort, fmtCount: fmtCount, fmtMph: fmtMph,
    parseHash: parseHash, buildHash: buildHash, resolveApiBase: resolveApiBase
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.RM = root.RM || {}).geo = api;
})(typeof self !== 'undefined' ? self : this);
