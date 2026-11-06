// The details panel: a bottom sheet on phones, a side panel on desktop (CSS decides which).
// Every string from the API is placed with textContent via dom.h(); there is no innerHTML here.
(function (root) {
  'use strict';

  var RM = root.RM, h = RM.dom.h, clear = RM.dom.clear;
  var geo = RM.geo, classes = RM.classes, D = RM.describe;

  function createPanel(el, handlers) {
    var state = { kind: null, sig: null, atMs: null, ageEl: null, openHelp: {}, lastFocus: null, follow: false };
    var swiped = false;

    // Persistent parts: they keep keyboard focus across the 5-second refreshes.
    var handle = h('button', {
      class: 'sheet-handle', type: 'button', 'aria-expanded': 'false', 'aria-label': 'Show more details',
      onclick: function () {
        if (swiped) { swiped = false; return; }           // the click that follows a swipe is not a tap
        setExpanded(!el.classList.contains('expanded'));
      }
    }, h('span', { class: 'grip', 'aria-hidden': 'true' }));
    var closeBtn = h('button', {
      class: 'icon-btn panel-close', type: 'button', 'aria-label': 'Close details', title: 'Close',
      onclick: function () { handlers.onClose(); }
    }, RM.dom.svgIcon('M6 6l12 12M18 6L6 18'));
    var head = h('div', { class: 'p-head' });
    var followBtn = h('button', {
      class: 'btn', type: 'button', 'aria-pressed': 'false',
      onclick: function () { handlers.onFollow(!state.follow); }
    }, 'Follow this train');
    var shareBtn = h('button', { class: 'btn', type: 'button', onclick: function () { handlers.onShare(); } }, 'Share link');
    var actions = h('div', { class: 'p-actions' }, followBtn, shareBtn);
    var body = h('div', { class: 'p-body' });
    var foot = h('p', { class: 'p-foot' },
      'Map: ', h('a', { href: 'https://openfreemap.org', target: '_blank', rel: 'noopener' }, 'OpenFreeMap'),
      ' © OpenMapTiles, data from OpenStreetMap contributors. Train data: Network Rail (OGL).');
    var scroller = h('div', { class: 'p-scroll' }, head, actions, body, foot);
    el.appendChild(handle); el.appendChild(closeBtn); el.appendChild(scroller);
    el.setAttribute('tabindex', '-1');

    function setExpanded(on) {
      el.classList.toggle('expanded', on);
      handle.setAttribute('aria-expanded', String(on));
      handle.setAttribute('aria-label', on ? 'Show fewer details' : 'Show more details');
    }

    // Pointer drag on the handle: a swipe up opens the sheet fully, a swipe down closes it
    // (a second swipe down, from the peek, dismisses it).
    (function drag() {
      var y0 = null;
      handle.addEventListener('pointerdown', function (e) { y0 = e.clientY; });
      handle.addEventListener('pointerup', function (e) {
        if (y0 == null) return;
        var dy = e.clientY - y0; y0 = null;
        if (Math.abs(dy) < 24) return;                       // a tap: the click handler deals with it
        swiped = true;
        if (dy < 0) setExpanded(true);
        else if (el.classList.contains('expanded')) setExpanded(false);
        else handlers.onClose();
      });
      handle.addEventListener('pointercancel', function () { y0 = null; });
    })();

    function open(kind) {
      var wasHidden = el.hidden;
      if (wasHidden) {
        state.lastFocus = document.activeElement;
        el.hidden = false;
        document.body.classList.add('panel-open');
        setExpanded(false);
      }
      if (state.kind !== kind) state.sig = null;
      state.kind = kind;
      followBtn.hidden = kind !== 'train';
      return wasHidden;
    }

    function helpToggle(key, label, text) {
      var open = !!state.openHelp[key];
      var tip = h('p', { class: 'help-text', id: 'help-' + key, hidden: !open }, text);
      var btn = h('button', {
        class: 'help-btn', type: 'button', 'data-key': 'help-' + key, 'aria-expanded': String(open),
        'aria-controls': 'help-' + key, 'aria-label': label, title: text,
        onclick: function () {
          state.openHelp[key] = !state.openHelp[key];
          btn.setAttribute('aria-expanded', String(state.openHelp[key]));
          tip.hidden = !state.openHelp[key];
        }
      }, '?');
      return { btn: btn, tip: tip };
    }

    function fillWithFocus(fn) {
      var active = document.activeElement, key = active && el.contains(active) ? active.getAttribute('data-key') : null;
      var top = scroller.scrollTop;
      fn();
      scroller.scrollTop = top;
      if (key) { var again = el.querySelector('[data-key="' + key + '"]'); if (again) again.focus(); }
    }

    function dlRow(label, value, extra) {
      return h('div', { class: 'row' },
        h('dt', null, label, extra && extra.btn),
        h('dd', null, value),
        extra && extra.tip);
    }

    // ---- a train ------------------------------------------------------------------------------
    function renderTrain(d) {
      var t = d.train, svc = d.service;
      var cls = classes.classInfo(t.hc);
      var explain = classes.explainHeadcode(t.hc);
      var opName = svc ? classes.operatorLabel(svc.toc) : (t.svc ? classes.operatorLabel(t.svc.toc) : null);
      state.atMs = t.at;

      clear(head);
      var hcHelp = helpToggle('headcode', 'What is a headcode?', classes.HEADCODE_HELP);
      head.appendChild(h('div', { class: 'p-title' },
        h('span', { class: 'swatch', style: 'background:' + cls.colour, 'aria-hidden': 'true' }),
        h('h2', { id: 'panelTitle', tabindex: '-1' }, t.hc),
        hcHelp.btn));
      head.appendChild(h('p', { class: 'p-sub' }, cls.label + (opName ? ' · ' + opName : '')));
      head.appendChild(hcHelp.tip);
      // The two things a passenger wants first: is it on time, and where does it stop next.
      var live = (t.svc || {}), pill = D.latePill(live.late), nextTxt = D.nextLine(live.next);
      if (pill || nextTxt || d.waiting) {
        head.appendChild(h('div', { class: 'p-live' },
          pill && h('span', { class: 'pill ' + pill.kind, 'data-testid': 'late-pill' }, pill.text),
          nextTxt && h('span', { class: 'p-next', 'data-testid': 'next-line' }, nextTxt),
          d.waiting && h('span', { class: 'pill wait', 'data-testid': 'waiting-pill' }, 'Waiting at a signal')));
      }

      clear(body);
      body.appendChild(h('p', { class: 'p-lead' }, explain.text));

      // Route
      if (svc && svc.origin && svc.destination) {
        body.appendChild(h('section', { class: 'card' },
          h('h3', null, 'Journey'),
          h('p', { class: 'route' },
            h('span', null, classes.titleCase(svc.origin.name)), h('span', { class: 'arrow', 'aria-label': 'to' }, ' → '),
            h('span', null, classes.titleCase(svc.destination.name))),
          h('p', { class: 'muted' }, 'Timetable: leaves ' + (svc.origin.time || '?') + ', due ' + (svc.destination.time || '?') +
            '. These are booked times, not live running.')));
      } else {
        body.appendChild(h('section', { class: 'card' },
          h('h3', null, 'Journey'),
          h('p', { class: 'muted' }, 'We could not match this train to a timetable entry, so we do not know where it is going. ' +
            'This is common for engineering trains and short-notice workings.')));
      }

      // Where it is now
      var note = D.estimateNote(t.pl);
      var berthHelp = helpToggle('berth', 'What is a signal section?', classes.BERTH_HELP);
      var speed = geo.fmtMph(d.speedMphEstimate);
      var dir = geo.compass(t.hdg);
      var dl = h('dl', { class: 'facts' },
        dlRow('Signal section', (t.area || '') + ' ' + (t.berth || ''), berthHelp),
        dlRow('Last moved', h('span', { class: 'js-age' }, geo.fmtAgo(Date.now() - t.at))),
        dlRow('Speed', d.speedMphEstimate === 0 ? 'Standing still'
          : speed ? 'About ' + speed + ' (estimated from recent movement)' : 'Not enough movement to estimate'),
        dlRow('Heading', dir ? 'Travelling ' + dir : 'Not known'));
      state.ageEl = dl.querySelector('.js-age');
      body.appendChild(h('section', { class: 'card' },
        h('h3', null, 'Where it is now'),
        h('p', { class: 'place' }, D.describePlace(d.place)),
        note && h('p', { class: 'estimate' }, h('span', { class: 'est-mark', 'aria-hidden': 'true' }, '~ '), note),
        dl));

      if (d.previousHeadcodes && d.previousHeadcodes.length) {
        body.appendChild(h('section', { class: 'card' },
          h('h3', null, 'Earlier codes'),
          h('p', null, 'This train has also been known as ' + d.previousHeadcodes.join(', ') +
            '. A train\'s code can change part-way through its journey.')));
      }

      // Calling points
      if (svc && svc.calls && svc.calls.length) {
        var cur = D.currentCall(svc.calls, d.place);
        var list = h('ol', { class: 'calls' });
        svc.calls.forEach(function (c, i) {
          var st = D.callStatus(c);
          var marker = cur && cur.index === i ? (cur.here ? 'Train is here' : 'Next') : null;
          var sub = [];
          if (st.cancelled) sub.push(h('span', { class: 'cs bad' }, 'Cancelled'));
          else if (st.done) sub.push(h('span', { class: 'cs done' }, st.done));
          else if (st.expected) sub.push(h('span', { class: 'cs ' + (st.expected === 'On time' ? 'ok' : 'late') }, st.expected));
          list.appendChild(h('li', { class: (st.passing ? 'passing ' : '') + (st.cancelled ? 'cancelled ' : '') + (marker ? 'current' : '') },
            h('span', { class: 'ct', title: st.bookedLabel }, st.booked),
            h('span', { class: 'cn' }, h('span', { class: 'cname' }, classes.titleCase(c.name), marker && h('span', { class: 'tag' }, marker)), sub),
            h('span', { class: 'cp' + (st.platformChanged ? ' changed' : '') }, st.platform,
              st.platformChanged && h('span', { class: 'was' }, ' (was ' + st.platformWas + ')'))));
        });
        body.appendChild(h('section', { class: 'card' },
          h('h3', null, 'Calling points'),
          h('p', { class: 'muted' }, 'Booked times on the left. Ticks and expected times show how it is running. Greyed rows are places it passes without stopping.'),
          list));
      }
      if (svc) {
        var bits = [];
        var pw = classes.powerLabel(svc.power);
        if (pw) bits.push(pw.charAt(0).toUpperCase() + pw.slice(1));
        if (svc.speedMph) bits.push('top speed ' + svc.speedMph + ' mph');
        if (bits.length) body.appendChild(h('p', { class: 'muted small' }, bits.join(' · ')));
      }
    }

    // ---- a station ----------------------------------------------------------------------------
    // Header, then a live board with Departures / Arrivals / Passing / Recent tabs. A row that has a
    // train on the map is a button: tapping it selects that train.
    function renderStation(s, nearby, board) {
      clear(head); clear(body);
      state.ageEl = null; state.atMs = null;
      head.appendChild(h('div', { class: 'p-title' },
        h('span', { class: 'swatch station', 'aria-hidden': 'true' }),
        h('h2', { id: 'panelTitle', tabindex: '-1' }, classes.titleCase(s.name))));
      head.appendChild(h('p', { class: 'p-sub' }, 'Railway station · code ' + s.crs + ' · ' +
        (nearby === 0 ? 'no trains within 5 km' : nearby === 1 ? '1 train within 5 km' : nearby + ' trains within 5 km')));
      var tab = state.stTab || 'dep';
      var tabs = [['dep', 'Departures'], ['arr', 'Arrivals'], ['pass', 'Passing'], ['recent', 'Recent']];
      var bar = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Station board' });
      tabs.forEach(function (tb) {
        var on = tb[0] === tab;
        bar.appendChild(h('button', {
          class: 'seg-btn', type: 'button', role: 'tab', id: 'tab-' + tb[0], 'aria-selected': String(on), 'aria-controls': 'board-panel',
          tabindex: on ? '0' : '-1', 'data-key': 'tab-' + tb[0],
          onclick: function () { state.stTab = tb[0]; state.sig = null; if (state.lastStation) renderStation.apply(null, state.lastStation); },
          onkeydown: function (e) {
            var i = tabs.findIndex(function (x) { return x[0] === tab; }), j = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : -1;
            if (j < 0 || j >= tabs.length) return;
            e.preventDefault(); state.stTab = tabs[j][0]; state.sig = null;
            if (state.lastStation) { renderStation.apply(null, state.lastStation); var nb = el.querySelector('#tab-' + tabs[j][0]); if (nb) nb.focus(); }
          }
        }, tb[1]));
      });
      var list = h('div', { class: 'board', role: 'tabpanel', id: 'board-panel', 'aria-labelledby': 'tab-' + tab });
      if (!board) {
        list.appendChild(h('p', { class: 'muted pad' }, state.boardFailed ? 'The live board is not available right now.' : 'Loading the live board'));
      } else if (tab === 'recent') {
        var rec = (board.recent || []).map(D.recentRow);
        if (!rec.length) list.appendChild(h('p', { class: 'muted pad' }, 'Nothing has been through in the last half hour.'));
        else {
          var ul = h('ul', { class: 'recent' });
          rec.forEach(function (r) { ul.appendChild(h('li', null, h('strong', null, r.hc), h('span', null, r.text), r.late && h('span', { class: 'muted' }, r.late))); });
          list.appendChild(ul);
        }
      } else {
        var rows = D.boardRows(board.board, tab);
        if (!rows.length) list.appendChild(h('p', { class: 'muted pad' }, 'No ' + D.KIND_LABEL[tab].toLowerCase() + ' in the next two hours.'));
        rows.forEach(function (r) {
          var inner = [
            h('span', { class: 'bt' }, r.time || ''),
            h('span', { class: 'bm' },
              h('span', { class: 'bplace' }, r.place, r.plain && h('span', { class: 'btag ' + r.cls.key }, r.plain)),
              h('span', { class: 'bsub' }, r.hc + (r.toc ? ' · ' + classes.operatorLabel(r.toc) : '') + ' · ' + r.status)),
            h('span', { class: 'bp' }, r.platform ? 'Pl ' + r.platform : '')
          ];
          var cls = 'brow tone-' + r.tone;
          if (r.trainId) {
            list.appendChild(h('button', { class: cls, type: 'button', 'data-train': r.trainId,
              'aria-label': r.time + ' ' + r.place + ', ' + r.status + '. Show this train on the map.',
              onclick: function () { if (handlers.onPickTrain) handlers.onPickTrain(r.trainId); } }, inner));
          } else {
            list.appendChild(h('div', { class: cls + ' static', title: 'Not on the map yet' }, inner));
          }
        });
      }
      body.appendChild(bar); body.appendChild(list);
      if (board) body.appendChild(h('p', { class: 'muted small' }, 'Times are booked unless marked. Freight and empty trains are included.'));
    }

    function afterRender(wasHidden) {
      if (wasHidden) {
        var title = el.querySelector('#panelTitle');
        if (title) title.focus({ preventScroll: true });
      }
    }

    return {
      get el() { return el; },
      get kind() { return state.kind; },
      get isOpen() { return !el.hidden; },
      showLoading: function (label) {
        var wasHidden = open('train');
        clear(head); clear(body);
        head.appendChild(h('div', { class: 'p-title' }, h('h2', { id: 'panelTitle', tabindex: '-1' }, label || 'Train')));
        body.appendChild(h('p', { class: 'muted' }, 'Loading details'));
        state.sig = 'loading'; state.ageEl = null;
        afterRender(wasHidden);
      },
      showTrain: function (d) {
        var t = d.train;
        var sv = t.svc || {}, calls = d.service && d.service.calls || [];
        var sig = [t.id, t.hc, t.at, t.pl, d.speedMphEstimate, d.place && d.place.kind, calls.length,
          (d.previousHeadcodes || []).join(','), sv.late, sv.next && (sv.next.name + sv.next.time + sv.next.exp), !!d.waiting,
          calls.map(function (c) { return [c.actualArr, c.actualDep, c.actualPass, c.expArr, c.expDep, c.platformActual, c.cancelled].join(','); }).join(';')].join('|');
        var wasHidden = open('train');
        if (sig === state.sig) return;
        state.sig = sig;
        fillWithFocus(function () { renderTrain(d); });
        afterRender(wasHidden);
      },
      showStation: function (s, nearby, board, failed) {
        var wasHidden = open('station');
        var sig = [s.crs, nearby, state.stTab, failed ? 'f' : '', board ? JSON.stringify(board.board).length + ':' + (board.board[0] && board.board[0].booked) + ':' + (board.recent || []).length +
          ':' + board.board.map(function (r) { return r.actual || r.expected || ''; }).join('') : ''].join('|');
        if (sig === state.sig) return;
        if (state.lastStation && state.lastStation[0].crs !== s.crs) state.stTab = 'dep';
        state.sig = sig; state.boardFailed = !!failed;
        state.lastStation = [s, nearby, board];
        fillWithFocus(function () { renderStation(s, nearby, board); });
        afterRender(wasHidden);
      },
      showMessage: function (title, text) {
        var wasHidden = open('message');
        state.sig = null; state.ageEl = null;
        clear(head); clear(body);
        head.appendChild(h('div', { class: 'p-title' }, h('h2', { id: 'panelTitle', tabindex: '-1' }, title)));
        body.appendChild(h('p', null, text));
        afterRender(wasHidden);
      },
      hide: function () {
        if (el.hidden) return;
        el.hidden = true;
        document.body.classList.remove('panel-open');
        state.kind = null; state.sig = null; state.ageEl = null; state.lastStation = null;
        var f = state.lastFocus; state.lastFocus = null;
        if (f && f.focus && document.contains(f)) f.focus({ preventScroll: true });
      },
      setFollow: function (on) {
        state.follow = !!on;
        followBtn.setAttribute('aria-pressed', String(!!on));
        followBtn.classList.toggle('on', !!on);
        followBtn.textContent = on ? 'Following (tap to stop)' : 'Follow this train';
      },
      // Called once a second with the server's idea of "now".
      tick: function (serverNowMs) {
        if (state.ageEl && state.atMs != null) state.ageEl.textContent = geo.fmtAgo(serverNowMs - state.atMs);
      }
    };
  }

  (root.RM = root.RM || {}).panel = { createPanel: createPanel };
})(typeof self !== 'undefined' ? self : this);
