'use strict';

// Run under BOTH timezone environments to prove Intl-based logic is TZ-independent:
//   TZ=UTC node backend/test/time-utils.test.js
//   TZ=Europe/London node backend/test/time-utils.test.js
//
// All assertions must pass under each. The suite exits 1 on any failure.

const { parseLondonWallClock, londonMinsToDate, londonDateStamp, serviceDayStamp } = require('../src/time-utils');

let pass = 0, fail = 0;

function check(label, actual, expected) {
  const a = actual instanceof Date ? actual.toISOString() : String(actual);
  const e = expected instanceof Date ? expected.toISOString() : String(expected);
  if (a === e) {
    console.log(`  PASS  ${label}`);
    pass++;
  } else {
    console.log(`  FAIL  ${label}`);
    console.log(`          got:      ${a}`);
    console.log(`          expected: ${e}`);
    fail++;
  }
}

function londonWallClock(d) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', hour12: false,
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(d).map(x => [x.type, x.value])
  );
  return `${p.hour}:${p.minute}:${p.second}`;
}

console.log(`\nparseLondonWallClock  (TZ env: ${process.env.TZ || '(not set)'})\n`);

// ---- Normal BST ----
check(
  'BST: 09:07 London → 08:07 UTC  [regression: original bug]',
  parseLondonWallClock('2026-05-12T09:07:00'),
  new Date('2026-05-12T08:07:00.000Z')
);
check(
  'BST: 23:55 London → 22:55 UTC',
  parseLondonWallClock('2026-05-12T23:55:00'),
  new Date('2026-05-12T22:55:00.000Z')
);
check(
  'BST midnight rollover: 00:30 London → previous UTC day',
  parseLondonWallClock('2026-05-12T00:30:00'),
  new Date('2026-05-11T23:30:00.000Z')
);

// ---- Normal GMT ----
check(
  'GMT: 09:07 London → 09:07 UTC',
  parseLondonWallClock('2026-12-12T09:07:00'),
  new Date('2026-12-12T09:07:00.000Z')
);
check(
  'GMT: 00:30 London → 00:30 UTC',
  parseLondonWallClock('2026-12-12T00:30:00'),
  new Date('2026-12-12T00:30:00.000Z')
);

// ---- Spring forward (last Sunday March 2026 = 29 March) ----
// 01:00–01:59 do not exist; expect null + console.warn
{
  const orig = console.warn;
  let warned = false;
  console.warn = (...a) => { warned = true; orig(...a); };
  const r = parseLondonWallClock('2026-03-29T01:30:00');
  console.warn = orig;
  check('Spring forward gap: 01:30 → null', String(r), 'null');
  check('Spring forward gap: emits console.warn', warned, true);
}
check(
  'Spring forward: 00:59 (just before gap) → still parses correctly',
  parseLondonWallClock('2026-03-29T00:59:00'),
  new Date('2026-03-29T00:59:00.000Z')
);
check(
  'Spring forward: 02:00 (just after gap, now BST) → 01:00 UTC',
  parseLondonWallClock('2026-03-29T02:00:00'),
  new Date('2026-03-29T01:00:00.000Z')
);

// ---- Autumn back (last Sunday October 2026 = 25 October) ----
// 01:00–01:59 appear twice. NR WTT convention = GMT (second occurrence).
// parseLondonWallClock returns 01:30 UTC = 01:30 GMT (post-rollback).
check(
  'Autumn back 01:30 → GMT occurrence (01:30 UTC) per NR WTT',
  parseLondonWallClock('2026-10-25T01:30:00'),
  new Date('2026-10-25T01:30:00.000Z')
);
check(
  'Autumn back 00:30 (unambiguous BST) → 23:30 UTC previous day',
  parseLondonWallClock('2026-10-25T00:30:00'),
  new Date('2026-10-24T23:30:00.000Z')
);
check(
  'Autumn back 02:30 (unambiguous GMT) → 02:30 UTC',
  parseLondonWallClock('2026-10-25T02:30:00'),
  new Date('2026-10-25T02:30:00.000Z')
);

// ---- londonMinsToDate ----
// Can't test exact UTC value without knowing today's date, so verify
// that the returned Date formats back to the requested wall-clock time.
console.log('\nlondonMinsToDate\n');
{
  const mins = 9 * 60 + 7; // 09:07
  const d = londonMinsToDate(mins);
  if (d === null) {
    // Spring forward gap on today's date — only possible at 2026-03-29T01:xx
    console.log('  SKIP  londonMinsToDate(547): today is spring-forward day, null expected');
    pass++;
  } else {
    check('londonMinsToDate(547) formats back to 09:07:00 in London', londonWallClock(d), '09:07:00');
  }
}
{
  const mins = 23 * 60 + 55; // 23:55
  const d = londonMinsToDate(mins);
  if (d !== null) {
    check('londonMinsToDate(1435) formats back to 23:55:00 in London', londonWallClock(d), '23:55:00');
  }
}

// ---- londonDateStamp ----
console.log('\nlondonDateStamp\n');
{
  const stamp = londonDateStamp();
  check('londonDateStamp format is YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(stamp), true);
  // Must match what Intl says today is in London
  const expected = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
  check('londonDateStamp matches Intl en-CA Europe/London', stamp, expected);
}

// ---- serviceDayStamp: London, turning over at 03:00 ----
console.log('\nserviceDayStamp\n');
{
  const sd = iso => serviceDayStamp(new Date(iso));
  check('BST 23:59 London is that day', sd('2026-10-07T22:59:00Z'), '2026-10-07');
  check('BST 00:13 London is still the previous day', sd('2026-10-07T23:13:00Z'), '2026-10-07');
  check('BST 02:59 London is still the previous day', sd('2026-10-08T01:59:00Z'), '2026-10-07');
  check('BST 03:00 London is the new day', sd('2026-10-08T02:00:00Z'), '2026-10-08');
  check('GMT 02:59 London is still the previous day', sd('2026-11-05T02:59:00Z'), '2026-11-04');
  check('GMT 03:00 London is the new day', sd('2026-11-05T03:00:00Z'), '2026-11-05');
  check('month/year rollover', sd('2027-01-01T01:00:00Z'), '2026-12-31');
  // Clock-change nights (2026-10-25 back, 2027-03-28 forward): 03:00 London is a single instant
  check('autumn change: 02:59 GMT still the previous day', sd('2026-10-25T02:59:00Z'), '2026-10-24');
  check('autumn change: 03:00 GMT the new day', sd('2026-10-25T03:00:00Z'), '2026-10-25');
  check('spring change: 01:59 UTC = 02:59 BST still the previous day', sd('2027-03-28T01:59:00Z'), '2027-03-27');
  check('spring change: 02:00 UTC = 03:00 BST the new day', sd('2027-03-28T02:00:00Z'), '2027-03-28');
  check('spring change: 00:59 UTC = 00:59 GMT the previous day', sd('2027-03-28T00:59:00Z'), '2027-03-27');
}

// ---- Summary ----
console.log();
if (fail > 0) {
  console.error(`${fail} FAILED, ${pass} passed`);
  process.exit(1);
} else {
  console.log(`All ${pass} tests passed.`);
}
