const fs = require('fs');
const path = require('path');
const { pollCrossing } = require('./ldb-poller');
const { parseScheduleFile, applyUpdateExtract } = require('./schedule-parser');
const { CrossingEngines } = require('./engines');
const { createApi } = require('./api');
const logger = require('./logger');
const tdListener = require('./td-listener');
const tdRotation = require('./td-rotation');
const sclassRotation = require('./sclass-rotation');
const feedLogger = require('./feed-logger');
const cifFetcher = require('./cif-fetcher');
const cifArchive = require('./cif-archive');
const { applyNewerUpdate } = require('./timetable-update');
const corpusFetcher = require('./corpus-fetcher');
const { computeRunRates } = require('./run-rate');
const { tdLogFile, crossingTdAreas } = require('./td-paths');
const { validateDirections } = require('./direction');
const { parseLondonWallClock, londonDateStamp } = require('./time-utils');

// Load config
// One definition file per crossing, config/crossings/<id>.json (src/crossing-definitions.js).
const { loadCrossings, loadRoutesFor, engineOf, shadowEngineOf } = require('./crossing-definitions');
const crossingsConfig = loadCrossings();
// The berth-first routes of each crossing that uses berth-first (serving or shadow); none otherwise.
const routesById = loadRoutesFor(crossingsConfig);

// Environment
const RDM_API_KEY = process.env.RDM_API_KEY;       // RDM consumer key (preferred)
const NR_TOKEN_SV = process.env.NR_TOKEN_SV;       // Direct SOAP token (alternative)
const PORT = parseInt(process.env.PORT || '3000', 10);
const SCHEDULE_FILE = process.env.SCHEDULE_FILE || '';
const POLL_INTERVAL_MS = 30000; // 30 seconds

// Last full-parse result (per crossing), annotated with run-rates. An UPDATE extract newer than the
// full is overlaid onto a clone of this (refreshScheduleUpdate), so an application always starts from
// a clean baseline. Null until the first full parse completes.
let baseScheduleByCrossing = null;
// Sequence number of the full timetable baseScheduleByCrossing was parsed from (from its own header),
// so an update is applied only if it is newer (timetable-update.js). null = unknown: no update is applied.
let loadedFullSeq = null;

// The sequence in a timetable file's header, or null if it has none (a hand-made test timetable).
async function fullSequence(file) {
  try {
    const h = await cifArchive.readHeader(file);
    return h.type === 'full' ? h.sequence : null;
  } catch (e) {
    console.error(`CIF: could not read the full timetable's header (${e.message}) — no update will be applied over it`);
    return null;
  }
}

// Build auth config — RDM takes priority
let auth;
if (RDM_API_KEY) {
  auth = { mode: 'rdm', apiKey: RDM_API_KEY };
} else if (NR_TOKEN_SV) {
  auth = { mode: 'soap', token: NR_TOKEN_SV };
} else {
  console.error('ERROR: Set either RDM_API_KEY (RDM consumer key) or NR_TOKEN_SV (SOAP token)');
  console.error('  RDM_API_KEY = your consumer key from raildata.org.uk');
  console.error('  NR_TOKEN_SV = your SOAP token from realtime.nationalrail.co.uk');
  process.exit(1);
}

// Each crossing's engines (engines.js): the serving one, whose state the API publishes, and an
// optional shadow fed the same inputs and only logged. `crossingStates` is the serving engines.
const engines = new CrossingEngines(crossingsConfig, routesById);
const crossingStates = engines.serving;
for (const [id, config] of Object.entries(crossingsConfig)) {
  const shadow = shadowEngineOf(config);
  console.log(`Crossing registered: ${id} (${config.name}) — engine ${engineOf(config)}` +
    (shadow ? `, shadow ${shadow} (logged, not served; areas ${(routesById[id] && routesById[id].areas || []).join('+')})` : ''));
  // A name on both place lists would match neither (src/direction.js) — say so at startup.
  for (const p of validateDirections(config.directions)) console.error(`Crossing ${id}: directions config: ${p}`);
}

// LDB polling loop
async function pollAll() {
  for (const [id, config] of Object.entries(crossingsConfig)) {
    try {
      const trains = await pollCrossing(id, config, auth, {
        timetableDirection: q => crossingStates[id].timetableDirection(q)
      });
      engines.ldb(id, trains);
      console.log(`LDB ${id}: ${trains.length} trains, state=${crossingStates[id].state}`);
    } catch (err) {
      console.error(`LDB poll failed for ${id}:`, err.message);
    }
  }
}

// Load CORPUS reference data — used to resolve CIF train origin/destination
// TIPLOCs to human-readable names. Non-fatal: on failure, freight/ECS origin
// and destination remain raw TIPLOCs (current pre-CORPUS behaviour).
async function loadCorpus() {
  if (!corpusFetcher.latestFileExists()) {
    console.log('No CORPUS file on disk yet — triggering initial download');
    try {
      const res = await corpusFetcher.downloadCorpus();
      console.log(`CORPUS downloaded: ${res.bytes} bytes`);
    } catch (err) {
      console.error('Initial CORPUS download failed:', err.message);
      console.error('Freight/ECS origins shown as raw TIPLOCs until next refresh.');
      return;
    }
  }
  try {
    await corpusFetcher.loadCorpusFromDisk();
  } catch (err) {
    console.error('Failed to load CORPUS from disk:', err.message);
  }
}

// Annotate Q-flagged freight trains with their recent run rate by scanning
// past TD logs. Mutates the trains in place with `recentRunRate` and the
// underlying `recentRunDays` count for transparency.
//
// Per crossing, against that crossing's own TD area: "did this headcode run" means "was it
// seen in the area this crossing watches". A crossing with no td.area has no TD history, so
// its trains are left unannotated rather than scored against someone else's area.
function annotateRunRates(scheduleByCrossing) {
  const many = Object.keys(scheduleByCrossing).length > 1;
  for (const [id, trains] of Object.entries(scheduleByCrossing)) {
    const area = crossingsConfig[id] && crossingsConfig[id].td && crossingsConfig[id].td.area;
    if (!area) continue;
    const headcodeToDaysPattern = new Map();
    for (const t of trains) {
      if (t.runsAsRequired && t.headcode) {
        headcodeToDaysPattern.set(t.headcode, t.daysPattern || '');
      }
    }
    if (headcodeToDaysPattern.size === 0) continue;

    const rates = computeRunRates(headcodeToDaysPattern, { area });
    for (const t of trains) {
      if (!t.runsAsRequired || !t.headcode) continue;
      const r = rates[t.headcode];
      if (!r) continue;
      t.recentRunRate = r.rate;
      t.recentRunSeen = r.seen;
      t.recentRunApplicable = r.applicable;
    }
    const summary = Object.entries(rates).map(([h, r]) =>
      `${h}=${r.applicable > 0 ? Math.round(100 * r.rate) + '%' : 'n/a'}(${r.seen}/${r.applicable})`
    ).join(' ');
    console.log(`Run-rate scan${many ? ` [${id}]` : ''} (${headcodeToDaysPattern.size} Q-freight headcodes): ${summary}`);
  }
}

// Load schedule data — prefers env SCHEDULE_FILE (for testing); else auto-managed CIF
async function loadSchedule() {
  let file = SCHEDULE_FILE;
  if (!file) file = cifFetcher.latestFilePath();

  if (!fs.existsSync(file)) {
    console.log(`No CIF file on disk yet at ${file} — triggering initial download`);
    try {
      const res = await cifFetcher.downloadCif();
      console.log(`CIF downloaded: ${res.bytes} bytes`);
    } catch (err) {
      console.error('Initial CIF download failed:', err.message);
      console.error('Will retry at next 04:00 BST. Predictions run without freight/ECS until then.');
      return;
    }
  }

  console.log(`Loading schedule from: ${file}`);
  try {
    const scheduleTrains = await parseScheduleFile(file, crossingsConfig);
    annotateRunRates(scheduleTrains);
    baseScheduleByCrossing = scheduleTrains;
    loadedFullSeq = await fullSequence(file);
    console.log(`Schedule loaded: full timetable sequence ${loadedFullSeq == null ? 'unknown' : loadedFullSeq}`);
    for (const [id, trains] of Object.entries(scheduleTrains)) engines.schedule(id, trains);
  } catch (err) {
    console.error('Failed to load schedule:', err.message);
  }
}

// After each full load (startup, and the 04:00 refresh whether or not its download worked): fetch the
// newest published UPDATE and overlay it on the full's parse ONLY if its header says it is newer than
// the full (timetable-update.js). Normally it is not: the full is fetched after the morning's update is
// published and already contains it. It matters when the 04:00 full failed and we are on yesterday's.
//
// This used to run hourly and ask for TODAY's file name, which is last week's file until tonight, so
// it re-applied a six-day-old update over a fresh full all day (found 2026-11-19). Non-fatal: on any
// failure we keep the current predictions.
async function refreshScheduleUpdate() {
  if (!baseScheduleByCrossing) return; // no full-parse baseline yet
  const base = baseScheduleByCrossing;
  try {
    await applyNewerUpdate({
      fullSeq: loadedFullSeq,
      download: cifFetcher.downloadCifUpdate,
      readHeader: cifArchive.readHeader,
      log: line => console.log(line),
      apply: async file => {
        const { trains } = await applyUpdateExtract(file, crossingsConfig, base);
        if (baseScheduleByCrossing !== base) return; // a newer full arrived meanwhile: it wins
        annotateRunRates(trains);
        for (const [id, t] of Object.entries(trains)) engines.schedule(id, t);
      }
    });
  } catch (err) {
    console.error('CIF update failed (keeping current predictions):', err.message);
  }
}

// Daily refresh — fires at 04:00 Europe/London. Refreshes CORPUS first so the
// subsequent CIF reparse sees the latest TIPLOC names. On failure of either
// stage, keeps in-memory data from the previous run.
function scheduleDailyCifRefresh() {
  const next = nextFireAt(4, 0);
  const ms = next.getTime() - Date.now();
  console.log(`Daily refresh: next fire at ${next.toISOString()} (in ${Math.round(ms/60000)} min)`);
  setTimeout(async function tick() {
    try {
      console.log('CORPUS refresh: starting daily fetch');
      const res = await corpusFetcher.downloadCorpus();
      console.log(`CORPUS refresh: downloaded ${res.bytes} bytes`);
      await corpusFetcher.loadCorpusFromDisk();
    } catch (err) {
      console.error('CORPUS refresh failed (keeping previous map):', err.message);
    }

    try {
      console.log('CIF refresh: starting daily fetch');
      const res = await cifFetcher.downloadCif();
      console.log(`CIF refresh: downloaded ${res.bytes} bytes`);
      const trains = await parseScheduleFile(cifFetcher.latestFilePath(), crossingsConfig);
      annotateRunRates(trains);
      baseScheduleByCrossing = trains;
      loadedFullSeq = await fullSequence(cifFetcher.latestFilePath());
      for (const [id, t] of Object.entries(trains)) engines.schedule(id, t);
      console.log(`CIF refresh: in-memory schedules updated (full timetable sequence ${loadedFullSeq == null ? 'unknown' : loadedFullSeq})`);
    } catch (err) {
      console.error('CIF refresh failed (keeping previous data):', err.message);
    }
    // Then the newest update, if it is newer than whichever full we now hold. On a normal morning it is
    // the same sequence as the full just fetched and is skipped; after a failed download it brings in
    // the changes the missed full would have had.
    await refreshScheduleUpdate();
    // Schedule next 24h out
    setTimeout(tick, 24 * 3600 * 1000);
  }, ms);
}

function scheduleCifArchive() {
  if (SCHEDULE_FILE) return; // a test timetable is not the real one
  const run = () => cifArchive.runOnce({ download: cifFetcher.downloadCifUpdateDay, fullFile: cifFetcher.latestFilePath() })
    .catch(err => console.error('CIF archive failed:', err.message));
  setTimeout(run, 5 * 60 * 1000).unref(); // after the startup parse (~3 min), not competing with it
  const next = nextFireAt(4, 30);
  setTimeout(function tick() {
    run();
    setTimeout(tick, 24 * 3600 * 1000).unref();
  }, next.getTime() - Date.now()).unref();
}

function nextFireAt(hour, minute) {
  const today = londonDateStamp();
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  let target = parseLondonWallClock(`${today}T${hh}:${mm}:00`);
  if (target.getTime() <= Date.now()) {
    target = new Date(target.getTime() + 24 * 3600 * 1000);
  }
  return target;
}

// Startup
// Replay today's TD log into each crossing's first-sighting map. Cheap: one pass over a
// file the listener is already appending to (~1MB/day), read once at startup. Each crossing
// reads its own area's log (td-paths), and still keeps only lines from its own area.
function readTodaysTdEntries(area) {
  const file = tdLogFile(area, londonDateStamp());
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n');
  } catch (e) {
    return { error: e.code };
  }
  const entries = [];
  for (const line of lines) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch (err) { continue; }
    if (!r.area || !r.desc || !r.ts) continue;
    // Steps and cancels, as on the live path (CrossingState.recordTdEvent): an interpose is not
    // a sighting for this engine. Older lines all carry `event`.
    if (r.event === 'CC') continue;
    entries.push({ area: r.area, headcode: r.desc, ts: r.ts, from: r.from, to: r.to });
  }
  return { entries };
}

function seedSightingsFromLog(states) {
  const byArea = new Map();
  for (const state of Object.values(states)) {
    const area = state.config && state.config.td && state.config.td.area;
    if (!area) { console.log(`TD sighting seed: ${state.id} — no td.area, nothing to seed`); continue; }
    if (!byArea.has(area)) byArea.set(area, readTodaysTdEntries(area));
    const got = byArea.get(area);
    if (got.error) { console.log(`TD sighting seed: no log for today (${got.error}) — starting cold`); continue; }
    const mine = got.entries.filter(e => state.ownsTdArea(e.area));
    const n = state.seedSightings(mine);
    console.log(`TD sighting seed: ${state.id} — ${n} headcodes from ${mine.length} events`);
  }
}

async function main() {
  console.log('=== Rail Crossing Backend v2 ===');
  console.log(`Crossings: ${Object.keys(crossingsConfig).join(', ')}`);
  console.log(`Port: ${PORT}`);
  console.log(`Auth mode: ${auth.mode === 'rdm' ? 'RDM REST API' : 'Direct SOAP'}`);
  console.log(`API key: ****${(auth.apiKey || auth.token || '').slice(-4)}`);
  console.log(`Schedule file: ${SCHEDULE_FILE || '(none)'}`);
  console.log();

  logger.logStartup(Object.keys(crossingsConfig), crossingsConfig);

  // Load CORPUS before schedule so CIF parsing can resolve TIPLOC names.
  // Awaiting keeps the order correct; ~770KB gzipped → typically sub-second.
  await loadCorpus();

  // Load schedule (non-blocking — LDB starts immediately). Once the full-parse baseline is in place,
  // check for a newer UPDATE than the full on disk (it is newer if that full is from before this
  // morning's publication, e.g. a restart after a failed 04:00 download).
  loadSchedule()
    .then(() => refreshScheduleUpdate())
    .catch(err => console.error('Schedule load error:', err));

  // Daily refresh at 04:00 Europe/London (CORPUS, then CIF)
  scheduleDailyCifRefresh();

  // Timetable archive (cif-archive.js, log only): at startup once the schedule has loaded, then daily at
  // 04:30 London, after the 04:00 full download. A failure costs archive data, never predictions.
  scheduleCifArchive();

  // Start API server
  createApi(crossingStates, PORT);

  // Start TD feed listener and daily log rotation (additive — does not affect LDB/state path).
  // Route every TD sighting into each crossing-state so that CIF-sourced freight
  // predictions can be marked tdSeen=true once the train enters our area.
  // Rebuild today's first-sighting map before the feed starts, so a restart doesn't
  // resurrect trains that ran hours ago (see CrossingState.seedSightings).
  seedSightingsFromLog(crossingStates);

  // Each crossing takes only its own area's events (CrossingState.ownsTdArea) — berth codes
  // repeat across areas, so an unfiltered fan-out lets a distant train anchor a local closure.
  // Steps, cancels and interposes all arrive here, labelled; recordTdEvent decides what each
  // is worth.
  // A shadow engine gets each event too, as its own copy (engines.js).
  tdListener.on('berth', (s) => engines.berth(s));
  // The listener hears each crossing's td.area and, for a berth-first crossing, every area its
  // routes cross (td-paths.crossingTdAreas).
  tdListener.start({ areas: crossingTdAreas(crossingsConfig, routesById) });

  // Shadow logging (berth-first-v1-plan §3), only for crossings that have a shadow: both engines'
  // closures on change, checked every 5 s, and an hourly line per shadow.
  if (engines.shadowIds().length) {
    setInterval(() => engines.logClosureChanges(), 5000).unref();
    setInterval(() => engines.logShadowSummary(), 3600 * 1000).unref();
  }
  tdRotation.start();
  sclassRotation.start(); // bound + rotate the new S-Class logs alongside the TD logs
  // VSTP + TRUST, logged for berth-first replay (docs/berth-first-design.md §7). Log only.
  feedLogger.start();

  // Initial LDB poll
  await pollAll();

  // Poll every 30 seconds
  setInterval(pollAll, POLL_INTERVAL_MS);

  console.log(`\nPolling every ${POLL_INTERVAL_MS / 1000}s. Ctrl+C to stop.\n`);
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('\nShutting down...');
  process.exit(0);
});

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
