# Multi-crossing readiness review

**Date:** 2026-09-19 · **Scope:** `main` (frontend) + `backend-v2` (backend) · **Question:** what has to
change before a second crossing can be added, and how much of the code can be shared rather than copied?

This is an assessment, not a change. Nothing here has been implemented.

---

## Verdict

The **data layer is in better shape than it looks and the presentation layer is in worse shape than it
looks.** The backend was written with `Object.entries(crossingsConfig)` loops throughout and a
per-crossing `CrossingState`; adding an entry to `backend/config/crossings.json` genuinely does
instantiate a second crossing. But four things are hard-wired to Portslade below that config, and two
of them (`TARGET_AREA`, `isEastOrigin`) make a crossing outside TD area LA silently produce wrong
answers rather than no answers — which is the dangerous failure mode for a safety-adjacent app.

On the frontend, the opposite: `predict.js` was split out precisely to stop the two apps disagreeing,
and that worked — but the split was drawn around *"what must the two Portslade apps agree on"*, not
around *"what is crossing-independent"*. So the shared core now contains a 28-berth Portslade berth
chain with measured medians baked in as a module constant (`shared/predict.js:348`). Crossing #2 gets
that chain shared with it whether it wants it or not.

| Layer | State | Work to add crossing #2 |
|---|---|---|
| Backend config schema | **Good** — already per-crossing, richly documented, provenance on every constant | Populate, no code change |
| Backend engine (`crossing-state.js`) | **Good with caveats** — per-instance, config-driven, but `east`/`west` are load-bearing literals | Small, surgical |
| Backend TD ingest | **Blocker** — single hard-coded area, area-blind fan-out | Real work (~half a day) |
| Backend LDB direction | **Blocker** — Sussex place-names hard-coded in code | Real work |
| Backend CIF direction | **Good** — fully config-driven via TIPLOC sets | Populate, no code change |
| Shared prediction core | **Partial** — formatters/derive/state are generic; berth chain is not | Medium refactor |
| App shell (`portslade/index.html`) | **Poor** — 155 lines of markup that would be copy-pasted per crossing | Medium refactor |
| Frontend config | **Confused** — 9 of 13 fields are dead or duplicate backend config | Cleanup |
| Observer PWA | **Poor** — `CROSSING_ID` hard-coded, own service worker, own `BERTH_ETA` table | Medium refactor |
| Calibration tooling | **Surprisingly good** — `--crossing` parameterised already | Mostly works |

**Bottom line:** the current design supports *one* crossing very well. Crossing #2 in the **same TD
area** (another West Coastway crossing) is roughly a day's work. Crossing #2 in a **different TD area**
is the real port, and it is where the hidden assumptions live.

---

## The blockers, ranked

Ranked by "how wrong is the app if you don't fix this", not by effort.

### 1. `TARGET_AREA = 'LA'` — TD ingest is single-area

`backend/src/td-listener.js:17`. The C-Class path filters `msg.area_id !== TARGET_AREA` and drops
everything else. A crossing in any other area gets **no berth steps at all**: no TD-anchored close, no
clear-step-anchored open, no `tdSeen`, no live map, no observer, no Q-freight lock. The prediction
degrades to the schedule-only path, which is the accuracy the app had before the thing that makes it
good.

Not a deep problem — the S-Class path right beside it (`CCLASS_EXTRA_AREAS`) already demonstrates the
multi-area pattern, and already banks C-Class for area BM into a separate area-tagged log. The fix is
to derive the C-Class area set from `crossings.json` rather than a constant, and to partition
`data/logs/td/` by area (`td-<area>-<date>.jsonl`), which `run-rate.js:23` and `derive-chain.js` then
need to follow.

### 2. The TD sighting fan-out ignores area

`backend/src/index.js:290-294`:

```js
tdListener.on('sighting', (s) => {
  for (const state of Object.values(crossingStates)) {
    state.recordTdSighting(s.headcode, s.ts);
    state.recordTdBerth(s);
    ...
```

Every sighting is fed to **every** crossing. `recordTdBerth` (`crossing-state.js:280`) writes it into
`liveTrains` unconditionally — no area check anywhere in `crossing-state.js`. Two consequences:

- **Cross-area contamination.** With crossings in LA and BM, a BM train appears in LA's live map and
  vice versa. The observer would show it; the feedback picker would offer it.
- **Berth codes are not globally unique.** Berths are stored without the area prefix (CLAUDE.md says
  so explicitly, and the JSONL confirms it). `_matchCloseStrikeBerth` (`crossing-state.js:388`) matches
  a bare 4-character code against the configured approach chain. Berth `0006` exists in LA *and* in
  most other areas. A BM train stepping into its own `0006` would be recorded as a Portslade approach
  strike and **anchor a real closure**. That is a false BARRIERS DOWN caused by a train 30 miles away.

Note the asymmetry that makes this worth flagging rather than assuming: the **boot-time** seeding path
already gets this right (`index.js:242` filters `e.area === state.config.td.area`). Only the runtime
path doesn't. So the intent exists; the runtime hook was written when there was one area and never
revisited.

**Fix:** filter on `s.area === state.config.td.area` in the fan-out, and key strikes by
`area|berth` rather than `berth`. Cheap, and it should go in *before* a second crossing exists, because
it is invisible today and catastrophic the day it isn't.

### 3. `isEastOrigin()` — LDB direction is a hard-coded Sussex gazetteer

`backend/src/ldb-poller.js:68-78`. Fourteen place-name substrings — brighton, hove, london, gatwick,
croydon, haywards, preston park, burgess, lewes, eastbourne, lovers walk, three bridges, horsham — with
`direction = isEastOrigin(origin) ? 'west' : 'east'` at line 146.

Three problems for crossing #2: the list is wrong for anywhere else; the *fallback* is `east`, so an
unrecognised origin is silently assigned a direction rather than marked unknown; and `east`/`west`
aren't meaningful labels on a north-south line.

Worth noting the inconsistency: CIF direction is *fully* config-driven (`tiplocs_west` / `tiplocs_east`
in `analyseRoute`, `schedule-parser.js:55`). And CLAUDE.md states the `isEastOrigin()` heuristic "has
been removed" — true of the frontend, not of the backend. The backend copy is live and is the direction
source for every LDB-sourced train.

**Fix:** direction for an LDB train should come from the CIF join that already exists (LDB and CIF are
deduped UID-first), falling back to a configured origin/destination CRS set, never to a default.

### 4. `direction === 'east'` selects arrival-vs-departure geometry

`ldb-poller.js:152`: eastbound reads `sta/eta/ata`, westbound reads `std/etd/atd`. The comment is
honest about why — *"the crossing sits immediately west of the platform"* — and that is a **property of
Portslade, not of east**. At a crossing east of its station the mapping inverts; at a crossing with no
adjacent station neither applies.

This ripples: `_computeCloseTime` has genuinely different algorithms per direction
(`crossing-state.js:1044` east vs `:1096` west), and the difference is not compass-driven either. East
uses `predictedLeadSecs` off an *arrival* estimate; west branches on `predictedDepartureLeadSecs` vs
`crossingLeadSecs` depending on whether `bestTime` means a departure or an interpolated crossing.

**This is the deepest structural issue in the review** and it is not a bug — it's a modelling choice
that's correct for Portslade and unnamed. The two directions are not "east" and "west", they are
**"the direction whose `bestTime` anchor is before the crossing"** and **"the direction whose anchor is
after it"**. Until that's named, a new crossing is configured by guessing which of Portslade's two
directions it resembles.

**Fix (recommended):** keep `east`/`west` as the wire format — renaming them would touch ~90 sites in
`crossing-state.js` alone for no behavioural gain — but add an explicit per-direction
`anchor: "arrival" | "departure" | "interpolated"` to config and branch on *that* instead of on the
direction name. It makes the Portslade asymmetry configuration rather than code, and it is the single
change that most reduces the guesswork in launching a new crossing.

### 5. `PREDICT.CHAIN` — the Portslade berth chain is a module constant

`shared/predict.js:348-375`. 28 berths across two directions with measured `gap`, `ttc` and `tac`
medians from 28 days of TD logs, as a literal inside the shared core.

Everything downstream of it is generic and good — `proximity`, `eta`, `eventRank`, `suggestForEvent`
are all clean, well-reasoned, testable functions. They just take their topology from a global.

For crossing #2 today: `proximity()` returns `null` for every berth, so every train reads *"Elsewhere in
the area"*, `eventRank` returns `null`, `suggestForEvent` returns no guess, and the feedback picker
degrades to recency order with no position labels. **The feedback loop — the thing that calibrates a new
crossing — is the first thing that breaks.** Which is exactly backwards from what you want when
launching somewhere you can't visit.

**Fix:** the backend already publishes most of this. `GET /crossing/:id/triggers` returns
`chain[direction]` (approachChain + XING) and `clear[direction]` (`crossing-state.js:2014`), and both
apps already fetch it. Extend that payload with the per-berth `gap`/`ttc`/`tac` values — which the
backend can compute from `transits.json`, where they already live per crossing — and change `proximity`
/ `etaToCrossing` to take a chain argument. Then `predict.js` carries zero Portslade data and the chain
is derived from measurement on the server, where it's regenerated, rather than hand-copied into a
frontend constant.

Same applies to `BERTH_ETA` in `portslade/observe/observe.js:58` — 15 hard-coded off-chain berth ETAs,
seeded from one day, which the comment already flags as needing refinement.

---

## What to centralise (and what not to)

### The app shell should be one file, not one per crossing

`portslade/index.html` is 159 lines. Exactly **one** is crossing-specific: `initCrossing('portslade')`.
Everything else — the barrier SVG with its carefully-reasoned viewBox, the three-slot card track, the
feedback section, the modal — is generic markup with load-bearing comments.

CLAUDE.md's "Add a new crossing" instructions say to *"create `<crossing-name>/index.html` mirroring
`portslade/index.html`"*. That means copy 158 lines per crossing. With five crossings, a change to the
card track is five edits, and the bump-assets script's `FILES=` list grows with it. This is the same
class of failure `predict.js` and `closure-card.js` were created to prevent, just at the markup layer —
and the repo has already paid for it once (the 2026-08-10 stale-asset incident was a *pairing* problem
between HTML and JS, and more HTML copies means more pairings).

**Recommended:** one `crossing/index.html` that reads the crossing id from the path or a query param,
plus a per-crossing directory containing only a redirect or a 3-line shell. Keeps `railcrossing.uk/<id>/`
URLs intact, and there's no build step to fight — the id is available from `location.pathname`.

There is a real trade-off: GitHub Pages has no server-side routing, so `/<id>/` must be a real
directory. A 3-line `<meta refresh>`/`<script>` stub per crossing is the honest minimum. That's fine —
3 lines of stub is not 158 lines of duplicated logic.

### `shared/crossings.json` is mostly dead and partly a drift hazard

Of 13 fields in the Portslade entry, the frontend actually reads **four**:

| Field | Read by | Verdict |
|---|---|---|
| `name` | `crossing.js:517`, `initCrossing`, landing page | keep |
| `road` | `crossing.js:704`, landing page | keep |
| `station` | landing page only | keep |
| `feedbackUrl` | `crossing.js:623`, `observe.js:493` | keep |
| `confidenceWindows` | `predict.js` `getWindowTier` | keep |
| `closeBefore`, `openAfter`, `openAfterFreight` | **debug panel only** (`crossing.js:399-400`) | duplicate of backend |
| `berths` | **nothing** | **drift hazard — delete** |
| `signalBox`, `crossingType`, `autoLower`, `autoRaise`, `signals` | **nothing** | documentation, mislabelled as config |

`berths` is the one that matters. It duplicates `td.eastbound/westbound` in the backend config *and*
the chain in `predict.js`, and nothing reads it — so it can silently disagree with both. Three copies of
the berth topology, one authoritative, one unused, one hard-coded. Delete it, or make it the source and
have the other two derive from it. Not both.

`closeBefore`/`openAfter` being live-looking but debug-only is the second-order version of the same
problem: CLAUDE.md already had to add a warning that tuning them does nothing. That warning is a
symptom; the fix is to stop shipping the duplicate.

**Recommended:** `shared/crossings.json` becomes strictly *presentation* config (name, road, station,
feedbackUrl, confidenceWindows) and everything physical lives backend-side and reaches the client via
the API. A new crossing then has exactly one config file to populate.

### The observer needs the same treatment

`CROSSING_ID = 'portslade'` at `observe.js:38`, one service worker with a hard-coded `SHELL` list, one
manifest, and a hard-coded `BERTH_ETA`. A second observer would be a second copy of an 891-line file.

This one is less urgent — **you can't do field observation at a remote crossing anyway**, which is the
whole premise of the question. But see below: the observer's *prediction panel* is still useful remotely
for anyone local who wants to help, so parameterising `CROSSING_ID` from the URL is worth doing when the
shell is refactored. The service worker precache is the fiddly part (`sw.js` matches its precached
shell on exact URL) and it should not be "optimised" in the process — the network-first behaviour is
there for a measured reason.

---

## The remote-crossing problem — and why it's less bad than it looks

You flagged the real constraint: no field observation at a crossing you can't stand next to. Every
calibrated number in `backend/config/crossings.json` traces back to barrier taps —
`crossingLeadSecs: 92` from n=11 westbound observations, `openLagSecs.west.passenger: 18` from n=8, the
east close anchors from a handful of 1H closes. That method does not scale and does not travel.

**But three of the four input classes need no human at all, and the fourth already has a proven
substitute.**

| Parameter class | Source | Needs a human? |
|---|---|---|
| Berth chain + order + per-berth dwell | TD logs → `scripts/derive-chain.js` (already `--crossing`) | **No** |
| Per-class berth→crossing transits (`transits.json`) | TD logs → `scripts/derive-transits.js` | **No** |
| Direction, calling pattern, TIPLOC sets, interpolation | CIF + CORPUS | **No** (desk research) |
| **Barrier close/open instants** | Field observation… **or S-Class** | **Not necessarily** |

The last row is the one that changes everything, and the groundwork is **already in the repo**:

- `backend/config/sclass.json` maps describer → byte:bit → crossing, with the explicit note that
  *"describer->byte:bit->crossing mappings live ONLY in config, never in code"*. The decoder
  (`sclass-decoder.js`) is pure, tested, and crossing-agnostic.
- Yapton (area BM, `L(YN)` byte 09) is **confirmed and producing data**: `yapton-episodes.csv` holds
  **1,364 barrier episodes** with close/open times, duration, triggering headcode, direction, strike-in
  berth, close lead and open lag — every quantity that took months of standing at Boundary Road with a
  phone, derived entirely from the feed.
- **Twelve** LXG-positive describers (BM, X7, RT, EN, EH, HG, EK, B3, BU, Q3, Q5, EA) are already in
  collection-only mode, banking raw S-Class so their barrier bytes can be hunted offline the way
  Yapton's was.

So the honest framing of the scaling question is not *"how do we calibrate without observations"*. It
is: **a crossing in an S-Class-publishing area is dramatically cheaper to launch than Portslade was,
because it has better ground truth than Portslade has.** Portslade is the hard case, not the template —
area LA publishes no crossing bits, which is exactly why human observation was the only option there.

That reverses the natural site-selection instinct, and it is the single most important input to the
playbook: **S-Class availability should be the first screening criterion for a candidate crossing, ahead
of traffic volume or road importance.** A busy crossing with no barrier feed costs a field campaign you
can't run; a quieter one with a confirmed byte:bit calibrates itself in a fortnight.

One caveat, already recorded and worth carrying forward: *"Yapton is not transferable to Portslade"* —
different box, different geometry, no platform dwell in either direction. Per-crossing calibration is
still per-crossing. S-Class removes the *cost* of measuring, not the *need* to measure.

---

## What's already fit for purpose

Worth stating plainly, because it's most of the system:

- **`backend/config/crossings.json` schema.** Genuinely well designed for this. Per-direction, per-class,
  with provenance comments recording sample sizes, standard deviations and explicit "do not retune"
  markers. It is the best artefact in the repo for scaling, because it is simultaneously the config and
  the documentation of how to derive the config.
- **`CrossingState`.** Per-instance, reads everything from `config`, and the constructor already
  anticipates this (`config.transits ... or a second crossing`). `_closeAnchor` was deliberately
  generalised so west-side per-class anchors work rather than being silently ignored.
- **`transits.json`.** Already keyed by crossing id at the top level.
- **CIF pipeline.** `analyseRoute` / `estimateCrossingTime` are fully config-driven. Direction,
  traversal detection and crossing-time interpolation all come from TIPLOC sets and fractions.
- **The API.** `api.js` is entirely generic — routes are `/crossing/:id`, iteration is over
  `crossingStates`. No changes needed.
- **`closure-card.js` and the `derive`/formatter half of `predict.js`.** Genuinely crossing-independent
  already.
- **`derive-chain.js`.** Takes `--crossing` and reads its anchors from `crossings.json`. Its header
  note — *"Method (no geography needed)"* — is precisely the property a remote launch needs.

**Correction to an earlier draft of this review:** the other two derivation scripts are *not*
parameterised. `derive-transits.js` hard-codes `CHAIN` and `CLEAR` as literals at the top of the file
(lines 37-41) and takes only `--days` / `--out`; `derive-ttc.js` hard-codes `PLAN` and takes only a log
directory. Both also classify trains by Portslade-specific proxies — platform dwell for "calls at
Portslade", berth-0006 occupancy for "calls at Southwick". So of the three, only `derive-chain.js` runs
against a new crossing today. Parameterising the other two is a prerequisite for Phase C, and it is the
cheap half: the logic is sound and general, the constants just need to come from config.
- **The audit skill.** `SKILL.md` already says "Covers Portslade and any future crossing", and
  `record.sh` takes a crossing argument.

---

## Recommended sequence

**Revised 2026-09-19 after Rich's decisions** (see *Decisions* below). The original ordering assumed a
same-area crossing #2 was plausible. It isn't: every LXG-positive describer is outside area LA, so
"S-Class sites only" means crossing #2 is in a different TD area by construction. Multi-area ingest
moves from Phase D to Phase A, and the area-keying bug stops being latent.

**Phase A — multi-area correctness (now the critical path, not a precaution)**
1. Area-filter the TD sighting fan-out; key `closeStrikeSeen` / `liveTrains` by `area|berth` rather than
   bare berth. **Ship this before any second crossing exists.** With two areas, a bare `0006` collision
   lets a distant train anchor a real closure. *(small)*
2. Derive the TD C-Class area set from `crossings.json` instead of `TARGET_AREA`; partition
   `data/logs/td/` by area; follow through in `run-rate.js`, `derive-chain.js`, `derive-transits.js`.
   *(medium)*
3. Delete `berths` from `shared/crossings.json`; demote the other dead fields. Fix the stale
   `isEastOrigin()` claim in CLAUDE.md. *(trivial)*

**Phase B — remove Portslade constants from shared code**
4. Extend `/crossing/:id/triggers` with the full chain (`gap`/`ttc`/`tac` from `transits.json`); make
   `PREDICT.proximity`/`eta`/`etaToCrossing` take a chain. Delete `CHAIN` and `BERTH_ETA`. *(medium)*
5. Add `anchor: arrival|departure|interpolated` per direction; branch `_computeCloseTime` and
   `extractTrain` on it rather than on the direction name. *(medium — highest value per hour)*
6. Replace `isEastOrigin()` with CIF-join-first, config-fallback, never-default direction resolution.
   *(medium)*

**Phase C — S-Class promoted from side-project to primary ground truth**
7. Generalise the Yapton derivation (`yapton-episodes.csv`) into a repeatable script: S-Class barrier
   episodes joined to C-Class berth steps, emitting per-class `strikeInBerth` / `closeLeadS` /
   `openLagS`. This is the instrument that replaces the observer PWA at remote sites, and it already
   exists as a one-off. *(medium — see the launch playbook)*
8. Byte-hunt tooling: scan a banked area's raw S-Class for candidate bytes whose transitions correlate
   with berth steps, so a new crossing's byte:bit can be found offline. *(medium)*

**Phase D — de-duplicate the shell**
9. One parameterised app shell + per-crossing stub; update `bump-assets.sh`. *(medium)*
10. Parameterise `CROSSING_ID` in the observer from the URL. *(small, do with 9)*

Phases A and B are worth doing even if no second crossing launches: A closes a correctness hole, B
removes three copies of a topology that needs one.

---

## Decisions (Rich, 2026-09-19)

- **Site selection is demand-led**, so the playbook must cover both S-Class and non-S-Class sites —
  but **only sites with barrier data will be looked at initially**.
- **S-Class availability is a preferred screening criterion.** Launch where barrier state is in the
  feed; accuracy then starts near where Portslade ended rather than where it began.

Consequences for the work above: Phase A step 2 is required, not optional. Phase C stops being
exploratory. The non-S-Class path still needs writing into the playbook (demand may point there) but
is not the near-term build target.

---

## Still open

**One backend instance or one per region?** Currently one VPS process holds every crossing's state in
memory and one TD/STOMP connection. That scales to tens of crossings comfortably. Worth knowing if the
ambition is hundreds — and note that a single STOMP subscription already receives every area, so the
cost of more areas is CPU and disk, not connections.

---

## See also

`.claude/skills/crossing-launch/` — the launch playbook this review feeds into.
