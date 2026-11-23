'use strict';

// The berth tracker (src/berth-first/tracker.js) on REAL cases, cut unchanged from the logs into
// test/fixtures/berth-first/, replayed through the REAL td-listener (processMessage) by the replay
// adapter (tools/lib/replay-feed.js), as the live service would receive them. berth-first-v1-plan §6
// step 3: the hand-over, reminder descriptions, the same headcode twice, "****", the 3S93 reversal;
// plus what building the route-learning tool found in the feed (the same step reported by two areas,
// advance descriptions, a hand-over split across a second, steps of one second logged in reverse).

const fs = require('fs');
const os = require('os');
const path = require('path');
const td = require('../src/td-listener');
const { BerthTracker, kindOf } = require('../src/berth-first/tracker');
const { compileRoutes } = require('../src/berth-first/routes');
const { framesFromLines } = require('../tools/lib/replay-feed');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}\n          got:      ${a}\n          expected: ${e}`); fail++; }
}

const FIX = path.join(__dirname, 'fixtures', 'berth-first');
const routesOf = id => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'crossings', `${id}.routes.json`), 'utf8'));
const portslade = compileRoutes(routesOf('portslade'));
const yapton = compileRoutes(routesOf('yapton'));

// The listener writes its logs; send them to a scratch folder.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'berth-tracker-'));
td._setLogFilesForTest({ td: a => path.join(tmp, `td-${a}.jsonl`), cclass: a => path.join(tmp, `cc-${a}.jsonl`),
  survey: () => path.join(tmp, 'survey.jsonl'), tdAll: () => path.join(tmp, 'td-all.jsonl') });
let current = null;
td.on('berth', e => { if (current) current.event(e); });

// Replay one fixture into a fresh tracker; returns it with every event it reported.
function replay(file, { areas, routes = null, preferArea = null }) {
  const lines = fs.readFileSync(path.join(FIX, file), 'utf8').split('\n').filter(Boolean).slice(1).map(JSON.parse);
  const events = [];
  const tr = new BerthTracker({ sameBerths: routes ? routes.sameBerths : [], preferArea: preferArea || (routes && routes.preferArea),
    knownSteps: routes ? routes.steps : [],
    onEvent: ev => events.push(ev) });
  td._setCrossingAreasForTest(areas);
  current = tr;
  const quiet = console.log; console.log = () => {};
  try { for (const f of framesFromLines(lines)) td._processMessageForTest(f.body); }
  finally { console.log = quiet; current = null; }
  tr.events = events;
  return tr;
}
const iso = t => new Date(t).toISOString().slice(11, 19);
const keys = e => e.path.map(p => p[0]);
const trainsLabelled = (tr, label) => tr.trains().filter(e => e.label === label);
const movedEver = (tr, label) => { const ids = new Set(); for (const ev of tr.events) if (ev.type === 'train' && ev.entry.label === label) ids.add(ev.entry.id); return ids; };

console.log('\n-- kinds come from the fields, not the label (logs before 2026-11-21 have CB and CC swapped)');
check('from+to is a step, from a cancel, to an interpose', [kindOf({ from: 'A', to: 'B' }), kindOf({ from: 'A' }), kindOf({ to: 'B' })], ['step', 'cancel', 'interpose']);

console.log('\n-- routes.js: the learned routes, for the engine');
check('shared berths are named by the crossing\'s own area', [portslade.canon('TB:0682'), portslade.canon('TB:N001'), portslade.canon('LA:0003')], ['LA:T682', 'LA:0001', 'LA:0003']);
check('Portslade clear steps', portslade.clears.map(c => `${c.dir} ${c.from}>${c.to}`), ['east LA:0004>LA:0002', 'west LA:0005>LA:0007']);
check('westbound berths from the clear step', ['LA:0005', 'LA:0003', 'LA:0001', 'LA:T677', 'LA:T682', 'TB:0673'].map(k => portslade.onRoute(k).west), [0, 1, 2, 3, 4, 5]);
check('heading: 0001>T681 is away from the crossing, T681>0001 towards it', [portslade.heading('west', 'LA:0001', 'LA:T681'), portslade.heading('west', 'LA:T681', 'LA:0001')], [-1, 1]);
check('Yapton: BM names the berths it shares with LA', [yapton.canon('LA:0041'), yapton.canon('LA:A027'), yapton.clears.map(c => `${c.dir} ${c.from}>${c.to}`).join(', ')],
  ['BM:L041', 'BM:A027', 'up BM:BH72>BM:AR12, down BM:BH73>BM:BH75']);

console.log('\n-- 1B42 21 Nov: hand-over inside LA, interpose and cancel in one second (insight 1)');
{
  const tr = replay('handover-1B42-2026-11-21.jsonl', { areas: ['LA'] });
  const t = trainsLabelled(tr, '1B42');
  check('one train 1B42, from AM12 through the hand-over to BH71', t.map(keys), [['LA:AM12', 'LA:A001', 'LA:A003', 'LA:A005', 'LA:A007', 'LA:BH71']]);
  check('described at AM12 at 16:56:38 (advance), a train only from the hand-over at 17:01:04 (decision 1)',
    [t[0] && t[0].born.kind, t[0] && iso(t[0].born.t), iso((tr.events.find(e => e.type === 'train' && e.entry.label === '1B42') || {}).t)], ['interpose', '16:56:38', '17:01:04']);
  check('the hand-over is counted, no train started from nowhere for it', [tr.stats.handovers >= 1, tr.events.filter(e => e.type === 'train' && e.entry.label === '1B42').length], [true, 1]);
}

console.log('\n-- 1C04 23 Jun: a hand-over split across a second, LA and BM both tracking (own logs)');
{
  const tr = replay('split-handover-1C04-2026-06-23.jsonl', { areas: ['LA', 'BM'], routes: yapton });
  const t = trainsLabelled(tr, '1C04');
  check('one train, not two: BM\'s history kept, LA\'s copy merged where the berths are shared', t.map(keys),
    [['BM:H987', 'BM:H989', 'BM:A001', 'BM:A003', 'BM:A005', 'BM:A007', 'BM:BH71', 'BM:BH73', 'BM:BH75', 'BM:BH77']]);
  check('it crossed Yapton (down clear step BH73>BH75)', t[0] && keys(t[0]).join(' ').includes('BM:BH73 BM:BH75'), true);
  check('merged once, nothing left behind in LA', [tr.stats.twins >= 1, tr.entries().filter(e => e.label === '1C04').length], [true, 1]);
}

console.log('\n-- 1H18 20 Nov: the same step reported by TB and LA, three steps in one second (national log)');
{
  const tr = replay('same-step-1H18-2026-11-20.jsonl', { areas: ['TB', 'LA'], routes: portslade });
  const t = trainsLabelled(tr, '1H18');
  check('one train from Preston Park through Hove (named by LA) to the crossing', [t.length, t[0] && keys(t[0]).join(' ').includes('TB:0425 TB:0675 LA:T682 LA:T677 LA:0001 LA:0003 LA:0005 LA:0007')], [1, true]);
  check('first seen at the cut-out\'s start in TB; the other area\'s reports were echoes, no second copy', [t[0] && t[0].born.key, tr.stats.echoes >= 2, tr.stats.fromEmpty, tr.entries().filter(e => e.label === '1H18').length], ['TB:0401', true, 1, 1]);
}

console.log('\n-- 2S02 20 Nov: Brighton start, TB/LA same steps, BM described in advance, to Yapton (national log)');
{
  const tr = replay('advance-2S02-2026-11-20.jsonl', { areas: ['TB', 'LA', 'BM'], routes: yapton });
  const t = trainsLabelled(tr, '2S02');
  const p = t[0] ? keys(t[0]) : [];
  check('one train, described at Brighton F663 at 02:02, a train from its first step at 05:00:30', [t.length, t[0] && t[0].born.key, t[0] && iso(t[0].born.t),
    iso((tr.events.find(e => e.type === 'train' && e.entry.label === '2S02') || {}).t)], [1, 'TB:F663', '02:02:39', '05:00:30']);
  check('its path runs through Portslade (LA 0005>0007) and on through BM\'s L041 to Yapton (BH73>BH75)',
    [p.join(' ').includes('LA:0005 LA:0007'), p.includes('BM:L041'), p.join(' ').includes('BM:BH73 BM:BH75')], [true, true, true]);
  check('BM\'s advance description and LA\'s late reports made no second train', [tr.entries().filter(e => e.label === '2S02').length, tr.stats.fromEmpty], [1, 0]);
}

console.log('\n-- 1N33 1 Oct: two steps of one second logged in reverse order (0203>0024 before 0026>0203)');
{
  const tr = replay('reversed-1N33-2026-10-01.jsonl', { areas: ['LA'] });
  const all = tr.entries().filter(e => e.label === '1N33');
  check('one train, crossing Portslade eastbound with its history unbroken', all.map(e => [keys(e)[0], keys(e).includes('LA:0203'), keys(e).join(' ').includes('LA:0004 LA:0002')]),
    [['LA:BH72', true, true]]);
  check('nothing stranded in 0203', tr.at('LA:0203').length, 0);
}

console.log('\n-- reminders 30 Sep/1 Oct: **** described into 0005 again and again; two step across the crossing');
{
  const tr = replay('reminders-0005-2026-10-01.jsonl', { areas: ['LA'] });
  const trainsMade = tr.events.filter(e => e.type === 'train' && e.entry.label === '****');
  check('a **** becomes a train only when it steps: twice, at 00:10:34 and 00:34:47', trainsMade.map(e => iso(e.t)), ['00:10:34', '00:34:47']);
  check('each crossed westbound (0005>0007) and is unidentified', trainsMade.map(e => [keys(e.entry).slice(0, 2).join('>'), e.entry.unidentified]), [['LA:0005>LA:0007', true], ['LA:0005>LA:0007', true]]);
  check('the repeated interposes never made more than one label in 0005', tr.events.filter(e => e.type === 'merge').length + tr.at('LA:0005').length <= 2, true);
}

console.log('\n-- 3S93 27 Oct: backs out of the westbound approach, then comes again and crosses');
{
  const tr = replay('reversal-3S93-2026-10-27.jsonl', { areas: ['LA'] });
  const t = tr.entries().filter(e => e.label === '3S93');
  const p = t[0] ? keys(t[0]) : [];
  check('one entry throughout', t.length, 1);
  check('its path: into 0001, back to T681, in again, across', p.slice(0, 7), ['LA:T681', 'LA:0001', 'LA:T681', 'LA:0001', 'LA:0003', 'LA:0005', 'LA:0007']);
  const steps = p.slice(0, 4).map((k, i, a) => i ? portslade.heading('west', a[i - 1], k) : null).slice(1);
  check('the routes tell its steps apart: towards, away (the reversal), towards', steps, [1, -1, 1]);
}

console.log('\n-- 1H56 20 Nov: the feed never sent 0003>0005 (D5: a skipped step moves the train forward)');
{
  const tr = replay('lost-step-1H56-2026-11-20.jsonl', { areas: ['TB', 'LA'], routes: portslade });
  const all = tr.entries().filter(e => e.label === '1H56');
  check('one train: the step out of 0005 is the train behind it in 0003, which skipped a berth', [all.length, all[0] && keys(all[0]).join(' ').includes('LA:0001 LA:0003 LA:0005 LA:0007'), all[0] && all[0].skipped], [1, true, 1]);
  check('no train from nowhere, none left in 0003', [tr.stats.fromEmpty - (all[0] && all[0].born.kind === 'stepFromEmpty' ? 1 : 0), tr.at('LA:0003').length], [0, 0]);
}

console.log('\n-- 1P75 19/20 Nov: one headcode, two trains (TB and B3) at the same time');
{
  const tr = replay('two-trains-1P75-2026-11-20.jsonl', { areas: ['TB', 'B3'], routes: yapton });
  const ids = movedEver(tr, '1P75');
  const byId = new Map(); for (const ev of tr.events) if (ev.entry && ids.has(ev.entry.id)) byId.set(ev.entry.id, ev.entry);
  const spans = [...byId.values()].map(e => ({ area: e.born.key.slice(0, 2), from: e.path[0][1], to: e.lastMove }));
  check('two trains, kept apart: never merged', [ids.size, tr.events.filter(e => e.type === 'merge' && e.entry.label === '1P75').length], [2, 0]);
  check('one in each area, both moving at the same time', [spans.map(s => s.area).sort(), Math.max(...spans.map(s => s.from)) < Math.min(...spans.map(s => s.to))], [['B3', 'TB'], true]);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
