# Berth-first closure prediction — design

**Date:** 2026-11-19 · **Status:** design agreed in discussion 16–19 Nov 2026. **Phase 0 (logging) live**
since 2026-11-19 21:52 UTC (backend-v2 `a049364`); nothing else built. Every phase in *Rollout* needs Rich's explicit go-ahead before it starts.
**Scope:** `backend-v2` (prediction core, feeds, logging), `main` (what the page shows), the
`crossing-launch` skill and `docs/crossing-definition.md`.

---

## 1. Why

On 16 Nov at 10:22 the app showed one closure of five trains. In reality there were three separate
closures. Replay found two causes:

1. **A ghost.** 1H14 never ran; the same service ran as 1Z14 from Hove, a short-notice timetable the app
   doesn't receive.
2. **Merging on guesses.** Three of the five trains were not yet on the signalling berths. Their times
   came from the timetable and departure board, and those guesses overlapped, so they were merged.

The two candidate fixes were both measured over 46 days and neither is good enough:

- **Fix A** (keep same-direction trains apart until the follower is on the berths) halved false merges
  but missed 3 real crossings, all trains that ran through Portslade faster than booked.
- **Fix B** (drop a train missing from the departure board) hid 87 trains that did run. Rejected.

Both were patches on the guessing. The design below stops the guessing from driving closures at all.

**The idea in one line:** a closure is predicted, merged and shown as a countdown **only from trains the
signalling berths have seen**. The timetable and Darwin say which trains to expect and roughly when;
the berths confirm each one and take over the timing.

**The evidence that it pays:**

- Over the 46 days the live app missed 172 closures. **64 of those trains were in neither the timetable
  nor the board** (30 empty trains, 20 unscheduled passenger, 9 track or test, 3 freight, 2 with no
  headcode). The berths saw every one. Berth-first catches them by design.
- Once trains are on the berths, the app groups them correctly about 99% of the time in the last
  minute. The errors are almost all in the guessing zone.
- Close in, the berths beat Darwin: westbound 2 minutes out, typical error 9 s from the berths against
  47 s from Darwin.

---

## 2. Decisions taken (Rich, 16–19 Nov)

| # | Decision |
|---|---|
| D1 | Closures and merges come only from berth sightings. The timetable and Darwin form a forecast layer |
| D2 | Each approach needs train positions **at least 25 minutes** before the crossing. Reading more signalling areas is fine, and nationwide coverage is planned anyway |
| D3 | **Trains starting less than 25 minutes away** are timed from their booked departure until their first berth after leaving, then by the berths |
| D4 | **Missed deadline:** a train expected at our outermost berth that hasn't appeared by its expected time plus a buffer triggers a status check. Cancelled entirely → removed. Only stops cancelled → kept, timed as running through. Rerouted away from the crossing → removed. Delayed → stays in the forecast as "Delayed" with no closure time |
| D5 | **Skipped berths are allowed.** A train dropped after missing its deadline is **reinstated** the moment it hits any berth further along |
| D6 | **Stalled trains** (not reaching the next berth within normal time) are dropped from closure predictions; details in §5.6 |
| D7 | **Signalling feed down:** say so plainly and show no predictions. No fallback to another feed |
| D8 | **Train type** is assigned from whatever the data sources say about that train |
| D9 | **Running through instead of stopping:** westbound from Darwin's cancelled stop, eastbound from time in the berth before Southwick, plus a backstop (§5.5) |
| D10 | **Held or stalled trains** are handled by the stall rule, not a queueing rule (§5.6) |
| D11 | **Trains are tracked by berth, not by headcode** (§5.2) |
| D12 | **Beyond the berth horizon:** train states, approximate times, no countdowns, Closing soon only from Approaching trains (§6) |
| D13 | A timetable can take a train **off the forecast** but can never stop a closure the berths are showing. The berths are the final word |
| D14 | Overlaps across the horizon show as separate closures until both trains are on the berths, then merge |
| D15 | Every new input must be **replayable from day one** |
| D16 | "One train per berth" and "no overtaking" are **validated per crossing**, as variables in the new-crossing skill (§5.7) |
| D17 | Lines with no signalling berths are **rejected, in plain words** (§9.2) |
| D18 | Trains with no description at all are a **known limit**, not a solved case (§8) |
| D19 | The new-crossing skill is updated as part of this work (§9) |

---

## 3. What each source does

| Source | Job | Never used for |
|---|---|---|
| **Signalling berths** (TD C-Class, every area covering 25 min) | Where every train is. Countdowns, BARRIERS DOWN, barriers up, every merge, Closing soon, run-through and stall detection | — |
| **Timetable** (CIF, plus short-notice VSTP) | Which trains to expect, their route (does it cross?), type, stopping pattern, booked times | Closure timing once a train is on the berths; stopping a berth-shown closure |
| **Train movements** (TRUST) | Exact headcode ↔ timetable link (activation); cancellations with where from; change of origin or identity; lateness at upstream timing points | Closure timing |
| **Darwin** (departure board service today) | Live forecast times for Forecast trains; stops cancelled (run-through, westbound) | Closure timing once a train is on the berths |

Today's ladder for a train's time is: timetable → Darwin → projection from its berth → the real berth
step. Berth-first keeps the ladder but splits it in two. The first two rungs produce **forecasts only**.
The last two produce **closures**.

---

## 4. Life of a train

Each train in the app is in one of these states:

| State | Means | Shown as | Can close or merge? |
|---|---|---|---|
| **Forecast** | Expected (timetable, VSTP, Darwin), not on the berths yet, deadline not passed | Listed on its own: "around 10:27" | No |
| **Not yet seen** | Deadline passed, status check under way or unanswered | Listed: "Not yet seen" | No |
| **Delayed** | Status says it is still coming | Listed: "Delayed", no time | No |
| **Approaching** | On the berths, on a route to the crossing, moving normally | Live countdown | Yes |
| **Stalled** | On the berths, overdue in its berth, before the berth that brings the barrier down | Listed: "Delayed" | No — re-enters Approaching the moment it moves |
| **Closing / closed** | Has struck the berth that brings the barrier down | BARRIERS DOWN, or "Train held" if it stops after that berth | Yes |
| **Gone** | Clear step seen, or removed (cancelled, rerouted, left the approach backwards) | Not shown | — |

Transitions:

1. **Forecast → Not yet seen** at the deadline (§5.8).
2. **Not yet seen →** Gone (cancelled or rerouted), Delayed (still coming), or stays Not yet seen if no
   source answers (§5.8).
3. **Any state → Approaching** on a berth step on a route to the crossing. This is the reinstatement
   rule (D5). An unknown train (no timetable entry) enters here directly.
4. **Approaching ↔ Stalled** by time in berth (§5.6).
5. **Approaching → Closing** on the trigger berth step (today's anchor strike, unchanged).
6. **Closing → Gone** on the clear step plus the open lag (unchanged).
7. **A train stepping back out of the approach** (a test train reversing, as 3S93 did on 27 Oct) → Gone,
   or back to Forecast if it is still timetabled to cross.

---

## 5. Components

### 5.1 Berth coverage

- Read every signalling area needed to see trains **25 minutes** out on every route into the crossing,
  or back to the platform where they start (D2, D3).
- **Portslade today:** eastbound already meets it (first seen a median 35 min out; 92% at least 25 min).
  Westbound does not: about 5½ minutes, because Hove and Brighton belong to the neighbouring area. Trains
  enter area LA at two handover berths, T682 (4,199 of 4,378 westbound trains) and T681 (112, including
  1Z14 from Hove and the early-morning empty trains 5H13, 5H91, 5C44).
- Adding the neighbouring area also fixes almost all the westbound trains first seen less than 90 s
  before barrier-down (48 of 4,378). They come in at T681 from that area.
- **Routes are learned, not hand-listed.** For every train that crossed, walk back over the berths it
  used. That gives every route in, the berths shared with other lines, and the **last junction** before
  the crossing. From the last junction inwards every train will cross. Outside it, a sighting counts only
  if the train continues onto the crossing's route, or its timetable says it will (D13).

### 5.2 Tracking by berth, not headcode

- The app keeps **one entry per occupied berth on the learned routes**. A step from X to Y moves whatever
  is in X. This is how the feed itself works.
- **The headcode is a label.** An interpose or cancel (CC/CB) or a change of identity updates the label;
  the entry carries on. Two trains with the same headcode are simply two entries.
- **No headcode ("****"):** tracked the same way, shown as "Unidentified train".
- **A berth showing one label for two trains** (only at berths marked exempt in §5.7): a second train
  entering can overwrite the first one's label. The tracker must keep the first train, not delete it.
- **Prerequisite:** CLAUDE.md records that `td-listener.js` has CB and CC swapped (CB is the cancel,
  carrying `from` only; CC is the interpose, carrying `to` only), so interposes are skipped and every
  cancel blanks a train's position. Berth tracking depends on both, so fix that first (with its fixture)
  if it is still open.
- **Lost and skipped steps (D5):** a step from a berth we never saw the train enter is accepted, and moves
  the train forward. A stall (§5.6) is judged only from time in a berth, never from a missing message.

### 5.3 Linking a tracked train to its timetable

1. **TRUST activation** gives the exact headcode ↔ timetable link when we take that feed.
2. Until then, and as a check: headcode + direction + time window + route consistency (its berths fit the
   timetable's route).
3. If two timetable entries fit, or none, the train **stays unlinked**. Its closure still comes from the
   berths; only its type and stopping pattern are uncertain (§5.4).

### 5.4 Train type (D8)

Sources, first that answers wins:

1. The linked timetable (CIF or VSTP): category, power, stopping pattern.
2. Darwin (passenger service or not, stops, stops cancelled).
3. The headcode's first digit (today's `classify.headcodes`).
4. **Nothing at all** (unlinked "****"): the class that brings the barrier down **earliest** in that
   direction. The safe error is a closure shown slightly early.

### 5.5 Running through instead of stopping (D9)

Measured over 44 days:

- **Westbound (Portslade stop):** 37 of about 3,800 booked stoppers ran through. **36 of the 37 had
  their Portslade stop cancelled on Darwin in the 10 minutes before**; of 3,758 that did stop, only 8
  had. Earlier berth steps don't tell the two apart.
  - **Rule:** booked to stop + stop cancelled on Darwin + still on the berths → time as non-stopping
    (fast class). The 8 false cases close slightly early, the safe direction.
  - **Change needed:** the board poller currently throws away cancelled services. It must keep them and
    read the cancelled stop directly, not infer it from absence (which is what sank Fix B).
- **Eastbound (Southwick, inside berth 0006):** 88 of 1,627 booked callers ran through. They also skipped
  Shoreham, so they spent a median **45 s** in berth 0010 (p10 43, p90 86) against **145 s** for those
  that stopped (p10 131, p90 166). No overlap.
  - **Rule:** time in 0010 below a threshold set between the two groups → time as not calling at
    Southwick.
- **Backstop, both directions:** a train leaving its station berth sooner than any stopping train ever
  does switches to non-stopping timing at once.
- **Caveat:** the westbound non-stopping close offset (berth 0001 + 2 s) is a `GUESS` with no barrier
  observations. It needs field checking before this rule is trusted.

This fixes the 3 real crossings that Fix A missed.

### 5.6 Stalled trains (D6, D10)

- For each berth and class (stopping and non-stopping separately where a station is inside the berth),
  measure the **normal time in the berth**. A train well past it (threshold set by calibration, e.g. p95)
  is **stalled**.
- **Stalled before the trigger berth** → out of closure predictions, shown as "Delayed". When it moves it
  re-enters Approaching. That is safe: it still gets the full warning the trigger berth gives.
- **Stalled at or after the trigger berth** → kept: the barrier is already down. That is today's "Train
  held".
- **Correction recorded:** 1N15 on 16 Nov was **not** queueing behind 1S17. A leader beyond the adjacent
  berth makes no difference to waits (berth 0012: median 36 s, p90 48 s). Only a leader in the very next
  berth slows a follower (0012: 93 s vs 36 s), and today's held-train rule (C20) already covers that.
  1N15 sat in 0012 for 6 min 42 s for no reason visible in our data. At 10:22 it had been there about
  2 minutes, so the stall rule would have taken it out of the closure.

### 5.7 One train per berth, and no overtaking (D16)

- **One train per berth:** when projecting a follower forward, never move it into a berth until the train
  ahead has left it. At Portslade this holds (0–3 exceptions per berth in 44 days).
  - **Where it doesn't hold** (a long platform where a second train pulls in behind, a section with two
    signals): applying it would hold the follower back in the projection while in reality it moves up.
    It would then reach the crossing **sooner than shown**, the dangerous direction. So each berth is
    measured and marked *holds* or *exempt*. At an exempt berth the follower is timed from its own steps
    only, as today: we lose a sanity check, nothing gets worse.
- **No overtaking:** "the train ahead" means **the train ahead on the same track**. Parallel tracks have
  their own berths, so they don't break one-per-berth, but a fast train can pass a slow one.
  - **Portslade:** 0 overtakes in about 8,600 consecutive pairs over 47 days. The one apparent case was
    test train 3S93 reversing out of the approach.
  - **Parallel tracks that merge before the crossing:** compare trains only with others on their own
    track until the merge; the normal rules apply below it.
  - **More than one track per direction across the road itself:** not supported. The engine has one
    track each way. Design it properly when the first such crossing is chosen, against its data.

### 5.8 Deadlines and the cancellation flow (D4, D5)

**The expected time at the outermost berth.** The timetable gives times at timing points (stations,
junctions), not at berths, so it is worked out:

1. From the logs, measure for each outermost berth how long after its booked time at the nearest timing
   point a train normally steps into that berth (median and spread).
2. **Expected** = booked time at that timing point + that offset + current lateness (TRUST movement
   reports, else Darwin).
3. **Deadline** = expected + a buffer per class, set from measured lateness.

This time only decides **when to check on a train**, never a closure time. A deadline too early means a
needless check, and if the train is dropped its next berth restores it. Too late means a train that isn't
coming lingers in the forecast list.

**At the deadline, check status:**

| Status (source) | Action |
|---|---|
| Cancelled over the crossing (TRUST cancellation, by location; Darwin cancelled at the timing points either side) | Gone |
| Only some stops cancelled (Darwin per-stop cancellation) | Keep. Time as running through when it reaches the berths |
| Rerouted: a new or changed schedule whose route doesn't cross (VSTP or TRUST change of origin/location, read with the same both-sides rule as today) | Gone |
| Delayed: still coming (TRUST late at upstream points, Darwin forecast later) | Delayed |
| No source answers (e.g. a freight path that didn't run) | Not yet seen, then Gone after a cut-off measured from the logs |

**Whatever the status says, a berth step on the route brings the train back** (D5, D13). A train diverted
on the day with no new timetable still closes the crossing if it turns up.

**This replaces** the current unseen-train rules: the no-show lead, the unseen grace, the unseen floor,
and the runs-as-required rule for closures. None of them is needed when an unseen train can't close the
crossing. The runs-as-required history may still decide whether such a train is **listed** as a forecast.

### 5.9 Trains starting near the crossing (D3)

- **Before departure:** Forecast, from its booked (or Darwin) departure plus the measured
  departure → crossing time.
- **On the first berth step after leaving the platform:** Approaching, berth timing as normal.
- At Portslade about 70% of westbound passenger trains start at Brighton, roughly 6–7 minutes away.
  This rule covers them; the 25-minute coverage can't, because 25 minutes before they haven't left.

### 5.10 Closure timing, merging and the barrier state

- **Unchanged once a train is Approaching:** the per-class trigger berths and offsets, projection between
  berths, the predicted vs confirmed close, the clear step plus open lag, and BARRIERS DOWN needing the
  trigger strike.
- **Added:** the run-through switch (§5.5), the stall rule (§5.6), and the one-train-per-berth floor on
  projections (§5.7).
- **Merging:** only between Approaching or Closing trains. Today's rules apply: opposite directions merge
  within 20 s; the same direction only on a true overlap; a held close can't justify a merge (C20); and
  the "would otherwise look back to front" coalescing check. **Forecast trains never merge** (D14).
- **Not adopted:** Fix A's same-direction sequencing and its `sameDirFollowGapSecs`. Berth-first makes it
  unnecessary.

### 5.11 Feed outage (D7)

- **Detect:** the whole feed silent, or any one area the crossing needs going quiet when it shouldn't.
  "Shouldn't" is measured: the normal longest silence per area by time of day, or the area's heartbeat
  messages if the logs confirm it sends them.
- **Show** (wording agreed with Rich, 2026-11-19): "Network Rail data is currently unavailable, so we can't predict closures. We're working to get this fixed."
  No countdowns, no closures, no forecasts dressed as predictions.
- **Recover:** when the feed returns, rebuild positions (§5.12) before showing predictions again.
- **This supersedes the TD liveness watchdog** (register #21). Under berth-first a silent feed is no
  longer a quiet degradation to timetable times (as for 4½ days from 22 Sep); it would be an app showing
  no closures, so the detector is a must-have, not a nice-to-have. Surface it on `/health` too.

### 5.12 Restarts

- On start, rebuild every tracked train by replaying the logged berth steps from the last 60 minutes
  (longer than the longest normal approach), plus the timetable, VSTP and TRUST state for the day.
- Until the rebuild finishes, show the same "can't predict" message as an outage, never an empty
  "no closures".

---

## 6. What the page shows (D12)

| Situation | Status card | Next close card | Notes |
|---|---|---|---|
| Next closure from an **Approaching** train | CROSSING CLEAR, "Next closure in ~4m 10s" | Countdown | As today |
| Next closure from a **Forecast** train | CROSSING CLEAR, "Open until around 10:26" | "Next train expected around 10:27" | A clock time, not ticking. Error band from measured Darwin error at that distance: about ±35–55 s at 10–25 min eastbound |
| Within 90 s of an Approaching train's close | CLOSING SOON, "Closing in ~1m 10s" | Countdown | **Only from Approaching trains.** 99.4% of 8,798 crossings over 47 days had the train on the berths at least 90 s before barrier-down |
| A Forecast train due within 90 s but not on the berths | CROSSING CLEAR | "Not yet seen" | It can't reach the crossing that fast. Today the app would go amber for it |
| Barrier down | BARRIERS DOWN, "Opening in ~…" | Open countdown | As today |
| Stalled before trigger | — | Train listed "Delayed" | Re-enters when it moves |
| Feed down or rebuilding | "Network Rail data is currently unavailable, so we can't predict closures. We're working to get this fixed." | Nothing | §5.11 |

- The list of upcoming trains shows Forecast trains **one per row, never merged**, with "around".
  "Delayed" and "Not yet seen" trains appear with no time.
- **Precision matches knowledge:** a countdown only ever appears once the train causing it has been seen
  on the berths.
- **Closures visibly join up** as the second train reaches the berths (D14). That is a desired change, not
  a regression. A regression is a prediction that gets worse as the train gets closer, or worse at
  identical points.

---

## 7. New and changed inputs

All logged raw, timestamped on receipt, rotated by London date and gzipped, in a form the replay feeds back
in the same order as live (D15). **Every timestamp is checked for the London wall-clock trap.**

| Input | What for | Change | Status |
|---|---|---|---|
| **Every TD area's berth steps and heartbeats** (191 areas), to `data/logs/td-all/` | 25-min coverage for any crossing (Portslade westbound: Hove and Brighton; the T681 trains); heartbeats for the outage detector | TD listener writes a national log beside the per-crossing ones | Approved 2026-11-19. Chosen over "the neighbouring area": no per-crossing area hunt, and every future crossing's history starts now. Volume test: ~276 MB/day raw at an evening rate, gzipped daily |
| **VSTP** short-notice timetables (Network Rail, free, same login) | Replacement trains, ECS, freight, specials: does it cross? (same timing-point format, so the existing both-sides rule reads it) | New subscriber + log + merge into the day's schedules | Facts from secondary sources: **confirm from a logged sample** |
| **TRUST** train movements (free, same login) | Activation (0001: headcode ↔ timetable), cancellation (0002, with type and location), reinstatement (0005), change of origin (0006), change of identity (0007), change of location (0008), movements at timing points (0003) | New subscriber + log | Same: confirm from a sample |
| Darwin cancelled services (current board poller) | Stops cancelled → running through (§5.5); cancellations | Stop discarding `isCancelled` services; log them | Small change; needs approval |
| Darwin Push Port (optional, later) | Per-location cancel flag, passing-point forecasts | New connection | Only if the above leave gaps. Diversion support unconfirmed |
| Server capacity | — | Measure volume (one-hour test of all areas + VSTP + TRUST) before committing | Server is on the free tier |

---

## 8. Known limits

- **Trains with no description at all.** The berth display is blank and the feed sends no step for them.
  Signallers normally describe every train, so this should be rare, but we can't measure it at Portslade
  (no barrier data from the feed). Field observations of a closure with no train are the only check.
- **Beyond the horizon, forecasts stay timetable-quality.** Far out, Darwin beats the berths (eastbound
  25 min: Darwin 53 s typical error, crude berth estimate 173 s). That is why far-out trains are shown as
  approximate.
- **Westbound non-stopping close offset is a `GUESS`** (§5.5).
- **Diversions on the day without a new timetable** are only known when the train appears (or doesn't).
  The berths are the final word, so this can only leave a stale forecast, never hide a closure.
- **Unidentified trains get the earliest-closing type**, so their closures can show slightly early.
- **The feed facts for VSTP, TRUST and Darwin** came from search summaries and the published schema files
  (the Open Rail Data wiki blocks automated reading). Each is confirmed from logged samples before
  anything is built on it.

---

## 9. Changes to the new-crossing skill

The `crossing-launch` skill (`SKILL.md`, `MEASURING.md`, `SITE-SELECTION.md`) and
`docs/crossing-definition.md` change as below. **Applied 2026-11-19** at Rich's request, ahead of the code:
each step in the skill is marked **Now** (true today) or **Berth-first** (read by nothing until it ships),
and the new variables are `crossing-definition.md` §14, all Status New.

### 9.1 Code readiness

- **No longer code work:** a junction inside the approach, an approach spanning several areas. Routes are
  learned (§5.1).
- **Still code work:** more than one track per direction across the road (§5.7), automatic barriers
  (`closeModel`), bidirectional track, no adjacent station.

### 9.2 Stage 0 — Triage (`SITE-SELECTION.md` gate 1)

Gate 1 becomes **"Signalling berths covering 25 minutes on every route in."**

- Check every route in. Each needs berth data for 25 minutes, or back to the platform where its trains
  start (the departure rule then covers it).
- **No berth data at all → rejected**, and the verdict says it in these words:

  > **Can't be added.** Network Rail's signalling feed doesn't cover the railway around this crossing,
  > so the app can't see trains coming. Timetables on their own aren't accurate enough to tell people
  > when the barriers will go down, so we'd rather not show predictions than show poor ones.

- **Partial coverage** is stated just as plainly, e.g. "Trains from the north can only be seen 8 minutes
  out; we need 25." The verdict is Parked until the missing area is logged, or Proceed if the gap is a
  starting station.

### 9.3 Stage 1 — Desk facts

Add:

- **Every TD area** covering 25 minutes on every route in, not just the crossing's own.
- **Stations within 25 minutes where trains start**, with their platform berths (for the departure rule).
- **The last junction** before the crossing on each route (where closures become certain).
- **Tracks per direction** on each approach and across the road, and where parallel tracks merge.

### 9.4 Stage 2 — Start logging

- Log **all those areas** from day one, plus **VSTP, TRUST, and Darwin cancelled services**, all in the
  replayable form of §7. Once nationwide logging runs, this stage is a check, not a change.
- Gap-check per area, and record each area's normal longest silence (for the outage detector).

### 9.5 Stage 3 — Berths from the feed

- **Routes are learned automatically:** every berth path that ends in the crossing's clear step,
  including platform berths and joins from other lines. This replaces the hand-built `approachChain`.
- Add these measurements:
  - **normal time per berth** per class (stall rule);
  - **one train per berth** per berth, holds or exempt (§5.7);
  - an **overtaking count** per approach (§5.7);
  - **run-through signals** (§5.5): which evidence separates stoppers from non-stoppers at each station
    on the approach, and the threshold.
- **Accept:** add "every route in has a learned path to the clear step, and every berth is marked for
  one-per-berth".

### 9.6 Stage 4 — Timetable, board and direction (smaller role)

- The timetable now supplies identity, type, stopping pattern, the route test (does it cross?) and the
  expected time at the outermost berth. The board time is used only for forecasts.
- Add the **outermost-berth offsets**: for each outermost berth, booked time at the nearest timing point
  → berth step, with median and spread.

### 9.7 Stage 5 — Calibrate

Add, each with provenance or `GUESS`:

- the **deadline buffer per class** (from measured lateness);
- the **no-status cut-off** (§5.8);
- **stall thresholds** per berth and class;
- **run-through thresholds**;
- **forecast error bands by lead time** (for "around" times);
- **feed-silence thresholds** per area.

These sit alongside today's barrier timings, which remain the real bottleneck.

### 9.8 New rows in `MEASURING.md` (and variables in `crossing-definition.md`)

| Variable | How | If wrong |
|---|---|---|
| Coverage horizon per route | Time from first sighting to the clear step, per route, over ≥ 14 days | Short: trains appear late and Closing soon gets short. The triage gate exists to stop this |
| Learned routes, last junction | Walk back from every clear step over the berths used | A missing route means trains on it are invisible until they join |
| Starting stations and platform berths | Timetable origins within 25 min, plus the berths their trains start from | Their trains get no forecast before departure |
| Outermost-berth offset | Booked time at nearest timing point → step into the outermost berth: median, spread | Too early: needless checks (train restored by its next berth). Too late: dead trains linger in the forecast |
| Deadline buffer per class | Spread of lateness at the outermost berth | As above |
| Normal time per berth, stall threshold | Time in each berth per class (stopping and non-stopping separately where a station is inside) | Too low: moving trains dropped from closures, then restored late. Too high: stalled trains keep a closure |
| **One train per berth** (per berth) | Count how often a train steps into a berth still occupied; ≥ 14 days. Expect exceptions at platforms where trains join, split or pull in behind, at long berths with two signals, and at sidings | Assumed where it doesn't hold: followers projected too late, **barrier down before the countdown ends**. Not assumed where it holds: a lost sanity check only |
| **Tracks per direction, merge points, overtaking count** | Berth map, then count trains reaching the crossing in a different order from their entry | Overtakes missed: followers projected behind a train they actually passed, **barrier down before the countdown ends** |
| Run-through evidence and threshold per station | Darwin stop cancellations against actual non-stops; time-in-berth separation | Stoppers timed as non-stoppers: early (safe). Non-stoppers timed as stoppers: **late (unsafe)** |
| Feed-silence threshold per area | Longest normal gap by time of day, or heartbeat | Too short: false "data unavailable". Too long: a dead feed shown as "no trains" |
| Forecast error band by lead | Darwin and timetable error against the clear step, by minutes out | Wrong ± on "around" times |

**Removed or replaced** in `crossing-definition.md` (after replay proves each removal):

- Replaced by berth-first and no longer per crossing: `td.noShowLeadSecs`, `td.areaEntryLeadSecs`,
  `td.sightingScope`, `close.unseenFloorSecs`, `open.unseenGraceSecs`, and `runsAsRequired.*` for
  closures.
- Reviewed in replay: `close.safetyNetSecs`, and the `queue.*` settings, which stay unless replay shows
  the stall and one-per-berth rules make them redundant.
- `confidenceWindows` becomes the measured forecast band for Forecast trains plus the berth confidence
  for Approaching ones.

### 9.9 Ship gates — add

| # | Gate | Bar |
|---|---|---|
| 8 | Untimetabled trains | In replay over the calibration window, **0 missed closures** for trains the berths saw but no timetable had |
| 9 | Feed down | Outage and restart behaviour shown in replay: the "unavailable" message, never an empty "no closures" |
| 10 | Replayable inputs | Every input the crossing uses is in the logs and drives the replay |
| 11 | Coverage | Horizon ≥ 25 min on every route, or the starting-station rule documented for that route |
| 12 | Closing soon lead | ≥ 99% of closures had their train on the berths ≥ 90 s before barrier-down |

### 9.10 Elapsed time and open questions

- **Elapsed time:** unchanged in shape. Logs and barrier timing still dominate. Learned routes remove the
  hand-built berth lists.
- **Open questions:** remove "calibration tooling to be rewritten" only when the route-learning tool
  exists; it is the same rewrite (readiness item 7). Add "more than one track per direction across the
  road: design when first met".

---

## 10. Rollout

**Each phase needs Rich's go-ahead. No push or deploy without "push and deploy". Portslade's
behaviour changes only after replay proves it.**

| Phase | What | User-visible? |
|---|---|---|
| 0. Log | All TD areas, VSTP, TRUST, Darwin cancelled services. One-hour volume test first (run 2026-11-19) | No |
| 1. Measure (≥ 14 days of logs) | Coverage, outermost-berth offsets, buffers, stall and run-through thresholds, one-per-berth, overtakes, feed silence; confirm each feed's facts from samples; trace the T681 entries | No |
| 2. Build in shadow | Berth tracker, linking, states, deadlines, cancellation flow, stall, run-through, outage, restart. Runs beside live, logs its output, serves nothing | No |
| 3. Replay and shadow comparison | §11 against live code over all logged days, plus live shadow days | No |
| 4. Page | States and wording (§6). Headless screenshots per `feedback_rail_crossing_verify_frontend` | Only on deploy |
| 5. Switch | Serve berth-first at Portslade | Yes |
| 6. Skill | §9 applied early, 2026-11-19, steps marked Now / Berth-first; rewrite around the engine at phase 5 | — |

---

## 11. How each part is proven (replay, before any switch)

Scored against TD-derived truth (barrier-down from the anchor strike, barrier-up from the clear step plus
lag), with the 46-day harness (`~/rc-data/fixab/`: `ab.js`, `report.js`, `truth.js`), extended for the new
inputs.

| Check | Pass |
|---|---|
| Missed crossings | ≤ live overall; the 64 untimetabled misses caught; Fix A's 3 run-through misses caught |
| False CLOSED minutes | ≤ live |
| Grouping, 0–5 min out | False merges ≤ live in both directions |
| Next-close error 0–8 min out | No worse than live, and improving with proximity |
| Inverted closures | 0 |
| Closing soon | ≥ 99% of closures given ≥ 90 s |
| **16 Nov 10:22** | 1S17 alone as an Approaching closure; 1H14 removed or never listed; 1Z14 a single forecast; 1N15 Delayed (stalled) |
| Run-through rule | Over the 44 days: the 36 westbound and 88 eastbound non-stoppers timed as non-stopping before their trigger; false switches counted |
| Stall rule | Trains dropped then restored: none restored with less warning than its trigger berth gives |
| Reinstatement | Every dropped train that later appeared was back before its trigger |
| Reversal | 3S93 on 27 Oct leaves cleanly when it steps back out |
| Same headcode, "****" | Two same-headcode trains tracked separately; "****" closes the crossing |
| Exempt berth | A synthetic two-trains-in-one-berth case keeps both trains |
| Feed outage, restart | Cut the replay feed for 10 min and restart mid-day: "unavailable", then correct positions |
| Regression check | Predictions never worse at identical points, never worse with proximity |

---

## 12. Evidence index

All from logs 1 Oct – 16 Nov 2026 (area LA), scripts in `~/rc-data/fixab/`:

- Fix A/B A/B: `ab.js`, `report.js`, outputs in `out/fixa|fixb|fixab/`.
- Lookahead and berth-vs-Darwin error: `lookahead.js`, `horizon.js`.
- Running through: `runthrough.js`, `runthrough-darwin.js`.
- Queueing and waits: `wait.js`, `release.js`.
- Closing-soon lead and overtaking: `soon.js`, `overtake.js`.
