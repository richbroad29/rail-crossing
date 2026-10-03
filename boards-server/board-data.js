'use strict';
// Turns National Rail's "departure board with details" response (Rail Data Marketplace, the
// public LDBWS feed, JSON) into the rows the Portslade board draws.
//
// Everything the board DECIDES lives here: the status wording, the order, the platform, and
// the scrolling line under the next train. The page only draws what it is given, so this
// file can move into the backend unchanged when the board goes live on railcrossing.uk.

const TZ = 'Europe/London';
const MIN = 60000;

const isClock = v => typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v);

// The feed gives a list bare, wrapped ({ service: [...] }, { location: [...] }), or as a lone
// object when there is only one. All three come out as an array.
function list(v, key) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'object' && key in v) return list(v[key]);
  return typeof v === 'object' ? [v] : [];
}

// Reasons are plain sentences on the public feed; tolerate the { Value } wrapping too.
function text(v) {
  if (typeof v === 'string') return v.trim() || null;
  if (v && typeof v === 'object') return text(v.Value ?? v.value ?? v.text ?? null);
  return null;
}
const sentence = s => /[.!?]$/.test(s) ? s : s + '.';

// "HH:MM" from the board -> an absolute time, taking the day from `ref` (the feed's own
// generatedAt). A board only covers the next two hours, so the clock time nearest to `ref`
// is always the right one, which is all that's needed to get trains after midnight in order.
function clockToDate(hhmm, ref) {
  const [h, m] = hhmm.split(':').map(Number);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(ref).map(x => [x.type, x.value]));
  let diff = h * 60 + m - (Number(p.hour) * 60 + Number(p.minute));
  if (diff < -720) diff += 1440;
  if (diff > 720) diff -= 1440;
  return new Date(Math.floor(ref.getTime() / MIN) * MIN + diff * MIN);
}

function statusOf(svc, std, etd, isBus, ref) {
  if (svc.isCancelled === true || etd === 'Cancelled') return { kind: 'cancelled', text: 'Cancelled' };
  if (etd === 'Delayed') return { kind: 'delayed', text: 'Delayed' };
  if (isClock(etd) && etd !== std) {
    const late = clockToDate(etd, ref) > clockToDate(std, ref);
    return { kind: late ? 'late' : 'ontime', text: 'Exp ' + etd };
  }
  if (etd === 'On time' || etd === std) return { kind: 'ontime', text: isBus ? 'Bus' : 'On time' };
  return { kind: 'other', text: etd };    // e.g. "No report": shown as given, not treated as a delay
}

function callingPoints(svc) {
  // [{ callingPoint: [{ locationName, st, et, isCancelled }] }]. A train that divides has more
  // than one group; the first is the portion the board's destination belongs to.
  const group = list(svc.subsequentCallingPoints, 'callingPointList')[0];
  return list(group && group.callingPoint, 'callingPoint')
    .filter(p => p && p.locationName && p.isCancelled !== true)
    .map(p => p.locationName);
}

/**
 * @param body  the feed's JSON (string or parsed)
 * @param now   fallback reference time if the feed carries no generatedAt
 * @returns { station, generatedAt, departures: [...] }, departures in the order they will leave
 */
function departuresFrom(body, now = new Date()) {
  const data = typeof body === 'string' ? JSON.parse(body) : body;
  const ref = data.generatedAt && !isNaN(Date.parse(data.generatedAt)) ? new Date(data.generatedAt) : now;
  const services = [
    ...list(data.trainServices, 'service').map(svc => [svc, false]),
    ...list(data.busServices, 'service').map(svc => [svc, true]),
  ];

  const rows = [];
  for (const [svc, onBusList] of services) {
    if (!svc) continue;
    const std = String(svc.std || '').trim();
    if (!isClock(std)) continue;                     // terminates here: not a departure
    const etd = String(svc.etd || '').trim();
    const isBus = onBusList || svc.serviceType === 'bus';
    const status = statusOf(svc, std, etd, isBus, ref);
    const destination = list(svc.destination, 'location').map(l => l && l.locationName).filter(Boolean).join(' & ') || 'Unknown';

    // The scrolling line. Calling points always; the reason only when there really is a
    // delay or cancellation to explain (the feed sometimes keeps a reason on a train that
    // has since made the time up).
    let callingAt = null;
    if (status.kind === 'cancelled') callingAt = isBus ? 'This bus has been cancelled.' : 'This train has been cancelled.';
    else {
      const calls = callingPoints(svc);
      if (calls.length) {
        callingAt = `${isBus ? 'Replacement bus calling at' : 'Calling at'}: ` +
          (calls.length === 1 ? `${calls[0]} only` : calls.join(', '));
      }
    }
    const why = status.kind === 'cancelled' ? text(svc.cancelReason)
      : status.kind === 'late' || status.kind === 'delayed' ? text(svc.delayReason) : null;

    const scheduledAt = clockToDate(std, ref);
    const expectedAt = isClock(etd) ? clockToDate(etd, ref) : scheduledAt;
    const platform = svc.platform == null || String(svc.platform).trim() === '' ? null : String(svc.platform).trim();

    rows.push({
      id: svc.serviceID || svc.serviceIdUrlSafe || `${std}|${destination}`,
      time: std,
      destination,
      platform,
      isBus,
      status,
      callingAt,
      reason: why ? sentence(why) : null,
      scheduledAt: scheduledAt.toISOString(),
      expectedAt: expectedAt.toISOString(),
    });
  }

  // In the order they will actually leave: expected time where the feed has one, else the
  // timetable (which is all "Delayed" and "Cancelled" give us), timetable as the tie-break.
  rows.sort((a, b) => Date.parse(a.expectedAt) - Date.parse(b.expectedAt) ||
    Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));

  return { station: data.locationName || 'Portslade', generatedAt: ref.toISOString(), departures: rows };
}

module.exports = { departuresFrom, clockToDate };
