'use strict';

// A whole service, in this process, on a loopback port: the real App, the real stompit, a local STOMP
// server standing in for NROD, reference files from the small fixtures, a hand-made CIF, and a clock
// the test controls. Fast timers (50 ms batches) so tests do not wait seconds.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { FakeStompServer } = require('../dev/fake-stomp-server');
const { App } = require('../src/app');
const stomp = require('../src/stomp');
const log = require('../src/log');
const H = require('./helpers');

const TOPIC = '/topic/TD_ALL_SIG_AREA';
const TRUST_TOPIC = '/topic/TRAIN_MVT_ALL_TOC', VSTP_TOPIC = '/topic/VSTP_ALL';
const NOW = Date.UTC(2026, 10, 2, 9, 44);       // Monday 2026-11-02 09:44 London (GMT)

const loc = (type, tiploc, arr, dep, pass, platform) => ({ location_type: type, tiploc_code: tiploc, ...(arr ? { arrival: arr } : {}), ...(dep ? { departure: dep } : {}), ...(pass ? { pass } : {}), ...(platform ? { platform } : {}) });
const sched = (uid, hc, locs, stp = 'P') => JSON.stringify({ JsonScheduleV1: {
  CIF_train_uid: uid, CIF_stp_indicator: stp, transaction_type: 'Create', atoc_code: 'SN', schedule_days_runs: '1111111', schedule_start_date: '2026-05-17', schedule_end_date: '2026-12-12', train_status: 'P',
  schedule_segment: { signalling_id: hc, CIF_train_category: 'OO', CIF_power_type: 'EMU', CIF_timing_load: '377', CIF_speed: '075', schedule_location: locs }
} });

/** 1H15 Littlehampton 09:30 -> London Victoria 11:15 via Southwick and Portslade. */
function writeCif(dir, extra = []) {
  const lines = ['{"JsonTimetableV1":{}}', ...extra, sched('C00001', '1H15', [loc('LO', 'LTLHMPT', null, '0930', null, '2'), loc('LI', 'STHWICK', '0941', '0942', null, '1'), loc('LI', 'PSLDAWH', '0945', '0946', null, '2'), loc('LT', 'VICTRIC', '1115', null, null, '14')])];
  fs.writeFileSync(path.join(dir, 'cif-latest.json.gz'), zlib.gzipSync(lines.join('\n') + '\n'));
}

async function startRig({ overrides = {}, cif = true, start = true, cifLines = [], track = null, forbidden = [], subs = 3 } = {}) {
  stomp._resetForTest();
  const cap = H.captureLog();
  const stompSrv = new FakeStompServer({ acceptAny: true, heartbeat: [0, 0], forbidden });
  const stompPort = await stompSrv.listen();
  const refDir = H.fixtureRefDir();
  if (cif) writeCif(refDir, cifLines);
  const dataDir = H.tmpDir('data-');
  const cfg = H.config({
    port: 0,
    http: { batchMs: 50, coarseIntervalSecs: 1, pingSecs: 1, maxSseClients: 3 },
    td: { backoffMinMs: 10, backoffMaxMs: 50, connectTimeoutMs: 1000 },
    reference: { minRows: { smart: 10, corpus: 10, naptan: 10, cif: 1 } },
    ...overrides
  });
  const clock = { now: NOW };
  const app = new App({ config: cfg, dataDir, fake: { host: '127.0.0.1', port: stompPort, refDir }, now: () => clock.now, tdSleep: ms => H.sleep(5), track });
  const rig = {
    app, stompSrv, refDir, dataDir, clock, cap,
    get port() { return app.port; },
    /** Publish C-Class events as one TD frame, timestamped with the rig clock. */
    td(events) {
      const items = events.map(([type, area, descr, from, to]) => ({ [`${type}_MSG`]: { area_id: area, descr, ...(from ? { from } : {}), ...(to ? { to } : {}), time: String(clock.now), msg_type: type } }));
      return stompSrv.publish(TOPIC, JSON.stringify(items));
    },
    /** Publish TRUST messages ({header, body} objects) as one frame. */
    trust(msgs) { return stompSrv.publish(TRUST_TOPIC, JSON.stringify(msgs)); },
    /** Publish one VSTP message (an object, or a raw string). */
    vstp(obj) { return stompSrv.publish(VSTP_TOPIC, typeof obj === 'string' ? obj : JSON.stringify(obj)); },
    /** Wait for the service to have applied everything published so far and rebuilt its snapshot. */
    async settle(ms = 150) { await H.sleep(ms); },
    async stop() {
      await app.stop();
      await stompSrv.close();
      H.rmrf(refDir); H.rmrf(dataDir);
      stomp._resetForTest();
      cap.restore(); log.resetForTest();
    }
  };
  if (start) {
    await app.start();
    await stompSrv.waitForSubscribe(subs);
  }
  return rig;
}

module.exports = { startRig, TOPIC, TRUST_TOPIC, VSTP_TOPIC, NOW, sched, loc };
