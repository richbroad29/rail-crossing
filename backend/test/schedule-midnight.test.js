'use strict';

// Fix 2 — midnight-crossing CIF gap. Run under BOTH timezones:
//   TZ=UTC node test/schedule-midnight.test.js
//   TZ=Europe/London node test/schedule-midnight.test.js
//
// (a) a service that departs late evening and crosses just after midnight must
//     be detected (not dropped / mis-directed) and land on the NEXT day; and
// (b) londonMinsToDate must map an estimatedCrossingMins >= 1440 to the correct
//     next-day Date rather than folding it back onto today via "% 24".

const { analyseRoute, estimateCrossingTime } = require('../src/schedule-parser');
const { londonMinsToDate, londonDateStamp, shiftDateStamp } = require('../src/time-utils');

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

// London Y-M-D / HH:MM for a Date — independent of the process TZ env.
const LP = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
});
function londonParts(d) {
  const p = Object.fromEntries(LP.formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

// Minimal Portslade-shaped crossing config (real TIPLOCs both sides).
const cfg = {
  tiplocs_west: ['SHRHMBS'],
  tiplocs_east: ['HOVE'],
  interpolation: {
    eastbound: { from: 'SHRHMBS', to: 'HOVE', fraction: 0.7 },
    westbound: { from: 'HOVE', to: 'SHRHMBS', fraction: 0.3 }
  }
};

console.log(`\nFix 2 — midnight crossing  (TZ env: ${process.env.TZ || '(not set)'})\n`);

// (a) Eastbound: SHRHMBS 23:55 -> HOVE 00:10 (next day). Crossing ~00:05.
{
  const locations = [
    { tiploc_code: 'SHRHMBS', departure: '2355' },
    { tiploc_code: 'HOVE', arrival: '0010' }
  ];
  const route = analyseRoute(locations, cfg);
  check('midnight service traverses', route.traverses, true);
  check('direction is east', route.direction, 'east');

  const estMins = estimateCrossingTime(route.nearWest, route.nearEast, route.direction, cfg.interpolation);
  // SHRHMBS=1435, HOVE unwrapped=1450, est = 1435 + 0.7*15 = 1445.5 → after midnight.
  check('estimatedCrossingMins rolled past 1440', estMins > 1440, true);

  const d = londonMinsToDate(estMins);
  const p = londonParts(d);
  const tomorrow = shiftDateStamp(londonDateStamp(), 1);
  check('crossing lands on the next calendar day', p.date, tomorrow);
  check('crossing wall-clock hour is 00 (just after midnight)', p.time.slice(0, 2), '00');
}

// (b) londonMinsToDate maps >= 1440 to the next day, not back onto today.
{
  const tomorrow = shiftDateStamp(londonDateStamp(), 1);

  const d0005 = londonMinsToDate(1440 + 5); // tomorrow 00:05
  const p0005 = londonParts(d0005);
  check('londonMinsToDate(1445).date == tomorrow', p0005.date, tomorrow);
  check('londonMinsToDate(1445).time == 00:05', p0005.time, '00:05');

  const d0000 = londonMinsToDate(1440); // tomorrow 00:00
  const p0000 = londonParts(d0000);
  check('londonMinsToDate(1440).date == tomorrow', p0000.date, tomorrow);
  check('londonMinsToDate(1440).time == 00:00', p0000.time, '00:00');

  // Sanity: a same-day value still maps to today (no regression).
  const d1000 = londonMinsToDate(10 * 60); // today 10:00
  const p1000 = londonParts(d1000);
  check('londonMinsToDate(600).date == today', p1000.date, londonDateStamp());
  check('londonMinsToDate(600).time == 10:00', p1000.time, '10:00');
}

// (c) Regression: an ordinary daytime service is unaffected by the unwrap.
{
  const locations = [
    { tiploc_code: 'SHRHMBS', departure: '1000' },
    { tiploc_code: 'HOVE', arrival: '1010' }
  ];
  const route = analyseRoute(locations, cfg);
  check('daytime service traverses east', route.traverses && route.direction === 'east', true);
  const estMins = estimateCrossingTime(route.nearWest, route.nearEast, route.direction, cfg.interpolation);
  check('daytime estimate stays under 1440', estMins < 1440, true);
}

// (d) Westbound across midnight: HOVE 23:55 -> SHRHMBS 00:10 still detected.
{
  const locations = [
    { tiploc_code: 'HOVE', departure: '2355' },
    { tiploc_code: 'SHRHMBS', arrival: '0010' }
  ];
  const route = analyseRoute(locations, cfg);
  check('westbound midnight service traverses west', route.traverses && route.direction === 'west', true);
  const estMins = estimateCrossingTime(route.nearWest, route.nearEast, route.direction, cfg.interpolation);
  check('westbound estimate is monotonic (>= west timing point)', estMins >= 1435, true);
}

console.log();
if (fail > 0) { console.error(`${fail} FAILED, ${pass} passed`); process.exit(1); }
else { console.log(`All ${pass} tests passed.`); }
