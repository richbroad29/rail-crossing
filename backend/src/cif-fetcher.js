'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { londonDateStamp } = require('./time-utils');

const NROD_HOST = 'datafeeds.networkrail.co.uk';
// Full daily snapshot (whole timetable). Pulled once at 04:00.
const FULL_PATH = '/ntrod/CifFileAuthenticate?type=CIF_ALL_FULL_DAILY&day=toc-full';
const DATA_DIR = path.join(__dirname, '..', 'data', 'schedule');
const TARGET = path.join(DATA_DIR, 'cif-latest.json.gz');
const TEMP    = path.join(DATA_DIR, 'cif-latest.json.gz.tmp');
// Daily UPDATE extract: one day's changes (STP=C cancellations, overlays, Deletes), named for that day
// and published ~00:30 UTC the next morning. Fetched after each full load and applied only if newer
// than the full (timetable-update.js).
const UPDATE_TARGET = path.join(DATA_DIR, 'cif-update-latest.json.gz');
const UPDATE_TEMP   = path.join(DATA_DIR, 'cif-update-latest.json.gz.tmp');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function basicAuthHeader(user, pass) {
  return 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
}

const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// The name of the newest published update (toc-update-<dow>): YESTERDAY's weekday in London. An update
// is named for the day whose changes it carries and appears ~00:30 UTC the next morning, so today's own
// name is last week's file until tonight — asking for it is the bug fixed 2026-11-20. Before ~00:30
// UTC even yesterday's name is still last week's; the caller's sequence check skips it then.
// Worked from the London calendar date, not "now minus 24 h", so a clock change cannot shift it.
function newestUpdateDay(now = new Date()) {
  const [y, m, d] = londonDateStamp(now).split('-').map(Number);
  return DOW[new Date(Date.UTC(y, m - 1, d - 1)).getUTCDay()];
}

// Download `reqPath` to tempPath, then atomic rename to targetPath. Follows one
// redirect (NROD often 302s to a presigned S3 URL — the presigned URL does NOT
// need basic auth). Shared by the full and update fetchers.
function fetchToFile(reqPath, tempPath, targetPath, label) {
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
          res.on('end', () => reject(new Error(`${label} HTTP ${res.statusCode}: ${body.slice(0, 200)}`)));
          return;
        }

        const ws = fs.createWriteStream(tempPath);
        let bytes = 0;
        res.on('data', chunk => { bytes += chunk.length; });
        res.pipe(ws);
        ws.on('finish', () => {
          fs.renameSync(tempPath, targetPath);
          resolve({ path: targetPath, bytes });
        });
        ws.on('error', err => {
          try { fs.unlinkSync(tempPath); } catch {}
          reject(err);
        });
      });
      req.on('error', reject);
      req.setTimeout(120000, () => req.destroy(new Error(`${label} download timeout`)));
      req.end();
    }

    get('https://' + NROD_HOST + reqPath, true, 3);
  });
}

// Download the full daily CIF snapshot.
function downloadCif() {
  return fetchToFile(FULL_PATH, TEMP, TARGET, 'CIF');
}

// Download the newest published UPDATE extract (toc-update-<yesterday>). Whether it is applied is decided
// from its header, not its name (timetable-update.js).
function downloadCifUpdate(day = newestUpdateDay()) {
  const reqPath = `/ntrod/CifFileAuthenticate?type=CIF_ALL_UPDATE_DAILY&day=toc-update-${day}`;
  return fetchToFile(reqPath, UPDATE_TEMP, UPDATE_TARGET, 'CIF-update')
    .then(res => ({ ...res, day }));
}

// Download one weekday's UPDATE extract (toc-update-<day>) to `targetPath`, for the timetable archive
// (cif-archive.js). Each file is named for the day whose changes it carries and is published ~00:30 UTC
// the NEXT morning, so all seven names together are the last seven days.
function downloadCifUpdateDay(day, targetPath) {
  const reqPath = `/ntrod/CifFileAuthenticate?type=CIF_ALL_UPDATE_DAILY&day=toc-update-${day}`;
  return fetchToFile(reqPath, targetPath + '.tmp', targetPath, `CIF-update-${day}`);
}

function latestFilePath() {
  return TARGET;
}

module.exports = {
  downloadCif, downloadCifUpdate, downloadCifUpdateDay,
  latestFilePath, newestUpdateDay
};
