'use strict';

// Europe/London wall-clock helpers.
//
// Two questions the interlock asks are London-time questions: "which TD log file is today's?"
// (the crossing service names it by the London date, so it rolls over at London midnight, not UTC
// midnight) and "is the log-silence fallback valid right now?" (LA goes quiet overnight by London
// hours). London is UTC+1 for half the year, so neither can be answered with getUTCHours().

const FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23'
});

/** The London wall-clock fields of an instant. `date` is YYYY-MM-DD, `minutesOfDay` is 0..1439. */
function londonParts(when) {
  const d = when instanceof Date ? when : new Date(when);
  const p = {};
  for (const { type, value } of FORMAT.formatToParts(d)) p[type] = value;
  // `% 24` because some ICU builds print midnight as "24" even with h23.
  const hour = Number(p.hour) % 24;
  const minute = Number(p.minute);
  return {
    year: p.year, month: p.month, day: p.day,
    hour, minute, second: Number(p.second),
    date: `${p.year}-${p.month}-${p.day}`,
    minutesOfDay: hour * 60 + minute
  };
}

/** YYYY-MM-DD in Europe/London — the suffix of the crossing service's td-<date>.jsonl. */
function londonDateStamp(when) { return londonParts(when).date; }

/** HH:MM:SS in Europe/London, for messages a person will read. */
function londonClock(when) {
  const p = londonParts(when);
  const two = n => String(n).padStart(2, '0');
  return `${two(p.hour)}:${two(p.minute)}:${two(p.second)}`;
}

/** "2026-11-02 10:15:00 UTC" — the form `journalctl --since` accepts regardless of the box's TZ. */
function utcStamp(when) {
  const d = when instanceof Date ? when : new Date(when);
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/** HH:MM:SS in UTC, for the progress lines. */
function utcClock(when) {
  const d = when instanceof Date ? when : new Date(when);
  return d.toISOString().slice(11, 19);
}

/**
 * Does [startMs, endMs] touch the crossing service's daily timetable reload (04:00 London, per
 * CLAUDE.md)? The reload is when the crossing service's memory and event loop are busiest, so a
 * run that spans it measures the worst case — and is also the run most likely to see the
 * interlock trip. Both are worth saying in the report. `slackMin` widens the window either side
 * because the reload starts a little after 04:00 and takes a while.
 */
function overlapsDailyReload(startMs, endMs, slackMin = 15) {
  // Sample the run every five minutes and ask London what time it is. Sampling (rather than
  // computing 04:00 on each London date) sidesteps DST arithmetic, and a five-minute step cannot
  // jump over a window that is 2 x slackMin wide so long as slackMin >= 3.
  const lo = 4 * 60 - slackMin, hi = 4 * 60 + slackMin;
  for (let t = startMs; ; t += 5 * 60 * 1000) {
    const at = Math.min(t, endMs);
    const m = londonParts(at).minutesOfDay;
    if (m >= lo && m <= hi) return true;
    if (at >= endMs) return false;
  }
}

module.exports = { londonParts, londonDateStamp, londonClock, utcStamp, utcClock, overlapsDailyReload };
