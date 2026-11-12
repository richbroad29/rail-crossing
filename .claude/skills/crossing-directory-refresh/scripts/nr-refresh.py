#!/usr/bin/env python3
"""Compare a new Network Rail level-crossing file with the master crossing list.

Standard library only (no openpyxl): the .xlsx is read as the zip of XML it is.

  python3 -I nr-refresh.py diff  <nr.xlsx> <crossing-list.csv>
      Print the change summary for Rich to approve. Writes nothing.

  python3 -I nr-refresh.py apply <nr.xlsx> <crossing-list.csv> <out.csv>
      Write the updated list to <out.csv>. Rows that need road/town/county filling
      come out with needs_fill=yes and are listed at the end. Never writes over
      <crossing-list.csv> itself: diff the two files, then move <out.csv> into place.

  python3 -I nr-refresh.py seed <nr.xlsx> <research.csv> <overrides.csv> <out.csv>
      One-time: make the master list from ticket 09's research CSV. Adds the nr_*
      columns from the Network Rail file the research used, marks the hand-checked
      rows, and re-cleans every display name.

  python3 -I nr-refresh.py clean-name "<raw NR name>"
      Show the cleaned display name for one raw name.

The master list keeps what Network Rail said last time (nr_name, nr_type, nr_status,
nr_lat, nr_lon) apart from what the app shows (display_name, lat, lon). A refresh
compares Network Rail with Network Rail, so a position we corrected by hand never
reads as "moved" again. When a list has no nr_* columns yet (the first run, from the
research CSV), name/type/status/lat/lon stand in for them.
"""
import csv, math, re, sys, zipfile
import xml.etree.ElementTree as ET

# ---- which Network Rail crossing types are road crossings (ticket 01) ---------------
CORE = {'CCTV', 'AHB', 'AHB-X', 'MCBOD', 'MCB/MB', 'MCBR', 'ABCL', 'ABCL-X', 'AOCL',
        'AOCLB', 'AOCR', 'AFBCL', 'MGH', 'MGW'}
AMBIG = {'OC', 'MG', 'TMOB', 'TMOG', 'TOB', 'TOG', 'MBW', 'MBWM'}
DROP_STATUS = {'Engineering Only'}
MOVE_M = 50

def group_of(t):
    return 'core' if t in CORE else 'ambig' if t in AMBIG else None

# ---- xlsx -------------------------------------------------------------------------
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}

def col_index(ref):
    n = 0
    for ch in re.match(r'[A-Z]+', ref).group(0):
        n = n * 26 + ord(ch) - 64
    return n - 1

def read_xlsx(path):
    z = zipfile.ZipFile(path)
    shared = []
    if 'xl/sharedStrings.xml' in z.namelist():
        for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si', NS):
            shared.append(''.join(t.text or '' for t in si.iter('{%s}t' % NS['m'])))
    sheets = sorted(n for n in z.namelist() if re.match(r'xl/worksheets/sheet\d+\.xml$', n))
    if len(sheets) != 1:
        raise SystemExit(f'expected one sheet, found {sheets} - check the file by eye')
    rows = []
    for row in ET.fromstring(z.read(sheets[0])).iter('{%s}row' % NS['m']):
        cells = {}
        for c in row.findall('m:c', NS):
            t, v = c.get('t'), c.find('m:v', NS)
            if t == 's':
                val = shared[int(v.text)]
            elif t == 'inlineStr':
                val = ''.join(x.text or '' for x in c.iter('{%s}t' % NS['m']))
            else:
                val = v.text if v is not None else ''
            cells[col_index(c.get('r'))] = (val or '').strip()
        if cells:
            rows.append([cells.get(i, '') for i in range(max(cells) + 1)])
    header = rows[0]
    need = ['Crossing UID', 'Crossing Name', 'Latitude', 'Longitude', 'Crossing Type', 'Overall Status']
    missing = [h for h in need if h not in header]
    if missing:
        raise SystemExit(f'Network Rail changed the columns: missing {missing}; header is {header}')
    ix = {h: header.index(h) for h in need}
    out = {}
    for r in rows[1:]:
        r = r + [''] * (len(header) - len(r))
        uid = r[ix['Crossing UID']].split('.')[0]
        if not uid:
            continue
        out[uid] = {'uid': uid, 'name': r[ix['Crossing Name']], 'type': r[ix['Crossing Type']],
                    'status': r[ix['Overall Status']],
                    'lat': float(r[ix['Latitude']]), 'lon': float(r[ix['Longitude']])}
    return out

# ---- display-name clean-up ------------------------------------------------------------
# Type suffixes Network Rail appends to names. Longest first, so "MCB (CCTV)" beats "MCB".
SUFFIXES = ['AOCL+B', 'MCB-CCTV', 'MCB (CCTV)', 'MCB-OD', 'MCB OD', 'AHB-X', 'ABCL-X',
            'CCTV', 'MCBR', 'MCB', 'AHB', 'ABCL', 'AOCL', 'MGH', 'MGW', 'TMOG', 'TMOB', 'TMO',
            'AFBCL', 'AOCR', 'OC']
TYPE_WORDS = '|'.join(re.escape(x) for x in SUFFIXES + ['MCB/MB', 'MCBOD'])
SMALL = {'and', 'on', 'le', 'in', 'by', 'of', 'the', 'upon', 'cum', 'next', 'under', 'en', 'de', 'la'}

def _cap(word):
    lead = re.match(r'[(\[]*', word).group(0)            # "(hartlepool)" -> "(Hartlepool)"
    word = word[len(lead):]
    parts = word.split('-')
    return lead + '-'.join(p if i and p in SMALL else p[:1].upper() + p[1:]
                           for i, p in enumerate(parts))

def title_case(s):
    out = []
    for i, w in enumerate(s.lower().split(' ')):
        if i and w in SMALL:
            out.append(w)
        elif re.fullmatch(r'no\.?\d*', w):
            out.append('No' + w[2:])
        elif "'" in w:
            out.append(w[:1].upper() + w[1:])        # "st'" etc - leave the rest lower
        else:
            out.append(_cap(w))
    return ' '.join(out)

def clean_name(raw):
    s = re.sub(r'\s+', ' ', raw).strip()
    s = re.sub(r'\s+\d+m\s*\d+ch$', '', s)            # "ABCL 103m 47ch"
    s = re.sub(r'\s*\((?:EMP|LTN\d+)\)$', '', s)      # "AHB (EMP)", "CCTV (LTN1)"
    s = re.sub(r'\s*\((?:' + TYPE_WORDS + r')\)$', '', s, flags=re.I)   # "SPITTAL (MGH)"
    s = re.sub(r'\s+(?:LC|CROSSING|LEVEL CROSSING)$', '', s)           # "CARLETON CROSSING"
    for suf in SUFFIXES:
        if re.search(r'\s' + re.escape(suf) + r'$', s, re.I) and len(s) > len(suf) + 1:
            s = s[:-len(suf)].rstrip()
            break
    s = re.sub(r'\s*\((?:EMP|LTN\d+)\)$', '', s)
    letters = [c for c in s if c.isalpha()]
    if letters and sum(c.isupper() for c in letters) / len(letters) > 0.6:
        s = title_case(s)
    return s

# ---- list I/O ---------------------------------------------------------------------
def read_list(path):
    with open(path, newline='') as f:
        rd = csv.DictReader(f)
        return rd.fieldnames, {r['uid']: r for r in rd}

def nr_was(row):
    """What Network Rail said last time for this row."""
    g = lambda k: row.get('nr_' + k) or row.get(k, '')
    return {'name': g('name'), 'type': g('type'), 'status': g('status'),
            'lat': float(g('lat')), 'lon': float(g('lon'))}

def metres(a, b):
    p = math.pi / 180
    x = (b['lon'] - a['lon']) * p * math.cos((a['lat'] + b['lat']) / 2 * p)
    y = (b['lat'] - a['lat']) * p
    return 6371000 * math.hypot(x, y)

def yes(v):
    return str(v).strip().lower() in ('yes', 'true', '1')

# ---- the comparison -------------------------------------------------------------------
def compare(nr, lst):
    ch = {k: [] for k in ('added', 'gone', 'moved', 'renamed', 'retyped', 'regrouped',
                          'status', 'excluded_seen')}
    for uid, n in nr.items():
        g = group_of(n['type'])
        if not g or n['status'] in DROP_STATUS:
            continue
        if uid not in lst:
            ch['added'].append((uid, n, g))
    for uid, row in lst.items():
        was = nr_was(row)
        n = nr.get(uid)
        g = group_of(n['type']) if n else None
        if not n or not g or n['status'] in DROP_STATUS:
            why = ('not in the new file' if not n else
                   f"now type {n['type']} (not a road crossing)" if not g else
                   f"status {n['status']}")
            ch['gone'].append((uid, row, why))
            continue
        if yes(row.get('excluded')):
            ch['excluded_seen'].append(uid)
        d = metres(was, n)
        if d > MOVE_M:
            ch['moved'].append((uid, row, n, round(d)))
        if n['name'] != was['name']:
            ch['renamed'].append((uid, row, n))
        if n['type'] != was['type']:
            (ch['regrouped'] if g != group_of(was['type']) else ch['retyped']).append((uid, row, n, g))
        if n['status'] != was['status']:
            ch['status'].append((uid, row, n))
    return ch

def label(row):
    return f"{row.get('display_name') or row.get('name')} ({row['uid']})"

def summary(ch):
    L = []
    hc = lambda r: ' **hand-checked: position kept, look at it**' if yes(r.get('hand_checked')) else ''
    ex = lambda r: ' (excluded row)' if yes(r.get('excluded')) else ''
    L.append(f"## Added - {len(ch['added'])} new road crossing(s)")
    for uid, n, g in sorted(ch['added']):
        L.append(f"- {clean_name(n['name'])} ({uid}) - raw \"{n['name']}\", {n['type']} [{g}], "
                 f"{n['status']}, {n['lat']:.6f},{n['lon']:.6f}")
    L.append(f"\n## Gone - {len(ch['gone'])} (removed; a LIVE crossing here makes the build fail)")
    for uid, r, why in sorted(ch['gone']):
        L.append(f"- {label(r)} - {why}{ex(r)}")
    L.append(f"\n## Moved more than {MOVE_M} m - {len(ch['moved'])} (road and town refilled)")
    for uid, r, n, d in sorted(ch['moved'], key=lambda x: -x[3]):
        L.append(f"- {label(r)} - {d} m{hc(r)}{ex(r)}")
    L.append(f"\n## Renamed by Network Rail - {len(ch['renamed'])}")
    for uid, r, n in sorted(ch['renamed']):
        L.append(f"- {label(r)}: \"{nr_was(r)['name']}\" -> \"{n['name']}\" "
                 f"=> shows \"{clean_name(n['name'])}\"{ex(r)}")
    L.append(f"\n## Type changed, still a road crossing - {len(ch['retyped'])}")
    for uid, r, n, g in sorted(ch['retyped']):
        L.append(f"- {label(r)}: {nr_was(r)['type']} -> {n['type']}")
    L.append(f"\n## Moved between core and ambiguous - {len(ch['regrouped'])} (look at each)")
    for uid, r, n, g in sorted(ch['regrouped']):
        L.append(f"- {label(r)}: {nr_was(r)['type']} -> {n['type']} [{g}]{ex(r)}")
    L.append(f"\n## Status changed - {len(ch['status'])}")
    for uid, r, n in sorted(ch['status']):
        L.append(f"- {label(r)}: {nr_was(r)['status']} -> {n['status']}")
    L.append(f"\n{len(ch['excluded_seen'])} excluded row(s) still in Network Rail's file - left excluded.")
    return '\n'.join(L)

NR_COLS = ['nr_name', 'nr_type', 'nr_status', 'nr_lat', 'nr_lon']
EXTRA = ['excluded', 'exclude_reason', 'hand_checked', 'needs_fill']

def apply(nr, fields, lst, ch):
    fields = list(fields) + [c for c in NR_COLS + EXTRA if c not in fields]
    out = {}
    gone = {uid for uid, _, _ in ch['gone']}
    for uid, row in lst.items():
        if uid in gone:
            continue
        r = dict(row)
        for k in NR_COLS:                         # first run: seed from the stand-ins
            r[k] = r.get(k) or nr_was(row)[k[3:]]
        out[uid] = r
    for uid, r, n, d in ch['moved']:
        out[uid]['needs_fill'] = 'yes'            # road + town may differ at the new spot
        if not yes(r.get('hand_checked')):
            out[uid]['lat'], out[uid]['lon'] = f"{n['lat']:.6f}", f"{n['lon']:.6f}"
    for uid, r, n in ch['renamed']:
        out[uid]['name'] = n['name']
        out[uid]['display_name'] = clean_name(n['name'])
    for uid, r, n, g in ch['retyped'] + ch['regrouped']:
        out[uid]['type'], out[uid]['group'] = n['type'], g
    for uid, r, n in ch['status']:
        out[uid]['status'] = n['status']
    for uid, n, g in ch['added']:
        out[uid] = {k: '' for k in fields}
        out[uid].update(uid=uid, name=n['name'], display_name=clean_name(n['name']), type=n['type'],
                        group=g, status=n['status'], lat=f"{n['lat']:.6f}", lon=f"{n['lon']:.6f}",
                        needs_fill='yes')
    for uid, r in out.items():                    # record what NR said, this time
        n = nr[uid]
        r.update(nr_name=n['name'], nr_type=n['type'], nr_status=n['status'],
                 nr_lat=f"{n['lat']:.6f}", nr_lon=f"{n['lon']:.6f}")
    return fields, out

def seed(nr, research, overrides, out_path):
    fields, lst = read_list(research)
    _, hand = read_list(overrides)
    fields = list(fields) + [c for c in NR_COLS + EXTRA if c not in fields]
    missing = [u for u in lst if u not in nr]
    if missing:
        raise SystemExit(f'not the file the research used: {len(missing)} rows missing, e.g. {missing[:5]}')
    for uid, r in lst.items():
        n = nr[uid]
        r.update(nr_name=n['name'], nr_type=n['type'], nr_status=n['status'],
                 nr_lat=f"{n['lat']:.6f}", nr_lon=f"{n['lon']:.6f}",
                 display_name=clean_name(r['name']),
                 hand_checked='yes' if uid in hand else '', needs_fill='')
    with open(out_path, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore')
        w.writeheader()
        for uid in sorted(lst, key=lambda u: lst[u]['display_name'].lower()):
            w.writerow(lst[uid])
    print(f'Wrote {out_path}: {len(lst)} rows, {len(hand)} hand-checked')

def main(a):
    if len(a) >= 2 and a[0] == 'clean-name':
        print(clean_name(a[1])); return
    if len(a) == 5 and a[0] == 'seed':
        seed(read_xlsx(a[1]), a[2], a[3], a[4]); return
    if len(a) < 3 or a[0] not in ('diff', 'apply') or (a[0] == 'apply' and len(a) < 4):
        print(__doc__); sys.exit(2)
    nr = read_xlsx(a[1])
    fields, lst = read_list(a[2])
    ch = compare(nr, lst)
    print(f"Network Rail file: {len(nr)} rows. Master list: {len(lst)} rows.\n")
    print(summary(ch))
    if a[0] == 'apply':
        if a[3] == a[2]:
            raise SystemExit('refusing to overwrite the master list in place')
        fields, out = apply(nr, fields, lst, ch)
        with open(a[3], 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore')
            w.writeheader()
            for uid in sorted(out, key=lambda u: (out[u].get('display_name') or '').lower()):
                w.writerow(out[uid])
        todo = [u for u, r in out.items() if yes(r.get('needs_fill'))]
        print(f"\nWrote {a[3]}: {len(out)} rows, {len(todo)} need road/town/county filling: "
              + ', '.join(sorted(todo)))

if __name__ == '__main__':
    main(sys.argv[1:])
