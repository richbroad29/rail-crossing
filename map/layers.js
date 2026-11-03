// Everything that is drawn on the map: the train icon atlas, the railway lines added to the base
// style, and the deck.gl layers (stations, trains, labels, trail). No page state lives here; app.js
// passes in what to draw and gets layer objects back.
//
// Trains come in two SETS of icons, one atlas:
//   "px"  chunky shapes sized in screen pixels. They work from the national view down to a region,
//         where a real train would be far too small to see.
//   "m"   long, slim shapes sized in METRES (about 80 m, a 4-car unit; drawn 8 m wide so it reads),
//         used from zoom 15 where the street map has a real scale. The two sets cross-fade over one
//         zoom level (motion.metreMix).
// PHASE 3 (real carriage drawings) means replacing the drawing functions in SHAPES below, and nothing
// else: the sets, the sizing, the picking and the fade all go through trainLayers().
(function (root) {
  'use strict';

  var RM = root.RM;

  // ---- colours by theme ---------------------------------------------------------------------------
  var THEME = {
    light: {
      halo: [15, 23, 42, 235], text: [17, 24, 39, 255], textOutline: [255, 255, 255, 235],
      stFill: [255, 255, 255, 255], stLine: [71, 85, 105, 255], stText: [51, 65, 85, 255],
      rail: '#3d4657', railCase: '#ffffff', railTie: '#ffffff', ring: [219, 39, 119, 255]
    },
    dark: {
      halo: [255, 255, 255, 235], text: [241, 245, 249, 255], textOutline: [10, 16, 28, 240],
      stFill: [30, 41, 59, 255], stLine: [203, 213, 225, 255], stText: [203, 213, 225, 255],
      rail: '#c3ccda', railCase: '#0a101c', railTie: '#0a101c', ring: [244, 114, 182, 255]
    }
  };
  var FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

  // ---- train icon atlas ---------------------------------------------------------------------------
  // White-on-transparent, pointing north, tinted per train by the GPU (mask: true): one atlas serves
  // every class colour and both themes.  Per set, eight icons:
  //   dir / nodir     solid body with a cab nose, or a symmetric pill when the heading is unknown
  //   est / estnodir  dashed outline, translucent fill: "this position is an estimate"
  //   halo*           a fatter silhouette drawn underneath in a contrasting colour (est ones are soft)
  //   sel / selnodir  a much fatter silhouette in the highlight colour, drawn under the selected train
  var SHAPES = {
    px: {
      cw: 48, ch: 128, y0: 0, halo: 9, sel: 20, dash: [9, 6], line: 5,
      // body silhouette, cab nose at the top
      dir: function (c, ox, oy) {
        c.beginPath();
        c.moveTo(ox + 9, oy + 46);
        c.quadraticCurveTo(ox + 9, oy + 14, ox + 24, oy + 9);
        c.quadraticCurveTo(ox + 39, oy + 14, ox + 39, oy + 46);
        c.lineTo(ox + 39, oy + 113);
        c.arcTo(ox + 39, oy + 118, ox + 34, oy + 118, 5);
        c.lineTo(ox + 14, oy + 118);
        c.arcTo(ox + 9, oy + 118, ox + 9, oy + 113, 5);
        c.closePath();
      },
      pill: function (c, ox, oy) { c.beginPath(); c.roundRect(ox + 9, oy + 10, 30, 108, 13); },
      // see-through details cut out of the solid body
      details: function (c, ox, oy, nose) {
        c.fillStyle = '#000';
        c.fillRect(ox + 5, oy + 66, 38, 3.5); c.fillRect(ox + 5, oy + 94, 38, 3.5);     // gaps between carriages
        if (nose) {
          c.fillStyle = 'rgba(0,0,0,0.6)';                                               // windscreen
          c.beginPath(); c.moveTo(ox + 13, oy + 38); c.lineTo(ox + 17, oy + 26);
          c.quadraticCurveTo(ox + 24, oy + 22, ox + 31, oy + 26); c.lineTo(ox + 35, oy + 38); c.closePath(); c.fill();
        }
      }
    },
    m: {
      cw: 32, ch: 320, y0: 384, halo: 7, sel: 13, dash: [6, 4], line: 3.2,
      dir: function (c, ox, oy) {
        c.beginPath();
        c.moveTo(ox + 8, oy + 66);
        c.quadraticCurveTo(ox + 8, oy + 20, ox + 16, oy + 12);
        c.quadraticCurveTo(ox + 24, oy + 20, ox + 24, oy + 66);
        c.lineTo(ox + 24, oy + 305);
        c.arcTo(ox + 24, oy + 308, ox + 21, oy + 308, 3);
        c.lineTo(ox + 11, oy + 308);
        c.arcTo(ox + 8, oy + 308, ox + 8, oy + 305, 3);
        c.closePath();
      },
      pill: function (c, ox, oy) { c.beginPath(); c.roundRect(ox + 8, oy + 12, 16, 296, 8); },
      details: function (c, ox, oy, nose) {
        c.fillStyle = '#000';
        for (var k = 1; k <= 3; k++) c.fillRect(ox + 4, oy + 64 + 61 * k - 1.5, 24, 3);   // 4 cars
        c.fillStyle = 'rgba(0,0,0,0.5)';
        for (var car = 0; car < 4; car++) c.fillRect(ox + 10, oy + 64 + 61 * car + 12, 12, 26);   // window bands
        if (nose) {
          c.beginPath(); c.moveTo(ox + 10, oy + 46); c.lineTo(ox + 12, oy + 28);
          c.quadraticCurveTo(ox + 16, oy + 23, ox + 20, oy + 28); c.lineTo(ox + 22, oy + 46); c.closePath(); c.fill();
        }
      }
    }
  };
  var NAMES = ['dir', 'nodir', 'est', 'estnodir', 'halo', 'halonodir', 'haloest', 'haloestnodir', 'sel', 'selnodir'];
  function cellOf(setKey, idx) {
    var S = SHAPES[setKey];
    return [(idx % 4) * S.cw, S.y0 + Math.floor(idx / 4) * S.ch];
  }
  function makeAtlas() {
    var cv = document.createElement('canvas');
    cv.width = 192; cv.height = 384 + 3 * 320;       // px set: 4 x 3 cells of 48x128; m set below it: 4 x 3 cells of 32x320
    var c = cv.getContext('2d');
    var mapping = {};
    Object.keys(SHAPES).forEach(function (setKey) {
      var S = SHAPES[setKey];
      NAMES.forEach(function (name, idx) {
        var o = cellOf(setKey, idx);
        var nodir = /nodir$/.test(name);
        var pathFn = nodir ? S.pill : S.dir;
        c.save();
        // clip to the cell so a fat stroke never bleeds into the neighbour
        c.beginPath(); c.rect(o[0], o[1], S.cw, S.ch); c.clip();
        if (name === 'dir' || name === 'nodir') {
          c.globalCompositeOperation = 'source-over'; c.fillStyle = '#fff';
          pathFn(c, o[0], o[1]); c.fill();
          c.globalCompositeOperation = 'destination-out';
          S.details(c, o[0], o[1], !nodir);
        } else if (name === 'est' || name === 'estnodir') {
          pathFn(c, o[0], o[1]);
          c.fillStyle = 'rgba(255,255,255,0.5)'; c.fill();
          c.setLineDash(S.dash); c.lineWidth = S.line; c.strokeStyle = '#fff'; c.lineJoin = 'round'; c.stroke();
        } else if (/^halo/.test(name)) {
          var soft = /^haloest/.test(name) ? 'rgba(255,255,255,0.5)' : '#fff';
          c.fillStyle = soft; c.strokeStyle = soft; c.lineWidth = S.halo; c.lineJoin = 'round';
          pathFn(c, o[0], o[1]); c.fill(); c.stroke();
        } else {                                                  // sel
          c.fillStyle = '#fff'; c.strokeStyle = '#fff'; c.lineWidth = S.sel; c.lineJoin = 'round';
          pathFn(c, o[0], o[1]); c.fill(); c.stroke();
        }
        c.restore();
        mapping[setKey + '.' + name] = { x: o[0], y: o[1], width: S.cw, height: S.ch, anchorX: S.cw / 2, anchorY: S.ch / 2, mask: true };
      });
    });
    return { url: cv.toDataURL('image/png'), mapping: mapping };
  }
  // kind bits (motion.js): 1 = no heading, 2 = estimated
  function bodyName(setKey, kind) { return setKey + '.' + ['dir', 'nodir', 'est', 'estnodir'][kind & 3]; }
  function haloName(setKey, kind) { return setKey + '.' + ['halo', 'halonodir', 'haloest', 'haloestnodir'][kind & 3]; }

  // ---- railway lines on the base map --------------------------------------------------------------
  // The base styles draw railways very faintly and only from zoom 14. Add our own, boldly, so a train
  // visibly sits on a line. MEASURED against OpenFreeMap's tiles (2026-11): the vector tiles carry NO
  // rail at zoom 7 and below, one generalised network feature from zoom 8, and full detail from 9.
  // So the lines start at 8; nothing can be drawn from the tiles before that.
  var RAIL_IDS = ['rm-rail-case', 'rm-rail', 'rm-rail-ties'];
  var RAIL_MIN_ZOOM = 8;
  function addRailLayers(map, theme) {
    var style = map.getStyle();
    if (!style) return;
    var src = null;
    Object.keys(style.sources || {}).forEach(function (k) { if (!src && style.sources[k].type === 'vector') src = k; });
    if (!src) return;
    var before = null;
    (style.layers || []).some(function (l) { if (l.type === 'symbol') { before = l.id; return true; } return false; });
    var T = THEME[theme];
    // Tunnels are drawn exactly like open track. A train in a tunnel is still on the railway; leaving
    // tunnels out made trains in Clayton Tunnel and on the Elizabeth line look as if they ran along
    // the road above (owner's report, 2026-11-03).
    var filter = ['all', ['==', ['get', 'class'], 'rail'], ['!', ['has', 'service']]];
    RAIL_IDS.forEach(function (id) { if (map.getLayer(id)) map.removeLayer(id); });
    map.addLayer({
      id: 'rm-rail-case', type: 'line', source: src, 'source-layer': 'transportation', filter: filter, minzoom: RAIL_MIN_ZOOM,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': T.railCase, 'line-opacity': 0.92,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3.8, 10, 4.6, 13, 7, 16, 11, 19, 18] }
    }, before || undefined);
    map.addLayer({
      id: 'rm-rail', type: 'line', source: src, 'source-layer': 'transportation', filter: filter, minzoom: RAIL_MIN_ZOOM,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': T.rail,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.9, 10, 2.4, 13, 3.9, 16, 6, 19, 10] }
    }, before || undefined);
    map.addLayer({
      id: 'rm-rail-ties', type: 'line', source: src, 'source-layer': 'transportation', filter: filter, minzoom: 13.5,
      paint: { 'line-color': T.railTie, 'line-dasharray': [2, 3],
        'line-width': ['interpolate', ['linear'], ['zoom'], 13.5, 1.4, 16, 3, 19, 6] }
    }, before || undefined);
  }

  // Apply the plan from style.js (hide station POIs, recolour dark labels, ...).
  function applyStylePlan(map, ops) {
    ops.forEach(function (o) {
      try {
        if (!map.getLayer(o.id)) return;
        if (o.op === 'visibility') map.setLayoutProperty(o.id, 'visibility', o.value);
        else if (o.op === 'paint') map.setPaintProperty(o.id, o.prop, o.value);
        else if (o.op === 'minzoom') map.setLayerZoomRange(o.id, o.min, 24);
        else if (o.op === 'filter') map.setFilter(o.id, o.value);
      } catch (e) { /* a layer the style does not have in this version: skip it */ }
    });
  }

  // ---- deck.gl layers -----------------------------------------------------------------------------
  // Label overlap is handled by declutter.js before the data gets here; no GPU collision pass.
  // Accessors have fixed identity: deck re-lays-out every label when it sees a "new" function.
  function stPos(s) { return s.pos; }
  function stText(s) { return s.name; }
  function stRadius(s) { return s.r; }
  function stSize(s) { return s.tier === 1 ? 14 : s.tier === 2 ? 12.5 : 11.5; }
  function stOff(s) { return s.lo; }
  function stAnchor(s) { return s.la; }
  function stBase(s) { return s.lb; }
  var stationMemo = null;
  function stationLayers(o) {
    var scale = o.zoom < 7 ? 0.8 : o.zoom < 11 ? 1 : 1.35;
    // Same inputs as last frame: hand back the very same layer objects, so deck does no work.
    if (stationMemo && stationMemo.dots === o.dots && stationMemo.names === o.names &&
        stationMemo.scale === scale && stationMemo.theme === o.theme) return stationMemo.out;
    var d = root.deck, T = THEME[o.theme], out = [];
    out.push(new d.ScatterplotLayer({
      id: 'station-dots', data: o.dots, pickable: true,
      getPosition: stPos, getRadius: stRadius,
      radiusUnits: 'pixels', radiusScale: scale, stroked: true, filled: true, lineWidthUnits: 'pixels',
      getLineWidth: 1.5, getFillColor: T.stFill, getLineColor: T.stLine,
      updateTriggers: { getFillColor: o.theme, getLineColor: o.theme }
    }));
    out.push(new d.TextLayer({
      id: 'station-names', data: o.names, pickable: false,
      getPosition: stPos, getText: stText, getSize: stSize, sizeUnits: 'pixels',
      getColor: T.stText, getTextAnchor: stAnchor, getAlignmentBaseline: stBase, getPixelOffset: stOff,
      fontFamily: FONT, fontWeight: 600, fontSettings: { sdf: true }, outlineWidth: 3, outlineColor: T.textOutline,
      characterSet: 'auto',
      updateTriggers: { getColor: o.theme, getPixelOffset: o.frame, getTextAnchor: o.frame, getAlignmentBaseline: o.frame }
    }));
    stationMemo = { dots: o.dots, names: o.names, scale: scale, theme: o.theme, out: out };
    return out;
  }

  // Trains. o: { buf, zoom, lat, theme, atlas }.
  function trainLayers(o) {
    var d = root.deck, T = THEME[o.theme], b = o.buf, out = [];
    var mix = RM.motion.metreMix(o.zoom);
    var lenPx = RM.motion.trainLenPx(o.zoom, o.lat);
    // Faint circle round trains we only know the rough area of. At the national view it is noise.
    if (b.na > 0 && o.zoom >= 10 && mix < 1) {
      out.push(new d.ScatterplotLayer({
        id: 'approx', data: { length: b.na, attributes: { getPosition: { value: b.apos, size: 2 } } },
        radiusUnits: 'pixels', getRadius: lenPx * 0.95, stroked: true, filled: false, lineWidthUnits: 'pixels', getLineWidth: 1.2,
        opacity: 1 - mix,
        getFillColor: o.theme === 'dark' ? [255, 255, 255, 18] : [15, 23, 42, 18],
        getLineColor: o.theme === 'dark' ? [255, 255, 255, 90] : [15, 23, 42, 90],
        updateTriggers: { getRadius: lenPx }
      }));
    }
    function set(setKey, id, opacity, pickable, sizing) {
      var posAng = { getPosition: { value: b.pos, size: 2 }, getAngle: { value: b.ang, size: 1 } };
      out.push(new d.IconLayer(Object.assign({
        id: id + '-halo', data: { length: b.n, attributes: posAng }, opacity: opacity, pickable: false,
        getIcon: function (_, i) { return haloName(setKey, b.kind[i.index]); }, getSize: 1, getColor: T.halo,
        iconAtlas: o.atlas.url, iconMapping: o.atlas.mapping, billboard: false
      }, sizing)));
      out.push(new d.IconLayer(Object.assign({
        id: id, data: { length: b.n, attributes: Object.assign({ getColor: { value: b.col, size: 4 } }, posAng) },
        opacity: opacity, pickable: pickable,
        getIcon: function (_, i) { return bodyName(setKey, b.kind[i.index]); }, getSize: 1,
        iconAtlas: o.atlas.url, iconMapping: o.atlas.mapping, billboard: false
      }, sizing)));
    }
    if (mix < 1) set('px', 'trains', 1 - mix, mix < 0.5, { sizeUnits: 'pixels', sizeScale: RM.motion.trainSizePx(o.zoom) });
    if (mix > 0) set('m', 'trains-m', mix, mix >= 0.5, { sizeUnits: 'meters', sizeScale: RM.motion.TRAIN_LENGTH_M });
    return out;
  }
  var TRAIN_PICK_IDS = ['trains', 'trains-m'];

  // The highlight under the selected train: the same silhouette, much fatter, in the ring colour,
  // so it follows the train's heading and its metre size.   rec: { pos, sa (screen angle), si ('sel'|'selnodir') }
  function selPos(r) { return r.pos; }
  function selAngle(r) { return r.sa; }
  function selIconPx(r) { return 'px.' + r.si; }
  function selIconM(r) { return 'm.' + r.si; }
  function selectedTrain(o) {
    var d = root.deck, mix = RM.motion.metreMix(o.zoom);
    var common = { data: [o.rec], getPosition: selPos, getAngle: selAngle, getSize: 1, getColor: THEME[o.theme].ring,
      iconAtlas: o.atlas.url, iconMapping: o.atlas.mapping, billboard: false,
      updateTriggers: { getPosition: o.frame, getAngle: o.frame, getIcon: o.frame, getColor: o.theme } };
    var out = [];
    if (mix < 1) out.push(new d.IconLayer(Object.assign({ id: 'selected', opacity: 1 - mix, sizeUnits: 'pixels', sizeScale: RM.motion.trainSizePx(o.zoom), getIcon: selIconPx }, common)));
    if (mix > 0) out.push(new d.IconLayer(Object.assign({ id: 'selected-m', getIcon: selIconM, opacity: mix, sizeUnits: 'meters', sizeScale: RM.motion.TRAIN_LENGTH_M }, common)));
    return out;
  }

  // Train headcodes. Each rec carries its own offset (rec.lo) chosen by the label placement.
  function recPos(r) { return r.pos; }
  function recText(r) { return r.pl === 's' ? r.hc : r.hc + ' ~'; }
  function recOff(r) { return r.lo; }
  function labelLayer(o) {
    var d = root.deck, T = THEME[o.theme];
    return new d.TextLayer({
      id: 'train-labels', data: o.recs, pickable: false,
      getPosition: recPos, getText: recText, getPixelOffset: recOff,
      getSize: 12.5, sizeUnits: 'pixels', getColor: T.text, getTextAnchor: 'middle', getAlignmentBaseline: 'center',
      fontFamily: FONT, fontWeight: 700, fontSettings: { sdf: true },
      outlineWidth: 3, outlineColor: T.textOutline, characterSet: 'auto',
      updateTriggers: { getPosition: o.frame, getPixelOffset: o.frame, getText: o.version, getColor: o.theme }
    });
  }

  // A ring for a selected STATION.
  function selectedRing(o) {
    var d = root.deck;
    return new d.ScatterplotLayer({
      id: 'selected-station', data: [o.pos], getPosition: function (p) { return p; },
      radiusUnits: 'pixels', getRadius: o.radius, stroked: true, filled: false,
      lineWidthUnits: 'pixels', getLineWidth: 3.5, getLineColor: THEME[o.theme].ring,
      updateTriggers: { getLineColor: o.theme }
    });
  }

  function trailLayers(o) {
    var d = root.deck, T = THEME[o.theme];
    var rgb = RM.motion.hexToRgb(o.colour);
    return [
      new d.PathLayer({
        id: 'trail-halo', data: [o.path], getPath: function (p) { return p; }, widthUnits: 'pixels', getWidth: 8,
        getColor: [T.halo[0], T.halo[1], T.halo[2], 120], capRounded: true, jointRounded: true,
        updateTriggers: { getPath: o.frame, getColor: o.theme }
      }),
      new d.PathLayer({
        id: 'trail', data: [o.path], getPath: function (p) { return p; }, widthUnits: 'pixels', getWidth: 4,
        getColor: [rgb[0], rgb[1], rgb[2], 235], capRounded: true, jointRounded: true,
        updateTriggers: { getPath: o.frame, getColor: o.colour }
      })
    ];
  }

  var api = {
    THEME: THEME, SHAPES: SHAPES, makeAtlas: makeAtlas, addRailLayers: addRailLayers, applyStylePlan: applyStylePlan,
    RAIL_IDS: RAIL_IDS, RAIL_MIN_ZOOM: RAIL_MIN_ZOOM, TRAIN_PICK_IDS: TRAIN_PICK_IDS,
    stationLayers: stationLayers, trainLayers: trainLayers, selectedTrain: selectedTrain, labelLayer: labelLayer,
    selectedRing: selectedRing, trailLayers: trailLayers
  };
  (root.RM = root.RM || {}).layers = api;
})(typeof self !== 'undefined' ? self : this);
