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
  const h = Math.floor(mins / 60) % 24;
  const m = Math.round(mins % 60);
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
// Returns { traverses: true, direction, nearWest, nearEast } when it does,
// otherwise { traverses: false }.
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

  for (const loc of locations) {
    const tip = loc.tiploc_code;
    const raw = cifTimeToMins(loc.departure || loc.pass || loc.arrival);
    if (raw === null) continue;

    if (prevTime !== null && raw + offset < prevTime - MIDNIGHT_WRAP_THRESHOLD_MINS) {
      offset += 1440;
    }
    const time = raw + offset;
    prevTime = time;

    if (westSet.has(tip)) {
      if (!firstWest) firstWest = { tiploc: tip, time };
      lastWest = { tiploc: tip, time };
    }
    if (eastSet.has(tip)) {
      if (!firstEast) firstEast = { tiploc: tip, time };
      lastEast = { tiploc: tip, time };
    }
  }

  // Train must have calls on BOTH sides of the crossing
  if (!lastWest || !firstEast || !firstWest || !lastEast) {
    return { traverses: false };
  }

  // Determine direction: if west calls come before east calls, train is eastbound
  if (lastWest.time < firstEast.time) {
    return {
      traverses: true,
      direction: 'east',
      nearWest: lastWest,
      nearEast: firstEast
    };
  } else if (lastEast.time < firstWest.time) {
    return {
      traverses: true,
      direction: 'west',
      nearWest: firstWest,
      nearEast: lastEast
    };
  }

  // Ambiguous — might be a reversing service
  return { traverses: false };
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

// Does this schedule CALL at the crossing's own station (config schedule.tiploc_station)?
// A calling location carries an arrival and/or departure; a location the train merely
// runs through carries only `pass`. Returns null when unconfigured or the station isn't
// in the schedule at all, so callers can distinguish "doesn't call" from "don't know".
function callsAtStation(locations, schedCfg) {
  const tip = schedCfg && schedCfg.tiploc_station;
  if (!tip) return null;
  let seen = false;
  for (const loc of locations) {
    if (loc.tiploc_code !== tip) continue;
    seen = true;
    if (loc.arrival || loc.departure || loc.public_arrival || loc.public_departure) return true;
  }
  return seen ? false : null;
}

// Build the per-crossing train entry for a record that traverses, or null.
function buildCrossingEntry(fields, locations, crossingCfg) {
  const schedCfg = crossingCfg.schedule;
  if (!schedCfg) return null;

  const route = analyseRoute(locations, schedCfg);
  if (!route.traverses) return null;

  const estMins = estimateCrossingTime(
    route.nearWest, route.nearEast, route.direction, schedCfg.interpolation
  );
  if (estMins === null) return null;

  return {
    uid: fields.uid,
    headcode: fields.headcode,
    category: fields.category,
    operator: fields.operator,
    trainType: fields.trainType,
    power: fields.power,
    direction: route.direction,
    // true/false when the schedule says whether it calls at the crossing station,
    // null when unknowable. Lets crossing-state classify a CIF train beyond the LDB
    // window instead of silently treating every CIF entry as non-stopping.
    callsAtStation: callsAtStation(locations, schedCfg),
    stp: fields.stp,
    runsAsRequired: fields.runsAsRequired,
    daysPattern: fields.daysPattern,
    estimatedCrossingTime: minsToTimeStr(estMins),
    estimatedCrossingMins: estMins,
    nearWestTiploc: route.nearWest.tiploc,
    nearWestTime: minsToTimeStr(route.nearWest.time),
    nearEastTiploc: route.nearEast.tiploc,
    nearEastTime: minsToTimeStr(route.nearEast.time),
    origin: resolveTiploc(locations[0].tiploc_code),
    destination: resolveTiploc(locations[locations.length - 1].tiploc_code),
    source: 'schedule'
  };
}

// Insert/replace an entry into the uid-keyed map under STP priority.
function mergeByStp(schedulesByUid, key, entry) {
  const existing = schedulesByUid.get(key);
  if (!existing || stpRank(entry.stp) >= stpRank(existing.stp)) {
    schedulesByUid.set(key, entry);
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
      const entry = buildCrossingEntry(fields, locations, crossingCfg);
      if (!entry) continue;
      traversed = true;
      mergeByStp(schedulesByUid, `${crossingId}|${fields.uid}`, entry);
    }
    if (traversed && crHere) skipped.crOnTraversing += crHere;
  });

  // Collect final results, excluding cancellations
  for (const [key, entry] of schedulesByUid) {
    const crossingId = key.split('|')[0];
    if (entry.stp !== 'C') {
      results[crossingId].push(entry);
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

  lastParseStats = { ...skipped, lineCount, scheduleCount };
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
  const schedulesByUid = new Map();
  for (const [crossingId, trains] of Object.entries(baseByCrossing || {})) {
    for (const t of trains) {
      if (t && t.uid) schedulesByUid.set(`${crossingId}|${t.uid}`, { ...t });
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
        if (existing && stpRank('C') >= stpRank(existing.stp)) {
          schedulesByUid.set(key, { ...existing, stp: 'C' });
          stats.cancelledIds.push({
            uid, crossingId,
            headcode: existing.headcode || null,
            estimatedCrossingTime: existing.estimatedCrossingTime || null
          });
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
      const entry = buildCrossingEntry(fields, locations, crossingsConfig[crossingId]);
      if (!entry) continue;
      mergeByStp(schedulesByUid, `${crossingId}|${uid}`, entry);
      didOverlay = true;
    }
    if (didOverlay) stats.overlays++;
  });

  // Rebuild per-crossing results, excluding cancellations, sorted by time.
  const results = {};
  for (const id of crossingIds) results[id] = [];
  for (const [key, entry] of schedulesByUid) {
    const crossingId = key.split('|')[0];
    if (entry.stp !== 'C' && results[crossingId]) results[crossingId].push(entry);
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
