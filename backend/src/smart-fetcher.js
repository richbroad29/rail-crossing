'use strict';

// SMART reference data — NROD's table of which TD berth steps are timing events (arrive/depart
// at a STANOX). The live train map uses it to tie berths to stations; see berth-geo.js.
//
// Same host, credentials and redirect handling as CORPUS (corpus-fetcher.js). Refreshed daily
// with CORPUS in index.js; SMART itself changes rarely.
//
// The file is one JSON document, {"BERTHDATA":[{...},{...}]}, national, a few tens of MB
// unzipped. Rather than JSON.parse the whole thing (a heap spike this VPS does not need), it is
// streamed and each flat row object is parsed on its own — rows contain no nested braces, so
// `{[^{}]*}` finds exactly one row, whether the file is on one line or many.

const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');

const NROD_HOST = 'publicdatafeeds.networkrail.co.uk';
const NROD_PATH = '/ntrod/SupportingFileAuthenticate?type=SMART';
const DATA_DIR = path.join(__dirname, '..', 'data', 'smart');
const TARGET = path.join(DATA_DIR, 'smart-latest.json.gz');
const TEMP = TARGET + '.tmp';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function downloadSmart() {
  return new Promise((resolve, reject) => {
    const user = process.env.NR_FEED_USER;
    const pass = process.env.NR_FEED_PASS;
    if (!user || !pass) return reject(new Error('NR_FEED_USER / NR_FEED_PASS not set'));
    ensureDir(DATA_DIR);

    function get(urlStr, sendAuth, redirectsLeft) {
      const u = new URL(urlStr);
      const headers = { 'User-Agent': 'rail-crossing-backend/2.0' };
      if (sendAuth) headers.Authorization = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
      const req = https.request({ host: u.hostname, path: u.pathname + u.search, method: 'GET', headers }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
          // Presigned S3 redirect carries its own auth — do not forward ours.
          return get(res.headers.location, false, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) {
          let body = '';
          res.on('data', d => { body += d.toString(); });
          res.on('end', () => reject(new Error(`SMART HTTP ${res.statusCode}: ${body.slice(0, 200)}`)));
          return;
        }
        const ws = fs.createWriteStream(TEMP);
        let bytes = 0;
        res.on('data', c => { bytes += c.length; });
        res.pipe(ws);
        ws.on('finish', () => { fs.renameSync(TEMP, TARGET); resolve({ path: TARGET, bytes }); });
        ws.on('error', err => { try { fs.unlinkSync(TEMP); } catch (_) {} reject(err); });
      });
      req.on('error', reject);
      req.setTimeout(120000, () => req.destroy(new Error('SMART download timeout')));
      req.end();
    }
    get('https://' + NROD_HOST + NROD_PATH, true, 3);
  });
}

// One SMART row → the compact shape berth-geo uses. Blank strings become null.
function compactRow(o) {
  const s = v => (v == null ? '' : String(v).trim());
  return {
    td: s(o.TD) || null,
    from: s(o.FROMBERTH) || null,
    to: s(o.TOBERTH) || null,
    stanox: s(o.STANOX) || null,
    event: s(o.EVENT) || null,
    stepType: s(o.STEPTYPE) || null,
    stanme: s(o.STANME) || null
  };
}

// Stream-parse a SMART file (gzip or plain). Returns compact rows, optionally filtered.
function parseSmartStream(stream, keep = () => true) {
  return new Promise((resolve, reject) => {
    const rows = [];
    let carry = '';
    let bad = 0;
    const re = /\{[^{}]*\}/g;
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      const text = carry + chunk;
      re.lastIndex = 0;
      let m, lastEnd = 0;
      while ((m = re.exec(text)) !== null) {
        lastEnd = re.lastIndex;
        let o;
        try { o = JSON.parse(m[0]); } catch (_) { bad++; continue; }
        if (!o || (o.TD === undefined && o.FROMBERTH === undefined)) continue;
        const r = compactRow(o);
        if (keep(r)) rows.push(r);
      }
      // Keep the unmatched tail, but only from its last '{' — anything before that cannot
      // start a row. Bounds the carry even if the file were one enormous unmatched run.
      const tail = text.slice(lastEnd);
      const brace = tail.lastIndexOf('{');
      carry = brace >= 0 ? tail.slice(brace) : '';
    });
    stream.on('end', () => resolve({ rows, bad }));
    stream.on('error', reject);
  });
}

async function loadSmartFromDisk(file = TARGET, keep) {
  if (!fs.existsSync(file)) throw new Error(`SMART file not on disk at ${file}`);
  let stream = fs.createReadStream(file);
  if (file.endsWith('.gz')) stream = stream.pipe(zlib.createGunzip());
  const { rows, bad } = await parseSmartStream(stream, keep);
  console.log(`SMART: loaded ${rows.length} rows${bad ? ` (${bad} unparseable)` : ''}`);
  return rows;
}

function latestFileExists() { return fs.existsSync(TARGET); }

module.exports = { downloadSmart, loadSmartFromDisk, parseSmartStream, latestFileExists, _compactRow: compactRow };
