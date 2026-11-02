# Live train map — engineering contract

The binding interface between the map **service** (`map-service/`) and the map **page** (`map/`).
Both sides build to this file. A change to it is made here first, by the lead, never silently by
one side. Product intent is in the brief ("UK Live Train Map brief"); this file is the how.

Phase status: **phase 1** (separate service, national, station-anchored positions). Fields marked
*phase 2+* are reserved: don't use the names for anything else.

## 1. Ground rules

- **Never harm the crossing service (goal 1 of the whole project).** The map service is its own
  process, own systemd unit, own Network Rail connection, own data folder. It never imports from
  `backend/`, never writes outside `MAP_DATA_DIR`, and reads the crossing service's files only
  where this contract says so (the credentials file, read-only).
- **Measured facts from the real VPS (2026-11-02):** Oracle `VM.Standard.E2.1.Micro`-class box,
  x86_64, 2 vCPU, 952 MB RAM, ~567 MB available, Node **20.20.1**, no C compiler (so **no native
  npm modules**: no sqlite, no bcrypt). The crossing service's RSS is ~70 MB.
- **Memory budget for the map service:** steady-state RSS ≤ 220 MB; it runs with
  `--max-old-space-size=192` under systemd `MemoryMax=300M`. Design data structures for that.
- **Node 20, CommonJS, `'use strict'`, no build step.** Dependencies: `stompit@1.0.0` only, unless
  the lead agrees another. Tests use `node:test` and run offline.
- **Real reference data for development** (not committed; copy what you need into fixtures, keep
  fixtures small): `/Users/richandanna/rail-map-refdata/` holds the real SMART file
  (34,298 rows, 194 TD areas), CORPUS, NaPTAN rail stations CSV (2,768 rows), the phase-0 anchor
  table, and one real day of TD area LA (`td-2026-11-01.jsonl`, the crossing service's log format).

## 2. Phase-0 findings this builds on

- SMART reads as documented: `{"BERTHDATA":[…]}`; for a station step, an **arrival** (EVENT A/C)
  puts the station at the step's **TOBERTH**, a **departure** (B/D) at its **FROMBERTH** — 92% of
  3,868 station groups agree, the reverse reading 1%. Southwick lands in LA 0006 as known.
- 7,591 berths in 188 TD areas anchor to a station; the Sussex box has 317 anchored berths at 101
  of its 103 stations.
- NaPTAN rail stations (`ATCOCode` `9100<TIPLOC>`) resolve 99% to a TIPLOC CORPUS knows. Use
  NaPTAN as the **primary** station-coordinate source (by TIPLOC), with
  `map-service/data/stations.json` (by CRS) as the fallback.
- TD message rules verified on the real feed: **CA** step (`from`→`to`), **CB** cancel (`from`
  only), **CC** interpose (`to` only). stompit 1.0.0 crashes on short text ERROR frames — use the
  hardened wrapper from `map-service/phase0/lib/stomp.js` (promote a copy into `src/`).

## 3. Service layout

```
map-service/
  package.json                 the service's own (phase0/ keeps its own)
  bin/rail-map.js              entry point
  config/default.json          tunables (region box, TTLs, intervals, limits)
  src/                         the service
  test/                        node:test, offline
  dev/                         local tools: a fake NROD server, a replay of a TD log
  deploy/rail-map.service      systemd unit (the lead installs it)
```

Environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAP_ENV_FILE` | `~/rail-crossing/backend/.env` | Read **literally and read-only** for `NR_FEED_USER` / `NR_FEED_PASS` (the password contains `$`; reuse `phase0/lib/env.js` parsing) |
| `MAP_DATA_DIR` | `~/rail-map-data` | Everything the service writes: downloads, learned state, logs |
| `PORT` | `3100` | HTTP, bound to `127.0.0.1` only (Caddy fronts it) |

Reference data the service maintains itself in `MAP_DATA_DIR` (atomic temp-then-rename downloads,
the phase-0 `download.js` rules — auth on the first hop only, bounded timeouts):

| Data | Source | Refresh |
| --- | --- | --- |
| SMART | NROD `SupportingFileAuthenticate?type=SMART` | daily 04:40 London |
| CORPUS | NROD `…?type=CORPUS` | daily 04:40 |
| NaPTAN rail stations | `https://naptan.api.dft.gov.uk/v1/access-nodes?dataFormat=csv&atcoAreaCodes=910` (public) | weekly |
| CIF timetable | NROD `CifFileAuthenticate?type=CIF_ALL_FULL_DAILY&day=toc-full` (~120 MB gz) | daily 04:50 (after the crossing service's 04:00 load, so the two never parse at once) |

The CIF parse is **streamed** and keeps a compact index of today's (and, before 05:00, yesterday's)
schedules: per schedule its UID, STP, headcode, operator, category, power type, timing load,
speed, and its calling/passing points as `[tiplocId, arr, dep, pass, platform]` with interned
TIPLOC ids and minutes as integers. Stay inside the memory budget; measure it and say so.

## 4. The model

**Occupancy** is the state: `area:berth → trainId`. A **train** is an object with a stable,
opaque `id` (not the headcode). Identity rules:
- CA moves the train from `from` to `to`.
- CB clears the berth; the train is kept for 120 s as "recently cancelled" with its last key.
- CC creates or re-attaches a train:
  - same berth, recently cancelled train → **renumbering**: same `id`, new headcode, the old one
    kept in `previousHeadcodes`;
  - another area, same headcode, cancelled or last stepped ≤ 90 s ago → **handover**: same `id`,
    and the graph learns the edge;
  - otherwise a new `id`.
- A train with no event for `maxIdleSecs` (default 2700) is dropped.

**Placement** (phase 1 — the proof-of-concept algorithm, made national and correct): SMART anchors
under the reading above; the berth graph learned from live steps (edge usable after 2 sightings,
SMART edges trusted) and from handovers, persisted to `MAP_DATA_DIR`; unanchored berths placed by
hop count between the nearest anchored berths behind and ahead (distinct stations); one-sided →
`approx`. An unplaceable berth is counted, never drawn. *Phase 2* replaces straight chords with the
OpenStreetMap track model and adds motion plans.

**Service match** (headcode → schedule) for phase 1: same headcode, a schedule active today whose
route passes a timing point in the train's current TD area (area ↔ TIPLOC from SMART STANOX ↔
CORPUS), choosing the one whose booked time at the nearest such point is closest to now, within
45 minutes. No match → no `service` (never a guess). *Phase 2* adds TRUST activation (exact UID).

## 5. HTTP API — `api.railcrossing.uk/map/v1/…` (Caddy strips nothing; the service serves `/map/v1/*`)

All JSON responses: `Content-Type: application/json`, gzip when the client accepts it, no
`Access-Control-*` headers (Caddy adds CORS). Times are **epoch milliseconds** unless named `…Time`
(then `HH:MM` London wall clock). Coordinates `[lat, lon]` rounded to 5 dp.

### `GET /map/v1/health`
`{status: "ok"|"degraded"|"starting", uptimeSecs, rssMB, heapMB, feeds: {td: {connected, lastMessageAt, staleSecs, messagesPerMin}}, reference: {smart: {rows, loadedAt}, corpus: {...}, naptan: {...}, cif: {schedules, loadedAt}}, model: {trains, placed, unplaced, anchoredBerths, learnedEdges}, clients: {sse}}`

### `GET /map/v1/trains?bbox=S,W,N,E`
Every placed train inside the box (whole GB if omitted). Response:
`{serverTime, feedStale: bool, trains: [Train]}`. Cache-Control `no-store`.

`Train` (compact; the page derives everything else):
```
{
  id: "t8f2k",                 stable across steps, renumbering and area handovers
  hc: "1H15",                  current headcode (TD description)
  lat, lon,                    placed position
  hdg: 92 | null,              degrees from north, null if unknown
  area: "LA", berth: "0004",
  at: 1793600000000,           when it entered this berth (feed time)
  pl: "s" | "i" | "a",         placement: station / interpolated / approx
  svc: {                       present only on a confident match
    uid, toc: "SN", o: "Littlehampton", d: "London Victoria",
    dep: "09:30", arr: "11:15", cat: "OO", pwr: "EMU", load: "377"
  }
}
```

### `GET /map/v1/stream?bbox=S,W,N,E`  (Server-Sent Events)
- On connect: `event: snapshot` with the same body as `/trains` for the box.
- Then, batched at most once per second: `event: update` `{serverTime, upsert: [Train], remove: [id]}`
  for trains entering, moving within or leaving the box.
- `event: ping` every 20 s. The client reconnects with a new bbox when the view moves (debounced
  ~400 ms); the server caps total SSE clients (`config.maxSseClients`, default 300) and returns
  503 when full, so the page falls back to polling `/trains` every 5 s.
- Zoomed out: if the bbox is larger than `config.coarseBboxDeg2`, updates are coalesced to one
  per 10 s.

### `GET /map/v1/train/:id`
Everything for the details panel:
`{train: Train, previousHeadcodes, firstSeenAt, recentBerths: [{area, berth, at}] (last 20),
trail: [[lat, lon, at], …] (last 15 min), service: {uid, stp, toc, headcode, category, power,
timingLoad, speedMph, origin: {name, time}, destination: {name, time},
calls: [{name, tiploc, arr, dep, pass, platform}]} | null, place: {kind: "station"|"between"|"near",
station?, between?: [a, b]}, speedMphEstimate | null}`. 404 when unknown.

### `GET /map/v1/stations?bbox=`
`{stations: [{tiploc, crs, name, lat, lon}]}`; Cache-Control `public, max-age=86400`.

### `GET /map/v1/search?q=`
Up to 20 hits: `{trains: [{id, hc, o, d}], stations: [{crs, name, lat, lon}]}` — headcode prefix,
station name or CRS.

### Errors
`{error: "<plain sentence>"}` with 400/404/503. Never a stack trace.

## 6. The page — `map/` (railcrossing.uk/map)

- MapLibre GL JS + **deck.gl** (UMD from unpkg, exact versions, SRI), **OpenFreeMap** vector tiles
  (no key; attribution "OpenFreeMap © OpenMapTiles Data from OpenStreetMap"). No build step.
- Phase 1 draws: stations; trains as train-shaped icons rotated to `hdg`, coloured by headcode
  class; headcodes from zoom 11; the details panel from `/train/:id`; search; class filters;
  share links (`#t=<id>` / `#s=<crs>`); light/dark; reduced motion.
- `?api=http://localhost:3100` for local development only (loopback hosts only).
- Talks to the API through one module, `map/api.js`, so the transport (SSE vs polling) can change
  without touching the rest.
- Unlisted: not linked from the home page until the lead says so.

## 7. Done means (phase 1)

- `npm test` passes on Node 20 and 22; a replay of the real LA day through the real service gives
  sensible positions for LA trains (checked against SMART anchors).
- The page runs against the service locally and against the fake, with no console errors, at
  390 px and desktop, light and dark.
- The service stays inside its memory budget with the national TD rate measured in phase 0.
