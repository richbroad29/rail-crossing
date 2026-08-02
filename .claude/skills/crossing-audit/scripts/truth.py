#!/usr/bin/env python3
"""Ground truth from TD berth strikes, and the coverage question.
   truth.py <OUTDIR>
Answers: did every train that physically crossed get a closure, in time to be useful?
And: is every train in the observer's feed that is on the Portslade route in the app?"""
import json, sys, os
from datetime import datetime, timezone, timedelta

OUT = sys.argv[1] if len(sys.argv) > 1 else sys.exit('usage: truth.py <OUTDIR>')
LON = timezone(timedelta(hours=1))          # BST; use +0 in winter

XING = {'0006': ('east', 'approach'), '0004': ('east', 'protecting'), '0002': ('east', 'clear'),
        '0003': ('west', 'approach'), '0005': ('west', 'protecting'), '0007': ('west', 'clear')}
# Berths on the Portslade route (observer CHAIN + its eastbound off-chain ETA map).
ROUTE = set('0016 0014 0012 0010 0008 0006 0004 0002 T686 T684'.split()) | \
        set('T682 T677 0001 0003 0005 0007 0009 0011 0013 0015 0017'.split()) | \
        set('0020 0024 0203 0202 0026 0028 0040 0032 0030 0042 0034 0022 0036 A030 0038'.split())

def piso(s):
    s = s.replace('Z', '+00:00'); d = datetime.fromisoformat(s)
    return d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d
def T(d): return d.astimezone(LON).strftime('%H:%M:%S') if d else '--:--:--'
def L(t): return datetime.fromtimestamp(t, LON).strftime('%H:%M:%S')

live, first_t, last_t = {}, None, None
for line in open(f'{OUT}/live.jsonl'):
    try: rec = json.loads(line)
    except Exception: continue
    first_t = first_t or rec['t']; last_t = rec['t']
    for t in (rec.get('live') or {}).get('trains', []):
        hc = t.get('headcode')
        if not hc: continue
        r = live.setdefault(hc, {'dirs': set(), 'berths': set(), 'strikes': {},
                                 'origin': None, 'dest': None, 'first': rec['t']})
        if t.get('direction'): r['dirs'].add(t['direction'])
        if t.get('berth'): r['berths'].add(t['berth'])
        if t.get('origin'): r['origin'] = t['origin']
        if t.get('destination'): r['dest'] = t['destination']
        for h in t.get('history', []):
            b, ts = h.get('berth'), h.get('ts')
            if b and ts and (b not in r['strikes'] or ts < r['strikes'][b]): r['strikes'][b] = ts

app = {}
for line in open(f'{OUT}/main.jsonl'):
    try: rec = json.loads(line)
    except Exception: continue
    for c in (rec.get('main') or {}).get('upcomingClosures') or []:
        for t in c.get('trains', []):
            hc = t.get('headcode')
            if hc: app.setdefault(hc, {'first': rec['t'], 'src': set()})['src'].add(t.get('source'))

def roles(hc):
    d = next((x for x in live[hc]['dirs'] if x in ('east', 'west')), None)
    got = {}
    for b, ts in live[hc]['strikes'].items():
        if b in XING:
            bd, role = XING[b]
            if d is None or bd == d: got[role] = piso(ts)
    return got, d

print('=' * 112)
print(f'GROUND TRUTH  window {L(first_t)}-{L(last_t)}   feed trains={len(live)}  app trains={len(app)}')
print('=' * 112)

crossed = [(hc, *roles(hc)) for hc in live if roles(hc)[0]]
crossed.sort(key=lambda x: min(x[1].values()))
print(f"\n1. COVERAGE — trains that physically struck a crossing berth\n{'-'*112}")
print(f"{'HC':6}{'dir':6}{'approach':10}{'clear':10}{'in app?':10}{'warning':10} route")
missed = []
for hc, r, d in crossed:
    xt = r.get('clear') or r.get('protecting') or r.get('approach')
    if hc in app:
        ft = app[hc]['first']
        warn = (f'{(xt.timestamp()-ft)/60:.0f}m' if ft > first_t
                else f'>={(xt.timestamp()-first_t)/60:.0f}m')
        tag = 'YES'
    else:
        warn, tag = '-', '*** NO ***'; missed.append(hc)
    print(f"{hc:6}{str(d):6}{T(r.get('approach')):10}{T(r.get('clear')):10}{tag:10}{warn:10} "
          f"{live[hc]['origin'] or '?'} -> {live[hc]['dest'] or '?'}")
print(f"\n  {len(crossed)} crossed; {len(missed)} MISSING from the app: {missed or 'none'}")

print(f"\n2. IN THE OBSERVER FEED BUT NOT IN THE APP\n{'-'*112}")
print(f"{'HC':6}{'dir':9}{'onRoute':11}{'berths seen':38} route")
onroute = []
for hc in sorted(set(live) - set(app)):
    r = live[hc]
    on = bool((r['berths'] | set(r['strikes'])) & ROUTE)
    if on: onroute.append(hc)
    print(f"{hc:6}{(','.join(sorted(r['dirs'])) or '(none)'):9}{('*** YES ***' if on else 'no'):11}"
          f"{','.join(sorted(r['berths'])[:5]):38} {r['origin'] or '?'} -> {r['dest'] or '?'}")
print(f"\n  >>> on a Portslade-route berth but MISSING from the app: {onroute or 'NONE'}")

print(f"\n3. DIRECTION JOIN QUALITY on route trains\n{'-'*112}")
bad = [hc for hc, r in live.items()
       if ((r['berths'] | set(r['strikes'])) & ROUTE) and not (r['dirs'] & {'east', 'west'})]
print(f"  route trains with no usable direction: {len(bad)} {bad}")

print(f"\n4. FALSE ALARMS — closure windows that passed with no strike\n{'-'*112}")
seen, fa = {}, 0
for line in open(f'{OUT}/main.jsonl'):
    try: rec = json.loads(line)
    except Exception: continue
    for c in (rec.get('main') or {}).get('upcomingClosures') or []:
        seen[tuple(sorted(t.get('headcode', '?') for t in c['trains']))] = c
endw = datetime.fromtimestamp(last_t, timezone.utc)
startw = datetime.fromtimestamp(first_t, timezone.utc)
for key, c in sorted(seen.items(), key=lambda kv: kv[1]['end']):
    e = piso(c['end'])
    if not (startw < e < endw): continue
    if not any(hc in live and roles(hc)[0] for hc in key):
        fa += 1
        print(f"  {'+'.join(key):18} {T(piso(c['start']))}-{T(e)}  {c['reason']}  -> no train struck")
print(f"  false alarms: {fa}")

# berth transit distribution — feeds anchor calibration
print(f"\n5. BERTH TRANSIT (approach -> clear), the class signal\n{'-'*112}")
for hc, r, d in crossed:
    a, c = r.get('approach'), r.get('clear')
    if a and c: print(f"  {hc:6}{str(d):6} {T(a)} -> {T(c)} = {(c-a).total_seconds():.0f}s")
