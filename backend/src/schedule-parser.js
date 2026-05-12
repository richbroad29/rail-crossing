const fs = require('fs');
const zlib = require('zlib');
const readline = require('readline');
const path = require('path');
const logger = require('./logger');
const { londonMinsToDate, londonDateStamp } = require('./time-utils');

// Parse CIF time "HHMM" or "HHMMH" (H = half-minute) into minutes since midnight
function cifTimeToMins(t) {
  if (!t) return null;
  const h = parseInt(t.slice(0, 2));
  const m = parseInt(t.slice(2, 4));
  const half = t.endsWith('H') ? 0.5 : 0;
  return h * 60 + m + half;
}

// Convert minutes since midnight to "HH:MM" string
function minsToTimeStr(mins) {
  const h = Math.floor(mins / 60) % 24;
  const m = Math.round(mins % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Convert minutes since midnight to a Date for today (Europe/London wall-clock)
function minsToDate(mins) {
  return londonMinsToDate(mins);
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

// Determine if a schedule traverses a crossing based on TIPLOC sets
// Returns { traverses, direction, westTiploc, eastTiploc, westTime, eastTime }
function analyseRoute(locations, crossingConfig) {
  const westSet = new Set(crossingConfig.tiplocs_west);
  const eastSet = new Set(crossingConfig.tiplocs_east);

  let firstWest = null, lastWest = null;
  let firstEast = null, lastEast = null;

  for (const loc of locations) {
    const tip = loc.tiploc_code;
    const time = cifTimeToMins(loc.departure || loc.pass || loc.arrival);

    if (westSet.has(tip) && time !== null) {
      if (!firstWest) firstWest = { tiploc: tip, time };
      lastWest = { tiploc: tip, time };
    }
    if (eastSet.has(tip) && time !== null) {
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

// Parse the CIF file and extract trains for configured crossings
// Uses streaming to stay within memory limits
async function parseScheduleFile(filePath, crossingsConfig) {
  const results = {}; // crossingId → array of trains

  for (const id of Object.keys(crossingsConfig)) {
    results[id] = [];
  }

  // Determine if file is gzipped
  const isGzip = filePath.endsWith('.gz');
  let inputStream = fs.createReadStream(filePath);
  if (isGzip) {
    inputStream = inputStream.pipe(zlib.createGunzip());
  }

  const rl = readline.createInterface({ input: inputStream, crlfDelay: Infinity });

  // STP overlay tracking: uid → highest-priority schedule
  const schedulesByUid = new Map();

  let lineCount = 0;
  let scheduleCount = 0;

  for await (const line of rl) {
    lineCount++;
    if (!line.trim()) continue;

    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (!obj.JsonScheduleV1) continue;
    const sched = obj.JsonScheduleV1;
    scheduleCount++;

    // Only process Create records that are active today
    if (sched.transaction_type !== 'Create') continue;
    if (!isActiveToday(sched)) continue;

    const segment = sched.schedule_segment;
    if (!segment) continue;

    const locations = segment.schedule_location || [];
    if (locations.length < 2) continue;

    const uid = sched.CIF_train_uid;
    const stp = sched.CIF_stp_indicator || 'P';
    const headcode = segment.signalling_id || '';
    const category = segment.CIF_train_category || '';
    const operator = sched.atoc_code || '';
    const power = segment.CIF_power_type || '';

    // Determine train type from headcode and category
    let trainType = 'passenger';
    if (category === 'EE') trainType = 'ecs';
    else if (headcode && '67'.includes(headcode.charAt(0))) trainType = 'freight';
    else if (headcode && headcode.charAt(0) === '3') trainType = 'test';
    else if (headcode && headcode.charAt(0) === '5') trainType = 'ecs';

    // Check each crossing
    for (const [crossingId, crossingCfg] of Object.entries(crossingsConfig)) {
      const schedCfg = crossingCfg.schedule;
      if (!schedCfg) continue;

      const route = analyseRoute(locations, schedCfg);
      if (!route.traverses) continue;

      const estMins = estimateCrossingTime(
        route.nearWest, route.nearEast, route.direction,
        schedCfg.interpolation
      );
      if (estMins === null) continue;

      const entry = {
        uid,
        headcode,
        category,
        operator,
        trainType,
        power,
        direction: route.direction,
        stp,
        estimatedCrossingTime: minsToTimeStr(estMins),
        estimatedCrossingMins: estMins,
        nearWestTiploc: route.nearWest.tiploc,
        nearWestTime: minsToTimeStr(route.nearWest.time),
        nearEastTiploc: route.nearEast.tiploc,
        nearEastTime: minsToTimeStr(route.nearEast.time),
        origin: locations[0].tiploc_code,
        destination: locations[locations.length - 1].tiploc_code,
        source: 'schedule'
      };

      // STP overlay logic: higher-priority STP indicator replaces lower
      // C (cancel) > N (new) > O (overlay) > P (permanent)
      const stpPriority = { P: 0, O: 1, N: 2, C: 3 };
      const key = `${crossingId}|${uid}`;
      const existing = schedulesByUid.get(key);

      if (!existing || (stpPriority[stp] || 0) >= (stpPriority[existing.stp] || 0)) {
        schedulesByUid.set(key, entry);
      }
    }
  }

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

  return results;
}

module.exports = { parseScheduleFile, cifTimeToMins, minsToTimeStr, minsToDate };
