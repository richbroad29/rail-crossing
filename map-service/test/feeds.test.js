'use strict';

// TRUST and VSTP through the WHOLE service: the real stompit against a local STOMP server, the real
// App, real HTTP. Plus subscription isolation (a refused topic, a throwing handler, garbage frames
// never touch the TD feed).

const test = require('node:test');
const assert = require('node:assert/strict');
const { startRig, TRUST_TOPIC, VSTP_TOPIC, NOW, sched, loc } = require('./rig');
const { getJson, sleep, until } = require('./helpers');
const T = require('./trust-helpers');

const ID = T.trainId('1H15');
const trains = async rig => (await getJson(rig.port, '/map/v1/trains')).json.trains;
const one = async (rig, hc) => (await trains(rig)).find(t => t.hc === hc);

async function eastbound(opts) {
  const rig = await startRig(opts);
  rig.td([['CC', 'LA', '1H15', null, '0002']]);                       // Portslade, matched to C00001 by time alone
  await until(() => rig.app.model.byId.size === 1, 2000, 'the train');
  await rig.settle(1200);
  return rig;
}

test('TRUST end to end: an activation and a movement give the train late and next, and the detail panel its per-call actuals', async () => {
  const rig = await eastbound();
  try {
    let t = await one(rig, '1H15');
    assert.equal(t.svc.late, undefined, 'no TRUST yet: no lateness (never a guess)');
    assert.equal(t.svc.next, undefined);
    rig.trust([T.activation({ id: ID, uid: 'C00001', originStanox: T.STANOX.LTLHMPT, depMs: T.at(9, 30) }),
      T.movement({ id: ID, stanox: T.STANOX.STHWICK, evt: 'DEPARTURE', actual: T.at(9, 43, 40), planned: T.at(9, 42), variation: 2, platform: '1' })]);
    await rig.settle(1300);                                           // activation and movement arrive AFTER the train: no TD event needed
    t = await one(rig, '1H15');
    assert.equal(t.svc.late, 2);
    assert.deepEqual(t.svc.next, { name: 'Portslade', time: '09:45', exp: '09:47' });
    assert.equal(t.svc.uid, 'C00001');
    const d = (await getJson(rig.port, `/map/v1/train/${t.id}`)).json;
    const calls = d.service.calls;
    assert.deepEqual(calls.map(c => c.tiploc), ['LTLHMPT', 'STHWICK', 'PSLDAWH', 'VICTRIC']);
    assert.equal(calls[1].actualDep, '09:43'); assert.equal(calls[1].variation, 2); assert.equal(calls[1].platformActual, '1');
    assert.deepEqual([calls[2].expArr, calls[2].expDep], ['09:47', '09:48'], 'booked + 2 min, never earlier than now');
    assert.equal(calls[3].expArr, '11:17');
    assert.equal(calls[0].expDep, null, 'already past: no expectation');
    assert.deepEqual(d.service.lastReport, { name: 'Southwick', event: 'dep', time: '09:43', at: T.at(9, 43, 40) });
    const h = (await getJson(rig.port, '/map/v1/health')).json;
    assert.equal(h.feeds.trust.activations, 1);
    assert.equal(h.diagnostics.trust.types['0001'], 1);
    assert.equal(h.diagnostics.trust.types['0003'], 1);
  } finally { await rig.stop(); }
});

test('EXACT UID beats the phase-1 time match: the activation, not the nearest booked time, names the service', async () => {
  const other = sched('C00099', '1H15', [loc('LO', 'LTLHMPT', null, '1000'), loc('LI', 'STHWICK', '1011', '1012'), loc('LI', 'PSLDAWH', '1015', '1016'), loc('LT', 'VICTRIC', '1145')]);
  const rig = await eastbound({ cifLines: [other] });
  try {
    assert.equal((await one(rig, '1H15')).svc.uid, 'C00001', 'by time alone: the 09:30');
    rig.trust([T.activation({ id: T.trainId('1H15', '02', '87'), uid: 'C00099', originStanox: T.STANOX.LTLHMPT, depMs: T.at(10, 0) })]);
    await rig.settle(1300);
    const t = await one(rig, '1H15');
    assert.equal(t.svc.uid, 'C00099');
    assert.equal(t.svc.dep, '10:00');
  } finally { await rig.stop(); }
});

test('RENUMBERING: the TD train becomes 1H17 (CB+CC), TRUST sends the change of identity, and the exact service is back', async () => {
  const rig = await eastbound();
  try {
    rig.trust([T.activation({ id: ID, uid: 'C00001', originStanox: T.STANOX.LTLHMPT, depMs: T.at(9, 30) })]);
    await rig.settle(300);
    const id0 = (await one(rig, '1H15')).id;
    rig.td([['CB', 'LA', '1H15', '0002']]); rig.td([['CC', 'LA', '1H17', null, '0002']]);
    await rig.settle(1300);
    let t = await one(rig, '1H17');
    assert.equal(t.id, id0, 'same train object across the renumbering');
    assert.equal(t.svc, undefined, '1H17 is in no timetable and no activation yet');
    rig.trust([T.changeIdentity({ id: ID, revised: T.trainId('1H17', '02', '86') })]);
    await rig.settle(1300);
    t = await one(rig, '1H17');
    assert.equal(t.svc.uid, 'C00001', 'matched through the activation, which phase 1 never could');
  } finally { await rig.stop(); }
});

test('TRUST cancellation reaches the details panel: calls after the cancellation point are cancelled', async () => {
  const rig = await eastbound();
  try {
    rig.trust([T.activation({ id: ID, uid: 'C00001', originStanox: T.STANOX.LTLHMPT, depMs: T.at(9, 30) }),
      T.movement({ id: ID, stanox: T.STANOX.STHWICK, evt: 'ARRIVAL', actual: T.at(9, 41), planned: T.at(9, 41), variation: 0 }),
      T.cancellation({ id: ID, stanox: T.STANOX.STHWICK, type: 'ON CALL' })]);
    await rig.settle(1300);
    const t = await one(rig, '1H15');
    const d = (await getJson(rig.port, `/map/v1/train/${t.id}`)).json;
    assert.deepEqual(d.service.calls.map(c => c.cancelled), [false, false, true, true]);
    assert.equal(t.svc.next, undefined, 'nothing left to be next');
  } finally { await rig.stop(); }
});

test('VSTP end to end: a created service matches a train; deleting it removes the match; the overlay is saved on stop', async () => {
  const rig = await startRig();
  try {
    rig.td([['CC', 'LA', '1Z99', null, '0002']]);
    await rig.settle(1200);
    assert.equal((await one(rig, '1Z99')).svc, undefined);
    rig.vstp(T.vstpCreate({ uid: 'V12345', hc: '1Z99', locs: [T.vloc('LTLHMPT', { dep: '093000' }), T.vloc('STHWICK', { arr: '094100', dep: '094200' }), T.vloc('PSLDAWH', { arr: '094500', dep: '094600' }), T.vloc('VICTRIC', { arr: '111500' })] }));
    await until(() => rig.app.vstp.size === 1, 2000, 'vstp create');
    await rig.settle(1300);
    assert.equal((await one(rig, '1Z99')).svc.uid, 'V12345');
    const h = (await getJson(rig.port, '/map/v1/health')).json;
    assert.equal(h.feeds.vstp.schedules, 1);
    rig.vstp(T.vstpDelete({ uid: 'V12345' }));
    await until(() => rig.app.vstp.size === 0, 2000, 'vstp delete');
    await rig.settle(1300);
    assert.equal((await one(rig, '1Z99')).svc, undefined);
  } finally { await rig.stop(); }
});

test('VSTP persists across a restart (hourly and on stop), so a restart does not forget today\'s changes', async () => {
  const fs = require('fs'), path = require('path');
  const rig = await startRig();
  try {
    rig.vstp(T.vstpCreate({ uid: 'V12345', hc: '1Z99', locs: [T.vloc('LTLHMPT', { dep: '093000' }), T.vloc('PSLDAWH', { arr: '094500' })] }));
    await until(() => rig.app.vstp.size === 1, 2000, 'vstp create');
    await rig.app.stop();
    const saved = JSON.parse(fs.readFileSync(path.join(rig.dataDir, 'state', 'vstp-overlay.json'), 'utf8'));
    assert.equal(saved.schedules.length, 1);
    assert.equal(saved.schedules[0].uid, 'V12345');
  } finally { await rig.stop().catch(() => {}); }
});

test('ISOLATION: a login that may not read TRUST still gets TD (and VSTP); TRUST is switched off for a while, with one log line', async () => {
  const rig = await startRig({ forbidden: [TRUST_TOPIC], subs: 2 });
  try {
    await until(() => rig.app.td.extraStatus('trust').refused >= 1 && rig.app.td.connected && rig.app.td.extraStatus('vstp').connected, 4000, 'reconnected without TRUST');
    rig.td([['CC', 'LA', '1H15', null, '0002']]);
    await until(() => rig.app.model.byId.size === 1, 2000, 'TD still delivers');
    const h = (await getJson(rig.port, '/map/v1/health')).json;
    assert.equal(h.feeds.td.connected, true);
    assert.equal(h.feeds.trust.connected, false);
    assert.equal(h.feeds.vstp.connected, true);
    assert.equal(rig.cap.lines.filter(l => /trust: this login may not read/.test(l)).length, 1);
    assert.ok(rig.stompSrv.framesOf('SUBSCRIBE').filter(f => f.headers.destination === TRUST_TOPIC).length <= 2, 'not hammered');
  } finally { await rig.stop(); }
});

test('ISOLATION: garbage frames and a THROWING handler on TRUST/VSTP never stop the TD feed', async () => {
  const rig = await startRig();
  try {
    rig.app.trust.onBody = () => { throw new Error('boom'); };
    rig.trust([T.activation({ id: ID, uid: 'C00001', originStanox: T.STANOX.LTLHMPT, depMs: T.at(9, 30) })]);
    rig.stompSrv.publish(TRUST_TOPIC, 'not json at all');
    rig.stompSrv.publish(VSTP_TOPIC, '{"half":');
    rig.vstp('[1,2,3]');
    rig.td([['CC', 'LA', '1H15', null, '0002']]);
    await until(() => rig.app.model.byId.size === 1, 2000, 'TD still delivers');
    await rig.settle(300);
    assert.equal(rig.app.td.extraStatus('trust').handlerErrors, 2);
    assert.equal(rig.app.td.extraStatus('trust').connected, true, 'the connection survives');
    assert.equal(rig.app.vstp.counts.badBodies, 1);
    assert.ok(Object.keys(rig.app.vstp.counts.bad.toJSON()).length >= 1, 'the array of numbers was counted as bad items');
    assert.equal((await getJson(rig.port, '/map/v1/health')).json.feeds.td.connected, true);
    rig.td([['CA', 'LA', '1H15', '0002', '0004']]);
    await rig.settle(200);
    assert.equal([...rig.app.model.byId.values()][0].keyId, rig.app.graph.lookup('LA', '0004'));
  } finally { await rig.stop(); }
});

test('STATION BOARD: ordering, the 2 h / 30 min windows, passes, terminations, cancellations, lateness, freight and ECS included', async () => {
  const route = (id, hc, tPrefix, { arr, dep, pass, last = false, toc = 'SN' } = {}) => sched(id, hc, [
    loc('LO', 'LTLHMPT', null, tPrefix.origin), pass ? loc('LI', 'PSLDAWH', null, null, pass) : loc(last ? 'LT' : 'LI', 'PSLDAWH', arr, last ? null : dep, null, '2'), ...(last ? [] : [loc('LT', 'VICTRIC', tPrefix.end)])
  ]);
  const lines = [
    route('B00001', '1B02', { origin: '0920', end: '1100' }, { arr: '0946', dep: '0947' }),
    route('A00001', '1A01', { origin: '0925', end: '1100' }, { arr: '0949', dep: '0950' }),
    route('D00001', '6V01', { origin: '0930', end: '1100' }, { pass: '0952' }),
    route('K00001', '1K11', { origin: '0930', end: '1100' }, { arr: '0949', dep: '0950' }),
    route('C00003', '1C03', { origin: '0935', end: '1100' }, { arr: '0954', dep: '0955' }),
    route('I00001', '1I09', { origin: '0940', end: '1100' }, { arr: '0959', dep: '1000' }),
    route('E00001', '5Z10', { origin: '0945', end: '1100' }, { arr: '1010', last: true }),
    route('F00001', '1F06', { origin: '1130', end: '1300' }, { arr: '1159', dep: '1200' }),
    route('G00001', '1G07', { origin: '0910', end: '1100' }, { arr: '0919', dep: '0920' }),
    route('H00001', '1H08', { origin: '0855', end: '1100' }, { arr: '0904', dep: '0905' }),
    route('J00001', '1J10', { origin: '0920', end: '1100' }, { arr: '0934', dep: '0935' })
  ];
  const rig = await startRig({ cifLines: lines });
  try {
    rig.td([['CC', 'LA', '1A01', null, '0002']]);                      // a live train for A: the board links to it
    await rig.settle(1200);
    const act = (id, uid, hc, dep) => T.activation({ id: T.trainId(hc), uid, originStanox: T.STANOX.LTLHMPT, depMs: dep });
    rig.trust([
      act(0, 'K00001', '1K11', T.at(9, 30)), T.movement({ id: T.trainId('1K11'), stanox: T.STANOX.LTLHMPT, evt: 'DEPARTURE', actual: T.at(9, 34), planned: T.at(9, 30), variation: 4 }),
      act(0, 'I00001', '1I09', T.at(9, 40)), T.cancellation({ id: T.trainId('1I09'), stanox: T.STANOX.LTLHMPT, type: 'AT ORIGIN' }),
      act(0, 'G00001', '1G07', T.at(9, 10)), T.movement({ id: T.trainId('1G07'), stanox: T.STANOX.PSLDAWH, evt: 'DEPARTURE', actual: T.at(9, 21), planned: T.at(9, 20), variation: 1, platform: '2' }),
      act(0, 'H00001', '1H08', T.at(8, 55)), T.movement({ id: T.trainId('1H08'), stanox: T.STANOX.PSLDAWH, evt: 'DEPARTURE', actual: T.at(9, 6), planned: T.at(9, 5), variation: 1 })
    ]);
    await rig.settle(300);
    const r = await getJson(rig.port, '/map/v1/station/PLD');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json).sort(), ['board', 'recent', 'station']);
    assert.deepEqual(r.json.station, { crs: 'PLD', name: 'Portslade', lat: 50.83568, lon: -0.20534 });
    const rows = r.json.board;
    rows.forEach(x => assert.deepEqual(Object.keys(x).sort(), ['actual', 'booked', 'cancelled', 'd', 'expected', 'hc', 'kind', 'late', 'o', 'platform', 'toc', 'trainId', 'uid']));
    assert.deepEqual(rows.map(x => [x.hc, x.kind, x.booked, x.expected]), [
      ['1G07', 'dep', '09:20', '09:21'],         // reported 23 minutes ago: in the last 30
      ['1H15', 'dep', '09:46', '09:46'],         // the rig's own default schedule
      ['1B02', 'dep', '09:47', '09:47'],
      ['1A01', 'dep', '09:50', '09:50'],
      ['6V01', 'pass', '09:52', '09:52'],        // freight is on the board, as a pass
      ['1K11', 'dep', '09:50', '09:54'],         // booked 09:50, 4 minutes late: sorts by EXPECTED
      ['1C03', 'dep', '09:55', '09:55'],
      ['1I09', 'dep', '10:00', '10:00'],         // cancelled but still shown, flagged
      ['5Z10', 'arr', '10:10', '10:10']          // an ECS terminating here: an arrival
    ], 'ordered by expected time; 1H08 (38 min ago), 1J10 (booked 09:35, nothing heard) and 1F06 (beyond 2 h) are out');
    const by = hc => rows.find(x => x.hc === hc);
    assert.equal(by('1A01').trainId, (await trains(rig)).find(t => t.hc === '1A01').id, 'linked to the live train');
    assert.equal(by('1B02').trainId, null);
    assert.equal(by('1K11').late, 4); assert.equal(by('1B02').late, null);
    assert.deepEqual([by('1I09').cancelled, by('1A01').cancelled], [true, false]);
    assert.deepEqual([by('1G07').actual, by('1G07').platform, by('1A01').actual, by('1A01').platform], ['09:21', '2', null, '2']);
    assert.deepEqual([by('1A01').o, by('1A01').d, by('1A01').toc, by('1A01').uid], ['Littlehampton', 'London Victoria', 'SN', 'A00001']);
    assert.deepEqual(r.json.recent, [{ hc: '1G07', kind: 'dep', time: '09:21', late: 1 }]);
    // Unknown, malformed.
    for (const p of ['ZZZ', 'ab', 'ABCD', '12A']) assert.equal((await getJson(rig.port, `/map/v1/station/${p}`)).status, 404, p);
    assert.equal((await getJson(rig.port, '/map/v1/station/%E0%A4%A')).status, 400);
    assert.equal((await getJson(rig.port, '/map/v1/station/pld')).status, 200, 'case-insensitive');
  } finally { await rig.stop(); }
});

test('SECTION 16: svc.late is POSITIVE when late and NEGATIVE when early, in minutes, on the wire', async () => {
  const rig = await eastbound();
  try {
    rig.trust([T.activation({ id: ID, uid: 'C00001', originStanox: T.STANOX.LTLHMPT, depMs: T.at(9, 30) }),
      T.movement({ id: ID, stanox: T.STANOX.STHWICK, evt: 'DEPARTURE', actual: T.at(9, 45), planned: T.at(9, 42), variation: 3, status: 'LATE' })]);
    await rig.settle(1300);
    assert.strictEqual((await one(rig, '1H15')).svc.late, 3, 'three minutes late is +3');
    rig.trust([T.movement({ id: ID, stanox: T.STANOX.PSLDAWH, evt: 'ARRIVAL', actual: T.at(9, 46), planned: T.at(9, 48), variation: 2, status: 'EARLY' })]);
    await rig.settle(1300);
    assert.strictEqual((await one(rig, '1H15')).svc.late, -2, 'two minutes early is -2');
    rig.trust([T.movement({ id: ID, stanox: T.STANOX.PSLDAWH, evt: 'DEPARTURE', actual: T.at(9, 47), planned: T.at(9, 47), variation: 0, status: 'ON TIME' })]);
    await rig.settle(1300);
    assert.strictEqual((await one(rig, '1H15')).svc.late, 0);
  } finally { await rig.stop(); }
});
