---
name: crossing-audit
description: Live-watch the railcrossing.uk prediction pipeline against physical ground truth to find bugs and inaccuracies. Use when asked to watch/monitor the app for a period, audit prediction accuracy, check whether all trains are being captured, investigate a suspected wrong prediction, or re-check previously reported issues. Covers Portslade and any future crossing.
---

# Crossing audit playbook

Purpose: find real, evidenced defects in the closure-prediction pipeline by watching it live
and scoring it against physical truth — not by reading code and reasoning about what it
probably does.

The one-line summary of the method: **record first, replay the real code over the recording,
and score everything against TD berth strikes plus one source outside our own pipeline.**

---

## Non-negotiables

These are ordered. Getting 1 wrong wastes the whole session.

1. **Start the recorder before doing anything else.** Time-series data is perishable; code
   reading is not. Every minute spent orienting first is a minute of trains lost forever.
   `scripts/record.sh` then read code while it streams.
2. **Pin what is actually deployed, and watch for restarts.** Backend HEAD on the VPS, live
   frontend hash, and `/health` uptime sampled throughout. A mid-window restart silently
   invalidates conclusions — this happened (2026-07-25 20:58) and nearly produced a false
   "production is broken" finding.
3. **Never trust the app's own output as ground truth.** Score against TD berth strikes.
4. **Get one independent source.** Realtime Trains. Two of the best findings ever made
   (reversing-service hole, STP phantom) were invisible to both TD and the app, because
   neither train ran.
5. **Read the clock, don't estimate elapsed time.** `date` every time you need to know.
   Getting this wrong cost a mis-scoped window once.

---

## Phase 0 — start recording (target: under 2 minutes)

```bash
bash .claude/skills/crossing-audit/scripts/record.sh <OUTDIR> "<END HH:MM>" [crossing]
```

Records `/crossing/:id`, `/crossing/:id/live` and `/health` at 5 s. Wraps itself in
`caffeinate` — a laptop suspend killed the recorder mid-session once and cost 11 minutes.
Every sample stores both local `t` and the payload's `serverTime` so clock skew is
detectable after the fact.

## Phase 1 — pin versions (while recording)

```bash
ssh -i ~/Downloads/ssh-key-2026-03-22.key ubuntu@130.162.167.237 \
  'cd ~/rail-crossing && git rev-parse HEAD && systemctl is-active rail-crossing'
curl -s https://railcrossing.uk/shared/crossing.js | diff - <(git show main:shared/crossing.js) \
  && echo "live frontend == main tip"
git log --oneline -8 backend-v2      # what changed since last audit
git diff <last-audited-sha>..backend-v2 -- backend/config/crossings.json
```

Read the config diff properly. The timing constants *are* the behaviour; a config change is
a logic change.

## Phase 2 — establish ground truth

Portslade crossing berths — a strike here is unambiguous physical evidence:

| direction | approach | protecting | clear |
|---|---|---|---|
| east | `0006` | `0004` | `0002` |
| west | `0003` | `0005` | `0007` |

`scripts/truth.py` extracts per-train first-strike times from the `/live` history and answers
the coverage question. The clear strike is the best available proxy for "the train has passed".

**Independent source.** RTT is Cloudflare-gated, so `WebFetch` fails; load it in a real
browser tab instead (ordinary page load, no CAPTCHA solving):

```
https://www.realtimetrains.co.uk/search/detailed/gb-nr:PLD/YYYY-MM-DD/HHMM-HHMM
https://www.realtimetrains.co.uk/service/gb-nr:<uid>/YYYY-MM-DD/detailed
```

Extract with `javascript_tool` (`document.querySelectorAll('.location')`), not screenshots.
The service page reveals reversals, double traversals, and Q-flag activation status.

## Phase 3 — replay the real code

```bash
node .claude/skills/crossing-audit/scripts/replay.js <OUTDIR>
```

Runs the **actual** `shared/crossing.js` over every recorded payload with a stubbed DOM and a
faked clock, emitting the exact on-screen strings per sample.

This is the highest-value technique in the playbook. It is what produced `"in now"`,
`"07:24 ±2 min ~1 min · in now"` and `"Down For ~9m"` — defects that are obvious as rendered
text and nearly invisible when reasoning about the source.

## Phase 4 — run the detectors

```bash
python3 .claude/skills/crossing-audit/scripts/truth.py  <OUTDIR>
python3 .claude/skills/crossing-audit/scripts/detect.py <OUTDIR>
```

What they check, and why each earns its place:

- **Coverage** — every train that struck a crossing berth must have had a closure, and it
  must have appeared *before* the train arrived. Retrospective closures are useless.
- **Feed vs app** — every train in `/live` (the observer's data) that is on a Portslade-route
  berth must be in the app. Trains elsewhere in area LA legitimately are not.
- **False alarms** — closures that came and went with no strike.
- **Close accuracy** — score against the anchor rule the backend *actually* uses for that
  train's class, not one guessed rule (see Traps).
- **Open accuracy** — final end vs clear-strike + `openLagSecs`.
- **Grouping stability** — count merged↔split *oscillations*, not just changes. One-way
  regrouping as estimates firm up is fine; alternating is the pathology.
- **`bestTime` jitter** — distinct values and span per train. This is the driver of grouping
  churn and of countdowns moving backwards.
- **Monotonicity** — any countdown that increases is a bug regardless of cause.
- **Invariants** — `start` vs `predictedStart` bucketed by direction and source.
- **Self-consistency** — `state` vs `currentClosure` vs `upcomingClosures` in the *same*
  response.
- **Dead code paths** — is `tdBerth` populated? Does `"Any moment now"` ever render?
- **Ghost trains** — `bestTime` pinned to `now+30s` with `etaText:"Live (TD)"` persisting
  beyond ~2 min.
- **Restarts** — uptime resets in `health.jsonl`.

## Phase 5 — interrogate to root cause

For every anomaly, land on a specific mechanism at a specific line before writing it up.
"The merge threshold is noisy" is not a finding; *"`mergeOppositeMaxGapSecs: 20` is a hard
threshold on the difference of two estimates, and interpolated `bestTime` moves 18–42 s per
±1 min LDB revision, measured swinging the gap −77 s to +30 s"* is.

Read the current source every time. Config comments in `backend/config/crossings.json` carry
the calibration provenance and sample sizes — they will tell you whether a number is
field-calibrated or a guess, which changes what you should recommend.

## Phase 6 — falsify before reporting

This phase exists because it has repeatedly caught wrong conclusions.

- **Test your proposed fix against the recording.** A hysteresis proposal (merge ≤20 s, split
  >45 s) was replayed against the actual gap sequence and would have locked the closure
  *permanently* in the wrong state. It was cut before reaching the report.
- **Try to kill each finding.** Ones that died on inspection: FB_CHAIN "mislabels stopping
  trains" (that train was just held at a signal); "1H95 is misclassified" (measured transit
  supported the class chosen); "a 50-minute closure" (misread UTC as BST); "strikes after the
  last sample" (my own laptop suspend).
- **Separate "defect exists" from "harm occurred today."** The reversing-service hole is real,
  but the train did not run — so it is a capability gap, not a missed closure. Say which.
- **State sample size.** `n=2` on a Sunday is not a calibration.

## Phase 7 — report

One block per issue: **What** (observed, with the actual timestamps/strings) → **Why**
(mechanism at `file:line`) → **Fix** (concrete change). Then a priority table weighing user
impact against effort. Lead with what is *working* — it is how the reader calibrates trust in
the rest, and it protects a correct component from being "fixed".

Finish by updating `KNOWN-ISSUES.md` in this directory.

## Phase 8 — regression check

At the start of the next audit, re-run every entry in `KNOWN-ISSUES.md` against the new
window: `python3 scripts/detect.py <OUTDIR> --regress`. Report each as fixed / recurring /
latent-but-untriggered. "Didn't trigger" is not "fixed" — check whether the code path still
exists before claiming either.

---

## Traps

- **Timezone.** RDM/naked ISO strings are London wall-clock; API `...Z` values are real UTC.
  Convert once at the edge and label every printed time. This produced a wrong intermediate
  conclusion ("a 50-minute closure") in session 1.
- **`stopping` in `/live` is unreliable.** It is `"unknown"` unless the train is on the PLD
  board. Backend classification uses `callsAtStation`/`callsAtApproach`, which are *not*
  exposed on the API — infer the class from which anchor reproduces the prediction.
- **Don't score a westbound LDB stopper against the strike anchor.** It correctly uses
  `departure − 45 s`. Scoring it against `0003+20` produced fake "+67 s late" deltas that then
  needed explaining away.
- **Merged groups.** Per-train open scoring is meaningless for a non-final train in a group;
  the group end belongs to the final train. Check whether the barrier genuinely stayed down
  between them before calling it an error.
- **Don't stream state-change notifications during a long watch.** It burns turns for nothing.
  Record at 5 s and analyse once at the end.
- **Prefer replaying the feed over driving the UI.** The replay harness is more rigorous than
  screenshots and far cheaper. Open a browser only for questions genuinely about rendering, or
  for Cloudflare-gated sources.
- **Sunday/holiday windows** are sparse and STP-heavy. Good for finding schedule-data bugs,
  poor for timing calibration.

## Useful window shapes

- **Weekday 07:00–09:30** — densest service, freight, back-to-back closures. Best for grouping
  and merge behaviour.
- **Weekday 22:00–00:30** — freight and ECS, midnight-crossing schedules.
- **Sunday morning** — STP overlays and engineering variations; where schedule-source bugs surface.
- Minimum useful watch is about 90 minutes; under ~5 closures, timing figures are anecdote.
