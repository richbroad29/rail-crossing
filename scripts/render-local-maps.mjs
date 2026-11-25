#!/usr/bin/env node
// Makes each crossing page's local map picture (burger-menu ticket 12): ~550 m across (zoom 15), centred on
// the crossing, the crossing unmistakable, nearby named businesses from OpenStreetMap (cafés, pubs,
// shops, supermarkets, petrol stations, pharmacies; nearest 8), the street map in /map's calm light
// look (the site's colours, read from shared/theme.css since the 2026-11 rebrand), and the OpenStreetMap credit. Writes <id>/local-map.webp and <id>/local-map.json (what is
// on it, for the page's alt text). scripts/build-crossings.js puts it in the About block.
//
// Run on the Mac (needs Google Chrome; ~20 s a crossing), after `node scripts/build-crossings.js`,
// then run build-crossings.js again so the pages show the pictures:
//   node scripts/render-local-maps.mjs             every crossing with a page (live or coming soon)
//   node scripts/render-local-maps.mjs --missing   only those without a picture yet
//   node scripts/render-local-maps.mjs portslade   one, by its page address
// It opens a real Chrome window OFF-SCREEN: MapLibre does not draw in headless Chrome here, nor in
// a hidden tab (both learned 2026-11-12). Remake at each twice-yearly check: businesses change.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Zoom 15 shows about 550 m x 360 m at UK latitudes (2026-11-23: Rich asked for more local context
// than 16.4, which showed only ~200 m x 140 m, though this line used to say 400 m). MapLibre's world is
// 512 px wide at zoom 0, so one CSS pixel is 40,075 km x cos(latitude) / (512 x 2^zoom).
const W = 360, H = 240;
const argv = process.argv.slice(2);
const opt = name => { const a = argv.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const ZOOM = Number(opt('zoom') || 15);
const OUT = opt('out');                            // try a zoom without touching the pages: --out=<dir>
const metresPerPx = lat => 40075016.686 * Math.cos(lat * Math.PI / 180) / (512 * 2 ** ZOOM);
const UA = 'railcrossing.uk local map build';
// The picture's colours and map style come from shared/theme.css, the one list of the site's colours.
const THEME_CSS = readFileSync(join(ROOT, 'shared', 'theme.css'), 'utf8');
// A job name points at the palette (`--rc-text:var(--slate-900)`), so follow var() to the value.
const raw = name => { const m = THEME_CSS.match(new RegExp(`--${name}:\\s*([^;]+);`)); if (!m) throw new Error(`shared/theme.css has no --${name}`); return m[1].trim(); };
const T = name => { let v = raw('rc-' + name); for (let i = 0, r; i < 8 && (r = v.match(/^var\(--([\w-]+)\)$/)); i++) v = raw(r[1]); return v; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MISSING = argv.includes('--missing');
const only = argv.find(a => !a.startsWith('--'));

const dir = JSON.parse(readFileSync(join(ROOT, 'shared', 'directory.json'), 'utf8')).crossings;
// Every crossing with a page: live (id) or coming soon (pg), both at /<slug>/.
const live = dir.map(e => ({ ...e, slug: e.id || e.pg })).filter(e => e.slug && (!only || e.slug === only) &&
  !(MISSING && existsSync(join(ROOT, e.slug, 'local-map.webp'))));
if (!live.length) { console.error('no crossing page' + (only ? ` called ${only}` : '') + (MISSING ? ' without a picture' : '')); process.exit(MISSING ? 0 : 1); }

// ---- landmarks from the OpenStreetMap API (one box per crossing) ---------------------------------
// Named places a local would steer by (Rich, 2026-11-23: "more reference points, e.g. shops"):
// everyday shops, cafés, pubs, takeaways, petrol stations, plus the big landmarks: schools,
// churches, parks, libraries, post offices. OpenStreetMap's shop=* also covers betting shops,
// salons, estate agents and so on, which are left off.
const KINDS = { cafe: 'café', pub: 'pub', bar: 'bar', restaurant: 'restaurant', fast_food: 'takeaway', fuel: 'petrol station',
  pharmacy: 'pharmacy', post_office: 'post office', library: 'library', school: 'school', college: 'college',
  place_of_worship: 'church', community_centre: 'community centre', hospital: 'hospital', cinema: 'cinema',
  theatre: 'theatre', police: 'police station', fire_station: 'fire station' };
const SHOPS = { supermarket: 'supermarket', convenience: 'shop', newsagent: 'newsagent', bakery: 'bakery', butcher: 'butcher',
  greengrocer: 'greengrocer', deli: 'deli', kiosk: 'shop', alcohol: 'off-licence', general: 'shop', chemist: 'chemist',
  hardware: 'hardware shop', doityourself: 'DIY store', garden_centre: 'garden centre', department_store: 'department store' };
const LEISURE = { park: 'park', sports_centre: 'sports centre', recreation_ground: 'recreation ground' };
const kindOf = t => KINDS[t.amenity] || SHOPS[t.shop] || LEISURE[t.leisure] || (t.tourism === 'hotel' ? 'hotel' : t.tourism === 'museum' ? 'museum' : null);
const unxml = s => s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const tagsOf = body => Object.fromEntries([...body.matchAll(/<tag k="([^"]+)" v="([^"]*)"\/>/g)].map(t => [t[1], unxml(t[2])]));
async function businesses(e, shrink = 1) {
  // The picture's own extent, a tenth wider each way. A dense town centre can pass the API's 50,000-
  // node limit for one box; then try a box half the size (the nearest businesses are what we keep).
  const m = metresPerPx(e.lat) * 1.1 / shrink;
  const dLat = (H / 2) * m / 111320, dLon = (W / 2) * m / (111320 * Math.cos(e.lat * Math.PI / 180));
  const box = [e.lon - dLon, e.lat - dLat, e.lon + dLon, e.lat + dLat].map(v => v.toFixed(6)).join(',');
  const res = await fetch(`https://api.openstreetmap.org/api/0.6/map?bbox=${box}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) {
    if (shrink < 4) return businesses(e, shrink * 2);
    throw new Error(`${e.slug}: OpenStreetMap API ${res.status} for the business box`);
  }
  const xml = await res.text();
  // Every node's position (a way's shape is a list of them), then the tagged nodes and ways: shops are
  // often mapped as the building outline, and schools and parks nearly always are. A way stands at
  // the average of its points.
  const at = new Map();
  for (const m of xml.matchAll(/<node id="(\d+)"[^>]*?lat="([\d.-]+)" lon="([\d.-]+)"/g)) at.set(m[1], [+m[2], +m[3]]);
  const found = [];
  for (const m of xml.matchAll(/<node id="(\d+)"[^>]*?lat="([\d.-]+)" lon="([\d.-]+)"[^>]*?>([\s\S]*?)<\/node>/g))
    found.push({ tags: tagsOf(m[4]), lat: +m[2], lon: +m[3] });
  for (const m of xml.matchAll(/<way id="\d+"[^>]*?>([\s\S]*?)<\/way>/g)) {
    const pts = [...m[1].matchAll(/<nd ref="(\d+)"\/>/g)].map(r => at.get(r[1])).filter(Boolean);
    if (pts.length) found.push({ tags: tagsOf(m[1]), lat: pts.reduce((a, p) => a + p[0], 0) / pts.length, lon: pts.reduce((a, p) => a + p[1], 0) / pts.length });
  }
  const out = [], seen = new Set();
  for (const f of found) {
    const kind = kindOf(f.tags), name = f.tags.name;
    if (!kind || !name || seen.has(name)) continue;      // one of each name: a chain twice is clutter
    seen.add(name);
    const d = Math.hypot((f.lon - e.lon) * Math.cos(e.lat * Math.PI / 180), f.lat - e.lat) * 111320;
    out.push({ name, kind, lat: f.lat, lon: f.lon, d: Math.round(d) });
  }
  // Leave out any the crossing's own marker and label would cover, and any whose name would run off
  // the bottom edge or under the credit line. The map then drops any whose name doesn't fit.
  return out.filter(b => !underMarker(e, b) && inPicture(e, b, 44)).sort((a, b) => a.d - b.d).slice(0, 14);
}
// Where a point lands in the picture, in CSS pixels from the crossing (y downwards).
function offsetPx(e, p) {
  const m = metresPerPx(e.lat);
  return { x: (p.lon - e.lon) * 111320 * Math.cos(e.lat * Math.PI / 180) / m, y: -(p.lat - e.lat) * 111320 / m };
}
// The marker is a 28 px dot with a white two-line label ("Level crossing / <road>") under it, about
// 20 to 54 px below the point; a business's own name hangs ~25 px under its dot. Keep clear of both.
// The marker (2026-11-23, made smaller for the wider view): an 18 px dot with a 5 px halo, and a white
// two-line label ("Level crossing / <road>") about 13 to 40 px below the point. A landmark's own name
// hangs ~20 px under its dot, so keep landmarks clear of the label by that much more.
const labelWidth = e => Math.max(70, String(e.road || '').length * 5.6) + 10;
function underMarker(e, p) {
  const { x, y } = offsetPx(e, p);
  return Math.abs(x) < labelWidth(e) / 2 + 22 && y > -30 && y < 44;
}
function inPicture(e, p, bottom) {
  const { x, y } = offsetPx(e, p);
  return Math.abs(x) < W / 2 - 40 && y > -H / 2 + 8 && y < H / 2 - bottom;
}
// Stations inside the picture, from the same NaPTAN list the pages use (scripts/data/stations.json).
const STATIONS = JSON.parse(readFileSync(join(ROOT, 'scripts', 'data', 'stations.json'), 'utf8')).stations;
function stationsIn(e) {
  return STATIONS.filter(st => inPicture(e, st, 20));
}

// ---- the page Chrome draws --------------------------------------------------------------------
function page(e, biz, stns) {
  const pts = { type: 'FeatureCollection', features: biz.map(b => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [b.lon, b.lat] }, properties: { name: b.name } })) };
  const stp = { type: 'FeatureCollection', features: stns.map(st => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [st.lon, st.lat] }, properties: { name: `${st.name} station` } })) };
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css">
<style>@font-face{font-family:'Schibsted Grotesk';font-weight:400 900;src:url(/shared/fonts/schibsted-grotesk-latin.woff2) format('woff2')}
html,body{margin:0;background:${T('map-sea')}}#m{width:${W}px;height:${H}px}
.lx{width:13px;height:13px;border-radius:50%;background:${T('lamp')};border:2.5px solid #fff;box-shadow:0 0 0 1.5px ${T('text')},0 0 0 5px rgba(220,38,38,.35)}
.lxl{position:absolute;top:22px;left:9px;transform:translateX(-50%);white-space:nowrap;text-align:center;background:#fff;color:${T('text')};font:700 9.5px/1.2 'Schibsted Grotesk',-apple-system,system-ui,sans-serif;padding:2px 5px;border-radius:5px;box-shadow:0 1px 4px rgba(0,0,0,.25)}
.cr{position:absolute;right:0;bottom:0;font:9px/1.2 'Schibsted Grotesk',-apple-system,system-ui,sans-serif;color:${T('dim')};background:${T('map-attrib')};padding:1px 4px;border-radius:3px}</style>
<script src="https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js"></script><script src="/map/style.js"></script></head>
<body><div id="m"></div><div class="cr">© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap</div><script>
var map = new maplibregl.Map({ container: 'm', style: 'https://tiles.openfreemap.org/styles/${T('map-base')}', center: [${e.lon}, ${e.lat}],
  zoom: ${ZOOM}, interactive: false, attributionControl: false, fadeDuration: 0, preserveDrawingBuffer: true });
map.on('load', function () {
  RM.style.planStyle(map.getStyle(), '${T('map-plan')}').forEach(function (o) { try { if (!map.getLayer(o.id)) return;
    if (o.op === 'visibility') map.setLayoutProperty(o.id, 'visibility', o.value); else if (o.op === 'paint') map.setPaintProperty(o.id, o.prop, o.value);
    else if (o.op === 'minzoom') map.setLayerZoomRange(o.id, o.min, 24); else if (o.op === 'filter') map.setFilter(o.id, o.value); } catch (x) {} });
  // Road names: the base style labels a road at most once every 350 px, wider than this whole picture,
  // so most streets went unnamed. Every 120 px gives each street a chance to fit somewhere.
  ['highway_name_other', 'highway_name_motorway'].forEach(function (id) { if (map.getLayer(id)) {
    map.setLayoutProperty(id, 'symbol-spacing', 120); map.setLayoutProperty(id, 'text-padding', 1); } });
  map.addSource('biz', { type: 'geojson', data: ${JSON.stringify(pts)} });
  map.addLayer({ id: 'biz-dot', type: 'circle', source: 'biz', paint: { 'circle-radius': 3.5, 'circle-color': '${T('warn')}', 'circle-stroke-color': '#FFFFFF', 'circle-stroke-width': 1.2 } });
  map.addLayer({ id: 'biz-name', type: 'symbol', source: 'biz', layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 10,
    'text-variable-anchor': ['top', 'bottom', 'right', 'left'], 'text-radial-offset': 0.55, 'text-max-width': 8, 'text-padding': 1 }, paint: { 'text-color': '${T('warn')}', 'text-halo-color': '#FFFFFF', 'text-halo-width': 1.5 } });
  // Stations last, so their names win any clash with a business (the top layer is placed first).
  map.addSource('stn', { type: 'geojson', data: ${JSON.stringify(stp)} });
  map.addLayer({ id: 'stn-dot', type: 'circle', source: 'stn', paint: { 'circle-radius': 4, 'circle-color': '#FFFFFF', 'circle-stroke-color': '${T('pin-live')}', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'stn-name', type: 'symbol', source: 'stn', layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': 10.5,
    'text-variable-anchor': ['top', 'bottom', 'right', 'left', 'top-right', 'top-left', 'bottom-right', 'bottom-left'], 'text-radial-offset': 0.7, 'text-max-width': 9 },
    paint: { 'text-color': '${T('text')}', 'text-halo-color': '#FFFFFF', 'text-halo-width': 1.8 } });
  // The crossing's dot and label are HTML on top of the map, so the map can't see them when it works
  // out where names fit. Transparent images the size of them, in the top layers (placed first), make
  // every name keep clear of them, moving to another side where it can (text-variable-anchor).
  // Two boxes, hugging the dot (with its halo) and the white label under it, so a name can still sit
  // beside them: one big box round both would push out a station right next to the crossing.
  map.addImage('lx-dot', { width: 30, height: 30, data: new Uint8Array(30 * 30 * 4) });
  map.addImage('lx-lab', { width: ${Math.ceil(labelWidth(e)) + 4}, height: 30, data: new Uint8Array(${(Math.ceil(labelWidth(e)) + 4) * 30 * 4}) });
  map.addSource('lxb', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'Point', coordinates: [${e.lon}, ${e.lat}] }, properties: {} } });
  map.addLayer({ id: 'lx-lab', type: 'symbol', source: 'lxb', layout: { 'icon-image': 'lx-lab', 'icon-allow-overlap': true, 'icon-anchor': 'top', 'icon-offset': [0, 12] } });
  map.addLayer({ id: 'lx-dot', type: 'symbol', source: 'lxb', layout: { 'icon-image': 'lx-dot', 'icon-allow-overlap': true } });
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
  if (u.pathname === '/shared/fonts/schibsted-grotesk-latin.woff2') { res.writeHead(200, { 'content-type': 'font/woff2' }); return res.end(readFileSync(join(ROOT, 'shared', 'fonts', 'schibsted-grotesk-latin.woff2'))); }
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
    const stns = stationsIn(e);
    pages[`/${e.slug}.html`] = page(e, biz, stns);
    await send('Page.navigate', { url: `http://127.0.0.1:${sport}/${e.slug}.html` });
    let ok = false;
    for (let i = 0; i < 60 && !ok; i++) {
      await sleep(500);
      const r = await send('Runtime.evaluate', { expression: '!!window.__done', returnByValue: true });
      ok = r.result && r.result.result && r.result.result.value === true;
    }
    if (!ok) throw new Error(`${e.slug}: the map did not finish drawing in 30 s`);
    await sleep(500);
    const shownR = await send('Runtime.evaluate', { expression: 'window.__shown', returnByValue: true });
    const shown = new Set((shownR.result && shownR.result.result && shownR.result.result.value) || []);
    biz.splice(0, biz.length, ...biz.filter(b => shown.has(b.name)));
    const shot = await send('Page.captureScreenshot', { format: 'webp', quality: 82, clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
    const dest = OUT ? join(OUT, e.slug) : join(ROOT, e.slug);
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'local-map.webp'), Buffer.from(shot.result.data, 'base64'));
    writeFileSync(join(dest, 'local-map.json'), JSON.stringify({
      _generated: 'scripts/render-local-maps.mjs; do not edit', made: new Date().toISOString().slice(0, 10),
      zoom: ZOOM, widthMetres: Math.round(W * metresPerPx(e.lat) / 50) * 50,
      stations: stns.map(st => st.name),
      businesses: biz.map(b => ({ name: b.name, kind: b.kind, metres: b.d }))
    }, null, 2) + '\n');
    console.log(`${e.slug}: local-map.webp, ${stns.length} station(s), ${biz.length} businesses (${biz.map(b => b.name).join(', ') || 'none'})`);
  }
} finally { ws.close(); chrome.kill(); server.close(); }
