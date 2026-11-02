'use strict';

// A stand-in for the crossing service's /health: a tiny HTTP server whose answer the test can
// change between polls — healthy, stale, 500, garbage, hung, or a dropped connection.

const http = require('http');

/** A body shaped like the real one (see api.js on backend-v2), with a td block. Uptime advances in real time. */
function healthyBody(over = {}) {
  const t0 = Date.now();
  return () => ({
    status: 'ok', uptime: 5000 + (Date.now() - t0) / 1000, crossings: 1, memory: '66MB', time: new Date().toISOString(),
    td: { started: true, connected: true, lastMessageAt: new Date().toISOString(), staleSecs: 2, stale: false, messagesReceived: 120, forcedReconnects: 0, lastForcedReconnectAt: null, ...(over.td || {}) },
    ...(over.body || {})
  });
}

class FakeHealth {
  /** @param {object|function} body  what /health returns (a function is called per request) */
  constructor(body = healthyBody()) {
    this.body = body;
    this.mode = 'ok';
    this.requests = 0;
    this.sockets = new Set();
    this.server = http.createServer((req, res) => this._handle(req, res));
    this.server.on('connection', s => { this.sockets.add(s); s.on('close', () => this.sockets.delete(s)); });
  }

  async listen() {
    await new Promise(res => this.server.listen(0, '127.0.0.1', res));
    this.port = this.server.address().port;
    this.url = `http://127.0.0.1:${this.port}/health`;
    return this.url;
  }

  _handle(req, res) {
    this.requests++;
    if (req.url !== '/health') { res.writeHead(404); res.end(); return; }
    switch (this.mode) {
      case 'hang': return;                                           // never answer
      case 'close': req.socket.destroy(); return;                    // drop the connection
      case '500': res.writeHead(500); res.end('boom'); return;
      case 'garbage': res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>not json</html>'); return;
      default: {
        const body = typeof this.body === 'function' ? this.body(this.requests) : this.body;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      }
    }
  }

  setMode(mode) { this.mode = mode; }
  set(body) { this.body = body; }

  async close() {
    for (const s of this.sockets) s.destroy();
    await new Promise(res => this.server.close(() => res()));
  }
}

module.exports = { FakeHealth, healthyBody };
