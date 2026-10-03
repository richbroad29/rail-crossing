'use strict';
// A made-up National Rail response for Portslade, in the same JSON shape as the live feed, so
// `node server.js --sample` shows a working board with no key. Times run from `anchor` (when
// the server started) and departed trains drop off, as on the real feed, so the board can be
// watched moving up.
// It puts every state on screen at once: on time, late, delayed with no estimate, cancelled,
// a replacement bus. Platform numbers and stopping patterns are invented.

const MIN = 60000;
const clock = d => d.toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });

const STOPS = {
  'Brighton': [['Aldrington', 2], ['Hove', 5], ['Brighton', 10]],
  'West Worthing': [['Fishersgate', 2], ['Southwick', 4], ['Shoreham-by-Sea', 7], ['Lancing', 11], ['East Worthing', 14], ['Worthing', 17], ['West Worthing', 20]],
  'Littlehampton': [['Fishersgate', 2], ['Southwick', 4], ['Shoreham-by-Sea', 7], ['Lancing', 11], ['East Worthing', 14], ['Worthing', 17], ['West Worthing', 20], ['Durrington-on-Sea', 23], ['Goring-by-Sea', 25], ['Angmering', 29], ['Littlehampton', 36]],
  'Southampton Central': [['Shoreham-by-Sea', 6], ['Lancing', 10], ['Worthing', 15], ['West Worthing', 18], ['Goring-by-Sea', 21], ['Angmering', 25], ['Barnham', 33], ['Chichester', 41], ['Havant', 53], ['Fareham', 68], ['Southampton Central', 89]],
};

// [minutes from now, destination, platform, what goes wrong]
const SERVICES = [
  [1, 'Brighton', '1'],
  [4, 'Littlehampton', '2', { late: 7, delay: 'This train has been delayed by a signalling problem' }],
  [9, 'Brighton', '1', { delayed: true, delay: 'This train has been delayed by a fault on this train' }],
  [13, 'West Worthing', '2', { cancelled: 'This train has been cancelled because of a shortage of train crew' }],
  [16, 'Brighton', '1', { late: 2, delay: 'This train has been delayed by a late-running train in front of this one' }],
  [22, 'West Worthing', null, { bus: true }],
  [27, 'Brighton', '1'],
  [33, 'Southampton Central', '2'],
  [38, 'Brighton', '1'],
  [43, 'West Worthing', '2'],
  [48, 'Brighton', '1'],
  [54, 'Littlehampton', '2'],
];

function sampleResponse(now = new Date(), anchor = now) {
  const base = Math.ceil(anchor.getTime() / MIN) * MIN;
  const trainServices = [], busServices = [];
  SERVICES.forEach(([off, dest, platform, t = {}], i) => {
    const std = new Date(base + off * MIN);
    const late = t.late || 0;
    if (!t.delayed && +std + late * MIN < +now) return;      // gone
    const etd = t.cancelled ? 'Cancelled' : t.delayed ? 'Delayed' : late ? clock(new Date(+std + late * MIN)) : 'On time';
    const svc = {
      std: clock(std), etd, platform,
      operator: 'Southern', operatorCode: 'SN',
      serviceType: t.bus ? 'bus' : 'train',
      isCancelled: !!t.cancelled,
      cancelReason: t.cancelled || null,
      delayReason: t.delay || null,
      serviceID: `sample-${i}`,
      origin: [{ locationName: dest === 'Brighton' ? 'West Worthing' : 'Brighton' }],
      destination: [{ locationName: dest }],
      subsequentCallingPoints: [{
        callingPoint: STOPS[dest].map(([name, o]) => ({
          locationName: name,
          st: clock(new Date(+std + o * MIN)),
          et: t.cancelled ? 'Cancelled' : t.delayed ? 'Delayed' : late ? clock(new Date(+std + (o + late) * MIN)) : 'On time',
        })),
      }],
    };
    (t.bus ? busServices : trainServices).push(svc);
  });
  return { generatedAt: now.toISOString(), locationName: 'Portslade', crs: 'PLD', trainServices, busServices };
}

module.exports = { sampleResponse };
