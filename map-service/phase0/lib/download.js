'use strict';

// HTTP fetching for the phase-0 scripts: NROD reference-data downloads (SMART, CORPUS) and the
// NaPTAN probe.
//
// Rules this module enforces, because getting any of them wrong is quiet:
//   * Basic auth is sent on the FIRST request only. NROD answers with a redirect to a presigned S3
//     URL, which carries its own authorisation; forwarding ours to another host would leak it.
//   * Credentials are never sent over plain http (loopback excepted, so tests can use a local server).
//   * At most `maxRedirects` redirects (3), and a redirect may not downgrade https to http.
//   * Two timeouts: `idleTimeoutMs` (default 120 s) with no data at all, which catches a stalled
//     connection at any stage, and `totalTimeoutMs` (default 15 min), which catches one that trickles
//     forever. Neither fires on a slow-but-moving download.
//   * A download is written to <dest>.tmp and renamed onto <dest> only when it is complete and the
//     right size, so <dest> is never half a file. On any failure, including Ctrl-C, the temp file is
//     removed.
//   * Error messages are sentences a non-developer can act on. They never contain the Authorization
//     header, and never the redirect URL (a presigned URL is itself a credential): only host names.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { pipeline } = require('stream/promises');
const { URL } = require('url');
const { fmtDuration } = require('./format');

const NROD_SUPPORTING_FILE = 'https://publicdatafeeds.networkrail.co.uk/ntrod/SupportingFileAuthenticate';
const USER_AGENT = 'rail-map-phase0/0.1 (read-only reference-data check)';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The NROD supporting-file URL for a file type: SMART, CORPUS. */
function nrodUrl(type) { return `${NROD_SUPPORTING_FILE}?type=${encodeURIComponent(type)}`; }

class DownloadError extends Error {
  /** @param {string} code AUTH | HTTP | TIMEOUT | REDIRECTS | NETWORK | INTERRUPTED | TRUNCATED | EMPTY | DISK | INSECURE */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'DownloadError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

// ---- temp-file bookkeeping ------------------------------------------------------------------------

// Temp files of downloads in flight. The process 'exit' hook removes whatever is left, which is what
// makes Ctrl-C clean (the CLI turns SIGINT into process.exit, and exit hooks run).
const liveTemps = new Set();
let exitHookInstalled = false;

function trackTemp(file) {
  liveTemps.add(file);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => { for (const f of liveTemps) removeQuietly(f); });
  }
}

function untrackTemp(file) { liveTemps.delete(file); }
function removeQuietly(file) { try { fs.unlinkSync(file); } catch (_) { /* already gone */ } }

// ---- one request ----------------------------------------------------------------------------------

function requestOnce(u, headers, idleTimeoutMs, state, onIdle) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    // agent:false => a fresh connection that closes afterwards; nothing lingers to hold the process open.
    const req = lib.request(u, { method: 'GET', headers, agent: false }, res => {
      res.on('error', () => {});          // an abort must never become an uncaught 'error' event
      state.res = res;
      resolve(res);
    });
    state.req = req;
    req.on('error', reject);              // after the response has started this is a harmless no-op
    req.setTimeout(idleTimeoutMs, onIdle);
    // req.setTimeout only starts counting once the connection exists, so a host that swallows the connect
    // would otherwise wait for the operating system (about two minutes) instead of the limit we state.
    req.on('socket', sock => {
      if (!sock.connecting) return;
      const t = setTimeout(onIdle, idleTimeoutMs);
      const cancel = () => clearTimeout(t);
      sock.once('connect', cancel);
      sock.once('close', cancel);
    });
    req.end();
  });
}

/** Read at most `maxChars` of a response body as text, then stop. Used only for error messages. */
function readExcerpt(res, maxChars = 2048) {
  return new Promise(resolve => {
    let text = '';
    res.setEncoding('utf8');
    const finish = () => resolve(text);
    res.on('data', d => {
      text += d;
      if (text.length >= maxChars) { text = text.slice(0, maxChars); res.destroy(); finish(); }
    });
    res.on('end', finish);
    res.on('close', finish);
    res.on('error', finish);
  });
}

function oneLineExcerpt(text, max = 200) {
  const t = String(text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** The sentence for a non-200 answer. */
async function httpStatusError(res, o) {
  const status = res.statusCode;
  const who = o.serverName;
  if (status === 401) {
    res.destroy();                        // the body is not quoted, so do not wait for it
    return new DownloadError('AUTH', `${who} refused the login (HTTP 401): ${o.authHint || 'check the username and password'}`, { status });
  }
  const said = oneLineExcerpt(await readExcerpt(res));
  const tail = said ? ` The server said: "${said}"` : '';
  if (status === 403) {
    return new DownloadError('HTTP', `${who} refused access to the ${o.what} (HTTP 403): the account may not be allowed this file, or the download link has expired.${tail}`, { status });
  }
  if (status === 404) {
    return new DownloadError('HTTP', `${who} has no ${o.what} at that address (HTTP 404): the URL may have changed.${tail}`, { status });
  }
  if (status === 429) {
    return new DownloadError('HTTP', `${who} says there have been too many requests (HTTP 429): wait a few minutes and run again.${tail}`, { status });
  }
  if (status >= 500) {
    return new DownloadError('HTTP', `${who} had a server error (HTTP ${status}): try again in a few minutes.${tail}`, { status });
  }
  if (REDIRECT_STATUSES.has(status)) {
    return new DownloadError('HTTP', `${who} sent a redirect (HTTP ${status}) with no destination.${tail}`, { status });
  }
  return new DownloadError('HTTP', `${who} answered HTTP ${status} instead of the ${o.what}.${tail}`, { status });
}

/** Turn whatever Node threw into a DownloadError with a sentence; DownloadErrors pass through. */
function explainError(e, o, host) {
  if (e instanceof DownloadError) return e;
  const code = e && e.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new DownloadError('NETWORK', `Cannot find ${host} on the network (DNS lookup failed): check this machine's internet connection.`);
  }
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ETIMEDOUT') {
    return new DownloadError('NETWORK', `Cannot connect to ${host} (${code}): the server may be down or blocked from this machine.`);
  }
  if (code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE' || (e && e.message === 'aborted')) {
    return new DownloadError('INTERRUPTED', `${o.serverName} closed the connection before the ${o.what} download finished: run it again.`);
  }
  if (/^(CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_TLS|ERR_SSL)/.test(code || '') || /certificate/i.test((e && e.message) || '')) {
    return new DownloadError('NETWORK', `The secure connection to ${host} failed (${code || e.message}): check this machine's clock and certificates.`);
  }
  if (['ENOSPC', 'EACCES', 'EROFS', 'EPERM', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EMFILE'].includes(code)) {
    return new DownloadError('DISK', `Cannot save the ${o.what} download (${code}${e.path ? ` on ${e.path}` : ''}): check the output folder is writable and the disk is not full.`);
  }
  return new DownloadError('NETWORK', `The ${o.what} download failed: ${(e && e.message) || e}`);
}

// ---- the redirect-following request ----------------------------------------------------------------

/**
 * GET `url`, following redirects, and hand the final response to `handler(res, info)`. The handler's
 * result is returned. The timeouts cover the whole exchange including the handler consuming the body.
 * The handler receives ANY non-redirect status; it decides what to do with it.
 *
 * @param {string} url
 * @param {object} [opts] auth {user,pass} (first request only), serverName, what, authHint,
 *   idleTimeoutMs, totalTimeoutMs, maxRedirects, headers
 * @param {function(import('http').IncomingMessage, object):Promise<any>} handler
 */
async function fetchResponse(url, opts, handler) {
  const o = {
    auth: null, serverName: 'The server', what: 'file', authHint: '',
    idleTimeoutMs: 120000, totalTimeoutMs: 900000, maxRedirects: 3, headers: {},
    ...opts
  };
  const state = { req: null, res: null, abortedWith: null };
  const abort = err => {
    if (state.abortedWith) return;
    state.abortedWith = err;
    if (state.res) state.res.destroy(err);
    if (state.req) state.req.destroy(err);
  };
  const onIdle = () => abort(new DownloadError('TIMEOUT', `${o.serverName} stopped sending data for ${fmtDuration(o.idleTimeoutMs)}, so the ${o.what} download was abandoned: run it again.`));
  const totalTimer = setTimeout(
    () => abort(new DownloadError('TIMEOUT', `The ${o.what} download did not finish within ${fmtDuration(o.totalTimeoutMs)} and was abandoned.`)),
    o.totalTimeoutMs
  );

  let current;
  try {
    try { current = new URL(url); }
    catch (_) { throw new DownloadError('NETWORK', `"${url}" is not a usable web address.`); }
    const hosts = [current.host];

    for (let hop = 0; ; hop++) {
      if (hop === 0 && o.auth && current.protocol !== 'https:' && !isLoopback(current.hostname)) {
        throw new DownloadError('INSECURE', `Refusing to send the ${o.serverName} login over plain http (${current.host}).`);
      }
      const headers = { 'User-Agent': USER_AGENT, Accept: '*/*', ...o.headers };
      if (hop === 0 && o.auth) {
        headers.Authorization = 'Basic ' + Buffer.from(`${o.auth.user}:${o.auth.pass}`).toString('base64');
      }
      state.res = null;
      const res = await requestOnce(current, headers, o.idleTimeoutMs, state, onIdle);

      if (REDIRECT_STATUSES.has(res.statusCode) && res.headers.location) {
        res.resume();                                       // discard the redirect's own body
        if (hop >= o.maxRedirects) {
          throw new DownloadError('REDIRECTS', `${o.serverName} redirected more than ${o.maxRedirects} times while fetching the ${o.what}: giving up.`);
        }
        let next;
        try { next = new URL(res.headers.location, current); }
        catch (_) { throw new DownloadError('NETWORK', `${o.serverName} sent a redirect that is not a usable address.`); }
        if (current.protocol === 'https:' && next.protocol !== 'https:' && !isLoopback(next.hostname)) {
          throw new DownloadError('INSECURE', `${o.serverName} redirected to a plain http address (${next.host}): refusing to follow it.`);
        }
        current = next;
        hosts.push(current.host);
        continue;
      }
      return await handler(res, { hosts, redirects: hop, finalHost: current.host });
    }
  } catch (e) {
    throw state.abortedWith || explainError(e, o, current ? current.host : url);
  } finally {
    clearTimeout(totalTimer);
  }
}

// ---- download to a file ----------------------------------------------------------------------------

/**
 * Download `url` to `dest` atomically. Resolves { path, bytes, redirects, hosts, contentType,
 * contentEncoding }; rejects with a DownloadError whose message is ready to show a person.
 *
 * @param {object} opts url, dest, plus everything fetchResponse takes
 */
async function downloadFile({ url, dest, ...opts }) {
  const o = { serverName: 'The server', what: 'file', ...opts };
  const tmp = dest + '.tmp';
  try { fs.mkdirSync(path.dirname(dest), { recursive: true }); }
  catch (e) { throw explainError(e, o, ''); }

  return fetchResponse(url, o, async (res, info) => {
    if (res.statusCode !== 200) throw await httpStatusError(res, o);

    let bytes = 0;
    const count = async function* (source) { for await (const chunk of source) { bytes += chunk.length; yield chunk; } };
    trackTemp(tmp);
    try {
      await pipeline(res, count, fs.createWriteStream(tmp));
      const expected = res.headers['content-length'] === undefined ? NaN : Number(res.headers['content-length']);
      if (Number.isFinite(expected) && expected !== bytes) {
        throw new DownloadError('TRUNCATED', `The ${o.what} download was cut short (${bytes} of ${expected} bytes): run it again.`);
      }
      if (bytes === 0) throw new DownloadError('EMPTY', `${o.serverName} sent an empty ${o.what}.`);
      fs.renameSync(tmp, dest);
      return {
        path: dest,
        bytes,
        redirects: info.redirects,
        hosts: info.hosts,
        contentType: res.headers['content-type'] || null,
        contentEncoding: res.headers['content-encoding'] || null
      };
    } catch (e) {
      removeQuietly(tmp);
      throw e;
    } finally {
      untrackTemp(tmp);
    }
  });
}

module.exports = {
  downloadFile, fetchResponse, nrodUrl, DownloadError, readExcerpt, oneLineExcerpt,
  NROD_SUPPORTING_FILE, REDIRECT_STATUSES
};
