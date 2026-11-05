'use strict';

// Build-time downloads (public data only: Geofabrik's UK extract and the DfT NaPTAN rail CSV).
// Follows redirects, writes to a temp file and renames, never needs credentials.

const fs = require('fs');
const https = require('https');
const path = require('path');

const GEOFABRIK = 'https://download.geofabrik.de/europe/united-kingdom-latest.osm.pbf';
const NAPTAN = 'https://naptan.api.dft.gov.uk/v1/access-nodes?dataFormat=csv&atcoAreaCodes=910';

function download(url, dest, { log = () => {}, redirects = 6 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'railcrossing-track-builder (+https://github.com/richbroad29/rail-crossing)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (!redirects) return reject(new Error('too many redirects fetching ' + url));
        return resolve(download(new URL(res.headers.location, url).toString(), dest, { log, redirects: redirects - 1 }));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${url}: HTTP ${res.statusCode}`)); }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      let n = 0, lastLog = 0;
      res.on('data', (c) => { n += c.length; if (n - lastLog > 200e6) { lastLog = n; log(`  ${Math.round(n / 1e6)} MB`); } });
      res.pipe(out);
      out.on('finish', () => { fs.renameSync(tmp, dest); resolve({ bytes: n, finalUrl: url }); });
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('timeout fetching ' + url)));
  });
}

module.exports = { download, GEOFABRIK, NAPTAN };
