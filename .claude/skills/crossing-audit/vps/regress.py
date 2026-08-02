#!/usr/bin/env python3
"""Per-entry regression signatures for KNOWN-ISSUES.md.
   regress.py <OUTDIR>   -> prints a report, writes <OUTDIR>/regress.json

The existing `detect.py --regress` only PRINTS the register. This actually tests it.

Every entry gets one of four verdicts, and the distinction matters:
  fixed     - the condition arose and the bug did not
  recurring - the bug reproduced
  latent    - the condition never arose, so this window says nothing
  n/a       - not testable from a recording (needs a human at the crossing)
"Didn't trigger" is not "fixed" - that is exactly the mistake the register warns about.

Priority targets are C14/C15/C16: deployed in 2d8ca15 but, per the register, reproduced only
against fixtures and "NOT observed in the field". This is their first live window.
"""
import json, sys, os, re, statistics
from datetime import datetime, timezone, timedelta

OUT = sys.argv[1] if len(sys.argv) > 1 else sys.exit('usage: regress.py <OUTDIR>')
LON = timezone(timedelta(hours=1))
J = lambda p: json.load(open(p)) if os.path.exists(p) else None
LINES = lambda p: [json.loads(l) for l in open(p) if l.strip()] if os.path.exists(p) else []

main = LINES(f'{OUT}/main.jsonl')
live = LINES(f'{OUT}/live.jsonl')
health = LINES(f'{OUT}/health.jsonl')
public = LINES(f'{OUT}/public.jsonl')
errors = LINES(f'{OUT}/errors.jsonl')
rep = J(f'{OUT}/replay.json') or []
truth = J(f'{OUT}/truth.json') or {}
trig = J(f'{OUT}/triggers.json') or {}
if not main: sys.exit('no main.jsonl')

def piso(s):
    if not s: return None
    s = s.replace('Z', '+00:00'); d = datetime.fromisoformat(s)
    return d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d
def L(t): return datetime.fromtimestamp(t, LON).strftime('%H:%M:%S')
def med(v): return round(statistics.median(v), 1) if v else None
def pct(v, p): return round(sorted(v)[min(len(v) - 1, int(len(v) * p / 100))], 1) if v else None

# strike times per headcode, rebuilt from truth.json's crossings
STRIKE = {}
for k in ('closeAccuracy',):
    pass
# truth.json keeps only summaries; re-read the raw TD for exact per-berth strikes
import glob
TD_DIR = os.path.expanduser('~/rail-crossing/backend/data/logs/td')
t0, t1 = main[0]['t'], main[-1]['t']
w0 = datetime.fromtimestamp(t0, timezone.utc) - timedelta(hours=3)
w1 = datetime.fromtimestamp(t1, timezone.utc) + timedelta(hours=3)
for fp in sorted(glob.glob(f'{TD_DIR}/td-*.jsonl')):
    for line in open(fp):
        if not line.strip(): continue
        try: o = json.loads(line)
        except Exception: continue
        ts = piso(o.get('ts'))
        if not ts or not (w0 <= ts <= w1): continue
        hc, to = o.get('desc'), o.get('to')
        if hc and to:
            d = STRIKE.setdefault(hc, {})
            if to not in d or ts < d[to]: d[to] = ts
APPROACH = {'east': '0006', 'west': '0003'}
CLEAR = {'east': '0002', 'west': '0007'}

byt = {r['t']: r for r in rep}
V = {}          # entry -> verdict record
def verdict(key, title, status, detail, examples=None):
    V[key] = {'title': title, 'verdict': status, 'detail': detail, 'examples': (examples or [])[:5]}
    mark = {'recurring': 'RECURRING  <<<', 'fixed': 'fixed', 'latent': 'latent', 'n/a': 'n/a'}[status]
    print(f"  {key:6} {mark:16} {title[:62]:64} {detail}")

print('=' * 118)
print(f"REGRESSION REGISTER  window {L(t0)}-{L(t1)}  samples={len(main)} replay={len(rep)}")
print('=' * 118)

# ---------------------------------------------------------------- C1 grouping oscillation
seq = {}
for rec in main:
    for c in (rec['main'].get('upcomingClosures') or []):
        key = tuple(sorted(t.get('headcode', '?') for t in c.get('trains', [])))
        st = piso(c.get('start'))
        lead = (st.timestamp() - rec['t']) / 60.0 if st else None
        for hc in key: seq.setdefault(hc, []).append((key, lead))
osc = []
for hc, g in seq.items():
    flips = [i for i in range(1, len(g)) if (len(g[i][0]) > 1) != (len(g[i - 1][0]) > 1)]
    if len(flips) >= 2:
        # How far ahead was the closure when it flip-flopped? Oscillation 90 minutes out is
        # cosmetic; the same oscillation five minutes out is a barrier time moving under a
        # user who is standing at the crossing. The register's "alternating is the pathology"
        # still holds, but severity is not flat across lead time.
        lead_at = [g[i][1] for i in flips if g[i][1] is not None]
        osc.append({'hc': hc, 'transitions': len(flips), 'samples': len(g),
                    'medianLeadMins': med(lead_at), 'minLeadMins': round(min(lead_at), 1) if lead_at else None})
near = [o for o in osc if (o['minLeadMins'] or 999) <= 10]
verdict('C1', 'grouping flip-flops merged<->split', 'recurring' if osc else ('fixed' if seq else 'latent'),
        f'{len(osc)} train(s) oscillating 2+ times across {len(seq)} tracked; {len(near)} within 10 min of the closure', osc)

# ------------------------------------------------- C3/C14b premature CLOSED while upstream
# The close anchor is PER CLASS: east stopping fires at 0008, east stoppingLocal at 0006.
# Scoring every east train against 0006 flagged a train sitting legitimately at 0010 as a
# premature CLOSED — a false positive on the rehearsal data. Read the real rule instead.
CHAIN = {'east': ['0016', '0014', '0012', '0010', '0008', '0006', '0004', '0002'],
         'west': ['T682', 'T677', '0001', '0003', '0005', '0007']}
ANCHOR = {}
for r in (trig.get('close') or []):
    ANCHOR[(r.get('direction'), r.get('trainClass'))] = r.get('berth')
klass = {}
for rec in live:
    for t in (rec['live'].get('trains') or []):
        if t.get('headcode') and t.get('trainClass'): klass[t['headcode']] = t['trainClass']

first_closed = {}
for rec in main:
    m = rec['main']
    if m.get('state') != 'CLOSED': continue
    for t in ((m.get('currentClosure') or {}).get('trains') or []):
        hc, d = t.get('headcode'), t.get('direction')
        if hc and d in CHAIN and hc not in first_closed: first_closed[hc] = (rec['t'], d)

prem, leads = [], []
for hc, (ts, d) in first_closed.items():
    s = STRIKE.get(hc) or {}
    onchain = [b for b in CHAIN[d] if b in s and s[b].timestamp() <= ts]
    anchor = ANCHOR.get((d, klass.get(hc)))
    ast = s.get(anchor) if anchor else None
    row = {'hc': hc, 'dir': d, 'class': klass.get(hc), 'anchor': anchor,
           'closedAt': L(ts), 'onChainWhenClosed': onchain[-1] if onchain else None,
           'leadToAnchorSecs': round(ast.timestamp() - ts) if ast else None}
    if ast: leads.append(row['leadToAnchorSecs'])
    # Genuinely premature: CLOSED while the train had not reached the approach chain at all.
    if not onchain: prem.append(row)
verdict('C3', 'premature CLOSED with the train demonstrably upstream',
        'recurring' if prem else ('fixed' if first_closed else 'latent'),
        f'{len(first_closed)} closure(s); {len(prem)} fired with the train not yet on the approach chain'
        + (f'; lead to its own anchor berth median {med(leads)}s max {max(leads)}s' if leads else ''), prem)
verdict('C14b', "a /live read deleted the CLOSED gate's own evidence",
        'recurring' if prem else ('fixed' if first_closed else 'latent'),
        f'/live polled every 5s all window, so the triggering condition was present; {len(prem)} offending closure(s)', prem)

# ---------------------------------------------------------- C4 self-consistency in one response
c4a = [L(r['t']) for r in main if r['main'].get('state') == 'CLOSED' and r['main'].get('currentClosure') is None]
UIMAP = {'BARRIERS DOWN': 'CLOSED', 'CLOSING SOON': 'CLOSING_SOON', 'CROSSING CLEAR': 'OPEN'}
pend_t = {rec['t'] for rec in main
          if any(c.get('closePending') or c.get('holdingOpen') for c in (rec['main'].get('upcomingClosures') or []))}
mism = [r for r in rep if UIMAP.get(r.get('uiTitle')) not in (None, r.get('backendState'))]
# Divergence WHILE a close is held is a consequence of the C14 design, not the C4 bug: the
# trigger has not fired, so the client declines to say CLOSING SOON. Scored separately —
# lumping them together would bury a real inconsistency under an intended one.
c4b = [r['time'] for r in mism if r.get('t') not in pend_t]
heldiv = [{'t': r['time'], 'backend': r.get('backendState'), 'ui': r.get('uiTitle')}
          for r in mism if r.get('t') in pend_t]
verdict('C4', 'state vs currentClosure vs list disagree in one response',
        'recurring' if (c4a or c4b) else 'fixed',
        f'CLOSED-with-null-currentClosure: {len(c4a)}; unexplained UI/backend state mismatch: {len(c4b)}/{len(rep)}',
        [{'closedNoCurrent': c4a[:5]}, {'uiMismatch': c4b[:5]}])
verdict('UX4', 'headline flips backwards (CLOSING SOON -> CROSSING CLEAR) when a close is held',
        'recurring' if heldiv else 'latent',
        f'{len(heldiv)} sample(s): backend still says CLOSING_SOON while the client says clear', heldiv)

# ------------------------------------------------------------ C5 start later than predictedStart
c5 = []
for rec in main:
    for c in (rec['main'].get('upcomingClosures') or []):
        ps, st = piso(c.get('predictedStart')), piso(c.get('start'))
        if ps and st and ps < st:
            d = (st - ps).total_seconds()
            trs = c.get('trains') or [{}]
            # A merged group can hold both directions; trains[0] is not necessarily the train
            # that set `start`. Only call it west when the whole group is west.
            dirs = {t.get('direction') for t in trs}
            grp = 'west' if dirs == {'west'} else ('east' if dirs == {'east'} else 'mixed')
            c5.append({'t': L(rec['t']), 'dir': grp, 'source': trs[0].get('source'),
                       'soonSecs': round(d), 'hc': '+'.join(sorted(t.get('headcode', '?') for t in trs))})
west5 = [x for x in c5 if x['dir'] == 'west']
verdict('C5', 'west: start later than its own predictedStart', 'recurring' if west5 else 'fixed',
        f'{len(west5)} west sample(s) (east is deliberate - confirmedMayFollowPredicted)', west5)

# ---------------------------------------------------- C6 strike-confirmed yet still banded
banded = []
for rec in main:
    r = byt.get(rec['t'])
    if not r: continue
    cs = rec['main'].get('upcomingClosures') or []
    if cs and cs[0].get('closeConfirmed') and '±' in (r.get('card1') or ''):
        banded.append({'t': L(rec['t']), 'card': (r.get('card1') or '')[:90]})
conf_any = any((c.get('closeConfirmed')) for rec in main for c in (rec['main'].get('upcomingClosures') or []))
verdict('C6', 'a strike-confirmed close still rendered a +/- band',
        'recurring' if banded else ('fixed' if conf_any else 'latent'),
        f'{len(banded)} sample(s); closeConfirmed ever seen: {conf_any}', banded)

# ------------------------------------------------------------------------ C8 "in now"
innow = [{'t': r['time'], 'card': (r.get('card1') or '')[:90]} for r in rep if 'in now' in (r.get('card1') or '')]
verdict('C8', '"in now" rendered on a closure pill', 'recurring' if innow else 'fixed',
        f'{len(innow)} sample(s)', innow)

# -------------------------------------------------- C11 pill and card round differently
def dsecs(s):
    """Parse a rendered duration to seconds. C11 is about the two places disagreeing on the
       VALUE; '5 mins' vs '5m' is the same value in two formats, which is a different (and
       much smaller) complaint. Comparing raw strings conflated them."""
    if not s: return None
    s = s.strip().lstrip('~').strip()
    m = re.match(r'^(?:(\d+)\s*m(?:in)?s?)?\s*(?:(\d+)\s*s)?$', s)
    if not m or not any(m.groups()): return None
    return int(m.group(1) or 0) * 60 + int(m.group(2) or 0)

c11, c11fmt = [], []
for r in rep:
    pill, card = (r.get('downFor') or '').strip(), (r.get('card1') or '')
    if not pill or r.get('uiTitle') != 'BARRIERS DOWN': continue
    m = re.search(r'Closed\s+([0-9a-z~\s]+?)\s*[·.]', card)
    if not m: continue
    cs = m.group(1).strip()
    a, b = dsecs(pill), dsecs(cs)
    if a is not None and b is not None and a != b:
        c11.append({'t': r['time'], 'pill': pill, 'card': cs, 'diffSecs': b - a})
    elif cs != pill:
        c11fmt.append({'t': r['time'], 'pill': pill, 'card': cs})
had_closed = any(r.get('uiTitle') == 'BARRIERS DOWN' for r in rep)
verdict('C11', 'pill and "Down For" card round the same duration differently',
        'recurring' if c11 else ('fixed' if had_closed else 'latent'),
        f'{len(c11)} value disagreement(s)', c11)
verdict('UX5', 'pill and card format the same duration differently ("5 mins" vs "5m")',
        'recurring' if c11fmt else ('fixed' if had_closed else 'latent'),
        f'{len(c11fmt)} sample(s) - same value, two spellings, side by side', c11fmt)

# ------------------------------------------- C12 countdowns running backwards (both of them)
def cd(s):
    if not s or s.strip() in ('--', 'Soon', 'NOW', ''): return None
    m = re.match(r'^(?:(\d+)m\s*)?(?:(\d+)s)?$', s.strip())
    return int(m.group(1) or 0) * 60 + int(m.group(2) or 0) if m and any(m.groups()) else None
# Keyed on the closure being counted down to. Without that, the countdown legitimately
# jumping when one closure completes and the NEXT becomes the target reads as a reversal —
# it produced a false positive on the rehearsal data (4s -> 203s at a handover).
pending_at = {rec['t']: any(c.get('closePending') for c in (rec['main'].get('upcomingClosures') or []))
              for rec in main}
# Identity is the TARGET TIME the countdown points at, not upcomingClosures[0].start. When
# one closure completes and the next becomes the target, the countdown legitimately jumps —
# keying on the list head scored that as a reversal (4s -> 203s on the rehearsal data).
target = {rec['t']: (rec['main'].get('nextCloseTime'), rec['main'].get('nextOpenTime')) for rec in main}
revs, jitter = [], []
for field, gate in (('nextOpen', 'BARRIERS DOWN'), ('nextClose', None)):
    idx = 1 if field == 'nextOpen' else 0
    prev = pt = pid = None
    for r in rep:
        v = cd(r.get(field))
        cid = (target.get(r.get('t')) or (None, None))[idx]
        same = (cid == pid)
        if same and prev is not None and v is not None and (gate is None or r.get('uiTitle') == pt == gate):
            if v > prev + 8:
                revs.append({'field': field, 't': r['time'], 'from': prev, 'to': v, 'closure': cid})
            elif v > prev and pending_at.get(r.get('t')):
                # a HELD bound is now + offset recomputed each pass, so it wobbles a second or
                # two. Not C12 — but it is a number on screen that ticks upward.
                jitter.append({'field': field, 't': r['time'], 'from': prev, 'to': v})
        prev, pt, pid = v, r.get('uiTitle'), cid
verdict('C12', 'a countdown increased (counted backwards)', 'recurring' if revs else 'fixed',
        f'{len(revs)} reversal(s) >8s within a single closure', revs)
verdict('UX3', 'held lower bound wobbles upward by a second or two', 'recurring' if jitter else 'latent',
        f'{len(jitter)} small upward tick(s) while closePending (cosmetic, but visible)', jitter)

# ==========================================================================================
# C14a - the priority entry. A countdown to a trigger that has NOT fired.
# ==========================================================================================
c14a, held_premature, held_all = [], [], []
for rec in main:
    r = byt.get(rec['t'])
    cs = rec['main'].get('upcomingClosures') or []
    if not cs: continue
    c0 = cs[0]
    t0_ = (c0.get('trains') or [{}])[0]
    hc, d = t0_.get('headcode'), t0_.get('direction')
    struck = None
    if hc and d in APPROACH: struck = (STRIKE.get(hc) or {}).get(APPROACH[d])
    unstruck = struck is None or struck.timestamp() > rec['t']
    # (a) the rendered countdown walked to zero with no strike and no held flag
    if r and unstruck and not c0.get('closePending'):
        v = cd(r.get('nextClose'))
        if (v is not None and v <= 0) or (r.get('nextClose') or '').strip() in ('Soon', 'NOW'):
            c14a.append({'t': L(rec['t']), 'hc': hc, 'nextClose': r.get('nextClose'), 'state': rec['main'].get('state')})
    # the register's own open question: does "held" appear on trains merely SLOW, not stopped?
    if c0.get('closePending') and hc:
        held_all.append({'t': rec['t'], 'hc': hc, 'dir': d})
first_held = {}
for h in held_all: first_held.setdefault(h['hc'], h)
for hc, h in first_held.items():
    d = h['dir']
    st = (STRIKE.get(hc) or {}).get(APPROACH.get(d, '')) if d in APPROACH else None
    # any berth step at all after the hold appeared
    nxt = min([ts for ts in (STRIKE.get(hc) or {}).values() if ts.timestamp() > h['t']], default=None)
    if nxt:
        delay = nxt.timestamp() - h['t']
        rec_ = {'hc': hc, 'heldAt': L(h['t']), 'nextStepIn': round(delay)}
        if delay <= 60: held_premature.append(rec_)
verdict('C14a', 'countdown ran to zero on a trigger that never fired',
        'recurring' if c14a else ('fixed' if rep else 'latent'),
        f'{len(c14a)} sample(s)', c14a)
verdict('C14h', '"Train held" shown on a train that was merely slow (register question)',
        'recurring' if held_premature else ('fixed' if held_all else 'latent'),
        f'{len(first_held)} train(s) held; {len(held_premature)} stepped again within 60s', held_premature)

# -------------------------------------------------------- the strike handover, measured
# C14's write-up claims "the strike handover moves the close <=1s (holding at now+offset is
# where strike+offset lands)". That was shown against fixtures. This measures it live: the
# last close served before the train struck its approach berth, against the first one after.
# A visible jump at the handover is a countdown lurching in front of the user.
hand = []
close_series = {}
for rec in main:
    for c in (rec['main'].get('upcomingClosures') or []):
        for t in (c.get('trains') or []):
            hc = t.get('headcode')
            if hc and (c.get('predictedStart') or c.get('start')):
                close_series.setdefault(hc, []).append((rec['t'], piso(c.get('predictedStart') or c.get('start'))))
for hc, series in close_series.items():
    d = None
    for rec in main:
        for c in (rec['main'].get('upcomingClosures') or []):
            for t in (c.get('trains') or []):
                if t.get('headcode') == hc and t.get('direction'): d = t['direction']
    if d not in APPROACH: continue
    ap = (STRIKE.get(hc) or {}).get(APPROACH[d])
    if not ap: continue
    before = [v for (ts, v) in series if ts < ap.timestamp() and v]
    after = [v for (ts, v) in series if ts >= ap.timestamp() + 5 and v]
    if before and after:
        jump = (after[0] - before[-1]).total_seconds()
        hand.append({'hc': hc, 'dir': d, 'jumpSecs': round(jump)})
big = [h for h in hand if abs(h['jumpSecs']) > 15]
verdict('C14j', 'the close jumps when the strike takes over from the projection',
        'recurring' if big else ('fixed' if hand else 'latent'),
        f'{len(hand)} handover(s) measured; {len(big)} moved >15s'
        + (f'; median |jump| {med([abs(h["jumpSecs"]) for h in hand])}s' if hand else ''), big or hand)

# ==========================================================================================
# C15 - inversion, plus: does the coalescing pass merge things a human would call two closures?
# ==========================================================================================
inv, cbo = [], []
for rec in main:
    cs = [c for c in (rec['main'].get('upcomingClosures') or []) if c.get('start') and c.get('end')]
    for i in range(1, len(cs)):
        if piso(cs[i]['start']) < piso(cs[i - 1]['end']):
            inv.append({'t': L(rec['t']), 'prevEnd': cs[i - 1]['end'], 'start': cs[i]['start']}); break
    m = rec['main']
    if m.get('state') == 'CLOSED' and m.get('nextCloseTime') and m.get('nextOpenTime') \
       and piso(m['nextCloseTime']) < piso(m['nextOpenTime']):
        cbo.append({'t': L(rec['t']), 'nextClose': m['nextCloseTime'], 'nextOpen': m['nextOpenTime']})
verdict('C15', 'a closure predicted to OPEN after the next one CLOSED',
        'recurring' if (inv or cbo) else 'fixed',
        f'{len(inv)} overlapping-period sample(s); {len(cbo)} close-before-open sample(s)', inv + cbo)

# merges audited against TD: how long was the barrier actually asked to stay down?
merges, wide = {}, []
for rec in main:
    for c in (rec['main'].get('upcomingClosures') or []):
        tr = [t.get('headcode') for t in (c.get('trains') or []) if t.get('headcode')]
        if len(tr) > 1: merges[tuple(sorted(tr))] = c
for key, c in merges.items():
    times = []
    for hc in key:
        s = STRIKE.get(hc) or {}
        a = min([v for k, v in s.items() if k in ('0006', '0003')], default=None)
        cl = min([v for k, v in s.items() if k in ('0002', '0007')], default=None)
        if a or cl: times.append((hc, a, cl))
    if len(times) >= 2:
        times.sort(key=lambda x: x[1] or x[2])
        gap = None
        if times[0][2] and times[1][1]: gap = (times[1][1] - times[0][2]).total_seconds()
        rec_ = {'trains': list(key), 'reason': c.get('reason'), 'gapSecs': round(gap) if gap is not None else None,
                'durationMins': c.get('durationMins')}
        if gap is not None and gap > 90: wide.append(rec_)
verdict('C15m', 'coalescing merged what a human would call two separate closures',
        'recurring' if wide else ('fixed' if merges else 'latent'),
        f'{len(merges)} merged group(s); {len(wide)} with a real gap >90s between clear and next approach', wide)

# ==========================================================================================
# C16 - the documented watch item: on a long-dwell train the west close fires ~140s early
# ==========================================================================================
early = []
for row in (truth.get('closeAccuracy') or []):
    if row.get('dir') != 'west': continue
    hc = row['hc']
    s = STRIKE.get(hc) or {}
    a, cl = s.get('0003'), s.get('0007')
    dwell = round((cl - a).total_seconds()) if (a and cl) else None
    if row['errSecs'] < -60:
        early.append({'hc': hc, 'firedEarlySecs': -row['errSecs'], 'transitSecs': dwell, 'class': row.get('class')})
westn = [r for r in (truth.get('closeAccuracy') or []) if r.get('dir') == 'west']
verdict('C16', 'west close fires far early on a long-dwell train',
        'recurring' if early else ('fixed' if westn else 'latent'),
        f'{len(westn)} west close(s) scored; {len(early)} fired >60s early', early)

# ------------------------------------------------------------------ open register entries
tdb = {t.get('tdBerth') for rec in main for c in (rec['main'].get('upcomingClosures') or []) for t in (c.get('trains') or [])}
verdict('#6b', 'tdBerth never populated, so the confidence ladder is unbuilt',
        'recurring' if tdb <= {None} else 'fixed', f'values seen: {sorted(str(x) for x in tdb)[:6]}')

eta = {t.get('etaText') for rec in main for c in (rec['main'].get('upcomingClosures') or []) for t in (c.get('trains') or [])}
iso_like = [e for e in eta if e and re.search(r'\d{4}-\d{2}-\d{2}T', str(e))]
# The register's point is that this is LATENT — the values are ugly but nothing renders them.
# So the test is whether one ever reaches the screen, not whether one exists.
rendered_iso = [r['time'] for r in rep
                if re.search(r'\d{4}-\d{2}-\d{2}T', str(r.get('card1') or '') + str(r.get('uiMsg') or ''))]
verdict('#9', 'etaText mixes labels with raw ISO timestamps',
        'recurring' if rendered_iso else ('latent' if iso_like else 'fixed'),
        f'{len(iso_like)}/{len(eta)} values are raw ISO; reached the screen in {len(rendered_iso)} sample(s)',
        sorted(str(e) for e in eta)[:8])

# #11 - the three close rules still at n=0
rule_n = {}
for row in (truth.get('closeAccuracy') or []):
    rule_n[row.get('rule')] = rule_n.get(row.get('rule'), 0) + 1
verdict('#11', 'close offsets ungrounded; three rules still at n=0', 'n/a',
        f'samples per rule this window: {json.dumps(rule_n)}')

gaps = truth.get('pairGaps') or []
near = [g for g in gaps if g['gapSecs'] <= 60]
verdict('#16', 'mergeOppositeMaxGapSecs=20 unvalidated', 'n/a',
        f'{len(gaps)} consecutive pair(s); {sum(1 for g in gaps if g["gapSecs"]<=20)} inside 20s, {len(near)} inside 60s'
        ' (needs barrier observation to close)', near)

# ------------------------------------------------------------------------ new UX checks
print(f"\n{'-'*118}\nUX / RENDERING")
BAD = re.compile(r'NaN|undefined|Invalid Date|null|-\d+s\b')
badstr = []
for r in rep:
    for f in ('uiTitle', 'uiMsg', 'nextClose', 'nextOpen', 'downFor', 'downForRange', 'card1'):
        v = r.get(f)
        if v and BAD.search(str(v)):
            badstr.append({'t': r['time'], 'field': f, 'value': str(v)[:100]})
verdict('UX1', 'NaN / undefined / Invalid Date / negative duration rendered',
        'recurring' if badstr else 'fixed', f'{len(badstr)} occurrence(s)', badstr)

soon_bad = []
for rec in main:
    r = byt.get(rec['t'])
    cs = rec['main'].get('upcomingClosures') or []
    if r and cs and cs[0].get('closePending') and 'Soon' in (r.get('nextClose') or ''):
        soon_bad.append({'t': L(rec['t']), 'nextClose': r.get('nextClose')})
verdict('UX2', '"Soon" rendered while the trigger had NOT fired (closePending)',
        'recurring' if soon_bad else ('fixed' if any(c.get('closePending') for rec in main for c in (rec['main'].get('upcomingClosures') or [])) else 'latent'),
        f'{len(soon_bad)} sample(s) - "Soon" must mean the trigger HAS fired', soon_bad)

# ------------------------------------------------------------------------ infrastructure
print(f"\n{'-'*118}\nINFRASTRUCTURE")
ups, prev, restarts = [], None, 0
for h in health:
    u = (h.get('health') or {}).get('uptime')
    if u is None: continue
    if prev is not None and u < prev: restarts += 1; ups.append(L(h['t']))
    prev = u
mem = [int(re.sub(r'\D', '', (h.get('health') or {}).get('memory', '0') or '0')) for h in health if (h.get('health') or {}).get('memory')]
lat = [r['ms'] for r in main if r.get('ms') is not None]
pub_bad = [p for p in public if not p.get('ok')]
# appview.jsonl is the DEFAULT-limit response, i.e. what a real client downloads. main.jsonl
# is limit=50 and would overstate the cost roughly threefold.
appview = LINES(f'{OUT}/appview.jsonl')
byt_ = [r['bytes'] for r in appview if r.get('bytes')]
INFRA = {
    'restarts': restarts, 'restartTimes': ups,
    'memoryMB': {'first': mem[0] if mem else None, 'last': mem[-1] if mem else None, 'max': max(mem) if mem else None},
    'localLatencyMs': {'p50': pct(lat, 50), 'p95': pct(lat, 95), 'max': max(lat) if lat else None},
    'publicProbe': {'n': len(public), 'failures': len(pub_bad),
                    'p95ms': pct([p['ms'] for p in public if p.get('ms')], 95)},
    'fetchErrors': len(errors),
    'payloadBytes': {'source': 'default limit (what a client actually requests)',
                     'n': len(byt_), 'median': med(byt_), 'max': max(byt_) if byt_ else None,
                     'kbPerHourAt10s': round((med(byt_) or 0) * 360 / 1024) if byt_ else None,
                     'closureCountMedian': med([r['closureCount'] for r in appview if r.get('closureCount') is not None])},
}
print(f"  restarts: {restarts} {ups}" + ('   <<< before/after are not comparable' if restarts else ''))
print(f"  memory MB: {INFRA['memoryMB']}   local latency ms: {INFRA['localLatencyMs']}")
print(f"  public probe: {INFRA['publicProbe']}   recorder fetch errors: {len(errors)}")
print(f"  payload: median {INFRA['payloadBytes']['median']}B -> {INFRA['payloadBytes']['kbPerHourAt10s']} KB/h at the 10s poll")

res = {'window': {'from': L(t0), 'to': L(t1)}, 'entries': V, 'infra': INFRA}
json.dump(res, open(f'{OUT}/regress.json', 'w'), indent=1)
rec_n = sum(1 for v in V.values() if v['verdict'] == 'recurring')
print(f"\n  {rec_n} RECURRING, {sum(1 for v in V.values() if v['verdict']=='fixed')} fixed, "
      f"{sum(1 for v in V.values() if v['verdict']=='latent')} latent, {sum(1 for v in V.values() if v['verdict']=='n/a')} n/a")
print(f"wrote {OUT}/regress.json")
