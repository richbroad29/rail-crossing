'use strict';
// Links a train the berths saw at a crossing to its timetable entry, for the measurements that need
// a booked time or a stopping pattern (outermost-berth offsets, per-class berth times, run-through).
//
// Link = same headcode, a schedule that runs that day (the STP winner per uid: C > N > O > P, as
// schedule-parser does), passing the crossing in the same direction, booked crossing time nearest to
// the clear step within [-120 min, +30 min] (late trains are common, early ones rare). Two equally
// near entries, or none, leave the train unlinked (design §5.3).
//
// Only one full extract is read. A full extract holds every schedule still valid on its date, so
// for earlier days it lacks one-day overlays that have since expired: such a day falls back to the
// permanent schedule. The provenance in the routes file says which extract was used.

const fs = require('fs');
const zlib = require('zlib');
const readline = require('readline');
const { parseLondonWallClock, shiftDateStamp, londonDateStamp } = require('../../src/time-utils');

const STP_PRIORITY = { P: 0, O: 1, N: 2, C: 3 };

function cifMins(t) {
  if (!t) return null;
  return parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(2, 4), 10) + (t.endsWith('H') ? 0.5 : 0);
}

// Train class from the timetable, falling back to the headcode's first digit.
function classOf(category, headcode) {
  const c = category || '';
  if (/^(B|S)/.test(c)) return 'other';                              // bus, ship
  if (/^(O|X)/.test(c)) return 'passenger';
  if (/^E(E|L|S)$/.test(c)) return 'ecs';
  if (c) return 'freight';
  const d = (headcode || '')[0];
  if ('12 9'.includes(d)) return 'passenger';
  if (d === '5' || d === '3') return 'ecs';
  if ('04678'.includes(d)) return 'freight';
  return 'unknown';
}

/**
 * point: { station: TIPLOC } or { between: [A, B], fraction } — where the crossing is
 * before: { <dir>: [TIPLOC...] } — timing points a train in that direction passes BEFORE the crossing
 */
async function loadCif(file, { point, before }) {
  const tiplocs = point.station ? [point.station] : point.between;
  const keep = new Map();      // uid → [schedule]
  const overrides = new Map(); // uid → [{stp, start, end, days}] for every non-P record
  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let header = null;
  for await (const line of rl) {
    if (!header && line.includes('JsonTimetableV1')) { try { header = JSON.parse(line).JsonTimetableV1; } catch (e) {} continue; }
    if (!line.startsWith('{"JsonScheduleV1"')) continue;
    const touches = tiplocs.some(t => line.includes(`"${t}"`));
    const nonP = !line.includes('"CIF_stp_indicator":"P"');
    if (!touches && !nonP) continue;
    let s; try { s = JSON.parse(line).JsonScheduleV1; } catch (e) { continue; }
    if (s.transaction_type && s.transaction_type !== 'Create') continue;
    const base = { uid: s.CIF_train_uid, stp: s.CIF_stp_indicator, start: s.schedule_start_date, end: s.schedule_end_date, days: s.schedule_days_runs };
    if (s.CIF_stp_indicator !== 'P') {
      if (!overrides.has(base.uid)) overrides.set(base.uid, []);
      overrides.get(base.uid).push(base);
    }
    if (!touches || s.CIF_stp_indicator === 'C') continue;
    const seg = s.schedule_segment || {};
    const locs = [];
    let prev = null, add = 0;
    for (const L of seg.schedule_location || []) {
      let m = cifMins(L.pass || L.departure || L.arrival);
      if (m === null) continue;
      if (prev !== null && m + add < prev - 360) add += 1440;     // past midnight: unwrap
      m += add; prev = m;
      locs.push({ tiploc: L.tiploc_code, mins: m, stop: !L.pass });
    }
    const sched = { ...base, headcode: seg.signalling_id, category: seg.CIF_train_category, locs };
    // Direction and booked crossing minute.
    let xMins = null, dir = null;
    if (point.station) {
      const i = locs.findIndex(l => l.tiploc === point.station);
      if (i < 0) continue;
      xMins = locs[i].mins;
      // A train starting at the crossing's station has nothing before it: dir stays null and the
      // link does not test direction.
      for (const [d, set] of Object.entries(before)) if (locs.slice(0, i).some(l => set.includes(l.tiploc))) dir = d;
    } else {
      const [A, B] = point.between;
      const ia = locs.findIndex(l => l.tiploc === A), ib = locs.findIndex(l => l.tiploc === B);
      if (ia < 0 || ib < 0 || Math.abs(ia - ib) !== 1) continue;
      const first = Math.min(ia, ib);
      const f = ia < ib ? point.fraction : 1 - point.fraction;
      xMins = locs[first].mins + f * (locs[first + 1].mins - locs[first].mins);
      for (const [d, set] of Object.entries(before)) if (set.includes(locs[first].tiploc)) dir = d;
    }
    sched.xMins = xMins; sched.dir = dir;
    if (!keep.has(sched.uid)) keep.set(sched.uid, []);
    keep.get(sched.uid).push(sched);
  }
  const byHeadcode = new Map();
  for (const list of keep.values()) for (const s of list) {
    if (!byHeadcode.has(s.headcode)) byHeadcode.set(s.headcode, []);
    byHeadcode.get(s.headcode).push(s);
  }
  return { header, byHeadcode, overrides, file };
}

function runsOn(rec, date) {
  if (rec.start > date || rec.end < date) return false;
  const dow = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;   // Monday = 0
  return rec.days && rec.days[dow] === '1';
}

// The schedule of `s.uid` that wins on `date`: s itself unless a higher-ranked record runs that day.
function wins(cif, s, date) {
  if (!runsOn(s, date)) return false;
  const r = STP_PRIORITY[s.stp] || 0;
  for (const o of cif.overrides.get(s.uid) || []) if ((STP_PRIORITY[o.stp] || 0) > r && runsOn(o, date)) return false;
  return true;
}

function minsToMs(date, mins) {
  const day = Math.floor(mins / 1440), within = mins - day * 1440;
  const h = Math.floor(within / 60), m = Math.floor(within % 60), sec = Math.round((within % 1) * 60);
  const d = parseLondonWallClock(`${shiftDateStamp(date, day)}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`);
  return d ? d.getTime() : null;
}

/** Link { descr, dir, t } → { sched, date, xMs, lateSecs, locs: [{tiploc, ms, stop}] } or null. */
function link(cif, { descr, dir, t }) {
  const cands = cif.byHeadcode.get(descr);
  if (!cands) return null;
  const today = londonDateStamp(new Date(t));
  const found = [];
  for (const date of [shiftDateStamp(today, -1), today]) {
    for (const s of cands) {
      if (s.dir && dir && s.dir !== dir) continue;
      if (!wins(cif, s, date)) continue;
      const xMs = minsToMs(date, s.xMins);
      if (xMs === null) continue;
      const late = (t - xMs) / 1000;
      if (late < -1800 || late > 7200) continue;
      found.push({ s, date, xMs, late });
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => Math.abs(a.late) - Math.abs(b.late));
  if (found.length > 1 && found[1].s.uid !== found[0].s.uid && Math.abs(Math.abs(found[1].late) - Math.abs(found[0].late)) < 120) return null;
  const f = found[0];
  return {
    sched: f.s, date: f.date, xMs: f.xMs, lateSecs: f.late,
    locs: f.s.locs.map(l => ({ tiploc: l.tiploc, ms: minsToMs(f.date, l.mins), stop: l.stop, mins: l.mins }))
  };
}

module.exports = { loadCif, link, classOf, cifMins, runsOn, wins, minsToMs };
