'use strict';

// The download module against a real local HTTP server: auth on the first request only, redirects
// (relative, chained, over the limit), actionable errors, truncated bodies, both timeouts, atomic
// writes, and cleanup on failure and on exit.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { downloadFile, fetchResponse, DownloadError, nrodUrl } = require('../lib/download');

const AUTH = { user: 'rich@example.com', pass: 'p$ss"w\\rd' };
const BASIC = 'Basic ' + Buffer.from(`${AUTH.user}:${AUTH.pass}`).toString('base64');
const BODY = Buffer.from('x'.repeat(5000) + 'END');

let seen = [];                         // every request the server received: { url, authorization }
const servers = [];
let releaseStall = null;               // lets a test finish the deliberately stalled response

function handler(req, res) {
  seen.push({ url: req.url, authorization: req.headers.authorization || null, host: req.headers.host });
  const u = new URL(req.url, 'http://x');
  const port = req.socket.localPort;
  const p = u.pathname;
  const redirect = (to, code = 302) => { res.writeHead(code, { Location: to }); res.end('moved'); };

  if (p === '/nrod') return redirect(`http://127.0.0.1:${port}/s3/smart.gz?X-Amz-Signature=SECRET-SIGNATURE`);
  if (p === '/relative') return redirect('/s3/smart.gz');
  if (p === '/s3/smart.gz') { res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': BODY.length }); return res.end(BODY); }
  if (p.startsWith('/chain/')) {
    const n = Number(p.slice(7));
    return n > 0 ? redirect(`/chain/${n - 1}`) : (res.writeHead(200, { 'Content-Length': 2 }), res.end('ok'));
  }
  if (p === '/denied') { res.writeHead(401, { 'Content-Type': 'text/html' }); return res.end('<h1>Unauthorized</h1><p>User rich@example.com is not authorized</p>'); }
  if (p === '/denied-hang') { res.writeHead(401, { 'Content-Type': 'text/html' }); res.write('<h1>Unauthorized</h1>'); return; }   // never ends
  if (p === '/forbidden') { res.writeHead(403); return res.end('no'); }
  if (p === '/missing') { res.writeHead(404); return res.end('gone'); }
  if (p === '/busy') { res.writeHead(429); return res.end(''); }
  if (p === '/boom') { res.writeHead(500, { 'Content-Type': 'text/html' }); return res.end('<html><body>' + 'Internal failure details. '.repeat(400) + '</body></html>'); }
  if (p === '/teapot') { res.writeHead(418); return res.end('short and stout'); }
  if (p === '/empty') { res.writeHead(200, { 'Content-Length': 0 }); return res.end(); }
  if (p === '/bare-redirect') { res.writeHead(302); return res.end(); }
  if (p === '/silent') return;                                            // never answers
  if (p === '/stall') {                                                   // first half, then waits to be told
    res.writeHead(200, { 'Content-Length': BODY.length });
    res.write(BODY.subarray(0, 2000));
    releaseStall = () => res.end(BODY.subarray(2000));
    return;
  }
  if (p === '/hang-mid-body') { res.writeHead(200, { 'Content-Length': 100000 }); res.write('abc'); return; }
  if (p === '/trickle') {
    res.writeHead(200);
    const t = setInterval(() => res.write('.'), 20);
    res.on('close', () => clearInterval(t));
    return;
  }
  if (p === '/cut') { res.writeHead(200, { 'Content-Length': 100000 }); res.write('partial'); setTimeout(() => req.socket.destroy(), 30); return; }
  res.writeHead(404); res.end('?');
}

function startServer() {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

after(() => { for (const s of servers) { s.closeAllConnections && s.closeAllConnections(); s.close(); } });

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'phase0-dl-')); }
const NROD = { serverName: 'NROD', what: 'SMART file', authHint: 'check NR_FEED_USER / NR_FEED_PASS in /x/.env' };
const FAST = { idleTimeoutMs: 400, totalTimeoutMs: 3000 };

test('the login goes on the FIRST request only; the redirected request carries no Authorization', async () => {
  const { base } = await startServer();
  seen = [];
  const dest = path.join(tmpdir(), 'data', 'smart.json.gz');
  const r = await downloadFile({ url: `${base}/nrod?type=SMART`, dest, auth: AUTH, ...NROD, ...FAST });

  assert.equal(seen.length, 2);
  assert.equal(seen[0].url, '/nrod?type=SMART');
  assert.equal(seen[0].authorization, BASIC, 'first hop is authenticated');
  assert.equal(seen[1].url.startsWith('/s3/smart.gz'), true);
  assert.equal(seen[1].authorization, null, 'second hop must NOT carry the login');
  assert.deepEqual(fs.readFileSync(dest), BODY);
  assert.equal(r.bytes, BODY.length);
  assert.equal(r.redirects, 1);
  assert.equal(r.hosts.length, 2);
  assert.equal(r.contentType, 'application/gzip');
  assert.deepEqual(fs.readdirSync(path.dirname(dest)), ['smart.json.gz'], 'no temp file left behind');
});

test('a relative redirect is followed, still without the login', async () => {
  const { base } = await startServer();
  seen = [];
  const dest = path.join(tmpdir(), 'rel.gz');
  await downloadFile({ url: `${base}/relative`, dest, auth: AUTH, ...NROD, ...FAST });
  assert.equal(seen[1].authorization, null);
  assert.deepEqual(fs.readFileSync(dest), BODY);
});

test('three redirects are followed; a fourth is refused', async () => {
  const { base } = await startServer();
  const dir = tmpdir();
  const ok = await fetchResponse(`${base}/chain/3`, { ...NROD, ...FAST }, async (res, info) => { res.resume(); return info; });
  assert.equal(ok.redirects, 3);
  await assert.rejects(
    downloadFile({ url: `${base}/chain/4`, dest: path.join(dir, 'x'), ...NROD, ...FAST }),
    e => e instanceof DownloadError && e.code === 'REDIRECTS' && /more than 3 times/.test(e.message)
  );
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('HTTP 401 gives the actionable message and leaves no file at all', async () => {
  const { base } = await startServer();
  const dir = tmpdir();
  const dest = path.join(dir, 'data', 'smart.json.gz');
  await assert.rejects(
    downloadFile({ url: `${base}/denied`, dest, auth: AUTH, ...NROD, ...FAST }),
    e => {
      assert.equal(e.code, 'AUTH');
      assert.equal(e.status, 401);
      assert.equal(e.message, 'NROD refused the login (HTTP 401): check NR_FEED_USER / NR_FEED_PASS in /x/.env');
      assert.ok(!e.message.includes('rich@example.com'), 'the body the server echoed must not be quoted');
      return true;
    }
  );
  assert.equal(fs.existsSync(dest), false);
  assert.equal(fs.existsSync(dest + '.tmp'), false);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'data')), []);
});

test('a 401 is reported at once even if the server never finishes sending its body', async () => {
  const { base } = await startServer();
  const t0 = Date.now();
  await assert.rejects(
    downloadFile({ url: `${base}/denied-hang`, dest: path.join(tmpdir(), 'f.gz'), auth: AUTH, ...NROD, idleTimeoutMs: 5000, totalTimeoutMs: 10000 }),
    e => e.code === 'AUTH' && /NROD refused the login \(HTTP 401\)/.test(e.message)
  );
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms: the error waited for the body`);
});

test('other failures each say what to do, and none leave a file', async () => {
  const { base } = await startServer();
  const dir = tmpdir();
  const cases = [
    ['/forbidden', 'HTTP', /refused access to the SMART file \(HTTP 403\).*account may not be allowed/],
    ['/missing', 'HTTP', /has no SMART file at that address \(HTTP 404\).*gone/],
    ['/busy', 'HTTP', /too many requests \(HTTP 429\): wait a few minutes/],
    ['/boom', 'HTTP', /server error \(HTTP 500\): try again in a few minutes/],
    ['/teapot', 'HTTP', /answered HTTP 418 instead of the SMART file.*short and stout/],
    ['/bare-redirect', 'HTTP', /redirect \(HTTP 302\) with no destination/],
    ['/empty', 'EMPTY', /sent an empty SMART file/]
  ];
  for (const [route, code, re] of cases) {
    await assert.rejects(
      downloadFile({ url: base + route, dest: path.join(dir, 'f.gz'), ...NROD, ...FAST }),
      e => { assert.equal(e.code, code, route); assert.match(e.message, re, route); return true; },
      route
    );
  }
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a long error body is truncated in the message and HTML tags are stripped', async () => {
  const { base } = await startServer();
  await assert.rejects(
    downloadFile({ url: `${base}/boom`, dest: path.join(tmpdir(), 'f.gz'), ...NROD, ...FAST }),
    e => {
      assert.ok(e.message.length < 400, `message is ${e.message.length} characters`);
      assert.ok(e.message.includes('…'));
      assert.ok(!/<html|<body/.test(e.message));
      assert.match(e.message, /Internal failure details\./);
      return true;
    }
  );
});

test('the presigned redirect URL (itself a credential) never appears in an error', async () => {
  const { base } = await startServer();
  await assert.rejects(
    downloadFile({ url: `${base}/nrod`, dest: path.join(tmpdir(), 'f.gz'), auth: AUTH, ...NROD, idleTimeoutMs: 10, totalTimeoutMs: 3000, maxRedirects: 0 }),
    e => { assert.equal(e.code, 'REDIRECTS'); assert.ok(!/SECRET-SIGNATURE|X-Amz/.test(e.message)); return true; }
  );
});

test('the login is never sent over plain http to a non-loopback host, and nothing is requested', async () => {
  seen = [];
  await assert.rejects(
    downloadFile({ url: 'http://example.invalid/file', dest: path.join(tmpdir(), 'f.gz'), auth: AUTH, ...NROD, ...FAST }),
    e => e.code === 'INSECURE' && /Refusing to send the NROD login over plain http/.test(e.message)
  );
  assert.equal(seen.length, 0);
});

test('a server that never answers is abandoned after the idle timeout', async () => {
  const { base } = await startServer();
  const dir = tmpdir();
  const t0 = Date.now();
  await assert.rejects(
    downloadFile({ url: `${base}/silent`, dest: path.join(dir, 'f.gz'), ...NROD, idleTimeoutMs: 200, totalTimeoutMs: 5000 }),
    e => e.code === 'TIMEOUT' && /stopped sending data for 0\.2 seconds/.test(e.message)
  );
  assert.ok(Date.now() - t0 < 2000);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a host that swallows the TCP connect is abandoned at the idle limit, not after the operating system gives up', async t => {
  // 10.255.255.1 is not routable, so on most networks the connection attempt is silently dropped (port 81
  // rather than 80, because some networks answer port 80 through a proxy). A machine that rejects it
  // immediately cannot show this behaviour, and the test says so rather than passing falsely.
  const t0 = Date.now();
  let error;
  try { await downloadFile({ url: 'http://10.255.255.1:81/x', dest: path.join(tmpdir(), 'f.gz'), ...NROD, idleTimeoutMs: 400, totalTimeoutMs: 20000 }); }
  catch (e) { error = e; }
  const took = Date.now() - t0;
  assert.ok(error, 'the download cannot have succeeded');
  if (error.code !== 'TIMEOUT' && took < 300) return t.skip(`this machine rejected the address at once (${error.message})`);
  assert.equal(error.code, 'TIMEOUT');
  assert.match(error.message, /stopped sending data for 0\.4 seconds/);
  assert.ok(took >= 350 && took < 3000, `took ${took} ms`);
});

test('a download that stalls mid-body is abandoned and its partial file is deleted', async () => {
  const { base } = await startServer();
  const dir = tmpdir();
  const dest = path.join(dir, 'f.gz');
  await assert.rejects(
    downloadFile({ url: `${base}/hang-mid-body`, dest, ...NROD, idleTimeoutMs: 200, totalTimeoutMs: 5000 }),
    e => e.code === 'TIMEOUT'
  );
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a connection that trickles forever hits the total ceiling even though it is never idle', async () => {
  const { base } = await startServer();
  const dir = tmpdir();
  await assert.rejects(
    downloadFile({ url: `${base}/trickle`, dest: path.join(dir, 'f.gz'), ...NROD, idleTimeoutMs: 1000, totalTimeoutMs: 300 }),
    e => e.code === 'TIMEOUT' && /did not finish within 0\.3 seconds/.test(e.message)
  );
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a connection cut mid-body is reported as interrupted and leaves no partial file', async () => {
  const { base } = await startServer();
  const dir = tmpdir();
  await assert.rejects(
    downloadFile({ url: `${base}/cut`, dest: path.join(dir, 'f.gz'), ...NROD, ...FAST }),
    e => e.code === 'INTERRUPTED' && /closed the connection before the SMART file download finished/.test(e.message)
  );
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('the destination only ever appears whole: a temp file while downloading, the real file after', async () => {
  const { base } = await startServer();
  const dir = tmpdir();
  const dest = path.join(dir, 'smart.gz');
  releaseStall = null;
  const done = downloadFile({ url: `${base}/stall`, dest, ...NROD, idleTimeoutMs: 5000, totalTimeoutMs: 10000 });

  const deadline = Date.now() + 3000;
  while (!(fs.existsSync(dest + '.tmp') && fs.statSync(dest + '.tmp').size > 0) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10));
  }
  assert.ok(fs.existsSync(dest + '.tmp'), 'the temp file exists while the download is in flight');
  assert.equal(fs.existsSync(dest), false, 'the destination does not exist until the download is complete');
  assert.ok(typeof releaseStall === 'function');
  releaseStall();

  const r = await done;
  assert.equal(r.bytes, BODY.length);
  assert.deepEqual(fs.readFileSync(dest), BODY);
  assert.equal(fs.existsSync(dest + '.tmp'), false);
});

test('a download replaces an earlier file only when it succeeds; a failed one leaves the old file intact', async () => {
  const { base } = await startServer();
  const dir = tmpdir();
  const dest = path.join(dir, 'smart.gz');
  fs.writeFileSync(dest, 'previous good copy');
  await assert.rejects(downloadFile({ url: `${base}/denied`, dest, auth: AUTH, ...NROD, ...FAST }), e => e.code === 'AUTH');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'previous good copy');
  await downloadFile({ url: `${base}/s3/smart.gz`, dest, ...NROD, ...FAST });
  assert.deepEqual(fs.readFileSync(dest), BODY);
});

test('an unreachable host says so in plain words', async () => {
  const { server, base } = await startServer();
  const port = server.address().port;
  server.close();
  server.closeAllConnections && server.closeAllConnections();
  await new Promise(r => setTimeout(r, 50));
  await assert.rejects(
    downloadFile({ url: `http://127.0.0.1:${port}/x`, dest: path.join(tmpdir(), 'f.gz'), ...NROD, ...FAST }),
    e => e.code === 'NETWORK' && /Cannot connect to 127\.0\.0\.1:\d+ \(ECONNREFUSED\)/.test(e.message)
  );
  void base;
});

test('an unwritable destination is reported as a disk problem, not a stack trace', async () => {
  const { base } = await startServer();
  const blocker = path.join(tmpdir(), 'a-file');
  fs.writeFileSync(blocker, 'x');
  await assert.rejects(
    downloadFile({ url: `${base}/s3/smart.gz`, dest: path.join(blocker, 'inside', 'f.gz'), ...NROD, ...FAST }),
    e => e.code === 'DISK' && /output folder is writable/.test(e.message)
  );
});

test('the NROD URL is the documented supporting-file endpoint', () => {
  assert.equal(nrodUrl('SMART'), 'https://publicdatafeeds.networkrail.co.uk/ntrod/SupportingFileAuthenticate?type=SMART');
  assert.equal(nrodUrl('CORPUS'), 'https://publicdatafeeds.networkrail.co.uk/ntrod/SupportingFileAuthenticate?type=CORPUS');
});

test('Ctrl-C / process exit mid-download removes the temp file (exit hook)', async () => {
  const { base } = await startServer();
  const dir = tmpdir();
  const dest = path.join(dir, 'smart.gz');
  const child = `
    const fs = require('fs');
    const { downloadFile } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'download.js'))});
    downloadFile({ url: ${JSON.stringify(base + '/stall')}, dest: ${JSON.stringify(dest)}, idleTimeoutMs: 30000, totalTimeoutMs: 60000 }).catch(() => {});
    const t = setInterval(() => {
      try { if (fs.statSync(${JSON.stringify(dest + '.tmp')}).size > 0) { clearInterval(t); process.exit(0); } } catch (_) {}
    }, 10);
  `;
  const code = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['-e', child], { stdio: 'ignore' });
    p.on('error', reject);
    p.on('exit', resolve);
  });
  assert.equal(code, 0);
  assert.deepEqual(fs.readdirSync(dir), [], 'the exit hook removed the partial file');
});
