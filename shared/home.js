// The homepage: search, Nearby, the Live crossings filter, the map, and Add as app.
// Decisions: burger-menu map tickets 05 (layout v5), 06 (search), 08 (loading), 11 (copy).
// All finding logic is shared/finder.js, the same engine the burger menu uses.
// Loading order (ticket 08): the page's text is plain HTML and shows first; this script starts
// the 47 KB crossing directory at once (search and Nearby need only that) and loads the map
// library itself afterwards, so a slow or failed map never holds search up.
(function () {
  'use strict';
  var F = window.FINDER;
  var $ = function (id) { return document.getElementById(id); };
  var q = $('hpQ'), dd = $('hpDD'), nearBtn = $('nearBtn'), clearBtn = $('hpClear');
  var strip = $('nearStrip'), stripIn = $('nearStripIn'), placeCard = $('placeCard'), mapStatus = $('mapStatus');
  if (!F || !q) return;
  // The map library: the same version, place and integrity hash as /map (map/index.html).
  var LIB_SRI = '5+cfbwT0iiub6VsQAdn6yz16nr6sDiQoHx6tm4O8OVYXHYOxcffFmCJBL0dgdvGp';
  var ready = F.load();
  ready.catch(function () { /* each caller reports it where it shows */ });

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  var ICON = {
    soon: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    near: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
    close: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>'
  };
  function note(t, cls) { return '<div class="pm-note' + (cls ? ' ' + cls : '') + '">' + t + '</div>'; }
  // The same row as the burger menu: live plain with a chevron, coming soon striped with a badge.
  function row(e, d, num) {
    var n = num != null ? '<span class="pm-num">' + num + '</span>' : '';
    var dist = d != null ? '<span class="pm-dist">' + esc(F.fmtMiles(d)) + '</span>' : '';
    var main = '<span class="pm-row-main"><span class="pm-name">' + esc(e.name) + '</span><span class="pm-sub">' + esc(F.place(e)) + '</span>';
    if (e.id) return '<a class="pm-row pm-live" href="' + esc(F.href(e)) + '">' + n + main + '</span>' + dist + '<span class="pm-chev" aria-hidden="true">›</span></a>';
    return '<a class="pm-row pm-soon" href="' + esc(F.requestUrl(e)) + '" target="_blank" rel="noopener">' + n + main +
      '<span class="pm-req">Tap to request it</span></span>' + dist + '<span class="pm-tag">' + ICON.soon + 'Coming soon</span></a>';
  }

  // ---- search dropdown (ticket 05: Nearby + recents on focus; all matches when typing) ----------
  function hits() { return F.search(q.value, { here: F.knownLocation() }); }
  function ddHTML() {
    var text = q.value.trim();
    if (!text) {
      var rec = F.recent(0);
      return '<button class="hp-dditem" type="button" data-near>' + ICON.near + '<span>Show nearby crossings</span></button>' +
        (rec.length ? '<div class="pm-eyebrow">Recent</div>' + rec.map(function (e) { return row(e); }).join('') : '');
    }
    if (text.replace(/\s/g, '').length < 2) return note('Keep typing…');
    var r = hits();
    if (!r.hits.length) {
      return note('No road crossings match “' + esc(text) + '”. Try a town or road name.') +
        '<button class="hp-dditem" type="button" data-near>' + ICON.near + '<span>Show nearby crossings</span></button>';
    }
    var nl = r.hits.filter(function (h) { return h.e.id; }).length;
    return '<div class="hp-ddhead"><span>' + r.hits.length + ' crossing' + (r.hits.length === 1 ? '' : 's') +
      (nl ? ' · ' + nl + ' live' : '') + '</span><button class="hp-linkbtn" type="button" data-fit>Show on map</button></div>' +
      (r.typo ? note('No exact matches — showing close spellings') : '') +
      r.hits.slice(0, 300).map(function (h) { return row(h.e, h.d); }).join('') +
      (r.hits.length > 300 ? note('Showing the first 300. Add a town or road to narrow it down.') : '');
  }
  function openDD() {
    ready.then(function () {
      dd.innerHTML = ddHTML(); dd.hidden = false; nearBtn.hidden = true;
    }, function () {
      dd.innerHTML = note('Couldn’t load the list of crossings. Check your connection and try again.', 'pm-warn');
      dd.hidden = false;
    });
  }
  function closeDD() { dd.hidden = true; nearBtn.hidden = false; }

  // ---- Live crossings list: the static links, filtered by the search text (ticket 05) -----------
  var liveRows = $('liveRows'), liveCount = $('liveCount'), liveNone = $('liveNone');
  var LIVE_TOTAL = liveRows ? liveRows.querySelectorAll('[data-n]').length : 0;
  function filterLive() {
    if (!liveRows) return;
    var text = q.value.trim(), all = liveRows.querySelectorAll('[data-n]');
    if (text.replace(/\s/g, '').length < 2) {
      Array.prototype.forEach.call(all, function (a) { a.hidden = false; });
      liveCount.textContent = LIVE_TOTAL; liveNone.hidden = true; groupHeads(); return;
    }
    ready.then(function () {
      var keep = {};
      F.search(text).hits.forEach(function (h) { if (h.e.id) keep[h.e.n] = 1; });
      var shown = 0;
      Array.prototype.forEach.call(all, function (a) { var on = !!keep[a.getAttribute('data-n')]; a.hidden = !on; if (on) shown++; });
      liveCount.textContent = shown + ' of ' + LIVE_TOTAL + ' match “' + text + '”';
      liveNone.hidden = shown > 0;
      liveNone.textContent = 'No live crossings match “' + text + '”. Coming-soon ones are on the map and in search.';
      groupHeads();
    });
  }
  // A county heading shows only while one of its crossings does.
  function groupHeads() {
    var heads = liveRows.querySelectorAll('.hp-county');
    Array.prototype.forEach.call(heads, function (h) {
      var n = h.nextElementSibling, any = false;
      while (n && !n.classList.contains('hp-county')) { if (!n.hidden) any = true; n = n.nextElementSibling; }
      h.hidden = !any;
    });
  }

  // ---- Nearby (ticket 05: numbered cards under the map; the map fits to you + them) --------------
  function card(e, d, num, label) {
    var live = !!e.id;
    return '<a class="hp-card' + (live ? '' : ' pm-soon') + '" href="' + esc(F.href(e)) + '"' + (live ? '' : ' target="_blank" rel="noopener"') + '>' +
      '<span class="row1"><span class="pm-num">' + num + '</span><span class="pm-dist">' + (label ? label + ' · ' : '') + esc(F.fmtMiles(d)) + '</span></span>' +
      '<span class="pm-name">' + esc(e.name) + '</span><span class="pm-sub">' + esc(F.place(e)) + '</span>' +
      (live ? '<span class="hp-card-live">Live — see closing times ›</span>' : '<span class="pm-tag">' + ICON.soon + 'Coming soon · tap to request</span>') + '</a>';
  }
  function findNear() {
    closeDD(); q.blur();
    strip.hidden = false;
    stripIn.innerHTML = '<h2 class="hp-h2">Near you</h2>' + note('Finding your location…');
    F.locate().then(function (here) { return ready.then(function () { return here; }); }).then(function (here) {
      var n = F.nearest(here, 3);
      var items = n.top.map(function (x, i) { return card(x.e, x.d, i + 1); });
      if (n.nearestLive) items.push(card(n.nearestLive.e, n.nearestLive.d, '★', 'Nearest live'));
      stripIn.innerHTML = '<h2 class="hp-h2">Near you</h2><div class="hp-cards">' + items.join('') + '</div>';
      MAP.showNear(here, n);
    }).catch(function (err) {
      stripIn.innerHTML = '<h2 class="hp-h2">Near you</h2>' + (err && /^directory/.test(err.message || '')
        ? note('Couldn’t load the list of crossings. Check your connection and try again.', 'pm-warn')
        : note('Location is off — allow it in your browser settings, or search instead.', 'pm-warn'));
    });
  }

  // ---- events ---------------------------------------------------------------------------------
  q.addEventListener('focus', function () { F.quietLocation(); openDD(); });
  q.addEventListener('input', function () { clearBtn.hidden = !q.value; openDD(); filterLive(); });
  q.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); closeDD(); q.blur(); ready.then(function () { MAP.fitTo(hits().hits); }); }
    if (e.key === 'Escape') { closeDD(); q.blur(); }
  });
  clearBtn.addEventListener('click', function () { q.value = ''; clearBtn.hidden = true; filterLive(); q.focus(); openDD(); });
  nearBtn.addEventListener('click', findNear);
  document.addEventListener('click', function (e) {
    if (!e.target.closest('#hpSearch') && !dd.hidden) closeDD();
    if (e.target.closest('[data-near]')) { findNear(); return; }
    if (e.target.closest('[data-fit]')) { closeDD(); q.blur(); MAP.fitTo(hits().hits); return; }
    if (e.target.closest('[data-unsel]')) MAP.unselect();
  });
  // Arriving from the menu's "See more": the query filled in, the dropdown open, the map fitted.
  var arrived = new URLSearchParams(location.search).get('q');
  if (arrived) {
    q.value = arrived; clearBtn.hidden = false;
    openDD(); filterLive();
    ready.then(function () { MAP.fitTo(hits().hits); });
  }

  // ---- the map (ticket 08: /map's library, tiles and calm dark style; no train code) -------------
  var MAP = (function () {
    var map = null, pending = [], sel = null, overlays = [];
    var FINE = window.matchMedia && matchMedia('(pointer: fine)').matches;   // mouse: smaller marks
    var DOT = FINE ? { r: [4, 1.6, 7, 2, 9, 2.6, 12, 3.4], w: 0.75, tol: 5 } : { r: [4, 2.5, 7, 3, 9, 4, 12, 5], w: 1, tol: 14 };
    var GB = [[-6.3, 49.95], [1.8, 58.7]];
    function pad() { return { top: 120, bottom: 70, left: 30, right: 30 }; }
    function whenReady(fn) { if (map && map.loaded()) fn(); else pending.push(fn); }
    function fail() {
      mapStatus.textContent = 'The map couldn’t load. Search and the list of live crossings below still work.';
      mapStatus.classList.add('is-error'); mapStatus.hidden = false;
    }
    function loadLib() {
      if (window.maplibregl) return Promise.resolve();
      return new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = 'https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js';
        s.integrity = 'sha384-' + LIB_SRI; s.crossOrigin = 'anonymous';
        s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
      });
    }
    // The same 10 lines as map/layers.js applyStylePlan: map/style.js decides, this applies.
    function applyPlan(ops) {
      ops.forEach(function (o) {
        try {
          if (!map.getLayer(o.id)) return;
          if (o.op === 'visibility') map.setLayoutProperty(o.id, 'visibility', o.value);
          else if (o.op === 'paint') map.setPaintProperty(o.id, o.prop, o.value);
          else if (o.op === 'minzoom') map.setLayerZoomRange(o.id, o.min, 24);
          else if (o.op === 'filter') map.setFilter(o.id, o.value);
        } catch (e) { /* a layer this version of the style lacks */ }
      });
    }
    function build(list) {
      try {
        map = new maplibregl.Map({
          container: 'map', style: 'https://tiles.openfreemap.org/styles/dark', bounds: GB, fitBoundsOptions: { padding: pad() },
          minZoom: 4, maxZoom: 17, maxBounds: [[-32, 40], [26, 70]], attributionControl: false, dragRotate: false,
          pitchWithRotate: false, touchPitch: false, renderWorldCopies: false, cooperativeGestures: false
        });
      } catch (e) { fail(); return; }
      map.touchZoomRotate.disableRotation();
      map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
      var loaded = false;
      map.on('error', function () { if (!loaded) fail(); });
      // A map that stalls rather than errors (tiles unreachable, a browser that never finishes the
      // style) gets the same honest line instead of "Loading map…" for ever.
      setTimeout(function () { if (!loaded) fail(); }, 20000);
      map.on('load', function () {
        loaded = true; mapStatus.hidden = true;
        // Whole-GB view, fitted now the page has its final size (the constructor's fit can run
        // before the layout settles and cut the south coast off). A pending view (a search to fit,
        // Nearby, a known location) replaces it below.
        map.resize(); map.fitBounds(GB, { padding: pad(), animate: false });
        if (window.RM && RM.style) applyPlan(RM.style.planStyle(map.getStyle(), 'dark'));
        map.addSource('crossings', { type: 'geojson', data: {
          type: 'FeatureCollection',
          features: list.map(function (e) {
            return { type: 'Feature', geometry: { type: 'Point', coordinates: [e.lon, e.lat] },
              properties: { n: e.n, live: !!e.id, name: e.name } };
          })
        } });
        var r = ['interpolate', ['linear'], ['zoom']].concat(DOT.r);
        map.addLayer({ id: 'soon-dots', type: 'circle', source: 'crossings', filter: ['!', ['get', 'live']],
          paint: { 'circle-radius': r, 'circle-color': '#7B8BA3', 'circle-stroke-color': '#0F172A', 'circle-stroke-width': DOT.w } });
        map.addLayer({ id: 'sel-dot', type: 'circle', source: 'crossings', filter: ['==', ['get', 'n'], -1],
          paint: { 'circle-radius': FINE ? 5 : 7, 'circle-color': '#E2E8F0', 'circle-stroke-color': '#FFFFFF', 'circle-stroke-width': 2 } });
        map.addLayer({ id: 'live-halo', type: 'circle', source: 'crossings', filter: ['get', 'live'],
          paint: { 'circle-radius': FINE ? 8 : 12, 'circle-color': 'rgba(59,130,246,0.3)' } });
        map.addLayer({ id: 'live-pin', type: 'circle', source: 'crossings', filter: ['get', 'live'],
          paint: { 'circle-radius': FINE ? 4.5 : 6.5, 'circle-color': '#3B82F6', 'circle-stroke-color': '#FFFFFF', 'circle-stroke-width': FINE ? 1.5 : 2 } });
        // Live names only from about village scale (zoom 11), never over the whole-GB view.
        map.addLayer({ id: 'live-label', type: 'symbol', source: 'crossings', filter: ['get', 'live'], minzoom: 11,
          layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 13,
            'text-anchor': 'left', 'text-offset': [1, 0], 'text-allow-overlap': true },
          paint: { 'text-color': '#F8FAFC', 'text-halo-color': '#0F172A', 'text-halo-width': 1.6 } });
        map.on('click', onTap);
        if (FINE) map.on('mousemove', function (e) { map.getCanvas().style.cursor = pick(e.point) ? 'pointer' : ''; });
        var p = pending; pending = []; p.forEach(function (fn) { fn(); });
      });
    }
    // A wide tap area on phones: the nearest crossing within DOT.tol pixels, live ones first.
    function pick(pt) {
      var t = DOT.tol, fs = map.queryRenderedFeatures([[pt.x - t, pt.y - t], [pt.x + t, pt.y + t]], { layers: ['live-halo', 'live-pin', 'soon-dots'] });
      if (!fs.length) return null;
      var live = fs.filter(function (f) { return f.properties.live; });
      var pool = live.length ? live : fs, best = null, bd = Infinity;
      pool.forEach(function (f) {
        var s = map.project(f.geometry.coordinates), d = Math.hypot(s.x - pt.x, s.y - pt.y);
        if (d < bd) { bd = d; best = f; }
      });
      return best;
    }
    function onTap(e) {
      closeDD();
      var f = pick(e.point);
      if (!f) return;
      var c = F.byNumber(f.properties.n);
      if (!c) return;
      if (c.id) { location.href = F.href(c); return; }
      select(c);
    }
    function select(c) {
      sel = c;
      map.setFilter('sel-dot', ['==', ['get', 'n'], c.n]);
      placeCard.innerHTML = '<div class="hp-place-top"><div><span class="pm-tag">' + ICON.soon + 'Coming soon</span>' +
        '<b>' + esc(c.name) + '</b><span class="s">' + esc(F.place(c)) + ' · ' + esc(c.county) + '</span></div>' +
        '<button class="hp-x" type="button" data-unsel aria-label="Close">' + ICON.close + '</button></div>' +
        '<p>Not live yet. Ask for it: requests help decide which crossings go live first.</p>' +
        '<a class="hp-btn hp-btn-primary hp-btn-wide" href="' + esc(F.requestUrl(c)) + '" target="_blank" rel="noopener">Request this crossing</a>';
      placeCard.hidden = false;
      map.panTo([c.lon, c.lat]);
    }
    function unselect() {
      sel = null; placeCard.hidden = true;
      if (map && map.getLayer('sel-dot')) map.setFilter('sel-dot', ['==', ['get', 'n'], -1]);
    }
    function marker(lngLat, html) {
      var el = document.createElement('div'); el.innerHTML = html;
      var m = new maplibregl.Marker({ element: el.firstChild }).setLngLat(lngLat).addTo(map);
      overlays.push(m);
    }
    function clearOverlays() { overlays.forEach(function (m) { m.remove(); }); overlays = []; }
    function fitTo(hs) {
      if (!hs.length) return;
      whenReady(function () {
        var b = new maplibregl.LngLatBounds();
        hs.forEach(function (h) { b.extend([h.e.lon, h.e.lat]); });
        map.fitBounds(b, { padding: pad(), maxZoom: 13 });
      });
    }
    function showNear(here, n) {
      whenReady(function () {
        clearOverlays(); unselect();
        marker([here.lon, here.lat], '<div class="pin-you"></div>');
        var b = new maplibregl.LngLatBounds([here.lon, here.lat], [here.lon, here.lat]);
        n.top.forEach(function (x, i) { marker([x.e.lon, x.e.lat], '<div class="pin-num">' + (i + 1) + '</div>'); b.extend([x.e.lon, x.e.lat]); });
        if (n.nearestLive) marker([n.nearestLive.e.lon, n.nearestLive.e.lat], '<div class="pin-num">★</div>');
        map.fitBounds(b, { padding: { top: 140, bottom: 70, left: 50, right: 150 }, maxZoom: 14 });   // right: room for live names, drawn to the right of their pins
      });
    }
    // Start: the directory and the library in parallel; the map draws once both are here.
    Promise.all([ready, loadLib()]).then(function (res) { build(res[0]); }, fail);
    // Already allowed location (never prompts): start zoomed to the visitor.
    F.quietLocation().then(function (here) {
      if (here && !arrived) whenReady(function () { map.jumpTo({ center: [here.lon, here.lat], zoom: 11 }); });
    });
    return { fitTo: fitTo, showNear: showNear, unselect: unselect };
  })();

  // ---- Add as app (the homepage's own copy of the crossing page's logic in shared/crossing.js) ---
  var installPrompt = null;
  var isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  var isAndroid = /Android/.test(navigator.userAgent);
  function standalone() {
    try { return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true; }
    catch (e) { return false; }
  }
  var appBtns = document.querySelectorAll('.js-add-app');
  function showApp(on) { Array.prototype.forEach.call(appBtns, function (b) { b.classList.toggle('hidden', !on); }); }
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installPrompt = e; });
  window.addEventListener('appinstalled', function () { installPrompt = null; showApp(false); });
  showApp(!standalone());
  Array.prototype.forEach.call(appBtns, function (b) {
    b.addEventListener('click', function () {
      if (installPrompt) { var p = installPrompt; installPrompt = null; p.prompt(); return; }
      var t, body;
      if (isIOS) {
        t = 'Add to your home screen — iPhone';
        body = '<ol><li>Open this page in <strong>Safari</strong>.</li><li>Tap the <strong>Share</strong> button (on newer iPhones, tap <strong>···</strong> first, then Share).</li><li>Tap <strong>Add to Home Screen</strong> (you may need to tap <strong>More</strong> first).</li><li>Tap <strong>Add</strong>.</li></ol>';
      } else if (isAndroid) {
        t = 'Add to your home screen — Android';
        body = '<ol><li>Open this page in <strong>Chrome</strong>.</li><li>Tap the <strong>three-dot menu</strong> at the top right.</li><li>Tap <strong>Add to Home screen</strong> or <strong>Install app</strong>.</li><li>Tap <strong>Add</strong>.</li></ol>';
      } else {
        t = 'Add to your home screen';
        body = '<p>Open railcrossing.uk on your phone, then use your browser’s menu: <strong>Add to Home Screen</strong> (iPhone: Share → Add to Home Screen).</p>';
      }
      $('appModalTitle').textContent = t; $('appModalBody').innerHTML = body; $('appModal').hidden = false;
    });
  });
  $('appModalClose').addEventListener('click', function () { $('appModal').hidden = true; });
  $('appModal').addEventListener('click', function (e) { if (e.target === $('appModal')) $('appModal').hidden = true; });
})();
