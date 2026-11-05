#!/usr/bin/env node
'use strict';

// Renders the spans of one TD area (the JSON written by dev/spans-report.js --dump) over OpenFreeMap with headless Chrome,
// one colour per berth (neighbouring berths of a chain never share a colour), eastbound spans offset one way and westbound the
// other so that two directions on one track stay visible, stop points as black dots, the berth id on each span.
//
//   node dev/render-spans.js spans-LA.json OUTDIR [--chrome PATH]
//
// Needs `npm install` in track/ (playwright-core), Google Chrome, and the network (tiles, maplibre from unpkg).

const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('../track/node_modules/playwright-core');

const [file, outDir] = process.argv.slice(2);
if (!file || !outDir) { console.error('usage: render-spans.js spans.json OUTDIR [--chrome PATH]'); process.exit(2); }
const ci = process.argv.indexOf('--chrome');
const CHROME = ci > 0 ? process.argv[ci + 1] : process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
fs.mkdirSync(outDir, { recursive: true });
const spans = JSON.parse(fs.readFileSync(file, 'utf8'));
const W = 1440, H = 900;
const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#008080', '#9a6324', '#f032e6'];

// per chain, number the berths in order so neighbours differ
const chains = new Map();
for (const s of spans) { const l = chains.get(s.chain) || []; l.push(s); chains.set(s.chain, l); }
let colorIx = 0;
const features = [], dots = [], labels = [];
for (const list of chains.values()) {
  list.sort((a, b) => a.rule.start === 'stop' && b.rule.start !== 'stop' ? -1 : 0);
  for (const s of list) {
    const east = s.path[s.path.length - 1][1] >= s.path[0][1];
    const color = PALETTE[colorIx++ % PALETTE.length];
    features.push({ type: 'Feature', properties: { berth: s.berth, color, east: east ? 1 : 0, visited: s.visited ? 1 : 0 }, geometry: { type: 'LineString', coordinates: s.path.map(p => [p[1], p[0]]) } });
    const mid = s.path[Math.floor(s.path.length / 2)];
    labels.push({ type: 'Feature', properties: { label: s.berth, east: east ? 1 : 0 }, geometry: { type: 'Point', coordinates: [mid[1], mid[0]] } });
    if (s.stop !== null) { const p = s.stop === 0 ? s.path[0] : s.path[s.path.length - 1]; dots.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [p[1], p[0]] } }); }
  }
}

const HTML = `<!doctype html><meta charset="utf-8"><title>spans</title>
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css">
<style>html,body,#m{margin:0;height:100%}#legend{position:absolute;left:8px;top:8px;background:#fffe;padding:6px 8px;font:12px system-ui;border-radius:4px;max-width:560px}</style>
<div id="m"></div><div id="legend"></div>
<script src="https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js"></script>
<script>
const map = new maplibregl.Map({ container: 'm', style: 'https://tiles.openfreemap.org/styles/positron', center: [-0.17, 50.83], zoom: 12, attributionControl: false, fadeDuration: 0, canvasContextAttributes: { preserveDrawingBuffer: true } });
window.ready = new Promise(r => map.on('load', r));
window.show = async (spec) => {
  await window.ready;
  for (const id of ['spansE','spansW','stops','lbl']) if (map.getLayer(id)) map.removeLayer(id);
  for (const id of ['spans','stops','lbl']) if (map.getSource(id)) map.removeSource(id);
  document.getElementById('legend').textContent = spec.legend;
  map.addSource('spans', { type: 'geojson', data: spec.spans });
  map.addSource('stops', { type: 'geojson', data: spec.dots });
  map.addSource('lbl', { type: 'geojson', data: spec.labels });
  // No offset: a span is drawn where the track IS. Eastbound spans are thick, westbound thin on top, so two directions on one
  // track show as a thin line inside a thick one, and two directions on two tracks show as two lines.
  const line = (id, east, k) => map.addLayer({ id, type: 'line', source: 'spans', filter: ['==', ['get', 'east'], east], layout: { 'line-cap': 'butt' },
    paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.5 * k, 15, 5 * k, 18, 8 * k], 'line-opacity': 0.9 } });
  line('spansE', 1, 1.5); line('spansW', 0, 0.6);
  map.addLayer({ id: 'stops', type: 'circle', source: 'stops', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2, 15, 5], 'circle-color': '#000', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } });
  map.addLayer({ id: 'lbl', type: 'symbol', source: 'lbl', minzoom: spec.labelZoom, layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-offset': ['case', ['==', ['get', 'east'], 1], ['literal', [0, -1.1]], ['literal', [0, 1.1]]], 'text-font': ['Noto Sans Bold'], 'text-allow-overlap': true }, paint: { 'text-halo-color': '#fff', 'text-halo-width': 2 } });
  map.jumpTo({ center: spec.center, zoom: spec.zoom });
  await new Promise(r => setTimeout(r, 400));
  await new Promise(r => { const t = setTimeout(r, 25000); const check = () => { if (map.loaded() && map.areTilesLoaded()) { clearTimeout(t); r(); } else setTimeout(check, 250); }; check(); });
  await new Promise(r => setTimeout(r, 600));
  return true;
};
</script>`;

const VIEWS = [
  { name: 'LA-overview', center: [-0.43, 50.83], zoom: 10.3, labelZoom: 99, legend: 'LA spans: Littlehampton to Brighton. One colour per berth; eastbound thick, westbound thin; black dots are station stop points.' },
  { name: 'LA-shoreham-brighton', center: [-0.2, 50.835], zoom: 12.3, labelZoom: 99, legend: 'Shoreham to Brighton, both directions. One colour per berth.' },
  { name: 'LA-hove-brighton', center: [-0.155, 50.832], zoom: 14.2, labelZoom: 13, legend: 'Hove to Brighton, with berth ids.' },
  { name: 'LA-portslade', center: [-0.205, 50.835], zoom: 15.6, labelZoom: 13, legend: 'Portslade, with berth ids.' },
  { name: 'LA-portslade-platforms', center: [-0.2053, 50.8357], zoom: 18, labelZoom: 13, legend: 'Portslade platforms at zoom 18: eastbound thick, westbound thin.' },
  { name: 'LA-shoreham', center: [-0.265, 50.833], zoom: 14.6, labelZoom: 13, legend: 'Shoreham-by-Sea area, with berth ids.' }
];

(async () => {
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  const page = await (await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${srv.address().port}/`, { waitUntil: 'load' });
  for (const v of VIEWS) {
    await page.evaluate(s => window.show(s), { ...v, spans: { type: 'FeatureCollection', features }, dots: { type: 'FeatureCollection', features: dots }, labels: { type: 'FeatureCollection', features: labels } });
    const f = path.join(outDir, `spans-${v.name}.png`);
    await page.screenshot({ path: f });
    console.log('wrote', f);
  }
  if (errors.length) console.log('page errors:', errors.slice(0, 3));
  await browser.close(); srv.close();
  process.exit(0);
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
