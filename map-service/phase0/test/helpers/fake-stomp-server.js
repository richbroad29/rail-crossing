'use strict';

// A minimal STOMP server on Node's `net`, faithful enough to drive the REAL stompit through
// lib/stomp.js: CONNECT/STOMP -> CONNECTED with heart-beat negotiation, SUBSCRIBE, MESSAGE frames
// carrying subscription / message-id / destination, an ERROR frame for a forbidden topic (worded
// like ActiveMQ's), DISCONNECT -> RECEIPT, null-byte terminators, header escaping, optional
// content-length. Every frame it receives is recorded so tests can assert on what the client
// actually put on the wire — which is the only honest way to prove "never a durable subscription".
//
// It is NOT a broker: no queues, no persistence. publish() writes to whoever is subscribed now.

const net = require('net');

const decodeHeader = v => v.replace(/\\(.)/g, (m, c) => ({ n: '\n', c: ':', r: '\r', '\\': '\\' }[c] ?? m));
const encodeHeader = v => String(v).replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/:/g, '\\c');

class FrameParser {
  constructor(onFrame, { decode }) { this.buf = Buffer.alloc(0); this.onFrame = onFrame; this.decode = decode; }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      // Bare EOLs between frames are heart-beats.
      let skip = 0;
      while (skip < this.buf.length && (this.buf[skip] === 0x0a || this.buf[skip] === 0x0d)) skip++;
      if (skip) this.buf = this.buf.subarray(skip);
      if (!this.buf.length) return;
      let end = this.buf.indexOf('\n\n'), sepLen = 2;
      const crlf = this.buf.indexOf('\r\n\r\n');
      if (crlf !== -1 && (end === -1 || crlf < end)) { end = crlf; sepLen = 4; }
      if (end === -1) return;
      const lines = this.buf.subarray(0, end).toString('utf8').split(/\r?\n/);
      const command = lines.shift();
      const headers = {};
      // CONNECT's headers are never escaped (STOMP 1.2 §Value Encoding); everything else is.
      const dec = command === 'CONNECT' || command === 'STOMP' ? (x => x) : this.decode;
      for (const l of lines) {
        const i = l.indexOf(':');
        if (i < 0) continue;
        const name = dec(l.slice(0, i));
        if (!(name in headers)) headers[name] = dec(l.slice(i + 1));
      }
      const bodyStart = end + sepLen;
      let bodyEnd;
      if (headers['content-length'] !== undefined) {
        bodyEnd = bodyStart + parseInt(headers['content-length'], 10);
        if (this.buf.length < bodyEnd + 1) return;
      } else {
        bodyEnd = this.buf.indexOf(0, bodyStart);
        if (bodyEnd === -1) return;
      }
      const body = this.buf.subarray(bodyStart, bodyEnd).toString('utf8');
      this.buf = this.buf.subarray(bodyEnd + 1);
      this.onFrame({ command, headers, body });
    }
  }
}

function frameBytes(command, headers = {}, body = '', { escape = true } = {}) {
  const enc = escape ? encodeHeader : String;
  let head = `${command}\n`;
  for (const [k, v] of Object.entries(headers)) head += `${enc(k)}:${enc(v)}\n`;
  return Buffer.concat([Buffer.from(`${head}\n`, 'utf8'), Buffer.from(body, 'utf8'), Buffer.from([0])]);
}

class FakeStompServer {
  /**
   * @param {object} [opts]
   * @param {string}   opts.login / opts.passcode   the credentials it accepts
   * @param {string}   opts.version                 STOMP version to answer with (default 1.2)
   * @param {number[]} opts.heartbeat               [what we send, what we want] in ms; [0,0] disables
   * @param {string[]} opts.forbidden               destinations that get an ERROR frame on SUBSCRIBE
   * @param {string}   opts.errorOnSubscribe        answer EVERY SUBSCRIBE with an ERROR frame saying this
   * @param {boolean}  opts.bareErrors              ERROR frames carry only a `message` header, no body
   * @param {string}   opts.mode                    'normal' | 'blackhole' (accept TCP, never answer CONNECT)
   * @param {boolean}  opts.noReceipt               ignore DISCONNECT's receipt request (to test the bound)
   * @param {boolean}  opts.contentLength           put content-length on MESSAGE frames (default true)
   */
  constructor(opts = {}) {
    this.opts = {
      login: 'tester@example.com', passcode: 'p$ss"w\\rd:x', version: '1.2', heartbeat: [15000, 15000],
      forbidden: [], errorOnSubscribe: null, mode: 'normal', noReceipt: false, contentLength: true, ...opts
    };
    this.connections = [];
    this.frames = [];
    this._nextConn = 1;
    this._nextMsg = 1;
    this.server = net.createServer(sock => this._onSocket(sock));
  }

  async listen() {
    await new Promise((res, rej) => { this.server.once('error', rej); this.server.listen(0, '127.0.0.1', res); });
    this.port = this.server.address().port;
    return this.port;
  }

  async close() {
    for (const c of this.connections) c.socket.destroy();
    await new Promise(res => this.server.close(() => res()));
  }

  _onSocket(socket) {
    socket.setNoDelay(true);
    const conn = { id: this._nextConn++, socket, subs: new Map(), connected: false, closed: false, connectHeaders: null, openedAt: Date.now() };
    this.connections.push(conn);
    const parser = new FrameParser(f => this._onFrame(conn, f), { decode: decodeHeader });
    socket.on('data', d => { if (this.opts.mode !== 'blackhole') parser.push(d); else conn.bytesIgnored = (conn.bytesIgnored || 0) + d.length; });
    socket.on('close', () => { conn.closed = true; });
    socket.on('error', () => { conn.closed = true; });
  }

  _send(conn, command, headers, body, o) {
    if (conn.closed || conn.socket.destroyed) return;
    conn.socket.write(frameBytes(command, headers, body, { escape: this.opts.version !== '1.0', ...o }));
  }

  // Two shapes of ERROR frame, because stompit's handler branches on them: ActiveMQ-style (a
  // stack trace as a text/plain body with a content-length) and bare (just a message header).
  _error(conn, text, stack, o) {
    if (this.opts.bareErrors) this._send(conn, 'ERROR', { message: text }, '', o);
    else this._send(conn, 'ERROR', { message: text, 'content-type': 'text/plain', 'content-length': Buffer.byteLength(stack) }, stack, o);
  }

  _onFrame(conn, frame) {
    this.frames.push({ connId: conn.id, at: Date.now(), ...frame });
    const { command, headers } = frame;
    if (command === 'CONNECT' || command === 'STOMP') {
      conn.connectHeaders = headers;
      if (headers.login !== this.opts.login || headers.passcode !== this.opts.passcode) {
        // Echoes the login, as ActiveMQ does — the redaction tests depend on that.
        const text = `User name [${headers.login}] or password is invalid.`;
        const body = `java.lang.SecurityException: ${text}\n\tat org.apache.activemq.security.JaasAuthenticationBroker.addConnection(JaasAuthenticationBroker.java:98)`;
        // Before CONNECTED the client has not negotiated a version: headers are not escaped yet.
        this._error(conn, text, body, { escape: false });
        setTimeout(() => conn.socket.end(), 10);
        return;
      }
      conn.connected = true;
      const [sx, sy] = this.opts.heartbeat;
      this._send(conn, 'CONNECTED', { version: this.opts.version, 'heart-beat': `${sx},${sy}`, session: `ID:fake-${conn.id}`, server: 'FakeActiveMQ/0.1' }, '', { escape: false });
      return;
    }
    if (!conn.connected) return;
    if (command === 'SUBSCRIBE') {
      const dest = headers.destination;
      if (this.opts.errorOnSubscribe || this.opts.forbidden.includes(dest)) {
        const text = this.opts.errorOnSubscribe
          || `User ${conn.connectHeaders.login} is not authorized to read from: topic://${String(dest).replace(/^\/topic\//, '')}`;
        const body = `java.lang.SecurityException: ${text}\n\tat org.apache.activemq.security.AuthorizationBroker.addConsumer(AuthorizationBroker.java:75)`;
        this._error(conn, text, body);
        setTimeout(() => conn.socket.end(), 10);
        return;
      }
      conn.subs.set(headers.id, dest);
      if (headers.receipt) this._send(conn, 'RECEIPT', { 'receipt-id': headers.receipt }, '');
      return;
    }
    if (command === 'UNSUBSCRIBE') { conn.subs.delete(headers.id); return; }
    if (command === 'DISCONNECT') {
      conn.sawDisconnect = true;
      if (headers.receipt && !this.opts.noReceipt) this._send(conn, 'RECEIPT', { 'receipt-id': headers.receipt }, '');
      if (!this.opts.noReceipt) setTimeout(() => conn.socket.end(), 10);
    }
  }

  /** Deliver one message body to every matching subscription; returns how many frames went out. */
  publish(destination, body, { contentLength = this.opts.contentLength } = {}) {
    let n = 0;
    for (const conn of this.connections) {
      if (conn.closed || !conn.connected) continue;
      for (const [id, dest] of conn.subs) {
        if (dest !== destination) continue;
        const headers = {
          subscription: id, 'message-id': `ID:fake-${conn.id}:1:1:1:${this._nextMsg++}`, destination,
          'content-type': 'text/plain', timestamp: Date.now(), expires: 0, priority: 4
        };
        if (contentLength) headers['content-length'] = Buffer.byteLength(body);
        this._send(conn, 'MESSAGE', headers, body);
        n++;
      }
    }
    return n;
  }

  /** Hard-drop every client with no goodbye, as a dying server or a middlebox would. */
  dropAll() { for (const c of this.connections) c.socket.destroy(); }

  framesOf(command) { return this.frames.filter(f => f.command === command); }
  get openCount() { return this.connections.filter(c => !c.closed).length; }

  async waitFor(predicate, timeoutMs = 3000, label = 'condition') {
    const t0 = Date.now();
    while (!predicate()) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label}`);
      await new Promise(r => setTimeout(r, 5));
    }
  }
  waitForSubscribe(n = 1) { return this.waitFor(() => this.framesOf('SUBSCRIBE').length >= n, 3000, 'SUBSCRIBE'); }
}

module.exports = { FakeStompServer, frameBytes, FrameParser };
