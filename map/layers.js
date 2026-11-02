// Everything that is drawn on the map: the train icon atlas, the railway lines added to the base
// style, and the deck.gl layers (stations, trains, labels, trail). No page state lives here; app.js
// passes in what to draw and gets layer objects back.
(function (root) {
  'use strict';

  var RM = root.RM;

  // ---- colours by theme ---------------------------------------------------------------------------
  var THEME = {
    light: {
      halo: [15, 23, 42, 235], text: [17, 24, 39, 255], textOutline: [255, 255, 255, 235],
      stFill: [255, 255, 255, 255], stLine: [71, 85, 105, 255], stText: [51, 65, 85, 255],
      rail: '#4b5563', railCase: '#ffffff', railTie: '#ffffff', ring: [219, 39, 119, 255]
    },
    dark: {
      halo: [255, 255, 255, 235], text: [241, 245, 249, 255], textOutline: [10, 16, 28, 240],
      stFill: [30, 41, 59, 255], stLine: [203, 213, 225, 255], stText: [203, 213, 225, 255],
      rail: '#b6c0d0', railCase: '#0a101c', railTie: '#0a101c', ring: [244, 114, 182, 255]
    }
  };
  var FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

  // ---- train icon atlas ---------------------------------------------------------------------------
  // Drawn once on a canvas, pointing north. All icons are white-on-transparent and tinted per train
  // by the GPU (mask: true), so one atlas serves every class colour and both themes.
  //   body   solid cab-nosed carriage shape with a windscreen and gaps between carriages
  //   nodir  the same without a nose, for trains whose heading is unknown
  //   est    outline only, dashed, translucent fill: "this position is an estimate"
  //   halo   a fatter copy of the body, drawn underneath in a contrasting colour
  var CW = 48, CH = 128;
  var CELLS = { dir: [0, 0], nodir: [1, 0], est: [2, 0], estnodir: [3, 0], haloDir: [0, 1], haloNodir: [1, 1], haloEst: [2, 1], haloEstNodir: [3, 1] };
  function dirPath(c, ox, oy) {
    c.beginPath();
    c.moveTo(ox + 9, oy + 46);
    c.quadraticCurveTo(ox + 9, oy + 14, ox + 24, oy + 9);
    c.quadraticCurveTo(ox + 39, oy + 14, ox + 39, oy + 46);
    c.lineTo(ox + 39, oy + 113);
    c.arcTo(ox + 39, oy + 118, ox + 34, oy + 118, 5);
    c.lineTo(ox + 14, oy + 118);
    c.arcTo(ox + 9, oy + 118, ox + 9, oy + 113, 5);
    c.closePath();
  }
  function pillPath(c, ox, oy) {
    c.beginPath();
    c.roundRect(ox + 9, oy + 10, 30, 108, 13);
  }
  function makeAtlas() {
    var cv = document.createElement('canvas');
    cv.width = CW * 4; cv.height = CH * 2;
    var c = cv.getContext('2d');
    function cell(name) { return [CELLS[name][0] * CW, CELLS[name][1] * CH]; }
    function solid(name, pathFn, withNose) {
      var o = cell(name);
      c.save();
      c.globalCompositeOperation = 'source-over';
      c.fillStyle = '#fff';
      pathFn(c, o[0], o[1]); c.fill();
      c.globalCompositeOperation = 'destination-out';
      c.fillStyle = '#000';
      c.fillRect(o[0] + 5, o[1] + 66, 38, 3.5);        // gaps between carriages
      c.fillRect(o[0] + 5, o[1] + 94, 38, 3.5);
      if (withNose) {                                    // windscreen: a see-through patch
        c.fillStyle = 'rgba(0,0,0,0.6)';
        c.beginPath();
        c.moveTo(o[0] + 13, o[1] + 38); c.lineTo(o[0] + 17, o[1] + 26);
        c.quadraticCurveTo(o[0] + 24, o[1] + 22, o[0] + 31, o[1] + 26);
        c.lineTo(o[0] + 35, o[1] + 38); c.closePath(); c.fill();
      }
      c.restore();
    }
    function halo(name, pathFn) {
      var o = cell(name);
      c.save();
      c.fillStyle = '#fff'; c.strokeStyle = '#fff'; c.lineWidth = 9; c.lineJoin = 'round';
      pathFn(c, o[0], o[1]); c.fill(); c.stroke();
      c.restore();
    }
    function est(name, pathFn) {
      var o = cell(name);
      c.save();
      pathFn(c, o[0], o[1]);
      c.fillStyle = 'rgba(255,255,255,0.5)'; c.fill();
      c.setLineDash([9, 6]); c.lineWidth = 5; c.strokeStyle = '#fff'; c.lineJoin = 'round';
      c.stroke();
      c.restore();
    }
    function haloSoft(name, pathFn) {
      var o = cell(name);
      c.save();
      c.fillStyle = 'rgba(255,255,255,0.5)'; c.strokeStyle = 'rgba(255,255,255,0.5)'; c.lineWidth = 9; c.lineJoin = 'round';
      pathFn(c, o[0], o[1]); c.fill(); c.stroke();
      c.restore();
    }
    solid('dir', dirPath, true);
    solid('nodir', pillPath, false);
    est('est', dirPath);
    est('estnodir', pillPath);
    halo('haloDir', dirPath);
    halo('haloNodir', pillPath);
    haloSoft('haloEst', dirPath);
    haloSoft('haloEstNodir', pillPath);
    var mapping = {};
    Object.keys(CELLS).forEach(function (k) {
      mapping[k] = { x: CELLS[k][0] * CW, y: CELLS[k][1] * CH, width: CW, height: CH, anchorX: CW / 2, anchorY: CH / 2, mask: true };
    });
    return { url: cv.toDataURL('image/png'), mapping: mapping };
  }
  var BODY_NAMES = ['dir', 'nodir', 'est', 'estnodir'];
  var HALO_NAMES = ['haloDir', 'haloNodir', 'haloEst', 'haloEstNodir'];

  // ---- railway lines on the base map --------------------------------------------------------------
  // The base styles draw railways very faintly (and only from zoom 14). Add our own, boldly, so a
  // train visibly sits on a line from the regional view down. They are inserted under the labels.
  var RAIL_IDS = ['rm-rail-case', 'rm-rail', 'rm-rail-ties'];
  function addRailLayers(map, theme) {
    var style = map.getStyle();
    if (!style) return;
    var src = null;
    Object.keys(style.sources || {}).forEach(function (k) { if (!src && style.sources[k].type === 'vector') src = k; });
    if (!src) return;
    var before = null;
    (style.layers || []).some(function (l) { if (l.type === 'symbol') { before = l.id; return true; } return false; });
    var T = THEME[theme];
    var filter = ['all', ['==', ['get', 'class'], 'rail'], ['!', ['has', 'service']], ['!=', ['get', 'brunnel'], 'tunnel']];
    RAIL_IDS.forEach(function (id) { if (map.getLayer(id)) map.removeLayer(id); });
    map.addLayer({
      id: 'rm-rail-case', type: 'line', source: src, 'source-layer': 'transportation', filter: filter, minzoom: 5,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': T.railCase, 'line-opacity': 0.9,
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.6, 9, 3, 13, 5.5, 16, 9, 19, 16] }
    }, before || undefined);
    map.addLayer({
      id: 'rm-rail', type: 'line', source: src, 'source-layer': 'transportation', filter: filter, minzoom: 5,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': T.rail,
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.8, 9, 1.6, 13, 3, 16, 5, 19, 9] }
    }, before || undefined);
    map.addLayer({
      id: 'rm-rail-ties', type: 'line', source: src, 'source-layer': 'transportation', filter: filter, minzoom: 13.5,
      paint: { 'line-color': T.railTie, 'line-dasharray': [2, 3],
        'line-width': ['interpolate', ['linear'], ['zoom'], 13.5, 1.4, 16, 3, 19, 6] }
    }, before || undefined);
  }

  // ---- deck.gl layers -----------------------------------------------------------------------------
  // Label overlap is handled by declutter.js before the data gets here; no GPU collision pass.

  // Accessors have fixed identity: deck re-lays-out every label when it sees a "new" function.
  function stPos(s) { return s.pos; }
  function stText(s) { return s.name; }
  function stRadius(s) { return s.r; }
  function stSize(s) { return s.tier === 1 ? 14 : s.tier === 2 ? 12.5 : 11.5; }
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
      getPosition: stPos, getText: stText,
      getSize: stSize, sizeUnits: 'pixels',
      getColor: T.stText, getTextAnchor: 'start', getAlignmentBaseline: 'center', getPixelOffset: [9, 0],
      fontFamily: FONT, fontWeight: 600, fontSettings: { sdf: true }, outlineWidth: 3, outlineColor: T.textOutline,
      characterSet: 'auto',
      updateTriggers: { getColor: o.theme }
    }));
    stationMemo = { dots: o.dots, names: o.names, scale: scale, theme: o.theme, out: out };
    return out;
  }

  function trainLayers(o) {
    var d = root.deck, T = THEME[o.theme], b = o.buf, out = [];
    var iconProps = { iconAtlas: o.atlas.url, iconMapping: o.atlas.mapping, sizeUnits: 'pixels', sizeScale: o.sizePx, billboard: false };
    if (b.na > 0) {
      out.push(new d.ScatterplotLayer({
        id: 'approx', data: { length: b.na, attributes: { getPosition: { value: b.apos, size: 2 } } },
        radiusUnits: 'pixels', getRadius: o.sizePx * 0.95, stroked: true, filled: true, lineWidthUnits: 'pixels', getLineWidth: 1.2,
        getFillColor: o.theme === 'dark' ? [255, 255, 255, 38] : [15, 23, 42, 38],
        getLineColor: o.theme === 'dark' ? [255, 255, 255, 120] : [15, 23, 42, 120],
        updateTriggers: { getRadius: o.sizePx }
      }));
    }
    out.push(new d.IconLayer(Object.assign({
      id: 'train-halo', data: { length: b.n, attributes: { getPosition: { value: b.pos, size: 2 }, getAngle: { value: b.ang, size: 1 } } },
      getIcon: function (_, i) { return HALO_NAMES[b.kind[i.index] & 3]; }, getSize: 1, getColor: T.halo,
      sizeScale: o.sizePx * 1.0, pickable: false
    }, { iconAtlas: iconProps.iconAtlas, iconMapping: iconProps.iconMapping, sizeUnits: 'pixels', billboard: false })));
    out.push(new d.IconLayer(Object.assign({
      id: 'trains', data: { length: b.n, attributes: { getPosition: { value: b.pos, size: 2 }, getAngle: { value: b.ang, size: 1 }, getColor: { value: b.col, size: 4 } } },
      getIcon: function (_, i) { return BODY_NAMES[b.kind[i.index] & 3]; }, getSize: 1, pickable: true
    }, iconProps)));
    return out;
  }

  function recPos(r) { return r.pos; }
  function recText(r) { return r.pl === 's' ? r.hc : r.hc + ' ~'; }
  function labelLayer(o) {
    var d = root.deck, T = THEME[o.theme];
    return new d.TextLayer({
      id: 'train-labels', data: o.recs, pickable: false,
      getPosition: recPos,
      getText: recText,
      getSize: 12.5, sizeUnits: 'pixels', getColor: T.text, getTextAnchor: 'middle', getAlignmentBaseline: 'top',
      getPixelOffset: [0, o.sizePx * 0.62 + 4], fontFamily: FONT, fontWeight: 700, fontSettings: { sdf: true },
      outlineWidth: 3, outlineColor: T.textOutline, characterSet: 'auto',
      updateTriggers: { getPosition: o.frame, getText: o.version, getColor: o.theme }
    });
  }

  function selectedRing(o) {
    var d = root.deck;
    return new d.ScatterplotLayer({
      id: 'selected', data: [o.pos], getPosition: function (p) { return p; },
      radiusUnits: 'pixels', getRadius: o.sizePx * 0.72 + 7, stroked: true, filled: false,
      lineWidthUnits: 'pixels', getLineWidth: 3.5, getLineColor: THEME[o.theme].ring,
      updateTriggers: { getPosition: o.frame, getRadius: o.sizePx, getLineColor: o.theme }
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
    THEME: THEME, makeAtlas: makeAtlas, addRailLayers: addRailLayers, RAIL_IDS: RAIL_IDS,
    stationLayers: stationLayers, trainLayers: trainLayers, labelLayer: labelLayer,
    selectedRing: selectedRing, trailLayers: trailLayers
  };
  (root.RM = root.RM || {}).layers = api;
})(typeof self !== 'undefined' ? self : this);
