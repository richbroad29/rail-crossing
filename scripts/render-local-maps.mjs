#!/usr/bin/env node
// Makes each live crossing's local map picture (burger-menu ticket 12): ~400 m across, centred on
// the crossing, the crossing unmistakable, nearby named businesses from OpenStreetMap (cafés, pubs,
// shops, supermarkets, petrol stations, pharmacies; nearest 8), the street map in /map's calm dark
// look, and the OpenStreetMap credit. Writes <id>/local-map.webp and <id>/local-map.json (what is
// on it, for the page's alt text). scripts/build-crossings.js puts it in the About block.
//
// Run on the Mac (needs Google Chrome; ~20 s a crossing), after `node scripts/build-crossings.js`:
//   node scripts/render-local-maps.mjs            every live crossing
//   node scripts/render-local-maps.mjs portslade  one
// It opens a real Chrome window OFF-SCREEN: MapLibre does not draw in headless Chrome here, nor in
// a hidden tab (both learned 2026-11-12). Remake at each twice-yearly check: businesses change.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = 360, H = 240, ZOOM = 16.4;              // ~400 m across at UK latitudes
const UA = 'railcrossing.uk local map build';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const only = process.argv[2];

const dir = JSON.parse(readFileSync(join(ROOT, 'shared', 'directory.json'), 'utf8')).crossings;
const live = dir.filter(e => e.id && (!only || e.id === only));
if (!live.length) { console.error('no live crossing' + (only ? ` called ${only}` : '')); process.exit(1); }

// ---- businesses from the OpenStreetMap API (one small box per crossing) -------------------------
const KINDS = { cafe: 'café', pub: 'pub', fuel: 'petrol station', pharmacy: 'pharmacy' };
// "Shops" = everyday ones someone waiting at or going round a crossing might use; OpenStreetMap's
// shop=* also covers betting shops, salons, estate agents and so on, which are left off.
const SHOPS = { supermarket: 'supermarket', convenience: 'shop', newsagent: 'newsagent', bakery: 'bakery', butcher: 'butcher',
  greengrocer: 'greengrocer', deli: 'deli', kiosk: 'shop', alcohol: 'off-licence', general: 'shop', chemist: 'chemist' };
async function businesses(e) {
  const dLat = 0.0016, dLon = 0.0032;            // a little wider than the picture
  const box = [e.lon - dLon, e.lat - dLat, e.lon + dLon, e.lat + dLat].map(v => v.toFixed(6)).join(',');
  const xml = await (await fetch(`https://api.openstreetmap.org/api/0.6/map?bbox=${box}`, { headers: { 'User-Agent': UA } })).text();
  const out = [];
  for (const m of xml.matchAll(/<node id="(\d+)"[^>]*lat="([\d.-]+)" lon="([\d.-]+)"[^>]*>([\s\S]*?)<\/node>/g)) {
    const tags = Object.fromEntries([...m[4].matchAll(/<tag k="([^"]+)" v="([^"]*)"\/>/g)].map(t => [t[1], t[2]]));
    const kind = KINDS[tags.amenity] || SHOPS[tags.shop] || null;
    if (!kind || !tags.name) continue;
    const lat = +m[2], lon = +m[3];
    const d = Math.hypot((lon - e.lon) * Math.cos(e.lat * Math.PI / 180), lat - e.lat) * 111320;
    out.push({ name: tags.name.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'"), kind, lat, lon, d: Math.round(d) });
  }
  return out.sort((a, b) => a.d - b.d).slice(0, 8);
}

// ---- the page Chrome draws --------------------------------------------------------------------
function page(e, biz) {
  const pts = { type: 'FeatureCollection', features: biz.map(b => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [b.lon, b.lat] }, properties: { name: b.name } })) };
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css">
<style>html,body{margin:0;background:#0c0c0c}#m{width:${W}px;height:${H}px}
.lx{width:22px;height:22px;border-radius:50%;background:#DC2626;border:3px solid #fff;box-shadow:0 0 0 2px #0F172A,0 0 0 9px rgba(220,38,38,.35)}
.lxl{position:absolute;top:34px;left:14px;transform:translateX(-50%);white-space:nowrap;text-align:center;background:#fff;color:#0F172A;font:700 11px/1.25 -apple-system,system-ui,sans-serif;padding:3px 7px;border-radius:6px;box-shadow:0 2px 6px rgba(0,0,0,.5)}
.cr{position:absolute;right:0;bottom:0;font:9px/1.2 -apple-system,system-ui,sans-serif;color:#94A3B8;background:rgba(12,12,12,.75);padding:1px 4px;border-radius:3px}</style>
<script src="https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js"></script><script src="/map/style.js"></script></head>
<body><div id="m"></div><div class="cr">© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap</div><script>
var map = new maplibregl.Map({ container: 'm', style: 'https://tiles.openfreemap.org/styles/dark', center: [${e.lon}, ${e.lat}],
  zoom: ${ZOOM}, interactive: false, attributionControl: false, fadeDuration: 0, preserveDrawingBuffer: true });
map.on('load', function () {
  RM.style.planStyle(map.getStyle(), 'dark').forEach(function (o) { try { if (!map.getLayer(o.id)) return;
    if (o.op === 'visibility') map.setLayoutProperty(o.id, 'visibility', o.value); else if (o.op === 'paint') map.setPaintProperty(o.id, o.prop, o.value);
    else if (o.op === 'minzoom') map.setLayerZoomRange(o.id, o.min, 24); else if (o.op === 'filter') map.setFilter(o.id, o.value); } catch (x) {} });
  map.addSource('biz', { type: 'geojson', data: ${JSON.stringify(pts)} });
  map.addLayer({ id: 'biz-dot', type: 'circle', source: 'biz', paint: { 'circle-radius': 4.5, 'circle-color': '#F59E0B', 'circle-stroke-color': '#0F172A', 'circle-stroke-width': 1.5 } });
  map.addLayer({ id: 'biz-name', type: 'symbol', source: 'biz', layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11,
    'text-anchor': 'top', 'text-offset': [0, 0.6], 'text-max-width': 8 }, paint: { 'text-color': '#FCD34D', 'text-halo-color': '#0c0c0c', 'text-halo-width': 1.5 } });
  var el = document.createElement('div'); el.innerHTML = '<div class="lx"></div><div class="lxl">Level crossing<br>' + ${JSON.stringify(JSON.stringify(e.road || ''))}.slice(1, -1) + '</div>';
  new maplibregl.Marker({ element: el }).setLngLat([${e.lon}, ${e.lat}]).addTo(map);
  // A dot only where its name fitted: labels that collide are dropped by the map, and a dot with no
  // name is noise. Keep the drawn ones, then wait for the redraw.
  map.once('idle', function () {
    var shown = {}; map.queryRenderedFeatures({ layers: ['biz-name'] }).forEach(function (f) { shown[f.properties.name] = 1; });
    window.__shown = Object.keys(shown);
    map.setFilter('biz-dot', ['in', ['get', 'name'], ['literal', window.__shown]]);
    map.once('idle', function () { window.__done = true; });
  });
});
</script></body></html>`;
}

// ---- Chrome, off-screen, driven over the DevTools protocol --------------------------------------
const pages = {};
const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (pages[u.pathname]) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(pages[u.pathname]); }
  if (u.pathname === '/map/style.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(readFileSync(join(ROOT, 'map', 'style.js'))); }
  res.writeHead(404); res.end();
}).listen(0);
const sport = server.address().port;
const port = 9300 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'lmap-'))}`,
  '--window-position=-4000,0', `--window-size=${W + 40},${H + 200}`, '--no-first-run', '--no-default-browser-check',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', 'about:blank'],
  { stdio: 'ignore' });
let target;
for (let i = 0; i < 150 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch {}
}
if (!target) { console.error('Chrome did not start'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const waiting = {};
ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.id && waiting[d.id]) { waiting[d.id](d); delete waiting[d.id]; } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; waiting[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });

try {
  for (const e of live) {
    const biz = await businesses(e);
    pages[`/${e.id}.html`] = page(e, biz);
    await send('Page.navigate', { url: `http://127.0.0.1:${sport}/${e.id}.html` });
    let ok = false;
    for (let i = 0; i < 60 && !ok; i++) {
      await sleep(500);
      const r = await send('Runtime.evaluate', { expression: '!!window.__done', returnByValue: true });
      ok = r.result && r.result.result && r.result.result.value === true;
    }
    if (!ok) throw new Error(`${e.id}: the map did not finish drawing in 30 s`);
    await sleep(500);
    const shownR = await send('Runtime.evaluate', { expression: 'window.__shown', returnByValue: true });
    const shown = new Set((shownR.result && shownR.result.result && shownR.result.result.value) || []);
    biz.splice(0, biz.length, ...biz.filter(b => shown.has(b.name)));
    const shot = await send('Page.captureScreenshot', { format: 'webp', quality: 82, clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
    writeFileSync(join(ROOT, e.id, 'local-map.webp'), Buffer.from(shot.result.data, 'base64'));
    writeFileSync(join(ROOT, e.id, 'local-map.json'), JSON.stringify({
      _generated: 'scripts/render-local-maps.mjs; do not edit', made: new Date().toISOString().slice(0, 10),
      widthMetres: 400, businesses: biz.map(b => ({ name: b.name, kind: b.kind, metres: b.d }))
    }, null, 2) + '\n');
    console.log(`${e.id}: local-map.webp, ${biz.length} businesses (${biz.map(b => b.name).join(', ') || 'none'})`);
  }
} finally { ws.close(); chrome.kill(); server.close(); }
