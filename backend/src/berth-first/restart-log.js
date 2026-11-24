'use strict';

// Restart rebuild, the reading half (docs/berth-first-design.md §5.12; v1 plan §2 engine.js "restart").
//
// The berth tracker lives in memory, so a restart would forget every train on the approach: a train already
// past the berth that brings the barrier down would be unknown until its next step, which may be the step
// that clears the crossing. So, before the feed is heard again, every berth-first engine is handed the berth
// events of the last WINDOW_MS (longer than the longest normal approach: 25 min is the design's horizon) from
// what this server logged, and replays them through the same path the live feed takes.
//
// Where the events come from, per area:
//   - the area's own log (td-listener writes every crossing area's steps, cancels and interposes to
//     data/logs/td/[<AREA>/]td-<London date>.jsonl, in the order received, with the feed's own time) — small,
//     and the normal source;
//   - else the national log (data/logs/td-all/td-all-<date>.jsonl, every area's messages with the time each
//     was received, `rx`), for an area whose own log does not reach back over the window: the first start
//     after an area is added to a crossing, when its own log begins only at that start. The national log is
//     ~250 MB by evening, so it is never read whole: the window's start is found by bisecting on `rx`. A day
//     already gzipped (the day before, after the 03:00 rotation) is skipped and said so — it can only matter
//     to a restart in the first hour after midnight on the day an area is added.
// And when the previous process last heard the feed: the national log's last line (it is written for every
// message of every area, ~1 s apart, so its last `rx` is when that process stopped hearing). FeedHealth turns
// a downtime longer than an area's silence limit into a blind span (feed-health.js).
//
// All synchronous, like the sighting seed beside it in index.js: it runs once at startup before the listener
// starts, so no live event can arrive in the middle of the replay.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { tdLogFile } = require('../td-paths');
const { londonDateStamp, shiftDateStamp } = require('../time-utils');

const WINDOW_MS = 60 * 60e3;
const LOG_ROOT = path.join(__dirname, '..', '..', 'data', 'logs');
const CHUNK = 1 << 20;

// The London dates a window [fromMs, toMs) touches, oldest first.
function datesOf(fromMs, toMs) {
  const out = [];
  let d = londonDateStamp(new Date(fromMs));
  const last = londonDateStamp(new Date(toMs));
  for (let i = 0; i < 3 && !out.includes(last); i++) { out.push(d); d = shiftDateStamp(d, 1); }
  return out;
}

function readMaybeGz(file) {
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  if (fs.existsSync(file + '.gz')) return zlib.gunzipSync(fs.readFileSync(file + '.gz')).toString('utf8');
  return null;
}
const existsMaybeGz = file => fs.existsSync(file) || fs.existsSync(file + '.gz');

// One line of an area's own log (td-listener writeEvent) as the berth event td-listener emits (berthEvent).
function ownLine(r, area) {
  if (!r || r.area !== area || !r.desc || !r.ts) return null;
  if (r.event !== 'CA' && r.event !== 'CB' && r.event !== 'CC') return null;
  return { headcode: r.desc, ts: r.ts, area, event: r.event, from: r.from || null, to: r.to || null };
}

// An area's own log, or null if it does not reach back over the window: it must exist for every date the
// window touches, and the earliest must either begin by the window's start or follow a day that was logged
// too (a quiet area — LA overnight — begins its day late without anything being missing).
function fromOwnLog(area, fromMs, toMs, root) {
  const dates = datesOf(fromMs, toMs);
  const texts = dates.map(d => readMaybeGz(tdLogFile(area, d, path.join(root, 'td'))));
  if (texts.some(t => t === null)) return null;
  const events = [];
  let first = null;
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch (e) { continue; }
      const ms = Date.parse(r.ts);
      if (first === null && Number.isFinite(ms)) first = ms;
      if (!(ms >= fromMs && ms < toMs)) continue;
      const e = ownLine(r, area);
      if (e) events.push(e);
    }
  }
  const coversStart = first !== null && first <= fromMs;
  const dayBefore = existsMaybeGz(tdLogFile(area, shiftDateStamp(dates[0], -1), path.join(root, 'td')));
  return coversStart || dayBefore ? events : null;
}

// The rx of the first complete line at or after byte `pos` (null at the end of the file).
function rxAfter(fd, pos, size) {
  const buf = Buffer.alloc(Math.min(65536, size - pos));
  const n = fs.readSync(fd, buf, 0, buf.length, pos);
  const s = buf.toString('utf8', 0, n);
  const i = pos === 0 ? 0 : s.indexOf('\n') + 1;
  if (pos !== 0 && i === 0) return null;
  const m = /"rx":"([^"]+)"/.exec(s.slice(i, i + 200));
  return m ? Date.parse(m[1]) : null;
}

// Every line of a plain national-log file with rx in [fromMs, toMs), for the given areas, found by bisection.
function scanNational(file, areas, fromMs, toMs, onLine) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let lo = 0, hi = size;
    while (hi - lo > 65536) {
      const mid = Math.floor((lo + hi) / 2);
      const rx = rxAfter(fd, mid, size);
      if (rx === null || rx >= fromMs) hi = mid; else lo = mid;
    }
    let pos = lo, rest = '', done = false;
    const buf = Buffer.alloc(CHUNK);
    while (pos < size && !done) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      pos += n;
      const lines = (rest + buf.toString('utf8', 0, n)).split('\n');
      rest = lines.pop();
      for (const l of lines) {
        const i = l.indexOf('"area_id":"');
        if (i < 0 || !areas.has(l.substr(i + 11, 2))) continue;
        let r; try { r = JSON.parse(l); } catch (e) { continue; }
        const rx = Date.parse(r.rx);
        if (rx < fromMs) continue;
        if (rx >= toMs) { done = true; break; }
        onLine(r);
      }
    }
  } finally { fs.closeSync(fd); }
}

function fromNational(areaList, fromMs, toMs, root, notes) {
  const areas = new Set(areaList), events = [];
  for (const d of datesOf(fromMs, toMs)) {
    const file = path.join(root, 'td-all', `td-all-${d}.jsonl`);
    if (!fs.existsSync(file)) { notes.push(`national log ${d}: ${fs.existsSync(file + '.gz') ? 'gzipped, skipped' : 'missing'}`); continue; }
    scanNational(file, areas, fromMs, toMs, r => {
      if (r.type !== 'CA_MSG' && r.type !== 'CB_MSG' && r.type !== 'CC_MSG') return;
      if (!r.descr) return;
      const ms = Number(r.time);
      events.push({ headcode: r.descr, ts: new Date(Number.isFinite(ms) && ms > 0 ? ms : Date.parse(r.rx)).toISOString(),
        area: r.area_id, event: r.msg_type || r.type.replace('_MSG', ''), from: r.from || null, to: r.to || null });
    });
  }
  return events;
}

// When the previous process last received anything: the last line, at or before toMs, of the latest plain national log.
function lastReceived(root, toMs) {
  for (const d of [londonDateStamp(new Date(toMs)), shiftDateStamp(londonDateStamp(new Date(toMs)), -1)]) {
    const file = path.join(root, 'td-all', `td-all-${d}.jsonl`);
    if (!fs.existsSync(file)) continue;
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (!size) continue;
      // Normally the file ends before toMs (it is now). If not (a replay), bisect to toMs first.
      let end = size;
      const tail = rxAfter(fd, Math.max(0, size - 4096), size);
      if (tail !== null && tail > toMs) {
        let lo = 0, hi = size;
        while (hi - lo > 4096) { const mid = Math.floor((lo + hi) / 2); const rx = rxAfter(fd, mid, size); if (rx === null || rx > toMs) hi = mid; else lo = mid; }
        end = Math.min(size, hi + 4096);
      }
      const len = Math.min(65536 + 4096, end);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, end - len);
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = /"rx":"([^"]+)"/.exec(lines[i]);
        const ms = m ? Date.parse(m[1]) : NaN;
        if (Number.isFinite(ms) && ms <= toMs) return ms;
      }
    } finally { fs.closeSync(fd); }
  }
  return null;
}

// Each source is already in the order it was received. Merged by the feed's time without ever reordering
// within a source: messages of one area stamped a second out of order (1N33 1 Oct) stay as received.
function mergeByTime(lists) {
  const at = lists.map(() => 0), t = e => Date.parse(e.ts), out = [];
  for (;;) {
    let k = -1;
    for (let i = 0; i < lists.length; i++) if (at[i] < lists[i].length && (k < 0 || t(lists[i][at[i]]) < t(lists[k][at[k]]))) k = i;
    if (k < 0) return out;
    out.push(lists[k][at[k]++]);
  }
}

/**
 * The berth events of the last `windowMs` for `areas`, oldest first, as td-listener emits them.
 * @returns {{ events, sources: {<area>: 'own log'|'national log'}, lastRxMs, fromMs, toMs, notes }}
 */
function readRecentBerthEvents({ areas, toMs = Date.now(), windowMs = WINDOW_MS, root = LOG_ROOT } = {}) {
  const fromMs = toMs - windowMs;
  const sources = {}, notes = [];
  const lists = [];
  const national = [];
  for (const a of areas || []) {
    let own = null;
    try { own = fromOwnLog(a, fromMs, toMs, root); } catch (e) { notes.push(`${a} own log: ${e.message}`); }
    if (own) { sources[a] = 'own log'; lists.push(own); }
    else national.push(a);
  }
  if (national.length) {
    try {
      lists.push(fromNational(national, fromMs, toMs, root, notes));
      for (const a of national) sources[a] = 'national log';
    } catch (e) { notes.push(`national log: ${e.message}`); for (const a of national) sources[a] = 'none'; }
  }
  const events = mergeByTime(lists);
  let lastRxMs = null;
  try { lastRxMs = lastReceived(root, toMs); } catch (e) { notes.push(`last received: ${e.message}`); }
  return { events, sources, lastRxMs, fromMs, toMs, notes };
}

module.exports = { readRecentBerthEvents, WINDOW_MS, _datesOf: datesOf };
