'use strict';

// lib/stomp.js without a network: error classification, the plain-words explanations, and the
// bounded connect via the injectable `connect`. The real-socket behaviour is in
// stomp.integration.test.js.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const util = require('util');
const stomp = require('../lib/stomp');
const { classifyError, explain, openSession, StompError } = stomp;

afterEach(() => stomp._resetForTest());

// What stompit raises: an Error decorated with the three predicates, plus ERROR-frame extras.
function stompitError(message, { kind = 'application', code, longMessage, connectArgs } = {}) {
  const e = new Error(message);
  e.isApplicationError = () => kind === 'application';
  e.isTransportError = () => kind === 'transport';
  e.isProtocolError = () => kind === 'protocol';
  if (code) e.code = code;
  if (longMessage) e.longMessage = longMessage;
  if (connectArgs) e.connectArgs = connectArgs;
  return e;
}
const SECRETS = ['rich@example.com', 'p$ssw0rd'];

// ---- classification ------------------------------------------------------------------------------

test('classify: ActiveMQ\'s bad-login wording is "auth", and the login it echoes is scrubbed', () => {
  for (const text of [
    'User name [rich@example.com] or password is invalid.',
    'java.lang.SecurityException: User name [rich@example.com] or password is invalid.',
    'Authentication failed',
    'Login incorrect',
    'bad credentials'
  ]) {
    const c = classifyError(stompitError(text), { phase: 'connect', secrets: SECRETS });
    assert.equal(c.kind, 'auth', text);
    assert.ok(!JSON.stringify(c).includes('rich@example.com'), `login leaked from: ${text}`);
  }
});

test('classify: "not authorized to read from" is "not-authorised", and the topic is recovered in either spelling', () => {
  const a = classifyError(stompitError('User rich@example.com is not authorized to read from: topic://TRAIN_MVT_ALL_TOC'), { secrets: SECRETS });
  assert.equal(a.kind, 'not-authorised');
  assert.equal(a.topic, '/topic/TRAIN_MVT_ALL_TOC');
  const b = classifyError(stompitError('User x is not authorized to read from: /topic/VSTP_ALL'), { secrets: SECRETS });
  assert.equal(b.topic, '/topic/VSTP_ALL');
  // British spelling, and the topic only in the long message.
  const c = classifyError(stompitError('server sent ERROR frame', { longMessage: 'java.lang.SecurityException: User x is not authorised to read from: topic://VSTP_ALL\n\tat ...' }));
  assert.equal(c.kind, 'not-authorised');
  assert.equal(c.topic, '/topic/VSTP_ALL');
  // No destination in the text: fall back to the one we were subscribing to.
  const d = classifyError(stompitError('not authorized'), { topic: '/topic/TRAIN_MVT_ALL_TOC' });
  assert.equal(d.topic, '/topic/TRAIN_MVT_ALL_TOC');
});

test('classify: authorisation is checked BEFORE login, because both are SecurityExceptions', () => {
  const c = classifyError(stompitError('SecurityException: User name [x] is not authorized to read from: topic://A, password is invalid'));
  assert.equal(c.kind, 'not-authorised');
});

test('classify: timeouts — stompit\'s two wordings, the OS code, and our own bound', () => {
  assert.equal(classifyError(stompitError('connect timed out', { kind: 'transport' })).kind, 'timeout');     // TCP phase
  assert.equal(classifyError(stompitError('connection timed out', { kind: 'transport' })).kind, 'timeout');  // heart-beat
  assert.equal(classifyError(stompitError('x', { kind: 'transport', code: 'ETIMEDOUT' })).kind, 'timeout');
  const own = Object.assign(new Error('not established within 30s'), { stompKind: 'timeout' });
  assert.equal(classifyError(own).kind, 'timeout');
});

test('classify: network errors keep their code', () => {
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EPIPE']) {
    const c = classifyError(stompitError(`connect ${code} 1.2.3.4:61618`, { kind: 'transport', code }));
    assert.equal(c.kind, 'network', code);
    assert.equal(c.code, code);
  }
  assert.equal(classifyError(stompitError('weird socket thing', { kind: 'transport' })).kind, 'network');
});

test('classify: the server hanging up without an ERROR frame is "server-closed"', () => {
  assert.equal(classifyError(stompitError('connection ended unexpectedly', { kind: 'protocol' })).kind, 'server-closed');
  assert.equal(classifyError(stompitError('connection ended without disconnect receipt', { kind: 'protocol' })).kind, 'server-closed');
});

test('classify: an ERROR frame we do not recognise is carried VERBATIM, never guessed at', () => {
  const c = classifyError(stompitError('Too many connections for user rich@example.com', {
    longMessage: 'javax.jms.JMSSecurityException: limit\n\tat a\n\tat b\n\tat c\n\tat d'
  }), { secrets: SECRETS });
  assert.equal(c.kind, 'server-error');
  assert.equal(c.serverMessage, 'Too many connections for user ***');
  assert.equal(c.serverDetail, 'javax.jms.JMSSecurityException: limit | \tat a | \tat b', 'first three lines only');
});

test('classify: protocol problems and plain errors', () => {
  assert.equal(classifyError(stompitError('invalid receipt', { kind: 'protocol' })).kind, 'protocol');
  assert.equal(classifyError(new Error('who knows')).kind, 'unknown');
  assert.equal(classifyError('a bare string').kind, 'unknown');
  assert.equal(classifyError(undefined).kind, 'unknown');
});

test('classify: nothing in the result can carry a credential, even from the long message', () => {
  const c = classifyError(stompitError('boom', { longMessage: 'login=rich@example.com pass=p$ssw0rd', connectArgs: { connectHeaders: { passcode: 'p$ssw0rd' } } }), { secrets: SECRETS });
  const dump = JSON.stringify(c) + util.inspect(c, { depth: 10 });
  assert.ok(!dump.includes('p$ssw0rd'));
  assert.ok(!dump.includes('rich@example.com'));
});

// ---- plain words --------------------------------------------------------------------------------------

test('explain: each kind says what happened and what to do, in words', () => {
  const ctx = { envFile: '/home/rich/rail-crossing/backend/.env' };
  const auth = explain({ kind: 'auth', message: 'User name [***] or password is invalid.', serverMessage: 'User name [***] or password is invalid.' }, ctx);
  assert.match(auth, /NR_FEED_USER and NR_FEED_PASS in \/home\/rich\/rail-crossing\/backend\/\.env/);
  assert.match(auth, /second connection/);
  assert.match(explain({ kind: 'not-authorised', topic: '/topic/VSTP_ALL', message: 'm', serverMessage: 'm' }), /not allowed to read \/topic\/VSTP_ALL/);
  assert.match(explain({ kind: 'timeout', message: 'connect timed out' }), /says nothing about the feed/);
  assert.match(explain({ kind: 'network', code: 'ECONNREFUSED', message: 'm' }), /outbound TCP port 61618/);
  assert.match(explain({ kind: 'server-closed', message: 'the connection ended' }), /limiting connections/);
  assert.match(explain({ kind: 'server-error', serverMessage: 'Weird', serverDetail: 'x | y', message: 'Weird' }), /"Weird" \(x \| y\)/);
  assert.match(explain({ kind: 'unknown', message: 'm' }), /Unexpected STOMP problem/);
});

// ---- the bounded connect, with an injected connect ---------------------------------------------------------

const CREDS = { user: 'rich@example.com', pass: 'p$ssw0rd' };

function fakeClient() {
  const c = { destroyed: 0, handlers: {} };
  c.on = (ev, fn) => { (c.handlers[ev] = c.handlers[ev] || []).push(fn); return c; };
  c.destroy = () => { c.destroyed++; };
  c.disconnect = cb => setImmediate(() => cb(null));
  c.subscribe = () => ({});
  return c;
}

test('a connect that never calls back is cut off at the bound, and the half-open client is destroyed', async () => {
  const client = fakeClient();
  const t0 = Date.now();
  await assert.rejects(
    openSession({ creds: CREDS, connect: () => client, connectTimeoutMs: 80 }),
    e => e instanceof StompError && e.kind === 'timeout' && /within 0s|not established/.test(e.message));
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(client.destroyed, 1);
});

test('a callback that arrives AFTER the bound does not become a live client', async () => {
  const late = fakeClient();
  let deliver;
  const connect = (opts, cb) => { deliver = () => cb(null, late); return fakeClient(); };
  await assert.rejects(openSession({ creds: CREDS, connect, connectTimeoutMs: 30 }), e => e.kind === 'timeout');
  deliver();
  assert.equal(late.destroyed, 1, 'the late client is destroyed, not kept');
  assert.equal(late.handlers.error.length, 1, 'with a no-op error listener, so destroying it cannot throw');
  // The slot is free again.
  const ok = await openSession({ creds: CREDS, connect: (o, cb) => { const c = fakeClient(); setImmediate(() => cb(null, c)); return c; } });
  assert.ok(ok.isOpen);
  await ok.close();
});

test('cancelling while connecting abandons the attempt at once', async () => {
  const client = fakeClient();
  let cancel;
  const cancelled = new Promise(res => { cancel = res; });
  const p = openSession({ creds: CREDS, connect: () => client, connectTimeoutMs: 5000, cancel: cancelled });
  setTimeout(cancel, 20);
  await assert.rejects(p, e => e.kind === 'aborted');
  assert.equal(client.destroyed, 1);
});

test('a connect that throws synchronously is reported, not thrown past us, and frees the slot', async () => {
  await assert.rejects(openSession({ creds: CREDS, connect: () => { throw new Error('expected ssl property to have boolean value'); } }),
    e => e instanceof StompError && /expected ssl/.test(e.message));
  const ok = await openSession({ creds: CREDS, connect: (o, cb) => { const c = fakeClient(); setImmediate(() => cb(null, c)); return c; } });
  await ok.close();
});

test('stompit\'s connectArgs (login + passcode) is stripped from the error and never reaches the StompError', async () => {
  const bad = stompitError('User name [rich@example.com] or password is invalid.', { connectArgs: { connectHeaders: { login: CREDS.user, passcode: CREDS.pass } } });
  let err;
  await openSession({ creds: CREDS, connect: (o, cb) => { setImmediate(() => cb(bad)); return fakeClient(); } }).catch(e => { err = e; });
  assert.equal(err.kind, 'auth');
  assert.equal(bad.connectArgs, undefined, 'removed from stompit\'s own error object too');
  const dump = util.inspect(err, { depth: 12 }) + JSON.stringify(err.info);
  assert.ok(!dump.includes(CREDS.pass));
  assert.ok(!dump.includes(CREDS.user));
});

test('the connect options are exactly what the brief asks for', async () => {
  let seen;
  const connect = (opts, cb) => { seen = opts; const c = fakeClient(); setImmediate(() => cb(null, c)); return c; };
  const s = await openSession({ creds: CREDS, connect });
  assert.equal(seen.host, 'publicdatafeeds.networkrail.co.uk');
  assert.equal(seen.port, 61618);
  assert.equal(seen.timeout, 30000, 'stompit\'s own 3 s TCP bound is raised to ours');
  const h = seen.connectHeaders;
  assert.equal(h.host, '/');
  assert.equal(h.login, CREDS.user);
  assert.equal(h.passcode, CREDS.pass);
  assert.equal(h['heart-beat'], '15000,15000');
  assert.match(h['client-id'], /^rail-map-phase0-\d+-[0-9a-f]{8}$/);
  assert.deepEqual(Object.keys(h).filter(k => /activemq|durable|subscription/i.test(k)), []);
  assert.equal(stomp.CONNECT_TIMEOUT_MS, 30000);
  await s.close();
});

test('every connection gets its own client-id', async () => {
  const ids = [];
  const connect = (opts, cb) => { ids.push(opts.connectHeaders['client-id']); const c = fakeClient(); setImmediate(() => cb(null, c)); return c; };
  for (let i = 0; i < 3; i++) await (await openSession({ creds: CREDS, connect })).close();
  assert.equal(new Set(ids).size, 3);
});

test('openSession refuses without credentials', async () => {
  await assert.rejects(openSession({ creds: { user: 'x' } }), TypeError);
  await assert.rejects(openSession({}), TypeError);
});
