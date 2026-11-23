'use strict';
// Linking a tracked train to its timetable or board entry (docs/berth-first-design.md §5.3; v1-plan §2).
//
// v1 has no TRUST activations (v1.1), so a link is: the same headcode, the same direction, and the entry's
// time near when the berths say the train will cross. "Near" allows lateness (a train well behind its
// booked time is common) but little earliness. Two tracked trains with one headcode take the entries
// nearest each, best match first; two entries fitting one train equally well leave it unlinked (§5.3:
// its closure still comes from the berths, only its type and stopping pattern are uncertain).
//
// A train renamed where it stands keeps its old names (1S54 re-described 2Y48 in Portslade's platform
// berth 0005 on 19 Nov, 18:34, then crossed): the link tries the current headcode first, then each earlier
// one, so the entry it had is not lost to a rename.
//
// Board (LDB) and timetable (CIF) entries are linked separately: the classic timing merges a board entry
// and its timetable twin itself, so both may point at the same tracked train.

const { londonMinsToDate } = require('../time-utils');

const LATE_MS = 120 * 60e3;      // an entry booked up to 2 h before the berths' estimate (running late)
const EARLY_MS = 30 * 60e3;      // or up to 30 min after it (running early)
const TIE_MS = 2 * 60e3;         // two entries this close to each other in fit: ambiguous

const entryTime = (rec, kind) => {
  if (kind === 'ldb') { const d = new Date(rec.bestTime); return Number.isFinite(d.getTime()) ? d.getTime() : null; }
  const d = londonMinsToDate(rec.estimatedCrossingMins);
  return d ? d.getTime() : null;
};

/**
 * @param trains  [{ id, headcode, headcodes?, dir, expectedMs }] — tracked trains on the approach (or just
 *                crossed); headcodes = every headcode it has carried, latest first
 * @param ldb     the board entries; @param cif the timetable entries (classic engine shapes)
 * @returns Map(entry record → { id, expectedMs }) — what timing.js's adapter answers for each entry
 */
function linkEntries(trains, ldb, cif) {
  const out = new Map();
  for (const [kind, list] of [['ldb', ldb || []], ['cif', cif || []]]) {
    const pairs = [];
    const byHd = new Map();
    for (const rec of list) {
      if (!rec || !rec.headcode) continue;
      if (!byHd.has(rec.headcode)) byHd.set(rec.headcode, []);
      byHd.get(rec.headcode).push(rec);
    }
    for (const tr of trains) {
      const names = (tr.headcodes && tr.headcodes.length ? tr.headcodes : [tr.headcode]).filter(Boolean);
      names.forEach((hc, rank) => {
      if (!byHd.has(hc)) return;
      for (const rec of byHd.get(hc)) {
        if (rec.direction && tr.dir && rec.direction !== tr.dir) continue;
        const at = entryTime(rec, kind);
        if (at === null || tr.expectedMs === null) continue;
        const late = tr.expectedMs - at;                 // + = the train is behind its entry's time
        if (late > LATE_MS || late < -EARLY_MS) continue;
        // An earlier name fits only after every later one: rank it behind them.
        pairs.push({ tr, rec, fit: Math.abs(late) + rank * 6 * 3600e3 });
      }
      });
    }
    pairs.sort((a, b) => a.fit - b.fit);
    const usedTr = new Set(), usedRec = new Set();
    for (const p of pairs) {
      if (usedTr.has(p.tr.id) || usedRec.has(p.rec)) continue;
      // Ambiguous: another free entry fits this train almost as well.
      const rival = pairs.find(q => q !== p && q.tr === p.tr && !usedRec.has(q.rec) && q.fit - p.fit < TIE_MS && entryTime(q.rec, kind) !== entryTime(p.rec, kind));
      if (rival && !(p.rec.uid && rival.rec.uid === p.rec.uid)) { usedTr.add(p.tr.id); continue; }
      usedTr.add(p.tr.id); usedRec.add(p.rec);
      out.set(p.rec, { id: p.tr.id, expectedMs: p.tr.expectedMs, kind });
    }
  }
  return out;
}

module.exports = { linkEntries, LATE_MS, EARLY_MS };
