// Test the observer service worker's fetch handler by running the REAL sw.js against stubbed
// caches/fetch. Browser offline mode isn't reachable from the agent tooling, and the paths that
// matter most (offline, and a link that hangs rather than rejecting) are exactly the ones that
// can't be exercised by loading the page normally.
//
//   node .claude/skills/crossing-audit/scripts/sw-test.js
//
// Asserts, for a logic-carrying file (predict.js):
//   online       -> the NETWORK copy is served, and the cache is updated
//   offline      -> the CACHED copy is served, no throw
//   hanging link -> the CACHED copy is served within ~the timeout, and the cache still updates
//                   when the request eventually resolves
//   cold + offline -> rejects, rather than resolving undefined (respondWith would throw)
// and for an asset (icon) that cache-first is preserved.
const fs = require('fs'), path = require('path');

const SW = path.resolve(__dirname, '../../../../portslade/observe/sw.js');
let pass = 0, fail = 0;
function check(label, actual, expected) {
  if (actual === expected) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}\n          got:      ${actual}\n          expected: ${expected}`); fail++; }
}

// ---- minimal SW environment ------------------------------------------------------------
function makeEnv(opts) {
  const cacheStore = new Map(Object.entries(opts.cached || {}));
  const written = [];
  const waits = [];
  const listeners = {};
  const env = {
    written, waits, cacheStore, fetchCalls: [],
    self: {
      addEventListener: (t, fn) => { listeners[t] = fn; },
      location: { origin: 'https://railcrossing.uk' },
      skipWaiting: () => Promise.resolve(),
      clients: { claim: () => Promise.resolve() },
    },
    caches: {
      match: (req) => Promise.resolve(cacheStore.has(req.url) ? { body: cacheStore.get(req.url), from: 'cache' } : undefined),
      open: () => Promise.resolve({ put: (req, resp) => { written.push(req.url); cacheStore.set(req.url, resp.body); return Promise.resolve(); }, addAll: () => Promise.resolve() }),
      keys: () => Promise.resolve([]),
      delete: () => Promise.resolve(true),
    },
    fetch: function (input, init) { env.fetchCalls.push({ url: String(input && input.url || input), init: init || null }); return opts.fetch(input, init); },
    URL,
    setTimeout,
    listeners,
  };
  const src = fs.readFileSync(SW, 'utf8');
  new Function('self', 'caches', 'fetch', 'URL', 'setTimeout', src)(
    env.self, env.caches, env.fetch, env.URL, env.setTimeout
  );
  return env;
}

// Drive one request through the handler and return what respondWith was given.
function run(env, url) {
  let responded = null;
  const e = {
    request: { method: 'GET', url },
    respondWith: (p) => { responded = p; },
    waitUntil: (p) => { env.waits.push(p); },
  };
  env.listeners.fetch(e);
  return responded;
}

const PJS = 'https://railcrossing.uk/shared/predict.js';
const ICON = 'https://railcrossing.uk/shared/icon-180.png';
const API = 'https://api.railcrossing.uk/crossing/portslade/live';

(async () => {
  console.log('Observer service worker — fetch handler\n');

  console.log('  -- code/config: network-first --');
  {   // ONLINE: network wins, cache updated
    const env = makeEnv({
      cached: { [PJS]: 'OLD' },
      fetch: () => Promise.resolve({ status: 200, body: 'NEW', clone: () => ({ body: 'NEW' }) }),
    });
    const r = await run(env, PJS);
    check('online: serves the NETWORK copy (not the stale cache)', r.body, 'NEW');
    await Promise.all(env.waits);
    check('online: cache updated to the new copy', env.cacheStore.get(PJS), 'NEW');
  }
  {   // OFFLINE: cache answers, no throw
    const env = makeEnv({ cached: { [PJS]: 'OLD' }, fetch: () => Promise.reject(new Error('offline')) });
    let r, threw = false;
    try { r = await run(env, PJS); } catch { threw = true; }
    check('offline: no throw', threw, false);
    check('offline: serves the CACHED copy', r && r.body, 'OLD');
  }
  {   // HANGING link (connected, no route): must not wait forever
    const env = makeEnv({ cached: { [PJS]: 'OLD' }, fetch: () => new Promise(() => {}) });
    const t0 = Date.now();
    const r = await run(env, PJS);
    const ms = Date.now() - t0;
    check('hanging link: falls back to cache', r.body, 'OLD');
    check(`hanging link: within the timeout (took ${ms}ms)`, ms >= 1900 && ms < 3500, true);
  }
  {   // HANGING then resolving: the cache must still converge
    let settle;
    const env = makeEnv({
      cached: { [PJS]: 'OLD' },
      fetch: () => new Promise((res) => { settle = () => res({ status: 200, body: 'NEW', clone: () => ({ body: 'NEW' }) }); }),
    });
    const r = await run(env, PJS);
    check('slow link: answered from cache', r.body, 'OLD');
    settle();
    await Promise.all(env.waits);
    await new Promise((res) => setTimeout(res, 20));
    check('slow link: cache STILL converges for the next launch', env.cacheStore.get(PJS), 'NEW');
  }
  {   // COLD cache + offline: reject, never resolve undefined
    const env = makeEnv({ cached: {}, fetch: () => Promise.reject(new Error('offline')) });
    let rejected = false, val = 'unset';
    try { val = await run(env, PJS); } catch { rejected = true; }
    check('cold cache + offline: rejects rather than resolving undefined', rejected, true);
    check('cold cache + offline: did not resolve a value', val, 'unset');
  }

  console.log('\n  -- the HTTP cache underneath must be bypassed --');
  {   // The bug the 13 ordering tests missed: GitHub Pages serves the shell with
      // cache-control: max-age=600, so a plain fetch() inside the worker is answered by the
      // browser's HTTP cache without reaching the network. Network-first at the SW layer alone
      // changes nothing. Assert the cache mode explicitly.
    const env = makeEnv({
      cached: { [PJS]: 'OLD' },
      fetch: () => Promise.resolve({ status: 200, body: 'NEW', clone: () => ({ body: 'NEW' }) }),
    });
    await run(env, PJS);
    const call = env.fetchCalls.find(c => c.url === PJS);
    check('code fetch sets a cache mode at all', !!(call && call.init && call.init.cache), true);
    check("code fetch bypasses the HTTP cache (cache:'reload')", call && call.init && call.init.cache, 'reload');
  }

  console.log('\n  -- assets: cache-first preserved --');
  {
    let netCalls = 0;
    const env = makeEnv({
      cached: { [ICON]: 'CACHED_ICON' },
      fetch: () => { netCalls++; return Promise.resolve({ status: 200, body: 'NET_ICON', clone: () => ({ body: 'NET_ICON' }) }); },
    });
    const r = await run(env, ICON);
    check('asset: served from cache', r.body, 'CACHED_ICON');
    check('asset: no network request made', netCalls, 0);
  }

  console.log('\n  -- cross-origin API is never intercepted --');
  {
    const env = makeEnv({ cached: {}, fetch: () => Promise.resolve({ status: 200, body: 'x', clone: () => ({ body: 'x' }) }) });
    check('live API request is passed through untouched', run(env, API), null);
  }

  console.log();
  if (fail) { console.error(`${fail} FAILED, ${pass} passed`); process.exit(1); }
  console.log(`All ${pass} service-worker tests passed.`);
})();
