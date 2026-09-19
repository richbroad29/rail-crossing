---
name: crossing-launch
description: The repeatable process for launching railcrossing.uk at a new level crossing — triage a candidate, prove the data exists, instrument it, derive the config, calibrate the timings without visiting the site, and gate the launch. Use when asked to evaluate, scope, assess or launch a new crossing, to decide whether a requested crossing is worth building, to work out what data a site would need, or to populate a new entry in backend/config/crossings.json.
---

# Crossing launch playbook

Purpose: take a candidate crossing from "someone requested it" to "live and accurate", by a route that
**does not require anyone to stand at the crossing with a phone**.

The one-line summary of the method: **start logging before you do anything else, let the signalling feed
calibrate the crossing for you, and refuse to launch until the gates pass.**

Read `docs/multi-crossing-readiness.md` first if the codebase hasn't been prepared yet — several
phases below assume work that may not be done.

---

## Non-negotiables

Ordered. Getting 1 wrong costs weeks, not hours.

1. **Start logging before analysis, before config, before code.** Every timing constant is derived
   from accumulated feed data. You cannot backfill a day you didn't record. The moment a candidate
   looks plausible, add its TD area to collection — *even before deciding whether to launch*. This is
   the same rule as `crossing-audit`'s "record first", and it costs more here because the horizon is
   weeks not hours.
2. **Never transfer a timing offset from another crossing.** Measured and settled: *"Yapton is not
   transferable to Portslade — different signal box, different berth geometry, and no platform dwell in
   either direction"* (`DATA-SOURCES.md`). The *structure* transfers — which berth, why a class split
   exists, what to check. The *numbers* never do. A transferred offset is worse than no launch, because
   it is confidently wrong.
3. **Prove direction resolution before anything else downstream.** Every close rule, every class, every
   merge is keyed on direction. `isEastOrigin()` in `ldb-poller.js` is a hard-coded Sussex place-name
   list that defaults to `east` — at a new crossing it silently assigns a direction to every train. If
   Phase A of the readiness review isn't done, this is your first bug and you will chase its symptoms
   for days.
4. **Berth codes are only unique within a TD area.** `0006` exists in LA and in most other areas.
   Until the area-keying fix ships, a second area means a distant train can anchor a real closure.
   Check this before adding any second area.
5. **A ship gate is a gate.** If the close-anchor spread doesn't meet the bar, the answer is "keep
   logging", not "launch with a wider confidence window". The app's stated goals are catch every
   closure, then avoid false alarms, then accurate timing — a crossing that fails gate 2 fails goal 2.

---

## Phase 0 — triage (target: 30 minutes, desk only)

Is this candidate worth anything? See `SITE-SELECTION.md` for the scoring model and the kill criteria.

Answer four questions, in this order, and stop at the first "no":

1. **Does the TD area publish C-Class berth steps covering the approach?** No berth data ⇒ the best
   possible product is a timetable readout. **Hard no.**
2. **What lowers the barrier?** MCB-CCTV (signaller, manual — Portslade), MCB-OD / AHB (automatic).
   Automatic types should be *easier* than Portslade, because the close loses its human variance. See
   `SITE-SELECTION.md` § Crossing type.
3. **How much closure is there?** Computable from CIF alone, today, with no new data — see Phase 1
   step 3. Below the threshold, the app has nothing to tell anyone.
4. **Is barrier state observable?** S-Class byte known → cheapest possible launch. Huntable → add a
   few weeks. Neither, and no local volunteer → you are signing up for a field campaign you can't run.

Record the answers in `.claude/skills/crossing-launch/CANDIDATES.md` (create it) whether or not you
proceed. A rejected candidate that's re-requested in six months should cost 5 minutes, not 30.

## Phase 1 — feasibility, and the free measurements (target: half a day)

Everything here is desk work against data already on the VPS or one fetch away. Nothing here needs a
site visit or a new subscription.

1. **Locate the crossing.** Road name, nearest station(s) and their CRS codes, the TIPLOCs either side,
   the signal box, the crossing type. Sources: Ordnance Survey / OpenStreetMap for geography, the
   Network Rail Sectional Appendix for the box and type, CORPUS (already downloaded daily) for
   TIPLOC ↔ name ↔ STANOX.
2. **Identify the TD area.** SMART is the authoritative berth ↔ STANOX ↔ area map and is available
   from the same NROD `SupportingFileAuthenticate` endpoint as CORPUS (verify the `type=` value —
   there is no fetcher for it in the repo yet, unlike `corpus-fetcher.js`). Failing that, the Open Rail
   Data wiki's describer list.
3. **Compute the closure burden from CIF, before committing to anything.** The daily extract is
   already on the VPS. Count schedules traversing the crossing's TIPLOC pair per day, apply a nominal
   close lead and open lag, merge overlaps, and report closures/day, barrier-down minutes/day, and peak-
   hour down-minutes. This is the single most valuable free number in the process: it answers "is it
   worth it" with no new instrumentation. Reference point: Portslade runs around **22 closures a day**
   (single observation, from the pre-`?limit=` payload size note in CLAUDE.md — re-measure rather than
   treating it as a constant).
4. **Check S-Class.** Is the area in `backend/config/sclass.json`? Is a crossing block already
   populated? Is the area merely in collection-only mode (`logRaw: "all"`, empty `crossings`)? The 12
   LXG-positive describers already banking raw are BM, X7, RT, EN, EH, HG, EK, B3, BU, Q3, Q5, EA.
5. **Check freight.** 6xxx/7xxx headcodes on the route, and how many carry the CIF `Q` flag. Determines
   how long Phase 5 takes — freight is the binding constraint on calibration time.

## Phase 2 — instrument (do this the day the candidate survives Phase 0)

**This phase has no deliverable and must not be deferred.** It starts the clock on everything else.

1. Add the TD area to C-Class collection. (Requires the multi-area ingest work — see
   `docs/multi-crossing-readiness.md` Phase A. Until then, `TARGET_AREA = 'LA'` blocks this outright.)
2. Add the area to `sclass.json` in collection-only mode if it isn't already: `"logRaw": "all"`,
   `"crossings": {}`. It emits zero events and banks raw bytes for the hunt in Phase 3.
3. Confirm both logs are landing and rotating. Note the **23:00Z rotation** — a strike at 22:59 looks
   missing unless consecutive days are stitched.
4. Diarise the Phase 3 review for **+14 days**.

Cost of getting this wrong: every week you delay is a week added to launch, and the data is not
recoverable.

## Phase 3 — topology, from the feed (target: 1 day, after ≥14 days of logs)

The goal is the `td` block of `crossings.json`: area, per-direction `approach.from/to`,
`clear.from/to`, and `approachChain`.

**With S-Class, the byte-hunt and the topology discovery are the same computation**, and this is the
insight the whole remote method rests on. Yapton's `byte09` binding was confirmed *"by berth-step
correlation"* — and that same correlation names the berths:

- Extract every (byte, bit) in the area that toggles, and its transition times.
- For each candidate bit, test: do episodes have plausible durations (roughly 60–600 s)? Does the
  count-per-day resemble the traversal count? Does a *consistent* berth step precede each rise at a
  tight standard deviation?
- The bit that passes is a crossing's `lowered` bit. **The berth whose strike precedes it most tightly
  is the approach anchor.** The berth step that most tightly precedes the `raised` rise is the clear
  step. That is `approach.from`, `clear.from` and `clear.to`, derived — not looked up.
- Cross-check against SMART. Agreement is confirmation; disagreement means re-check which crossing the
  bit belongs to before trusting either.

**Without S-Class**, fall back to SMART for the anchors, then run `derive-chain.js --crossing <id>` to
extend the chain outward — it reconstructs berth order and dwell from TD timestamps alone
(*"Method (no geography needed)"*). It needs the anchors as a seed, which is the chicken-and-egg S-Class
resolves for free.

**Then check for a station inside an approach berth.** This is the trap that cost Portslade the most:
Southwick sits inside eastbound berth `0006`, so calling services occupy it ~160 s against ~49 s for
those that don't — two disjoint populations that one anchor cannot serve, and the reason
`_eastClass` exists at all. **Test it at every approach berth on every new crossing**: plot berth
occupancy and look for bimodality. If it's bimodal, find the station inside the berth and set
`schedule.tiploc_approach_call`. Note the Portslade lesson that the *nearest* station is not
necessarily the culprit — Fishersgate is closer and does not split the population (41/93 mismatches);
Southwick does (0/93).

## Phase 4 — schedule wiring (target: half a day)

The `schedule` and `ldb` blocks. All desk work, all config, no measurement.

- `ldb.station` / `ldb.adjacentStations` — CRS codes. Only meaningful if a station's board covers
  trains that traverse the crossing.
- `schedule.tiploc_station` — the crossing's own station TIPLOC, CORPUS-verified. Beware: Portslade is
  `PSLDAWH`, not `PORTSLD`. Always verify against CORPUS rather than guessing the abbreviation.
- `schedule.tiplocs_west` / `tiplocs_east` — every timing point on each side. Be generous; a missing
  TIPLOC means a route that doesn't resolve. This is what makes CIF direction detection config-driven
  and correct, and it is the model the LDB side should follow.
- `schedule.interpolation` — the two timing points that bracket the crossing, and the fraction between
  them. Estimate from distance along the line; refine in Phase 5 against observed crossing instants.

**Validate the wiring before calibrating anything**: parse a day of CIF against the new config and check
the traversal count against Phase 1 step 3, the direction split against expectation, and the ambiguous/
dropped count against zero. `schedule-parser.js` logs the ambiguous multi-traversal drop; a non-trivial
count means the TIPLOC sets are wrong or the line genuinely has reversing services.

## Phase 5 — calibration (the phase that used to need a human)

Derive the `timing` block. Three sub-phases, in dependency order.

**5a. Transits — no ground truth needed, ~14 days of TD.**
Run `derive-transits.js`. Note it currently hard-codes `CHAIN`/`CLEAR` and classifies by
Portslade-specific proxies (platform dwell, berth-0006 occupancy) — parameterise it first. Cells with
n<15 are omitted rather than guessed, which is the right behaviour: an omitted cell degrades to the
bestTime fallback, a guessed one degrades to a confident lie.

Expect the dominant passenger class to reach n=15 within a day or two and freight to take **weeks** —
at Portslade freight reached only n=31 in 77 days. Freight is what sets the schedule.

**5b. Close and open offsets — S-Class does what the observer PWA did.**
Join S-Class barrier episodes to C-Class berth steps to produce, per class: `strikeInBerth`,
`closeLeadS` (strike → barrier down) and `openLagS` (clear step → barrier up). This is exactly the
shape of `yapton-episodes.csv`, which holds **1,364 episodes over 38 days** — two orders of magnitude
more than Portslade's n=8–11 human observations, and it cost nobody a Saturday.

Then:
- `closeTrigger.<dir>.classes[].berth` — the tightest-sd anchor that still fires early enough to be
  useful. Portslade chose `0003` over `0005` westbound despite marginally worse sd, because an anchor
  that fires 30 s before the barrier is useless.
- `closeTrigger.<dir>.crossingLeadSecs` — observed seconds between barrier-down and the train reaching
  the crossing. **Prefer this to per-class `offsetSecs`**: offsets derive at runtime as
  `transit[berth>XING] − crossingLeadSecs`, so they follow the transit table when it's regenerated
  instead of drifting away from it. One calibrated number beats four hand-copied ones.
- `openLagSecs.<dir>.<class>` — clear step → barrier up. Where the raise is automatic this is tight
  (Portslade west: mean 18.9, sd 5.3, n=8).
- `safetyNetSecs`, `minAfterStrikeSecs`, `predictedLeadSecs`, `mergeOppositeMaxGapSecs` — see
  `VARIABLES.md` for what each protects against and how to set it.

**5c. What to do about freight before its sample matures.**
Do not guess a freight offset and do not borrow the passenger one — freight ran ~100 s slower than fast
passenger at *every* berth at Portslade, so sharing a rule is a guaranteed early close. Until n is
adequate: anchor freight to the earliest feasible berth with a deliberately conservative (early) offset,
and let the four-state freight label carry the doubt to the user. Early is the safe direction; goal 1 is
catch every closure.

## Phase 6 — ship gates

Launch only when **all** of these hold. Each has a stated basis; tighten them as real cross-site data
accumulates, and record any change here with its reason.

| # | Gate | Bar | Basis |
|---|---|---|---|
| 1 | Barrier episodes observed | ≥ 200 (S-Class) or ≥ 30 attributed (human) | Portslade shipped on n=8–11 and needed repeated recalibration; Yapton reached 1,364 in 38 days |
| 2 | Close-anchor spread, dominant class | sd < 45 s | Portslade west: anchor sd ~22 s + close-lead sd ~34 s. 45 s ≈ "no worse than the live site" |
| 3 | Open-lag spread | sd < 20 s | Portslade west sd 5.3, east sd 9.0. Generous headroom |
| 4 | Direction resolution | ≥ 99% of movements resolved, **no silent default** | An unresolved direction must be `unknown`, never a guess |
| 5 | Replay integrity | 0 inverted periods, 0 "CLEAR with a train on the crossing" over ≥ 3 days replayed | Registers #14/#15 — both were real, both were invisible without replay |
| 6 | Freight false positives | Q-flagged predicted-but-unsighted rate measured and surfaced | Goal 2: avoid false alarms |

Gate 5 is the `crossing-audit` skill's job — hand off to it rather than reimplementing. Run it against
the new crossing **before** launch, not after.

## Phase 7 — launch

1. `backend/config/crossings.json` entry, with a provenance comment on every calibrated number: sample
   size, sd, date, and how it was derived. This repo's config is simultaneously its calibration
   documentation, and that is why the Portslade numbers survived contact with six months of tuning.
   Mark any un-calibrated value explicitly **GUESS**, as the Portslade entry does.
2. `backend/data/transits.json` regenerated with the new crossing's key.
3. `shared/crossings.json` entry — presentation only: `name`, `road`, `station`, `feedbackUrl`,
   `confidenceWindows`. Nothing physical.
4. Front-end route. Until the shell is parameterised this means copying `portslade/index.html`; add the
   new path to `scripts/bump-assets.sh` `FILES=` or its assets go unstamped, which is the 2026-08-10
   failure mode.
5. `sh scripts/bump-assets.sh`, commit, push `main`.
6. Deploy backend per CLAUDE.md (`git merge --ff-only`, restart, verify `active (running)`).
7. **Verify by reading the RUNNING code, not the file** — `curl` bypasses the service worker. Use
   `.claude/skills/crossing-audit/scripts/stale-check.js`.

## Phase 8 — post-launch watch

1. Run `crossing-audit` on days 1, 7 and 30.
2. Keep S-Class calibration running. It doesn't stop when you launch — it is a permanent, free,
   continuously-improving ground truth, which is a thing Portslade has never had.
3. Re-derive transits monthly for the first quarter, then quarterly.
4. Add crossing-specific findings to `crossing-audit/KNOWN-ISSUES.md`, tagged with the crossing id.

---

## Time and cost summary

| Path | Elapsed | Human site time |
|---|---|---|
| S-Class byte already known | ~3 weeks | **none** |
| S-Class byte needs hunting | ~6 weeks | **none** |
| No S-Class, local volunteer with the observer PWA | 3+ months | many sessions |
| No S-Class, no volunteer | — | not viable; don't start |

The elapsed time is almost entirely **waiting for the feed to accumulate**, not working. Three
candidates can be instrumented in parallel for roughly the cost of one, which is the strongest argument
for doing Phase 2 early and speculatively on anything that clears Phase 0.

---

## References

- `SITE-SELECTION.md` — triage scoring, kill criteria, crossing types
- `VARIABLES.md` — every config variable: what it is, where it comes from, what breaks if it's wrong
- `docs/multi-crossing-readiness.md` — the codebase work these phases assume
- `.claude/skills/crossing-audit/` — the pre-launch integrity check and the post-launch watch
- `.claude/skills/crossing-audit/DATA-SOURCES.md` — where every existing dataset lives
