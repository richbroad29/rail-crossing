#!/usr/bin/env node
'use strict';

// td-measure — phase 0, questions 1 and 2.
//   1. Does a SECOND NROD connection on the crossing service's login work, without disturbing the
//      connection the crossing service already holds?
//   2. What does the national TD feed cost to process — messages and events per second, per area,
//      peaks, CPU, memory — and would a map service fit on this VPS next to the crossing service?
//
// It only listens. It writes nothing except its report, and the whole time it is connected it
// watches the crossing service (lib/interlock.js) and disconnects at once if that looks disturbed.

const { monitorEventLoopDelay } = require('perf_hooks');
const { loadEnvFile, feedCredentials, secretsFor } = require('../lib/env');
const { Report } = require('../lib/report');
const stomp = require('../lib/stomp');
const { createInterlock, LOUD_WARNING } = require('../lib/interlock');
const { fetchHealth } = require('../lib/health');
const { StopController, holdTopic } = require('../lib/hold');
const { TdStats, growthSummary } = require('../lib/td-stats');
const { ResourceSampler } = require('../lib/sampler');
const { memoryFit } = require('../lib/memory-fit');
const { machineFacts } = require('../lib/machine');
const { overlapsDailyReload, utcStamp } = require('../lib/london');
const { round1, clock, interlockCheck, afterRunAdvice } = require('../lib/verdicts');
const cli = require('../lib/cli');

const TOPIC = '/topic/TD_ALL_SIG_AREA';
const FIRST_MESSAGE_LIMIT_MS = 60 * 1000;
// The crossing service's own watchdog treats five minutes of silence as a dead feed
// (td-listener.js STALE_MS); the national feed's quietest five-minute window held 97 messages.
const SILENCE_MS = 5 * 60 * 1000;
const SAMPLE_MS = 10 * 1000;
const PROGRESS_MS = 5 * 60 * 1000;
const ELD_RESOLUTION_MS = 20;

const HELP = `td-measure - what does the national TD feed cost, and does a second NROD connection work?

Opens a SECOND connection to Network Rail's open data feed, using the crossing service's login,
subscribes to the whole national train describer feed (TD_ALL_SIG_AREA) and measures it for a
while: messages and events per second, per area and at the peak, CPU, memory, and whether the
crossing service's own connection stays healthy while this one is open. It only listens, and it
writes nothing except its report.

Run it exactly like this, so it cannot starve the crossing service of CPU or memory:

  cd ~/rail-crossing/map-service/phase0
  nice -n 19 node --max-old-space-size=256 bin/td-measure.js

Options
  --minutes N        how long to measure, 1 to 240 (default 60)
  --env FILE         the crossing service's .env file, for the NROD login
                     (default ~/rail-crossing/backend/.env)
  --health-url URL   the crossing service's health check
                     (default http://127.0.0.1:3000/health)
  --td-log-dir DIR   the crossing service's TD log folder; only used if its /health has no "td"
                     block (default ~/rail-crossing/backend/data/logs/td)
  --out DIR          where the report goes (default: the "out" folder beside bin/)
  --no-interlock     DANGEROUS. Do not watch the crossing service. Only if you are watching it
                     yourself.
  --debug            show technical detail if something goes wrong
  --help             this text

For testing against a fake server (not for real runs):
  --stomp-host HOST  --stomp-port PORT

The safety check: every 15 seconds this reads the crossing service's health check, and it
disconnects at once, writes the report and exits with an error if the crossing service's own feed
connection is down, has been silent for over a minute, has been forced to reconnect, or the health
check stops answering. If it cannot see the crossing service at all it will not start.

Good to know
  - Avoid a run that spans 04:00 London: that is when the crossing service reloads its timetable,
    and it may briefly stop answering.
  - Ctrl-C stops it cleanly (it disconnects and still writes the report). So does closing the
    terminal. For a long run use tmux or screen, or start it with nohup.
  - Afterwards it prints one command to run on the VPS to double-check the crossing service's
    own log.
`;

function parseCli(argv) {
  const values = cli.parseOptions(argv, { minutes: { type: 'string' } });
  if (values.help) return { help: true };
  const common = cli.resolveCommon(values);
  return { help: false, options: { ...common, minutes: cli.intOption('minutes', values.minutes, { min: 1, max: 240, def: 60 }) } };
}

// ---- verdicts (pure) ---------------------------------------------------------------------------

function describeClose(outcome, ctx) {
  const err = outcome.detail && outcome.detail.error;
  return err && err.info ? stomp.explain(err.info, ctx) : 'NROD or the network closed it';
}

function secondConnection(r) {
  const { connectError, outcome, interlock, settle } = r;
  const tripped = interlock.tripped;
  const first = outcome ? outcome.firstFrameAfterMs : null;
  const data = {
    connectMs: r.connectMs,
    firstMessageAfterSecs: first === null || first === undefined ? null : round1(first / 1000),
    frames: outcome ? outcome.frames : 0,
    endedBy: outcome ? outcome.endedBy : null,
    ranSecs: round1(r.ranMs / 1000),
    plannedSecs: round1(r.plannedMs / 1000),
    closeHow: outcome && outcome.close ? outcome.close.how : null,
    interlockTripped: tripped ? tripped.rule : null,
    connectError: connectError ? connectError.info : null
  };
  const out = (status, message) => ({ id: 'SECOND_CONNECTION', status, message, data });
  const ran = cli.fmtDuration(r.ranMs);

  if (connectError) {
    const info = connectError.info;
    if (info.kind === 'aborted') {
      return tripped
        ? out('FAIL', `stopped while still connecting: the crossing service looked disturbed (${tripped.rule}) - ${tripped.message}`)
        : out('WARN', 'stopped (by you) before the connection was ready, so nothing can be concluded');
    }
    return out('FAIL', `could not open the second connection: ${stomp.explain(info, r.ctx)}`);
  }
  if (tripped) {
    return out('FAIL', `the crossing service looked disturbed at ${clock(tripped.at)} (${tripped.rule}): ${tripped.message}. This connection was closed at once.`);
  }
  if (first === null || first > FIRST_MESSAGE_LIMIT_MS) {
    // Being dropped (or refused the subscription) before any message is a definite failure...
    if (outcome.endedBy === 'closed') {
      return out('FAIL', `connected, but the connection was dropped before any TD message arrived: ${describeClose(outcome, r.ctx)}`);
    }
    // ...but "nothing within 60 s" can only be claimed if we actually waited 60 s.
    if (first === null && r.ranMs < FIRST_MESSAGE_LIMIT_MS) {
      return out('WARN', `ended after ${ran}, inside the 60 s allowed for the first message, so nothing can be concluded`);
    }
    return out('FAIL', first === null
      ? 'connected and subscribed, but no TD message arrived within 60 s. The national feed is never quiet, so the subscription is not delivering'
      : `connected, but the first TD message took ${round1(first / 1000)} s (limit 60 s)`);
  }
  switch (outcome.endedBy) {
    case 'closed':
      return out('WARN', `connected and receiving (first message after ${round1(first / 1000)} s), but the connection was dropped after ${ran}: ${describeClose(outcome, r.ctx)}`);
    case 'silent':
      return out('WARN', `connected and receiving, but then no message arrived for ${cli.fmtDuration(SILENCE_MS)} (after ${ran}), so the run was stopped`);
    case 'guard':
      return out('WARN', `stopped early after ${ran} by the ${outcome.detail.rule} guard (${outcome.detail.message}); the connection itself was fine`);
    case 'signal':
      return out('WARN', `stopped early (${outcome.detail.name}) after ${ran} of ${cli.fmtDuration(r.plannedMs)}; the connection was fine up to then`);
    case 'error':
      return out('WARN', `stopped early after ${ran} by an internal error (${outcome.detail && outcome.detail.message})`);
    default:
  }
  if (!interlock.enabled) {
    return out('WARN', `connected in ${r.connectMs} ms and received data, BUT the crossing service was not watched (--no-interlock), so "without disturbing it" is unverified`);
  }
  if (settle && settle.disturbed) {
    return out('WARN', `connected and clean for ${ran}, but after we disconnected the crossing service looked disturbed (${settle.rule}): ${settle.message}. Check it`);
  }
  return out('PASS', `connected in ${r.connectMs} ms, first TD message after ${round1(first / 1000)} s, ${outcome.frames} messages over ${ran}, and the crossing service was undisturbed (${interlock.polls} health checks, none tripped)`);
}

function tdVolume(r) {
  const t = r.tdSummary;
  if (!t || t.frames === 0) return { id: 'TD_VOLUME', status: 'WARN', message: 'no TD messages were received, so there is nothing to measure', data: null };
  // A run can receive frames that carry no events (or none it could parse); the peaks are then
  // empty rather than missing, and the verdict must say 0, not throw.
  const peak = t.peakBucket || { eventsPerSec: 0, startedAt: null };
  const busiest = t.peakSecond ? t.peakSecond.events : 0;
  const cpu = r.mem && r.mem.cpu ? `, CPU ${r.mem.cpu.percentOfOneCoreMean}% of one core` : '';
  return {
    id: 'TD_VOLUME', status: 'INFO',
    message: `${t.rates.eventsPerSecMean} events/s mean (${t.rates.framesPerSecMean} messages/s), peak minute ${peak.eventsPerSec}/s at ${clock(peak.startedAt)}, busiest second ${busiest}; ${t.areas} areas, ${t.distinctDescriptions} distinct descriptions; ${t.rates.bodyMBPerHour} MB/h of message bodies${cpu}`,
    data: { rates: t.rates, peakBucket: peak, peakSecond: t.peakSecond, areas: t.areas, cclassEvents: t.cclassEvents }
  };
}

function memoryCheck(r) {
  const t = r.tdSummary;
  if (!t || t.frames === 0) return { id: 'MEMORY_FIT', status: 'WARN', message: 'not measured: no TD data arrived, so there was no state to size', data: null };
  const fit = memoryFit({ availableMB: r.mem.availableForVerdictMB, projectedMB: r.mem.peakRssMB, minutes: r.ranMs / 60000 });
  let message = fit.message;
  if (r.growth && r.growth.enough && r.growth.stillGrowing) {
    message += ` (the berth graph was still growing at the end: +${r.growth.lastThirdGrowthPct}% over the final third, so treat the peak as a floor)`;
  }
  if (r.outcome && r.outcome.endedBy === 'guard') message += ` (the run was stopped early by the ${r.outcome.detail.rule} guard)`;
  return { id: 'MEMORY_FIT', status: fit.status, message, data: { ...fit.data, growth: r.growth } };
}

/** All four checks from what the run observed. Pure, so every path is tested without a socket. */
function buildChecks(r) {
  return [secondConnection(r), interlockCheck(r), tdVolume(r), memoryCheck(r)];
}

// ---- the run -----------------------------------------------------------------------------------

function eventLoopLag(eld) {
  // The histogram records each sampling interval, so an idle loop reads about `resolution`; lag is
  // what is left after subtracting it. (Never reset() mid-run: it also forgets the previous tick
  // and drops the next sample, which is exactly the one that would have shown a stall.)
  const lag = ns => Math.max(0, Math.round((ns / 1e6 - ELD_RESOLUTION_MS) * 10) / 10);
  return { resolutionMs: ELD_RESOLUTION_MS, observations: eld.count === undefined ? null : eld.count, meanMs: lag(eld.mean), p50Ms: lag(eld.percentile(50)), p99Ms: lag(eld.percentile(99)), maxMs: lag(eld.max) };
}

/**
 * @param {object} opts   the parsed, validated options (see parseCli)
 * @param {object} [deps] test seams: now, stdout, stderr, signals, connect, connectTimeoutMs, fetchHealth,
 *                        statFile, meminfo, sampleMs, progressMs, bucketMs, settleMs, durationMs,
 *                        interlockConfig, forceExit
 * @returns {Promise<number>} the process exit code
 */
async function run(opts, deps = {}) {
  const d = {
    now: Date.now, stdout: process.stdout, stderr: process.stderr, signals: process,
    connect: undefined, connectTimeoutMs: undefined, fetchHealth: undefined, statFile: undefined, meminfo: undefined,
    sampleMs: SAMPLE_MS, progressMs: PROGRESS_MS, bucketMs: 60 * 1000, settleMs: 3000, durationMs: undefined,
    interlockConfig: undefined, forceExit: code => process.exit(code),
    ...deps
  };

  let creds;
  try { creds = feedCredentials(loadEnvFile(opts.envFile), opts.envFile); }
  catch (e) { d.stderr.write(`${cli.friendlyError(e, { debug: opts.debug })}\n`); return 2; }
  // Before anything is opened: a report that cannot be written is worth learning about now, not
  // after an hour.
  try { cli.ensureOutDir(opts.outDir); }
  catch (e) { d.stderr.write(`${cli.friendlyError(e, { debug: opts.debug })}\n`); return 2; }
  const secrets = secretsFor(creds);
  const say = cli.makeSay(d.stdout, secrets, d.now);
  const write = cli.makeWrite(d.stdout, secrets);
  const safeOut = { write: s => { try { d.stdout.write(s); } catch (_) { /* terminal gone; the files are written first */ } } };
  const report = new Report('td-measure', { outDir: opts.outDir, secrets, now: () => new Date(d.now()) });
  const ctx = { host: opts.stomp.host, port: opts.stomp.port, envFile: opts.envFile };

  const plannedMs = d.durationMs !== undefined ? d.durationMs : opts.minutes * 60000;
  const runStartedAt = d.now();
  write(`td-measure: measuring the national TD feed for ${cli.fmtDuration(plannedMs)} on a second NROD connection.`);
  write(`Report folder: ${opts.outDir}`);

  const finish = () => {
    try { return report.finish(safeOut); }
    catch (e) {
      write(report.summaryText());
      write(`Could not write the report files to ${opts.outDir} (${e.code || e.message}). The summary above is the result: copy it from the terminal.`);
      return Math.max(1, report.exitCode);
    }
  };

  // ---- machine facts, first, so every number after them can be read against the hardware ----------
  const healthFetch = d.fetchHealth || fetchHealth;
  const h0 = await healthFetch(opts.healthUrl, { timeoutMs: 5000 }).catch(() => null);
  report.fact('machine', machineFacts({ health: h0 && h0.ok ? h0.body : null }));
  report.fact('run', { script: 'td-measure', plannedSecs: plannedMs / 1000, startedAt: new Date(runStartedAt).toISOString(), topic: TOPIC, overlapsDailyReload: overlapsDailyReload(runStartedAt, runStartedAt + plannedMs) });

  // ---- the interlock: refuse to start unless the crossing service can be watched ------------------
  const stop = new StopController();
  const interlock = createInterlock({
    healthUrl: opts.healthUrl, tdLogDir: opts.tdLogDir, disabled: !opts.interlock, config: d.interlockConfig, log: say,
    deps: { fetchHealth: d.fetchHealth, statFile: d.statFile, now: d.now },
    onTrip: v => { say(`INTERLOCK TRIPPED - stopping now: ${v.message}`); stop.request({ type: 'interlock', verdict: v }); }
  });
  const pre = await interlock.preflight({ plannedRunMs: plannedMs });
  if (!pre.ok) {
    write(`\nNOT STARTING.\n\n${pre.message}\n`);
    report.check('INTERLOCK', 'FAIL', `refused to start: ${pre.short}`, { rule: pre.rule });
    report.note(pre.message);
    return finish();
  }
  if (pre.disabled) { write(`\n${LOUD_WARNING}\n`); report.note(LOUD_WARNING); }
  else if (pre.note) { say(pre.note); report.note(pre.note); }
  if (report.facts.run.overlapsDailyReload) {
    say('note: this run overlaps the crossing service\'s 04:00 timetable reload; it may briefly stop answering, and the interlock may stop the run');
  }

  // ---- signals: Ctrl-C, kill, and an SSH drop all stop cleanly -------------------------------------
  let signals = 0;
  const unwatch = cli.watchSignals(d.signals, name => {
    signals++;
    if (signals === 1) {
      say(`${name} received - stopping cleanly and writing the report (send it again to quit at once)`);
      stop.request({ type: 'signal', name });
    } else {
      say(`${name} again - quitting at once`);
      stomp.killActive();
      d.forceExit(130);
    }
  });

  // ---- connect, then hold ----------------------------------------------------------------------------
  const sampler = new ResourceSampler({ now: d.now, meminfo: d.meminfo });
  sampler.begin();
  interlock.start();
  let session = null, connectError = null, outcome = null, stats = null, eld = null;
  const connectStarted = d.now();
  try {
    session = await stomp.openSession({ creds, host: opts.stomp.host, port: opts.stomp.port, connect: d.connect, connectTimeoutMs: d.connectTimeoutMs, cancel: stop.promise, secrets });
  } catch (e) { connectError = e; }
  const connectMs = d.now() - connectStarted;

  if (session) {
    say(`connected to NROD in ${connectMs} ms (client-id ${session.clientId}); subscribing to ${TOPIC}`);
    report.fact('connection', { host: session.host, port: session.port, clientId: session.clientId, connectMs, heartbeat: stomp.HEARTBEAT });
    stats = new TdStats({ startMs: d.now(), bucketMs: d.bucketMs });
    eld = monitorEventLoopDelay({ resolution: ELD_RESOLUTION_MS });
    eld.enable();
    let lastProgress = d.now();
    outcome = await holdTopic({
      session, topic: TOPIC, durationMs: plannedMs, stop, silenceMs: SILENCE_MS, now: d.now,
      onBody: (body, headers, at) => stats.ingest(body, at),
      tick: {
        everyMs: d.sampleMs,
        fn: ctl => {
          const s = sampler.sample();
          const g = sampler.guard(s);
          if (g) { say(`GUARD ${g.rule} - stopping now: ${g.message}`); ctl.stop('guard', g); return; }
          if (d.now() - lastProgress >= d.progressMs) {
            lastProgress = d.now();
            const il = interlock.summary();
            say(`${cli.fmtDuration(d.now() - runStartedAt)} of ${cli.fmtDuration(plannedMs)}: ${stats.frames} messages, ${stats.events} events, RSS ${s.rssMB} MB, free ${s.memAvailableMB === null ? '?' : `${s.memAvailableMB} MB`}; crossing service watched (${il.polls} checks, ${il.failedPolls} failed)`);
          }
        }
      }
    });
    if (outcome.endedBy === 'closed' || outcome.endedBy === 'silent') say(`run ended early: ${outcome.endedBy}`);
  } else {
    say(`could not connect: ${connectError.message}`);
  }

  // ---- tear down, and look at the crossing service once more after we have gone ----------------------
  const endedAt = outcome ? outcome.endedAt : d.now();
  if (eld) eld.disable();
  if (stats) sampler.sample();    // the final state is usually the biggest; do not miss it
  const interlockSummary = interlock.stop();
  unwatch();
  const settle = await interlock.settleCheck({ settleMs: d.settleMs });

  // ---- facts, verdicts, report -------------------------------------------------------------------------
  // The window that was actually MEASURED — subscribe to end — not the whole run, which also holds
  // the preflight and the connect. This is what "over 1h 00m" and the memory verdict's minutes mean.
  const ranMs = outcome && outcome.subscribedAt !== null ? endedAt - outcome.subscribedAt : 0;
  const tdSummary = stats ? stats.summary(endedAt) : null;
  const series = stats ? stats.series(endedAt) : [];
  const growth = stats ? growthSummary(series) : null;
  const mem = sampler.summary(endedAt);

  if (tdSummary) {
    report.fact('td', tdSummary);
    report.fact('tdPerBucket', series);
    report.fact('state', { ...tdSummary.state, growth });
    report.fact('eventLoopLag', eventLoopLag(eld));
  }
  report.fact('memory', { ...mem, series: sampler.series() });
  report.fact('interlock', { ...interlockSummary, afterWeLeft: settle });
  if (tdSummary && tdSummary.frames) {
    report.fact('eventsPerSecMean', tdSummary.rates.eventsPerSecMean, { summary: true });
    report.fact('eventsPerSecPeakMinute', tdSummary.peakBucket ? tdSummary.peakBucket.eventsPerSec : 0, { summary: true });
    report.fact('areas', tdSummary.areas, { summary: true });
    report.fact('peakRssMB', mem.peakRssMB, { summary: true });
    report.fact('memAvailableMB', mem.availableForVerdictMB, { summary: true });
    report.fact('cpuPercent', mem.cpu.percentOfOneCoreMean, { summary: true });
  }
  for (const c of buildChecks({ connectError, outcome, connectMs, ranMs, plannedMs, interlock: interlockSummary, settle, tdSummary, growth, mem, ctx })) {
    report.check(c.id, c.status, c.message, c.data);
  }
  report.note(`This run: ${utcStamp(runStartedAt)} to ${utcStamp(endedAt)} (measured for ${cli.fmtDuration(ranMs)}).`);
  report.note('Peak RSS is a floor for the map service, not a ceiling: the real service adds its HTTP server, SMART/CORPUS tables and per-client state on top of this state.');
  report.note('"Available memory" used for MEMORY_FIT is the lowest of MemAvailable at the start and (MemAvailable + this process\'s RSS) at every sample: the least room a map service would have had.');
  const journal = cli.journalCheckLines(runStartedAt, endedAt);
  for (const line of journal) report.note(line);

  for (const line of afterRunAdvice({ tripped: interlockSummary.tripped, settle, healthUrl: opts.healthUrl })) write(line);
  const code = finish();
  write('');
  for (const line of journal) write(line);
  return code;
}

// ---- process entry -------------------------------------------------------------------------------

async function main(argv = process.argv.slice(2)) {
  let parsed;
  try { parsed = parseCli(argv); }
  catch (e) { process.stderr.write(`${cli.friendlyError(e)}\n`); return 2; }
  if (parsed.help) { process.stdout.write(HELP); return 0; }
  // A closed terminal must not be able to crash a run that is mid-measurement.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  process.on('uncaughtException', err => {
    try { stomp.killActive(); } catch (_) { /* nothing open */ }
    process.stderr.write(`${cli.friendlyError(err, { debug: parsed.options.debug })}\n`);
    process.exit(1);
  });
  try { return await run(parsed.options); }
  catch (e) {
    try { stomp.killActive(); } catch (_) { /* nothing open */ }
    process.stderr.write(`${cli.friendlyError(e, { debug: parsed.options.debug })}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then(code => {
    process.exitCode = code;
    // Whatever happens, do not leave a measurement process lingering on the live server.
    setTimeout(() => process.exit(code), 5000).unref();
  });
}

module.exports = { main, run, parseCli, buildChecks, HELP, TOPIC, FIRST_MESSAGE_LIMIT_MS, SILENCE_MS };
