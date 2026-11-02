'use strict';

// One GET of the crossing service's /health, as an observation.
//
// Never rejects: every way this can go wrong (refused, timed out, non-200, not JSON, too big) comes
// back as `{ok: false, error}` because the interlock counts them. It runs against the live service
// every 15 s, so it is bounded on both axes — a hard deadline for the whole exchange (an idle
// timeout alone would let a response that trickles in one byte at a time hold it open) and a cap
// on the body it will buffer.

const http = require('http');
const https = require('https');

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_BYTES = 64 * 1024;

function fetchHealth(url, { timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = MAX_BYTES, now = Date.now } = {}) {
  return new Promise(resolve => {
    const t0 = now();
    let settled = false;
    let req = null;
    const done = result => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      result.at = now();
      result.ms = result.at - t0;
      resolve(result);
    };
    const fail = (error) => { try { if (req) req.destroy(); } catch (_) { /* already gone */ } done({ ok: false, error }); };
    const deadline = setTimeout(() => fail(`no answer within ${Math.round(timeoutMs / 1000)}s`), timeoutMs);

    let u;
    try { u = new URL(url); } catch (_) { return fail('not a valid URL'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return fail('not an http(s) URL');

    try {
      const lib = u.protocol === 'https:' ? https : http;
      req = lib.request({
        protocol: u.protocol,
        hostname: u.hostname.replace(/^\[|\]$/g, ''),
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': 'rail-map-phase0' },
        // A fresh connection each time: nothing here should be able to hold a socket to the
        // service open between polls.
        agent: false
      }, res => {
        const chunks = [];
        let size = 0;
        res.on('data', c => {
          size += c.length;
          if (size > maxBytes) return fail(`response over ${maxBytes} bytes`);
          chunks.push(c);
        });
        res.on('error', e => fail(e.code || e.message));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return done({ ok: false, error: `HTTP ${res.statusCode}`, status: res.statusCode });
          let body;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch (_) { return done({ ok: false, error: 'answered, but not JSON', status: res.statusCode }); }
          if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            return done({ ok: false, error: 'answered, but not a JSON object', status: res.statusCode });
          }
          done({ ok: true, status: res.statusCode, body });
        });
      });
      req.on('error', e => fail(e.code || e.message));
      req.end();
    } catch (e) {
      fail(e.code || e.message);
    }
  });
}

module.exports = { fetchHealth, DEFAULT_TIMEOUT_MS };
