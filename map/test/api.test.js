'use strict';
// The transport state machine in api.js, driven by a fake EventSource, a fake fetch and a fake clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApi } = require('../api.js');

function fakeClock() {
  let t = 1000, id = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const i = ++id; timers.set(i, { at: t + ms, fn }); return i; },
    clearTimeout: (i) => { timers.delete(i); },
    // Run every timer due within `ms`, in order, letting each one schedule more.
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [i, x] of timers) if (x.at <= end && (!next || x.at < next.x.at)) next = { i, x };
        if (!next) break;
        timers.delete(next.i); t = next.x.at; next.x.fn();
        await flush();
      }
      t = end;
    },
    pending: () => timers.size
  };
}
const flush = () => new Promise((r) => setImmediate(r));

function makeEnv(opts = {}) {
  const clock = fakeClock();
  const instances = [];
  class FakeES {
    constructor(url) { this.url = url; this.closed = false; this.l = {}; instances.push(this); }
    addEventListener(type, fn) { (this.l[type] = this.l[type] || []).push(fn); }
    close() { this.closed = true; }
    emit(type, data) { (this.l[type] || []).forEach((fn) => fn({ data: typeof data === 'string' ? data : JSON.stringify(data) })); }
    fail() { this.emit('error', ''); }
  }
  const fetches = [];
  let respond = opts.respond || (() => ({ status: 200, body: { serverTime: clock.now(), feedStale: false, trains: [] } }));
  const fakeFetch = (url) => {
    fetches.push(url);
    return Promise.resolve().then(() => {
      const r = respond(url);
      if (r instanceof Error) throw r;
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: () => Promise.resolve(r.body) };
    });
  };
  const api = createApi({
    base: 'https://api.example.test/', EventSource: FakeES, fetch: fakeFetch,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now
  });
  const events = { snapshot: [], update: [], status: [] };
  Object.keys(events).forEach((k) => api.on(k, (p) => events[k].push(p)));
  return { api, clock, instances, fetches, events, setRespond: (f) => { respond = f; }, FakeES };
}
const snap = (n = 1) => ({ serverTime: 5000, feedStale: false, trains: Array.from({ length: n }, (_, i) => ({ id: 't' + i })) });
const VIEW = [50.7, -1.0, 51.2, 0.8];

test('start opens the stream for a padded box and a snapshot makes it live', async () => {
  const e = makeEnv();
  e.api.start(VIEW);
  assert.equal(e.instances.length, 1);
  const u = new URL(e.instances[0].url);
  assert.equal(u.origin + u.pathname, 'https://api.example.test/map/v1/stream');
  const bbox = u.searchParams.get('bbox').split(',').map(Number);
  assert.ok(bbox[0] < VIEW[0] && bbox[1] < VIEW[1] && bbox[2] > VIEW[2] && bbox[3] > VIEW[3], 'padded beyond the view');
  assert.equal(e.api.state.transport, 'connecting');
  e.instances[0].emit('snapshot', snap(3));
  assert.equal(e.api.state.transport, 'sse');
  assert.equal(e.events.snapshot.length, 1);
  assert.equal(e.events.snapshot[0].trains.length, 3);
  assert.equal(e.api.state.reachable, true);
});

test('update events are forwarded; pings only refresh liveness', async () => {
  const e = makeEnv();
  e.api.start(VIEW);
  const es = e.instances[0];
  es.emit('snapshot', snap());
  await e.clock.advance(5000);
  const before = e.api.state.lastMessageAt;
  es.emit('ping', {});
  assert.ok(e.api.state.lastMessageAt > before - 1);
  assert.equal(e.events.update.length, 0);
  es.emit('update', { serverTime: 6000, upsert: [{ id: 'a' }], remove: ['b'] });
  assert.equal(e.events.update.length, 1);
  assert.deepEqual(e.events.update[0].remove, ['b']);
  assert.equal(e.api.state.serverTime, 6000);
});

test('malformed event data is ignored, not fatal', () => {
  const e = makeEnv();
  e.api.start(VIEW);
  e.instances[0].emit('snapshot', '{not json');
  assert.equal(e.events.snapshot.length, 0);
  assert.equal(e.api.state.transport, 'connecting');
  e.instances[0].emit('snapshot', snap());
  assert.equal(e.api.state.transport, 'sse');
});

test('first failure to connect retries after 1 s; a second drops to polling at once', async () => {
  const e = makeEnv();
  e.api.start(VIEW);
  e.instances[0].fail();
  assert.equal(e.instances[0].closed, true);
  assert.equal(e.api.state.transport, 'connecting');
  assert.equal(e.instances.length, 1, 'not yet: waits for the backoff');
  await e.clock.advance(999);
  assert.equal(e.instances.length, 1);
  await e.clock.advance(1);
  assert.equal(e.instances.length, 2, 'reconnected after 1 s');
  e.instances[1].fail();                      // e.g. the server is full and answers 503
  await flush();
  assert.equal(e.api.state.transport, 'polling');
  assert.equal(e.fetches.length, 1);
  assert.match(e.fetches[0], /\/map\/v1\/trains\?bbox=/);
  assert.equal(e.events.snapshot.length, 1, 'polling delivers a snapshot');
});

test('a live stream that drops reconnects once, then falls back to polling', async () => {
  const e = makeEnv();
  e.api.start(VIEW);
  e.instances[0].emit('snapshot', snap());
  e.instances[0].fail();                      // failure 1 (after being live)
  await e.clock.advance(1000);
  assert.equal(e.instances.length, 2);
  e.instances[1].fail();                      // failure 2, never connected
  await flush();
  assert.equal(e.api.state.transport, 'polling');
});

test('a successful snapshot resets the failure count', async () => {
  const e = makeEnv();
  e.api.start(VIEW);
  e.instances[0].fail();
  await e.clock.advance(1000);
  e.instances[1].emit('snapshot', snap());    // connected on the retry
  e.instances[1].fail();                      // a later drop counts as failure 1 again
  await e.clock.advance(1000);
  assert.equal(e.instances.length, 3);
  assert.equal(e.api.state.transport, 'connecting');
});

test('polling repeats every 5 s', async () => {
  const e = makeEnv();
  e.api.start(VIEW);
  e.instances[0].fail(); await e.clock.advance(1000); e.instances[1].fail(); await flush();
  assert.equal(e.fetches.length, 1);
  await e.clock.advance(5000);
  assert.equal(e.fetches.length, 2);
  await e.clock.advance(5000);
  assert.equal(e.fetches.length, 3);
});

test('two failed polls mark the service unreachable; recovery clears it', async () => {
  const e = makeEnv();
  e.api.start(VIEW);
  e.instances[0].fail(); await e.clock.advance(1000);
  e.setRespond(() => ({ status: 503, body: { error: 'down' } }));
  e.instances[1].fail(); await flush();
  assert.equal(e.api.state.reachable, true, 'one failure is not yet "unreachable"');
  await e.clock.advance(5000);
  assert.equal(e.api.state.reachable, false);
  assert.ok(e.events.status.some((s) => s.reachable === false));
  e.setRespond(() => ({ status: 200, body: snap(2) }));
  await e.clock.advance(20000);
  assert.equal(e.api.state.reachable, true);
  assert.equal(e.events.snapshot.at(-1).trains.length, 2);
});

test('network errors during polling back off but keep trying', async () => {
  const e = makeEnv();
  e.api.start(VIEW);
  e.instances[0].fail(); await e.clock.advance(1000);
  e.setRespond(() => new Error('offline'));
  e.instances[1].fail(); await flush();
  const n0 = e.fetches.length;
  await e.clock.advance(5000 + 10000 + 20000);
  assert.ok(e.fetches.length > n0, 'still retrying');
  assert.equal(e.api.state.reachable, false);
});

test('while polling, a probe retries the stream and a snapshot switches back', async () => {
  const e = makeEnv();
  e.api.start(VIEW);
  e.instances[0].fail(); await e.clock.advance(1000); e.instances[1].fail(); await flush();
  assert.equal(e.api.state.transport, 'polling');
  await e.clock.advance(60000);
  const probe = e.instances.at(-1);
  assert.equal(e.instances.length, 3, 'probe opened a stream');
  assert.equal(e.api.state.transport, 'polling', 'still polling until the stream proves itself');
  probe.emit('snapshot', snap());
  assert.equal(e.api.state.transport, 'sse');
  const n = e.fetches.length;
  await e.clock.advance(30000);
  assert.equal(e.fetches.length, n, 'polling has stopped');
});

test('a failed probe leaves polling alone and tries again later', async () => {
  const e = makeEnv();
  e.api.start(VIEW);
  e.instances[0].fail(); await e.clock.advance(1000); e.instances[1].fail(); await flush();
  await e.clock.advance(60000);
  e.instances.at(-1).fail();
  await flush();
  assert.equal(e.api.state.transport, 'polling');
  assert.equal(e.api.state.sseFailures, 2, 'a probe failure is not counted');
  await e.clock.advance(60000);
  assert.equal(e.instances.length, 4, 'probed again');
});

test('a stream that goes silent for 45 s is treated as dead', async () => {
  const e = makeEnv();
  e.api.start(VIEW);
  e.instances[0].emit('snapshot', snap());
  await e.clock.advance(44000);
  assert.equal(e.instances[0].closed, false);
  e.instances[0].emit('ping', {});            // a ping resets the watchdog
  await e.clock.advance(44000);
  assert.equal(e.instances[0].closed, false);
  await e.clock.advance(1500);
  assert.equal(e.instances[0].closed, true);
  await e.clock.advance(1000);
  assert.equal(e.instances.length, 2, 'reconnected');
});

test('feedStale comes from the snapshot and status events fire only on change', () => {
  const e = makeEnv();
  e.api.start(VIEW);
  e.instances[0].emit('snapshot', { serverTime: 1, feedStale: true, trains: [] });
  assert.equal(e.api.state.feedStale, true);
  const n = e.events.status.length;
  e.instances[0].emit('update', { serverTime: 2, upsert: [], remove: [] });
  assert.equal(e.events.status.length, n, 'an update changes nothing worth announcing');
});

test('setBbox is debounced: a burst of moves resubscribes once, 400 ms after the last', async () => {
  const e = makeEnv();
  e.api.start(VIEW);
  e.instances[0].emit('snapshot', snap());
  const far = (d) => [VIEW[0] + d, VIEW[1] + d, VIEW[2] + d, VIEW[3] + d];
  e.api.setBbox(far(5)); await e.clock.advance(200);
  e.api.setBbox(far(5.1)); await e.clock.advance(200);
  e.api.setBbox(far(5.2)); await e.clock.advance(399);
  assert.equal(e.instances.length, 1, 'nothing yet');
  await e.clock.advance(1);
  assert.equal(e.instances.length, 2, 'exactly one resubscribe');
  assert.equal(e.api.state.resubscribes, 2);                     // the start, plus this one
  const bbox = new URL(e.instances[1].url).searchParams.get('bbox').split(',').map(Number);
  assert.ok(bbox[0] < VIEW[0] + 5.2, 'the NEW box is requested');
  assert.equal(e.instances[0].closed, true);
});

test('a move that stays inside the held box does not resubscribe', async () => {
  const e = makeEnv();
  e.api.start(VIEW);
  e.instances[0].emit('snapshot', snap());
  const dx = (VIEW[3] - VIEW[1]) * 0.1;                          // small pan, inside the 30% padding
  e.api.setBbox([VIEW[0], VIEW[1] + dx, VIEW[2], VIEW[3] + dx]);
  await e.clock.advance(500);
  assert.equal(e.instances.length, 1);
});

test('zooming far in resubscribes to a smaller box instead of holding a huge one', async () => {
  const e = makeEnv();
  e.api.start([49.5, -9, 61, 2.5]);
  e.instances[0].emit('snapshot', snap());
  e.api.setBbox([50.8, -0.3, 50.9, -0.1]);
  await e.clock.advance(500);
  assert.equal(e.instances.length, 2);
  const b = new URL(e.instances[1].url).searchParams.get('bbox').split(',').map(Number);
  assert.ok(b[2] - b[0] < 1, 'small box');
});

test('while polling a box change triggers an immediate poll with the new box', async () => {
  const e = makeEnv();
  e.api.start(VIEW);
  e.instances[0].fail(); await e.clock.advance(1000); e.instances[1].fail(); await flush();
  const n = e.fetches.length;
  e.api.setBbox([53, -3, 53.5, -2]);
  await e.clock.advance(400);
  assert.equal(e.fetches.length, n + 1);
  assert.match(e.fetches.at(-1), /bbox=/);
});

test('pause closes the stream and resume reopens it', async () => {
  const e = makeEnv();
  e.api.start(VIEW);
  e.instances[0].emit('snapshot', snap());
  e.api.pause();
  assert.equal(e.instances[0].closed, true);
  await e.clock.advance(120000);
  assert.equal(e.instances.length, 1, 'nothing runs while paused');
  e.api.resume();
  assert.equal(e.instances.length, 2);
});

test('stop closes everything and cancels timers', async () => {
  const e = makeEnv();
  e.api.start(VIEW);
  e.instances[0].fail();
  e.api.stop();
  await e.clock.advance(120000);
  assert.equal(e.instances.length, 1);
  assert.equal(e.api.state.transport, 'idle');
});

test('getTrain encodes the id, returns null on 404 and throws on other errors', async () => {
  const e = makeEnv();
  e.setRespond((url) => url.includes('missing') ? { status: 404, body: { error: 'no' } } : url.includes('broken') ? { status: 500, body: {} } : { status: 200, body: { train: { id: 'x' } } });
  assert.deepEqual(await e.api.getTrain('abc'), { train: { id: 'x' } });
  assert.equal(await e.api.getTrain('missing'), null);
  await assert.rejects(() => e.api.getTrain('broken'));
  await e.api.getTrain('a/b?c');
  assert.match(e.fetches.at(-1), /train\/a%2Fb%3Fc$/);
});

test('search and stations hit the documented paths', async () => {
  const e = makeEnv();
  await e.api.search('1H 5');
  assert.match(e.fetches.at(-1), /\/map\/v1\/search\?q=1H%205$/);
  await e.api.getStations();
  assert.match(e.fetches.at(-1), /\/map\/v1\/stations$/);
});

test('the same on() subscription can be removed', () => {
  const e = makeEnv();
  let n = 0;
  const off = e.api.on('snapshot', () => n++);
  e.api.start(VIEW);
  e.instances[0].emit('snapshot', snap());
  off();
  e.instances[0].emit('snapshot', snap());
  assert.equal(n, 1);
});
