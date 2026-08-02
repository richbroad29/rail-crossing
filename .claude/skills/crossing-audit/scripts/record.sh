#!/bin/zsh
# Record the crossing API at 5s until a wall-clock end time.
#   record.sh <OUTDIR> "<END HH:MM>" [crossing-id]
# Writes main.jsonl / live.jsonl / health.jsonl, each line {"t":<epoch>,...}.
# Wrapped in caffeinate: a laptop suspend has killed this mid-session before.
set -u
OUT=${1:?usage: record.sh <OUTDIR> "<END HH:MM>" [crossing-id]}
ENDHM=${2:?missing end time, e.g. 08:52}
CROSS=${3:-portslade}
API=https://api.railcrossing.uk

# Re-exec under caffeinate so a laptop suspend can't kill the run mid-window.
if command -v caffeinate >/dev/null 2>&1 && [ -z "${CA_WRAPPED:-}" ]; then
  CA_WRAPPED=1 exec caffeinate -i zsh "$0" "$@"
fi

mkdir -p "$OUT"
END=$(date -j -f "%Y-%m-%d %H:%M:%S" "$(date +%Y-%m-%d) ${ENDHM}:00" +%s)
if [ "$END" -le "$(date +%s)" ]; then echo "end time already passed" >&2; exit 1; fi
echo "recording $CROSS -> $OUT until $ENDHM ($(( (END - $(date +%s)) / 60 )) min)"

i=0
while [ "$(date +%s)" -lt "$END" ]; do
  T=$(date +%s)
  A=$(curl -s -m 8 "$API/crossing/$CROSS")
  B=$(curl -s -m 8 "$API/crossing/$CROSS/live")
  [ -n "$A" ] && print -r -- "{\"t\":$T,\"main\":$A}"  >> "$OUT/main.jsonl"
  [ -n "$B" ] && print -r -- "{\"t\":$T,\"live\":$B}"  >> "$OUT/live.jsonl"
  if [ $((i % 6)) -eq 0 ]; then
    H=$(curl -s -m 8 "$API/health")
    [ -n "$H" ] && print -r -- "{\"t\":$T,\"health\":$H}" >> "$OUT/health.jsonl"
  fi
  i=$((i+1))
  sleep 5
done
print -r -- "done $(date +%H:%M:%S)" >> "$OUT/record.done"
