#!/usr/bin/env python3
"""Where each LDB time came from, for a day — actual, forecast, or the bare timetable.

Run it without deploying anything, by piping it in over ssh:

    ssh -i ~/Downloads/ssh-key-2026-03-22.key ubuntu@130.162.167.237 \
      'python3 - 2026-08-15' < .claude/skills/crossing-audit/vps/estimate-provenance.py

Defaults to today (Europe/London, which is how the log files are named).

WHY THIS EXISTS. C19 fixed two faults with one visible symptom — a train shown at its
timetabled time and labelled "On time". Fault A (the feed publishes an ACTUAL and drops the
forecast; we never read the actual) is fixed and field-verified. Fault B — the estimate
collapsing to the timetable while the train is still APPROACHING — was seen once, on 1S30
on 2026-08-13, and its cause was never established: the log stored only the resolved time,
and a withdrawn `etd` is byte-identical to an `etd` equal to `std` once resolved.

That is the question this answers. `src: scheduled` means the feed gave us nothing — no
forecast and no actual — which is the state the sticky-estimate rule exists for. If it never
appears, then 1S30 was the other case (the feed actively re-asserting the timetable time),
the sticky rule is inert, and fixing 1S30 needs something else entirely: a guard on the
prediction, not on the estimate.

So: no `src: scheduled` is a RESULT, not a null result. It rules a hypothesis out.

`held: true` is the sticky rule actually firing — the count of times we served a remembered
estimate instead of falling back to the timetable.
"""

import json
import sys
import collections
import datetime
import os

LOG_DIR = "/home/ubuntu/rail-crossing/backend/data/logs"

day = sys.argv[1] if len(sys.argv) > 1 else None
if not day:
    os.environ["TZ"] = "Europe/London"
    try:
        import time as _t
        _t.tzset()
    except Exception:
        pass
    day = datetime.datetime.now().strftime("%Y-%m-%d")

path = f"{LOG_DIR}/{day}.jsonl"
if not os.path.exists(path):
    print(f"no log for {day} at {path}")
    sys.exit(1)

src = collections.Counter()
types = collections.Counter()
per_service = collections.defaultdict(list)
scheduled_hits = []
held_hits = []

for line in open(path):
    try:
        d = json.loads(line)
    except Exception:
        continue
    if d.get("cat") != "ldb":
        continue
    ts = d["ts"]
    for t in d.get("trains", []):
        s = t.get("src")
        src[s] += 1
        types[(t.get("arrType"), t.get("depType"))] += 1
        key = (t.get("headcode"), t.get("sch"))
        per_service[key].append((ts, t.get("best"), t.get("delay"), s, t.get("held")))
        if s == "scheduled":
            scheduled_hits.append((ts, t.get("headcode"), t.get("sch"), t.get("best"),
                                   t.get("arrType"), t.get("depType")))
        if t.get("held"):
            held_hits.append((ts, t.get("headcode"), t.get("sch"), t.get("best")))

total = sum(src.values())
if not total:
    print(f"{day}: no LDB observations")
    sys.exit(0)

# Entries logged before the C19 deploy have no `src` at all — count them separately rather
# than letting them masquerade as a category.
legacy = src.pop(None, 0)

print(f"{day}: {total} train-observations across {len(per_service)} services")
if legacy:
    print(f"  {legacy} predate the C19 deploy (no provenance recorded) — excluded below")
print()
print("  timeSource census:")
for k, v in src.most_common():
    print(f"    {k:<10} {v:>6}")
print()
print("  what the feed called its own times (arrivalType, departureType):")
for k, v in types.most_common(6):
    if k == (None, None):
        continue
    print(f"    {str(k):<26} {v:>6}")
print()

print(f"  *** src=scheduled (feed gave nothing): {len(scheduled_hits)} ***")
if scheduled_hits:
    print("      This is the state 1S30 could not be classified into. Cross-reference each")
    print("      headcode against the TD log: if the train had NOT yet reached its approach")
    print("      berth, it is fault B occurring live, and the sticky rule is doing real work.")
    for h in scheduled_hits[:25]:
        print(f"      {h[0][11:19]}  {h[1]}  sch {h[2][11:16] if h[2] else '?'}  "
              f"best {h[3][11:16] if h[3] else '?'}  arrType {h[4]}  depType {h[5]}")
    if len(scheduled_hits) > 25:
        print(f"      ... and {len(scheduled_hits) - 25} more")
else:
    print("      None. On this day's evidence the feed always supplied a time, so a train")
    print("      showing its timetabled slot was being FORECAST on time, not left silent —")
    print("      which makes the sticky-estimate rule inert and points 1S30's cause elsewhere.")
print()

print(f"  held=true (sticky estimate served): {len(held_hits)}")
for h in held_hits[:15]:
    print(f"      {h[0][11:19]}  {h[1]}  sch {h[2][11:16] if h[2] else '?'}  kept {h[3][11:16] if h[3] else '?'}")
print()

# The original symptom, restated as a check: a service that was running late and ended its
# board life back at its timetabled time with zero delay. C19 should make this impossible.
#
# ONLY over observations that carry provenance. On a day that straddles the deploy, the
# earlier ones are the OLD code doing exactly what it was fixed for, and counting those is a
# false alarm by construction — the first run of this script reported 145 of them against a
# day whose morning predated the fix. A service is judged on its post-deploy tail or not at
# all; one whose whole life predates the deploy is not evidence either way.
reverted = 0
delayed = 0
shown = 0
for (hc, sch), v in sorted(per_service.items()):
    v = [x for x in v if x[3] is not None]
    if not v:
        continue
    if max((x[2] or 0) for x in v) <= 0:
        continue
    delayed += 1
    if v[-1][1] == sch and v[-1][2] == 0:
        reverted += 1
        if shown < 10:
            shown += 1
            print(f"  REGRESSION: {hc} sch {sch[11:16]} ended back at its timetabled time, "
                  f"delay 0, src {v[-1][3]}")
if reverted > shown:
    print(f"  ... and {reverted - shown} more")
print(f"  delayed services (post-deploy observations only): {delayed}")
print(f"  of those reverting to timetable+delay0 at the end: {reverted}")
print("  (any non-zero here is C19 regressing — that is the reported symptom returning)")
