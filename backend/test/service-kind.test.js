'use strict';

// Buses and ships never become closures, from either source, at any crossing (src/service-kind.js).
//
// Found 2026-11-11: rail-replacement buses (category BR, headcode 0B00) in the timetable were
// predicted as barrier closures — 237 on Saturday 7 Nov while the line was closed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isNonRailService } = require('../src/service-kind');
const { parseScheduleFile, applyUpdateExtract } = require('../src/schedule-parser');
const { parseRdmJson } = require('../src/ldb-poller');
const crossingsConfig = require('../src/crossing-definitions').loadCrossings();

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

const ALWAYS = { schedule_start_date: '2020-01-01', schedule_end_date: '2035-12-31', schedule_days_runs: '1111111' };
// A westbound-to-eastbound route through Portslade's timing points (Shoreham -> Hove).
const ROUTE = [
  { tiploc_code: 'LTLHMPT', departure: '0900', location_type: 'LO' },
  { tiploc_code: 'SHRHMBS', departure: '0930' },
  { tiploc_code: 'HOVE', arrival: '0940', departure: '0941' },
  { tiploc_code: 'BRGHTN', arrival: '0950', location_type: 'LT' }
];
function sched({ uid, headcode, stp = 'P', category = 'OO', status = 'P' }) {
  return { JsonScheduleV1: {
    transaction_type: 'Create', CIF_train_uid: uid, CIF_stp_indicator: stp, train_status: status, ...ALWAYS,
    atoc_code: 'SN',
    schedule_segment: { signalling_id: headcode, CIF_train_category: category, CIF_power_type: 'EMU',
      CIF_operating_characteristics: '', schedule_location: ROUTE }
  } };
}
function writeJsonl(name, records) {
  const p = path.join(os.tmpdir(), `rcx-sk-${name}-${process.pid}.jsonl`);
  fs.writeFileSync(p, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}
const uids = list => list.map(t => t.uid).sort().join(',');

(async () => {
  console.log('\nBuses and ships are never closures\n');

  console.log('  -- the rule --');
  check('category BR (replacement bus)', isNonRailService({ category: 'BR' }), true);
  check('category BS (timetabled bus)', isNonRailService({ category: 'BS' }), true);
  check('category SS (ship)', isNonRailService({ category: 'SS' }), true);
  check('status 5 (short-term bus)', isNonRailService({ status: '5' }), true);
  check('status B (permanent bus)', isNonRailService({ status: 'B' }), true);
  check('status 4 / S (ship)', isNonRailService({ status: '4' }) && isNonRailService({ status: 'S' }), true);
  check("board serviceType 'bus'", isNonRailService({ serviceType: 'bus' }), true);
  check('ordinary passenger train (OO, P)', isNonRailService({ category: 'OO', status: 'P' }), false);
  check('freight (EN, F)', isNonRailService({ category: 'EN', status: 'F' }), false);
  check('empty stock (EE)', isNonRailService({ category: 'EE' }), false);
  check('nothing known: a train', isNonRailService({}), false);

  console.log('  -- timetable, full parse --');
  const full = writeJsonl('full', [
    sched({ uid: 'T00001', headcode: '1N01' }),                                     // a train
    sched({ uid: 'B00001', headcode: '0B00', stp: 'N', category: 'BR', status: '5' }), // replacement bus
    sched({ uid: 'B00002', headcode: '0B00', category: 'BS', status: 'B' }),        // timetabled bus
    // A train whose day is taken over by a bus OVERLAY of the same UID. The overlay must
    // still win (so the train does not run) and then be dropped (so the bus is not a closure).
    sched({ uid: 'T00002', headcode: '1N02' }),
    sched({ uid: 'T00002', headcode: '0B00', stp: 'O', category: 'BR', status: '5' })
  ]);
  const log = console.log; let dropLine = '';
  console.log = (...a) => { const s = a.join(' '); if (/bus\/ship/.test(s)) dropLine = s; };
  const base = await parseScheduleFile(full, crossingsConfig);
  console.log = log;
  check('only the train survives', uids(base.portslade), 'T00001');
  check('the bus-replaced train is gone too (overlay won, then dropped)', base.portslade.some(t => t.uid === 'T00002'), false);
  check('the drop is logged', /dropped 3 bus\/ship/.test(dropLine), true);

  console.log('  -- timetable, daily update --');
  const upd = writeJsonl('upd', [
    sched({ uid: 'B00003', headcode: '0B00', stp: 'N', category: 'BR', status: '5' }),   // new bus
    sched({ uid: 'T00001', headcode: '0B00', stp: 'O', category: 'BR', status: '5' })    // T00001 bussed
  ]);
  console.log = () => {};
  const { trains: after } = await applyUpdateExtract(upd, crossingsConfig, base);
  console.log = log;
  check('a bus added by the update is not a closure', after.portslade.some(t => t.uid === 'B00003'), false);
  check('a train replaced by a bus in the update is gone', after.portslade.some(t => t.uid === 'T00001'), false);

  console.log('  -- departure board --');
  const svc = o => Object.assign({ trainid: '1N03', uid: 'T00003', sta: '2026-11-07T09:35:00', std: '2026-11-07T09:36:00',
    origin: [{ locationName: 'Littlehampton' }], destination: [{ locationName: 'Brighton' }], operator: 'SN' }, o);
  const board = parseRdmJson({ trainServices: [svc(), svc({ trainid: '0B00', uid: 'B1', category: 'BR' }),
    svc({ trainid: '0B00', uid: 'B2', serviceType: 'bus' }), svc({ trainid: '0B00', uid: 'B3', category: 'BS' })] });
  check('board keeps the train, drops all three buses', board.map(t => t.headcode).join(','), '1N03');

  console.log(`\n${pass} passed, ${fail} failed\n`);
  setImmediate(() => process.exit(fail ? 1 : 0));
})().catch(e => { console.error(e); process.exit(1); });
