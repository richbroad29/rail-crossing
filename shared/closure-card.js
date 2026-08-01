/*
 * shared/closure-card.js — the closure card, rendered identically by both front-ends.
 *
 * Why this is shared rather than "presentation, so it lives in each app". The usual split
 * in this repo is right: shared maths, separate prose, because "Approaching (~3 min)" is
 * for a passer-by and "Approaching (3m20s)" is for someone with a stopwatch. This is the
 * exception, and deliberately so — the observer's job is to show WHAT THE PUBLIC APP IS
 * SHOWING so that a mismatch is a real bug. A second copy of this markup would make the two
 * apps able to disagree about the same closure at the same moment, which is precisely the
 * failure shared/predict.js exists to prevent. So: one string builder, one stylesheet
 * (shared/closure-card.css), both apps.
 *
 * DOM-free like predict.js — returns an HTML string, no build step, loads via <script>.
 * It formats; it does not decide. Every value comes from a period built by
 * PREDICT.buildClosures, so it cannot invent a number the prediction core didn't produce.
 */
(function (root) {
  'use strict';
  var P = root.PREDICT;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Four-state freight label, by descending confidence. A TD sighting today is live
  // confirmation and beats recent history; recent history beats schedule-only. A Q-flagged
  // freight with a low historical run rate is the typical false-positive culprit, and
  // saying so is the difference between a useful prediction and a cried wolf.
  function typeLabel(t) {
    if (t.trainType !== 'freight') return '';
    if (t.tdSeen) return ' (freight — confirmed)';
    if (t.runsAsRequired && t.recentRunRate !== null && t.recentRunRate < 0.3) {
      return ' (freight — usually doesn’t run)';
    }
    if (t.runsAsRequired) return ' (freight — may not run)';
    return ' (freight)';
  }

  function trainRow(t) {
    var dirColor = t.direction === 'east' ? '#38BDF8' : '#FB923C';
    var arrow = t.direction === 'east' ? '→' : '←';
    var statusHtml;
    if (t.isUncertain) {
      statusHtml = '<span class="train-status train-status-delayed">Delayed</span>';
    } else if (t.isDelayed && t.delayMins > 0) {
      statusHtml = '<span class="train-status train-status-delayed">+' + t.delayMins + 'm</span>';
    } else {
      statusHtml = '<span class="train-status train-status-ontime">On time</span>';
    }
    return '<div class="closure-train">'
      + '<span style="color:' + dirColor + ';font-weight:700;flex-shrink:0">' + arrow + '</span>'
      + '<span class="closure-train-route">' + esc(t.origin) + ' → ' + esc(t.destination) + esc(typeLabel(t)) + '</span>'
      + '<span class="closure-train-time">' + P.fmtShort(t.bestTime) + '</span>'
      + statusHtml
      + '</div>';
  }

  // One closure period. `now` is a Date; the caller re-renders on its own tick.
  function cardHtml(p, now) {
    var t = now.getTime();
    // A period holding open has not finished when its end passes — the train has not
    // performed its clear step (register #14) — so "are we in it" cannot be the clock
    // alone. Same test as PREDICT.derive, for the same reason.
    var isCurrent = t >= p.start.getTime() && (p.holdingOpen || t <= p.end.getTime());
    // Measure from the PREDICTED close, not the confirmed `start`. Everything the user
    // sees (header countdown, the time on this row, the Down For card) targets the
    // predicted close, and `start` sits earlier by the safety-net margin — measuring
    // from it would overstate the closure and disagree with the Down For card.
    // fmtDuration so this pill and the "Down For" card round the same way — they were
    // showing "~5 min" and "~4m 50s" side by side for one closure.
    var duration = P.fmtDuration(p.end - (p.predictedStart || p.start)).replace('~', '');
    var html = '<div class="closure-card' + (isCurrent ? ' closure-active' : '') + '">';
    html += '<div class="closure-hdr">';

    if (isCurrent) {
      html += '<span class="closure-time" style="color:#FCA5A5">NOW — ' + P.fmtShort(p.end) + '</span>';
      // A held open has no time to count down to, so don't print one — the train has not
      // cleared and we do not know when it will.
      html += p.holdingOpen
        ? '<span class="closure-pill closure-pill-active">Closed ' + duration + ' · held</span>'
        : '<span class="closure-pill closure-pill-active">Closed ' + duration + ' · opens in ' + P.fmtCountdown(p.end.getTime() - t) + '</span>';
    } else {
      var w = p.window || { imminent: false, halfWidthSecs: 120 };
      // Show the PREDICTED close time/countdown (matches the header countdown);
      // isCurrent above still gates on the confirmed start.
      var pStart = p.predictedStart || p.start;
      var secsUntil = pStart.getTime() - t;
      if (p.closePending) {
        // The trigger has not fired and its projection has expired: the time on this row is
        // a lower bound, so showing a clock time would be a false precision. Say what is
        // actually happening instead — a train stopped short of the crossing means the
        // barrier is NOT about to drop, which is the opposite of what the old "Soon" said.
        html += '<div class="closure-time-group"><span class="closure-time closure-held">Train held</span></div>';
        html += '<span class="closure-pill">Closed ' + duration + ' · not before ' + P.fmtCountdown(Math.max(0, secsUntil)) + '</span>';
      } else if (w.imminent) {
        html += '<div class="closure-time-group"><span class="closure-time closure-imminent">Any moment now</span></div>';
        html += '<span class="closure-pill">Closed ' + duration + ' · any moment now</span>';
      } else {
        var band = w.halfWidthSecs > 0
          ? '<span class="closure-uncertainty">±' + P.fmtUncertainty(w.halfWidthSecs) + '</span>'
          : '';
        html += '<div class="closure-time-group"><span class="closure-time">' + P.fmtShort(pStart) + '</span>' + band + '</div>';
        html += '<span class="closure-pill">Closed ' + duration + ' · ' + P.fmtWhen(secsUntil, w.halfWidthSecs >= 60) + '</span>';
      }
    }
    html += '</div>';

    var hasUncertain = p.trains.some(function (x) { return x.isUncertain; });
    if (hasUncertain) {
      html += '<div class="closure-warn">⚠ Timing uncertain — train delayed with no estimate</div>';
    }
    for (var j = 0; j < p.trains.length; j++) html += trainRow(p.trains[j]);
    return html + '</div>';
  }

  // The periods worth showing at `now`: everything that hasn't finished, plus a minute of
  // grace so a closure doesn't vanish the instant it ends. `limit` caps the list.
  function relevant(periods, now, limit) {
    var t = now.getTime();
    var out = [];
    for (var i = 0; i < (periods || []).length; i++) {
      var p = periods[i];
      if (p.holdingOpen || p.end.getTime() > t - 60000) out.push(p);
      if (limit && out.length >= limit) break;
    }
    return out;
  }

  function listHtml(periods, now, limit) {
    var rel = relevant(periods, now, limit);
    if (!rel.length) return '<div class="empty">No upcoming closures</div>';
    return rel.map(function (p) { return cardHtml(p, now); }).join('');
  }

  root.CLOSURE_CARD = { cardHtml: cardHtml, listHtml: listHtml, relevant: relevant, typeLabel: typeLabel };
})(typeof globalThis !== 'undefined' ? globalThis : this);
