# Where every dataset lives

**Read this BEFORE any analysis.** On 2026-07-31 an analysis concluded "we only have 3 westbound
close observations" and recommended replacing a rule that was very nearly correct. There were
**11**, in two files nobody had listed. Check this inventory first, and add to it whenever a new
source appears.

## Barrier observations (Portslade) — the scarce resource

The barrier's own state is **not in any feed** for Portslade. Area LA does not publish
level-crossing S-class bits (only the 12 LXG-positive describers in `backend/config/sclass.json`
do, and LA is not among them). So **human observation is the only source of Portslade barrier
truth**, which is why these files matter so much.

| What | Where | Contents |
|---|---|---|
| 24 Jun session, raw | `~/Downloads/observer-portslade-20260624-1426.json` | 26 records — 13 CLOSE / 13 OPEN, 14 west / 12 east. `liveSnapshot` holds only `{headcode, berth, fromBerth, direction, stopping, ageSecs}` — **no sched/live times**, so lateness must come from the VPS `ldb` log |
| 24 Jun westbound, analysed | `~/Desktop/portslade-westbound-24jun2026.csv` | **8 west stopper closes**, fully worked: close time, RTT arr/dep, `0003`/`0005` strike-ins, `0007` crossing, and every offset pre-computed. The most directly useful barrier file we have |
| 6 Jun session | `~/Downloads/observer-portslade-20260606-2152.json` | small (3.8 KB), early session |
| 31 Jul onward | Google Sheet `Feedback v2` tab → exports in `~/Downloads/New Crossing Requests - Feedback v2*.csv` | 53 columns. **The observer only started POSTing to the sheet on 2026-07-29** — before that it was local export only, which is why the early sessions exist only as JSON |
| earlier feedback | `~/Downloads/Crossing Feedback - Feedback v2.csv`, `Crossing Feedback - Level crossing data.csv` (645 KB) | pre-v2 era, public-app feedback |

Running total of **westbound stopper closes: 11** (8 from 24 Jun + 3 from 31 Jul).

## Backend logs on the VPS — `ssh -i ~/Downloads/ssh-key-2026-03-22.key ubuntu@130.162.167.237`

`~/rail-crossing/backend/data/`

| What | Where | Contents |
|---|---|---|
| **Train lateness history** | `logs/YYYY-MM-DD.jsonl` — **84 days** from 2026-03-22, ~4 MB/day | `cat:"ldb"` records (~2,880/day) each carrying per-train `{dir, sch, best, origin, dest, delay, headcode}`. **This is where scheduled-vs-estimated and `delay` live** — the only route to historical lateness, and the file that answered the late-train hypothesis |
| TD berth steps (area LA) | `logs/td/td-YYYY-MM-DD.jsonl` — **87 days** | C-class CA/CB/CC for area LA. Ground truth for the crossing instant (`0004→0002` east, `0005→0007` west). **Rotates 23:00Z** — stitch consecutive days or a 22:59 strike looks missing |
| S-class (other areas) | `logs/sclass/` — 469 files | 12 LXG-positive describers. `barrier-*.jsonl.gz` = **Yapton** barrier events, 38 days, 29,213 events |
| CIF schedule | `schedule/cif-latest.json.gz` | daily full extract, ~592 k schedules |
| CORPUS | `corpus/corpus-latest.json.gz` | TIPLOC → name |
| Derived transits | `transits.json` | per-class berth→XING seconds + sd + n |

## In the repo — `rail-crossing/analysis-data/` (untracked)

| What | Contents |
|---|---|
| `audit-2026-07-27/` | 639-sample API recording (`main.jsonl`, `live.jsonl`, `health.jsonl`) + `rtt.txt` + analysis scripts. Replay harness input |
| `barrier-2026-06-2X.jsonl` (8 days) | **Yapton** S-class barrier events |
| `cclass-BM-2026-06-2X.jsonl` (8 days) | Barnham-area C-class berth steps |
| `yapton-episodes.csv` | **1,364** Yapton barrier episodes: `closeT/openT/durationS/triggeringHeadcode/serviceType/direction/strikeInBerth/closeLeadS/openLagS`. NB `closeLeadS` = **strike→close** (our `offsetSecs`), *not* close→crossing |
| `yapton-train-pairs.csv` | 1,794 consecutive-train pairs |

**Yapton is not transferable to Portslade** (Rich, 2026-07-31): different signal box, different berth
geometry, and measured — **no platform dwell in either direction** (stop/fast occupancy ratio 1.04×
and 0.95× against Portslade west's 5×). Neither direction reproduces the Portslade westbound case.
Use it when the app expands to other crossings, not for Portslade numbers or ceilings.

## Reference documents

`~/Downloads/MCB-CCTV barrier logic at Portslade LC (Boundary Road) — … RailUK Forums.pdf`,
`~/Downloads/NRA_2010867_0.01 Portslade_redacted.pdf`.

## Facts worth not rediscovering

- **The open is automatic, the close is manual** (`autoLower:false, autoRaise:true`). Hence the
  open is ~2× tighter than the close, and the close carries irreducible signaller variance
  (sd ~34 s on n=11 westbound).
- **CCTV is not how the signaller sees the train** — it verifies the crossing is clear before
  lowering. Position comes from the signalling panel, i.e. the same berth data we consume.
- **Booked dwell dominates west stopper transit error.** `0005`→crossing is 114–138 s for 0–2 min
  dwells but 219–223 s for 3 min dwells; the class median (116 s) cannot cover both. Dwell is a
  per-service timetable fact, not a class property.
- **24 Jun was a disrupted day** — mean delay 5.9 min, range 1–13. The shipped `dep − 45` was
  calibrated on it. Delay does *not* correlate with close lead (r = −0.00, n=11), so probably
  harmless, but it is a provenance caveat.
- **Rejected hypotheses** (don't re-run): late trains get a different close lead (r = −0.00,
  n=11); train sequencing / time-of-day driving close lead (observation bias in a 4-point sample).
