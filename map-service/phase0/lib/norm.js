'use strict';

// Value normalisation shared by the SMART, CORPUS and TD readers, so a value means the same thing
// in every file we join on it.
//
// Everything is documented as a JSON string, but this whole script exists because the documentation
// has not been checked against a real download. So: coerce rather than crash, and let the format
// facts show what was actually there.

/** A field value as a trimmed string. null / undefined / objects / arrays become ''. */
function str(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

/**
 * STANOX is a 5-digit code. If a file delivered it as a JSON number it would have lost its leading
 * zeros, so purely numeric values shorter than 5 digits are padded back. Applied identically on both
 * sides of every join, so it can only make a join more forgiving, never produce a false match
 * between two different 5-digit codes.
 */
function stanoxKey(v) {
  const s = str(v);
  return /^\d{1,4}$/.test(s) ? s.padStart(5, '0') : s;
}

/** A CRS code (3 letters), or '' if the value is blank or not one. CORPUS blanks are a single space. */
function crsKey(v) {
  const s = str(v).toUpperCase();
  return /^[A-Z]{3}$/.test(s) ? s : '';
}

/** A TD area code, upper-cased. */
function areaKey(v) { return str(v).toUpperCase(); }

/** SMART EVENT: A = arrive up, B = depart up, C = arrive down, D = depart down (as documented). */
const EVENT_KINDS = {
  A: { kind: 'arrival', dir: 'up' },
  B: { kind: 'departure', dir: 'up' },
  C: { kind: 'arrival', dir: 'down' },
  D: { kind: 'departure', dir: 'down' }
};

/** { kind, dir } for a documented EVENT code, or null for anything else. */
function classifyEvent(event) { return EVENT_KINDS[event] || null; }

module.exports = { str, stanoxKey, crsKey, areaKey, classifyEvent, EVENT_KINDS };
