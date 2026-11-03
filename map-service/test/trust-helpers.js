'use strict';

// Builders for TRUST and VSTP messages in the documented wire shapes, and a small timetable world
// whose answers are known. Times: Monday 2026-11-02, London = UTC (GMT).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { buildCifIndex, targetDays } = require('../src/cif-index');
const { london } = require('../src/time');
const { tmpDir, rmrf } = require('./helpers');

const DAY = '2026-11-02';
const DAYNUM = Math.round(Date.UTC(2026, 10, 2) / 86400000);
const at = (h, m, s = 0) => Date.UTC(2026, 10, 2, h, m, s);
const NOW = at(9, 44);

// TIPLOC -> STANOX, as in the CORPUS fixture.
const STANOX = { LTLHMPT: 86471, STHWICK: 87988, PSLDAWH: 87986, ALDTON: 87985, VICTRIC: 87201, BRGHTN: 87980, ASHFKY: 89428, SPHS: 89326, HEADCRN: 89323, PLUCKLY: 89321, MIDPASS: 87990, LONELY: 90001 };
const CRS = new Set(['LTLHMPT', 'STHWICK', 'PSLDAWH', 'VICTRIC', 'BRGHTN', 'ASHFKY', 'SPHS', 'HEADCRN', 'PLUCKLY']);
const AREAS = new Map([
  ['LA', new Set([86471, 87988, 87986, 87985, 87980])],
  ['A2', new Set([89428, 89326, 89323, 89321])],
  ['ZZ', new Set([90001])]
]);

const loc = (type, tiploc, arr, dep, pass, platform) => ({ location_type: type, tiploc_code: tiploc, ...(arr ? { arrival: arr } : {}), ...(dep ? { departure: dep } : {}), ...(pass ? { pass } : {}), ...(platform ? { platform } : {}) });
const sched = ({ uid, hc, locs, stp = 'P', start = '2026-05-17', end = '2026-12-12', days = '1111111', toc = 'SN' }) => JSON.stringify({ JsonScheduleV1: {
  CIF_train_uid: uid, CIF_stp_indicator: stp, transaction_type: 'Create', atoc_code: toc, schedule_days_runs: days, schedule_start_date: start, schedule_end_date: end, train_status: 'P',
  schedule_segment: locs ? { signalling_id: hc, CIF_train_category: 'OO', CIF_power_type: 'EMU', CIF_timing_load: '377', CIF_speed: '075', schedule_location: locs } : undefined
} });

/** Littlehampton 09:30 -> Southwick 09:41/42 -> Portslade 09:45/46 -> Victoria 11:15. */
const LA_ROUTE = [loc('LO', 'LTLHMPT', null, '0930', null, '2'), loc('LI', 'STHWICK', '0941', '0942', null, '1'), loc('LI', 'PSLDAWH', '0945', '0946', null, '2'), loc('LT', 'VICTRIC', '1115', null, null, '14')];
/** Ashford 09:20 -> Staplehurst 09:40/41 -> Headcorn (pass 09:50) -> Pluckley 09:55/56 -> ... */
const KENT_ROUTE = [loc('LO', 'ASHFKY', null, '0920', null, '3'), loc('LI', 'SPHS', '0940', '0941', null, '1'), loc('LI', 'HEADCRN', null, null, '0950'), loc('LI', 'PLUCKLY', '0955', '0956', null, '2'), loc('LT', 'ASHFKY', '1030', null, null, '4')];

async function buildIdx(lines, nowMs = NOW) {
  const dir = tmpDir();
  try {
    const f = path.join(dir, 'cif.json.gz');
    fs.writeFileSync(f, zlib.gzipSync(['{"JsonTimetableV1":{}}', ...lines].join('\n') + '\n'));
    return await buildCifIndex(f, { dayNums: targetDays(nowMs) });
  } finally { rmrf(dir); }
}

/** The context TrustState and progress.derive want, over `cif`. */
const ctxFor = cif => ({
  cif, areaStanox: AREAS,
  stanoxOf: t => STANOX[t] || 0,
  tiplocsOfStanox: sx => Object.keys(STANOX).filter(k => STANOX[k] === sx),
  isStation: t => CRS.has(t)
});

// ---- TRUST messages -----------------------------------------------------------------------------------------

const trainId = (hc, dd = '02', prefix = '86', mid = 'MY') => `${prefix}${hc}${mid}${dd}`;     // 10 chars: 2 + headcode + 2 + day of month

const activation = ({ id, uid, originStanox, depMs, schedType = 'O', extra = {} }) => ({
  header: { msg_type: '0001', source_dev_id: '', user_id: '', original_data_source: 'SDR', msg_queue_timestamp: String(NOW), source_system_id: 'TRUST' },
  body: { schedule_source: 'C', train_file_address: null, schedule_end_date: '2026-12-12', train_id: id, tp_origin_timestamp: DAY, tp_origin_stanox: String(originStanox), origin_dep_timestamp: String(depMs),
    train_service_code: '24673000', toc_id: '84', d1266_record_number: '00000', train_call_type: 'AUTOMATIC', train_uid: uid, train_call_mode: 'NORMAL', schedule_type: schedType,
    sched_origin_stanox: String(originStanox), schedule_wtt_id: `${id.slice(2, 6)}M`, schedule_start_date: '2026-05-17', ...extra }
});

const movement = ({ id, stanox, evt = 'DEPARTURE', actual, planned, variation = 0, status, platform = ' ', terminated = false, offroute = false, extra = {} }) => ({
  header: { msg_type: '0003', source_dev_id: '', user_id: '', original_data_source: 'SDR', msg_queue_timestamp: String(actual), source_system_id: 'TRUST' },
  body: { event_type: evt, gbtt_timestamp: String(planned), original_loc_stanox: '', planned_timestamp: String(planned), timetable_variation: String(Math.abs(variation)), original_loc_timestamp: '',
    current_train_id: '', delay_monitoring_point: 'true', next_report_run_time: '1', reporting_stanox: String(stanox), actual_timestamp: String(actual), correction_ind: 'false', event_source: 'AUTOMATIC',
    train_file_address: null, platform, division_code: '84', train_terminated: String(terminated), train_id: id, offroute_ind: String(offroute),
    variation_status: status || (variation > 0 ? 'LATE' : variation < 0 ? 'EARLY' : 'ON TIME'), train_service_code: '24673000', toc_id: '84', loc_stanox: String(stanox), auto_expected: 'true',
    direction_ind: 'UP', route: '', planned_event_type: evt, next_report_stanox: '', line_ind: '', ...extra }
});

const cancellation = ({ id, stanox, type = 'ON CALL', extra = {} }) => ({
  header: { msg_type: '0002' }, body: { train_file_address: null, train_service_code: '24673000', orig_loc_stanox: '', toc_id: '84', dep_timestamp: String(NOW), division_code: '84', loc_stanox: String(stanox), canx_timestamp: String(NOW),
    canx_reason_code: 'YI', train_id: id, orig_loc_timestamp: '', canx_type: type, ...extra }
});
const reinstatement = ({ id, stanox }) => ({ header: { msg_type: '0005' }, body: { train_id: id, current_train_id: '', loc_stanox: String(stanox), toc_id: '84', dep_timestamp: String(NOW), division_code: '84', train_file_address: null, train_service_code: '24673000', original_loc_stanox: '', original_loc_timestamp: '' } });
const changeOrigin = ({ id, stanox }) => ({ header: { msg_type: '0006' }, body: { train_id: id, loc_stanox: String(stanox), reason_code: 'XX', dep_timestamp: String(NOW), toc_id: '84', division_code: '84', train_file_address: null, train_service_code: '24673000', orig_loc_stanox: '', original_loc_timestamp: '', coo_timestamp: String(NOW) } });
const changeIdentity = ({ id, revised }) => ({ header: { msg_type: '0007' }, body: { train_id: id, revised_train_id: revised, event_timestamp: String(NOW), train_file_address: null, train_service_code: '24673000', toc_id: '84' } });

// ---- VSTP --------------------------------------------------------------------------------------------------------

const vloc = (tiploc, { arr = '', dep = '', pass = '', platform = '' } = {}) => ({
  scheduled_arrival_time: arr, scheduled_pass_time: pass, scheduled_departure_time: dep, public_arrival_time: arr.slice(0, 4), public_departure_time: dep.slice(0, 4),
  CIF_platform: platform, CIF_line: '', CIF_path: '', CIF_activity: '', location: { tiploc: { tiploc_id: tiploc } }
});
const vstpCreate = ({ uid, hc, stp = 'N', start = DAY, end = DAY, days = '1111111', locs, toc = 'SN', extraSchedule = {} }) => ({ VSTPCIFMsgV1: {
  schemaLocation: 'x', classification: 'industry', timestamp: String(NOW), owner: 'Network Rail', Sender: { organisation: 'Rail Delivery Group', application: 'TSIA', component: 'TSIA' },
  Schedule: { transaction_type: 'Create', schedule_id: `${uid}${start}${stp}`, schedule_start_date: start, schedule_end_date: end, schedule_days_runs: days, applicable_timetable: 'Y', CIF_bank_holiday_running: '',
    CIF_train_uid: uid, train_status: '1', CIF_stp_indicator: stp, ...extraSchedule,
    schedule_segment: { signalling_id: hc, uic_code: '', atoc_code: toc, CIF_train_category: 'XX', CIF_headcode: '', CIF_course_indicator: 1, CIF_train_service_code: '', CIF_business_sector: '', CIF_power_type: 'EMU', CIF_timing_load: null, CIF_speed: '075',
      CIF_operating_characteristics: '', CIF_train_class: '', CIF_sleepers: '', CIF_reservations: '', CIF_connection_indicator: '', CIF_catering_code: '', CIF_service_branding: '', schedule_location: locs } } } });
const vstpDelete = ({ uid, start = DAY, end = DAY, stp = 'N' }) => ({ VSTPCIFMsgV1: { Schedule: { transaction_type: 'Delete', schedule_id: `${uid}${start}${stp}`, schedule_start_date: start, schedule_end_date: end, CIF_train_uid: uid, CIF_stp_indicator: stp } } });

module.exports = {
  DAY, DAYNUM, at, NOW, STANOX, CRS, AREAS, loc, sched, LA_ROUTE, KENT_ROUTE, buildIdx, ctxFor,
  trainId, activation, movement, cancellation, reinstatement, changeOrigin, changeIdentity, vloc, vstpCreate, vstpDelete, london
};
