// The page: wires the map, the data, the panel, search, filters, themes and deep links together.
// Anything testable without a browser lives in the pure modules (geo, classes, motion, api, ...).
(function () {
  'use strict';

  var RM = window.RM, geo = RM.geo, classes = RM.classes, motion = RM.motion, ST = RM.stations;
  var L = RM.layers, DC = RM.declutter, h = RM.dom.h, clear = RM.dom.clear;

  var DEFAULT_API = 'https://api.railcrossing.uk';
  var API_BASE = geo.resolveApiBase(location.search, DEFAULT_API);
  // Light base: OpenFreeMap "positron" (see style.js for the flattening applied on top). ?light=liberty
  // is kept as a review switch so the two can be compared on the same view.
  var LIGHT_BASE = new URLSearchParams(location.search).get('light') === 'liberty' ? 'liberty' : 'positron';
  var STYLE = { light: 'https://tiles.openfreemap.org/styles/' + LIGHT_BASE, dark: 'https://tiles.openfreemap.org/styles/dark' };
  var LABEL_MIN_ZOOM = 11;
  var MAX_LABELS = 300;
  var FOLLOW_ZOOM = 12.5;
  // Trains follow the real track (motion plans + spans) from this zoom; below it a train moves less than a
  // pixel in a minute and the phase-1 glide is exact enough. ?trackzoom=N is a test switch.
  var TRACK_MIN_ZOOM = Number(new URLSearchParams(location.search).get('trackzoom'));
  if (!isFinite(TRACK_MIN_ZOOM) || new URLSearchParams(location.search).get('trackzoom') == null) TRACK_MIN_ZOOM = 8;
  var FAN_MIN_ZOOM = 11;
  // One clock for everything the store sees: epoch milliseconds, with sub-millisecond precision.
  function pnow() { return performance.timeOrigin + performance.now(); }

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

  map.on('style.load', function () {
    placeIds = null;
    L.addNetworkLayers(map, theme, new URLSearchParams(location.search).get('debugtrack') === '1');
    L.addRailLayers(map, theme);
    L.applyStylePlan(map, RM.style.planStyle(map.getStyle(), theme));
  });
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
  var api = RM.api.createApi({ base: API_BASE });
  var spans = RM.spans.createSpanCache({ fetchSpan: function (id) { return api.getSpan(id); } });
  var clock = RM.engine.createClock({ lagMs: Number(new URLSearchParams(location.search).get('lag')) || 12000 });
  var store = motion.createStore({ reducedMotion: reduced, spans: spans, clock: clock });
  store.setHalo(L.THEME[theme].halo);
  var stations = [], stationByCrs = {};
  var sel = { type: null, id: null, crs: null, detail: null, path: null, timer: null, follow: false };
  var lastPlaced = null, lastBuf = null, frameN = 0, rafId = 0, lastFrameTs = 0, loopUntil = 0;
  var viewBox = geo.GB_BBOX.slice();
  var stCache = { zb: -1, box: null, dots: [], names: [], theme: null };
  var pendingStation = null;
  var debug = RM.debug = { keepAnimating: false, intervals: [], js: [], fill: [], maxSamples: 600 };

  // ---- panel ----------------------------------------------------------------------------------------
  var panel = RM.panel.createPanel($('panel'), {
    onClose: function () { clearSelection(); },
    onPickTrain: function (id) { selectTrain(id, { fly: true }); },
    onFollow: function (on) { setFollow(on); },
    onShare: function () { shareLink(); }
  });

  // ---- scheduling the draw ----------------------------------------------------------------------
  var waitTimer = 0;
  function request() {
    if (waitTimer) { clearTimeout(waitTimer); waitTimer = 0; }
    if (!rafId) rafId = requestAnimationFrame(frame);
  }

  function stationData(zoom) {
    var zb = Math.floor(zoom * 4);
    if (stCache.zb === zb && stCache.theme === theme && stCache.box && geo.bboxContains(stCache.box, viewBox)) return stCache;
    var box = geo.padBbox(viewBox, 0.6);
    var dots = [], names = [];
    for (var i = 0; i < stations.length; i++) {
      var s = stations[i];
      if (!geo.inBbox(box, s.lat, s.lon)) continue;
      if (s.dotMin <= zoom) dots.push(s);
      if (s.nameMin <= zoom && !basemapHasLabel(s)) { names.push(s); s.lo = [9, 0]; s.la = 'start'; s.lb = 'center'; }
    }
    // Below the label zoom: keep the most important names that do not overlap one another (screen
    // positions as of now; a pan only translates them, a zoom change re-runs this). From the label
    // zoom up, placeLabels() redoes it every frame so names also keep clear of trains.
    var kept = names;
    if (zoom < LABEL_MIN_ZOOM) {
      kept = DC.place(names.map(function (s) {
        var p = map.project(s.pos), size = nameSize(s);
        return { x: p.x + 9, y: p.y - size / 2 - 1, w: DC.textWidth(s.name, size), h: size + 2, prio: (4 - s.tier) * 100 - s.name.length * 0.01, ref: s };
      }), 3);
    }
    stCache = { zb: zb, box: box, dots: dots, names: kept, theme: theme };
    return stCache;
  }
  // The base map labels towns itself; where it already prints this station's name beside the dot,
  // ours would be the same word twice ("Chichester Chichester"), so we leave ours out and keep the dot.
  var placeIds = null;
  function placeLayerIds() {
    if (placeIds) return placeIds;
    var st = map.getStyle();
    placeIds = ((st && st.layers) || []).filter(function (l) { return l['source-layer'] === 'place' && l.type === 'symbol'; })
      .map(function (l) { return l.id; });
    return placeIds;
  }
  function basemapHasLabel(s) {
    var ids = placeLayerIds();
    if (!ids.length) return false;
    var p = map.project(s.pos), feats;
    try { feats = map.queryRenderedFeatures([[p.x - 60, p.y - 24], [p.x + 130, p.y + 24]], { layers: ids }); } catch (e) { return false; }
    var n = ST.norm(s.name);
    for (var i = 0; i < feats.length; i++) {
      var pn = ST.norm(feats[i].properties.name || '');
      if (pn && (pn === n || (pn.length >= 4 && (n.indexOf(pn) === 0 || pn.indexOf(n) === 0)))) return true;
    }
    return false;
  }
  function nameSize(s) { return s.tier === 1 ? 14 : s.tier === 2 ? 12.5 : 11.5; }
  // Where and which way a train is DRAWN (the fan-out may have moved it sideways and squared it up): labels
  // and the declutter boxes must follow the drawn body, not the real position, or a label lands on a neighbour.
  function bearingOf(r) { return r.ph === r.ph ? r.ph : r.ch === r.ch ? r.ch : r.lh === r.lh ? r.lh : r.hf === r.hf ? r.hf : 0; }

  // A train with no heading at all is turned to run along the railway line underneath it, read back
  // from the map's own rail layer (a few per frame; the answer is kept until the train moves).
  function railBearingAt(lon, lat) {
    var p = map.project([lon, lat]);
    var feats;
    try { feats = map.queryRenderedFeatures([[p.x - 14, p.y - 14], [p.x + 14, p.y + 14]], { layers: ['rm-rail'] }); } catch (e) { return NaN; }
    var cosLat = Math.cos(lat * Math.PI / 180), best = Infinity, brg = NaN;
    for (var i = 0; i < feats.length; i++) {
      var g = feats[i].geometry;
      var lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
      for (var k = 0; k < lines.length; k++) {
        var ln = lines[k];
        for (var j = 1; j < ln.length; j++) {
          var ax = (ln[j - 1][0] - lon) * cosLat, ay = ln[j - 1][1] - lat, bx = (ln[j][0] - lon) * cosLat, by = ln[j][1] - lat;
          var dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
          var t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
          var px = ax + t * dx, py = ay + t * dy, d = px * px + py * py;
          if (d < best) { best = d; brg = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 180; }
        }
      }
    }
    return brg;
  }
  function updateRailHeadings(buf, zoom) {
    if (zoom < 9) return;
    var budget = 6;
    for (var i = 0; i < buf.n && budget > 0; i++) {
      var r = buf.order[i];
      if (r.ch === r.ch || r.lh === r.lh) continue;
      if (Math.abs(r.cx - r.hfX) < 2e-5 && Math.abs(r.cy - r.hfY) < 2e-5) continue;
      budget--;
      r.hfX = r.cx; r.hfY = r.cy;
      r.hf = railBearingAt(r.cx, r.cy);
    }
  }

  // Label placement from the label zoom up. In one pass, in priority order: the selected train's
  // code, then station names, then the other trains' codes. Each tries a few positions (beside the
  // train, either side, then off its ends; to the right/above/below/left of a station dot) and takes
  // the first that is clear of every train body, every station dot and every label already placed.
  // Returns the station names and the train records that found a place, with their offsets set.
  function placeLabels(buf, zoom, sd, selTrainId) {
    var vb = geo.padBbox(viewBox, 0.05);
    var lat = (viewBox[0] + viewBox[2]) / 2;
    var lenPx = motion.trainLenPx(zoom, lat), mix = motion.metreMix(zoom);
    var widPx = Math.max(7, lenPx * (mix >= 0.5 ? 0.1 : 0.375));
    var fixed = [], items = [], trainRecs = [];
    var dotScale = zoom < 7 ? 0.8 : zoom < 11 ? 1 : 1.35;
    var i, r, p;
    // train bodies as a row of small boxes along their axis
    var side = Math.max(widPx, 8), steps = Math.max(1, Math.round(lenPx / side));
    var inView = [];
    for (i = 0; i < buf.n && inView.length < MAX_LABELS * 2; i++) {
      r = buf.order[i];
      if (r.py < vb[0] || r.py > vb[2] || r.px < vb[1] || r.px > vb[3]) continue;
      p = map.project([r.px, r.py]);
      var hd = bearingOf(r) * Math.PI / 180, tx = Math.sin(hd), ty = -Math.cos(hd);
      inView.push({ r: r, x: p.x, y: p.y, tx: tx, ty: ty });
      for (var k = 0; k < steps; k++) {
        var o = (k + 0.5) / steps * lenPx - lenPx / 2;
        fixed.push({ x: p.x + tx * o - side / 2, y: p.y + ty * o - side / 2, w: side, h: side });
      }
    }
    for (i = 0; i < sd.dots.length; i++) {
      var s0 = sd.dots[i];
      if (s0.lat < vb[0] || s0.lat > vb[2] || s0.lon < vb[1] || s0.lon > vb[3]) continue;
      p = map.project(s0.pos);
      var rad = s0.r * dotScale + 1;
      fixed.push({ x: p.x - rad, y: p.y - rad, w: rad * 2, h: rad * 2 });
    }
    // station names
    for (i = 0; i < sd.names.length; i++) {
      var s = sd.names[i];
      if (s.lat < vb[0] || s.lat > vb[2] || s.lon < vb[1] || s.lon > vb[3]) continue;
      p = map.project(s.pos);
      var size = nameSize(s), w = DC.textWidth(s.name, size), hh = size + 2, off = Math.ceil(s.r * dotScale) + 5;
      items.push({ w: w, h: hh, prio: (4 - s.tier) * 100 - s.name.length * 0.01, ref: s, kind: 'st',
        alts: [
          { x: p.x + off, y: p.y - hh / 2, lo: [off, 0], la: 'start', lb: 'center' },
          { x: p.x - w / 2, y: p.y - off - hh, lo: [0, -off - hh / 2], la: 'middle', lb: 'center' },
          { x: p.x - w / 2, y: p.y + off, lo: [0, off + hh / 2], la: 'middle', lb: 'center' },
          { x: p.x - off - w, y: p.y - hh / 2, lo: [-off, 0], la: 'end', lb: 'center' },
          // further out, clear of a train standing at the station (they sit on the station point)
          { x: p.x - w / 2, y: p.y - off - 10 - hh, lo: [0, -off - 10 - hh / 2], la: 'middle', lb: 'center' },
          { x: p.x - w / 2, y: p.y + off + 10, lo: [0, off + 10 + hh / 2], la: 'middle', lb: 'center' },
          { x: p.x - w / 2, y: p.y - off - 0.25 * lenPx - 8 - hh, lo: [0, -off - 0.25 * lenPx - 8 - hh / 2], la: 'middle', lb: 'center' },
          { x: p.x - w / 2, y: p.y + off + 0.25 * lenPx + 8, lo: [0, off + 0.25 * lenPx + 8 + hh / 2], la: 'middle', lb: 'center' }
        ] });
    }
    // train codes
    var lsz = 12.5, lh = lsz + 3;
    for (i = 0; i < inView.length; i++) {
      var v = inView[i], rr = v.r;
      var text = rr.pl === 's' ? rr.hc : rr.hc + ' ~', lw = DC.textWidth(text, lsz);
      var nx = -v.ty, ny = v.tx;                           // unit normal to the train's axis
      if (ny < 0 || (Math.abs(ny) < 1e-6 && nx < 0)) { nx = -nx; ny = -ny; }   // prefer the side below / to the right
      var dSide = widPx / 2 + 6 + 0.21 * side + Math.abs(nx) * lw / 2 + Math.abs(ny) * lh / 2;
      var dEnd = lenPx / 2 + 5 + Math.abs(v.tx) * lw / 2 + Math.abs(v.ty) * lh / 2;
      var cand = [[nx * dSide, ny * dSide], [-nx * dSide, -ny * dSide], [v.tx * dEnd, v.ty * dEnd], [-v.tx * dEnd, -v.ty * dEnd]];
      items.push({ w: lw, h: lh, prio: rr.id === selTrainId ? 1000 : 10 - rr.clsIdx, ref: rr, kind: 'tr',
        alts: cand.map(function (c) { return { x: v.x + c[0] - lw / 2, y: v.y + c[1] - lh / 2, lo: [c[0], c[1]] }; }) });
    }
    var res = DC.placeAlt(items, fixed, 2);
    var names = [];
    var byRef = new Map();
    for (i = 0; i < items.length; i++) byRef.set(items[i].ref, items[i]);
    for (i = 0; i < res.length && trainRecs.length < MAX_LABELS; i++) {
      var it = byRef.get(res[i].ref), alt = it.alts[res[i].alt];
      if (it.kind === 'st') { it.ref.lo = alt.lo; it.ref.la = alt.la; it.ref.lb = alt.lb; names.push(it.ref); }
      else { it.ref.lo = alt.lo; if (!it.ref.pos) it.ref.pos = [0, 0]; it.ref.pos[0] = it.ref.px; it.ref.pos[1] = it.ref.py; trainRecs.push(it.ref); }
    }
    return { names: names, trains: trainRecs };
  }

  function frame() {
    rafId = 0;
    var t0 = performance.now();
    var zoom = map.getZoom();
    var selTrainId = sel.type === 'train' ? sel.id : null;
    store.setView(zoom >= TRACK_MIN_ZOOM, geo.padBbox(viewBox, 0.25));
    store.setFan(zoom >= FAN_MIN_ZOOM);
    var buf = store.fill(pnow(), hidden, selTrainId);
    debug.fill.push(performance.now() - t0); if (debug.fill.length > debug.maxSamples) debug.fill.shift();
    updateRailHeadings(buf, zoom);
    lastBuf = buf;
    frameN++;
    var layers = [];
    var lat = (viewBox[0] + viewBox[2]) / 2;
    var labelled = zoom >= LABEL_MIN_ZOOM;

    var sd = stations.length ? stationData(zoom) : null;
    var placed = labelled && sd ? placeLabels(buf, zoom, sd, selTrainId) : null;
    lastPlaced = placed;
    if (sd) layers = layers.concat(L.stationLayers({ dots: sd.dots, names: placed ? placed.names : sd.names, zoom: zoom, theme: theme, frame: frameN }));

    var rec = selTrainId ? store.get(selTrainId) : null;
    if (rec) {
      var path = trailPath(rec);
      if (path) layers = layers.concat(L.trailLayers({ path: path, colour: classes.CLASSES[rec.cls].colour, theme: theme, frame: frameN }));
    }
    if (rec) {                                         // highlight under the selected train: same silhouette, same heading
      if (!rec.pos) rec.pos = [0, 0];
      rec.pos[0] = rec.px; rec.pos[1] = rec.py;
      var known = rec.ph === rec.ph || rec.ch === rec.ch || rec.lh === rec.lh;
      var shd = rec.ph === rec.ph ? rec.ph : rec.ch === rec.ch ? rec.ch : rec.lh === rec.lh ? rec.lh : rec.hf === rec.hf ? rec.hf : 0;
      rec.sa = -shd; rec.si = known ? 'sel' : 'selnodir';
      layers = layers.concat(L.selectedTrain({ rec: rec, zoom: zoom, theme: theme, atlas: atlas, frame: frameN }));
    }
    if (buf.n > 0 || buf.na > 0) layers = layers.concat(L.trainLayers({ buf: buf, zoom: zoom, lat: lat, theme: theme, atlas: atlas }));

    if (placed && placed.trains.length) {
      layers.push(L.labelLayer({ recs: placed.trains, theme: theme, frame: frameN, version: store.version }));
    }

    if (rec) {
      if (sel.follow) followTo(rec);
    } else if (sel.type === 'station' && stationByCrs[sel.crs]) {
      layers.push(L.selectedRing({ pos: stationByCrs[sel.crs].pos, radius: 11, theme: theme }));
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

    if (store.isAnimating(pnow()) || (sel.follow && rec) || debug.keepAnimating) {
      // A train moves a pixel or two a second when zoomed out: no need to redraw at 60 fps for that.
      var pxPerSec = 30 / motion.metresPerPixel(zoom, lat), gap = debug.keepAnimating || (sel.follow && rec) ? 0 : pxPerSec < 4 ? 250 : pxPerSec < 15 ? 66 : 0;
      if (gap) waitTimer = setTimeout(function () { waitTimer = 0; request(); }, gap); else request();
    } else lastFrameTs = 0;
  }

  // The selected train's trail: the track it actually travelled, not chords between berth positions.
  // Older berths (from the details response) first, then the ones this page has watched it cross, then
  // the current span up to where the train is drawn. Falls back to the service's own trail points only
  // when no span geometry is available at all.
  var trailCache = { key: '', pts: [] };
  function pushPts(out, pts) {
    for (var i = 0; i < pts.length; i++) {
      var l = out[out.length - 1];
      if (!l || Math.abs(l[0] - pts[i][0]) > 1e-7 || Math.abs(l[1] - pts[i][1]) > 1e-7) out.push(pts[i]);
    }
  }
  function trailPath(rec) {
    var es = rec.es, E = RM.engine;
    if (rec.mode === 'track' && es && es.init && rec.plans && rec.plans[es.k] && rec.plans[es.k].span) {
      var older = (sel.older || []).filter(function (o) { return spans.peek(o.sp); });
      var key = rec.id + '|' + rec.hist.length + '|' + older.length + '|' + rec.plans[0].sp;
      if (trailCache.key !== key) {
        var pts = [];
        older.forEach(function (o) { var sp = spans.peek(o.sp); pushPts(pts, E.sliceSpan(sp, 0, sp.length, [])); });
        rec.hist.forEach(function (p) { if (p.span) pushPts(pts, E.sliceSpan(p.span, 0, p.span.length, [])); });
        trailCache = { key: key, pts: pts };
      }
      var out = trailCache.pts.slice();
      for (var i = 0; i < es.k; i++) if (rec.plans[i].span) pushPts(out, E.sliceSpan(rec.plans[i].span, 0, rec.plans[i].span.length, []));
      pushPts(out, E.sliceSpan(rec.plans[es.k].span, 0, es.s, []));
      out.push([rec.cx, rec.cy]);
      if (out.length > 1) return out;
    }
    if (!sel.path) return null;
    var last = sel.path[sel.path.length - 1];
    last[0] = rec.cx; last[1] = rec.cy;
    return sel.path;
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
  // Base-map labels settle after the tiles do; then re-check which station names it already prints.
  var settle = false;
  map.on('moveend', function () { settle = true; });
  map.on('idle', function () { if (settle) { settle = false; stCache.zb = -1; request(); } });

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
    if (L.TRAIN_PICK_IDS.indexOf(id) >= 0 && info.index >= 0 && lastBuf) {
      var r = lastBuf.order[info.index];
      if (r) { selectTrain(r.id, { fly: false }); return true; }
    }
    if (id === 'station-dots' && info.object) { selectStation(info.object.crs, { fly: false }); return true; }
    if (sel.type) clearSelection();
    return false;
  }
  function onDeckHover(info) {
    var id = info && info.layer && info.layer.id;
    var over = (L.TRAIN_PICK_IDS.indexOf(id) >= 0 && info.index >= 0) || (id === 'station-dots' && info.object);
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
      var rec0 = store.get(id);
      d.waiting = !!(rec0 && rec0.wait);
      // berths older than anything this page has watched: their spans make the trail follow the track
      var have = {};
      if (rec0 && rec0.plans) { rec0.plans.forEach(function (p) { have[p.sp] = 1; }); rec0.hist.forEach(function (p) { have[p.sp] = 1; }); }
      var cut = Date.now() + api.state.skewMs - 15 * 60000;
      sel.older = (d.recentBerths || []).filter(function (b) { return b.sp && !have[b.sp] && b.at >= cut; }).reverse();
      sel.older.forEach(function (b) { spans.need(b.sp, true); });
      sel.path = (d.trail || []).map(function (p) { return [p[1], p[0]]; });
      sel.path.push([d.train.lon, d.train.lat]);
      store.add(d.train, pnow());
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
      store.applyUpdate(null, [sel.id], pnow());
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
    panel.showStation(s, nearbyTrains(s), null);
    if (o.fly) flyToPoint(s.lon, s.lat, Math.max(map.getZoom(), 13.2));
    loadBoard(s);
    sel.timer = setInterval(function () { if (sel.type === 'station') loadBoard(s); }, 8000);
    request();
  }
  function loadBoard(s) {
    var crs = s.crs;
    api.getStation(crs).then(function (b) {
      if (sel.type !== 'station' || sel.crs !== crs) return;
      sel.board = b;
      panel.showStation(s, nearbyTrains(s), b, !b);
    }, function () {
      if (sel.type !== 'station' || sel.crs !== crs) return;
      panel.showStation(s, nearbyTrains(s), sel.board || null, !sel.board);
    });
  }
  // The national line layer. Two detail levels; the first is small and shows the whole country at once.
  function loadNetwork(level, attempt) {
    api.getNetwork(level).then(function (g) {
      if (g && g.type === 'FeatureCollection') { L.setNetworkData(map, level, g); request(); }
    }, function () { if (attempt < 3) setTimeout(function () { loadNetwork(level, attempt + 1); }, 6000 * (attempt + 1)); });
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
    if (typeof d.serverTime === 'number') clock.observe(d.serverTime, pnow());
    store.applySnapshot(d.trains || [], pnow(), keepId());
    onData();
  });
  api.on('update', function (d) {
    if (typeof d.serverTime === 'number') clock.observe(d.serverTime, pnow());
    var rem = d.remove || [];
    if (sel.type === 'train' && rem.indexOf(sel.id) >= 0) rem = rem.filter(function (x) { return x !== sel.id; });
    store.applyUpdate(d.upsert, rem, pnow());
    onData();
  });
  api.on('status', function () { renderStatus(); });
  var countsDirty = true, lastChipRender = 0;
  function onData() { countsDirty = true; request(); }

  function loadStations(attempt) {
    api.getStations().then(function (d) {
      stations = ST.cleanStations(d.stations).map(function (s) {
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
    if (sel.type === 'train' && sel.detail) {         // the live pieces of the panel follow the stream between detail refreshes
      var r = store.get(sel.id);
      if (r) {
        if (r.svc && sel.detail.train) sel.detail.train.svc = r.svc;
        sel.detail.waiting = !!r.wait;
        panel.showTrain(sel.detail);
      }
    }
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
      store.setHalo(L.THEME[theme].halo);
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
  loadNetwork('lo', 0); loadNetwork('hi', 0);
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
      fillMs: { p50: pct(debug.fill, 0.5), p95: pct(debug.fill, 0.95), max: pct(debug.fill, 1) },
      trains: store.size, zoom: map.getZoom()
    };
  };
  debug.labels = function () { return lastPlaced; };
  debug.reset = function () { debug.intervals.length = 0; debug.js.length = 0; debug.fill.length = 0; };
})();
