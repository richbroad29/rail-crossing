'use strict';

// B1 — live-position map + GET /crossing/:id/live.
//
// Asserts the constraints Rich set:
//   - direction from the headcode→LDB/CIF join; "unknown" if no match (never
//     guessed from raw berths);
//   - stopping = true only if the train is on the PLD LDB board; otherwise
//     "unknown" — never false;
//   - latest berth (the `to` of the most recent step) wins;
//   - entries past the TTL are pruned;
//   - the endpoint returns the list plus serverTime + ttlSecs.

const http = require('http');
const CrossingState = require('../src/crossing-state');
const { createApi } = require('../src/api');

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
function checkTruthy(label, actual) {
  if (actual) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label} (got: ${actual})`); fail++; }
}

const cfg = {
  name: 'Test Crossing', road: 'Test Rd',
  td: { area: 'LA' },
  live: { ttlSecs: 240 },
  timing: { closeBefore: { east: 1.5, west: 2.5 }, openAfter: { east: 0.5, west: 0.5 }, consecutiveWindow: 1.5 }
};

const BASE = 1_750_000_000_000; // fixed reference instant (ms)

function freshState() {
  const s = new CrossingState('portslade', cfg);
  // A CIF-known freight (not on the LDB board) and an LDB passenger (on board).
  s.scheduleTrains = [{ headcode: '6O12', direction: 'east', origin: 'EASTLEIGH', destination: 'VICTORIA' }];
  s.ldbTrains = [{ headcode: '2W20', direction: 'west', origin: 'BRIGHTON', destination: 'SOUTHAMPTON' }];
  return s;
}

console.log('\nB1 — live-position map\n');

{
  const s = freshState();
  s.recordTdBerth({ headcode: '6O12', ts: BASE, event: 'CA', from: '0006', to: '0004' });
  s.recordTdBerth({ headcode: '2W20', ts: BASE, event: 'CA', from: '0003', to: '0005' });
  s.recordTdBerth({ headcode: '9Z99', ts: BASE, event: 'CB', from: 'A010', to: 'A035' });
  s.recordTdBerth({ headcode: '5S00', ts: BASE - 10 * 60000, event: 'CA', from: '0001', to: '0002' }); // stale

  const live = s.getLiveTrains(BASE);
  const byHc = Object.fromEntries(live.map(t => [t.headcode, t]));

  // CIF-matched freight: direction from schedule, NOT on board → stopping "unknown" (never false).
  checkTruthy('6O12 present', byHc['6O12']);
  check('6O12 direction from CIF join', byHc['6O12'] && byHc['6O12'].direction, 'east');
  check('6O12 stopping is "unknown" (not on board)', byHc['6O12'] && byHc['6O12'].stopping, 'unknown');
  check('6O12 stopping is never false', byHc['6O12'] && byHc['6O12'].stopping === false, false);
  check('6O12 berth = latest step `to`', byHc['6O12'] && byHc['6O12'].berth, '0004');
  check('6O12 fromBerth', byHc['6O12'] && byHc['6O12'].fromBerth, '0006');

  // LDB-matched passenger: direction from LDB, on board → stopping true.
  check('2W20 direction from LDB join', byHc['2W20'] && byHc['2W20'].direction, 'west');
  check('2W20 stopping true (on PLD board)', byHc['2W20'] && byHc['2W20'].stopping, true);

  // No CIF/LDB match → direction "unknown" (not guessed from the A0xx berth).
  checkTruthy('9Z99 present (unknown train)', byHc['9Z99']);
  check('9Z99 direction "unknown" (no match)', byHc['9Z99'] && byHc['9Z99'].direction, 'unknown');
  check('9Z99 stopping "unknown"', byHc['9Z99'] && byHc['9Z99'].stopping, 'unknown');

  // Stale for DISPLAY — filtered out of the response.
  check('5S00 pruned past TTL', '5S00' in byHc, false);
  // ...but STILL IN THE MAP. This assertion used to be `s.liveTrains.size === 3`, i.e. it
  // asserted that serving the endpoint deleted it. That was register #14: getLiveTrains is
  // a read, the CLOSED gate (_upstreamOfAnchor) reads the same map on a much longer horizon,
  // and the observer polls /live every 2.5s — so serving the observer destroyed the position
  // evidence the gate needed, and the app fired CLOSED with no trigger. Whether it did so
  // depended on whether anyone had the observer open.
  check('the read does NOT mutate the map', s.liveTrains.size, 4);
  checkTruthy('5S00 still remembered for the CLOSED gate', s.liveTrains.has('5S00'));
  // Pruning happens on the WRITE path instead, at the longest horizon any reader uses
  // (max of the display TTL and the 20-min strike TTL).
  s.recordTdBerth({ headcode: '1A11', ts: BASE + 25 * 60000, event: 'CA', from: '0006', to: '0004' });
  check('a later write prunes past the 20-min horizon', s.liveTrains.has('5S00'), false);
  checkTruthy('...and keeps the entry that wrote it', s.liveTrains.has('1A11'));
}

// Latest berth wins on a subsequent step.
{
  const s = freshState();
  s.recordTdBerth({ headcode: '6O12', ts: BASE, event: 'CA', from: '0006', to: '0004' });
  s.recordTdBerth({ headcode: '6O12', ts: BASE + 1000, event: 'CA', from: '0004', to: '0002' });
  const t = s.getLiveTrains(BASE + 1000).find(x => x.headcode === '6O12');
  check('berth updates to most recent `to`', t && t.berth, '0002');
  check('fromBerth updates too', t && t.fromBerth, '0004');
  check('lastSeen is the later step', t && t.lastSeen, BASE + 1000);
}

// Berth-strike history accumulates (deduped, ordered, ISO ts) and surfaces on the
// live train; the four LDB times (schedArr/schedDep/liveArr/liveDep) pass through the join.
{
  const s = new CrossingState('portslade', cfg);
  s.ldbTrains = [{ headcode: '2W20', direction: 'west', origin: 'BRIGHTON', destination: 'SOUTHAMPTON',
                   schedArr: '20:18', schedDep: '20:20', liveArr: '20:20', liveDep: '20:22' }];
  s.recordTdBerth({ headcode: '2W20', ts: BASE, event: 'CA', from: 'T677', to: '0001' });
  s.recordTdBerth({ headcode: '2W20', ts: BASE + 1000, event: 'CA', from: '0001', to: '0001' }); // dup berth → ignored
  s.recordTdBerth({ headcode: '2W20', ts: BASE + 2000, event: 'CA', from: '0001', to: '0003' });
  const t = s.getLiveTrains(BASE + 2000).find(x => x.headcode === '2W20');

  checkTruthy('history present as array', t && Array.isArray(t.history));
  check('history deduped to 2 strikes', t && t.history.length, 2);
  check('history[0] berth', t && t.history[0].berth, '0001');
  check('history[0] ts is ISO of the strike', t && t.history[0].ts, new Date(BASE).toISOString());
  check('history[1] berth (latest)', t && t.history[1].berth, '0003');
  check('schedArr passes through from LDB join', t && t.schedArr, '20:18');
  check('schedDep passes through', t && t.schedDep, '20:20');
  check('liveArr passes through', t && t.liveArr, '20:20');
  check('liveDep passes through', t && t.liveDep, '20:22');
}

// No LDB/CIF match → the four times are null; history still present.
{
  const s = new CrossingState('portslade', cfg);
  s.recordTdBerth({ headcode: '9Z99', ts: BASE, event: 'CB', from: 'A010', to: 'A035' });
  const t = s.getLiveTrains(BASE).find(x => x.headcode === '9Z99');
  check('unmatched train: schedDep null', t && t.schedDep, null);
  check('unmatched train: history is an array', t && Array.isArray(t.history), true);
}

// Endpoint shape over real HTTP.
(async () => {
  const s = freshState();
  s.recordTdBerth({ headcode: '2W20', ts: Date.now(), event: 'CA', from: '0003', to: '0005' });
  const server = createApi({ portslade: s }, 0);
  await new Promise(r => (server.listening ? r() : server.once('listening', r)));
  const port = server.address().port;

  const body = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/crossing/portslade/live`, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
  server.close();

  console.log('\nB1 — GET /crossing/:id/live\n');
  check('area echoed', body.area, 'LA');
  check('ttlSecs from config', body.ttlSecs, 240);
  check('serverTime is a number', typeof body.serverTime, 'number');
  check('trains is an array', Array.isArray(body.trains), true);
  check('endpoint lists the live train', body.trains.some(t => t.headcode === '2W20'), true);

  console.log();
  if (fail > 0) { console.error(`${fail} FAILED, ${pass} passed`); process.exit(1); }
  else { console.log(`All ${pass} tests passed.`); }
})().catch(err => { console.error('Test runner error:', err); process.exit(1); });
