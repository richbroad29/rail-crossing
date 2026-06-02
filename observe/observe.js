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
 *
 * v1.1 — legibility pass: plain-English identities, a schematic approach strip
 * (confirmed berths only — NOT a geographic map; we don't have berth positions
 * yet, that's what this tool collects), and approaching-first attribution.
 */

(function () {
  var API_BASE = 'https://railcrossing.duckdns.org';
  var CROSSING_ID = 'portslade';
  var POLL_MS = 2500;

  // Confirmed Portslade approach berths (from shared/crossings.json / SMART).
  // Embedded so capture + the attribution suggestion work offline. The wider
  // berth→position mapping across all of LA is the separate berth-chain
  // analysis — we deliberately only trust THESE berths for "on approach".
  var BERTHS = {
    east: { approach: '0006', protecting: '0004', clear: '0002' },
    west: { approach: '0003', protecting: '0005', clear: '0007' }
  };

  // ---- pure helpers (kept side-effect-free for clarity / future testing) ----

  function trainKind(hc) {
    if (!hc) return 'passenger';
    var c = hc.charAt(0);
    if (c === '6' || c === '7') return 'freight';
    if (c === '5') return 'ecs';
    if (c === '3') return 'test';
    return 'passenger';
  }
  function dirWord(d) { return d === 'east' ? 'Eastbound' : d === 'west' ? 'Westbound' : 'Direction unknown'; }
  function dirArrow(d) { return d === 'east' ? '▶' : d === 'west' ? '◀' : '·'; }

  // Proximity of a train on a confirmed approach berth: stage + plain label +
  // rank (0 = closest). null if the berth is not a confirmed Portslade berth.
  function proximity(berth, direction) {
    var b = BERTHS[direction];
    if (!b || !berth) return null;
    if (berth === b.protecting) return { stage: 'close', label: 'Close — about to cross', rank: 0 };
    if (berth === b.approach) return { stage: 'approach', label: 'Approaching', rank: 1 };
    if (berth === b.clear) return { stage: 'passed', label: 'Just passed', rank: 2 };
    return null;
  }
  function isApproaching(t) { return proximity(t.berth, t.direction) !== null; }

  // Plain-English headline for a train; falls back gracefully when un-timetabled.
  function identity(t) {
    var kind = trainKind(t.headcode);
    var hasOD = t.origin || t.destination;
    var od = (t.origin || '?') + ' → ' + (t.destination || '?');
    if (kind === 'freight') return hasOD ? ('Freight · ' + od) : 'Freight (not in timetable)';
    if (kind === 'ecs') return hasOD ? ('Empty stock · ' + od) : 'Empty stock';
    return hasOD ? od : 'Train (not in timetable)';
  }
  // Short name for a strip chip: destination first word, else headcode.
  function shortName(t) { return t.destination ? t.destination.split(/[ (,]/)[0] : t.headcode; }

  // CLOSE → nearest approaching: confirmed approach berths only; protecting
  // before approach, then freshest.
  function suggestForClose(trains) {
    var cand = [];
    for (var i = 0; i < trains.length; i++) {
      var p = proximity(trains[i].berth, trains[i].direction);
      if (!p || p.stage === 'passed') continue;
      cand.push({ t: trains[i], rank: p.rank });
    }
    if (!cand.length) return null;
    cand.sort(function (a, b) { return a.rank - b.rank || (a.t.ageSecs || 0) - (b.t.ageSecs || 0); });
    return cand[0].t;
  }
  // OPEN → just-cleared: a train on its clear berth, freshest; else most recent
  // train still on the approach (just passing through).
  function suggestForOpen(trains) {
    var cleared = trains.filter(function (t) { var p = proximity(t.berth, t.direction); return p && p.stage === 'passed'; });
    if (cleared.length) { cleared.sort(function (a, b) { return (a.ageSecs || 0) - (b.ageSecs || 0); }); return cleared[0]; }
    var appr = trains.filter(isApproaching);
    appr.sort(function (a, b) { return (a.ageSecs || 0) - (b.ageSecs || 0); });
    return appr[0] || null;
  }

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
  function fmtOffset(ms) { var s = ms >= 0 ? '+' : '-'; var a = Math.abs(ms); return a < 1000 ? (s + a + 'ms') : (s + (a / 1000).toFixed(1) + 's'); }
  function ageStr(t) { return (t.ageSecs != null ? t.ageSecs + 's ago' : ''); }

  function csvCell(v) { if (v === null || v === undefined) return ''; var s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function toCsv(records) {
    var cols = ['id', 'eventType', 'tCapturedDevice', 'tCorrected', 'tCorrectedISO', 'crossingId',
      'headcode', 'direction', 'stopping', 'suggestedHeadcode', 'suggestionAccepted',
      'confidence', 'episodeTrains', 'note', 'offsetMs', 'createdAt'];
    var lines = [cols.join(',')];
    records.forEach(function (r) {
      lines.push([
        r.id, r.eventType, r.tCapturedDevice, r.tCorrected, new Date(r.tCorrected).toISOString(), r.crossingId,
        r.train ? r.train.headcode : '', r.train ? r.train.direction : '', r.train ? r.train.stopping : '',
        r.suggestedHeadcode || '', r.suggestionAccepted ? 'yes' : 'no', r.confidence || '',
        (r.episodeTrains || []).join(' '), r.note || '', r.offsetMs, r.createdAt
      ].map(csvCell).join(','));
    });
    return lines.join('\n');
  }

  // ---- IndexedDB ----
  var DB_NAME = 'crossing-observer', STORE = 'observations', db = null;
  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function (e) { var d = e.target.result; if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true }); };
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
  var episodeSet = {};
  var lastCaptureId = null;
  var pending = null;
  var showElsewhere = false;

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function toast(msg) { var e = $('toast'); e.textContent = msg; e.classList.remove('hidden'); clearTimeout(toast._t); toast._t = setTimeout(function () { e.classList.add('hidden'); }, 1800); }
  function correctedNow() { return Date.now() + clockOffsetMs; }

  // split the live feed into approaching (confirmed berths) and elsewhere
  function partition() {
    var appr = [], rest = [];
    liveTrains.forEach(function (t) { (isApproaching(t) ? appr : rest).push(t); });
    return { appr: appr, rest: rest };
  }

  // ---- live feed poll (B1). Failure never blocks capture. ----
  function poll() {
    var t0 = Date.now();
    fetch(API_BASE + '/crossing/' + CROSSING_ID + '/live', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        var t1 = Date.now();
        if (typeof data.serverTime === 'number') { lastRtt = t1 - t0; clockOffsetMs = Math.round(data.serverTime - (t0 + lastRtt / 2)); }
        liveTrains = Array.isArray(data.trains) ? data.trains : [];
        liveTrains.forEach(function (t) { if (t.headcode) episodeSet[t.headcode] = true; });
        lastPollAt = Date.now(); lastPollOk = true;
        renderApproach(); renderElsewhere(); renderStatus();
        if (pending) renderPicker();
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
      eventType: type, tCapturedDevice: tDev, tCorrected: tDev + clockOffsetMs, crossingId: CROSSING_ID,
      train: sug ? { headcode: sug.headcode, direction: sug.direction, stopping: sug.stopping } : null,
      suggestedHeadcode: sug ? sug.headcode : null, suggestionAccepted: false, confidence: null,
      episodeTrains: type === 'OPEN' ? Object.keys(episodeSet) : [], note: '', offsetMs: clockOffsetMs, createdAt: Date.now()
    };
    if (type === 'CLOSE') { episodeSet = {}; liveTrains.forEach(function (t) { if (t.headcode) episodeSet[t.headcode] = true; }); }
    dbAdd(rec).then(function (id) { rec.id = id; lastCaptureId = id; openAttr(rec); refreshLocal(); });
  }

  // ---- attribution ----
  function openAttr(rec) {
    pending = {
      id: rec.id, eventType: rec.eventType,
      train: rec.train ? Object.assign({}, rec.train) : null,
      confidence: rec.confidence, note: rec.note || '', suggestedHeadcode: rec.suggestedHeadcode
    };
    $('attrTitle').textContent = 'Which train caused this ' + rec.eventType + '?';
    $('attrTime').textContent = hms(rec.tCorrected);
    var sug = rec.suggestedHeadcode ? liveTrains.filter(function (t) { return t.headcode === rec.suggestedHeadcode; })[0] : null;
    if (sug) {
      var p = proximity(sug.berth, sug.direction);
      $('attrSuggest').innerHTML = 'Suggested: <b>' + identity(sug) + '</b><br>' + dirWord(sug.direction) +
        (p ? ' · ' + p.label : '') + ' · <span class="mono">' + sug.headcode + '</span>';
    } else {
      $('attrSuggest').innerHTML = 'No clear approaching train — pick from the list, or mark Unknown.';
    }
    $('attrNote').value = pending.note;
    renderConf(); renderPicker();
    $('attrPanel').classList.remove('hidden');
    $('attrPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function renderConf() { var b = document.querySelectorAll('.conf-btn'); for (var i = 0; i < b.length; i++) b[i].classList.toggle('sel', b[i].dataset.conf === pending.confidence); }

  function pickRow(t) {
    var sel = pending.train && pending.train.headcode === t.headcode;
    var p = proximity(t.berth, t.direction);
    var row = el('div', 'pick' + (sel ? ' sel' : '') + (t.headcode === pending.suggestedHeadcode ? ' suggested' : ''));
    row.innerHTML =
      '<span class="dir">' + dirArrow(t.direction) + '</span>' +
      '<span class="pick-main"><span class="pick-id">' + identity(t) + '</span>' +
      '<span class="pick-sub">' + dirWord(t.direction) + (p ? ' · ' + p.label : '') + '</span></span>' +
      '<span class="meta"><span class="mono">' + t.headcode + '</span><br>' + (t.berth || '?') + ' · ' + ageStr(t) + '</span>';
    row.onclick = function () { pending.train = { headcode: t.headcode, direction: t.direction, stopping: t.stopping }; renderPicker(); };
    return row;
  }
  function renderPicker() {
    var box = $('attrPicker'); box.innerHTML = '';
    var parts = partition();
    if (!liveTrains.length) { box.innerHTML = '<div class="empty">No trains in feed — mark Unknown or add a note.</div>'; return; }
    // approaching first, ordered closest → furthest, suggestion floated to top
    parts.appr.sort(function (a, b) {
      if (a.headcode === pending.suggestedHeadcode) return -1;
      if (b.headcode === pending.suggestedHeadcode) return 1;
      var pa = proximity(a.berth, a.direction).rank, pb = proximity(b.berth, b.direction).rank;
      return pa - pb || (a.ageSecs || 0) - (b.ageSecs || 0);
    });
    if (parts.appr.length) { box.appendChild(el('div', 'pick-group', 'On the Portslade approach')); parts.appr.forEach(function (t) { box.appendChild(pickRow(t)); }); }
    if (parts.rest.length) {
      var tog = el('div', 'pick-toggle', (showElsewhere ? '▾ ' : '▸ ') + 'Elsewhere in area (' + parts.rest.length + ')');
      tog.onclick = function () { showElsewhere = !showElsewhere; renderPicker(); };
      box.appendChild(tog);
      if (showElsewhere) parts.rest.forEach(function (t) { box.appendChild(pickRow(t)); });
    }
  }

  function saveAttr() {
    if (!pending) return;
    var id = pending.id;
    dbAll().then(function (all) {
      var rec = all.filter(function (r) { return r.id === id; })[0]; if (!rec) return;
      rec.train = pending.train ? Object.assign({}, pending.train) : null;
      rec.suggestionAccepted = !!(rec.train && rec.suggestedHeadcode && rec.train.headcode === rec.suggestedHeadcode);
      rec.confidence = pending.confidence; rec.note = $('attrNote').value.trim();
      dbPut(rec).then(function () { $('attrPanel').classList.add('hidden'); pending = null; refreshLocal(); toast('Saved'); });
    });
  }

  // ---- recent / tally / export ----
  function refreshLocal() { dbAll().then(function (all) { all.sort(function (a, b) { return b.createdAt - a.createdAt; }); renderRecent(all); renderTally(all); renderExport(all); }); }
  function renderRecent(all) {
    var box = $('recentList'); var recent = all.slice(0, 6);
    if (!recent.length) { box.innerHTML = '<div class="empty">No captures yet.</div>'; return; }
    box.innerHTML = '';
    recent.forEach(function (r) {
      var who = r.train ? (r.train.headcode + ' ' + dirArrow(r.train.direction)) : (r.note ? 'note' : 'unknown');
      var div = el('div', 'rec');
      div.innerHTML = '<span class="tag ' + (r.eventType === 'CLOSE' ? 'tag-close' : 'tag-open') + '">' + r.eventType + '</span>' +
        '<span class="rt">' + hms(r.tCorrected) + '</span><span class="rmeta">' + who + (r.confidence ? ' · ' + r.confidence : '') + '</span><span class="ractions"></span>';
      var act = div.querySelector('.ractions');
      var e = el('button', null, 'Edit'); e.onclick = function () { openAttr(r); }; act.appendChild(e);
      var d = el('button', null, 'Del'); d.onclick = function () { delObs(r.id); }; act.appendChild(d);
      box.appendChild(div);
    });
  }
  function renderTally(all) {
    var c = { east_stop: 0, east_fast: 0, west: 0, consec: 0, other: 0 };
    all.forEach(function (r) { var k = categoryOf(r); if (k) c[k]++; });
    var box = $('tally'); box.innerHTML = '';
    Object.keys(CAT_LABELS).forEach(function (k) { box.appendChild(el('div', 'tally-cell', '<div class="tally-n">' + c[k] + '</div><div class="tally-l">' + CAT_LABELS[k] + '</div>')); });
    if (c.other) { var n = el('div', 'info-text', c.other + ' CLOSE event(s) unattributed/other'); n.style.gridColumn = '1 / -1'; box.appendChild(n); }
  }
  function renderExport(all) {
    $('storedCount').textContent = all.length + ' stored';
    var notExp = all.filter(function (r) { return !r.exportedAt; }).length;
    $('exportNote').textContent = notExp ? (notExp + ' not yet exported') : (all.length ? 'all exported' : 'nothing to export yet');
  }
  function delObs(id) { dbDel(id).then(function () { if (lastCaptureId === id) lastCaptureId = null; refreshLocal(); toast('Removed'); }); }
  function undoLast() { if (lastCaptureId == null) { toast('Nothing to undo'); return; } delObs(lastCaptureId); }

  function download(name, mime, text) { var b = new Blob([text], { type: mime }); var u = URL.createObjectURL(b); var a = el('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 1000); }
  function stamp() { var d = new Date(); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()); }
  function exportAs(kind) {
    dbAll().then(function (all) {
      if (!all.length) { toast('Nothing to export'); return; }
      all.sort(function (a, b) { return a.createdAt - b.createdAt; });
      if (kind === 'csv') download('observer-' + CROSSING_ID + '-' + stamp() + '.csv', 'text/csv', toCsv(all));
      else download('observer-' + CROSSING_ID + '-' + stamp() + '.json', 'application/json', JSON.stringify(all, null, 2));
      var now = Date.now(); Promise.all(all.map(function (r) { r.exportedAt = now; return dbPut(r); })).then(refreshLocal);
    });
  }

  // ---- rendering: clock, status, approach strip, elsewhere ----
  function renderClock() { $('clock').textContent = hms(correctedNow()); }
  function renderStatus() {
    var dot = $('netDot'), txt = $('netText');
    var age = lastPollAt ? Math.round((Date.now() - lastPollAt) / 1000) : null;
    if (!lastPollOk && age === null) { dot.className = 'dot dot-warn'; txt.textContent = 'connecting…'; }
    else if (!lastPollOk || (age != null && age > 8)) { dot.className = 'dot dot-bad'; txt.textContent = 'feed offline (capture still works)'; }
    else { dot.className = 'dot dot-ok'; txt.textContent = 'live'; }
    $('offsetText').textContent = 'offset ' + fmtOffset(clockOffsetMs);
    $('pollAge').textContent = age != null ? ('feed ' + age + 's') : 'feed --';
  }

  function chip(t) { return '<div class="chip"><span class="chip-name">' + shortName(t) + '</span><span class="chip-hc">' + dirArrow(t.direction) + ' ' + t.headcode + '</span></div>'; }
  function stageCell(label, trains, passed) {
    var cell = el('div', 'stage' + (passed ? ' passed' : ''));
    var html = '<div class="stage-l">' + label + '</div>';
    html += trains.length ? trains.map(chip).join('') : '<div class="stage-empty">–</div>';
    cell.innerHTML = html; return cell;
  }
  function renderApproach() {
    var box = $('approachView'); box.innerHTML = '';
    var any = false;
    [{ k: 'east', l: 'Eastbound ▶' }, { k: 'west', l: 'Westbound ◀' }].forEach(function (d) {
      var ap = [], cl = [], ps = [];
      liveTrains.forEach(function (t) {
        if (t.direction !== d.k) return;
        var p = proximity(t.berth, d.k); if (!p) return;
        if (p.stage === 'approach') ap.push(t); else if (p.stage === 'close') cl.push(t); else ps.push(t);
      });
      if (ap.length || cl.length || ps.length) any = true;
      var strip = el('div', 'strip', '<div class="strip-dir">' + d.l + '</div>');
      var track = el('div', 'strip-track');
      track.appendChild(stageCell('Approaching', ap));
      track.appendChild(stageCell('Close', cl));
      track.appendChild(el('div', 'xing', 'CROSSING'));
      track.appendChild(stageCell('Just passed', ps, true));
      strip.appendChild(track); box.appendChild(strip);
    });
    if (!any) box.innerHTML = '<div class="empty">No trains on the Portslade approach right now.</div>';
  }
  function renderElsewhere() {
    var rest = partition().rest;
    $('elsewhereCount').textContent = rest.length ? (rest.length + ' in wider area') : '';
    var box = $('liveList');
    if (!rest.length) { box.innerHTML = '<div class="empty">Nothing else in the area.</div>'; return; }
    box.innerHTML = '';
    rest.forEach(function (t) {
      box.appendChild(el('div', 'train',
        '<span class="dir">' + dirArrow(t.direction) + '</span>' +
        '<span class="pick-main"><span class="pick-id">' + identity(t) + '</span>' +
        '<span class="pick-sub">' + dirWord(t.direction) + '</span></span>' +
        '<span class="right"><span class="mono">' + t.headcode + '</span><br>' + (t.berth || '?') + ' · ' + ageStr(t) + '</span>'));
    });
  }

  // ---- init ----
  function init() {
    $('btnClose').onclick = function () { capture('CLOSE'); };
    $('btnOpen').onclick = function () { capture('OPEN'); };
    $('attrSave').onclick = saveAttr;
    $('attrUnknown').onclick = function () { if (pending) { pending.train = null; renderPicker(); } };
    $('undoBtn').onclick = undoLast;
    $('exportCsv').onclick = function () { exportAs('csv'); };
    $('exportJson').onclick = function () { exportAs('json'); };
    var cb = document.querySelectorAll('.conf-btn');
    for (var i = 0; i < cb.length; i++) cb[i].onclick = (function (b) { return function () { if (pending) { pending.confidence = b.dataset.conf; renderConf(); } }; })(cb[i]);

    renderClock(); setInterval(renderClock, 250);
    renderStatus(); setInterval(renderStatus, 1000);
    openDb().then(function () { refreshLocal(); }).catch(function (e) { toast('Storage error: ' + e.message); });
    poll(); setInterval(poll, POLL_MS);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () { });
  }
  document.addEventListener('DOMContentLoaded', init);
})();
