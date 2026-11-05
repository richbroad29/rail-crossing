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

---

# Phase 2 — real track, smooth movement, TRUST

Phase 1 is live (service `rail-map` on the VPS, page at railcrossing.uk/map). Phase 2 is additive:
every phase-1 field keeps its meaning; new fields are optional to old clients.

## 8. Track pack (built offline, loaded by the service)

`map-service/track/` holds the builder. **Input:** Geofabrik's UK extract (`united-kingdom-latest.osm.pbf`,
~2.3 GB) plus NaPTAN and SMART. **Output:** one versioned file `track-pack-<yyyymmdd>.bin` (+ a small
JSON manifest with the source dates, counts and a SHA-256), produced by `node track/build.js`.
It runs on a Mac or a GitHub Actions runner, never on the VPS. The VPS downloads the published file.

- **Graph:** OSM `railway=rail` (and `light_rail` where it carries Network Rail services), split at
  junctions. Nodes = junctions/ends; edges = track sections with their true polyline (simplified
  to ≤ 2 m deviation), length in metres, `usage`/`service` (main, branch, siding, yard, crossover),
  electrification, `maxspeed` where tagged, line name/ref where tagged. Disconnected fragments
  under 200 m are dropped.
- **Station snaps:** for each NaPTAN rail station (by TIPLOC) the nearest point on a non-siding
  edge within 300 m, per platform track where OSM separates them; unsnapped stations listed.
- **Network overview:** a simplified national line layer (main + branch, ≤ 50 m deviation) as
  GeoJSON, served by the service at `GET /map/v1/network` (≈1–3 MB gz, `Cache-Control: public,
  max-age=86400`, `ETag` = pack hash). The page draws it below zoom 8, where the base tiles have
  no rail.
- **Runtime library** `map-service/src/track/`: load the pack into typed arrays (memory budget for
  the loaded pack: **≤ 40 MB RSS**), `nearestOnTrack(lat, lon, opts)`, `route(fromSnap, toSnap,
  {avoidSidings})` (A* by length), `slice(route, d0, d1)` → polyline, `pointAt(route, d)` →
  `{lat, lon, bearing}`.
- Licence: OSM data is ODbL. The pack and the network layer are derived databases: credit
  "© OpenStreetMap contributors" wherever they are shown, and keep the builder public.

## 9. Berths on the track (service)

Every berth the model knows gets a **span**: a polyline along the track graph from where trains
enter it to where they leave it, for its most common (previous berth → this berth → next berth)
path. Rules, in order:
1. Station-anchored berths (SMART) are pinned to the station's snap point; arrival berths END at
   the platform stop point, departure berths START there.
2. Between two pinned points, `route()` gives the path; the berths in between are cut from it in
   proportion to their **learned median transit time** for non-stopping trains (§10), falling back
   to equal shares until learned.
3. Where OSM tags a signal with a `ref` that matches the berth id within the same TD area, pin the
   boundary there (validate per area; report the match rate).
4. Spans get stable ids `sp_<hash>` and are recomputed when learning changes a berth materially
   (> 10 % of its length); the id changes then.
`GET /map/v1/span/:id` → `{id, length, path: [[lat, lon], …], stop: metresAlong | null}`
(immutable per id: `Cache-Control: public, max-age=604800, immutable`).

## 10. Learned transit times (service)

Per berth, per class (`express`/`stopping`/`ecs`/`freight`/`other` from the headcode) and per
behaviour (`calls` here / `passes`), a bounded streaming estimate of time-in-berth: median and
p10/p90 over the last 200 samples (ring buffer), persisted to `MAP_DATA_DIR` hourly and on SIGTERM.
Whether a train calls in a berth comes from its matched schedule (CIF/VSTP + TRUST) and the
berth's SMART station. Outliers > 30 min are excluded (held trains).

## 11. Motion plans (wire)

`Train` gains, when the berth has a span:
```
mv: { sp: "sp_3f9a", t0: <epoch ms the train entered the berth>, eta: <expected exit, epoch ms>,
      stop: metresAlong | null, dwell: secs | null, held: bool }
```
- `t0` is the **signalling time** of the step (TD `time`), not receive time.
- `eta` = `t0` + learned median for this train's class/behaviour (with `dwell` included when it calls).
- `held: true` once `now > eta + max(30 s, p90 − median)` with no step: the train is waiting.
- Trains without a span keep phase-1 `lat/lon` only.

## 12. Client motion (page) — the anti-jump rules (brief §"Continuous movement")

- Render clock = server clock − **10 s** (configurable). Position = function of render time along
  the current span: constant speed for a pass; decelerate → dwell at `stop` → accelerate for a call.
- Never pass the span end before the next step is known: ease to a stop ~30 m short and wait.
- On the next step: re-time the remaining distance so the train reaches the boundary at the step's
  `t0` (it usually arrives inside the 10 s window, so this is a gentle speed change).
- Step known late (train drawn behind): catch up at ≤ 1.5× current speed; never move backwards;
  if > 2 km off, fade out and in.
- Identity continuity (renumbering, area handover) is already the same `id`: keep the object.
- **Replay harness** (`map/test/motion-replay.js`): runs recorded service output (§13) through
  the same motion code and reports: share of steps absorbed by re-timing alone, catch-up speeds,
  backward moves (must be 0), fades per train-hour. Targets: ≥ 90 %, ≤ 1.5×, 0, < 0.1.

## 13. Recording for the harness

`GET /map/v1/debug/record?secs=600&bbox=` (loopback only, never through Caddy): streams the
service's own update events as JSONL for the harness. The service also keeps a rolling 1-hour
JSONL of updates for the Sussex box in `MAP_DATA_DIR/record/` (bounded, rotated).

## 14. TRUST and VSTP (service)

- Own STOMP subscriptions to `/topic/TRAIN_MVT_ALL_TOC` and `/topic/VSTP_ALL` on the existing
  connection (same hardened client; separate subscription handlers isolated by try/catch).
- **Activation (0001):** `train_id`, `train_uid`, `schedule_start_date` → links a TRUST train to
  its exact schedule. A TD headcode matches a TRUST activation when the headcode equals
  `train_id[2..6)` and the TD area covers the activation's origin or a later movement's STANOX.
  Exact UID beats the phase-1 time match.
- **Movement (0003):** arrival/departure/pass at a STANOX → the schedule's calling point gets
  `actual`, `variation` (minutes, signed), `platform`; the train gets `late` (minutes) and
  `lastReport: {name, event, time}`.
- **Cancellation (0002) / reinstatement (0005) / change of origin (0006) / identity (0007):**
  applied to the train and its schedule.
- **VSTP:** Create/Delete merged into the day's index with the same STP rules as CIF.
- `Train.svc` gains `late` (signed minutes, absent if unknown) and `next: {name, time, exp}`
  (the next station and its booked and expected time — the details panel's top line).
- `GET /map/v1/train/:id` `service.calls[]` gains `actualArr/actualDep/actualPass`,
  `expArr/expDep` (booked + current lateness, never earlier than now), `platformActual`, `cancelled`.
- `GET /map/v1/station/:crs` → `{station, board: [{trainId|null, hc, uid, toc, o, d, kind:
  "arr"|"dep"|"pass", booked, expected, actual, platform, late, cancelled}], recent: [{hc, kind,
  time, late}]}`: next 2 h and last 30 min, freight and ECS included.

## 15. Done means (phase 2)

- Every placed train draws on real track at every zoom; the national view shows the network.
- The motion replay meets §12's targets on a recorded hour of the live Sussex box.
- TRUST: next station + time and lateness on every matched passenger train; station boards live.
- Memory: service ≤ 220 MB steady, ≤ 260 MB peak during the daily CIF refresh, measured on the VPS.

## 16. Phase 2 clarifications (lead, 2026-11-05)

- **Render lag** defaults to **12 s** (was 10). Measured on the noisy mock: 10 s absorbs 88.8% of
  steps, 12 s 92.7%, 15 s 95.0%. To be re-confirmed on a real recording before deploy.
- **"Absorbed"** (section 12 metric): between the step arriving and the train entering the new span,
  the drawn train neither stopped short at a signal nor hit the catch-up limit. Standing at a
  platform past its dwell is not waiting.
- **`mv.stop` on a departure berth** is `0` with `dwell: 0` ("starts standing here"), never null.
  On an arrival berth `stop` is the platform stop point. `null` means a constant-speed pass.
- **Catch-up limit** is ≤ 1.5× the span's cruise speed (length ÷ (eta − t0)), not the current
  speed, which is zero for a held train.
- **`svc.late`**: positive = late, negative = early, minutes.
- **`recentBerths[].sp`** (in `/train/:id`): the span id each recent berth was traversed on, so the
  trail follows the track.
- **Recording format** (`/debug/record` and the rolling record): JSONL lines `{t, event, data}`
  with `event` ∈ `snapshot`, `update`, `span`. The recorder emits a `span` line the first time a
  span id appears in a segment, so a recording replays with no network.
- **Network overview**: `GeoJSON LineStrings`, optional `properties.u` = `main` | `branch`.

## 17. Phase 2 fix round (lead, 2026-11-05)

**Why.** Real Sussex recordings gave 75 % absorbed and 6.4 fades per train-hour. Diagnosed from one hour of the live
record (`dev` tooling in the lead's notes; numbers are steps in that hour):

- **94 % of fades were gaps between consecutive spans**, not trains falling behind. 22 % of all steps entered a span
  that did not start where the last one ended. Causes, in order: (1) chains that meet at a station end and start at
  DIFFERENT snaps of it (one platform drawn as two OSM ways 138 m apart, e.g. Three Bridges); (2) a chain whose leading
  or trailing berths were already claimed by another chain cut its remaining berths over the WHOLE station-to-station
  route, stretching them (spans of 4 km run in 40 s, "speeds" over 100 m/s); (3) consecutive berths placed on
  different parallel tracks with no crossover in reach; (4) SSE batching: a train that steps twice in one second
  reaches the page with a berth missing, so a join computed from the service's own "previous berth" is wrong for it.
- **"Capped" steps were mostly not catch-up.** The limit was measured against the cruise speed of the train's own
  span while the reference was already running in the next, faster span (median 2.3x faster). Timing accuracy was
  fine: capped steps had actual/predicted transit 0.97 at the median.
- Rejected after measuring: braking early for an unknown step (a 30 s delay only reached 83 %), reference profiles
  that start at the entry speed (no change).
- A prototype of 17.1-17.3 on the same hour: fades 6.35 -> 0.26 per train-hour, absorbed 74.5 % -> 88.8 % at 12 s,
  backward 0, catch-up <= 1.5x, acceleration bound held. Delay sweep: 10 s 87.5, 12 s 88.8, 16 s 90.2, 20 s 91.7 %.

### 17.1 Continuation spans (service, page, recorder)

`GET /map/v1/span/:id?after=:prev` returns a span for the same berth as `:id` that STARTS exactly where span `:prev`
ends (its last point, heading the way `:prev` runs) and ends where `:id` ends. Same body as `/span/:id`
(`{id, length, path, stop}`), its own stable id `sp_<hash>` of `(:prev, :id)`, immutable cache headers. That id also
resolves on a plain `GET /span/<id>` and may itself be an `:prev` (trains chain continuations).

- **How it is routed, in order:** (a) the shortest route from `:prev`'s end, travelling the way `:prev` travels, to
  `:id`'s end, travelling the way `:id` travels, no reversing, within `2 x length(:id) + 500 m`; (b) the same from
  `:prev`'s end to the nearest reachable point within 120 m of `:id`'s end on any non-siding track (stay on the
  train's own track); (c) straight on from `:prev`'s end along the track (at each node the edge with the smallest turn,
  never a siding or yard, never over 100 degrees) for `length(:id)`. The track library's `route()` gains an optional
  `dir` on a snap (0 = towards increasing edge offset, 1 = decreasing) to make (a) and (b) directed.
- `stop`: null when `:id`'s is null; 0 when `:id`'s is 0; otherwise the continuation's length (an arrival ends at its
  stop point).
- When `:prev`'s end is within 2 m of `:id`'s start, the answer is `:id` itself (its own id and body).
  Unknown `:prev` (evicted, never issued): `:id` itself, 200. Unknown `:id`: 404 as today.
- Bounded: at most `spans.maxJoins` (default 50 000) join records, LRU, each holding only `(prev, id, length, stop,
  end point, how)`; geometry is recomputed on demand and an evicted join is rebuilt from its two ids when asked.
  `/health` `diagnostics.spans.joins`: counts by how (`same`, `direct`, `beside`, `straight`, `fallback`).
- **The page** asks for a continuation whenever a new plan's span is attached and the previous plan's span is attached
  and they are more than 2 m apart: `span/<new sp>?after=<the span id the page actually drew the previous berth on>`
  (which may itself be a continuation id). Until the answer arrives the plan is not ready (the train waits at the wall,
  as for any span still loading); on an error it keeps the canonical span.
- **The recorder** (rolling records and `/debug/record`) writes what a page would fetch: per train, when the recorded
  `mv.sp` changes from P to S and S does not start within 2 m of P's end, a `span` line
  `{id: <continuation id>, after: P, of: S, length, path, stop}` before the line that references S. The replay harness
  resolves `(after, of)` from these lines exactly as the page would from the API.

### 17.2 Spans (service)

- A chain is cut over ALL its berths (claimed ones included, so the unclaimed ones get their true share of the
  route), and only its unclaimed berths are built from it. Claimed berths keep the span of the chain that claimed them.
- Cut weights: each berth's learned pass median where it has one, the mean of the chain's known medians where it has
  not, equal shares only when none is known. `rule.cutBy` gains `partial`.

### 17.3 Catch-up limit (page) — amends section 16

The limit is `cap x` the HIGHER of: the cruise speed of the train's own span, the cruise speed of the span it just
left (until it has slowed, as before), and the cruise speed of the span the REFERENCE is on when that is a later span.
The limit itself never falls faster than the braking bound (a speed the train was allowed a moment ago is shed at
`brk`, not cut in one frame). The harness measures catch-up against that same effective limit.

### 17.4 Departures (service) — amends section 16

On a departure berth (`stop: 0`) where the train calls, `dwell` is the seconds from `t0` until its expected
departure from that station (booked departure plus TRUST lateness when known; never negative; at most 3600), and
`eta = t0 + dwell + learned run time`. `dwell: 0` means it is due to leave now. Before this, a train standing
20-40 minutes at an origin crept along its departure span at under 1 m/s and faded when it really left.

### 17.5 Transit store (service)

At the cap, evict the least recently updated series instead of dropping new samples (live: the 60 000 cap filled in
12 h; 24 000 of the series had fewer than 5 samples). Store compactly enough that the national set (measure it: about
24 000 berths x their classes) fits with the service still <= 220 MB steady; report the series count and RSS after
24 h live.

### 17.6 Render delay — DECIDED: 12 s (Rich, 2026-11-05)

Swept on all six regions after 17.1-17.5 (respanned recordings): 10/12/14/16 s give sussex 88.3/89.2/89.6/90.4 %,
london 93.1/93.8/94.4/94.9 %, glasgow 87.1/88.0/88.5/89.5 %, manchester 78.2/79.6/80.5/81.6 % absorbed. Feed delay (step
to service emit) is p50 1.2 s, p95 ~2 s in every region, so a longer delay buys little: what is left is prediction error
and genuinely slow trains, not late data. Each extra second makes every train a second staler (~27 m at 60 mph).

## 18. Fix round 2 (lead, 2026-11-05)

### 18.1 The absorbed metric — DECIDED (Rich, 2026-11-05)

A step is **slower than predicted** when the train left the berth (the next step's t0) later than the plan's `eta` by MORE
than the render delay. No motion code could have known in time, so waiting at the wall for it is not a defect. The harness
reports these separately and the 90 % target is measured on the other steps:
`absorbed = absorbed steps / (all steps - slower-than-predicted steps that waited)`. It also reports the raw share, and
calls them "slower than predicted", never "held": TD shows only that the train was slow, not why.

The harness also counts a **re-appearance** as a fade: a train already drawn on the track that leaves track mode and comes
back (re-init) fades in, which the viewer sees exactly like a fade.

### 18.2 Impossible spans (service)

Live respans showed 86 canonical spans over 4 km, up to 32.8 km for one berth (XA:0633, 285 m/s implied): a chain walk that
crosses unobserved berths gives one berth the whole station-to-station route. A berth gets NO span (its trains keep phase-1
positions) when its span length divided by its learned pass median, or the chain's route length divided by the sum of the
chain's medians, exceeds `spans.maxImpliedMps` (default 60 m/s, a little over 125 mph). Report the count by TD area in
`diagnostics.spans`. Measure on the respanned recordings how many fades it removes and how many steps lose track mode.

### 18.3 Stay at the platform until it has left (service)

A departure plan (17.4) must not run out of the platform on the clock alone. While the train has neither a TRUST departure
report from that station nor a step out of the berth, the service re-issues its `mv` with the dwell extended (in steps of
`motion.departExtendSecs`, default 30 s) BEFORE the current departure time is reached (the page renders 12 s behind, so an
extension issued at the departure time itself arrives in time). A TRUST departure report ends the extension: dwell = reported
departure time - t0. The page needs no change: a same-berth re-issue already updates dwell and eta.

### 18.4 Later (phase 3)

Darwin forecast departure times replace "booked + TRUST lateness" as the expected departure where Darwin has a forecast
(they include delays announced before a train moves, which TRUST cannot).

