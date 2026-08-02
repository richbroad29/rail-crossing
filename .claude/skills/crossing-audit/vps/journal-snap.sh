#!/usr/bin/env bash
# Snapshot the backend journal around the 03:00 UTC CIF/CORPUS refresh. No audit block covers
# it (block A starts 04:58 UTC), yet a failed refresh silently degrades every prediction for
# the rest of the day — so it is worth one targeted dump.
set -u
DAY=$(date -u +%Y-%m-%d)
OUT=$HOME/audit/runs/$DAY/probe
mkdir -p "$OUT"
{ sudo journalctl -u rail-crossing --since "${DAY} 02:30:00" --until "${DAY} 04:10:00" \
    --no-pager -o short-iso 2>/dev/null || \
  journalctl -u rail-crossing --since "${DAY} 02:30:00" --until "${DAY} 04:10:00" \
    --no-pager -o short-iso 2>/dev/null; } > "$OUT/journal-refresh.log"
wc -l "$OUT/journal-refresh.log"
