'use strict';
// Berth-first timing.js, BERTH-FIRST (4): the overlap re-check (_coalesceOverlapping) applies register #20 per TRAIN.
//   A. 25 Nov 11:14:48 as it happened: 2Y24w's closure runs to 11:15:40; the next period holds 1H25e (held: a lower
//      bound), 1S23e (struck 11:13:41) and 1N26w. 1S23e's real close lies inside 2Y24w's closure, so the two are one
//      closure. The original skipped the whole period because 1H25e was held, and the page showed two "Now" rows.
//   B. Register #20 itself is kept: a period of held trains alone is never joined on its bound, however early.
//   C. A held train's bound inside the previous closure, its neighbour's real close after it: not joined (the only
//      close inside is a bound).
//   D. No held train: the original #15 join, unchanged.
//   E. The live engine (crossing-state.js) is not changed: it still skips a period with any held train.
// usage: node test/berth-coalesce.test.js
const fs = require('fs');
const path = require('path');

const RealDate = Date; let NOW = 0;
class FakeDate extends RealDate { constructor(...a) { if (a.length === 0) super(NOW); else super(...a); } static now() { return NOW; } }
global.Date = FakeDate;
const quiet = fn => { const w = console.warn, l = console.log; console.warn = console.log = () => {}; try { return fn(); } finally { console.warn = w; console.log = l; } };

require('../src/logger').logHeld = function () {};
const ClosureTiming = quiet(() => require('../src/berth-first/timing'));
const CrossingState = quiet(() => require('../src/crossing-state'));
const def = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'crossings', 'portslade.json'), 'utf8'));

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}\n          got:      ${a}\n          expected: ${e}`); fail++; }
}
const at = s => new RealDate(`2026-11-25T${s}Z`);
NOW = at('11:14:50').getTime();
const now = new Date();

// One annotated train as _computeClosuresDirectional hands them to the re-check.
const ann = (headcode, direction, close, open, held = false) => ({
  train: { headcode, direction, trainType: 'passenger', source: 'ldbsv' },
  predClose: at(close), confClose: at(close), openPred: at(open), closeHeld: held, heldReason: held ? 'queued' : null
});
const shape = groups => groups.map(g => g.map(a => a.train.headcode + a.train.direction[0]).join('+'));
const run = (Engine, groups) => { const e = quiet(() => new Engine('portslade', def)); quiet(() => e._coalesceOverlapping(groups, now)); return shape(groups); };

console.log('A. 25 Nov 11:14:48');
check('1S23e struck inside 2Y24w\'s closure, beside held 1H25e: one closure',
  run(ClosureTiming, [[ann('2Y24', 'west', '11:13:46', '11:15:40')],
    [ann('1H25', 'east', '11:16:47', '11:20:55', true), ann('1S23', 'east', '11:13:41', '11:16:24'), ann('1N26', 'west', '11:18:20', '11:20:55')]]),
  ['2Y24w+1H25e+1S23e+1N26w']);

console.log('B. Register #20 kept');
check('a held train alone, its bound inside the previous closure: not joined',
  run(ClosureTiming, [[ann('2Y24', 'west', '11:13:46', '11:15:40')], [ann('1H25', 'east', '11:14:50', '11:19:15', true)]]),
  ['2Y24w', '1H25e']);
check('two held trains, both bounds inside: not joined',
  run(ClosureTiming, [[ann('2Y24', 'west', '11:13:46', '11:15:40')],
    [ann('1H25', 'east', '11:14:50', '11:19:15', true), ann('1N26', 'west', '11:15:00', '11:20:55', true)]]),
  ['2Y24w', '1H25e+1N26w']);

console.log('C. Only a bound inside');
check('held 1H25e inside, its neighbour\'s real close after the previous end: not joined',
  run(ClosureTiming, [[ann('2Y24', 'west', '11:13:46', '11:15:40')],
    [ann('1H25', 'east', '11:14:50', '11:19:15', true), ann('1N26', 'west', '11:30:00', '11:32:00')]]),
  ['2Y24w', '1H25e+1N26w']);

console.log('D. No held train');
check('a real close inside the previous closure: joined, as before',
  run(ClosureTiming, [[ann('2Y24', 'west', '11:13:46', '11:15:40')], [ann('1S23', 'east', '11:13:41', '11:16:24')]]),
  ['2Y24w+1S23e']);
check('a real close after it: not joined, as before',
  run(ClosureTiming, [[ann('2Y24', 'west', '11:13:46', '11:15:40')], [ann('1N19', 'east', '11:30:00', '11:33:00')]]),
  ['2Y24w', '1N19e']);

console.log('E. The live engine is not changed');
check('crossing-state.js still skips the 25 Nov period (any held train)',
  run(CrossingState, [[ann('2Y24', 'west', '11:13:46', '11:15:40')],
    [ann('1H25', 'east', '11:16:47', '11:20:55', true), ann('1S23', 'east', '11:13:41', '11:16:24'), ann('1N26', 'west', '11:18:20', '11:20:55')]]),
  ['2Y24w', '1H25e+1S23e+1N26w']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
