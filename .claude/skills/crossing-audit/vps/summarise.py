#!/usr/bin/env python3
"""Collapse a block to something a model can read in one go.
   summarise.py <OUTDIR> -> <OUTDIR>/summary.json  (+ summary.md)

This is the token-efficiency mechanism. Nine hours of 5-second samples is ~6,500 payloads;
this reduces a block to a few KB of counts, verdicts and capped examples, and leaves every
raw artefact on disk so any drill-down can be fetched on demand rather than up front.
"""
import json, os, sys, glob
from datetime import datetime

OUT = sys.argv[1] if len(sys.argv) > 1 else sys.exit('usage: summarise.py <OUTDIR>')
J = lambda p: json.load(open(p)) if os.path.exists(p) else None
LINES = lambda p: [json.loads(l) for l in open(p) if l.strip()] if os.path.exists(p) else []

meta = J(f'{OUT}/meta.json') or {}
truth = J(f'{OUT}/truth.json') or {}
reg = J(f'{OUT}/regress.json') or {}
faults = J(f'{OUT}/faults.json') or {}
anom = LINES(f'{OUT}/anomalies.jsonl')

S = {
    'block': meta.get('label'),
    'window': {'from': meta.get('startedAt'), 'to': meta.get('finishedAt'),
               'samples': meta.get('samples'), 'recorderErrors': meta.get('errors')},
    'deployed': {'backend': (meta.get('backendHead') or '')[:7],
                 'frontend': {k: v.get('sha256') for k, v in (meta.get('frontend') or {}).items()},
                 'restartSuspected': meta.get('restartSuspected')},
    'coverage': truth.get('coverage'),
    'falseAlarms': truth.get('falseAlarms'),
    'transits': truth.get('transits'),
    'closeAccuracy': truth.get('closeAccuracy'),
    'openAccuracy': truth.get('openAccuracy'),
    'pairGaps': {'n': len(truth.get('pairGaps') or []),
                 'within20s': sum(1 for g in (truth.get('pairGaps') or []) if g['gapSecs'] <= 20),
                 'within60s': sum(1 for g in (truth.get('pairGaps') or []) if g['gapSecs'] <= 60),
                 'examples': (truth.get('pairGaps') or [])[:10]},
    'register': reg.get('entries'),
    'infra': reg.get('infra'),
    'faults': faults.get('summary'),
    'inlineAnomalies': {},
}
for a in anom:
    for k in a.get('an', []): S['inlineAnomalies'][k] = S['inlineAnomalies'].get(k, 0) + 1

# ------------------------------------------------------------------ UX captures + parity
caps, problems, parity = [], [], []
for cj in sorted(glob.glob(f'{OUT}/ux/*/capture.json')):
    c = J(cj)
    if not c: continue
    byname = {t['name']: t for t in c.get('targets', [])}
    row = {'tag': c.get('tag'), 'reason': c.get('reason'), 'problems': []}
    for t in c.get('targets', []):
        if t.get('fatal'): row['problems'].append(f"{t['name']}:fatal={t['fatal'][:80]}")
        if t.get('rendered') is False: row['problems'].append(f"{t['name']}:did-not-render")
        if t.get('viewportOk') is False:
            row['problems'].append(f"{t['name']}:VIEWPORT-OVERRIDE-FAILED(vw={t.get('probe',{}).get('vw')})")
        elif t.get('overflow'): row['problems'].append(
            f"{t['name']}:overflow scrollW={t.get('probe',{}).get('scrollW')} vw={t.get('probe',{}).get('vw')}")
        if t.get('errors'): row['problems'].append(f"{t['name']}:jserr={t['errors'][:2]}")
        if t.get('http'): row['problems'].append(f"{t['name']}:http={t['http'][:2]}")
        if t.get('failed'): row['problems'].append(f"{t['name']}:reqfail={t['failed'][:2]}")
    # service worker: the observer's network-first fix is only observable in a real browser
    ob = byname.get('observer', {})
    row['sw'] = (ob.get('probe') or {}).get('sw')
    if row['sw'] and row['sw'].get('waiting'):
        row['problems'].append('observer:SW-WAITING (page may have executed stale code)')

    # public app vs observer must not disagree about the same crossing at the same moment.
    pub, obs = byname.get('public-mobile'), byname.get('observer')
    if pub and obs and pub.get('probe') and obs.get('probe'):
        gap = abs((obs.get('capturedAt') or 0) - (pub.get('capturedAt') or 0)) / 1000.0
        pt, ot = pub['probe']['text'], obs['probe']['text']
        d = []
        # time-invariant fields must match exactly; countdowns are excluded because the two
        # captures are seconds apart and would disagree for that reason alone.
        for a, b, name in (('statusTitle', 'predState', 'state'),
                           ('closureLength', 'predDown', 'downFor'),
                           ('closureLengthSub', 'predDownRange', 'downForRange'),
                           ('nextCloseTime', 'predCloseAt', 'closeAt'),
                           ('nextOpenTime', 'predOpenAt', 'openAt')):
            if pt.get(a) is not None and ot.get(b) is not None and pt[a] != ot[b]:
                d.append({'field': name, 'public': pt[a], 'observer': ot[b]})
        if d:
            parity.append({'tag': c.get('tag'), 'captureGapSecs': round(gap, 1), 'diffs': d})
            row['problems'].append(f'PARITY:{len(d)} field(s) differ')
    if row['problems']: problems.append(row)
    caps.append(row)

S['ux'] = {'captures': len(caps), 'withProblems': len(problems), 'problems': problems[:15],
           'parityDisagreements': parity[:10]}

os.makedirs(f'{OUT}', exist_ok=True)
json.dump(S, open(f'{OUT}/summary.json', 'w'), indent=1)

# ------------------------------------------------------------------------ human-readable
rec = [k for k, v in (S['register'] or {}).items() if v['verdict'] == 'recurring']
lat = [k for k, v in (S['register'] or {}).items() if v['verdict'] == 'latent']
md = [f"# Block {S['block']}  {S['window']['from']} -> {S['window']['to']}", '',
      f"samples={S['window']['samples']} recorderErrors={S['window']['recorderErrors']} "
      f"backend={S['deployed']['backend']} restart={S['deployed']['restartSuspected']}", '',
      f"**RECURRING: {rec or 'none'}**", f"latent (condition never arose): {lat or 'none'}", '',
      f"coverage: {json.dumps(S['coverage'])}", f"false alarms: {len(S['falseAlarms'] or [])}",
      f"inline anomalies: {json.dumps(S['inlineAnomalies'])}",
      f"ux: {S['ux']['captures']} captures, {S['ux']['withProblems']} with problems, "
      f"{len(S['ux']['parityDisagreements'])} parity disagreements",
      f"faults: {json.dumps(S['faults'])}", f"infra: {json.dumps(S['infra'])}"]
open(f'{OUT}/summary.md', 'w').write('\n'.join(md) + '\n')

print('\n'.join(md))
print(f"\nwrote {OUT}/summary.json ({os.path.getsize(f'{OUT}/summary.json')} bytes)")
