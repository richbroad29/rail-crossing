'use strict';

// Reading the crossing back end's TD logs, read-only. One file per day, td-YYYY-MM-DD.jsonl, one JSON
// object per line, area LA only:
//   {"ts":"2026-10-25T14:02:10.000Z","area":"LA","event":"CA","desc":"1H15","from":"0006","to":"0004","trust_uid":null}
// CA is a step (from and to); CB carries `from` only (a cancel); CC carries `to` only (an interpose) -
// verified on the real feed, not just the spec.
//
// What this takes from them: which berths exist (any berth that appears in any event) and which
// berth-to-berth steps trains make, with how many times each was seen. That is all the coverage
// measurement needs.
//
// The file being written right now can end in a half-written line: that line is counted as bad, not fatal.
// A missing directory or file is a normal answer ("no TD data here"), not an error.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { openSource } = require('./json-rows');
const { str, areaKey } = require('./norm');
const { Counter } = require('./stats');

const FILE_NAME = /^td-(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/;

const dayNumber = date => {
  const [y, m, d] = date.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
};

/**
 * The log files to read: those dated within `days` calendar days of the NEWEST file in the directory
 * (so a copy of old logs still reads, and a gap in the days is simply skipped). If a day exists both
 * plain and gzipped, the plain one is used.
 * @returns {{ dir, readable, reason?, files: Array<{date,file}>, found: number, newest: string|null, oldest: string|null }}
 */
function findTdLogFiles(dir, days) {
  let names;
  try { names = fs.readdirSync(dir); }
  catch (e) {
    return { dir, readable: false, reason: e.code === 'ENOENT' ? 'the folder does not exist' : `cannot read the folder (${e.code || e.message})`, files: [], found: 0, newest: null, oldest: null };
  }
  const byDate = new Map();
  for (const name of names.sort()) {
    const m = FILE_NAME.exec(name);
    if (!m) continue;
    if (!byDate.has(m[1]) || !m[2]) byDate.set(m[1], { date: m[1], file: path.join(dir, name) });
  }
  const all = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!all.length) return { dir, readable: true, files: [], found: 0, newest: null, oldest: null };
  const newest = all[all.length - 1].date;
  const files = all.filter(f => dayNumber(newest) - dayNumber(f.date) < days);
  return { dir, readable: true, files, found: all.length, newest, oldest: files[0].date };
}

/**
 * Stream the given files and collect berths and step counts for one TD area.
 * @returns {Promise<{berths:Set<string>, stepBerths:Set<string>, edges:Map<string,Map<string,number>>,
 *   lines:number, areaLines:number, bad:number, events:object, perFile:object[]}>}
 */
async function readTdLogs(files, { area = 'LA' } = {}) {
  const berths = new Set();        // every berth in any event
  const stepBerths = new Set();    // berths that are an end of a CA step
  const edges = new Map();         // from -> Map(to -> times seen)
  const events = new Counter(40);
  let lines = 0, areaLines = 0, bad = 0;
  const perFile = [];

  for (const f of files) {
    const info = { date: f.date, lines: 0, bad: 0, error: null };
    try {
      const rl = readline.createInterface({ input: openSource(f.file).stream, crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        lines++; info.lines++;
        let o;
        try { o = JSON.parse(line); } catch (_) { bad++; info.bad++; continue; }
        if (!o || typeof o !== 'object' || areaKey(o.area) !== area) continue;
        areaLines++;
        const event = str(o.event).toUpperCase();
        events.add(event);
        const from = str(o.from), to = str(o.to);
        if (event === 'CA') {
          if (from) { berths.add(from); stepBerths.add(from); }
          if (to) { berths.add(to); stepBerths.add(to); }
          if (from && to && from !== to) {
            let m = edges.get(from);
            if (!m) { m = new Map(); edges.set(from, m); }
            m.set(to, (m.get(to) || 0) + 1);
          }
        } else if (event === 'CB') { if (from) berths.add(from); }
        else if (event === 'CC') { if (to) berths.add(to); }
      }
    } catch (e) {
      info.error = e.code || e.message;                // one unreadable day must not lose the others
    }
    perFile.push(info);
  }
  return { berths, stepBerths, edges, lines, areaLines, bad, events: events.toObject(), perFile };
}

module.exports = { findTdLogFiles, readTdLogs, FILE_NAME };
