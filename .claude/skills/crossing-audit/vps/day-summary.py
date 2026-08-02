#!/usr/bin/env python3
"""Merge the day's blocks into one file to read.
   day-summary.py [YYYY-MM-DD] -> ~/audit/runs/<day>/DAY-SUMMARY.json (+ .md)

Register verdicts are combined across blocks with the worst-case rule: one 'recurring' in any
block makes the entry recurring for the day, and 'latent' everywhere means the condition never
arose all day — which is a genuinely different statement from 'fixed' and must not collapse
into it.
"""
import json, os, sys, glob
from datetime import datetime

DAY = sys.argv[1] if len(sys.argv) > 1 else datetime.utcnow().strftime('%Y-%m-%d')
ROOT = os.path.expanduser(f'~/audit/runs/{DAY}')
J = lambda p: json.load(open(p)) if os.path.exists(p) else None
LINES = lambda p: [json.loads(l) for l in open(p) if l.strip()] if os.path.exists(p) else []

blocks = {}
for d in sorted(glob.glob(f'{ROOT}/*/summary.json')):
    label = os.path.basename(os.path.dirname(d))
    blocks[label] = J(d)
if not blocks: sys.exit(f'no block summaries under {ROOT}')

RANK = {'recurring': 3, 'n/a': 2, 'latent': 1, 'fixed': 0}
combined, per_block = {}, {}
for label, s in blocks.items():
    for k, v in (s.get('register') or {}).items():
        per_block.setdefault(k, {})[label] = v['verdict']
        cur = combined.get(k)
        if cur is None or RANK[v['verdict']] > RANK[cur['verdict']]:
            combined[k] = {'title': v['title'], 'verdict': v['verdict'], 'detail': v['detail'],
                           'examples': v['examples'], 'worstBlock': label}
for k in combined: combined[k]['byBlock'] = per_block[k]

def agg(path, default=0):
    out = 0
    for s in blocks.values():
        v = s
        for p in path.split('.'):
            v = (v or {}).get(p) if isinstance(v, dict) else None
        out += (len(v) if isinstance(v, list) else (v or 0))
    return out

probe = LINES(f'{ROOT}/probe/main.jsonl')
D = {
    'day': DAY,
    'blocks': {k: {'window': v.get('window'), 'deployed': v.get('deployed')} for k, v in blocks.items()},
    'totals': {
        'samples': sum((b.get('window') or {}).get('samples') or 0 for b in blocks.values()),
        'recorderErrors': sum((b.get('window') or {}).get('recorderErrors') or 0 for b in blocks.values()),
        'trainsCrossed': sum(((b.get('coverage') or {}).get('crossed') or 0) for b in blocks.values()),
        'missingFromApp': [h for b in blocks.values() for h in ((b.get('coverage') or {}).get('missing') or [])],
        'retrospective': [h for b in blocks.values() for h in ((b.get('coverage') or {}).get('retrospective') or [])],
        'falseAlarms': agg('falseAlarms'),
        'uxCaptures': agg('ux.captures'),
        'uxWithProblems': agg('ux.withProblems'),
        'parityDisagreements': agg('ux.parityDisagreements'),
        'probeSamples': len(probe),
    },
    'register': combined,
    'closeAccuracy': [r for b in blocks.values() for r in (b.get('closeAccuracy') or [])],
    'openAccuracy': [r for b in blocks.values() for r in (b.get('openAccuracy') or [])],
    'transitsByBlock': {k: v.get('transits') for k, v in blocks.items()},
    'infraByBlock': {k: v.get('infra') for k, v in blocks.items()},
    'faultsByBlock': {k: v.get('faults') for k, v in blocks.items()},
    'uxProblems': [p for b in blocks.values() for p in ((b.get('ux') or {}).get('problems') or [])][:30],
    'parity': [p for b in blocks.values() for p in ((b.get('ux') or {}).get('parityDisagreements') or [])][:20],
}

# register #11: how many samples each close rule finally has
rules = {}
for r in D['closeAccuracy']: rules[r.get('rule')] = rules.get(r.get('rule'), 0) + 1
D['closeRuleSampleCounts'] = rules

json.dump(D, open(f'{ROOT}/DAY-SUMMARY.json', 'w'), indent=1)

recur = [k for k, v in combined.items() if v['verdict'] == 'recurring']
lat = [k for k, v in combined.items() if v['verdict'] == 'latent']
md = [f'# Audit day {DAY}', '',
      f"blocks: {', '.join(blocks)}", f"totals: {json.dumps(D['totals'])}", '',
      f"## RECURRING ({len(recur)})"] + \
     [f"- **{k}** {combined[k]['title']} — {combined[k]['detail']} (worst: {combined[k]['worstBlock']}; by block: {combined[k]['byBlock']})" for k in recur] + \
     ['', f"## Latent — condition never arose, says nothing ({len(lat)})"] + \
     [f"- {k}: {combined[k]['title']}" for k in lat] + \
     ['', '## Close rule sample counts (register #11)', json.dumps(rules, indent=1)]
open(f'{ROOT}/DAY-SUMMARY.md', 'w').write('\n'.join(md) + '\n')
print('\n'.join(md))
print(f"\nwrote {ROOT}/DAY-SUMMARY.json ({os.path.getsize(f'{ROOT}/DAY-SUMMARY.json')} bytes)")
