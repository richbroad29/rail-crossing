# Rail Crossing Backend v2

Server-side prediction engine for level crossing barrier timing. Replaces the
Cloudflare Worker with a richer multi-source architecture. Deployed on the
Oracle Cloud VPS under systemd (`rail-crossing.service`) behind Caddy.

## Data sources

| Source | What it provides | Coverage |
|--------|-----------------|----------|
| **LDBSVWS** (Staff Version, via RDM REST) | Real-time departure board data including non-stopping trains and ECS | Passenger + ECS |
| **CIF Schedule** (NROD, daily) | Timetabled paths including freight and test trains | All scheduled trains |
| **CORPUS** (NROD) | TIPLOC → display-name map for resolving CIF origin/destination | Reference data |
| **TD** (STOMP, area LA) | Real-time berth-step sightings | Every physical movement |

TD is **partially joined** into predictions: each sighting drives the late-minute
lock for Q-freight (`tdSeen`/`tdSeenAt`) and the clear-step-anchored OPEN. Full
per-berth confidence-tier narrowing (`tdBerth`) is still pending.

## Quick start

```bash
cd backend
npm install
cp .env.example .env   # then fill in the values below

npm start
```

See `.env.example` for the full list. At minimum set `RDM_API_KEY` (LDBSVWS) and
`NR_FEED_USER`/`NR_FEED_PASS` (the single NROD login for CIF + CORPUS + TD).

## API endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check (uptime, memory, crossing count) |
| `GET /crossings` | Summary of all crossings and their current state |
| `GET /crossing/:id` | Full state for a crossing (closures, trains, timing) |
| `GET /crossing/:id/closures` | Upcoming closure periods with train details |
| `GET /crossing/:id/live` | B1 live train positions in area LA (feeds the observer app) |

## Deployment on VPS

The service runs under **systemd**. Canonical deploy sequence (run on the VPS
once `backend-v2` is pushed to origin — pushing does NOT make changes live):

```bash
cd ~/rail-crossing
git rev-parse HEAD                          # note this — rollback point
git fetch
git log HEAD..origin/backend-v2 --oneline   # review incoming commits
git merge --ff-only origin/backend-v2       # fast-forward only, never reset --hard
sudo systemctl restart rail-crossing        # ~90s reparse on boot
sudo systemctl status rail-crossing --no-pager
```

Rollback: `git reset --hard <HEAD-from-step-1> && sudo systemctl restart rail-crossing`.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `RDM_API_KEY` | Yes (or `NR_TOKEN_SV`) | LDBSVWS consumer key (RDM REST) |
| `NR_TOKEN_SV` | Alternative | LDBSVWS SOAP token (fallback if no `RDM_API_KEY`) |
| `NR_FEED_USER` | Yes | NROD login — CIF SCHEDULE + CORPUS + TD STOMP |
| `NR_FEED_PASS` | Yes | NROD password |
| `PORT` | No | API port (default: 3000) |
| `SCHEDULE_FILE` | No | Override CIF schedule file path (else auto-downloaded) |

## Adding a new crossing

Edit `config/crossings.json` and add a new entry. You need:

1. **LDB station code** (CRS) and adjacent station codes
2. **TD berth IDs** from SMART data (approach/clear per direction)
3. **TIPLOC sets** — stations on each side of the crossing
4. **Interpolation fractions** — where the crossing sits between timing points
5. **Timing parameters** — closeBefore, openAfter, openLagSecs, consecutiveWindow

## Logs

Daily JSONL log files are written to `data/logs/` (gitignored). Each line records:
- LDB poll results (trains seen, times, delays)
- State transitions (OPEN → CLOSING_SOON → CLOSED → OPEN)
- Schedule loads
- TD berth-step sightings with timestamps (raw feed in `data/logs/td/`)

These logs are the ground truth for calibrating timing parameters.
