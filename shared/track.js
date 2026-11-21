// Usage counts: named events sent to GoatCounter (richbroad29.goatcounter.com), the same
// cookie-free counter that already counts page views. Events appear in its dashboard beside the
// pages, each name counted like a page. Every page names its events through this one file, so
// the names stay consistent and the dashboard can be filtered by their prefix ("map-tap:",
// "search:", "request:" …). The full list of names is in docs/analytics.md.
//
// Two ways in:
//   - markup: data-track="gofundme: homepage footer" on anything clickable; several events on
//     one click are separated by " | ". One delegated listener on the document, so it works for
//     rows drawn after load too (GoatCounter's own data-goatcounter-click binds once, at load).
//   - code:   TRACK('location-result: blocked'), and TRACK.search(term, hits[, kind]) for the
//     search boxes, which waits for the visitor to stop typing. `kind` names the search box
//     ("search" by default: the crossing searches; "train-map-search" on /map/).
//
// GoatCounter's count.js loads async after everything else, so an event raised before it arrives
// waits in a short queue. count.js itself refuses localhost, file:// and a browser that has opted
// out (railcrossing.uk/#toggle-goatcounter), so nothing here needs its own filter. It sends with
// sendBeacon, so a click that leaves the page is still counted.
(function (root) {
  'use strict';
  if (typeof document === 'undefined' || !document.addEventListener) return;

  var queue = [], timer = null, tries = 0;
  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 200); }
  function flush() {
    timer = null;
    var gc = root.goatcounter;
    if (gc && typeof gc.count === 'function') {
      while (queue.length) { try { gc.count(queue.shift()); } catch (e) { /* never break the page */ } }
      return;
    }
    if (++tries > 40) { queue = []; return; }   // ~20 s and still no count.js: blocked, give up
    timer = setTimeout(flush, 500);
  }
  function track(name) {
    name = clean(name);
    if (!name) return;
    queue.push({ path: name, title: name, event: true });
    if (queue.length > 50) queue.shift();
    if (!timer) flush();
  }

  // ---- search terms: one event per thing searched for, not per keystroke -------------------
  // Sent 2 s after the last keystroke, or at once when the visitor acts on it (Enter, a result,
  // leaving the page). Lower-cased so "Portslade" and "portslade" count together; the same term
  // twice in a row on one page counts once.
  var pending = null, pendTimer = null, lastSent = '';
  function sendSearch() {
    clearTimeout(pendTimer); pendTimer = null;
    var p = pending; pending = null;
    if (!p || p.kind + p.term === lastSent) return;
    lastSent = p.kind + p.term;
    track(p.kind + (p.hits ? ': ' : ' (no results): ') + p.term);
  }
  track.search = function (term, hits, kind) {
    term = clean(term).toLowerCase().slice(0, 60);
    if (term.replace(/\s/g, '').length < 2) { pending = null; clearTimeout(pendTimer); return; }
    pending = { term: term, hits: hits, kind: kind || 'search' };
    clearTimeout(pendTimer);
    pendTimer = setTimeout(sendSearch, 2000);
  };
  track.searchNow = sendSearch;

  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest && e.target.closest('[data-track]');
    if (!el) return;
    sendSearch();                                  // a result tapped: the search that found it first
    el.getAttribute('data-track').split('|').forEach(function (n) { track(n); });
  }, true);                                        // capture: runs even where a handler stops the click
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') sendSearch();
  });

  // An install that completed, however it was started (our button or the browser's own menu).
  // Only Chrome-family browsers report this — Android, and desktop Chrome/Edge. iPhone never does.
  if (root.addEventListener) {
    root.addEventListener('appinstalled', function () {
      track('app-installed: ' + (location.pathname === '/' ? 'homepage' : location.pathname.replace(/^\/|\/$/g, '') + ' page'));
    });
  }

  root.TRACK = track;
})(typeof window !== 'undefined' ? window : this);
