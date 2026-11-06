# Live train map — handover (2026-11-05)

Read this, then `map-service/docs/CONTRACT.md` (the binding engineering contract, sections 1–16),
then the repo's `CLAUDE.md`. Product intent is the Claude Doc "UK Live Train Map brief"
(https://claude.ai/artifact/4uDU8iPUc25NbHCk4MmC1k; read it with the Claude Docs tools).

## What exists

- **Branch `claude/map-service`** holds everything: `map-service/` (back end, track pack builder,
  phase-0 checks) and `map/` (the page). Only `map/` goes to `main` (GitHub Pages). Never merge
  `map-service/` into `main`; publish the page by copying `map/` + `scripts/bump-assets.sh` onto a
  branch from `origin/main` (see how `claude/map-page-publish` was made), and ask Rich before
  pushing `main`.
- **Live page:** railcrossing.uk/map is **phase 1** (unlisted, `noindex`) plus a tunnel fix
  (`main` at `d9c8c6e`). Phase 2's page is merged on the branch but NOT published.
- **Live service:** VPS `130.162.167.237` (`ssh -i ~/Downloads/ssh-key-2026-03-22.key ubuntu@…`),
  systemd unit `rail-map` (port 3100, `MemoryMax=300M`), code at `~/rail-map` (a detached git
  worktree of `~/rail-crossing`, now at `17d9a67`), data in `~/rail-map-data`. Caddy routes
  `api.railcrossing.uk/map/v1/*` to it (Caddyfile backup `/etc/caddy/Caddyfile.bak-20261103`).
  It reads NROD credentials read-only from `~/rail-crossing/backend/.env`. **The crossing service
  (`rail-crossing`, port 3000, `~/rail-crossing` on `backend-v2`) is goal 1 — never disturb it.**
  Deploy the map service: fetch + `git checkout --detach origin/claude/map-service` in
  `~/rail-map`, `npm ci --omit=dev` in `map-service/`, `sudo systemctl restart rail-map`, then
  check `/map/v1/health` and the crossing service's `/health`.
- **Track pack:** format 2, `~/rail-map-data/track/track-pack-20261102.{bin,manifest.json}`
  (copied by hand). Source build: `/Users/richandanna/rail-map-refdata/track-out-v2/`.
- **Monthly track rebuild — Rich decided to KEEP it (2026-11-05), and it is not active yet.** The
  GitHub Actions workflow `.github/workflows/track-pack.yml` (on `claude/map-service`) rebuilds the
  pack from the latest OpenStreetMap and NaPTAN data each month and publishes it as a GitHub Release;
  the service's track manager checks daily and swaps the new pack in. It only runs once the workflow
  file is on `main`, and it has never been run. To do: (1) confirm the builder emits format 2 (it
  should — `assemble.js` computes the derived index; the hand-copied pack was made with
  `track/upgrade.js`); (2) put ONLY the workflow file (and anything it needs that is not already on
  `main`) on a branch from `origin/main`, ask Rich, push; (3) run it once by manual dispatch, check
  the release has the `.bin` and manifest, and check the server picks it up (`/map/v1/health`
  `diagnostics.track`). Until then the service logs one harmless WARN a day: "no track-pack release
  … was found". Without it nothing breaks; the map just keeps the November 2026 track model.
- **Local reference data (not in git):** `/Users/richandanna/rail-map-refdata/` — SMART, CORPUS,
  NaPTAN CSV, real CIF, a real LA TD day, the 2.3 GB OSM extract, Node 20 binary at
  `node20/node_modules/node/node_modules/node-bin-darwin-arm64/bin/node` (the VPS runs Node
  20.20.1, x86_64, 952 MB RAM, no C compiler — no native npm modules).

## Phase status

| Phase | State |
| --- | --- |
| 0 prove the data | Done. SMART reading 92% vs 1%; 2nd NROD connection fine; TRUST + VSTP enabled and working. |
| 1 national map | Live. |
| 2 real track, motion, TRUST | LIVE 2026-11-06 (page `28e2b7d`, service `7090736`). Fades still above target: fix round 3. |
| 3 carriages | Not started. Rich has subscribed to Darwin Push Port + snapshots on RDM. |
| 4 enthusiast features, launch | Not started. |

## Publishing phase 2 (2026-11-06, lead) — PUBLISHED: `main` at `28e2b7d`, live 2026-11-06 ~17:50 UTC (rollback: revert it; previous `d9c8c6e`)

- **CONTRACT 19.1 DEPLOYED** 2026-11-06 ~15:25 UTC (VPS `~/rail-map` at `7090736`; rollback point `e81f499`). The bbox
  filters test a train's reach box (point + current and previous span), not its signalled point. Found by the browser
  check: zoomed in, 21-40 % (phone) of the trains drawn on screen were never sent. Now 0.6-1.4 %; the rest are trains drawn
  on continuations outside both spans' boxes (round 3: give joins a box).
- **Page fix `8efd21e`:** a stack of standing trains whose lowest id had no heading was not squared, so it drew as a cross
  (live Victoria: 15 trains, crossed in 480/480 samples -> 0).
- **Publish branch `claude/map-phase2-publish`** (worktree `/Users/richandanna/rail-crossing-publish`, commit `28e2b7d`):
  `origin/main` + `map/` from `claude/map-service` at `8efd21e`, re-stamped (token 202611061746). Nothing outside `map/` changes. Pushed on Rich's word; the RUNNING production page was checked in Chrome (engine.js + motion.js at that token, trains on the track, no console errors).
  To publish: `git -C /Users/richandanna/rail-crossing-publish push origin claude/map-phase2-publish:main`.
- Checked: page 219 tests + 28/28 mutations + fixture replay; browser `shots` all good; `phase2` all good except the
  Brighton "stacked" scenario (the mock's `stack=BTN` no longer puts the trains on one point: fix the scenario, not the page)
  and a marginal sequence frame (0.46 m vs 0.45, intermittent); `real.js` against the LIVE service through an ssh tunnel
  (`ssh -N -L 127.0.0.1:3110:127.0.0.1:3100 ...` + `map/dev/cors-proxy.js --target 127.0.0.1:3110`) all good.
- Seen live, round 3: junction areas (Clapham WI/XA/Q0) have most berths unspanned, so 18 of 29 trains there sit piled at
  the station point (same as phase 1); approximate (`pl` a) trains drawn in streets off the line (5c).

## Fix round 2 — LIVE RESULTS (2026-11-06, lead)

Six regions' LIVE recordings, 04:19-10:42 UTC 2026-11-06 (the morning peak; 36 segments each), copied to
`/Users/richandanna/rail-map-refdata/rec-live-20261106/` and scored with no respan by `map/dev/score-region.js`
(12 s delay, 18.1 harness). The recorder keeps only a rolling 6 h, so the overnight hours had already gone; copy more
down with `rsync -a -e "ssh -i ~/Downloads/ssh-key-2026-03-22.key" 'ubuntu@130.162.167.237:rail-map-data/record/' <that dir>/`
at least every 6 h if a full day is wanted.

| Region | train-h | steps | absorbed (target >= 90 %) | fades / train-h (target < 0.1) | gap / behind / re-appear | re-added (not counted) |
| --- | --- | --- | --- | --- | --- | --- |
| sussex | 426 | 11,944 | 93.3 % | 0.30 | 10 / 72 / 45 | 4 |
| london | 640 | 30,291 | 99.4 % | 0.24 | 53 / 27 / 71 | 1,044 |
| glasgow | 141 | 5,606 | 96.9 % | 0.24 | 0 / 8 / 26 | 0 |
| manchester | 118 | 3,090 | 92.6 % | 0.86 | 20 / 16 / 66 | 17 |
| cambrian | 18 | 138 | 92.3 % | 2.22 | 0 / 33 / 8 | 1 (tiny sample) |
| ecml-rural | 27 | 455 | 84.3 % | 0.58 | 0 / 11 / 5 | 0 (small sample) |

Backward 0, catch-up <= 1.50x, acceleration bound held, 0 teleports, everywhere. Service after 12 h: no WARN/ERROR in the
journal, RSS 175 MB, transit 80k series of its 100k cap, 0 evicted.

**Why the fades** (`map/dev/diag-fades.js`): the top five berths make 44-74 % of each region's fades, so round 3 is a list.
- **behind** (the reference jumps > 2 km ahead): every one is a plan that expected the train to be far SLOWER than it was;
  when the real step arrives the reference re-times into the next span. Manchester: all 16 at M3:0402, a departure berth
  whose 17.4 dwell (30-182 s) outlasts the real stand: the train has gone before the dwell ends. Glasgow: 7 of 8 at
  ED:0306 (3.8 km arrival span, dwell 60). Cambrian: MH:148C/151C departure dwells (120-149 s) too long. Sussex: TE:0432,
  TE:H002, A3:RY25 (long spans, 3.7-7.6 km, predicted 250-500 s). Only 14 of 167 behind fades are ECS.
- **holes** (re-appearance: the train passes berths with no span, drops to phase 1, fades back in): sussex X7:0112 x13,
  X7:1415 x9; manchester MP:B352, M3:0532, M3:0502; glasgow ED:0426, G1:5520.
- **gap** (consecutive spans not meeting, more than in the respan's 12): london CT:033C x25 (892 m) and Y9:1073/3107 (895 m),
  manchester M3:0582 x20 (279 m), sussex AD:0161 (2,076 m). Check these joins' `how` (probably `fallback`, see below).
- **re-added** (round 3 candidate 5a/5b, not in the fade count): London 1,044 in 640 train-h.

## Fix round 2 — DEPLOYED 2026-11-05 22:35 UTC (VPS `~/rail-map` at `e81f499`; rollback point `0161a0d`)

CONTRACT 18.1-18.5: the harness's headline excludes "slower than predicted" waits and counts re-appearances as fades;
impossible spans (> 60 m/s implied) are withdrawn (201 berths nationally, at most 12 per area); a departing train stays at
the platform until TRUST reports it left or it steps (extensions every 30 s, capped at 15 min); gap chains give spans to
unspanned berths between spanned ones (1,028 built nationally, half by the beside fallback); the recorder now follows the
page's ingest rule (it wrote the wrong continuation `after` when a train stepped twice in one second).
Six-region respan (state 2026-11-05 21:10), 12 s, 18.1 harness — round-1 build -> round-2 build:
fades per train-hour 0.94 -> 0.27 overall (sussex 0.66 -> 0.24, london 1.02 -> 0.18, glasgow 0.93 -> 0.11,
manchester 2.31 -> 0.84; rural samples too small); headline absorbed 95.1 -> 95.2 % (sussex 93.2, london 97.8,
glasgow 96.0, manchester 89.0). Backward 0, catch-up <= 1.5x, accel bound held. Remaining fades: 40 behind, 46
re-appearances, 12 gaps (11 continuations the service could not make when the previous span was itself a continuation:
`continuation()` returns `fallback`; worth a look). Fades still miss < 0.1 everywhere.
Live after deploy: 14,304 berths with spans, 208 impossible withdrawn, gap chains 1,047 built (respan predicted 1,028),
RSS 174 MB, transit store past the old 60k cap with no drops. NEXT: let it record ~24 h (rural regions need it), copy the
LIVE recordings down and score them directly with `map/test/motion-replay.js` (no respan: they carry continuation lines and
the 18.3 departure timing), report region by region, then ask Rich about publishing the phase 2 page. Round 3 candidates
are listed under "Next, in order" item 5 below.

## Fix round 1 — DONE 2026-11-05 (service deployed at 0161a0d)

Diagnosis, design and measured results are in CONTRACT section 17. Merged on `claude/map-service` and **the service is DEPLOYED** (VPS `~/rail-map` at `0161a0d`, 2026-11-05 21:45 UTC;
rollback point `cf74eaf`). The live recordings now carry continuation lines. The phase 2 PAGE is still not published. Service 283 tests, page 221 tests + 28/28 mutations, all on Node 20.

Scored by re-spanning every recording made so far with this build (`map-service/dev/respan.js --state=<saved VPS state>`)
and replaying through the new page harness. 12 s delay, before -> after:

| Region | train-h | absorbed | fades / train-h |
| --- | --- | --- | --- |
| sussex | 167 | 75.7 -> 89.2 % | 5.35 -> 0.23 |
| london | 115 | 77.2 -> 93.8 % | 8.11 -> 0.65 |
| glasgow | 26 | 74.1 -> 88.0 % | 7.79 -> 0.19 |
| manchester | 22 | 57.8 -> 79.6 % | 10.08 -> 1.13 |
| cambrian | 3 | 64.9 -> 81.6 % | 8.50 -> 2.29 (tiny sample) |
| ecml-rural | 4 | 84.6 -> 76.0 % | 26.7 -> 1.43 (tiny sample) |

Backward 0, catch-up <= 1.5x, acceleration bound held everywhere after (before: up to 146 m/s^2 frames). The "before" step
counts are inflated: the old engine emitted a step every frame while a gap fade overlapped a fade-in.
Delay sweep (after): 10/12/14/16 s -> sussex 88.3/89.2/89.6/90.4, london 93.1/93.8/94.4/94.9, glasgow 87.1/88.0/88.5/89.5,
manchester 78.2/79.6/80.5/81.6. Feed delay (step -> service emit) is the same everywhere: p50 1.2 s, p95 ~2 s.
The respan keeps recorded t0/eta, so the departure-dwell fix (17.4) is NOT in these numbers.

**Next, in order:**
1. **Oversized spans** cause most remaining fades (now "behind > 2 km", not gaps): 86 canonical spans over 4 km, e.g.
   XA:0633 32.8 km in 115 s (285 m/s), LN:TJ04 18 km in 58 s. A chain walk that jumps across unobserved berths gives one berth
   the whole station-to-station route. Proposed rule: no span when length / learned median implies > ~60 m/s (train glides,
   phase-1 style). Also make the harness count a re-init of an already-drawn train as a fade (it currently does not).
2. DECIDED by Rich: render delay stays 12 s; "slower than predicted" waits are excluded from the 90 % target (CONTRACT 18.1).
   Also agreed: stay at the platform until departed (18.3), Darwin forecast departures in phase 3 (18.4). Fix round 2 =
   CONTRACT section 18.
3. After round 2 is deployed and has recorded a day, re-measure all six regions from the LIVE recordings (no respan needed),
   then ask Rich to publish the phase 2 page. Then phase 3.
4. Rural regions need a full day of recording before their numbers mean anything.
5. **Fix round 3 candidates (found 2026-11-05, not started):** trains REMOVED inside the view and re-added later, which the
   viewer sees as a pop-out then a fade-in and the harness does not count (it reports them as `readded`). London respans:
   1,970 removals more than 1.5 km inside the box in ~1.3 h, 348 re-added (median 83 s gone). (a) 52 came back at the SAME
   berth with a new headcode: a renumbering (CB then CC) that the model keeps as one train but the update stream removes at
   the CB — keep it drawn through the 120 s recently-cancelled window. (b) Most others had no `mv` (phase-1 placement,
   `pl` i/a) and came back > 2 km away: they stepped into berths the placement cannot place and were removed — hold the last
   position (marked approximate) for a while instead. Decide with Rich whether 18.1's fade count should include these.
   (c) Phase-1 positions can sit well off the line: Rich's screenshot 2026-11-05 22:43, Kettering — 1Y65 (KG:6075) and 1B99
   (KG:0044) both at exactly 52.34867, -0.70411 and 1H66 (KG:6084) at -0.7096, ~1 km west of the MML, while their SPANS run
   along it (~-0.692). The phase 2 page draws spanned trains on their spans, so it fixes these; but trains with NO span
   (e.g. 6J15, pl a) are still drawn from the phase-1 estimate. Snap pl i/a positions to the nearest non-siding track
   (pack.nearestOnTrack, within ~300 m along the train's heading) in the service, and find why KG's interpolation goes wide.

## Open problem (as found 2026-11-05 morning; superseded by fix round 1 above)

Real Sussex recordings (10-min segments) through
`node map/test/motion-replay.js <file>`: absorbed **73–76 %** (target ≥ 90 %), fades **6–7 per
train-hour** (target < 0.1), backward 0, catch-up ≤ 1.5×, acceleration bound held (one segment had a
130 m/s² frame). The mock gave 92–94 % and 0 fades — it was too clean. Suspects, unconfirmed:
spans of adjacent berths not meeting (each fade is a > 5 m gap), equal-share cuts while transit
times are still being learned, trains moving between spanned and unspanned berths. Diagnose from
the recordings first (classify every fade and every non-absorbed step by cause), then fix in the
service and/or page, then re-measure.

Also seen on the live server: `transit` hit its 60,000-series cap within 12 h (9,670 dropped) and
RSS rose from 130 to 173 MB over the day (budget 220 steady). Size the transit store properly.

**The measurement is now national — DONE, deployed `cf74eaf` (2026-11-05 ~20:00 UTC).** At Rich's
request the recorder covers six contrasting regions, each a rolling 6 h of 10-min segments in
`~/rail-map-data/record/<region>-<start>.jsonl` (`config.record.regions`):

| Region | Type | Box [S, W, N, E] |
| --- | --- | --- |
| `sussex` | suburban / coastal, stopping-heavy | 50.7, -0.95, 51.2, 0.85 |
| `london` | dense urban, termini, tunnels (Elizabeth line, Thameslink core) | 51.46, -0.23, 51.56, 0.0 |
| `manchester` | urban hub, congested corridor | 53.42, -2.35, 53.52, -2.15 |
| `glasgow` | Scottish urban | 55.8, -4.35, 55.9, -4.15 |
| `cambrian` | rural single line, long sections, few stations | 52.35, -4.15, 52.75, -2.7 |
| `ecml-rural` | rural high-speed main line with freight | 52.55, -0.75, 53.55, -0.25 |

Copy them down with `scp 'ubuntu@130.162.167.237:rail-map-data/record/<region>-*.jsonl' <dir>/`.
**Every fix must meet the section-12 targets in ALL six regions**, not just Sussex; report a table
region by region. Rural regions record little traffic per segment, so join several segments or use
more hours before judging them.

**The 12 s render delay is not validated.** It was chosen from a sweep on the MOCK (10 s → 89%,
12 s → 93%, 15 s → 95% absorbed): the shortest delay that cleared 90% with margin, since each extra
second makes every train a second staler (~27 m at 60 mph). Real data gave ~75% at 12 s, so redo the
sweep on the real recordings (all six regions) as part of the fix, and also measure the real feed
delay distribution (signalling time → time the page receives the step) per region. Choose the
delay from that, explain the trade-off to Rich in plain words, and record it in CONTRACT section 16.

Only after that: publish the phase 2 page (ask Rich first), then phase 3.

## Phase 3 notes

Darwin (National Rail) via the Rail Data Marketplace: Rich subscribed to "Darwin Real Time Train
Information (Push)" and "…snapshots". Credentials are NOT yet in any .env — agree variable names
with Rich, have him add them to `~/rail-crossing/backend/.env` on the VPS (never in chat), and read
them the way `MAP_ENV_FILE` already is. Confirm the push product's transport (STOMP vs Kafka) from
the RDM product page before designing. Formations: coach count, class, toilets, loading.
Drawing rule (Rich): the front engine counts as a carriage. Fallbacks: CIF unit class + a class
table, freight wagons from trailing load, all labelled estimated. See the brief's carriages section.

## How the work has been run (keep doing this)

- The lead (Opus) writes the contract and briefs; builders are Sonnet subagents in isolated
  worktrees (`isolation: worktree`, background), each told to `git reset --hard
  origin/claude/map-service` first because worktrees start from `main`.
- Every builder report is verified by the lead, not trusted: run the tests on Node 20, read the key
  code, look at the screenshots, run against real data, measure on the VPS. Send work back with a
  numbered list until it meets the bar; merge with `--no-ff` into `claude/map-service`.
- Rich's standing asks: production quality, market ready; plain-English explanations;
  step-by-step commands labelled by where they run; ask before pushing `main`; pause on request
  (stop all agents with TaskStop, resume them with SendMessage).
- Owner feedback already applied: calm base map (positron, flat land colour); tunnels drawn like
  open track everywhere; railway lines visible at every zoom (network overview lo/hi);
  no stacked-train crosses; subtle estimate cue; "Next: <station> <time>" top line in the panel.
