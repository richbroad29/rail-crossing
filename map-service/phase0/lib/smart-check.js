'use strict';

// smart-check: does Network Rail's SMART reference file read the way we think, and how much of the berth
// network can it tie to real stations? The orchestration: read inputs, run the pure analyses, and report.
// bin/smart-check.js is a thin wrapper around `run` below.
//
// Read-only with respect to the crossing back end: its .env, CORPUS and TD logs are only ever opened for
// reading. Everything this script writes (reports, the anchor table, downloads) goes inside --out.
//
// Failure policy: after the command line is parsed, nothing throws at the user. A stage that fails (no
// credentials, a 401, a damaged file) becomes a FAIL check with a sentence that says what to do; checks
// that depend on it say they were skipped rather than vanishing; and whatever did finish is reported.

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');

const { Report, stamp } = require('./report');
const { loadEnvFile, feedCredentials, secretsFor, expandHome, redact } = require('./env');
const { downloadFile, nrodUrl, DownloadError } = require('./download');
const { readSmart, judgeSmartFormat, describeSmartFacts } = require('./smart');
const { loadCorpus, judgeCorpus, describeCorpusFacts } = require('./corpus');
const { loadStations, DEFAULT_STATIONS_FILE } = require('./stations');
const A = require('./smart-analysis');
const P = require('./portslade');
const { findTdLogFiles, readTdLogs } = require('./td-logs');
const { analyseCoverage, describeCoverage } = require('./coverage');
const { probeNaptan, judgeNaptan } = require('./naptan');
const { anchorsFileText, writeAnchorsFile } = require('./anchors-file');
const { MemoryProbe } = require('./memory');
const N = require('./notes');
const { fmtInt, mb, oneLine } = require('./format');

const PHASE0_DIR = path.resolve(__dirname, '..');
const DEFAULTS = {
  env: '~/rail-crossing/backend/.env',
  corpus: '~/rail-crossing/backend/data/corpus/corpus-latest.json.gz',
  tdLogDir: '~/rail-crossing/backend/data/logs/td',
  tdDays: 7,
  out: path.join(PHASE0_DIR, 'out')
};
const TD_AREA = P.AREA;                                       // 'LA'
const FRIENDLY_CODES = new Set(['ENV_UNREADABLE', 'ENV_MISSING_CREDS', 'FILE_MISSING', 'FILE_UNREADABLE', 'GZIP_DAMAGED', 'STATIONS_UNREADABLE', 'STATIONS_INVALID', 'STATIONS_EMPTY']);

const OPTION_SPEC = {
  env: { type: 'string' },
  'smart-file': { type: 'string' },
  corpus: { type: 'string' },
  stations: { type: 'string' },
  'td-log-dir': { type: 'string' },
  'td-days': { type: 'string' },
  out: { type: 'string' },
  naptan: { type: 'boolean' },
  debug: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' }
};

const HELP = `smart-check - does Network Rail's SMART file read the way we think, and how much of the berth
network can it tie to real stations?

Read-only: the crossing back end's files are only ever read. Everything written (reports, the anchor
table, downloads) goes inside the --out folder.

Usage: node bin/smart-check.js [options]

  --env <path>         credentials file; only read if something has to be downloaded
                       (default ~/rail-crossing/backend/.env)
  --smart-file <path>  use this SMART file (gzip or plain JSON) instead of downloading one
  --corpus <path>      CORPUS file (default ~/rail-crossing/backend/data/corpus/corpus-latest.json.gz;
                       if that default is missing, CORPUS is downloaded into <out>/data/)
  --stations <path>    station table (default map-service/data/stations.json)
  --td-log-dir <path>  TD logs (default ~/rail-crossing/backend/data/logs/td)
  --td-days <n>        days of TD logs to read, counted back from the newest file (default 7)
  --out <dir>          reports, anchor table and downloads (default map-service/phase0/out)
  --naptan             also probe the NaPTAN API (optional)
  --debug              show stack traces for unexpected errors
  -h, --help           this text

On the VPS:
  cd ~/rail-map/map-service/phase0
  nice -n 19 node --max-old-space-size=256 bin/smart-check.js

It prints a block between "paste from here" and "end smart-check": copy that block back.
Exit code: 0 if no check FAILed, 1 if one did, 2 if it was run wrongly.
`;

// ---- command line -----------------------------------------------------------------------------------

function parseOptions(argv) {
  const { values } = parseArgs({ args: argv, allowPositionals: false, strict: true, options: OPTION_SPEC });
  let tdDays = DEFAULTS.tdDays;
  if (values['td-days'] !== undefined) {
    if (!/^\d+$/.test(values['td-days']) || Number(values['td-days']) < 1 || Number(values['td-days']) > 366) {
      throw new Error('--td-days must be a whole number of days from 1 to 366.');
    }
    tdDays = Number(values['td-days']);
  }
  const resolve = p => path.resolve(expandHome(p));
  return {
    help: !!values.help,
    debug: !!values.debug,
    naptan: !!values.naptan,
    env: resolve(values.env || DEFAULTS.env),
    smartFile: values['smart-file'] ? resolve(values['smart-file']) : null,
    corpus: resolve(values.corpus || DEFAULTS.corpus),
    corpusExplicit: values.corpus !== undefined,
    stations: values.stations ? resolve(values.stations) : DEFAULT_STATIONS_FILE,
    tdLogDir: resolve(values['td-log-dir'] || DEFAULTS.tdLogDir),
    tdDays,
    out: values.out ? resolve(values.out) : DEFAULTS.out
  };
}

// ---- stages -----------------------------------------------------------------------------------------

/** A sentence for an error: our own errors say it already; anything else is "unexpected". */
function describeError(ctx, e, doing) {
  if (ctx.opts.debug && e && e.stack) ctx.say(e.stack);
  if (e instanceof DownloadError || (e && FRIENDLY_CODES.has(e.code))) return e.message;
  return `unexpected error while ${doing}: ${(e && e.message) || e}${ctx.opts.debug ? '' : ' (re-run with --debug for the details)'}`;
}

/** The NROD login, read from the back end's .env only when a download needs it, and registered for scrubbing. */
function getCreds(ctx) {
  if (!ctx.creds) {
    const env = loadEnvFile(ctx.opts.env);
    ctx.creds = feedCredentials(env, ctx.opts.env);
    ctx.secrets.push(...secretsFor(ctx.creds));
  }
  return ctx.creds;
}

async function download(ctx, type, dest) {
  const creds = getCreds(ctx);
  return ctx.io.downloadFile({
    url: nrodUrl(type), dest, auth: creds,
    serverName: 'NROD', what: `${type} file`,
    authHint: `check NR_FEED_USER / NR_FEED_PASS in ${ctx.opts.env}`
  });
}

function stageStations(ctx, S) {
  try {
    S.stations = loadStations(ctx.opts.stations);
    ctx.report.fact('stations.table', { file: S.stations.file, stations: S.stations.count, skipped: S.stations.skipped, source: S.stations.source });
    ctx.say(`Station table: ${fmtInt(S.stations.count)} stations.`);
  } catch (e) {
    S.stationsErr = describeError(ctx, e, 'reading the station table');
  }
}

async function stageCorpus(ctx, S) {
  const { opts, report } = ctx;
  try {
    let file = opts.corpus, source = 'file';
    if (!fs.existsSync(file)) {
      if (opts.corpusExplicit) {
        const err = new Error(`The CORPUS file ${file} (from --corpus) does not exist.`);
        err.code = 'FILE_MISSING';
        throw err;
      }
      file = path.join(opts.out, 'data', 'corpus-latest.json.gz');
      ctx.say(`CORPUS not found at ${opts.corpus}; downloading it into ${path.dirname(file)} ...`);
      const d = await download(ctx, 'CORPUS', file);
      source = 'downloaded';
      report.fact('corpus.download', { bytes: d.bytes, redirects: d.redirects, hosts: d.hosts, contentType: d.contentType, contentEncoding: d.contentEncoding });
    }
    ctx.say(`Reading CORPUS (${file}) ...`);
    S.corpus = await loadCorpus(file, { onChunk: () => ctx.mem.sample('reading CORPUS') });
    S.corpus.file = file;
    report.fact('corpus.file', file);
    report.fact('corpus.source', source);
    report.fact('corpus.format', S.corpus.facts);
    for (const line of describeCorpusFacts(S.corpus.facts)) report.note(line);
    S.corpusVerdict = judgeCorpus(S.corpus.facts);
  } catch (e) {
    S.corpusErr = describeError(ctx, e, 'reading CORPUS');
  }
}

async function stageSmart(ctx, S) {
  const { opts, report } = ctx;
  try {
    let file = opts.smartFile, source = 'file';
    if (!file) {
      file = path.join(opts.out, 'data', 'smart-latest.json.gz');
      ctx.say(`Downloading SMART from NROD into ${path.dirname(file)} ...`);
      const d = await download(ctx, 'SMART', file);
      source = 'downloaded';
      report.fact('smart.download', { bytes: d.bytes, redirects: d.redirects, hosts: d.hosts, contentType: d.contentType, contentEncoding: d.contentEncoding });
      ctx.say(`Downloaded ${mb(d.bytes)} MB.`);
    }
    const t0 = Date.now();
    ctx.say(`Reading SMART (${file}) ...`);
    S.smart = await readSmart(file, { keepRaw: c => c.td === TD_AREA, onChunk: () => ctx.mem.sample('reading SMART') });
    S.smart.file = file;
    S.smart.source = source;
    ctx.say(`Read ${fmtInt(S.smart.facts.rows)} SMART rows in ${Math.round((Date.now() - t0) / 100) / 10} s.`);
    report.fact('smart.file', file);
    report.fact('smart.source', source);
    report.fact('smart.bytesOnDisk', S.smart.facts.bytesOnDisk);
    report.fact('smart.bytesUncompressed', S.smart.facts.bytesUncompressed);
    S.smartVerdict = judgeSmartFormat(S.smart.facts);
  } catch (e) {
    S.smartErr = describeError(ctx, e, 'reading SMART');
  }
}

// ---- the checks -------------------------------------------------------------------------------------

function skip(report, id, reason) { report.check(id, 'INFO', `Skipped: ${reason}.`); }

/** Run one analysis; an exception becomes a FAIL check for that id instead of ending the run. */
function attempt(ctx, id, doing, fn) {
  try { return { ok: true, value: fn() }; }
  catch (e) {
    ctx.report.check(id, 'FAIL', describeError(ctx, e, doing));
    return { ok: false };
  }
}

async function runChecks(ctx) {
  const { opts, report } = ctx;
  const S = {};
  stageStations(ctx, S);
  await stageCorpus(ctx, S);
  await stageSmart(ctx, S);
  ctx.mem.sample('inputs loaded');

  // 1. SMART_FORMAT
  if (S.smartErr) {
    report.check('SMART_FORMAT', 'FAIL', `Could not read SMART: ${S.smartErr}`);
  } else {
    report.check('SMART_FORMAT', S.smartVerdict.status, S.smartVerdict.message, S.smart.facts);
    for (const line of describeSmartFacts(S.smart.facts)) report.note(line);
    report.fact('smart.rows', S.smart.facts.rows, { summary: true });
    report.fact('smart.tdAreas', S.smart.facts.tdAreas, { summary: true });
  }
  const smartOk = !!S.smart && S.smartVerdict.status !== 'FAIL';
  const smartWhy = S.smartErr ? 'SMART could not be read' : 'the file does not look like SMART (see SMART_FORMAT)';
  const corpusOk = !!S.corpus && S.corpusVerdict.ok;
  const joinWhy = !smartOk ? smartWhy
    : S.stationsErr ? 'the station table could not be read'
      : S.corpusErr ? 'CORPUS could not be read'
        : !corpusOk ? 'CORPUS cannot be used' : null;
  const ready = smartOk && !!S.stations && corpusOk;

  // 2. SMART_SEMANTICS
  if (!smartOk) skip(report, 'SMART_SEMANTICS', smartWhy);
  else {
    const r = attempt(ctx, 'SMART_SEMANTICS', 'testing the berth reading', () => {
      const res = A.analyseSemantics(S.smart.rows);
      return { res, verdict: A.judgeSemantics(res, { events: S.smart.facts.events }) };
    });
    if (r.ok) {
      const { res, verdict } = r.value;
      report.check('SMART_SEMANTICS', verdict.status, verdict.message, { ...res, thresholds: verdict.thresholds });
      for (const line of N.semanticsNotes(res)) report.note(line);
      if (res.groups > 0) {
        report.fact('semantics.oursExactPct', res.pct.oursExact, { summary: true });
        report.fact('semantics.oursAdjacentPct', res.pct.oursAdjacent, { summary: true });
        report.fact('semantics.reversedExactPct', res.pct.reversedExact, { summary: true });
        // by row, beside the group-level shares: the group test is existential, so lenient at big multi-platform stations
        report.fact('semantics.rowOursArrivalPct', res.rowLevel.pct.oursArrival, { summary: true });
        report.fact('semantics.rowOursDeparturePct', res.rowLevel.pct.oursDeparture, { summary: true });
        report.fact('semantics.rowReversedArrivalPct', res.rowLevel.pct.reversedArrival, { summary: true });
        report.fact('semantics.rowReversedDeparturePct', res.rowLevel.pct.reversedDeparture, { summary: true });
      }
    }
  }

  // 3. STATION_RESOLUTION
  if (!smartOk) skip(report, 'STATION_RESOLUTION', smartWhy);
  else if (S.stationsErr) report.check('STATION_RESOLUTION', 'FAIL', `Cannot tie SMART to stations: ${S.stationsErr}`);
  else if (S.corpusErr) report.check('STATION_RESOLUTION', 'FAIL', `Cannot tie SMART to stations: ${S.corpusErr}`);
  else if (!corpusOk) report.check('STATION_RESOLUTION', 'FAIL', `Cannot tie SMART to stations: ${S.corpusVerdict.problem}.`);
  else {
    const r = attempt(ctx, 'STATION_RESOLUTION', 'resolving stations', () => {
      const res = A.analyseStationResolution({ stanoxInfo: S.smart.stanoxInfo, corpus: S.corpus.index, stations: S.stations.byCrs });
      return { res, verdict: A.judgeStationResolution(res, { smartStanoxLengths: S.smart.facts.stanoxLengths, corpusStanoxLengths: S.corpus.facts.stanoxLengths }) };
    });
    if (r.ok) {
      const { res, verdict } = r.value;
      report.check('STATION_RESOLUTION', verdict.status, verdict.message, { ...res, thresholds: verdict.thresholds });
      for (const line of N.resolutionNotes(res)) report.note(line);
    }
  }

  // 5 (computed before 4, which needs it for the Southwick check). ANCHORS
  let anchors = null;
  if (ready) {
    const r = attempt(ctx, 'ANCHORS', 'placing berths at stations', () => A.analyseAnchors(S.smart.rows, {
      crsForStanox: s => S.corpus.index.crsForStanox(s), stations: S.stations.byCrs
    }));
    if (r.ok) anchors = r.value;
  }

  // 4. PORTSLADE_KNOWN_ANSWER
  if (!smartOk) skip(report, 'PORTSLADE_KNOWN_ANSWER', smartWhy);
  else if (!corpusOk || !S.stations) skip(report, 'PORTSLADE_KNOWN_ANSWER', joinWhy);
  else if (!anchors) skip(report, 'PORTSLADE_KNOWN_ANSWER', 'the anchors could not be computed (see ANCHORS)');
  else {
    const r = attempt(ctx, 'PORTSLADE_KNOWN_ANSWER', 'checking Portslade', () => {
      const res = P.analysePortslade({ rawKept: S.smart.rawKept, corpus: S.corpus.index, anchorTable: anchors.table });
      return { res, verdict: P.judgePortslade(res) };
    });
    if (r.ok) {
      report.check('PORTSLADE_KNOWN_ANSWER', r.value.verdict.status, r.value.verdict.message, P.portsladeData(r.value.res));
      for (const line of P.describePortslade(r.value.res)) report.note(line);
    }
  }

  // 5. ANCHORS
  let anchorsFile = null;
  if (!ready) skip(report, 'ANCHORS', joinWhy);
  else if (anchors) {
    report.check('ANCHORS', 'INFO', A.describeAnchors(anchors), {
      totals: anchors.totals, perArea: anchors.perArea, rowCounts: anchors.rowCounts,
      suspiciousTop: anchors.suspiciousTop, conflictsNearest: anchors.conflictsNearest
    });
    for (const line of N.anchorNotes(anchors)) report.note(line);
    report.fact('anchors.berths', anchors.totals.anchors, { summary: true });
    try {
      anchorsFile = path.join(opts.out, `smart-anchors-${stamp(report.startedAt)}.json`);
      writeAnchorsFile(anchorsFile, anchorsFileText({ generatedAt: report.startedAt.toISOString(), smartFile: S.smart.file, anchors }), ctx.secrets);
      report.fact('anchors.file', anchorsFile);
    } catch (e) {
      anchorsFile = null;
      report.note(`The anchor table could not be written: ${describeError(ctx, e, 'writing the anchor table')}`);
    }
  }
  ctx.mem.sample('anchors computed');

  // 6. LA_COVERAGE
  if (!ready || !anchors) skip(report, 'LA_COVERAGE', joinWhy || 'the anchors could not be computed');
  else await stageCoverage(ctx, anchors);

  // 7. SUSSEX
  if (!ready || !anchors) skip(report, 'SUSSEX', joinWhy || 'the anchors could not be computed');
  else {
    const r = attempt(ctx, 'SUSSEX', 'counting Sussex anchors', () => A.analyseSussex(anchors.table, S.stations.byCrs));
    if (r.ok) {
      report.check('SUSSEX', 'INFO', A.describeSussex(r.value), r.value);
      for (const line of N.sussexNotes(r.value)) report.note(line);
    }
  }

  // 8. NAPTAN_PROBE
  if (opts.naptan) {
    ctx.say('Probing NaPTAN ...');
    let r;
    try { r = await ctx.io.probeNaptan({ tiplocs: S.corpus ? S.corpus.index.tiplocs : null }); }
    catch (e) { r = { ok: false, reason: `unexpected error: ${(e && e.message) || e}` }; }   // never fatal, whatever happens
    const v = judgeNaptan(r);
    report.check('NAPTAN_PROBE', v.status, v.message, r);
    for (const line of N.naptanNotes(r)) report.note(line);
  }

  return { anchorsFile };
}

async function stageCoverage(ctx, anchors) {
  const { opts, report } = ctx;
  const logs = findTdLogFiles(opts.tdLogDir, opts.tdDays);
  report.fact('td.logDir', opts.tdLogDir);
  if (!logs.readable) {
    report.check('LA_COVERAGE', logs.reason.startsWith('cannot') ? 'WARN' : 'INFO', `No TD logs to measure coverage from: ${opts.tdLogDir} - ${logs.reason}.`, { logs });
    return;
  }
  if (!logs.files.length) {
    report.check('LA_COVERAGE', 'INFO', `No TD log files (td-YYYY-MM-DD.jsonl) in ${opts.tdLogDir}, so coverage was not measured.`, { logs });
    return;
  }
  ctx.say(`Reading ${logs.files.length} day(s) of TD logs (${logs.oldest} to ${logs.newest}) ...`);
  let td;
  try { td = await readTdLogs(logs.files, { area: TD_AREA }); }
  catch (e) { report.check('LA_COVERAGE', 'FAIL', describeError(ctx, e, 'reading the TD logs')); return; }
  ctx.mem.sample('TD logs read');
  const anchored = new Set(anchors.table.filter(a => a.td === TD_AREA).map(a => a.berth));
  const r = attempt(ctx, 'LA_COVERAGE', 'measuring coverage', () => analyseCoverage({ berths: td.berths, edges: td.edges, anchored }));
  if (!r.ok) return;
  const cov = r.value;
  if (td.berths.size === 0) {
    report.check('LA_COVERAGE', 'INFO', `The ${logs.files.length} TD log file(s) in ${opts.tdLogDir} hold no ${TD_AREA} berth events, so coverage was not measured.`, { logs, lines: td.lines });
    return;
  }
  report.check('LA_COVERAGE', 'INFO', describeCoverage(cov, { area: TD_AREA, logs }), {
    ...cov, logs: { dir: logs.dir, found: logs.found, files: logs.files.map(f => f.date), newest: logs.newest },
    td: { lines: td.lines, areaLines: td.areaLines, bad: td.bad, events: td.events, perFile: td.perFile }
  });
  for (const line of N.coverageNotes(cov, logs, td, TD_AREA, anchored)) report.note(line);
  report.fact('la.berthsSeen', cov.berthsSeen, { summary: true });
  report.fact('la.anchoredPct', cov.sharePct[0], { summary: true });
  report.fact('la.within1Pct', cov.sharePct[1], { summary: true });
  report.fact('la.within2Pct', cov.sharePct[2], { summary: true });
  report.fact('la.within3Pct', cov.sharePct[3], { summary: true });
}

// ---- entry points -----------------------------------------------------------------------------------

/**
 * Run smart-check. Resolves the exit code. `deps` replaces the outside world for tests: stdout, stderr,
 * now, downloadFile, probeNaptan.
 */
async function main(argv, deps = {}) {
  const io = { stdout: process.stdout, stderr: process.stderr, now: () => new Date(), downloadFile, probeNaptan, ...deps };
  const secrets = [];
  const say = text => io.stderr.write(redact(String(text), secrets) + '\n');

  let opts;
  try { opts = parseOptions(argv); }
  catch (e) {
    say(`${String(e.message).split('\n')[0]}\nRun with --help for usage.`);
    return 2;
  }
  if (opts.help) { io.stdout.write(HELP); return 0; }

  // Fail now, not after a minute of work, if the reports cannot be written.
  try {
    fs.mkdirSync(opts.out, { recursive: true });
    fs.accessSync(opts.out, fs.constants.W_OK);
  } catch (e) {
    say(`Cannot write to the output folder ${opts.out} (${e.code || e.message}): pass --out with a folder you can write to.`);
    return 2;
  }

  const report = new Report('smart-check', { outDir: opts.out, secrets, now: io.now });
  const mem = new MemoryProbe();
  const ctx = { opts, io, report, secrets, say, mem, creds: null };
  const t0 = Date.now();

  let result = {};
  try {
    result = await runChecks(ctx);
  } catch (e) {
    report.check('SMART_CHECK', 'FAIL', describeError(ctx, e, 'running the checks'));
  }

  const m = mem.report();
  report.fact('heap.peakUsedMB', m.peakHeapUsedMB, { summary: true });
  report.fact('process.peakRssMB', m.peakRssMB, { summary: true });
  report.fact('heap.detail', `${m.peakHeapUsedMB} MB used at the sampled peak (during: ${m.peakHeapAt}) of a ${m.heapLimitMB} MB limit; heap is sampled and counts uncollected garbage, peak RSS is the OS's own figure`);
  report.fact('runtime.secs', Math.round((Date.now() - t0) / 100) / 10);
  report.fact('node.version', process.version);

  const code = report.finish(io.stdout);
  if (result.anchorsFile) io.stdout.write(`Anchor table (for phase 1): ${result.anchorsFile}\n`);
  return code;
}

/** What bin/smart-check.js calls: signal handling around `main`. Ctrl-C and kill clean up half-downloaded files via the exit hook. */
async function run(argv) {
  process.once('SIGINT', () => process.exit(130));
  process.once('SIGTERM', () => process.exit(143));
  try {
    return await main(argv);
  } catch (e) {
    const debug = argv.includes('--debug');
    process.stderr.write(`smart-check stopped unexpectedly: ${oneLine((e && e.message) || e, 300)}${debug ? `\n${e && e.stack}` : ' (re-run with --debug for the details)'}\n`);
    return 70;
  }
}

module.exports = { main, run, parseOptions, HELP, DEFAULTS };
