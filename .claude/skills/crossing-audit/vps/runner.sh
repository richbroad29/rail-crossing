#!/usr/bin/env bash
# One audit block, end to end, unattended.
#   runner.sh <label> <duration_min> [interval_secs]
#
# Record first (perishable), then analyse (not perishable). Analysis is niced so it cannot
# perturb the backend it is measuring — the register cares about steady-state CPU.
set -u
LABEL=${1:?usage: runner.sh <label> <duration_min> [interval_secs]}
DUR=${2:?missing duration}
IVL=${3:-5}

AUDIT=$HOME/audit
DAY=$(date -u +%Y-%m-%d)
OUT=$AUDIT/runs/$DAY/$LABEL
LOG=$AUDIT/logs/$DAY-$LABEL.log
mkdir -p "$OUT" "$AUDIT/logs"

exec >>"$LOG" 2>&1
echo "=================================================================="
echo "$(date -u +%FT%TZ) runner start label=$LABEL dur=${DUR}min interval=${IVL}s out=$OUT"

# One block at a time. -n so a watchdog relaunch can't double-record into the same files.
exec 9>"$AUDIT/.lock-$LABEL"
if ! flock -n 9; then echo "another runner holds the lock for $LABEL; exiting"; exit 0; fi

node "$AUDIT/record-vps.js" "$OUT" "$DUR" --label "$LABEL" --interval "$IVL"
echo "$(date -u +%FT%TZ) recording finished, analysing"

# The journal for this window: parse lines, the ambiguous-traversal drop (register #1),
# CIF update extracts, and any restart. Cheap, and it explains anomalies the API can't.
sudo journalctl -u rail-crossing --since "$DUR min ago" --no-pager -o short-iso \
  > "$OUT/journal.log" 2>/dev/null || journalctl -u rail-crossing --since "$DUR min ago" \
  --no-pager -o short-iso > "$OUT/journal.log" 2>/dev/null || echo "(journal unavailable)" > "$OUT/journal.log"

run() { echo "--- $1"; shift; nice -n 19 "$@" || echo "!!! FAILED: $*"; }

# replay.js reads the DEPLOYED frontend the recorder pinned into $OUT/frontend — backend-v2
# is backend-only, so there is no shared/ on this box to replay against.
run "replay (real deployed frontend)" node "$AUDIT/replay.js"        "$OUT" "$OUT/frontend"
run "ground truth (raw TD)"          python3 "$AUDIT/td-truth.py"    "$OUT"
run "detectors"                      python3 "$AUDIT/detect.py"      "$OUT"
run "regression register"            python3 "$AUDIT/regress.py"     "$OUT"
run "fault injection"                node "$AUDIT/replay-extra.js"   "$OUT"
run "summarise"                      python3 "$AUDIT/summarise.py"   "$OUT"

du -sh "$OUT" 2>/dev/null
echo "$(date -u +%FT%TZ) runner done label=$LABEL"
