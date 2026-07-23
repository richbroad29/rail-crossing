const fs = require('fs');
const path = require('path');
const { pollCrossing } = require('./ldb-poller');
const { parseScheduleFile, applyUpdateExtract } = require('./schedule-parser');
const CrossingState = require('./crossing-state');
const { createApi } = require('./api');
const logger = require('./logger');
const tdListener = require('./td-listener');
const tdRotation = require('./td-rotation');
const sclassRotation = require('./sclass-rotation');
const cifFetcher = require('./cif-fetcher');
const corpusFetcher = require('./corpus-fetcher');
const { computeRunRates } = require('./run-rate');
const { parseLondonWallClock, londonDateStamp } = require('./time-utils');

// Load config
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'crossings.json');
const crossingsConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

// Environment
const RDM_API_KEY = process.env.RDM_API_KEY;       // RDM consumer key (preferred)
const NR_TOKEN_SV = process.env.NR_TOKEN_SV;       // Direct SOAP token (alternative)
const PORT = parseInt(process.env.PORT || '3000', 10);
const SCHEDULE_FILE = process.env.SCHEDULE_FILE || '';
const POLL_INTERVAL_MS = 30000; // 30 seconds
const UPDATE_INTERVAL_MS = 3600000; // 1 hour — daily UPDATE extract apply cadence

// Last full-parse result (per crossing), annotated with run-rates. The hourly
// UPDATE-extract apply overlays onto a clone of this, so each application is
// idempotent from a clean baseline. Null until the first full parse completes.
let baseScheduleByCrossing = null;

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

// Create state objects for each crossing
const crossingStates = {};
for (const [id, config] of Object.entries(crossingsConfig)) {
  crossingStates[id] = new CrossingState(id, config);
  console.log(`Crossing registered: ${id} (${config.name})`);
}

// LDB polling loop
async function pollAll() {
  for (const [id, config] of Object.entries(crossingsConfig)) {
    try {
      const trains = await pollCrossing(id, config, auth);
      crossingStates[id].updateLdbTrains(trains);
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
function annotateRunRates(scheduleByCrossing) {
  const headcodeToDaysPattern = new Map();
  for (const trains of Object.values(scheduleByCrossing)) {
    for (const t of trains) {
      if (t.runsAsRequired && t.headcode) {
        headcodeToDaysPattern.set(t.headcode, t.daysPattern || '');
      }
    }
  }
  if (headcodeToDaysPattern.size === 0) return;

  const rates = computeRunRates(headcodeToDaysPattern);
  for (const trains of Object.values(scheduleByCrossing)) {
    for (const t of trains) {
      if (!t.runsAsRequired || !t.headcode) continue;
      const r = rates[t.headcode];
      if (!r) continue;
      t.recentRunRate = r.rate;
      t.recentRunSeen = r.seen;
      t.recentRunApplicable = r.applicable;
    }
  }
  const summary = Object.entries(rates).map(([h, r]) =>
    `${h}=${r.applicable > 0 ? Math.round(100 * r.rate) + '%' : 'n/a'}(${r.seen}/${r.applicable})`
  ).join(' ');
  console.log(`Run-rate scan (${headcodeToDaysPattern.size} Q-freight headcodes): ${summary}`);
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
    for (const [id, trains] of Object.entries(scheduleTrains)) {
      crossingStates[id].updateScheduleTrains(trains);
    }
  } catch (err) {
    console.error('Failed to load schedule:', err.message);
  }
}

// Fetch the daily UPDATE extract and overlay it on the last full parse, so a
// same-day STP=C cancellation suppresses that train within the hour without
// waiting for the next 04:00 full re-download. Non-fatal: on any failure we
// keep the current predictions.
async function refreshScheduleUpdate() {
  if (!baseScheduleByCrossing) return; // no full-parse baseline yet
  let updateFile;
  try {
    const res = await cifFetcher.downloadCifUpdate();
    updateFile = res.path;
    console.log(`CIF update: downloaded ${res.bytes} bytes (toc-update-${res.day})`);
  } catch (err) {
    console.error('CIF update download failed (keeping current predictions):', err.message);
    return;
  }
  try {
    const { trains } = await applyUpdateExtract(updateFile, crossingsConfig, baseScheduleByCrossing);
    annotateRunRates(trains);
    for (const [id, t] of Object.entries(trains)) {
      crossingStates[id].updateScheduleTrains(t);
    }
  } catch (err) {
    console.error('CIF update apply failed (keeping current predictions):', err.message);
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
      for (const [id, t] of Object.entries(trains)) {
        crossingStates[id].updateScheduleTrains(t);
      }
      console.log('CIF refresh: in-memory schedules updated');
    } catch (err) {
      console.error('CIF refresh failed (keeping previous data):', err.message);
    }
    // Schedule next 24h out
    setTimeout(tick, 24 * 3600 * 1000);
  }, ms);
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

  // Load schedule (non-blocking — LDB starts immediately). Once the full-parse
  // baseline is in place, apply the daily UPDATE extract straight away so any
  // already-issued same-day cancellations take effect at startup.
  loadSchedule()
    .then(() => refreshScheduleUpdate())
    .catch(err => console.error('Schedule load error:', err));

  // Re-apply the UPDATE extract hourly to pick up same-day STP=C cancellations
  // (and overlays) without waiting for the 04:00 full re-download.
  setInterval(() => {
    refreshScheduleUpdate().catch(err => console.error('Schedule update error:', err));
  }, UPDATE_INTERVAL_MS);

  // Daily refresh at 04:00 Europe/London (CORPUS, then CIF)
  scheduleDailyCifRefresh();

  // Start API server
  createApi(crossingStates, PORT);

  // Start TD feed listener and daily log rotation (additive — does not affect LDB/state path).
  // Route every TD sighting into each crossing-state so that CIF-sourced freight
  // predictions can be marked tdSeen=true once the train enters our area.
  tdListener.on('sighting', (s) => {
    for (const state of Object.values(crossingStates)) {
      state.recordTdSighting(s.headcode, s.ts);
      state.recordTdBerth(s); // B1: feed the live-position map (berth in payload)
      state.recordTdClearStep(s); // TD-triggered open: anchor closure end to the crossing clear step
      state.recordTdCloseStrike(s); // TD-triggered close: anchor closure start to the approach strike-in
    }
  });
  tdListener.start();
  tdRotation.start();
  sclassRotation.start(); // bound + rotate the new S-Class logs alongside the TD logs

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
