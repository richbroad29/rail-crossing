'use strict';

// The one way the map service talks to Network Rail's STOMP feed (copied from phase 0, map-service/phase0/lib/stomp.js).
//
// Every rule here exists because the crossing service has already paid for it or because breaking
// it would cost the crossing service something:
//
//   * Connect is BOUNDED (30 s). stompit's own `timeout` only covers the TCP connect and is
//     cleared the moment the socket is up, so a server that accepts TCP and never answers CONNECT
//     hangs forever — which is the shape of the 2026-09-22 outage (td-listener.js, register #21).
//   * Subscriptions are NON-DURABLE, structurally: `subscribe()` takes no headers, so there is no
//     way to add `activemq.subscriptionName`. A durable subscription would make NROD queue
//     messages for this login after we leave, and hand them to us (or the crossing service) later.
//   * A client-id unique per connection, so it can never collide with `rail-crossing-<pid>`.
//   * Exactly one connection at a time per process (the crossing service holds its own, on the same
//     login, from its own process).
//   * DISCONNECT is sent and awaited (bounded) on finish, so NROD sees us leave rather than
//     time out.
//   * The login only ever goes to loopback or the real NROD host (ALLOWED_STOMP_HOSTS below):
//     the --stomp-host test flag cannot be used to send it anywhere else.
//   * Credentials never leave this module in an error: stompit attaches the connect options —
//     login and passcode included — to the errors it raises (`error.connectArgs`), and ERROR
//     frames echo the login. Both are removed/redacted before anything is thrown or emitted.
//
// `connect` is injectable so tests can stand in for stompit; the integration tests do the
// opposite and drive the real stompit against a fake server on a local port.

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { redact, secretsFor } = require('./env');

const NROD = Object.freeze({ host: 'publicdatafeeds.networkrail.co.uk', port: 61618 });

// Where the NROD login may be sent. The scripts' --stomp-host flag exists so they can be pointed at a
// fake server on this machine for testing; it must never be a way to send the real login to a host
// nobody intended. EXACT, case-sensitive matches only — "LOCALHOST", "localhost.", "127.0.0.2",
// "127.0.0.1.evil.com" and anything with a port, a user or brackets are all refused, because the
// point is that there is no cleverness to get wrong. Enforced three times, because each is a
// different way in: at the command line (exit 2, before the credentials are read), at the top of each
// script's run() (any other caller, also before the credentials are read), and in openSession, where
// the login is actually put on the wire.
const ALLOWED_STOMP_HOSTS = Object.freeze(['localhost', '127.0.0.1', '::1', NROD.host]);

function isAllowedStompHost(host) {
  return typeof host === 'string' && ALLOWED_STOMP_HOSTS.includes(host);
}

/** The refusal, in plain words, for every place that has to say it. */
function hostRefusal(host) {
  return `--stomp-host must be localhost, 127.0.0.1, ::1 or ${NROD.host} (you gave "${host}"). `
    + 'It exists so the scripts can be tested against a fake server on this machine, and the NROD login is never sent anywhere else.';
}

const CONNECT_TIMEOUT_MS = 30 * 1000;
const DISCONNECT_TIMEOUT_MS = 5 * 1000;
const HEARTBEAT = '15000,15000';

let active = null; // the single open (or opening) session in this process

function makeClientId() {
  return `rail-map-svc-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
}

// ---- error classification ----------------------------------------------------------------------

// ActiveMQ's wording, UNVERIFIED against NROD itself: the authorisation sentence is the brief's
// ("User ... is not authorized to read from: /topic/..."); the bad-login one is my recollection of
// ActiveMQ's ("User name [<name>] or password is invalid."). Both are expected as ERROR frames, and
// the authorisation test runs first because both are java.lang.SecurityException, so the exception
// name proves nothing. Anything that matches neither is NOT guessed at: it is passed through
// verbatim as "server-error" (see classifyError), so a wrong guess here costs a label, never a lie.
const NOT_AUTHORISED = /not authori[sz]ed|authori[sz]ation (?:failed|denied)|not permitted to (?:read|subscribe)/i;
const BAD_LOGIN = /(?:user ?name|login|password|passcode|credentials?)[^\n]{0,80}(?:invalid|incorrect|wrong|rejected|refused|denied|failed)|authenticat\w*[^\n]{0,40}(?:fail|refus|reject|denied|invalid|required)|not authenticated|bad credentials/i;
const DESTINATION = /(?:read from|write to|subscribe to|access)[:\s]+((?:topic|queue):\/\/[^\s,;"')]+|\/(?:topic|queue)\/[^\s,;"')]+)/i;
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'ECONNABORTED', 'EPIPE']);

function normaliseDestination(d) {
  const m = /^(topic|queue):\/\/(.+)$/i.exec(d);
  return m ? `/${m[1].toLowerCase()}/${m[2]}` : d;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/**
 * Turn whatever stompit (or our own bound) raised into a plain, credential-free description.
 *
 * kinds:  auth            NROD refused the login
 *         not-authorised  the login may not read the topic (the feed is not switched on)
 *         timeout         nothing happened in time (connect bound, heart-beat, OS timeout)
 *         network         could not reach NROD, or the link broke (refused, DNS, reset)
 *         server-closed   NROD closed the connection without an ERROR frame
 *         server-error    an ERROR frame that is none of the above — shown verbatim
 *         protocol        a STOMP-level problem
 *         aborted         we gave up on purpose (interlock trip, signal)
 *         refused         we would not send the login to that host (see ALLOWED_STOMP_HOSTS)
 *         busy            a connection is already open in this process
 *         unknown
 * `serverMessage`/`serverDetail` are NROD's own words, redacted: never over-classify what we
 * cannot be sure of, and always carry what the server actually said.
 */
function classifyError(err, ctx = {}) {
  const secrets = ctx.secrets || [];
  const r = s => redact(s, secrets);
  const rawMessage = r(err && err.message ? String(err.message) : String(err));
  const longMessage = err && err.longMessage ? String(err.longMessage) : '';
  const code = (err && (err.code || (typeof err.errno === 'string' ? err.errno : null))) || null;
  const isApp = !!(err && typeof err.isApplicationError === 'function' && err.isApplicationError());
  const isTransport = !!(err && typeof err.isTransportError === 'function' && err.isTransportError());
  const isProtocol = !!(err && typeof err.isProtocolError === 'function' && err.isProtocolError());
  const text = `${rawMessage}\n${r(longMessage)}`;

  let kind;
  if (err && err.stompKind) kind = err.stompKind;
  else if (NOT_AUTHORISED.test(text)) kind = 'not-authorised';
  else if (BAD_LOGIN.test(text)) kind = 'auth';
  else if (code === 'ETIMEDOUT' || /timed out/i.test(rawMessage)) kind = 'timeout';
  else if (code && NETWORK_CODES.has(code)) kind = 'network';
  else if (isApp) kind = 'server-error';
  else if (/connection ended/i.test(rawMessage)) kind = 'server-closed';
  else if (isTransport) kind = 'network';
  else if (isProtocol) kind = 'protocol';
  else kind = 'unknown';

  let topic = ctx.topic || null;
  if (kind === 'not-authorised') {
    const m = DESTINATION.exec(text);
    if (m) topic = normaliseDestination(m[1]);
  }
  return {
    kind,
    phase: ctx.phase || 'unknown',
    topic,
    code,
    serverMessage: isApp ? clip(rawMessage, 300) : null,
    serverDetail: longMessage ? clip(r(longMessage).split('\n').slice(0, 3).join(' | '), 300) : null,
    message: clip(rawMessage, 300)
  };
}

class StompError extends Error {
  constructor(info) {
    super(info.serverMessage || info.message);
    this.name = 'StompError';
    this.info = info;
    this.kind = info.kind;
  }
}

/**
 * Plain words for a person who is not a developer: what happened, and what to do about it.
 * `ctx`: {host, port, envFile, topicLabel}.
 */
function explain(info, ctx = {}) {
  const where = `${ctx.host || NROD.host}:${ctx.port || NROD.port}`;
  const said = info.serverMessage || info.message;
  switch (info.kind) {
    case 'auth':
      return `NROD refused the login (it said: "${said}"). Check NR_FEED_USER and NR_FEED_PASS in ${ctx.envFile || 'the .env file'}. `
        + 'If the crossing service is connected with this same login right now, this may instead be NROD refusing a second connection on one login.';
    case 'not-authorised':
      return `This login is not allowed to read ${info.topic || ctx.topicLabel || 'that topic'} (NROD said: "${said}").`;
    case 'timeout':
      return `Timed out talking to NROD at ${where} (${said}). This says nothing about the feed itself: check the server's internet connection, then run it again.`;
    case 'network':
      return `Could not reach NROD at ${where} (${info.code || said}). Check the server's internet connection and that outbound TCP port ${ctx.port || NROD.port} is allowed, then run it again.`;
    case 'server-closed':
      return `NROD closed the connection without saying why (${said}). If this repeats, it may be limiting connections on this login.`;
    case 'server-error':
      return `NROD sent an error we do not recognise: "${said}"${info.serverDetail ? ` (${info.serverDetail})` : ''}.`;
    case 'aborted':
      return `Stopped before the connection was ready (${said}).`;
    case 'busy':
    case 'refused':
      return said;
    default:
      return `Unexpected STOMP problem (${said}).`;
  }
}

// ---- the session -------------------------------------------------------------------------------

class StompSession extends EventEmitter {
  constructor({ host, port, clientId, secrets, now }) {
    super();
    this.host = host;
    this.port = port;
    this.clientId = clientId;
    this._secrets = secrets;
    this._now = now;
    this._client = null;
    this._topic = null;
    this._closing = false;
    this._finished = false;
    this._closePromise = null;
    this.closedInfo = null;
    this.connectedAt = null;
    this.subscribedAt = null;
    this.closedAt = null;
    this.stats = { frames: 0, firstFrameAt: null, lastFrameAt: null, maxGapMs: 0, readErrors: 0, handlerErrors: 0, firstHandlerError: null };
  }

  get isOpen() { return !this._finished; }

  /** Called synchronously from inside the connect callback — see connectBounded. */
  _attach(client) {
    this._client = client;
    this.connectedAt = this._now();
    client.on('error', err => this._fail(err));
    client.on('end', () => {
      if (this._finished) return;
      // stompit emits 'end' after the DISCONNECT receipt too; that is us leaving, not a fault.
      if (this._closing) { this._finish(null); return; }
      this._finish(new StompError({
        kind: 'server-closed', phase: this._phase(), topic: this._topic, code: null,
        serverMessage: null, serverDetail: null, message: 'the connection ended'
      }));
    });
  }

  _phase() {
    if (this.stats.frames > 0) return 'streaming';
    return this.subscribedAt ? 'subscribed' : 'connected';
  }

  // stompit reports one failure through the client's 'error' event AND through every
  // subscription's listener; whichever arrives first wins and the rest are ignored.
  _fail(err) {
    if (this._finished) return;
    this._finish(new StompError(classifyError(err, { phase: this._phase(), topic: this._topic, secrets: this._secrets })));
  }

  _finish(error) {
    if (this._finished) return;
    this._finished = true;
    this.closedAt = this._now();
    if (active === this) active = null;
    // Anything that arrives after we asked to close is part of closing, not a fault.
    this.closedInfo = { unexpected: !this._closing, error: error || null, at: this.closedAt };
    this.emit('closed', this.closedInfo);
  }

  /**
   * Subscribe, NON-durably. No `headers` argument on purpose: the only SUBSCRIBE this module can
   * send is {destination, ack: 'auto', id}. `onBody(bodyString, frameHeaders)` is called for each
   * message; if it throws, the error is counted and the session carries on.
   */
  subscribe(topic, onBody) {
    if (this._finished) throw new Error('the STOMP session is already closed');
    this._topic = topic;
    this.subscribedAt = this._now();
    this._client.subscribe({ destination: topic, ack: 'auto' }, (err, message) => {
      if (err) { this._fail(err); return; }
      // Every frame must be read to its end or stompit stops parsing the next one.
      let done = false;
      message.readString('utf-8', (readErr, body) => {
        if (done) return;
        done = true;
        if (readErr) { this.stats.readErrors++; return; }
        this._deliver(body, message.headers, onBody);
      });
    });
  }

  _deliver(body, headers, onBody) {
    if (this._closing || this._finished) return;
    const t = this._now();
    const s = this.stats;
    if (s.firstFrameAt === null) s.firstFrameAt = t;
    else s.maxGapMs = Math.max(s.maxGapMs, t - s.lastFrameAt);
    s.lastFrameAt = t;
    s.frames++;
    try { onBody(body, headers, t); }
    catch (e) {
      s.handlerErrors++;
      if (s.firstHandlerError === null) s.firstHandlerError = redact(e && e.message, this._secrets);
    }
  }

  /**
   * Leave properly: DISCONNECT, wait (bounded) for NROD's RECEIPT, then make sure the socket is
   * gone. Idempotent. Resolves {clean, how, ms}; `how` is 'receipt', 'timeout', 'error' or
   * 'already-closed' (the server had already dropped us, so there was nothing to say goodbye to).
   */
  close({ timeoutMs = DISCONNECT_TIMEOUT_MS } = {}) {
    if (this._closePromise) return this._closePromise;
    this._closing = true;
    const t0 = this._now();
    this._closePromise = new Promise(resolve => {
      const client = this._client;
      const finishWith = how => {
        if (!this._finished) this._finish(null);
        resolve({ clean: how === 'receipt', how, ms: this._now() - t0 });
      };
      if (this._finished || !client) return finishWith('already-closed');
      let settled = false;
      const settle = how => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (how !== 'receipt') { try { client.destroy(); } catch (_) { /* already gone */ } }
        finishWith(how);
      };
      const timer = setTimeout(() => settle('timeout'), timeoutMs);
      try {
        client.disconnect(err => settle(err ? 'error' : 'receipt'));
      } catch (_) {
        settle('error');
      }
    });
    return this._closePromise;
  }

  /** Hard stop for crash handlers: no goodbye, just make sure the socket is gone. */
  kill() {
    this._closing = true;
    try { if (this._client) this._client.destroy(); } catch (_) { /* already gone */ }
    if (!this._finished) this._finish(null);
  }
}

// ---- working around stompit 1.0.0's ERROR-frame handler ----------------------------------------
//
// stompit's own handler for an ERROR frame (Client.js `onError`) does
//
//     frame.on('end', function () { error.longMessage = ...; this.destroy(error); });
//
// when the frame has `content-type: text/plain` and `content-length <= 4096`. In that plain
// function `this` is the FRAME stream, not the client, so the error is emitted on the frame — which
// nobody listens to — and the process dies with an uncaught exception. Neither `client.on('error')`
// nor the subscription callback is ever called. Reproduced with raw stompit against a server that
// answers a forbidden SUBSCRIBE (or a bad login) with such a frame; the unauthorised-topic outcome
// phase 0 must CLASSIFY would otherwise crash it. (Whether NROD's own ERROR frames carry those
// headers is not verified; ActiveMQ's are believed to. td-listener.js has the same exposure.)
//
// The fix uses only public API: stompit sets its handler map through `setCommandHandlers`, once
// at CONNECT and again at CONNECTED, so wrapping that method on this one client substitutes ours
// every time. Ours reads the body (bounded) and destroys the CLIENT with the error, as intended.

const ERROR_BODY_MAX = 4096;

function safeErrorHandler(frame) {
  const client = this; // stompit calls handlers with apply(client, ...)
  const message = (frame.headers && frame.headers.message) || 'server sent ERROR frame';
  const error = client.createApplicationError(message);
  let done = false;
  const finish = text => {
    if (done) return;
    done = true;
    if (text) error.longMessage = text;
    client.destroy(error);
  };
  const chunks = [];
  let size = 0;
  frame.on('data', c => { if (size < ERROR_BODY_MAX) { chunks.push(c); size += c.length; } });
  frame.on('end', () => finish(Buffer.concat(chunks).toString('utf8').slice(0, ERROR_BODY_MAX)));
  frame.on('error', () => finish(''));
}

function hardenClient(client) {
  if (!client || typeof client.setCommandHandlers !== 'function') return; // a test stand-in
  const original = client.setCommandHandlers.bind(client);
  client.setCommandHandlers = handlers => original(handlers && handlers.ERROR ? { ...handlers, ERROR: safeErrorHandler } : handlers);
}

// ---- opening -----------------------------------------------------------------------------------

function defaultConnect(options, callback) {
  // Required lazily, as td-listener.js does: `--help` and the pure modules work without it.
  let stompit;
  try { stompit = require('stompit'); }
  catch (e) {
    // Not a network problem: retrying cannot help. TdIngest treats this kind as fatal.
    throw Object.assign(new Error('the "stompit" package is not installed (run "npm ci")'), { stompKind: 'missing-dependency' });
  }
  return stompit.connect(options, callback);
}

/**
 * One bounded connect attempt. Settles exactly once: with the client, or with an error.
 *
 * The session is attached to the client SYNCHRONOUSLY inside stompit's callback. stompit removes
 * its own 'error' listeners just before calling us, and an 'error' event with no listener throws,
 * so an `await` between the callback and our listener would leave a window in which one stray
 * frame could crash the process.
 */
function connectBounded({ connect, options, timeoutMs, cancel, session, classify }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let client = null;
    let timer = null;

    const quietlyDestroy = c => {
      if (!c) return;
      try { c.on('error', () => {}); c.destroy(); } catch (_) { /* already gone */ }
    };
    // Classify the moment an error is SEEN, not later. stompit hands an ERROR-frame error to the
    // callback and then, a tick later, net.Socket's own 'error' runs createTransportError() on the
    // very same object — re-decorating it in place, so isApplicationError() turns false and
    // isTransportError() true. Anything that inspects the error after an `await` sees the wrong
    // kind of error.
    const failWith = e => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      reject(new StompError(classify(e)));
      return true;
    };
    const succeed = c => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(c);
    };
    const synthetic = (kind, message) => Object.assign(new Error(message), { stompKind: kind });

    timer = setTimeout(() => {
      if (failWith(synthetic('timeout', `the connection was not established within ${Math.round(timeoutMs / 1000)}s`))) quietlyDestroy(client);
    }, timeoutMs);

    if (cancel) {
      cancel.then(() => {
        if (failWith(synthetic('aborted', 'cancelled while connecting'))) quietlyDestroy(client);
      });
    }

    try {
      client = connect(options, (err, c) => {
        const live = c || client;
        if (settled) { quietlyDestroy(live); return; }   // a late arrival must not become a live client
        if (err) {
          delete err.connectArgs;                         // holds the login and passcode
          failWith(err);
          return;
        }
        session._attach(live);
        succeed(live);
      });
      // stompit returns the client synchronously, before any socket I/O: patch it now, before it
      // sets its first command-handler map.
      hardenClient(client);
    } catch (e) {
      failWith(e);
    }
  });
}

/**
 * Connect to NROD and return a StompSession, or throw a StompError.
 *
 * @param {object}   o
 * @param {{user,pass}} o.creds
 * @param {string[]} [o.secrets]          extra strings to scrub from anything that comes back
 * @param {string}   [o.host]/[o.port]    default NROD (tests point it at a local fake)
 * @param {function} [o.connect]          stompit.connect stand-in
 * @param {number}   [o.connectTimeoutMs] default 30 s
 * @param {string}   [o.heartbeat]        default '15000,15000'
 * @param {Promise}  [o.cancel]           resolve to abandon the attempt (interlock trip, Ctrl-C)
 */
async function openSession(o) {
  const creds = o && o.creds;
  if (!creds || !creds.user || !creds.pass) throw new TypeError('openSession needs creds {user, pass}');
  const host = o.host || NROD.host, port = o.port || NROD.port;
  const secrets = [...secretsFor(creds), ...(o.secrets || [])];
  const now = o.now || Date.now;

  // The last line of defence for the login: refuse BEFORE anything is opened or reserved.
  if (!isAllowedStompHost(host)) {
    throw new StompError({
      kind: 'refused', phase: 'connect', topic: null, code: null, serverMessage: null, serverDetail: null,
      message: hostRefusal(host)
    });
  }

  if (active) {
    throw new StompError({
      kind: 'busy', phase: 'connect', topic: null, code: null, serverMessage: null, serverDetail: null,
      message: 'a STOMP connection is already open in this process; the map service only ever holds one at a time'
    });
  }
  const clientId = o.clientId || makeClientId();
  const session = new StompSession({ host, port, clientId, secrets, now });
  active = session; // reserved before the first await, so two racing opens cannot both pass

  const timeoutMs = o.connectTimeoutMs || CONNECT_TIMEOUT_MS;
  const options = {
    host, port,
    // stompit's TCP-connect bound: set to ours, because its 3 s default is shorter than we want.
    // It ends when the socket is up; connectBounded bounds the whole attempt.
    timeout: timeoutMs,
    connectHeaders: {
      host: '/',
      login: creds.user,
      passcode: creds.pass,
      'heart-beat': o.heartbeat || HEARTBEAT,
      'client-id': clientId
    }
  };
  try {
    await connectBounded({
      connect: o.connect || defaultConnect, options, timeoutMs, cancel: o.cancel || null, session,
      classify: e => classifyError(e, { phase: 'connect', secrets })
    });
  } catch (e) {
    if (active === session) active = null;
    throw e; // already a StompError, classified when it was first seen
  }
  return session;
}

/**
 * Drop whatever connection is open, with no goodbye. For the places that cannot wait for a clean
 * DISCONNECT — an uncaught exception, a second Ctrl-C — so the socket is closed by us rather than
 * left for the OS to reap. Safe to call when nothing is open.
 */
function killActive() {
  if (active) active.kill();
}

/** Test seam: forget any session left open by a test that failed before closing it. */
function _resetForTest() { active = null; }

module.exports = {
  NROD, ALLOWED_STOMP_HOSTS, CONNECT_TIMEOUT_MS, DISCONNECT_TIMEOUT_MS, HEARTBEAT,
  openSession, isAllowedStompHost, hostRefusal, classifyError, explain, makeClientId, killActive,
  StompError, StompSession, _resetForTest
};
