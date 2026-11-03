'use strict';

// The HTTP API (contract section 5), served under /map/v1/ on 127.0.0.1. Caddy fronts it and adds
// CORS, so there are no Access-Control headers here. Every error is {error: "<plain sentence>"} with
// a 4xx/5xx; a stack trace never leaves the process.

const http = require('http');
const { parseBbox, inBbox } = require('./geo');
const { gzip } = require('./snapshot');
const log = require('./log');
const { serveDebugRecord } = require('./record');

const PREFIX = '/map/v1/';

function createServer(app) {
  const cfg = app.config.http;
  let lastErrLog = 0;

  const onFailure = (req, res, e) => {
    const t = Date.now();
    if (t - lastErrLog > 60000) { lastErrLog = t; log.error(`http: handler failed (${log.errText(e)})`); }
    try {
      if (!res.headersSent) sendJson(req, res, 500, { error: 'Something went wrong on the server.' }).catch(() => {});
      else res.destroy();
    } catch (_) { /* gone */ }
  };
  // route() may be sync or async; either way nothing escapes as an unhandled rejection.
  const server = http.createServer((req, res) => {
    Promise.resolve().then(() => route(req, res)).catch(e => onFailure(req, res, e));
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 50;
  server.on('clientError', (err, socket) => { try { socket.destroy(); } catch (_) { /* gone */ } });

  function wantsGzip(req) { return /\bgzip\b/i.test(req.headers['accept-encoding'] || ''); }

  function baseHeaders(extra) {
    return { 'Content-Type': 'application/json', Vary: 'Accept-Encoding', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra };
  }

  /** Send a JSON string (or object). `gzBuf` is an optional ready-made gzip of the same body. */
  async function sendText(req, res, status, text, { cache, gzBuf } = {}) {
    const headers = baseHeaders(cache ? { 'Cache-Control': cache } : {});
    const head = req.method === 'HEAD';
    if (wantsGzip(req) && (gzBuf || text.length > 1024)) {
      let buf = gzBuf;
      if (!buf) { try { buf = await gzip(text); } catch (_) { buf = null; } }
      if (buf) {
        headers['Content-Encoding'] = 'gzip'; headers['Content-Length'] = buf.length;
        res.writeHead(status, headers); res.end(head ? undefined : buf); return;
      }
    }
    headers['Content-Length'] = Buffer.byteLength(text);
    res.writeHead(status, headers); res.end(head ? undefined : text);
  }

  const sendJson = (req, res, status, obj, o) => sendText(req, res, status, JSON.stringify(obj), o);

  function route(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); sendJson(req, res, 405, { error: 'Only GET requests are supported.' }); return; }
    if (typeof req.url !== 'string' || req.url.length > cfg.maxUrlChars) { sendJson(req, res, 414, { error: 'That address is too long.' }); return; }
    let u;
    try { u = new URL(req.url, 'http://localhost'); } catch (_) { sendJson(req, res, 400, { error: 'That is not a valid address.' }); return; }
    if (!u.pathname.startsWith(PREFIX)) { sendJson(req, res, 404, { error: 'No such endpoint.' }); return; }
    const rest = u.pathname.slice(PREFIX.length).replace(/\/+$/, '');
    const q = u.searchParams;

    if (rest === 'health') { sendJson(req, res, 200, app.health()); return; }
    if (rest === 'trains') return trains(req, res, q);
    if (rest === 'stream') return stream(req, res, q);
    if (rest === 'stations') return stations(req, res, q);
    if (rest === 'search') return search(req, res, q);
    if (rest.startsWith('train/')) return train(req, res, rest.slice(6));
    if (rest.startsWith('station/')) return station(req, res, rest.slice(8));
    if (rest.startsWith('span/')) return span(req, res, rest.slice(5));
    if (rest === 'debug/record') return serveDebugRecord(app, req, res, q, sendJson);
    sendJson(req, res, 404, { error: 'No such endpoint.' });
  }

  // bbox: absent -> null (all GB); present but bad -> false (400)
  function readBbox(q) {
    if (!q.has('bbox')) return null;
    return parseBbox(q.get('bbox')) || false;
  }

  async function trains(req, res, q) {
    const bbox = readBbox(q);
    if (bbox === false) { sendJson(req, res, 400, { error: 'bbox must be four numbers: south,west,north,east.' }); return; }
    const snap = app.snapshot;
    const key = bbox ? `${bbox.s},${bbox.w},${bbox.n},${bbox.e}` : '';
    let gzBuf = null;
    if (wantsGzip(req) && req.method === 'GET') { try { gzBuf = await snap.gz(bbox, key); } catch (_) { gzBuf = null; } }
    await sendText(req, res, 200, snap.body(bbox), { gzBuf });
  }

  function stream(req, res, q) {
    const bbox = readBbox(q);
    if (bbox === false) { sendJson(req, res, 400, { error: 'bbox must be four numbers: south,west,north,east.' }); return; }
    if (req.method === 'HEAD') { sendJson(req, res, 405, { error: 'Only GET requests are supported.' }); return; }
    if (!app.sse.add(req, res, bbox)) {
      res.setHeader('Retry-After', '5');
      sendJson(req, res, 503, { error: 'Too many live connections right now; poll /trains every few seconds instead.' });
    }
  }

  async function stations(req, res, q) {
    const bbox = readBbox(q);
    if (bbox === false) { sendJson(req, res, 400, { error: 'bbox must be four numbers: south,west,north,east.' }); return; }
    const list = app.stationList || [];
    const out = bbox ? list.filter(s => inBbox(s.lat, s.lon, bbox)) : list;
    await sendJson(req, res, 200, { stations: out }, { cache: 'public, max-age=86400' });
  }

  async function search(req, res, q) {
    const text = (q.get('q') || '').trim();
    if (!text) { sendJson(req, res, 400, { error: 'Give a search term in q.' }); return; }
    if (text.length > 40) { sendJson(req, res, 400, { error: 'The search term is too long.' }); return; }
    await sendJson(req, res, 200, app.search(text));
  }

  async function train(req, res, rawId) {
    let id;
    try { id = decodeURIComponent(rawId); } catch (_) { sendJson(req, res, 400, { error: 'That train id is not valid.' }); return; }
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(id)) { sendJson(req, res, 404, { error: 'No train with that id.' }); return; }
    const d = app.trainDetail(id);
    if (!d) { sendJson(req, res, 404, { error: 'No train with that id.' }); return; }
    await sendJson(req, res, 200, d);
  }

  async function station(req, res, raw) {
    let crs;
    try { crs = decodeURIComponent(raw).toUpperCase(); } catch (_) { sendJson(req, res, 400, { error: 'That station code is not valid.' }); return; }
    if (!/^[A-Z]{3}$/.test(crs)) { sendJson(req, res, 404, { error: 'No station with that code.' }); return; }
    const b = app.stationBoard(crs);
    if (!b) { sendJson(req, res, 404, { error: 'No station with that code.' }); return; }
    await sendJson(req, res, 200, b);
  }

  async function span(req, res, raw) {
    let id;
    try { id = decodeURIComponent(raw); } catch (_) { sendJson(req, res, 400, { error: 'That span id is not valid.' }); return; }
    const sp = /^sp_[0-9a-f]{6,16}$/.test(id) && app.spans ? app.spans.get(id) : null;
    if (!sp) { sendJson(req, res, 404, { error: 'No span with that id.' }); return; }
    // Immutable per id: a span that changes is issued under a new id.
    await sendJson(req, res, 200, sp, { cache: 'public, max-age=604800, immutable' });
  }

  return server;
}

module.exports = { createServer, PREFIX };
