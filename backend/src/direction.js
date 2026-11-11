'use strict';

// Which way a departure-board (LDB) train is travelling over the crossing.
//
// The board gives no direction, only an origin and a destination. This used to be a
// hard-coded list of Sussex place names in ldb-poller (isEastOrigin): an origin on the list
// meant westbound, ANYTHING else eastbound. Right for Portslade almost always, wrong anywhere
// else, and silently so — an unrecognised origin was assigned a direction rather than marked
// unknown (multi-crossing-readiness.md, blocker 3).
//
// Resolution, in order, stopping at the first answer:
//   1. TIMETABLE — the crossing's own CIF entry for the same train (UID, else headcode at the
//      nearest time). CIF direction comes from the order the train passes the timing points
//      either side of the crossing (schedule-parser analyseRoute), so it is right even for a
//      diverted train. Supplied by the caller (CrossingState.timetableDirection).
//   2. PLACES — the crossing's `directions.<dir>.placesBeyond` lists: the places that lie
//      beyond the crossing when travelling that way. The DESTINATION decides first (where the
//      train is going says which way it is going); the origin only if the destination is on
//      neither list (coming from a place beyond the crossing in one direction means travelling
//      the other way).
//   3. 'unknown' — never a default. crossing-state resolves it from the berth chain once the
//      train is near enough to be seen there.
//
// Measured at Portslade over 179 days of logs (34,399 board trains), 2026-11-06:
//   - timetable matched 34,031; the old guess disagreed with it on 7, and the guess was wrong
//     each time (3 origins not on the list, 4 London Victoria -> Brighton trains diverted round
//     via Littlehampton on 10-11 Oct);
//   - the PLACES rule alone agreed with the timetable on 34,028 of those 34,031 (its 3 misses
//     are diverted Brighton -> London Victoria trains, which step 1 gets right);
//   - none of the 34,399 came out unknown.
//
// Direction KEYS are the crossing's two slots, named by its own definition (`directions`:
// Portslade east/west); nothing here names a slot. What each slot means is per crossing —
// `directions.<dir>.line` records the official Up/Down designation.

// The two slot names, in definition order.
function slotsOf(directions) { return Object.keys(directions || {}); }

// The other slot. Derived, never configured: a crossing has exactly two.
function oppositeOf(directions, dir) {
  const s = slotsOf(directions);
  return s.length === 2 && s.includes(dir) ? s[1 - s.indexOf(dir)] : null;
}

function norm(s) { return typeof s === 'string' ? s.trim().toLowerCase().replace(/\s+/g, ' ') : ''; }

// Does board name `name` match list entry `place`? The whole name, or its leading words:
// 'london' matches London Victoria and London Bridge, 'portsmouth' matches Portsmouth Harbour,
// but 'ford' matches only Ford — never Watford or Guildford, which the old substring test
// would have. Case-insensitive.
function matchesPlace(name, place) {
  const n = norm(name), p = norm(place);
  return !!p && (n === p || n.startsWith(p + ' '));
}

// Which direction's list a place name is on: a slot name, or null. A name matching BOTH
// lists is a config error, reported as null rather than guessed — validateDirections refuses
// such a config at startup anyway.
function placeSide(name, directions) {
  const n = norm(name);
  if (!n || !directions) return null;
  const hits = slotsOf(directions).filter(d => {
    const list = directions[d] && directions[d].placesBeyond;
    return Array.isArray(list) && list.some(p => matchesPlace(n, p));
  });
  return hits.length === 1 ? hits[0] : null;
}

// Step 2: destination first, then origin. Returns a slot name or null.
function directionFromPlaces(directions, origin, dest) {
  const d = placeSide(dest, directions);
  if (d) return d;
  const o = placeSide(origin, directions);
  if (o) return oppositeOf(directions, o);
  return null;
}

// Refuse a config that could not resolve consistently. Returns a list of problems (empty = ok).
function validateDirections(directions) {
  const problems = [];
  if (!directions) return problems;     // absent: places step simply never answers
  const slots = slotsOf(directions);
  for (const d of slots) {
    const list = directions[d] && directions[d].placesBeyond;
    if (list !== undefined && !Array.isArray(list)) problems.push(`directions.${d}.placesBeyond must be a list`);
  }
  if (slots.length !== 2) return problems;       // crossing-definitions.js reports the count
  const [x, y] = slots;
  const a = (directions[x] && directions[x].placesBeyond) || [];
  const b = (directions[y] && directions[y].placesBeyond) || [];
  for (const p of a) for (const q of b) {
    if (matchesPlace(p, q) || matchesPlace(q, p)) problems.push(`"${p}" (${x}) and "${q}" (${y}) overlap — a place would match both`);
  }
  return problems;
}

// The full resolver for one crossing. `timetableDirection` is ({uid, headcode, at}) =>
// a slot name or null, or absent. Returns { direction, source, boardTime } with source one of
// 'timetable' | 'places' | 'unknown', and boardTime that slot's `directions.<dir>.boardTime`
// (which board time is nearest the crossing: 'arrival' | 'departure'), absent when unknown.
function makeDirectionResolver(directions, timetableDirection) {
  const found = (direction, source) =>
    ({ direction, source, boardTime: directions[direction] && directions[direction].boardTime });
  return q => {
    const tt = timetableDirection ? timetableDirection(q) : null;
    if (slotsOf(directions).includes(tt)) return found(tt, 'timetable');
    const pl = directionFromPlaces(directions, q.origin, q.dest);
    if (pl) return found(pl, 'places');
    return { direction: 'unknown', source: 'unknown' };
  };
}

module.exports = { slotsOf, oppositeOf, matchesPlace, placeSide, directionFromPlaces, validateDirections, makeDirectionResolver };
