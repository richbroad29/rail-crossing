'use strict';
// Replay adapters (berth-first-v1-plan §5): every berth log turned back into the feed's own message
// shape, in the order it arrived, to be pushed through the REAL td-listener (processMessage), as the
// live service receives it. Built on td-sources.js, which knows where each area's days are.
//
//   td-all/td-all-<date>        raw feed messages with their receive time `rx`: regrouped into the
//                               frames they came in (one frame per rx), replayed in rx order
//   sclass/cclass-<AREA>-<date> {ts, area, event, desc, from, to}: one message per frame, at its feed
//   td/td-<date> (area LA)      time (no rx was kept)
//
// Which log an area's day comes from: the national log when it covers the whole day (it is the only one
// with true arrival order), else the area's own log, else whatever part of the national log there is.
// The kind of a per-area message is rebuilt from its fields, not its label: logs written before
// 2026-11-21 (73ca165) carry CB and CC swapped.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { catalogue, datesBetween } = require('./td-sources');
const { parseLondonWallClock } = require('../../src/time-utils');

const lines = file => readline.createInterface({
  input: file.endsWith('.gz') ? fs.createReadStream(file).pipe(zlib.createGunzip()) : fs.createReadStream(file),
  crlfDelay: Infinity
});

// When a national-log file starts, from its first line (it began at 21:52 on 2026-11-19).
async function firstTime(file) {
  for await (const l of lines(file)) { try { return +JSON.parse(l).time; } catch (e) { return null; } }
  return null;
}

// The London midnight that starts `date`.
const dayStart = date => parseLondonWallClock(`${date}T00:00:00`).getTime();

function msgType(from, to) { return from && to ? 'CA' : from ? 'CB' : to ? 'CC' : null; }

// A per-area log line as the feed sent it.
function frameOfLogged(r) {
  const type = msgType(r.from, r.to);
  if (!type || !r.desc) return null;
  const ms = Date.parse(r.ts);
  const m = { time: String(ms), area_id: r.area, msg_type: type, descr: r.desc };
  if (r.from) m.from = r.from;
  if (r.to) m.to = r.to;
  // No receive time was logged: the feed delivers within a second or so of its own clock.
  return { ms: ms + 500, body: JSON.stringify([{ [`${type}_MSG`]: m }]) };
}

/**
 * One day's frames for `areas`, in arrival order: [{ ms, body }], body being what td-listener's
 * processMessage takes. Also says where each area came from.
 */
async function dayFrames(cat, date, areas) {
  const frames = [];
  const used = {};
  const tdAll = cat.tdAll.get(date) || null;
  const tdAllFull = tdAll ? (await firstTime(tdAll)) <= dayStart(date) + 10 * 60e3 : false;
  const fromTdAll = new Set();
  const perFile = new Map();
  for (const a of areas) {
    const own = cat.perArea.get(a) && cat.perArea.get(a).get(date);
    if (tdAll && tdAllFull) { fromTdAll.add(a); used[a] = 'national'; }
    else if (own) { if (!perFile.has(own)) perFile.set(own, new Set()); perFile.get(own).add(a); used[a] = 'own log'; }
    else if (tdAll) { fromTdAll.add(a); used[a] = 'national (part day)'; }
    else used[a] = null;
  }
  if (fromTdAll.size) {
    const byRx = new Map();
    for await (const l of lines(tdAll)) {
      if (!l) continue;
      const i = l.indexOf('"area_id":"');
      if (i < 0 || !fromTdAll.has(l.substr(i + 11, 2))) continue;
      let r; try { r = JSON.parse(l); } catch (e) { continue; }
      if (r.msg_type === 'CT') continue;
      const { rx, type, ...msg } = r;
      if (!byRx.has(rx)) byRx.set(rx, []);
      byRx.get(rx).push({ [type]: msg });
    }
    for (const [rx, w] of byRx) frames.push({ ms: Date.parse(rx), body: JSON.stringify(w) });
  }
  for (const [file, set] of perFile) {
    for await (const l of lines(file)) {
      if (!l) continue;
      let r; try { r = JSON.parse(l); } catch (e) { continue; }
      if (!set.has(r.area)) continue;
      const f = frameOfLogged(r);
      if (f) frames.push(f);
    }
  }
  frames.sort((a, b) => a.ms - b.ms);
  return { date, frames, used };
}

// Frames from log lines of either shape (a national-log line has `rx`; a per-area line has `ts`), in
// arrival order, file order kept within a second. For test fixtures cut from the real logs.
function framesFromLines(lineObjects) {
  const frames = [];
  const byRx = new Map();
  for (const r of lineObjects) {
    if (r.rx) {
      if (r.msg_type === 'CT') continue;
      const { rx, type, ...msg } = r;
      if (!byRx.has(rx)) { const f = { ms: Date.parse(rx), wrappers: [] }; byRx.set(rx, f); frames.push(f); }
      byRx.get(rx).wrappers.push({ [type]: msg });
    } else {
      const f = frameOfLogged(r);
      if (f) frames.push(f);
    }
  }
  for (const f of frames) if (f.wrappers) { f.body = JSON.stringify(f.wrappers); delete f.wrappers; }
  return frames.sort((a, b) => a.ms - b.ms);
}

// Every frame of a window, day by day.
async function* windowFrames(dirs, from, to, areas) {
  const cat = catalogue(dirs);
  for (const d of datesBetween(from, to)) yield await dayFrames(cat, d, areas);
}

module.exports = { dayFrames, windowFrames, framesFromLines, frameOfLogged, msgType };
