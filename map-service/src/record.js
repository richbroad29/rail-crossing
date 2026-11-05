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
// Line shapes (contract section 16): one JSON object per line, {t, event, data}, t = the server time in ms.
//   {"t":..,"event":"snapshot","data":{"serverTime":..,"feedStale":..,"trains":[Train...]}}
//   {"t":..,"event":"update","data":{"upsert":[Train...],"remove":[id...]}}
//   {"t":..,"event":"span","data":{"id":"sp_..","length":..,"path":[[lat,lon]...],"stop":..}}
//   {"t":..,"event":"end","data":null}                 (debug stream only)
// A `span` line is written BEFORE the first line that references its id (a train's mv.sp) in a segment, or in a debug stream,
// so any one segment replays with no network: nothing has to be fetched from /span/:id.

const fs = require('fs');
const path = require('path');
const log = require('./log');

// One recorder per named region (config.record.regions); each writes <name>-<start>.jsonl.
const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
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

const SP = /"sp":"(sp_[0-9a-f]+)"/g;

/**
 * Builds the {t, event, data} lines, adding a `span` line the first time each span id is referenced since the last reset().
 * `write(text)` returns true when the text was kept; ids are only remembered as written then (a dropped block never leaves a
 * later line pointing at a span the file does not contain).
 */
class LineMaker {
  constructor(spanFor) { this.spanFor = spanFor; this.seen = new Set(); }
  reset() { this.seen.clear(); }
  _emit(t, event, dataJson, idsFrom, write) {
    let text = '';
    const fresh = [];
    if (this.spanFor && idsFrom) {
      SP.lastIndex = 0;
      let m;
      while ((m = SP.exec(idsFrom)) !== null) {
        const id = m[1];
        if (this.seen.has(id) || fresh.includes(id)) continue;
        const sp = this.spanFor(id);
        if (sp) { text += `{"t":${t},"event":"span","data":${JSON.stringify(sp)}}\n`; fresh.push(id); }
      }
    }
    text += `{"t":${t},"event":"${event}","data":${dataJson}}\n`;
    if (write(text)) for (const id of fresh) this.seen.add(id);
  }
  snapshot(body, t, write) { this._emit(t, 'snapshot', body, body, write); }
  update(u, write) {
    const json = `{"upsert":[${u.upsert.join(',')}],"remove":${JSON.stringify(u.remove)}}`;
    this._emit(u.serverTime, 'update', json, u.upsert.length ? json : null, write);
  }
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
   * @param {function(string):object|null} [o.spanFor]  span id -> {id, length, path, stop} (for the `span` lines)
   */
  constructor({ config, dataDir, sse, snapshot, now = Date.now, spanFor = null, name = 'sussex', bbox = null }) {
    if (!NAME_RE.test(name)) throw new Error(`record: region name "${name}" must be lower-case letters, digits and hyphens`);
    this.cfg = config; this.dir = path.join(dataDir, 'record'); this.sse = sse; this.snapshot = snapshot; this.now = now;
    this.name = name; this.prefix = `${name}-`;
    const [s, w, n, e] = bbox || config.bbox;
    this.bbox = { s, w, n, e };
    this.fd = null; this.file = null; this.bytes = 0; this.segStart = 0;
    this.disabledUntil = 0;
    this.stats = { segments: 0, lines: 0, bytes: 0, droppedLines: 0, errors: 0, deleted: 0 };
    this.maker = new LineMaker(spanFor);
    this.tap = { bbox: this.bbox, onUpdate: u => this._onUpdate(u) };
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
    this.file = path.join(this.dir, `${this.prefix}${stamp(t)}.jsonl`);
    this.fd = fs.openSync(this.file, 'a');
    this.bytes = 0; this.segStart = t; this.stats.segments++;
    this._prune();
    this.maker.reset();                                     // each segment replays on its own: spans are written again
    this.maker.snapshot(this.snapshot.body(this.bbox), t, text => this._raw(text));
  }

  /** Write a block of whole lines, or none of it. Returns whether it was kept. */
  _raw(text) {
    const max = this.cfg.maxSegmentBytes || 12582912;
    if (this.bytes + text.length > max) { this.stats.droppedLines++; return false; }
    fs.writeSync(this.fd, text);
    this.bytes += text.length; this.stats.lines += text.split('\n').length - 1; this.stats.bytes += text.length;
    return true;
  }

  _onUpdate(u) {
    const t = this.now();
    if (t < this.disabledUntil) { this.stats.droppedLines++; return; }
    try {
      if (this.fd !== null && t - this.segStart >= (this.cfg.segmentSecs || 600) * 1000) this._close();
      if (this.fd === null) this._open(t);
      this.maker.update(u, text => this._raw(text));
    } catch (e) { this._fail(e); }
  }

  /** Delete all but the newest `keepSegments` files (the one just opened included). */
  _prune() {
    let names;
    try { names = fs.readdirSync(this.dir).filter(n => n.startsWith(this.prefix) && n.endsWith('.jsonl')).sort(); } catch (_) { return; }
    const keep = this.cfg.keepSegments || 7;
    for (const n of names.slice(0, Math.max(0, names.length - keep))) {
      try { fs.unlinkSync(path.join(this.dir, n)); this.stats.deleted++; } catch (_) { /* best effort */ }
    }
  }

  files() { try { return fs.readdirSync(this.dir).filter(n => n.startsWith(this.prefix)).sort(); } catch (_) { return []; } }

  status() { return { region: this.name, enabled: this.enabled, current: this.file ? path.basename(this.file) : null, ...this.stats, lastError: this.lastError }; }
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
  const maker = new LineMaker(app.spans ? id => app.spans.get(id) : null);
  const write = text => { if (done) return false; if (res.writableLength > 1048576) { finish(); return false; } res.write(text); return true; };
  const tap = { bbox, onUpdate: u => maker.update(u, write) };
  const finish = () => {
    if (done) return;
    done = true; clearTimeout(timer);
    app.sse.removeTap(tap); app.debugTaps--;
    try { res.end(`{"t":${app.now()},"event":"end","data":null}\n`); } catch (_) { /* gone */ }
  };
  const timer = setTimeout(finish, secs * 1000);
  res.on('close', () => { if (!done) { done = true; clearTimeout(timer); app.sse.removeTap(tap); app.debugTaps--; } });
  maker.snapshot(app.snapshot.body(bbox), app.now(), write);
  app.sse.addTap(tap);
}

module.exports = { Recorder, serveDebugRecord, isLocalRequest, LineMaker };
