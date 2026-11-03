'use strict';

// Recording for the motion-replay harness (contract section 13).
//
//   * The rolling Sussex record: the service's own `update` events for the Sussex box, as JSONL, in
//     MAP_DATA_DIR/record/sussex-<start>.jsonl, in segments of `segmentSecs`. Each segment starts with
//     a `snapshot` line, so any one segment replays on its own. BOUNDED three ways: a segment stops
//     growing at `maxSegmentBytes` (the rest of that segment is counted as dropped), only the newest
//     `keepSegments` files are kept (older ones are deleted at each roll), and a failing disk disables
//     the recorder for a minute rather than throwing into the tick.
//   * GET /map/v1/debug/record?secs=600&bbox=  streams the same lines live for `secs` seconds, then ends.
//     LOOPBACK ONLY: refused unless the socket is loopback AND the request carries no proxy headers
//     and a loopback Host, because Caddy reaches this service from 127.0.0.1 too: the socket alone
//     would let the whole internet in. Refusals look like any unknown path (404).
//
// Line shapes (the SSE shapes, plus an `event` key first):
//   {"event":"snapshot","serverTime":..,"feedStale":..,"trains":[Train...]}
//   {"event":"update","serverTime":..,"upsert":[Train...],"remove":[id...]}
//   {"event":"end","serverTime":..}              (debug stream only)

const fs = require('fs');
const path = require('path');
const log = require('./log');

const PREFIX = 'sussex-';
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip', 'forwarded', 'via', 'cf-connecting-ip', 'cf-ray'];
const LOOPBACK_ADDR = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/** Is this request a direct local one (not through Caddy, not from another machine)? */
function isLocalRequest(req) {
  const addr = req.socket && req.socket.remoteAddress;
  if (!LOOPBACK_ADDR.has(addr)) return false;
  for (const h of PROXY_HEADERS) if (req.headers[h] !== undefined) return false;
  return LOOPBACK_HOST.test(String(req.headers.host || ''));
}

const stamp = ms => new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 15);        // 20261102T094400

class Recorder {
  /**
   * @param {object} o
   * @param {object} o.config     config.record
   * @param {string} o.dataDir
   * @param {SseHub} o.sse
   * @param {Snapshot} o.snapshot
   * @param {function} [o.now]
   */
  constructor({ config, dataDir, sse, snapshot, now = Date.now }) {
    this.cfg = config; this.dir = path.join(dataDir, 'record'); this.sse = sse; this.snapshot = snapshot; this.now = now;
    const [s, w, n, e] = config.bbox;
    this.bbox = { s, w, n, e };
    this.fd = null; this.file = null; this.bytes = 0; this.segStart = 0;
    this.disabledUntil = 0;
    this.stats = { segments: 0, lines: 0, bytes: 0, droppedLines: 0, errors: 0, deleted: 0 };
    this.tap = { bbox: this.bbox, write: line => this._write(line) };
    this.enabled = config.enabled !== false;
    this.lastError = null;
  }

  start() { if (this.enabled) this.sse.addTap(this.tap); }
  stop() { this.sse.removeTap(this.tap); this._close(); }

  _close() { if (this.fd !== null) { try { fs.closeSync(this.fd); } catch (_) { /* gone */ } this.fd = null; } }

  _fail(e) {
    this.stats.errors++; this.lastError = log.errText(e);
    this._close();
    this.disabledUntil = this.now() + 60000;
    log.warn(`record: cannot write the rolling record (${this.lastError}); pausing it for a minute`);
  }

  _open(t) {
    fs.mkdirSync(this.dir, { recursive: true });
    this.file = path.join(this.dir, `${PREFIX}${stamp(t)}.jsonl`);
    this.fd = fs.openSync(this.file, 'a');
    this.bytes = 0; this.segStart = t; this.stats.segments++;
    this._prune();
    const body = this.snapshot.body(this.bbox);
    this._raw(`{"event":"snapshot",${body.slice(1)}\n`);
  }

  _raw(line) {
    const max = this.cfg.maxSegmentBytes || 12582912;
    if (this.bytes + line.length > max) { this.stats.droppedLines++; return; }
    fs.writeSync(this.fd, line);
    this.bytes += line.length; this.stats.lines++; this.stats.bytes += line.length;
  }

  _write(line) {
    const t = this.now();
    if (t < this.disabledUntil) { this.stats.droppedLines++; return; }
    try {
      if (this.fd !== null && t - this.segStart >= (this.cfg.segmentSecs || 600) * 1000) this._close();
      if (this.fd === null) this._open(t);
      this._raw(line);
    } catch (e) { this._fail(e); }
  }

  /** Delete all but the newest `keepSegments` files (the one just opened included). */
  _prune() {
    let names;
    try { names = fs.readdirSync(this.dir).filter(n => n.startsWith(PREFIX) && n.endsWith('.jsonl')).sort(); } catch (_) { return; }
    const keep = this.cfg.keepSegments || 7;
    for (const n of names.slice(0, Math.max(0, names.length - keep))) {
      try { fs.unlinkSync(path.join(this.dir, n)); this.stats.deleted++; } catch (_) { /* best effort */ }
    }
  }

  files() { try { return fs.readdirSync(this.dir).filter(n => n.startsWith(PREFIX)).sort(); } catch (_) { return []; } }

  status() { return { enabled: this.enabled, current: this.file ? path.basename(this.file) : null, ...this.stats, lastError: this.lastError }; }
}

/**
 * The debug stream. Returns true when it took the request (including a refusal), false when the
 * caller should treat the path as unknown.
 */
function serveDebugRecord(app, req, res, q, sendJson) {
  const cfg = app.config.record;
  if (!isLocalRequest(req)) { sendJson(req, res, 404, { error: 'No such endpoint.' }); return; }
  if (req.method !== 'GET') { sendJson(req, res, 405, { error: 'Only GET requests are supported.' }); return; }
  let secs = q.has('secs') ? Number(q.get('secs')) : 600;
  if (!Number.isFinite(secs) || secs <= 0) { sendJson(req, res, 400, { error: 'secs must be a positive number of seconds.' }); return; }
  secs = Math.min(secs, cfg.maxDebugSecs || 3600);
  let bbox = null;
  if (q.has('bbox')) {
    bbox = require('./geo').parseBbox(q.get('bbox'));
    if (!bbox) { sendJson(req, res, 400, { error: 'bbox must be four numbers: south,west,north,east.' }); return; }
  }
  if (app.debugTaps >= (cfg.maxDebugClients || 2)) { res.setHeader('Retry-After', '10'); sendJson(req, res, 503, { error: 'Too many recordings running; try again shortly.' }); return; }
  app.debugTaps++;
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  let done = false;
  const tap = { bbox, write: line => { if (!done) { if (res.writableLength > 1048576) finish(); else res.write(line); } } };
  const finish = () => {
    if (done) return;
    done = true; clearTimeout(timer);
    app.sse.removeTap(tap); app.debugTaps--;
    try { res.end(`{"event":"end","serverTime":${app.now()}}\n`); } catch (_) { /* gone */ }
  };
  const timer = setTimeout(finish, secs * 1000);
  res.on('close', () => { if (!done) { done = true; clearTimeout(timer); app.sse.removeTap(tap); app.debugTaps--; } });
  res.write(`{"event":"snapshot",${app.snapshot.body(bbox).slice(1)}\n`);
  app.sse.addTap(tap);
}

module.exports = { Recorder, serveDebugRecord, isLocalRequest };
