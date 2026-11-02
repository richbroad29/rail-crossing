// The page: wires the map, the data, the panel, search, filters, themes and deep links together.
// Anything testable without a browser lives in the pure modules (geo, classes, motion, api, ...).
(function () {
  'use strict';

  var RM = window.RM, geo = RM.geo, classes = RM.classes, motion = RM.motion, ST = RM.stations;
  var L = RM.layers, DC = RM.declutter, h = RM.dom.h, clear = RM.dom.clear;

  var DEFAULT_API = 'https://api.railcrossing.uk';
  var API_BASE = geo.resolveApiBase(location.search, DEFAULT_API);
  var STYLE = { light: 'https://tiles.openfreemap.org/styles/liberty', dark: 'https://tiles.openfreemap.org/styles/dark' };
  var LABEL_MIN_ZOOM = 11;
  var MAX_LABELS = 300;
  var FOLLOW_ZOOM = 12.5;

  function $(id) { return document.getElementById(id); }
  function load(k, d) { try { var v = localStorage.getItem('map.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem('map.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } }

  // ---- preferences ----------------------------------------------------------------------------------
  var mqDark = window.matchMedia('(prefers-color-scheme: dark)');
  var mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  function reduced() { return mqReduce.matches; }
  var themePref = load('theme', 'auto');
  if (['auto', 'light', 'dark'].indexOf(themePref) < 0) themePref = 'auto';
  function resolvedTheme() { return themePref === 'auto' ? (mqDark.matches ? 'dark' : 'light') : themePref; }
  var theme = resolvedTheme();
  document.documentElement.setAttribute('data-theme', theme);
  var hidden = load('hidden', {});
  if (!hidden || typeof hidden !== 'object') hidden = {};

  var isWide = window.matchMedia('(min-width: 820px)');

  // ---- map ------------------------------------------------------------------------------------------
  var map = new maplibregl.Map({
    container: 'map', style: STYLE[theme], center: [-2.6, 54.2], zoom: 5, minZoom: 4, maxZoom: 18.5,
    maxBounds: [[-32, 40], [26, 70]], attributionControl: false, dragRotate: false, pitchWithRotate: false,
    touchPitch: false, fadeDuration: 0, renderWorldCopies: false
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.AttributionControl({
    compact: !window.matchMedia('(min-width: 820px)').matches,
    customAttribution: [
      'Train data: <a href="https://www.networkrail.co.uk/who-we-are/transparency-and-ethics/transparency/open-data-feeds/" target="_blank" rel="noopener">Network Rail</a> (OGL)',
      'Stations: <a href="https://naptan.dft.gov.uk/" target="_blank" rel="noopener">NaPTAN</a> (OGL), <a href="https://github.com/davwheat/uk-railway-stations" target="_blank" rel="noopener">uk-railway-stations</a> (ODbL)'
    ]
  }), 'bottom-left');
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.addControl(new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: false }, trackUserLocation: false, fitBoundsOptions: { maxZoom: 13 }
  }), 'bottom-right');

  // Start with the credits folded away on phones (the "i" button opens them); they stay one tap away.
  map.once('load', function () {
    var el = document.querySelector('.maplibregl-ctrl-attrib');
    if (el && el.classList.contains('maplibregl-compact')) { el.classList.remove('maplibregl-compact-show'); el.removeAttribute('open'); }
  });

  function fitGB() {
    // On a phone the header spans the screen; on a desktop it floats at the left, so the map can use the full height.
    var top = isWide.matches ? 16 : $('top').offsetHeight + 12;
    map.fitBounds([[-6.4, 49.9], [1.9, 58.8]], { padding: { top: top, bottom: 24, left: 8, right: 8 }, animate: false });
  }
  fitGB();

  map.on('style.load', function () { L.addRailLayers(map, theme); });
  // The OpenFreeMap tile server is the one thing the page cannot do without; say so plainly.
  map.on('error', function (e) {
    if (e && e.error && /Failed to fetch|NetworkError|Load failed/i.test(String(e.error.message || e.error))) tileTrouble();
  });
  var tileWarned = false;
  function tileTrouble() {
    if (tileWarned) return; tileWarned = true;
    toast('The map background is slow to load. Trains will still show.');
  }

  // ---- deck.gl ------------------------------------------------------------------------------------
  var atlas = L.makeAtlas();
  var overlay = new deck.MapboxOverlay({
    interleaved: false, layers: [], pickingRadius: 12,
    onClick: onDeckClick, onHover: onDeckHover
  });
  map.addControl(overlay);

  // ---- state ----------------------------------------------------------------------------------------
  var store = motion.createStore({ reducedMotion: reduced });
  var api = RM.api.createApi({ base: API_BASE });
  var stations = [], stationByCrs = {};
  var sel = { type: null, id: null, crs: null, detail: null, path: null, timer: null, follow: false };
  var lastBuf = null, frameN = 0, rafId = 0, lastFrameTs = 0, loopUntil = 0;
  var viewBox = geo.GB_BBOX.slice();
  var stCache = { zb: -1, box: null, dots: [], names: [], theme: null };
  var pendingStation = null;
  var ringPos = [0, 0];
  var debug = RM.debug = { keepAnimating: false, intervals: [], js: [], maxSamples: 600 };

  // ---- panel ----------------------------------------------------------------------------------------
  var panel = RM.panel.createPanel($('panel'), {
    onClose: function () { clearSelection(); },
    onFollow: function (on) { setFollow(on); },
    onShare: function () { shareLink(); }
  });

  // ---- scheduling the draw ----------------------------------------------------------------------
  function request() { if (!rafId) rafId = requestAnimationFrame(frame); }

  function stationData(zoom) {
    var zb = Math.floor(zoom * 4);
    if (stCache.zb === zb && stCache.theme === theme && stCache.box && geo.bboxContains(stCache.box, viewBox)) return stCache;
    var box = geo.padBbox(viewBox, 0.6);
    var dots = [], names = [];
    for (var i = 0; i < stations.length; i++) {
      var s = stations[i];
      if (!geo.inBbox(box, s.lat, s.lon)) continue;
      if (s.dotMin <= zoom) dots.push(s);
      if (s.nameMin <= zoom) names.push(s);
    }
    // Keep the most important names that do not overlap one another (screen positions as of now;
    // a pan only translates them, a zoom change re-runs this).
    var boxes = names.map(function (s) {
      var p = map.project(s.pos), size = s.tier === 1 ? 14 : s.tier === 2 ? 12.5 : 11.5;
      return { x: p.x + 9, y: p.y - size / 2 - 1, w: DC.textWidth(s.name, size), h: size + 2, prio: (4 - s.tier) * 100 - s.name.length * 0.01, ref: s };
    });
    stCache = { zb: zb, box: box, dots: dots, names: DC.place(boxes, 3), theme: theme };
    return stCache;
  }

  var labelRecs = [];
  function frame() {
    rafId = 0;
    var t0 = performance.now();
    var zoom = map.getZoom();
    var selTrainId = sel.type === 'train' ? sel.id : null;
    var buf = store.fill(t0, hidden, selTrainId);
    lastBuf = buf;
    frameN++;
    var sizePx = motion.trainSizePx(zoom);
    var layers = [];

    if (stations.length) {
      var sd = stationData(zoom);
      layers = layers.concat(L.stationLayers({ dots: sd.dots, names: sd.names, zoom: zoom, theme: theme }));
    }

    var rec = selTrainId ? store.get(selTrainId) : null;
    if (rec && sel.path) {
      var last = sel.path[sel.path.length - 1];
      last[0] = rec.cx; last[1] = rec.cy;
      layers = layers.concat(L.trailLayers({ path: sel.path, colour: classes.CLASSES[rec.cls].colour, theme: theme, frame: frameN }));
    }
    if (buf.n > 0 || buf.na > 0) layers = layers.concat(L.trainLayers({ buf: buf, sizePx: sizePx, theme: theme, atlas: atlas }));

    if (zoom >= LABEL_MIN_ZOOM) {
      var bx = geo.padBbox(viewBox, 0.1), boxes = [], lsz = 12.5, yOff = sizePx * 0.62 + 4;
      for (var i = 0; i < buf.n && boxes.length < MAX_LABELS * 2; i++) {
        var r = buf.order[i];
        if (r.cy < bx[0] || r.cy > bx[2] || r.cx < bx[1] || r.cx > bx[3]) continue;
        var p = map.project([r.cx, r.cy]);
        var text = r.pl === 's' ? r.hc : r.hc + ' ~';
        var w = DC.textWidth(text, lsz);
        boxes.push({ x: p.x - w / 2, y: p.y + yOff, w: w, h: lsz + 3, prio: r.id === selTrainId ? 1000 : 10 - r.clsIdx, ref: r });
      }
      labelRecs = DC.place(boxes, 2).slice(0, MAX_LABELS);
      for (var j = 0; j < labelRecs.length; j++) {
        var lr = labelRecs[j];
        if (!lr.pos) lr.pos = [0, 0];
        lr.pos[0] = lr.cx; lr.pos[1] = lr.cy;
      }
      if (labelRecs.length) {
        layers.push(L.labelLayer({ recs: labelRecs, theme: theme, sizePx: sizePx, frame: frameN, version: store.version }));
      }
    }

    if (rec) {
      ringPos[0] = rec.cx; ringPos[1] = rec.cy;
      layers.push(L.selectedRing({ pos: ringPos, sizePx: sizePx, theme: theme, frame: frameN }));
      if (sel.follow) followTo(rec);
    } else if (sel.type === 'station' && stationByCrs[sel.crs]) {
      var st = stationByCrs[sel.crs];
      layers.push(L.selectedRing({ pos: st.pos, sizePx: 6, theme: theme, frame: 0 }));
    }

    overlay.setProps({ layers: layers });

    var t1 = performance.now();
    if (lastFrameTs) {
      debug.intervals.push(t0 - lastFrameTs);
      if (debug.intervals.length > debug.maxSamples) debug.intervals.shift();
    }
    debug.js.push(t1 - t0);
    if (debug.js.length > debug.maxSamples) debug.js.shift();
    lastFrameTs = t0;

    if (store.isAnimating(t1) || (sel.follow && rec) || debug.keepAnimating) request();
    else lastFrameTs = 0;
  }

  function followTo(rec) {
    if (map.isZooming()) return;                  // do not fight a pinch or wheel zoom in progress
    var off = viewOffset();
    map.easeTo({ center: [rec.cx, rec.cy], duration: 0, offset: off, essential: true });
  }
  // Where the "visual centre" is: not under the panel.
  function viewOffset() {
    if (!panel.isOpen) return [0, 0];
    if (isWide.matches) return [-190, 0];
    return [0, -Math.round(window.innerHeight * 0.16)];
  }
  function flyToPoint(lon, lat, zoom) {
    var o = { center: [lon, lat], zoom: zoom, offset: viewOffset(), essential: false };
    if (reduced()) { o.duration = 0; map.easeTo(o); } else { o.speed = 1.5; o.curve = 1.3; map.flyTo(o); }
  }

  map.on('move', function () {
    viewBox = geo.clampBbox(geo.boundsToBbox(map.getBounds()));
    api.setBbox(viewBox);
    request();
  });
  map.on('moveend', function () { viewBox = geo.clampBbox(geo.boundsToBbox(map.getBounds())); api.setBbox(viewBox); request(); });
  map.on('dragstart', function () { if (sel.follow) setFollow(false); });
  map.on('style.load', request);

  // ---- picking ------------------------------------------------------------------------------------
  // The end of a drag must not count as a click on the map (it would close the panel).
  var down = null, dragged = false;
  var mapEl = map.getContainer();
  mapEl.addEventListener('pointerdown', function (e) { down = [e.clientX, e.clientY]; dragged = false; }, true);
  mapEl.addEventListener('pointermove', function (e) {
    if (down && Math.abs(e.clientX - down[0]) + Math.abs(e.clientY - down[1]) > 8) {
      dragged = true;
      if (sel.follow) setFollow(false);       // grabbing the map ends follow mode at once
    }
  }, true);
  function onDeckClick(info) {
    if (dragged) { dragged = false; return false; }
    var id = info && info.layer && info.layer.id;
    if (id === 'trains' && info.index >= 0 && lastBuf) {
      var r = lastBuf.order[info.index];
      if (r) { selectTrain(r.id, { fly: false }); return true; }
    }
    if (id === 'station-dots' && info.object) { selectStation(info.object.crs, { fly: false }); return true; }
    if (sel.type) clearSelection();
    return false;
  }
  function onDeckHover(info) {
    var id = info && info.layer && info.layer.id;
    var over = (id === 'trains' && info.index >= 0) || (id === 'station-dots' && info.object);
    map.getCanvas().style.cursor = over ? 'pointer' : '';
  }

  // ---- selection ----------------------------------------------------------------------------------
  function stopDetailTimer() { if (sel.timer) { clearInterval(sel.timer); sel.timer = null; } }
  function setHash(s) {
    var hash = geo.buildHash(s);
    try { history.replaceState(null, '', location.pathname + location.search + hash); } catch (e) { /* ignore */ }
  }
  function setFollow(on) {
    sel.follow = !!on && sel.type === 'train';
    panel.setFollow(sel.follow);
    if (sel.follow) {
      var rec = store.get(sel.id);
      if (rec && map.getZoom() < FOLLOW_ZOOM - 1) map.setZoom(FOLLOW_ZOOM);
    }
    request();
  }
  function clearSelection(o) {
    stopDetailTimer();
    sel = { type: null, id: null, crs: null, detail: null, path: null, timer: null, follow: false };
    panel.setFollow(false);
    panel.hide();
    if (!(o && o.keepHash)) setHash(null);
    request();
  }

  function selectTrain(id, o) {
    o = o || {};
    stopDetailTimer();
    sel = { type: 'train', id: id, crs: null, detail: null, path: null, timer: null, follow: false };
    panel.setFollow(false);
    var rec = store.get(id);
    panel.showLoading(rec ? rec.hc : 'Train');
    setHash({ t: id });
    if (rec && o.fly) flyToPoint(rec.cx, rec.cy, Math.max(map.getZoom(), 11.5));
    else if (rec && !o.fly) nudgeIntoView(rec);
    loadDetail(true, !rec);
    sel.timer = setInterval(function () { loadDetail(false, false); }, 5000);
    request();
  }
  // Tapping a train at the very bottom of the screen on a phone: the sheet would cover it.
  function nudgeIntoView(rec) {
    var p = map.project([rec.cx, rec.cy]);
    var hgt = map.getContainer().clientHeight;
    var covered = isWide.matches ? p.x > map.getContainer().clientWidth - 400 : p.y > hgt * 0.55;
    if (covered) flyToPoint(rec.cx, rec.cy, map.getZoom());
  }

  function loadDetail(first, needFly) {
    var id = sel.id;
    api.getTrain(id).then(function (d) {
      if (sel.type !== 'train' || sel.id !== id) return;
      if (!d) { trainGone(first); return; }
      sel.detail = d;
      sel.path = (d.trail || []).map(function (p) { return [p[1], p[0]]; });
      sel.path.push([d.train.lon, d.train.lat]);
      store.add(d.train, performance.now());
      panel.showTrain(d);
      if (needFly) flyToPoint(d.train.lon, d.train.lat, 12.5);
      request();
    }, function () {
      if (sel.type !== 'train' || sel.id !== id) return;
      if (first) panel.showMessage('Could not load details', 'The train service did not answer. Close this and tap the train again in a moment.');
    });
  }
  function trainGone(first) {
    stopDetailTimer();
    if (first) {
      panel.showMessage('Train not found', 'We cannot see that train. It may have finished its journey, or the link may be old.');
      sel.path = null;
    } else {
      panel.showMessage('This train has gone', 'We cannot see it any more. It may have finished its journey or left the area we cover.');
      sel.follow = false; panel.setFollow(false);
      store.applyUpdate(null, [sel.id], performance.now());
      sel.path = null;
    }
    request();
  }

  function selectStation(crs, o) {
    o = o || {};
    var s = stationByCrs[crs];
    if (!s) { if (!stations.length) pendingStation = { crs: crs, fly: o.fly }; return; }
    stopDetailTimer();
    sel = { type: 'station', id: null, crs: crs, detail: null, path: null, timer: null, follow: false };
    panel.setFollow(false);
    setHash({ s: crs });
    panel.showStation(s, nearbyTrains(s));
    if (o.fly) flyToPoint(s.lon, s.lat, Math.max(map.getZoom(), 13.2));
    sel.timer = setInterval(function () {
      if (sel.type === 'station') panel.showStation(s, nearbyTrains(s));
    }, 5000);
    request();
  }
  function nearbyTrains(s) {
    var n = 0;
    store.forEach(function (r) { if (geo.haversineKm(s.lat, s.lon, r.lat, r.lon) <= 5) n++; });
    return n;
  }

  // ---- share ---------------------------------------------------------------------------------------
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2800);
  }
  function shareLink() {
    var hash = geo.buildHash(sel.type === 'train' ? { t: sel.id } : { s: sel.crs });
    var url = location.origin + location.pathname + hash;
    var title = sel.type === 'train' && sel.detail ? 'Train ' + sel.detail.train.hc + ' on the live train map'
      : sel.type === 'station' && stationByCrs[sel.crs] ? stationByCrs[sel.crs].name + ' on the live train map' : 'Live train map';
    var note = sel.type === 'train' ? 'Link copied. It works while the train is running.' : 'Link copied.';
    // The share sheet is right on phones; on a desktop a copied link is what people expect.
    if (navigator.share && window.matchMedia('(pointer: coarse)').matches) {
      navigator.share({ title: title, url: url }).catch(function () { /* cancelled */ });
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { toast(note); }, function () { toast(url); });
    } else toast(url);
  }

  // ---- data -----------------------------------------------------------------------------------------
  function keepId() { return sel.type === 'train' ? sel.id : null; }
  api.on('snapshot', function (d) {
    store.applySnapshot(d.trains || [], performance.now(), keepId());
    onData();
  });
  api.on('update', function (d) {
    var rem = d.remove || [];
    if (sel.type === 'train' && rem.indexOf(sel.id) >= 0) rem = rem.filter(function (x) { return x !== sel.id; });
    store.applyUpdate(d.upsert, rem, performance.now());
    onData();
  });
  api.on('status', function () { renderStatus(); });
  var countsDirty = true, lastChipRender = 0;
  function onData() { countsDirty = true; request(); }

  function loadStations(attempt) {
    api.getStations().then(function (d) {
      stations = (d.stations || []).map(function (s) {
        var t = ST.tierOf(s);
        s.pos = [s.lon, s.lat]; s.tier = t; s.r = t === 1 ? 5.5 : t === 2 ? 4.2 : 3.4;
        s.dotMin = ST.dotMinZoom(s); s.nameMin = ST.nameMinZoom(s); s.prio = t === 1 ? -10 : t === 2 ? -20 : -30;
        stationByCrs[s.crs] = s;
        return s;
      });
      stCache.zb = -1;
      if (pendingStation) { var p = pendingStation; pendingStation = null; selectStation(p.crs, { fly: p.fly }); }
      request();
    }, function () { if (attempt < 4) setTimeout(function () { loadStations(attempt + 1); }, 4000 * (attempt + 1)); });
  }

  // ---- chips ----------------------------------------------------------------------------------------
  var chipEls = {};
  (function buildChips() {
    var box = $('chips');
    classes.ORDER.forEach(function (k) {
      var info = classes.CLASSES[k];
      var count = h('span', { class: 'count' }, '0');
      var btn = h('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(!hidden[k]), 'data-cls': k, title: info.meaning,
        onclick: function () {
          hidden[k] = !hidden[k];
          if (!hidden[k]) delete hidden[k];
          save('hidden', hidden);
          btn.setAttribute('aria-pressed', String(!hidden[k]));
          renderChips();
          request();
        }
      }, h('span', { class: 'swatch', style: 'background:' + info.colour, 'aria-hidden': 'true' }), h('span', { class: 'lbl' }, info.chip), count);
      chipEls[k] = { btn: btn, count: count };
      box.appendChild(btn);
    });
  })();
  function renderChips() {
    var c = store.counts();
    classes.ORDER.forEach(function (k) {
      var e = chipEls[k];
      e.count.textContent = geo.fmtCount(c[k]);
      e.btn.setAttribute('aria-label', classes.CLASSES[k].label + ', ' + c[k] + (c[k] === 1 ? ' train' : ' trains') +
        (hidden[k] ? ', hidden' : ', shown'));
      e.btn.hidden = k === 'other' && c[k] === 0;
    });
  }

  // ---- status line and banner -----------------------------------------------------------------------
  function renderStatus() {
    var s = api.state, now = Date.now();
    var dot = $('statusDot'), txt = $('status'), banner = $('banner');
    var age = s.lastMessageAt ? now - s.lastMessageAt : null;
    var n = store.size;
    var cls = 'dot', text;
    if (!s.reachable) {
      cls += ' bad'; text = 'Offline' + (age != null ? ' · last update ' + geo.fmtAgeShort(age) + ' ago' : '');
    } else if (s.lastDataAt == null) {
      cls += ' wait'; text = 'Connecting to the train service';
    } else {
      var how = s.feedStale ? 'Data delayed' : s.transport === 'sse' ? 'Live' : 'Refreshing every 5 s';
      var stale = s.feedStale || (age != null && age > 45000);
      cls += stale ? ' warn' : s.transport === 'sse' ? ' ok' : ' wait';
      text = geo.fmtCount(n) + (n === 1 ? ' train' : ' trains') + ' · ' + how + ' · updated ' +
        (age < 5000 ? 'just now' : geo.fmtAgeShort(age) + ' ago');
    }
    dot.className = cls;
    if (txt.textContent !== text) txt.textContent = text;

    var msg = null, kind = '';
    if (!s.reachable) {
      kind = 'bad';
      msg = 'We cannot reach the train service. ' + (n ? 'The map shows the last positions we received' +
        (age != null ? ' (' + geo.fmtAgeShort(age) + ' ago)' : '') + '. ' : '') + 'We keep trying automatically.';
    } else if (s.feedStale) {
      kind = 'warn';
      msg = 'Network Rail’s live data is running late right now, so train positions may be out of date.';
    } else if (s.lastDataAt != null && age > 45000) {
      kind = 'warn';
      msg = 'We have not heard from the train service for ' + geo.fmtAgeShort(age) + '. Positions may be out of date.';
    }
    if (msg) {
      banner.style.top = Math.round($('top').getBoundingClientRect().bottom + 6) + 'px';
      if (banner.textContent !== msg) banner.textContent = msg;
      banner.className = 'banner ' + kind; banner.hidden = false;
    } else banner.hidden = true;
    document.body.classList.toggle('has-banner', !!msg);
  }

  setInterval(function () {
    renderStatus();
    if (countsDirty && performance.now() - lastChipRender > 500) { renderChips(); countsDirty = false; lastChipRender = performance.now(); }
    panel.tick(Date.now() + api.state.skewMs);
  }, 1000);

  // ---- search ---------------------------------------------------------------------------------------
  var search = RM.search.createSearch({
    input: $('q'), list: $('results'),
    getTrains: function () { var a = []; store.forEach(function (r) { a.push(r); }); return a; },
    getStations: function () { return stations; },
    remote: function (q, signal) { return api.search(q, signal); },
    onPickTrain: function (it) { selectTrain(it.id, { fly: true }); },
    onPickStation: function (it) { if (stationByCrs[it.crs]) selectStation(it.crs, { fly: true }); else flyToPoint(it.lon, it.lat, 13.2); }
  });
  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) || '';
    if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); search.focus(); }
    else if (e.key === 'Escape' && sel.type && tag !== 'INPUT') clearSelection();
  });

  // ---- theme ----------------------------------------------------------------------------------------
  var THEME_LABEL = { auto: 'Automatic (follows your device)', light: 'Light', dark: 'Dark' };
  var SUN = 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6L4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 8a4 4 0 100 8 4 4 0 000-8z';
  var MOON = 'M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z';
  var AUTO = 'M12 3a9 9 0 100 18V3z';
  function renderThemeButton() {
    var b = $('btnTheme');
    clear(b);
    b.appendChild(RM.dom.svgIcon(themePref === 'light' ? SUN : themePref === 'dark' ? MOON : AUTO, themePref === 'auto' ? { fill: true } : null));
    var next = themePref === 'auto' ? 'light' : themePref === 'light' ? 'dark' : 'auto';
    b.setAttribute('aria-label', 'Colour theme: ' + THEME_LABEL[themePref] + '. Switch to ' + THEME_LABEL[next].toLowerCase());
    b.title = 'Theme: ' + THEME_LABEL[themePref];
  }
  function applyTheme() {
    var next = resolvedTheme();
    document.documentElement.setAttribute('data-theme', next);
    if (next !== theme) {
      theme = next;
      map.setStyle(STYLE[theme]);
      stCache.zb = -1;
    }
    renderThemeButton();
    request();
  }
  $('btnTheme').addEventListener('click', function () {
    themePref = themePref === 'auto' ? 'light' : themePref === 'light' ? 'dark' : 'auto';
    save('theme', themePref);
    applyTheme();
    toast('Theme: ' + THEME_LABEL[themePref]);
  });
  (mqDark.addEventListener ? mqDark.addEventListener.bind(mqDark, 'change') : mqDark.addListener.bind(mqDark))(function () {
    if (themePref === 'auto') applyTheme();
  });
  renderThemeButton();

  // ---- help dialog ----------------------------------------------------------------------------------
  (function buildKey() {
    var ul = $('aboutKey');
    classes.ORDER.slice(0, 5).forEach(function (k) {
      var info = classes.CLASSES[k];
      ul.appendChild(h('li', null, h('span', { class: 'swatch big', style: 'background:' + info.colour, 'aria-hidden': 'true' }),
        h('span', null, h('strong', null, info.label), ': ', info.meaning)));
    });
  })();
  $('btnHelp').addEventListener('click', function () { var d = $('about'); if (d.showModal) d.showModal(); else d.setAttribute('open', ''); });

  // ---- deep links -----------------------------------------------------------------------------------
  function applyHash() {
    var p = geo.parseHash(location.hash);
    if (p.t) { if (!(sel.type === 'train' && sel.id === p.t)) selectTrain(p.t, { fly: true }); }
    else if (p.s) { if (!(sel.type === 'station' && sel.crs === p.s)) selectStation(p.s, { fly: true }); }
    else if (sel.type) clearSelection({ keepHash: true });
  }
  window.addEventListener('hashchange', applyHash);

  // ---- tab visibility: do not hold a stream open for a hidden tab ------------------------------------
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) api.pause(); else { api.resume(); request(); }
  });
  isWide.addEventListener && isWide.addEventListener('change', request);
  window.addEventListener('resize', request);

  // ---- go -------------------------------------------------------------------------------------------
  viewBox = geo.clampBbox(geo.boundsToBbox(map.getBounds()));
  api.start(viewBox);
  loadStations(0);
  applyHash();
  renderStatus();
  request();

  // A hook for tests and for anyone looking at the page in devtools.
  debug.store = store; debug.map = map; debug.api = api; debug.select = selectTrain; debug.overlay = overlay;
  debug.summary = function () {
    function pct(a, p) { var s = a.slice().sort(function (x, y) { return x - y; }); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null; }
    return {
      frames: debug.intervals.length,
      intervalMs: { p50: pct(debug.intervals, 0.5), p95: pct(debug.intervals, 0.95), max: pct(debug.intervals, 1) },
      jsMs: { p50: pct(debug.js, 0.5), p95: pct(debug.js, 0.95), max: pct(debug.js, 1) },
      trains: store.size, zoom: map.getZoom()
    };
  };
  debug.reset = function () { debug.intervals.length = 0; debug.js.length = 0; };
})();
