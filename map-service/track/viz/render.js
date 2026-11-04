#!/usr/bin/env node
'use strict';

// Visual proof for a track pack: renders the graph, station snaps, signals and junction/end nodes over
// OpenFreeMap with headless Chrome (Playwright), and the two overview levels over SE England.
//   node track/viz/render.js PACK OUTDIR [--chrome PATH] [--only name,name]
// Needs network (tiles from tiles.openfreemap.org, maplibre from unpkg) and `npm install` in track/.
// Screenshots are written to OUTDIR (never committed); the overview presence checks are printed and
// written to OUTDIR/overview-checks.json.

const fs = require('fs');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const { chromium } = require('playwright-core');
const { loadPack } = require('../../src/track/pack');
const F = require('../../src/track/format');
const { DEG7, KY, kxAt } = require('../../src/track/geom');

const [packFile, outDir] = process.argv.slice(2);
if (!packFile || !outDir) { console.error('usage: node track/viz/render.js PACK OUTDIR [--chrome PATH] [--only a,b]'); process.exit(2); }
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const CHROME = arg('--chrome', process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const ONLY = (arg('--only', '') || '').split(',').filter(Boolean);
fs.mkdirSync(outDir, { recursive: true });
const pack = loadPack(packFile);
const W = 1440, H = 900;

const HTML = `<!doctype html><meta charset="utf-8"><title>track viz</title>
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css">
<style>html,body,#m{margin:0;height:100%}#legend{position:absolute;left:8px;top:8px;background:#fffd;padding:6px 8px;font:12px system-ui;border-radius:4px;max-width:520px}</style>
<div id="m"></div><div id="legend"></div>
<script src="https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js"></script>
<script>
const map = new maplibregl.Map({ container: 'm', style: 'https://tiles.openfreemap.org/styles/positron', center: [-0.14, 50.83], zoom: 12, attributionControl: false, fadeDuration: 0, canvasContextAttributes: { preserveDrawingBuffer: true } });
window.ready = new Promise(r => map.on('load', r));
window.show = async (spec) => {
  await window.ready;
  for (const id of ['edges','nodes','ends','tunnels','platform','primary','sigs','sigl','stl','ovb','ovm','pl']) if (map.getLayer(id)) map.removeLayer(id);
  for (const id of ['edges','pts','ov']) if (map.getSource(id)) map.removeSource(id);
  document.getElementById('legend').textContent = spec.legend || '';
  if (spec.edges) {
    map.addSource('edges', { type: 'geojson', data: spec.edges });
    map.addLayer({ id: 'edges', type: 'line', source: 'edges', paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 16, 2.2, 19, 4], 'line-color': ['match', ['get', 'cls'], 0, '#0b3c9c', 1, '#00897b', 2, '#e65100', 3, '#e65100', 4, '#8e24aa', '#757575'], 'line-opacity': 0.9 } });
    if (spec.highlightTunnels) map.addLayer({ id: 'tunnels', type: 'line', source: 'edges', filter: ['==', ['get', 'tunnel'], 1], paint: { 'line-width': 5, 'line-color': '#ff00aa', 'line-opacity': 0.35 } });
    map.addSource('pts', { type: 'geojson', data: spec.points });
    map.addLayer({ id: 'nodes', type: 'circle', source: 'pts', filter: ['==', ['get', 'kind'], 'junction'], paint: { 'circle-radius': 2.5, 'circle-color': '#111' } });
    map.addLayer({ id: 'ends', type: 'circle', source: 'pts', filter: ['==', ['get', 'kind'], 'end'], paint: { 'circle-radius': 3.5, 'circle-color': '#d50000', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } });
    map.addLayer({ id: 'platform', type: 'circle', source: 'pts', filter: ['==', ['get', 'kind'], 'platform'], paint: { 'circle-radius': 4.5, 'circle-color': '#ffab00', 'circle-stroke-color': '#000', 'circle-stroke-width': 1 } });
    map.addLayer({ id: 'primary', type: 'circle', source: 'pts', filter: ['==', ['get', 'kind'], 'primary'], paint: { 'circle-radius': 7, 'circle-color': '#00c853', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    map.addLayer({ id: 'sigs', type: 'circle', source: 'pts', filter: ['==', ['get', 'kind'], 'signal'], paint: { 'circle-radius': 3.5, 'circle-color': '#ffd600', 'circle-stroke-color': '#000', 'circle-stroke-width': 1 } });
    map.addLayer({ id: 'pl', type: 'symbol', source: 'pts', filter: ['==', ['get', 'kind'], 'platform'], minzoom: 16.5, layout: { 'text-field': ['get', 'label'], 'text-size': 12, 'text-offset': [0, -1.1], 'text-font': ['Noto Sans Bold'], 'text-allow-overlap': true }, paint: { 'text-halo-color': '#fff', 'text-halo-width': 2 } });
    map.addLayer({ id: 'sigl', type: 'symbol', source: 'pts', filter: ['==', ['get', 'kind'], 'signal'], minzoom: 17, layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-font': ['Noto Sans Regular'] }, paint: { 'text-halo-color': '#fff', 'text-halo-width': 2, 'text-color': '#8a6d00' } });
    map.addLayer({ id: 'stl', type: 'symbol', source: 'pts', filter: ['==', ['get', 'kind'], 'primary'], layout: { 'text-field': ['get', 'label'], 'text-size': 13, 'text-offset': [0, 1.4], 'text-font': ['Noto Sans Bold'], 'text-allow-overlap': true }, paint: { 'text-halo-color': '#fff', 'text-halo-width': 2, 'text-color': '#006400' } });
  }
  if (spec.overview) {
    map.addSource('ov', { type: 'geojson', data: spec.overview });
    map.addLayer({ id: 'ovb', type: 'line', source: 'ov', filter: ['==', ['get', 'class'], 'branch'], paint: { 'line-width': 1.6, 'line-color': '#e53935' } });
    map.addLayer({ id: 'ovm', type: 'line', source: 'ov', filter: ['==', ['get', 'class'], 'main'], paint: { 'line-width': 2.2, 'line-color': '#b71c1c' } });
  }
  map.jumpTo({ center: spec.center, zoom: spec.zoom });
  await new Promise(r => setTimeout(r, 400));
  await new Promise(r => { const t = setTimeout(r, 25000); const check = () => { if (map.loaded() && map.areTilesLoaded()) { clearTimeout(t); r(); } else setTimeout(check, 250); }; check(); });
  await new Promise(r => setTimeout(r, 600));
  return true;
};
</script>`;

// ---- data for a view -----------------------------------------------------------------------------

const mpp = (lat, z) => 78271.517 * Math.cos(lat * Math.PI / 180) / 2 ** z;
function bboxOf(center, zoom, margin = 1.25) {
  const [lon, lat] = center;
  const hw = W / 2 * mpp(lat, zoom) * margin, hh = H / 2 * mpp(lat, zoom) * margin;
  return { s: lat - hh / KY, n: lat + hh / KY, w: lon - hw / (KY * Math.cos(lat * Math.PI / 180)), e: lon + hw / (KY * Math.cos(lat * Math.PI / 180)) };
}
function viewData(center, zoom, { signals = true, platformLabels = true } = {}) {
  const b = bboxOf(center, zoom);
  const lo = (b.s * 1e7), hi = (b.n * 1e7), wl = (b.w * 1e7), el = (b.e * 1e7);
  const edges = [], nodeSeen = new Set(), points = [];
  const inB = (la, lon) => la >= lo && la <= hi && lon >= wl && lon <= el;
  const edgeIn = new Set();
  for (let e = 0; e < pack.nEdges; e++) {
    let hit = false;
    for (let v = pack.evo[e]; v < pack.evo[e + 1]; v++) if (inB(pack.vlat[v], pack.vlon[v])) { hit = true; break; }
    if (!hit) continue;
    edgeIn.add(e);
    edges.push({ type: 'Feature', properties: { cls: pack.ecls[e], tunnel: pack.s.EFLG[e] & F.FLG.TUNNEL ? 1 : 0 }, geometry: { type: 'LineString', coordinates: pack.edgePolyline(e).map(([la, lon]) => [lon, la]) } });
    for (const n of [pack.efrom[e], pack.eto[e]]) {
      if (nodeSeen.has(n)) continue;
      nodeSeen.add(n);
      const deg = pack.edgesAt(n).length;
      points.push({ type: 'Feature', properties: { kind: deg === 1 ? 'end' : deg >= 3 ? 'junction' : 'x' }, geometry: { type: 'Point', coordinates: [pack.s.NLON[n] * DEG7, pack.s.NLAT[n] * DEG7] } });
    }
  }
  for (const t of pack.stationTiplocs()) {
    const st = pack.station(t);
    if (!inB(st.lat * 1e7, st.lon * 1e7)) continue;
    for (const sn of st.snaps) {
      points.push({ type: 'Feature', properties: { kind: sn.primary ? 'primary' : 'platform', label: sn.primary ? `${st.name} (${t})` : (sn.platform || '') }, geometry: { type: 'Point', coordinates: [sn.lon, sn.lat] } });
    }
  }
  if (signals) for (const s of pack.signals()) if (inB(s.lat * 1e7, s.lon * 1e7)) {
    const at = pack.snapAt(s.edge, s.offset);
    points.push({ type: 'Feature', properties: { kind: 'signal', label: s.ref }, geometry: { type: 'Point', coordinates: [at.lon, at.lat] } });
  }
  return { edges: { type: 'FeatureCollection', features: edges }, points: { type: 'FeatureCollection', features: points.filter(p => p.properties.kind !== 'x') } };
}

// ---- overview checks -----------------------------------------------------------------------------

function distToLines(gj, lat, lon) {
  const kx = kxAt(lat * 1e7);
  let best = Infinity;
  for (const f of gj.features) for (const line of f.geometry.coordinates) {
    for (let i = 0; i + 1 < line.length; i++) {
      const ax = (line[i][0] - lon) * kx, ay = (line[i][1] - lat) * KY, bx = (line[i + 1][0] - lon) * kx, by = (line[i + 1][1] - lat) * KY;
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      let t = l2 ? -(ax * dx + ay * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  }
  return best;
}

// ---- the views -----------------------------------------------------------------------------------

const GRAPH_VIEWS = [
  { name: 'brighton-throat', center: [-0.1410, 50.8291], zoom: 16.6, legend: 'Brighton station throat: graph by class (blue main, teal branch, orange siding/yard, purple crossover), black = junction node, red = dead end, green = primary station snap, amber = platform-track snaps (platform ref), yellow = OSM signals (ref)' },
  { name: 'portslade-shoreham', center: [-0.2250, 50.8345], zoom: 13.6, legend: 'Portslade (PSLDAWH) to Shoreham-by-Sea: graph, station snaps, signals' },
  { name: 'portslade-detail', center: [-0.2040, 50.8358], zoom: 17.2, legend: 'Portslade station and Boundary Road: two running tracks, platform snaps 1 and 2' },
  { name: 'clapham-junction', center: [-0.1700, 51.4645], zoom: 16.2, legend: 'Clapham Junction: every platform track is separate' },
  { name: 'marshlink-rye', center: [0.7150, 50.9430], zoom: 12.8, legend: 'Marshlink: Rye - Winchelsea (rural single line)' },
  { name: 'marshlink-rye-detail', center: [0.7305, 50.9525], zoom: 17.0, legend: 'Rye station on the Marshlink: platform snaps and junction nodes' },
  { name: 'marshlink-appledore', center: [0.7800, 51.0300], zoom: 12.3, legend: 'Marshlink: Appledore - Ham Street (single line, passing loop at Rye excluded here)' },
  { name: 'glasgow-central', center: [-4.2578, 55.8590], zoom: 15.6, legend: 'Central Glasgow: Central (high level) and Queen Street' },
  { name: 'clayton-tunnel', center: [-0.1585, 50.9028], zoom: 13.6, legend: 'Clayton Tunnel (Hassocks - Preston Park): tunnel edges highlighted magenta; tunnels are ordinary track in the graph', highlightTunnels: true },
  { name: 'london-core-tunnels', center: [-0.1100, 51.5150], zoom: 13.0, legend: 'Elizabeth line and Thameslink core: tunnel edges (magenta halo) are ordinary graph edges', highlightTunnels: true, signals: false }
];
const OVERVIEW_VIEWS = [
  { name: 'z06', center: [0.2, 51.2], zoom: 6, levels: ['lo', 'hi'] },
  { name: 'z08', center: [0.0, 51.0], zoom: 8, levels: ['lo', 'hi'] },
  { name: 'z10', center: [0.0, 51.05], zoom: 10, levels: ['lo', 'hi'] }
];
const PLACES = [  // station TIPLOCs on lines that the base tiles lose at zoom 8-9
  ['East Grinstead', 'EGRNSTD'], ['Uckfield', 'UCKFILD'], ['Caterham', 'CATERHM'], ['Rye (Marshlink)', 'RYEE'], ['Appledore (Marshlink)', 'APDR'], ['Winchelsea (Marshlink)', 'WINCHLS'],
  ['Pulborough (Arun Valley)', 'PULBRO'], ['Amberley (Arun Valley)', 'AMLY'], ['Arundel', 'ARUNDEL'], ['Ham Street (Marshlink)', 'HMST']
];

(async () => {
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(url, { waitUntil: 'load' });
  const written = [];
  const shoot = async (name, spec) => {
    await page.evaluate(s => window.show(s), spec);
    const f = path.join(outDir, name + '.png');
    await page.screenshot({ path: f });
    written.push(f);
    console.log('wrote', f);
  };
  for (const v of GRAPH_VIEWS) {
    if (ONLY.length && !ONLY.includes(v.name)) continue;
    const d = viewData(v.center, v.zoom, { signals: v.signals !== false });
    await shoot('graph-' + v.name, { ...v, ...d });
  }
  const checks = { places: {}, sizes: {} };
  for (const lvl of ['lo', 'hi']) {
    const gz = pack.network(lvl);
    if (!gz) continue;
    const gj = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
    checks.sizes[lvl] = { gzipBytes: gz.length, rawBytes: zlib.gunzipSync(gz).length };
    for (const [label, t] of PLACES) {
      const st = pack.station(t);
      if (!st) { (checks.places[label] = checks.places[label] || {})[lvl] = 'station not in pack'; continue; }
      (checks.places[label] = checks.places[label] || {})[lvl] = Math.round(distToLines(gj, st.lat, st.lon));
    }
    for (const v of OVERVIEW_VIEWS) {
      if (ONLY.length && !ONLY.includes('overview-' + v.name)) continue;
      await shoot(`overview-${lvl}-${v.name}`, { center: v.center, zoom: v.zoom, overview: gj, legend: `Overview level "${lvl}" over OpenFreeMap, zoom ${v.zoom}: red = main, light red = branch (tunnels not distinguished)` });
    }
  }
  fs.writeFileSync(path.join(outDir, 'overview-checks.json'), JSON.stringify(checks, null, 2));
  console.log('overview checks (metres from the station to the nearest overview line):');
  for (const [label, r] of Object.entries(checks.places)) console.log('  ' + label.padEnd(28), JSON.stringify(r));
  console.log('sizes', JSON.stringify(checks.sizes));
  if (errors.length) console.log('page errors:', errors);
  await browser.close(); srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
