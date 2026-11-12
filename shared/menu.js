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
  function row(e, d) {
    var dist = d != null ? '<span class="pm-dist">' + esc(F.fmtMiles(d)) + '</span>' : '';
    var main = '<span class="pm-row-main"><span class="pm-name">' + esc(e.name) + '</span>' +
      '<span class="pm-sub">' + esc(F.place(e)) + '</span>';
    if (e.id) {
      return '<a class="pm-row pm-live" href="' + esc(F.href(e)) + '">' + main + '</span>' + dist +
        '<span class="pm-chev" aria-hidden="true">›</span></a>';
    }
    return '<a class="pm-row pm-soon" href="' + esc(F.requestUrl(e)) + '" target="_blank" rel="noopener">' + main +
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
    }).catch(function (err) {
      if (err && err.message && /^directory/.test(err.message)) return loadFailed();
      results.innerHTML = note('Location is off — allow it in your browser settings, or search instead.', 'pm-warn');
      input.focus();
    });
  }

  // ---- Search -------------------------------------------------------------------------------
  var LIMIT = 5;
  function renderSearch() {
    var q = input.value;
    if (!q.trim()) { results.innerHTML = ''; return; }
    if (q.replace(/\s/g, '').length < 2) { results.innerHTML = note('Keep typing…'); return; }
    F.load().then(function () {
      if (input.value !== q) return;                     // a newer keystroke will render
      var r = F.search(q, { here: F.knownLocation() });
      if (!r.hits.length) {
        results.innerHTML = note('No road crossings match “' + esc(q) + '”. Try a town or road name.') +
          '<button class="pm-link" type="button" data-nearby>Show nearby crossings</button>';
        return;
      }
      var h = r.typo ? note('No exact matches — showing close spellings') : '';
      h += r.hits.slice(0, LIMIT).map(function (x) { return row(x.e, x.d); }).join('');
      if (r.hits.length > LIMIT) {
        h += '<a class="pm-seemore" href="/?q=' + encodeURIComponent(q) + '">See more (' + r.hits.length + ')</a>';
      }
      results.innerHTML = h;
    }).catch(loadFailed);
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
