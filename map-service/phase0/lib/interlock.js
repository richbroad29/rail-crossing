'use strict';

// The safety interlock.
//
// While a phase-0 connection to NROD is open, watch the crossing service and stop the moment it
// looks disturbed. The crossing service holds the one connection that catches every barrier
// closure (project goal 1); a diagnostic that needed a second connection on the same login must
// never be the reason that one drops.
//
// Layout: everything that DECIDES is a pure function of observations (`preflight`, `decide`,
// `tdDisturbance`, `fallbackWindowProblem`) — no clock, no I/O, no timers — so every rule is
// unit-tested. `createInterlock` is the thin shell that gathers observations (HTTP, stat) on a
// timer and feeds them in.
//
// Principle: FAIL SAFE. Anything the interlock cannot vouch for is treated as a reason not to
// start, or to stop — an unreachable /health, a /health that changed shape, a log it cannot
// read. A false alarm costs one re-run; a missed one costs a barrier closure.
//
// Two signals, in priority order:
//   1. /health `td` block (recent back ends): td.connected, td.staleSecs, td.forcedReconnects.
//   2. The crossing service's LA log growing, for back ends whose /health has no td block. LA is
//      legitimately silent for hours overnight (CLAUDE.md measured 151 and 78 minutes between
//      events), so this fallback is only believable 06:00-23:00 London.
//
// What neither signal can see: a drop that the crossing service recovers from inside one poll
// (its reconnect delay is 2 s; we poll every 15 s) and that is not a watchdog-forced one. That
// is why the scripts also tell the operator which journal lines to check afterwards, and why our
// own connection being dropped by the server is reported separately.

const fs = require('fs');
const path = require('path');
const { fetchHealth } = require('./health');
const { londonParts, londonDateStamp, londonClock } = require('./london');
const { expandHome } = require('./env');

const DEFAULTS = Object.freeze({
  pollMs: 15 * 1000,
  healthTimeoutMs: 5 * 1000,
  // The national feed is never quiet (quietest 5-minute window: 97 messages — about one every
  // three seconds), so a minute of silence is already far outside normal. The crossing service's
  // own watchdog waits five; we stop well before it has to.
  staleSecsLimit: 60,
  unreachableLimit: 3,
  logQuietMs: 15 * 60 * 1000,
  fallbackFromMin: 6 * 60,
  fallbackToMin: 23 * 60,
  // Connect + disconnect + the operator's start-up time, added to the planned run when asking
  // whether it fits the fallback window.
  runMarginMs: 2 * 60 * 1000
});

// Built rather than hand-padded so the box cannot drift out of alignment when the words change.
const LOUD_WARNING = (() => {
  const lines = [
    'THE SAFETY INTERLOCK IS OFF (--no-interlock).',
    'Nothing is watching the crossing service while this runs. If the second',
    'connection disturbs the live feed, this script will NOT notice and will',
    'NOT stop. Only carry on if you are watching the crossing service yourself.'
  ];
  const width = Math.max(...lines.map(l => l.length));
  const bar = '!'.repeat(width + 6);
  return [bar, ...lines.map(l => `!! ${l.padEnd(width)} !!`), bar].join('\n');
})();

const isNum = v => typeof v === 'number' && Number.isFinite(v);

/** The `td` block of a /health body, or null when it is absent (an older back end) or malformed. */
function tdBlock(body) {
  const td = body && body.td;
  return td && typeof td === 'object' && !Array.isArray(td) ? td : null;
}

// ---- pure rules --------------------------------------------------------------------------------

/**
 * The td-block rules that need no baseline: is the crossing service's feed up and fresh right
 * now? Returns the first rule that fires as {rule, message}, or null. Used both at start (to
 * refuse a start while it is already unwell) and on every poll.
 */
function tdDisturbance(td, cfg) {
  if (td.started === false) {
    return { rule: 'td-not-started', message: 'the crossing service says its TD listener is not running (td.started is false)' };
  }
  if (td.connected === false) {
    return { rule: 'td-disconnected', message: 'the crossing service reports its own TD connection is down (td.connected is false)' };
  }
  // A td block without the fields we judge by is a back end we do not understand: stop, don't guess.
  if (td.connected !== true || !isNum(td.staleSecs)) {
    return { rule: 'td-unreadable', message: 'the crossing service\'s /health has a td block without a usable td.connected / td.staleSecs' };
  }
  if (td.staleSecs > cfg.staleSecsLimit) {
    return { rule: 'td-stale', message: `the crossing service has had no TD message for ${td.staleSecs}s (limit ${cfg.staleSecsLimit}s)` };
  }
  return null;
}

/**
 * Is [startMs, startMs + plannedRunMs + margin] entirely inside the hours the log fallback is
 * valid (same London day, 06:00 <= t < 23:00)? Returns null if it fits, else the London clock
 * times for the caller to put in a sentence.
 */
function fallbackWindowProblem(startMs, plannedRunMs, cfg) {
  const endMs = startMs + plannedRunMs + cfg.runMarginMs;
  const s = londonParts(startMs), e = londonParts(endMs);
  const inside = p => p.minutesOfDay >= cfg.fallbackFromMin && p.minutesOfDay < cfg.fallbackToMin;
  if (inside(s) && inside(e) && s.date === e.date) return null;
  return { startClock: londonClock(startMs), endClock: londonClock(endMs) };
}

function logDescription(log) {
  if (!log) return 'no log observation';
  if (log.error) return `the log could not be read (${log.error})`;
  return log.exists ? `size ${log.size}` : 'file does not exist';
}

/**
 * The start-of-run decision. `obs` is one observation (see createInterlock.observe); `plan` has
 * plannedRunMs, healthUrl and tdLogDir (the last two only for the wording of messages).
 * Returns {ok: true, mode, state, note?} or {ok: false, rule, message}. `state` seeds `decide`.
 */
function preflight(obs, cfg, plan = {}) {
  const url = plan.healthUrl || 'the health URL';
  // `short` is one line that stands on its own in the paste-back summary; `message` is the
  // full explanation printed to the terminal and kept in the report's notes.
  const refuse = (rule, short, message) => ({ ok: false, rule, short, message });

  // 1. Cannot see the service at all: nothing to judge disturbance by.
  if (!obs.health || !obs.health.ok) {
    return refuse('health-unreachable', `could not read ${url} (${obs.health ? obs.health.error : 'no answer'}) - is the crossing service running?`, [
      `Could not read the crossing service's health check at ${url} (${obs.health ? obs.health.error : 'no answer'}).`,
      'Without it this script cannot tell whether it is disturbing the live service, so it will not start.',
      `Is the service running?  Try:  curl -s ${url}`,
      'Only if you are sure the service is being watched some other way, add --no-interlock.'
    ].join('\n'));
  }

  const body = obs.health.body;
  const td = tdBlock(body);
  const baseState = {
    unreachable: 0,
    lastUptime: isNum(body.uptime) ? body.uptime : null,
    polls: 1
  };

  // 2. Primary signal.
  if (td) {
    const d = tdDisturbance(td, cfg);
    if (d) {
      return refuse('already-disturbed', `the crossing service already looks unwell before we started: ${d.message}`, [
        `The crossing service already looks unwell before this script has done anything: ${d.message}.`,
        'Not starting, so that nothing here can be blamed for it or make it worse.',
        `Check the service first:  curl -s ${url}`
      ].join('\n'));
    }
    return {
      ok: true,
      mode: 'td',
      state: { ...baseState, mode: 'td', baseline: { forcedReconnects: isNum(td.forcedReconnects) ? td.forcedReconnects : 0 } }
    };
  }

  // 3. Fallback signal: this /health predates the td block.
  const problem = fallbackWindowProblem(obs.at, plan.plannedRunMs || 0, cfg);
  if (problem) {
    return refuse('fallback-window', `this crossing service's /health has no td block, so it can only be watched between 06:00 and 23:00 London; it is ${problem.startClock} and the run would last until about ${problem.endClock}`, [
      'This version of the crossing service has no "td" block in /health, so the only way to watch it',
      'is its LA log — and that log is legitimately silent for hours overnight, so that check is only',
      'valid between 06:00 and 23:00 London time.',
      `It is ${problem.startClock} in London now and this run would last until about ${problem.endClock}.`,
      'Run it inside those hours (use --minutes to make it shorter), or deploy the newer back end,',
      'or add --no-interlock if you are sure.'
    ].join('\n'));
  }
  const log = obs.log;
  if (!log || log.error) {
    return refuse('log-unobservable', `no td block in /health, and the crossing service's TD log cannot be read (${log ? log.error : 'not checked'}) - check --td-log-dir`, [
      'This version of the crossing service has no "td" block in /health, so this script would watch its',
      `TD log instead, but that log cannot be read (${log ? log.error : 'not checked'}). Check --td-log-dir`,
      `(currently ${plan.tdLogDir || 'the default'}) and that you can read it.`
    ].join('\n'));
  }
  if (!log.exists) {
    return refuse('log-missing', `no td block in /health, and today's TD log does not exist (${log.file}) - check --td-log-dir`, [
      'This version of the crossing service has no "td" block in /health, so this script would watch its',
      `TD log instead, but today's file does not exist: ${log.file}`,
      `Check --td-log-dir (currently ${plan.tdLogDir || 'the default'}).`
    ].join('\n'));
  }
  const quietMs = obs.at - log.mtimeMs;
  if (quietMs > cfg.logQuietMs) {
    return refuse('log-not-growing', `no td block in /health, and the LA log last grew ${Math.round(quietMs / 60000)} minutes ago (limit ${Math.round(cfg.logQuietMs / 60000)}) - the service may already have lost its feed`, [
      `The crossing service's LA log (${log.file}) last grew ${Math.round(quietMs / 60000)} minutes ago`,
      `(limit ${Math.round(cfg.logQuietMs / 60000)}). The service may already have lost its feed, so this script will not start.`,
      `Check it first:  curl -s ${url}`
    ].join('\n'));
  }
  return {
    ok: true,
    mode: 'log',
    note: 'This crossing service has no td block in /health; watching its LA log instead (trouble is noticed only after 15 minutes).',
    state: { ...baseState, mode: 'log', baseline: { forcedReconnects: 0 }, log: { lastSize: log.size, lastGrowthAt: log.mtimeMs } }
  };
}

/**
 * One poll's decision. Pure: (state, observation) -> {state, verdict}. `state` comes from
 * `preflight().state` and is never mutated. A verdict is {disturbed: false[, note]} or
 * {disturbed: true, rule, message}; the rule names are what the tests and the report key on.
 */
function decide(state, obs, cfg = DEFAULTS) {
  const next = { ...state, polls: state.polls + 1 };
  const trip = (rule, message) => ({ state: next, verdict: { disturbed: true, rule, message } });

  // --- can we see it? Tolerate a stumble, not a pattern.
  const h = obs.health;
  if (!h || !h.ok) {
    next.unreachable = state.unreachable + 1;
    const why = h ? h.error : 'no answer';
    if (next.unreachable >= cfg.unreachableLimit) {
      return trip('health-unreachable',
        `the crossing service's /health did not answer ${next.unreachable} times running (last: ${why})`);
    }
    return { state: next, verdict: { disturbed: false, note: `health check failed (${next.unreachable} of ${cfg.unreachableLimit} allowed in a row): ${why}` } };
  }
  next.unreachable = 0;
  const body = h.body;

  // --- a restart is its own event: the counters below reset with it, so "forcedReconnects
  // increased" could not see trouble in the new process. Stop rather than guess.
  if (isNum(body.uptime)) {
    if (isNum(state.lastUptime) && body.uptime + 1 < state.lastUptime) {
      return trip('service-restarted',
        `the crossing service restarted during the run (uptime fell from ${Math.round(state.lastUptime)}s to ${Math.round(body.uptime)}s)`);
    }
    next.lastUptime = body.uptime;
  }

  if (state.mode === 'td') {
    const td = tdBlock(body);
    if (!td) {
      return trip('td-block-missing', 'the crossing service\'s /health no longer has a td block (it may have been redeployed)');
    }
    const d = tdDisturbance(td, cfg);
    if (d) return trip(d.rule, d.message);
    if (isNum(td.forcedReconnects)) {
      const base = state.baseline.forcedReconnects;
      if (td.forcedReconnects > base) {
        return trip('td-forced-reconnect',
          `the crossing service's watchdog forced a reconnect (td.forcedReconnects went from ${base} to ${td.forcedReconnects})`);
      }
      if (td.forcedReconnects < base) {
        return trip('service-restarted',
          `the crossing service's td.forcedReconnects went DOWN (${base} to ${td.forcedReconnects}), which means it restarted`);
      }
    }
    return { state: next, verdict: { disturbed: false } };
  }

  if (state.mode === 'log') {
    const problem = fallbackWindowProblem(obs.at, 0, { ...cfg, runMarginMs: 0 });
    if (problem) {
      return trip('fallback-window-ended',
        `it is now ${problem.startClock} in London, outside the 06:00-23:00 hours in which the LA log can be trusted; stopping rather than running unwatched`);
    }
    const log = obs.log;
    if (!log || log.error) {
      return trip('log-unobservable', `the crossing service's LA log cannot be read (${log ? log.error : 'not checked'})`);
    }
    const prev = state.log;
    const grew = log.exists && log.size > prev.lastSize;
    next.log = {
      lastSize: log.exists ? log.size : prev.lastSize,
      lastGrowthAt: grew ? obs.at : prev.lastGrowthAt
    };
    const quietMs = obs.at - next.log.lastGrowthAt;
    if (quietMs > cfg.logQuietMs) {
      return trip('log-silent',
        `the crossing service's LA log has not grown for ${Math.round(quietMs / 60000)} minutes (limit ${Math.round(cfg.logQuietMs / 60000)}; ${logDescription(log)})`);
    }
    return { state: next, verdict: { disturbed: false } };
  }

  // A state that did not come from preflight(): nothing here can vouch for the service.
  return trip('interlock-error', `unknown interlock mode ${JSON.stringify(state.mode)}`);
}

/** A small, report-safe description of what one observation showed. */
function summariseObs(obs) {
  if (!obs || !obs.health) return null;
  const out = { at: new Date(obs.at).toISOString() };
  if (!obs.health.ok) return { ...out, reachable: false, error: obs.health.error };
  const b = obs.health.body, td = tdBlock(b);
  out.reachable = true;
  out.status = b.status === undefined ? null : b.status;
  out.uptimeSecs = isNum(b.uptime) ? Math.round(b.uptime) : null;
  out.memory = b.memory === undefined ? null : b.memory;
  out.td = td ? {
    started: td.started, connected: td.connected, staleSecs: td.staleSecs,
    forcedReconnects: td.forcedReconnects, messagesReceived: td.messagesReceived
  } : null;
  if (obs.log) out.log = obs.log;
  return out;
}

// ---- the shell ---------------------------------------------------------------------------------

async function defaultStatFile(file) {
  try {
    const st = await fs.promises.stat(file);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * @param {object} o
 * @param {string}  [o.healthUrl]  default http://127.0.0.1:3000/health
 * @param {string}  [o.tdLogDir]   default ~/rail-crossing/backend/data/logs/td
 * @param {boolean} [o.disabled]   --no-interlock
 * @param {object}  [o.config]     overrides for DEFAULTS (tests)
 * @param {function} [o.onTrip]    called once, with the verdict, the moment a rule fires
 * @param {function} [o.log]       one-line messages for the operator
 * @param {object}  [o.deps]       fetchHealth, statFile, now, setTimer, clearTimer, sleep (tests)
 */
function createInterlock(o = {}) {
  const healthUrl = o.healthUrl || 'http://127.0.0.1:3000/health';
  const tdLogDir = expandHome(o.tdLogDir || '~/rail-crossing/backend/data/logs/td');
  const disabled = !!o.disabled;
  const cfg = { ...DEFAULTS, ...(o.config || {}) };
  const log = o.log || (() => {});
  const deps = o.deps || {};
  const d = {
    fetchHealth: deps.fetchHealth || fetchHealth,
    statFile: deps.statFile || defaultStatFile,
    now: deps.now || Date.now,
    setTimer: deps.setTimer || setTimeout,
    clearTimer: deps.clearTimer || clearTimeout,
    sleep: deps.sleep || (ms => new Promise(r => setTimeout(r, ms)))
  };

  let state = null, mode = disabled ? 'off' : null;
  let timer = null, started = false, stopped = false, tripped = null;
  let firstObs = null, lastObs = null, lastPollAt = null;
  const stats = { polls: 0, failedPolls: 0, maxGapMs: 0 };
  let resolveTripped;
  const whenTripped = new Promise(res => { resolveTripped = res; });

  async function observe() {
    let h;
    try { h = await d.fetchHealth(healthUrl, { timeoutMs: cfg.healthTimeoutMs }); }
    catch (e) { h = { ok: false, error: (e && (e.code || e.message)) || String(e) }; }
    const at = d.now();
    const obs = { at, health: h && h.ok ? { ok: true, body: h.body } : { ok: false, error: h ? h.error : 'no answer' } };
    // The log is only consulted when /health has no td block (or we already chose that mode).
    if (obs.health.ok && (mode === 'log' || !tdBlock(obs.health.body))) {
      const file = path.join(tdLogDir, `td-${londonDateStamp(at)}.jsonl`);
      try {
        const st = await d.statFile(file);
        obs.log = st ? { file, exists: true, size: st.size, mtimeMs: st.mtimeMs } : { file, exists: false };
      } catch (e) {
        obs.log = { file, error: e.code || e.message };
      }
    }
    return obs;
  }

  async function preflightCheck({ plannedRunMs = 0 } = {}) {
    if (disabled) return { ok: true, mode: 'off', disabled: true, message: LOUD_WARNING };
    const obs = await observe();
    firstObs = lastObs = obs;
    lastPollAt = obs.at;
    stats.polls = 1;
    if (!obs.health.ok) stats.failedPolls++;
    const r = preflight(obs, cfg, { plannedRunMs, healthUrl, tdLogDir });
    if (!r.ok) return r;
    state = r.state;
    mode = r.mode;
    return { ok: true, mode: r.mode, note: r.note || null, baseline: summariseObs(obs) };
  }

  function trip(verdict, obs) {
    stopped = true;
    tripped = { rule: verdict.rule, message: verdict.message, at: new Date(obs.at).toISOString(), observation: summariseObs(obs) };
    resolveTripped(tripped);
    try { if (o.onTrip) o.onTrip(tripped); } catch (_) { /* the abort path must not be able to throw back into the poller */ }
  }

  async function tick() {
    timer = null;
    if (stopped) return;
    const obs = await observe();
    if (stopped) return;
    stats.polls++;
    if (lastPollAt !== null) stats.maxGapMs = Math.max(stats.maxGapMs, obs.at - lastPollAt);
    lastPollAt = obs.at;
    lastObs = obs;
    if (!obs.health.ok) stats.failedPolls++;
    const r = decide(state, obs, cfg);
    state = r.state;
    if (r.verdict.note) log(`interlock: ${r.verdict.note}`);
    if (r.verdict.disturbed) return trip(r.verdict, obs);
    schedule();
  }

  // If the poller itself breaks, that is a reason to stop, not to carry on unwatched.
  function failClosed(e) {
    if (stopped) return;
    trip({ rule: 'interlock-error', message: `the interlock itself failed (${e && e.message})` },
      { at: d.now(), health: { ok: false, error: e && e.message } });
  }

  function schedule() {
    // Returning the promise changes nothing for a real timer and lets a test await one poll.
    timer = d.setTimer(() => tick().catch(failClosed), cfg.pollMs);
    // A poll timer must never be the thing that keeps the process alive.
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function summary() {
    return {
      enabled: !disabled,
      mode,
      pollIntervalSecs: cfg.pollMs / 1000,
      polls: stats.polls,
      failedPolls: stats.failedPolls,
      maxGapSecs: Math.round(stats.maxGapMs / 100) / 10,
      tripped,
      first: summariseObs(firstObs),
      last: summariseObs(lastObs)
    };
  }

  // Plain closures, no `this`: callers pass these around (e.g. as event handlers).
  return {
    mode: () => mode,
    /** Resolves (never rejects) with the verdict when a rule fires; stays pending otherwise. */
    whenTripped,
    getTripped: () => tripped,
    preflight: preflightCheck,
    start() {
      if (disabled || !state || started) return;
      started = true;
      schedule();
    },
    stop() {
      stopped = true;
      if (timer) { d.clearTimer(timer); timer = null; }
      return summary();
    },
    /**
     * One more look after our connection has closed: did the crossing service survive our leaving?
     * Strict — a single failed fetch counts. Returns null if there is nothing to compare with.
     */
    async settleCheck({ settleMs = 3000 } = {}) {
      if (disabled || !state) return null;
      if (settleMs > 0) await d.sleep(settleMs);
      const obs = await observe();
      const r = decide(state, obs, { ...cfg, unreachableLimit: 1 });
      lastObs = obs;
      return {
        disturbed: r.verdict.disturbed,
        rule: r.verdict.rule || null,
        message: r.verdict.message || null,
        observation: summariseObs(obs)
      };
    },
    summary
  };
}

module.exports = {
  DEFAULTS, LOUD_WARNING,
  preflight, decide, tdDisturbance, fallbackWindowProblem, tdBlock, summariseObs,
  createInterlock
};
