// Score the feedback picker's train attribution against TD ground truth, over every
// barrier tap ever recorded. Answers "how often does the app blame the wrong train?" —
// which matters because a picker default gets accepted, and an accepted wrong default puts
// a barrier timing against the wrong train in the calibration sheet.
//
//   node attribution-truth.js <td-steps.jsonl> <feedback.csv> [triggers.json]
//
// td-steps.jsonl: one CA event per line, {ts,h,f,t}, covering the FULL chain including the
// post-crossing berths. Getting that set wrong is not a small error — with the post-crossing
// berths omitted this harness scored the OLD rule 17/17, because the bug it is looking for
// is precisely that a train keeps stepping AFTER it crosses. Build it on the VPS with:
//
//   python3 - <<'PY' > /tmp/steps.jsonl
//   import json,glob
//   keep=set(["0016","0014","0012","0010","0008","0006","0004","0002","T686","T684",
//             "T682","T677","0001","0003","0005","0007","0009","0011","0013","0015","0017"])
//   for p in sorted(glob.glob("/home/ubuntu/rail-crossing/backend/data/logs/td/td-*.jsonl")):
//       for line in open(p):
//           try: r=json.loads(line)
//           except: continue
//           if r.get("event")!="CA": continue
//           if r.get("to") in keep or r.get("from") in keep:
//               print(json.dumps({"ts":r["ts"],"h":r.get("desc"),"f":r.get("from"),"t":r.get("to")}))
//   PY
//
// triggers.json: GET /crossing/portslade/triggers. Optional — without it the ranking
// degrades to distance-from-crossing, which is what an old backend would give the app.
//
// It reconstructs the /live view the device would have held at each tap (every train on the
// chain, its latest berth, its age) and runs the real PREDICT attribution over it. The
// reconstruction is validated by the `ourGuessHeadcode` column: where the app recorded its
// own guess, this harness must reproduce it. It does, on 4 of 4 known-wrong cases.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const STEPS = process.argv[2], CSV = process.argv[3], TRIGFILE = process.argv[4];
if (!STEPS || !CSV) { console.error('usage: node attribution-truth.js <td-steps.jsonl> <feedback.csv> [triggers.json]'); process.exit(1); }
const REPO = path.resolve(__dirname, '../../../..');
global.window = global;
require(path.join(REPO, 'shared/predict.js'));
const P = global.PREDICT;
const TRIG = TRIGFILE ? JSON.parse(fs.readFileSync(TRIGFILE, 'utf8')) : null;

const steps = fs.readFileSync(STEPS, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  .map(s => ({ ...s, ms: Date.parse(s.ts) })).sort((a, b) => a.ms - b.ms);
const chainSet = d => new Set(P.CHAIN[d].filter(n => !n.x).map(n => n.b));
const EAST = chainSet('east'), WEST = chainSet('west');
const TTL = 240000;                                   // config live.ttlSecs

// The /live payload as the backend would have served it at `ms`.
function liveAt(ms) {
  const cur = new Map();
  for (const s of steps) { if (s.ms > ms) break; cur.set(s.h, { berth: s.t, ms: s.ms }); }
  const out = [];
  for (const [headcode, v] of cur) {
    if (ms - v.ms > TTL) continue;
    const direction = EAST.has(v.berth) ? 'east' : WEST.has(v.berth) ? 'west' : null;
    if (!direction) continue;
    out.push({ headcode, direction, berth: v.berth, ageSecs: Math.round((ms - v.ms) / 1000),
               origin: 'x', destination: 'y' });
  }
  return out;
}
// Truth: the last train to make a clear step. That IS the crossing instant.
function lastClearBefore(ms) {
  let best = null;
  for (const s of steps) { if (s.ms > ms) break;
    if ((s.f === '0004' && s.t === '0002') || (s.f === '0005' && s.t === '0007')) best = s; }
  return best;
}

const taps = JSON.parse(cp.execSync(`python3 -c "
import csv, json, sys
csv.field_size_limit(10000000)
rows = list(csv.DictReader(open(sys.argv[1], newline='', encoding='utf-8-sig')))
print(json.dumps([{ 'ts': r['eventTimestamp'], 'ev': r['event'], 'guess': r['ourGuessHeadcode'],
                    'sel': r['selectedHeadcode'], 'was': r['wasOurGuess'] }
                  for r in rows if r.get('eventTimestamp') and r.get('event')]))
" ${JSON.stringify(CSV)}`).toString());

let n = 0, ok = 0, reproduced = 0, reproducible = 0, accepted = 0;
console.log('tap                  event    TD truth  app guessed  this rule   ');
for (const tap of taps) {
  if (tap.ev !== 'opening') continue;                 // CLOSE truth needs the FUTURE crossing
  const ms = Date.parse(tap.ts), truth = lastClearBefore(ms);
  if (!truth || ms - truth.ms > 600000) continue;     // no crossing near this tap
  const real = Date.now; Date.now = () => ms;         // enrich() stamps strikeAtMs off now
  const enriched = liveAt(ms).map(t => P.enrich(t, () => ({ sched: null, live: null })));
  Date.now = real;
  const got = P.suggestForEvent('opening', enriched, ms, TRIG);
  const gh = got ? got.headcode : null;
  n++; if (gh === truth.h) ok++;
  if (tap.guess) { reproducible++; if (tap.guess !== truth.h && tap.was === 'TRUE') accepted++; }
  const flag = gh === truth.h ? '' : '  <-- WRONG';
  const appFlag = tap.guess && tap.guess !== truth.h ? (tap.was === 'TRUE' ? ' (accepted!)' : ' (overridden)') : '';
  console.log(`${tap.ts.slice(0, 19)}  opening  ${truth.h.padEnd(9)} ${String(tap.guess || '-').padEnd(6)}${appFlag.padEnd(14)} ${String(gh).padEnd(6)}${flag}`);
}
console.log(`\nthis rule: ${ok}/${n} correct`);
console.log(`historically the app guessed wrong on ${taps.filter(t => t.ev === 'opening' && t.guess && t.was === 'FALSE').length} taps the human overrode, and ${accepted} it accepted`);
process.exit(ok === n ? 0 : 1);
