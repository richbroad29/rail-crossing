'use strict';

// MEMORY_FIT — would a map service fit on this VPS next to the crossing service?
//
// projected = the peak RSS of td-measure while it held the simulated national state. It is the
// best stand-in available before the service exists, and it is a FLOOR: the real service adds
// its HTTP server, SMART/CORPUS tables and per-client state on top.
// reserve   = what would be left: MemAvailable minus projected.
//
//   PASS   reserve >= 300 MB
//   WARN   reserve >= 150 MB
//   FAIL   below that — "use a second machine"
//
// The thresholds are a judgement call, not a measurement. The reserve exists because the
// crossing service reloads its timetable every day (04:00 London: the CIF file is ~120 MB
// gzipped and parsed in memory, per CLAUDE.md), and its memory peaks then. A map service that
// only just fits at 3 pm could still push the box into swap or the OOM killer at 4 am — and the
// OOM killer does not promise to pick the map service. 150 MB is the floor below which a spike
// of that kind has nowhere to go; 300 MB is comfortable. Change them here, in one place, if the
// reload turns out to need more or less.

const PASS_RESERVE_MB = 300;
const WARN_RESERVE_MB = 150;
// State (above all the berth graph) keeps growing for a while after start. A projection from a
// few minutes of data is not evidence the service fits, whatever the arithmetic says.
const MIN_MINUTES_FOR_VERDICT = 15;

const mb = n => Math.round(n * 10) / 10;
const known = v => typeof v === 'number' && Number.isFinite(v);

/**
 * @param {object} o
 * @param {number|null} o.availableMB  MemAvailable (see td-measure for how it is chosen)
 * @param {number|null} o.projectedMB  peak RSS of the measuring process
 * @param {number} [o.minutes]         how long the state was measured
 * @returns {{status: 'PASS'|'WARN'|'FAIL', reserveMB: number|null, message: string, data: object}}
 */
function memoryFit({ availableMB, projectedMB, minutes } = {}) {
  const data = { availableMB: known(availableMB) ? mb(availableMB) : null, projectedMB: known(projectedMB) ? mb(projectedMB) : null, minutes: known(minutes) ? mb(minutes) : null, passReserveMB: PASS_RESERVE_MB, warnReserveMB: WARN_RESERVE_MB };
  if (!known(availableMB) || !known(projectedMB)) {
    return { status: 'WARN', reserveMB: null, data, message: 'could not judge: available memory or this process\'s peak size could not be read (the check needs Linux\'s /proc/meminfo)' };
  }
  const reserve = availableMB - projectedMB;
  // Floored, never rounded: 299.96 must not be displayed as "300" beside a WARN that says "want 300".
  const reserveMB = Math.floor(reserve * 10) / 10;
  data.reserveMB = reserveMB;
  const facts = `a map service of about ${mb(projectedMB)} MB would leave ${reserveMB} MB free of ${mb(availableMB)} MB available`;
  if (reserve < WARN_RESERVE_MB) {
    return { status: 'FAIL', reserveMB, data, message: `${facts} (the floor is ${WARN_RESERVE_MB} MB) - use a second machine for the map service` };
  }
  if (reserve < PASS_RESERVE_MB) {
    return { status: 'WARN', reserveMB, data, message: `${facts} (comfortable is ${PASS_RESERVE_MB} MB): it fits, but tightly - check the crossing service's memory at its 04:00 reload before deciding` };
  }
  if (known(minutes) && minutes < MIN_MINUTES_FOR_VERDICT) {
    return { status: 'WARN', reserveMB, data, message: `${facts} - but only ${mb(minutes)} min were measured and the state is still filling; run at least ${MIN_MINUTES_FOR_VERDICT} (default 60) before trusting this` };
  }
  return { status: 'PASS', reserveMB, data, message: `${facts} (need ${PASS_RESERVE_MB}): it fits next to the crossing service` };
}

module.exports = { memoryFit, PASS_RESERVE_MB, WARN_RESERVE_MB, MIN_MINUTES_FOR_VERDICT };
