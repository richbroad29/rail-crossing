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
          var tm = D.callTime(c);
          var marker = cur && cur.index === i ? (cur.here ? 'Train is here' : 'Next') : null;
          list.appendChild(h('li', { class: (tm.passing ? 'passing ' : '') + (marker ? 'current' : '') },
            h('span', { class: 'ct', title: tm.label }, tm.text),
            h('span', { class: 'cn' }, classes.titleCase(c.name),
              marker && h('span', { class: 'tag' }, marker)),
            h('span', { class: 'cp' }, c.platform ? 'Platform ' + c.platform : (tm.passing ? 'Passes' : ''))));
        });
        body.appendChild(h('section', { class: 'card' },
          h('h3', null, 'Calling points'),
          h('p', { class: 'muted' }, 'Where the train is booked to stop. Greyed rows are places it passes without stopping.'),
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
    function renderStation(s, nearby) {
      clear(head); clear(body);
      state.ageEl = null; state.atMs = null;
      head.appendChild(h('div', { class: 'p-title' },
        h('span', { class: 'swatch station', 'aria-hidden': 'true' }),
        h('h2', { id: 'panelTitle', tabindex: '-1' }, classes.titleCase(s.name))));
      head.appendChild(h('p', { class: 'p-sub' }, 'Railway station · code ' + s.crs));
      body.appendChild(h('section', { class: 'card' },
        h('h3', null, 'Trains nearby'),
        h('p', null, nearby === 0 ? 'No trains within 5 km right now.'
          : nearby === 1 ? '1 train within 5 km right now.' : nearby + ' trains within 5 km right now.')));
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
        var sig = [t.id, t.hc, t.at, t.pl, d.speedMphEstimate, d.place && d.place.kind, (d.service && d.service.calls || []).length,
          (d.previousHeadcodes || []).join(',')].join('|');
        var wasHidden = open('train');
        if (sig === state.sig) return;
        state.sig = sig;
        fillWithFocus(function () { renderTrain(d); });
        afterRender(wasHidden);
      },
      showStation: function (s, nearby) {
        var wasHidden = open('station');
        var sig = s.crs + '|' + nearby;
        if (sig === state.sig) return;
        state.sig = sig;
        fillWithFocus(function () { renderStation(s, nearby); });
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
        state.kind = null; state.sig = null; state.ageEl = null;
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
