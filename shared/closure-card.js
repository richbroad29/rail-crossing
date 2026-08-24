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

  // Which trains this closure is for — direction, route, and how much to trust a freight.
  // No time and no punctuality label, deliberately (2026-08-14).
  //
  // The card header already answers the only question the app exists to answer: when the
  // barrier moves, and for how long. A train's own time answered a different question and
  // answered it ambiguously — it was the Portslade STATION time for a train off the live
  // departure board (westbound departure, eastbound arrival) but an estimate of the time at
  // the CROSSING for one off the timetable (freight, ECS, anything beyond the ~2h board
  // horizon). Same column, two meanings, no way to tell which from looking.
  //
  // It was also the one thing on the card that could be confidently wrong. The feed swaps a
  // forecast for a published actual once a train has been past, and we were not reading the
  // actual: so ~180 services a day spent about 90s each showing their timetabled time beside
  // the words "On time" — 1H42 on 2026-08-14 read "17:29 On time" while it was physically on
  // the crossing 9 minutes late, which is what got this looked at. That fault is fixed at
  // source in the backend, but the column it was displayed in was not worth keeping either.
  //
  // Timing doubt still gets said, once per closure rather than once per train: the
  // .closure-warn line above, and the held / "any moment now" treatments in the header.
  // (The ± band was part of that set until 2026-08-14; the window it came from now reaches
  // the user only as the precision of the pill's countdown — see fmtWhen in predict.js.)
  function trainRow(t) {
    var dirColor = t.direction === 'east' ? '#38BDF8' : '#FB923C';
    var arrow = t.direction === 'east' ? '→' : '←';
    return '<div class="closure-train">'
      + '<span style="color:' + dirColor + ';font-weight:700;flex-shrink:0">' + arrow + '</span>'
      + '<span class="closure-train-route">' + esc(t.origin) + ' → ' + esc(t.destination) + esc(typeLabel(t)) + '</span>'
      + '</div>';
  }

  // One closure period. `now` is a Date; the caller re-renders on its own tick.
  //
  // `heldT` (PREDICT.heldRef) is where a HELD value is measured from: the moment the
  // payload was built, not now. A bound that loses a second a second between polls is a
  // countdown, not a bound. Defaults to `now` so a caller that has no payload age still
  // renders — the observer passes it, the public app passes it.
  function cardHtml(p, now, heldT) {
    var t = now.getTime();
    if (typeof heldT !== 'number') heldT = t;
    // A period holding open has not finished when its end passes — the train has not
    // performed its clear step (register #14) — so "are we in it" cannot be the clock
    // alone. Same test as PREDICT.derive, for the same reason.
    var isCurrent = t >= p.start.getTime() && (p.holdingOpen || t <= p.end.getTime());
    // Measure from the PREDICTED close, not the confirmed `start`. Everything the user
    // sees (header countdown, the time on this row, the Down For card) targets the
    // predicted close, and `start` sits earlier by the safety-net margin — measuring
    // from it would overstate the closure and disagree with the Down For card.
    // fmtDownFor, the SAME formatter the "Down For" card uses — not merely the same
    // rounding. Both already rounded to 10s so the VALUE always agreed, but the two
    // spellings did not: on 2026-08-03 this pill read "3m" beside a card reading
    // "3 mins", 132 samples across the day (register UX5). They differed only on exact
    // whole minutes; every mixed value ("1m 50s") already matched, which is why it
    // survived a rounding fix. One formatter is the only way they cannot drift again.
    // No '~' strip needed — fmtDownFor does not add one.
    var duration = P.fmtDownFor(p.end - (p.predictedStart || p.start));
    var html = '<div class="closure-card' + (isCurrent ? ' closure-active' : '') + '">';
    html += '<div class="closure-hdr">';

    if (isCurrent) {
      html += '<span class="closure-time" style="color:#FCA5A5">NOW — ' + P.fmtShort(p.end) + '</span>';
      // How much longer it stays shut, counting down — the SAME value and the same
      // formatter as the Next Open card above, deliberately. derive() sets that card from
      // `current.end` and `current.holdingOpen` (predict.js), which is exactly the pair
      // passed here, so the two cannot drift apart: a user glancing between them sees one
      // number, not two that agree by luck.
      //
      // fmtEta carries the held case with it — "≥ 9s" while the train has not cleared,
      // "held" once even that bound has passed, "Soon" when a live countdown reaches zero
      // before the state catches up. Each is the token the card above is showing at that
      // moment, so the mirror holds in the awkward states too, not just the tidy one.
      //
      // The closure's TOTAL length is no longer printed here. It was a static number
      // sitting where a moving one belongs, and "Closed 2m 20s · opens in 1m 16s" made the
      // reader work out which of the two was the answer to "how long until I can cross".
      html += '<span class="closure-pill closure-pill-active">Closed '
        + P.fmtEta(p.end.getTime() - (p.holdingOpen ? heldT : t), p.holdingOpen) + '</span>';
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
        html += '<span class="closure-pill">Closed ' + duration + ' · not before '
          + P.fmtCountdown(Math.max(0, pStart.getTime() - heldT)) + '</span>';
      } else if (w.imminent) {
        // The end is a real prediction here: `imminent` means the trigger HAS fired and the
        // state is catching up (register #14), so only the start is too close to put a clock
        // time on. Same range as below, with the phrase standing in for the start.
        //
        // The pill drops its own "· any moment now": it repeated the header word for word,
        // and at 390px the two together overflowed the row — measured, the end truncated to
        // "17:4" and the pill ellipsised to "any momen…". A half-printed clock time is worse
        // than no clock time. Losing the duplicate is what buys the range its room.
        html += '<div class="closure-time-group"><span class="closure-time closure-imminent">Any moment now — ' + P.fmtShort(p.end) + '</span></div>';
        html += '<span class="closure-pill">Closed ' + duration + '</span>';
      } else {
        // No ± band (2026-08-14). The window is still computed and still used — it decides
        // whether the pill's countdown is spelled to the second or rounded (`fmtWhen`
        // below) — it is just no longer drawn. Confidence is expressed by improving the
        // prediction, not by printing an error bar beside it.
        html += '<div class="closure-time-group"><span class="closure-time">' + P.fmtShort(pStart) + ' — ' + P.fmtShort(p.end) + '</span></div>';
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

  function listHtml(periods, now, limit, heldT) {
    var rel = relevant(periods, now, limit);
    if (!rel.length) return '<div class="empty">No upcoming closures</div>';
    return rel.map(function (p) { return cardHtml(p, now, heldT); }).join('');
  }

  root.CLOSURE_CARD = { cardHtml: cardHtml, listHtml: listHtml, relevant: relevant, typeLabel: typeLabel };
})(typeof globalThis !== 'undefined' ? globalThis : this);
