'use strict';

// Server-Sent Events: per-client bbox filtering, 1 s batching, ping, the client cap, coarse mode and
// the buffer cap.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startRig } = require('./rig');
const { sleep, until, getJson } = require('./helpers');
const { inBbox } = require('../src/geo');

function sse(port, query = '') {
  const events = [];
  let buf = '', raw = '', res = null, status = null, headers = null, onEnd = null, myReq = null;
  const ended = new Promise(r => { onEnd = r; });
  const ready = new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: `/map/v1/stream${query}`, headers: { Accept: 'text/event-stream' }, agent: false }, r => {
      res = r; status = r.statusCode; headers = r.headers;
      r.setEncoding('utf8');
      r.on('end', () => onEnd());
      r.on('data', d => {
        raw += d;
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = { at: Date.now() };
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) ev.event = line.slice(7);
            else if (line.startsWith('data: ')) { try { ev.data = JSON.parse(line.slice(6)); } catch (_) { ev.data = line.slice(6); } }
            else if (line.startsWith('retry: ')) ev.retry = line.slice(7);
          }
          events.push(ev);
        }
      });
      r.on('error', () => {});
      resolve();
    });
    req.on('error', reject);
    req.end();
    myReq = req;
  });
  return {
    events, ready, get status() { return status; }, get headers() { return headers; },
    ofType: t => events.filter(e => e.event === t),
    close: () => { try { if (myReq) myReq.destroy(); if (res) res.destroy(); } catch (_) { /* gone */ } },
    body: () => ended.then(() => raw)
  };
}

async function world(overrides) {
  const rig = await startRig({ overrides });
  rig.td([
    ['CC', 'LA', '1H15', null, '0002'],        // Portslade (Sussex)
    ['CC', 'LA', '2K22', null, '0001'],        // Aldrington (Sussex)
    ['CC', 'A2', '3M33', null, '0630']         // Pluckley (Kent)
  ]);
  await until(() => rig.app.model.byId.size === 3, 2000, 'three trains');
  await rig.settle();
  return rig;
}

const SUSSEX = '?bbox=50.7,-0.4,50.95,-0.1';
const KENT = '?bbox=51.0,0.5,51.3,0.9';
const byHc = (rig, hc) => [...rig.app.model.byId.values()].find(t => t.hc === hc);

test('on connect: an SSE snapshot of exactly the trains in the box, with the right headers', async () => {
  const rig = await world();
  try {
    const c = sse(rig.port, SUSSEX); await c.ready;
    await until(() => c.events.length >= 1);
    assert.equal(c.status, 200);
    assert.match(c.headers['content-type'], /^text\/event-stream/);
    assert.match(c.headers['cache-control'], /no-store|no-cache/);
    assert.equal(c.events[0].event, 'snapshot');
    assert.deepEqual(Object.keys(c.events[0].data).sort(), ['feedStale', 'serverTime', 'trains']);
    assert.deepEqual(c.events[0].data.trains.map(t => t.hc).sort(), ['1H15', '2K22']);
    const k = sse(rig.port, KENT); await k.ready; await until(() => k.events.length >= 1);
    assert.deepEqual(k.events[0].data.trains.map(t => t.hc), ['3M33']);
    c.close(); k.close();
    await until(() => rig.app.sse.size === 0, 2000, 'clients gone');
  } finally { await rig.stop(); }
});

test('FILTERING: a client hears only about trains entering, moving within or leaving ITS box', async () => {
  const rig = await world();
  try {
    const sx = sse(rig.port, SUSSEX), kt = sse(rig.port, KENT);
    await sx.ready; await kt.ready; await until(() => sx.events.length && kt.events.length);
    const kentId = byHc(rig, '3M33').id, pldId = byHc(rig, '1H15').id;

    // 1. A Kent train steps: Kent hears it (upsert), Sussex hears nothing.
    rig.td([['CA', 'A2', '3M33', '0630', '0633']]);
    await until(() => kt.ofType('update').length >= 1, 2000, 'Kent update');
    assert.deepEqual(kt.ofType('update')[0].data.upsert.map(t => t.id), [kentId]);
    assert.deepEqual(kt.ofType('update')[0].data.remove, []);
    await sleep(150);
    assert.equal(sx.ofType('update').length, 0, 'Sussex heard nothing about Kent');

    // 2. A Sussex train steps within the box: Sussex upserts, Kent hears nothing.
    rig.td([['CA', 'LA', '1H15', '0002', '0004']]);
    await until(() => sx.ofType('update').length >= 1, 2000, 'Sussex update');
    const u = sx.ofType('update')[0].data;
    assert.deepEqual(Object.keys(u).sort(), ['remove', 'serverTime', 'upsert']);
    assert.deepEqual(u.upsert.map(t => [t.id, t.berth]), [[pldId, '0004']]);
    assert.equal(kt.ofType('update').length, 1);

    // 3. A train LEAVES the Sussex box (stepping to a berth that is placed in Kent? use a far berth): remove.
    //    LA 0013 is Shoreham, west of the box edge at -0.4? Shoreham is -0.27: still inside. Use a tight box instead.
    sx.close(); kt.close();
    const tight = sse(rig.port, '?bbox=50.83,-0.215,50.84,-0.195');       // around Portslade only
    await tight.ready; await until(() => tight.events.length >= 1);
    assert.deepEqual(tight.events[0].data.trains.map(t => t.hc), [], 'the train is at Fishersgate now, outside the tight box');
    rig.td([['CA', 'LA', '1H15', '0004', '0002']]);                          // back into Portslade: ENTERS
    await until(() => tight.ofType('update').length >= 1, 2000, 'enter');
    assert.deepEqual(tight.ofType('update')[0].data.upsert.map(t => t.id), [pldId]);
    rig.td([['CA', 'LA', '1H15', '0002', '0004']]);                          // and out again: LEAVES
    await until(() => tight.ofType('update').length >= 2, 2000, 'leave');
    const leave = tight.ofType('update')[1].data;
    assert.deepEqual([leave.upsert, leave.remove], [[], [pldId]]);
    // 4. Cancelled (gone): removed from every box that had it.
    rig.td([['CA', 'LA', '1H15', '0004', '0002']]);
    await until(() => tight.ofType('update').length >= 3, 2000, 'enter again');
    rig.td([['CB', 'LA', '1H15', '0002']]);
    await until(() => tight.ofType('update').length >= 4, 2000, 'cancel');
    assert.deepEqual(tight.ofType('update')[3].data.remove, [pldId]);
    tight.close();
  } finally { await rig.stop(); }
});

test('BATCHING: many changes inside one batch become ONE update carrying the final state', async () => {
  const rig = await world({ http: { batchMs: 400 } });
  try {
    const c = sse(rig.port, SUSSEX); await c.ready; await until(() => c.events.length >= 1);
    await sleep(450);                                           // let the existing batch boundary pass
    const base = c.ofType('update').length;
    const id = byHc(rig, '1H15').id;
    const t0 = Date.now();
    for (const [from, to] of [['0002', '0004'], ['0004', '0006'], ['0006', '0004'], ['0004', '0002']]) rig.td([['CA', 'LA', '1H15', from, to]]);
    rig.td([['CA', 'LA', '2K22', '0001', '0003']]);
    await until(() => c.ofType('update').length > base, 3000, 'the batch');
    await sleep(250);
    const ups = c.ofType('update').slice(base);
    assert.ok(ups.length <= 2, `5 events in one tick became ${ups.length} update(s)`);
    const merged = ups.flatMap(u => u.data.upsert);
    const last1H15 = merged.filter(t => t.id === id).pop();
    assert.equal(last1H15.berth, '0002', 'the update carries the FINAL berth, not the intermediate ones');
    // Never more than one update per batch: over a second of continuous churn at 400 ms batches there are <= 3.
    const n0 = c.ofType('update').length;
    for (let i = 0; i < 10; i++) { rig.td([['CA', 'LA', '2K22', i % 2 ? '0003' : '0001', i % 2 ? '0001' : '0003']]); await sleep(40); }
    await sleep(500);
    assert.ok(c.ofType('update').length - n0 <= 3, `${c.ofType('update').length - n0} updates in ~1 s`);
    c.close();
  } finally { await rig.stop(); }
});

test('a train that moves and is cancelled within one batch is removed, not upserted', async () => {
  const rig = await world({ http: { batchMs: 300 } });
  try {
    const c = sse(rig.port, SUSSEX); await c.ready; await until(() => c.events.length >= 1);
    await sleep(350);
    const id = byHc(rig, '2K22').id;
    const base = c.ofType('update').length;                      // anything from the set-up is already in
    rig.td([['CA', 'LA', '2K22', '0001', '0003'], ['CB', 'LA', '2K22', '0003']]);        // one frame: one batch
    await until(() => c.ofType('update').slice(base).some(u => u.data.remove.includes(id)), 2000, 'removal');
    const all = c.ofType('update').slice(base).flatMap(u => u.data.upsert.map(t => t.id));
    assert.ok(!all.includes(id));
    c.close();
  } finally { await rig.stop(); }
});

test('a renumbered train keeps its id on the wire: an upsert with the new headcode, no remove', async () => {
  const rig = await world();
  try {
    const c = sse(rig.port, SUSSEX); await c.ready; await until(() => c.events.length >= 1);
    const id = byHc(rig, '1H15').id;
    rig.td([['CB', 'LA', '1H15', '0002']]); rig.td([['CC', 'LA', '2Z99', null, '0002']]);
    await until(() => c.ofType('update').length >= 1, 2000);
    const u = c.ofType('update')[0].data;
    assert.deepEqual(u.upsert.map(t => [t.id, t.hc]), [[id, '2Z99']]);
    assert.deepEqual(u.remove, []);
    c.close();
  } finally { await rig.stop(); }
});

test('PING every pingSecs on an otherwise silent stream', async () => {
  const rig = await world();
  try {
    const c = sse(rig.port, SUSSEX); await c.ready; await until(() => c.events.length >= 1);
    await until(() => c.ofType('ping').length >= 2, 4000, 'two pings');
    assert.equal(typeof c.ofType('ping')[0].data.serverTime, 'number');
    c.close();
  } finally { await rig.stop(); }
});

test('the client cap: past maxSseClients the answer is 503 with a plain sentence and Retry-After; a freed slot is reusable', async () => {
  const rig = await world();           // maxSseClients is 3 in the rig
  try {
    const cs = [sse(rig.port, SUSSEX), sse(rig.port, SUSSEX), sse(rig.port, KENT)];
    await Promise.all(cs.map(c => c.ready));
    await until(() => rig.app.sse.size === 3);
    const over = sse(rig.port, SUSSEX); await over.ready;
    assert.equal(over.status, 503);
    assert.match(over.headers['content-type'], /application\/json/);
    assert.equal(over.headers['retry-after'], '5');
    assert.match(JSON.parse(await over.body()).error, /poll/);
    assert.equal(rig.app.sse.stats.refused, 1);
    cs[0].close();
    await until(() => rig.app.sse.size === 2, 2000, 'slot freed');
    const again = sse(rig.port, SUSSEX); await again.ready;
    assert.equal(again.status, 200);
    again.close(); cs.forEach(c => c.close());
  } finally { await rig.stop(); }
});

test('COARSE: a box larger than coarseBboxDeg2 gets one update per coarseIntervalSecs, a small box one per batch', async () => {
  const rig = await world({ http: { batchMs: 50, coarseIntervalSecs: 1, coarseBboxDeg2: 25 } });
  try {
    const small = sse(rig.port, SUSSEX), big = sse(rig.port, '?bbox=49.8,-8,59,2');
    const none = sse(rig.port, '');                                              // no bbox = all of GB = coarse
    await Promise.all([small.ready, big.ready, none.ready]);
    await until(() => small.events.length && big.events.length && none.events.length);
    await sleep(1100);                                                           // align past a coarse boundary
    const s0 = small.ofType('update').length, b0 = big.ofType('update').length, n0 = none.ofType('update').length;
    const t0 = Date.now();
    for (let i = 0; i < 8; i++) { rig.td([['CA', 'LA', '2K22', i % 2 ? '0003' : '0001', i % 2 ? '0001' : '0003']]); await sleep(60); }
    await sleep(1300 - (Date.now() - t0));
    const smallN = small.ofType('update').length - s0, bigN = big.ofType('update').length - b0, noneN = none.ofType('update').length - n0;
    assert.ok(smallN >= 3, `small box: ${smallN} updates`);
    assert.ok(bigN >= 1 && bigN <= 2, `coarse box: ${bigN} updates in ~1.3 s`);
    assert.ok(noneN >= 1 && noneN <= 2, `whole-GB stream: ${noneN} updates`);
    // And the coarse update is complete: the train's FINAL berth (8 alternating steps end where they began).
    const lastBig = big.ofType('update').flatMap(u => u.data.upsert).filter(t => t.hc === '2K22').pop();
    assert.equal(lastBig.berth, '0001');
    [small, big, none].forEach(c => c.close());
  } finally { await rig.stop(); }
});

test('BUFFER CAP: a client whose write buffer passes the cap is dropped, not buffered without limit', async () => {
  // Unit level, with a stand-in response whose backlog the test controls: filling a real kernel socket
  // buffer would take megabytes and prove nothing more.
  const { EventEmitter } = require('events');
  const { SseHub } = require('../src/sse');
  const train = { id: 't1', placed: true, lat: 51, lon: -1 };
  const model = { byId: new Map([['t1', train]]), trainJson: () => '{"id":"t1"}', reachOf: () => [51, -1, 51, -1] };
  const hub = new SseHub({ model, snapshot: { body: () => '{"trains":[]}' }, config: { maxSseClients: 5, coarseBboxDeg2: 25, coarseIntervalSecs: 10, pingSecs: 20, sseMaxBufferBytes: 1000 }, now: () => 1, mono: () => 1 });
  const mkRes = () => Object.assign(new EventEmitter(), { writableLength: 0, written: [], destroyed: false, writeHead() {}, write(t) { this.written.push(t); return true; }, end() {}, destroy() { this.destroyed = true; } });
  const slow = mkRes(), fast = mkRes();
  assert.equal(hub.add(new EventEmitter(), slow, { s: 50, w: -2, n: 52, e: 0 }), true);
  assert.equal(hub.add(new EventEmitter(), fast, { s: 50, w: -2, n: 52, e: 0 }), true);
  const change = new Map([['t1', { obox: null }]]);
  hub.flush(change);
  assert.equal(slow.written.length, 2, 'snapshot and one update while its buffer was empty');
  slow.writableLength = 5000;                                   // the phone stopped reading
  hub.flush(change);
  assert.equal(slow.destroyed, true);
  assert.equal(hub.size, 1, 'only the dropped client was removed');
  assert.equal(hub.stats.dropped, 1);
  assert.equal(fast.written.length, 3, 'the healthy client kept receiving');
  const n = slow.written.length;
  hub.flush(change);
  assert.equal(slow.written.length, n, 'nothing more is written to a dropped client');
});

test('an aborted connection is cleaned up; closeAll on shutdown ends every stream', async () => {
  const rig = await world();
  const cs = [sse(rig.port, SUSSEX), sse(rig.port, KENT)];
  await Promise.all(cs.map(c => c.ready));
  await until(() => rig.app.sse.size === 2);
  cs[0].close();
  await until(() => rig.app.sse.size === 1, 2000, 'abort cleaned up');
  await rig.app.stop();
  assert.equal(rig.app.sse.size, 0);
  cs[1].close();
  await rig.stop();
});

// ---- contract 19.1: a train is in a box when the page could DRAW it there ----------------------------------------------------------

/** Plant a span provider (the way transit.test.js does): berth keyIds -> span id, and span id -> box. `state.sp` may be changed between touches. */
function plantSpans(rig, state) {
  rig.app.spans = {
    step() {},
    forBerth: id => (state.sp[id] ? { id: state.sp[id], length: 500, stop: null } : null),
    bboxOf: id => state.box[id] || null
  };
}

test('19.1 /trains?bbox and the SSE snapshot return a train whose span crosses the box although its signalled point is outside; the old rule does not', async () => {
  const rig = await world();
  try {
    const t = byHc(rig, '1H15'), g = rig.app.graph;
    const keyId = g.lookup('LA', '0002');
    const state = { sp: { [keyId]: 'sp_crossing' }, box: { sp_crossing: [t.lat, t.lon - 0.001, t.lat + 0.08, t.lon + 0.001] } };     // 9 km north of the point
    plantSpans(rig, state);
    for (let i = 0; i < 6; i++) rig.app.transit.add(keyId, 'stopping', 'passes', 60);
    rig.app.model._touch(t);
    await rig.settle(1200);
    const R = `${t.lat + 0.05},${t.lon - 0.01},${t.lat + 0.06},${t.lon + 0.01}`;                // 5 km+ north of the train, inside the span's reach
    assert.equal(inBbox(t.lat, t.lon, { s: t.lat + 0.05, w: t.lon - 0.01, n: t.lat + 0.06, e: t.lon + 0.01 }), false, 'the signalled point is outside the box (what the old rule tested)');
    const r = (await getJson(rig.port, `/map/v1/trains?bbox=${R}`)).json;
    assert.deepEqual(r.trains.map(x => x.hc), ['1H15'], '/trains?bbox');
    assert.equal(r.trains[0].mv.sp, 'sp_crossing', 'and it is the same Train on the wire, mv and all');
    assert.deepEqual(Object.keys(r.trains[0]).sort(), ['area', 'at', 'berth', 'hc', 'hdg', 'id', 'lat', 'lon', 'mv', 'pl', 'svc'].sort(), 'the Train shape is unchanged');
    const far = (await getJson(rig.port, `/map/v1/trains?bbox=${t.lat + 0.3},${t.lon - 0.01},${t.lat + 0.31},${t.lon + 0.01}`)).json;
    assert.deepEqual(far.trains, [], 'a box beyond the span and its pad');
    const c = sse(rig.port, `?bbox=${R}`); await c.ready; await until(() => c.events.length >= 1);
    assert.deepEqual(c.events[0].data.trains.map(x => x.hc), ['1H15'], 'the SSE snapshot');
    c.close();
  } finally { await rig.stop(); }
});

test('19.1 over a live stream: a train is upserted when its span starts to cross the box and removed when it stops, with its signalled point never in it', async () => {
  const rig = await world();
  try {
    const t = byHc(rig, '1H15'), g = rig.app.graph;
    const keyId = g.lookup('LA', '0002');
    const state = { sp: {}, box: { sp_crossing: [t.lat, t.lon - 0.001, t.lat + 0.08, t.lon + 0.001] } };
    plantSpans(rig, state);
    for (let i = 0; i < 6; i++) rig.app.transit.add(keyId, 'stopping', 'passes', 60);
    const R = `?bbox=${t.lat + 0.05},${t.lon - 0.01},${t.lat + 0.06},${t.lon + 0.01}`;
    const c = sse(rig.port, R); await c.ready; await until(() => c.events.length >= 1);
    assert.deepEqual(c.events[0].data.trains, [], 'no span yet: the train is drawn at its point, outside the box');

    state.sp[keyId] = 'sp_crossing'; rig.app.model._touch(t);                    // the span arrives
    await until(() => c.ofType('update').length >= 1, 2000, 'upsert');
    assert.deepEqual(c.ofType('update')[0].data.upsert.map(x => x.hc), ['1H15']);
    assert.deepEqual(c.ofType('update')[0].data.remove, []);

    delete state.sp[keyId]; rig.app.model._touch(t);                             // and goes again: the old reach box is what says "remove"
    await until(() => c.ofType('update').length >= 2, 2000, 'remove');
    assert.deepEqual([c.ofType('update')[1].data.upsert, c.ofType('update')[1].data.remove], [[], [t.id]]);
    c.close();
  } finally { await rig.stop(); }
});
