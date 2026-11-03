'use strict';
// Round-2 behaviour: metre sizing, heading fallbacks, label alternatives, style plan and contrast.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../motion.js');
const DC = require('../declutter.js');
const S = require('../style.js');

const T = (id, extra) => Object.assign({ id, hc: '2A12', lat: 50.8, lon: -0.1, hdg: 90, area: 'LA', berth: '0004', at: 1, pl: 's' }, extra);

test('trains switch to real-world metres from zoom 15, cross-fading over one zoom level', () => {
  assert.equal(M.metreMix(14), 0);
  assert.equal(M.metreMix(14.5), 0);
  assert.equal(M.metreMix(15), 0.5);
  assert.equal(M.metreMix(15.5), 1);
  assert.equal(M.metreMix(18), 1);
  assert.equal(M.TRAIN_LENGTH_M, 80);
});

test('on-screen length is continuous across the switch and then grows with the zoom like real metres', () => {
  const lat = 51;
  let prev = M.trainLenPx(12, lat);
  for (let z = 12.05; z <= 18; z += 0.05) {
    const v = M.trainLenPx(z, lat);
    assert.ok(v >= prev - 1e-9, 'never shrinks as you zoom in (z ' + z.toFixed(2) + ')');
    assert.ok(v - prev < 0.06 * v + 0.5, 'no jump at z ' + z.toFixed(2) + ': ' + (v - prev));
    prev = v;
  }
  const z16 = M.trainLenPx(16, lat), z17 = M.trainLenPx(17, lat);
  assert.ok(Math.abs(z17 / z16 - 2) < 0.01, 'past the fade, doubling the zoom doubles the length');
  // 80 m at zoom 17 and 51N really is ~ 80 / 0.375 m per px
  assert.ok(Math.abs(z17 - 80 / M.metresPerPixel(17, lat)) < 1e-6);
});

test('metres per pixel matches the Web Mercator figure for MapLibre 512 px tiles', () => {
  assert.ok(Math.abs(M.metresPerPixel(0, 0) - 78271.517) < 0.01);
  assert.ok(Math.abs(M.metresPerPixel(15, 0) - 2.3887) < 0.001);
  assert.ok(M.metresPerPixel(15, 60) < M.metresPerPixel(15, 0) * 0.51);
});

test('a stopped train with no heading keeps the one it last had (it does not turn to face north)', () => {
  const s = M.createStore();
  s.applySnapshot([T('a', { hdg: 200 })], 0);
  s.applyUpdate([T('a', { hdg: null, lat: 50.8, lon: -0.1 })], null, 10);
  const b = s.fill(10, null);
  assert.equal(b.ang[0], -200);
  assert.equal(b.kind[0] & M.KIND_NODIR, 0, 'still drawn with a nose');
});

test('a train that never had a heading is drawn as a symmetric shape, along the rail if the page found one', () => {
  const s = M.createStore();
  s.applySnapshot([T('a', { hdg: null })], 0);
  let b = s.fill(0, null);
  assert.equal(b.kind[0] & M.KIND_NODIR, M.KIND_NODIR);
  assert.equal(b.ang[0], 0);
  s.get('a').hf = 70;                          // set by the page from the railway line underneath
  b = s.fill(0, null);
  assert.equal(b.ang[0], -70);
  assert.equal(b.kind[0] & M.KIND_NODIR, M.KIND_NODIR, 'direction is only known up to 180 degrees: no nose');
});

test('placeAlt takes the first free position and leaves fixed obstacles clear', () => {
  const fixed = [{ x: 0, y: 0, w: 40, h: 40 }];
  const out = DC.placeAlt([
    { w: 20, h: 10, prio: 1, ref: 'a', alts: [{ x: 5, y: 5 }, { x: 50, y: 0 }, { x: 100, y: 0 }] }
  ], fixed, 0);
  assert.deepEqual(out, [{ ref: 'a', alt: 1, x: 50, y: 0 }]);
});

test('placeAlt: higher priority claims its first choice; the other moves on or is dropped', () => {
  const items = [
    { w: 30, h: 10, prio: 1, ref: 'low', alts: [{ x: 0, y: 0 }, { x: 0, y: 20 }] },
    { w: 30, h: 10, prio: 5, ref: 'high', alts: [{ x: 0, y: 0 }] },
    { w: 30, h: 10, prio: 0, ref: 'dropped', alts: [{ x: 0, y: 0 }, { x: 0, y: 20 }] }
  ];
  const out = DC.placeAlt(items, [], 0);
  assert.deepEqual(out.map((o) => [o.ref, o.alt]), [['high', 0], ['low', 1]]);
});

test('placeAlt with no alternatives behaves like place()', () => {
  const boxes = [{ x: 0, y: 0, w: 50, h: 12, prio: 1, ref: 'low' }, { x: 20, y: 2, w: 50, h: 12, prio: 5, ref: 'high' }];
  const a = DC.place(boxes);
  const b = DC.placeAlt(boxes.map((x) => ({ w: x.w, h: x.h, prio: x.prio, ref: x.ref, alts: [{ x: x.x, y: x.y }] })), [], 2).map((o) => o.ref);
  assert.deepEqual(a, b);
});

// ---- the plan for the base styles -------------------------------------------------------------------
const libertyLike = { layers: [
  { id: 'poi_transit', type: 'symbol', layout: { 'text-field': 'x' } },
  { id: 'poi_r1', type: 'symbol', filter: ['>=', ['get', 'rank'], 1], layout: { 'text-field': 'x' } }, { id: 'poi_r7', type: 'symbol', layout: { 'text-field': 'x' } },
  { id: 'poi_r20', type: 'symbol', layout: { 'text-field': 'x' } },
  { id: 'highway-name-path', type: 'symbol', layout: { 'text-field': 'x' } },
  { id: 'waterway_line_label', type: 'symbol', layout: { 'text-field': 'x' } }
] };
const darkLike = { layers: [
  { id: 'aeroway-runway', type: 'line' }, { id: 'aeroway-runway-casing', type: 'line' }, { id: 'aeroway-area', type: 'fill' }, { id: 'aeroway-taxiway', type: 'line' },
  { id: 'place_city', type: 'symbol', layout: { 'text-field': 'x' } }, { id: 'place_town', type: 'symbol', layout: { 'text-field': 'x' } },
  { id: 'highway_name_motorway', type: 'symbol', layout: { 'text-field': 'x' } }, { id: 'water_name', type: 'symbol', layout: { 'text-field': 'x' } },
  { id: 'symbol_without_text', type: 'symbol', layout: {} }
] };

test('light plan: hides transit POIs, delays the rest, lifts two weak label colours', () => {
  const ops = S.planStyle(libertyLike, 'light');
  assert.ok(ops.some((o) => o.op === 'visibility' && o.id === 'poi_transit' && o.value === 'none'));
  const z = Object.fromEntries(ops.filter((o) => o.op === 'minzoom').map((o) => [o.id, o.min]));
  assert.ok(z.poi_r1 >= 16 && z.poi_r7 > z.poi_r1 && z.poi_r20 > z.poi_r7);
  const f = ops.find((o) => o.op === 'filter' && o.id === 'poi_r1').value;
  assert.deepEqual(f[0], 'all');
  assert.deepEqual(f[1], ['>=', ['get', 'rank'], 1], 'the style\'s own filter is kept');
  assert.match(JSON.stringify(f[2]), /railway.*bus.*airport|rail.*bus/, 'station and stop classes are excluded');
  assert.deepEqual(ops.find((o) => o.op === 'filter' && o.id === 'poi_r7').value[0], '!', 'a layer with no filter gets just the exclusion');
  assert.ok(ops.some((o) => o.id === 'highway-name-path' && o.prop === 'text-color'));
  assert.ok(!ops.some((o) => /aeroway/.test(o.id)), 'light plan does not touch aeroways');
});

test('dark plan: runways recoloured away from pure black, every text layer lifted', () => {
  const ops = S.planStyle(darkLike, 'dark');
  const paint = (id, prop) => (ops.find((o) => o.id === id && o.prop === prop) || {}).value;
  ['aeroway-runway', 'aeroway-taxiway'].forEach((id) => assert.notEqual(paint(id, 'line-color'), '#000'));
  assert.notEqual(paint('aeroway-area', 'fill-color'), '#000');
  ['place_city', 'place_town', 'highway_name_motorway', 'water_name'].forEach((id) => assert.ok(paint(id, 'text-color'), id));
  assert.ok(!ops.some((o) => o.id === 'symbol_without_text'));
});

test('a layer the style does not have is simply not in the plan', () => {
  assert.deepEqual(S.planStyle({ layers: [{ id: 'unrelated', type: 'fill' }] }, 'dark'), []);
  assert.deepEqual(S.planStyle({}, 'light'), []);
});

test('WCAG contrast helper is right', () => {
  assert.ok(Math.abs(S.contrast('#000000', '#ffffff') - 21) < 1e-6);
  assert.ok(Math.abs(S.contrast('#777777', '#ffffff') - 4.48) < 0.02);
  assert.equal(S.contrast('#123456', '#123456'), 1);
});

test('every label colour we set clears WCAG AA (4.5:1) against the ground it sits on', () => {
  Object.entries(S.TEXT.dark).forEach(([k, c]) => assert.ok(S.contrast(c, S.DARK_GROUND) >= 4.5, k + ' ' + S.contrast(c, S.DARK_GROUND)));
  assert.ok(S.contrast(S.TEXT.light.footpath, S.LIGHT_GROUND) >= 4.5, 'footpath ' + S.contrast(S.TEXT.light.footpath, S.LIGHT_GROUND));
  assert.ok(S.contrast(S.TEXT.light.waterway, S.WATER_LIGHT) >= 4.5, 'waterway ' + S.contrast(S.TEXT.light.waterway, S.WATER_LIGHT));
  // and the colours the dark style shipped with really did fail, which is why we replaced them
  assert.ok(S.contrast('#656565', S.DARK_GROUND) < 4.5);
  assert.ok(S.contrast('#5e5e5e', S.DARK_GROUND) < 4.5);
});
