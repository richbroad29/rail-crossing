'use strict';

// NAPTAN_PROBE (optional, --naptan): does the DfT NaPTAN API answer, in what shape, and do its rail-station
// rows carry the TIPLOC in their ATCO code?
//
// The URL is from memory and may be wrong: any failure is reported plainly as a WARN, never fatal.
//
// ATCO codes for rail stations start 9100 and embed the TIPLOC after it (Portslade is 9100PSLDAWH, TIPLOC
// PSLDAWH). If that holds, NaPTAN could map TIPLOC -> coordinates directly, for timing points that have no
// CRS. The probe counts how many of the 9100 rows' suffixes are TIPLOCs CORPUS knows, which is the test.

const zlib = require('zlib');
const { pipeline } = require('stream');
const { StringDecoder } = require('string_decoder');
const { fetchResponse, readExcerpt, oneLineExcerpt, DownloadError } = require('./download');
const { CsvParser } = require('./csv');
const { Counter } = require('./stats');
const { fmtInt, listCap, fmtPct } = require('./format');

const NAPTAN_URL = 'https://naptan.api.dft.gov.uk/v1/access-nodes?dataFormat=csv&atcoAreaCodes=910';
const RAIL_PREFIX = '9100';
const KNOWN_CODE = '9100PSLDAWH';          // Portslade
const SAMPLE_ROWS = 5;

/**
 * Probe the API. Never throws: resolves { ok: true, ... } or { ok: false, reason }.
 * @param {object} [p]
 * @param {string} [p.url]
 * @param {number} [p.idleTimeoutMs=60000]   no data for this long is a timeout
 * @param {number} [p.totalTimeoutMs=300000] overall ceiling
 * @param {Set<string>} [p.tiplocs]          CORPUS TIPLOCs, for the cross-check
 * @param {function} [p.now]
 */
async function probeNaptan({ url = NAPTAN_URL, idleTimeoutMs = 60000, totalTimeoutMs = 300000, tiplocs = null, now = Date.now } = {}) {
  const t0 = now();
  try {
    return await fetchResponse(url, {
      serverName: 'NaPTAN', what: 'NaPTAN access-node list', idleTimeoutMs, totalTimeoutMs,
      headers: { Accept: 'text/csv,*/*', 'Accept-Encoding': 'gzip' }
    }, async (res, info) => {
      if (res.statusCode !== 200) {
        const said = oneLineExcerpt(await readExcerpt(res));
        return { ok: false, status: res.statusCode, reason: `HTTP ${res.statusCode} from ${info.finalHost}${said ? `: "${said}"` : ''}` };
      }
      const contentType = res.headers['content-type'] || null;
      const contentEncoding = res.headers['content-encoding'] || null;
      // pipeline (unlike .pipe) carries a network abort through the gunzip stream to the reader below.
      const source = contentEncoding === 'gzip' ? pipeline(res, zlib.createGunzip(), () => {}) : res;

      let header = null, atco = -1, stopType = -1, name = -1, lat = -1, lon = -1;
      const col = n => (header ? header.findIndex(h => h.trim().toLowerCase() === n) : -1);
      let rows = 0, ragged = 0, rail = 0, railWithTiploc = 0, knownCodeFound = false, bytes = 0;
      const prefixes = new Counter(50), stopTypes = new Counter(20);
      const sample = [];

      const parser = new CsvParser(record => {
        if (!header) {
          header = record;
          atco = col('atcocode'); stopType = col('stoptype'); name = col('commonname'); lat = col('latitude'); lon = col('longitude');
          return;
        }
        rows++;
        if (record.length !== header.length) ragged++;
        const code = atco >= 0 ? (record[atco] || '').trim() : '';
        prefixes.add(code.slice(0, 4));
        if (!code.startsWith(RAIL_PREFIX)) return;
        rail++;
        if (code === KNOWN_CODE) knownCodeFound = true;
        if (stopType >= 0) stopTypes.add((record[stopType] || '').trim());
        if (tiplocs && tiplocs.has(code.slice(RAIL_PREFIX.length))) railWithTiploc++;
        if (sample.length < SAMPLE_ROWS) {
          sample.push({
            ATCOCode: code,
            CommonName: name >= 0 ? record[name] : undefined,
            StopType: stopType >= 0 ? record[stopType] : undefined,
            Latitude: lat >= 0 ? record[lat] : undefined,
            Longitude: lon >= 0 ? record[lon] : undefined
          });
        }
      });

      const decoder = new StringDecoder('utf8');
      for await (const chunk of source) { bytes += chunk.length; parser.write(decoder.write(chunk)); }
      parser.write(decoder.end());
      const tail = parser.end();

      return {
        ok: true, status: 200, host: info.finalHost, redirects: info.redirects, seconds: Math.round((now() - t0) / 100) / 10,
        contentType, contentEncoding, bytes,
        header: header || [], hasAtcoColumn: atco >= 0, rows, ragged, rail,
        railWithTiplocInCorpus: tiplocs ? railWithTiploc : null, tiplocsChecked: !!tiplocs,
        knownCodeFound, prefixes: prefixes.toObject(), stopTypes: stopTypes.toObject(), sample,
        unterminatedQuote: tail.unterminatedQuote, truncatedFields: parser.truncatedFields
      };
    });
  } catch (e) {
    const reason = e instanceof DownloadError ? e.message : `${(e && e.message) || e}`;
    return { ok: false, status: e && e.status, reason };
  }
}

/** The NAPTAN_PROBE verdict: INFO when it worked and showed rail stations, WARN otherwise. */
function judgeNaptan(r) {
  if (!r.ok) {
    return { status: 'WARN', message: `NaPTAN probe failed: ${r.reason} (the URL in this script is from memory and may be wrong; this does not affect the other checks).` };
  }
  const cols = `${fmtInt(r.header.length)} columns (${listCap(r.header, 6)})`;
  const base = `NaPTAN answered HTTP ${r.status} in ${r.seconds} s from ${r.host}: ${cols}, ${fmtInt(r.rows)} rows`;
  if (!r.hasAtcoColumn) {
    return { status: 'WARN', message: `${base}, but there is no ATCOCode column, so rail stations cannot be picked out.` };
  }
  if (r.rail === 0) {
    return { status: 'WARN', message: `${base}, but none has an ATCOCode starting ${RAIL_PREFIX} (prefixes seen: ${listCap(Object.keys(r.prefixes), 8)}).` };
  }
  const tiploc = r.tiplocsChecked
    ? `; ${fmtInt(r.railWithTiplocInCorpus)} of those (${fmtPct(r.railWithTiplocInCorpus, r.rail)}) end in a TIPLOC CORPUS knows`
    : '';
  const known = r.knownCodeFound ? `; Portslade ${KNOWN_CODE} is present` : `; Portslade ${KNOWN_CODE} was not found`;
  return { status: 'INFO', message: `${base}, ${fmtInt(r.rail)} with ATCOCode ${RAIL_PREFIX}…${tiploc}${known}.` };
}

module.exports = { probeNaptan, judgeNaptan, NAPTAN_URL, RAIL_PREFIX, KNOWN_CODE };
