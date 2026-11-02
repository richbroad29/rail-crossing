#!/usr/bin/env node
'use strict';

// feeds-check — phase 0, question 3: once the TRUST and VSTP feeds are switched on in the NROD
// portal, do they deliver, and do their messages carry the fields the map plans to use?
//
// One connection per topic, one after the other, each under the safety interlock. The TRUST and
// VSTP message shapes are from documentation, not from the feed, so this reports what it actually
// sees (presence rates, the keys really present, one example per type) and never fails on a field
// being absent.

const { loadEnvFile, feedCredentials, secretsFor } = require('../lib/env');
const stomp = require('../lib/stomp');
const { createInterlock, LOUD_WARNING } = require('../lib/interlock');
const { fetchHealth } = require('../lib/health');
const { StopController, holdTopic } = require('../lib/hold');
const { FeedAnalyser } = require('../lib/feed-fields');
const { JsonOnlyReport } = require('../lib/json-only-report');
const { utcStamp } = require('../lib/london');
const { round1, interlockCheck, afterRunAdvice } = require('../lib/verdicts');
const cli = require('../lib/cli');

const TOPICS = Object.freeze({
  trust: Object.freeze({
    key: 'trust', id: 'TRUST_FEED', label: 'TRUST', destination: '/topic/TRAIN_MVT_ALL_TOC', what: 'train movements',
    flag: '--trust-minutes', suggest: 10, mainType: '0003', sparse: false
  }),
  vstp: Object.freeze({
    key: 'vstp', id: 'VSTP_FEED', label: 'VSTP', destination: '/topic/VSTP_ALL', what: 'short-notice schedule changes',
    flag: '--vstp-minutes', suggest: 60, mainType: 'VSTPCIFMsgV1:Create', sparse: true
  })
});

const HELP = `feeds-check - are the TRUST and VSTP feeds switched on, and do their messages carry what the map needs?

Run this AFTER switching the TRUST and VSTP feeds on for your account in the NROD portal. It opens
one connection at a time, using the crossing service's login, and subscribes to
  TRUST  /topic/TRAIN_MVT_ALL_TOC   train movements
  VSTP   /topic/VSTP_ALL            short-notice schedule changes (sparse: expect few messages)
For each it reports whether the subscription was accepted, whether messages arrived, how many of
each type, and how many carry the fields the map plans to use. It only listens, and it writes
nothing except its report.

  cd ~/rail-map/map-service/phase0
  nice -n 19 node bin/feeds-check.js

Options
  --trust-minutes N  how long to listen to TRUST, 1 to 240 (default 3)
  --vstp-minutes N   how long to listen to VSTP, 1 to 240 (default 10)
  --only trust|vstp  check just one of them
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

For testing against a fake server on this machine (not for real runs):
  --stomp-host HOST  --stomp-port PORT
                     HOST may only be localhost, 127.0.0.1, ::1 or publicdatafeeds.networkrail.co.uk:
                     the NROD login is never sent anywhere else.

What the verdicts mean
  PASS  subscribed, and messages arrived
  WARN  subscribed with no error, but no messages in the window: inconclusive, so try a longer one
  FAIL  not allowed to read the feed (it says how to fix that), or the connection failed

The safety check: while connected, every 15 seconds this reads the crossing service's health
check, and it disconnects at once, writes the report and exits with an error if the crossing
service's own feed connection looks disturbed. If it cannot see the crossing service it will not
start. Ctrl-C (or closing the terminal) stops cleanly and still writes the report.
`;

function parseCli(argv) {
  const values = cli.parseOptions(argv, {
    'trust-minutes': { type: 'string' },
    'vstp-minutes': { type: 'string' },
    only: { type: 'string' }
  });
  if (values.help) return { help: true };
  const common = cli.resolveCommon(values);
  if (values.only !== undefined && values.only !== 'trust' && values.only !== 'vstp') {
    throw new cli.UsageError(`--only must be "trust" or "vstp" (you gave "${values.only}").`);
  }
  const minutes = {
    trust: cli.intOption('trust-minutes', values['trust-minutes'], { min: 1, max: 240, def: 3 }),
    vstp: cli.intOption('vstp-minutes', values['vstp-minutes'], { min: 1, max: 240, def: 10 })
  };
  return { help: false, options: { ...common, only: values.only || null, minutes } };
}

// ---- verdicts (pure) -----------------------------------------------------------------------------

// "0003 (movement)" for TRUST, but just "VSTPCIFMsgV1:Create" for VSTP, whose label is already
// the tail of its key.
const labelled = (key, label) => (!label || key === label || key.endsWith(`:${label}`) ? key : `${key} (${label})`);

function describeTypes(a) {
  const entries = Object.entries(a.byType);
  const shown = entries.slice(0, 5).map(([k, v]) => `${labelled(k, v.label)} ${v.sharePct}%`).join(', ');
  return entries.length > 5 ? `${shown}, and ${entries.length - 5} more` : shown;
}

// The message type whose fields are worth quoting: the one the map is built around if it was
// seen, else whatever was commonest. Types in the summary are already ordered by count.
function headlineFields(a, spec) {
  const key = a.types[spec.mainType] ? spec.mainType : Object.keys(a.types)[0];
  const t = key && a.types[key];
  if (!t || !Object.keys(t.planned).length) return '';
  const fields = Object.entries(t.planned).map(([f, p]) => `${f.split('.').pop().replace(/\[\d+\]/g, '')} ${p.populatedPct}%`);
  return `${labelled(key, t.label)} fields populated: ${fields.join(', ')}`;
}

// Why a window ended before its time, as a phrase that follows "by".
function endReason(o) {
  switch (o.endedBy) {
    case 'interlock': return `the safety check (${o.detail.verdict.rule})`;
    case 'signal': return o.detail.name;
    case 'closed': return 'the connection being dropped';
    default: return o.endedBy;
  }
}

const cutShort = (o, ran, window) => (o.endedBy === 'duration' ? '' : `Cut short after ${ran} of ${window} by ${endReason(o)}`);

/**
 * The verdict for one topic. `t`: {skipped, connectError, outcome, ranMs, windowMs, connectMs, analysis}.
 * Pure. PASS = subscribed and messages arrived; WARN = subscribed, no error, nothing in the window
 * (inconclusive); FAIL = not allowed to read it, or the connection failed.
 */
function topicCheck(spec, t, ctx = {}) {
  const o = t.outcome;
  const first = o ? o.firstFrameAfterMs : null;
  const data = {
    topic: spec.destination,
    windowSecs: round1(t.windowMs / 1000),
    ranSecs: round1(t.ranMs / 1000),
    skipped: t.skipped || null,
    connectMs: t.connectMs === undefined ? null : t.connectMs,
    endedBy: o ? o.endedBy : null,
    frames: o ? o.frames : 0,
    firstMessageAfterSecs: first === null || first === undefined ? null : round1(first / 1000),
    closeHow: o && o.close ? o.close.how : null,
    connectError: t.connectError ? t.connectError.info : null,
    analysis: t.analysis || null
  };
  const out = (status, message) => ({ id: spec.id, status, message, data });
  const ran = cli.fmtDuration(t.ranMs), window = cli.fmtDuration(t.windowMs);

  if (t.skipped) return out('WARN', `not checked: ${t.skipped}`);
  if (t.connectError) {
    const info = t.connectError.info;
    if (info.kind === 'aborted') return out('WARN', 'not checked: stopped before the connection was ready');
    return out('FAIL', `could not connect, so ${spec.label} was not tested: ${stomp.explain(info, ctx)}`);
  }

  const closedErr = o.endedBy === 'closed' && o.detail && o.detail.error ? o.detail.error : null;
  if (o.frames === 0 && closedErr && closedErr.kind === 'not-authorised') {
    return out('FAIL', `NOT AUTHORISED: this login may not read ${closedErr.info.topic || spec.destination}. Fix: switch on the ${spec.label} feed for your account in the NROD portal, then run this again.`);
  }
  if (o.frames > 0) {
    const a = t.analysis;
    // Sentences, joined: the verdict, the types seen, the planned fields, then any caveats.
    const sentences = [
      `subscribed, and ${o.frames} messages arrived in ${ran} (first after ${round1(first / 1000)} s)`,
      `Types: ${describeTypes(a)}`,
      headlineFields(a, spec),
      a.parseErrors ? `${a.parseErrors} messages were not JSON` : '',
      cutShort(o, ran, window)
    ].filter(Boolean);
    return out('PASS', `${sentences.join('. ')}.`);
  }
  if (closedErr) {
    return out('FAIL', `connected, but the connection ended before any message arrived: ${stomp.explain(closedErr.info, ctx)}`);
  }
  if (o.endedBy === 'duration') {
    return out('WARN', `subscribed with no error, but no messages in ${ran}: inconclusive${spec.sparse ? ` (${spec.label} is sparse)` : ''}. Run it again with a longer window, e.g. ${spec.flag} ${spec.suggest}`);
  }
  return out('WARN', `stopped after ${ran} of ${window} by ${endReason(o)}, before any message arrived: inconclusive`);
}

// ---- the run ---------------------------------------------------------------------------------------

/**
 * @param {object} opts   parsed options (see parseCli)
 * @param {object} [deps] test seams: now, stdout, stderr, signals, connect, connectTimeoutMs, fetchHealth,
 *                        statFile, settleMs, windowsMs: {trust, vstp}, interlockConfig, forceExit
 * @returns {Promise<number>} the process exit code
 */
async function run(opts, deps = {}) {
  const d = {
    now: Date.now, stdout: process.stdout, stderr: process.stderr, signals: process,
    connect: undefined, connectTimeoutMs: undefined, fetchHealth: undefined, statFile: undefined,
    settleMs: 3000, windowsMs: {}, interlockConfig: undefined, forceExit: code => process.exit(code),
    ...deps
  };

  // FIRST, before the credentials are even read: whichever way run() was reached, the NROD login
  // must not be able to go to a host nobody intended (the command line already checks this at parse
  // time; this is the same rule for any other caller).
  const stompHost = opts.stomp && opts.stomp.host;
  if (stompHost !== undefined && !stomp.isAllowedStompHost(stompHost)) {
    d.stderr.write(`${stomp.hostRefusal(stompHost)}\n`);
    return 2;
  }

  let creds;
  try { creds = feedCredentials(loadEnvFile(opts.envFile), opts.envFile); }
  catch (e) { d.stderr.write(`${cli.friendlyError(e, { debug: opts.debug })}\n`); return 2; }
  try { cli.ensureOutDir(opts.outDir); }
  catch (e) { d.stderr.write(`${cli.friendlyError(e, { debug: opts.debug })}\n`); return 2; }
  const secrets = secretsFor(creds);
  const say = cli.makeSay(d.stdout, secrets, d.now);
  const write = cli.makeWrite(d.stdout, secrets);
  const safeOut = { write: s => { try { d.stdout.write(s); } catch (_) { /* terminal gone; the files are written first */ } } };
  const report = new JsonOnlyReport('feeds-check', { outDir: opts.outDir, secrets, now: () => new Date(d.now()) });
  const ctx = { host: opts.stomp.host, port: opts.stomp.port, envFile: opts.envFile };

  const specs = Object.values(TOPICS).filter(s => !opts.only || s.key === opts.only);
  const windowMs = s => (d.windowsMs[s.key] !== undefined ? d.windowsMs[s.key] : opts.minutes[s.key] * 60000);
  const plannedMs = specs.reduce((n, s) => n + windowMs(s), 0);
  const runStartedAt = d.now();
  write(`feeds-check: checking ${specs.map(s => `${s.label} (${cli.fmtDuration(windowMs(s))})`).join(' then ')}, one connection at a time.`);
  write(`Report folder: ${opts.outDir}`);

  const finish = () => {
    try { return report.finish(safeOut); }
    catch (e) {
      write(report.summaryText());
      write(`Could not write the report files to ${opts.outDir} (${e.code || e.message}). The summary above is the result: copy it from the terminal.`);
      return Math.max(1, report.exitCode);
    }
  };

  report.fact('run', { script: 'feeds-check', startedAt: new Date(runStartedAt).toISOString(), topics: specs.map(s => ({ feed: s.label, destination: s.destination, windowSecs: windowMs(s) / 1000 })) });

  // ---- the interlock ---------------------------------------------------------------------------------
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

  // ---- one topic at a time ----------------------------------------------------------------------------------
  interlock.start();
  const results = {};
  const settleAfter = {};   // the strict look at the crossing service after each connection closed
  let lastSettle = null;
  let skipRest = null;
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const win = windowMs(spec);
    const t = { windowMs: win, ranMs: 0, skipped: null, connectError: null, outcome: null, analysis: null, connectMs: undefined };
    results[spec.key] = t;
    if (skipRest || stop.reason) {
      t.skipped = skipRest || (stop.reason.type === 'signal' ? `stopped by ${stop.reason.name} before it began` : 'stopped by the safety check before it began');
      continue;
    }
    const analyser = new FeedAnalyser(spec.key);
    const started = d.now();
    say(`${spec.label}: connecting (${cli.fmtDuration(win)} window)`);
    let session = null;
    try {
      session = await stomp.openSession({ creds, host: opts.stomp.host, port: opts.stomp.port, connect: d.connect, connectTimeoutMs: d.connectTimeoutMs, cancel: stop.promise, secrets });
    } catch (e) { t.connectError = e; }
    t.connectMs = d.now() - started;
    if (session) {
      say(`${spec.label}: connected in ${t.connectMs} ms (client-id ${session.clientId}); subscribing to ${spec.destination}`);
      t.outcome = await holdTopic({ session, topic: spec.destination, durationMs: win, stop, now: d.now, onBody: body => analyser.ingest(body) });
      say(`${spec.label}: ${t.outcome.endedBy === 'duration' ? 'window finished' : `ended early (${t.outcome.endedBy})`}; ${t.outcome.frames} messages`);
    } else {
      say(`${spec.label}: could not connect: ${t.connectError.message}`);
    }
    // The listening window (subscribe to end) when there was one; otherwise how long we spent trying.
    t.ranMs = t.outcome && t.outcome.subscribedAt !== null ? t.outcome.endedAt - t.outcome.subscribedAt : d.now() - started;
    t.analysis = analyser.summary();
    report.jsonOnly(spec.key, analyser.examples());

    // A connect-phase failure (login refused, network down) is not about this topic, so the next
    // would fail the same way; a refused SUBSCRIBE (not authorised) is specific to the topic and
    // does not stop the other one.
    if (t.connectError && t.connectError.kind !== 'aborted') skipRest = `the first connection could not be opened (${t.connectError.kind}), so another would fail the same way`;

    // Look at the crossing service again now that this connection has gone — strictly, before
    // deciding whether to open another one.
    const more = i < specs.length - 1;
    const settle = await interlock.settleCheck({ settleMs: d.settleMs });
    settleAfter[spec.key] = settle;
    lastSettle = settle;
    if (more && settle && settle.disturbed && !stop.reason) {
      say(`the crossing service looks disturbed after ${spec.label} disconnected (${settle.rule}): ${settle.message}`);
      stop.request({ type: 'interlock', verdict: { rule: settle.rule, message: settle.message } });
      skipRest = `the crossing service looked disturbed after the previous connection closed (${settle.rule})`;
    }
  }

  const interlockSummary = interlock.stop();
  unwatch();
  const finalSettle = lastSettle;
  const endedAt = d.now();

  // ---- verdicts and report ------------------------------------------------------------------------------------
  for (const spec of specs) {
    const t = results[spec.key];
    report.fact(spec.key, { ...(t.analysis || {}), timing: { windowSecs: t.windowMs / 1000, ranSecs: round1(t.ranMs / 1000), endedBy: t.outcome ? t.outcome.endedBy : null, connectMs: t.connectMs === undefined ? null : t.connectMs, firstMessageAfterMs: t.outcome ? t.outcome.firstFrameAfterMs : null } });
    report.fact(`${spec.key}Messages`, t.outcome ? t.outcome.frames : 0, { summary: true });
    const c = topicCheck(spec, t, ctx);
    report.check(c.id, c.status, c.message, c.data);
  }
  const il = interlockCheck({ interlock: interlockSummary, settle: finalSettle, extra: { afterEachConnection: settleAfter } });
  report.check(il.id, il.status, il.message, il.data);
  report.fact('interlock', { ...interlockSummary, afterEachConnection: settleAfter });
  report.note(`This run: ${utcStamp(runStartedAt)} to ${utcStamp(endedAt)}.`);
  report.note('The TRUST and VSTP message shapes (and the fields measured) are from the NROD documentation, not from observation: the presence tables and the key census above are what the feeds actually carried. One trimmed example per message type is in the JSON report only, under "examples".');
  report.note('VSTP is a sparse feed. A WARN with no messages is inconclusive, not a failure: run it again with a longer window.');
  const journal = cli.journalCheckLines(runStartedAt, endedAt);
  for (const line of journal) report.note(line);

  for (const line of afterRunAdvice({ tripped: interlockSummary.tripped, settle: finalSettle, healthUrl: opts.healthUrl })) write(line);
  const code = finish();
  write('');
  for (const line of journal) write(line);
  return code;
}

// ---- process entry ---------------------------------------------------------------------------------------

async function main(argv = process.argv.slice(2)) {
  let parsed;
  try { parsed = parseCli(argv); }
  catch (e) { process.stderr.write(`${cli.friendlyError(e)}\n`); return 2; }
  if (parsed.help) { process.stdout.write(HELP); return 0; }
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
    setTimeout(() => process.exit(code), 5000).unref();
  });
}

module.exports = { main, run, parseCli, topicCheck, HELP, TOPICS };
