// The closure card's header, checked against the event cards it is supposed to agree with.
//
//   node .claude/skills/crossing-audit/scripts/card-test.js
//
// Both files are DOM-free IIFEs that attach to globalThis, so this needs no browser — which
// is the point: a screenshot shows one moment, and the property worth protecting here is one
// that only breaks over time or in a state nobody screenshots.
//
// WHAT IT PROTECTS. The active closure's pill ("Closed 1m 16s") is the same countdown as the
// Next Open card above it. They are not merely similar: derive() sets that card from
// `current.end` and `current.holdingOpen`, and cardHtml is handed the same period, so the two
// are the same number by construction. Nothing enforces that but this file. If someone later
// gives the pill its own arithmetic — a rounding, a floor, a different formatter — the app
// will show two different answers to "how long until I can cross", inches apart, and it will
// look deliberate. That is the failure this exists to catch.
//
// The held states are asserted too, because they are where a mirror usually cracks: "≥ 9s"
// while a train has not cleared, "held" once even that bound has passed, "Soon" when a live
// countdown reaches zero before the state catches up. Each has to be the token the card above
// is showing at that instant.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..', '..');

eval(fs.readFileSync(path.join(ROOT, 'shared/predict.js'), 'utf8'));
eval(fs.readFileSync(path.join(ROOT, 'shared/closure-card.js'), 'utf8'));
const P = globalThis.PREDICT, C = globalThis.CLOSURE_CARD;

let pass = 0, fail = 0;
function check(label, actual, expected) {
  if (actual === expected) { console.log(`  PASS  ${label}  (${actual})`); pass++; }
  else {
    console.log(`  FAIL  ${label}`);
    console.log(`          got:      ${actual}`);
    console.log(`          expected: ${expected}`);
    fail++;
  }
}

const T0 = new Date('2026-08-14T17:39:10Z').getTime();

// One current closure, ending `endOffsetSecs` from T0. `holdingOpen` is the register-#14
// case: the train has not performed its clear step, so the end is a bound, not a prediction.
function periods(endOffsetSecs, holdingOpen, extra) {
  return P.buildClosures([Object.assign({
    start: new Date(T0 - 190000).toISOString(),
    predictedStart: new Date(T0 - 133000).toISOString(),
    end: new Date(T0 + endOffsetSecs * 1000).toISOString(),
    holdingOpen: holdingOpen, closeConfirmed: true, closePending: false,
    trains: [{
      headcode: '1H42', direction: 'west', origin: 'London Victoria', destination: 'Littlehampton',
      bestTime: new Date(T0).toISOString(), scheduledTime: new Date(T0).toISOString(), source: 'ldbsv'
    }]
  }, extra || {})], { confidenceWindows: {} });
}

const pillOf = html => { const m = /closure-pill-active">Closed ([^<]*)</.exec(html); return m && m[1]; };
// Exactly what fillEventCard() in shared/crossing.js prints, from the same derive() output.
const boxOf = (pr, t) => P.fmtEta(pr.nextOpenTime.getTime() - t, pr.openHeld);

console.log('\nActive-closure pill mirrors the Next Open card\n');
[false, true].forEach(held => {
  [136, 76, 9, -5].forEach(off => {
    const ps = periods(off, held);
    if (!ps.length) return;
    const now = new Date(T0);
    const html = C.cardHtml(ps[0], now);
    if (pillOf(html) === null) return;   // not rendered as current at this offset
    check((held ? 'held' : 'live') + ', end ' + (off < 0 ? off : '+' + off) + 's',
          pillOf(html), boxOf(P.derive(ps, now, 0), T0));
  });
});

console.log('\nIt is a countdown, not a static duration\n');
const ticking = [0, 30, 60, 120].map(a => pillOf(C.cardHtml(periods(136, false)[0], new Date(T0 + a * 1000))));
console.log('  t+0/30/60/120s ->', ticking.join('  ->  '));
check('a distinct value at each tick', new Set(ticking).size, ticking.length);
check('starts at the full remaining time', ticking[0], '2m 16s');
check('and has counted down by t+120s', ticking[3], '16s');

console.log('\nThe closure total is no longer printed beside it\n');
check('no "opens in" phrasing', /opens in/.test(C.cardHtml(periods(136, false)[0], new Date(T0))), false);

console.log('\nNo confidence band anywhere (removed 2026-08-14)\n');
const upcoming = P.buildClosures([{
  start: new Date(T0 + 600000).toISOString(), predictedStart: new Date(T0 + 600000).toISOString(),
  end: new Date(T0 + 820000).toISOString(), holdingOpen: false, closeConfirmed: false, closePending: false,
  trains: [{ headcode: '1N63', direction: 'east', origin: 'A', destination: 'B',
             bestTime: new Date(T0 + 600000).toISOString(), scheduledTime: new Date(T0 + 600000).toISOString(),
             source: 'cif' }]
}], { confidenceWindows: {} });
const markup = [periods(136, false)[0], upcoming[0]].map(p => C.cardHtml(p, new Date(T0))).join('');
check('no ± in the markup', /±/.test(markup), false);
check('no .closure-uncertainty element', /closure-uncertainty/.test(markup), false);
// The window itself must survive — it still decides the countdown's precision.
check('window still computed for an upcoming period', typeof upcoming[0].window.halfWidthSecs, 'number');

console.log('\nUpcoming closures read as a range\n');
check('start — end in the header',
      /closure-time">(\d\d:\d\d) — (\d\d:\d\d)</.test(C.cardHtml(upcoming[0], new Date(T0))), true);

console.log();
if (fail > 0) { console.error(`${fail} FAILED, ${pass} passed`); process.exit(1); }
console.log(`All ${pass} checks passed.`);
