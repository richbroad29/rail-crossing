#!/usr/bin/env node
'use strict';

// Generates every crossing's public files from its definition.
//
// A crossing is defined ONCE, in backend/config/crossings/<id>.json on the backend-v2 branch
// (docs/crossing-definition.md). Its `presentation` block plus a few backend fields are all
// the website needs; this script writes, for every crossing:
//
//   <id>/index.html           the crossing's page — scripts/templates/crossing-page.html with
//                             its title, description and link-preview tags written into the page
//                             (link previews and search engines do not run the page's code)
//   <id>/manifest.webmanifest its home-screen app file
//
// and, across all crossings:
//
//   shared/crossings.json     the website's settings — only the fields the pages read
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

const ROOT = path.resolve(__dirname, '..');
const SITE = 'https://railcrossing.uk';
const DEFS_REF = 'origin/backend-v2';
const DEFS_PATH = 'backend/config/crossings';
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

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

const REQUIRED = ['pageTitle', 'description', 'appName', 'appShortName', 'confidenceWindows'];
function check(id, d) {
  const p = d.presentation;
  if (!p) throw new Error(`${id}: no presentation block`);
  for (const k of REQUIRED) if (p[k] == null) throw new Error(`${id}: presentation.${k} missing`);
  for (const k of ['name', 'road', 'feedbackUrl']) if (!d[k]) throw new Error(`${id}: ${k} missing`);
}

// ---- outputs ---------------------------------------------------------------------------
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page(id, d, template) {
  const p = d.presentation;
  const vals = {
    id, name: d.name, road: d.road, roadLabel: p.roadLabel || d.road.toUpperCase(),
    pageTitle: p.pageTitle, description: p.description, appShortName: p.appShortName,
    url: `${SITE}/${id}/`
  };
  const body = template.replace(/^<!--[\s\S]*?-->\n/, '');     // drop the template's own header
  return body.replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (!(k in vals)) throw new Error(`template value {{${k}}} has no source`);
    return esc(vals[k]);
  });
}

function manifest(id, d) {
  const p = d.presentation;
  return `{
  "name": ${JSON.stringify(p.appName)},
  "short_name": ${JSON.stringify(p.appShortName)},
  "description": ${JSON.stringify(p.description)},
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

const ROBOTS = `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`;
const LIST_START = '<!-- crossings:start (generated by scripts/build-crossings.js) -->';
const LIST_END = '<!-- crossings:end -->';

// ---- main ------------------------------------------------------------------------------
const defs = loadDefinitions();
for (const [id, d] of Object.entries(defs)) check(id, d);
const template = fs.readFileSync(path.join(__dirname, 'templates', 'crossing-page.html'), 'utf8');

const token = (fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').match(/shared\/[A-Za-z0-9._-]+\.css\?v=(\d+)/) || [])[1];
const writes = {};
for (const [id, d] of Object.entries(defs)) {
  writes[`${id}/index.html`] = page(id, d, template);
  writes[`${id}/manifest.webmanifest`] = manifest(id, d);
}
writes['shared/crossings.json'] = websiteSettings(defs);
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
