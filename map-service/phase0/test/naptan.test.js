'use strict';

// The CSV parser and the NaPTAN probe: quoting rules, a local server in each of the ways the real
// one might answer, and the promise that a failure is a WARN and never an exception.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const zlib = require('zlib');
const { CsvParser } = require('../lib/csv');
const { probeNaptan, judgeNaptan } = require('../lib/naptan');

const BOM = String.fromCharCode(0xfeff);

function parse(pieces, opts) {
  const records = [];
  const p = new CsvParser(r => records.push(r), opts);
  for (const piece of pieces) p.write(piece);
  const tail = p.end();
  return { records, tail, parser: p };
}

const TRICKY = 'a,b,c\r\n1,"two, with comma","three ""quoted"""\r\n4,"five\nover two lines",\r\n\r\n6,,"seven"';
const TRICKY_RECORDS = [['a', 'b', 'c'], ['1', 'two, with comma', 'three "quoted"'], ['4', 'five\nover two lines', ''], ['6', '', 'seven']];

test('CSV: commas, newlines and doubled quotes inside quotes; CRLF; blank lines; no trailing newline', () => {
  assert.deepEqual(parse([TRICKY]).records, TRICKY_RECORDS);
});

test('CSV: the same records however the text is cut, including inside a quote pair and a CRLF', () => {
  for (let k = 0; k <= TRICKY.length; k++) assert.deepEqual(parse([TRICKY.slice(0, k), TRICKY.slice(k)]).records, TRICKY_RECORDS, `split at ${k}`);
  const oneByOne = parse([...TRICKY]);
  assert.deepEqual(oneByOne.records, TRICKY_RECORDS);
});

test('CSV: a byte order mark is ignored, a quote in the middle of a plain field is literal, empty fields are kept', () => {
  assert.deepEqual(parse([BOM + 'id,name\n1,5" pipe\n,\n']).records, [['id', 'name'], ['1', '5" pipe'], ['', '']]);
});

test('CSV: an unterminated quote is reported, and a runaway field is capped instead of swallowing memory', () => {
  const t = parse(['a,b\n1,"never closed\nstill going']);
  assert.equal(t.tail.unterminatedQuote, true);
  const big = parse(['x\n"' + 'y'.repeat(5000) + '"\n'], { maxFieldChars: 100 });
  assert.equal(big.records[1][0].length, 100);
  assert.equal(big.parser.truncatedFields, 1);
});

// ---- the probe --------------------------------------------------------------------------------------

const HEADER = 'ATCOCode,NaptanCode,CommonName,Easting,Northing,Longitude,Latitude,StopType';
const ROWS = [
  '9100PSLDAWH,,"Portslade Rail Station",524600,106400,-0.204898,50.836044,RLY',
  '9100SWK,,"Southwick, Rail Station",523000,105000,-0.237,50.83,RLY',
  '9100NOTTIPLOC,,Nowhere,0,0,0,0,RLY',
  '9100PSLDAWH1,,"Portslade Platform 1",524600,106400,-0.2,50.83,RPL',
  '910GBRIGHTN,,Brighton Entrance,0,0,0,0,RSE',
  '490000123X,,A bus stop,0,0,0,0,BCT'
];
const CSV = [HEADER, ...ROWS].join('\r\n') + '\r\n';
const TIPLOCS = new Set(['PSLDAWH', 'SWK']);

let mode = 'csv';
const servers = [];
const seen = [];
function handler(req, res) {
  seen.push({ url: req.url, authorization: req.headers.authorization || null, accept: req.headers.accept, acceptEncoding: req.headers['accept-encoding'] });
  if (mode === 'csv') { res.writeHead(200, { 'Content-Type': 'text/csv' }); return res.end(CSV); }
  if (mode === 'gzip') { const z = zlib.gzipSync(CSV); res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Encoding': 'gzip', 'Content-Length': z.length }); return res.end(z); }
  if (mode === 'chunked') { res.writeHead(200); const b = Buffer.from(BOM + CSV, 'utf8'); let i = 0; const t = setInterval(() => { res.write(b.subarray(i, i + 3)); i += 3; if (i >= b.length) { clearInterval(t); res.end(); } }, 0); return; }
  if (mode === '404') { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<html><body><h1>Not Found</h1>No such route</body></html>'); }
  if (mode === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html><body>Maintenance</body></html>'); }
  if (mode === 'nocolumn') { res.writeHead(200); return res.end('Name,Lat\r\nPortslade,50.8\r\n'); }
  if (mode === 'norail') { res.writeHead(200); return res.end(`${HEADER}\r\n490000123X,,A bus stop,0,0,0,0,BCT\r\n`); }
  if (mode === 'stall') { res.writeHead(200); res.write(HEADER + '\n'); return; }
  res.writeHead(500); res.end('?');
}
function start() {
  return new Promise(resolve => {
    const s = http.createServer(handler);
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}/v1/access-nodes?dataFormat=csv&atcoAreaCodes=910`));
  });
}
after(() => { for (const s of servers) { s.closeAllConnections && s.closeAllConnections(); s.close(); } });

test('probe: header, row counts, 9100 rows, TIPLOC cross-check, sample, and no credentials sent', async () => {
  mode = 'csv'; seen.length = 0;
  const url = await start();
  const r = await probeNaptan({ url, tiplocs: TIPLOCS, idleTimeoutMs: 2000, totalTimeoutMs: 5000 });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.deepEqual(r.header, HEADER.split(','));
  assert.equal(r.rows, 6);
  assert.equal(r.rail, 4, 'four codes start 9100 (the 910G one and the bus stop do not)');
  assert.equal(r.railWithTiplocInCorpus, 2, 'PSLDAWH and SWK are TIPLOCs CORPUS knows; NOTTIPLOC and PSLDAWH1 are not');
  assert.equal(r.knownCodeFound, true);
  assert.deepEqual(r.stopTypes, { RLY: 3, RPL: 1 });
  assert.deepEqual(r.prefixes, { 9100: 4, '910G': 1, 4900: 1 });
  assert.equal(r.sample.length, 4);
  assert.deepEqual(r.sample[1], { ATCOCode: '9100SWK', CommonName: 'Southwick, Rail Station', StopType: 'RLY', Latitude: '50.83', Longitude: '-0.237' });
  assert.equal(r.ragged, 0);
  assert.equal(seen[0].authorization, null, 'the probe never sends a login');
  assert.match(seen[0].url, /dataFormat=csv&atcoAreaCodes=910/);

  const v = judgeNaptan(r);
  assert.equal(v.status, 'INFO');
  assert.match(v.message, /^NaPTAN answered HTTP 200 in [\d.]+ s from 127\.0\.0\.1:\d+: 8 columns \(ATCOCode, NaptanCode, CommonName, Easting, Northing, Longitude \+2 more\), 6 rows, 4 with ATCOCode 9100…; 2 of those \(50\.0%\) end in a TIPLOC CORPUS knows; Portslade 9100PSLDAWH is present\.$/);
  assert.ok(!/[\r\n]/.test(v.message));
});

test('probe: a gzip-encoded answer and a byte-by-byte one with a byte order mark read the same', async () => {
  for (const m of ['gzip', 'chunked']) {
    mode = m;
    const r = await probeNaptan({ url: await start(), tiplocs: TIPLOCS, idleTimeoutMs: 2000, totalTimeoutMs: 5000 });
    assert.equal(r.ok, true, m);
    assert.equal(r.rows, 6, m);
    assert.equal(r.rail, 4, m);
    assert.deepEqual(r.header, HEADER.split(','), m);
  }
});

test('probe: a redirect is followed, and the TIPLOC cross-check is skipped when no CORPUS TIPLOCs are given', async () => {
  const s = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/')) { res.writeHead(302, { Location: '/real' }); return res.end(); }
    res.writeHead(200); res.end(CSV);
  });
  servers.push(s);
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const r = await probeNaptan({ url: `http://127.0.0.1:${s.address().port}/v1/x`, idleTimeoutMs: 2000, totalTimeoutMs: 5000 });
  assert.equal(r.ok, true);
  assert.equal(r.redirects, 1);
  assert.equal(r.rows, 6);
  assert.equal(r.railWithTiplocInCorpus, null);
  assert.ok(!/end in a TIPLOC/.test(judgeNaptan(r).message));
});

test('probe failures are WARNs with the plain reason, and the probe itself never throws', async () => {
  mode = '404';
  const r404 = await probeNaptan({ url: await start(), idleTimeoutMs: 1000, totalTimeoutMs: 3000 });
  assert.equal(r404.ok, false);
  assert.equal(r404.status, 404);
  const v404 = judgeNaptan(r404);
  assert.equal(v404.status, 'WARN');
  assert.match(v404.message, /^NaPTAN probe failed: HTTP 404 from 127\.0\.0\.1:\d+: "Not Found No such route" \(the URL in this script is from memory and may be wrong; this does not affect the other checks\)\.$/);

  // connection refused
  const dead = http.createServer(); await new Promise(r => dead.listen(0, '127.0.0.1', r));
  const port = dead.address().port; dead.close();
  await new Promise(r => setTimeout(r, 30));
  const refused = await probeNaptan({ url: `http://127.0.0.1:${port}/x`, idleTimeoutMs: 1000, totalTimeoutMs: 3000 });
  assert.equal(refused.ok, false);
  assert.match(judgeNaptan(refused).message, /Cannot connect to 127\.0\.0\.1:\d+ \(ECONNREFUSED\)/);

  // an unusable address
  const bad = await probeNaptan({ url: 'not a url' });
  assert.equal(bad.ok, false);
  assert.equal(judgeNaptan(bad).status, 'WARN');
});

test('probe: a server that goes quiet mid-stream times out as a WARN, not a hang', async () => {
  mode = 'stall';
  const t0 = Date.now();
  const r = await probeNaptan({ url: await start(), idleTimeoutMs: 200, totalTimeoutMs: 5000 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /stopped sending data for 0\.2 seconds/);
  assert.ok(Date.now() - t0 < 3000);
});

test('probe: an answer that is not the expected CSV is a WARN naming what is missing', async () => {
  mode = 'html';
  const html = await probeNaptan({ url: await start(), idleTimeoutMs: 1000, totalTimeoutMs: 3000 });
  assert.equal(judgeNaptan(html).status, 'WARN');
  assert.match(judgeNaptan(html).message, /no ATCOCode column/);

  mode = 'nocolumn';
  assert.match(judgeNaptan(await probeNaptan({ url: await start(), idleTimeoutMs: 1000, totalTimeoutMs: 3000 })).message, /2 columns \(Name, Lat\), 1 rows, but there is no ATCOCode column/);

  mode = 'norail';
  const norail = judgeNaptan(await probeNaptan({ url: await start(), idleTimeoutMs: 1000, totalTimeoutMs: 3000 }));
  assert.equal(norail.status, 'WARN');
  assert.match(norail.message, /none has an ATCOCode starting 9100 \(prefixes seen: 4900\)/);
});
