'use strict';

// Departure-board direction (src/direction.js + CrossingState.timetableDirection).
//
// Order: the crossing's own timetable entry, then its place lists (destination first), then
// 'unknown' — never a default. The cases are the real ones from the 2026-11-06 measurement
// over 179 days of Portslade logs, where the old place-name guess was wrong.

const CrossingState = require('../src/crossing-state');
require('../src/logger').logHeld = function () {};
const { parseRdmJson } = require('../src/ldb-poller');
const { matchesPlace, directionFromPlaces, validateDirections, makeDirectionResolver } = require('../src/direction');
const cfg = require('../config/crossings.json').portslade;
const DIRS = cfg.directions;

let pass = 0, fail = 0;
function check(label, actual, expected) {
  if (actual === expected) { console.log(`  PASS  ${label}`); pass++; }
  else {
    console.log(`  FAIL  ${label}`);
    console.log(`          got:      ${actual}`);
    console.log(`          expected: ${expected}`);
    fail++;
  }
}

console.log('\nDeparture-board direction\n');

// ---- place matching ------------------------------------------------------------------------
console.log('  -- place matching --');
check("'london' matches London Victoria", matchesPlace('London Victoria', 'london'), true);
check("'ford' matches Ford", matchesPlace('Ford', 'ford'), true);
check("'ford' does NOT match Watford Junction", matchesPlace('Watford Junction', 'ford'), false);
check("'worthing' does NOT match West Worthing (listed separately)", matchesPlace('West Worthing', 'worthing'), false);
check('Portslade config is consistent', validateDirections(DIRS).length, 0);
check('an overlapping config is reported',
  validateDirections({ east: { placesBeyond: ['Brighton'] }, west: { placesBeyond: ['brighton'] } }).length, 1);

// ---- places: destination first, then origin -----------------------------------------------
console.log('  -- place lists --');
check('Southampton Central -> Brighton is east', directionFromPlaces(DIRS, 'Southampton Central', 'Brighton'), 'east');
check('London Victoria -> Littlehampton is west', directionFromPlaces(DIRS, 'London Victoria', 'Littlehampton'), 'west');
// The three the old guess got wrong because the ORIGIN was not on its list (it defaulted east):
check('Clapham Junction -> Littlehampton is west (old guess: east)', directionFromPlaces(DIRS, 'Clapham Junction', 'Littlehampton'), 'west');
check('Battersea Park -> Angmering is west (old guess: east)', directionFromPlaces(DIRS, 'Battersea Park', 'Angmering'), 'west');
check('Redhill -> Portsmouth Harbour is west (old guess: east)', directionFromPlaces(DIRS, 'Redhill', 'Portsmouth Harbour'), 'west');
check('destination unknown: origin decides (Brighton -> Somewhere is west)', directionFromPlaces(DIRS, 'Brighton', 'Somewhere'), 'west');
check('neither known: null, not a guess', directionFromPlaces(DIRS, 'Horsham', 'Watford Junction'), null);

// ---- the full resolver, with a timetable ------------------------------------------------------
console.log('  -- timetable first --');
const st = new CrossingState('portslade', cfg);
// estimatedCrossingMins is London minutes after midnight; crossing-state turns it into a Date.
const at = mins => st._scheduleTimeToDate(mins);
st.scheduleTrains = [
  // 1J00 on 2026-10-11: London Victoria -> Brighton, diverted via Littlehampton, so it passed
  // Portslade EASTBOUND. The old guess said west ("London" on its list).
  { uid: 'X70339', headcode: '1J00', direction: 'east', estimatedCrossingMins: 570 },
  // An out-and-back working: one UID, two traversals in opposite directions.
  { uid: 'Y00001', headcode: '3S97', direction: 'east', estimatedCrossingMins: 1046 },
  { uid: 'Y00001', headcode: '3S97', direction: 'west', estimatedCrossingMins: 1051 },
  // Headcode-only matching, reused an hour later in the other direction.
  { uid: null, headcode: '2N10', direction: 'west', estimatedCrossingMins: 600 },
  { uid: null, headcode: '2N10', direction: 'east', estimatedCrossingMins: 660 }
];
const resolve = makeDirectionResolver(DIRS, q => st.timetableDirection(q));
let r = resolve({ uid: 'X70339', headcode: '1J00', at: at(569), origin: 'London Victoria', dest: 'Brighton' });
check('diverted Victoria -> Brighton: timetable says east', r.direction, 'east');
check('  ...and records the timetable as the source', r.source, 'timetable');
// The diversion the place lists alone would get wrong: Brighton -> London Victoria the long way.
st.scheduleTrains.push({ uid: 'X11111', headcode: '1J03', direction: 'west', estimatedCrossingMins: 700 });
r = resolve({ uid: 'X11111', headcode: '1J03', at: at(700), origin: 'Brighton', dest: 'London Victoria' });
check('diverted Brighton -> London Victoria: timetable (west) beats the lists (east)', r.direction, 'west');
check('out-and-back, outward leg time: east', resolve({ uid: 'Y00001', at: at(1045) }).direction, 'east');
check('out-and-back, return leg time: west', resolve({ uid: 'Y00001', at: at(1052) }).direction, 'west');
check('headcode only, 10:00 -> the 10:00 entry (west)', resolve({ headcode: '2N10', at: at(601) }).direction, 'west');
check('headcode only, 11:00 -> the 11:00 entry (east)', resolve({ headcode: '2N10', at: at(659) }).direction, 'east');
r = resolve({ headcode: '2N10', at: at(630), origin: 'Brighton', dest: 'Littlehampton' });
check('headcode 30 min from any entry: not matched, lists answer instead', `${r.direction}/${r.source}`, 'west/places');
r = resolve({ uid: 'ZZZ', headcode: '9X99', at: at(700), origin: 'Horsham', dest: 'Watford Junction' });
check('no timetable, no list: unknown', `${r.direction}/${r.source}`, 'unknown/unknown');

// ---- through the real board parser ---------------------------------------------------------
console.log('  -- board parser --');
const svc = o => Object.assign({
  trainid: '1H34', uid: 'G26423',
  sta: '2026-07-31T15:26:00', std: '2026-07-31T15:27:00',
  origin: [{ locationName: 'Clapham Junction' }], destination: [{ locationName: 'Littlehampton' }],
  operator: 'SN', isCancelled: false
}, o);
let [t] = parseRdmJson({ trainServices: [svc()] }, makeDirectionResolver(DIRS));
check('1H34 Clapham Junction -> Littlehampton parses westbound', t.direction, 'west');
check('  ...reads the departure, as westbound always has', t.scheduledTime, new Date('2026-07-31T14:27:00Z').toISOString());
check('  ...source recorded for the log', t.directionSource, 'places');
check('  ...but never serialised', JSON.stringify(t).includes('directionSource'), false);
check('  ...nor carried by a copy', 'directionSource' in { ...t }, false);
[t] = parseRdmJson({ trainServices: [svc()] });
check('no resolver at all: unknown, not a default', t.direction, 'unknown');

// ---- unknown trains in the merge ---------------------------------------------------------
console.log('  -- unknown in the merge --');
{
  const s = new CrossingState('portslade', cfg);
  const now = new Date();
  const base = { headcode: '1Q01', origin: 'Horsham', destination: 'Watford Junction', bestTime: new Date(now.getTime() + 600000).toISOString(), direction: 'unknown' };
  s.ldbTrains = [base];
  const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
  check('unknown and not on our berths: left out', s._mergeTrains(now).filter(x => x.headcode === '1Q01').length, 0);
  s._mergeTrains(now);
  console.warn = warn;
  check('  ...and reported once, not every poll', warned, 1);
  s.recordTdBerth({ headcode: '1Q01', ts: now.toISOString(), event: 'CA', from: '0010', to: '0008' });
  const m = s._mergeTrains(now).filter(x => x.headcode === '1Q01');
  check('once in an eastbound approach berth: included as east', m.length === 1 && m[0].direction, 'east');
  s.recordTdBerth({ headcode: '1Q01', ts: now.toISOString(), event: 'CA', from: '0003', to: '0005' });
  check('in a westbound berth: west', s._mergeTrains(now).find(x => x.headcode === '1Q01').direction, 'west');
  check('a berth on neither chain places nothing', s._directionFromBerth('A035'), null);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
setImmediate(() => process.exit(fail ? 1 : 0));
