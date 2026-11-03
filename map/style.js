// Adjustments we make to the OpenFreeMap base styles, as DATA: planStyle(style, theme) reads the
// style JSON and returns a list of operations; layers.js applies them through MapLibre's API.
// Keeping the plan pure means it can be tested without a browser, and a change of base style
// (a layer renamed upstream) shows up as an empty plan rather than a silent visual regression.
//
// Why each one:
//  - Railway-station, bus-stop and airport POIs are hidden: the page draws its own station dots
//    and names, and two labels for one station is clutter (poi_transit is the style's transit layer).
//  - The remaining POI layers also drop station and stop classes, and start later, so zoomed in to a street the map is not a field of icons.
//  - Dark style: the runways are drawn pure black on near-black (a stray black glyph), and the
//    label greys (about 3.4:1 against the ground) fail WCAG AA. They are replaced with colours
//    checked by contrast() in the unit tests.
//  - Light style: two label colours (footpaths, waterways) were also well below 4.5:1.
(function (root) {
  'use strict';

  var DARK_GROUND = '#0c0c0c';                         // the dark style's background, rgb(12,12,12)
  var LIGHT_GROUND = '#f8f4f0';
  var WATER_LIGHT = '#9cc0f9';                         // approximate liberty water fill

  // Colours chosen for text, with the ground each must clear (exported so tests can check them).
  var TEXT = {
    dark: { place: '#c5cedb', road: '#a9b3c2', water: '#9db3d4' },
    light: { footpath: '#6f5f4b', waterway: '#1f4a8a' }
  };

  function hasLayer(style, id) { return (style.layers || []).some(function (l) { return l.id === id; }); }

  function planStyle(style, theme) {
    var ops = [];
    function vis(id) { if (hasLayer(style, id)) ops.push({ op: 'visibility', id: id, value: 'none' }); }
    function zoom(id, min) { if (hasLayer(style, id)) ops.push({ op: 'minzoom', id: id, min: min }); }
    function paint(id, prop, value) { if (hasLayer(style, id)) ops.push({ op: 'paint', id: id, prop: prop, value: value }); }

    vis('poi_transit');
    // The other POI layers also carry stations and stops; keep everything BUT those, and start later.
    (style.layers || []).forEach(function (l) {
      if (!/^poi_r\d+$/.test(l.id)) return;
      var not = ['!', ['match', ['get', 'class'], ['railway', 'rail', 'bus', 'airport'], true, false]];
      ops.push({ op: 'filter', id: l.id, value: l.filter ? ['all', l.filter, not] : not });
    });
    zoom('poi_r1', 16.5); zoom('poi_r7', 18); zoom('poi_r20', 19);

    if (theme === 'dark') {
      paint('aeroway-runway', 'line-color', '#3b4150');
      paint('aeroway-runway-casing', 'line-color', 'rgba(96,104,120,0.8)');
      paint('aeroway-area', 'fill-color', '#222630');
      paint('aeroway-taxiway', 'line-color', '#2c313c');
      (style.layers || []).forEach(function (l) {
        if (l.type !== 'symbol' || !l.layout || !l.layout['text-field']) return;
        if (/^place_/.test(l.id)) { paint(l.id, 'text-color', TEXT.dark.place); paint(l.id, 'text-halo-color', 'rgba(0,0,0,0.85)'); }
        else if (/^highway_name/.test(l.id)) { paint(l.id, 'text-color', TEXT.dark.road); paint(l.id, 'text-halo-color', 'rgba(0,0,0,0.85)'); }
        else if (l.id === 'water_name') { paint(l.id, 'text-color', TEXT.dark.water); paint(l.id, 'text-halo-color', 'rgba(0,0,0,0.75)'); }
      });
    } else {
      paint('highway-name-path', 'text-color', TEXT.light.footpath);
      paint('waterway_line_label', 'text-color', TEXT.light.waterway);
    }
    return ops;
  }

  // WCAG 2 contrast ratio between two #rrggbb colours.
  function lum(hex) {
    var n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (c) {
      c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }).reduce(function (s, v, i) { return s + v * [0.2126, 0.7152, 0.0722][i]; }, 0);
  }
  function contrast(a, b) {
    var la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  var api = { planStyle: planStyle, contrast: contrast, TEXT: TEXT, DARK_GROUND: DARK_GROUND, LIGHT_GROUND: LIGHT_GROUND, WATER_LIGHT: WATER_LIGHT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.RM = root.RM || {}).style = api;
})(typeof self !== 'undefined' ? self : this);
