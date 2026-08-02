#!/usr/bin/env python3
"""Ground truth from the RAW TD log, and the questions that depend on it.
   td-truth.py <OUTDIR>   -> prints a report, writes <OUTDIR>/truth.json

Why not the existing truth.py: that reads berth history out of the /live payload, which is
TTL-pruned and only as complete as the sampling. The raw JSONL on this box is the feed
itself — every CA/CB event, no pruning, no sampling gaps. On a 9-hour window that difference
is the whole ballgame.

Scores closes against the rule the backend ACTUALLY used for that train's class, read from
triggers.json, not a guessed anchor. SKILL.md warns that guessing produced fake "+67s late"
deltas that then needed explaining away; /triggers and the trainClass field on /live now make
guessing unnecessary.
"""
import json, sys, os, glob, statistics
from datetime import datetime, timezone, timedelta

OUT = sys.argv[1] if len(sys.argv) > 1 else sys.exit('usage: td-truth.py <OUTDIR>')
LON = timezone(timedelta(hours=1))          # BST
TD_DIR = os.path.expanduser('~/rail-crossing/backend/data/logs/td')

XING = {'0006': ('east', 'approach'), '0004': ('east', 'protecting'), '0002': ('east', 'clear'),
        '0003': ('west', 'approach'), '0005': ('west', 'protecting'), '0007': ('west', 'clear')}

def piso(s):
    if not s: return None
    s = s.replace('Z', '+00:00')
    d = datetime.fromisoformat(s)
    return d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d
def T(d): return d.astimezone(LON).strftime('%H:%M:%S') if d else '--:--:--'
def L(t): return datetime.fromtimestamp(t, LON).strftime('%H:%M:%S')
def med(v): return round(statistics.median(v), 1) if v else None

meta = json.load(open(f'{OUT}/meta.json'))
main = [json.loads(l) for l in open(f'{OUT}/main.jsonl') if l.strip()]
live = [json.loads(l) for l in open(f'{OUT}/live.jsonl') if l.strip()] if os.path.exists(f'{OUT}/live.jsonl') else []
trig = json.load(open(f'{OUT}/triggers.json')) if os.path.exists(f'{OUT}/triggers.json') else {}
if not main: sys.exit('no main.jsonl samples')
t0, t1 = main[0]['t'], main[-1]['t']
w0 = datetime.fromtimestamp(t0, timezone.utc)
w1 = datetime.fromtimestamp(t1, timezone.utc)

# --- TD log, stitched across the 22:59Z rotation -----------------------------------------
# SKILL.md: "TD logs rotate at 23:00Z — stitch consecutive days, or a strike at 22:59 looks
# missing. This alone inflates the apparent missed-strike rate 4x."
strikes = {}          # headcode -> {berth: first ts}
allev = {}            # headcode -> [(ts, from, to)]
files = sorted(glob.glob(f'{TD_DIR}/td-*.jsonl'))
pad0, pad1 = w0 - timedelta(hours=3), w1 + timedelta(hours=3)
nlines = 0
for fp in files:
    day = os.path.basename(fp)[3:13]
    try: d = datetime.strptime(day, '%Y-%m-%d').replace(tzinfo=timezone.utc)
    except ValueError: continue
    if not (pad0 - timedelta(days=1) <= d <= pad1 + timedelta(days=1)): continue
    for line in open(fp):
        if not line.strip(): continue
        try: o = json.loads(line)
        except Exception: continue
        ts = piso(o.get('ts'))
        if not ts or not (pad0 <= ts <= pad1): continue
        nlines += 1
        hc, to = o.get('desc'), o.get('to')
        if not hc: continue
        allev.setdefault(hc, []).append((ts, o.get('from'), to))
        if to and (to not in strikes.setdefault(hc, {}) or ts < strikes[hc][to]):
            strikes[hc][to] = ts

# --- what physically crossed --------------------------------------------------------------
def crossing_of(hc):
    s = strikes.get(hc) or {}
    out = {}
    for berth, ts in s.items():
        if berth in XING:
            d, role = XING[berth]
            out.setdefault(d, {})[role] = ts
    # a direction is a real traversal if it struck at least the approach or the clear berth
    best = None
    for d, roles in out.items():
        score = len(roles)
        if best is None or score > best[1]: best = (d, score, roles)
    return (best[0], best[2]) if best else (None, None)

crossed = []
for hc in strikes:
    d, roles = crossing_of(hc)
    if not roles: continue
    ref = roles.get('approach') or roles.get('protecting') or roles.get('clear')
    if not (w0 <= ref <= w1): continue          # only trains inside the recorded window
    crossed.append({'hc': hc, 'dir': d, **{k: v for k, v in roles.items()}})
crossed.sort(key=lambda x: x.get('approach') or x.get('clear'))

# --- what the app said ---------------------------------------------------------------------
app_first = {}        # headcode -> earliest sample time it appeared in a closure
app_meta = {}
for rec in main:
    for c in (rec['main'].get('upcomingClosures') or []):
        for t in c.get('trains', []):
            hc = t.get('headcode')
            if not hc: continue
            if hc not in app_first: app_first[hc] = rec['t']
            m = app_meta.setdefault(hc, {'source': set(), 'type': set(), 'dir': set(), 'tdSeen': False})
            m['source'].add(t.get('source')); m['type'].add(t.get('trainType')); m['dir'].add(t.get('direction'))
            if t.get('tdSeen'): m['tdSeen'] = True

# class discriminator, straight off /live (ea64c09 exposes it; no need to infer from dwell)
klass = {}
for rec in live:
    for t in (rec['live'].get('trains') or []):
        hc = t.get('headcode')
        if hc and t.get('trainClass'): klass[hc] = t['trainClass']

R = {'window': {'from': L(t0), 'to': L(t1), 'mins': round((t1 - t0) / 60, 1)},
     'backendHead': meta.get('backendHead', '')[:7], 'restartSuspected': meta.get('restartSuspected'),
     'tdLines': nlines, 'samples': len(main)}

print('=' * 104)
print(f"GROUND TRUTH (raw TD)  {L(t0)}-{L(t1)}  samples={len(main)}  td events={nlines}  crossings={len(crossed)}")
print('=' * 104)

# --- 1. coverage ---------------------------------------------------------------------------
print(f"\n1. COVERAGE — every train that struck a crossing berth must have had a closure FIRST\n{'-'*104}")
print(f"{'HC':7}{'dir':6}{'class':14}{'approach':10}{'clear':10}{'in app?':10}{'lead':9}")
missed, late, leads = [], [], []
for c in crossed:
    hc = c['hc']
    ref = c.get('approach') or c.get('protecting') or c.get('clear')
    if hc in app_first:
        lead = ref.timestamp() - app_first[hc]
        tag, ld = 'YES', (f'{lead/60:.0f}m' if app_first[hc] > t0 else f'>={(ref.timestamp()-t0)/60:.0f}m')
        leads.append(lead)
        if app_first[hc] > t0 and lead < 0: late.append(hc)      # appeared only AFTER it arrived
    else:
        tag, ld = '*** NO ***', '-'; missed.append(hc)
    print(f"{hc:7}{str(c['dir']):6}{klass.get(hc,'?'):14}{T(c.get('approach')):10}{T(c.get('clear')):10}{tag:10}{ld:9}")
print(f"\n  {len(crossed)} crossed; MISSING from the app: {len(missed)} {missed or 'none'}")
print(f"  appeared only AFTER arriving (retrospective, useless to a user): {len(late)} {late or 'none'}")
R['coverage'] = {'crossed': len(crossed), 'missing': missed, 'retrospective': late,
                 'medianLeadSecs': med(leads)}

# --- 2. false alarms -----------------------------------------------------------------------
print(f"\n2. FALSE ALARMS — a closure ran its course with no train striking a berth\n{'-'*104}")
seen = {}
for rec in main:
    for c in (rec['main'].get('upcomingClosures') or []):
        seen[tuple(sorted(t.get('headcode', '?') for t in c.get('trains', [])))] = c
fa = []
for key, c in sorted(seen.items(), key=lambda kv: kv[1].get('end') or ''):
    e = piso(c.get('end'))
    if not e or not (w0 < e < w1): continue
    if not any(hc in strikes and crossing_of(hc)[1] for hc in key):
        fa.append({'trains': list(key), 'start': T(piso(c.get('start'))), 'end': T(e), 'reason': c.get('reason')})
        print(f"  {'+'.join(key):18} {T(piso(c.get('start')))}-{T(e)}  {c.get('reason')}  -> no strike")
print(f"  false alarms: {len(fa)}")
R['falseAlarms'] = fa

# --- 3. close accuracy, scored against the rule the backend actually used -------------------
print(f"\n3. CLOSE ACCURACY — predicted close vs the train's own approach strike\n{'-'*104}")
rules = {}
for r in (trig.get('close') or []):
    rules[(r.get('direction'), r.get('trainClass'))] = r
final_close = {}     # headcode -> last predictedStart/start the app served before the strike
for rec in main:
    for c in (rec['main'].get('upcomingClosures') or []):
        for t in c.get('trains', []):
            hc = t.get('headcode')
            if hc: final_close.setdefault(hc, []).append((rec['t'], c.get('predictedStart'), c.get('start'), c.get('closeConfirmed'), c.get('closePending')))
close_rows = []
print(f"{'HC':7}{'dir':6}{'class':14}{'rule':22}{'predClose':11}{'approach':10}{'err':8}")
for c in crossed:
    hc, d = c['hc'], c['dir']
    ap = c.get('approach')
    if not ap or hc not in final_close: continue
    # the last prediction made BEFORE the train struck its approach berth
    pre = [x for x in final_close[hc] if x[0] < ap.timestamp()]
    if not pre: continue
    _, ps, st, conf, pend = pre[-1]
    pd = piso(ps or st)
    if not pd: continue
    k = klass.get(hc)
    rule = rules.get((d, k)) or rules.get((d, None))
    rname = f"{d}/{k or '?'}"
    if rule: rname += f" {rule.get('berth')}+{rule.get('offsetSecs')}"
    err = (pd - ap).total_seconds()
    close_rows.append({'hc': hc, 'dir': d, 'class': k, 'rule': rname, 'errSecs': round(err),
                       'confirmed': bool(conf), 'pending': bool(pend)})
    print(f"{hc:7}{d:6}{str(k):14}{rname:22}{T(pd):11}{T(ap):10}{err:+8.0f}")
for d in ('east', 'west'):
    v = [r['errSecs'] for r in close_rows if r['dir'] == d]
    if v: print(f"  {d}: n={len(v)} median={med(v)}s  spread={min(v):+.0f}..{max(v):+.0f}s")
R['closeAccuracy'] = close_rows

# --- 4. open accuracy ----------------------------------------------------------------------
print(f"\n4. OPEN ACCURACY — served end vs the train's own clear strike\n{'-'*104}")
final_end = {}
for rec in main:
    for c in (rec['main'].get('upcomingClosures') or []):
        for t in c.get('trains', []):
            hc = t.get('headcode')
            if hc: final_end[hc] = (c.get('end'), c.get('holdingOpen'), len(c.get('trains', [])))
open_rows = []
for c in crossed:
    hc = c['hc']; cl = c.get('clear')
    if not cl or hc not in final_end: continue
    end, hold, n = final_end[hc]
    e = piso(end)
    if not e: continue
    # per-train open scoring is meaningless for a non-final train in a merged group
    if n > 1: continue
    err = (e - cl).total_seconds()
    open_rows.append({'hc': hc, 'dir': c['dir'], 'errSecs': round(err), 'holding': bool(hold)})
    print(f"  {hc:7}{c['dir']:6} end={T(e)} clear={T(cl)} err={err:+.0f}s{'  (holdingOpen)' if hold else ''}")
for d in ('east', 'west'):
    v = [r['errSecs'] for r in open_rows if r['dir'] == d]
    if v: print(f"  {d}: n={len(v)} median={med(v)}s")
R['openAccuracy'] = open_rows

# --- 5. transits — the class signal, and the input to register #11 -------------------------
print(f"\n5. BERTH TRANSIT approach->clear (feeds the close-rule calibration)\n{'-'*104}")
tr = {}
for c in crossed:
    a, cl = c.get('approach'), c.get('clear')
    if a and cl:
        secs = (cl - a).total_seconds()
        tr.setdefault((c['dir'], klass.get(c['hc'], '?')), []).append(secs)
        print(f"  {c['hc']:7}{c['dir']:6}{klass.get(c['hc'],'?'):14}{T(a)} -> {T(cl)} = {secs:.0f}s")
R['transits'] = {f'{d}/{k}': {'n': len(v), 'median': med(v), 'min': round(min(v)), 'max': round(max(v))}
                 for (d, k), v in sorted(tr.items())}
for key, v in R['transits'].items(): print(f"  {key:22} n={v['n']:3} median={v['median']}s  range {v['min']}-{v['max']}s")

# --- 6. register #16 — the consecutive-pair gap the merge threshold acts on ----------------
print(f"\n6. REGISTER #16 — gap between one train clearing and the next train's close anchor\n{'-'*104}")
print("   (mergeOppositeMaxGapSecs=20 is the only config value with no provenance. This is the")
print("    distribution it thresholds. Without barrier observations we get the gaps, not 'did it lift'.)")
ev = sorted(((c.get('clear') or c.get('protecting'), c) for c in crossed if c.get('clear') or c.get('protecting')))
gaps = []
for i in range(1, len(ev)):
    prev_clear, pc = ev[i - 1]
    cur = ev[i][1]
    nxt = cur.get('approach')
    if not nxt: continue
    g = (nxt - prev_clear).total_seconds()
    if 0 <= g <= 900:
        gaps.append({'first': pc['hc'], 'second': cur['hc'], 'gapSecs': round(g),
                     'sameDir': pc['dir'] == cur['dir']})
        flag = '  <<< inside the 20s merge window' if g <= 20 else ('  <-- near threshold' if g <= 60 else '')
        print(f"  {pc['hc']} clear {T(prev_clear)} -> {cur['hc']} approach {T(nxt)} = {g:5.0f}s"
              f"{' same-dir' if pc['dir']==cur['dir'] else ' opposite'}{flag}")
R['pairGaps'] = gaps
if gaps:
    gv = [g['gapSecs'] for g in gaps]
    print(f"  n={len(gv)} median={med(gv)}s  <=20s: {sum(1 for x in gv if x<=20)}  <=60s: {sum(1 for x in gv if x<=60)}")

json.dump(R, open(f'{OUT}/truth.json', 'w'), indent=1)
print(f"\nwrote {OUT}/truth.json")
