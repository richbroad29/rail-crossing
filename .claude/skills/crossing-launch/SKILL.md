---
name: crossing-launch
description: The process for adding a new level crossing to railcrossing.uk — triage a requested crossing, start logging its area, derive its berths and timings from the signalling feed, write its definition file, dark-run it, and launch. Use when assessing, scoping or launching a crossing, or when writing a new backend/config/crossings/<id>.json.
---

# Adding a crossing

> **Changelog** — 2026-11-06: rewritten around the per-crossing definition file and generated pages
> (items 1–9 of `docs/multi-crossing-readiness.md` shipped). Calibration tooling is marked *to be
> rebuilt*. Add a dated line here whenever a stage changes, and say why.
> 2026-11-12: direction slots are named by the definition, not the code (any two names; every
> per-direction block keyed by them). Board time per direction is a live setting and Stage 4 now
> confirms it from the feed instead of only from the map, because a wrong pick is silent.

Take a candidate from "someone asked for it" to "live and accurate" **without anyone standing at the
crossing**. The signalling feed calibrates it: start logging first, measure everything from the feed,
and launch only through the gates.

Three references, each the single source for its subject:

- `docs/crossing-definition.md` — every variable a crossing has: meaning, Portslade's value, and whether
  the code reads it yet (Status column).
- `MEASURING.md` (this folder) — how to obtain each variable and what breaks when it is wrong.
- `SITE-SELECTION.md` (this folder) — the triage gates and scoring. `CANDIDATES.md` — every assessment.

## Rules that hold at every stage

1. **Record first.** Start logging the candidate's area the day it survives triage. Every timing comes
   from accumulated feed data, and a day not recorded cannot be recovered.
2. **Numbers never transfer between crossings.** The structure does (which berth, why a class split
   exists); the numbers are measured per site. Yapton's timings are not Portslade's.
3. **Provenance or GUESS.** Every number in a definition carries sample size, spread, date and method,
   or is labelled `GUESS`. Portslade's `_comment_*` keys are the model.
4. **The definition is the only source.** Public files are generated from it; edit the definition or
   `scripts/templates/crossing-page.html` and rebuild, never the generated files.
5. **A gate is a gate.** A failed gate means keep logging. The app's goals, in order: catch every
   closure, avoid false alarms, then timing accuracy.

## Code readiness — check before Stage 1

The engine supports only what Portslade needed. For each variable in `docs/crossing-definition.md`
whose Status is **Hard-coded** or **Partial**, compare the candidate's value with Portslade's. Every
difference is code work that must ship before this crossing can be calibrated. The ones most likely to
bite: no adjacent station (`ldb.station` none currently crashes the board poll), automatic barriers
(`closeModel`), bidirectional track, more than one clear step, a junction inside the approach, a
crossing spanning two TD areas.

**Exit:** a list of required code changes (or "none") in the candidate's `CANDIDATES.md` row.

---

## Stage 0 — Triage (desk, ~30 min)

- **In:** a crossing name or road.
- **Do:** run the four gates in `SITE-SELECTION.md`, cheapest first, stopping at the first failure.
- **Out:** a `CANDIDATES.md` row with gate results and a verdict.
- **Exit:** verdict is Rejected (permanent reason), Parked (the condition that would revive it), or
  Proceed.

## Stage 1 — Desk facts (~half a day)

- **In:** a Proceed verdict.
- **Do:**
  - Locate it: road, crossing type, signal box, nearest stations and CRS codes (Sectional Appendix,
    OpenStreetMap).
  - TIPLOCs either side and the crossing's own station TIPLOC, **verified against CORPUS** (Portslade is
    `PSLDAWH`, not `PORTSLD`).
  - The TD area(s) covering the approach (SMART, or the Open Rail Data describer list).
  - S-Class: is the area in `backend/config/sclass.json`, and is a byte:bit known for this crossing?
  - Closure burden from CIF: closures/day, barrier-down minutes/day, peak-hour down-minutes.
  - Freight: 4xxx/6xxx/7xxx/8xxx on the route and how many are runs-as-required. Freight sets how long
    Stage 4 takes.
- **Out:** draft values for definition §1–5 and §12.
- **Exit:** every Desk variable in `MEASURING.md` has a value or a recorded reason it has none.

## Stage 2 — Start logging (the same day)

- **In:** the TD area(s).
- **Do:**
  - Add each area to `backend/config/sclass.json` in collection mode (`"logRaw": "all"`,
    `"crossings": {}`) and deploy. This banks the area's berth steps (`data/logs/sclass/cclass-<AREA>-*`)
    and raw S-Class without creating a crossing. A crossing's own definition later adds its area to the
    main berth log, `data/logs/td/<AREA>/`.
  - Confirm the logs land and rotate (files are named by **London** date).
  - Gap-check weekly: one file per day, each ending just before London midnight. The feed watchdog only
    notices the *whole* feed stopping, not one area going quiet. Exclude gap days from every derivation.
- **Out:** a growing, gap-checked log for each area.
- **Exit:** ≥ 14 days of gap-free logs before Stage 3; freight needs weeks more.

## Stage 3 — Berths from the feed (~1 day)

- **In:** ≥ 14 days of logs.
- **Do** (*tooling to be rebuilt*):
  - **Berth geography, per direction** (definition §6a): every berth in the order a train meets it, the
    clear step(s) onto the road, what each berth contains (station, platform), typical time in each.
  - **With S-Class**, the byte hunt and the berth discovery are one computation: the bit whose episodes
    have plausible durations and a count matching traversals is the barrier; the berth step that most
    tightly precedes "lowered" is the close anchor, and the one before "raised" is the clear step.
  - **Without S-Class**, take the anchors from SMART and extend the chain outward from TD step order.
  - **Station-inside-a-berth test** at every approach berth: bimodal occupancy means a station stop
    splits the timings (Portslade: Southwick inside 0006, 160 s vs 49 s). The nearest station is not
    necessarily the one; test each.
- **Out:** definition §6 and the geography half of §6a.
- **Accept:** each direction's berths are disjoint (or the crossing is flagged bidirectional); SMART
  agrees with the derived anchors; every bimodal berth has a named station.

## Stage 4 — Timetable, board and direction (~half a day)

- **In:** Stage 1 facts, Stage 3 berths.
- **Do:**
  - Timing points each side, the side the crossing's own station counts as, seconds from each nearby
    timing point to the crossing (definition §5).
  - The board station, or none (§4); which board time (arrival, departure) is nearest the crossing in
    each direction (`directions.<d>.boardTime`): decide from the platform position, then **confirm
    from the feed** — `MEASURING.md` has the method. Only arrival and departure are supported; a
    crossing whose board station is not at the crossing needs code work first.
  - Direction (§3): name the two slots (any names — every per-direction block in the definition
    uses the same two), each slot's Up/Down designation, label, `presentation.directions` arrow,
    marker and colour, and `placesBeyond` — every origin and destination the board shows, by which
    side of the crossing it lies.
  - Timing points each side as `schedule.tiplocsBefore.<d>`: the points a train going that way
    passes BEFORE the crossing.
  - **Validate** against a day of CIF: traversal count matches Stage 1, no ambiguous drops; place lists
    agree with the timetable direction on ≥ 99% of matched board trains (Portslade: 34,028 / 34,031);
    the board-time check above agrees with the map, or the definition says why not.
- **Out:** definition §3–5.
- **Exit:** validation passes, and no board train resolves to a guessed direction.

## Stage 5 — Calibrate (*tooling to be rebuilt*)

- **In:** logs, berths, classes.
- **Do:**
  - **Berth timings per class** (§6a timings, the generated `<id>.timings.json`): seconds from every
    approach berth to the road and between any two berths, per class, with median, spread and n; a
    queued-train set alongside. Cells under 15 trains are left out, never guessed.
  - **Barrier episodes** (S-Class, joined to berth steps): per class, the close lead (barrier down →
    train on the road) and the open lag (clear step → barrier up).
  - **Close rule per class** (§8): the tightest-spread trigger berth that still fires early enough to be
    useful, and its offset — preferably derived from one calibrated lead so it follows the timings when
    they are regenerated.
  - **Open lag per class** (§9), merge gaps (§10), queue settings (§8).
  - **Freight before its sample matures:** the earliest feasible trigger with a deliberately early
    offset, labelled `GUESS`. Never the passenger rule; freight ran ~100 s slower at every Portslade
    berth.
- **Out:** definition §6a timings and §7–10.
- **Accept:** each timing reproduces out-of-sample on held-back days; gates 1–3 below pass.

## Stage 6 — Write the definition and dark-run it

- **In:** everything above.
- **Do:**
  1. Write `backend/config/crossings/<id>.json` on `backend-v2` (copy `portslade.json`; the file name is
     the id). Include `presentation` with **`listed: false`**.
  2. Run the backend tests, push, deploy per CLAUDE.md (`merge --ff-only`, restart, verify).
  3. On `main`: `git fetch`, `node scripts/build-crossings.js`, then `--check` must pass. Commit the
     generated files and push. The page now exists at `/<id>/` but is not listed or in the sitemap.
  4. Let it run live for ≥ 3 days. Run `crossing-audit` against it and compare its closures with the
     S-Class barrier truth.
- **Exit:** all ship gates pass.

### Ship gates

| # | Gate | Bar | Basis |
|---|---|---|---|
| 1 | Barrier episodes observed | ≥ 200 | Yapton reached 1,364 in 38 days; Portslade shipped on 8–11 and needed repeated recalibration |
| 2 | Close-trigger spread, main class | sd < 45 s | ≈ no worse than Portslade (trigger sd ~22 s + lead sd ~34 s) |
| 3 | Open-lag spread | sd < 20 s | Portslade 5–9 s |
| 4 | Direction | ≥ 99% resolved, none guessed | An unresolved train is `unknown`, never a default |
| 5 | Replay integrity | 0 open-before-close, 0 CLEAR with a train on the road, over ≥ 3 days | Registers #14/#15 |
| 6 | Data continuity | No unexplained gap in the calibration window | Register #21 |
| 7 | Freight false alarms | Predicted-but-never-seen rate for runs-as-required trains measured and shown | Goal 2 |

Gate 5 is `crossing-audit`'s job; hand off to it.

## Stage 7 — Launch

- **Do:** set `listed: true`, push and deploy the backend, rebuild on `main`, `--check`, commit, push.
  Verify the **running** code with `.claude/skills/crossing-audit/scripts/stale-check.js`, not with
  `curl`, which bypasses the service worker.
- **Exit:** the crossing is on the home page and in `sitemap.xml`, and the live page shows predictions.

## Stage 8 — Watch

- `crossing-audit` on days 1, 7 and 30; findings into `crossing-audit/KNOWN-ISSUES.md` tagged with the id.
- S-Class calibration keeps running: free, permanent ground truth.
- Regenerate the berth timings monthly for the first quarter, then quarterly.

---

## Elapsed time

| Path | Elapsed | Site visits |
|---|---|---|
| S-Class byte known | ~3 weeks | none |
| S-Class byte to hunt | ~6 weeks | none |
| No S-Class | not supported | — |

Almost all of it is waiting for logs. Instrument several candidates at once; Stage 2 costs minutes.

## Open questions

- **Calibration tooling.** To be rewritten from scratch. Stages 3 and 5 state inputs, outputs and
  acceptance checks only; fill in the commands when the tools exist. They must read both the collection
  log (`sclass/cclass-<AREA>-*`) and the crossing log (`td/<AREA>/`).
- **Unwired variables.** Most of the definition is still Hard-coded to Portslade. The close algorithm
  was unified (2026-11-06) and the direction slots made per-crossing names (2026-11-12); re-check the
  Code readiness list after each further change lands.
- **Crossings without S-Class.** Rich: only sites with barrier data for now. The observer app is
  Portslade-only and internal, so there is no field-observation path for a new site.
- **Dark run visibility.** An unlisted crossing still has a reachable page and is predicted live by the
  backend. Acceptable for now; revisit if a dark crossing must be fully private.
- **Gate bars** come from Portslade (MCB-CCTV). Untested on an automatic crossing, where the close should
  be much tighter.
