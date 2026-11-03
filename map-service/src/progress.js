'use strict';

// What a schedule + its TRUST activation say about one train's journey, derived on demand:
//
//   * per calling point: actual arrival / departure / pass, variation, the platform it really used,
//     whether it is cancelled, and (for points not yet reached) booked + current lateness, never
//     earlier than now;
//   * the train's lateness (signed minutes, from the latest report);
//   * the NEXT STATION: the next call not yet passed, skipping passes and cancelled calls.
//
// Derived at read time rather than stored per point, so it is always consistent with whatever
// schedule record is current (the CIF index and VSTP overlay change under an activation).
//
// All times are minutes (or seconds) since the schedule day's London midnight, unwrapped across
// 00:00, exactly as the CIF index stores them.

const { london, hhmm } = require('./time');

/**
 * @param {object} ctx  { cif, stanoxOf(tiploc)->int, isStation(tiploc)->bool }
 * @param {object} rec  a schedule record
 * @param {object|null} act   the TRUST activation (or null)
 * @param {object} trust  the TrustState (for decoding events), or null
 * @param {number} nowMs
 */
function derive(ctx, rec, act, trust, nowMs, runDay) {
  const n = rec.n, cif = ctx.cif;
  const day = act ? act.runDay : runDay;
  const l = london(nowMs);
  const nowMin = (l.dayNum - day) * 1440 + l.minutes;
  const pts = new Array(n);
  const stanox = new Array(n);
  for (let i = 0; i < n; i++) { pts[i] = cif.point(rec, i); stanox[i] = ctx.stanoxOf(pts[i].tiploc); }
  const calls = pts.map(p => ({
    actualArr: null, actualDep: null, actualPass: null, variation: null, platformActual: null, cancelled: false, expArr: null, expDep: null, _arr: -1, _dep: -1, _pass: -1, _p: p
  }));
  let lastIdx = -1;
  const reportedAt = new Array(n).fill(false);

  if (act && trust && act.evN) {
    for (const e of trust.events(act)) {
      let bestI = -1, bestD = Infinity;
      for (let i = 0; i < n; i++) {
        if (stanox[i] !== e.stanox) continue;
        const p = pts[i];
        const booked = e.dep ? (p.dep >= 0 ? p.dep : p.pass >= 0 ? p.pass : p.arr) : (p.arr >= 0 ? p.arr : p.pass >= 0 ? p.pass : p.dep);
        const ref = e.plannedSec >= 0 ? e.plannedSec / 60 : e.actualSec / 60;
        const d = booked < 0 ? 1e6 : Math.abs(booked - ref);
        if (d < bestD) { bestD = d; bestI = i; }
      }
      if (bestI < 0) continue;
      const c = calls[bestI], p = pts[bestI];
      const passOnly = p.arr < 0 && p.dep < 0 && p.pass >= 0;
      const hm = hhmm(e.actualSec / 60);
      const sec = e.actualSec;
      if (e.dep) { if (passOnly) { c.actualPass = hm; c._pass = sec; } else { c.actualDep = hm; c._dep = sec; } }
      else { c.actualArr = hm; c._arr = sec; }
      if (!e.offroute && e.status !== 3) c.variation = e.status === 1 ? e.variation : e.status === 2 ? -e.variation : 0;
      if (e.platform) c.platformActual = e.platform;
      reportedAt[bestI] = true;
      if (bestI > lastIdx) lastIdx = bestI;
    }
    // cancellation: from the cancellation point on (AT ORIGIN: everything); change of origin: everything before the new origin
    const cx = act.cancel;
    if (cx) {
      let ci = -1;
      if (cx.type !== 'AT ORIGIN' && cx.stanox) {
        for (let i = 0; i < n; i++) if (stanox[i] === cx.stanox) { ci = i; if (reportedAt[i]) break; }
      }
      if (cx.type === 'AT ORIGIN' || ci < 0) { for (let i = 0; i < n; i++) if (!reportedAt[i]) calls[i].cancelled = true; }
      else for (let i = ci + 1; i < n; i++) calls[i].cancelled = true;
    }
    if (act.coo) {
      let oi = -1;
      for (let i = 0; i < n; i++) if (stanox[i] === act.coo) { oi = i; break; }
      if (oi > 0) for (let i = 0; i < oi; i++) calls[i].cancelled = true;
    }
  }

  const late = act && act.lateMins !== null ? act.lateMins : null;
  // Expected times: booked + lateness, only for points still ahead, never earlier than now.
  for (let i = 0; i < n; i++) {
    const c = calls[i], p = pts[i];
    if (c.cancelled || late === null) continue;
    if (i > lastIdx && p.arr >= 0) c.expArr = hhmm(Math.max(p.arr + late, nowMin));
    const awaitingDep = i > lastIdx || (i === lastIdx && c._arr >= 0 && c._dep < 0 && c._pass < 0);
    if (awaitingDep && p.dep >= 0) c.expDep = hhmm(Math.max(p.dep + late, nowMin));
  }

  // Next station.
  let start;
  if (lastIdx >= 0) start = lastIdx + 1;
  else {
    start = 1;
    for (let i = 1; i < n; i++) { const p = pts[i]; const t = p.arr >= 0 ? p.arr : p.dep >= 0 ? p.dep : p.pass; if (t >= nowMin - 1) { start = i; break; } start = i + 1; }
  }
  let next = null, nextI = -1, anyCall = -1;
  for (let i = Math.max(1, start); i < n; i++) {
    const p = pts[i], c = calls[i];
    if (c.cancelled || (p.arr < 0 && p.dep < 0)) continue;       // passes and cancelled calls are not "next"
    if (anyCall < 0) anyCall = i;
    if (ctx.isStation(p.tiploc)) { nextI = i; break; }
  }
  if (nextI < 0) nextI = anyCall;
  if (nextI >= 0) {
    const p = pts[nextI], c = calls[nextI];
    const booked = p.arr >= 0 ? p.arr : p.dep;
    const exp = late === null ? null : (p.arr >= 0 ? c.expArr : c.expDep) || hhmm(Math.max(booked + late, nowMin));
    next = { index: nextI, tiploc: p.tiploc, time: hhmm(booked), exp, clamped: late !== null && booked + late < nowMin };
  }
  return { calls, late, next, lastIdx, nowMin };
}

module.exports = { derive };
