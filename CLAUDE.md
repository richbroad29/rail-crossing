# Rail Crossing — Claude Code instructions

This is **Rich's** project. Rich is tech-competent but not a developer. Read this file completely at the start of every session.

## What this project is

A web app that predicts when UK level crossing barriers will be closed, using real-time and scheduled train data. Currently focused on the **Boundary Road** crossing in Portslade, West Sussex (an MCB-CCTV crossing on the West Coastway line). Architecture is designed to scale to additional crossings.

Live at: https://railcrossing.uk/

Goals, in order of priority:
1. Catch every closure (including freight)
2. Avoid false alarms
3. Accurate timing

## Repository layout (current `main`)

```
index.html                       Landing page
portslade/index.html             The actual app (Boundary Road)
shared/predict.js                PREDICTION CORE — shared by BOTH apps (see below)
shared/crossing.js               Public app: presentation over the core
shared/crossings.json            Per-crossing config (timing params, IDs, feedback URL)
shared/crossing.css              Styles
shared/apps-script-feedback.gs   Copy of the Google Apps Script behind the feedback Sheet
shared/icon-180.png, icon.svg    Icons
README.md                        Almost empty
portslade/observe/               Barrier-observation PWA — field data-collection tool (separate app, /portslade/observe/)
```

### `shared/predict.js` — read this before touching either front-end

Anything the two apps must **agree** on lives here: the closure mapping and confidence
tiers, the `OPEN`/`CLOSING_SOON`/`CLOSED` derivation (`PREDICT.derive`), the formatters, the
Portslade berth chain and position maths (`PREDICT.proximity` / `PREDICT.eta`), live-train
enrichment, and the feedback payload shape. Both apps load it as a plain `<script>`; there
is no build step.

Anything about how one app **looks** does not live here. Each app keeps its own thin label
formatter over the shared position maths — "Approaching (~3 min)" for a passer-by,
"Approaching (3m20s)" for someone at the crossing with a stopwatch.

**Do not add a second implementation of any of it.** The observer previously carried its own
copy of the berth chain and no prediction at all, which is exactly how the two apps came to
be able to disagree about the same crossing at the same moment.

The **frontend has no build step** — edit files, push to `main`, GitHub Pages deploys within ~1 minute.

## Branches

- **`main`** — what's live. Frontend-only, calls the VPS backend (see Architecture).
- **`backend-v2`** — Node.js backend (`/backend` directory) running on Oracle Cloud VPS (`130.162.167.237`). Implements a three-layer data architecture: NWR CIF schedule baseline → LDBSVWS near-term refinement → NWR Train Describer feed for berth-step confirmation. **Deployed and serving the live frontend.** See Architecture for prediction-pipeline status of each source. Don't merge or deploy backend-v2 without explicit instruction from Rich.

## Deploying the backend (backend-v2)

Canonical, repeatable sequence — run on the VPS once `backend-v2` is pushed to
origin. **Pushing to origin does NOT make changes live; the service must be
restarted onto them.** Always end with the restart-and-verify steps.

```bash
cd ~/rail-crossing
git rev-parse HEAD                              # note this — rollback point
git fetch
git log HEAD..origin/backend-v2 --oneline       # review incoming commits
git merge --ff-only origin/backend-v2           # fast-forward only (see below)
sudo systemctl restart rail-crossing            # ~90s reparse on boot
sudo systemctl status rail-crossing --no-pager  # confirm "active (running)"
```

- **Use `--ff-only`, never `reset --hard`.** `reset --hard` silently discards
  any local commits or uncommitted changes on the VPS to force a match with
  origin. `--ff-only` refuses and errors out if histories have diverged, so a
  problem surfaces loudly instead of being papered over. The VPS is pull-only
  today, but if it ever holds a local change, `reset --hard` would delete it
  without warning. Use `--ff-only` everywhere as the standard update step.
- Rollback: `git reset --hard <HEAD-from-step-2> && sudo systemctl restart rail-crossing`
  (the one place `reset --hard` is intentional — reverting to a known-good commit).
- Fallback when local→GitHub push is blocked: git bundle + scp + `merge --ff-only`
  (see the deploy-bundle note in memory).

## Architecture (current — `main`)

```
Browser (portslade/index.html + shared/crossing.js)
  ↓ HTTPS (CORS allowlist)
Caddy on Oracle VPS (railcrossing.duckdns.org)
  ↓ reverse proxy → localhost:3000
backend-v2 Node service
  ├─ LDBSVWS via RDM REST   (active — near-term passenger + non-stopping fasts)
  ├─ CIF schedule           (active — freight, ECS, full-day passenger coverage)
  ├─ CORPUS reference data  (active — TIPLOC → display-name map for CIF trains)
  └─ TD STOMP feed          (live sightings join predictions for Q-freight lock; tdBerth tier-narrowing pending)
```

The frontend polls `GET /crossing/portslade` and renders the backend's **pre-computed** closure periods verbatim (`buildClosuresFromVps()` in `shared/crossing.js` — maps `start`/`end` to Dates and attaches only the client-side confidence window). This is deliberate: the backend owns the authoritative timing, including the TD **clear-step-anchored OPEN** and **hold-until-cleared** behaviour, which the client can't reproduce (it has only each train's `bestTime`, not the berth-step feed). There is no client-side fallback — the frontend always renders the backend's periods (`buildClosuresFromVps([])` is a no-op when the backend sends none). **Consequence:** `closeBefore`/`openAfter`/`openLagSecs`/`consecutiveWindow` are tuned **backend-side** now (`backend/config/crossings.json` on `backend-v2` + a deploy); the `shared/crossings.json` copies feed only the client-side confidence-window / debug-panel display. Renders a state (`OPEN`, `CLOSING_SOON`, `CLOSED`).

**TLS** is auto-provisioned by Caddy via Let's Encrypt (HTTP-01 challenge). The DuckDNS subdomain (`railcrossing.duckdns.org`) is kept alive by a cron on the VPS that hits the DuckDNS update endpoint every 5 minutes. The DuckDNS token lives in that crontab.

**Cloudflare Worker** — retired (2026-07). The old `rail-crossing-api.richardbroad29.workers.dev` SOAP proxy has been removed from the repo and torn down; the frontend calls the VPS backend directly.

**Prediction-pipeline status:**

*LDBSVWS* — active. Near-term passenger services (up to ~2h ahead) with real-time estimates. Source label `"ldbsv"`.

*CIF schedule* — active. Auto-downloaded from NROD (`CIF_ALL_FULL_DAILY`, same basic-auth credentials as STOMP) to `~/rail-crossing/backend/data/schedule/cif-latest.json.gz` at startup and refreshed daily at 04:00 Europe/London. Parsed in memory only. Provides full-day coverage including freight, ECS, and all services beyond LDBSVWS's 2h window. Source label `"cif"`.

Dedup: UID-first (CIF `CIF_train_uid` vs LDBSVWS `svc.uid`), then headcode + time ±5 min, then direction + time ±3 min as last resort. LDBSVWS wins on any match.

**CIF origin/destination resolution via CORPUS:** CIF entries carry raw TIPLOCs (e.g. `FRTSTGT`) where LDBSVWS provides `locationName` strings. `backend/src/corpus-fetcher.js` downloads NR CORPUS at startup, builds an in-memory `TIPLOC → NLCDESC` map (falls back to `3ALPHA`; parenthetical CORPUS admin markers like `(C) (TPS INDIC. ONLY)` are stripped at map-build time by `_cleanDisplayName`), and `schedule-parser.js` resolves `origin`/`destination` through it. Unknown TIPLOCs pass through unchanged — never silently dropped. LDBSVWS-sourced trains are not touched (they already have human names). Refreshed daily at 04:00 Europe/London immediately before the CIF reparse.

**Midnight-crossing CIF times — FIXED, don't re-fix.** This section used to describe a live bug: CIF times past 24:00 (e.g. `2510` = 01:10 next morning) mapped modulo-24, placing the train at 01:10 *today* instead of *tomorrow*. It was fixed in `1315934` and the description here was left stale, contradicting "Recently shipped" below. `londonMinsToDate` now takes `dayOffset = Math.floor(total / 1440)` and shifts the date stamp by it, and `analyseRoute` unwraps a route's times across 00:00 — so `2510` resolves to 01:10 tomorrow. Verified in `time-utils.js:80-93`.

*TD* — STOMP listener active, writing JSONL to `~/rail-crossing/backend/data/logs/td/`. **Partially joined into predictions:** every CA/CB event emits a `sighting` event (`td-listener.js`); `crossing-state` records the first sighting per headcode per day in `tdSeenToday`, surfaces `tdSeen`/`tdSeenAt` on the API, and uses the sighting as the late-minute lock signal for CIF predictions (see Q-freight handling below). Still pending: confidence-tier narrowing via `tdBerth` (approach/protecting/clear).

**Q-freight handling — false-positive control for CIF.** Freight scheduled in CIF often carries `Q` in `CIF_operating_characteristics` = "runs as required" (path booked, train only runs on demand — ~50% of Portslade-area freight). The pipeline addresses this in three layers:
- `schedule-parser.js` sets `runsAsRequired=true` when the entry has the `Q` flag.
- `backend/src/run-rate.js` scans the last 14 days of TD logs at schedule-load and daily-refresh time. For each Q-flagged headcode it computes `recentRunRate = daysSeen / applicableDays` (applicability respects `schedule_days_runs`). Attached to the train as `recentRunRate` / `recentRunSeen` / `recentRunApplicable`.
- `crossing-state._mergeTrains` applies a **late-minute lock**: within `TD_LOCK_LEAD_MS` (60 s) of the scheduled crossing, a CIF entry with `tdSeen=false` is dropped from the merged train list. The recompute triggered by `recordTdSighting` re-adds the entry if TD sights the headcode later. This is what guarantees "app says CLOSED ⇔ a train has actually been seen entering our berths" for CIF-sourced trains.

The frontend renders four-state freight labels by descending confidence: `confirmed` (tdSeen=true) → `usually doesn't run` (Q-flag and recentRunRate<0.3) → `may not run` (Q-flag, no rate) → plain `(freight)`. LDBSVWS-sourced predictions are untouched throughout (they have realtime ETAs).

Feedback flow: when the user reports a wrong prediction, the frontend POSTs to a Google Apps Script URL (in `crossings.json` → `feedbackUrl`), which appends a row to a Google Sheet.

## Observer app (`/portslade/observe/`)

A separate installable PWA (`portslade/observe/`, live at https://railcrossing.uk/portslade/observe/ , deployed on `main` via GitHub Pages) for on-site collection of real barrier event timestamps — **step 1 of position-based closure triggering**. It is read-only on train data.

- **Shows the public app's prediction** (2026-07-29) in a panel above the capture button, from the same `shared/predict.js` core and the same `GET /crossing/:id` — so a mismatch between it and railcrossing.uk is a bug, not a difference of implementation. Derived on the **device** clock, because the claim is "this is what a user is seeing", and the public app has only the device clock. Each capture freezes that prediction into the record along with `deltaVsPredictedSecs` (observed − predicted), which is the calibration measurement.
- **Writes to the Google Sheet** as well as local storage (2026-07-29): the same `Feedback v2` tab, the same payload builder as the public app, distinguished by a `source` column. Posted twice per event on one `eventId` — at the tap and again on Save — which the Apps Script upserts onto one row. Local IndexedDB + CSV export remain the record of truth: the POST is `no-cors`, so success only means the request left the device, and the export note reports anything that never got sent.
- **"End session"** returns the app to the arrival question. Backed by a `observer-session-end-<id>` localStorage timestamp, because `recomputeState()` otherwise re-derives the barrier state from the last event in the log however old it is. Deletes nothing.

- Polls the backend's **B1 live endpoint** `GET /crossing/:id/live` (~2.5s) for trains currently in TD area LA. The endpoint feeds the observer the per-train `{ headcode, berth, fromBerth, event, direction, stopping, origin, destination, lastSeen, ageSecs }` plus `serverTime` (for device clock-offset). B1 lives in `backend-v2`: `td-listener` emits the berth, `crossing-state.recordTdBerth`/`getLiveTrains` keep a TTL-pruned `liveTrains` map (config `live.ttlSecs`), `api.js` serves it. Direction is from a headcode→LDB/CIF join (`"unknown"` if no match); `stopping` is `true` only if on the PLD board, else `"unknown"` (never `false`).
- Captures **two events only** — CLOSE (red lights start) / OPEN (booms fully up) — each attributed to a **single** train: CLOSE → nearest *approaching* train, OPEN → *just-cleared* train. Attribution leans on direction + the **confirmed Portslade approach berths only** (`berths.east/west` in `shared/crossings.json`), never raw berth proximity across all of LA (that mapping is the later berth-chain analysis).
- Offline-first: timestamp captured synchronously at tap, IndexedDB storage, CSV/JSON export. No server-sync endpoint in v1 (add a token-protected `POST /observations` later only if per-session export becomes a chore).

## Non-obvious technical patterns — read before changing logic

### `closeBefore` and `openAfter` are direction-dependent

`crossings.json` stores them as objects keyed by direction:
```json
"closeBefore": {"east": 1.5, "west": 2.5},
"openAfter":   {"east": 0.5, "west": 0.5}
```
The helpers `getCloseBefore(direction)` and `getOpenAfter(direction)` (lines ~37–44 of `crossing.js`) handle both the new object form and the legacy flat-number form. Always use the helpers — never read `CFG.closeBefore` directly.

Eastbound barriers close ~1.5–2 min before the train, westbound ~2.5 min before. The asymmetry is real (it relates to signal positions and approach speeds), so don't "normalise" them without good reason.

### Direction detection is backend-side

Each train's `direction` (`east`/`west`) is computed **by the backend** and delivered on the API — the frontend just reads `t.direction`. The old client-side `isEastOrigin()` origin-keyword heuristic has been removed. Change direction logic backend-side (`analyseRoute()` in `backend/src/schedule-parser.js` for CIF; the LDB poller for LDBSVWS).

### `closurePeriods` vs `trainHistory`

- `closurePeriods` — reflects only the **last API refresh**. Used for live rendering.
- `trainHistory` — accumulates **all observed trains** across the session. Used for feedback tap event matching.

Feedback taps are event-aware:
- "Closing" tap → references the **next** upcoming closure (computed from `trainHistory`)
- "Opening" tap → references the **previous** closure

Reading from `closurePeriods` for feedback would be wrong — it forgets past trains.

### SOAP 1.2 quirk (backend LDBSVWS fallback)

The backend's default LDB path is the RDM REST endpoint (`RDM_API_KEY`). A dormant SOAP fallback in `backend/src/ldb-poller.js` — used only if `NR_TOKEN_SV` is set instead — speaks **SOAP 1.2**, not 1.1: namespace `http://thalesgroup.com/RTTI/2021-11-01/ldbsv/`, endpoint `ldbsv12.asmx`, `Content-Type: application/soap+xml`, **no SOAPAction header**. Deviating from any of this causes silent failures.

### Freight matters

~2–3 aggregate stone trains per weekday pass through Portslade (headcodes 6Vxx, 6Oxx). They don't appear in LDBSVWS (passenger-only) but are now visible via CIF schedule, tagged `source:"cif"` and `trainType:"freight"` in the API response. The CIF source also surfaces ECS movements (5xxx headcodes). Full-day coverage; not real-time.

### TD berth mappings (for backend-v2)

Verified from SMART data. Berths are stored in TD events **without** the area prefix — the area code is "LA" but `from`/`to` fields in the JSONL carry the 4-digit code only.

- Eastbound: approach `0006` → protecting `0004` → clear `0002`
- Westbound: approach `0003` → protecting `0005` → clear `0007`

These are also the values in `crossings.json` → `berths.east/west.approach/protecting/clear`.

## External services and credentials

- **GitHub Pages** — auto-deploys `main` to the custom domain `railcrossing.uk` (apex; `CNAME` file in repo root). The old `richbroad29.github.io/rail-crossing/` URL 301-redirects to it.
- **Oracle Cloud VPS** (`130.162.167.237`, Ubuntu, Node 20) — runs backend-v2 under systemd (`rail-crossing.service`) and Caddy (reverse proxy + Let's Encrypt). **Note:** Ubuntu image has host-level iptables that REJECT inbound besides 22 — opening a port needs BOTH the OCI Security List and `iptables -I INPUT <pos> ... -j ACCEPT` before the REJECT, persisted with `netfilter-persistent save`.
- **DuckDNS** — free dynamic-DNS subdomain `railcrossing.duckdns.org` → VPS IP. Kept alive by cron on VPS (`crontab -l` shows the update URL with token).
- **Caddy** on VPS — `/etc/caddy/Caddyfile`, systemd-managed, auto-renewing Let's Encrypt cert.
- **Cloudflare Worker** — retired (2026-07). The old `rail-crossing-api.richardbroad29.workers.dev` SOAP proxy has been removed from the repo and torn down; the frontend calls the VPS backend directly.
- **LDBSVWS** (Rail Data Marketplace, Staff Version) — backend-v2 calls the RDM REST endpoint with `x-apikey` (the `RDM_API_KEY` in backend `.env`). This is the active LDB data source.
- **NWR Train Describer (STOMP)** — Rich is subscribed via NROD. Backend-v2 `td-listener.js` subscribes via plain STOMP (no TLS) to `publicdatafeeds.networkrail.co.uk:61618`, filters area LA, writes JSONL to `backend/data/logs/td/`. Not yet joined into prediction output.
- **NWR SCHEDULE (CIF)** — downloaded automatically from NROD `CifFileAuthenticate` endpoint using the same basic-auth credentials as STOMP (`NR_FEED_USER`/`NR_FEED_PASS` in backend `.env`). No separate NROD subscription needed — the portal grants global access to all feeds. Daily full extract, ~120 MB gzipped; stored at `~/rail-crossing/backend/data/schedule/cif-latest.json.gz`. **Credential testing gotcha:** `source .env` in bash expands `$` in the password (e.g., `p$i$d…` → `p`) — use `awk -F= '/^NR_FEED_PASS=/{sub(/^NR_FEED_PASS=/,"");print}' .env` to read the literal value.
- **NWR CORPUS** — downloaded from `https://publicdatafeeds.networkrail.co.uk/ntrod/SupportingFileAuthenticate?type=CORPUS` using the same `NR_FEED_USER`/`NR_FEED_PASS` credentials. ~770 KB gzipped, ~12.3k usable TIPLOC entries after build; stored at `~/rail-crossing/backend/data/corpus/corpus-latest.json.gz`. Used only for resolving CIF train origin/destination names — see "CIF origin/destination resolution via CORPUS" above.
- **Google Apps Script + Sheets** — feedback collection. URL is in `crossings.json`.
- **GoatCounter** — analytics
- **Buy Me a Coffee** — donations

**Never commit secrets** to this repo (PATs, Cloudflare API tokens, RDM API keys, SSH keys). They go in environment files that are gitignored, or in Cloudflare/Oracle secret stores.

## Conventions

### Git author for AI commits

When making commits as an agent:
```bash
git config user.name "Claude (AI Agent)"
git config user.email "claude-agent@anthropic.com"
```

### Don't push without explicit instruction

`main` deploys live. Don't commit or push speculative changes. Make the edit, show Rich the diff, wait for him to say push.

### Verify before recommending code changes

When considering a change, **read the current file first**. Don't suggest edits based on memory of what the code probably looks like. The ~560 lines of `crossing.js` are not always what you'd expect.

### Free is the default for cost

External services should be free unless the value clearly justifies a paid tier. If a recurring cost is needed, flag it explicitly with the figure ("$5/month") rather than burying it.

## Working approach with Rich

- **Step-by-step terminal/VPS instructions** — spell out each command individually with context. Rich won't translate a summary into actions reliably.
- **Default to brevity** — short focused responses. No pre-amble, no post-amble. Headers and bullets only when they aid comprehension. One-sentence answers are fine.
- **Commit to recommendations** — when laying out options, end with the option you'd pick and a one-line reason. Don't punt decisions as "your call" if you have enough info.
- **Don't de-scope reflexively** — if Rich proposes infrastructure or a structural change, take it at the scope he's chosen. Only suggest a smaller version if there's a specific reason it solves the same problem.
- **Challenge wrong framings** — back challenges with reasoning he can engage with. Don't manufacture disagreement, but don't soften real disagreement into mush.
- **When stuck, escalate honestly** — if a series of fixes keeps hitting blockers, stop and say the path is wrong. Don't burn time on increasingly desperate workarounds.
- **No filler reflection** — when you make a mistake, name the failure mode in one short sentence and apply the corrective behaviour next message. Don't write self-flagellating apology paragraphs.

## Auditing the live app for bugs

Invoke the **`crossing-audit`** skill (`.claude/skills/crossing-audit/`). It holds the
record-first playbook, the harness that replays recorded API payloads through the real
`shared/crossing.js`, the ground-truth/detector scripts, and `KNOWN-ISSUES.md` — a register
to re-check at the start of every audit so regressions are caught. Read `SKILL.md` before
starting a watch; the ordering of its first phase matters (start recording before reading code).

## Common tasks — quick reference

- **Tweak timing parameters**: edit `backend/config/crossings.json` on `backend-v2` (`closeBefore` / `openAfter` / `openLagSecs` / `consecutiveWindow`) and deploy — the frontend renders the backend's closures. (`shared/crossings.json` feeds only the client-side confidence-window / debug-panel display.)
- **Change closure logic**: backend `_computeClosures()` / `_anchorEndToClearStep()` in `backend/src/crossing-state.js` (authoritative); frontend just maps them via `buildClosuresFromVps()` in `shared/crossing.js`.
- **Change direction detection**: it's backend-side now — `analyseRoute()` in `backend/src/schedule-parser.js` (CIF) and the LDB poller. The frontend just reads `t.direction`.
- **Change rendering / status**: `renderClosures()`, `updateStatus()` in `shared/crossing.js` — but the values themselves come from `PREDICT.derive` in `shared/predict.js`, and the observer renders the same ones. Change the numbers in the core, the presentation in the app.
- **Add a feedback field**: append it to the payload in `PREDICT.feedbackPayload` (or the app's `extra`), then append the same name to `FIELDS` in `shared/apps-script-feedback.gs` and paste that file over the spreadsheet's Apps Script. The header row and column count migrate themselves on the next post.
- **Add a new crossing**: append entry to `shared/crossings.json`, create `<crossing-name>/index.html` mirroring `portslade/index.html`, call `initCrossing('<id>')`.
- **Test changes**: open `portslade/index.html` directly in a browser (`open portslade/index.html` on macOS) — the VPS API URL is hard-coded (`API_BASE` in `shared/crossing.js`) so it works against live data.

## Recently shipped (backend-v2, live 2026-05-31)

- **Late-running CIF freight re-attachment** — a TD-sighted train whose scheduled crossing has passed (or is inside T−60s) now has `bestTime` re-projected from the sighting + `timing.areaEntryLeadSecs`, floored to the future, so it shows as imminent instead of expiring/vanishing. The lead values are a deliberate stopgap pending position-based triggering — **do not tune them** (see "Confidence-tier narrowing" below).
- **Midnight-crossing CIF placement** — `analyseRoute` unwraps times across 00:00 and `londonMinsToDate` maps `mins ≥ 1440` to the correct next day, so overnight traversals appear at e.g. 00:05 instead of being dropped/mis-dated.
- **Same-day STP=C cancellations** — the daily UPDATE extract (`toc-update-<dow>`) is now fetched + applied hourly on top of the full snapshot, so a cancellation suppresses its train within the hour. Logs `CIF update: suppressed N service(s) from update extract — …`. Validate against a live extract with `node scripts/validate-update.js`. Delete transactions are counted but not acted on (fail-safe).
- **CR / TI / TA records** — assessed immaterial to Portslade (BLI1); counted + logged, not applied.

## Active work / pending items

- **Confidence-tier narrowing via TD berth state** — TD sightings now flow into predictions (`tdSeen`/`tdSeenAt` on each CIF train) and drive the late-minute lock for Q-freight, but the per-berth `tdBerth` field (approach/protecting/clear) is still not populated. Setting it would unlock the ±90s → ±60s → ±30s → "imminent" confidence-window narrowing. This **position-based triggering** is intended to replace the `areaEntryLeadSecs` projection wholesale, which is why those lead values are not worth tuning.
- Ongoing calibration of `closeBefore` / `openAfter` / `consecutiveWindow` from feedback data
- Potential expansion to more crossings once Portslade architecture is validated
