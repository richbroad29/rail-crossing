// Where each train is drawn, as a function of time — and the store that holds them.
//
// PHASE 1 puts each train where the service says and glides it there over ~1.5 s.
// PHASE 2 will replace the glide with track-following motion plans. To make that a drop-in change,
// every train's drawn position comes from ONE function, model.sample(rec, now), which writes
// rec.cx / rec.cy / rec.ch (longitude, latitude, heading). Nothing else in the page reads where a
// train "is" except through those three fields. A phase-2 model only has to implement `sample`
// (and, if it needs to, `retarget` to take a fresh position from the feed) and be passed to
// createStore({ model }).
//
// The store keeps everything in plain records and fills preallocated typed arrays for the GPU, so
// a frame does no allocation proportional to the number of trains.
(function (root) {
  'use strict';

  var classes = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('./classes.js') : root.RM.classes;

  function lerpAngle(a, b, f) {
    var d = ((b - a + 540) % 360) - 180;
    return (a + d * f + 360) % 360;
  }
  function easeInOutSine(f) { return 0.5 - 0.5 * Math.cos(Math.PI * f); }

  // ---- the phase-1 model: a straight glide from where the train was drawn to where it now is ------
  var glideModel = {
    name: 'glide',
    // Called when the feed gives a train a new position. `from` is wherever it is drawn right now,
    // so a train that is retargeted mid-glide carries on from where it is, never jumping back.
    retarget: function (rec, lon, lat, hdg, now, durMs) {
      rec.fx = rec.cx; rec.fy = rec.cy; rec.fh = rec.ch;
      rec.tx = lon; rec.ty = lat; rec.th = hdg;
      rec.t0 = now; rec.dur = durMs;
    },
    sample: function (rec, now) {
      if (rec.dur <= 0 || now >= rec.t0 + rec.dur) {
        rec.cx = rec.tx; rec.cy = rec.ty; rec.ch = rec.th;
        return;
      }
      var f = easeInOutSine((now - rec.t0) / rec.dur);
      rec.cx = rec.fx + (rec.tx - rec.fx) * f;
      rec.cy = rec.fy + (rec.ty - rec.fy) * f;
      // A train with no heading stays without one; otherwise turn the short way round.
      if (rec.th !== rec.th || rec.fh !== rec.fh) rec.ch = rec.th;
      else rec.ch = lerpAngle(rec.fh, rec.th, f);
    },
    // True while this record is still moving at `now` (lets the page stop redrawing when idle).
    active: function (rec, now) { return rec.dur > 0 && now < rec.t0 + rec.dur; }
  };

  // Icon size in screen pixels (its length), by zoom. Piecewise linear, monotonic.
  var SIZE_STOPS = [[4, 10], [7, 14], [10, 22], [12, 30], [14, 42], [16, 60], [18, 80]];
  function trainSizePx(zoom) {
    var s = SIZE_STOPS;
    if (zoom <= s[0][0]) return s[0][1];
    for (var i = 1; i < s.length; i++) {
      if (zoom <= s[i][0]) {
        var f = (zoom - s[i - 1][0]) / (s[i][0] - s[i - 1][0]);
        return s[i - 1][1] + (s[i][1] - s[i - 1][1]) * f;
      }
    }
    return s[s.length - 1][1];
  }

  function hexToRgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  var CLASS_RGB = classes.ORDER.map(function (k) { return hexToRgb(classes.CLASSES[k].colour); });

  // Bits of `kind`, which picks the icon for each train.
  var KIND_NODIR = 1;      // no heading known: draw a symmetric shape that does not point anywhere
  var KIND_EST = 2;        // position is estimated (pl "i" or "a")
  var KIND_APPROX = 4;     // position is rough (pl "a")

  function createStore(opts) {
    opts = opts || {};
    var model = opts.model || glideModel;
    var glideMs = opts.glideMs == null ? 1500 : opts.glideMs;
    var reduced = opts.reducedMotion || function () { return false; };
    var JUMP_DEG = 0.3;                      // further than ~30 km: it is a different place, don't glide

    var recs = new Map();
    var animUntil = 0;
    var version = 0;
    var countsCache = null;

    // Ping-pong buffers: the array handed to the GPU changes identity every frame, which is what
    // makes "this attribute changed" reliable without allocating a new array per frame.
    var cap = 0;
    var bufs = [null, null];
    var flip = 0;
    function ensure(n) {
      if (n <= cap) return;
      cap = Math.max(256, 1 << Math.ceil(Math.log2(n)));
      for (var b = 0; b < 2; b++) {
        bufs[b] = {
          n: 0, pos: new Float64Array(cap * 2), ang: new Float32Array(cap), col: new Uint8Array(cap * 4),
          kind: new Uint8Array(cap), order: new Array(cap),
          apos: new Float64Array(cap * 2), na: 0
        };
      }
    }
    ensure(256);

    function newRec(t, now) {
      var hdg = t.hdg == null ? NaN : t.hdg;
      var ck = classes.classOf(t.hc);
      return {
        id: t.id, hc: t.hc, cls: ck, clsIdx: classes.indexOfClass(ck),
        lat: t.lat, lon: t.lon, hdg: t.hdg == null ? null : t.hdg,
        area: t.area, berth: t.berth, at: t.at, pl: t.pl, svc: t.svc || null,
        fx: t.lon, fy: t.lat, fh: hdg, tx: t.lon, ty: t.lat, th: hdg, t0: now, dur: 0,
        cx: t.lon, cy: t.lat, ch: hdg
      };
    }
    function upsert(t, now) {
      if (!t || typeof t.id !== 'string' || typeof t.lat !== 'number' || typeof t.lon !== 'number') return;
      var r = recs.get(t.id);
      if (!r) { recs.set(t.id, newRec(t, now)); return; }
      var hdg = t.hdg == null ? NaN : t.hdg;
      var same = Math.abs(t.lon - r.tx) < 1e-7 && Math.abs(t.lat - r.ty) < 1e-7 &&
        ((hdg !== hdg && r.th !== r.th) || hdg === r.th);
      if (!same) {
        var far = Math.abs(t.lon - r.cx) > JUMP_DEG || Math.abs(t.lat - r.cy) > JUMP_DEG;
        var dur = (reduced() || far) ? 0 : glideMs;
        model.sample(r, now);                      // so retarget starts from what is on screen
        model.retarget(r, t.lon, t.lat, hdg, now, dur);
        if (dur > 0 && now + dur > animUntil) animUntil = now + dur;
      }
      if (r.hc !== t.hc) { r.hc = t.hc; r.cls = classes.classOf(t.hc); r.clsIdx = classes.indexOfClass(r.cls); }
      r.lat = t.lat; r.lon = t.lon; r.hdg = t.hdg == null ? null : t.hdg;
      r.area = t.area; r.berth = t.berth; r.at = t.at; r.pl = t.pl; r.svc = t.svc || null;
    }

    return {
      get size() { return recs.size; },
      get version() { return version; },
      get model() { return model; },
      get(id) { return recs.get(id) || null; },
      has(id) { return recs.has(id); },
      forEach(fn) { recs.forEach(fn); },

      // A full list replaces everything (an SSE snapshot, or a poll): what is not in it is gone.
      // Exception: `keep` ids survive (the train being followed, which may sit outside the box).
      applySnapshot(trains, now, keep) {
        var seen = new Set();
        for (var i = 0; i < trains.length; i++) { upsert(trains[i], now); if (trains[i]) seen.add(trains[i].id); }
        recs.forEach(function (r, id) {
          if (!seen.has(id) && !(keep && keep === id)) recs.delete(id);
        });
        version++; countsCache = null;
      },
      applyUpdate(upserts, removes, now) {
        var i;
        if (upserts) for (i = 0; i < upserts.length; i++) upsert(upserts[i], now);
        if (removes) for (i = 0; i < removes.length; i++) recs.delete(removes[i]);
        version++; countsCache = null;
      },
      // A train fetched on its own (deep link, search result) that the box may not contain.
      add(t, now) { upsert(t, now); version++; countsCache = null; },
      clear() { recs.clear(); version++; countsCache = null; },

      counts() {
        if (countsCache) return countsCache;
        var c = {}; classes.ORDER.forEach(function (k) { c[k] = 0; });
        recs.forEach(function (r) { c[r.cls]++; });
        c.total = recs.size;
        countsCache = c;
        return c;
      },

      isAnimating(now) { return now < animUntil; },

      // Sample every visible train at `now` into the next buffer. `hidden` maps class key -> true.
      // `always` is a train id that is drawn even if its class is hidden (the one being inspected).
      fill(now, hidden, always) {
        ensure(recs.size);
        flip ^= 1;
        var b = bufs[flip];
        var n = 0, na = 0;
        var pos = b.pos, ang = b.ang, col = b.col, kind = b.kind, order = b.order, apos = b.apos;
        recs.forEach(function (r) {
          if (hidden && hidden[r.cls] && r.id !== always) return;
          model.sample(r, now);
          var i2 = n * 2;
          pos[i2] = r.cx; pos[i2 + 1] = r.cy;
          var k = 0;
          if (r.ch !== r.ch) { ang[n] = 0; k |= KIND_NODIR; } else ang[n] = -r.ch;   // deck turns anticlockwise
          if (r.pl === 'i' || r.pl === 'a') k |= KIND_EST;
          if (r.pl === 'a') { k |= KIND_APPROX; apos[na * 2] = r.cx; apos[na * 2 + 1] = r.cy; na++; }
          kind[n] = k;
          var rgb = CLASS_RGB[r.clsIdx], i4 = n * 4;
          col[i4] = rgb[0]; col[i4 + 1] = rgb[1]; col[i4 + 2] = rgb[2]; col[i4 + 3] = 255;
          order[n] = r;
          n++;
        });
        b.n = n; b.na = na;
        return b;
      }
    };
  }

  var api = {
    lerpAngle: lerpAngle, easeInOutSine: easeInOutSine, glideModel: glideModel,
    trainSizePx: trainSizePx, createStore: createStore, hexToRgb: hexToRgb,
    KIND_NODIR: KIND_NODIR, KIND_EST: KIND_EST, KIND_APPROX: KIND_APPROX
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.RM = root.RM || {}).motion = api;
})(typeof self !== 'undefined' ? self : this);
