# The crossing definition — every variable a crossing has

**Status:** draft for review, 2026-11-06. Nothing here changes behaviour yet.
**Worked example:** Portslade (Boundary Road). Every row gives Portslade's value.

This is the complete list of what makes one level crossing different from another, as far as this app
is concerned. It came from reading every line of the backend (`backend-v2`) and the public website
(`main`) for anything that is only true at Portslade, plus the existing settings in
`backend/config/crossings.json` and `shared/crossings.json`. The internal observer app is out of scope.

It supersedes `.claude/skills/crossing-launch/VARIABLES.md` as the list of variables. That file stays
useful for *how to measure* each one.

## How to read the Status column

| Status | Meaning |
|---|---|
| **Live** | The code reads this setting today. The name may move when the definition is restructured. |
| **Partial** | A setting exists, but the code only honours it in one direction, or wraps it in a rule that only fits Portslade. |
| **Hard-coded** | The behaviour exists but is written into the code with Portslade's value. Listed so the gap is visible; wiring it up is follow-on work. |
| **New** | Nothing in the app does this yet; the variable is what a crossing would need when it does. |
| **Doc** | Description only. Nothing reads it, and nothing should. |

Two rules carried over from `VARIABLES.md`: every number carries its provenance (sample size, date,
method) or is labelled a guess; and derive rather than store wherever the engine allows.

---

## 1. Identity and what the public sees

| Variable | What it means | Portslade | Status |
|---|---|---|---|
| `id` | The short name in the web address, `railcrossing.uk/<id>/` | `portslade` | Live |
| `name` | Full display name | Portslade Level Crossing | Live |
| `road` | The road that crosses the railway | Boundary Road | Live |
| `roadLabel` | Short form for the drawing of the barrier (long names clip) | BOUNDARY ROAD (from `road`) | Hard-coded |
| `stationName` | Nearby station in words; the landing page currently shows the code "PLD" | Portslade | New |
| `listed` | Whether the crossing appears on the home page. Lets a crossing be set up before it is public | true | New (every crossing is listed) |
| `pageTitle` | Browser tab and search result title. Must be in the page itself, because link previews don't run code | Portslade Level Crossing | Hard-coded ("Loading..." until code runs) |
| `description` | One line for search results and link previews | — (none today) | New |
| `appName` | Name when added to a phone's home screen | Portslade Crossing | Live (in the page's app file) |
| `appShortName` | Short home-screen label. Two installed crossings would both say "Crossing" today | Crossing | Live |
| `icon`, `socialImage` | Home-screen icon; picture shown when a link is shared | shared icon; none | Live; New |
| `barrierStyle` | Which drawing to show: full barriers, half barriers, or lights only | full (two booms, two lights) | Hard-coded |
| `stateWords` | The banner words. "BARRIERS DOWN" is wrong at a crossing with lights and no barriers | BARRIERS DOWN / CLOSING SOON / CROSSING CLEAR | Hard-coded |
| `howItWorks` | The explanation text. It claims live signalling, which is only true where berth data exists | the current paragraph | Hard-coded |
| `feedbackEnabled` | Whether the "Help improve accuracy" picker is shown | false (hidden 2026-11-06) | Hard-coded |
| `feedbackUrl` | Where feedback is sent | the Portslade Google Sheet script | Live |

## 2. What kind of crossing it is

These decide which *logic* applies, not just which numbers.

| Variable | What it means | Portslade | Status |
|---|---|---|---|
| `crossingType` | MCB-CCTV, MCB-OD, AHB, ABCL, AOCL, ... | MCB-CCTV | Doc (nothing reads it) |
| `closeModel` | How the barriers come down. **signaller**: a signaller lowers them some time before the train, and may wait for a queue. **automatic**: a train hitting a treadle lowers them a fixed time before it arrives. Follows from `crossingType` | signaller | Hard-coded (the code assumes signaller) |
| `openModel` | How they go up. **autoOnClear**: automatically once the train has cleared. **manual**: the signaller raises them | autoOnClear | Hard-coded |
| `holdsForQueue` | Whether a signaller keeps the barriers down for a second train rather than raising and re-lowering | true | Hard-coded |
| `signalBox` | Which signal box controls it | Lancing | Doc |
| `tracks` | Running lines over the crossing | 2 (one each way) | Hard-coded (two is assumed) |
| `bidirectional` | Whether trains in both directions use the same track and berths. If so, the berth a train enters no longer tells you its direction | false | Hard-coded (assumed false) |

## 3. Directions

Each crossing has two direction "slots". Their internal names are `east` and `west` today (see
decision 1 at the end).

| Variable | What it means | Portslade | Status |
|---|---|---|---|
| `directions.<d>.line` | Official Up/Down designation | east = up, west = down | Doc (recorded, not read) |
| `directions.<d>.label` | Name shown to people | Eastbound / Westbound | Hard-coded |
| `directions.<d>.arrow`, `.color` | Arrow and colour on the closure cards | → blue / ← orange | Hard-coded |
| `directions.<d>.placesBeyond` | Places beyond the crossing that way, used to work out a departure-board train's direction when the timetable can't | 14 places east, 40 west | Live (2026-11-06) |

## 4. The nearby station and the departure board

| Variable | What it means | Portslade | Status |
|---|---|---|---|
| `ldb.station` | Station whose live departure board is read. Can be none | PLD | Live, but **none crashes the board poll** every 30 s |
| `ldb.stationAtCrossing` | Whether that station is right at the crossing. The code assumes every train on the board stops "here", which is only true if it is | true | Hard-coded |
| `directions.<d>.boardTime` | Which station time is closest to the crossing: **arrival** (crossing is before the platform), **departure** (after), or **none** | east = arrival, west = departure | Hard-coded |
| `directions.<d>.stationToCrossingSecs` | Typical seconds between that board time and the train being on the road | west: on the road about 46 s after departure (measured); east: not measured — a 180 s close lead off the arrival is used instead | Partial (only inside the close leads) |
| `ldb.adjacentStations` | Neighbouring stations | FSG, HOV | Doc (nothing reads it) |
| `ldb.rows`, `ldb.windowMins` | How much of the board is fetched | 30 rows, 120 min | Hard-coded |
| `ldb.matchWindowMins` | How far apart board and timetable times can be and still be the same train | 20 (direction), 5 (merging) | Hard-coded |

## 5. The timetable

| Variable | What it means | Portslade | Status |
|---|---|---|---|
| `schedule.stationTiploc` | The crossing's own station in timetable code. Used to tell stopping trains from fast ones | PSLDAWH | Live |
| `schedule.sides.<d>` | Timing points on each side; a train crosses if it passes points on both sides | 27 west, 12 east | Live |
| `schedule.stationSide` | Which side the crossing's own station counts as. Without it, a train that starts or terminates at Portslade, crossing on its way, has no point on one side and **is missed** | — | Hard-coded (missing) |
| `schedule.timingPoints` | For each timing point next to the crossing, the seconds from it to the crossing. Today one fraction is used between *whichever* two points bracket the crossing, though it was set for Shoreham↔Hove | Shoreham → Hove, 0.7 eastbound / 0.3 westbound | Partial |
| `directions.<d>.approachStops` | Stations inside the approach whose stop changes the timing (Southwick inside berth 0006 adds about 160 s) | east: Southwick (STHWICK) in 0006 → class "stoppingLocal"; west: none | Partial (one station, eastbound only) |
| `schedule.outAndBack` | Which timing-point pairs mark a train crossing out and back | Shoreham ↔ Hove | Partial |
| `schedule.changeEnRoute` | Whether trains change type part-way (checked: not at Portslade) | false | Hard-coded |

## 6. The signalling feed (train describer berths)

| Variable | What it means | Portslade | Status |
|---|---|---|---|
| `td.areas` | Describer area(s). A crossing on an area boundary needs two | LA | Live (one area only) |
| `directions.<d>.td.approachChain` | Berths a train passes on the way in, nearest last | east: 0016 → 0004 (7); west: T682 → 0005 (5) | Live, but must be **one straight line**: a junction feeding the approach can't be described |
| `directions.<d>.td.clear` | The berth step that means the train is on or past the crossing | east 0004 → 0002; west 0005 → 0007 | Live, but **only one per direction** (a loop or crossover needs several) |
| `directions.<d>.td.crossingOffsetSecs` | Seconds between that step and the train being on the road. Today it is silently folded into the open and close timings | 0 (folded in) | Hard-coded |
| `td.sightingScope` | What counts as "seen": anywhere in the area, or on this crossing's own berths. A big area makes "seen anywhere" weak evidence | anywhere in the area | Hard-coded |
| `td.requireSightingForClosed` | Never show BARRIERS DOWN for a train the feed has never seen | true | Hard-coded |
| `td.noShowLeadSecs` | An unseen timetabled train this close to its crossing is treated as not running. Depends on where the area boundary is | 60 | Hard-coded |
| `td.strikeMemorySecs` | How long a berth step is remembered (also how long "no step yet" is trusted) | 1,200 | Hard-coded |
| `td.clearMemorySecs` | How long a clear step is remembered | 1,200 | Hard-coded |
| `td.positionStaleSecs` | When a train's last known berth is too old to project from | 240 | Live |
| `td.areaEntryLeadSecs` | Rough "first seen in area → crossing" time, a stopgap. The code also has its own Portslade copy as a default | east 150, west 112 | Live + hard-coded default |

## 7. Train types and timing classes

| Variable | What it means | Portslade | Status |
|---|---|---|---|
| `classify.headcodes` | What the first digit of a train's code means. Today **4xxx and 8xxx freight and 0xxx light engines count as passenger trains**; Portslade rarely sees them, Southampton would | 6, 7 freight; 5 empty; 3 test | Hard-coded |
| `directions.<d>.classes` | The ordered rules that put a train in a timing class, e.g. freight, empty, fast, stopping, calls at Southwick | east: freight → empty → fast → stopping → stoppingLocal; west: **stopping → freight → empty → fast** | Hard-coded, and the two directions are checked in a different order by accident |
| `directions.<d>.defaultClass` | Class used when a train's stopping pattern is unknown | east stoppingLocal, west stopping | Hard-coded |
| `test` class | Test trains (3xxx, e.g. the autumn rail-head treatment train) run slowly but are timed as fast or stopping | none | New |

## 8. When the barriers come down

Per direction. At Portslade the two directions run **different code**, for historical reasons rather
than geography (decision 2).

| Variable | What it means | Portslade east | Portslade west | Status |
|---|---|---|---|---|
| `close.crossingLeadSecs` | Barriers down → train on the road. The one number to calibrate; the per-class settings follow from it | (stored per class instead) | 92 | Partial (west only) |
| `close.classes.<c>.berth` | The berth whose step triggers the countdown for that class | stopping 0008, stoppingLocal 0006, fast 0008, empty 0008, freight 0006 | stopping 0003, freight 0003, empty 0001, fast 0001 | Live |
| `close.classes.<c>.offsetSecs` | Seconds after that step that the barriers come down (west works this out from the lead) | 55, 100, 20, 85, 20 | worked out | Live |
| `close.preStrikeLeadSecs` | Before the train reaches the berths: how far ahead of the timetable time to predict the close, separately for board times and timetable times | 180 for both | 46 (board departure), 92 (timetable) | Partial (east doesn't split) |
| `close.minAfterStrikeSecs` | Never predict a close sooner than this after the step that triggered it | — (not applied) | 10 | Partial (west only) |
| `close.safetyNetSecs` | Fallback when no berth step is seen | 145 | 90 | Live |
| `close.confirmedMayFollowPredicted` | Let the confirmed BARRIERS DOWN come after the predicted moment | true | — | Live |
| `close.unseenFloorSecs` | Last-resort close for a train never seen and with no fallback | 60 | 60 | Hard-coded |
| `queue.maxAhead` | How near a train ahead must be to count as queuing this one (in berths) | 2 | 2 | Live |
| `queue.exemptClasses` | Classes a train ahead doesn't delay | stoppingLocal | — | Live |
| `queue.estimate` | Count down a queued train from its own measured times | on | off | Live |
| `queue.hold` | Show "Train held" while the train ahead hasn't cleared | on | **off (by code, not setting)** | Hard-coded |
| `queue.gate` | Don't confirm BARRIERS DOWN for a queued train early | on | on | Hard-coded |
| `queue.protectingLagSecs` | Delay after a queued train reaches the last berth | 0 (uncalibrated) | 0 | Hard-coded |
| `transits` | Measured berth → crossing times per class, from the logs (`backend/data/transits.json`) | generated | generated | Live |

## 9. When the barriers go up

| Variable | What it means | Portslade east | Portslade west | Status |
|---|---|---|---|---|
| `open.lagSecs.<class>` | Clear step → barriers up | passenger 40, freight 70 | passenger 18, freight 30 | Live (only passenger vs freight) |
| `open.fallbackSecs.boardTime` | Barriers up after a board time, when there is no clear step | −21 | 55 | Live |
| `open.fallbackSecs.timetable` | Same, after a timetable crossing time | 40 | 20 | Live |
| `open.sightedGraceSecs` | How long a seen train is kept after its predicted crossing | 180 | 180 | Hard-coded |
| `open.unseenGraceSecs` | Same for a train never seen | 600 | 600 | Hard-coded |

## 10. Joining closures together

| Variable | What it means | Portslade | Status |
|---|---|---|---|
| `merge.oppositeMaxGapSecs` | Two trains in opposite directions this close together share one closure | 20 (no recorded basis, register #16) | Live |
| `merge.sameMaxGapSecs` | Same, for two trains the same way. Today only an actual overlap merges | 0 | Hard-coded |
| `merge.coalesceOverlaps` | Merge when the next close would land before the previous open (a signaller holds rather than raising and re-lowering) | true | Hard-coded |

## 11. Trains that only run when needed

| Variable | What it means | Portslade | Status |
|---|---|---|---|
| `runsAsRequired.lookbackDays` | Days of history used to judge whether a "runs if required" train will run | 14 | Hard-coded |
| `runsAsRequired.evidence` | What counts as "it ran": seen anywhere in the area, or on this crossing's berths | anywhere in area LA | Hard-coded |
| `runsAsRequired.dropAtZero` | Hide one that hasn't run once in the period | true | Hard-coded |

## 12. Direct barrier data from the signalling feed

| Variable | What it means | Portslade | Status |
|---|---|---|---|
| `barrierFeed` | Where the feed reports this crossing's barriers directly (area, crossing code, byte and bit) | none (area LA doesn't publish it) | New: Yapton's is captured but nothing uses it |
| `barrierFeed.use` | What to do with it: check predictions, or show the real state | — | New |

## 13. Confidence and on-screen countdowns

| Variable | What it means | Portslade | Status |
|---|---|---|---|
| `confidenceWindows` | The ± shown on a countdown at each stage | timetable 120, board 90, approach berth 60, last berth 30 | Live |
| `confidenceWindows.boardHorizonSecs` | How far out the board's ± applies | 300 | Hard-coded |
| `closingSoonSecs` | How early the amber "closing soon" starts. Set separately in the backend and the website today | 90 | Hard-coded (two copies) |
| `chain` | Berths drawn on position labels, with typical times to the crossing | 11 east, 12 west | Live (moved to settings 2026-11-06) |

---

## Not per crossing (site-wide)

Website address, API address, the "request a crossing" and "share feedback" forms, the Buy Me a
Coffee link, analytics, how often the page refreshes, time formatting, and the feed-health thresholds.
These stay in the shared code.

## Bugs found on the way

These are wrong at Portslade today, not just at future crossings. Each would change Portslade slightly,
so each needs your go-ahead.

1. **The "seen today" list resets at midnight UTC, not UK midnight.** During summer time, trains seen
   between midnight and 1 am count towards the wrong day.
2. **4xxx and 8xxx freight and 0xxx light engines are treated as passenger trains.**
3. **Westbound checks "is it stopping" before "is it freight"**, the opposite of eastbound.
4. **The Southwick stop is matched by headcode with no time limit**, so a later run with the same
   headcode can borrow the wrong stopping pattern.
5. **A train that starts or terminates at Portslade and crosses on its way is missed**, because Portslade
   station is on neither side's timing-point list.

## Decisions needed

1. **Direction names.** Keep the internal slot names `east`/`west` with a display label per crossing, or
   rename them `up`/`down`. Renaming touches about 90 places in the code and the API's wire format.
   Recommendation: rename when the two close algorithms are merged (decision 2), since that rewrites the
   same code anyway.
2. **One close algorithm.** East and west run different code paths at Portslade (queue hold, minimum
   after the step, board-vs-timetable leads). Merge them into one, driven by the settings above, with
   Portslade's current behaviour as its settings — provable by replay as before.
3. **Where the definition lives.** See below.

## Proposed layout

- **One definition file per crossing**, authored once: `backend/config/crossings/<id>.json` on
  `backend-v2`, laid out as sections 1–13 above, with every setting for one direction under that
  direction.
- **Everything else is generated from it** by one script (`scripts/build-crossings.js`, run like
  `bump-assets.sh`, output committed — no build step on deploy):
  - `/<id>/index.html` — the crossing's page: its own title, description, link-preview tags and
    home-screen name written into the page, and the shared page body.
  - `/<id>/manifest.webmanifest` — the home-screen app file.
  - `shared/crossings.json` — the website's settings, now generated rather than hand-edited.
  - the home page's list of crossings and a `sitemap.xml`, as real links search engines can follow.
- **Portslade keeps `railcrossing.uk/portslade/`**, so links and installed home-screen apps keep
  working, and is proven unchanged by rendering the old and new page against the same recorded data.
