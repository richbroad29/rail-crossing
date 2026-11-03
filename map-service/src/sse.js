'use strict';

// Server-Sent Events with per-client bbox filtering.
//
//   * On connect: `event: snapshot` with the same body as /trains for the box.
//   * Then at most once per `batchMs`: `event: update` {serverTime, upsert, remove}.
//   * `event: ping` every `pingSecs`.
//   * A client whose box is larger than `coarseBboxDeg2` gets one update per `coarseIntervalSecs`.
//   * The hub refuses past `maxSseClients` (the caller answers 503) and drops a client whose write
//     buffer grows past `sseMaxBufferBytes`: a stalled phone must not make the server hold megabytes.
//
// No per-client memory of "what this client knows": the model reports each changed train with its
// position BEFORE the change, so for any box: now inside -> upsert; was inside, now not -> remove.

const { performance } = require('perf_hooks');
const { inBbox, bboxDeg2 } = require('./geo');

class SseHub {
  // `now` stamps what is sent (serverTime); `mono` times the batches and pings, so a wall-clock step
  // (NTP) can neither stall the stream nor fire a burst of pings.
  constructor({ model, snapshot, config, now = Date.now, mono = () => performance.now() }) {
    this.model = model; this.snapshot = snapshot; this.cfg = config; this.now = now; this.mono = mono;
    this.clients = new Set();
    this.slow = new Map();                 // changes accumulated for coarse clients
    this.slowSince = mono();
    this.stats = { connected: 0, dropped: 0, refused: 0, updates: 0, bytes: 0 };
    this._lastPing = mono();
  }

  get size() { return this.clients.size; }
  get full() { return this.clients.size >= this.cfg.maxSseClients; }

  /** Open a stream. Returns false (nothing written) when full. */
  add(req, res, bbox) {
    if (this.full) { this.stats.refused++; return false; }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no'
    });
    const client = { res, bbox, coarse: !!bbox && bboxDeg2(bbox) > this.cfg.coarseBboxDeg2, closed: false };
    if (!bbox) client.coarse = true;
    const remove = () => { client.closed = true; this.clients.delete(client); };
    res.on('close', remove); res.on('error', remove); req.on('error', remove);
    this.clients.add(client);
    this.stats.connected++;
    this._send(client, `retry: 3000\nevent: snapshot\ndata: ${this.snapshot.body(bbox)}\n\n`);
    return true;
  }

  _send(client, text) {
    if (client.closed) return;
    const res = client.res;
    if (res.writableLength > this.cfg.sseMaxBufferBytes) {
      this.stats.dropped++;
      client.closed = true; this.clients.delete(client);
      try { res.destroy(); } catch (_) { /* gone */ }
      return;
    }
    try { res.write(text); this.stats.bytes += text.length; }
    catch (_) { client.closed = true; this.clients.delete(client); }
  }

  _update(map, bbox) {
    const upsert = [], remove = [];
    for (const [id, o] of map) {
      const t = this.model.byId.get(id);
      const cur = t && t.placed ? t : null;
      const isIn = cur && (!bbox || inBbox(cur.lat, cur.lon, bbox));
      const wasIn = !Number.isNaN(o.olat) && (!bbox || inBbox(o.olat, o.olon, bbox));
      if (isIn) upsert.push(this.model.trainJson(cur)); else if (wasIn) remove.push(id);
    }
    return { upsert, remove };
  }

  _emit(client, map, serverTime) {
    const { upsert, remove } = this._update(map, client.bbox);
    if (!upsert.length && !remove.length) return;
    this.stats.updates++;
    this._send(client, `event: update\ndata: {"serverTime":${serverTime},"upsert":[${upsert.join(',')}],"remove":${JSON.stringify(remove)}}\n\n`);
  }

  /** Called once per batch with the changes since the last call. */
  flush(changes) {
    const m = this.mono(), wall = this.now();
    for (const [id, o] of changes) if (!this.slow.has(id)) this.slow.set(id, o);
    if (!this.clients.size) { if (m - this.slowSince >= this.cfg.coarseIntervalSecs * 1000) { this.slow.clear(); this.slowSince = m; } return; }
    if (changes.size) for (const c of [...this.clients]) if (!c.coarse) this._emit(c, changes, wall);
    if (m - this.slowSince >= this.cfg.coarseIntervalSecs * 1000) {
      if (this.slow.size) for (const c of [...this.clients]) if (c.coarse) this._emit(c, this.slow, wall);
      this.slow = new Map(); this.slowSince = m;
    }
    if (m - this._lastPing >= this.cfg.pingSecs * 1000) {
      this._lastPing = m;
      const msg = `event: ping\ndata: {"serverTime":${wall}}\n\n`;
      for (const c of [...this.clients]) this._send(c, msg);
    }
  }

  closeAll() {
    for (const c of [...this.clients]) { try { c.res.end(); } catch (_) { /* gone */ } }
    this.clients.clear();
  }
}

module.exports = { SseHub };
