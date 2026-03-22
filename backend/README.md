# Rail Crossing Backend v2

Server-side prediction engine for level crossing barrier timing. Replaces the Cloudflare Worker with a richer multi-source architecture.

## Data sources

| Source | What it provides | Coverage |
|--------|-----------------|----------|
| **LDBSVWS** (Staff Version) | Real-time departure board data including non-stopping trains and ECS | Passenger + ECS |
| **CIF Schedule** | Timetabled paths including freight and test trains | All scheduled trains |
| **TD** (Phase 2) | Real-time berth-step data from track signals | Every physical movement |

## Quick start

```bash
cd backend
npm install

# Set your LDBSVWS Staff Version token
export NR_TOKEN_SV=your-token-here

# Optional: point to CIF schedule file for freight/ECS predictions
# export SCHEDULE_FILE=./data/schedule.json.gz

# Start
npm start
```

## API endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check (uptime, memory, crossing count) |
| `GET /crossings` | Summary of all crossings and their current state |
| `GET /crossing/:id` | Full state for a crossing (closures, trains, timing) |
| `GET /crossing/:id/closures` | Upcoming closure periods with train details |
| `GET /api?station=PLD` | Legacy compatibility endpoint |

## Deployment on VPS

```bash
# Clone and enter backend
git clone https://github.com/richbroad29/rail-crossing.git
cd rail-crossing/backend
npm install

# Set environment variables
echo 'NR_TOKEN_SV=your-token' > .env

# Start with pm2 (auto-restart, survives reboots)
pm2 start src/index.js --name rail-crossing
pm2 save
pm2 startup  # follow the instructions it prints
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NR_TOKEN_SV` | Yes | LDBSVWS Staff Version API token |
| `PORT` | No | API port (default: 3000) |
| `SCHEDULE_FILE` | No | Path to CIF JSON schedule file (.json or .json.gz) |

## Adding a new crossing

Edit `config/crossings.json` and add a new entry. You need:

1. **LDB station code** (CRS) and adjacent station codes
2. **TD berth IDs** from SMART data (Phase 2)
3. **TIPLOC sets** — stations on each side of the crossing
4. **Interpolation fractions** — where the crossing sits between timing points
5. **Timing parameters** — closeBefore, openAfter, consecutiveWindow

## Logs

Daily JSONL log files are written to `data/logs/`. Each line records:
- LDB poll results (trains seen, times, delays)
- State transitions (OPEN → CLOSING_SOON → CLOSED → OPEN)
- Schedule loads
- Phase 2: TD berth events with timestamps

These logs are the ground truth for calibrating timing parameters.
