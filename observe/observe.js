'use strict';
/*
 * Crossing Observer — v1 field data-collection tool (Boundary Road, Portslade).
 *
 * Captures the human-observed CLOSE (red lights start) and OPEN (booms fully up)
 * instants at ms precision, attributes each to a single train from the live B1
 * feed, and stores everything locally (IndexedDB) for CSV/JSON export. It does
 * NOT predict and never writes to the backend (read-only on /crossing/:id/live).
 *
 * Capture is offline-first: a button tap stores the timestamp immediately and is
 * never blocked on the network. Attribution is added straight after.
 */

(function () {
  var API_BASE = 'https://railcrossing.duckdns.org';
  var CROSSING_ID = 'portslade';
  var POLL_MS = 2500;

  // Confirmed Portslade approach berths (from shared/crossings.json / SMART).
  // Embedded so capture + the attribution suggestion work offline. The wider
  // berth→approach mapping across all of LA is the separate berth-chain
  // analysis — we deliberately only trust THESE berths for "on approach".
  var BERTHS = {
    east: { approach: '0006', protecting: '0004', clear: '0002' },
    west: { approach: '0003', protecting: '0005', clear: '0007' }
  };

  // ---- pure helpers (kept side-effect-free for clarity / future testing) ----

  // Stage of a berth on a direction's confirmed approach: 0 = protecting
  // (closest to crossing), 1 = approach (further out), or null = not a confirmed
  // approach berth. We never infer approach from unconfirmed LA berths.
  function approachStage(berth, direction) {
    var b = BERTHS[direction];
    if (!b || !berth) return null;
    if (berth === b.protecting) return 0;
    if (berth === b.approach) return 1;
    return null;
  }
  function onClearBerth(berth, direction) {
    var b = BERTHS[direction];
    return !!(b && berth && berth === b.clear);
  }

  // CLOSE → nearest approaching train: only trains on a confirmed approach berth
  // with a known direction; rank protecting before approach, then freshest.
  function suggestForClose(trains) {
    var cand = [];
    for (var i = 0; i < trains.length; i++) {
      var t = trains[i];
      if (t.direction !== 'east' && t.direction !== 'west') continue;
      var stage = approachStage(t.berth, t.direction);
      if (stage === null) continue;
      cand.push({ t: t, stage: stage });
    }
    if (!cand.length) return null;
    cand.sort(function (a, b) {
      if (a.stage !== b.stage) return a.stage - b.stage;     // protecting first
      return (a.t.ageSecs || 0) - (b.t.ageSecs || 0);        // then freshest
    });
    return cand[0].t;
  }

  // OPEN → just-cleared train: a train on its direction's clear berth, freshest;
  // fall back to the most recently seen approaching train (just passed through).
  function suggestForOpen(trains) {
    var cleared = trains.filter(function (t) {
      return (t.direction === 'east' || t.direction === 'west') && onClearBerth(t.berth, t.direction);
    });
    if (cleared.length) {
      cleared.sort(function (a, b) { return (a.ageSecs || 0) - (b.ageSecs || 0); });
      return cleared[0];
    }
    var appr = trains.filter(function (t) { return approachStage(t.berth, t.direction) !== null; });
    appr.sort(function (a, b) { return (a.ageSecs || 0) - (b.ageSecs || 0); });
    return appr[0] || null;
  }

  // Tally category for a CLOSE record. Consecutive (>1 train in the episode)
  // takes precedence. "fast" = stopping not true (board omits non-stopping fasts,
  // so stopping is "unknown" — label honestly as fast/through, not "non-stop").
  function categoryOf(rec) {
    if (rec.eventType !== 'CLOSE') return null;
    if (!rec.train) return 'other';
    if (rec.episodeTrains && rec.episodeTrains.length > 1) return 'consec';
    var d = rec.train.direction;
    if (d === 'east') return rec.train.stopping === true ? 'east_stop' : 'east_fast';
    if (d === 'west') return 'west';
    return 'other';
  }
  var CAT_LABELS = { east_stop: 'East · stopping', east_fast: 'East · fast/through', west: 'Westbound', consec: 'Consecutive' };

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function hms(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
  function fmtOffset(ms) {
    var s = ms >= 0 ? '+' : '-'; var a = Math.abs(ms);
    return a < 1000 ? (s + a + 'ms') : (s + (a / 1000).toFixed(1) + 's');
  }
  function dirArrow(d) { return d === 'east' ? '▶' : d === 'west' ? '◀' : '·'; }

  function csvCell(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(records) {
    var cols = ['id', 'eventType', 'tCapturedDevice', 'tCorrected', 'tCorrectedISO', 'crossingId',
      'headcode', 'direction', 'stopping', 'suggestedHeadcode', 'suggestionAccepted',
      'confidence', 'episodeTrains', 'note', 'offsetMs', 'createdAt'];
    var lines = [cols.join(',')];
    records.forEach(function (r) {
      var row = [
        r.id, r.eventType, r.tCapturedDevice, r.tCorrected,
        new Date(r.tCorrected).toISOString(), r.crossingId,
        r.train ? r.train.headcode : '', r.train ? r.train.direction : '',
        r.train ? r.train.stopping : '', r.suggestedHeadcode || '',
        r.suggestionAccepted ? 'yes' : 'no', r.confidence || '',
        (r.episodeTrains || []).join(' '), r.note || '', r.offsetMs, r.createdAt
      ];
      lines.push(row.map(csvCell).join(','));
    });
    return lines.join('\n');
  }

  // ---- IndexedDB ----
  var DB_NAME = 'crossing-observer', STORE = 'observations', db = null;
  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function (e) {
        var d = e.target.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = function (e) { db = e.target.result; resolve(db); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function tx(mode) { return db.transaction(STORE, mode).objectStore(STORE); }
  function dbAdd(rec) { return new Promise(function (res, rej) { var r = tx('readwrite').add(rec); r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
  function dbPut(rec) { return new Promise(function (res, rej) { var r = tx('readwrite').put(rec); r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
  function dbDel(id) { return new Promise(function (res, rej) { var r = tx('readwrite').delete(id); r.onsuccess = function () { res(); }; r.onerror = function () { rej(r.error); }; }); }
  function dbAll() { return new Promise(function (res, rej) { var r = tx('readonly').getAll(); r.onsuccess = function () { res(r.result || []); }; r.onerror = function () { rej(r.error); }; }); }

  // ---- runtime state ----
  var liveTrains = [];
  var clockOffsetMs = 0, lastRtt = 0, lastPollAt = 0, lastPollOk = false;
  var episodeSet = {};            // headcodes seen since the last CLOSE
  var lastCaptureId = null;
  var pending = null;             // { id, eventType, train, confidence, note, suggestedHeadcode }

  function $(id) { return document.getElementById(id); }
  function toast(msg) {
    var el = $('toast'); el.textContent = msg; el.classList.remove('hidden');
    clearTimeout(toast._t); toast._t = setTimeout(function () { el.classList.add('hidden'); }, 1800);
  }
  function correctedNow() { return Date.now() + clockOffsetMs; }

  // ---- live feed poll (B1). Failure never blocks capture. ----
  function poll() {
    var t0 = Date.now();
    fetch(API_BASE + '/crossing/' + CROSSING_ID + '/live', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        var t1 = Date.now();
        if (typeof data.serverTime === 'number') {
          lastRtt = t1 - t0;
          clockOffsetMs = Math.round(data.serverTime - (t0 + lastRtt / 2));
        }
        liveTrains = Array.isArray(data.trains) ? data.trains : [];
        liveTrains.forEach(function (t) { if (t.headcode) episodeSet[t.headcode] = true; });
        lastPollAt = Date.now(); lastPollOk = true;
        renderLive(); renderStatus();
      })
      .catch(function () { lastPollOk = false; renderStatus(); });
  }

  // ---- capture ----
  function capture(type) {
    if (navigator.vibrate) navigator.vibrate(35);
    var btn = $(type === 'CLOSE' ? 'btnClose' : 'btnOpen');
    btn.classList.remove('flash'); void btn.offsetWidth; btn.classList.add('flash');

    var tDev = Date.now();
    var sug = type === 'CLOSE' ? suggestForClose(liveTrains) : suggestForOpen(liveTrains);
    var rec = {
      eventType: type,
      tCapturedDevice: tDev,
      tCorrected: tDev + clockOffsetMs,
      crossingId: CROSSING_ID,
      train: sug ? { headcode: sug.headcode, direction: sug.direction, stopping: sug.stopping } : null,
      suggestedHeadcode: sug ? sug.headcode : null,
      suggestionAccepted: false,
      confidence: null,
      episodeTrains: type === 'OPEN' ? Object.keys(episodeSet) : [],
      note: '',
      offsetMs: clockOffsetMs,
      createdAt: Date.now()
    };
    // A CLOSE starts a new closure episode; reset the seen-set to the trains in
    // view right now so the matching OPEN captures who passed during it.
    if (type === 'CLOSE') {
      episodeSet = {};
      liveTrains.forEach(function (t) { if (t.headcode) episodeSet[t.headcode] = true; });
    }
    dbAdd(rec).then(function (id) {
      rec.id = id; lastCaptureId = id;
      openAttr(rec);
      refreshLocal();
    });
  }

  // ---- attribution ----
  function openAttr(rec) {
    pending = {
      id: rec.id, eventType: rec.eventType,
      train: rec.train ? Object.assign({}, rec.train) : null,
      confidence: rec.confidence, note: rec.note || '',
      suggestedHeadcode: rec.suggestedHeadcode
    };
    $('attrTitle').textContent = 'Attribute ' + rec.eventType;
    $('attrTime').textContent = hms(rec.tCorrected);
    $('attrSuggest').innerHTML = rec.suggestedHeadcode
      ? 'Suggested: <b>' + rec.suggestedHeadcode + '</b> (' + (rec.eventType === 'CLOSE' ? 'nearest approaching' : 'just cleared') + ')'
      : 'No confident suggestion — pick the train.';
    $('attrNote').value = pending.note;
    renderConf(); renderPicker(); $('attrPanel').classList.remove('hidden');
    $('attrPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function renderConf() {
    var btns = document.querySelectorAll('.conf-btn');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('sel', btns[i].dataset.conf === pending.confidence);
  }
  function renderPicker() {
    var box = $('attrPicker'); box.innerHTML = '';
    if (!liveTrains.length) { box.innerHTML = '<div class="empty">No trains in feed — mark Unknown or add a note.</div>'; return; }
    liveTrains.forEach(function (t) {
      var sel = pending.train && pending.train.headcode === t.headcode;
      var div = document.createElement('div');
      div.className = 'pick' + (sel ? ' sel' : '') + (t.headcode === pending.suggestedHeadcode ? ' suggested' : '');
      div.innerHTML = '<span class="dir">' + dirArrow(t.direction) + '</span>' +
        '<span class="hc">' + t.headcode + '</span>' +
        '<span class="meta">' + (t.berth || '?') + ' · ' + (t.stopping === true ? 'stops' : 'stop?') + '<br>' + ageStr(t) + '</span>';
      div.onclick = function () {
        pending.train = { headcode: t.headcode, direction: t.direction, stopping: t.stopping };
        renderPicker();
      };
      box.appendChild(div);
    });
  }
  function ageStr(t) { return (t.ageSecs != null ? t.ageSecs + 's ago' : ''); }

  function saveAttr() {
    if (!pending) return;
    var id = pending.id;
    dbAll().then(function (all) {
      var rec = all.filter(function (r) { return r.id === id; })[0];
      if (!rec) return;
      rec.train = pending.train ? Object.assign({}, pending.train) : null;
      rec.suggestionAccepted = !!(rec.train && rec.suggestedHeadcode && rec.train.headcode === rec.suggestedHeadcode);
      rec.confidence = pending.confidence;
      rec.note = $('attrNote').value.trim();
      dbPut(rec).then(function () {
        $('attrPanel').classList.add('hidden'); pending = null;
        refreshLocal(); toast('Saved');
      });
    });
  }

  // ---- recent / tally / export ----
  function refreshLocal() {
    dbAll().then(function (all) {
      all.sort(function (a, b) { return b.createdAt - a.createdAt; });
      renderRecent(all); renderTally(all); renderExport(all);
    });
  }
  function renderRecent(all) {
    var box = $('recentList');
    var recent = all.slice(0, 6);
    if (!recent.length) { box.innerHTML = '<div class="empty">No captures yet.</div>'; return; }
    box.innerHTML = '';
    recent.forEach(function (r) {
      var div = document.createElement('div'); div.className = 'rec';
      var who = r.train ? r.train.headcode + ' ' + dirArrow(r.train.direction) : (r.note ? 'note' : 'unknown');
      div.innerHTML = '<span class="tag ' + (r.eventType === 'CLOSE' ? 'tag-close' : 'tag-open') + '">' + r.eventType + '</span>' +
        '<span class="rt">' + hms(r.tCorrected) + '</span>' +
        '<span class="rmeta">' + who + (r.confidence ? ' · ' + r.confidence : '') + '</span>' +
        '<span class="ractions"></span>';
      var act = div.querySelector('.ractions');
      var e = document.createElement('button'); e.textContent = 'Edit'; e.onclick = function () { openAttr(r); }; act.appendChild(e);
      var d = document.createElement('button'); d.textContent = 'Del'; d.onclick = function () { delObs(r.id); }; act.appendChild(d);
      box.appendChild(div);
    });
  }
  function renderTally(all) {
    var counts = { east_stop: 0, east_fast: 0, west: 0, consec: 0, other: 0 };
    all.forEach(function (r) { var c = categoryOf(r); if (c) counts[c]++; });
    var box = $('tally'); box.innerHTML = '';
    Object.keys(CAT_LABELS).forEach(function (k) {
      var cell = document.createElement('div'); cell.className = 'tally-cell';
      cell.innerHTML = '<div class="tally-n">' + counts[k] + '</div><div class="tally-l">' + CAT_LABELS[k] + '</div>';
      box.appendChild(cell);
    });
    if (counts.other) {
      var note = document.createElement('div'); note.className = 'info-text'; note.style.gridColumn = '1 / -1';
      note.textContent = counts.other + ' CLOSE event(s) unattributed/other';
      box.appendChild(note);
    }
  }
  function renderExport(all) {
    $('storedCount').textContent = all.length + ' stored';
    var notExp = all.filter(function (r) { return !r.exportedAt; }).length;
    $('exportNote').textContent = notExp ? (notExp + ' not yet exported') : (all.length ? 'all exported' : 'nothing to export yet');
  }

  function delObs(id) { dbDel(id).then(function () { if (lastCaptureId === id) lastCaptureId = null; refreshLocal(); toast('Removed'); }); }
  function undoLast() { if (lastCaptureId == null) { toast('Nothing to undo'); return; } delObs(lastCaptureId); }

  function download(name, mime, text) {
    var blob = new Blob([text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function stamp() { var d = new Date(); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()); }
  function markExported(all) { var now = Date.now(); return Promise.all(all.map(function (r) { r.exportedAt = now; return dbPut(r); })); }
  function exportAs(kind) {
    dbAll().then(function (all) {
      if (!all.length) { toast('Nothing to export'); return; }
      all.sort(function (a, b) { return a.createdAt - b.createdAt; });
      if (kind === 'csv') download('observer-' + CROSSING_ID + '-' + stamp() + '.csv', 'text/csv', toCsv(all));
      else download('observer-' + CROSSING_ID + '-' + stamp() + '.json', 'application/json', JSON.stringify(all, null, 2));
      markExported(all).then(function () { refreshLocal(); });
    });
  }

  // ---- rendering: clock, status, live list ----
  function renderClock() { $('clock').textContent = hms(correctedNow()); }
  function renderStatus() {
    var dot = $('netDot'), txt = $('netText');
    var ageSecs = lastPollAt ? Math.round((Date.now() - lastPollAt) / 1000) : null;
    if (!lastPollOk && ageSecs === null) { dot.className = 'dot dot-warn'; txt.textContent = 'connecting…'; }
    else if (!lastPollOk || (ageSecs != null && ageSecs > 8)) { dot.className = 'dot dot-bad'; txt.textContent = 'feed offline (capture still works)'; }
    else { dot.className = 'dot dot-ok'; txt.textContent = 'live'; }
    $('offsetText').textContent = 'offset ' + fmtOffset(clockOffsetMs);
    $('pollAge').textContent = ageSecs != null ? ('feed ' + ageSecs + 's') : 'feed --';
  }
  function renderLive() {
    var box = $('liveList');
    $('liveCount').textContent = liveTrains.length ? (liveTrains.length + ' in area') : '';
    if (!liveTrains.length) { box.innerHTML = '<div class="empty">No trains in area right now.</div>'; return; }
    box.innerHTML = '';
    liveTrains.forEach(function (t) {
      var appr = approachStage(t.berth, t.direction) !== null;
      var div = document.createElement('div'); div.className = 'train' + (appr ? ' approaching' : '');
      var stopBadge = t.stopping === true ? '<span class="badge badge-stop">stops</span>' : '<span class="badge badge-unknown">stop?</span>';
      var apprBadge = appr ? '<span class="badge badge-appr">approach</span>' : '';
      div.innerHTML = '<span class="dir">' + dirArrow(t.direction) + '</span>' +
        '<span><span class="hc">' + t.headcode + '</span>' + stopBadge + apprBadge +
        '<div class="od">' + (t.origin || '?') + ' → ' + (t.destination || '?') + '</div></span>' +
        '<span class="right"><span class="berth">' + (t.berth || '?') + '</span><br>' + ageStr(t) + '</span>';
      box.appendChild(div);
    });
  }

  // ---- init ----
  function init() {
    $('btnClose').onclick = function () { capture('CLOSE'); };
    $('btnOpen').onclick = function () { capture('OPEN'); };
    $('attrSave').onclick = saveAttr;
    $('attrUnknown').onclick = function () { pending.train = null; renderPicker(); };
    $('undoBtn').onclick = undoLast;
    $('exportCsv').onclick = function () { exportAs('csv'); };
    $('exportJson').onclick = function () { exportAs('json'); };
    var cb = document.querySelectorAll('.conf-btn');
    for (var i = 0; i < cb.length; i++) cb[i].onclick = (function (b) { return function () { pending.confidence = b.dataset.conf; renderConf(); }; })(cb[i]);

    renderClock(); setInterval(renderClock, 250);
    renderStatus(); setInterval(renderStatus, 1000);

    openDb().then(function () { refreshLocal(); }).catch(function (e) { toast('Storage error: ' + e.message); });

    poll(); setInterval(poll, POLL_MS);

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () { });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
