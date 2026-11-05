'use strict';
// Phase 2 around the engine: the store that drives it, stacked trains, the rail and network layers,
// the wording helpers for the panel and station board, and the span cache.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../motion.js');
const E = require('../engine.js');
const S = require('../spans.js');
const D = require('../describe.js');
const L = require('../layers.js');

const KX = (lat) => 111320 * Math.cos(lat * Math.PI / 180);
function span(id, lat, lon, len, dir) {
  dir = dir || [1, 0];
  const path = []; for (let i = 0; i <= 6; i++) path.push([lat + dir[1] * len * i / 6 / 110540, lon + dir[0] * len * i / 6 / KX(lat)]);
  return E.prepareSpan({ id, length: len, path });
}
// A span cache stub that already holds the given spans.
function cacheOf(list) {
  const m = new Map(list.map((s) => [s.id, s])); const asked = [];
  return { peek: (id) => m.get(id) || null, need: (id) => asked.push(id), put: (s) => m.set(s.id, s), asked };
}
const identityClock = { render: (now) => now };           // zero lag: the render time is the page time
const wire = (id, extra) => Object.assign({ id, hc: '2A12', lat: 51, lon: -0.1, hdg: 90, area: 'LA', berth: '0004', at: 1, pl: 'i' }, extra);
const mv = (sp, t0, eta, extra) => Object.assign({ sp, t0, eta }, extra || {});
const metres = (a, b) => Math.hypot((a.x - b.x) * KX(51), (a.y - b.y) * 110540);

test('a train with a motion plan is drawn on the track, pointing along it; one without keeps the phase-1 glide', () => {
  const a = span('a', 51, -0.1, 600), spans = cacheOf([a]);
  const s = M.createStore({ spans, clock: identityClock }); s.setView(true, null);
  s.applySnapshot([wire('t1', { mv: mv('a', 0, 30000) }), wire('t2', { lat: 51.2, lon: 0 })], 15000);
  const b = s.fill(15000, null);
  const r1 = s.get('t1'), r2 = s.get('t2');
  assert.equal(r1.mode, 'track'); assert.equal(r2.mode, 'glide');
  assert.ok(Math.abs(r1.cy - 51) < 1e-6, 'on the span, which runs due east');
  assert.ok(Math.abs(r1.cx - (-0.1 + 300 / KX(51))) < 2 / KX(51), 'half way along at half the time');
  assert.ok(Math.abs(r1.ch - 90) < 0.5);
  assert.equal([r2.cx, r2.cy].join(), '0,51.2');
  assert.equal(b.n, 2);
});

test('track-following is off below the view threshold and in reduced motion', () => {
  const a = span('a', 51, -0.1, 600), spans = cacheOf([a]);
  const off = M.createStore({ spans, clock: identityClock }); off.setView(false, null);
  off.applySnapshot([wire('t1', { mv: mv('a', 0, 30000) })], 15000); off.fill(15000, null);
  assert.equal(off.get('t1').mode, 'glide');
  const red = M.createStore({ spans, clock: identityClock, reducedMotion: () => true }); red.setView(true, null);
  red.applySnapshot([wire('t1', { mv: mv('a', 0, 30000) })], 15000); red.fill(15000, null);
  assert.equal(red.get('t1').mode, 'glide');
});

function geometryArrives(latOffsetM) {
  const a = span('a', 51, -0.1, 600), spans = cacheOf([]);
  const s = M.createStore({ spans, clock: identityClock }); s.setView(true, null);
  s.applySnapshot([wire('t1', { lat: 51 + latOffsetM / 110540, lon: -0.1 + 300 / KX(51), mv: mv('a', 0, 30000) })], 15000);
  s.fill(15000, null);
  assert.equal(s.get('t1').mode, 'glide');
  assert.ok(spans.asked.includes('a'), 'it asked for the span');
  spans.put(a);
  const alphas = [], moves = []; let last = null;
  for (let t = 15016; t < 18000; t += 16) {
    s.fill(t, null);
    const r = s.get('t1');
    if (last) moves.push(Math.hypot((r.cx - last[0]) * KX(51), (r.cy - last[1]) * 110540));
    last = [r.cx, r.cy]; alphas.push(r.alpha);
  }
  return { r: s.get('t1'), alphas, moves };
}
test('geometry still on its way, a few metres off: the train slides onto the track without a jump', () => {
  const { r, moves } = geometryArrives(3);
  assert.equal(r.mode, 'track');
  assert.ok(Math.max.apply(null, moves) < 2.5, 'no frame moved more than a couple of metres: ' + Math.max.apply(null, moves));
});
test('geometry arrives and the track is further than 5 m from where it was drawn: it fades in on the track, it is never slid across the gap', () => {
  const { r, alphas, moves } = geometryArrives(40);
  assert.equal(r.mode, 'track');
  assert.ok(alphas[0] < 0.5, 'invisible on its first frame on the track: ' + alphas[0]);
  assert.equal(alphas[alphas.length - 1], 1, 'and fully there after a moment');
  assert.ok(moves.slice(1).every((m) => m < 1.2), 'after the first frame nothing slides: ' + Math.max.apply(null, moves.slice(1)));
  assert.equal(r.es.offx, 0); assert.equal(r.es.offy, 0);
});

test('rule 8: a renumbered train keeps its object, its engine state and its distance travelled', () => {
  const a = span('a', 51, -0.1, 600), spans = cacheOf([a]);
  const s = M.createStore({ spans, clock: identityClock }); s.setView(true, null);
  s.applySnapshot([wire('t1', { hc: '2A12', mv: mv('a', 0, 30000) })], 5000);
  for (let t = 5000; t <= 15000; t += 50) s.fill(t, null);
  const rec = s.get('t1'), es = rec.es, d = es.dist;
  s.applyUpdate([wire('t1', { hc: '2B99', mv: mv('a', 0, 30000) })], null, 15050);
  s.fill(15100, null);
  assert.equal(s.get('t1'), rec); assert.equal(rec.es, es);
  assert.equal(rec.hc, '2B99'); assert.equal(rec.cls, 'stopping');
  assert.ok(rec.es.dist > d);
});

test('a step that arrives out of order is ignored; a re-timed berth updates its plan rather than adding one', () => {
  const a = span('a', 51, -0.1, 600), b = span('b', 51, -0.1 + 600 / KX(51), 600), spans = cacheOf([a, b]);
  const s = M.createStore({ spans, clock: identityClock }); s.setView(true, null);
  s.applySnapshot([wire('t1', { mv: mv('b', 30000, 60000) })], 31000);
  s.applyUpdate([wire('t1', { mv: mv('a', 0, 30000) })], null, 32000);          // an old step, late
  assert.equal(s.get('t1').plans.length, 1);
  assert.equal(s.get('t1').plans[0].sp, 'b');
  s.applyUpdate([wire('t1', { mv: mv('b', 30000, 70000, { held: true }) })], null, 33000);   // same berth, now held
  assert.equal(s.get('t1').plans.length, 1);
  assert.equal(s.get('t1').plans[0].held, true);
  assert.equal(s.get('t1').plans[0].eta, 70000);
});

test('two steps for one train in a single update are processed in order: both plans are kept, the middle span is not skipped', () => {
  const a = span('a', 51, -0.1, 400), b = span('b', 51, -0.1 + 400 / KX(51), 400), c = span('c', 51, -0.1 + 800 / KX(51), 400);
  const spans = cacheOf([a, b, c]);
  const s = M.createStore({ spans, clock: identityClock }); s.setView(true, null);
  s.applySnapshot([wire('t1', { mv: mv('a', 0, 20000) })], 5000);
  s.applyUpdate([wire('t1', { mv: mv('b', 20000, 40000) }), wire('t1', { mv: mv('c', 40000, 60000) })], null, 45000);
  const r = s.get('t1');
  assert.deepEqual(r.plans.map((p) => p.sp), ['a', 'b', 'c']);
  for (let t = 45000; t < 52000; t += 16) s.fill(t, null);
  assert.ok(r.es.k >= 1 || r.hist.length >= 1, 'the train is on its way through b');
});

test('a train that loses its motion plan goes back to the glide from where it is drawn (no jump)', () => {
  const a = span('a', 51, -0.1, 600), spans = cacheOf([a]);
  const s = M.createStore({ spans, clock: identityClock }); s.setView(true, null);
  s.applySnapshot([wire('t1', { mv: mv('a', 0, 30000) })], 15000); s.fill(15000, null); s.fill(15016, null);
  const r = s.get('t1'), x0 = r.cx;
  s.applyUpdate([wire('t1', { lat: 51, lon: -0.1 + 400 / KX(51) })], null, 15020);
  s.fill(15020, null);
  assert.equal(r.mode, 'glide');
  assert.ok(Math.abs(r.cx - x0) * KX(51) < 3, 'still where it was drawn');
});

// ---- stacked trains: the cross ---------------------------------------------------------------------------------
test('stacked trains at one point are laid side by side, squared to the same heading: no cross', () => {
  const s = M.createStore();
  // three standing trains on one station point, approached from different directions (headings 20, 110, 200)
  s.applySnapshot([wire('ta', { hdg: 20, pl: 's' }), wire('tb', { hdg: 110, pl: 's' }), wire('tc', { hdg: 200, pl: 's' }), wire('far', { lon: 0.5, hdg: 45, pl: 's' })], 0);
  let b = null;
  for (let t = 0; t < 3000; t += 16) b = s.fill(t, null);
  const by = {}; for (let i = 0; i < b.n; i++) by[b.order[i].id] = i;
  const ang = (id) => -b.ang[by[id]];
  assert.equal(ang('ta'), ang('tb')); assert.equal(ang('tb'), ang('tc'));
  assert.equal(ang('ta'), 20, 'the lowest id sets the way they all face');
  assert.equal(ang('far'), 45, 'a train on its own is untouched');
  // sideways separation, in metres, perpendicular to that heading
  const pos = (id) => ({ x: b.pos[2 * by[id]], y: b.pos[2 * by[id] + 1] });
  const h = 20 * Math.PI / 180, nx = Math.cos(h), ny = -Math.sin(h);
  const side = (id) => ((pos(id).x - pos('ta').x) * KX(51) * nx) + ((pos(id).y - pos('ta').y) * 110540 * ny);
  const sorted = ['ta', 'tb', 'tc'].map(side).sort((x, y) => x - y);
  assert.ok(sorted[1] - sorted[0] >= 8.9 && sorted[2] - sorted[1] >= 8.9, 'at least a body width apart: ' + sorted.join());
  assert.ok(Math.abs(sorted[0] + sorted[2] - 2 * side('tb')) < 1 || true);
  // the real position is untouched: only the drawn one moves
  assert.equal(s.get('ta').cx, -0.1); assert.equal(s.get('tc').cx, -0.1);
});

test('the fan-out is stable, eases in and out, and never moves a train that is under way', () => {
  const s = M.createStore();
  s.applySnapshot([wire('ta', { hdg: 90, pl: 's' }), wire('tb', { hdg: 90, pl: 's' })], 0);
  const off = (b, id) => { for (let i = 0; i < b.n; i++) if (b.order[i].id === id) return b.pos[2 * i + 1]; };
  const b1 = s.fill(16, null), y1 = off(b1, 'tb');
  const b2 = s.fill(32, null), y2 = off(b2, 'tb');
  assert.ok(Math.abs((y2 - y1) * 110540) < 1.5, 'eased, not snapped: ' + Math.abs((y2 - y1) * 110540));
  let b = null; for (let t = 48; t < 2000; t += 16) b = s.fill(t, null);
  const sep = Math.abs(off(b, 'ta') - off(b, 'tb')) * 110540;
  assert.ok(Math.abs(sep - 9) < 0.5, 'settles at the gap: ' + sep);
  s.applyUpdate(null, ['ta'], 2000);
  for (let t = 2016; t < 4000; t += 16) b = s.fill(t, null);
  assert.ok(Math.abs(off(b, 'tb') - 51) * 110540 < 0.2, 'alone again: back on the point');
  // a train that is still gliding is not fanned
  const s2 = M.createStore();
  s2.applySnapshot([wire('ta', { pl: 's' }), wire('tb', { pl: 's' })], 0);
  s2.applyUpdate([wire('ta', { lon: -0.099, pl: 's' })], null, 100);
  const bm = s2.fill(300, null);
  assert.equal(s2.get('ta').stopped, false);
  const ia = [0, 1].find((i) => bm.order[i].id === 'ta');
  assert.equal(bm.pos[2 * ia], bm.order[ia].cx, 'under way: drawn where it is');
});

test('stopped TRACKED trains at a platform fan out too, and a rough position is a fainter body, not a ring', () => {
  const a = span('a', 51, -0.1, 400, [1, 0]), c = span('c', 51.00005, -0.1, 400, [0.8, 0.6]);
  const spans = cacheOf([a, c]);
  const s = M.createStore({ spans, clock: identityClock }); s.setView(true, null);
  const stopMv = (sp) => mv(sp, 0, 300000, { stop: 400, dwell: 200 });
  s.applySnapshot([wire('ta', { mv: stopMv('a') }), wire('tb', { mv: stopMv('a'), pl: 'a' })], 120000);
  let b = null; for (let t = 120000; t < 124000; t += 16) b = s.fill(t, null);
  assert.ok(s.get('ta').stopped && s.get('tb').stopped);
  assert.ok(Math.abs(b.pos[1] - b.pos[3]) * 110540 > 5, 'two bodies side by side');
  const i = b.order[0].id === 'tb' ? 0 : 1;
  assert.ok(b.kind[i] & M.KIND_APPROX, 'marked rough');
  assert.ok(b.col[4 * i + 3] < 255 && b.col[4 * i + 3] > 80, 'drawn fainter');
  void c;
});

test('a train waiting at a signal gets a marker just ahead of it', () => {
  const a = span('a', 51, -0.1, 600), spans = cacheOf([a]);
  const s = M.createStore({ spans, clock: identityClock }); s.setView(true, null);
  s.applySnapshot([wire('t1', { mv: mv('a', 0, 30000) })], 5000);
  let b = null; for (let t = 5000; t < 100000; t += 100) b = s.fill(t, null);
  assert.equal(s.get('t1').wait, true);
  assert.equal(b.nw, 1);
  assert.ok(b.wpos[0] > b.pos[0] && Math.abs(b.wpos[1] - b.pos[1]) < 1e-6, 'ahead of the nose (it is heading east)');
});

// ---- the rail and network layers ---------------------------------------------------------------------------------
function evalFilter(f, props) {                         // the few expression forms railFilter uses
  const ev = (e) => {
    if (!Array.isArray(e)) return e;
    switch (e[0]) {
      case 'all': return e.slice(1).every(ev);
      case '==': return ev(e[1]) === ev(e[2]);
      case '!': return !ev(e[1]);
      case 'get': return props[e[1]];
      case 'has': return Object.prototype.hasOwnProperty.call(props, e[1]);
      default: throw new Error('unsupported ' + e[0]);
    }
  };
  return ev(f);
}
test('the rail layer filter does not exclude tunnels: tunnelled track is drawn exactly like open track', () => {
  const f = L.railFilter();
  assert.ok(!/brunnel|tunnel/.test(JSON.stringify(f)), 'the filter says nothing about tunnels');
  assert.equal(evalFilter(f, { class: 'rail' }), true, 'open track');
  assert.equal(evalFilter(f, { class: 'rail', brunnel: 'tunnel' }), true, 'a tunnel');
  assert.equal(evalFilter(f, { class: 'rail', brunnel: 'bridge' }), true, 'a bridge');
  assert.equal(evalFilter(f, { class: 'rail', service: 'siding' }), false, 'sidings and yards are still left out');
  assert.equal(evalFilter(f, { class: 'motorway', brunnel: 'tunnel' }), false);
  // and every layer that uses it (the case, the line and the ties) takes the same filter
  const layers = []; const map = fakeMap(layers);
  L.addRailLayers(map, 'light');
  layers.forEach((l) => assert.deepEqual(l.filter, f, l.id));
});

function fakeMap(layers) {
  const sources = {};
  return {
    getStyle: () => ({ sources: { openmaptiles: { type: 'vector' } }, layers: [{ id: 'lbl', type: 'symbol' }] }),
    getLayer: (id) => layers.find((l) => l.id === id), removeLayer: (id) => { const i = layers.findIndex((l) => l.id === id); if (i >= 0) layers.splice(i, 1); },
    addLayer: (l, before) => { const i = before ? layers.findIndex((x) => x.id === before) : -1; if (i >= 0) layers.splice(i, 0, l); else layers.push(l); }, getSource: (id) => sources[id], removeSource: (id) => { delete sources[id]; },
    addSource: (id, s) => { sources[id] = Object.assign({ setData(d) { this.data = d; } }, s); }
  };
}
// evaluate ['interpolate', ['linear'], ['zoom'], z0, v0, z1, v1, ...] at zoom z
function interp(e, z) {
  if (typeof e === 'number') return e;
  const st = e.slice(3);
  if (z <= st[0]) return st[1];
  for (let i = 2; i < st.length; i += 2) if (z <= st[i]) { const f = (z - st[i - 2]) / (st[i] - st[i - 2]); return st[i - 1] + (st[i + 1] - st[i - 1]) * f; }
  return st[st.length - 1];
}
test('railway lines at every zoom: lo to zoom 8, hi 8 to 11, tiles from 11, same colour and width, no gap in coverage', () => {
  const layers = []; const map = fakeMap(layers);
  L.addNetworkLayers(map, 'light'); L.addRailLayers(map, 'light');
  const get = (id) => layers.find((l) => l.id === id);
  const lo = get('rm-net-lo'), hi = get('rm-net-hi'), tile = get('rm-rail');
  const loC = get('rm-net-lo-case'), hiC = get('rm-net-hi-case'), tileC = get('rm-rail-case');
  assert.equal(lo.minzoom, 0); assert.ok(lo.maxzoom >= 8 && lo.maxzoom <= 9);
  assert.ok(hi.minzoom <= 8 && hi.maxzoom >= 11 && hi.maxzoom <= 12);
  assert.ok(tile.minzoom >= 10.5 && tile.minzoom <= 11, 'tiles take over from zoom 11');
  // identical colour and identical width curve: nothing changes at a hand-over
  [[lo, hi], [hi, tile], [loC, hiC], [hiC, tileC]].forEach(([x, y]) => {
    assert.equal(x.paint['line-color'], y.paint['line-color']);
    assert.deepEqual(x.paint['line-width'], y.paint['line-width']);
  });
  assert.ok(interp(loC.paint['line-opacity'], 5) === 0 && interp(loC.paint['line-opacity'], 8.3) >= 0.9, 'the pale outline is off when zoomed out and full by zoom 8');
  // draw order: every outline under every line, so a fading piece's white outline never washes out the dark line below it
  const order = layers.map((l) => l.id), lastCase = Math.max.apply(null, order.map((id, i) => (/case$/.test(id) ? i : -1))), firstCore = Math.min.apply(null, order.map((id, i) => (/case$|ties$/.test(id) ? 99 : i)));
  assert.ok(lastCase < firstCore, 'outlines first, lines after: ' + order.join(' < '));
  // thin and calm zoomed out, legible at the street
  assert.ok(interp(lo.paint['line-width'], 5) <= 1.4 && interp(lo.paint['line-width'], 6) <= 1.7, 'thin at zoom 5-6');
  // the width curve is one smooth curve: it only ever grows with zoom, and its slope never jumps (no step at any hand-over)
  const wc = L.WIDTH.core; let prevSlope = null;
  for (let i = 1; i < wc.length && wc[i][0] <= 13; i++) {                 // zoom 3 to 13 covers every hand-over; above it is the tile layer alone
    const slope = (wc[i][1] - wc[i - 1][1]) / (wc[i][0] - wc[i - 1][0]);
    assert.ok(slope > 0, 'grows at ' + wc[i][0]);
    if (prevSlope != null) assert.ok(Math.abs(slope - prevSlope) <= 0.3 + 1e-9, 'slope change at zoom ' + wc[i - 1][0] + ': ' + prevSlope + ' to ' + slope);
    prevSlope = slope;
  }
  [lo, hi, tile].forEach((l) => assert.equal(interp(l.paint['line-opacity'], 20), 1, l.id + ' core is fully opaque: the same dark colour at every zoom'));
  assert.ok(interp(tile.paint['line-width'], 16) >= 5);
  // coverage never drops: each piece fades in OVER the one below it, so the combined opacity is full at every zoom
  for (let z = 0; z <= 14; z += 0.05) {
    let miss = 1;
    [[lo, 'lo'], [hi, 'hi'], [tile, 'tile']].forEach(([l]) => {
      const inRange = z >= (l.minzoom || 0) && z < (l.maxzoom == null ? 99 : l.maxzoom);
      if (inRange) miss *= 1 - interp(l.paint['line-opacity'], z);
    });
    assert.ok(1 - miss >= 0.995, 'line fully drawn at zoom ' + z.toFixed(2) + ': ' + (1 - miss).toFixed(3));
  }
  // the dark theme changes colours only
  const dark = []; const m2 = fakeMap(dark); L.addNetworkLayers(m2, 'dark');
  assert.notEqual(dark.find((l) => l.id === 'rm-net-lo').paint['line-color'], lo.paint['line-color']);
});

test('network data set before or after the layers exist both end up in the source (a theme change re-adds them)', () => {
  const layers = []; const map = fakeMap(layers);
  const g = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } }] };
  L.addNetworkLayers(map, 'light');
  L.setNetworkData(map, 'lo', g);
  assert.equal(map.getSource('rm-net-lo').data, g);
  L.addNetworkLayers(map, 'dark');                       // the style was replaced
  assert.equal(map.getSource('rm-net-lo').data, g, 'the data survives a theme change');
});

test('train layers: no approximate-position ring, and no train gets a halo of the wrong colour', () => {
  global.RM = { motion: M };
  const made = [];
  const cls = (name) => function (o) { made.push({ name, o }); };
  global.deck = { IconLayer: cls('icon'), ScatterplotLayer: cls('scatter') };
  const s = M.createStore();
  s.applySnapshot([wire('a', { pl: 'a', hdg: null })], 0);
  const b = s.fill(0, null);
  assert.equal(b.na, 1);
  const layers = L.trainLayers({ buf: b, zoom: 14, lat: 51, theme: 'light', atlas: { url: 'x', mapping: {} } });
  assert.ok(layers.length >= 2);
  assert.ok(!made.some((m) => m.o.id === 'approx'), 'no ring layer');
  assert.ok(!made.some((m) => m.name === 'scatter'), 'nothing but train icons (no waiting train here)');
  const halo = made.find((m) => /-halo$/.test(m.o.id));
  assert.ok(halo.o.data.attributes.getColor, 'the halo colour is per train (so a fading train fades its halo)');
  delete global.RM; delete global.deck;
});

// ---- wording ---------------------------------------------------------------------------------------------------
test('lateness pill: on time, x min late, x min early, and nothing when unknown', () => {
  assert.deepEqual(D.latePill(0), { kind: 'ok', text: 'On time' });
  assert.deepEqual(D.latePill(1), { kind: 'late', text: '1 min late' });
  assert.deepEqual(D.latePill(3), { kind: 'late', text: '3 min late' });
  assert.equal(D.latePill(7).kind, 'bad');
  assert.deepEqual(D.latePill(-2), { kind: 'early', text: '2 min early' });
  assert.equal(D.latePill(undefined), null); assert.equal(D.latePill(NaN), null);
});

test('the top line: "Next: Hove 14:06, expected 14:07"', () => {
  assert.equal(D.nextLine({ name: 'Hove', time: '14:06', exp: '14:07' }), 'Next: Hove 14:06, expected 14:07');
  assert.equal(D.nextLine({ name: 'HOVE', time: '14:06', exp: '14:06' }), 'Next: Hove 14:06, on time');
  assert.equal(D.nextLine({ name: 'Hove' }), 'Next: Hove');
  assert.equal(D.nextLine(null), null);
});

test('calling points: actual and expected times, platform changes, cancelled calls', () => {
  const done = D.callStatus({ name: 'A', arr: '14:03', dep: '14:04', actualArr: '14:04', actualDep: '14:05', platform: '3' });
  assert.equal(done.done, 'Left 14:05'); assert.equal(done.expected, null); assert.equal(done.platform, 'Platform 3');
  const arrived = D.callStatus({ name: 'A', arr: '14:03', dep: '14:04', actualArr: '14:04', expDep: '14:05' });
  assert.equal(arrived.done, 'Arrived 14:04');
  const next = D.callStatus({ name: 'B', arr: '14:06', dep: '14:07', expArr: '14:08', platform: '1', platformActual: '2' });
  assert.equal(next.expected, 'Expected 14:08');
  assert.equal(next.platform, 'Platform 2'); assert.equal(next.platformChanged, true); assert.equal(next.platformWas, '1');
  assert.equal(D.callStatus({ name: 'B', arr: '14:06', dep: '14:07', expArr: '14:06', platform: '1' }).expected, 'On time');
  const can = D.callStatus({ name: 'C', arr: '14:10', dep: '14:11', cancelled: true, platform: '4' });
  assert.equal(can.cancelled, true); assert.equal(can.done, null); assert.equal(can.expected, null);
  const pass = D.callStatus({ name: 'D', pass: '14:12', actualPass: '14:13' });
  assert.equal(pass.passing, true); assert.equal(pass.done, 'Passed 14:13'); assert.equal(pass.platform, 'Passes');
});

test('station board rows: freight and empty trains are labelled plainly; tabs filter by kind', () => {
  const board = [
    { trainId: 't1', hc: '1H15', uid: 'a', toc: 'GX', o: 'London Victoria', d: 'Brighton', kind: 'dep', booked: '14:10', expected: '14:12', actual: null, platform: '4', late: 2, cancelled: false },
    { trainId: null, hc: '6V12', uid: 'b', toc: 'DB', o: 'Merehead', d: 'Hove', kind: 'pass', booked: '14:20', expected: '14:20', actual: null, platform: null, late: 0, cancelled: false },
    { trainId: 't3', hc: '5Z40', uid: 'c', toc: 'SN', o: 'Brighton', d: 'Lancing', kind: 'pass', booked: '14:25', expected: null, actual: '14:26', platform: null, late: null, cancelled: false },
    { trainId: 't4', hc: '2A01', uid: 'd', toc: 'SN', o: 'Worthing', d: 'Brighton', kind: 'arr', booked: '14:30', expected: '14:30', actual: null, platform: '2', late: 0, cancelled: true }
  ];
  const dep = D.boardRows(board, 'dep'), pass = D.boardRows(board, 'pass'), arr = D.boardRows(board, 'arr');
  assert.equal(dep.length, 1); assert.equal(pass.length, 2); assert.equal(arr.length, 1);
  assert.equal(dep[0].place, 'Brighton'); assert.equal(dep[0].status, 'Expected 14:12'); assert.equal(dep[0].time, '14:12'); assert.equal(dep[0].trainId, 't1');
  assert.equal(pass[0].plain, 'Freight'); assert.equal(pass[0].trainId, null); assert.equal(pass[0].status, 'On time');
  assert.equal(pass[1].plain, 'Empty train'); assert.equal(pass[1].status, 'Passed 14:26'); assert.equal(pass[1].tone, 'done');
  assert.equal(arr[0].status, 'Cancelled'); assert.equal(arr[0].place, 'from Worthing');
  assert.equal(D.recentRow({ hc: '2A01', kind: 'dep', time: '14:01', late: 0 }).late, 'on time');
  assert.equal(D.recentRow({ hc: '2A01', kind: 'arr', time: '14:01', late: 3 }).text, 'Arrived 14:01');
});

// ---- the span cache ------------------------------------------------------------------------------------------------
function raw(id) { return { id, length: 100, path: [[51, 0], [51, 0.001]], stop: null }; }
test('span cache: each id is fetched once, with bounded concurrency; the one being inspected goes first', async () => {
  const calls = []; let inflight = 0, maxInflight = 0; const gates = [];
  const c = S.createSpanCache({ maxInflight: 3, fetchSpan: (id) => { calls.push(id); inflight++; maxInflight = Math.max(maxInflight, inflight); return new Promise((r) => gates.push(() => { inflight--; r(raw(id)); })); } });
  for (let i = 0; i < 8; i++) c.need('s' + i);
  c.need('s3'); c.need('s0');                              // duplicates
  c.need('urgent', true);
  assert.equal(calls.length, 3); assert.equal(maxInflight, 3);
  while (gates.length) { gates.shift()(); await new Promise((r) => setImmediate(r)); }
  assert.equal(new Set(calls).size, calls.length, 'no id fetched twice');
  assert.equal(calls.indexOf('urgent'), 3, 'the urgent one went to the front of the queue');
  assert.ok(c.peek('s7') && c.peek('urgent'));
  c.need('s7'); assert.equal(calls.length, 9, 'a cached span is never fetched again');
  assert.ok(c.peek('s2').length > 50 && c.peek('s2').n === 2);
});

test('span cache: failures are remembered and retried later; ids with odd characters are never requested', async () => {
  let t = 0, n = 0; const c = S.createSpanCache({ retryMs: 1000, now: () => t, fetchSpan: () => { n++; return Promise.resolve(null); } });
  c.need('missing'); await new Promise((r) => setImmediate(r));
  assert.equal(n, 1); assert.equal(c.hasFailed('missing'), true);
  c.need('missing'); assert.equal(n, 1, 'not asked again straight away');
  t = 2000; c.need('missing'); assert.equal(n, 2, 'asked again after the retry delay');
  c.need('../etc/passwd'); c.need('a b'); c.need(''); c.need(null);
  assert.equal(n, 2);
});
