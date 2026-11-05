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
| 2 real track, motion, TRUST | Built, merged, service deployed. **Page blocked: fails the jump targets on real data.** |
| 3 carriages | Not started. Rich has subscribed to Darwin Push Port + snapshots on RDM. |
| 4 enthusiast features, launch | Not started. |

## Open problem — do this first (phase 2 fix round)

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
