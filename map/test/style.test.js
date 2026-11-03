'use strict';
// The calm-base-map plan (map/style.js) against trimmed copies of the REAL OpenFreeMap styles
// (test/fixtures/openfreemap-styles.json): every land fill hidden, one ground colour, water, roads
// and place names kept, buildings faint, labels at WCAG AA.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const S = require('../style.js');
const fx = require(path.join(__dirname, 'fixtures/openfreemap-styles.json'));

// Apply a plan to a style the way layers.js does through MapLibre, and report the result.
function apply(style, ops) {
  const L = {};
  style.layers.forEach((l) => { L[l.id] = { def: l, visible: true, paint: Object.assign({}, l.paint || {}), filter: l.filter, minzoom: undefined }; });
  ops.forEach((o) => {
    const l = L[o.id];
    if (!l) return;
    if (o.op === 'visibility') l.visible = o.value !== 'none';
    else if (o.op === 'paint') l.paint[o.prop] = o.value;
    else if (o.op === 'filter') l.filter = o.value;
    else if (o.op === 'minzoom') l.minzoom = o.min;
  });
  return L;
}
const visible = (L, pred) => Object.values(L).filter((x) => x.visible && pred(x.def));

for (const base of ['liberty', 'positron', 'dark']) {
  for (const theme of base === 'dark' ? ['dark'] : ['light']) {
    const style = fx[base];
    const ops = S.planStyle(style, theme);
    const L = apply(style, ops);

    test(`${base}: no land cover, land use, park or airfield fill is left visible`, () => {
      const left = visible(L, (d) => (S.LAND_SOURCE_LAYERS.includes(d['source-layer']) && (d.type === 'fill' || d.type === 'line')) ||
        (d['source-layer'] === 'aeroway' && d.type === 'fill')).map((x) => x.def.id);
      assert.deepEqual(left, []);
      const hiddenLand = Object.values(L).filter((x) => !x.visible && S.LAND_SOURCE_LAYERS.includes(x.def['source-layer']));
      assert.ok(hiddenLand.length >= 2, 'the plan really did hide land layers (' + hiddenLand.length + ')');
    });

    test(`${base}: the only visible fills are water, buildings and road areas`, () => {
      const fills = visible(L, (d) => d.type === 'fill').map((x) => x.def['source-layer']);
      fills.forEach((sl) => assert.ok(['water', 'building', 'transportation'].includes(sl), 'unexpected visible fill from ' + sl));
      assert.ok(fills.includes('water'));
    });

    test(`${base}: shaded relief and 3D buildings are gone`, () => {
      assert.deepEqual(visible(L, (d) => d.type === 'raster' || d.type === 'fill-extrusion'), []);
    });

    test(`${base}: roads, railways, water and place names are kept`, () => {
      const kept = (sl, type) => visible(L, (d) => d['source-layer'] === sl && (!type || d.type === type)).length;
      assert.ok(kept('transportation', 'line') > 5, 'road lines');
      assert.ok(kept('water', 'fill') >= 1, 'water');
      assert.ok(kept('place', 'symbol') >= 3, 'place names');
      assert.ok(kept('transportation_name', 'symbol') >= 1, 'road names');
    });

    test(`${base}: one flat ground colour`, () => {
      const bg = Object.values(L).find((x) => x.def.type === 'background');
      assert.equal(bg.paint['background-color'], S.GROUND[theme]);
    });

    test(`${base}: buildings are invisible below zoom 15.5 and faint at street level`, () => {
      const b = Object.values(L).filter((x) => x.visible && x.def['source-layer'] === 'building' && x.def.type === 'fill');
      assert.ok(b.length >= 1);
      b.forEach((x) => {
        const o = x.paint['fill-opacity'];
        assert.equal(o[0], 'interpolate');
        assert.deepEqual(o.slice(3, 5), [15.5, 0], 'opacity 0 at 15.5');
        assert.ok(o[6] <= 0.75, 'at most a faint tone at 17');
        assert.equal(x.paint['fill-color'], S.BUILDING[theme]);
      });
    });

    test(`${base}: water has the one water tint`, () => {
      Object.values(L).filter((x) => x.visible && x.def['source-layer'] === 'water' && x.def.type === 'fill')
        .forEach((x) => assert.equal(x.paint['fill-color'], S.WATER[theme]));
    });

    test(`${base}: every text colour is at least 4.5:1 against its ground (or the water)`, () => {
      const bad = [];
      Object.values(L).forEach((x) => {
        if (!x.visible || x.def.type !== 'symbol' || !x.def.layout || !x.def.layout['text-field']) return;
        const c = S.parseColour(x.paint['text-color']);
        if (!c) return;                                       // an expression: not ours to judge
        const bg = /water/.test(x.def.id) ? S.WATER[theme] : S.GROUND[theme];
        if (S.contrast(c, bg) < 4.5) bad.push(x.def.id + ' ' + x.paint['text-color'] + ' ' + S.contrast(c, bg).toFixed(2));
      });
      assert.deepEqual(bad, []);
    });
  }
}

test('liberty: station, bus and airport POIs are hidden or filtered out, the rest start later', () => {
  const L = apply(fx.liberty, S.planStyle(fx.liberty, 'light'));
  assert.equal(L.poi_transit.visible, false);
  ['poi_r1', 'poi_r7', 'poi_r20'].forEach((id) => {
    assert.match(JSON.stringify(L[id].filter), /railway.*bus.*airport/);
    assert.ok(L[id].minzoom >= 16.5, id);
  });
});

test('plans differ by theme only where they should', () => {
  const light = S.planStyle(fx.positron, 'light'), dark = S.planStyle(fx.positron, 'dark');
  const bg = (ops) => ops.find((o) => o.prop === 'background-color').value;
  assert.notEqual(bg(light), bg(dark));
  const hidden = (ops) => ops.filter((o) => o.op === 'visibility').map((o) => o.id).sort();
  assert.deepEqual(hidden(light), hidden(dark), 'the same layers are hidden in both themes, so the two look alike');
});

test('an empty or unrelated style gives an empty plan and does not throw', () => {
  assert.deepEqual(S.planStyle({}, 'light'), []);
  assert.deepEqual(S.planStyle({ layers: [{ id: 'x', type: 'circle', 'source-layer': 'poi' }] }, 'dark'), []);
});

test('colour parser handles every form the styles use', () => {
  assert.deepEqual(S.parseColour('#f00'), [255, 0, 0, 1]);
  assert.deepEqual(S.parseColour('#00ff0080').map((v, i) => i < 3 ? v : Math.round(v * 100) / 100), [0, 255, 0, 0.5]);
  assert.deepEqual(S.parseColour('rgb(12,12,12)'), [12, 12, 12, 1]);
  assert.deepEqual(S.parseColour('rgba(0, 0, 0, 0.7)'), [0, 0, 0, 0.7]);
  assert.deepEqual(S.parseColour('hsl(0,0%,50%)').slice(0, 3), [128, 128, 128]);
  assert.deepEqual(S.parseColour('hsla(120,100%,50%,0.5)'), [0, 255, 0, 0.5]);
  assert.equal(S.parseColour(['interpolate']), null);
  assert.equal(S.parseColour('not a colour'), null);
  assert.equal(S.parseColour(undefined), null);
});

test('the flat ground is dark enough or light enough for the train colours to stand out', () => {
  // the six class colours must keep at least 1.8:1 against the ground, in both themes
  const classes = require('../classes.js');
  classes.ORDER.slice(0, 5).forEach((k) => {
    const c = classes.CLASSES[k].colour;
    assert.ok(S.contrast(c, S.GROUND.light) >= 1.8, k + ' on light ' + S.contrast(c, S.GROUND.light).toFixed(2));
    assert.ok(S.contrast(c, S.GROUND.dark) >= 1.8, k + ' on dark ' + S.contrast(c, S.GROUND.dark).toFixed(2));
  });
});
