#!/usr/bin/env node
'use strict';
// Local server for the Portslade departures board, for the proof of concept.
//
//   node boards-server/server.js            live, from National Rail (needs boards-server/.env)
//   node boards-server/server.js --sample   made-up trains, no key needed
//
// Then open http://localhost:8080/portslade/departures-arrivals/
//
// It exists because the National Rail key must not be in the browser: the page asks this
// server for /api/departures, and only this server talks to National Rail, at most once
// every 20 s however many tabs are open. When the board goes live on railcrossing.uk, the
// /api/departures part moves into the backend on the VPS (which already holds the keys) and
// this file is no longer needed.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { departuresFrom } = require('./board-data');
const { sampleResponse } = require('./sample');

const ROOT = path.resolve(__dirname, '..');
const env = { ...readEnv(path.join(__dirname, '.env')), ...process.env };
const SAMPLE = process.argv.includes('--sample');
const PORT = Number(env.PORT) || 8080;
const KEY = env.RDM_DEPARTURES_KEY;
// Best guess at the Rail Data Marketplace address. Copy the real one from the product's page
// on raildata.org.uk into .env: everything up to and including GetDepBoardWithDetails.
const FEED_URL = (env.RDM_DEPARTURES_URL ||
  'https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120/GetDepBoardWithDetails').replace(/\/+$/, '');
const CRS = 'PLD';
const REFRESH_MS = 20000;
const PAGE = '/portslade/departures-arrivals/';

// Only these parts of the repo are served: never the .env next to this file.
const SERVED = ['portslade/departures-arrivals/', 'shared/'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

// KEY=value lines. Read directly rather than via a shell, so a '$' in a key survives intact.
function readEnv(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  const out = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

// Sample trains run from when the server started, restarting every 40 minutes so they never run out.
let sampleFrom = Date.now();

async function fetchFeed() {
  if (SAMPLE) {
    if (Date.now() - sampleFrom > 40 * 60000) sampleFrom = Date.now();
    return sampleResponse(new Date(), new Date(sampleFrom));
  }
  const res = await fetch(`${FEED_URL}/${CRS}?numRows=10&timeWindow=120`, {
    headers: { 'x-apikey': KEY, accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.text();
  if (!res.ok) {
    const hint = res.status === 404 ? ' (check RDM_DEPARTURES_URL in boards-server/.env)'
      : res.status === 401 || res.status === 403 ? ' (check RDM_DEPARTURES_KEY, and that the product subscription is active)' : '';
    throw new Error(`National Rail answered HTTP ${res.status}${hint}: ${body.slice(0, 200)}`);
  }
  // Kept so a surprise in the live data can be looked at afterwards. Gitignored.
  fs.writeFile(path.join(__dirname, 'last-response.json'), body, () => {});
  return body;
}

let cache = null;       // { payload, at }
let inflight = null;

function board() {
  if (cache && Date.now() - cache.at < REFRESH_MS) return Promise.resolve(cache.payload);
  if (!inflight) {
    inflight = fetchFeed()
      .then(raw => {
        const b = departuresFrom(raw);
        cache = { payload: { ...b, source: SAMPLE ? 'sample' : 'live', fetchedAt: new Date().toISOString() }, at: Date.now() };
        const next = b.departures[0];
        console.log(`[${new Date().toLocaleTimeString('en-GB')}] ${b.departures.length} departures` +
          (next ? ` · next ${next.time} ${next.destination} (plat ${next.platform || '-'}) ${next.status.text}` : ''));
        return cache.payload;
      })
      .catch(err => {
        console.error(`[${new Date().toLocaleTimeString('en-GB')}] ${err.message}`);
        // Serve the last good board; the page stops trusting it once it is 2 minutes old.
        if (cache) return cache.payload;
        throw err;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/departures') {
    try { send(res, 200, TYPES['.json'], JSON.stringify(await board())); }
    catch (err) { send(res, 502, TYPES['.json'], JSON.stringify({ error: err.message })); }
    return;
  }
  if (url.pathname === '/') { res.writeHead(302, { location: PAGE }); res.end(); return; }

  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (rel.endsWith('/') || rel === '') rel += 'index.html';
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) || !SERVED.some(p => rel.startsWith(p)) || rel.split('/').some(s => s.startsWith('.'))) {
    send(res, 404, 'text/plain', 'Not found'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { send(res, 404, 'text/plain', 'Not found'); return; }
    send(res, 200, TYPES[path.extname(file)] || 'application/octet-stream', data);
  });
});

if (!SAMPLE && !KEY) {
  console.error('No National Rail key found. Put RDM_DEPARTURES_KEY in boards-server/.env');
  console.error('(copy boards-server/.env.example to start), or run with --sample to use made-up trains.');
  process.exit(1);
}
if (typeof fetch !== 'function') {
  console.error(`This needs Node 18 or newer (you have ${process.version}). Install the LTS from nodejs.org.`);
  process.exit(1);
}
// 127.0.0.1 only: the page is for this computer, not the whole network.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Portslade departures board: ${SAMPLE ? 'SAMPLE trains (made up)' : 'LIVE from National Rail'}`);
  console.log(`Open http://localhost:${PORT}${PAGE}   (Ctrl+C to stop)`);
});
