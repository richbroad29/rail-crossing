'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const NROD_HOST = 'datafeeds.networkrail.co.uk';
const NROD_PATH = '/ntrod/CifFileAuthenticate?type=CIF_ALL_FULL_DAILY&day=toc-full';
const DATA_DIR = path.join(__dirname, '..', 'data', 'schedule');
const TARGET = path.join(DATA_DIR, 'cif-latest.json.gz');
const TEMP    = path.join(DATA_DIR, 'cif-latest.json.gz.tmp');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function basicAuthHeader(user, pass) {
  return 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
}

// Download CIF to TEMP, then atomic rename to TARGET. Follows one redirect (NROD
// often 302s to a presigned S3 URL — the presigned URL does NOT need basic auth).
function downloadCif() {
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
          // Don't send auth to the redirect target (presigned S3 URL has its own auth)
          res.resume();
          get(res.headers.location, false, redirectsLeft - 1);
          return;
        }
        if (res.statusCode !== 200) {
          let body = '';
          res.on('data', d => body += d.toString());
          res.on('end', () => reject(new Error(`CIF HTTP ${res.statusCode}: ${body.slice(0, 200)}`)));
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
      req.setTimeout(120000, () => req.destroy(new Error('CIF download timeout')));
      req.end();
    }

    get('https://' + NROD_HOST + NROD_PATH, true, 3);
  });
}

function latestFilePath() {
  return TARGET;
}

function latestFileExists() {
  return fs.existsSync(TARGET);
}

module.exports = { downloadCif, latestFilePath, latestFileExists };
