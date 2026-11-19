'use strict';

// Timetable archive: lets any day of the last KEEP_DAYS (retention.js) be rebuilt, so a crossing can be
// replayed against the timetable it really had. LOG ONLY — nothing here is read by predictions.
//
// Why both kinds of file: the full snapshot only holds schedules still valid on the day it was made
// (about a week back), and a daily UPDATE only holds one day's changes. A day is rebuilt from the
// newest full at or before it plus every update after that full, in sequence order. So:
//   - one FULL a week   data/schedule/archive/cif-full-<date>-<seq>.json.gz    (~154 MB each)
//   - every UPDATE      data/schedule/archive/cif-update-<date>-<seq>.json.gz  (~4 MB each)
// <date> and <seq> come from the file's own header, never from the name it was fetched under:
// Network Rail names each update for the day whose changes it carries and publishes it ~00:30 UTC
// the next morning, so "today's" name returns last week's file until midnight.
//
// Each run fetches all seven weekday update files and keeps any sequence not already archived, so
// a missed day is filled by the next run within a week. A full older than KEEP_DAYS is kept while it is
// still the base of the oldest day in the window. About 2.5 GB at steady state.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { KEEP_DAYS } = require('./retention');

const SCHEDULE_DIR = path.join(__dirname, '..', 'data', 'schedule');
let archiveDir = path.join(SCHEDULE_DIR, 'archive');
const FULL_EVERY_DAYS = 7;
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const NAME_RE = /^cif-(full|update)-(\d{4}-\d{2}-\d{2})-(\d+)\.json\.gz$/;

// First line of a gzipped NROD JSON timetable: { type: 'full'|'update', sequence, date: 'YYYY-MM-DD' }.
function readHeader(file) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let done = false;
    const rs = fs.createReadStream(file);
    const gz = zlib.createGunzip();
    const finish = (err, val) => {
      if (done) return;
      done = true;
      rs.destroy(); gz.destroy();
      err ? reject(err) : resolve(val);
    };
    gz.on('data', chunk => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0 && buf.length < 65536) return;
      try {
        const h = JSON.parse(nl < 0 ? buf : buf.slice(0, nl)).JsonTimetableV1;
        if (!h || !h.Metadata || !Number.isFinite(h.timestamp)) throw new Error('no JsonTimetableV1 header');
        finish(null, { type: h.Metadata.type, sequence: Number(h.Metadata.sequence),
          date: new Date(h.timestamp * 1000).toISOString().slice(0, 10) });
      } catch (e) { finish(e); }
    });
    gz.on('error', e => finish(e));
    gz.on('end', () => finish(new Error('empty file')));
    rs.on('error', e => finish(e));
    rs.pipe(gz);
  });
}

function listArchive() {
  if (!fs.existsSync(archiveDir)) return [];
  return fs.readdirSync(archiveDir).map(f => {
    const m = f.match(NAME_RE);
    return m ? { file: f, kind: m[1], date: m[2], sequence: Number(m[3]) } : null;
  }).filter(Boolean);
}

const nameFor = h => `cif-${h.type}-${h.date}-${h.sequence}.json.gz`;
const ageDays = (date, today) => (Date.parse(today + 'T00:00:00Z') - Date.parse(date + 'T00:00:00Z')) / 86400000;

// Copy the current full snapshot in if the newest archived full is FULL_EVERY_DAYS or more older.
async function archiveFull(srcFile, today) {
  if (!fs.existsSync(srcFile)) return null;
  const h = await readHeader(srcFile);
  if (h.type !== 'full') throw new Error(`${path.basename(srcFile)} is not a full extract (${h.type})`);
  const fulls = listArchive().filter(a => a.kind === 'full');
  if (fulls.some(a => a.sequence === h.sequence)) return null;
  const newest = fulls.map(a => a.date).sort().pop();
  if (newest && ageDays(newest, today) < FULL_EVERY_DAYS) return null;
  const dst = path.join(archiveDir, nameFor(h));
  fs.copyFileSync(srcFile, dst + '.tmp');
  fs.renameSync(dst + '.tmp', dst);
  return path.basename(dst);
}

// Fetch every weekday's update; keep any sequence not archived yet. `download(day, path)` is
// cif-fetcher.downloadCifUpdateDay (injected so the tests need no network).
async function archiveUpdates(download) {
  const have = new Set(listArchive().filter(a => a.kind === 'update').map(a => a.sequence));
  const added = [];
  for (const day of DAYS) {
    const tmp = path.join(archiveDir, `incoming-${day}.json.gz`);
    try {
      await download(day, tmp);
      const h = await readHeader(tmp);
      if (h.type !== 'update' || have.has(h.sequence)) { fs.unlinkSync(tmp); continue; }
      fs.renameSync(tmp, path.join(archiveDir, nameFor(h)));
      have.add(h.sequence);
      added.push(nameFor(h));
    } catch (e) {
      console.error(`CIF archive: update ${day} failed: ${e.message}`);
      try { fs.unlinkSync(tmp); } catch (_) { /* not there */ }
    }
  }
  return added;
}

// Everything goes at KEEP_DAYS, except the base of the oldest day still in the window (the newest full
// on or before it): without it, the first days of the window couldn't be rebuilt.
function prune(today) {
  const gone = [];
  const all = listArchive();
  const cutoff = new Date(Date.parse(today + 'T00:00:00Z') - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  const base = all.filter(a => a.kind === 'full' && a.date <= cutoff).map(a => a.date).sort().pop() || null;
  for (const a of all) {
    if (ageDays(a.date, today) <= KEEP_DAYS) continue;
    if (a.kind === 'full' && a.date === base) continue;
    try { fs.unlinkSync(path.join(archiveDir, a.file)); gone.push(a.file); }
    catch (e) { console.error(`CIF archive: prune ${a.file} failed: ${e.message}`); }
  }
  return gone;
}

async function runOnce({ download, fullFile, today = new Date().toISOString().slice(0, 10) }) {
  fs.mkdirSync(archiveDir, { recursive: true });
  let full = null;
  try { full = await archiveFull(fullFile, today); }
  catch (e) { console.error(`CIF archive: full snapshot failed: ${e.message}`); }
  const updates = await archiveUpdates(download);
  const pruned = prune(today);
  console.log(`CIF archive: ${full ? `full ${full}, ` : ''}${updates.length} update(s) added` +
    (updates.length ? ` (${updates.join(', ')})` : '') + (pruned.length ? `, ${pruned.length} pruned` : ''));
  return { full, updates, pruned };
}

module.exports = {
  runOnce, readHeader, KEEP_DAYS, FULL_EVERY_DAYS,
  _setArchiveDirForTest(dir) { archiveDir = dir; },
  _listArchive: listArchive
};
