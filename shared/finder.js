// FINDER: finding a crossing, shared by the burger menu on crossing pages and the homepage.
// One implementation, so the menu and the homepage can never disagree about what a search
// matches or which crossing is closest (the same rule as shared/predict.js). The rules are the
// burger-menu map's decisions: Search matching rules (ticket 06), Crossing data model (07),
// Homepage map loading (08), Request form pre-fill (02).
//
// The data is the crossing directory, shared/directory.json, written by scripts/build-crossings.js.
// Each page names the exact version it was built with in <meta name="crossing-directory">.
// Loaded as a plain <script> (window.FINDER) and by node for scripts/finder-test.js.
(function (root) {
  'use strict';

  // ---- loading ----------------------------------------------------------------------------
  var loading = null, LIST = null;
  function directoryUrl() {
    var m = root.document && root.document.querySelector('meta[name="crossing-directory"]');
    return m ? m.getAttribute('content') : '/shared/directory.json';
  }
  // Resolves with the list; fetched once per page. A failure rejects, and the next call retries.
  function load(url) {
    if (LIST) return Promise.resolve(LIST);
    if (!loading) {
      loading = root.fetch(url || directoryUrl())
        .then(function (r) { if (!r.ok) throw new Error('directory ' + r.status); return r.json(); })
        .then(function (d) { return use(d.crossings); })
        .catch(function (e) { loading = null; throw e; });
    }
    return loading;
  }
  function use(list) {
    LIST = list;
    for (var i = 0; i < list.length; i++) index(list[i]);
    return list;
  }
  function byNumber(n) {
    if (!LIST) return null;
    for (var i = 0; i < LIST.length; i++) if (LIST[i].n === n) return LIST[i];
    return null;
  }

  // ---- words (ticket 06) --------------------------------------------------------------------
  // Case, accents, apostrophes and hyphens are ignored; "&" = "and"; other punctuation splits.
  function norm(s) {
    s = String(s == null ? '' : s).toLowerCase();
    if (s.normalize) s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return s.replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function words(s) { var n = norm(s); return n ? n.split(' ') : []; }
  var DROP = { level: 1, crossing: 1, crossings: 1, railway: 1, rail: 1 };
  // The only abbreviations, both ways.
  var ABBR = { rd: ['road'], road: ['rd'], ln: ['lane'], lane: ['ln'], st: ['street', 'saint'],
    street: ['st'], saint: ['st'] };
  function queryTokens(q) {
    return words(q).filter(function (t) { return !DROP[t]; });
  }
  function index(e) {
    if (e._w) return;
    e._w = {
      name: words(e.name).concat(words(e.town)),
      road: words(e.road).concat(words((e.alt || []).join(' '))),
      area: words([e.la, e.cc, e.country, e.county].join(' '))
    };
  }

  // How a token matches a word: 2 = the whole word, 1 = its start, 0 = not at all.
  function tokenWord(t, w, typo) {
    var alts = [t].concat(ABBR[t] || []);
    for (var i = 0; i < alts.length; i++) {
      if (w === alts[i]) return 2;
      if (w.indexOf(alts[i]) === 0 && alts[i] === t) return 1;   // abbreviations match whole words only
    }
    if (typo && t.length >= 5) {
      for (var d = -1; d <= 1; d++) if (lev1(t, w.slice(0, t.length + d))) return 1;
    }
    return 0;
  }
  // Within one edit (substitution, insertion or deletion)?
  function lev1(a, b) {
    if (a === b) return true;
    var la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1 || !lb) return false;
    var i = 0, j = 0, edits = 0;
    while (i < la && j < lb) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (la > lb) i++; else if (lb > la) j++; else { i++; j++; }
    }
    return edits + (la - i) + (lb - j) <= 1;
  }
  // Best match of one token across a list of words.
  function tokenIn(t, ws, typo) {
    var best = 0;
    for (var i = 0; i < ws.length && best < 2; i++) best = Math.max(best, tokenWord(t, ws[i], typo));
    return best;
  }

  // ---- search (ticket 06) --------------------------------------------------------------------
  // Returns { hits: [{e, group, whole, d}], typo: bool }. Empty for under 2 characters.
  // opts.here = {lat, lon}: closest first within each group (never asked for here: the caller
  // passes it only when location is already available).
  function search(q, opts) {
    opts = opts || {};
    if (!LIST || norm(q).replace(/ /g, '').length < 2) return { hits: [], typo: false };
    var toks = queryTokens(q);
    if (!toks.length) return { hits: [], typo: false };
    var hits = run(toks, false), typo = false;
    if (!hits.length) { hits = run(toks, true); typo = hits.length > 0; }
    var here = opts.here;
    hits.forEach(function (h) { h.d = here ? miles(here, h.e) : null; });
    hits.sort(function (a, b) {
      var la = a.e.id ? 0 : 1, lb = b.e.id ? 0 : 1;
      if (la !== lb) return la - lb;                       // live first
      if (a.group !== b.group) return a.group - b.group;   // name/town, road, county/country
      if (here) return a.d - b.d;
      if (a.whole !== b.whole) return a.whole ? -1 : 1;
      return a.e.name.localeCompare(b.e.name);
    });
    return { hits: hits, typo: typo };
  }
  function run(toks, typo) {
    var out = [];
    for (var i = 0; i < LIST.length; i++) {
      var e = LIST[i], w = e._w, group = 2, whole = true, ok = true;
      for (var k = 0; k < toks.length && ok; k++) {
        var n = tokenIn(toks[k], w.name, typo), r = n ? 0 : tokenIn(toks[k], w.road, typo),
          a = n || r ? 0 : tokenIn(toks[k], w.area, typo), m = n || r || a;
        if (!m) { ok = false; break; }
        if (m === 1) whole = false;
        group = Math.min(group, n ? 0 : r ? 1 : 2);
      }
      if (ok) out.push({ e: e, group: group, whole: whole });
    }
    return out;
  }

  // ---- distance (Find closest / Nearby) ------------------------------------------------------
  function miles(a, b) {
    var R = Math.PI / 180, dLa = (b.lat - a.lat) * R, dLo = (b.lon - a.lon) * R;
    var h = Math.pow(Math.sin(dLa / 2), 2) + Math.cos(a.lat * R) * Math.cos(b.lat * R) * Math.pow(Math.sin(dLo / 2), 2);
    return 3958.8 * 2 * Math.asin(Math.sqrt(h));
  }
  function fmtMiles(m) { return (m < 10 ? m.toFixed(1) : String(Math.round(m))) + ' mi'; }
  // The k closest, plus the nearest live one when none of those is live.
  function nearest(here, k) {
    var all = LIST.map(function (e) { return { e: e, d: miles(here, e) }; })
      .sort(function (a, b) { return a.d - b.d; });
    var top = all.slice(0, k || 3), nearestLive = null;
    if (!top.some(function (x) { return x.e.id; })) {
      for (var i = 0; i < all.length; i++) if (all[i].e.id) { nearestLive = all[i]; break; }
    }
    return { top: top, nearestLive: nearestLive };
  }

  // Location is used only on the phone and never asked for unless the visitor taps Find closest
  // or Nearby. `known` is a position already granted this visit; it is not stored.
  var known = null;
  function locate() {
    return new Promise(function (resolve, reject) {
      if (!root.navigator || !root.navigator.geolocation) return reject(new Error('unavailable'));
      root.navigator.geolocation.getCurrentPosition(function (p) {
        known = { lat: p.coords.latitude, lon: p.coords.longitude };
        resolve(known);
      }, reject, { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
    });
  }
  // Without prompting: the position, if this visit already has one or the browser already allows it.
  function quietLocation() {
    if (known) return Promise.resolve(known);
    var p = root.navigator && root.navigator.permissions;
    if (!p || !p.query) return Promise.resolve(null);
    return p.query({ name: 'geolocation' }).then(function (s) {
      return s.state === 'granted' ? locate().catch(function () { return null; }) : null;
    }).catch(function () { return null; });
  }
  function knownLocation() { return known; }

  // What to tell the visitor when locate() fails. A browser shows its "allow location?" popup only
  // while the question is unanswered; once it has stored "no" (or location is off for the browser
  // itself) it refuses at once, with no popup, and no website can ask again. So a blocked visitor
  // needs the steps to unblock it on their phone, and a merely unlucky one needs "Try again".
  // Returns { kind: 'blocked'|'unavailable'|'unsupported', html }.
  function locationHelp(err) {
    var ua = (root.navigator && root.navigator.userAgent) || '';
    var ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && root.navigator.maxTouchPoints > 1);
    var app = /CriOS/.test(ua) ? 'Chrome' : /FxiOS/.test(ua) ? 'Firefox' : /EdgiOS/.test(ua) ? 'Edge' : 'Safari';
    var code = err && err.code;
    if (!root.navigator || !root.navigator.geolocation || (err && err.message === 'unavailable')) {
      return { kind: 'unsupported', html: 'This browser can’t share your location. Search for a town or road instead.' };
    }
    if (code === 1) {
      var steps;
      if (ios && app === 'Safari') {
        steps = '<li>Open <strong>Settings</strong> → <strong>Privacy &amp; Security</strong> → <strong>Location Services</strong>, and check it is <strong>On</strong>.</li>' +
          '<li>In that list tap <strong>Safari Websites</strong> and choose <strong>While Using the App</strong> (or <strong>Ask Next Time</strong>).</li>' +
          '<li>Back in Safari, tap <strong>aA</strong> in the address bar → <strong>Website Settings</strong> → <strong>Location</strong> → <strong>Allow</strong> (or <strong>Ask</strong>).</li>' +
          '<li>Reload this page and tap again.</li>';
      } else if (ios) {
        steps = '<li>Open <strong>Settings</strong> → <strong>' + app + '</strong> → <strong>Location</strong> → <strong>While Using the App</strong>.</li>' +
          '<li>Check <strong>Settings</strong> → <strong>Privacy &amp; Security</strong> → <strong>Location Services</strong> is <strong>On</strong>.</li>' +
          '<li>Reload this page and tap again.</li>';
      } else if (/Android/.test(ua)) {
        steps = '<li>Tap the icon to the left of the web address → <strong>Permissions</strong> → <strong>Location</strong> → <strong>Allow</strong> (or <strong>Reset permission</strong>).</li>' +
          '<li>Check your phone’s <strong>Location</strong> is on (swipe down from the top of the screen).</li>' +
          '<li>Reload this page and tap again.</li>';
      } else {
        steps = '<li>Allow location for railcrossing.uk in your browser’s site settings (usually the icon to the left of the web address).</li><li>Reload this page and try again.</li>';
      }
      return { kind: 'blocked', html: '<strong>Location is blocked for this site</strong>, so your phone didn’t ask. To allow it:<ol class="loc-steps">' + steps + '</ol>Or search for a town or road instead.' };
    }
    return { kind: 'unavailable', html: 'Couldn’t find your location just now (weak signal, or it took too long).' };
  }

  // ---- display ------------------------------------------------------------------------------
  // "Road, Town"; an unnamed road shows the town only (ticket 09).
  function place(e) { return e.road ? e.road + ', ' + e.town : e.town; }
  function href(e) { return e.id ? '/' + e.id + '/' : requestUrl(e); }
  // The request form, pre-filled with town and road (ticket 02). The long URL, never forms.gle.
  var FORM = 'https://docs.google.com/forms/d/e/1FAIpQLSdlD0Bm0jzDolWCKgJ4S3d8Bu9Pa8FCF6VmENbRcHAYHqzEXQ/viewform?usp=pp_url';
  function requestUrl(e) {
    return FORM + '&entry.310342749=' + encodeURIComponent(e.town || '') +
      (e.road ? '&entry.330374812=' + encodeURIComponent(e.road) : '');
  }

  // ---- recent crossings (per device; ticket 07: stored by crossing number) --------------------
  var KEY = 'rc-recent-crossings';
  function readRecent() {
    try { var v = JSON.parse(root.localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  }
  function recordVisit(n) {
    n = Number(n);
    if (!n) return;
    var v = readRecent().filter(function (x) { return x !== n; });
    v.unshift(n);
    try { root.localStorage.setItem(KEY, JSON.stringify(v.slice(0, 10))); } catch (e) { /* private mode */ }
  }
  // Up to 3 live crossings, newest first, leaving out the one being viewed.
  function recent(exclude) {
    var out = [];
    readRecent().forEach(function (n) {
      if (out.length >= 3 || n === Number(exclude)) return;
      var e = byNumber(n);
      if (e && e.id) out.push(e);
    });
    return out;
  }

  var FINDER = { load: load, use: use, search: search, nearest: nearest, miles: miles, fmtMiles: fmtMiles,
    locate: locate, quietLocation: quietLocation, knownLocation: knownLocation, locationHelp: locationHelp, place: place, href: href,
    requestUrl: requestUrl, recordVisit: recordVisit, recent: recent, byNumber: byNumber,
    _norm: norm, _lev1: lev1 };
  if (typeof module !== 'undefined' && module.exports) module.exports = FINDER;
  else root.FINDER = FINDER;
})(typeof window !== 'undefined' ? window : globalThis);
