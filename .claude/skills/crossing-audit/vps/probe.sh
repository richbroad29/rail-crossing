#!/usr/bin/env bash
# All-day background probe: ONE sample set, appended, then exit.
# Deliberately not a 24-hour process — each run is independent, so a crash costs one sample
# rather than the rest of the night. Covers what the three blocks cannot see: the 03:00 UTC
# CIF/CORPUS refresh that sets up the whole day, the 22:59 UTC TD log rotation, and overnight
# midnight-crossing schedules.
set -u
AUDIT=$HOME/audit
DAY=$(date -u +%Y-%m-%d)
OUT=$AUDIT/runs/$DAY/probe
mkdir -p "$OUT"
T=$(date -u +%s)
M=$(curl -s -m 8 "http://127.0.0.1:3000/crossing/portslade?limit=50")
H=$(curl -s -m 8 "http://127.0.0.1:3000/health")
A=$(curl -s -m 8 "http://127.0.0.1:3000/crossing/portslade")
[ -n "$M" ] && printf '{"t":%s,"main":%s}\n' "$T" "$M" >> "$OUT/main.jsonl"
[ -n "$H" ] && printf '{"t":%s,"health":%s}\n' "$T" "$H" >> "$OUT/health.jsonl"
[ -n "$A" ] && printf '{"t":%s,"bytes":%s}\n' "$T" "${#A}" >> "$OUT/appview.jsonl"
# public path (Caddy + TLS), status and latency only — this is the route real users take
curl -s -o /dev/null -m 12 -w '{"t":'"$T"',"status":%{http_code},"ms":%{time_total},"bytes":%{size_download}}\n' \
  "https://api.railcrossing.uk/crossing/portslade" >> "$OUT/public.jsonl" 2>/dev/null
