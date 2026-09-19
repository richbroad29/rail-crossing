# Every variable a crossing needs

Companion to `SKILL.md`. Grouped by **how you get it**, because that's the question being asked when
you open this file. Within each group: what it is, the method, and — the most useful column — **what
the app does wrong if the value is wrong**, because that's how you'll actually discover the error.

Authoritative file is `backend/config/crossings.json` on `backend-v2`. `shared/crossings.json` is
presentation only. Read the Portslade entry alongside this: its `_comment_*` keys carry the provenance
for every calibrated number and are the model for what a new entry should look like.

**Two standing rules.**

1. **Provenance or GUESS.** Every number either carries its sample size, spread and derivation, or is
   explicitly labelled a guess. The Portslade entry does both (`"freight west n=0 DELIBERATE GUESS"`),
   and that honesty is why six months of tuning didn't corrupt it.
2. **Derive rather than store, where the engine supports it.** One calibrated `crossingLeadSecs` plus a
   measured transit table beats four hand-copied `offsetSecs`, because the derived values follow the
   table when it's regenerated instead of silently drifting from the measurement they came from.

---

## Group A — Desk research (free, immediate, no data needed)

| Variable | What it is | Method | If wrong |
|---|---|---|---|
| `name`, `road` | Display strings | Map / OSM | Cosmetic |
| `crossingType` | MCB-CCTV / AHB / MCB-OD / … | Sectional Appendix | Not read by code today; drives *your* expectations in Phase 5 |
| `signalBox` | Controlling box | Sectional Appendix | Documentation only |
| `ldb.station` | CRS of the adjacent station | National Rail | No LDB trains at all ⇒ schedule-only accuracy, silently |
| `ldb.adjacentStations` | Neighbouring CRS codes | National Rail | Reduced near-term coverage |
| `feedbackUrl` | Apps Script endpoint | Existing Sheet | Feedback silently discarded (`no-cors` — failure is invisible) |

## Group B — CORPUS / SMART lookup (free, one fetch)

| Variable | What it is | Method | If wrong |
|---|---|---|---|
| `schedule.tiploc_station` | TIPLOC of the crossing's own station | **CORPUS-verified**, never guessed from the name | Calling pattern misread ⇒ every CIF passenger service classified non-stopping ⇒ wrong close class |
| `schedule.tiplocs_west` / `tiplocs_east` | Timing points each side | CORPUS + route map. Be generous | A missing TIPLOC means routes don't resolve — **the train is invisible, both ways** |
| `td.area` | TD describer code | SMART, or Open Rail Data describer list | No berth data; every position path dead |

> Portslade is `PSLDAWH`, not `PORTSLD`. The plausible abbreviation was wrong. Always verify against
> CORPUS, which is already downloaded daily by `corpus-fetcher.js`.

> There is **no SMART fetcher** in the repo. SMART should be available from the same NROD
> `SupportingFileAuthenticate` endpoint as CORPUS — verify the `type=` value. Writing
> `smart-fetcher.js` alongside `corpus-fetcher.js` would make Group B fully automatic.

## Group C — Derived from TD logs (free, needs ~14 days of logging)

| Variable | What it is | Method | If wrong |
|---|---|---|---|
| `td.<dir>.approach.from` | Approach anchor berth | S-Class correlation (best) or SMART, confirmed by `derive-chain.js` | **The worst single error.** Portslade's pre-2026-07-25 bug anchored class A to `0006`, whose strike lands a median **29 s after the barrier was already down** — so the app announced a closure that had already happened |
| `td.<dir>.approach.to` | Protecting berth (= `clear.from`) | Same | Held-close floor misplaced; queued trains mispredicted |
| `td.<dir>.clear.from` / `.to` | The clear step | Same | **Open never anchors.** Closures fall back to clock-expiry, and "hold until cleared" can't work — the register #14 failure: CLEAR reported with a train on the crossing |
| `td.<dir>.approachChain` | Berth order inward, nearest-last | `derive-chain.js --crossing <id>` | Position gating and the CLOSED backstop lose their ordering; projections degrade |
| `transits.json[<id>][dir][class]` | Measured berth→berth and berth→XING seconds, sd, n | `derive-transits.js` (**parameterise first** — it hard-codes the chain) | No projection; every path falls back to bestTime. Degrades gracefully — cells with n<15 are omitted by design |
| `schedule.tiploc_approach_call` | Station *inside* an approach berth | Test occupancy for bimodality, then identify the station | Class split wrong. Portslade: Southwick gives 0/93 mismatches, Fishersgate 41/93 — **the nearest station is not necessarily the right one** |
| `schedule.interpolation.<dir>` | Bracketing timing points + fraction | Estimate from distance; refine against observed crossing instants | CIF-sourced crossing times skewed ⇒ freight and out-of-window passenger predicted at the wrong time |
| `areaEntryLeadSecs.<dir>` | First-sighting → crossing transit | Median over observed traversals | Late-running freight re-projected wrongly. **Deliberate stopgap — CLAUDE.md says do not tune**; position-based triggering is meant to replace it |
| `live.ttlSecs` | How long a berth position stays live | Longest plausible area transit + margin | Too short: trains vanish from the picker mid-selection. Too long: ghosts |

## Group D — Needs barrier ground truth (S-Class, or a human)

This is the group the observer PWA existed for, and the group S-Class makes free.

| Variable | What it is | Method | If wrong |
|---|---|---|---|
| `closeTrigger.<dir>.crossingLeadSecs` | Barrier-down → train at crossing | Median over barrier episodes. **The one number to calibrate** — per-class offsets derive from it | Systematic early/late close across every class at once |
| `closeTrigger.<dir>.classes[].berth` | Per-class anchor berth | Tightest-sd berth that still fires early enough to be useful | Anchor fires after the event, or too late to warn |
| `closeTrigger.<dir>.classes[].offsetSecs` | Explicit override | Only where a class is separately calibrated. Otherwise **omit and let it derive** | A stored value drifts from the transit table it was computed from |
| `openLagSecs.<dir>.<class>` | Clear step → barrier up | Median over episodes. Tight where the raise is automatic (Portslade west: mean 18.9, sd 5.3, n=8) | Barrier shown open while physically down — **the dangerous direction**; or red long after it lifts |
| `closeTrigger.<dir>.predictedLeadSecs` | Pre-strike close lead | Measured lead, pre-anchor | Countdown lurches when the strike lands |
| `closeTrigger.west.predictedDepartureLeadSecs` | Same, for a *departure*-anchored bestTime | Departure → crossing, measured | Wrong anchor event. Dropping it moved a Portslade west close **105 s early** and re-merged periods |
| `closeTrigger.<dir>.safetyNetSecs` | Backstop when no strike is seen | Must sit **after** the class anchor | Too large and the backstop becomes the primary path: Portslade's 210 fired before the anchor for **34/34** class-A trains |
| `closeTrigger.west.minAfterStrikeSecs` | Floor after the strike | ~10 s; covers pipeline latency on near-zero offsets | A close lands on or before the strike that anchored it |
| `confirmedMayFollowPredicted` | Allow the CLOSED gate later than the predicted close | Only where `safetyNetSecs < predictedLeadSecs` deliberately | Without it the frontend "Soon" state is dormant; with it set carelessly, countdown passes zero while the app says CLEAR |
| `mergeOppositeMaxGapSecs` | Gap below which opposing closures merge | Observed inter-closure barrier-up gaps | Over-merge: one long phantom closure. Under-merge: two closures where the barrier never actually lifted. **Portslade's 20 has no provenance** (register #16) — do better at the new site |
| `openAfterSecs.{crossingAnchored,stationAnchored}.<dir>` | Far-out barrier-up fallback, by what bestTime is anchored to | Measured per source | One number cannot serve both sources: a single +30 s made every Portslade east closure ~50 s too long |
| `closeBefore` / `openAfter` | Legacy minute-granularity fallbacks | Coarse initial estimates | Only reached when everything else is absent — but that's exactly the pre-calibration state, so set them sanely |

## Group E — Presentation (`shared/crossings.json`)

| Variable | Notes |
|---|---|
| `name`, `road`, `station` | `station` is read by the landing page only |
| `feedbackUrl` | Same endpoint as the backend entry |
| `confidenceWindows` | Decides whether the pill counts to the second or rounds. Start at Portslade's values; tighten as sd data arrives |

**Do not add anything physical here.** Nine of Portslade's 13 fields are dead or duplicate the backend,
and `berths` is a third copy of the topology that nothing reads — see
`docs/multi-crossing-readiness.md`. A new crossing should not inherit that.

## Group F — S-Class (`backend/config/sclass.json`)

| Variable | What it is | Method |
|---|---|---|
| `areas.<AREA>.logRaw` | `"all"` while hunting, `"watched"` once bytes are known | Flip after confirmation to cut volume |
| `areas.<AREA>.crossings.<ID>.bits.{raised,lowered,failed}` | `{byte, bit}` per state | Community map / Open Rail Data wiki, or the byte-hunt in `SKILL.md` Phase 3 |

Byte:bit mappings live **only in config, never in code** — the decoder is crossing-agnostic and should
stay that way.

---

## Minimum viable config

The smallest set that produces something better than a timetable, for standing a crossing up in
degraded mode while Group D calibrates:

**Required:** `name`, `road`, `feedbackUrl`, `schedule.tiplocs_west`/`tiplocs_east`,
`schedule.interpolation`, `td.area`, `td.<dir>.approach` and `.clear`.

**Strongly wanted:** `ldb.station`, `schedule.tiploc_station`, `td.<dir>.approachChain`, a transit table.

**Deferrable with conservative (early) defaults:** everything in Group D, plus
`schedule.tiploc_approach_call` if no bimodality shows.

Degraded mode is honest as long as the confidence windows are widened to match and the freight labels
carry the doubt. It is **not** honest if the numbers are guesses presented at Portslade's precision.

---

## Order of operations

Group A and B are free and immediate. Group C needs the clock started (`SKILL.md` Phase 2) — which is
why Phase 2 comes before any analysis. Group D needs Group C's transits to exist first, because the
close offsets derive from them.

```
A, B  ──►  instrument  ──►  C (≈14 days)  ──►  D (≈14 days passenger, ≈6 weeks freight)  ──►  gates
```

Freight is the long pole in every case. Ship on the passenger classes with freight conservative, then
tighten — don't hold a launch for a train that runs twice a week.
