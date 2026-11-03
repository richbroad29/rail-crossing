'use strict';

// The TD connection, against a local STOMP server and the REAL stompit.

const test = require('node:test');
const assert = require('node:assert/strict');
const { FakeStompServer } = require('../dev/fake-stomp-server');
const { TdIngest, RateWindow } = require('../src/td-ingest');
const stomp = require('../src/stomp');
const log = require('../src/log');
const { config, captureLog, until, sleep } = require('./helpers');

const TOPIC = '/topic/TD_ALL_SIG_AREA';
const CREDS = { user: 'map-user@example.com', pass: 'sec$ret"pass\\word' };

async function rig({ server = {}, td = {}, creds = CREDS } = {}) {
  stomp._resetForTest();
  const srv = new FakeStompServer({ login: CREDS.user, passcode: CREDS.pass, heartbeat: [0, 0], ...server });
  const port = await srv.listen();
  const events = [], delays = [];
  const cfg = { ...config().td, connectTimeoutMs: 500, backoffMinMs: 10, backoffMaxMs: 40, ...td };
  const ing = new TdIngest({
    config: cfg, creds, host: '127.0.0.1', port, onEvent: e => events.push(e),
    sleep: ms => { delays.push(ms); return sleep(5); }
  });
  return { srv, ing, events, delays, port, stop: async () => { await ing.stop(); await srv.close(); stomp._resetForTest(); } };
}

const frame = items => JSON.stringify(items);
const ca = (area, descr, from, to, time) => ({ CA_MSG: { area_id: area, descr, from, to, time: String(time), msg_type: 'CA' } });

test('connects with the login, subscribes NON-durably to the all-areas topic, and delivers C-Class events', async () => {
  const cap = captureLog();
  const r = await rig();
  try {
    r.ing.start();
    await r.srv.waitForSubscribe();
    const sub = r.srv.framesOf('SUBSCRIBE')[0];
    assert.equal(sub.headers.destination, TOPIC);
    assert.equal(sub.headers['activemq.subscriptionName'], undefined, 'never a durable subscription');
    const conn = r.srv.framesOf('CONNECT')[0] || r.srv.framesOf('STOMP')[0];
    assert.equal(conn.headers.login, CREDS.user);
    assert.equal(conn.headers.passcode, CREDS.pass, 'the literal password');
    assert.match(conn.headers['client-id'], /^rail-map-svc-\d+-[0-9a-f]{8}$/);
    const now = Date.now();
    r.srv.publish(TOPIC, frame([
      ca('LA', '1H15', '0001', '0002', now),
      { CB_MSG: { area_id: 'LA', descr: '1H15', from: '0002', time: String(now), msg_type: 'CB' } },
      { CC_MSG: { area_id: 'SX', descr: '2K22', to: '0100', time: String(now), msg_type: 'CC' } },
      { CT_MSG: { area_id: 'LA', time: String(now), msg_type: 'CT', report_time: '1000' } },
      { SF_MSG: { area_id: 'LA', time: String(now), msg_type: 'SF', address: '01', data: '00' } }
    ]));
    await until(() => r.events.length === 3, 2000, 'events');
    assert.deepEqual(r.events.map(e => [e.type, e.area, e.descr, e.from || null, e.to || null]), [
      ['CA', 'LA', '1H15', '0001', '0002'], ['CB', 'LA', '1H15', '0002', null], ['CC', 'SX', '2K22', null, '0100']]);
    assert.equal(r.ing.counts.other, 2, 'CT and SF are counted, not delivered');
    const st = r.ing.status();
    assert.equal(st.connected, true);
    assert.ok(st.staleSecs <= 1);
    assert.deepEqual(Object.keys(st).sort(), ['connected', 'eventsPerMin', 'lastMessageAt', 'messagesPerMin', 'staleSecs']);
  } finally { await r.stop(); cap.restore(); log.resetForTest(); }
});

test('event time: the feed clock when sane, the receive clock when it is wildly off or absent', async () => {
  const r = await rig();
  try {
    r.ing.start(); await r.srv.waitForSubscribe();
    const now = Date.now();
    r.srv.publish(TOPIC, frame([ca('LA', 'AAAA', '1', '2', now - 5000), ca('LA', 'BBBB', '1', '2', now - 3 * 3600 * 1000), ca('LA', 'CCCC', '1', '2', 'garbage'), { CA_MSG: { area_id: 'LA', descr: 'DDDD', from: '1', to: '2' } }]));
    await until(() => r.events.length === 4);
    assert.equal(r.events[0].ts, now - 5000);
    for (const e of r.events.slice(1)) assert.ok(Math.abs(e.ts - now) < 5000, 'fell back to receive time');
  } finally { await r.stop(); }
});

test('malformed bodies and elements never throw, never stop the stream, and good messages after them still arrive', async () => {
  const r = await rig();
  try {
    r.ing.start(); await r.srv.waitForSubscribe();
    const now = Date.now();
    for (const body of ['', 'not json', '{"CA_MSG":{}}', '42', 'null', '[1,2,3]', '[null,"x",[]]', '[{"CA_MSG":null}]', '[{"CA_MSG":5}]', '[{"CA_MSG":{"area_id":{},"descr":[]}}]', '\u0000\u0001', '['.repeat(5000)]) {
      r.srv.publish(TOPIC, body);
    }
    r.srv.publish(TOPIC, frame([ca('LA', 'GOOD', '0001', '0002', now)]));
    await until(() => r.events.some(e => e.descr === 'GOOD'), 2000, 'the good event');
    assert.equal(r.ing.connected, true);
    assert.ok(r.ing.counts.badBodies >= 5);
  } finally { await r.stop(); }
});

test('an onEvent that throws is contained (counted), and delivery continues', async () => {
  stomp._resetForTest();
  const srv = new FakeStompServer({ login: CREDS.user, passcode: CREDS.pass, heartbeat: [0, 0] });
  const port = await srv.listen();
  let n = 0;
  const ing = new TdIngest({ config: { ...config().td, backoffMinMs: 10, backoffMaxMs: 20 }, creds: CREDS, host: '127.0.0.1', port, onEvent: () => { n++; if (n === 1) throw new Error('boom'); }, sleep: () => sleep(5) });
  try {
    ing.start(); await srv.waitForSubscribe();
    srv.publish(TOPIC, frame([ca('LA', 'A', '1', '2', Date.now()), ca('LA', 'B', '1', '2', Date.now())]));
    await until(() => n === 2);
    assert.equal(ing.counts.badItems, 1);
    assert.equal(ing.connected, true);
  } finally { await ing.stop(); await srv.close(); stomp._resetForTest(); }
});

test('reconnects after a dropped link, with ONE connection at a time (single-flight)', async () => {
  const cap = captureLog();
  const r = await rig();
  try {
    let maxOpen = 0;
    const watch = setInterval(() => { maxOpen = Math.max(maxOpen, r.srv.openCount); }, 2);
    r.ing.start(); await r.srv.waitForSubscribe(1);
    r.srv.dropAll();
    await r.srv.waitForSubscribe(2);
    r.srv.dropAll();
    await r.srv.waitForSubscribe(3);
    clearInterval(watch);
    assert.equal(r.srv.connections.length, 3);
    assert.ok(maxOpen <= 1, `at most one open connection at once (saw ${maxOpen})`);
    assert.ok(r.ing.counts.reconnects >= 2);
    r.srv.publish(TOPIC, frame([ca('LA', 'AFTER', '1', '2', Date.now())]));
    await until(() => r.events.some(e => e.descr === 'AFTER'));
    const lines = cap.lines.join('\n');
    assert.ok(lines.includes('connection lost'), 'a transition is logged');
    assert.ok(!lines.includes(CREDS.pass) && !lines.includes(CREDS.user));
  } finally { await r.stop(); cap.restore(); log.resetForTest(); }
});

test('backoff grows while the server refuses, and is bounded', async () => {
  const cap = captureLog();
  stomp._resetForTest();
  const srv = new FakeStompServer({ login: CREDS.user, passcode: CREDS.pass, heartbeat: [0, 0] });
  const port = await srv.listen();
  const delays = [];
  const bad = { user: CREDS.user, pass: 'wrong' };
  const ing = new TdIngest({ config: { ...config().td, backoffMinMs: 100, backoffMaxMs: 800, connectTimeoutMs: 500 }, creds: bad, host: '127.0.0.1', port, onEvent() {}, sleep: ms => { delays.push(ms); return sleep(2); } });
  try {
    ing.start();
    await until(() => delays.length >= 6, 5000, 'six retries');
    // Jittered between 50% and 100% of 100, 200, 400, 800, 800...
    const caps = [100, 200, 400, 800, 800, 800];
    delays.slice(0, 6).forEach((d, i) => assert.ok(d >= caps[i] * 0.5 - 1 && d <= caps[i], `delay ${i} = ${d} within [${caps[i] * 0.5}, ${caps[i]}]`));
    const text = cap.lines.join('\n');
    assert.ok(!text.includes('wrong') && !text.includes(CREDS.user), 'the login and password are not in the log');
    assert.equal(cap.lines.filter(l => l.includes('connect failed')).length, 1, 'one line for a run of identical failures, not one per attempt');
  } finally { await ing.stop(); await srv.close(); stomp._resetForTest(); cap.restore(); log.resetForTest(); }
});

test('SILENCE WATCHDOG: a connection that stays open but delivers nothing is dropped and re-established', async () => {
  const cap = captureLog();
  const r = await rig({ td: { silenceMs: 250 } });
  try {
    r.ing.start(); await r.srv.waitForSubscribe(1);
    await r.srv.waitForSubscribe(2);
    assert.ok(r.ing.counts.watchdogKills >= 1);
    assert.ok(cap.lines.some(l => l.includes('no message for') && l.includes('reconnect')));
  } finally { await r.stop(); cap.restore(); log.resetForTest(); }
});

test('the watchdog leaves a healthy stream alone', async () => {
  const r = await rig({ td: { silenceMs: 400 } });
  try {
    r.ing.start(); await r.srv.waitForSubscribe(1);
    const t = setInterval(() => r.srv.publish(TOPIC, frame([ca('LA', 'X', '1', '2', Date.now())])), 50);
    await sleep(1200);
    clearInterval(t);
    assert.equal(r.ing.counts.watchdogKills, 0);
    assert.equal(r.srv.connections.length, 1);
  } finally { await r.stop(); }
});

test('connect is BOUNDED: a server that accepts TCP and never answers CONNECT cannot hang the loop', async () => {
  const cap = captureLog();
  const r = await rig({ server: { mode: 'blackhole' }, td: { connectTimeoutMs: 150 } });
  try {
    const t0 = Date.now();
    r.ing.start();
    await until(() => r.srv.connections.length >= 2, 3000, 'a second attempt');
    assert.ok(Date.now() - t0 < 2500);
    assert.equal(r.ing.connected, false);
    assert.ok(r.ing.counts.connectFailures >= 1);
  } finally { await r.stop(); cap.restore(); log.resetForTest(); }
});

test('an ERROR frame (not authorised for the topic) is classified, logged without the login, and does not crash the process', async () => {
  const cap = captureLog();
  const r = await rig({ server: { forbidden: [TOPIC] } });
  try {
    r.ing.start();
    await until(() => r.ing.counts.reconnects >= 2, 3000, 'two cycles');
    assert.ok(r.srv.connections.length >= 2, 'it came back for another try');
    const text = cap.lines.join('\n');
    assert.ok(text.includes('connection lost'));
    assert.ok(!text.includes(CREDS.user) && !text.includes(CREDS.pass), 'the ERROR frame echoes the login; it must be redacted');
  } finally { await r.stop(); cap.restore(); log.resetForTest(); }
});

test('stop() says goodbye (DISCONNECT) and the loop ends; nothing reconnects afterwards', async () => {
  const r = await rig();
  r.ing.start(); await r.srv.waitForSubscribe();
  await r.ing.stop();
  assert.equal(r.srv.framesOf('DISCONNECT').length, 1);
  const n = r.srv.connections.length;
  await sleep(100);
  assert.equal(r.srv.connections.length, n);
  await r.srv.close(); stomp._resetForTest();
});

test('the NROD login is never sent to a host that is not loopback or NROD', async () => {
  const cap = captureLog();
  stomp._resetForTest();
  const ing = new TdIngest({ config: { ...config().td, backoffMinMs: 5, backoffMaxMs: 10 }, creds: CREDS, host: 'evil.example.com', port: 61618, onEvent() {}, sleep: () => sleep(5) });
  try {
    ing.start();
    await until(() => ing.counts.connectFailures >= 1);
    assert.ok(cap.lines.join('\n').includes('--stomp-host must be'));
    assert.equal(ing.connected, false);
  } finally { await ing.stop(); cap.restore(); log.resetForTest(); }
});

test('RateWindow: events per minute over a sliding window, from an injected clock', () => {
  let t = 1_000_000;
  const w = new RateWindow(5000, 12, () => t);
  w.add(10);
  assert.equal(w.perMin(), 10);
  t += 30_000; w.add(20);
  assert.equal(w.perMin(), 30);
  t += 40_000;                          // the first 10 has aged out of the 60 s window
  assert.equal(w.perMin(), 20);
  t += 120_000;
  assert.equal(w.perMin(), 0);
});

test('isStale: not connected, or silent for longer than the limit', () => {
  let t = 1000;
  const ing = new TdIngest({ config: config().td, creds: CREDS, host: '127.0.0.1', port: 1, onEvent() {}, now: () => t });
  assert.equal(ing.isStale(120), true, 'never connected');
  ing.connected = true; ing.connectedAt = t;
  assert.equal(ing.isStale(120), false);
  t += 121_000;
  assert.equal(ing.isStale(120), true, 'connected but silent since connect');
  ing.lastMessageAt = t - 1000;
  assert.equal(ing.isStale(120), false);
});
