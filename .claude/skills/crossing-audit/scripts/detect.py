#!/usr/bin/env python3
"""Failure-signature detectors + regression check against KNOWN-ISSUES.md.
   detect.py <OUTDIR> [--regress]
Run after replay.js (needs replay.json for the rendered-text checks)."""
import json, sys, re, os
from datetime import datetime, timezone, timedelta

OUT = sys.argv[1] if len(sys.argv) > 1 else sys.exit('usage: detect.py <OUTDIR> [--regress]')
LON = timezone(timedelta(hours=1))
def piso(s):
    s = s.replace('Z', '+00:00'); d = datetime.fromisoformat(s)
    return d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d
def L(t): return datetime.fromtimestamp(t, LON).strftime('%H:%M:%S')

main = [json.loads(l) for l in open(f'{OUT}/main.jsonl') if l.strip()]
live = [json.loads(l) for l in open(f'{OUT}/live.jsonl') if l.strip()]
rep = json.load(open(f'{OUT}/replay.json')) if os.path.exists(f'{OUT}/replay.json') else []
print(f'window {L(main[0]["t"])}-{L(main[-1]["t"])}  main={len(main)} live={len(live)} replay={len(rep)}')

def head(n, t): print(f'\n{"="*100}\n{n}. {t}\n{"="*100}')

# --- 0. clock skew + restarts: validate the recording before trusting it ---
head(0, 'RECORDING INTEGRITY')
skew = [(r['t'], (r['live']['serverTime'] / 1000) - r['t']) for r in live if r.get('live', {}).get('serverTime')]
bad = [(t, s) for t, s in skew if abs(s) > 20]
print(f'  samples: {len(skew)}   with >20s local/server clock skew: {len(bad)}'
      + (f'  <<< EXCLUDE THESE: {[L(t) for t, _ in bad][:5]}' if bad else ''))
ups, prev = [], None
for line in open(f'{OUT}/health.jsonl') if os.path.exists(f'{OUT}/health.jsonl') else []:
    try: u = json.loads(line)
    except Exception: continue
    up = (u.get('health') or {}).get('uptime')
    if up is None: continue
    if prev is not None and up < prev: ups.append(L(u['t']))
    prev = up
print(f'  backend restarts during window: {len(ups)} {ups}'
      + ('   <<< conclusions before/after are not comparable' if ups else ''))

# --- 1. grouping stability: oscillation is the pathology, not change ---
head(1, 'GROUPING STABILITY')
seq = {}
for rec in main:
    for c in (rec['main'].get('upcomingClosures') or []):
        key = tuple(sorted(t.get('headcode', '?') for t in c['trains']))
        for hc in key: seq.setdefault(hc, []).append(key)
osc = 0
for hc, g in sorted(seq.items()):
    flips = sum(1 for i in range(1, len(g)) if g[i] != g[i - 1])
    trans = sum(1 for i in range(1, len(g)) if (len(g[i]) > 1) != (len(g[i - 1]) > 1))
    if flips:
        dist = {}
        for k in g: dist[k] = dist.get(k, 0) + 1
        parts = '  '.join(f"{'+'.join(k)}={v*100//len(g)}%" for k, v in sorted(dist.items(), key=lambda x: -x[1]))
        mark = '  <<< OSCILLATING' if trans >= 2 else ''
        if trans >= 2: osc += 1
        print(f'  {hc:6} {flips:3} regroup(s)/{len(g):4} samples: {parts}{mark}')
print(f'  trains oscillating merged<->split 2+ times: {osc}   (one-way regrouping is fine)')

# --- 2. bestTime jitter: driver of churn and backwards countdowns ---
head(2, 'bestTime JITTER')
jit = {}
for rec in main:
    for c in (rec['main'].get('upcomingClosures') or []):
        for t in c['trains']: jit.setdefault(t['headcode'], set()).add(t['bestTime'])
for hc, v in sorted(jit.items(), key=lambda x: -len(x[1]))[:8]:
    span = (max(map(piso, v)) - min(map(piso, v))).total_seconds()
    print(f'  {hc:6} {len(v):3} distinct values spanning {span:5.0f}s')

# --- 3. monotonicity: any countdown that increases is a bug ---
head(3, 'COUNTDOWN REVERSALS (any increase while CLOSED)')
def cd(s):
    if not s or s in ('--', 'Soon', 'NOW'): return None
    m = re.match(r'(?:(\d+)m\s*)?(?:(\d+)s)?$', s.strip())
    if not m or not any(m.groups()): return None
    return int(m.group(1) or 0) * 60 + int(m.group(2) or 0)
prev = pt = ps = None; rev = 0
for r in rep:
    v = cd(r['nextOpen'])
    if prev is not None and v is not None and r['uiTitle'] == pt == 'BARRIERS DOWN' and v > prev + 8:
        rev += 1; print(f"  {r['time']}  Next Open {ps} -> {r['nextOpen']} (+{v-prev}s)  downFor {r['downFor']}")
    prev, pt, ps = v, r['uiTitle'], r['nextOpen']
print(f'  reversals: {rev}')

# --- 4. invariants: start vs predictedStart ---
head(4, 'start vs predictedStart')
b = {}
for rec in main:
    for c in (rec['main'].get('upcomingClosures') or []):
        d = (piso(c.get('predictedStart') or c['start']) - piso(c['start'])).total_seconds()
        t0 = c['trains'][0]
        b.setdefault((t0.get('direction'), t0.get('source'), d), set()).add(tuple(sorted(x['headcode'] for x in c['trains'])))
for (dr, src, d), ks in sorted(b.items(), key=lambda x: (str(x[0][0]), str(x[0][1]), x[0][2])):
    tag = f'pred BEFORE start -> "Soon" for {-d:.0f}s  <<< INVARIANT BROKEN' if d < 0 else \
          ('equal (strike-confirmed)' if d == 0 else 'pred after start (ok)')
    print(f'  {str(dr):5} {str(src):6} delta={d:+6.0f}s  closures={len(ks):3}  {tag}')

# --- 5. self-consistency within one response ---
head(5, 'SELF-CONSISTENCY (state vs currentClosure vs list)')
n = sum(1 for r in rep if r['backendState'] == 'CLOSED' and r['currentClosureNull'])
dis = sum(1 for r in rep if {'BARRIERS DOWN': 'CLOSED', 'CLOSING SOON': 'CLOSING_SOON',
                             'CROSSING CLEAR': 'OPEN'}[r['uiTitle']] != r['backendState'])
print(f'  responses with state=CLOSED but currentClosure=null: {n}')
print(f'  samples where UI-derived state != backend state field: {dis} / {len(rep)}')

# --- 6. dead code paths / hidden certainty ---
head(6, 'CONFIDENCE TIERS')
tdb = {t.get('tdBerth') for rec in main for c in (rec['main'].get('upcomingClosures') or []) for t in c['trains']}
conf = [r for r in rep if r['firstStart'] and r['firstStart'] == r['firstPredStart']]
print(f'  tdBerth values ever populated: {tdb}')
print(f'  samples rendering "Any moment now": {sum(1 for r in rep if "Any moment now" in (r["card1"] or ""))}')
print(f'  samples rendering a "±" band: {sum(1 for r in rep if "±" in (r["card1"] or ""))}')
print(f'  samples strike-confirmed (start==predictedStart) yet still banded: {len(conf)}')
print(f'  samples rendering "in now": {sum(1 for r in rep if "in now" in (r["card1"] or ""))}')

# --- 7. ghost trains ---
head(7, 'GHOST TRAINS (bestTime pinned to now+30s)')
gh = {}
for rec in main:
    for c in (rec['main'].get('upcomingClosures') or []):
        for t in c['trains']:
            if t.get('etaText') == 'Live (TD)':
                d = piso(t['bestTime']).timestamp() - rec['t']
                if 25 <= d <= 36: gh.setdefault(t['headcode'], []).append(rec['t'])
if not gh: print('  none')
for hc, ts in gh.items():
    dur = (max(ts) - min(ts)) / 60
    print(f'  {hc}: {len(ts)} samples {L(min(ts))}-{L(max(ts))} ({dur:.1f} min)'
          + ('   <<< RUNAWAY' if dur > 2 else '   (brief, by design)'))

# --- 8. picker "on time" with no live estimate ---
head(8, 'PICKER "on time" WITH NO LIVE ESTIMATE')
tr = {}
for rec in live:
    for t in (rec['live'].get('trains') or []):
        hc = t.get('headcode')
        if not hc: continue
        r = tr.setdefault(hc, {k: set() for k in 'la ld sa sd'.split()})
        for k, f in (('la', 'liveArr'), ('ld', 'liveDep'), ('sa', 'schedArr'), ('sd', 'schedDep')):
            if t.get(f): r[k].add(t[f])
aff = [hc for hc, r in tr.items() if (r['sa'] or r['sd']) and not (r['la'] or r['ld'])]
print(f'  trains with a scheduled time but NO live estimate: {len(aff)} {aff}')
print('  (each of these renders as "<sched> on time" in the feedback picker)' if aff
      else '  (condition did not arise; check the code path still exists before calling it fixed)')

if '--regress' in sys.argv:
    p = os.path.join(os.path.dirname(__file__), '..', 'KNOWN-ISSUES.md')
    head(9, 'REGRESSION REGISTER')
    print(open(p).read() if os.path.exists(p) else '  KNOWN-ISSUES.md not found')
