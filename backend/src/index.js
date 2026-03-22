const fs = require('fs');
const path = require('path');
const { pollCrossing } = require('./ldb-poller');
const { parseScheduleFile } = require('./schedule-parser');
const CrossingState = require('./crossing-state');
const { createApi } = require('./api');
const logger = require('./logger');

// Load config
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'crossings.json');
const crossingsConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

// Environment
const NR_TOKEN_SV = process.env.NR_TOKEN_SV;
const PORT = parseInt(process.env.PORT || '3000', 10);
const SCHEDULE_FILE = process.env.SCHEDULE_FILE || '';
const POLL_INTERVAL_MS = 30000; // 30 seconds

// Validate
if (!NR_TOKEN_SV) {
  console.error('ERROR: NR_TOKEN_SV environment variable is required');
  console.error('Set it to your LDBSVWS (Staff Version) API token');
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
      const trains = await pollCrossing(id, config, NR_TOKEN_SV);
      crossingStates[id].updateLdbTrains(trains);
      console.log(`LDB ${id}: ${trains.length} trains, state=${crossingStates[id].state}`);
    } catch (err) {
      console.error(`LDB poll failed for ${id}:`, err.message);
    }
  }
}

// Load schedule data
async function loadSchedule() {
  if (!SCHEDULE_FILE) {
    console.log('No SCHEDULE_FILE set — skipping schedule data');
    console.log('Set SCHEDULE_FILE env var to path of CIF JSON file to enable freight/ECS predictions');
    return;
  }

  if (!fs.existsSync(SCHEDULE_FILE)) {
    console.warn(`Schedule file not found: ${SCHEDULE_FILE}`);
    return;
  }

  console.log(`Loading schedule from: ${SCHEDULE_FILE}`);
  try {
    const scheduleTrains = await parseScheduleFile(SCHEDULE_FILE, crossingsConfig);
    for (const [id, trains] of Object.entries(scheduleTrains)) {
      crossingStates[id].updateScheduleTrains(trains);
    }
  } catch (err) {
    console.error('Failed to load schedule:', err);
  }
}

// Startup
async function main() {
  console.log('=== Rail Crossing Backend v2 ===');
  console.log(`Crossings: ${Object.keys(crossingsConfig).join(', ')}`);
  console.log(`Port: ${PORT}`);
  console.log(`Staff Version token: ${NR_TOKEN_SV ? '****' + NR_TOKEN_SV.slice(-4) : 'NOT SET'}`);
  console.log(`Schedule file: ${SCHEDULE_FILE || '(none)'}`);
  console.log();

  logger.logStartup(Object.keys(crossingsConfig), crossingsConfig);

  // Load schedule (non-blocking — LDB starts immediately)
  loadSchedule().catch(err => console.error('Schedule load error:', err));

  // Start API server
  createApi(crossingStates, PORT);

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
