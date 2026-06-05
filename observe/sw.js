'use strict';
/*
 * Service worker for the Crossing Observer PWA — offline-first app shell.
 * Shell (same-origin) is cache-first with a background refresh, so the app
 * launches and captures with no network. The live B1 feed is cross-origin
 * (railcrossing.duckdns.org) and is NOT intercepted — it always hits the
 * network and simply fails gracefully when offline (capture never depends on it).
 */

var CACHE = 'observer-v3';
var SHELL = [
  './', './index.html', './observe.css', './observe.js', './manifest.webmanifest',
  '../shared/icon-180.png', '../shared/icon.svg'
];

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

  e.respondWith(
    caches.match(req).then(function (cached) {
      var net = fetch(req).then(function (resp) {
        if (resp && resp.status === 200) {
          var copy = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return resp;
      }).catch(function () { return cached; });
      return cached || net;
    })
  );
});
