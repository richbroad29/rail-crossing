'use strict';

// The REAL stompit, driven through lib/stomp.js, against a fake STOMP server on a local port.
// What these assert on is what the SERVER received and sent — the wire, not the library's own
// idea of what it did. That is the only honest evidence for "never a durable subscription" and
// "DISCONNECT was sent".

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const util = require('util');
const { FakeStompServer } = require('./helpers/fake-stomp-server');
const stomp = require('../lib/stomp');
const { TdStats } = require('../lib/td-stats');

const TOPIC = '/topic/TD_ALL_SIG_AREA';
const sessions = [];
const servers = [];

afterEach(async () => {
  for (const s of sessions.splice(0)) { try { await s.close({ timeoutMs: 200 }); } catch (_) { /* best effort */ } }
  for (const s of servers.splice(0)) await s.close();
  stomp._resetForTest();
});

async function start(opts) {
  const srv = new FakeStompServer(opts);
  await srv.listen();
  servers.push(srv);
  const creds = { user: srv.opts.login, pass: srv.opts.passcode };
  const open = async (extra = {}) => {
    const s = await stomp.openSession({ creds, host: '127.0.0.1', port: srv.port, ...extra });
    sessions.push(s);
    return s;
  };
  return { srv, creds, open };
}
const closed = s => new Promise(res => (s.closedInfo ? res(s.closedInfo) : s.once('closed', res)));
const ev = (type, f) => ({ [`${type}_MSG`]: { time: '1730000000000', msg_type: type, ...f } });

test('TD messages are counted correctly, byte for byte, through the real stompit', async () => {
  const { srv, open } = await start();
  const s = await open();
  const stats = new TdStats({ startMs: Date.now() });
  const sentBodies = [];
  s.subscribe(TOPIC, (body, h, at) => stats.ingest(body, at));
  await srv.waitForSubscribe();

  // 30 frames of 1 CA + 1 CT + 1 SF, one frame with a multi-byte character in a description,
  // one big frame (about 300 KB, many TCP chunks), and one sent WITHOUT content-length.
  for (let i = 0; i < 30; i++) {
    const body = JSON.stringify([
      ev('CA', { area_id: 'LA', descr: `1A${String(i).padStart(2, '0')}`, from: '0006', to: '0004' }),
      ev('CT', { area_id: 'LA', report_time: '1000' }),
      ev('SF', { area_id: 'BM', address: '01', data: '00' })
    ]);
    sentBodies.push(body); srv.publish(TOPIC, body);
  }
  const unicode = JSON.stringify([ev('CC', { area_id: 'SB', descr: 'Ünï', to: '0100' })]);
  sentBodies.push(unicode); srv.publish(TOPIC, unicode);
  const big = JSON.stringify(Array.from({ length: 3000 }, (_, i) => ev('CA', { area_id: 'XX', descr: `B${i}`, from: `F${i}`, to: `T${i}` })));
  assert.ok(big.length > 250000);
  sentBodies.push(big); srv.publish(TOPIC, big);
  const noLen = JSON.stringify([ev('CB', { area_id: 'LA', descr: 'GONE', from: '0002' })]);
  sentBodies.push(noLen); srv.publish(TOPIC, noLen, { contentLength: false });

  await srv.waitFor(() => s.stats.frames === sentBodies.length, 5000, 'all frames');
  const r = stats.summary(Date.now() + 1000);
  assert.equal(r.frames, 33);
  assert.equal(r.bytes, sentBodies.reduce((n, b) => n + Buffer.byteLength(b), 0), 'every byte arrived, in order, intact');
  assert.deepEqual(r.eventsByType, { CA: 3030, CT: 30, SF: 30, CB: 1, CC: 1 });
  assert.deepEqual(r.eventsPerArea, { XX: 3000, BM: 30, LA: 61, SB: 1 });
  assert.equal(r.areas, 4);
  assert.equal(r.parseErrors, 0);
  assert.equal(s.stats.handlerErrors, 0);
  assert.ok(stats.descriptions.has('Ünï'), 'multi-byte text survives framing');
});

test('a topic the login may not read: the server\'s ERROR frame is classified, with the topic, and the session ends', async () => {
  const { srv, creds, open } = await start({ forbidden: ['/topic/TRAIN_MVT_ALL_TOC'] });
  const s = await open();
  s.subscribe('/topic/TRAIN_MVT_ALL_TOC', () => assert.fail('no message should arrive'));
  const info = await closed(s);
  assert.equal(info.unexpected, true);
  assert.equal(info.error.kind, 'not-authorised');
  assert.equal(info.error.info.topic, '/topic/TRAIN_MVT_ALL_TOC');
  assert.match(info.error.info.serverMessage, /is not authorized to read from/);
  // The fake echoes the login in the ERROR text, as ActiveMQ does: it must not survive.
  const dump = util.inspect(info, { depth: 12 }) + JSON.stringify(info.error.info);
  assert.ok(!dump.includes(creds.user), 'login scrubbed from the server\'s text');
  assert.ok(!dump.includes(creds.pass));
  assert.equal(srv.framesOf('SUBSCRIBE').length, 1);
  assert.equal(s.isOpen, false);
});

test('ERROR frames of BOTH shapes reach us as classified errors — stompit 1.0.0 crashes the process on one of them', async () => {
  // stompit's own ERROR handler takes one branch for a frame with content-type text/plain and a
  // content-length (ActiveMQ-style) and another for a bare one. The first emits the error on the
  // frame stream instead of the client, so unaided it is an uncaught exception (see
  // hardenClient in lib/stomp.js). The suite runs both through, for a bad login and a forbidden topic.
  for (const bareErrors of [false, true]) {
    const bad = await start({ bareErrors });
    const err = await stomp.openSession({ creds: { user: bad.creds.user, pass: 'nope' }, host: '127.0.0.1', port: bad.srv.port }).catch(e => e);
    assert.equal(err.kind, 'auth', `login, bareErrors=${bareErrors}`);
    assert.equal(err.info.serverDetail === null, bareErrors, 'the body is only there when the server sent one');

    const forbidden = await start({ bareErrors, forbidden: ['/topic/VSTP_ALL'] });
    const s = await forbidden.open();
    s.subscribe('/topic/VSTP_ALL', () => {});
    const info = await closed(s);
    assert.equal(info.error.kind, 'not-authorised', `subscribe, bareErrors=${bareErrors}`);
    assert.equal(info.error.info.topic, '/topic/VSTP_ALL');
  }
});

test('an unrecognised ERROR frame is passed through verbatim as "server-error"', async () => {
  const { open } = await start({ errorOnSubscribe: 'Too many connections for this user' });
  const s = await open();
  s.subscribe(TOPIC, () => {});
  const info = await closed(s);
  assert.equal(info.error.kind, 'server-error');
  assert.equal(info.error.info.serverMessage, 'Too many connections for this user');
});

test('a bad login is "auth"; the error carries neither the login nor the password, even in its hidden fields', async () => {
  const { srv, creds } = await start();
  let err;
  await stomp.openSession({ creds: { user: creds.user, pass: 'wrong-pass' }, host: '127.0.0.1', port: srv.port })
    .catch(e => { err = e; });
  assert.ok(err instanceof stomp.StompError);
  assert.equal(err.kind, 'auth');
  assert.match(err.info.serverMessage, /User name \[\*\*\*\] or password is invalid/);
  const dump = util.inspect(err, { depth: 12, showHidden: true }) + JSON.stringify(err.info) + err.stack;
  assert.ok(!dump.includes('wrong-pass'), 'password');
  assert.ok(!dump.includes(creds.user), 'login');
  // And the slot is free again afterwards.
  const ok = await stomp.openSession({ creds, host: '127.0.0.1', port: srv.port });
  sessions.push(ok);
  assert.ok(ok.isOpen);
});

test('nothing listening: "network", with the OS code, quickly', async () => {
  const port = await new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const t0 = Date.now();
  const err = await stomp.openSession({ creds: { user: 'u@example.com', pass: 'secret1' }, host: '127.0.0.1', port }).catch(e => e);
  assert.equal(err.kind, 'network');
  assert.equal(err.info.code, 'ECONNREFUSED');
  assert.ok(Date.now() - t0 < 2000);
});

test('the connect is BOUNDED: a server that accepts TCP and never says CONNECTED cannot hang us', async () => {
  // This is the 2026-09-22 shape. stompit's own timeout ends when the socket connects, so
  // without lib/stomp.js's outer bound this would never settle.
  const { srv, creds, open } = await start({ mode: 'blackhole' });
  const t0 = Date.now();
  const err = await open({ connectTimeoutMs: 300 }).catch(e => e);
  const took = Date.now() - t0;
  assert.equal(err.kind, 'timeout');
  assert.ok(took >= 250 && took < 2000, `took ${took} ms`);
  await srv.waitFor(() => srv.connections[0] && srv.connections[0].closed, 2000, 'the half-open socket to be destroyed');
  assert.equal(srv.connections.length, 1);
  // ...and a later attempt, to a healthy server, is not blocked by the failed one.
  const healthy = await start();
  const ok = await healthy.open();
  assert.ok(ok.isOpen);
  void creds;
});

test('never a durable subscription: the wire carries no activemq.* header, ack is auto, and CONNECT is as specified', async () => {
  const { srv, creds, open } = await start();
  const s = await open();
  s.subscribe(TOPIC, () => {});
  await srv.waitForSubscribe();
  const sub = srv.framesOf('SUBSCRIBE')[0].headers;
  assert.deepEqual(Object.keys(sub).sort(), ['ack', 'destination', 'id']);
  assert.equal(sub.destination, TOPIC);
  assert.equal(sub.ack, 'auto');
  const con = srv.framesOf('CONNECT')[0].headers;
  for (const [where, headers] of [['SUBSCRIBE', sub], ['CONNECT', con]]) {
    const bad = Object.keys(headers).filter(k => /activemq|durable|subscriptionname|selector/i.test(k));
    assert.deepEqual(bad, [], `${where} must not carry ${bad}`);
  }
  assert.equal(con['heart-beat'], '15000,15000');
  assert.equal(con.host, '/');
  assert.match(con['client-id'], /^rail-map-phase0-\d+-[0-9a-f]{8}$/);
  assert.equal(con['client-id'], s.clientId);
  assert.notEqual(con['client-id'], `rail-crossing-${process.pid}`, 'can never collide with the live service\'s id');
  // The password has $ " \ and : in it; CONNECT headers are unescaped, so it must arrive literally.
  assert.equal(con.login, creds.user);
  assert.equal(con.passcode, creds.pass);
  assert.match(con['accept-version'], /1\.1/);
  // Nothing but CONNECT and SUBSCRIBE so far: no UNSUBSCRIBE, no SEND, no ACK.
  assert.deepEqual(srv.frames.map(f => f.command), ['CONNECT', 'SUBSCRIBE']);
});

test('finishing sends DISCONNECT, waits for NROD\'s RECEIPT, and the server sees us leave', async () => {
  const { srv, open } = await start();
  const s = await open();
  s.subscribe(TOPIC, () => {});
  await srv.waitForSubscribe();
  const r = await s.close();
  assert.equal(r.clean, true);
  assert.equal(r.how, 'receipt');
  const d = srv.framesOf('DISCONNECT');
  assert.equal(d.length, 1);
  assert.ok(d[0].headers.receipt, 'DISCONNECT asked for a receipt');
  await srv.waitFor(() => srv.connections[0].closed, 2000, 'server to see the socket close');
  assert.equal(s.closedInfo.unexpected, false);
  assert.equal(s.closedInfo.error, null, 'our own DISCONNECT is not an error');
  assert.equal(await s.close(), r, 'closing twice is the same close');
  assert.equal(srv.framesOf('DISCONNECT').length, 1);
});

test('a server that never answers DISCONNECT cannot hang us either', async () => {
  const { srv, open } = await start({ noReceipt: true });
  const s = await open();
  s.subscribe(TOPIC, () => {});
  await srv.waitForSubscribe();
  const t0 = Date.now();
  const r = await s.close({ timeoutMs: 200 });
  assert.equal(r.how, 'timeout');
  assert.equal(r.clean, false);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(srv.framesOf('DISCONNECT').length, 1, 'we did say goodbye');
  await srv.waitFor(() => srv.connections[0].closed, 2000, 'socket destroyed after the bound');
});

test('exactly one connection at a time per process', async () => {
  const { srv, creds, open } = await start();
  const first = await open();
  const err = await stomp.openSession({ creds, host: '127.0.0.1', port: srv.port }).catch(e => e);
  assert.equal(err.kind, 'busy');
  assert.equal(srv.connections.length, 1, 'the second attempt never touched the network');
  await first.close();
  const second = await open();
  assert.notEqual(second.clientId, first.clientId);
  assert.equal(srv.connections.length, 2);
});

test('two opens racing: one wins, one is refused — they cannot both pass the check', async () => {
  const { srv, creds } = await start();
  const results = await Promise.allSettled([
    stomp.openSession({ creds, host: '127.0.0.1', port: srv.port }),
    stomp.openSession({ creds, host: '127.0.0.1', port: srv.port })
  ]);
  for (const r of results) if (r.status === 'fulfilled') sessions.push(r.value);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.kind, 'busy');
  assert.equal(srv.connections.length, 1);
});

test('the server dropping us mid-run is reported as UNEXPECTED, with a reason, and close() copes', async () => {
  const { srv, open } = await start();
  const s = await open();
  s.subscribe(TOPIC, () => {});
  await srv.waitForSubscribe();
  srv.dropAll();
  const info = await closed(s);
  assert.equal(info.unexpected, true);
  assert.ok(['network', 'server-closed'].includes(info.error.kind), info.error.kind);
  assert.equal(info.error.info.phase, 'subscribed');
  const r = await s.close();
  assert.equal(r.how, 'already-closed');
  assert.equal(srv.framesOf('DISCONNECT').length, 0, 'nobody to say goodbye to');
  const again = await open();       // the slot was released
  assert.ok(again.isOpen);
});

test('a server that goes silent is caught by the heart-beat (stompit\'s "connection timed out")', async () => {
  const { srv, open } = await start({ heartbeat: [100, 100] });
  const s = await open({ heartbeat: '100,100' });
  s.subscribe(TOPIC, () => {});
  await srv.waitForSubscribe();
  const info = await closed(s);
  assert.equal(info.unexpected, true);
  assert.equal(info.error.kind, 'timeout');
  assert.match(info.error.message, /timed out/);
});

test('a handler that throws is counted and the session carries on', async () => {
  const { srv, open } = await start();
  const s = await open();
  let n = 0;
  s.subscribe(TOPIC, () => { n++; if (n === 1) throw new Error('boom'); });
  await srv.waitForSubscribe();
  srv.publish(TOPIC, 'one'); srv.publish(TOPIC, 'two'); srv.publish(TOPIC, 'three');
  await srv.waitFor(() => n === 3, 2000, 'three deliveries');
  assert.equal(s.stats.handlerErrors, 1);
  assert.equal(s.stats.firstHandlerError, 'boom');
  assert.equal(s.isOpen, true);
});

test('frames that arrive while we are closing are not delivered (the measurement stops when we say so)', async () => {
  const { srv, open } = await start({ noReceipt: true });
  const s = await open();
  let n = 0;
  s.subscribe(TOPIC, () => { n++; });
  await srv.waitForSubscribe();
  srv.publish(TOPIC, 'before');
  await srv.waitFor(() => n === 1, 2000, 'first delivery');
  const closing = s.close({ timeoutMs: 300 });
  srv.publish(TOPIC, 'during');
  await closing;
  assert.equal(n, 1);
});

test('the session records when frames arrived, for the silence check and the first-message time', async () => {
  const { srv, open } = await start();
  const s = await open();
  s.subscribe(TOPIC, () => {});
  await srv.waitForSubscribe();
  assert.equal(s.stats.firstFrameAt, null);
  srv.publish(TOPIC, 'a');
  await srv.waitFor(() => s.stats.frames === 1, 2000, 'a');
  await new Promise(r => setTimeout(r, 60));
  srv.publish(TOPIC, 'b');
  await srv.waitFor(() => s.stats.frames === 2, 2000, 'b');
  assert.ok(s.stats.firstFrameAt >= s.subscribedAt);
  assert.ok(s.stats.maxGapMs >= 50);
  assert.equal(s.stats.lastFrameAt - s.stats.firstFrameAt >= 50, true);
});

test('STOMP 1.1 servers work too (header escaping differs from 1.2)', async () => {
  const { srv, open } = await start({ version: '1.1' });
  const s = await open();
  const got = [];
  s.subscribe(TOPIC, b => got.push(b));
  await srv.waitForSubscribe();
  srv.publish(TOPIC, 'hello');
  await srv.waitFor(() => got.length === 1, 2000, 'message');
  assert.deepEqual(got, ['hello']);
  assert.equal((await s.close()).clean, true);
});
