'use strict';

// LDB time resolution — the three ways the feed reports a location, and what we do
// when it stops reporting one.
//
// LDBSVWS gives every location a scheduled time, a forecast, and an ACTUAL, and it
// swaps the forecast for the actual the moment the train has been there
// (arrivalType/departureType flip Forecast -> Actual). We read only the first two for
// a long time, so a train's time collapsed to the timetable at the instant its real
// time became known — 1H42 on 2026-08-14 was re-labelled "17:29, On time" while it was
// physically on the crossing 9 minutes late, and ~180 services a day did the same.
//
// The second half is subtler and is what actually moved a prediction: a forecast can
// also disappear BEFORE the train has passed (1S30, 2026-08-13, eleven minutes out),
// and falling back to the timetable then puts a real train's predicted crossing in the
// past. So a live estimate, once given, is not un-given by silence.
//
// Assertions are on the OFFSET between bestTime and scheduledTime, never on an absolute
// instant, so the file is timezone-independent (RDM sends Europe/London wall-clock with
// no offset and parseTime resolves it against the London zone).

const { parseRdmJson, applyEstimateMemory, deduplicateTrains } = require('../src/ldb-poller');

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

// Offset of the resolved time from the scheduled one, in seconds. The whole point of
// this file: which of the three values did we take?
function offsetSecs(t) {
  return Math.round((new Date(t.bestTime) - new Date(t.scheduledTime)) / 1000);
}

// One westbound service at Portslade, in the exact RDM REST shape. Westbound because
// the crossing sits immediately west of the platform, so the DEPARTURE is the
// crossing-relevant time and std/etd/atd are the fields that matter.
function svc(over) {
  return Object.assign({
    trainid: '1H42',
    uid: 'W12345',
    sta: '2026-08-14T17:28:00', eta: null, ata: null,
    std: '2026-08-14T17:29:00', etd: null, atd: null,
    origin: [{ locationName: 'London Victoria' }],
    destination: [{ locationName: 'Littlehampton' }],
    operator: 'SN',
    isCancelled: false
  }, over);
}
const board = (...services) => parseRdmJson({ trainServices: services });

console.log('\nLDB time resolution — actual / forecast / timetable\n');

// ---- 1. The 1H42 case: the feed has published the real time and dropped the forecast.
{
  const [t] = board(svc({ eta: null, ata: '2026-08-14T17:37:30', etd: null, atd: '2026-08-14T17:38:07' }));
  check('actual time is used when the forecast has gone', offsetSecs(t), 547);
  check('  ...and the lateness is real, not zero', t.delayMins, 9);
  check('  ...and we record where the time came from', t.timeSource, 'actual');
  check('  ...and the picker gets the actual departure, not a blank', t.liveDep, '2026-08-14T17:38:07');
  check('  ...westbound reads the departure', t.direction, 'west');
}

// ---- 2. A live forecast, no actual yet. Unchanged behaviour — the regression guard.
{
  const [t] = board(svc({ etd: '2026-08-14T17:37:46' }));
  check('forecast is used while it is the best we have', offsetSecs(t), 526);
  check('  ...flagged as a forecast', t.timeSource, 'forecast');
  check('  ...and the picker gets the estimate', t.liveDep, '2026-08-14T17:37:46');
}

// ---- 3. Nothing but the timetable. Allowed — but it must not masquerade as live.
{
  const [t] = board(svc({}));
  check('with no forecast and no actual we fall back to the timetable', offsetSecs(t), 0);
  check('  ...and say so rather than implying a live time', t.timeSource, 'scheduled');
  check('  ...and the picker is given no live departure to report', t.liveDep, '');
}

// ---- 4. The 1S30 case: a forecast withdrawn while the train is still approaching.
{
  const mem = {};
  const [early] = applyEstimateMemory(board(svc({ etd: '2026-08-14T17:37:46' })), mem, Date.now());
  check('poll 1 takes the forecast', offsetSecs(early), 526);

  const [later] = applyEstimateMemory(board(svc({})), mem, Date.now());
  check('poll 2 keeps the estimate the feed stopped sending', offsetSecs(later), 526);
  check('  ...so it never reverts to the timetable mid-approach', later.timeSource, 'forecast');
  check('  ...flagged as held, so the log says why', later.estimateHeld, true);
  check('  ...and the lateness survives with it', later.delayMins, 9);
}

// ---- 5. An actual outranks a remembered forecast. Memory is a floor, not a ceiling.
{
  const mem = {};
  applyEstimateMemory(board(svc({ etd: '2026-08-14T17:37:46' })), mem, Date.now());
  const [t] = applyEstimateMemory(board(svc({ etd: null, atd: '2026-08-14T17:38:07' })), mem, Date.now());
  check('a published actual replaces the remembered forecast', offsetSecs(t), 547);
  check('  ...and is not marked held', t.timeSource, 'actual');
}

// ---- 6. A newer forecast replaces an older one (memory must not pin a train).
{
  const mem = {};
  applyEstimateMemory(board(svc({ etd: '2026-08-14T17:37:46' })), mem, Date.now());
  const [t] = applyEstimateMemory(board(svc({ etd: '2026-08-14T17:33:00' })), mem, Date.now());
  check('a newer forecast wins, even an earlier one', offsetSecs(t), 240);
}

// ---- 7. Dedup. Moving a late train's time FORWARD to the truth can land it within the
// 120s window of the genuinely-next service to the same destination. A different uid is
// positive proof they are two different trains, so it must not discard one.
{
  const two = deduplicateTrains(board(
    svc({ trainid: '1H42', uid: 'W11111', atd: '2026-08-14T17:38:07' }),
    svc({ trainid: '1H44', uid: 'W22222', std: '2026-08-14T17:39:00', etd: '2026-08-14T17:39:37' })
  ));
  check('two same-destination services 90s apart both survive dedup', two.length, 2);

  const noIds = deduplicateTrains([
    { uid: null, headcode: null, destination: 'Littlehampton', bestTime: '2026-08-14T17:38:07Z' },
    { uid: null, headcode: null, destination: 'Littlehampton', bestTime: '2026-08-14T17:39:37Z' }
  ]);
  check('  ...but the destination+time heuristic still fires with no identifiers', noIds.length, 1);
}

console.log();
if (fail > 0) { console.error(`${fail} FAILED, ${pass} passed`); process.exit(1); }
else { console.log(`All ${pass} tests passed.`); }
