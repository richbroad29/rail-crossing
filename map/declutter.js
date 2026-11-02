// Label decluttering: keep the most important labels, drop any that would overlap one already kept.
// Pure and allocation-light (a small spatial hash), so it can run every frame for a few hundred
// train labels. Boxes are in screen pixels: { x, y, w, h, prio, ref } with (x, y) the top-left.
//
// This replaces deck.gl's CollisionFilterExtension, which on the target browsers (Chrome on Apple
// silicon through ANGLE/Metal, deck.gl 9.4.0) filtered out every label. Doing it on the CPU is
// predictable and testable; the cost is one pass over the candidates, not a second GPU render.
(function (root) {
  'use strict';

  var CELL = 96;

  function overlaps(a, b, pad) {
    return a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
  }

  // Returns the refs of the boxes that survive, highest priority first.
  function place(boxes, pad) {
    pad = pad == null ? 2 : pad;
    var order = boxes.slice().sort(function (a, b) { return b.prio - a.prio; });
    var grid = Object.create(null);
    var kept = [];
    for (var i = 0; i < order.length; i++) {
      var b = order[i];
      var x0 = Math.floor((b.x - pad) / CELL), x1 = Math.floor((b.x + b.w + pad) / CELL);
      var y0 = Math.floor((b.y - pad) / CELL), y1 = Math.floor((b.y + b.h + pad) / CELL);
      var clash = false;
      for (var cx = x0; cx <= x1 && !clash; cx++) {
        for (var cy = y0; cy <= y1 && !clash; cy++) {
          var cell = grid[cx + ',' + cy];
          if (!cell) continue;
          for (var k = 0; k < cell.length; k++) { if (overlaps(b, cell[k], pad)) { clash = true; break; } }
        }
      }
      if (clash) continue;
      for (cx = x0; cx <= x1; cx++) {
        for (cy = y0; cy <= y1; cy++) {
          var key = cx + ',' + cy;
          (grid[key] || (grid[key] = [])).push(b);
        }
      }
      kept.push(b.ref);
    }
    return kept;
  }

  // Rough text width for a UI font: avoids measuring text on a canvas for every label.
  function textWidth(str, sizePx) { return str.length * sizePx * 0.58 + 4; }

  var api = { place: place, overlaps: overlaps, textWidth: textWidth };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.RM = root.RM || {}).declutter = api;
})(typeof self !== 'undefined' ? self : this);
