// Sussex train map — proof of concept.
//
// Polls GET /map/live on the backend (backend-v2: src/train-map.js) and draws every train in
// the region where its TD berth places it. The backend does all the placing; this file only
// draws, animates between polls and explains what it is showing.
//
// Positions are BERTH positions: a train is drawn at the berth TD last stepped it into, so it
// moves signal section by signal section, not continuously. Between stations the berth is an
// estimate (interpolated along the straight line between them) and the label is dashed.
//
// ?demo        simulated trains, no backend needed (map/demo.js) — for previewing the UI
// ?api=URL     a local backend, for testing (localhost / 127.0.0.1 only)
// #1H15        select that train when it appears
(function () {
  'use strict';

  var API_BASE = 'https://api.railcrossing.uk';
  var POLL_MS = 5000;
  var ANIM_MS = 1600;
  var LABEL_MIN_ZOOM = 11;
  var TRAIL_POINTS = 12;
  var DEFAULT_BBOX = [50.72, -0.96, 51.17, 0.87];   // until the server sends its own

  var params = new URLSearchParams(location.search);
  var DEMO = params.has('demo');
  var apiParam = params.get('api');
  if (apiParam && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(apiParam)) API_BASE = apiParam;

  // ---- what a headcode says about a train ---------------------------------------------------
  // The first character of a headcode is its class. That is all TD tells us about a train, and
  // it is enough to colour the map; the timetable match adds the rest when there is one.
  var CLASSES = {
    express:  { label: 'Express passenger',  chip: 'Express',  color: '#60A5FA' },
    stopping: { label: 'Stopping passenger', chip: 'Stopping', color: '#34D399' },
    ecs:      { label: 'Empty stock',        chip: 'Empty',    color: '#94A3B8' },
    freight:  { label: 'Freight',            chip: 'Freight',  color: '#F59E0B' },
    special:  { label: 'Light engine / special', chip: 'Special', color: '#C084FC' },
    other:    { label: 'Unclassified',       chip: 'Other',    color: '#E2E8F0' }
  };
  var CLASS_ORDER = ['express', 'stopping', 'ecs', 'freight', 'special', 'other'];
  function classOf(hc) {
    if (!/^[0-9][A-Z][0-9]{2}$/.test(hc || '')) return 'other';
    var c = hc.charAt(0);
    if (c === '1' || c === '9') return 'express';   // 9 = Thameslink core, among others
    if (c === '2') return 'stopping';
    if (c === '5') return 'ecs';
    if ('4678'.indexOf(c) >= 0) return 'freight';
    return 'special';                                 // 0 light engine, 3 priority / test
  }
  var OPERATORS = {
    SN: 'Southern', TL: 'Thameslink', GX: 'Gatwick Express', SE: 'Southeastern',
    SW: 'South Western Railway', GW: 'Great Western Railway', XC: 'CrossCountry',
    LO: 'London Overground', ES: 'Eurostar', DB: 'DB Cargo', GB: 'GB Railfreight',
    FL: 'Freightliner', DR: 'Direct Rail Services', LD: 'Locomotive Services',
    ZZ: 'Network Rail / other', RT: 'Network Rail', NR: 'Network Rail', PT: 'Colas Rail'
  };

  function titleCase(s) {
    if (!s) return '';
    if (!/[A-Z]{3}/.test(s) || /[a-z]/.test(s)) return s;   // only fix SHOUTED names (CORPUS)
    return s.toLowerCase().replace(/(^|[\s\-(/&])([a-z])/g, function (m, p, c) { return p + c.toUpperCase(); });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function compass(deg) {
    if (deg == null) return '—';
    var pts = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return pts[Math.round(deg / 45) % 8] + ' (' + Math.round(deg) + '°)';
  }
  function ago(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + ' s ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' min ' + (s % 60) + ' s ago';
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min ago';
  }

  // Per-viewer conveniences only; the page works the same without storage.
  function load(k, d) { try { var v = localStorage.getItem('map.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem('map.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } }

  // ---- map ----------------------------------------------------------------------------------
  var $ = function (id) { return document.getElementById(id); };
  var prefs = {
    tracks: load('tracks', true), labels: load('labels', true), dark: load('dark', true),
    hidden: load('hidden', {})
  };

  var map = L.map('map', { zoomControl: false, attributionControl: true, worldCopyJump: false, minZoom: 7 });
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  map.attributionControl.setPrefix(false);
  map.fitBounds([[DEFAULT_BBOX[0], DEFAULT_BBOX[1]], [DEFAULT_BBOX[2], DEFAULT_BBOX[3]]]);

  var base = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, className: 'basemap',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  var tracks = L.tileLayer('https://{s}.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png', {
    maxZoom: 19, subdomains: 'abc', opacity: 0.7,
    attribution: '<a href="https://www.openrailwaymap.org/">OpenRailwayMap</a>'
  });
  map.attributionControl.addAttribution(
    'Train data: <a href="https://www.networkrail.co.uk/who-we-are/transparency-and-ethics/transparency/open-data-feeds/">Network Rail</a> (OGL)'
    + ' · stations: <a href="https://github.com/davwheat/uk-railway-stations">uk-railway-stations</a> (ODbL)');
  void base;

  var trailLayer = L.layerGroup().addTo(map);
  var trainLayer = L.layerGroup().addTo(map);
  var berthLayer = null;

  function applyPrefs() {
    document.body.classList.toggle('dark', !!prefs.dark);
    document.body.classList.toggle('light', !prefs.dark);
    document.body.classList.toggle('no-labels', !prefs.labels);
    if (prefs.tracks && !map.hasLayer(tracks)) tracks.addTo(map);
    if (!prefs.tracks && map.hasLayer(tracks)) map.removeLayer(tracks);
    $('optTracks').checked = !!prefs.tracks;
    $('optLabels').checked = !!prefs.labels;
    $('optDark').checked = !!prefs.dark;
  }
  applyPrefs();

  function onZoom() { $('map').classList.toggle('zoomed-out', map.getZoom() < LABEL_MIN_ZOOM); }
  map.on('zoomend', onZoom);
  onZoom();

  // ---- trains -------------------------------------------------------------------------------
  var trains = {};            // id → entry
  var selectedId = null;
  var wantedId = (location.hash || '').replace('#', '').toUpperCase() || null;
  var clockOffset = 0;        // serverTime − Date.now()
  var staleSecs = 600;
  var last = null;            // last payload
  var lastOkAt = 0;

  function iconHtml(t, cls) {
    var col = CLASSES[cls].color;
    var body = t.heading == null
      ? '<circle cx="13" cy="13" r="7" fill="' + col + '" stroke="#0F172A" stroke-width="2"/>'
      : '<g class="rot" transform="rotate(' + t.heading + ' 13 13)">'
        + '<path d="M13 2.5 L18.5 9 L18.5 22 Q18.5 23.5 17 23.5 L9 23.5 Q7.5 23.5 7.5 22 L7.5 9 Z" fill="' + col + '" stroke="#0F172A" stroke-width="1.6" stroke-linejoin="round"/>'
        + '<path d="M10 11 H16" stroke="#0F172A" stroke-width="1.4" stroke-linecap="round" opacity=".55"/></g>';
    return '<div class="tm"><svg viewBox="0 0 26 26" aria-hidden="true">' + body + '</svg></div>'
      + '<span class="lbl">' + esc(t.headcode) + '</span>';
  }

  function setMarkerState(el, e) {
    var age = (Date.now() + clockOffset - e.t.lastStepAt) / 1000;
    el.classList.add('train');
    el.classList.toggle('stale', age > staleSecs);
    el.classList.toggle('est', e.t.placement !== 'station');
    el.classList.toggle('sel', e.id === selectedId);
  }

  function makeEntry(t) {
    var cls = classOf(t.headcode);
    var e = { id: t.id, t: t, cls: cls, lat: t.lat, lon: t.lon, anim: null, trail: [[t.lat, t.lon]], iconKey: '' };
    e.marker = L.marker([t.lat, t.lon], {
      icon: L.divIcon({ className: '', html: '', iconSize: [26, 26], iconAnchor: [13, 13] }),
      keyboard: true, title: t.headcode, riseOnHover: true
    });
    e.marker.on('click', function () { select(e.id, false); });
    return e;
  }

  function refreshIcon(e) {
    var key = e.t.heading + '|' + e.cls + '|' + e.t.headcode;
    if (key !== e.iconKey) {
      e.marker.setIcon(L.divIcon({ className: '', html: iconHtml(e.t, e.cls), iconSize: [26, 26], iconAnchor: [13, 13] }));
      e.iconKey = key;
    }
    var el = e.marker.getElement();
    if (el) setMarkerState(el, e);
    if (e.id === selectedId) e.marker.setZIndexOffset(1000); else e.marker.setZIndexOffset(0);
  }

  function visible(e) { return !prefs.hidden[e.cls]; }

  function applyPayload(p) {
    last = p;
    lastOkAt = Date.now();
    clockOffset = (p.serverTime || Date.now()) - Date.now();
    staleSecs = p.staleSecs || staleSecs;
    var seen = {};
    var now = performance.now();
    (p.trains || []).forEach(function (t) {
      seen[t.id] = true;
      var e = trains[t.id];
      if (!e) { e = trains[t.id] = makeEntry(t); }
      var moved = t.lat !== e.t.lat || t.lon !== e.t.lon;
      e.t = t;
      e.cls = classOf(t.headcode);
      if (moved) {
        e.anim = { fromLat: e.lat, fromLon: e.lon, toLat: t.lat, toLon: t.lon, start: now, dur: ANIM_MS };
        var tr = e.trail[e.trail.length - 1];
        if (!tr || tr[0] !== t.lat || tr[1] !== t.lon) e.trail.push([t.lat, t.lon]);
        if (e.trail.length > TRAIL_POINTS) e.trail.shift();
      }
      var on = visible(e);
      if (on && !trainLayer.hasLayer(e.marker)) e.marker.addTo(trainLayer);
      if (!on && trainLayer.hasLayer(e.marker)) trainLayer.removeLayer(e.marker);
      refreshIcon(e);
    });
    Object.keys(trains).forEach(function (id) {
      if (seen[id]) return;
      trainLayer.removeLayer(trains[id].marker);
      delete trains[id];
      if (id === selectedId) { /* keep the sheet, say it has gone */ renderSheet(); }
    });
    if (wantedId && trains[wantedId]) { select(wantedId, true); wantedId = null; }
    renderChips();
    renderStatus();
    renderSheet();
    drawTrail();
    if (selectedId && trains[selectedId] && $('optFollow').checked) map.panTo([trains[selectedId].t.lat, trains[selectedId].t.lon], { animate: true });
  }

  function tick(now) {
    Object.keys(trains).forEach(function (id) {
      var e = trains[id];
      if (!e.anim) return;
      var k = Math.min(1, (now - e.anim.start) / e.anim.dur);
      var ease = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      e.lat = e.anim.fromLat + (e.anim.toLat - e.anim.fromLat) * ease;
      e.lon = e.anim.fromLon + (e.anim.toLon - e.anim.fromLon) * ease;
      e.marker.setLatLng([e.lat, e.lon]);
      if (k >= 1) e.anim = null;
    });
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // ---- selection + sheet --------------------------------------------------------------------
  var trailLine = null;
  function drawTrail() {
    trailLayer.clearLayers();
    var e = selectedId && trains[selectedId];
    if (!e || e.trail.length < 2) return;
    trailLine = L.polyline(e.trail, { color: CLASSES[e.cls].color, weight: 3, opacity: 0.7, dashArray: '4 6', className: 'trail', interactive: false });
    trailLine.addTo(trailLayer);
  }

  function select(id, fly) {
    selectedId = id;
    var e = trains[id];
    Object.keys(trains).forEach(function (k) { refreshIcon(trains[k]); });
    $('sheet').hidden = !id;
    if (id && history.replaceState) history.replaceState(null, '', location.pathname + location.search + '#' + id);
    if (!id && history.replaceState) history.replaceState(null, '', location.pathname + location.search);
    if (e && fly) map.flyTo([e.t.lat, e.t.lon], Math.max(map.getZoom(), 13), { duration: 0.8 });
    renderSheet();
    drawTrail();
  }

  function whereText(t) {
    if (t.placement === 'station') return 'At ' + esc(titleCase(t.station || ''));
    if (t.placement === 'interpolated' && t.between) return 'Between ' + esc(titleCase(t.between[0])) + ' and ' + esc(titleCase(t.between[1]));
    if (t.station) return 'Near ' + esc(titleCase(t.station)) + ' <span class="k">(approx.)</span>';
    return 'Position estimated';
  }

  function renderSheet() {
    if (!selectedId) return;
    var e = trains[selectedId];
    if (!e) {
      $('sheetClass').textContent = 'no longer reported — left the area or terminated';
      return;
    }
    var t = e.t, c = CLASSES[e.cls];
    $('sheetDot').style.background = c.color;
    $('sheetHc').textContent = t.headcode;
    $('sheetClass').textContent = c.label;
    var r = $('sheetRoute');
    if (t.service) {
      var op = OPERATORS[t.service.operator] || t.service.operator || '';
      r.className = 'sheet-route';
      r.innerHTML = esc(titleCase(t.service.origin)) + ' → ' + esc(titleCase(t.service.destination))
        + '<span class="op">' + esc(op) + (op ? ' · ' : '') + esc(t.service.departs) + ' – ' + esc(t.service.arrives) + '</span>';
    } else {
      r.className = 'sheet-route none';
      r.textContent = 'No timetable match for this headcode right now';
    }
    $('sheetWhere').innerHTML = whereText(t);
    $('sheetAge').textContent = ago(Date.now() + clockOffset - t.lastStepAt);
    $('sheetBerth').textContent = t.area + ' ' + t.berth + (t.placement === 'station' ? '' : ' (estimated)');
    $('sheetHeading').textContent = compass(t.heading);
  }
  setInterval(function () {
    renderSheet();
    renderStatus();
    Object.keys(trains).forEach(function (k) { refreshIcon(trains[k]); });
  }, 1000);

  $('sheetClose').addEventListener('click', function () { select(null); });
  map.on('click', function () { if (selectedId) select(null); });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && selectedId) select(null); });

  // ---- chips, status, search ----------------------------------------------------------------
  function renderChips() {
    var counts = {};
    Object.keys(trains).forEach(function (k) { var c = trains[k].cls; counts[c] = (counts[c] || 0) + 1; });
    var html = CLASS_ORDER.filter(function (c) { return counts[c] || c !== 'other'; }).map(function (c) {
      var on = !prefs.hidden[c];
      return '<button class="chip" type="button" data-cls="' + c + '" aria-pressed="' + on + '">'
        + '<span class="sw" style="background:' + CLASSES[c].color + '"></span>' + CLASSES[c].chip
        + ' <span class="n">' + (counts[c] || 0) + '</span></button>';
    }).join('');
    if ($('chips').innerHTML !== html) $('chips').innerHTML = html;
  }
  $('chips').addEventListener('click', function (ev) {
    var b = ev.target.closest('.chip');
    if (!b) return;
    var c = b.getAttribute('data-cls');
    prefs.hidden[c] = !prefs.hidden[c];
    save('hidden', prefs.hidden);
    Object.keys(trains).forEach(function (k) {
      var e = trains[k];
      if (visible(e)) { if (!trainLayer.hasLayer(e.marker)) { e.marker.addTo(trainLayer); refreshIcon(e); } }
      else trainLayer.removeLayer(e.marker);
    });
    renderChips();
  });

  var statusMsg = null;   // set when something is wrong
  function renderStatus() {
    var el = $('status');
    if (statusMsg) { el.innerHTML = '<span class="warn">' + esc(statusMsg) + '</span>'; return; }
    if (!last) { el.textContent = 'Connecting…'; return; }
    var n = (last.trains || []).length;
    var secs = Math.round((Date.now() - lastOkAt) / 1000);
    var feedWarn = last.feed && last.feed.stale
      ? ' · <span class="warn">berth feed silent ' + Math.round((last.feed.staleSecs || 0) / 60) + ' min</span>' : '';
    el.innerHTML = '<span class="live"></span>' + (DEMO ? 'Demo · ' : '') + n + ' train' + (n === 1 ? '' : 's')
      + ' · updated ' + secs + ' s ago' + feedWarn;
  }

  $('search').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var q = $('searchInput').value.trim().toUpperCase();
    if (!q) return;
    var ids = Object.keys(trains);
    var hit = ids.filter(function (id) { return trains[id].t.headcode === q; })[0]
      || ids.filter(function (id) { return trains[id].t.headcode.indexOf(q) === 0; })[0];
    if (hit) {
      if (prefs.hidden[trains[hit].cls]) { prefs.hidden[trains[hit].cls] = false; save('hidden', prefs.hidden); applyPayload(last); }
      select(hit, true);
      $('searchInput').blur();
    } else {
      var f = $('search');
      f.classList.add('miss');
      setTimeout(function () { f.classList.remove('miss'); }, 900);
    }
  });

  // ---- options ------------------------------------------------------------------------------
  $('btnLayers').addEventListener('click', function () {
    var open = $('layers').hidden;
    $('layers').hidden = !open;
    this.setAttribute('aria-expanded', String(open));
  });
  $('btnLocate').addEventListener('click', function () {
    var b = (last && last.region && last.region.bbox) || DEFAULT_BBOX;
    map.flyToBounds([[b[0], b[1]], [b[2], b[3]]], { duration: 0.8 });
  });
  $('optTracks').addEventListener('change', function () { prefs.tracks = this.checked; save('tracks', prefs.tracks); applyPrefs(); });
  $('optLabels').addEventListener('change', function () { prefs.labels = this.checked; save('labels', prefs.labels); applyPrefs(); });
  $('optDark').addEventListener('change', function () { prefs.dark = this.checked; save('dark', prefs.dark); applyPrefs(); });
  $('optBerths').addEventListener('change', function () { toggleBerths(this.checked); });

  // Coverage view: every berth the backend can place, coloured by how. This is the honest
  // picture of what the map knows — and what it is still learning.
  function toggleBerths(on) {
    if (!on) { if (berthLayer) map.removeLayer(berthLayer); return; }
    if (DEMO) { statusMsg = 'Berth coverage needs the live backend'; renderStatus(); setTimeout(function () { statusMsg = null; renderStatus(); }, 3000); $('optBerths').checked = false; return; }
    if (berthLayer) { berthLayer.addTo(map); return; }
    fetchJson(API_BASE + '/map/berths').then(function (d) {
      var col = { station: '#F8FAFC', interpolated: '#22D3EE', approx: '#FB923C' };
      berthLayer = L.layerGroup();
      (d.berths || []).forEach(function (b) {
        if (b.lat == null) return;
        L.circleMarker([b.lat, b.lon], { radius: 3, weight: 1, color: '#0F172A', fillColor: col[b.placement] || '#999', fillOpacity: 0.9, className: 'berth-dot' })
          .bindTooltip(esc(b.area + ' ' + b.berth) + ' · ' + esc(b.placement) + (b.station ? ' · ' + esc(titleCase(b.station)) : ''))
          .addTo(berthLayer);
      });
      if ($('optBerths').checked) berthLayer.addTo(map);
    }).catch(function () { $('optBerths').checked = false; });
  }

  // ---- polling ------------------------------------------------------------------------------
  function fetchJson(url) {
    var ctl = window.AbortController ? new AbortController() : null;
    var to = setTimeout(function () { if (ctl) ctl.abort(); }, 8000);
    return fetch(url, { cache: 'no-store', signal: ctl ? ctl.signal : undefined }).then(function (r) {
      clearTimeout(to);
      if (!r.ok) { var err = new Error('HTTP ' + r.status); err.status = r.status; throw err; }
      return r.json();
    }, function (err) { clearTimeout(to); throw err; });
  }

  var pollTimer = null;
  var fails = 0;
  function poll() {
    clearTimeout(pollTimer);
    if (document.hidden) return;          // resumes on visibilitychange
    var p = DEMO ? Promise.resolve(window.MAP_DEMO.snapshot(Date.now())) : fetchJson(API_BASE + '/map/live');
    p.then(function (d) {
      fails = 0;
      statusMsg = null;
      applyPayload(d);
    }).catch(function (err) {
      fails++;
      statusMsg = err && err.status === 404
        ? 'Map service not on the server yet — add ?demo to preview'
        : 'Can’t reach the server — retrying';
      renderStatus();
    }).then(function () {
      pollTimer = setTimeout(poll, fails ? Math.min(30000, POLL_MS * Math.pow(2, fails - 1)) : POLL_MS);
    });
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });

  function start() {
    if (DEMO) $('demoBanner').hidden = false;
    renderChips();
    poll();
  }

  if (DEMO) {
    // Same cache token as this file, so a deploy can't pair a new map.js with an old demo.js.
    var me = document.currentScript && document.currentScript.src;
    var tok = me && me.indexOf('?') >= 0 ? me.slice(me.indexOf('?')) : '';
    var s = document.createElement('script');
    s.src = 'demo.js' + tok;
    s.onload = start;
    s.onerror = function () { statusMsg = 'Demo failed to load'; renderStatus(); };
    document.head.appendChild(s);
  } else {
    start();
  }
})();
