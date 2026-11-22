'use strict';
// Where each TD area's berth events come from, day by day, in one shape (berth-first-v1-plan §5).
//
//   td-all/td-all-<date>.jsonl(.gz)          every area, raw feed messages, since 2026-11-19 21:52
//   sclass/cclass-<AREA>-<date>.jsonl(.gz)   the 12 banked areas, since ~23 Aug (BM since 23 Jun)
//   td/td-<date>.jsonl(.gz)                  area LA (Portslade's own log), since May
//
// The per-area logs and td-all carry the same events for their area (checked 2026-11-20: cclass-BM
// and td-all's BM lines are both 8,862), and both time them by the feed's own clock, to the second.
// So an area's day is read from its per-area log when there is one (it covers the whole day), and
// from td-all otherwise. Heartbeats (CT) exist only in td-all.
//
// What a message IS comes from its fields, never its label: from+to is a step, from alone a cancel,
// to alone an interpose. The labels were swapped in td-listener until 2026-11-21 (73ca165), so the
// older td logs say CB where they mean CC; the fields were always right.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

const DATE_RE = /(\d{4}-\d{2}-\d{2})/;

function listDated(dir, re) {
  const out = new Map();
  if (!dir || !fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(re);
    if (!m) continue;
    // Prefer the .gz once a day is rotated; a day can briefly have both.
    const prev = out.get(m[1]);
    if (!prev || f.endsWith('.gz')) out.set(m[1], path.join(dir, f));
  }
  return out;
}

// { tdAll: Map(date → file), perArea: Map(area → Map(date → file)) }
function catalogue({ tdAllDir, sclassDir, tdDir, tdArea = 'LA' }) {
  const tdAll = listDated(tdAllDir, /^td-all-(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/);
  const perArea = new Map();
  if (sclassDir && fs.existsSync(sclassDir)) {
    for (const f of fs.readdirSync(sclassDir)) {
      const m = f.match(/^cclass-([A-Z0-9]{2})-(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/);
      if (!m) continue;
      if (!perArea.has(m[1])) perArea.set(m[1], new Map());
      const prev = perArea.get(m[1]).get(m[2]);
      if (!prev || f.endsWith('.gz')) perArea.get(m[1]).set(m[2], path.join(sclassDir, f));
    }
  }
  const td = listDated(tdDir, /^td-(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/);
  if (td.size) {
    if (!perArea.has(tdArea)) perArea.set(tdArea, new Map());
    for (const [d, f] of td) if (!perArea.get(tdArea).has(d)) perArea.get(tdArea).set(d, f);
  }
  return { tdAll, perArea };
}

function datesBetween(from, to) {
  const out = [];
  for (let d = new Date(`${from}T12:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// Which file each area's day comes from: per-area log first, then td-all, else none.
function sourceFor(cat, area, date) {
  const pa = cat.perArea.get(area);
  if (pa && pa.has(date)) return { kind: 'perArea', file: pa.get(date) };
  if (cat.tdAll.has(date)) return { kind: 'tdAll', file: cat.tdAll.get(date) };
  return null;
}

function lines(file) {
  const stream = file.endsWith('.gz') ? fs.createReadStream(file).pipe(zlib.createGunzip()) : fs.createReadStream(file);
  return readline.createInterface({ input: stream, crlfDelay: Infinity });
}

function kindOf(from, to) {
  if (from && to) return 'step';
  if (from) return 'cancel';
  if (to) return 'interpose';
  return null;
}

// A per-area log line: {ts, area, event, desc, from, to}.
function fromPerArea(r, seq) {
  const kind = kindOf(r.from, r.to);
  if (!kind || !r.area) return null;
  return { t: Date.parse(r.ts), rx: null, area: r.area, kind, from: r.from || null, to: r.to || null, descr: r.desc || '', seq };
}

// A td-all line: {rx, msg_type, area_id, time, from, to, descr}.
function fromTdAll(r, seq) {
  if (r.msg_type === 'CT') return { t: +r.time, rx: Date.parse(r.rx), area: r.area_id, kind: 'heartbeat', seq };
  if (r.msg_type !== 'CA' && r.msg_type !== 'CB' && r.msg_type !== 'CC') return null;
  const kind = kindOf(r.from, r.to);
  if (!kind) return null;
  return { t: +r.time, rx: Date.parse(r.rx), area: r.area_id, kind, from: r.from || null, to: r.to || null, descr: r.descr || '', seq };
}

// The area of a td-all line without parsing it (td-all is ~3.5 M lines a day).
function tdAllArea(line) {
  const i = line.indexOf('"area_id":"');
  return i < 0 ? null : line.substr(i + 11, 2);
}

/**
 * One day's events for `areas`, sorted by feed time (then receive time, then file order).
 * Also returns:
 *   foreignMatches: Map("<t>|<descr>" → [{area, kind, from, to}]) — messages in areas NOT in `areas`
 *     (td-all only) with the same second and description as one of ours, so a train arriving from an
 *     unread neighbour is recognised: a hand-over (insight 1: interpose into our berth + cancel from
 *     theirs) or the same step reported by both (TB 0682→0677 with LA T682→T677);
 *   heartbeats: Map(area → [t]) for our areas, from td-all;
 *   used: Map(area → {kind, file}) or null when the area has no data that day.
 */
async function readDay(cat, date, areas, { foreign = true } = {}) {
  const want = new Set(areas);
  const used = new Map();
  const byFile = new Map();
  for (const a of areas) {
    const s = sourceFor(cat, a, date);
    used.set(a, s);
    if (!s) continue;
    if (!byFile.has(s.file)) byFile.set(s.file, { kind: s.kind, areas: new Set() });
    byFile.get(s.file).areas.add(a);
  }
  // td-all is read for foreign matches even when every wanted area has a per-area log.
  if (foreign && cat.tdAll.has(date) && !byFile.has(cat.tdAll.get(date))) {
    byFile.set(cat.tdAll.get(date), { kind: 'tdAll', areas: new Set() });
  }
  const events = [];
  const heartbeats = new Map();
  // Messages from areas we are NOT reading that share a second and a description with one of ours:
  // a hand-over or the same step reported by a neighbour. Matched in a short rolling window (the
  // national log is ~3.5 M lines a day; only the matches are kept).
  const foreignMatches = new Map();
  const ours = new Map(), theirs = new Map();       // t → Set(descr) / t → [line]
  const WINDOW_MS = 10e3;
  let windowEnd = 0;
  const match = (t, descr, line) => {
    let r; try { r = JSON.parse(line); } catch (e) { return; }
    const e = fromTdAll(r, 0);
    if (!e || e.kind === 'heartbeat') return;
    const k = `${t}|${descr}`;
    if (!foreignMatches.has(k)) foreignMatches.set(k, []);
    foreignMatches.get(k).push({ area: e.area, kind: e.kind, from: e.from, to: e.to });
  };
  const field = (line, name) => { const i = line.indexOf(`"${name}":"`); if (i < 0) return null; const j = line.indexOf('"', i + name.length + 4); return line.slice(i + name.length + 4, j); };
  let seq = 0, tdAllFirst = null;
  for (const [file, spec] of byFile) {
    const rl = lines(file);
    for await (const line of rl) {
      if (!line) continue;
      if (spec.kind === 'tdAll') {
        const area = tdAllArea(line);
        const isCT = line.includes('"msg_type":"CT"');
        if (tdAllFirst === null) tdAllFirst = +field(line, 'time');
        if (isCT) {
          if (want.has(area)) {
            if (!heartbeats.has(area)) heartbeats.set(area, []);
            heartbeats.get(area).push(+field(line, 'time'));
          }
          continue;
        }
        if (foreign) {
          const t = +field(line, 'time'), descr = field(line, 'descr');
          if (t > windowEnd) {                                   // forget seconds older than the window
            windowEnd = t;
            for (const k of ours.keys()) if (k < t - WINDOW_MS) ours.delete(k);
            for (const k of theirs.keys()) if (k < t - WINDOW_MS) theirs.delete(k);
          }
          if (descr) {
            if (want.has(area)) {
              if (!ours.has(t)) ours.set(t, new Set());
              ours.get(t).add(descr);
              for (const l of theirs.get(t) || []) if (field(l, 'descr') === descr) match(t, descr, l);
            } else {
              if (!theirs.has(t)) theirs.set(t, []);
              theirs.get(t).push(line);
              if (ours.has(t) && ours.get(t).has(descr)) match(t, descr, line);
            }
          }
        }
        if (!spec.areas.has(area)) continue;
        let r; try { r = JSON.parse(line); } catch (e) { continue; }
        const e = fromTdAll(r, seq++);
        if (e) events.push(e);
      } else {
        let r; try { r = JSON.parse(line); } catch (e) { continue; }
        if (!spec.areas.has(r.area)) continue;
        const e = fromPerArea(r, seq++);
        if (e && Number.isFinite(e.t)) events.push(e);
      }
    }
  }
  events.sort((a, b) => a.t - b.t || (a.rx || 0) - (b.rx || 0) || a.seq - b.seq);
  for (const v of heartbeats.values()) v.sort((a, b) => a - b);
  // tdAllFirst: when the national log starts that day (it began at 21:52 on 2026-11-19), so a caller
  // knows from when a hand-over from an unread area could have been recognised.
  return { date, events, foreignMatches, heartbeats, used, tdAllFirst };
}

module.exports = { catalogue, datesBetween, sourceFor, readDay, kindOf, fromPerArea, fromTdAll, DATE_RE };
