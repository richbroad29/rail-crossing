'use strict';

// CORPUS reference data — maps TIPLOCs to human-readable location names.
// Used to enrich CIF-sourced freight/ECS trains whose origin/destination
// come from the schedule as raw TIPLOCs (LDBSVWS already provides names).
//
// Source: https://wiki.openraildata.com/index.php?title=Reference_Data
// Refresh cadence: daily, aligned with CIF in index.js.

const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');

const NROD_HOST = 'publicdatafeeds.networkrail.co.uk';
const NROD_PATH = '/ntrod/SupportingFileAuthenticate?type=CORPUS';
const DATA_DIR = path.join(__dirname, '..', 'data', 'corpus');
const TARGET = path.join(DATA_DIR, 'corpus-latest.json.gz');
const TEMP    = path.join(DATA_DIR, 'corpus-latest.json.gz.tmp');

const tiplocMap = new Map();

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function basicAuthHeader(user, pass) {
  return 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
}

// Download CORPUS to TEMP, then atomic rename to TARGET. Same redirect handling
// pattern as cif-fetcher: drop auth on redirect (presigned S3 URLs carry their own).
function downloadCorpus() {
  return new Promise((resolve, reject) => {
    const user = process.env.NR_FEED_USER;
    const pass = process.env.NR_FEED_PASS;
    if (!user || !pass) return reject(new Error('NR_FEED_USER / NR_FEED_PASS not set'));

    ensureDir(DATA_DIR);

    function get(urlStr, sendAuth, redirectsLeft) {
      const u = new URL(urlStr);
      const headers = { 'User-Agent': 'rail-crossing-backend/2.0' };
      if (sendAuth) headers['Authorization'] = basicAuthHeader(user, pass);

      const req = https.request({
        host: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects'));
            res.resume();
            return;
          }
          res.resume();
          get(res.headers.location, false, redirectsLeft - 1);
          return;
        }
        if (res.statusCode !== 200) {
          let body = '';
          res.on('data', d => body += d.toString());
          res.on('end', () => reject(new Error(`CORPUS HTTP ${res.statusCode}: ${body.slice(0, 200)}`)));
          return;
        }

        const ws = fs.createWriteStream(TEMP);
        let bytes = 0;
        res.on('data', chunk => { bytes += chunk.length; });
        res.pipe(ws);
        ws.on('finish', () => {
          fs.renameSync(TEMP, TARGET);
          resolve({ path: TARGET, bytes });
        });
        ws.on('error', err => {
          try { fs.unlinkSync(TEMP); } catch {}
          reject(err);
        });
      });
      req.on('error', reject);
      req.setTimeout(120000, () => req.destroy(new Error('CORPUS download timeout')));
      req.end();
    }

    get('https://' + NROD_HOST + NROD_PATH, true, 3);
  });
}

// Strip parenthetical suffixes from NLCDESC ("VICTORIA (C) (TPS INDIC. ONLY)"
// → "VICTORIA"). CORPUS uses these for administrative markers that aren't
// useful end-user labels. Returns empty string if input is missing/blank;
// callers fall back to 3ALPHA in that case.
function cleanDisplayName(raw) {
  if (!raw) return '';
  return String(raw).replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
}

// Read TARGET, gunzip, parse JSON, build the in-memory map.
// Atomic: builds a fresh Map first and only swaps into tiplocMap on success.
async function loadCorpusFromDisk() {
  if (!fs.existsSync(TARGET)) throw new Error(`CORPUS file not on disk at ${TARGET}`);

  const raw = await new Promise((resolve, reject) => {
    fs.readFile(TARGET, (err, data) => {
      if (err) return reject(err);
      zlib.gunzip(data, (gErr, out) => {
        if (gErr) return reject(gErr);
        resolve(out);
      });
    });
  });

  const parsed = JSON.parse(raw.toString('utf-8'));
  const list = parsed.TIPLOCDATA || [];

  const next = new Map();
  let skipped = 0;
  for (const entry of list) {
    const tip = (entry.TIPLOC || '').trim();
    if (!tip) { skipped++; continue; }
    const nlc = cleanDisplayName(entry.NLCDESC);
    const tre = (entry['3ALPHA'] || '').trim();
    const name = nlc || tre;
    if (!name) { skipped++; continue; }
    next.set(tip, name);
  }

  tiplocMap.clear();
  for (const [k, v] of next) tiplocMap.set(k, v);

  console.log(`CORPUS: loaded ${tiplocMap.size} TIPLOCs (${skipped} skipped, ${list.length} total entries)`);
  return tiplocMap.size;
}

// Lookup. Returns the display name if known, otherwise the raw TIPLOC unchanged.
function resolveTiploc(tip) {
  if (!tip) return tip;
  return tiplocMap.get(tip) || tip;
}

function mapSize() {
  return tiplocMap.size;
}

function latestFileExists() {
  return fs.existsSync(TARGET);
}

module.exports = {
  downloadCorpus,
  loadCorpusFromDisk,
  resolveTiploc,
  mapSize,
  latestFileExists,
  _cleanDisplayName: cleanDisplayName
};
