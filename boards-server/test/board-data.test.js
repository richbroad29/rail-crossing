'use strict';
// node --test boards-server/test
const test = require('node:test');
const assert = require('node:assert/strict');
const { departuresFrom } = require('../board-data');
const { sampleResponse } = require('../sample');

const AT = '2026-10-03T10:30:00+01:00';     // 10:30 London (BST)
const svc = (std, etd, more = {}) => ({
  std, etd, platform: '1', serviceType: 'train',
  destination: [{ locationName: 'Brighton' }],
  subsequentCallingPoints: [{ callingPoint: [{ locationName: 'Aldrington' }, { locationName: 'Hove' }, { locationName: 'Brighton' }] }],
  ...more,
});
const one = (s, at = AT) => departuresFrom({ generatedAt: at, trainServices: [s] }).departures[0];

test('status wording', () => {
  assert.deepEqual(one(svc('10:42', 'On time')).status, { kind: 'ontime', text: 'On time' });
  assert.deepEqual(one(svc('10:42', '10:49')).status, { kind: 'late', text: 'Exp 10:49' });
  assert.deepEqual(one(svc('10:42', 'Delayed')).status, { kind: 'delayed', text: 'Delayed' });
  assert.deepEqual(one(svc('10:42', 'Cancelled', { isCancelled: true })).status, { kind: 'cancelled', text: 'Cancelled' });
  assert.deepEqual(one(svc('10:42', '10:42')).status, { kind: 'ontime', text: 'On time' });
  assert.deepEqual(one(svc('10:42', '10:41')).status, { kind: 'ontime', text: 'Exp 10:41' });   // early is not a delay
  assert.deepEqual(one(svc('10:42', 'No report')).status, { kind: 'other', text: 'No report' });
});

test('scrolling line: calling points, as "Calling at: X, Y, Z"', () => {
  assert.equal(one(svc('10:42', 'On time')).callingAt, 'Calling at: Aldrington, Hove, Brighton');
  const single = svc('10:42', 'On time', { subsequentCallingPoints: [{ callingPoint: [{ locationName: 'Hove' }] }] });
  assert.equal(one(single).callingAt, 'Calling at: Hove only');
  const skip = svc('10:42', 'On time', { subsequentCallingPoints: [{ callingPoint: [{ locationName: 'Aldrington', isCancelled: true }, { locationName: 'Hove' }, { locationName: 'Brighton' }] }] });
  assert.equal(one(skip).callingAt, 'Calling at: Hove, Brighton');
  assert.equal(one(svc('10:42', 'On time', { subsequentCallingPoints: [] })).callingAt, null);
});

test('reason only when there actually is a delay or cancellation', () => {
  const why = 'This train has been delayed by a signalling problem';
  assert.equal(one(svc('10:42', '10:49', { delayReason: why })).reason, why + '.');
  assert.equal(one(svc('10:42', 'Delayed', { delayReason: why })).reason, why + '.');
  assert.equal(one(svc('10:42', 'On time', { delayReason: why })).reason, null);     // made the time up
  assert.equal(one(svc('10:42', '10:41', { delayReason: why })).reason, null);       // early
  assert.equal(one(svc('10:42', '10:49')).reason, null);                             // late, feed gives no reason
  const c = one(svc('10:42', 'Cancelled', { isCancelled: true, cancelReason: 'This train has been cancelled because of a shortage of train crew', delayReason: why }));
  assert.equal(c.callingAt, 'This train has been cancelled.');
  assert.equal(c.reason, 'This train has been cancelled because of a shortage of train crew.');
});

test('order follows expected time, so a late train drops behind an on-time one', () => {
  const b = departuresFrom({ generatedAt: AT, trainServices: [
    svc('10:40', '10:55', { serviceID: 'late' }),
    svc('10:50', 'On time', { serviceID: 'ontime' }),
    svc('10:45', 'Delayed', { serviceID: 'unknown' }),      // no estimate: stays in its timetable slot
  ] });
  assert.deepEqual(b.departures.map(d => d.id), ['unknown', 'ontime', 'late']);
});

test('trains after midnight sort after the ones before it', () => {
  const b = departuresFrom({ generatedAt: '2026-10-03T23:50:00+01:00', trainServices: [
    svc('00:05', 'On time', { serviceID: 'after' }),
    svc('23:55', 'On time', { serviceID: 'before' }),
  ] });
  assert.deepEqual(b.departures.map(d => d.id), ['before', 'after']);
  assert.equal(b.departures[1].expectedAt, '2026-10-03T23:05:00.000Z');   // 00:05 BST on the 4th
});

test('buses, missing platforms, terminating trains, wrapped and empty lists', () => {
  const b = departuresFrom({
    generatedAt: AT,
    trainServices: { service: svc('10:42', 'On time', { platform: null, destination: { location: [{ locationName: 'Brighton' }] } }) },
    busServices: [svc('10:50', 'On time', { serviceType: 'bus', platform: null })],
  });
  assert.equal(b.departures.length, 2);
  assert.equal(b.departures[0].platform, null);
  assert.equal(b.departures[0].destination, 'Brighton');
  assert.equal(b.departures[1].isBus, true);
  assert.equal(b.departures[1].status.text, 'Bus');
  assert.match(b.departures[1].callingAt, /^Replacement bus calling at: /);

  assert.equal(departuresFrom({ generatedAt: AT, trainServices: [svc(undefined, undefined)] }).departures.length, 0);
  assert.deepEqual(departuresFrom({ generatedAt: AT, trainServices: null }).departures, []);
  assert.deepEqual(departuresFrom({ generatedAt: AT }).departures, []);
});

test('the sample data goes through the same code and shows every state', () => {
  const b = departuresFrom(JSON.stringify(sampleResponse(new Date())));
  const kinds = new Set(b.departures.map(d => d.status.kind));
  for (const k of ['ontime', 'late', 'delayed', 'cancelled']) assert.ok(kinds.has(k), k);
  assert.ok(b.departures.some(d => d.isBus));
  assert.ok(b.departures.some(d => d.reason));
});
