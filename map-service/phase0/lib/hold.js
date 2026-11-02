'use strict';

// Hold one subscription open for a while and say WHY it ended.
//
// Both scripts wrap different measurements around the same skeleton: subscribe, then wait for the
// FIRST of — time is up, the operator pressed Ctrl-C, the safety interlock tripped, NROD dropped
// us, the feed went silent, a guard fired — and then leave properly (DISCONNECT, wait for the
// receipt). Keeping that in one place means the "stop at once on any of these" behaviour is
// written, and tested, once.

/**
 * A one-shot "please stop": the first request wins and its reason is kept. Signals, the interlock
 * and the guards all feed one of these, and the connect attempt listens to it too so that a
 * trip or a Ctrl-C while still connecting does not wait out the 30 s bound.
 */
class StopController {
  constructor() {
    this.reason = null;
    this.promise = new Promise(resolve => { this._resolve = resolve; });
  }
  /** @param {{type: string}} reason  e.g. {type: 'signal', name: 'SIGINT'} or {type: 'interlock', ...} */
  request(reason) {
    if (this.reason) return false;
    this.reason = reason;
    this._resolve(reason);
    return true;
  }
}

/**
 * @param {object} o
 * @param {StompSession} o.session  an open session (lib/stomp.js)
 * @param {string}   o.topic
 * @param {function} o.onBody       (bodyString, frameHeaders, receivedAtMs)
 * @param {number}   o.durationMs
 * @param {StopController} o.stop
 * @param {number}   [o.silenceMs]  end the run if no message arrives for this long (a dead-but-open connection)
 * @param {{everyMs: number, fn: function}} [o.tick]  periodic work; fn({now, stop(type, detail)})
 * @param {function} [o.now]
 * @returns {Promise<object>} never rejects: {endedBy, detail, frames, firstFrameAfterMs, close, closedInfo, ...}
 *   endedBy: 'duration' | 'signal' | 'interlock' | 'closed' | 'silent' | 'guard' | 'error'
 */
async function holdTopic(o) {
  const { session, topic, onBody, durationMs, stop } = o;
  const now = o.now || Date.now;
  const startedAt = now();

  // `decidedAt` is when the run ENDED (the moment a stop reason won), taken before the goodbye:
  // the DISCONNECT handshake is not part of what was measured, and counting it would push the end
  // of a 60-minute window a few milliseconds into a 61st.
  const summarise = async (endedBy, detail, subscribed, decidedAt) => {
    const close = await session.close();
    const s = session.stats;
    return {
      endedBy, detail: detail || null, subscribed,
      startedAt, endedAt: decidedAt,
      subscribedAt: session.subscribedAt,
      frames: s.frames,
      firstFrameAfterMs: s.firstFrameAt === null || session.subscribedAt === null ? null : s.firstFrameAt - session.subscribedAt,
      maxGapMs: s.maxGapMs,
      handlerErrors: s.handlerErrors,
      firstHandlerError: s.firstHandlerError,
      close,
      closedInfo: session.closedInfo
    };
  };

  // A stop requested while we were still connecting: do not even subscribe.
  if (stop.reason) return summarise(stop.reason.type || 'stop', stop.reason, false, now());

  let outcome = null;
  let release;
  const ended = new Promise(resolve => { release = resolve; });
  const end = (endedBy, detail) => {
    if (outcome) return;
    outcome = { endedBy, detail: detail || null, at: now() };
    release();
  };

  const timers = [];
  const onClosed = info => { if (info.unexpected) end('closed', info); };

  session.subscribe(topic, onBody);
  session.on('closed', onClosed);
  if (session.closedInfo && session.closedInfo.unexpected) end('closed', session.closedInfo);
  stop.promise.then(reason => end((reason && reason.type) || 'stop', reason));
  timers.push(setTimeout(() => end('duration', null), durationMs));

  if (o.silenceMs) {
    const checkEvery = Math.min(5000, Math.max(100, Math.floor(o.silenceMs / 4)));
    timers.push(setInterval(() => {
      const last = session.stats.lastFrameAt !== null ? session.stats.lastFrameAt : session.subscribedAt;
      if (now() - last > o.silenceMs) end('silent', { silentForMs: now() - last });
    }, checkEvery));
  }
  if (o.tick) {
    timers.push(setInterval(() => {
      try { o.tick.fn({ now: now(), stop: end }); }
      catch (e) { end('error', { message: e && e.message }); }
    }, o.tick.everyMs));
  }

  await ended;
  for (const t of timers) { clearTimeout(t); clearInterval(t); }
  session.removeListener('closed', onClosed);
  return summarise(outcome.endedBy, outcome.detail, true, outcome.at);
}

module.exports = { StopController, holdTopic };
