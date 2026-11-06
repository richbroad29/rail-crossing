// Spans (CONTRACT section 9): the track geometry of one berth, fetched lazily from /span/:id and
// cached by id. A span is immutable per id (the service says so with Cache-Control: immutable), so a
// cached copy is never stale; a changed berth gets a new id.
//
// CONTINUATIONS (CONTRACT 17.1). Where one span ends more than a couple of metres from where the next starts, the page
// asks for a span of the next berth that STARTS where the one it drew ends: GET span/<of>?after=<the id it drew>. In this
// cache that answer is held under the key `after>of` (contKey), in the same maps as the plain spans, so it is bounded by the
// same limit, queued, retried and failed exactly like them. `>` is not an id character, so a key is never an id. The
// prepared span's own id is the CONTINUATION's id (what the next request's `after` must name); when the service answers
// "this span itself" that id is `of`.
//
// Requests are bounded (a busy view asks for a hundred at once) and ordered: the train being
// inspected first, then the rest in the order they were asked for. A failure is remembered for a
// while so a missing span is not asked for every frame.
(function (root) {
  'use strict';

  var engine = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('./engine.js') : root.RM.engine;

  var ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  var KEY_RE = /^[A-Za-z0-9_-]{1,64}(>[A-Za-z0-9_-]{1,64})?$/;
  function contKey(after, of) {
    return typeof after === 'string' && typeof of === 'string' && ID_RE.test(after) && ID_RE.test(of) ? after + '>' + of : null;
  }

  // o.fetchSpan(id) -> Promise of the raw span ({id, length, path, stop}) or null when unknown (404).
  // o.fetchSpanAfter(after, of) -> the same, for a continuation (optional: without it a continuation just fails).
  function createSpanCache(o) {
    var maxInflight = o.maxInflight || 10, retryMs = o.retryMs == null ? 30000 : o.retryMs, maxCached = o.maxCached || 6000;
    var now = o.now || Date.now;
    var ready = new Map(), failed = new Map(), queue = [], queued = new Set(), flying = new Set(), inflight = 0;
    var listeners = [];

    function pump() {
      while (inflight < maxInflight && queue.length) {
        var id = queue.shift(); queued.delete(id);
        if (ready.has(id)) continue;
        inflight++; flying.add(id);
        run(id);
      }
    }
    function run(id) {
      var p, cut = id.indexOf('>');
      try { p = cut < 0 ? o.fetchSpan(id) : o.fetchSpanAfter(id.slice(0, cut), id.slice(cut + 1)); } catch (e) { p = Promise.reject(e); }
      Promise.resolve(p).then(function (raw) {
        var sp = raw ? engine.prepareSpan(raw) : null;
        if (sp) {
          sp.id = cut < 0 ? id : (typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : id.slice(cut + 1));   // our key for a plain span, whatever the body says; a continuation carries its own id
          ready.set(id, sp); failed.delete(id);
          if (ready.size > maxCached) ready.delete(ready.keys().next().value);
        } else failed.set(id, now());
      }, function () { failed.set(id, now()); }).then(function () {
        inflight--; flying.delete(id);
        listeners.forEach(function (fn) { try { fn(id); } catch (e) { /* a listener must not stop the queue */ } });
        pump();
      });
    }
    return {
      // The prepared span, or null if it has not arrived (or failed).
      peek: function (id) { return ready.get(id) || null; },
      contKey: contKey,
      // Ask for a span; urgent ones go to the front. No-op if held, queued or recently failed.
      need: function (id, urgent) {
        if (typeof id !== 'string' || !KEY_RE.test(id) || ready.has(id) || flying.has(id)) return;   // held, or on its way: the page asks again every frame while it waits
        var f = failed.get(id);
        if (f != null && now() - f < retryMs) return;
        if (queued.has(id)) { if (urgent) { queue.splice(queue.indexOf(id), 1); queue.unshift(id); } return; }
        queued.add(id);
        if (urgent) queue.unshift(id); else queue.push(id);
        pump();
      },
      hasFailed: function (id) { var f = failed.get(id); return f != null && now() - f < retryMs; },
      onLoad: function (fn) { listeners.push(fn); },
      put: function (raw) { var sp = engine.prepareSpan(raw); if (sp) ready.set(raw.id, sp); return sp; },
      // Forget what is queued (the view moved on); in-flight requests finish and are kept.
      dropQueued: function () { queue.length = 0; queued.clear(); },
      get size() { return ready.size; },
      get pending() { return queue.length + inflight; }
    };
  }

  var api = { createSpanCache: createSpanCache, contKey: contKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.RM = root.RM || {}).spans = api;
})(typeof self !== 'undefined' ? self : this);
