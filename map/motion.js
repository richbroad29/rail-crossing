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

  var node = typeof require === 'function' && typeof module !== 'undefined';
  var classes = node ? require('./classes.js') : root.RM.classes;
  var engine = node ? require('./engine.js') : root.RM.engine;

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

  // From this zoom up a train is drawn at its real-world length, in metres, so it keeps a believable
  // scale against the street map (about a 4-car unit). Below it the pixel sizes above apply, and the
  // two cross-fade over one zoom level so nothing pops.
  var METRES_FROM = 15, FADE_ZOOMS = 1, TRAIN_LENGTH_M = 80, TRAIN_WIDTH_M = 8;   // width exaggerated x3 so it reads
  function metresPerPixel(zoom, lat) {
    return 40075016.686 * Math.cos(lat * Math.PI / 180) / (512 * Math.pow(2, zoom));   // MapLibre: 512 px tiles
  }
  // 0 = all pixel-sized, 1 = all metre-sized
  function metreMix(zoom) {
    var f = (zoom - (METRES_FROM - FADE_ZOOMS / 2)) / FADE_ZOOMS;
    return f < 0 ? 0 : f > 1 ? 1 : f;
  }
  // On-screen length of a train in pixels, whichever mode it is in (labels and rings key off this).
  function trainLenPx(zoom, lat) {
    var f = metreMix(zoom), px = trainSizePx(zoom);
    return f === 0 ? px : px * (1 - f) + (TRAIN_LENGTH_M / metresPerPixel(zoom, lat)) * f;
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

  // How far apart two stopped trains must sit before they are drawn as separate trains, and how far
  // they are fanned apart sideways when they are not. Display only: the real position is untouched.
  var FAN_JOIN_M = 14, FAN_GAP_M = 9, FAN_RATE = 40;

  function createStore(opts) {
    opts = opts || {};
    var model = opts.model || glideModel;
    var glideMs = opts.glideMs == null ? 1500 : opts.glideMs;
    var reduced = opts.reducedMotion || function () { return false; };
    var JUMP_DEG = 0.3;                      // further than ~30 km: it is a different place, don't glide
    // Track-following motion (phase 2). `spans` is a span cache (spans.js); `clock.render(now)` turns the
    // page clock into the render time. Without both, every train keeps the phase-1 glide.
    var spans = opts.spans || null, clock = opts.clock || null, ecfg = Object.assign({}, engine.DEFAULTS, opts.engine || {});
    var view = { on: !!opts.trackAlways, box: null };

    var recs = new Map();
    var animUntil = 0, trackMoving = false;
    var version = 0;
    var countsCache = null;
    var haloRgb = [15, 23, 42, 235], fanOn = true, lastFill = 0;

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
          hcol: new Uint8Array(cap * 4), kind: new Uint8Array(cap), order: new Array(cap),
          apos: new Float64Array(cap * 2), na: 0, wpos: new Float64Array(cap * 2), nw: 0
        };
      }
      statIdx = new Int32Array(cap); cluNext = new Int32Array(cap); cluHead = new Int32Array(cap);
    }
    var statIdx, cluNext, cluHead;
    ensure(256);

    function newRec(t, now) {
      var hdg = t.hdg == null ? NaN : t.hdg;
      var ck = classes.classOf(t.hc);
      return {
        id: t.id, hc: t.hc, cls: ck, clsIdx: classes.indexOfClass(ck),
        lat: t.lat, lon: t.lon, hdg: t.hdg == null ? null : t.hdg,
        area: t.area, berth: t.berth, at: t.at, pl: t.pl, svc: t.svc || null,
        fx: t.lon, fy: t.lat, fh: hdg, tx: t.lon, ty: t.lat, th: hdg, t0: now, dur: 0,
        cx: t.lon, cy: t.lat, ch: hdg,
        lh: t.hdg == null ? NaN : t.hdg,     // last heading we were ever given: a stopped train keeps pointing the way it came
        hf: NaN, hfX: NaN, hfY: NaN,         // heading read from the railway line under it (set by the page), for trains with none
        // phase 2
        plans: null, es: null, hist: [], mode: 'glide', alpha: 1, wait: false, stopped: false, shown: false,
        missing: 0, px: t.lon, py: t.lat, ph: hdg, dh: NaN, fan: 0, fanT: 0, mvSeen: false
      };
    }

    // ---- motion plans ------------------------------------------------------------------------------
    function validMv(mv) {
      return mv && typeof mv.sp === 'string' && typeof mv.t0 === 'number' && isFinite(mv.t0) &&
        typeof mv.eta === 'number' && isFinite(mv.eta);
    }
    function ingestMv(r, mv, now) {
      if (!r.plans) r.plans = [];
      var plans = r.plans, last = plans.length ? plans[plans.length - 1] : null;
      if (last && mv.sp === last.sp && mv.t0 === last.t0) {              // the same berth: its timing may have been refined
        last.eta = mv.eta; last.stop = mv.stop == null ? null : mv.stop; last.dwell = mv.dwell == null ? null : mv.dwell;
        last.held = !!mv.held; last.profT = -1;
        if (last.span) engine.attachSpan(last, last.span, ecfg);
        return;
      }
      if (last && mv.t0 <= last.t0) return;                              // an old step arriving late: never go back
      var p = engine.makePlan(mv, spans ? spans.peek(mv.sp) : null, ecfg);
      p.recvAt = now;
      if (!p.span) r.missing++;
      plans.push(p);
      r.mvSeen = true;
    }
    function attachMissing(r) {
      var plans = r.plans, n = 0;
      for (var i = 0; i < plans.length; i++) {
        var p = plans[i];
        if (p.span) continue;
        var sp = spans.peek(p.sp);
        if (sp) engine.attachSpan(p, sp, ecfg); else n++;
      }
      r.missing = n;
    }

    function upsert(t, now) {
      if (!t || typeof t.id !== 'string' || typeof t.lat !== 'number' || typeof t.lon !== 'number') return;
      var r = recs.get(t.id);
      if (!r) { r = newRec(t, now); recs.set(t.id, r); }
      else {
        var hdg = t.hdg == null ? NaN : t.hdg;
        var same = Math.abs(t.lon - r.tx) < 1e-7 && Math.abs(t.lat - r.ty) < 1e-7 &&
          ((hdg !== hdg && r.th !== r.th) || hdg === r.th);
        if (!same) {
          var far = Math.abs(t.lon - r.cx) > JUMP_DEG || Math.abs(t.lat - r.cy) > JUMP_DEG;
          var dur = (reduced() || far) ? 0 : glideMs;
          if (r.mode === 'glide') model.sample(r, now);                  // so retarget starts from what is on screen
          model.retarget(r, t.lon, t.lat, hdg, now, dur);
          if (r.mode !== 'glide') { r.t0 = now; r.dur = 0; }             // a tracked train is moved by the engine, not the glide
          if (dur > 0 && r.mode === 'glide' && now + dur > animUntil) animUntil = now + dur;
        }
      }
      if (r.hc !== t.hc) { r.hc = t.hc; r.cls = classes.classOf(t.hc); r.clsIdx = classes.indexOfClass(r.cls); }
      if (t.hdg != null) r.lh = t.hdg;
      r.lat = t.lat; r.lon = t.lon; r.hdg = t.hdg == null ? null : t.hdg;
      r.area = t.area; r.berth = t.berth; r.at = t.at; r.pl = t.pl; r.svc = t.svc || null;
      if (validMv(t.mv)) ingestMv(r, t.mv, now);
      else if (r.plans) { r.plans = null; r.es = null; r.missing = 0; r.mvSeen = false; if (r.mode === 'track') leaveTrack(r, now); }
    }

    function leaveTrack(r, now) {
      r.mode = 'glide'; r.es = null; r.alpha = 1; r.wait = false; r.stopped = false;
      r.fx = r.cx; r.fy = r.cy; r.fh = r.ch; r.tx = r.lon; r.ty = r.lat; r.th = r.hdg == null ? NaN : r.hdg;
      r.t0 = now; r.dur = reduced() ? 0 : glideMs;
      if (r.dur > 0 && now + r.dur > animUntil) animUntil = now + r.dur;
    }

    // One tracked train for one frame. Returns false if it has no usable plan yet (stay in glide).
    var rTime = 0, tmpState = null;
    function track(r, now) {
      var plans = r.plans;
      if (!plans || !plans.length) return false;
      if (r.missing && spans) attachMissing(r);
      var es = r.es;
      if (!es) {
        if (!plans[0].span) return false;
        es = r.es = engine.newState();
      }
      var wasInit = es.init;
      engine.advance(es, plans, rTime, ecfg, es);
      if (!es.init || es.x !== es.x) return false;
      if (!wasInit) {                              // first frame on the track
        if (r.shown && Math.abs(r.cx - es.x) * 80000 < 40) { es.offx += r.cx - es.x; es.offy += r.cy - es.y; es.x = r.cx; es.y = r.cy; es.alpha = 1; es.fade = 0; }   // slide from where it was drawn
        r.mode = 'track';
      }
      while (es.k > 1) { r.hist.push(plans.shift()); es.k--; if (es.fade === 1) es.tgtK--; if (r.hist.length > 24) r.hist.shift(); }
      r.cx = es.x + 0; r.cy = es.y + 0; r.ch = es.hdg; r.alpha = es.alpha; r.wait = es.wait; r.stopped = es.stopped;
      if (es.hdg === es.hdg) r.lh = es.hdg;
      if (!es.stopped || es.fade || es.offx !== 0 || es.offy !== 0) trackMoving = true;
      return true;
    }

    // ---- the fan-out of stopped trains ---------------------------------------------------------------
    // Trains standing at one point (a platform, one berth) would draw on top of one another, and with
    // different headings as a CROSS. They are laid side by side instead, all squared to the same way
    // (the lowest id's), a little apart. Their real positions are not changed.
    // Clustering uses typed arrays and an open-addressed table stamped per frame, so a frame with
    // thousands of stopped trains allocates nothing.
    var tabSize = 0, tabKey, tabVal, tabStamp, stamp = 0, cx0, cy0, cnext, ccount, chead, mnext, tmpMem = [], sortB = null;
    function ensureFan(n) {
      if (tabSize >= n * 2) return;
      tabSize = 1 << Math.ceil(Math.log2(Math.max(64, n * 2)));
      tabKey = new Int32Array(tabSize); tabVal = new Int32Array(tabSize); tabStamp = new Int32Array(tabSize);
      cx0 = new Float64Array(n); cy0 = new Float64Array(n); cnext = new Int32Array(n); ccount = new Int32Array(n);
      chead = new Int32Array(n); mnext = new Int32Array(n);
    }
    function cellKey(x, y) { return (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) & 0x3fffffff; }
    function slotOf(key) {
      var mask = tabSize - 1, i = key & mask;
      while (tabStamp[i] === stamp && tabKey[i] !== key) i = (i + 1) & mask;
      return i;
    }
    function byId(a, c) { return sortB.order[a].id < sortB.order[c].id ? -1 : 1; }
    function fanOut(b, n, ns, dt) {
      var i, r, q;
      ensureFan(Math.max(n, 16));
      stamp++;
      var cLat = 111000, cLon = 111320 * 0.62, cell = FAN_JOIN_M, nc = 0;
      for (q = 0; q < ns; q++) {
        i = statIdx[q]; r = b.order[i];
        var gx = Math.floor(r.cx * cLon / cell), gy = Math.floor(r.cy * cLat / cell), found = -1;
        for (var dx = -1; dx <= 1 && found < 0; dx++) for (var dy = -1; dy <= 1; dy++) {
          var sl = slotOf(cellKey(gx + dx, gy + dy));
          if (tabStamp[sl] !== stamp) continue;
          for (var c = tabVal[sl]; c >= 0; c = cnext[c]) {
            var ex = (cx0[c] - r.cx) * cLon, ey = (cy0[c] - r.cy) * cLat;
            if (ex * ex + ey * ey <= cell * cell) { found = c; break; }
          }
          if (found >= 0) break;
        }
        if (found < 0) {
          found = nc++;
          cx0[found] = r.cx; cy0[found] = r.cy; ccount[found] = 0; chead[found] = -1;
          var key = cellKey(gx, gy), s2 = slotOf(key);
          if (tabStamp[s2] !== stamp) { tabStamp[s2] = stamp; tabKey[s2] = key; tabVal[s2] = -1; }
          cnext[found] = tabVal[s2]; tabVal[s2] = found;
        }
        mnext[i] = chead[found]; chead[found] = i; ccount[found]++;
      }
      sortB = b;
      for (var g = 0; g < nc; g++) {
        if (ccount[g] < 2) continue;
        tmpMem.length = 0;
        for (var mi = chead[g]; mi >= 0; mi = mnext[mi]) tmpMem.push(mi);
        tmpMem.sort(byId);
        var lead = b.order[tmpMem[0]], gh = lead.ch === lead.ch ? lead.ch : lead.lh;
        if (gh !== gh) continue;
        var s = Math.sin(gh * Math.PI / 180), co = Math.cos(gh * Math.PI / 180);   // the normal to the right of travel, in (east, north)
        for (var k = 0; k < tmpMem.length; k++) {
          var rr = b.order[tmpMem[k]];
          rr.fanT = (k - (tmpMem.length - 1) / 2) * FAN_GAP_M; rr.gh = gh;
          rr.fnx = co; rr.fny = -s;
        }
      }
      // ease each train's sideways offset and heading toward their targets (so joining or leaving a
      // group slides rather than snaps), then write the display position
      var step = FAN_RATE * dt, turn = 270 * dt;
      for (i = 0; i < n; i++) {
        r = b.order[i];
        if (r.fan === 0 && r.fanT === 0 && r.gh !== r.gh && r.dh !== r.dh) continue;
        var moving = false;
        if (r.fan !== r.fanT) { var d = r.fanT - r.fan; r.fan += d > step ? step : d < -step ? -step : d; moving = true; }
        var want = r.gh === r.gh ? r.gh : (r.ch === r.ch ? r.ch : r.lh);
        if (r.fan !== 0 || r.gh === r.gh || r.dh === r.dh) {
          if (r.dh !== r.dh || want !== want) r.dh = want;
          else { var dd = lerpDiff(r.dh, want); r.dh = (r.dh + (dd > turn ? turn : dd < -turn ? -turn : dd) + 360) % 360; if (Math.abs(dd) > 0.01) moving = true; }
        }
        var px = r.cx, py = r.cy;
        if (r.fan !== 0 && r.fnx !== undefined) { px += r.fan * r.fnx / cLon; py += r.fan * r.fny / cLat; }
        r.px = px; r.py = py;
        var ph = r.dh === r.dh && (r.fan !== 0 || r.gh === r.gh) ? r.dh : (r.ch === r.ch ? r.ch : r.lh);
        r.ph = ph;
        if (r.fan === 0 && r.gh !== r.gh && r.dh === r.dh && Math.abs(lerpDiff(r.dh, r.ch === r.ch ? r.ch : r.lh)) < 0.01) r.dh = NaN;
        var i2 = i * 2; b.pos[i2] = px; b.pos[i2 + 1] = py;
        if (ph === ph) b.ang[i] = -ph;
        if (moving) trackMoving = true;
      }
    }
    function lerpDiff(a, b) { return ((b - a + 540) % 360) - 180; }

    return {
      get size() { return recs.size; },
      get version() { return version; },
      get model() { return model; },
      get(id) { return recs.get(id) || null; },
      has(id) { return recs.has(id); },
      forEach(fn) { recs.forEach(fn); },
      get spans() { return spans; },
      get engineConfig() { return ecfg; },

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

      // The page tells the store what is on screen: track-following (and the span requests it needs)
      // is only done for trains inside `box` and only when `on` (zoomed in enough for it to show).
      setView(on, box) { view.on = !!on && !reduced(); view.box = box || null; },
      setHalo(rgba) { haloRgb = rgba; },
      setFan(on) { fanOn = !!on; },
      // The span of a train that should be fetched first (the one being inspected).
      isAnimating(now) { return now < animUntil || trackMoving; },

      // Sample every visible train at `now` into the next buffer. `hidden` maps class key -> true.
      // `always` is a train id that is drawn even if its class is hidden (the one being inspected).
      fill(now, hidden, always) {
        ensure(recs.size);
        flip ^= 1;
        var b = bufs[flip];
        var n = 0, na = 0, nw = 0, ns = 0;
        var pos = b.pos, ang = b.ang, col = b.col, kind = b.kind, order = b.order, apos = b.apos, hcol = b.hcol;
        var dt = lastFill ? Math.min(0.25, Math.max(0, (now - lastFill) / 1000)) : 0.016; lastFill = now;
        trackMoving = false;
        rTime = clock ? clock.render(now) : now;
        var box = view.box, useTrack = view.on && !!spans && !!clock;
        recs.forEach(function (r) {
          if (hidden && hidden[r.cls] && r.id !== always) return;
          var tracked = false;
          if (useTrack && r.plans && (!box || (r.cy >= box[0] && r.cy <= box[2] && r.cx >= box[1] && r.cx <= box[3] || r.id === always))) {
            if (r.missing) {
              for (var q = 0; q < r.plans.length; q++) if (!r.plans[q].span) spans.need(r.plans[q].sp, r.id === always);
            }
            tracked = track(r, now);
          } else if (r.mode === 'track') leaveTrack(r, now);
          if (!tracked) {
            model.sample(r, now);
            r.alpha = 1; r.wait = false; r.stopped = !model.active || !model.active(r, now);
          }
          r.shown = true;
          r.fanT = 0; r.gh = NaN;
          if (fanOn && r.stopped && (!box || (r.cy >= box[0] && r.cy <= box[2] && r.cx >= box[1] && r.cx <= box[3]))) statIdx[ns++] = n;
          var i2 = n * 2;
          pos[i2] = r.cx; pos[i2 + 1] = r.cy;
          var k = 0;
          // Which way to point: the live heading; else the last one we were told (it just stopped);
          // else the line under it (a symmetric shape: the direction is only known up to 180 degrees).
          var hd = r.ch === r.ch ? r.ch : r.lh === r.lh ? r.lh : NaN;
          if (hd === hd) ang[n] = -hd;                                              // deck turns anticlockwise
          else if (r.hf === r.hf) { ang[n] = -r.hf; k |= KIND_NODIR; }
          else { ang[n] = 0; k |= KIND_NODIR; }
          if (r.pl === 'i' || r.pl === 'a') k |= KIND_EST;
          // a rough position is shown by a fainter body (never a ring): the estimate cue is the dashed outline
          var alpha = r.alpha * (r.pl === 'a' ? 0.62 : 1);
          if (r.pl === 'a') { k |= KIND_APPROX; apos[na * 2] = r.cx; apos[na * 2 + 1] = r.cy; na++; }
          kind[n] = k;
          var rgb = CLASS_RGB[r.clsIdx], i4 = n * 4;
          col[i4] = rgb[0]; col[i4 + 1] = rgb[1]; col[i4 + 2] = rgb[2]; col[i4 + 3] = Math.round(255 * alpha);
          hcol[i4] = haloRgb[0]; hcol[i4 + 1] = haloRgb[1]; hcol[i4 + 2] = haloRgb[2]; hcol[i4 + 3] = Math.round(haloRgb[3] * r.alpha);
          order[n] = r;
          r.px = r.cx; r.py = r.cy; r.ph = hd === hd ? hd : NaN;
          n++;
        });
        b.n = n; b.na = na;
        fanOut(b, n, ns, dt);
        // a small amber mark just ahead of each train that is waiting at a signal
        var wp = b.wpos;
        for (var i = 0; i < n; i++) {
          var rw = order[i];
          if (!rw.wait || rw.ph !== rw.ph) continue;
          var a = rw.ph * Math.PI / 180, ahead = 48;      // metres past its centre
          wp[nw * 2] = rw.px + Math.sin(a) * ahead / (111320 * Math.cos(rw.py * Math.PI / 180));
          wp[nw * 2 + 1] = rw.py + Math.cos(a) * ahead / 110540;
          nw++;
        }
        b.nw = nw;
        return b;
      }
    };
  }
    var api = {
    lerpAngle: lerpAngle, easeInOutSine: easeInOutSine, glideModel: glideModel,
    trainSizePx: trainSizePx, metresPerPixel: metresPerPixel, metreMix: metreMix, trainLenPx: trainLenPx,
    METRES_FROM: METRES_FROM, TRAIN_LENGTH_M: TRAIN_LENGTH_M, TRAIN_WIDTH_M: TRAIN_WIDTH_M, createStore: createStore, hexToRgb: hexToRgb,
    KIND_NODIR: KIND_NODIR, KIND_EST: KIND_EST, KIND_APPROX: KIND_APPROX
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.RM = root.RM || {}).motion = api;
})(typeof self !== 'undefined' ? self : this);
