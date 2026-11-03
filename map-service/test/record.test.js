'use strict';

// Recording (contract section 13): the loopback-only debug stream and the bounded, rotated rolling
// Sussex record.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { isLocalRequest } = require('../src/record');
const { startRig, NOW } = require('./rig');
const { getJson, get, sleep, until } = require('./helpers');

const req = (addr, headers) => ({ socket: { remoteAddress: addr }, headers });

test('isLocalRequest: loopback socket AND no proxy headers AND a loopback Host', () => {
  assert.equal(isLocalRequest(req('127.0.0.1', { host: '127.0.0.1:3100' })), true);
  assert.equal(isLocalRequest(req('::1', { host: 'localhost:3100' })), true);
  assert.equal(isLocalRequest(req('::ffff:127.0.0.1', { host: '[::1]:3100' })), true);
  assert.equal(isLocalRequest(req('203.0.113.9', { host: '127.0.0.1' })), false, 'a remote socket');
  // Caddy connects from 127.0.0.1 too: the socket alone proves nothing. Any proxy header, or the public Host, refuses.
  for (const h of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded', 'via', 'cf-connecting-ip']) {
    assert.equal(isLocalRequest(req('127.0.0.1', { host: '127.0.0.1:3100', [h]: '1.2.3.4' })), false, h);
  }
  assert.equal(isLocalRequest(req('127.0.0.1', { host: 'api.railcrossing.uk' })), false);
  assert.equal(isLocalRequest(req('127.0.0.1', { host: '127.0.0.1.evil.com' })), false);
  assert.equal(isLocalRequest(req('127.0.0.1', {})), false);
  assert.equal(isLocalRequest({ headers: { host: 'localhost' } }), false);
});

function stream(port, p, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, agent: false, headers }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, lines: body.split('\n').filter(Boolean).map(l => JSON.parse(l)), body }));
    });
    r.on('error', reject); r.end();
  });
}

test('GET /debug/record: refused (as an unknown path) through the proxy, from another Host, or with proxy headers', async () => {
  const rig = await startRig();
  try {
    for (const headers of [{ 'X-Forwarded-For': '8.8.8.8' }, { Host: 'api.railcrossing.uk' }, { 'X-Real-IP': '8.8.8.8' }, { Via: '1.1 caddy' }, { Forwarded: 'for=1.2.3.4' }]) {
      const r = await getJson(rig.port, '/map/v1/debug/record?secs=1', { headers });
      assert.equal(r.status, 404, JSON.stringify(headers));
      assert.deepEqual(r.json, { error: 'No such endpoint.' });
    }
  } finally { await rig.stop(); }
});

test('GET /debug/record: validates its arguments, then streams a snapshot, the updates, and an end line', async () => {
  const rig = await startRig();
  try {
    rig.td([['CC', 'LA', '1H15', null, '0002']]);
    await rig.settle();
    for (const q of ['secs=0', 'secs=abc', 'secs=-5', 'secs=1&bbox=nonsense']) assert.equal((await getJson(rig.port, `/map/v1/debug/record?${q}`)).status, 400, q);
    const pending = stream(rig.port, '/map/v1/debug/record?secs=1&bbox=50.7,-0.4,50.95,-0.1');
    await until(() => rig.app.debugTaps === 1, 2000, 'the tap');
    rig.clock.now += 5000;
    rig.td([['CA', 'LA', '1H15', '0002', '0004']]);                       // inside the box
    rig.td([['CC', 'A2', '3M33', null, '0630']]);                          // Kent: outside it
    const r = await pending;
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'application/x-ndjson');
    assert.equal(r.lines[0].event, 'snapshot');
    assert.deepEqual(Object.keys(r.lines[0]).sort(), ['event', 'feedStale', 'serverTime', 'trains']);
    assert.deepEqual(r.lines[0].trains.map(t => t.hc), ['1H15']);
    const updates = r.lines.filter(l => l.event === 'update');
    assert.ok(updates.length >= 1);
    assert.deepEqual(Object.keys(updates[0]).sort(), ['event', 'remove', 'serverTime', 'upsert']);
    assert.ok(updates.every(u => u.upsert.every(t => t.hc !== '3M33')), 'the Kent train is outside the box');
    assert.ok(updates.some(u => u.upsert.some(t => t.hc === '1H15' && t.berth === '0004')));
    assert.equal(r.lines.at(-1).event, 'end');
    assert.equal(rig.app.debugTaps, 0, 'the tap is released');
    assert.equal(rig.app.sse.taps.size, 1, 'only the rolling recorder remains');
  } finally { await rig.stop(); }
});

test('GET /debug/record: at most maxDebugClients at once (503), and a hang-up releases the slot', async () => {
  const rig = await startRig({ overrides: { record: { maxDebugClients: 1 } } });
  try {
    const first = http.request({ host: '127.0.0.1', port: rig.port, path: '/map/v1/debug/record?secs=30', agent: false }, res => { res.on('data', () => {}); });
    first.on('error', () => {}); first.end();
    await until(() => rig.app.debugTaps === 1, 2000, 'first tap');
    const r = await getJson(rig.port, '/map/v1/debug/record?secs=30');
    assert.equal(r.status, 503);
    first.destroy();
    await until(() => rig.app.debugTaps === 0, 2000, 'released');
    assert.equal((await stream(rig.port, '/map/v1/debug/record?secs=1')).status, 200);
  } finally { await rig.stop(); }
});

const segFiles = rig => fs.existsSync(path.join(rig.dataDir, 'record')) ? fs.readdirSync(path.join(rig.dataDir, 'record')).sort() : [];

test('ROLLING RECORD: Sussex updates only, a snapshot first in every segment, rotated at the segment length, oldest deleted', async () => {
  const rig = await startRig({ overrides: { record: { segmentSecs: 600, keepSegments: 2, bbox: [50.7, -0.4, 50.95, -0.1] } } });      // a narrow box: the fixture's Kent train is outside it
  try {
    rig.td([['CC', 'A2', '3M33', null, '0630']]);                                  // Kent: never recorded
    await rig.settle();
    assert.deepEqual(segFiles(rig), [], 'nothing in the box yet: no file');
    for (let seg = 0; seg < 4; seg++) {
      rig.clock.now = NOW + seg * 700_000;
      rig.td([[seg === 0 ? 'CC' : 'CA', 'LA', '1H15', seg === 0 ? null : (seg % 2 ? '0002' : '0004'), seg === 0 ? '0002' : (seg % 2 ? '0004' : '0002')]]);
      await rig.settle(120);
    }
    const files = segFiles(rig);
    assert.equal(files.length, 2, files.join());
    assert.ok(files.every(f => /^sussex-\d{8}T\d{6}\.jsonl$/.test(f)));
    for (const f of files) {
      const lines = fs.readFileSync(path.join(rig.dataDir, 'record', f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
      assert.equal(lines[0].event, 'snapshot', 'each segment replays on its own');
      assert.ok(lines.slice(1).every(l => l.event === 'update'));
      assert.ok(lines.length >= 2);
      assert.ok(!JSON.stringify(lines).includes('3M33'));
    }
    assert.equal(rig.app.recorder.stats.deleted, 2);
    assert.equal(rig.app.recorder.stats.segments, 4);
    assert.equal((await getJson(rig.port, '/map/v1/health')).json.diagnostics.record.segments, 4);
  } finally { await rig.stop(); }
});

test('ROLLING RECORD: a segment stops growing at maxSegmentBytes and says how much it dropped', async () => {
  const rig = await startRig({ overrides: { record: { maxSegmentBytes: 1500 } } });
  try {
    rig.td([['CC', 'LA', '1H15', null, '0002']]);
    await rig.settle(120);
    for (let i = 0; i < 12; i++) { rig.clock.now += 1000; rig.td([['CA', 'LA', '1H15', i % 2 ? '0004' : '0002', i % 2 ? '0002' : '0004']]); await rig.settle(80); }
    const [f] = segFiles(rig);
    assert.ok(fs.statSync(path.join(rig.dataDir, 'record', f)).size <= 1500);
    assert.ok(rig.app.recorder.stats.droppedLines > 0);
  } finally { await rig.stop(); }
});

test('ROLLING RECORD: a disk that cannot be written pauses the recorder, never the service', async () => {
  const rig = await startRig();
  try {
    fs.writeFileSync(path.join(rig.dataDir, 'record'), 'a file where the folder should be');
    rig.td([['CC', 'LA', '1H15', null, '0002']]);
    await rig.settle(200);
    assert.ok(rig.app.recorder.stats.errors >= 1);
    assert.ok(rig.cap.lines.some(l => /record: cannot write/.test(l)));
    rig.td([['CA', 'LA', '1H15', '0002', '0004']]);
    await rig.settle(200);
    const t = (await getJson(rig.port, '/map/v1/trains')).json.trains.find(x => x.hc === '1H15');
    assert.equal(t.berth, '0004', 'the map carries on');
    assert.equal(rig.app.recorder.stats.errors, 1, 'paused for a minute: not retried on every batch');
  } finally { await rig.stop(); }
});
