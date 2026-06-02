'use strict';
/*
 * Crossing Observer — v1 field data-collection tool (Boundary Road, Portslade).
 *
 * Captures the human-observed CLOSE (red lights start) and OPEN (booms fully up)
 * instants at ms precision, attributes each to a single train from the live B1
 * feed, and stores everything locally (IndexedDB) for CSV/JSON export. Read-only
 * on the backend; offline-first (a tap stores the timestamp immediately).
 *
 * v1.2 — approach STRIP-MAP. The berth chain + per-berth gaps below were derived
 * purely from TD timestamps (from→to step sequence + median dwell per berth), so
 * the diagram is spaced by typical JOURNEY TIME (not geographic distance — that
 * needs speed we don't have). Summing the gaps to the crossing gives an estimated
 * time-to-crossing. The chain is seeded from one day's log; re-derive over more
 * days (ideally server-side) to refine the gaps — order is stable topology.
 */

(function () {
  var API_BASE = 'https://railcrossing.duckdns.org';
  var CROSSING_ID = 'portslade';
  var POLL_MS = 2500;

  // Derived berth chain toward/through the crossing. gap = median seconds a train
  // dwells in that berth (≈ time to the next berth). role marks the confirmed
  // Portslade berths; {x:true} is the crossing itself (after protecting).
  var CHAIN = {
    east: [
      { b: '0016', gap: 132 }, { b: '0014', gap: 74 }, { b: '0012', gap: 37 },
      { b: '0010', gap: 143 }, { b: '0008', gap: 75 }, { b: '0006', gap: 142, role: 'approach' },
      { b: '0004', gap: 79, role: 'protecting' }, { x: true },
      { b: '0002', gap: 115, role: 'clear' }, { b: 'T686', gap: 53 }, { b: 'T684' }
    ],
    west: [
      { b: 'T682', gap: 90 }, { b: 'T677', gap: 126 }, { b: '0001', gap: 45 },
      { b: '0003', gap: 36, role: 'approach' }, { b: '0005', gap: 115, role: 'protecting' }, { x: true },
      { b: '0007', gap: 43, role: 'clear' }, { b: '0009', gap: 70 }, { b: '0011', gap: 140 },
      { b: '0013', gap: 144 }, { b: '0015', gap: 84 }, { b: '0017', gap: 47 }
    ]
  };
  // Precompute, per direction: berth → node index, and the crossing index.
  var CHAININ = {};
  Object.keys(CHAIN).forEach(function (d) {
    var idx = {}, xi = -1;
    CHAIN[d].forEach(function (n, i) { if (n.x) xi = i; else idx[n.b] = i; });
    CHAININ[d] = { idx: idx, xi: xi };
  });

  // Off-chain berths that nonetheless lead to the crossing, with the median
  // observed seconds-to-crossing (derived from TD timestamps). Used only to order
  // "Other trains in the area" by proximity — trains far out on the Portslade line
  // (beyond the drawn chain) sort by this; trains on unrelated LA lines have no
  // entry and fall back to recency. Seeded from one day; refine via derive-chain.
  var BERTH_ETA = {
    east: { '0020': 751, '0024': 860, '0203': 870, '0202': 903, '0026': 905, '0028': 995, '0040': 999, '0032': 1054, '0030': 1055, '0042': 1065, '0034': 1093, '0022': 1129, '0036': 1140, 'A030': 1146, '0038': 1157 },
    west: {}
  };
  function offChainEta(d, berth) { var m = BERTH_ETA[d]; var v = m && m[berth]; return typeof v === 'number' ? v : null; }

  // ---- pure helpers ----
  function trainKind(hc) { if (!hc) return 'passenger'; var c = hc.charAt(0); if (c === '6' || c === '7') return 'freight'; if (c === '5') return 'ecs'; if (c === '3') return 'test'; return 'passenger'; }
  function dirWord(d) { return d === 'east' ? 'Eastbound' : d === 'west' ? 'Westbound' : 'Direction unknown'; }
  function dirArrow(d) { return d === 'east' ? '▶' : d === 'west' ? '◀' : '·'; }

  // Sum of gaps from node index i up to (and including) the protecting berth —
  // the estimated seconds from entering berth i to reaching the crossing.
  function etaToCrossing(d, i) {
    var c = CHAININ[d]; if (i < 0 || i >= c.xi) return 0;
    var s = 0; for (var j = i; j < c.xi; j++) { var n = CHAIN[d][j]; s += (n.gap || 60); } return s;
  }
  // Position of a train on its chain: stage + plain label + etaSecs + rank.
  // null if the berth isn't on the Portslade chain (→ "elsewhere in area").
  function proximity(berth, direction) {
    var c = CHAININ[direction]; if (!c) return null;
    var i = c.idx[berth]; if (i === undefined) return null;
    if (i > c.xi) return { stage: 'passed', label: 'Just passed', etaSecs: null, rank: 9999, index: i };
    var eta = etaToCrossing(direction, i);
    var label = eta <= 25 ? 'At the crossing' : eta <= 90 ? 'Close (~' + fmtEta(eta) + ')' : 'Approaching (~' + fmtEta(eta) + ')';
    return { stage: 'approach', label: label, etaSecs: eta, rank: eta, index: i };
  }
  function isApproaching(t) { return proximity(t.berth, t.direction) !== null; }
  function fmtEta(s) { if (s == null) return ''; if (s < 60) return s + 's'; var m = Math.floor(s / 60), r = s % 60; return r ? (m + 'm' + r + 's') : (m + 'm'); }

  function identity(t) {
    var kind = trainKind(t.headcode), hasOD = t.origin || t.destination;
    var od = (t.origin || '?') + ' → ' + (t.destination || '?');
    if (kind === 'freight') return hasOD ? ('Freight · ' + od) : 'Freight (not in timetable)';
    if (kind === 'ecs') return hasOD ? ('Empty stock · ' + od) : 'Empty stock';
    return hasOD ? od : 'Train (not in timetable)';
  }
  function shortName(t) { return t.destination ? t.destination.split(/[ (,]/)[0] : t.headcode; }

  function suggestForClose(trains) {
    var cand = trains.filter(function (t) { var p = proximity(t.berth, t.direction); return p && p.stage === 'approach'; });
    if (!cand.length) return null;
    cand.sort(function (a, b) { return proximity(a.berth, a.direction).rank - proximity(b.berth, b.direction).rank; });
    return cand[0];
  }
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
  function fmtOffset(ms) { var s = ms >= 0 ? '+' : '-', a = Math.abs(ms); return a < 1000 ? (s + a + 'ms') : (s + (a / 1000).toFixed(1) + 's'); }
  function ageStr(t) { return (t.ageSecs != null ? t.ageSecs + 's ago' : ''); }

  function csvCell(v) { if (v === null || v === undefined) return ''; var s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function toCsv(records) {
    var cols = ['id', 'eventType', 'tCapturedDevice', 'tCorrected', 'tCorrectedISO', 'crossingId',
      'headcode', 'direction', 'stopping', 'suggestedHeadcode', 'suggestionAccepted', 'confidence', 'episodeTrains', 'note', 'offsetMs', 'createdAt'];
    var lines = [cols.join(',')];
    records.forEach(function (r) {
      lines.push([r.id, r.eventType, r.tCapturedDevice, r.tCorrected, new Date(r.tCorrected).toISOString(), r.crossingId,
        r.train ? r.train.headcode : '', r.train ? r.train.direction : '', r.train ? r.train.stopping : '',
        r.suggestedHeadcode || '', r.suggestionAccepted ? 'yes' : 'no', r.confidence || '',
        (r.episodeTrains || []).join(' '), r.note || '', r.offsetMs, r.createdAt].map(csvCell).join(','));
    });
    return lines.join('\n');
  }

  // ---- IndexedDB ----
  var DB_NAME = 'crossing-observer', STORE = 'observations', db = null;
  function openDb() { return new Promise(function (res, rej) { var q = indexedDB.open(DB_NAME, 1); q.onupgradeneeded = function (e) { var d = e.target.result; if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true }); }; q.onsuccess = function (e) { db = e.target.result; res(db); }; q.onerror = function () { rej(q.error); }; }); }
  function tx(m) { return db.transaction(STORE, m).objectStore(STORE); }
  function dbAdd(r) { return new Promise(function (s, j) { var q = tx('readwrite').add(r); q.onsuccess = function () { s(q.result); }; q.onerror = function () { j(q.error); }; }); }
  function dbPut(r) { return new Promise(function (s, j) { var q = tx('readwrite').put(r); q.onsuccess = function () { s(q.result); }; q.onerror = function () { j(q.error); }; }); }
  function dbDel(i) { return new Promise(function (s, j) { var q = tx('readwrite').delete(i); q.onsuccess = function () { s(); }; q.onerror = function () { j(q.error); }; }); }
  function dbAll() { return new Promise(function (s, j) { var q = tx('readonly').getAll(); q.onsuccess = function () { s(q.result || []); }; q.onerror = function () { j(q.error); }; }); }

  // ---- runtime state ----
  var liveTrains = [];
  var clockOffsetMs = 0, lastRtt = 0, lastPollAt = 0, lastPollOk = false;
  var episodeSet = {}, lastCaptureId = null, pending = null, showElsewhere = false;

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function toast(msg) { var e = $('toast'); e.textContent = msg; e.classList.remove('hidden'); clearTimeout(toast._t); toast._t = setTimeout(function () { e.classList.add('hidden'); }, 1800); }
  function correctedNow() { return Date.now() + clockOffsetMs; }
  function partition() { var a = [], r = []; liveTrains.forEach(function (t) { (isApproaching(t) ? a : r).push(t); }); return { appr: a, rest: r }; }
  // Order off-chain trains by proximity: those with a derived time-to-crossing
  // first (nearest → furthest), then trains with no path to Portslade by recency.
  function byProximity(list) {
    return list.slice().sort(function (a, b) {
      var ea = offChainEta(a.direction, a.berth), eb = offChainEta(b.direction, b.berth);
      if (ea != null && eb != null) return ea - eb;
      if (ea != null) return -1;
      if (eb != null) return 1;
      var aa = a.ageSecs == null ? 1e9 : a.ageSecs, ba = b.ageSecs == null ? 1e9 : b.ageSecs;
      return aa - ba;
    });
  }

  // ---- live feed poll (B1) ----
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
        renderStrip(); renderElsewhere(); renderStatus(); if (pending) renderPicker();
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
    pending = { id: rec.id, eventType: rec.eventType, train: rec.train ? Object.assign({}, rec.train) : null, confidence: rec.confidence, note: rec.note || '', suggestedHeadcode: rec.suggestedHeadcode };
    $('attrTitle').textContent = 'Which train caused this ' + rec.eventType + '?';
    $('attrTime').textContent = hms(rec.tCorrected);
    var sug = rec.suggestedHeadcode ? liveTrains.filter(function (t) { return t.headcode === rec.suggestedHeadcode; })[0] : null;
    if (sug) { var p = proximity(sug.berth, sug.direction); $('attrSuggest').innerHTML = 'Suggested: <b>' + identity(sug) + '</b><br>' + dirWord(sug.direction) + (p ? ' · ' + p.label : '') + ' · <span class="mono">' + sug.headcode + '</span>'; }
    else $('attrSuggest').innerHTML = 'No clear approaching train — pick from the list, or mark Unknown.';
    $('attrNote').value = pending.note;
    renderConf(); renderPicker(); $('attrPanel').classList.remove('hidden'); $('attrPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function renderConf() { var b = document.querySelectorAll('.conf-btn'); for (var i = 0; i < b.length; i++) b[i].classList.toggle('sel', b[i].dataset.conf === pending.confidence); }
  function pickRow(t) {
    var sel = pending.train && pending.train.headcode === t.headcode, p = proximity(t.berth, t.direction);
    var row = el('div', 'pick' + (sel ? ' sel' : '') + (t.headcode === pending.suggestedHeadcode ? ' suggested' : ''));
    row.innerHTML = '<span class="dir">' + dirArrow(t.direction) + '</span><span class="pick-main"><span class="pick-id">' + identity(t) + '</span><span class="pick-sub">' + dirWord(t.direction) + (p ? ' · ' + p.label : '') + '</span></span><span class="meta"><span class="mono">' + t.headcode + '</span><br>' + (t.berth || '?') + ' · ' + ageStr(t) + '</span>';
    row.onclick = function () { pending.train = { headcode: t.headcode, direction: t.direction, stopping: t.stopping }; renderPicker(); };
    return row;
  }
  function renderPicker() {
    var box = $('attrPicker'); box.innerHTML = ''; var parts = partition();
    if (!liveTrains.length) { box.innerHTML = '<div class="empty">No trains in feed — mark Unknown or add a note.</div>'; return; }
    parts.appr.sort(function (a, b) {
      if (a.headcode === pending.suggestedHeadcode) return -1; if (b.headcode === pending.suggestedHeadcode) return 1;
      return proximity(a.berth, a.direction).rank - proximity(b.berth, b.direction).rank;
    });
    if (parts.appr.length) { box.appendChild(el('div', 'pick-group', 'On the Portslade approach')); parts.appr.forEach(function (t) { box.appendChild(pickRow(t)); }); }
    if (parts.rest.length) {
      var tog = el('div', 'pick-toggle', (showElsewhere ? '▾ ' : '▸ ') + 'Elsewhere in area (' + parts.rest.length + ')');
      tog.onclick = function () { showElsewhere = !showElsewhere; renderPicker(); }; box.appendChild(tog);
      if (showElsewhere) byProximity(parts.rest).forEach(function (t) { box.appendChild(pickRow(t)); });
    }
  }
  function saveAttr() {
    if (!pending) return; var id = pending.id;
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
    var box = $('recentList'), recent = all.slice(0, 6);
    if (!recent.length) { box.innerHTML = '<div class="empty">No captures yet.</div>'; return; }
    box.innerHTML = '';
    recent.forEach(function (r) {
      var who = r.train ? (r.train.headcode + ' ' + dirArrow(r.train.direction)) : (r.note ? 'note' : 'unknown');
      var div = el('div', 'rec', '<span class="tag ' + (r.eventType === 'CLOSE' ? 'tag-close' : 'tag-open') + '">' + r.eventType + '</span><span class="rt">' + hms(r.tCorrected) + '</span><span class="rmeta">' + who + (r.confidence ? ' · ' + r.confidence : '') + '</span><span class="ractions"></span>');
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
  function renderExport(all) { $('storedCount').textContent = all.length + ' stored'; var ne = all.filter(function (r) { return !r.exportedAt; }).length; $('exportNote').textContent = ne ? (ne + ' not yet exported') : (all.length ? 'all exported' : 'nothing to export yet'); }
  function delObs(id) { dbDel(id).then(function () { if (lastCaptureId === id) lastCaptureId = null; refreshLocal(); toast('Removed'); }); }
  function undoLast() { if (lastCaptureId == null) { toast('Nothing to undo'); return; } delObs(lastCaptureId); }
  function download(name, mime, text) { var b = new Blob([text], { type: mime }), u = URL.createObjectURL(b), a = el('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 1000); }
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

  // ---- rendering: clock, status, strip-map, elsewhere ----
  function renderClock() { $('clock').textContent = hms(correctedNow()); }
  function renderStatus() {
    var dot = $('netDot'), txt = $('netText'), age = lastPollAt ? Math.round((Date.now() - lastPollAt) / 1000) : null;
    if (!lastPollOk && age === null) { dot.className = 'dot dot-warn'; txt.textContent = 'connecting…'; }
    else if (!lastPollOk || (age != null && age > 8)) { dot.className = 'dot dot-bad'; txt.textContent = 'feed offline (capture still works)'; }
    else { dot.className = 'dot dot-ok'; txt.textContent = 'live'; }
    $('offsetText').textContent = 'offset ' + fmtOffset(clockOffsetMs);
    $('pollAge').textContent = age != null ? ('feed ' + age + 's') : 'feed --';
  }
  function gapPx(g) { return Math.max(12, Math.min(60, Math.round((g || 60) * 0.4))); }
  function splitChain(d) { var pre = [], post = [], x = false; CHAIN[d].forEach(function (n) { if (n.x) { x = true; return; } (x ? post : pre).push(n); }); return { pre: pre, post: post }; }
  function trainsAt(d, b) { return liveTrains.filter(function (t) { return t.direction === d && t.berth === b; }); }
  function nodeEl(d, n) {
    var pills = trainsAt(d, n.b).map(function (t) { return '<span class="tpill">' + dirArrow(d) + ' ' + shortName(t) + '</span>'; }).join('');
    return el('div', 'bnode' + (n.role ? ' role-' + n.role : ''),
      '<span class="bdot"></span><span class="blabel">' + n.b + (n.role ? ' · ' + n.role : '') + '</span><span class="bpills">' + pills + '</span>');
  }
  // flow 'down' = train travels top→bottom (dwell in the upper node spaces to the
  // next); 'up' = travels bottom→top (dwell in the lower node spaces to the next).
  function colBand(d, nodes, flow) {
    var col = el('div', 'xcol');
    nodes.forEach(function (n, i) {
      col.appendChild(nodeEl(d, n));
      if (i < nodes.length - 1) { var g = flow === 'down' ? n.gap : nodes[i + 1].gap; var sp = el('div', 'bgap'); sp.style.height = gapPx(g) + 'px'; col.appendChild(sp); }
    });
    return col;
  }
  // Both directions share one horizontal BOUNDARY ROAD bar. Eastbound runs
  // DOWN (approach above the bar, cleared below); westbound runs UP (approach
  // below, cleared above) — so the two flows are mirror images meeting at the bar.
  function renderStrip() {
    var box = $('approachView'); box.innerHTML = '';
    var e = splitChain('east'), w = splitChain('west');
    var head = el('div', 'xhead');
    head.appendChild(el('div', 'xhcell', 'Eastbound ▼'));
    head.appendChild(el('div', 'xhcell', 'Westbound ▲'));
    box.appendChild(head);
    var top = el('div', 'xband xtop');
    top.appendChild(colBand('east', e.pre, 'down'));               // east approach (above, descending)
    top.appendChild(colBand('west', w.post.slice().reverse(), 'up')); // west cleared (above)
    box.appendChild(top);
    box.appendChild(el('div', 'xbar', '║  BOUNDARY ROAD CROSSING  ║'));
    var bot = el('div', 'xband xbot');
    bot.appendChild(colBand('east', e.post, 'down'));              // east cleared (below)
    bot.appendChild(colBand('west', w.pre.slice().reverse(), 'up'));  // west approach (below, ascending)
    box.appendChild(bot);
    if (!liveTrains.some(isApproaching)) box.appendChild(el('div', 'info-text', 'No trains on the Portslade chain right now — they appear on a berth as they enter area LA.'));
  }
  function renderElsewhere() {
    var rest = byProximity(partition().rest);
    $('elsewhereCount').textContent = rest.length ? (rest.length + ' in wider area') : '';
    var box = $('liveList');
    if (!rest.length) { box.innerHTML = '<div class="empty">Nothing else in the area.</div>'; return; }
    box.innerHTML = '';
    rest.forEach(function (t) {
      var eta = offChainEta(t.direction, t.berth);
      var sub = dirWord(t.direction) + (eta != null ? ' · ~' + fmtEta(eta) + ' to crossing (est)' : '');
      box.appendChild(el('div', 'train', '<span class="dir">' + dirArrow(t.direction) + '</span><span class="pick-main"><span class="pick-id">' + identity(t) + '</span><span class="pick-sub">' + sub + '</span></span><span class="right"><span class="mono">' + t.headcode + '</span><br>' + (t.berth || '?') + ' · ' + ageStr(t) + '</span>'));
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
