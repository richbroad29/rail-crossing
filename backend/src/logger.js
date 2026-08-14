const fs = require('fs');
const path = require('path');
const { londonDateStamp } = require('./time-utils');

const LOG_DIR = path.join(__dirname, '..', 'data', 'logs');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function dateStamp() {
  return londonDateStamp();
}

function timestamp() {
  return new Date().toISOString();
}

// Append a JSON line to the daily log file
function log(category, data) {
  ensureDir(LOG_DIR);
  const entry = { ts: timestamp(), cat: category, ...data };
  const file = path.join(LOG_DIR, `${dateStamp()}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}

// Log an LDB poll result for a crossing
function logLdb(crossingId, trains) {
  log('ldb', {
    crossing: crossingId,
    trainCount: trains.length,
    trains: trains.map(t => ({
      dir: t.direction,
      sch: t.scheduledTime,
      best: t.bestTime,
      origin: t.origin,
      dest: t.destination,
      delay: t.delayMins,
      headcode: t.headcode || null,
      // WHY we hold that time, not just what it is. Without these, a snapshot showing
      // `best === sch, delay 0` is ambiguous between a punctual train, a train whose
      // forecast the feed withdrew, and a train that has already been past — three
      // different faults with byte-identical output. Diagnosing 1S30 on 2026-08-13 from
      // three days of these logs was impossible for exactly that reason.
      src: t.timeSource || null,
      held: t.estimateHeld ? true : undefined,
      arrType: t.arrivalType || undefined,
      depType: t.departureType || undefined
    }))
  });
}

// Log a schedule-derived expected train
function logSchedule(crossingId, trains) {
  log('schedule', {
    crossing: crossingId,
    trainCount: trains.length,
    trains: trains.map(t => ({
      uid: t.uid,
      headcode: t.headcode,
      category: t.category,
      operator: t.operator,
      dir: t.direction,
      estTime: t.estimatedCrossingTime
    }))
  });
}

// Log a state transition
function logState(crossingId, oldState, newState, reason) {
  log('state', {
    crossing: crossingId,
    from: oldState,
    to: newState,
    reason
  });
}

// Log startup info
function logStartup(crossingIds, config) {
  log('startup', {
    crossings: crossingIds,
    version: require('../package.json').version,
    node: process.version
  });
}

module.exports = { log, logLdb, logSchedule, logState, logStartup };
