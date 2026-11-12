#!/usr/bin/env node
'use strict';

// Generates every crossing's public files from its definition.
//
// A crossing is defined ONCE, in backend/config/crossings/<id>.json on the backend-v2 branch
// (docs/crossing-definition.md). Its `presentation` block plus a few backend fields, joined by
// its `crossingNumber` to its row in scripts/crossing-list.csv (position, town, council, county,
// country, Network Rail type), are all the website needs; this script writes, for every crossing:
//
//   <id>/index.html           the crossing's page — scripts/templates/crossing-page.html with
//                             its title, description and link-preview tags written into the page
//                             (link previews and search engines do not run the page's code)
//   <id>/manifest.webmanifest its home-screen app file
//
// and, across all crossings:
//
//   shared/crossings.json     the website's settings — only the fields the pages read
//   shared/directory.json     the crossing directory: every road crossing in Great Britain from
//                             scripts/crossing-list.csv (excluded rows left out), the listed live
//                             ones carrying their page id. Read by the homepage and the menu.
//   index.html                the home page's list of crossings, between its markers
//   sitemap.xml, robots.txt   so search engines can find every listed crossing
//
// Asset links in generated pages carry the token already in use (read from index.html), so a
// rebuild alone never forces browsers to re-download unchanged code. When the shared code has
// changed, run scripts/bump-assets.sh as before — it stamps every crossing page.
//
// Generated files are committed; there is no build step on deploy. Never edit them by hand.
//
// Usage (from the repo root):
//   node scripts/build-crossings.js                 definitions from origin/backend-v2 (git fetch first)
//   node scripts/build-crossings.js --defs <dir>    definitions from a folder, e.g. a backend-v2 worktree
//   node scripts/build-crossings.js --check         write nothing; exit 1 if any file would change

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SITE = 'https://railcrossing.uk';
const DEFS_REF = 'origin/backend-v2';
const DEFS_PATH = 'backend/config/crossings';
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const LIST_PATH = path.join(ROOT, 'scripts', 'crossing-list.csv');

const args = process.argv.slice(2);
const argVal = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const CHECK = args.includes('--check');

// ---- definitions -----------------------------------------------------------------------
function loadDefinitions() {
  const dir = argVal('--defs');
  const files = {};
  if (dir) {
    for (const f of fs.readdirSync(dir)) files[f] = fs.readFileSync(path.join(dir, f), 'utf8');
  } else {
    const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });
    for (const p of git('ls-tree', '--name-only', `${DEFS_REF}:${DEFS_PATH}`).split('\n').filter(Boolean)) {
      files[p] = git('show', `${DEFS_REF}:${DEFS_PATH}/${p}`);
    }
  }
  const defs = {};
  for (const [f, text] of Object.entries(files).sort()) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -5);
    if (!ID_RE.test(id)) continue;                   // e.g. <id>.timings.json
    defs[id] = JSON.parse(text);
  }
  if (!Object.keys(defs).length) throw new Error('no crossing definitions found');
  return defs;
}

const REQUIRED = ['appName', 'appShortName', 'stationName', 'confidenceWindows'];
function check(id, d) {
  const p = d.presentation;
  if (!p) throw new Error(`${id}: no presentation block`);
  for (const k of REQUIRED) if (p[k] == null) throw new Error(`${id}: presentation.${k} missing`);
  for (const k of ['name', 'road', 'feedbackUrl']) if (!d[k]) throw new Error(`${id}: ${k} missing`);
}

// ---- the crossing list -----------------------------------------------------------------
// scripts/crossing-list.csv: one row per Network Rail crossing number, edited never regenerated
// (.claude/skills/crossing-directory-refresh). RFC 4180: quoted fields may hold commas, quotes
// ("" inside quotes) and newlines.
function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = ''; rows.push(row); row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter(r => r.length > 1 || r[0]);
  return body.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] == null ? '' : r[i]])));
}
function loadList() {
  const byNumber = {};
  for (const r of parseCsv(fs.readFileSync(LIST_PATH, 'utf8'))) byNumber[r.uid] = r;
  return byNumber;
}

// Every live crossing's row, by its crossing number. The build stops here rather than publish a
// crossing whose identity is missing, unknown, excluded or shared: that is the guard that keeps a
// list refresh from silently dropping or renumbering a live crossing.
function joinList(defs, list) {
  const rows = {}, seen = {};
  for (const [id, d] of Object.entries(defs)) {
    const n = d.crossingNumber == null ? '' : String(d.crossingNumber);
    if (!n) throw new Error(`${id}: crossingNumber missing (its Network Rail crossing number, e.g. Portslade 1950)`);
    const r = list[n];
    if (!r) throw new Error(`${id}: crossing number ${n} is not in scripts/crossing-list.csv`);
    if (r.excluded === 'yes') throw new Error(`${id}: crossing number ${n} is marked excluded in the list (${r.exclude_reason})`);
    if (seen[n]) throw new Error(`${id}: crossing number ${n} is also used by ${seen[n]}`);
    for (const k of ['town', 'local_authority', 'ceremonial_county', 'country', 'lat', 'lon', 'type'])
      if (!r[k]) throw new Error(`${id}: crossing ${n} has no ${k} in the list`);
    seen[n] = id; rows[id] = r;
  }
  return rows;
}

// What locals call the county: the ceremonial county in England, the council in Wales and
// Scotland, where the ceremonial names (Clwyd, Inverness) are legal but not everyday (ticket 09).
const countyOf = r => r.country === 'England' ? r.ceremonial_county : r.local_authority;
// "Boundary Road, Portslade by Sea, Brighton and Hove, East Sussex": the council is shown too when
// it differs from the county, because it is often what people search ("Brighton").
function whereLine(road, r) {
  const parts = [road, r.town];
  if (r.local_authority && r.local_authority !== countyOf(r) && r.local_authority !== r.town) parts.push(r.local_authority);
  parts.push(countyOf(r));
  return parts.filter(Boolean).join(', ');
}

// Network Rail's type codes in plain words. A live crossing of a type not listed here stops the
// build, so the words are written (and checked) when such a crossing launches.
const TYPE_WORDS = {
  'CCTV':   ['MCB-CCTV', 'Barriers lowered by a signaller watching the crossing on CCTV'],
  'MCB/MB': ['MCB', 'Barriers lowered by a signaller who can see the crossing'],
  'MCBR':   ['MCB-R', 'Barriers lowered by a signaller who can see the crossing'],
  'MCBOD':  ['MCB-OD', 'Barriers lowered by the signaller, with obstacle detection checking the crossing is clear'],
  'AHB':    ['AHB', 'Automatic half barriers, lowered by approaching trains'],
  'AHB-X':  ['AHB', 'Automatic half barriers, lowered by approaching trains'],
  'ABCL':   ['ABCL', 'Automatic barriers, checked by the train driver'],
  'ABCL-X': ['ABCL', 'Automatic barriers, checked by the train driver'],
  'AFBCL':  ['AFBCL', 'Automatic full barriers, checked by the train driver']
};
function typeOf(id, r) {
  const t = TYPE_WORDS[r.type];
  if (!t) throw new Error(`${id}: no plain-words description for Network Rail type ${r.type}; add it to TYPE_WORDS`);
  return t;
}

// The page's own values, generated from definition + list. A definition may override the title
// or description (presentation.pageTitle / .description) when the pattern reads badly.
function pageFacts(id, d, r) {
  const p = d.presentation, county = countyOf(r);
  const [typeCode, typeWords] = typeOf(id, r);
  return {
    pageTitle: p.pageTitle || `${d.name}, ${d.road}: live barrier times`,
    description: p.description ||
      `When will the barriers at ${d.name} (${d.road}, ${r.town}, ${county}) next go down? Live predictions from train times and railway signalling.`,
    where: whereLine(d.road, r), county, typeCode, typeWords
  };
}

// Structured data (burger-menu ticket 12): the page is about a Place that is a level crossing
// (schema.org has no such type; Wikidata Q171448 says it), plus the Home > crossing trail. Every
// value is also visible on the page. `<` is escaped so no value can close the script tag.
function jsonLd(id, d, r, f) {
  const url = `${SITE}/${id}/`;
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebPage', '@id': url, url, name: f.pageTitle, description: f.description,
        isPartOf: { '@type': 'WebSite', name: 'railcrossing.uk', url: `${SITE}/` },
        about: { '@type': 'Place', name: d.name, additionalType: 'https://www.wikidata.org/wiki/Q171448',
          geo: { '@type': 'GeoCoordinates', latitude: Number(r.lat), longitude: Number(r.lon) },
          address: { '@type': 'PostalAddress', streetAddress: d.road, addressLocality: r.town,
            addressRegion: f.county, addressCountry: 'GB' } } },
      { '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
        { '@type': 'ListItem', position: 2, name: d.name, item: url }] }
    ]
  }, null, 1).replace(/</g, '\\u003c');
}

// ---- outputs ---------------------------------------------------------------------------
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page(id, d, r, template) {
  const p = d.presentation, f = pageFacts(id, d, r);
  const vals = {
    id, name: d.name, road: d.road, roadLabel: p.roadLabel || d.road.toUpperCase(),
    pageTitle: f.pageTitle, description: f.description, appShortName: p.appShortName,
    url: `${SITE}/${id}/`, where: f.where, stationName: p.stationName,
    typeCode: f.typeCode, typeWords: f.typeWords, directoryUrl: `../${directoryUrl}`
  };
  const raw = { jsonLd: jsonLd(id, d, r, f) };                   // {{{x}}}: inserted unescaped
  const body = template.replace(/^<!--[\s\S]*?-->\n/, '');     // drop the template's own header
  return body
    .replace(/\{\{\{(\w+)\}\}\}/g, (m, k) => {
      if (!(k in raw)) throw new Error(`template value {{{${k}}}} has no source`);
      return raw[k];
    })
    .replace(/\{\{(\w+)\}\}/g, (m, k) => {
      if (!(k in vals)) throw new Error(`template value {{${k}}} has no source`);
      return esc(vals[k]);
    });
}

function manifest(id, d, r) {
  const p = d.presentation, f = pageFacts(id, d, r);
  return `{
  "name": ${JSON.stringify(p.appName)},
  "short_name": ${JSON.stringify(p.appShortName)},
  "description": ${JSON.stringify(f.description)},
  "id": ${JSON.stringify(`/${id}/`)},
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#0F172A",
  "theme_color": "#0F172A",
  "icons": [
    { "src": "../shared/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "../shared/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "../shared/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
`;
}

// The website settings: exactly what the pages read (shared/crossing.js, predict.js, the
// observer). No top-level key other than crossing ids — pages look crossings up by id.
function websiteSettings(defs) {
  const out = {};
  for (const [id, d] of Object.entries(defs)) {
    const p = d.presentation, t = d.timing || {};
    const e = {
      _generated: `From backend/config/crossings/${id}.json by scripts/build-crossings.js. Do not edit; edit the definition and rebuild.`,
      name: d.name,
      road: d.road,
      station: d.ldb && d.ldb.station ? d.ldb.station : null
    };
    // ?debug=1 panel only: the legacy minute-based estimate.
    if (t.closeBefore != null) e.closeBefore = t.closeBefore;
    if (t.openAfter != null) e.openAfter = t.openAfter;
    if (p.debugOpenAfterFreightMins != null) e.openAfterFreight = p.debugOpenAfterFreightMins;
    // Each direction slot, in definition order, as the pages draw it (shared/predict.js
    // setDirections): arrow/marker/colour from presentation.directions, and which board time
    // the feedback picker shows from the backend's directions.<dir>.boardTime. The slot names
    // are the crossing's own; the shared code never names one.
    const look = p.directions || {};
    e.directions = {};
    for (const [slot, dir] of Object.entries(d.directions || {})) {
      e.directions[slot] = { ...(look[slot] || {}) };
      if (dir && dir.boardTime) e.directions[slot].boardTime = dir.boardTime;
    }
    if (p._comment_chain) e._comment_chain = p._comment_chain;
    if (p.chain) e.chain = p.chain;
    if (p._comment_offChainEta) e._comment_offChainEta = p._comment_offChainEta;
    if (p.offChainEta) e.offChainEta = p.offChainEta;
    e.feedbackUrl = d.feedbackUrl;
    if (p._comment_confidenceWindows) e._comment_confidenceWindows = p._comment_confidenceWindows;
    e.confidenceWindows = p.confidenceWindows;
    out[id] = e;
  }
  // Two-space JSON with each berth on one line, as the file has always been laid out.
  return JSON.stringify(out, null, 2)
    .replace(/\{\n\s+"b": [^\[\]]*?\n\s+\}/g, m => m.replace(/\s*\n\s*/g, ' ').replace('{ ', '{').replace(' }', '}'))
    .replace(/\{\n\s+"x": true\n\s+\}/g, '{"x": true}')
    .replace(/\{\n\s+("q1": \d+),\n\s+("med": \d+),\n\s+("q3": \d+)\n\s+\}/g, '{$1, $2, $3}') + '\n';
}

// The home page's list, exactly as its old script built it at load time (now written into
// the page, so it shows without code and search engines can follow the links).
function landingList(defs) {
  return Object.entries(defs)
    .filter(([, d]) => d.presentation.listed !== false)
    .map(([id, d]) => `<li><a class="crossing-link" href="${esc(id)}/"><h3>${esc(d.name)}</h3><span>${esc(d.road)} · Station: ${esc(d.ldb && d.ldb.station ? d.ldb.station : '—')}</span></a></li>`)
    .join('');
}

function sitemap(defs) {
  const urls = [`${SITE}/`].concat(Object.entries(defs).filter(([, d]) => d.presentation.listed !== false).map(([id]) => `${SITE}/${id}/`));
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + urls.map(u => `  <url><loc>${u}</loc></url>`).join('\n') + '\n</urlset>\n';
}

// ---- the crossing directory (burger-menu tickets 06, 07, 08) ------------------------------
// One entry per crossing number. Shown fields: n (number), name, road (null = unnamed: the app
// shows "Name, Town" instead), town, la (council), cc (ceremonial county), country, county (the
// one locals use), lat, lon, id (only on a LISTED live crossing: its page). Search-only: alt, the
// other names the road goes by (the list's own road where a definition overrides it, its number,
// the other source's name, its Welsh name). A live crossing takes its name and road from its
// definition (ticket 07); an unlisted one stays coming soon.
function directory(defs, rows, list) {
  const live = {};
  for (const [id, d] of Object.entries(defs)) live[d.crossingNumber] = { id, d };
  const out = [];
  for (const r of Object.values(list)) {
    if (r.excluded === 'yes') continue;
    const L = live[r.uid];
    const listRoad = r.road_relation === 'unnamed' ? null : r.road_relation === 'off' ? `off ${r.road}` : r.road;
    const road = L ? L.d.road : listRoad;
    const alt = [...new Set([listRoad && r.road_relation !== 'off' ? r.road : null, r.road_relation === 'off' ? r.road : null,
      r.road_ref, r.road_alt, r.road_alt_lang].filter(v => v && v !== road))];
    const e = { n: Number(r.uid), name: L ? L.d.name : r.display_name, road, town: r.town,
      la: r.local_authority, cc: r.ceremonial_county, country: r.country, county: countyOf(r),
      lat: Number(Number(r.lat).toFixed(5)), lon: Number(Number(r.lon).toFixed(5)) };
    if (alt.length) e.alt = alt;
    if (L && L.d.presentation.listed !== false) e.id = L.id;
    out.push(e);
  }
  out.sort((a, b) => a.n - b.n);
  const body = out.map(e => JSON.stringify(e)).join(',\n');
  return `{"_licence":"Crossing list: Network Rail, OGL v3. Road and town names: OpenStreetMap contributors, ODbL 1.0 (this file is offered under ODbL). Also OS Open Roads, OS Boundary-Line and ONS built-up areas: Crown copyright and database right 2026, OGL v3.",\n"_generated":"scripts/build-crossings.js from scripts/crossing-list.csv; do not edit",\n"crossings":[\n${body}\n]}\n`;
}
// Pages fetch the directory as shared/directory.json?v=<hash of its content>, so a page and the
// directory it was built with always travel together through Pages' 10-minute cache.
const directoryVersion = text => crypto.createHash('sha1').update(text).digest('hex').slice(0, 10);

const ROBOTS = `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`;
const LIST_START = '<!-- crossings:start (generated by scripts/build-crossings.js) -->';
const LIST_END = '<!-- crossings:end -->';

// ---- main ------------------------------------------------------------------------------
const defs = loadDefinitions();
for (const [id, d] of Object.entries(defs)) check(id, d);
const LIST = loadList();
const rows = joinList(defs, LIST);
const directoryText = directory(defs, rows, LIST);
const directoryUrl = `shared/directory.json?v=${directoryVersion(directoryText)}`;
const template = fs.readFileSync(path.join(__dirname, 'templates', 'crossing-page.html'), 'utf8');

const token = (fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').match(/shared\/[A-Za-z0-9._-]+\.css\?v=(\d+)/) || [])[1];
const writes = {};
for (const [id, d] of Object.entries(defs)) {
  writes[`${id}/index.html`] = page(id, d, rows[id], template);
  writes[`${id}/manifest.webmanifest`] = manifest(id, d, rows[id]);
}
writes['shared/crossings.json'] = websiteSettings(defs);
writes['shared/directory.json'] = directoryText;
const landing = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const a = landing.indexOf(LIST_START), b = landing.indexOf(LIST_END);
if (a < 0 || b < a) throw new Error(`index.html: list markers not found`);
writes['index.html'] = landing.slice(0, a + LIST_START.length) + landingList(defs) + landing.slice(b);
writes['sitemap.xml'] = sitemap(defs);
writes['robots.txt'] = ROBOTS;

// Asset stamps: generated pages come out unstamped; give them the token already in use.
const stamp = text => token ? text.replace(/((?:src|href)=")((?:\.\.\/)*shared\/[A-Za-z0-9._-]+\.(?:js|css))(?:\?v=[^"]*)?"/g, `$1$2?v=${token}"`) : text;
for (const k of Object.keys(writes)) if (k.endsWith('.html')) writes[k] = stamp(writes[k]);

let changed = 0;
for (const [rel, text] of Object.entries(writes)) {
  const full = path.join(ROOT, rel);
  const before = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
  if (before === text) continue;
  changed++;
  console.log(`${CHECK ? 'would change' : 'wrote'}  ${rel}`);
  if (!CHECK) { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text); }
}
console.log(`${Object.keys(defs).length} crossing(s), ${changed} file(s) ${CHECK ? 'out of date' : 'written'}${token ? '' : ' — no asset token found: run scripts/bump-assets.sh'}`);
if (CHECK && changed) process.exit(1);
