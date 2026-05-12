# Rail Crossing — Claude Code instructions

This is **Rich's** project. Rich is tech-competent but not a developer. Read this file completely at the start of every session.

## What this project is

A web app that predicts when UK level crossing barriers will be closed, using real-time and scheduled train data. Currently focused on the **Boundary Road** crossing in Portslade, West Sussex (an MCB-CCTV crossing on the West Coastway line). Architecture is designed to scale to additional crossings.

Live at: https://richbroad29.github.io/rail-crossing/

Goals, in order of priority:
1. Catch every closure (including freight)
2. Avoid false alarms
3. Accurate timing

## Repository layout (current `main`)

```
index.html                       Landing page
portslade/index.html             The actual app (Boundary Road)
shared/crossing.js               All app logic — 614 lines, single file
shared/crossings.json            Per-crossing config (timing params, IDs, feedback URL)
shared/crossing.css              Styles
shared/icon-180.png, icon.svg    Icons
siri.js                          Scriptable iOS integration (separate, mirrors the worker calls)
feedback-update-instructions.md  Notes on the feedback system
README.md                        Almost empty
worker/                          Cloudflare Worker source (wrangler.jsonc + src/worker.js)
```

The **frontend has no build step** — edit files, push to `main`, GitHub Pages deploys within ~1 minute. The **worker requires a separate deploy step**: `cd worker && npx wrangler deploy`.

## Branches

- **`main`** — what's live. Frontend-only, calls the VPS backend (see Architecture).
- **`backend-v2`** — Node.js backend (`/backend` directory) running on Oracle Cloud VPS (`130.162.167.237`). Implements a three-layer data architecture: NWR CIF schedule baseline → LDBSVWS near-term refinement → NWR Train Describer feed for berth-step confirmation. **Deployed and serving the live frontend.** See Architecture for prediction-pipeline status of each source. Don't merge or deploy backend-v2 without explicit instruction from Rich.

## Architecture (current — `main`)

```
Browser (portslade/index.html + shared/crossing.js)
  ↓ HTTPS (CORS allowlist)
Caddy on Oracle VPS (railcrossing.duckdns.org)
  ↓ reverse proxy → localhost:3000
backend-v2 Node service
  ├─ LDBSVWS via RDM REST   (active in predictions)
  ├─ TD STOMP feed          (logged to JSONL, NOT joined into predictions)
  └─ CIF schedule           (parser wired up, no SCHEDULE_FILE set, NOT joined into predictions)
```

The frontend polls `GET /crossing/portslade`, receives JSON with the backend's pre-computed upcoming closures, then runs its own client-side closure logic over the train list (so `closeBefore`/`openAfter`/`consecutiveWindow` stay tunable via `crossings.json` without a backend deploy). Renders a state (`OPEN`, `CLOSING_SOON`, `CLOSED`).

**TLS** is auto-provisioned by Caddy via Let's Encrypt (HTTP-01 challenge). The DuckDNS subdomain (`railcrossing.duckdns.org`) is kept alive by a cron on the VPS that hits the DuckDNS update endpoint every 5 minutes. The DuckDNS token lives in that crontab.

**Cloudflare Worker** (`rail-crossing-api.richardbroad29.workers.dev`) is still deployed but **no longer in the request path**. It exists as a one-week fallback (~12 May 2026 onward) — retirement decision after the observation window.

**Prediction-pipeline status:** LDBSVWS is the only source currently feeding into the JSON response. TD events accumulate to `~/rail-crossing/backend/data/logs/td/*.jsonl` but the listener doesn't yet update `crossing-state.tdEvents` in a way that flows into the API output, so no `tdBerth` field on trains and no confidence-tier narrowing. CIF schedule parser exists in `schedule-parser.js` and `index.js` will load it on startup if `SCHEDULE_FILE` env var points to a CIF JSON file — currently unset, so no freight or ECS in predictions.

Feedback flow: when the user reports a wrong prediction, the frontend POSTs to a Google Apps Script URL (in `crossings.json` → `feedbackUrl`), which appends a row to a Google Sheet.

## Non-obvious technical patterns — read before changing logic

### `closeBefore` and `openAfter` are direction-dependent

`crossings.json` stores them as objects keyed by direction:
```json
"closeBefore": {"east": 1.5, "west": 2.5},
"openAfter":   {"east": 0.5, "west": 0.5}
```
The helpers `getCloseBefore(direction)` and `getOpenAfter(direction)` (lines ~37–44 of `crossing.js`) handle both the new object form and the legacy flat-number form. Always use the helpers — never read `CFG.closeBefore` directly.

Eastbound barriers close ~1.5–2 min before the train, westbound ~2.5 min before. The asymmetry is real (it relates to signal positions and approach speeds), so don't "normalise" them without good reason.

### Direction detection uses origin names, not coordinates

`isEastOrigin(str)` (line ~66) returns true if the train origin contains Brighton, Hove, London, Gatwick, Croydon, or Haywards. Adding new origin keywords needs care — adding too few causes misclassification, too many causes false matches.

### `closurePeriods` vs `trainHistory`

- `closurePeriods` — reflects only the **last API refresh**. Used for live rendering.
- `trainHistory` — accumulates **all observed trains** across the session. Used for feedback tap event matching.

Feedback taps are event-aware:
- "Closing" tap → references the **next** upcoming closure (computed from `trainHistory`)
- "Opening" tap → references the **previous** closure

Reading from `closurePeriods` for feedback would be wrong — it forgets past trains.

### SOAP 1.2 quirk (worker side, but relevant)

The Cloudflare Worker uses **SOAP 1.2** for OpenLDBWS, not 1.1. Required: `xmlns:soap="http://www.w3.org/2003/05/soap-envelope"`, namespace `http://thalesgroup.com/RTTI/2021-11-01/ldb/`, endpoint `ldb12.asmx`, `Content-Type: application/soap+xml`, **no SOAPAction header**. Deviating from any of this causes silent failures.

LDBSVWS (staff version) uses the same SOAP 1.2 structure but with namespace `http://thalesgroup.com/RTTI/2021-11-01/ldbsv/` and endpoint `ldbsv12.asmx` (not `ldb12.asmx`).

### Freight matters

~2–3 aggregate stone trains per weekday pass through Portslade. They don't appear in OpenLDBWS (passenger-only). This is the core motivation for backend-v2 (which adds CIF schedule and TD Kafka feed). On `main` today, freight closures are missed — known limitation.

### TD berth mappings (for backend-v2)

Verified from SMART data. Berths are stored in TD events **without** the area prefix — the area code is "LA" but `from`/`to` fields in the JSONL carry the 4-digit code only.

- Eastbound: approach `0006` → protecting `0004` → clear `0002`
- Westbound: approach `0003` → protecting `0005` → clear `0007`

These are also the values in `crossings.json` → `berths.east/west.approach/protecting/clear`.

## External services and credentials

- **GitHub Pages** — auto-deploys `main` to `richbroad29.github.io/rail-crossing/`
- **Oracle Cloud VPS** (`130.162.167.237`, Ubuntu, Node 20) — runs backend-v2 under systemd (`rail-crossing.service`) and Caddy (reverse proxy + Let's Encrypt). **Note:** Ubuntu image has host-level iptables that REJECT inbound besides 22 — opening a port needs BOTH the OCI Security List and `iptables -I INPUT <pos> ... -j ACCEPT` before the REJECT, persisted with `netfilter-persistent save`.
- **DuckDNS** — free dynamic-DNS subdomain `railcrossing.duckdns.org` → VPS IP. Kept alive by cron on VPS (`crontab -l` shows the update URL with token).
- **Caddy** on VPS — `/etc/caddy/Caddyfile`, systemd-managed, auto-renewing Let's Encrypt cert.
- **Cloudflare Worker** (`rail-crossing-api.richardbroad29.workers.dev`) — deployed but no longer in the request path. Source in `./worker/`. Retirement decision after the one-week observation window starting 11 May 2026.
- **LDBSVWS** (Rail Data Marketplace, Staff Version) — backend-v2 calls the RDM REST endpoint with `x-apikey` (the `RDM_API_KEY` in backend `.env`). This is the active LDB data source.
- **NWR Train Describer (STOMP)** — Rich is subscribed via NROD. Backend-v2 `td-listener.js` subscribes via plain STOMP (no TLS) to `publicdatafeeds.networkrail.co.uk:61618`, filters area LA, writes JSONL to `backend/data/logs/td/`. Not yet joined into prediction output.
- **NWR CIF schedule files** — backend-v2 has a parser ready but no schedule file is currently loaded.
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

When considering a change, **read the current file first**. Don't suggest edits based on memory of what the code probably looks like. The 614 lines of `crossing.js` are not always what you'd expect.

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

## Common tasks — quick reference

- **Tweak timing parameters**: edit `shared/crossings.json` → `closeBefore` / `openAfter` / `consecutiveWindow`.
- **Change closure logic**: `computeClosures()` in `shared/crossing.js` (~line 251).
- **Add a new origin keyword for direction detection**: `isEastOrigin()` (~line 66).
- **Change rendering / status**: `renderClosures()` (~333), `updateStatus()` (~413).
- **Add a new crossing**: append entry to `shared/crossings.json`, create `<crossing-name>/index.html` mirroring `portslade/index.html`, call `initCrossing('<id>')`.
- **Test changes**: open `portslade/index.html` directly in a browser (`open portslade/index.html` on macOS) — the worker URL is hard-coded so it works against live data.

## Active work / pending items

- **Join TD events into the prediction pipeline** — events are flowing to JSONL on disk but `crossing-state` doesn't yet use them to set `tdBerth` on trains. Wiring this up is what unlocks confidence-tier narrowing (±90s → ±60s → ±30s → "imminent") on the frontend. Planned follow-up prompt once the migration has been observed clean.
- **Wire CIF schedule into predictions** — load a CIF JSON file and set `SCHEDULE_FILE` env var on the VPS (the loader runs at startup). This is what surfaces freight (1Fxx, 6Mxx) and ECS (5xxx) headcodes. Planned follow-up prompt once the migration has been observed clean.
- **Retire the Cloudflare Worker** — one-week observation window started 11 May 2026. After that, decide whether to leave it as a permanent fallback or tear down the Workers project.
- Ongoing calibration of `closeBefore` / `openAfter` / `consecutiveWindow` from feedback data
- Potential expansion to more crossings once Portslade architecture is validated
