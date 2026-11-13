'use strict';

// All functions here treat Europe/London as authoritative for UK rail times.
// The VPS runs in UTC; naive new Date() / setHours() calls would produce
// +60 min drift during BST (last Sunday March → last Sunday October).
// Every function uses Intl with an explicit timeZone so TZ env var is irrelevant.

const LONDON_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit'
});

function londonParts(d) {
  return Object.fromEntries(LONDON_FMT.formatToParts(d).map(x => [x.type, x.value]));
}

/**
 * Parse an ISO-like wall-clock string (no TZ suffix) as Europe/London local time.
 * Returns a correct UTC Date.
 *
 * DST handling:
 *   - Spring forward (last Sunday March, 01:00–01:59): these wall-clock times
 *     do not exist. Neither candidate round-trips. Returns null and emits a
 *     console.warn so the caller can silently drop the train.
 *   - Autumn clock change (last Sunday October, 01:00–01:59): two candidates
 *     both round-trip (BST and GMT occurrences). The loop tries shiftMs=0 first,
 *     which lands the second / post-rollback occurrence (= GMT). Network Rail's
 *     WTT convention treats the duplicated hour as standard time (GMT), so this
 *     is intentionally correct — do not reorder the shift array.
 */
function parseLondonWallClock(iso) {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], s = +(m[6] || 0);
  const naiveUtcMs = Date.UTC(y, mo - 1, d, h, mi, s);

  for (const shiftMs of [0, -3600000]) {
    const cand = new Date(naiveUtcMs + shiftMs);
    const p = londonParts(cand);
    if (+p.year === y && +p.month === mo && +p.day === d &&
        +p.hour === h && +p.minute === mi && +p.second === s) {
      return cand;
    }
  }

  // Spring-forward gap: the input time doesn't exist in Europe/London.
  console.warn(`[time-utils] parseLondonWallClock: "${iso}" does not exist in Europe/London (spring-forward gap) — dropping`);
  return null;
}

/**
 * Add `days` to a "YYYY-MM-DD" stamp using pure calendar arithmetic. Done in
 * UTC (date-only, so no DST drift); the wall-clock time is applied afterwards
 * by parseLondonWallClock, which handles BST/GMT for the resulting date.
 */
function shiftDateStamp(stamp, days) {
  if (!days) return stamp;
  const d = new Date(`${stamp}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

/**
 * Convert CIF/schedule minutes-since-midnight (Europe/London wall-clock) to a
 * UTC Date, relative to today's service day. Returns null if the time falls in
 * the spring-forward gap.
 *
 * Day rollover (intended behaviour): a crossing can fall on a different
 * calendar day than today. A service departing late evening and crossing at
 * ~00:05 yields mins >= 1440 (the schedule-parser unwraps post-midnight times
 * onto a monotonic scale). Such a value must map to TOMORROW 00:05 — not be
 * folded back onto today by "% 24". We therefore split off whole days and shift
 * the date stamp accordingly (negative mins → a previous day, handled the same
 * way via floor division).
 */
function londonMinsToDate(mins) {
  if (mins === null || mins === undefined) return null;
  // Round to whole minutes first so a fractional (interpolated half-minute)
  // input can never produce mm = "60".
  const total = Math.round(mins);
  const dayOffset = Math.floor(total / 1440);
  const within = total - dayOffset * 1440; // 0..1439
  const h = Math.floor(within / 60);
  const mi = within % 60;
  const hh = String(h).padStart(2, '0');
  const mm = String(mi).padStart(2, '0');
  const dateStamp = shiftDateStamp(londonDateStamp(), dayOffset);
  return parseLondonWallClock(`${dateStamp}T${hh}:${mm}:00`);
}

/**
 * The London calendar date ("YYYY-MM-DD") of `d` (default now), not UTC.
 * Differs from d.toISOString().slice(0,10) during BST 00:00–01:00.
 */
function londonDateStamp(d = new Date()) {
  const p = londonParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

// The railway day a moment belongs to, as "YYYY-MM-DD": the London date, except that the hours
// before SERVICE_DAY_START_HOUR London still count as the previous day. Used for "which trains
// has the signalling feed seen today" (crossing-state tdSeenToday).
//
// Why not midnight: the last trains of the evening are still stepping through the berths after
// midnight. Counted as the NEW day's first sighting, that step marks the same headcode's run later
// in the new day as already seen hours ago, and the timetable entry for it is then dropped as
// long gone. Measured over 177 days of Portslade TD (2026-05-16..11-12), counting the previous
// evening's trains that step after the boundary and are timetabled again the next day:
// 344 with the boundary at 00:00 London, 3 at 01:00, 2 from 02:30 to 04:00 (both a freight that
// genuinely ran at 04:30). 03:00 sits in the quiet hours, after the last of them and before the
// 04:00 timetable refresh.
const SERVICE_DAY_START_HOUR = 3;
function serviceDayStamp(d = new Date()) {
  const p = londonParts(d);
  const date = `${p.year}-${p.month}-${p.day}`;
  return +p.hour < SERVICE_DAY_START_HOUR ? shiftDateStamp(date, -1) : date;
}

module.exports = { parseLondonWallClock, londonMinsToDate, londonDateStamp, shiftDateStamp, serviceDayStamp, SERVICE_DAY_START_HOUR };
