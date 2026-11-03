# map-service

The live train map's back end (see the brief, "UK Live Train Map brief", and `docs/CONTRACT.md`, which
is binding). A separate service from the Portslade crossing back end on `backend-v2`: its own process,
its own Network Rail connection, its own data folder. Nothing in here imports from `backend/`.

Current state: **phase 1** (national, station-anchored positions). `phase0/` keeps the read-only
check scripts that proved the data; `src/` is the service.

## Run it (real)

```
cd map-service && npm ci
MAP_ENV_FILE=~/rail-crossing/backend/.env MAP_DATA_DIR=~/rail-map-data PORT=3100 \
  node --max-old-space-size=192 bin/rail-map.js
```

Production: `deploy/rail-map.service` (systemd; `MemoryMax=300M`, `Nice=10`). It binds 127.0.0.1 only;
Caddy fronts it. The first start downloads SMART, CORPUS, NaPTAN and the CIF into
`$MAP_DATA_DIR/ref/` (about a minute); the next start loads what is on disk and refreshes only what is
due. `GET /map/v1/health` says `starting` until placement data is loaded.

## Run it (fake, no credentials, no network)

```
node dev/fake-nrod.js --mode=replay --file=/path/td-2026-11-01.jsonl --speed=60      # or --mode=synthetic --smart=/path/smart-latest.json.gz --rate=50
node bin/rail-map.js --fake=127.0.0.1:61613 --ref-dir=/path/to/reference/files       # smart-latest.json.gz, corpus-latest.json.gz, naptan-rail.csv, optional cif-latest.json.gz
```

Fake mode is loopback-only, reads the reference folder read-only, never downloads and never reads the
credentials file. `PORT=3100` is the default; the page uses `?api=http://localhost:3100`.

## Test

`npm test` (offline; `node:test`). Tests that need the big real reference files skip themselves when
`/Users/richandanna/rail-map-refdata` (or `$MAP_REFDATA`) is absent. Tools in `dev/`:

| Script | What it does |
| --- | --- |
| `dev/fake-nrod.js` | local STOMP server: synthetic national TD, or replay of a TD log |
| `dev/replay-report.js` | replays a log through the real service, reports placed / unplaced and spot-checks against SMART |
| `dev/mutation-check.js` | breaks one rule at a time and checks the tests notice |
| `dev/gen-cif.js` | a realistic full-size synthetic CIF |
| `dev/measure-memory.js` | RSS / heap / CPU of the real process under national load |
| `dev/measure-refresh.js`, `dev/measure-cif.js` | the daily CIF refresh, the worst moment for memory |
