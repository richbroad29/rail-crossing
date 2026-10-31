'use strict';

// Live train map (proof of concept): berth-geo, train-map, map-services, the SMART stream
// parser, the /map API, and the isolation of the map from the crossing path.
//
// Planted answer: a synthetic eastbound chain in area LA, Shoreham → Hove, with SMART tying
// 0014 to Southwick (arrival) and 0006 to Portslade (departure). The three berths between them
// must land at exactly 1/4, 1/2 and 3/4 of the Southwick → Portslade chord once the live feed
// has stepped through them twice — and not before.
//
// Nothing here writes under data/: the TD isolation test uses a non-LA area, which the
// listener never logs.

const http = require('http');
const { Readable } = require('stream');
const { BerthGeo, bearingDeg, haversineM } = require('../src/berth-geo');
const { TrainMap } = require('../src/train-map');
const { MapServices } = require('../src/map-services');
const { parseSmartStream } = require('../src/smart-fetcher');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  if (actual === expected) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}\n          got:      ${actual}\n          expected: ${expected}`); fail++; }
}
function near(label, actual, expected, tol = 1e-6) {
  if (typeof actual === 'number' && Math.abs(actual - expected) <= tol) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}\n          got:      ${actual}\n          expected: ${expected} ±${tol}`); fail++; }
}

const STATIONS = {
  SSE: { name: 'Shoreham-By-Sea', lat: 50.834, lon: -0.271 },
  SWK: { name: 'Southwick', lat: 50.832471, lon: -0.237142 },
  FSG: { name: 'Fishersgate', lat: 50.834469, lon: -0.219161 },
  PLD: { name: 'Portslade', lat: 50.836044, lon: -0.204898 },
  HOV: { name: 'Hove', lat: 50.835206, lon: -0.17018 },
  BTN: { name: 'Brighton', lat: 50.82886, lon: -0.140739 },
  EDB: { name: 'Edinburgh', lat: 55.952, lon: -3.189 }
};
const STANOX = { '87001': 'SWK', '87002': 'PLD', '87003': 'HOV', '87004': 'BTN', '87900': null, '99999': 'EDB' };
const stanoxToCrs = s => (s in STANOX ? STANOX[s] : null);

const SMART = [
  { td: 'LA', from: '0016', to: '0014', stanox: '87001', event: 'A' },  // arrive Southwick → 0014 AT SWK
  { td: 'LA', from: '0006', to: '0004', stanox: '87002', event: 'D' },  // depart Portslade → 0006 AT PLD
  { td: 'LA', from: '0004', to: '0002', stanox: '87900', event: 'A' },  // a junction: no CRS, no anchor
  { td: 'LB', from: '0101', to: '0103', stanox: '87004', event: 'C' }   // next area: arrive Brighton → LB:0103
];

const at = (a, b, t) => ({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });

function freshGeo() {
  const g = new BerthGeo({ stations: STATIONS, interpolation: { maxHops: 14, minEdgeCount: 2 } });
  g.loadSmart(SMART, stanoxToCrs);
  return g;
}
const CHAIN = ['0016', '0014', '0012', '0010', '0008', '0006', '0004', '0002'];
function stepChain(g, times) {
  for (let n = 0; n < times; n++) for (let i = 0; i < CHAIN.length - 1; i++) g.observeEdge(`LA:${CHAIN[i]}`, `LA:${CHAIN[i + 1]}`);
}

(async () => {
  console.log('\nberth-geo — anchors\n');
  {
    const g = freshGeo();
    const p14 = g.position('LA', '0014');
    check('arrival anchors the step\'s TO berth at the station', p14 && p14.crs, 'SWK');
    check('...as placement "station"', p14 && p14.placement, 'station');
    const p06 = g.position('LA', '0006');
    check('departure anchors the step\'s FROM berth', p06 && p06.crs, 'PLD');
    check('the other side of a station step is only a hint, not an anchor', g.anchors.has('LA:0016'), false);
    check('a junction STANOX with no CRS anchors nothing', g.anchors.has('LA:0002'), false);
    check('areas are those with an anchored berth', g.stats().areas.join(','), 'LA,LB');
  }
  {
    const g = new BerthGeo({ stations: STATIONS });
    g.loadSmart([
      { td: 'LA', from: 'X1', to: 'X2', stanox: '87002', event: 'A' },
      { td: 'LA', from: 'X3', to: 'X2', stanox: '87002', event: 'A' },
      { td: 'LA', from: 'X4', to: 'X2', stanox: '87003', event: 'A' }
    ], stanoxToCrs);
    check('a berth claimed by two stations takes the most-named one, not the midpoint', g.position('LA', 'X2').crs, 'PLD');
  }

  console.log('\nberth-geo — interpolation (planted answer)\n');
  {
    const g = freshGeo();
    stepChain(g, 1);
    const once = g.position('LA', '0010');
    check('after ONE pass the learned edges are not trusted yet', once === null || once.placement !== 'interpolated', true);
    stepChain(g, 1);
    const want = { '0012': 0.25, '0010': 0.5, '0008': 0.75 };
    for (const [b, t] of Object.entries(want)) {
      const p = g.position('LA', b);
      const e = at(STATIONS.SWK, STATIONS.PLD, t);
      check(`${b} is interpolated after two passes`, p && p.placement, 'interpolated');
      near(`${b} lat at ${t} of SWK→PLD`, p && p.lat, e.lat);
      near(`${b} lon at ${t} of SWK→PLD`, p && p.lon, e.lon);
    }
    check('between names both stations', g.position('LA', '0010').between.join('>'), 'SWK>PLD');
  }
  {
    // Same station both sides: a reversing berth must not be "interpolated" onto itself.
    const g = freshGeo();
    for (let n = 0; n < 2; n++) { g.observeEdge('LA:0014', 'LA:R1'); g.observeEdge('LA:R1', 'LA:0014'); }
    const p = g.position('LA', 'R1');
    check('a berth with the same station both ways is approx, at that station', p && `${p.placement}/${p.crs}`, 'approx/SWK');
  }
  {
    const g = freshGeo();
    stepChain(g, 2);
    const saved = JSON.parse(JSON.stringify(g.serializeLearned()));
    const g2 = freshGeo();
    check('learned edges reload', g2.loadLearned(saved) > 0, true);
    near('a reloaded graph places berths the same', g2.position('LA', '0010').lat, g.position('LA', '0010').lat);
  }

  console.log('\ntrain-map — occupancy from CA / CB / CC\n');
  const BASE = Date.parse('2026-01-15T10:00:00Z');   // 10:00 London (GMT)
  let clock = BASE;
  const cfg = { region: { id: 'sussex', name: 'Sussex', bbox: [50.72, -0.96, 51.17, 0.87] }, maxAgeSecs: 2700 };
  const msg = (type, o) => [`${type}_MSG`, { msg_type: type, area_id: 'LA', time: String(clock), ...o }];

  {
    const g = freshGeo(); stepChain(g, 2);
    const m = new TrainMap({ config: cfg, geo: g, now: () => clock });
    m.setAreas(['LA', 'LB']);
    m.handle(...msg('CA', { descr: '1H15', from: '0012', to: '0010' }));
    let s = m.snapshot();
    check('a stepped train is listed', s.trains.length, 1);
    const t = s.trains[0];
    check('...at its TO berth', t && t.berth, '0010');
    near('...at the interpolated position', t && t.lat, +at(STATIONS.SWK, STATIONS.PLD, 0.5).lat.toFixed(5), 1e-5);
    const hdg = bearingDeg(g.position('LA', '0012'), g.position('LA', '0010'));
    check('...heading is from the berth it left (eastbound ≈ east)', t && t.heading, Math.round(hdg));
    check('...which is roughly east', hdg > 45 && hdg < 135, true);

    clock += 30000;
    m.handle(...msg('CA', { descr: '1H15', from: '0010', to: '0008' }));
    s = m.snapshot();
    check('a step moves the train, it does not duplicate it', s.trains.length, 1);
    check('...to the new berth', s.trains[0].berth, '0008');

    m.handle(...msg('CB', { descr: '1H15', from: '0008' }));
    check('CB (cancel, from only) removes it', m.snapshot().trains.length, 0);

    m.handle(...msg('CC', { descr: '2N12', to: '0014' }));
    s = m.snapshot();
    check('CC (interpose, to only) adds a train', s.trains.length && s.trains[0].id, '2N12');
    check('...placed at its station', s.trains[0].placement, 'station');

    m.handle(...msg('CA', { descr: '5Z99', from: 'Q1', to: 'Q2' }));
    s = m.snapshot();
    check('a berth that cannot be placed is counted, never drawn', s.stats.unplaced, 1);
    check('...and not listed', s.trains.some(x => x.id === '5Z99'), false);

    m.handle('CA_MSG', { msg_type: 'CA', area_id: 'ZZ', descr: '9X99', from: '0014', to: '0012', time: String(clock) });
    check('areas outside the map are ignored', m.counters().CA, 3);
  }
  {
    const g = freshGeo(); stepChain(g, 2);
    const m = new TrainMap({ config: cfg, geo: g, now: () => clock });
    m.setAreas(['LA', 'LB']);
    m.handle(...msg('CC', { descr: '1A01', to: '0014' }));
    m.handle(...msg('CC', { descr: '1A01', to: '0012' }));
    check('one description in two nearby berths is one train', m.snapshot().trains.length, 1);
    m.handle('CC_MSG', { msg_type: 'CC', area_id: 'LB', descr: '1A01', to: '0103', time: String(clock + 1000) });
    const s = m.snapshot();
    // Brighton is ~7 km from Southwick: under SAME_TRAIN_M, so still merged…
    check('…and still one within 10 km', s.trains.length, 1);
    check('…keeping the newest', s.trains[0].area, 'LB');
  }
  {
    const geo = new BerthGeo({ stations: STATIONS });
    geo.loadSmart([...SMART, { td: 'LA', from: 'E1', to: 'E2', stanox: '99999', event: 'A' }], stanoxToCrs);
    const m = new TrainMap({ config: cfg, geo, now: () => clock });
    m.setAreas(['LA', 'LB']);
    m.handle(...msg('CC', { descr: '1A01', to: '0014' }));
    m.handle(...msg('CC', { descr: '1A01', to: 'E2' }));
    const s = m.snapshot();
    check('a berth placed outside the region box is not listed', s.trains.length, 1);
    check('...and counted as outside', s.stats.outsideRegion, 1);
  }
  {
    const g = freshGeo();
    const m = new TrainMap({ config: cfg, geo: g, now: () => clock });
    m.setAreas(['LA', 'LB']);
    m.handle(...msg('CC', { descr: '2N12', to: '0014' }));
    clock += 2700 * 1000 + 1;
    check('a description never stepped or cancelled ages out after maxAgeSecs', m.snapshot().trains.length, 0);
  }
  {
    const g = freshGeo();
    const m = new TrainMap({ config: cfg, geo: g, now: () => clock });
    m.setAreas(['LA']);
    m.handle('CC_MSG', { msg_type: 'CC', area_id: 'LA', descr: '2N12', to: '0014', time: '1' });
    check('an absurd feed time falls back to receive time', m.snapshot().trains[0].lastStepAt, clock);
  }
  {
    // Handover: cancelled in LA, interposed in LB 20 s later ⇒ the graph learns LA:x → LB:y.
    const g = freshGeo();
    const m = new TrainMap({ config: cfg, geo: g, now: () => clock });
    m.setAreas(['LA', 'LB']);
    m.handle(...msg('CB', { descr: '1H20', from: '0002' }));
    clock += 20000;
    m.handle('CC_MSG', { msg_type: 'CC', area_id: 'LB', descr: '1H20', to: '0101', time: String(clock) });
    check('a cancel→interpose across areas is learned as an edge', (g.next.get('LA:0002') || new Map()).get('LB:0101'), 1);
    check('...and counted as a handover', m.counters().handovers, 1);
    clock += 200000;
    m.handle(...msg('CB', { descr: '1H21', from: '0002' }));
    clock += 120000;
    m.handle('CC_MSG', { msg_type: 'CC', area_id: 'LB', descr: '1H21', to: '0101', time: String(clock) });
    check('...but not when the gap exceeds 90 s', m.counters().handovers, 1);
  }
  {
    const throwing = { observeEdge() { throw new Error('boom'); }, position() { return null; } };
    const m = new TrainMap({ config: cfg, geo: throwing, now: () => clock });
    m.setAreas(['LA']);
    let threw = false;
    try { m.handle(...msg('CA', { descr: '1H15', from: '0012', to: '0010' })); } catch (_) { threw = true; }
    check('a failure inside the map never propagates to the feed', threw, false);
    check('...it is counted', m.counters().errors, 1);
  }

  console.log('\nmap-services — headcode → service\n');
  {
    const region = new Set(['BRGHTN', 'HOVE', 'PSLDAWH']);
    const s = new MapServices({ inRegion: t => region.has(t), resolveName: t => ({ BRGHTN: 'Brighton', VICTRIC: 'London Victoria', LITLHPT: 'Littlehampton' }[t] || t) });
    const loc = (tip, k, v) => ({ tiploc_code: tip, [k]: v });
    const f = (uid, hc, stp = 'P') => ({ uid, headcode: hc, stp, operator: 'SN', trainType: 'passenger' });
    s.begin();
    s.collect(f('A1', '1H15'), [loc('LITLHPT', 'departure', '0930'), loc('HOVE', 'pass', '1000'), loc('VICTRIC', 'arrival', '1115')]);
    s.collect(f('A2', '1H15'), [loc('LITLHPT', 'departure', '1430'), loc('HOVE', 'pass', '1500'), loc('VICTRIC', 'arrival', '1615')]);
    s.collect(f('B1', '2X01'), [loc('LEEDS', 'departure', '0930'), loc('YORK', 'arrival', '1030')]);
    s.collect(f('C1', '1C01'), [loc('BRGHTN', 'departure', '0950'), loc('VICTRIC', 'arrival', '1050')]);
    s.collect(f('C1', '1C01', 'C'), [loc('BRGHTN', 'departure', '0950'), loc('VICTRIC', 'arrival', '1050')]);
    s.collect(f('D1', '1D01'), [loc('BRGHTN', 'departure', '0950'), loc('VICTRIC', 'arrival', '1050')]);
    s.collect(f('D1', '1D02', 'O'), [loc('BRGHTN', 'departure', '0955'), loc('VICTRIC', 'arrival', '1055')]);
    s.collect(f('N1', '5N99'), [loc('BRGHTN', 'departure', '2350'), loc('VICTRIC', 'arrival', '0040')]);
    check('only schedules touching the region are indexed, cancellations and superseded dropped', s.commit(), 4);
    const svc = s.lookup('1H15', BASE);            // 10:00 London
    check('the running 1H15 is the morning one', svc && svc.departs, '09:30');
    check('...with names resolved', svc && `${svc.origin} → ${svc.destination}`, 'Littlehampton → London Victoria');
    check('outside every window it says nothing', s.lookup('1H15', Date.parse('2026-01-15T12:30:00Z')), null);
    check('a schedule outside the region is never matched', s.lookup('2X01', BASE), null);
    check('an STP cancellation is not shown', s.lookup('1C01', BASE), null);
    check('an overlay (O) replaces the base schedule', s.lookup('1D02', BASE) && s.lookup('1D02', BASE).departs, '09:55');
    check('...and the base headcode no longer matches', s.lookup('1D01', BASE), null);
    const late = s.lookup('5N99', Date.parse('2026-01-16T00:20:00Z'));
    check('a service past midnight is still found before the 04:00 rebuild', late && late.arrives, '00:40');
  }

  console.log('\nsmart-fetcher — streaming parse\n');
  {
    const text = '{"BERTHDATA":[{"TD":"LA","FROMBERTH":"0006","TOBERTH":"0004","STANOX":"87002","EVENT":"D","STEPTYPE":"B","STANME":"PORTSLADE"},'
      + '{"TD":"LA","FROMBERTH":"","TOBERTH":"0014","STANOX":"87001","EVENT":"A","STEPTYPE":"I","STANME":"SOUTHWICK"},'
      + '{"TD":"LB","FROMBERTH":"0101","TOBERTH":"0103","STANOX":"87004","EVENT":"C","STEPTYPE":"B","STANME":"BRIGHTON"}]}';
    // Split into 7-byte chunks so every row straddles a boundary.
    const chunks = []; for (let i = 0; i < text.length; i += 7) chunks.push(text.slice(i, i + 7));
    const { rows, bad } = await parseSmartStream(Readable.from(chunks));
    check('every row survives chunk boundaries', rows.length, 3);
    check('no row is mangled', bad, 0);
    check('fields map to the compact shape', `${rows[0].td}/${rows[0].from}/${rows[0].to}/${rows[0].stanox}/${rows[0].event}`, 'LA/0006/0004/87002/D');
    check('a blank berth becomes null', rows[1].from, null);
    const kept = await parseSmartStream(Readable.from(chunks), r => r.td === 'LB');
    check('the keep filter applies', kept.rows.length, 1);
  }

  console.log('\nGET /map/live and /map/berths\n');
  {
    const { createApi } = require('../src/api');
    const g = freshGeo(); stepChain(g, 2);
    clock = BASE;
    const m = new TrainMap({ config: cfg, geo: g, now: () => clock });
    m.setAreas(['LA', 'LB']);
    m.handle(...msg('CA', { descr: '1H15', from: '0012', to: '0010' }));
    const server = createApi({}, 0, { trainMap: { trainMap: m, geo: g, config: { ...cfg, staleSecs: 600 }, services: null } });
    await new Promise(r => server.once('listening', r));
    const port = server.address().port;
    const get = p => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p }, r => {
      let b = ''; r.on('data', d => { b += d; }); r.on('end', () => res({ status: r.statusCode, body: JSON.parse(b) }));
    }).on('error', rej));
    const live = await get('/map/live');
    check('/map/live is 200', live.status, 200);
    check('...lists the train', live.body.trains.length && live.body.trains[0].headcode, '1H15');
    check('...with the region and areas', `${live.body.region.id}/${live.body.areas.join(',')}`, 'sussex/LA,LB');
    check('...and feed health', typeof live.body.feed, 'object');
    const berths = await get('/map/berths');
    check('/map/berths lists placed berths', berths.body.berths.some(b => b.area === 'LA' && b.berth === '0010' && b.placement === 'interpolated'), true);
    const none = await new Promise(r => {
      const s2 = createApi({}, 0);
      s2.once('listening', () => http.get({ host: '127.0.0.1', port: s2.address().port, path: '/map/live' }, rr => { rr.resume(); s2.close(); r(rr.statusCode); }));
    });
    check('without a map the route is a plain 404', none, 404);
    server.close();
  }

  console.log('\ntd-listener — the map cannot break the crossing path\n');
  {
    const td = require('../src/td-listener');
    let calls = 0;
    td.on('cclass', () => { calls++; if (calls === 1) throw new Error('map bug'); });
    const body = JSON.stringify([
      { CA_MSG: { msg_type: 'CA', area_id: 'ZZ', descr: '1A01', from: '0001', to: '0003', time: String(Date.now()) } },
      { CA_MSG: { msg_type: 'CA', area_id: 'ZZ', descr: '1A01', from: '0003', to: '0005', time: String(Date.now()) } }
    ]);
    const origErr = console.error; console.error = () => {};
    let threw = false;
    try { td._processMessageForTest(body); } catch (_) { threw = true; } finally { console.error = origErr; }
    check('a throwing map listener does not escape processMessage', threw, false);
    check('...and the rest of the batch is still processed', calls, 2);
  }

  console.log(`\n${fail === 0 ? 'All' : ''} ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
