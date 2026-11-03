// Adjustments we make to the OpenFreeMap base styles, as DATA: planStyle(style, theme) reads the
// style JSON and returns a list of operations; layers.js applies them through MapLibre's API.
// Keeping the plan pure means it is tested without a browser (against trimmed copies of the real
// styles in test/fixtures), and a base-style layer renamed upstream shows up as a failing test or
// an empty plan, not a silent visual change.
//
// The aim is a CALM map: the trains, stations and rail are the subject, the map is the ground.
//  - ALL land is one colour. Land cover and land use (parks, woods, farmland, grass, residential,
//    industrial, cemeteries, pitches ...), airfields' fills and the shaded-relief raster are hidden,
//    and the background is set to one flat ground colour. Roads, railways, water and place names stay.
//  - Buildings are invisible until zoom 15.5 and a very faint tone by 17 (a street-level cue only).
//  - Water gets one clear tint so it still reads against the flat ground.
//  - Station, bus-stop and airport POIs are hidden (we draw our own stations) and the other POI
//    layers start later and exclude those classes.
//  - Label colours that fail WCAG AA against the ground (or the water) are replaced; checked by tests.
//  - Dark style: black runways are recoloured.
(function (root) {
  'use strict';

  var GROUND = { light: '#f1f2ee', dark: '#0c0c0c' };
  var WATER = { light: '#cddbe8', dark: '#17202b' };
  var BUILDING = { light: '#e4e5df', dark: '#181b20' };
  var LAND_SOURCE_LAYERS = ['landcover', 'landuse', 'park'];

  // Colours chosen for text, with the ground each must clear (exported so tests can check them).
  var TEXT = {
    dark: { place: '#c5cedb', road: '#a9b3c2', water: '#9db3d4', fallback: '#aab4c4' },
    light: { fallback: '#4d535c', water: '#2b5a88', footpath: '#6f5f4b', waterway: '#1f4a8a' }
  };
  // kept for the existing tests / callers
  var DARK_GROUND = GROUND.dark, LIGHT_GROUND = GROUND.light, WATER_LIGHT = WATER.light;

  // ---- colour helpers ----------------------------------------------------------------------------
  // Parse the CSS colour forms MapLibre styles use into [r, g, b, a]; null if it is not a plain colour.
  function parseColour(s) {
    if (typeof s !== 'string') return null;
    s = s.trim().toLowerCase();
    var m;
    if ((m = /^#([0-9a-f]{3,8})$/.exec(s))) {
      var h = m[1];
      if (h.length === 3 || h.length === 4) h = h.split('').map(function (c) { return c + c; }).join('');
      if (h.length !== 6 && h.length !== 8) return null;
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
    }
    if ((m = /^rgba?\(([^)]+)\)$/.exec(s))) {
      var p = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
      if (p.length < 3 || p.some(isNaN)) return null;
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    }
    if ((m = /^hsla?\(([^)]+)\)$/.exec(s))) {
      var q = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
      if (q.length < 3 || q.some(isNaN)) return null;
      var hh = ((q[0] % 360) + 360) % 360 / 360, ss = q[1] / 100, ll = q[2] / 100;
      var a = ss * Math.min(ll, 1 - ll);
      var f = function (n) { var k = (n + hh * 12) % 12; return Math.round(255 * (ll - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
      return [f(0), f(8), f(4), q.length > 3 ? q[3] : 1];
    }
    return null;
  }
  function lum(c) {
    return c.slice(0, 3).map(function (v) {
      v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }).reduce(function (s, v, i) { return s + v * [0.2126, 0.7152, 0.0722][i]; }, 0);
  }
  // WCAG 2 contrast ratio between two colours (any form parseColour understands).
  function contrast(a, b) {
    var ca = typeof a === 'string' ? parseColour(a) : a, cb = typeof b === 'string' ? parseColour(b) : b;
    var la = lum(ca), lb = lum(cb);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  function hasLayer(style, id) { return (style.layers || []).some(function (l) { return l.id === id; }); }

  function planStyle(style, theme) {
    var dark = theme === 'dark';
    var ground = dark ? GROUND.dark : GROUND.light;
    var ops = [];
    function vis(id) { ops.push({ op: 'visibility', id: id, value: 'none' }); }
    function paint(id, prop, value) { ops.push({ op: 'paint', id: id, prop: prop, value: value }); }
    function zoom(id, min) { if (hasLayer(style, id)) ops.push({ op: 'minzoom', id: id, min: min }); }
    var layers = style.layers || [];

    layers.forEach(function (l) {
      var sl = l['source-layer'];
      if (l.type === 'background') { paint(l.id, 'background-color', ground); return; }
      if (l.type === 'raster') { vis(l.id); return; }                                   // shaded relief
      if (l.type === 'fill-extrusion') { vis(l.id); return; }                          // 3D buildings
      if (LAND_SOURCE_LAYERS.indexOf(sl) >= 0 && (l.type === 'fill' || l.type === 'line')) { vis(l.id); return; }
      if (sl === 'aeroway' && l.type === 'fill') { vis(l.id); return; }
      if (sl === 'building' && l.type === 'fill') {
        paint(l.id, 'fill-color', dark ? BUILDING.dark : BUILDING.light);
        paint(l.id, 'fill-opacity', ['interpolate', ['linear'], ['zoom'], 15.5, 0, 17, 0.7]);
        paint(l.id, 'fill-outline-color', 'rgba(0,0,0,0)');
        return;
      }
      if (sl === 'water' && l.type === 'fill') paint(l.id, 'fill-color', dark ? WATER.dark : WATER.light);
    });

    // Station, stop and airport POIs go; the rest of the POI layers lose those classes and start later.
    if (hasLayer(style, 'poi_transit')) vis('poi_transit');
    layers.forEach(function (l) {
      if (!/^poi_r\d+$/.test(l.id)) return;
      var not = ['!', ['match', ['get', 'class'], ['railway', 'rail', 'bus', 'airport'], true, false]];
      ops.push({ op: 'filter', id: l.id, value: l.filter ? ['all', l.filter, not] : not });
    });
    zoom('poi_r1', 16.5); zoom('poi_r7', 18); zoom('poi_r20', 19);

    if (dark) {
      if (hasLayer(style, 'aeroway-runway')) paint('aeroway-runway', 'line-color', '#1f232c');
      if (hasLayer(style, 'aeroway-runway-casing')) paint('aeroway-runway-casing', 'line-color', 'rgba(52,58,70,0.6)');
      if (hasLayer(style, 'aeroway-taxiway')) paint('aeroway-taxiway', 'line-color', '#1a1d25');
    }

    // Labels: named layers first (they also set a dark halo), then a generic AA check on whatever remains.
    var done = {};
    layers.forEach(function (l) {
      if (l.type !== 'symbol' || !l.layout || !l.layout['text-field']) return;
      var id = l.id, onWater = /water/.test(id);
      if (dark) {
        if (/^place_/.test(id)) { paint(id, 'text-color', TEXT.dark.place); paint(id, 'text-halo-color', 'rgba(0,0,0,0.85)'); done[id] = 1; }
        else if (/^highway_name/.test(id)) { paint(id, 'text-color', TEXT.dark.road); paint(id, 'text-halo-color', 'rgba(0,0,0,0.85)'); done[id] = 1; }
        else if (onWater) { paint(id, 'text-color', TEXT.dark.water); paint(id, 'text-halo-color', 'rgba(0,0,0,0.75)'); done[id] = 1; }
      } else {
        if (id === 'highway-name-path') { paint(id, 'text-color', TEXT.light.footpath); done[id] = 1; }
        else if (id === 'waterway_line_label') { paint(id, 'text-color', TEXT.light.waterway); done[id] = 1; }
      }
      if (done[id]) return;
      var c = l.paint && parseColour(l.paint['text-color']);
      if (!c) return;                                                                  // an expression: leave it
      var bg = onWater ? (dark ? WATER.dark : WATER.light) : ground;
      if (contrast(c, bg) < 4.5) paint(id, 'text-color', onWater && !dark ? TEXT.light.water : dark ? TEXT.dark.fallback : TEXT.light.fallback);
    });
    return ops;
  }

  var api = {
    planStyle: planStyle, contrast: contrast, parseColour: parseColour, TEXT: TEXT, GROUND: GROUND, WATER: WATER, BUILDING: BUILDING,
    LAND_SOURCE_LAYERS: LAND_SOURCE_LAYERS, DARK_GROUND: DARK_GROUND, LIGHT_GROUND: LIGHT_GROUND, WATER_LIGHT: WATER_LIGHT
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.RM = root.RM || {}).style = api;
})(typeof self !== 'undefined' ? self : this);
