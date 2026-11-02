'use strict';

// Verdict pieces both scripts share, so the same situation reads the same way in both reports.

const round1 = n => Math.round(n * 10) / 10;

/** "10:31:07 UTC" from an ISO timestamp, for one-line messages. */
const clock = iso => (iso ? iso.slice(11, 19) + ' UTC' : 'an unknown time');

/**
 * The INTERLOCK verdict: was the crossing service watched, and did the watching trip?
 *
 * A crossing service that looks disturbed right AFTER our last connection closed is a FAIL, not a
 * WARN. It may be coincidence, but this tool's first rule is never to disturb the live service,
 * and a false alarm costs one re-run where a missed one could cost a barrier closure. (The
 * SECOND_CONNECTION verdict stays a WARN for the same observation: "inconclusive" is the honest
 * word for the connection question, "fail" the honest word for the safety check.)
 *
 * @param {object} r
 * @param {object} r.interlock  createInterlock().summary()
 * @param {object|null} r.settle  the strict look after our last connection closed
 * @param {object} [r.extra]    more detail for the JSON (e.g. the look after each connection)
 */
function interlockCheck(r) {
  const il = r.interlock;
  const data = { ...il, afterWeLeft: r.settle, ...(r.extra || {}) };
  const out = (status, message) => ({ id: 'INTERLOCK', status, message, data });
  if (!il.enabled) return out('WARN', 'DISABLED by --no-interlock: the crossing service was NOT watched while this ran');
  if (il.tripped) return out('FAIL', `TRIPPED at ${clock(il.tripped.at)} (${il.tripped.rule}): ${il.tripped.message}`);
  const watched = `watched on the ${il.mode === 'log' ? 'LA-log' : 'health td'} signal every ${il.pollIntervalSecs} s: ${il.polls} checks (${il.failedPolls} failed), longest gap ${il.maxGapSecs} s, none tripped`;
  if (r.settle && r.settle.disturbed) {
    return out('FAIL', `${watched}; but after we disconnected it looked disturbed (${r.settle.rule}): ${r.settle.message}. Check it before doing anything else`);
  }
  return out('PASS', r.settle ? `${watched}; and still healthy after we disconnected` : watched);
}

/**
 * What to tell the operator, in the terminal after the summary, when the crossing service tripped
 * the interlock or looked unwell after we left. Empty when there is nothing to say.
 */
function afterRunAdvice({ tripped, settle, healthUrl }) {
  const unwellAfter = !!(settle && settle.disturbed);
  if (!tripped && !unwellAfter) return [];
  const lines = [''];
  lines.push(tripped
    ? `STOPPED: the crossing service looked disturbed (${tripped.rule}). The connection was closed at once.`
    : `After we disconnected, the crossing service looks disturbed (${settle.rule}): ${settle.message}.`);
  lines.push(tripped && settle && !settle.disturbed
    ? 'A moment after we disconnected, the crossing service looked healthy again.'
    : `It still looks unwell after we disconnected. It has its own watchdog and reconnects by itself within about 5 minutes. Check with:  curl -s ${healthUrl}   - and if td.connected is still false after that, tell us BEFORE restarting anything.`);
  return lines;
}

module.exports = { round1, clock, interlockCheck, afterRunAdvice };
