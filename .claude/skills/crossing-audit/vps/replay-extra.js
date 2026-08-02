#!/usr/bin/env node
// Fault injection over the DEPLOYED predict.js. Exercises the edge cases a passive
// recording can never contain, because they need the world to misbehave:
//
//   1. staleness  - the client honours holdingOpen only while the payload is <90s old
//                   (HOLD_TRUST_MS). A phone that loses the backend must NOT sit on
//                   BARRIERS DOWN forever. Assert it releases.
//   2. clock skew - the observer derives on the DEVICE clock, so a wrong phone clock is a
//                   real user state. +/-2 min must not produce negative or absurd durations.
//   3. no network - the last payload plus a long-advancing clock: does the UI ever stop
//                   asserting a closure that ended long ago?
//
//   node replay-extra.js <OUTDIR>   -> writes <OUTDIR>/faults.json
const fs = require('fs'), path = require('path');
const OUT = process.argv[2];
if (!OUT) { console.error('usage: replay-extra.js <OUTDIR>'); process.exit(2); }
const REPO = path.join(OUT, 'frontend');

const core = fs.readFileSync(path.join(REPO, 'shared/predict.js'), 'utf8')
  + ';\n' + fs.readFileSync(path.join(REPO, 'shared/closure-card.js'), 'utf8');
const P = new Function(core + ';return PREDICT;')();

const main = fs.readFileSync(path.join(OUT, 'main.jsonl'), 'utf8').trim().split('\n')
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// buildClosuresFromVps lives in crossing.js; replicate only its contract here (Dates), which
// is all derive() consumes. Keeping it minimal means this harness does not silently drift
// into testing a second implementation of the mapping.
const toPeriods = cs => (cs || []).map(c => ({
  start: new Date(c.start), end: new Date(c.end),
  predictedStart: c.predictedStart ? new Date(c.predictedStart) : null,
  holdingOpen: !!c.holdingOpen, closePending: !!c.closePending, closeConfirmed: !!c.closeConfirmed,
  trains: c.trains || [],
}));

const R = { staleness: [], skew: [], noNetwork: [], summary: {} };

// ---------------------------------------------------------------- 1. staleness guard
const AGES = [0, 60e3, 89e3, 91e3, 120e3, 300e3, 900e3];
let heldSamples = 0, stuck = 0;
for (const rec of main) {
  const cs = (rec.main.upcomingClosures || []).filter(c => c.holdingOpen);
  if (!cs.length) continue;
  heldSamples++;
  const periods = toPeriods(rec.main.upcomingClosures);
  const row = { t: rec.t, results: {} };
  for (const age of AGES) {
    // now advances WITH the age. Holding the clock still while ageing the payload is not a
    // state any device can be in, and it made the guard look broken when it is not: with the
    // clock frozen the period's own `end` is still in the future, so CLOSED is correct and
    // says nothing about whether holdingOpen was honoured.
    let d; try { d = P.derive(periods, new Date(rec.t * 1000 + age), age); } catch (e) { d = { error: e.message }; }
    row.results[age / 1000 + 's'] = d.error ? 'ERR:' + d.error : d.status;
  }
  // The claim under test: once the payload is too old to trust, a HELD period must stop being
  // honoured — i.e. the only thing keeping it CLOSED can be its own clock-based end.
  const heldEnd = Math.max(...periods.filter(p => p.holdingOpen).map(p => p.end.getTime()));
  const pastAllHeldEnds = AGES.filter(a => rec.t * 1000 + a > heldEnd);
  const probe = pastAllHeldEnds.find(a => a > 90e3);
  row.probeAgeSecs = probe ? probe / 1000 : null;
  row.released = probe == null ? null : row.results[probe / 1000 + 's'] !== 'CLOSED';
  if (row.released === false) { stuck++; }
  if (R.staleness.length < 25) R.staleness.push(row);
}
R.summary.holdingOpenSamples = heldSamples;
R.summary.heldStillClosedPastTrust = stuck;

// ---------------------------------------------------------------- 2. device clock skew
const BAD = /NaN|Invalid Date|undefined|-\d+\s*s/;
let skewChecked = 0;
for (const rec of main) {
  const periods = toPeriods(rec.main.upcomingClosures);
  if (!periods.length) continue;
  for (const off of [-120e3, 120e3]) {
    skewChecked++;
    const skewNow = rec.t * 1000 + off;
    let d; try { d = P.derive(periods, new Date(skewNow), 0); } catch (e) { d = { error: e.message }; }
    // derive returns absolute times, not deltas — the app subtracts `now` itself, so the
    // skewed clock is exactly what makes these go negative.
    const closeIn = d.nextCloseTime ? d.nextCloseTime.getTime() - skewNow : null;
    const openIn = d.nextOpenTime ? d.nextOpenTime.getTime() - skewNow : null;
    const strs = [];
    try {
      if (closeIn != null) strs.push(P.fmtEta(closeIn, d.closeHeld));
      if (openIn != null) strs.push(P.fmtEta(openIn, d.openHeld));
      if (d.downForMs != null) strs.push(P.fmtDuration(d.downForMs));
      if (d.downForRange) strs.push(String(d.downForRange));
    } catch (e) { strs.push('FMT-ERR:' + e.message); }
    const bad = strs.filter(s => BAD.test(String(s)));
    // Judge the RENDERED string, not the internal number. A close time a few seconds in the
    // past is negative and renders as "Soon" — which is correct, and flagging it as a skew
    // failure was noise. Only an absurd magnitude that still renders as a live countdown is
    // a real problem.
    const absurd = [closeIn, openIn, d.downForMs].filter(v =>
      typeof v === 'number' && v < -600e3 && !strs.some(s => /Soon|held|≥/.test(String(s))));
    if ((bad.length || absurd.length || d.error) && R.skew.length < 25) {
      R.skew.push({ t: rec.t, offsetSecs: off / 1000, state: d.status, strings: strs, bad, absurd, error: d.error });
    }
  }
}
R.summary.skewChecks = skewChecked;
R.summary.skewProblems = R.skew.length;

// ---------------------------------------------------------------- 3. lost backend
// Freeze the last payload and walk the clock forward. A closure whose end has long passed
// must not still read as current once the hold can no longer be trusted.
const last = main[main.length - 1];
if (last) {
  const periods = toPeriods(last.main.upcomingClosures);
  // The payload carries a whole day of upcoming closures, so an advancing clock will walk
  // INTO later legitimate ones. "Stuck" only means anything once the clock is past every
  // period the frozen payload knows about — otherwise CLOSED is the correct answer.
  const lastEnd = periods.length ? Math.max(...periods.map(p => p.end.getTime())) : last.t * 1000;
  const beyondMins = Math.ceil((lastEnd - last.t * 1000) / 60e3) + 60;
  for (const mins of [0, 2, 5, 15, 60, 240, beyondMins]) {
    const age = mins * 60e3;
    let d; try { d = P.derive(periods, new Date(last.t * 1000 + age), age); } catch (e) { d = { error: e.message }; }
    R.noNetwork.push({ afterMins: mins, state: d.error ? 'ERR' : d.status,
                       beyondAllPeriods: mins >= beyondMins, error: d.error || null });
  }
  const tail = R.noNetwork[R.noNetwork.length - 1];
  R.summary.periodsInFrozenPayload = periods.length;
  R.summary.stateBeyondAllPeriods = tail.state;
  R.summary.stuckClosedOffline = tail.state === 'CLOSED';
}

fs.writeFileSync(path.join(OUT, 'faults.json'), JSON.stringify(R, null, 1));
console.log('[faults] holdingOpen samples=%d stuckAt300s=%d | skew checks=%d problems=%d | offline 4h -> %s',
  R.summary.holdingOpenSamples, R.summary.heldStillClosedPastTrust,
  R.summary.skewChecks, R.summary.skewProblems, R.summary.stateBeyondAllPeriods);
