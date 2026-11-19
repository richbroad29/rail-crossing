# Site selection — is this crossing worth it?

Companion to `SKILL.md` Stage 0. The point of this document is to make the "no" cheap and the "yes"
evidenced, because the expensive mistake is instrumenting and half-calibrating a site that was never
going to produce a useful product.

---

## The four gates, in order

Stop at the first failure. They are ordered by cost-to-evaluate, cheapest first.

### Gate 1 — Signalling berths covering 25 minutes on every route in

**Hard requirement.** Without berth steps on the approach there is no position, no strike anchor, no
clear step, and therefore no product: the app degrades to reading out a timetable that the user could
have read themselves. Berth-first (docs/berth-first-design.md) goes further: a closure is only ever
predicted from a train the berths have seen, so the berths must see trains early enough.

Check (2026-11-19):

1. **Every route in** to the crossing, both directions, including lines that join before it.
2. **Each route needs berths for 25 minutes before the crossing**, possibly across several TD areas, or
   back to the platform where its trains start (they are timed from booked departure until they leave).
3. **Granularity:** a single berth covering eight minutes of approach gives one coarse trigger; four
   berths over the same stretch give a sharpening ladder.

Every area's berth steps are logged nationally since 2026-11-19 (`data/logs/td-all/` on the VPS), so
this is measured from the log, not estimated: first sighting → crossing, per route (`MEASURING.md`,
coverage horizon). Portslade: eastbound median 35 min (92% ≥ 25) from area LA alone; westbound only
about 5½ min from LA, because Hove and Brighton are in the neighbouring area.

**Verdicts, in these words:**

- **No berth data at all → Rejected**, and the verdict says:

  > **Can't be added.** Network Rail's signalling feed doesn't cover the railway around this crossing,
  > so the app can't see trains coming. Timetables on their own aren't accurate enough to tell people
  > when the barriers will go down, so we'd rather not show predictions than show poor ones.

- **Partial coverage → Parked**, saying just as plainly what is missing, e.g. "Trains from the north can
  only be seen 8 minutes out; we need 25." Proceed instead if the short route's trains start at a
  station inside the 25 minutes, and say so.

Rough test once logging: median dwell per approach berth. Berths with median dwell over ~180 s are
doing little work. Portslade's east chain runs 37–143 s per berth, which is what makes the projection
step worth having.

### Gate 2 — what lowers the barrier

| Type | Close trigger | Expected difficulty |
|---|---|---|
| **AHB** (automatic half barrier) | Automatic, fixed strike point | **Easiest** — no human in the loop |
| **MCB-OD** (obstacle detection) | Automatic lower | Easy — same reasoning |
| **MCB-CCTV** | Signaller, manually, watching CCTV | **Portslade.** Irreducible human variance on the close |
| **MCB** (non-CCTV, locally monitored) | Signaller | As MCB-CCTV |
| AOCL / ABCL / user-worked / footpath | Often no barriers to predict | Usually not a product |

**Hypothesis worth testing, not yet evidence:** an automatically-lowered crossing should be
*substantially* easier than Portslade, because the hardest variable — signaller decision timing, sd ~34 s
on n=11 westbound — simply doesn't exist. Portslade's close is manual and its open is automatic
(`autoLower: false, autoRaise: true`), which is precisely why the open is ~2× tighter than the close.
An AHB should be tight at both ends.

This is a hypothesis because **we have no AHB dataset**: Yapton, our only non-Portslade barrier data, is
also MCB-CCTV. Testing it is cheap — one AHB in an S-Class area, instrumented for a fortnight, settles
it. If it holds, it should reorder the candidate list, because it means the *easiest* sites to serve
are a different population from the one Portslade taught us about.

Do not assume regulatory warning times substitute for measurement. Measure.

### Gate 3 — is there enough closure to be worth predicting

**Computable today from CIF, with no new instrumentation.** This is the cheapest real number in the
whole process and it should be produced for every candidate before anything else is spent.

Method: count schedules traversing the TIPLOC pair per day, apply a nominal close lead and open lag,
merge overlaps, report:

- closures per day
- total barrier-down minutes per day
- **peak-hour down-minutes** — the number that actually correlates with how much people hate the
  crossing
- longest single closure
- how often two closures merge into one (back-to-back closures are the worst user experience and the
  case the app is most valuable for)

Reference: Portslade runs around **22 closures/day**. Treat that as one observation from the
pre-`?limit=` payload note in CLAUDE.md, not a constant — re-measure it when you compute a candidate's,
so the comparison is like-for-like.

**Suggested bar:** peak-hour down-minutes within a factor of two of Portslade's. Below that, the honest
answer to a user is "check the timetable". Calibrate this bar against Portslade's actual measured figure
on first use, then record the real number here and delete this paragraph.

Accuracy caveat: the CIF estimate is a *lower* bound on real closure burden. It will miss Q-freight that
actually runs, engineering movements, and signaller-discretionary early closures. It will overcount
Q-freight that doesn't. At Portslade roughly half the area's freight is Q-pathed.

### Gate 4 — is barrier state observable

| Situation | Cost | Verdict |
|---|---|---|
| S-Class byte:bit already known (wiki, community map, or `sclass.json`) | ~3 weeks elapsed, no site time | **Best case** |
| Area publishes S-Class; byte must be hunted from banked raw | ~6 weeks elapsed, no site time | **Good** — and the hunt also derives the topology |
| No S-Class, but a willing local volunteer | 3+ months, many sessions | Not supported today: the observer app is Portslade-only and internal |
| No S-Class, no volunteer | — | **Don't start.** You cannot calibrate, and an uncalibrated launch is a false-alarm generator |

The 12 LXG-positive describers already banking raw: **BM, X7, RT, EN, EH, HG, EK, B3, BU, Q3, Q5, EA**
(`backend/config/sclass.json`, Open Rail Data describer list, 10 Apr 2026 snapshot). A candidate in one
of these is materially cheaper than one outside them.

**This reverses the natural instinct.** The obvious way to pick the next crossing is "the busiest one
people complain about". The cheap way is "the one whose signalling area tells us what its barriers are
doing". Rich's decisions: demand-led selection with a preference for S-Class sites (2026-09-19), and
only sites with barrier data for now — so demand generates the candidate list and Gate 4 decides it.

---

## Demand signal

- **"Request Your Local Crossing" form** — the primary signal. Count requests per crossing.
- **GoatCounter** — referrer and search terms hitting the landing page.
- **Road importance** — DfT publishes annual average daily flow (AADF) by count point as open data;
  useful for weighting, but a crossing's annoyance is closure-time × traffic, and closure-time is the
  half we can compute precisely.

Demand tells you *which* crossing. Gates 1–4 tell you *whether* and *when*.

---

## Scoring

No weighted formula — the gates are near-binary and a composite score would hide that. Instead:

```
Gate 1 no berths       -> reject, permanently, in the Gate 1 wording
Gate 1 short coverage  -> park, naming the route and its minutes
Gate 2 = AOCL/UWC etc. -> reject unless there is a specific reason
Gate 3 below bar       -> park; re-check if the timetable changes materially
Gate 4 = no/no         -> park; re-check if S-Class coverage expands
All pass               -> rank by (demand x peak-hour down-minutes), launch cheapest-first within a band
```

"Launch cheapest-first within a band" matters: given two candidates of similar value, the one with a
known S-Class byte ships a month sooner and teaches you things that make the second one faster.

---

## Record every decision

Keep `CANDIDATES.md` in this directory: crossing, date assessed, gate results, verdict, and the reason.
A rejected candidate gets re-requested. The second assessment should cost five minutes and reach the
same answer, or explicitly say what changed.
