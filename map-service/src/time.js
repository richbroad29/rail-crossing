'use strict';

// London wall-clock helpers. CIF times are wall-clock minutes in Europe/London, so all timetable
// arithmetic is done on London day numbers and minutes-of-day, never on UTC offsets: a DST change
// then cannot shift a train by an hour.

const FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
});

/** { dayNum, date: 'YYYY-MM-DD', minutes (float, since London midnight), dow (0=Mon..6=Sun), hour, minute } */
function london(ms) {
  const p = {};
  for (const part of FMT.formatToParts(new Date(ms))) p[part.type] = part.value;
  const y = +p.year, m = +p.month, d = +p.day;
  const dayNum = Math.round(Date.UTC(y, m - 1, d) / 86400000);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return {
    dayNum, date: `${p.year}-${p.month}-${p.day}`, dow,
    hour: +p.hour, minute: +p.minute,
    minutes: (+p.hour) * 60 + (+p.minute) + (+p.second) / 60
  };
}

/** YYYY-MM-DD -> day number, or NaN. */
function dayNumOf(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date || '');
  if (!m) return NaN;
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
}

/** Day number -> YYYY-MM-DD. */
function dateOfDayNum(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }

/** Day number -> 0=Mon..6=Sun. */
function dowOfDayNum(n) { return (new Date(n * 86400000).getUTCDay() + 6) % 7; }

/** Minutes since midnight -> 'HH:MM' (wraps past 24 h for display only). */
function hhmm(mins) {
  if (mins === null || mins === undefined || mins < 0) return null;
  const t = Math.round(mins);
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** The ms timestamp of the next occurrence of London hour:minute strictly after `ms`'s slot today (used by tests). */
function londonSlotPassed(ms, hour, minute, weekday) {
  const l = london(ms);
  if (weekday !== undefined && weekday !== null && l.dow !== weekday) return false;
  return l.hour * 60 + l.minute >= hour * 60 + minute;
}

module.exports = { london, dayNumOf, dateOfDayNum, dowOfDayNum, hhmm, londonSlotPassed };
