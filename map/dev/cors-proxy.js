#!/usr/bin/env node
'use strict';
// Development only. The real map service sends no CORS headers (Caddy adds them in production), so a
// page served from another origin cannot read it from a browser. This is a tiny pass-through that
// adds Access-Control-Allow-Origin: * and nothing else, so the page can be tried against the REAL
// service on this machine. The service itself is not changed.
//
//   node map/dev/cors-proxy.js                          listen on 127.0.0.1:3101, forward to 127.0.0.1:3100
//   node map/dev/cors-proxy.js --listen 3101 --target 127.0.0.1:3100
//   then open  .../map/index.html?api=http://localhost:3101
//
// Loopback only: it binds to 127.0.0.1 and refuses a --target that is not a loopback address, so it
// cannot be turned into an open relay. Server-Sent Events pass straight through (no buffering).
const http = require('http');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i < 0 ? def : process.argv[i + 1];
}
const LISTEN = Number(arg('listen', 3101));
const [THOST, TPORT] = String(arg('target', '127.0.0.1:3100')).split(':');
if (!['127.0.0.1', 'localhost', '::1'].includes(THOST)) {
  console.error('cors-proxy: --target must be a loopback address (127.0.0.1, localhost or ::1), got ' + THOST);
  process.exit(2);
}

http.createServer((req, res) => {
  if (!req.url.startsWith('/map/v1/')) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); return res.end('{"error":"Not found."}'); }
  const up = http.request({ host: THOST, port: Number(TPORT), path: req.url, method: 'GET', headers: { accept: req.headers.accept || '*/*', 'accept-encoding': req.headers['accept-encoding'] || '' } }, (r) => {
    const h = Object.assign({}, r.headers, { 'access-control-allow-origin': '*' });
    res.writeHead(r.statusCode, h);
    r.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }); res.end('{"error":"The map service is not reachable."}'); });
  req.on('close', () => up.destroy());
  up.end();
}).listen(LISTEN, '127.0.0.1', () => console.error('cors-proxy on http://localhost:' + LISTEN + ' -> ' + THOST + ':' + TPORT));
