// Search box: headcodes and stations, with a keyboard-operable results list (ARIA combobox).
// Local matches appear instantly from what the page already holds; the service's own search is
// merged in a moment later, because it can see trains the current map view does not.
(function (root) {
  'use strict';

  var RM = root.RM, h = RM.dom.h, clear = RM.dom.clear, classes = RM.classes, S = RM.stations;

  function createSearch(o) {
    var input = o.input, list = o.list;
    var items = [], active = -1, token = 0, timer = null, abort = null, remoteDone = true, query = '';
    var Abort = root.AbortController;

    function close() {
      list.hidden = true; items = []; active = -1;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }
    function setActive(i) {
      active = i;
      var opts = list.querySelectorAll('[role="option"]');
      Array.prototype.forEach.call(opts, function (n, k) { n.setAttribute('aria-selected', String(k === i)); });
      if (i >= 0 && opts[i]) {
        input.setAttribute('aria-activedescendant', opts[i].id);
        if (opts[i].scrollIntoView) opts[i].scrollIntoView({ block: 'nearest' });
      } else input.removeAttribute('aria-activedescendant');
    }
    function pick(i) {
      var it = items[i];
      if (!it) return;
      close();
      input.value = '';
      input.blur();
      if (it.type === 'train') o.onPickTrain(it);
      else o.onPickStation(it);
    }

    function render(final) {
      clear(list);
      var n = 0;
      function group(title, rows) {
        if (!rows.length) return;
        list.appendChild(h('li', { role: 'presentation', class: 'grp' }, title));
        rows.forEach(function (it) {
          var idx = n++;
          var li = h('li', {
            role: 'option', id: 'opt-' + idx, 'aria-selected': 'false', class: 'opt',
            onpointerdown: function (e) { e.preventDefault(); },       // keep focus in the input
            onclick: function () { pick(idx); },
            onpointermove: function () { if (active !== idx) setActive(idx); }
          }, it.type === 'train'
            ? [h('span', { class: 'swatch', style: 'background:' + classes.classInfo(it.hc).colour, 'aria-hidden': 'true' }),
               h('span', { class: 'o-main' }, it.hc),
               h('span', { class: 'o-sub' }, it.route || 'Train')]
            : [h('span', { class: 'swatch station', 'aria-hidden': 'true' }),
               h('span', { class: 'o-main' }, classes.titleCase(it.name)),
               h('span', { class: 'o-sub crs' }, it.crs)]);
          list.appendChild(li);
        });
      }
      var trains = items.filter(function (i) { return i.type === 'train'; });
      var stations = items.filter(function (i) { return i.type === 'station'; });
      items = trains.concat(stations);
      group('Trains', trains);
      group('Stations', stations);
      if (!items.length) {
        list.appendChild(h('li', { role: 'presentation', class: 'none' },
          final ? 'No train or station matches “' + query + '”.' : 'Searching…'));
      }
      list.hidden = false;
      input.setAttribute('aria-expanded', String(items.length > 0));
      active = -1;
      setActive(items.length ? 0 : -1);
    }

    function localItems(q) {
      var trains = S.searchTrains(o.getTrains(), q, 8).map(function (t) {
        var s = t.svc;
        return { type: 'train', id: t.id, hc: t.hc, route: s ? classes.titleCase(s.o) + ' to ' + classes.titleCase(s.d) : 'Unknown route' };
      });
      var stations = S.searchStations(o.getStations(), q, 6).map(function (s) {
        return { type: 'station', crs: s.crs, name: s.name, lat: s.lat, lon: s.lon };
      });
      return trains.concat(stations);
    }

    function merge(local, remote) {
      var seenT = {}, seenS = {};
      var out = [];
      local.concat(remote).forEach(function (it) {
        if (it.type === 'train') { if (seenT[it.id]) return; seenT[it.id] = 1; }
        else { if (seenS[it.crs]) return; seenS[it.crs] = 1; }
        out.push(it);
      });
      return out;
    }

    function run() {
      query = input.value.trim();
      if (!query) { close(); return; }
      var mine = ++token;
      var local = localItems(query);
      items = local;
      remoteDone = false;
      render(false);
      if (timer) clearTimeout(timer);
      if (abort) { try { abort.abort(); } catch (e) { /* ignore */ } }
      abort = Abort ? new Abort() : null;
      timer = setTimeout(function () {
        o.remote(query, abort && abort.signal).then(function (r) {
          if (mine !== token) return;
          var rt = (r.trains || []).map(function (t) {
            return { type: 'train', id: t.id, hc: t.hc, route: t.o && t.d ? classes.titleCase(t.o) + ' to ' + classes.titleCase(t.d) : 'Train' };
          });
          var rs = (r.stations || []).map(function (s) { return { type: 'station', crs: s.crs, name: s.name, lat: s.lat, lon: s.lon }; });
          items = merge(local, rt.concat(rs));
          remoteDone = true;
          render(true);
        }, function () {
          if (mine !== token) return;
          remoteDone = true;
          render(true);                       // keep what we have; local results still stand
        });
      }, 220);
    }

    input.addEventListener('input', run);
    input.addEventListener('focus', function () { if (input.value.trim()) run(); });
    input.addEventListener('blur', function () { setTimeout(close, 120); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (list.hidden) { if (input.value.trim()) run(); return; }
        if (items.length) setActive((active + 1) % items.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (items.length) setActive((active - 1 + items.length) % items.length);
      } else if (e.key === 'Home' && !list.hidden && items.length && e.ctrlKey) { setActive(0); }
      else if (e.key === 'Enter') {
        if (!list.hidden && items.length) { e.preventDefault(); pick(active < 0 ? 0 : active); }
      } else if (e.key === 'Escape') {
        if (!list.hidden) { e.preventDefault(); close(); }
        else if (input.value) { input.value = ''; }
        else input.blur();
      }
    });
    void remoteDone;
    return { close: close, focus: function () { input.focus(); input.select(); } };
  }

  (root.RM = root.RM || {}).search = { createSearch: createSearch };
})(typeof self !== 'undefined' ? self : this);
