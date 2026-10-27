const fs = require('fs');
const zlib = require('zlib');
const readline = require('readline');
const path = require('path');
const logger = require('./logger');
const { londonMinsToDate, londonDateStamp } = require('./time-utils');
const { resolveTiploc } = require('./corpus-fetcher');

// Parse CIF time "HHMM" or "HHMMH" (H = half-minute) into minutes since midnight
function cifTimeToMins(t) {
  if (!t) return null;
  const h = parseInt(t.slice(0, 2));
  const m = parseInt(t.slice(2, 4));
  const half = t.endsWith('H') ? 0.5 : 0;
  return h * 60 + m + half;
}

// Convert minutes since midnight to "HH:MM" string. Display-only: the "% 24"
// intentionally drops the day for a post-midnight (>= 1440) value so the label
// reads as a 24h wall clock (e.g. 00:05). The calendar day is carried by the
// Date from londonMinsToDate, never by this string.
function minsToTimeStr(mins) {
  // Round to the whole minute FIRST. CIF carries half-minutes, so an interpolated
  // estimate is routinely fractional, and rounding the minutes field on its own took
  // 479.7 to "07:60" — the carry has to reach the hour. (Seen on a real extract once
  // out-and-back legs started being interpolated at 07:59.7.)
  const total = Math.round(mins);
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Check if a schedule runs on a given day of week (0=Mon, 6=Sun)
// schedule_days_runs is "1111100" (Mon-Sun)
function runsOnDay(daysStr, dayOfWeek) {
  if (!daysStr || daysStr.length !== 7) return false;
  return daysStr[dayOfWeek] === '1';
}

// Check if today is within the schedule's date range
function isActiveToday(schedule) {
  const today = londonDateStamp();
  const start = schedule.schedule_start_date?.slice(0, 10);
  const end = schedule.schedule_end_date?.slice(0, 10);
  if (start && today < start) return false;
  if (end && today > end) return false;
  // Day of week from London's today date — avoids wrong day during BST 00:00–01:00
  const jsDay = new Date(today + 'T00:00:00Z').getUTCDay(); // 0=Sun
  const cifDay = jsDay === 0 ? 6 : jsDay - 1; // Convert to CIF Mon=0
  return runsOnDay(schedule.schedule_days_runs, cifDay);
}

// A backward jump in the wall clock larger than this (minutes) means the
// service crossed midnight, not that timing points are out of order.
const MIDNIGHT_WRAP_THRESHOLD_MINS = 720;

// Determine if a schedule traverses a crossing based on TIPLOC sets.
// Returns { traverses: true, legs: [{ direction, nearWest, nearEast }, ...] } when it does,
// otherwise { traverses: false }. `legs` has one entry per traversal and is almost always
// length 1 — an out-and-back working gives more (see the interleaved branch below). The
// single-traversal case also keeps direction/nearWest/nearEast at the top level, which is
// what callers read when they know there is only one.
function analyseRoute(locations, crossingConfig) {
  const westSet = new Set(crossingConfig.tiplocs_west);
  const eastSet = new Set(crossingConfig.tiplocs_east);

  let firstWest = null, lastWest = null;
  let firstEast = null, lastEast = null;

  // Midnight unwrap (intended behaviour): CIF times are wall-clock HHMM within
  // a single service day, so a service departing late evening and continuing
  // past 00:00 has later locations with *smaller* HHMM values. Walk the
  // locations in order and add 1440 whenever the clock jumps backwards by more
  // than MIDNIGHT_WRAP_THRESHOLD_MINS, producing a monotonic minutes scale on
  // which post-midnight times are >= 1440. estimateCrossingTime then yields an
  // estimate >= 1440 and londonMinsToDate places it on the correct next day —
  // so a ~00:05 traversal appears at 00:05 instead of being dropped or folded
  // back onto the wrong day. (This covers the service whose own day spans
  // midnight; the daily parse that captures it runs while that day is "today",
  // and the in-memory schedule persists across the crossing.)
  let prevTime = null;
  let offset = 0;
  // Every call that lands on one side or the other, in route order. Only read on the
  // ambiguous path below, to describe WHY a schedule was dropped.
  const marks = [];

  for (const loc of locations) {
    const tip = loc.tiploc_code;
    const raw = cifTimeToMins(loc.departure || loc.pass || loc.arrival);
    if (raw === null) continue;

    if (prevTime !== null && raw + offset < prevTime - MIDNIGHT_WRAP_THRESHOLD_MINS) {
      offset += 1440;
    }
    const time = raw + offset;
    prevTime = time;

    const isWest = westSet.has(tip);
    const isEast = eastSet.has(tip);
    if (isWest) {
      if (!firstWest) firstWest = { tiploc: tip, time };
      lastWest = { tiploc: tip, time };
    }
    if (isEast) {
      if (!firstEast) firstEast = { tiploc: tip, time };
      lastEast = { tiploc: tip, time };
    }
    if (isWest || isEast) marks.push({ side: isWest ? 'W' : 'E', tiploc: tip, time });
  }

  // Train must have calls on BOTH sides of the crossing
  if (!lastWest || !firstEast || !firstWest || !lastEast) {
    return { traverses: false };
  }

  // Determine direction: if west calls come before east calls, train is eastbound
  if (lastWest.time < firstEast.time) {
    const leg = { direction: 'east', nearWest: lastWest, nearEast: firstEast };
    return { traverses: true, ...leg, legs: [leg] };
  } else if (lastEast.time < firstWest.time) {
    const leg = { direction: 'west', nearWest: firstWest, nearEast: lastEast };
    return { traverses: true, ...leg, legs: [leg] };
  }

  // West and east timing points INTERLEAVE. Two different things look like this, and
  // `transitions` — each west<->east change of side — is what tells them apart. A
  // transition is `bracketPair` when it is exactly the configured interpolation pair,
  // i.e. the two timing points that actually bracket this crossing.
  //
  //   every transition is the bracket pair  -> a genuine out-and-back over OUR road.
  //        Measured on the 2026-07-30 extract: 3 of the 4 schedules here, SHRHMBS<->HOVE
  //        7-11.5 min apart. Emitted below as one leg per traversal.
  //   anything else                         -> not our crossing. 1Q76 touches Arundel Jn
  //        and Preston Park 81 and 228 min apart via the Arun valley and never comes near
  //        Portslade; calling that a traversal would invent two closures a week. Still
  //        dropped, and still logged so the drop is visible.
  //
  // This branch used to drop BOTH, on the reasoning that the pipeline assumed one crossing
  // per train per day, with the note "revisit only if TD sights one of these headcodes".
  // TD has: over 2026-10-18..24 the railhead-treatment workings 3S93 and 3S97 were dropped
  // here every morning and crossed Boundary Road 26 times between them. Checked against the
  // backend state log for 24 Oct, the app read OPEN or CLOSING_SOON — never CLOSED — across
  // all four of that day's crossings, twice flipping to OPEN under a minute before the train
  // reached the road. That is a closure a day and a half, invisible, in RHTT season.
  //
  // The downstream assumption was real but narrower than "one crossing per train": what is
  // keyed per train is the UID (schedule map, now a group of legs) and the headcode (sighting
  // and strike maps). Strikes are already direction-matched, and the two directions use
  // disjoint berth chains, so each leg projects only off its own side of the railway. The one
  // place that genuinely cannot tell the legs apart is the day's FIRST sighting — see
  // `legIndex` in crossing-state._mergeTrains.
  const interp = crossingConfig.interpolation || {};
  const transitions = [];
  const legs = [];
  for (let i = 1; i < marks.length; i++) {
    if (marks[i].side === marks[i - 1].side) continue;
    const from = marks[i - 1], to = marks[i];
    const direction = from.side === 'W' ? 'east' : 'west';
    const pair = interp[direction === 'east' ? 'eastbound' : 'westbound'] || {};
    const bracketPair = from.tiploc === pair.from && to.tiploc === pair.to;
    transitions.push({
      direction,
      from: from.tiploc,
      to: to.tiploc,
      gapMins: Math.round((to.time - from.time) * 10) / 10,
      bracketPair
    });
    // A transition runs from the side the train is LEAVING to the side it is joining, so
    // eastbound its two marks are already (west, east) and westbound they are reversed.
    legs.push(direction === 'east'
      ? { direction, nearWest: from, nearEast: to }
      : { direction, nearWest: to, nearEast: from });
  }

  if (transitions.length > 1 && transitions.every(t => t.bracketPair)) {
    return { traverses: true, multi: true, legs, transitions };
  }
  return { traverses: false, ambiguous: true, transitions };
}

// Estimate crossing time by interpolation between two timing points
function estimateCrossingTime(nearWest, nearEast, direction, interpolation) {
  const interpConfig = interpolation[direction === 'east' ? 'eastbound' : 'westbound'];
  if (!interpConfig) return null;

  const fraction = interpConfig.fraction;

  if (direction === 'east') {
    // Travelling west→east: crossing is fraction of the way from west to east
    const duration = nearEast.time - nearWest.time;
    return nearWest.time + duration * fraction;
  } else {
    // Travelling east→west: crossing is fraction of the way from east to west
    const duration = nearWest.time - nearEast.time;
    return nearEast.time + duration * fraction;
  }
}

// STP indicator priority — higher replaces lower. C (cancel) > N (new STP) >
// O (overlay) > P (permanent / base WTT). Shared by the full parse and the
// daily-update overlay so the two paths agree.
const STP_PRIORITY = { P: 0, O: 1, N: 2, C: 3 };

function stpRank(stp) {
  return STP_PRIORITY[stp] || 0;
}

// Pull the common train-level fields out of a JsonScheduleV1 record.
function extractTrainFields(sched) {
  const segment = sched.schedule_segment || {};
  const headcode = segment.signalling_id || '';
  const category = segment.CIF_train_category || '';
  const opChars = segment.CIF_operating_characteristics || '';
  // Q in CIF_operating_characteristics = "runs as required". Path is in the
  // WTT but the train only runs on demand — common for freight aggregate
  // flows. Significant false-positive source unless we filter or downgrade.
  const runsAsRequired = opChars.includes('Q');

  // Determine train type from headcode and category
  let trainType = 'passenger';
  if (category === 'EE') trainType = 'ecs';
  else if (headcode && '67'.includes(headcode.charAt(0))) trainType = 'freight';
  else if (headcode && headcode.charAt(0) === '3') trainType = 'test';
  else if (headcode && headcode.charAt(0) === '5') trainType = 'ecs';

  return {
    uid: sched.CIF_train_uid,
    stp: sched.CIF_stp_indicator || 'P',
    headcode, category, trainType,
    operator: sched.atoc_code || '',
    power: segment.CIF_power_type || '',
    runsAsRequired,
    daysPattern: sched.schedule_days_runs || ''
  };
}

// Does this schedule CALL at `tiploc`? A calling location carries an arrival and/or
// departure; a location the train merely runs through carries only `pass`.
//
// ABSENT ⇒ FALSE, not unknown. A CIF schedule lists every location the train calls at,
// plus passing locations that happen to be timing points — so a station that does not
// appear is one the train does not call at. Verified against the real extract: the
// Littlehampton–Victoria services carry PSLDAWH with arr/dep and no STHWICK entry at
// all, which is exactly "calls Portslade, not Southwick". Treating absent as unknown
// made every one of them fall back to the wrong timing class.
//
// null is reserved for "not configured" — the only genuine don't-know.
function callsAt(locations, tiploc) {
  if (!tiploc) return null;
  for (const loc of locations) {
    if (loc.tiploc_code !== tiploc) continue;
    if (loc.arrival || loc.departure || loc.public_arrival || loc.public_departure) return true;
  }
  return false;
}

// Build the per-crossing train entries for a record that traverses: ONE PER TRAVERSAL,
// in time order. Almost always a single entry; an out-and-back working (see analyseRoute)
// yields one per leg. Returns [] for a record that does not traverse.
function buildCrossingEntries(fields, locations, crossingCfg, ambiguousOut) {
  const schedCfg = crossingCfg.schedule;
  if (!schedCfg) return [];

  const route = analyseRoute(locations, schedCfg);
  if (!route.traverses) {
    // Still dropped — this only records WHY, for the parse summary.
    if (route.ambiguous && Array.isArray(ambiguousOut)) {
      ambiguousOut.push({
        headcode: fields.headcode || '----', uid: fields.uid,
        runsAsRequired: !!fields.runsAsRequired, daysPattern: fields.daysPattern,
        transitions: route.transitions || []
      });
    }
    return [];
  }

  const built = [];
  for (const leg of route.legs) {
    const entry = buildLegEntry(fields, locations, schedCfg, leg);
    if (entry) built.push(entry);
  }
  built.sort((a, b) => a.estimatedCrossingMins - b.estimatedCrossingMins);
  // Stamped after the sort so legIndex is always "which traversal of the day is this",
  // counting from 0 in the order they happen. Read by crossing-state._mergeTrains, which
  // must not hand a later leg the day's first TD sighting — that sighting belongs to an
  // earlier one. Always present, 0/1 for the ordinary single-traversal case, so nothing
  // downstream has to tell "no legs" from "leg absent".
  built.forEach((e, i) => { e.legIndex = i; e.legCount = built.length; });
  return built;
}

// One traversal -> one schedule entry, or null when its crossing time cannot be estimated.
function buildLegEntry(fields, locations, schedCfg, leg) {
  const estMins = estimateCrossingTime(
    leg.nearWest, leg.nearEast, leg.direction, schedCfg.interpolation
  );
  if (estMins === null) return null;

  return {
    uid: fields.uid,
    headcode: fields.headcode,
    category: fields.category,
    operator: fields.operator,
    trainType: fields.trainType,
    power: fields.power,
    direction: leg.direction,
    // true/false when the schedule says whether it calls at the crossing station,
    // null when unknowable. Lets crossing-state classify a CIF train beyond the LDB
    // window instead of silently treating every CIF entry as non-stopping.
    callsAtStation: callsAt(locations, schedCfg.tiploc_station),
    // Whether it also calls at the station sitting INSIDE the approach berth
    // (schedule.tiploc_approach_call — Southwick, inside eastbound berth 0006).
    // That stop roughly doubles the approach-berth transit, so it selects which
    // close anchor applies. See timing.closeTrigger._comment.
    callsAtApproach: callsAt(locations, schedCfg.tiploc_approach_call),
    stp: fields.stp,
    runsAsRequired: fields.runsAsRequired,
    daysPattern: fields.daysPattern,
    estimatedCrossingTime: minsToTimeStr(estMins),
    estimatedCrossingMins: estMins,
    nearWestTiploc: leg.nearWest.tiploc,
    nearWestTime: minsToTimeStr(leg.nearWest.time),
    nearEastTiploc: leg.nearEast.tiploc,
    nearEastTime: minsToTimeStr(leg.nearEast.time),
    origin: resolveTiploc(locations[0].tiploc_code),
    destination: resolveTiploc(locations[locations.length - 1].tiploc_code),
    source: 'schedule'
  };
}

// Insert/replace a uid's ENTRIES into the uid-keyed map under STP priority. The value is
// a group — one entry per traversal — and it is replaced WHOLESALE, never entry by entry:
// an overlay is a different schedule for the same uid, so it decides how many times that
// train crosses, and merging leg-by-leg could leave a leg behind from the version it
// replaced. Every entry in a group comes off the same schedule record and so shares its stp.
function mergeByStp(schedulesByUid, key, entries) {
  if (!entries || !entries.length) return;
  const existing = schedulesByUid.get(key);
  if (!existing || stpRank(entries[0].stp) >= stpRank(existing[0].stp)) {
    schedulesByUid.set(key, entries);
  }
}

// Stream a CIF JSON file line-by-line (gzip-aware) and invoke onRecord(sched,
// obj) for each line: `sched` is obj.JsonScheduleV1 when present, else null
// (so callers can also see TIPLOC/association records). Returns the line count.
async function streamScheduleRecords(filePath, onRecord) {
  const isGzip = filePath.endsWith('.gz');
  let inputStream = fs.createReadStream(filePath);
  if (isGzip) inputStream = inputStream.pipe(zlib.createGunzip());

  const rl = readline.createInterface({ input: inputStream, crlfDelay: Infinity });
  let lineCount = 0;

  for await (const line of rl) {
    lineCount++;
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    onRecord(obj.JsonScheduleV1 || null, obj);
  }
  return lineCount;
}

// Parse the CIF file and extract trains for configured crossings
// Uses streaming to stay within memory limits
async function parseScheduleFile(filePath, crossingsConfig) {
  const results = {}; // crossingId → array of trains

  for (const id of Object.keys(crossingsConfig)) {
    results[id] = [];
  }

  // STP overlay tracking: crossingId|uid → highest-priority schedule
  const schedulesByUid = new Map();

  let scheduleCount = 0;

  // FINDING (Fix 4) — CR / TI / TA records are counted, not applied.
  //
  // Assessment for Portslade (ELR BLI1):
  //   * Change-en-Route (CR) locations alter a train's category/power/timing
  //     part-way through its journey. They do NOT add or remove calling points,
  //     so they cannot change WHETHER a service traverses the crossing, and the
  //     crossing time is interpolated from the LI arrival/pass/departure times
  //     (unaffected by a CR). The only thing a CR could touch is the train-type
  //     label, and our classification keys off the base signalling_id headcode,
  //     not a mid-route category change — West Coastway services through this
  //     crossing do not change category at Portslade. → immaterial to closures.
  //   * TIPLOC Insert/Amend (TI/TA = TiplocV1 Create/Update) are reference
  //     records mapping TIPLOC→name. Name resolution is done from CORPUS
  //     (see corpus-fetcher.resolveTiploc), and traversal/timing key off the
  //     hard-coded TIPLOC codes in config, not these records. → immaterial.
  // So we deliberately do NOT apply them (that would add complexity without
  // changing a single Portslade prediction). Instead we COUNT and LOG them so
  // they are visible rather than silently dropped, per the catch-every-closure
  // posture (if this assumption ever breaks, the counts make it obvious).
  const skipped = { tiInsert: 0, taAmend: 0, tiplocOther: 0, crLocations: 0, crOnTraversing: 0 };
  // Schedules dropped by analyseRoute's ambiguous branch — interleaved west/east calls we
  // cannot express as a single traversal. Collected so the drop is visible in the log
  // instead of silent; see the comment at that branch for why they stay dropped.
  const ambiguous = [];
  // Schedules that cross more than once and were EXPANDED into one entry per traversal
  // (analyseRoute's every-transition-is-the-bracket-pair case). Logged for the same reason
  // the drops are: this used to be a silent drop, and the fix should not be silent either.
  const multiLeg = [];

  const lineCount = await streamScheduleRecords(filePath, (sched, obj) => {
    if (!sched) {
      // Non-schedule line. Count TIPLOC reference records (TI/TA) for visibility.
      const tip = obj && obj.TiplocV1;
      if (tip) {
        const tt = tip.transaction_type;
        if (tt === 'Create') skipped.tiInsert++;           // TI — insert
        else if (tt === 'Update' || tt === 'Delete') skipped.taAmend++; // TA — amend/delete
        else skipped.tiplocOther++;
      }
      return;
    }
    scheduleCount++;

    // The full snapshot carries Create records only (overlays are Create with a
    // non-P stp). Delete/cancellation transactions arrive via the daily UPDATE
    // extract — see applyUpdateExtract.
    if (sched.transaction_type !== 'Create') return;
    if (!isActiveToday(sched)) return;

    const segment = sched.schedule_segment;
    if (!segment) return;

    const locations = segment.schedule_location || [];
    if (locations.length < 2) return;

    // Count Change-en-Route locations (visibility only — see FINDING above).
    let crHere = 0;
    for (const loc of locations) if (loc.location_type === 'CR') crHere++;
    skipped.crLocations += crHere;

    const fields = extractTrainFields(sched);

    // Check each crossing
    let traversed = false;
    for (const [crossingId, crossingCfg] of Object.entries(crossingsConfig)) {
      const entries = buildCrossingEntries(fields, locations, crossingCfg, ambiguous);
      if (!entries.length) continue;
      traversed = true;
      mergeByStp(schedulesByUid, `${crossingId}|${fields.uid}`, entries);
    }
    if (traversed && crHere) skipped.crOnTraversing += crHere;
  });

  // Collect final results, excluding cancellations. Multi-leg groups are tallied HERE,
  // off the surviving entries, not where they were built: a uid can appear as several
  // schedule versions and only the STP winner reaches the results, so counting at build
  // time over-reported the expansion.
  for (const [key, entries] of schedulesByUid) {
    const crossingId = key.split('|')[0];
    const kept = entries.filter(e => e.stp !== 'C');
    for (const entry of kept) results[crossingId].push(entry);
    if (kept.length > 1) {
      multiLeg.push({
        crossingId, uid: kept[0].uid, headcode: kept[0].headcode || '----',
        runsAsRequired: !!kept[0].runsAsRequired,
        legs: kept.map(e => `${e.direction} ~${e.estimatedCrossingTime}`)
      });
    }
  }

  // Sort each crossing's trains by estimated time
  for (const id of Object.keys(results)) {
    results[id].sort((a, b) => a.estimatedCrossingMins - b.estimatedCrossingMins);
    logger.logSchedule(id, results[id]);
  }

  console.log(`Schedule: parsed ${scheduleCount} schedules from ${lineCount} lines`);
  for (const [id, trains] of Object.entries(results)) {
    const types = {};
    for (const t of trains) types[t.trainType] = (types[t.trainType] || 0) + 1;
    console.log(`  ${id}: ${trains.length} trains (${JSON.stringify(types)})`);
  }

  // Visibility for the deliberately-unapplied CR/TI/TA records (see FINDING).
  console.log(
    `Schedule: skipped reference/CR records (not applied — immaterial to Portslade): ` +
    `TIPLOC insert(TI)=${skipped.tiInsert}, amend/delete(TA)=${skipped.taAmend}, ` +
    `CR-en-route locations=${skipped.crLocations} (on traversing trains=${skipped.crOnTraversing})`
  );

  // One line per parse. `bracket` counts side-changes that ARE the configured
  // interpolation pair, i.e. the ones that plausibly cross; a schedule with 0 of those is
  // almost certainly on another route and would be a phantom if it were ever re-added.
  if (ambiguous.length) {
    const detail = ambiguous.map(a => {
      const b = a.transitions.filter(t => t.bracketPair).length;
      return `${a.headcode}(${a.transitions.length} transition(s), ${b} bracket-pair` +
             `${a.runsAsRequired ? ', Q' : ''})`;
    }).join(', ');
    console.log(
      `Schedule: dropped ${ambiguous.length} ambiguous multi-traversal/reversing ` +
      `schedule(s) — ${detail}. Register #1: these are the ones NOT over our road — every ` +
      `side-change would have to be the bracket pair to be kept (see the expansion line). ` +
      `Revisit only if TD sights one of these headcodes.`
    );
  }
  if (multiLeg.length) {
    const detail = multiLeg
      .map(m => `${m.headcode} [${m.legs.join(', ')}]${m.runsAsRequired ? ' Q' : ''}`)
      .join(', ');
    console.log(
      `Schedule: expanded ${multiLeg.length} out-and-back schedule(s) into ` +
      `${multiLeg.reduce((n, m) => n + m.legs.length, 0)} traversals — ${detail}`
    );
  }
  lastParseStats = {
    ...skipped, lineCount, scheduleCount,
    ambiguousDropped: ambiguous.length, ambiguous,
    multiLegKept: multiLeg.length, multiLeg
  };
  return results;
}

// Counts from the most recent parseScheduleFile run (TI/TA/CR skip tallies +
// line/schedule counts). Exposed for diagnostics and tests.
let lastParseStats = null;
function getLastParseStats() {
  return lastParseStats;
}

// Apply a daily UPDATE extract on top of an already-parsed full schedule,
// WITHOUT a full re-download — so a same-day STP=C cancellation can suppress a
// train within the hour instead of waiting for the next 04:00 full reparse.
//
// Start from the full-parse result (`baseByCrossing`) and overlay the update's
// transactions, preserving STP priority (C > N > O > P):
//   - STP=C cancellation → remove the uid from predictions (the headline fix).
//       CIF cancellations usually carry no schedule_location, so we cancel by
//       uid against every crossing where the base predicted that uid.
//   - N/O/P overlay that traverses → add or replace under STP priority,
//       extending same-day coverage (a new short-term path appears within the hour).
//   - Delete transaction → counted and logged, but the train is NOT removed.
//       A bare Delete withdraws a specific prior schedule version; dropping a
//       train on it risks a false negative (a missed closure). Full schedule-
//       version tracking is out of scope, so the conservative choice favours
//       false positives, per the catch-every-closure priority.
//
// The base is never mutated and a fresh result is returned, so re-applying the
// (latest) update each hour is idempotent from a clean baseline.
async function applyUpdateExtract(updateFilePath, crossingsConfig, baseByCrossing) {
  const stats = { records: 0, cancelled: 0, overlays: 0, deletes: 0, deleteUids: [], cancelledIds: [] };
  const crossingIds = Object.keys(crossingsConfig);

  // Rebuild the uid-keyed map from the base predictions (these already exclude
  // any C the full snapshot carried, so their stp is P/O/N). Clone so the
  // caller's base array is never mutated.
  // Grouped by uid, because a uid can carry more than one traversal (an out-and-back
  // working — see analyseRoute). The base array is already in time order, so each group
  // keeps its legs in order too.
  const schedulesByUid = new Map();
  for (const [crossingId, trains] of Object.entries(baseByCrossing || {})) {
    for (const t of trains) {
      if (!t || !t.uid) continue;
      const key = `${crossingId}|${t.uid}`;
      if (!schedulesByUid.has(key)) schedulesByUid.set(key, []);
      schedulesByUid.get(key).push({ ...t });
    }
  }

  await streamScheduleRecords(updateFilePath, (sched) => {
    if (!sched || !sched.CIF_train_uid) return;
    stats.records++;
    const uid = sched.CIF_train_uid;
    const tt = sched.transaction_type || 'Create';
    const stp = sched.CIF_stp_indicator || 'P';

    // Only records effective today affect today's predictions.
    if (!isActiveToday(sched)) return;

    if (tt === 'Delete') {
      stats.deletes++;
      if (stats.deleteUids.length < 50) stats.deleteUids.push(uid);
      return; // conservative: never remove a train on a bare Delete
    }

    if (stp === 'C') {
      let didCancel = false;
      for (const crossingId of crossingIds) {
        const key = `${crossingId}|${uid}`;
        const existing = schedulesByUid.get(key);
        if (existing && stpRank('C') >= stpRank(existing[0].stp)) {
          // Cancels the whole uid: a cancelled train makes none of its traversals.
          schedulesByUid.set(key, existing.map(e => ({ ...e, stp: 'C' })));
          for (const e of existing) {
            stats.cancelledIds.push({
              uid, crossingId,
              headcode: e.headcode || null,
              estimatedCrossingTime: e.estimatedCrossingTime || null
            });
          }
          didCancel = true;
        }
      }
      if (didCancel) stats.cancelled++;
      return;
    }

    // N/O/P overlay carrying locations → add or replace under STP priority.
    const segment = sched.schedule_segment;
    const locations = (segment && segment.schedule_location) || [];
    if (locations.length < 2) return;
    const fields = extractTrainFields(sched);
    let didOverlay = false;
    for (const crossingId of crossingIds) {
      const entries = buildCrossingEntries(fields, locations, crossingsConfig[crossingId]);
      if (!entries.length) continue;
      mergeByStp(schedulesByUid, `${crossingId}|${uid}`, entries);
      didOverlay = true;
    }
    if (didOverlay) stats.overlays++;
  });

  // Rebuild per-crossing results, excluding cancellations, sorted by time.
  const results = {};
  for (const id of crossingIds) results[id] = [];
  for (const [key, entries] of schedulesByUid) {
    const crossingId = key.split('|')[0];
    for (const entry of entries) {
      if (entry.stp !== 'C' && results[crossingId]) results[crossingId].push(entry);
    }
  }
  for (const id of crossingIds) {
    results[id].sort((a, b) => a.estimatedCrossingMins - b.estimatedCrossingMins);
  }

  // Passive confirmation: one greppable line whenever real cancellations from
  // the update extract are applied, naming the suppressed services so the live
  // behaviour can be eyeballed in the logs (no need to catch one happening).
  if (stats.cancelled > 0) {
    const detail = stats.cancelledIds
      .map(c => `${c.headcode || c.uid} (${c.crossingId} ~${c.estimatedCrossingTime || '?'})`)
      .join(', ');
    console.log(`CIF update: suppressed ${stats.cancelled} service(s) from update extract — ${detail}`);
  }
  console.log(`CIF update applied: ${stats.cancelled} cancellation(s), ${stats.overlays} overlay(s), ${stats.deletes} delete(s) over ${stats.records} update record(s)`);
  return { trains: results, stats };
}

module.exports = {
  parseScheduleFile, applyUpdateExtract, getLastParseStats,
  cifTimeToMins, minsToTimeStr,
  analyseRoute, estimateCrossingTime
};
