'use strict';

// GET /map/v1/station/:crs  (contract section 14)
//
//   { station: {crs, name, lat, lon},
//     board:  [{trainId|null, hc, uid, toc, o, d, kind: "arr"|"dep"|"pass", booked, expected, actual, platform, late, cancelled}],
//     recent: [{hc, kind, time, late}] }
//
// Built from today's schedules (CIF with VSTP applied) that touch the station's TIPLOCs, joined to
// their TRUST activations. Freight and ECS are included.
//
//   kind     origin -> "dep", terminus -> "arr", an intermediate call -> "dep" (the departure, as on a
//            departures board), a point with only a pass time -> "pass";
//   board    events NOT yet reported whose EXPECTED time falls in [now - 5 min, now + 2 h], cancelled
//            ones included (flagged), plus events reported in the last 30 minutes (actual set,
//            expected = actual). expected = booked + the train's current lateness, never earlier
//            than now, or just booked when lateness is unknown; sorted by expected, then booked, then headcode;
//   recent   events REPORTED in the last 30 minutes, latest first (the same reports, as a short list);
//   times    "HH:MM" London. late is signed minutes (null if unknown). platform is the real one once reported.
//
// A fresh walk of the day's schedules costs a few ms, so results are cached for a few seconds per station.

const { london, hhmm } = require('./time');
const { derive } = require('./progress');
const { round5 } = require('./geo');

const AHEAD_MIN = 120, BEHIND_MIN = 30, GRACE_MIN = 5;

function buildBoard(app, crs, nowMs) {
  const st = app.stationByCrs(crs);
  if (!st) return null;
  const ctx = app.ctx();
  const cif = ctx.cif;
  const station = { crs: st.crs, name: st.name, lat: round5(st.lat), lon: round5(st.lon) };
  const out = { station, board: [], recent: [] };
  if (!cif) return out;
  const tiplocs = app.stationTiplocs(st);
  if (!tiplocs.size) return out;
  const l = london(nowMs);
  const trainByUid = new Map();
  for (const t of app.model.byId.values()) if (t.svc) trainByUid.set(t.svc.rec.uid, t.id);
  const board = [], recent = [];

  for (const day of cif.days) {
    const nowMin = (l.dayNum - day.dayNum) * 1440 + Math.floor(l.minutes);
    for (const rec of cif.eachRec(day)) {
      let hit = -1;
      for (let i = 0; i < rec.n; i++) if (tiplocs.has(cif.tiplocAt(rec, i))) {
        const p = cif.point(rec, i);
        const t = p.dep >= 0 ? p.dep : p.pass >= 0 ? p.pass : p.arr;
        if (t >= nowMin - BEHIND_MIN - 360 && t <= nowMin + AHEAD_MIN + 360) { hit = i; break; }
      }
      if (hit < 0) continue;
      const act = app.trust.actFor(rec.uid, day.dayNum);
      const d = derive(ctx, rec, act, app.trust, nowMs, day.dayNum);
      let svc = null;
      for (let i = hit; i < rec.n; i++) {
        if (!tiplocs.has(cif.tiplocAt(rec, i))) { if (i > hit) break; continue; }
        const p = cif.point(rec, i), c = d.calls[i];
        const passOnly = p.arr < 0 && p.dep < 0;
        const kind = passOnly ? 'pass' : i === rec.n - 1 ? 'arr' : 'dep';
        const booked = kind === 'pass' ? p.pass : kind === 'arr' ? p.arr : (p.dep >= 0 ? p.dep : p.arr);
        if (booked < 0) continue;
        const actual = kind === 'pass' ? c.actualPass : kind === 'arr' ? c.actualArr : c.actualDep;
        const late = c.variation !== null ? c.variation : d.late;
        if (!svc) svc = cif.svc(rec, app.namer);
        const base = { trainId: trainByUid.get(rec.uid) || null, hc: rec.hc, uid: rec.uid, toc: rec.toc, o: svc.o, d: svc.d, kind };
        if (actual !== null) {
          const secs = kind === 'pass' ? c._pass : kind === 'arr' ? c._arr : c._dep;
          const mins = secs / 60;
          if (mins >= nowMin - BEHIND_MIN && mins <= nowMin + 1) {
            recent.push({ k: mins - nowMin, row: { hc: rec.hc, kind, time: actual, late } });
            board.push({ k: mins, b: booked, row: { ...base, booked: hhmm(booked), expected: actual, actual, platform: c.platformActual || p.platform || null, late, cancelled: false } });
          }
          continue;
        }
        const expMin = late === null || c.cancelled ? booked : Math.max(booked + late, nowMin);
        if (expMin < nowMin - GRACE_MIN || expMin > nowMin + AHEAD_MIN) continue;
        board.push({
          k: expMin, b: booked,
          row: { ...base, booked: hhmm(booked), expected: hhmm(expMin), actual: null, platform: c.platformActual || p.platform || null, late, cancelled: !!c.cancelled }
        });
      }
    }
  }
  board.sort((a, b) => a.k - b.k || a.b - b.b || (a.row.hc < b.row.hc ? -1 : a.row.hc > b.row.hc ? 1 : 0) || (a.row.uid < b.row.uid ? -1 : 1));
  recent.sort((a, b) => b.k - a.k || (a.row.hc < b.row.hc ? -1 : 1));
  out.board = board.slice(0, 150).map(x => x.row);
  out.recent = recent.slice(0, 100).map(x => x.row);
  return out;
}

module.exports = { buildBoard, AHEAD_MIN, BEHIND_MIN };
