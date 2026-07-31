'use strict';
/*
 * Service worker for the Crossing Observer PWA.
 *
 * Split by whether staleness can change BEHAVIOUR:
 *
 *   code + config (.html/.js/.json/.css, and the bare / navigation)
 *     network-first with a timeout, cache as fallback.
 *   static assets (icons, manifest)
 *     cache-first — they carry no logic and are the least interesting bytes to re-fetch.
 *
 * The live B1 feed is cross-origin (api.railcrossing.uk) and is not intercepted at all: it
 * always hits the network and fails gracefully offline, because a capture never depends on it.
 *
 * WHY code is network-first (this used to be cache-first for everything). On 2026-07-31 a
 * capture recorded its train-class columns BLANK even though the deployed shared/predict.js was
 * correct: cache-first meant the page executed the PREVIOUS predict.js and only refreshed the
 * cache afterwards. Harmless for styling; not harmless here, because this app's output is a
 * calibration dataset. A stale launch records observations against superseded logic and the rows
 * look completely normal in the sheet — a silent data fault, in the field, where there is no way
 * to notice. Bumping CACHE does not fix it either: the new worker installs DURING the stale load
 * and only takes control from the next one.
 *
 * Three properties the code path has to keep, in priority order:
 *   1. Offline still launches instantly — fetch rejects, cache answers.
 *   2. A flaky link must not delay a capture. This is the case a bare catch does NOT cover: a
 *      connected-but-no-route link (captive portal, one bar at the crossing) leaves fetch
 *      HANGING rather than rejecting. Hence a race against a timer, not just a catch.
 *   3. A timeout still warms the cache — the request is not abandoned when the race is lost
 *      (see waitUntil below), so the next launch is fresh even if every launch times out.
 */

var CACHE = 'observer-v8';
var SHELL = [
  './', './index.html', './observe.css', './observe.js', './manifest.webmanifest',
  // The shared prediction core and its config. predict.js is a hard dependency — the app will
  // not start without it — so it belongs in the offline shell, not on the network.
  '../../shared/predict.js', '../../shared/crossings.json',
  '../../shared/icon-180.png', '../../shared/icon.svg'
];

// How long to wait for the network before falling back to cache. The shell is ~91 KB of
// code+config: well under a second on 4G, ~2 s on poor 3G. So 2 s serves fresh whenever the
// link is usable at all, and gives up before the delay is noticeable at a crossing.
var NET_TIMEOUT_MS = 2000;

// Does staleness in this file change what the app DOES? Extension-based rather than a list of
// paths, so a new module is covered by default — the safe direction to be wrong in.
function carriesLogic(pathname) {
  return /\.(?:html|js|json|css|webmanifest)$/i.test(pathname) || /\/$/.test(pathname);
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) { return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let the live API hit the network

  // Assets: cache-first, network only on a miss.
  if (!carriesLogic(url.pathname)) {
    e.respondWith(caches.match(req).then(function (cached) { return cached || fetch(req); }));
    return;
  }

  // Code + config: network-first, bounded.
  e.respondWith(
    caches.match(req).then(function (cached) {
      var net = fetch(req).then(function (resp) {
        if (resp && resp.status === 200) {
          var copy = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return resp;
      });
      // Keep the worker alive to finish the cache write even when we answer from cache, so a
      // permanently-slow link still converges instead of serving the same stale copy forever.
      e.waitUntil(net.catch(function () { }));

      // Nothing cached: the network is the only option, so wait for it (and let it reject
      // rather than resolving undefined, which respondWith would throw on).
      if (!cached) return net;

      return Promise.race([
        net.catch(function () { return cached; }),
        new Promise(function (resolve) { setTimeout(function () { resolve(cached); }, NET_TIMEOUT_MS); })
      ]);
    })
  );
});
