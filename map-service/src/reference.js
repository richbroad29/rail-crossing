'use strict';

// Loaders for the four reference files. Each takes a file path and resolves a plain in-memory
// structure, or rejects with a sentence. Nothing here writes anything. All are streamed, so a
// 100 MB file never sits in memory whole, and every loader skips a bad row (counted) rather than
// failing the file.

const fs = require('fs');
const zlib = require('zlib');
const { StringDecoder } = require('string_decoder');
const { pipeline } = require('stream');
const { streamRows } = require('./json-rows');
const { CsvParser } = require('./csv');

const str = v => (v === null || v === undefined ? '' : typeof v === 'string' ? v.trim() : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
const stanoxKey = v => { const s = str(v); return /^\d{1,4}$/.test(s) ? s.padStart(5, '0') : s; };
const crsKey = v => { const s = str(v).toUpperCase(); return /^[A-Z]{3}$/.test(s) ? s : ''; };
const finite = v => typeof v === 'number' && Number.isFinite(v);

const SMALL_WORDS = new Set(['and', 'of', 'the', 'on', 'in', 'upon', 'by', 'for', 'to']);

/** "LONDON VICTORIA (C) (TPS INDIC. ONLY)" -> "London Victoria"; leaves already-mixed-case names alone. */
function cleanName(raw) {
  let s = str(raw).replace(/\s*\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s !== s.toUpperCase()) return s;
  s = s.toLowerCase().replace(/(^|[\s\-/'.])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  return s.split(' ').map((w, i) => (i > 0 && SMALL_WORDS.has(w.toLowerCase()) ? w.toLowerCase() : w)).join(' ');
}

// ---- CORPUS ---------------------------------------------------------------------------------------

/** @returns {Promise<{rows:number, byTiploc:Map, stanoxTiplocs:Map, crsTiplocs:Map, bad:number}>} */
async function loadCorpus(file) {
  const byTiploc = new Map();      // TIPLOC -> { stanox, crs, name }
  const stanoxTiplocs = new Map(); // STANOX -> [TIPLOC...]
  const crsTiplocs = new Map();    // CRS -> [TIPLOC...]
  let rows = 0;
  const scan = await streamRows(file, {
    onRow(row) {
      if (!row || typeof row !== 'object') return;
      const tiploc = str(row.TIPLOC);
      if (!tiploc || tiploc.length > 8) return;
      rows++;
      const stanox = stanoxKey(row.STANOX), crs = crsKey(row['3ALPHA']);
      if (!byTiploc.has(tiploc)) byTiploc.set(tiploc, { stanox, crs, name: cleanName(row.NLCDESC) });
      if (stanox) { const l = stanoxTiplocs.get(stanox); if (!l) stanoxTiplocs.set(stanox, [tiploc]); else if (!l.includes(tiploc)) l.push(tiploc); }
      if (crs) { const l = crsTiplocs.get(crs); if (!l) crsTiplocs.set(crs, [tiploc]); else if (!l.includes(tiploc)) l.push(tiploc); }
    }
  });
  return { rows, byTiploc, stanoxTiplocs, crsTiplocs, bad: scan.bad, loadedAt: Date.now() };
}

// ---- NaPTAN ---------------------------------------------------------------------------------------

function stripStationSuffix(name) {
  return name.replace(/\s+(Rail|Railway|Train)\s+Station$/i, '').replace(/\s+Station$/i, '').trim();
}

/** NaPTAN access-node CSV (plain or gzip) -> active rail stations (StopType RLY, ATCOCode 9100<TIPLOC>) by TIPLOC. */
async function loadNaptan(file) {
  const byTiploc = new Map();      // TIPLOC -> { name, lat, lon }
  let header = null, ai = -1, ni = -1, lo = -1, la = -1, st = -1, su = -1, rows = 0, bad = 0;
  const col = n => header.findIndex(h => h.trim().toLowerCase() === n);
  const parser = new CsvParser(rec => {
    if (!header) {
      header = rec; ai = col('atcocode'); ni = col('commonname'); lo = col('longitude'); la = col('latitude'); st = col('stoptype'); su = col('status');
      return;
    }
    rows++;
    const code = (rec[ai] || '').trim();
    if (!code.startsWith('9100') || code.length <= 4 || code.length > 12) return;
    if (st >= 0 && (rec[st] || '').trim() !== 'RLY') return;
    if (su >= 0 && (rec[su] || '').trim().toLowerCase() === 'inactive') return;
    const lat = Number(rec[la]), lon = Number(rec[lo]);
    if (!finite(lat) || !finite(lon) || lat < 49 || lat > 61.5 || lon < -9 || lon > 2.5) { bad++; return; }
    const tiploc = code.slice(4);
    if (!byTiploc.has(tiploc)) byTiploc.set(tiploc, { name: stripStationSuffix(str(rec[ni])) || tiploc, lat, lon });
  });
  const src = openText(file);
  const decoder = new StringDecoder('utf8');
  for await (const chunk of src) parser.write(decoder.write(chunk));
  parser.write(decoder.end());
  parser.end();
  if (!header || ai < 0 || la < 0 || lo < 0) throw new Error(`${file} does not look like a NaPTAN access-node CSV (no ATCOCode/Latitude/Longitude columns).`);
  return { rows, byTiploc, bad, loadedAt: Date.now() };
}

function openText(file) {
  const fd = fs.openSync(file, 'r');
  let gz = false;
  try { const b = Buffer.alloc(2); gz = fs.readSync(fd, b, 0, 2, 0) === 2 && b[0] === 0x1f && b[1] === 0x8b; } finally { fs.closeSync(fd); }
  const raw = fs.createReadStream(file);
  return gz ? pipeline(raw, zlib.createGunzip(), () => {}) : raw;
}

// ---- station table (CRS fallback) --------------------------------------------------------------------

function loadStationsFile(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const table = doc && typeof doc === 'object' && doc.stations && typeof doc.stations === 'object' ? doc.stations : doc;
  const byCrs = new Map();
  let skipped = 0;
  for (const [crs, s] of Object.entries(table || {})) {
    if (crs.startsWith('_')) continue;
    if (/^[A-Z]{3}$/.test(crs) && s && finite(s.lat) && finite(s.lon) && Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180) {
      byCrs.set(crs, { name: typeof s.name === 'string' && s.name ? s.name : crs, lat: s.lat, lon: s.lon });
    } else skipped++;
  }
  if (!byCrs.size) throw new Error(`The station table ${file} has no usable stations.`);
  return { byCrs, skipped };
}

// ---- SMART ----------------------------------------------------------------------------------------

/**
 * SMART -> compact parallel arrays of interned strings (about 34k rows). Rows missing a TD area or
 * both berths are skipped and counted.
 * @returns {Promise<{rows:number, area:string[], from:string[], to:string[], stanox:string[], event:string[], skipped:number}>}
 */
async function loadSmart(file) {
  const pool = new Map();
  const intern = s => { const e = pool.get(s); if (e !== undefined) return e; pool.set(s, s); return s; };
  const d = { rows: 0, area: [], from: [], to: [], stanox: [], event: [], platform: [], skipped: 0 };
  await streamRows(file, {
    onRow(row) {
      if (!row || typeof row !== 'object') return;
      const area = str(row.TD).toUpperCase();
      const from = str(row.FROMBERTH), to = str(row.TOBERTH);
      if (!area || area.length > 4 || from.length > 6 || to.length > 6 || (!from && !to)) { d.skipped++; return; }
      d.area.push(intern(area)); d.from.push(intern(from)); d.to.push(intern(to));
      d.stanox.push(intern(stanoxKey(row.STANOX))); d.event.push(intern(str(row.EVENT).toUpperCase())); d.platform.push(intern(str(row.PLATFORM).slice(0, 4)));
      d.rows++;
    }
  });
  return d;
}

// ---- STANOX -> station ---------------------------------------------------------------------------------

/**
 * Where is the station at this STANOX? NaPTAN by TIPLOC first (the TIPLOC that carries a CRS is
 * preferred, then alphabetical, so the answer never depends on file order); else the CRS fallback
 * table. Memoised. Returns { key, name, lat, lon, crs } or null.
 */
function makeStanoxResolver({ corpus, naptan, stations }) {
  const memo = new Map();
  return stanox => {
    if (memo.has(stanox)) return memo.get(stanox);
    let out = null;
    const tiplocs = (corpus && corpus.stanoxTiplocs.get(stanox)) || [];
    const ordered = [...tiplocs].sort((a, b) => {
      const ca = corpus.byTiploc.get(a).crs ? 0 : 1, cb = corpus.byTiploc.get(b).crs ? 0 : 1;
      return ca - cb || (a < b ? -1 : a > b ? 1 : 0);
    });
    if (naptan) {
      for (const t of ordered) {
        const n = naptan.byTiploc.get(t);
        if (n) { const c = corpus.byTiploc.get(t); out = { key: t, name: n.name, lat: n.lat, lon: n.lon, crs: c.crs || '' }; break; }
      }
    }
    if (!out && stations) {
      for (const t of ordered) {
        const c = corpus.byTiploc.get(t);
        const s = c.crs && stations.byCrs.get(c.crs);
        if (s) { out = { key: t, name: s.name, lat: s.lat, lon: s.lon, crs: c.crs }; break; }
      }
    }
    memo.set(stanox, out);
    return out;
  };
}

/** TIPLOC -> display name: NaPTAN, else CORPUS, else the TIPLOC itself. */
function makeNamer({ corpus, naptan }) {
  return tiploc => {
    const n = naptan && naptan.byTiploc.get(tiploc);
    if (n) return n.name;
    const c = corpus && corpus.byTiploc.get(tiploc);
    return (c && c.name) || tiploc;
  };
}

/** The station list for /stations: every active NaPTAN rail station, plus fallback-table stations NaPTAN lacks. */
function buildStationList({ corpus, naptan, stations }) {
  const out = [], seenCrs = new Set(), seenTiploc = new Set();
  if (naptan) {
    for (const [tiploc, n] of [...naptan.byTiploc].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const crs = (corpus && corpus.byTiploc.get(tiploc) && corpus.byTiploc.get(tiploc).crs) || '';
      if (crs && seenCrs.has(crs)) continue;
      if (crs) seenCrs.add(crs);
      seenTiploc.add(tiploc);
      out.push({ tiploc, crs, name: n.name, lat: n.lat, lon: n.lon });
    }
  }
  if (stations) {
    for (const [crs, s] of [...stations.byCrs].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (seenCrs.has(crs)) continue;
      const tl = ((corpus && corpus.crsTiplocs.get(crs)) || []).find(t => !seenTiploc.has(t)) || '';
      seenCrs.add(crs);
      out.push({ tiploc: tl, crs, name: s.name, lat: s.lat, lon: s.lon });
    }
  }
  return out;
}

module.exports = { loadCorpus, loadNaptan, loadStationsFile, loadSmart, makeStanoxResolver, makeNamer, buildStationList, cleanName, stanoxKey, str, openText };
