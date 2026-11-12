'use strict';
// The headcode-class rule shared by the board and the timetable (src/train-type.js), and that
// both readers actually use it (bug b, 2026-11-12: 4xxx/8xxx/0xxx were timed as passenger).
const { trainTypeOf } = require('../src/train-type');
let pass = 0, fail = 0;
const check = (label, got, want) => {
  if (got === want) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}: got ${got}, want ${want}`); fail++; }
};
for (const [hc, want] of [['0Z12', 'freight'], ['4O27', 'freight'], ['6M40', 'freight'], ['7Y31', 'freight'],
  ['8Y91', 'freight'], ['5H97', 'ecs'], ['3S93', 'test'], ['1H96', 'passenger'], ['2T94', 'passenger'],
  ['9O12', 'passenger'], ['', 'passenger'], [null, 'passenger'], [undefined, 'passenger']]) {
  check(`${hc} -> ${want}`, trainTypeOf(hc), want);
}
check('CIF category EE is ecs whatever the headcode', trainTypeOf('2T94', 'EE'), 'ecs');
check('category DD (departmental) is read by headcode', trainTypeOf('8Y91', 'DD'), 'freight');

// The timetable reader uses it (extractTrainFields is internal, so go through a one-record parse).
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const { parseScheduleFile } = require('../src/schedule-parser');
const loc = (tiploc, t) => ({ tiploc_code: tiploc, pass: t });
const rec = (uid, hc) => JSON.stringify({ JsonScheduleV1: {
  CIF_train_uid: uid, CIF_stp_indicator: 'P', transaction_type: 'Create', schedule_days_runs: '1111111', train_status: 'P',
  schedule_start_date: '2020-01-01', schedule_end_date: '2099-12-31', atoc_code: 'ZZ',
  schedule_segment: { signalling_id: hc, CIF_train_category: 'DD', schedule_location: [
    loc('SHRHMBS', '1000'), loc('HOVE', '1010')] } } });
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tt-')), 'cif.json.gz');
fs.writeFileSync(file, zlib.gzipSync([rec('T00001', '8Y91'), rec('T00002', '0Z12'), rec('T00003', '4O27')].join('\n')));
const def = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'crossings', 'portslade.json'), 'utf8'));
(async () => {
  const log = console.log; console.log = () => {};
  const out = await parseScheduleFile(file, { portslade: def });
  console.log = log;
  const byHc = Object.fromEntries(out.portslade.map(t => [t.headcode, t.trainType]));
  check('timetable: 8Y91 parsed as freight', byHc['8Y91'], 'freight');
  check('timetable: 0Z12 parsed as freight', byHc['0Z12'], 'freight');
  check('timetable: 4O27 parsed as freight', byHc['4O27'], 'freight');
  console.log();
  if (fail) { console.error(`${fail} FAILED, ${pass} passed`); process.exit(1); }
  console.log(`All ${pass} tests passed.`);
})();
