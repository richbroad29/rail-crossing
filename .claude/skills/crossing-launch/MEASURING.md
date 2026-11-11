# How to measure each variable

Companion to `SKILL.md`. **What** each variable means, Portslade's value, and whether the code reads it
are in `docs/crossing-definition.md` (§ numbers below are its sections). This file holds the two things
that document does not: **how to get the value**, and **what the app does wrong when it is wrong** —
usually how the error is first noticed.

Grouped by how the value is obtained, because that decides which stage produces it.

---

## Desk — free, immediate (Stage 1)

| Variable (§) | How | If wrong |
|---|---|---|
| Name, road, page text (§1) | Map / OpenStreetMap | Cosmetic |
| Crossing type, close/open model, signal box (§2) | Network Rail Sectional Appendix | The close and open logic assume a signaller-lowered, auto-raised crossing; a different type mispredicts both ends until the model is wired |
| Board station (§4) | National Rail; a station whose board lists trains that cross | No board trains ⇒ timetable-only accuracy, silently. None at all currently crashes the board poll |
| Station TIPLOC (§5) | **CORPUS-verified**, never guessed from the name | Every timetabled passenger train read as non-stopping ⇒ wrong class |
| Timing points each side (§5) | CORPUS + route map; be generous | A missing TIPLOC means the route never resolves and **the train is invisible** |
| Station side (§5) | Which side of the crossing the platform is | Trains starting or terminating at the station, crossing on the way, are missed |
| TD area(s) (§6) | SMART, or the Open Rail Data describer list | No berth data: every position-based path is dead |
| Barrier feed byte:bit (§12) | `sclass.json`, community maps, or the Stage 3 hunt | No barrier truth ⇒ no remote calibration |
| `feedbackUrl` (§1) | An Apps Script endpoint | Feedback silently discarded (the post is `no-cors`; failure is invisible) |

## Board and direction (Stage 4)

| Variable (§) | How | If wrong |
|---|---|---|
| Slot names and Up/Down per slot (§3) | Name the two slots whatever reads naturally for the line (`east`/`west`, `up`/`down`, `north`/`south`); the code reads them from the definition. Record each slot's Up/Down from the Sectional Appendix line diagrams | Documentation only (`line` is not read). Every per-direction block must use the same two names, or the backend refuses to start |
| `placesBeyond` (§3) | List every origin and destination the board shows over a few weeks, by side. Check against the timetable direction: ≥ 99% agreement | A board train is given the wrong direction, so its berth strikes are never matched and it stays on the timetable estimate to the road |
| Board time per direction (§4, `directions.<d>.boardTime`) | **Decide** from the map: arrival if the train reaches the crossing before the platform, departure if after. **Then confirm from the feed** (≥ 14 days of logs): for each direction, join the board's actual arrival and actual departure to the train's crossing time (the clear step onto the road, Stage 3) and compare the spread (sd) of crossing − arrival with that of crossing − departure. Pick the time with the smaller spread; if the feed disagrees with the map, the feed wins and the reason goes in the definition's comment. Record the winning median and sd as `stationToCrossingSecs` (§4) with n and dates. Portslade west: departure, crossing a median 46 s after it (sd 16 s, n = 8); Darwin's live departure predicted the crossing with sd 48.8 s against 19.6 s for the 0005 berth step (n = 771) | The far-out estimate is off by the whole station stop, and the feedback picker shows the wrong time column |
| Seconds from each timing point to the road (§5) | Distance first, then refined against observed crossing instants | Timetabled crossing times skewed ⇒ freight and far-out trains predicted at the wrong time |
| Stations inside approach berths (§5, §6a) | The bimodal-occupancy test in Stage 3, then name the station | Class split wrong. Portslade: Southwick 0/93 mismatches, Fishersgate (nearer) 41/93 |

## From the berth logs — no barrier truth needed (Stages 3 and 5)

| Variable (§) | How | If wrong |
|---|---|---|
| Berth order per direction (§6a) | Step order and dwell from TD timestamps, seeded by the anchors | Position labels and the "still upstream" checks lose their ordering |
| Clear step(s) (§6) | The step most tightly preceding barrier-up (S-Class), else SMART | **Open never anchors**; a closure can read CLEAR with a train on the road (register #14) |
| Berth timings per class (§6a) | Median, spread and n per berth pair, per class; under 15 trains left out | No projection; every path falls back to timetable times. Degrades gracefully |
| Queue distance (§8) | Delay by distance to the train ahead, against trains with nothing ahead | Too large: "Train held" for trains that aren't delayed. Too small: queued trains predicted early |
| Position staleness, memory times (§6) | Longest normal berth occupancy plus a margin | Too short: trains vanish mid-approach. Too long: ghosts |
| No-show lead (§6) | Where the area boundary sits relative to the crossing | Real trains near an area edge dropped as no-shows |

## Needs barrier truth (S-Class) — Stage 5

| Variable (§) | How | If wrong |
|---|---|---|
| Close lead (§8) | Median of barrier-down → train on the road over episodes. **The one number to calibrate**; per-class offsets derive from it | Every class closes early or late together |
| Trigger berth per class (§8) | Tightest-spread berth that still fires early enough to warn | Fires after the barrier is already down (Portslade's early 0006 anchor landed a median 29 s late) |
| Open lag per class (§9) | Median clear step → barrier up | Barrier shown up while still down — **the dangerous direction** |
| Far-out leads and fallbacks (§8, §9) | Measured separately for board times and timetable times | The countdown lurches when the first berth strike lands |
| Safety net (§8) | Must sit **after** the class trigger | Becomes the main path: Portslade's 210 s fired before the trigger for 34/34 trains |
| Merge gaps (§10) | Observed gaps between one barrier-up and the next barrier-down | Over-merge: one long phantom closure. Under-merge: two closures where the barrier never lifted. Portslade's 20 s has no recorded basis — do better |

## Presentation — Stage 6

`listed` (false until launch), page title, description, home-screen names, station name, confidence
windows (start at Portslade's, tighten as spread data arrives), display chain. All in the definition's
`presentation` block; `scripts/build-crossings.js` fails if a required one is missing.

---

## Minimum to dark-run

**Required:** desk facts, TD area, berth order, clear step per direction, place lists, timing points.
**Strongly wanted:** board station, station TIPLOC, berth timings.
**Allowed as early `GUESS` while Stage 5 matures:** the barrier-truth group, freight above all.

A dark run on guesses is honest only if the confidence windows are widened to match and the guesses
are labelled.
