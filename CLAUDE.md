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

- **`main`** — what's live. Frontend-only, calls a Cloudflare Worker for data.
- **`backend-v2`** — Node.js backend (`/backend` directory) running on Oracle Cloud VPS (`130.162.167.237`). Implements a three-layer data architecture: NWR CIF schedule baseline → LDBSVWS near-term refinement → NWR Train Describer Kafka feed for berth-step confirmation. **Deployed; TD logging active.** LDBSVWS integration pending `NR_TOKEN_SV` secret. Don't merge or deploy backend-v2 without explicit instruction from Rich.

## Architecture (current — `main`)

```
Browser (portslade/index.html + shared/crossing.js)
  ↓ HTTPS
Cloudflare Worker (rail-crossing-api.richardbroad29.workers.dev)
  ↓ SOAP 1.2
National Rail OpenLDBWS (live arrival/departure board)
```

The frontend polls the worker, parses the SOAP/XML response, deduplicates trains, computes closure windows from scheduled times, and renders a state (`OPEN`, `CLOSING_SOON`, `CLOSED`).

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

Verified from SMART data:
- Eastbound approach: `LA 0006→0004`, clear: `LA 0004→0002`
- Westbound approach: `LA 0003→0005`, clear: `LA 0005→0007`

## External services and credentials

- **GitHub Pages** — auto-deploys `main` to `richbroad29.github.io/rail-crossing/`
- **Cloudflare Worker** (`rail-crossing-api.richardbroad29.workers.dev`) — proxies SOAP to OpenLDBWS/LDBSVWS. Worker source is in `./worker/`; deploy with `cd worker && npx wrangler deploy`.
- **OpenLDBWS** (public) — currently in use
- **LDBSVWS** (Rail Data Marketplace, Staff Version) — token (`NR_TOKEN_SV`) must be set as a Cloudflare secret; worker accepts `?sv=1` to activate it.
- **NWR Train Describer (Kafka)** — Rich is subscribed via RDM. Used by backend-v2 only.
- **NWR CIF schedule files** — used by backend-v2 only.
- **Google Apps Script + Sheets** — feedback collection. URL is in `crossings.json`.
- **Oracle Cloud VPS** (`130.162.167.237`, Ubuntu, Node 20) — backend-v2 deployment target.
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

- Deploy `backend-v2` to Oracle VPS (service deployed, TD logging running; LDBSVWS integration pending token)
- Set `NR_TOKEN_SV` secret in Cloudflare Worker (`cd worker && npx wrangler secret put NR_TOKEN_SV`), then update frontend to pass `?sv=1`
- Ongoing calibration of `closeBefore` / `openAfter` / `consecutiveWindow` from feedback data
- Potential expansion to more crossings once Portslade architecture is validated
