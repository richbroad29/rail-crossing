// Unit test for PREDICT's barrier-event attribution — which train the feedback picker
// blames for a CLOSE or an OPEN. Runs the REAL shared/predict.js, no browser.
//
//   node .claude/skills/crossing-audit/scripts/picker-test.js [repo-root]
//
// The case that motivated it is real and is in the sheet: 2026-08-01 17:43:36Z, the
// barrier lifted, and the app recommended 1H46 — which had crossed 175 s earlier — over
// 1N47, which had crossed 51 s earlier and was standing in the clear berth. 1H46 won
// because the ranking key was `ageSecs`, the age of the last BERTH STEP, and 1H46 had run
// on to 0013 (stepping 36 s before the tap) while 1N47 sat in 0002 (51 s). The observation
// went into the calibration sheet against the wrong train.
//
// To falsify: put `a.ageSecs - b.ageSecs` back as the sort key in PREDICT.suggestForEvent
// and the first three assertions must fail.
const path = require('path');
const REPO = process.argv[2] || path.resolve(__dirname, '../../../..');
global.window = global;
require(path.join(REPO, 'shared/predict.js'));
const P = global.PREDICT;

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `\n          got:      ${JSON.stringify(got)}\n          expected: ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
};

// The shipped trigger table, as GET /crossing/portslade/triggers serves it.
const TRIGGERS = {
  close: [
    { direction: 'east', trainClass: 'stopping',      berth: '0008', offsetSecs: 55,  firesSecsBeforeCrossing: 134 },
    { direction: 'east', trainClass: 'stoppingLocal', berth: '0006', offsetSecs: 100, firesSecsBeforeCrossing: 146 },
    { direction: 'east', trainClass: 'fast',          berth: '0008', offsetSecs: 20,  firesSecsBeforeCrossing: 137 },
    { direction: 'west', trainClass: 'stopping',      berth: '0003', offsetSecs: 61,  firesSecsBeforeCrossing: 92 }
  ],
  open: [
    { direction: 'east', trainClass: 'passenger', lagSecs: 40, clearBerth: '0002' },
    { direction: 'east', trainClass: 'freight',   lagSecs: 70, clearBerth: '0002' },
    { direction: 'west', trainClass: 'passenger', lagSecs: 18, clearBerth: '0007' },
    { direction: 'west', trainClass: 'freight',   lagSecs: 30, clearBerth: '0007' }
  ]
};

const NOW = 1785606216122;          // 2026-08-01T17:43:36.122Z — the real tap
// Build a live-feed train the way the /live endpoint serves it, then enrich it exactly as
// both apps do. ageSecs is the feed's own age-of-last-berth-step, which is the field that
// used to drive attribution.
// enrich() stamps strikeAtMs off Date.now(), because in both apps enrichment happens AT
// the tap. Pin the clock to NOW while building so the fixture reproduces that, rather than
// dating every train from whenever the test happens to run — without this, ageSecs lands in
// the future relative to NOW, in-berth time clamps to zero, and a train that cleared ten
// minutes ago reads as having just crossed.
const mk = (headcode, direction, berth, ageSecs, trainClass) => {
  const real = Date.now;
  Date.now = () => NOW;
  try {
    return P.enrich({ headcode, direction, berth, ageSecs, trainClass, origin: 'x', destination: 'y' },
                    () => ({ sched: null, live: null }));
  } finally { Date.now = real; }
};

// ---- 1. the 17:43:36 case ----
// 1H46 west: crossed 0005>0007 at 17:40:41, ran on, stepped into 0013 at 17:43:00 (36 s).
// 1N47 east: crossed 0004>0002 at 17:42:45 (51 s) and was still in 0002 at the tap.
// 1S28 west: in 0005, ~72 s short of the crossing — it caused the NEXT close, at 17:44:13.
const h46 = mk('1H46', 'west', '0013', 36, 'stopping');
const n47 = mk('1N47', 'east', '0002', 51, 'stoppingLocal');
const s28 = mk('1S28', 'west', '0005', 44, 'stopping');
const scene = [h46, n47, s28];

console.log('  -- 2026-08-01 17:43:36Z barrier-up --');
check('OPEN picks the train that actually just cleared, not the freshest berth step',
  P.suggestForEvent('opening', scene, NOW, TRIGGERS).headcode, '1N47');
check('...and the loser is the one ageSecs would have chosen',
  h46.ageSecs < n47.ageSecs, true);
check('...still right with no trigger table (degrades to distance-from-crossing)',
  P.suggestForEvent('opening', scene, NOW, null).headcode, '1N47');

// ---- 2. the open trigger sits AFTER the crossing ----
// A train 20 s short of the road cannot have opened the barrier; one 80 s past it can.
// Plain distance-from-crossing gets this backwards; distance-from-trigger does not.
{
  const before = mk('1A01', 'east', '0004', 0, 'stopping');   // approaching
  const after  = mk('1A02', 'east', '0002', 80, 'stopping');  // cleared 80 s ago
  before.prox = { stage: 'approach', role: 'protecting', index: 0, etaSecs: 20, sinceSecs: null, rank: 20 };
  before.strikeAtMs = NOW;
  check('east open ref is -lagSecs (40 s AFTER the crossing)', P.triggerRef('opening', after, TRIGGERS), -40);
  check('a cleared train beats one still short of the crossing',
    P.suggestForEvent('opening', [before, after], NOW, TRIGGERS).headcode, '1A02');
  // …and it keeps beating it however stale it is: a barrier does not rise for a train that
  // has not arrived, so an approaching train is a last resort, not a near-miss competitor.
  check('...and so does one that cleared 10 min ago, since the other has not arrived',
    P.suggestForEvent('opening', [before, mk('1A03', 'east', '0002', 600, 'stopping')], NOW, TRIGGERS).headcode, '1A03');
  check('an approaching train is still offered when nothing has cleared',
    P.suggestForEvent('opening', [before], NOW, TRIGGERS).headcode, '1A01');
}

// ---- 2b. the guard the 2026-07-27 replay caught ----
// A train 25 s PAST the crossing outranked one 41 s short of it on raw distance, so a CLOSE
// was attributed to a train that had already gone. Reproduced here with no trigger table,
// which is the degraded path where distance alone decides.
{
  const gone   = mk('2Y21', 'east', '0002', 25, 'stoppingLocal');
  const coming = mk('1H67', 'east', '0004', 0, 'stopping');
  coming.prox = { stage: 'approach', role: 'protecting', index: 0, etaSecs: 41, sinceSecs: null, rank: 41 };
  coming.strikeAtMs = NOW;
  check('CLOSE never picks a train that has already crossed, even with no triggers',
    P.suggestForEvent('closing', [gone, coming], NOW, null).headcode, '1H67');
  check('...and it sorts below every eligible train',
    P.eventRank('closing', gone, NOW, null) > P.eventRank('closing', coming, NOW, null), true);
}

// ---- 3. CLOSE ranks against the class's own anchor, not the crossing ----
// A stoppingLocal fires at 0006+100 = 146 s out; a stopping at 0008+55 = 134 s out. A train
// sitting 30 s from the road is past its trigger by two minutes and did not cause this close.
{
  const atTrigger = mk('1N01', 'east', '0006', 0, 'stoppingLocal');
  atTrigger.prox = { stage: 'approach', role: null, index: 0, etaSecs: 146, sinceSecs: null, rank: 146 };
  atTrigger.strikeAtMs = NOW;
  const nearRoad = mk('1H01', 'east', '0004', 0, 'stopping');
  nearRoad.prox = { stage: 'approach', role: 'protecting', index: 0, etaSecs: 30, sinceSecs: null, rank: 30 };
  nearRoad.strikeAtMs = NOW;
  check('east stoppingLocal close ref = 146 s before the crossing',
    P.triggerRef('closing', atTrigger, TRIGGERS), 146);
  check('CLOSE picks the train at its trigger, not the one nearest the road',
    P.suggestForEvent('closing', [nearRoad, atTrigger], NOW, TRIGGERS).headcode, '1N01');
  check('without triggers the old reference (the crossing) picks the nearer train',
    P.suggestForEvent('closing', [nearRoad, atTrigger], NOW, null).headcode, '1H01');
}

// ---- 4. degenerate inputs ----
check('off-chain train has no rank', P.eventRank('opening', mk('9Z99', 'east', 'ZZZZ', 5, null), NOW, TRIGGERS), null);
check('empty feed suggests nothing', P.suggestForEvent('opening', [], NOW, TRIGGERS), null);
check('unknown class falls back to the crossing as reference',
  P.triggerRef('closing', mk('1Q01', 'east', '0006', 0, 'nosuchclass'), TRIGGERS), 0);
check('freight uses the freight open lag', P.triggerRef('opening', mk('6V68', 'west', '0007', 5, 'freight'), TRIGGERS), -30);

console.log(`\n${fail ? fail + ' FAILED, ' : ''}${pass} passed`);
process.exit(fail ? 1 : 0);
