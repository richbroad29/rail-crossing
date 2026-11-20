'use strict';

// Out-and-back workings — a schedule that crosses the road TWICE.
//
// Until 2026-10-25 any schedule whose west/east timing points interleaved was dropped
// whole, with the note "revisit only if TD sights one of these headcodes". TD had: the
// railhead-treatment workings 3S93 and 3S97 were dropped every morning and crossed
// Boundary Road 26 times over 2026-10-18..24, with the app reading OPEN or CLOSING_SOON —
// never CLOSED — across every one of 24 Oct's four crossings.
//
// These assert the two halves of the fix:
//   PARSER        one entry per traversal, but ONLY when every side-change is the
//                 configured interpolation pair (so 1Q76, which interleaves via the Arun
//                 valley and never comes near Portslade, is still dropped).
//   CROSSING-STATE a later leg must not be handed the day's FIRST TD sighting — that
//                 sighting belongs to the outward run, and the "clearly gone" test would
//                 otherwise drop the return leg within minutes of the train appearing.

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseScheduleFile, applyUpdateExtract, getLastParseStats, analyseRoute, minsToTimeStr
} = require('../src/schedule-parser');
const CrossingState = require('../src/crossing-state');

const crossingsConfig = require('../src/crossing-definitions').loadCrossings();

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
function checkTruthy(label, actual) {
  if (actual) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label} (got: ${actual})`); fail++; }
}

const ALWAYS = {
  schedule_start_date: '2020-01-01', schedule_end_date: '2035-12-31',
  schedule_days_runs: '1111111'
};

function sched(uid, headcode, locations, stp) {
  return {
    JsonScheduleV1: {
      transaction_type: 'Create',
      CIF_train_uid: uid,
      CIF_stp_indicator: stp || 'P',
      ...ALWAYS,
      atoc_code: 'ZZ',
      schedule_segment: {
        signalling_id: headcode,
        CIF_train_category: '',
        CIF_power_type: 'D',
        CIF_operating_characteristics: '',
        schedule_location: locations
      }
    }
  };
}

// 3S93-shaped: starts west of the crossing, runs east to Brighton, returns west.
// SHRHMBS 07:00 -> HOVE 07:10 gives an east crossing at 07:00 + 0.7*10 = 07:07;
// HOVE 10:40 -> SHRHMBS 10:50 gives a west crossing at 10:40 + 0.3*10 = 10:43.
const OUT_AND_BACK = [
  { tiploc_code: 'LTLHMPT', departure: '0600', location_type: 'LO' },
  { tiploc_code: 'SHRHMBS', pass: '0700' },
  { tiploc_code: 'HOVE', pass: '0710' },
  { tiploc_code: 'BRGHTN', arrival: '0720', departure: '1030' },
  { tiploc_code: 'HOVE', pass: '1040' },
  { tiploc_code: 'SHRHMBS', pass: '1050' },
  { tiploc_code: 'LTLHMPT', arrival: '1130', location_type: 'LT' }
];

// 1Q76-shaped: interleaves west/east, but via the Arun valley — neither side-change is
// the SHRHMBS<->HOVE bracket pair, and the gaps are hours, not minutes.
const ARUN_VALLEY = [
  { tiploc_code: 'ARUNDLJ', pass: '0800', location_type: 'LO' },
  { tiploc_code: 'PRSP', pass: '0921' },
  { tiploc_code: 'ARUNDLJ', pass: '1300', location_type: 'LT' }
];

// An ordinary single traversal (regression guard).
const SINGLE = [
  { tiploc_code: 'SOTON', departure: '1000', location_type: 'LO' },
  { tiploc_code: 'SHRHMBS', pass: '1030' },
  { tiploc_code: 'HOVE', arrival: '1040', location_type: 'LT' }
];

function writeJsonl(name, records) {
  const p = path.join(os.tmpdir(), `rcx-${name}-${process.pid}.jsonl`);
  fs.writeFileSync(p, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

const portsladeCfg = crossingsConfig.portslade.schedule;

(async () => {
  console.log('\nOut-and-back workings — parser\n');

  // --- analyseRoute, directly ------------------------------------------------------
  {
    const route = analyseRoute(OUT_AND_BACK, portsladeCfg);
    check('out-and-back now traverses', route.traverses, true);
    check('  ...flagged multi', route.multi, true);
    check('  ...two legs', route.legs.length, 2);
    check('  ...first leg east', route.legs[0].direction, 'east');
    check('  ...second leg west', route.legs[1].direction, 'west');
    check('  ...east leg brackets SHRHMBS->HOVE',
      `${route.legs[0].from.tiploc}>${route.legs[0].to.tiploc}`, 'SHRHMBS>HOVE');
    check('  ...west leg brackets HOVE->SHRHMBS (from is the HOVE it left)',
      `${route.legs[1].from.tiploc}>${route.legs[1].to.tiploc}`, 'HOVE>SHRHMBS');
  }

  {
    const route = analyseRoute(ARUN_VALLEY, portsladeCfg);
    check('Arun-valley interleave is STILL dropped', route.traverses, false);
    check('  ...and still reported as ambiguous', route.ambiguous, true);
    check('  ...with no bracket-pair transition',
      route.transitions.filter(t => t.bracketPair).length, 0);
  }

  {
    const route = analyseRoute(SINGLE, portsladeCfg);
    check('ordinary single traversal unchanged: traverses', route.traverses, true);
    check('  ...direction still at the top level', route.direction, 'east');
    check('  ...exactly one leg', route.legs.length, 1);
    check('  ...not flagged multi', !route.multi, true);
  }

  // --- display rounding ------------------------------------------------------------
  // Surfaced by this change: the first real out-and-back leg interpolated to 07:59.7 and
  // printed as "07:60", because the minutes field was rounded without carrying.
  check('minsToTimeStr carries a rounded-up minute into the hour', minsToTimeStr(479.7), '08:00');
  check('  ...and still rounds down below the half', minsToTimeStr(479.4), '07:59');
  check('  ...and wraps the day at 1440', minsToTimeStr(1440), '00:00');
  check('  ...and 23:59.8 rounds to midnight, not 23:60', minsToTimeStr(1439.8), '00:00');

  // --- full parse ------------------------------------------------------------------
  const fullFile = writeJsonl('mt-full', [
    sched('Q11111', '3S93', OUT_AND_BACK),
    sched('Q22222', '1Q76', ARUN_VALLEY),
    sched('X33333', '1S63', SINGLE)
  ]);
  const base = await parseScheduleFile(fullFile, crossingsConfig);
  const trains = base.portslade;
  const legs = trains.filter(t => t.uid === 'Q11111');

  check('out-and-back yields two predictions', legs.length, 2);
  check('  ...east first', legs[0].direction, 'east');
  check('  ...east crossing interpolated to 07:07', legs[0].estimatedCrossingTime, '07:07');
  check('  ...west second', legs[1].direction, 'west');
  check('  ...west crossing interpolated to 10:43', legs[1].estimatedCrossingTime, '10:43');
  check('  ...legIndex counts the traversals', legs.map(l => l.legIndex).join(','), '0,1');
  check('  ...legCount on both', legs.map(l => l.legCount).join(','), '2,2');
  check('  ...both carry the same headcode', legs.every(l => l.headcode === '3S93'), true);
  check('  ...both carry the same uid', legs.every(l => l.uid === 'Q11111'), true);

  check('Arun-valley schedule predicts nothing', trains.some(t => t.uid === 'Q22222'), false);
  check('single traversal still predicts once',
    trains.filter(t => t.uid === 'X33333').length, 1);
  check('  ...and reports legIndex 0 of 1',
    trains.find(t => t.uid === 'X33333').legIndex + '/' +
    trains.find(t => t.uid === 'X33333').legCount, '0/1');

  const stats = getLastParseStats();
  check('parse stats count the expansion', stats.multiLegKept, 1);
  check('parse stats still count the drop', stats.ambiguousDropped, 1);
  check('results stay sorted by crossing time',
    trains.every((t, i) => i === 0 || trains[i - 1].estimatedCrossingMins <= t.estimatedCrossingMins),
    true);

  // --- update extract: a group is replaced WHOLESALE, never leg by leg --------------
  console.log('\nOut-and-back workings — STP overlay and cancellation\n');
  {
    // An O overlay for the same uid that now crosses only ONCE must leave no orphan leg.
    const updFile = writeJsonl('mt-overlay', [sched('Q11111', '3S93', SINGLE, 'O')]);
    const { trains: after } = await applyUpdateExtract(updFile, crossingsConfig, base);
    const q = after.portslade.filter(t => t.uid === 'Q11111');
    check('overlay replaces the whole group', q.length, 1);
    check('  ...leaving the overlay\'s own single traversal', q[0].direction, 'east');
    check('  ...with no stale west leg', q.some(t => t.direction === 'west'), false);
  }

  {
    const cancel = {
      JsonScheduleV1: {
        transaction_type: 'Create', CIF_train_uid: 'Q11111',
        CIF_stp_indicator: 'C', ...ALWAYS
      }
    };
    const updFile = writeJsonl('mt-cancel', [cancel]);
    const { trains: after, stats: ustats } = await applyUpdateExtract(updFile, crossingsConfig, base);
    check('cancelling the uid removes BOTH legs',
      after.portslade.filter(t => t.uid === 'Q11111').length, 0);
    check('  ...and names both in the cancellation log',
      ustats.cancelledIds.filter(c => c.uid === 'Q11111').length, 2);
    check('base is untouched by the apply',
      base.portslade.filter(t => t.uid === 'Q11111').length, 2);
  }

  // --- crossing-state: a later leg must not inherit the first sighting -------------
  console.log('\nOut-and-back workings — the later leg keeps its own clock\n');

  // Relative to the real clock: _mergeTrains reads `new Date()` for `now`.
  const BASE_MS = Date.now();
  const stateCfg = {
    name: 'T', road: 'R',
    directions: { east: {}, west: {} },
    td: { east: { classRule: 'approachStop' } },
    live: { ttlSecs: 240 },
    transits: { west: { freight: { '0003>XING': { secs: 60, sdSecs: 10 } } } },
    timing: {
      closeBefore: { east: 1.5, west: 2.5 },
      openAfter: { east: 0.5, west: 0.5 },
      consecutiveWindow: 1.5,
      areaEntryLeadSecs: { east: 150, west: 112 }
    }
  };

  // Minutes-since-midnight are used only as a key here; the stub maps them to instants.
  function legPair() {
    const common = {
      uid: 'Q11111', headcode: '3S93', trainType: 'test',
      origin: 'LITTLEHAMPTON', destination: 'LITTLEHAMPTON', operator: 'ZZ',
      callsAtStation: false, legCount: 2
    };
    return [
      { ...common, direction: 'east', estimatedCrossingMins: 427, legIndex: 0 },
      { ...common, direction: 'west', estimatedCrossingMins: 643, legIndex: 1 }
    ];
  }
  // east leg 30 min ago, west leg 3 h ahead.
  const mapTime = (mins) => new Date(BASE_MS + (mins === 427 ? -30 * 60000 : 3 * 3600000));

  {
    const s = new CrossingState('t', stateCfg);
    s._scheduleTimeToDate = mapTime;
    s.scheduleTrains = legPair();
    // Sighted once, on the outward run, 3.5 h before the return leg is due.
    s.recordTdSighting('3S93', new Date(BASE_MS - 30 * 60000));
    s.tdSeenToday.set('3S93', new Date(BASE_MS - 30 * 60000));

    const merged = s._mergeTrains();
    const west = merged.find(m => m.direction === 'west');
    checkTruthy('the return leg survives the outward leg\'s sighting', west);
    check('  ...and is not dated from it (bestTime is its own booked time)',
      west ? west.bestTime.getTime() - BASE_MS : null, 3 * 3600000);
    // tdSeen is an EXISTENCE flag, and the train has indeed been seen today — what the
    // return leg must not inherit is the outward run's TIMESTAMP, asserted above.
    check('  ...but still counts as seen today', west ? west.tdSeen : null, true);
  }

  {
    // A Q-pathed working that TD has sighted must keep BOTH legs. The run-rate drop is an
    // existence test, so reading the leg-scoped sighting there would have silently binned
    // every return leg of every Q path — which is all of them at Portslade.
    const s = new CrossingState('t', stateCfg);
    s._scheduleTimeToDate = mapTime;
    s.scheduleTrains = legPair().map(t => ({ ...t, runsAsRequired: true, recentRunRate: 0 }));
    s.recordTdSighting('3S93', new Date(BASE_MS - 30 * 60000));
    const merged = s._mergeTrains();
    checkTruthy('a sighted Q path keeps its return leg', merged.some(m => m.direction === 'west'));

    // ...and an unsighted one still predicts nothing, which is what keeps 8Y91 (0% run
    // rate over 14 days, never sighted) from inventing two closures a day.
    const s2 = new CrossingState('t', stateCfg);
    s2._scheduleTimeToDate = mapTime;
    s2.scheduleTrains = legPair().map(t => ({ ...t, runsAsRequired: true, recentRunRate: 0 }));
    check('an unsighted 0%-run-rate Q path still predicts nothing', s2._mergeTrains().length, 0);
  }

  {
    // Regression: leg 0 still uses the sighting, so the late-running re-attachment that
    // the sighting exists for is untouched.
    const s = new CrossingState('t', stateCfg);
    s._scheduleTimeToDate = () => new Date(Date.now() - 15 * 60000);
    s.scheduleTrains = [{
      uid: 'T00001', headcode: '6O99', direction: 'west', trainType: 'freight',
      estimatedCrossingMins: 0, origin: 'EASTLEIGH', destination: 'VICTORIA', operator: 'ZZ'
    }];
    s.recordTdSighting('6O99', new Date());
    const t = s._mergeTrains().find(m => m.headcode === '6O99');
    checkTruthy('a first leg still re-attaches off its sighting', t);
    check('  ...and is still flagged as seen', t ? t.tdSeen : null, true);
  }

  {
    // The T-60s no-show lock must not fire on a train TD can currently place on our own
    // approach chain — which is the only thing holding a later leg in the list at the end.
    const s = new CrossingState('t', stateCfg);
    const now = Date.now();
    s._scheduleTimeToDate = () => new Date(now + 30000);   // inside the 60s lock window
    s.scheduleTrains = [{
      uid: 'Q11111', headcode: '3S93', direction: 'west', trainType: 'freight',
      estimatedCrossingMins: 643, legIndex: 1, legCount: 2,
      origin: 'LITTLEHAMPTON', destination: 'LITTLEHAMPTON', operator: 'ZZ'
    }];
    // A berth step writes the live position but NOT the first-sighting map.
    s.recordTdBerth({ headcode: '3S93', ts: now, event: 'CA', from: '0001', to: '0003' });
    check('no sighting recorded by a bare berth step', s.tdSeenToday.has('3S93'), false);

    const t = s._mergeTrains().find(m => m.headcode === '3S93');
    checkTruthy('a train we can SEE in a berth is not dropped as a no-show', t);
    check('  ...and is timed off the berth projection, not the timetable',
      t ? t.etaText : null, 'Live (berth)');
  }

  // --- two legs close together must not read each other's clear step ---------------
  console.log('\nOut-and-back workings — closely-spaced legs\n');
  {
    // Today's real extract has 3S97 crossing east ~17:26 and west ~17:31 — five minutes
    // apart, well inside the 20-minute clear-step TTL. With one clear-step slot per
    // headcode the west leg read the east leg's, putting its barrier-up before its own
    // close (register #12's open-before-close).
    const clearCfg = {
      ...stateCfg,
      td: {
        east: { clear: { from: '0004', to: '0002' } },
        west: { clear: { from: '0005', to: '0007' } }
      },
      timing: {
        ...stateCfg.timing,
        openLagSecs: { east: { passenger: 40, freight: 70 }, west: { passenger: 18, freight: 30 } }
      }
    };
    const s = new CrossingState('t', clearCfg);
    const east = { direction: 'east', trainType: 'passenger', headcode: '3S97', legIndex: 0, legCount: 2 };
    const west = { direction: 'west', trainType: 'passenger', headcode: '3S97', legIndex: 1, legCount: 2 };
    const tEast = BASE_MS;
    s.recordTdClearStep({ headcode: '3S97', ts: new Date(tEast), from: '0004', to: '0002' });
    const at = new Date(tEast + 60000);  // one minute later, west leg still approaching

    checkTruthy('the east leg sees its own clear step', s._freshClearStep(east, at));
    check('  ...and the west leg does NOT borrow it', s._freshClearStep(west, at), null);

    // Once the west leg clears too, each reads its own.
    s.recordTdClearStep({ headcode: '3S97', ts: new Date(tEast + 300000), from: '0005', to: '0007' });
    const after = new Date(tEast + 310000);
    check('east still reads the east clear step',
      s._freshClearStep(east, after).ts - tEast, 0);
    check('west now reads the west one', s._freshClearStep(west, after).ts - tEast, 300000);

    // Regression: a single-traversal train with ONE reading uses it whichever way it
    // points — the "a missed direction join must not sideline the anchor" property.
    const s2 = new CrossingState('t', clearCfg);
    s2.recordTdClearStep({ headcode: '1A01', ts: new Date(tEast), from: '0004', to: '0002' });
    checkTruthy('a lone clear step is used even by a train claiming the other direction',
      s2._freshClearStep({ direction: 'west', trainType: 'passenger', headcode: '1A01' }, at));
  }

  // --- a crossing ends its own timetable entry, however early the train ran ----------
  console.log('\nOut-and-back workings — a leg that ran hours early\n');
  {
    // 2026-11-05: 3S93 booked west at 12:40, crossed west at 08:39:44. The entry kept its
    // real approach strike for 20 minutes while its time fell back to 12:40, so one "train"
    // closed at 08:37 and opened ~12:36 and the app read CLOSED 08:34–08:58; then the entry
    // came back at 12:40 as a train about to cross.
    const clearCfg = {
      ...stateCfg,
      td: {
        east: { clear: { from: '0004', to: '0002' } },
        west: { clear: { from: '0005', to: '0007' } }
      },
      timing: {
        ...stateCfg.timing,
        openLagSecs: { east: { passenger: 40, freight: 70 }, west: { passenger: 18, freight: 30 } }
      }
    };
    const common = {
      uid: 'Q11111', headcode: '3S93', trainType: 'test',
      origin: 'LITTLEHAMPTON', destination: 'LITTLEHAMPTON', operator: 'ZZ',
      callsAtStation: false, legCount: 2
    };
    // mins is only a key: 427 = east leg (2 h ago), 760 = west leg (4 h ahead),
    // 1300 = a different west run of the same headcode, 7 h ahead.
    const at = { 427: -2 * 3600000, 760: 4 * 3600000, 1300: 7 * 3600000 };
    const mk = () => {
      const s = new CrossingState('t', clearCfg);
      s._scheduleTimeToDate = (mins) => new Date(BASE_MS + at[mins]);
      s.scheduleTrains = [
        { ...common, direction: 'east', estimatedCrossingMins: 427, legIndex: 0 },
        { ...common, direction: 'west', estimatedCrossingMins: 760, legIndex: 1 },
        // legIndex 1 so the day's first sighting (bug (a), headcode-wide) does not drop it.
        { ...common, uid: 'Q22222', direction: 'west', estimatedCrossingMins: 1300, legIndex: 1 }
      ];
      s.recordTdSighting('3S93', new Date(BASE_MS - 2 * 3600000));
      return s;
    };
    const westAt = (s, ms) => s._mergeTrains(new Date(ms))
      .filter(m => m.direction === 'west').map(m => m.scheduledTime.getTime() - BASE_MS);

    const control = mk();
    check('control: before it crosses, both west entries are listed',
      westAt(control, BASE_MS).join(','), [4 * 3600000, 7 * 3600000].join(','));

    const s = mk();
    s.recordTdClearStep({ headcode: '3S93', ts: new Date(BASE_MS), from: '0005', to: '0007' });
    check('barrier still down (10s after the clear step): the leg is kept',
      westAt(s, BASE_MS + 10000).includes(4 * 3600000), true);
    check('barrier up (60s after): the crossed leg is gone',
      westAt(s, BASE_MS + 60000).includes(4 * 3600000), false);
    check('  ...and stays gone once the 20-min clear-step memory has expired',
      westAt(s, BASE_MS + 30 * 60000).includes(4 * 3600000), false);
    check('  ...including at its booked time',
      westAt(s, BASE_MS + 4 * 3600000 - 60000).includes(4 * 3600000), false);
    check('the same headcode\'s run 7 h later is NOT taken by that crossing',
      westAt(s, BASE_MS + 60000).includes(7 * 3600000), true);
    check('the east leg is not retired by a west crossing',
      s._crossedAtByEntry(new Date(BASE_MS + 60000)).size, 1);

    // A restart: the day's crossings are rebuilt from the TD log with the sightings.
    const r = mk();
    r.seedSightings([{ headcode: '3S93', ts: new Date(BASE_MS).toISOString(), from: '0005', to: '0007' }]);
    check('after a restart the crossed leg is still gone',
      westAt(r, BASE_MS + 30 * 60000).includes(4 * 3600000), false);
  }

  // --- a crossing ends a BOARD train too, however long the board goes on listing it ------
  console.log('\nBoard trains the board goes on listing after they have crossed\n');
  {
    // 2026-09-17: 1H96 booked west 00:32, crossed 00:43:52, still on the board "on time" at
    // 00:32 until 02:05. Once its clear step was 20 min old, the sighted, "uncleared" board
    // train held its period open, and the page read BARRIERS DOWN until the board let it go.
    // Retired at the TTL, not at barrier-up: see the comment in _mergeTrains.
    const clearCfg = {
      ...stateCfg,
      td: {
        east: { clear: { from: '0004', to: '0002' } },
        west: { clear: { from: '0005', to: '0007' } }
      },
      timing: {
        ...stateCfg.timing,
        openLagSecs: { east: { passenger: 40, freight: 70 }, west: { passenger: 18, freight: 30 } }
      }
    };
    const iso = ms => new Date(ms).toISOString();
    const cif = (uid, mins) => ({ uid, headcode: '1H96', direction: 'west', trainType: 'passenger',
      origin: 'BRIGHTON', destination: 'WEST WORTHING', operator: 'SN', callsAtStation: true,
      estimatedCrossingMins: mins, legIndex: 0 });
    const board = (uid, ms) => ({ uid, headcode: '1H96', direction: 'west', trainType: 'passenger',
      origin: 'BRIGHTON', destination: 'WEST WORTHING', operator: 'SN', source: 'ldbsv',
      scheduledTime: iso(ms), bestTime: iso(ms), timeSource: 'forecast', delayMins: 0 });
    // mins is only a key: 32 = booked now (BASE_MS), 452 = a later run of 1H96, 7 h on.
    const at = { 32: 0, 452: 7 * 3600000 };
    const CROSSED = BASE_MS + 11 * 60000 + 52000;   // crossed 11m52s late, as 1H96 did
    const mk = (boardTrains, { crossed = true } = {}) => {
      const s = new CrossingState('t', clearCfg);
      s._scheduleTimeToDate = (mins) => new Date(BASE_MS + at[mins]);
      s.scheduleTrains = [cif('W11111', 32), cif('W22222', 452)];
      s.ldbTrains = boardTrains;
      s.recordTdSighting('1H96', new Date(BASE_MS - 10 * 60000));
      if (crossed) s.recordTdClearStep({ headcode: '1H96', ts: new Date(CROSSED), from: '0005', to: '0007' });
      return s;
    };
    const listed = (s, ms) => s._mergeTrains(new Date(ms))
      .filter(m => m.headcode === '1H96').map(m => `${m.source}@${(m.scheduledTime.getTime() - BASE_MS) / 3600000}h`).join(',');
    // A period the page would read as CLOSED now: started, and held or not yet ended.
    const closedNow = (s, ms) => s._computeClosures(s._mergeTrains(new Date(ms)), new Date(ms))
      .some(p => Date.parse(p.start) <= ms && (p.holdingOpen || ms <= Date.parse(p.end)));

    const onBoard = () => [board('W11111', BASE_MS)];
    const TTL = 20 * 60000;   // CLEAR_STEP_TTL_MS
    const s = mk(onBoard());
    check('barrier still down (10 s after the clear step): the board train is kept',
      listed(s, CROSSED + 10000).split(',').includes('ldbsv@0h'), true);
    // The board's normal 1-4 min tail is left exactly as today: listed, its period ends on the
    // clear step, nothing held — and it still bridges into a following train's closure.
    check('60 s after: still listed while the board lists it (as today)', listed(s, CROSSED + 60000), 'ldbsv@0h');
    check('  ...and not CLOSED (its period ended on the clear step)', closedNow(s, CROSSED + 60000), false);
    check('19 min after (clear step still fresh): still listed, not CLOSED',
      listed(s, CROSSED + TTL - 60000) + '|' + closedNow(s, CROSSED + TTL - 60000), 'ldbsv@0h|false');
    check('20 min after (clear step expired): gone though the board still lists it',
      listed(s, CROSSED + TTL), '');
    check('  ...and its timetable entry does not come back in its place',
      s._mergeTrains(new Date(CROSSED + TTL)).some(m => m.uid === 'W11111'), false);
    check('40 min on, still on the board: the crossing is not CLOSED',
      closedNow(s, CROSSED + 40 * 60000), false);
    check('  ...nor listed', listed(s, CROSSED + 40 * 60000), '');

    const before = mk(onBoard(), { crossed: false });
    check('control: not yet crossed, the board train is listed', listed(before, BASE_MS + 5 * 60000), 'ldbsv@0h');

    const noTwin = mk([board('X99999', BASE_MS)]);
    check('a board train with no timetable entry keeps today\'s rules (listed)',
      listed(noTwin, CROSSED + TTL), 'ldbsv@0h');

    const noUid = mk([board(null, BASE_MS + 2 * 60000)]);
    check('no UID: matched by headcode within 5 min of booked, and retired',
      listed(noUid, CROSSED + TTL), '');

    const farNoUid = mk([board(null, BASE_MS + 6 * 60000)]);
    check('no UID and 6 min from any booked time: no twin, kept',
      listed(farNoUid, CROSSED + TTL).startsWith('ldbsv@0.1'), true);

    const later = mk([board('W11111', BASE_MS), board('W22222', BASE_MS + 7 * 3600000)]);
    check('the same headcode\'s run 7 h later stays on (its own entry has not crossed)',
      listed(later, CROSSED + TTL), 'ldbsv@7h');

    // Just before midnight the board lists tomorrow's first runs, while the timetable still
    // places "00:02" today — on the run that crossed ~24 h ago, within the 24 h crossing record.
    // Found in the full replay (27-30 Oct, 13 Oct): matched by UID with no time bound, tonight's
    // train was dropped as crossed and its countdown went missing until midnight.
    {
      const sm = new CrossingState('t', clearCfg);
      const YDAY = BASE_MS - 24 * 3600000 + 4 * 60000;   // yesterday's run of the same UID
      sm._scheduleTimeToDate = (mins) => new Date(mins === 2 ? YDAY : BASE_MS + at[mins]);
      sm.scheduleTrains = [{ ...cif('W33333', 2), headcode: '1H02' }];
      sm.ldbTrains = [{ ...board('W33333', BASE_MS + 4 * 60000), headcode: '1H02' }];
      sm.recordTdSighting('1H02', new Date(YDAY - 60000));
      sm.recordTdClearStep({ headcode: '1H02', ts: new Date(YDAY + 30000), from: '0005', to: '0007' });
      check('tomorrow\'s run on the board is not matched to yesterday\'s entry of the same UID (kept)',
        sm._mergeTrains(new Date(BASE_MS)).filter(m => m.headcode === '1H02').map(m => m.source).join(), 'ldbsv');
    }
  }

  console.log();
  if (fail > 0) { console.error(`${fail} FAILED, ${pass} passed`); process.exit(1); }
  console.log(`All ${pass} checks passed.`);
})();
