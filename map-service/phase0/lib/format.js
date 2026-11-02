'use strict';

// Number and text formatting for report messages, so every line reads the same way.
// Deliberately not toLocaleString: its output depends on how Node was built.

/** 1234567 -> "1,234,567" */
function fmtInt(n) {
  if (!Number.isFinite(n)) return String(n);
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** n/d as a percentage rounded to one decimal, as a number (78.4). 0 when d is 0. */
function pct(n, d) {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
}

/** n/d as "78.4%", or "n/a" when d is 0. */
function fmtPct(n, d) {
  return d > 0 ? `${pct(n, d).toFixed(1)}%` : 'n/a';
}

/** Collapse whitespace and cut to `max` characters, for quoting file content inside a one-line message. */
function oneLine(s, max = 120) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Bytes to megabytes with one decimal. */
function mb(bytes) { return Math.round((bytes / 1048576) * 10) / 10; }

/** "1 row" / "2 rows". */
function plural(n, one, many = one + 's') { return `${fmtInt(n)} ${n === 1 ? one : many}`; }

/** Verb agreement for a count: `${n} ${isAre(n)}` -> "1 is", "2 are". */
const isAre = n => (n === 1 ? 'is' : 'are');
const hasHave = n => (n === 1 ? 'has' : 'have');

/** "a, b, c" capped at `max` items with "+N more". */
function listCap(items, max = 12) {
  const a = [...items];
  return a.length <= max ? a.join(', ') : `${a.slice(0, max).join(', ')} +${a.length - max} more`;
}

/** 90000 -> "1.5 minutes", 45000 -> "45 seconds", 300 -> "0.3 seconds". */
function fmtDuration(ms) {
  if (ms >= 60000) { const m = Math.round(ms / 6000) / 10; return `${m} minute${m === 1 ? '' : 's'}`; }
  const s = ms >= 10000 ? Math.round(ms / 1000) : Math.round(ms / 100) / 10;
  return `${s} second${s === 1 ? '' : 's'}`;
}

module.exports = { fmtInt, pct, fmtPct, oneLine, mb, plural, listCap, fmtDuration, isAre, hasHave };
