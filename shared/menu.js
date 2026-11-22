// The burger menu on live-crossing pages (burger-menu map: tickets 04, 06, 07, 08, 02).
// Order: Home, Recent crossings, Find closest, Search, Add as app. The drawer markup is static in
// the page (scripts/templates/crossing-page.html); this file only opens and closes it and fills
// Recent and the results area. All finding logic is shared/finder.js, which the homepage uses too.
(function () {
  'use strict';
  var F = window.FINDER;
  var $ = function (id) { return document.getElementById(id); };
  var btn = $('menuBtn'), drawer = $('menuDrawer'), backdrop = $('menuBackdrop');
  if (!F || !btn || !drawer) return;
  var input = $('menuSearch'), results = $('menuResults'), recentBox = $('menuRecent');
  var metaN = document.querySelector('meta[name="crossing-number"]');
  var CURRENT = metaN ? Number(metaN.getAttribute('content')) : 0;

  // This page is a recent crossing on this device from now on (stored by crossing number).
  F.recordVisit(CURRENT);

  // ---- rows -------------------------------------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  var SOON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  // Usage counts (shared/track.js; names in docs/analytics.md), a crossing named as home.js names it.
  var TRACK = window.TRACK || function () {};
  var PAGE = location.pathname.split('/')[1] || 'crossing';   // "portslade": as the page's own buttons name it
  if (!TRACK.search) TRACK.search = function () {};
  function tapTrack(e) {
    var l = e.name + ' (' + F.place(e) + ') #' + e.n;
    return ' data-track="' + esc(e.id ? 'menu-tap: ' + l : 'request: ' + l + ' | request-from: ' + PAGE + ' menu') + '"';
  }
  function row(e, d) {
    var dist = d != null ? '<span class="pm-dist">' + esc(F.fmtMiles(d)) + '</span>' : '';
    var main = '<span class="pm-row-main"><span class="pm-name">' + esc(e.name) + '</span>' +
      '<span class="pm-sub">' + esc(F.place(e)) + '</span>';
    if (e.id) {
      return '<a class="pm-row pm-live" href="' + esc(F.href(e)) + '"' + tapTrack(e) + '>' + main + '</span>' + dist +
        '<span class="pm-chev" aria-hidden="true">›</span></a>';
    }
    return '<a class="pm-row pm-soon" href="' + esc(F.requestUrl(e)) + '" target="_blank" rel="noopener"' + tapTrack(e) + '>' + main +
      '<span class="pm-req">Tap to request it</span></span>' + dist +
      '<span class="pm-tag">' + SOON + 'Coming soon</span></a>';
  }
  function note(text, cls) { return '<div class="pm-note' + (cls ? ' ' + cls : '') + '">' + text + '</div>'; }

  // ---- Recent -------------------------------------------------------------------------------
  function renderRecent() {
    var list = F.recent(CURRENT);
    recentBox.hidden = !list.length;
    recentBox.innerHTML = list.length
      ? '<div class="pm-eyebrow">Recent</div>' + list.map(function (e) { return row(e); }).join('') : '';
  }

  // ---- Find closest -------------------------------------------------------------------------
  function findClosest() {
    TRACK('location-button: ' + PAGE + ' menu');
    input.value = '';
    results.innerHTML = note('Finding your location…');
    F.locate().then(function (here) {
      return F.load().then(function () { return here; });
    }).then(function (here) {
      var n = F.nearest(here, 3);
      var h = n.top.map(function (x) { return row(x.e, x.d); }).join('');
      if (n.nearestLive) {
        h += '<div class="pm-nearest-live"><div class="pm-eyebrow">Nearest live crossing</div>' +
          row(n.nearestLive.e, n.nearestLive.d) + '</div>';
      }
      results.innerHTML = h;
      TRACK('location-result: found');
    }).catch(function (err) {
      if (err && err.message && /^directory/.test(err.message)) return loadFailed();
      var help = F.locationHelp(err);
      TRACK('location-result: ' + help.kind);
      results.innerHTML = note(help.html, 'pm-warn') +
        (help.kind === 'unavailable' ? '<button class="pm-link" type="button" data-nearby>Try again</button>' : '');
    });
  }

  // ---- Search -------------------------------------------------------------------------------
  var LIMIT = 5;
  function renderSearch() {
    var q = input.value;
    if (q.replace(/\s/g, '').length < 2) TRACK.search('');   // deleted back: drop the half-typed term
    if (!q.trim()) { results.innerHTML = ''; return; }
    if (q.replace(/\s/g, '').length < 2) { results.innerHTML = note('Keep typing…'); return; }
    F.load().then(function () {
      if (input.value !== q) return;                     // a newer keystroke will render
      var r = F.search(q, { here: F.knownLocation() }), p = F.postcode(q);
      if (!p || p.kind === 'partial') {
        TRACK.search(q, r.hits.length);
        results.innerHTML = hitsHTML(q, r, p, false);
        return;
      }
      // A postcode (or a district): looked up by finder.js, once a visit, then laid out as Find
      // closest lays out "you". Counted by its district only, never the full postcode.
      results.innerHTML = p.kind === 'full' || !r.hits.length ? note('Looking up ' + esc(p.code) + '…') : hitsHTML(q, r, p, false);
      F.lookupPostcode(p).then(function (pos) { return { pos: pos }; }, function () { return { failed: true }; }).then(function (a) {
        if (input.value !== q) return;
        var top = '';
        if (a.pos) top = postcodeHTML(p, a.pos);
        else if (a.failed && (p.kind === 'full' || !r.hits.length)) top = note('Couldn’t look up that postcode just now. Check your connection and try again, or search for a town or road.', 'pm-warn');
        else if (p.kind === 'full') top = note('Couldn’t find the postcode ' + esc(p.code) + '. Check it, or search for a town or road.');
        if (a.pos || p.kind === 'full') TRACK.search(p.area, !!a.pos, 'postcode-search');
        else TRACK.search(q, r.hits.length);
        results.innerHTML = top && !r.hits.length ? top : top + hitsHTML(q, r, p, !!top);
      });
    }).catch(loadFailed);
  }
  function hitsHTML(q, r, p, below) {
    if (!r.hits.length) {
      return note('No road crossings match “' + esc(q) + '”. ' + (p ? 'For a postcode, type all of it (like BN41 1AB).' : 'Try a town, road or postcode.')) +
        '<button class="pm-link" type="button" data-nearby>Show nearby crossings</button>';
    }
    var h = below ? '<div class="pm-eyebrow">Matching “' + esc(q.trim()) + '”</div>' : '';
    h += r.typo ? note('No exact matches — showing close spellings') : '';
    h += r.hits.slice(0, LIMIT).map(function (x) { return row(x.e, x.d); }).join('');
    if (r.hits.length > LIMIT) {
      h += '<a class="pm-seemore" data-track="' + esc('search-see-more: ' + PAGE + ' menu') + '" href="/?q=' + encodeURIComponent(q) + '">See more (' + r.hits.length + ')</a>';
    }
    return h;
  }
  function postcodeHTML(p, pos) {
    var n = F.nearest(pos, 3), full = p.kind === 'full';
    var h = '<div class="pm-eyebrow">Closest to ' + esc(full ? p.code : 'the ' + p.code + ' area') + '</div>' +
      n.top.map(function (x) { return row(x.e, x.d); }).join('');
    if (n.nearestLive) {
      h += '<div class="pm-nearest-live"><div class="pm-eyebrow">Nearest live crossing</div>' + row(n.nearestLive.e, n.nearestLive.d) + '</div>';
    }
    if (!full) h += note('Measured from the middle of ' + esc(p.code) + '. Type the whole postcode for the closest to you.');
    return h + '<a class="pm-seemore" data-track="' + esc('postcode-show-on-map: ' + PAGE + ' menu') + '" href="/?q=' + encodeURIComponent(p.code) + '">Show on map</a>';
  }
  function loadFailed() {
    results.innerHTML = note('Couldn’t load the list of crossings. Check your connection and try again.', 'pm-warn');
  }

  // ---- open / close -------------------------------------------------------------------------
  var lastFocus = null;
  function open() {
    lastFocus = document.activeElement;
    drawer.hidden = false; backdrop.hidden = false;
    document.body.classList.add('pm-lock');
    btn.setAttribute('aria-expanded', 'true');
    $('menuClose').focus();
    F.load().then(renderRecent).catch(function () { /* Recent stays hidden; search reports it */ });
  }
  function close() {
    drawer.hidden = true; backdrop.hidden = true;
    document.body.classList.remove('pm-lock');
    btn.setAttribute('aria-expanded', 'false');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  btn.addEventListener('click', open);
  $('menuClose').addEventListener('click', close);
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !drawer.hidden) close(); });
  $('menuFind').addEventListener('click', findClosest);
  input.addEventListener('input', renderSearch);
  // Closest-first ordering when the browser already allows location: fetched quietly, never asked.
  input.addEventListener('focus', function () { F.quietLocation(); });
  results.addEventListener('click', function (e) {
    if (e.target.closest('[data-nearby]')) findClosest();
  });
})();
