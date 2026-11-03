// Tiny DOM builder. Everything that comes from the API goes into the page through here, as
// text nodes (textContent), never as markup — so there is nothing to escape and nothing to forget.
// There is no innerHTML anywhere in the page's own code.
(function (root) {
  'use strict';

  // h('div', {class: 'x', 'aria-label': 'y', onclick: fn}, 'text', childNode, [more], null)
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'text') el.textContent = v;
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(el, x); }); return; }
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  var SVG_NS = 'http://www.w3.org/2000/svg';
  // Static icon paths only (never API data): svg('M6 6l12 12', {stroke: true})
  function svgIcon(d, opts) {
    var s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    if (opts && opts.fill) p.setAttribute('fill', 'currentColor');
    else {
      p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '2.2'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
    }
    s.appendChild(p);
    return s;
  }

  var api = { h: h, clear: clear, svgIcon: svgIcon };
  (root.RM = root.RM || {}).dom = api;
})(typeof self !== 'undefined' ? self : this);
