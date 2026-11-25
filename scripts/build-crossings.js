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
//   index.html                the homepage, whole, from scripts/templates/home-page.html
//   manifest.webmanifest      the homepage's app file
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
// The browser-bar and app-splash colours, read from shared/theme.css (the one list of the site's
// colours), because a <meta name="theme-color"> and a web-app manifest cannot refer to CSS.
const THEME = (() => {
  const css = fs.readFileSync(path.join(ROOT, 'shared', 'theme.css'), 'utf8');
  const read = name => {
    const m = css.match(new RegExp(`--rc-${name}:\\s*(#[0-9A-Fa-f]{6})`));
    if (!m) throw new Error(`shared/theme.css has no --rc-${name} colour`);
    return m[1];
  };
  return { browserBar: read('browser-bar'), appSplash: read('app-splash') };
})();
const withTheme = t => t.replace(/\{\{themeColor\}\}/g, THEME.browserBar);
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
  'AOCLB':  ['AOCL+B', 'Automatic half barriers, checked by the train driver'],
  'AFBCL':  ['AFBCL', 'Automatic full barriers, checked by the train driver']
};
// What happens at each type, for coming-soon pages (keyed by the short code above). General facts
// only: no timings, because none are measured for these types yet. A type that is measured at a
// live crossing gets that crossing's figures added (sameTypeFigures). A coming-soon page of a type
// not listed here stops the build, so the words are written (and checked) when its county gets pages.
const TYPE_HOW = {
  'MCB-CCTV': 'A signaller watches the crossing on CCTV, lowers full barriers across the whole road and checks it is clear before the train is allowed through. The barriers come down well before the train arrives, so closures last longer than at an automatic crossing.',
  'MCB':      'A signaller who can see the crossing lowers full barriers across the whole road and checks it is clear before the train is allowed through, so closures last longer than at an automatic crossing.',
  'MCB-R':    'A signaller who can see the crossing lowers full barriers across the whole road and checks it is clear before the train is allowed through, so closures last longer than at an automatic crossing.',
  'MCB-OD':   'A signaller lowers full barriers across the whole road, and radar or laser obstacle detection checks it is clear before the train is allowed through, so closures last longer than at an automatic crossing.',
  'AHB':      'The approaching train lowers the barriers automatically. Half barriers close the left-hand side of the road on each side, and the red lights flash until the train has passed. The barriers come down only shortly before the train arrives.',
  'ABCL':     'The approaching train lowers half barriers automatically, and the train driver checks the crossing is clear, so trains slow down on the approach.',
  'AOCL+B':   'The approaching train lowers half barriers automatically, and the train driver checks the crossing is clear, so trains slow down on the approach.',
  'AFBCL':    'The approaching train lowers full barriers automatically, and the train driver checks the crossing is clear.'
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
    where: whereLine(d.road, r), county, typeCode, typeWords, figures: figuresLine(p.figures)
  };
}

// The measured figures line (ticket 12, Rich's rounding): the closure-length interquartile range
// to the nearest 15 s ("between 2 and 3¾ minutes"), closures per day to the nearest 5, the busiest
// hour as measured. Empty when the definition has no presentation.figures yet.
function minutesWords(secs) {
  const q = Math.round(secs / 15), whole = Math.floor(q / 4), frac = ['', '¼', '½', '¾'][q % 4];
  return whole ? `${whole}${frac}` : (frac || '0');                 // "between ¾ and 2 minutes"
}
function figuresLine(f) {
  if (!f) return '';
  const a = minutesWords(f.downP25Secs), b = minutesWords(f.downP75Secs);
  const perDay = Math.round(f.closuresPerDay / 5) * 5;
  return `50% of closures last between ${a} and ${b} minutes. About ${perDay} closures a day, typically ${f.busiestHour} in the busiest hour. (Recorded by this app, ${f.asOf}.)`;
}

// The site's identity, shared by every page's structured data: one name (the one in every title),
// the other name it goes by, and the logo. Google uses the WebSite block for the site name it shows
// in results and the Organization's logo where it shows one.
const WEBSITE_ID = `${SITE}/#website`, ORG_ID = `${SITE}/#organization`;
const SITE_NAME = 'railcrossing.uk', SITE_ALT_NAME = 'Rail Crossing';
const websiteLd = () => ({ '@type': 'WebSite', '@id': WEBSITE_ID, name: SITE_NAME, alternateName: SITE_ALT_NAME,
  url: `${SITE}/`, publisher: { '@id': ORG_ID } });
const organizationLd = () => ({ '@type': 'Organization', '@id': ORG_ID, name: SITE_NAME, url: `${SITE}/`,
  logo: { '@type': 'ImageObject', url: `${SITE}/shared/icon-512.png`, width: 512, height: 512 } });

// Structured data (burger-menu ticket 12): the page is about a Place that is a level crossing
// (schema.org has no such type; Wikidata Q171448 says it), plus the Home > crossing trail. Every
// value is also visible on the page. `<` is escaped so no value can close the script tag.
function jsonLd(id, d, r, f) {
  const url = `${SITE}/${id}/`;
  const cp = COUNTY_PAGES[f.county];
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebPage', '@id': url, url, name: f.pageTitle, description: f.description,
        isPartOf: { '@id': WEBSITE_ID },
        about: { '@type': 'Place', name: d.name, additionalType: 'https://www.wikidata.org/wiki/Q171448',
          geo: { '@type': 'GeoCoordinates', latitude: Number(r.lat), longitude: Number(r.lon) },
          address: { '@type': 'PostalAddress', streetAddress: d.road, addressLocality: r.town,
            addressRegion: f.county, addressCountry: 'GB' } } },
      websiteLd(),
      organizationLd(),
      breadcrumbLd([['Home', `${SITE}/`], cp && [`${f.county} crossings`, `${SITE}${cp.path}`], [d.name, url]])
    ]
  }, null, 1).replace(/</g, '\\u003c');
}
const breadcrumbLd = items => ({ '@type': 'BreadcrumbList', itemListElement: items.filter(Boolean)
  .map(([name, item], i) => ({ '@type': 'ListItem', position: i + 1, name, item })) });

// ---- outputs ---------------------------------------------------------------------------
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page(id, d, r, template) {
  const p = d.presentation, f = pageFacts(id, d, r);
  const vals = {
    id, name: d.name, road: d.road,
    pageTitle: f.pageTitle, description: f.description, appShortName: p.appShortName,
    url: `${SITE}/${id}/`, where: f.where, stationName: p.stationName,
    typeCode: f.typeCode, typeWords: f.typeWords, figures: f.figures, directoryUrl: `../${directoryUrl}`, crossingNumber: d.crossingNumber
  };
  const station = d.ldb && d.ldb.station;
  const localMap = localMapHtml(id, d.name, d.road, r.town, station, p.stationName);
  const cp = COUNTY_PAGES[f.county];
  const me = DIR.find(x => x.n === Number(d.crossingNumber));
  const raw = { jsonLd: jsonLd(id, d, r, f), localMap, nearby: me ? nearbySections(id, me, DIR) : '',
    countyNav: cp ? `<a data-track="county-link: ${esc(id)} page footer" href="${esc(cp.path)}">${esc(f.county)} crossings</a>` : '',
    figuresRow: f.figures ? `<dt>Closures</dt><dd>${esc(f.figures)}</dd>` : '' };                   // {{{x}}}: inserted unescaped
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

// The local map picture, when scripts/render-local-maps.mjs has made one (ticket 12). NOT lazy: on a
// phone it is the largest thing in the first screen (Google's LCP element), and lazy-loading it
// delays exactly the paint Google times. Tapping it opens the live train map at the station.
function localMapHtml(slug, name, road, town, stationCrs, stationName) {
  const lmPath = path.join(ROOT, slug, 'local-map.json');
  if (!fs.existsSync(lmPath) || !fs.existsSync(path.join(ROOT, slug, 'local-map.webp'))) return '';
  const lm = JSON.parse(fs.readFileSync(lmPath, 'utf8'));
  // Stations first, then up to six landmarks, nearest first (as drawn on the picture).
  const near = (lm.stations || []).map(st => `${st} station`).concat(lm.businesses.slice(0, 6).map(b => b.name));
  const alt = `Street map of about ${lm.widthMetres} metres around ${name}${road ? ` on ${road}` : ''}, ${town}` +
    (near.length ? `, with ${andList(near)} nearby.` : '.');
  const img = `<img src="local-map.webp" width="360" height="240" decoding="async" alt="${esc(alt)}">`;
  return stationCrs
    ? `<a class="about-map" data-track="map-link: ${esc(slug)} local map" href="/map/#s=${esc(stationCrs)}" aria-label="Open the live train map at ${esc(stationName)}">${img}</a>`
    : `<div class="about-map">${img}</div>`;
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
  "background_color": "${THEME.appSplash}",
  "theme_color": "${THEME.browserBar}",
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

// ---- the homepage (burger-menu tickets 05, 08, 11) ----------------------------------------
// Written whole from scripts/templates/home-page.html. Everything that changes with a launch or a
// list refresh (counts, the live crossings, the sentence naming them) is filled in here, never
// typed, so the page can't go stale.
const REQUEST_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSdlD0Bm0jzDolWCKgJ4S3d8Bu9Pa8FCF6VmENbRcHAYHqzEXQ/viewform';
const shortName = d => d.name.replace(/\s+level crossing$/i, '');
function inPlace(r) {           // "in Brighton and Hove (East Sussex)" / "in Gwynedd"
  const c = countyOf(r);
  return r.local_authority && r.local_authority !== c ? `in ${r.local_authority} (${c})` : `in ${c}`;
}
const andList = xs => xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];
function homePage(defs, rows, dirText, dirUrl, template, countyList) {
  const crossings = JSON.parse(dirText).crossings;
  const live = Object.entries(defs).filter(([, d]) => d.presentation.listed !== false);
  const soon = crossings.filter(e => !e.id).length;
  const soonText = soon.toLocaleString('en-GB');
  const liveSentence = live.length === 1
    ? `One so far: ${live[0][1].name}, on ${live[0][1].road} ${inPlace(rows[live[0][0]])}.`
    : `${live.length} so far: ${andList(live.map(([id, d]) => `${d.name} (${rows[id].town})`))}.`;
  const liveAt = live.length <= 3 ? `Live at ${andList(live.map(([, d]) => shortName(d)))}` : `Live at ${live.length} crossings`;
  const description = `See when level crossing barriers will next go down, and for how long. Free live predictions from train times and Network Rail signalling. ${liveAt}, with ${soonText} more crossings across Great Britain coming soon.`;
  // The Live crossings list: real links in the page (crawlable; the screen-reader route), grouped by
  // county past 20 (ticket 05). data-n lets shared/home.js filter it by the search box.
  const rowsLive = live.map(([id, d]) => ({ id, d, r: rows[id], county: countyOf(rows[id]) }))
    .sort((a, b) => a.county.localeCompare(b.county) || a.d.name.localeCompare(b.d.name));
  // data-track: a tap counted in GoatCounter (shared/track.js), named as home.js names a crossing.
  const rowHtml = x => `<a class="pm-row pm-live" data-n="${esc(x.d.crossingNumber)}" data-track="list-tap: ${esc(x.d.name)} (${esc(x.d.road)}, ${esc(x.r.town)}) #${esc(x.d.crossingNumber)}" href="/${esc(x.id)}/"><span class="pm-row-main"><span class="pm-name">${esc(x.d.name)}</span><span class="pm-sub">${esc(x.d.road)}, ${esc(x.r.town)}</span></span><span class="pm-chev" aria-hidden="true">›</span></a>`;
  let body = '', last = null;
  for (const x of rowsLive) {
    if (rowsLive.length > 20 && x.county !== last) { body += `<div class="hp-county">${esc(x.county)}</div>`; last = x.county; }
    body += rowHtml(x);
  }
  const liveList = `      <h2 class="hp-h2" id="liveHdr">Live crossings <span class="hp-count" id="liveCount">${live.length}</span></h2>\n` +
    `      <div id="liveRows">${body}</div>\n      <div class="pm-note" id="liveNone" hidden></div>`;
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      websiteLd(),
      organizationLd(),
      { '@type': 'WebApplication', name: SITE_NAME, url: `${SITE}/`, applicationCategory: 'TravelApplication',
        operatingSystem: 'Any', description, areaServed: { '@type': 'Country', name: 'United Kingdom' },
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'GBP' }, publisher: { '@id': ORG_ID } }
    ]
  }, null, 1).replace(/</g, '\\u003c');
  const vals = { description, directoryUrl: dirUrl, liveCount: String(live.length), soonCountText: soonText,
    liveSentence, requestUrl: REQUEST_URL };
  const raw = { liveList, jsonLd, countyList };
  return template.replace(/^<!--[\s\S]*?-->\n/, '')
    .replace(/\{\{\{(\w+)\}\}\}/g, (m, k) => { if (!(k in raw)) throw new Error(`home template {{{${k}}}} has no source`); return raw[k]; })
    .replace(/\{\{(\w+)\}\}/g, (m, k) => { if (!(k in vals)) throw new Error(`home template {{${k}}} has no source`); return esc(vals[k]); });
}
// The homepage's own app file, so "Add as app" can install it on Android as well as iPhone.
const HOME_MANIFEST = `{
  "name": "railcrossing.uk: level crossing barrier times",
  "short_name": "Crossings",
  "description": "When level crossing barriers will next go down, for every train.",
  "id": "/",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "${THEME.appSplash}",
  "theme_color": "${THEME.browserBar}",
  "icons": [
    { "src": "shared/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "shared/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "shared/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
`;

// <lastmod> is the day the page's content last changed, never the day of the build: Google uses
// lastmod only from sites where it is consistently accurate. A page whose generated file is
// unchanged keeps the date already in sitemap.xml; a changed (or new) page gets today, London time.
function sitemap(pages, changedPages) {         // pages: [[file, url]]
  const smPath = path.join(ROOT, 'sitemap.xml');
  const old = fs.existsSync(smPath) ? fs.readFileSync(smPath, 'utf8') : '';
  const kept = {};
  for (const m of old.matchAll(/<loc>([^<]+)<\/loc><lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>/g)) kept[m[1]] = m[2];
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });     // YYYY-MM-DD
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + pages.map(([file, u]) => `  <url><loc>${u}</loc><lastmod>${changedPages.has(file) || !kept[u] ? today : kept[u]}</lastmod></url>`).join('\n')
    + '\n</urlset>\n';
}

// ---- the crossing directory (burger-menu tickets 06, 07, 08) ------------------------------
// One entry per crossing number. Shown fields: n (number), name, road (null = unnamed: the app
// shows "Name, Town" instead), town, la (council), cc (ceremonial county), country, county (the
// one locals use), lat, lon, id (only on a LISTED live crossing: its page), pg (a coming-soon
// crossing's page where it has one: /<pg>/, the address it keeps when it goes live). Search-only: alt, the
// other names the road goes by (the list's own road where a definition overrides it, its number,
// the other source's name, its Welsh name). A live crossing takes its name and road from its
// definition (ticket 07); an unlisted one stays coming soon.
function directory(defs, rows, list, soonSlugs) {
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
    else if (!L && soonSlugs[r.uid]) e.pg = soonSlugs[r.uid];   // its coming-soon page (not live)
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

// ---- pages for coming-soon crossings, and county lists (search plan, 2026-11) -----------------
// Searches are for places, and a crossing without a page can't be found. So each coming-soon
// crossing in SOON_COUNTIES gets a page of fixed facts (where, type, what happens there, nearest
// station, nearby crossings, local map) and a request button, and each county with pages gets a
// list. A crossing's page lives at /<slug>/ from its first day, coming soon or live: a launch must
// never move it, or what search engines have learned about it is lost.
const SOON_COUNTIES = ['East Sussex', 'West Sussex'];      // the pilot. null = every county
const RESERVED = new Set(['shared', 'map', 'scripts', 'docs', 'crossings', 'backend', 'map-service', 'analysis-data', 'observe']);
const slugify = s => String(s).toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
// Every crossing's slug, over the WHOLE list (so it never depends on which counties have pages):
// its name ("keymer"); where two share a name, name + town ("carlton-nottingham"); then + number.
function pageSlugs(list) {
  const rs = Object.values(list).filter(r => r.excluded !== 'yes');
  const tally = f => rs.reduce((m, r) => (m[f(r)] = (m[f(r)] || 0) + 1, m), {});
  const one = r => slugify(r.display_name.replace(/\s+level crossing$/i, ''));
  const n1 = tally(one);
  const two = r => n1[one(r)] > 1 || RESERVED.has(one(r)) ? `${one(r)}-${slugify(r.town)}` : one(r);
  const n2 = tally(two);
  const out = {};
  for (const r of rs) out[r.uid] = n2[two(r)] > 1 ? `${two(r)}-${r.uid}` : two(r);
  return out;
}
// A published address must never change. The last build's directory says which coming-soon pages
// exist (pg); a list edit that would move one (say a new crossing now shares its name) stops the build.
function checkSlugsStable(slugs) {
  const p = path.join(ROOT, 'shared', 'directory.json');
  if (!fs.existsSync(p)) return;
  for (const e of JSON.parse(fs.readFileSync(p, 'utf8')).crossings)
    if (e.pg && slugs[e.n] && slugs[e.n] !== e.pg)
      throw new Error(`crossing ${e.n} (${e.name}) is published at /${e.pg}/ but would now be /${slugs[e.n]}/. Keep its address (special-case it in pageSlugs) rather than move a page search engines know.`);
}

const STATIONS = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'data', 'stations.json'), 'utf8')).stations;
function milesBetween(aLat, aLon, bLat, bLon) {
  const R = 3958.8, rad = x => x * Math.PI / 180;
  const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const fmtMiles = m => m < 0.1 ? 'under 0.1 miles' : `${m < 10 ? m.toFixed(1) : Math.round(m)} miles`;
function nearestStation(lat, lon) {
  let best = null;
  for (const st of STATIONS) { const d = milesBetween(lat, lon, st.lat, st.lon); if (!best || d < best.d) best = { st, d }; }
  return best;
}
const crossingName = e => /level crossing$/i.test(e.name) ? e.name : `${e.name} Level Crossing`;
const placeOf = e => e.road ? `${e.road}, ${e.town}` : e.town;
const requestUrlFor = e => `${REQUEST_URL}?usp=pp_url&entry.310342749=${encodeURIComponent(e.town || '')}` +
  (e.road ? `&entry.330374812=${encodeURIComponent(e.road)}` : '');    // as shared/finder.js requestUrl()
const pageOf = e => e.id || e.pg ? `/${e.id || e.pg}/` : null;

// " At Portslade, a crossing of the same type, half of all closures last between 2 and 3¾ minutes
// (recorded by this app, November 2026)." — from a listed live crossing of the type with figures.
function sameTypeFigures(typeCode, rows) {
  for (const [id, d] of Object.entries(defs)) {
    const f = d.presentation.figures;
    if (!f || d.presentation.listed === false || TYPE_WORDS[rows[id].type][0] !== typeCode) continue;
    return ` At <a href="/${esc(id)}/">${esc(shortName(d))}</a>, a crossing of the same type, half of all closures last between ${esc(minutesWords(f.downP25Secs))} and ${esc(minutesWords(f.downP75Secs))} minutes (recorded by this app, ${esc(f.asOf)}).`;
  }
  return '';
}

// One row: a crossing with a page is a link (live ones tagged), one without is plain text.
function crossingRow(e, sub, track, dist) {
  const main = `<span class="pm-row-main"><span class="pm-name">${esc(crossingName(e))}</span><span class="pm-sub">${esc(sub)}</span></span>` +
    (dist ? `<span class="pm-dist">${esc(dist)}</span>` : '');
  const href = pageOf(e);
  if (!href) return `<div class="pm-row pm-soon">${main}</div>`;
  return `<a class="pm-row${e.id ? ' pm-live' : ''}" data-track="${esc(track)}" href="${esc(href)}">${main}` +
    `${e.id ? '<span class="pm-tag">Live</span>' : ''}<span class="pm-chev" aria-hidden="true">›</span></a>`;
}

// The station on each side of the crossing along its line, up side first, each "towards" where trains
// going that way commonly finish (scripts/derive-crossing-stations.js, from the timetable). Rows look
// like the nearby crossings'; each opens the live train map at that station.
const NEAR_STATIONS = (() => {
  const p = path.join(ROOT, 'scripts', 'data', 'crossing-stations.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')).crossings : {};
})();
const stationByCrs = new Map(STATIONS.map(st => [st.crs, st]));
function nearbySections(slug, e, all) {
  const ns = NEAR_STATIONS[e.n];
  const stRows = ns ? ns.sides.map(sd => {
    const st = stationByCrs.get(sd.station), to = sd.towards && stationByCrs.get(sd.towards);
    if (!st || (!to && !sd.end)) return '';
    const line2 = to ? `Towards ${to.name}` : 'End of the line';
    const mi = fmtMiles(milesBetween(e.lat, e.lon, st.lat, st.lon)).replace(' miles', ' mi');
    return `<a class="pm-row" data-track="station-tap: ${esc(slug)} -> ${esc(st.crs)}" href="/map/#s=${esc(st.crs)}"><span class="pm-row-main"><span class="pm-name">${esc(st.name)}</span><span class="pm-sub">${esc(line2)}</span></span><span class="pm-dist">${esc(mi)}</span><span class="pm-chev" aria-hidden="true">›</span></a>`;
  }).join('') : '';
  const stations = stRows ? `<section class="section" aria-labelledby="stnHdr">\n    <h2 class="about-hdr" id="stnHdr">Nearby stations</h2>\n    <div class="near-list">${stRows}</div>\n  </section>\n  ` : '';
  // The three nearest other crossings, anywhere in Great Britain.
  const nearRows = all.filter(o => o.n !== e.n).map(o => ({ o, d: milesBetween(e.lat, e.lon, o.lat, o.lon) }))
    .sort((a, b) => a.d - b.d).slice(0, 3)
    .map(({ o, d }) => crossingRow(o, placeOf(o), `nearby-page-tap: ${slug} -> ${o.id || o.pg}`, fmtMiles(d).replace(' miles', ' mi'))).join('');
  return stations + `<section class="section" aria-labelledby="nearHdr">\n    <h2 class="about-hdr" id="nearHdr">Nearby crossings</h2>\n    <div class="near-list">${nearRows}</div>\n  </section>`;
}

function soonPage(e, r, all, rows, liveSentence, template) {
  const slug = e.pg, name = crossingName(e), place = placeOf(e), county = countyOf(r), url = `${SITE}/${slug}/`;
  const [typeCode, typeWords] = typeOf(slug, r);
  if (!TYPE_HOW[typeCode]) throw new Error(`${slug}: no "what happens" words for type ${typeCode}; add it to TYPE_HOW`);
  const ns = nearestStation(e.lat, e.lon);
  const cp = COUNTY_PAGES[county];
  const pageTitle = `${name}, ${e.town} | railcrossing.uk`;        // the road is in the heading and description: titles past ~60 characters are cut off on a phone
  const description = `${name} is on ${place} (${county}). ${typeWords}. Nearest station: ${ns.st.name}. Live barrier times are coming soon: request them for this crossing.`;
  const nearby = nearbySections(slug, e, all);
  const jsonLdText = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebPage', '@id': url, url, name: pageTitle, description, isPartOf: { '@id': WEBSITE_ID },
        about: { '@type': 'Place', name, additionalType: 'https://www.wikidata.org/wiki/Q171448',
          geo: { '@type': 'GeoCoordinates', latitude: e.lat, longitude: e.lon },
          address: { '@type': 'PostalAddress', ...(e.road ? { streetAddress: e.road } : {}), addressLocality: e.town,
            addressRegion: county, addressCountry: 'GB' } } },
      websiteLd(), organizationLd(),
      breadcrumbLd([['Home', `${SITE}/`], cp && [`${county} crossings`, `${SITE}${cp.path}`], [name, url]])
    ]
  }, null, 1).replace(/</g, '\\u003c');
  return fill(template,
    { slug, name, shortName: e.name, place, n: String(e.n), pageTitle, description, url,
      directoryUrl: `../${directoryUrl}`, requestUrl: requestUrlFor(e), where: whereLine(e.road, r),
      typeCode, typeWords, county, countyUrl: cp ? cp.path : '/' },
    { jsonLd: jsonLdText, nearby, liveSentence,
      typeHow: esc(TYPE_HOW[typeCode]) + sameTypeFigures(typeCode, rows),
      localMap: localMapHtml(slug, name, e.road, e.town, ns.st.crs, ns.st.name),
      stationRow: `<dt>Nearest station</dt><dd>${esc(ns.st.name)}, ${esc(fmtMiles(ns.d))} in a straight line</dd>` });
}

function countyPage(county, entries, template) {
  const cp = COUNTY_PAGES[county], url = `${SITE}${cp.path}`;
  const n = entries.length, live = entries.filter(e => e.id);
  const countText = `${n} road level crossing${n === 1 ? '' : 's'}${live.length ? `, ${live.length} live` : ''}`;
  const pageTitle = `Level crossings in ${county}: all ${n} | railcrossing.uk`;
  const description = `All ${n} road level crossings in ${county}, by town: where each one is, what type it is and which are nearby.` +
    (live.length ? ` Live barrier times at ${andList(live.map(e => crossingName(e)))}.` : '');
  const byTown = {};
  for (const e of entries) (byTown[e.town] = byTown[e.town] || []).push(e);
  const groups = `<section class="section county-list">` + Object.keys(byTown).sort((a, b) => a.localeCompare(b)).map(town =>
    `<h2 class="county-town">${esc(town)}</h2>` +
    byTown[town].sort((a, b) => a.name.localeCompare(b.name))
      .map(e => crossingRow(e, e.road || e.town, `county-tap: ${slugify(county)} -> ${e.id || e.pg}`)).join('')).join('\n  ') +
    `</section>`;
  // Only what is true today: the live ones by name. (No "coming soon" line: Rich, 2026-11-23.)
  const liveLine = live.length
    ? `Live barrier times: ${andList(live.map(e => `<a href="/${esc(e.id)}/">${esc(crossingName(e))}</a>`))}.` : '';
  const jsonLdText = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'CollectionPage', '@id': url, url, name: pageTitle, description, isPartOf: { '@id': WEBSITE_ID } },
      websiteLd(), organizationLd(),
      breadcrumbLd([['Home', `${SITE}/`], [`${county} crossings`, url]])
    ]
  }, null, 1).replace(/</g, '\\u003c');
  return fill(template, { county, countySlug: slugify(county), countText, pageTitle, description, url },
    { jsonLd: jsonLdText, groups, liveLine });
}

// {{x}} values are escaped, {{{x}}} blocks inserted as HTML; the template's own header comment goes.
function fill(template, vals, raw) {
  return template.replace(/^<!--[\s\S]*?-->\n/, '')
    .replace(/\{\{\{(\w+)\}\}\}/g, (m, k) => { if (!(k in raw)) throw new Error(`template value {{{${k}}}} has no source`); return raw[k]; })
    .replace(/\{\{(\w+)\}\}/g, (m, k) => { if (!(k in vals)) throw new Error(`template value {{${k}}} has no source`); return esc(vals[k]); });
}

// The homepage's way in to the county lists.
function countyListHtml(counts) {
  const names = Object.keys(COUNTY_PAGES).sort((a, b) => a.localeCompare(b));
  if (!names.length) return '';
  return `    <section class="hp-sec" id="countyList" aria-labelledby="countyHdr">\n      <h2 class="hp-h2" id="countyHdr">Crossings by county</h2>\n      <div>` +
    names.map(c => `<a class="pm-row" data-track="county-link: homepage" href="${esc(COUNTY_PAGES[c].path)}"><span class="pm-row-main"><span class="pm-name">${esc(c)}</span><span class="pm-sub">${counts[c]} crossings</span></span><span class="pm-chev" aria-hidden="true">›</span></a>`).join('') +
    `</div>\n    </section>`;
}

// ---- main ------------------------------------------------------------------------------
const defs = loadDefinitions();
for (const [id, d] of Object.entries(defs)) check(id, d);
const LIST = loadList();
const rows = joinList(defs, LIST);
// Page addresses. A live crossing's id IS its slug, so its coming-soon page becomes its live page.
const SLUGS = pageSlugs(LIST);
for (const [id, d] of Object.entries(defs))
  if (SLUGS[d.crossingNumber] !== id) throw new Error(`${id}: crossing ${d.crossingNumber}'s page address is /${SLUGS[d.crossingNumber]}/ (its coming-soon page). Name its definition ${SLUGS[d.crossingNumber]}.json so the address doesn't change when it goes live.`);
checkSlugsStable(SLUGS);
// A dark run (listed: false) writes the unvalidated live app at /<id>/. Where the crossing has a
// public coming-soon page that search engines know, that would swap it in silently: stop instead.
for (const [id, d] of Object.entries(defs))
  if (d.presentation.listed === false && (!SOON_COUNTIES || SOON_COUNTIES.includes(countyOf(rows[id]))))
    throw new Error(`${id}: its dark run (listed: false) would replace its public coming-soon page at /${id}/. Decide where the dark run lives before building (crossing-launch skill, Stage 6).`);
const liveNumbers = new Set(Object.values(defs).map(d => String(d.crossingNumber)));
const soonSlugs = {};
for (const r of Object.values(LIST))
  if (r.excluded !== 'yes' && !liveNumbers.has(r.uid) && (!SOON_COUNTIES || SOON_COUNTIES.includes(countyOf(r)))) soonSlugs[r.uid] = SLUGS[r.uid];
const directoryText = directory(defs, rows, LIST, soonSlugs);
const directoryUrl = `shared/directory.json?v=${directoryVersion(directoryText)}`;
const template = withTheme(fs.readFileSync(path.join(__dirname, 'templates', 'crossing-page.html'), 'utf8'));

const token = (fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').match(/shared\/[A-Za-z0-9._-]+\.css\?v=(\d+)/) || [])[1];
// County lists, for every county with at least one crossing page (coming soon or live, listed).
const DIR = JSON.parse(directoryText).crossings;
const COUNTY_PAGES = {}, countyCounts = {};
for (const e of DIR) countyCounts[e.county] = (countyCounts[e.county] || 0) + 1;
for (const e of DIR) if (e.id || e.pg) COUNTY_PAGES[e.county] = { path: `/crossings/${slugify(e.county)}/` };
const writes = {};
for (const [id, d] of Object.entries(defs)) {
  writes[`${id}/index.html`] = page(id, d, rows[id], template);
  writes[`${id}/manifest.webmanifest`] = manifest(id, d, rows[id]);
}
writes['shared/crossings.json'] = websiteSettings(defs);
writes['shared/directory.json'] = directoryText;
const homeTemplate = withTheme(fs.readFileSync(path.join(__dirname, 'templates', 'home-page.html'), 'utf8'));
writes['index.html'] = homePage(defs, rows, directoryText, directoryUrl, homeTemplate, countyListHtml(countyCounts));
const soonTemplate = withTheme(fs.readFileSync(path.join(__dirname, 'templates', 'soon-page.html'), 'utf8'));
const countyTemplate = withTheme(fs.readFileSync(path.join(__dirname, 'templates', 'county-page.html'), 'utf8'));
const listedLive = Object.entries(defs).filter(([, d]) => d.presentation.listed !== false);
const liveSentence = listedLive.length
  ? `It's live at ${andList(listedLive.map(([id, d]) => `<a href="/${esc(id)}/">${esc(d.name)}</a>`))} now.` : '';
for (const e of DIR) if (e.pg) writes[`${e.pg}/index.html`] = soonPage(e, LIST[e.n], DIR, rows, liveSentence, soonTemplate);
for (const c of Object.keys(COUNTY_PAGES))
  writes[`crossings/${slugify(c)}/index.html`] = countyPage(c, DIR.filter(e => e.county === c), countyTemplate);
writes['manifest.webmanifest'] = HOME_MANIFEST;
writes['robots.txt'] = ROBOTS;

// Asset stamps: generated pages come out unstamped; give them the token already in use.
const stamp = text => token ? text.replace(/((?:src|href)=")((?:\.\.\/)*(?:shared|map)\/[A-Za-z0-9._-]+\.(?:js|css))(?:\?v=[^"]*)?"/g, `$1$2?v=${token}"`) : text;
for (const k of Object.keys(writes)) if (k.endsWith('.html')) writes[k] = stamp(writes[k]);

// The sitemap last, once each page's final text is known: its dates say which pages changed.
const differs = rel => { const full = path.join(ROOT, rel); return !fs.existsSync(full) || fs.readFileSync(full, 'utf8') !== writes[rel]; };
const sitemapPages = [['index.html', `${SITE}/`]]
  .concat(listedLive.map(([id]) => [`${id}/index.html`, `${SITE}/${id}/`]))
  .concat(DIR.filter(e => e.pg).map(e => [`${e.pg}/index.html`, `${SITE}/${e.pg}/`]))
  .concat(Object.keys(COUNTY_PAGES).sort().map(c => [`crossings/${slugify(c)}/index.html`, `${SITE}${COUNTY_PAGES[c].path}`]));
writes['sitemap.xml'] = sitemap(sitemapPages, new Set(Object.keys(writes).filter(k => k.endsWith('index.html') && differs(k))));

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
