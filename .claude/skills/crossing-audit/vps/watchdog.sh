#!/usr/bin/env bash
# Restart a block's recorder if it died mid-window — a VPS reboot is the realistic cause,
# and losing the three-hour peak window to it would be the worst outcome of the day.
# Runs every 5 minutes from cron. Silent when there is nothing to do.
#
# Windows are UTC because the box is UTC. BST is UTC+1, so 06:00 BST = 05:00 UTC.
set -u
AUDIT=$HOME/audit
# Pinned to the audit date. Without this the window times match on ANY day — running it on
# 2 Aug at 18:58 launched a spurious 61-minute block-c, because 15:58-20:00 matches every day.
# The cron entry is date-pinned too; this is the second lock, so a manual run cannot misfire.
AUDIT_DAY=${AUDIT_DAY:-2026-08-03}
DAY=$(date -u +%Y-%m-%d)
[ "$DAY" = "$AUDIT_DAY" ] || exit 0
NOW=$(date -u +%s)
LOG=$AUDIT/logs/$DAY-watchdog.log
mkdir -p "$AUDIT/logs"

# label|start(UTC)|end(UTC)   — pipe-delimited: the times themselves contain colons.
BLOCKS='block-a|04:58|08:00
block-b|10:58|13:00
block-c|15:58|20:00'

echo "$BLOCKS" | while IFS='|' read -r LABEL S E; do
  [ -n "$LABEL" ] || continue
  START=$(date -u -d "${DAY} ${S}" +%s) || continue
  END=$(date -u -d "${DAY} ${E}" +%s)   || continue
  OUT=$AUDIT/runs/$DAY/$LABEL

  [ "$NOW" -ge "$START" ] || continue
  [ "$NOW" -lt "$END" ]   || continue
  [ -f "$OUT/record.done" ] && continue
  pgrep -f "record-vps.js .*--label $LABEL" >/dev/null 2>&1 && continue

  REMAIN=$(( (END - NOW) / 60 ))
  [ "$REMAIN" -lt 2 ] && continue
  echo "$(date -u +%FT%TZ) watchdog: $LABEL not running, ${REMAIN}min left — relaunching" >> "$LOG"
  nohup "$AUDIT/runner.sh" "$LABEL" "$REMAIN" >/dev/null 2>&1 &
done
