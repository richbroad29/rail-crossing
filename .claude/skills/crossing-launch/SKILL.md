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
> 2026-11-19: berth-first (docs/berth-first-design.md §9). Gate 1 is now 25 minutes of berths on every
> route in, rejected in plain words; Stage 2 starts from the national berth log (live since 19 Nov);
> new berth-log measurements (one train per berth, overtaking, coverage, stall and run-through
> thresholds) and ship gates 8–12. Each change is marked **Now** (true today) or **Berth-first**
> (only once that engine ships), because the engine predicting today is still the old one.

Take a candidate from "someone asked for it" to "live and accurate" **without anyone standing at the
crossing**. The signalling feed calibrates it: start logging first, measure everything from the feed,
and launch only through the gates.

Four references, each the single source for its subject:

- `docs/crossing-definition.md` — every variable a crossing has: meaning, Portslade's value, and whether
  the code reads it yet (Status column).
- `MEASURING.md` (this folder) — how to obtain each variable and what breaks when it is wrong.
- `SITE-SELECTION.md` (this folder) — the triage gates and scoring. `CANDIDATES.md` — every assessment.
- `docs/berth-first-design.md` — the agreed redesign: closures only from trains the berths have seen,
  timetable and Darwin as a forecast layer. Read §4–§5 before Stages 3–5: they say what the new
  measurements are for.

**Now / Berth-first.** Steps marked **Berth-first** feed an engine that is designed but not built. Do
them anyway when they are cheap (they are measurements from logs we already hold), but a crossing
launches on today's engine until berth-first ships: its gates are 1–7 plus any marked **Now**.

## Rules that hold at every stage

1. **Record first.** Every timing comes from accumulated feed data, and a day not recorded cannot be
   recovered. Since 2026-11-19 every area's berth steps AND raw S-Class (barrier bits) are logged
   nationally and permanently (Stage 2), so recording is already done for any candidate. What is not
   done is keeping it: every log is pruned at **90 days**, so copy out anything needed for longer.
2. **Numbers never transfer between crossings.** The structure does (which berth, why a class split
   exists); the numbers are measured per site. Yapton's timings are not Portslade's.
3. **Provenance or GUESS.** Every number in a definition carries sample size, spread, date and method,
   or is labelled `GUESS`. Portslade's `_comment_*` keys are the model.
4. **The definition is the only source.** Public files are generated from it; edit the definition or
   `scripts/templates/crossing-page.html` and rebuild, never the generated files.
5. **A gate is a gate.** A failed gate means keep logging. The app's goals, in order: catch every
   closure, avoid false alarms, then timing accuracy.
6. **The berths are the final word** (Berth-first). A timetable can take a train off the forecast; it can
   never stop a closure the berths are showing. Any measurement whose error would show a train later
   than it really arrives is the dangerous direction: say so in its provenance.

## Code readiness — check before Stage 1

The engine supports only what Portslade needed. For each variable in `docs/crossing-definition.md`
whose Status is **Hard-coded** or **Partial**, compare the candidate's value with Portslade's. Every
difference is code work that must ship before this crossing can be calibrated. The ones most likely to
bite: no adjacent station (`ldb.station` none currently crashes the board poll), automatic barriers
(`closeModel`), bidirectional track, more than one clear step, a junction inside the approach, a
crossing spanning two TD areas, **more than one track per direction across the road** (Now: not
supported by either engine; design it against the first such crossing's data).

Berth-first removes two of these: a junction inside the approach and an approach spanning several
areas become ordinary, because routes are learned from the logs rather than listed by hand. Until it
ships they are still code work.

**Exit:** a list of required code changes (or "none") in the candidate's `CANDIDATES.md` row.

---

## Stage 0 — Triage (desk, ~30 min)

- **In:** a crossing name or road.
- **Do:** run the four gates in `SITE-SELECTION.md`, cheapest first, stopping at the first failure.
  Gate 1 is 25 minutes of berths on every route in (Now); its rejection wording is fixed there.
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
  - S-Class: does the area publish barrier bits (the `crossing-directory-refresh` barrier scan lists the
    candidates), and is a byte:bit known for this crossing (`backend/config/sclass.json`)?
  - Closure burden from CIF: closures/day, barrier-down minutes/day, peak-hour down-minutes.
  - Freight: 4xxx/6xxx/7xxx/8xxx on the route and how many are runs-as-required. Freight sets how long
    Stage 4 takes.
  - **Every TD area** covering 25 minutes on every route in, not just the crossing's own (Now).
  - **Stations within 25 minutes where trains start**, from timetable origins (Now). Their trains are
    timed from booked departure until they leave the platform (design §5.9).
  - **The last junction** before the crossing on each route: from there in, every train crosses (Now).
  - **Tracks per direction** on each approach and across the road, and where parallel tracks merge
    (Now). More than one track per direction across the road is code work (Code readiness).
- **Out:** draft values for definition §1–5 and §12.
- **Exit:** every Desk variable in `MEASURING.md` has a value or a recorded reason it has none.

## Stage 2 — Check the logs (the same day)

- **In:** the TD area(s).
- **Do:**
  - **Nothing needs switching on — every area is already logged.** One retention policy for every log
    on the VPS: **kept 90 days, then pruned** (`backend/src/retention.js`, since 2026-11-19, backend-v2
    `6d3421a`). Files are under `backend/data/` and named by **London** date. Check the candidate's
    areas appear in each:

    | Log | Where | Since | Notes |
    |---|---|---|---|
    | Berth steps, every area | `logs/td-all/td-all-<date>.jsonl(.gz)` | 2026-11-19 | Raw CA/CB/CC/CT with receive time `rx`, one line per message |
    | Raw S-Class (barrier bits), every area not in `sclass.json` | `logs/sclass/survey-<date>.jsonl(.gz)` | 2026-11-12 | Permanent since 2026-11-19 (`sclass.json` `survey.until: "always"`); gzipped the next day |
    | Raw S-Class + decoded barrier events, areas in `sclass.json` | `logs/sclass/sclass-<date>`, `barrier-<date>`, `cclass-<AREA>-<date>` | 2026-06-23 (BM) | The 12 configured areas |
    | Train movements (TRUST) | `logs/trust/` | 2026-11-19 | |
    | Short-notice timetables (VSTP) | `logs/vstp/` | 2026-11-19 | |
    | Timetable (CIF): a full weekly + every daily update | `schedule/archive/cif-<full\|update>-<date>-<seq>.json.gz` | 2026-11-19 | Rebuild day X from the newest full on or before X plus the later updates in sequence order. Nothing earlier than 19 Nov can be rebuilt |
    | Board: lateness, cancelled services (`cat:"ldb"`, `"ldbCancelled"`) | `logs/<date>.jsonl` (daily app log) | — | **Only for crossings with a definition**: a new crossing's board station is polled once its definition exists |
    | Crossing berth log | `logs/td/<AREA>/` | — | Added by the crossing's definition |

  - **90 days is the ceiling for any derivation.** If a calibration window, a backtest or an audit
    will reach back further, copy that area's lines out to the Mac (`~/rc-data/`) before they are
    pruned. History older than 90 days at 2026-11-19 (Portslade from 22 Mar, Yapton and the 12 S-Class
    areas from 23 Jun, up to 31 Aug) is on the Mac at `~/rc-data/archive/`, not on the VPS.
  - Adding an area to `backend/config/sclass.json` is needed only to **decode** its barrier live, once
    the byte:bit is known (Stage 3). It moves the area's raw S-Class from `survey-<date>` to
    `sclass-<date>`; the barrier scan reads both.
  - Confirm the logs land and rotate (files are named by **London** date).
  - Gap-check weekly: one file per day, each ending just before London midnight. The feed watchdog only
    notices the *whole* feed stopping, not one area going quiet. Exclude gap days from every derivation.
    Record each area's normal longest silence by time of day, and whether it sends heartbeats (CT)
    (Berth-first: the outage detector, design §5.11).
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
  - **Now — measurable from the logs today, `MEASURING.md` has each method:**
    - **Coverage horizon per route:** first sighting → clear step. Gate 1's number, measured.
    - **Routes in and the last junction:** walk back from every clear step over the berths each train
      used, across areas (`td-all`). By script until the route-learning tool exists.
    - **One train per berth**, per approach berth: *holds* or *exempt*.
    - **Overtaking count** per approach, and which tracks merge where.
    - **Normal time per berth** per class, stopping and non-stopping separately where a station is
      inside the berth (the stall rule's input).
    - **Run-through evidence** at each station on the approach: what separates trains booked to stop
      that ran through (Darwin stop cancelled; short time in a berth; leaving a station berth sooner than
      any stopper), and the threshold.
- **Out:** definition §6, the geography half of §6a, and §14.
- **Accept:** each direction's berths are disjoint (or the crossing is flagged bidirectional); SMART
  agrees with the derived anchors; every bimodal berth has a named station; every route in has a path
  to the clear step; every approach berth is marked for one-per-berth; the overtaking count is recorded
  (any overtake on a route means the no-overtaking rule is per track there, design §5.7).

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
  - **Outermost-berth offsets** (Now): for each route's outermost berth, booked time at the nearest
    timing point → step into that berth, median and spread. Berth-first uses it only to decide when to
    check on a train that hasn't appeared, never as a closure time (design §5.8).
  - Berth-first narrows this stage: the timetable supplies identity, type, stopping pattern, the route
    test and the outermost-berth time; the board time is used only for far-out forecasts.
- **Out:** definition §3–5 and the timetable rows of §14.
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
  - **Berth-first thresholds** (§14), each with provenance or `GUESS`: deadline buffer per class (from
    lateness at the outermost berth), no-status cut-off, stall threshold per berth and class,
    run-through thresholds, forecast error band by minutes out, feed-silence threshold per area.
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
| 8 | Untimetabled trains (Berth-first) | 0 missed closures in replay for trains the berths saw but no timetable had | Portslade's live app missed 64 such in 46 days |
| 9 | Feed down (Berth-first) | Outage and restart shown in replay: the "unavailable" message, never an empty "no closures" | Design §5.11–5.12 |
| 10 | Replayable inputs (Berth-first) | Every input the crossing uses is logged and drives the replay | Design D15 |
| 11 | Coverage (Now) | Horizon ≥ 25 min on every route, or the starting-station rule documented for that route | Gate 1, measured in Stage 3 |
| 12 | Closing soon lead (Now) | ≥ 99% of closures had their train on the berths ≥ 90 s before barrier-down | Portslade 99.4% over 47 days |

Gate 5 is `crossing-audit`'s job; hand off to it. Gates 8–10 apply once berth-first is the engine.

## Stage 7 — Launch

- **Before going live** (burger-menu ticket 12; the page is generated, nothing is typed):
  1. The definition carries `crossingNumber` (its Network Rail number; the build stops without it).
  2. **Check its position by eye**: compare its `lat`/`lon` in `scripts/crossing-list.csv` with
     satellite imagery and OpenStreetMap's level-crossing node. Network Rail is sometimes 80-200 m off
     (usually at the station); correct the list, note it in `position_check`, set `hand_checked=yes`.
  3. `presentation.stationName` set, and a plain-words entry for its Network Rail type in
     `TYPE_WORDS` (`scripts/build-crossings.js`) if it is a type no live crossing has yet.
  4. Its measured figures, once it has logged a few weeks: on the VPS,
     `node backend/scripts/crossing-figures.js --crossing <id> --from <date> --to <date>`, pasted
     into `presentation.figures`.
  5. Its local map picture: `node scripts/render-local-maps.mjs <id>` on the Mac (opens Chrome
     off-screen; look at `<id>/local-map.webp` before committing).
- **Do:** set `listed: true`, push and deploy the backend, rebuild on `main`, `--check`, commit, push.
  Verify the **running** code with `.claude/skills/crossing-audit/scripts/stale-check.js`, not with
  `curl`, which bypasses the service worker.
- **Then check what crawlers see:** `curl -s -A OAI-SearchBot https://railcrossing.uk/<id>/` must
  show the title, the `<h1>`, the meta description and the About block without running any code.
  Then `node scripts/indexnow.mjs /<id>/ /` tells Bing and the other IndexNow engines about the new
  page and the homepage (Google finds it through the sitemap).
- **Exit:** the crossing is on the home page and in `sitemap.xml`, and the live page shows predictions.

## Stage 8 — Watch

- `crossing-audit` on days 1, 7 and 30; findings into `crossing-audit/KNOWN-ISSUES.md` tagged with the id.
- S-Class calibration keeps running: free ground truth, 90 days of it at any time.
- Regenerate the berth timings monthly for the first quarter, then quarterly.

---

## Elapsed time

| Path | Elapsed | Site visits |
|---|---|---|
| S-Class byte known | ~3 weeks | none |
| S-Class byte to hunt | ~6 weeks | none |
| No S-Class | not supported | — |

Almost all of it is waiting for logs. Since 2026-11-19 every area is logged before it is a candidate,
so the wait is already running for all of them (up to the 90-day window); Stage 2 is now a check.

## Open questions

- **Calibration tooling.** To be rewritten from scratch. Stages 3 and 5 state inputs, outputs and
  acceptance checks only; fill in the commands when the tools exist. They must read the national logs
  (`td-all/`, `sclass/survey-*`), the collection logs (`sclass/sclass-*`, `sclass/cclass-<AREA>-*`), the
  crossing log (`td/<AREA>/`) and the timetable archive (`schedule/archive/`), all plain and `.gz`.
- **Unwired variables.** Most of the definition is still Hard-coded to Portslade. The close algorithm
  was unified (2026-11-06) and the direction slots made per-crossing names (2026-11-12); re-check the
  Code readiness list after each further change lands.
- **Crossings without S-Class.** Rich: only sites with barrier data for now. The observer app is
  Portslade-only and internal, so there is no field-observation path for a new site.
- **Dark run visibility.** An unlisted crossing still has a reachable page and is predicted live by the
  backend. Acceptable for now; revisit if a dark crossing must be fully private.
- **Gate bars** come from Portslade (MCB-CCTV). Untested on an automatic crossing, where the close should
  be much tighter.
- **Route learning** (Berth-first) is the same rewrite as the calibration tooling above: one tool that
  walks back from each clear step gives the routes, the junctions and the per-berth timings together.
- **More than one track per direction across the road.** Not supported; design it when first met,
  against that crossing's data.
- **Berth-first itself.** Until it ships, the **Berth-first** steps above produce numbers nothing reads.
  When it ships, rewrite this skill around it and drop the markers.
