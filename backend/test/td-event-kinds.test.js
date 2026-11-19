'use strict';

// The three kinds of C-Class berth event, from the feed to the prediction state.
//
//   CA  step       description moves from `from` to `to`
//   CB  cancel     description removed from `from`   (the feed sends `from` only)
//   CC  interpose  description written into `to`     (the feed sends `to` only)
//
// Until 2026-11-20 td-listener had CB and CC the wrong way round (CLAUDE.md item 0b): every
// cancel reached the crossings as a sighting and blanked the train's position wherever it was,
// and every interpose was dropped. These tests pin the labelling at the listener, and what this
// engine does with each kind. Uses the real Portslade config so the berths are the live ones.

const fs = require('fs');
const os = require('os');
const path = require('path');
const td = require('../src/td-listener');
const CrossingState = require('../src/crossing-state');
require('../src/logger').logHeld = function () {};
const crossings = require('../src/crossing-definitions').loadCrossings();

let pass = 0, fail = 0;
function check(label, actual, expected) {
  if (actual === expected) { console.log(`  PASS  ${label}`); pass++; }
  else {
    console.log(`  FAIL  ${label}`);
    console.log(`          got:      ${actual}`);
    console.log(`          expected: ${expected}`);
    fail++;
  }
}

const cfg = crossings.portslade;
const day = '2026-10-23';
const at = hms => new Date(`${day}T${hms}.000Z`);

console.log('\nTD berth events: step, cancel, interpose\n');

// ---- 1. the listener labels each kind for what it is ----------------------------------------
console.log('  -- td-listener --');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'td-kinds-'));
  td._setLogFilesForTest({ td: () => path.join(tmp, 'td.jsonl'), tdAll: () => path.join(tmp, 'all.jsonl') });
  td._setCrossingAreasForTest(['LA']);
  const got = [];
  td.on('berth', e => got.push(e));
  const time = hms => String(at(hms).getTime());
  // Shapes exactly as the feed sends them (CB: no `to`; CC: no `from`; CT: no description).
  td._processMessageForTest(JSON.stringify([
    { CA_MSG: { area_id: 'LA', msg_type: 'CA', descr: '2P06', from: 'T677', to: '0001', time: time('04:26:54') } },
    { CC_MSG: { area_id: 'LA', msg_type: 'CC', descr: '2P06', to: 'T677', time: time('04:27:53') } },
    { CB_MSG: { area_id: 'LA', msg_type: 'CB', descr: '2P06', from: 'T677', time: time('04:27:57') } },
    { CT_MSG: { area_id: 'LA', msg_type: 'CT', report_time: '0428', time: time('04:28:00') } },
    { CA_MSG: { area_id: 'BM', msg_type: 'CA', descr: '1A01', from: '0008', to: '0006', time: time('04:28:01') } }
  ]));
  check('three events for the three LA messages that carry a description', got.length, 3);
  const line = e => `${e.event} ${e.headcode} ${e.from}>${e.to} ${e.ts.slice(11, 19)}`;
  check('the step is a CA, from and to', got[0] && line(got[0]), 'CA 2P06 T677>0001 04:26:54');
  check('the interpose is a CC, into `to`', got[1] && line(got[1]), 'CC 2P06 null>T677 04:27:53');
  check('the cancel is a CB, out of `from`', got[2] && line(got[2]), 'CB 2P06 T677>null 04:27:57');
  check('every event carries its area', got.every(e => e.area === 'LA'), true);
}

// ---- 2. what this engine does with each kind ---------------------------------------------------
console.log('  -- CrossingState.recordTdEvent --');
const ev = (event, headcode, from, to, hms) => ({ headcode, ts: at(hms).toISOString(), area: 'LA', event, from, to });

// The case that showed the bug, replayed from the LA log of 2026-10-23: 2P06 is standing in
// 0001 when a duplicate 2P06 description is interposed into T677 and cancelled 4 s later.
{
  const s = new CrossingState('portslade', cfg);
  s.recordTdEvent(ev('CC', '2P06', null, 'T677', '04:23:14'));
  s.recordTdEvent(ev('CA', '2P06', 'T677', '0001', '04:26:54'));
  s.recordTdEvent(ev('CC', '2P06', null, 'T677', '04:27:53'));
  s.recordTdEvent(ev('CB', '2P06', 'T677', null, '04:27:57'));
  const live = s.liveTrains.get('2P06');
  check('23 Oct 2P06: still in 0001 after a cancel at another berth', live && live.berth, '0001');
  check('23 Oct 2P06: lastSeen is still its step into 0001', live && live.lastSeen, at('04:26:54').getTime());
  check('23 Oct 2P06: first sighting is its first step, not the interpose',
    s.tdSeenToday.get('2P06') && s.tdSeenToday.get('2P06').toISOString(), at('04:26:54').toISOString());

  // Control: the same events the way they reached the state before (the cancel run through
  // the step recorders, the interposes dropped) lose the position. Proves this case can tell
  // the two behaviours apart.
  const old = new CrossingState('portslade', cfg);
  for (const e of [ev('CA', '2P06', 'T677', '0001', '04:26:54'), ev('CB', '2P06', 'T677', null, '04:27:57')]) {
    old.recordTdSighting(e.headcode, e.ts); old.recordTdBerth(e); old.recordTdClearStep(e); old.recordTdCloseStrike(e);
  }
  check('control: the old handling blanked the position', old.liveTrains.get('2P06').berth, null);
}

// A cancel at the berth we have the train in clears the position, and nothing else.
{
  const s = new CrossingState('portslade', cfg);
  s.recordTdEvent(ev('CA', '1H23', '0010', '0008', '10:00:00'));
  const before = s.liveTrains.get('1H23');
  check('cancel at its own berth: taken', s.recordTdEvent(ev('CB', '1H23', '0008', null, '10:05:00')), true);
  const live = s.liveTrains.get('1H23');
  check('cancel at its own berth: position cleared', live && live.berth, null);
  check('cancel at its own berth: lastSeen not refreshed', live && live.lastSeen, before.lastSeen);
  check('cancel at its own berth: history kept', live && live.history.map(h => h.berth).join(','), '0008');
  check('cancel at its own berth: the strike it made still stands', s.closeStrikeSeen.has('1H23|0008'), true);
}

// A cancel still counts as a sighting, as it always did in this engine, but places nothing.
// The case that matters, from the LA log of 2026-11-16: 1H08 is handed in from the fringe as an
// interpose into A001 and a cancel from AM12 in the same second, and steps 52 s later. The
// cancel is the moment it entered the area; the first sighting must not move to the step.
{
  const s = new CrossingState('portslade', cfg);
  s.recordTdEvent(ev('CC', '1H08', null, 'AM12', '09:06:58'));
  s.recordTdEvent(ev('CC', '1H08', null, 'A001', '09:09:09'));
  s.recordTdEvent(ev('CB', '1H08', 'AM12', null, '09:09:09'));
  check('16 Nov hand-over: first sighting is the cancel at the fringe',
    s.tdSeenToday.get('1H08') && s.tdSeenToday.get('1H08').toISOString(), at('09:09:09').toISOString());
  check('16 Nov hand-over: the cancel places nothing', s.liveTrains.has('1H08'), false);
  s.recordTdEvent(ev('CA', '1H08', 'A001', 'A003', '09:10:01'));
  check('16 Nov hand-over: placed by its first step', s.liveTrains.get('1H08').berth, 'A003');
  check('16 Nov hand-over: first sighting unchanged by the step',
    s.tdSeenToday.get('1H08').toISOString(), at('09:09:09').toISOString());
}

// An interpose is not used by this engine (see recordTdEvent): no sighting, position or strike.
{
  const s = new CrossingState('portslade', cfg);
  check('interpose: not taken', s.recordTdEvent(ev('CC', '2P06', null, 'T677', '04:24:56')), false);
  check('interpose: no sighting, position, strike or clear step',
    [s.tdSeenToday.size, s.liveTrains.size, s.closeStrikeSeen.size, s.clearStepSeen.size].join(','), '0,0,0,0');
  // A train already tracked keeps its position when its headcode is interposed elsewhere.
  s.recordTdEvent(ev('CA', '1N02', 'T677', '0001', '04:19:09'));
  s.recordTdEvent(ev('CC', '1N02', null, '0005', '04:19:30'));
  check('interpose of a tracked headcode elsewhere: position unchanged', s.liveTrains.get('1N02').berth, '0001');
}

// A cancel from another area is refused like any other event from another area.
{
  const s = new CrossingState('portslade', cfg);
  s.recordTdEvent(ev('CA', '1H23', '0010', '0008', '10:00:00'));
  check('cancel from another area: refused', s.recordTdEvent({ ...ev('CB', '1H23', '0008', null, '10:01:00'), area: 'BM' }), false);
  check('cancel from another area: position kept', s.liveTrains.get('1H23').berth, '0008');
}

// An event with no kind is a step, as callers sent before the kinds existed.
{
  const s = new CrossingState('portslade', cfg);
  const e = ev('CA', '1H23', '0010', '0008', '10:00:00'); delete e.event;
  check('no kind: taken as a step', s.recordTdEvent(e), true);
  check('no kind: placed like a step', s.liveTrains.get('1H23').berth, '0008');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
