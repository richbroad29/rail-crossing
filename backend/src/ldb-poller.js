const https = require('https');
const logger = require('./logger');
const { parseLondonWallClock, londonDateStamp } = require('./time-utils');

/**
 * LDB Poller — queries departure board data for crossing predictions.
 *
 * Supports two modes:
 *   1. RDM REST API (x-apikey header, returns JSON) — primary
 *   2. Direct SOAP (AccessToken header, returns XML) — fallback
 */

// RDM REST endpoints
const RDM_BASE = 'https://api1.raildata.org.uk';
const RDM_LDBSV_PATH = '/1010-live-arrival-and-departure-boards---staff-version1_0/LDBSVWS/api/20220120/GetArrDepBoardWithDetails';

// Direct SOAP endpoints (fallback)
const SOAP_LDB_URL = 'https://lite.realtime.nationalrail.co.uk/OpenLDBWS/ldb12.asmx';
const SOAP_LDBSV_URL = 'https://lite.realtime.nationalrail.co.uk/OpenLDBSVWS/ldbsv12.asmx';
const SOAP_NS = 'http://thalesgroup.com/RTTI/2021-11-01/ldb/';
const SOAP_SV_NS = 'http://thalesgroup.com/RTTI/2021-11-01/ldbsv/';

// ---- HTTP helpers ----

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('HTTP timeout')); });
    req.end();
  });
}

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('HTTP timeout')); });
    req.write(body);
    req.end();
  });
}

// ---- Direction detection ----

function isEastOrigin(name) {
  if (!name) return false;
  const l = name.toLowerCase();
  return l.includes('brighton') || l.includes('hove') ||
    l.includes('london') || l.includes('gatwick') ||
    l.includes('croydon') || l.includes('haywards') ||
    l.includes('preston park') || l.includes('burgess') ||
    l.includes('lewes') || l.includes('eastbourne') ||
    l.includes('lovers walk') || l.includes('three bridges') ||
    l.includes('horsham');
}

// ---- Time parsing ----

function parseTime(timeStr) {
  if (!timeStr) return null;
  // ISO 8601 datetime (RDM REST returns e.g. "2026-05-03T21:56:00")
  if (timeStr.includes('T') && timeStr.includes('-')) {
    // If the string already carries a timezone (Z or ±HH:MM), trust it.
    if (/[zZ]$|[+\-]\d{2}:?\d{2}$/.test(timeStr)) {
      const d = new Date(timeStr);
      return isNaN(d.getTime()) ? null : d;
    }
    // Europe/London wall-clock without offset (RDM REST shape).
    return parseLondonWallClock(timeStr);
  }
  // HH:MM fallback (SOAP path) — times are UK wall-clock, so build via
  // today's London date rather than UTC date components.
  if (!timeStr.includes(':')) return null;
  const [h, m] = timeStr.split(':').map(Number);
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  let d = parseLondonWallClock(`${londonDateStamp()}T${hh}:${mm}:00`);
  if (!d) return null;
  if (d.getTime() < Date.now() - 6 * 3600000) d = new Date(d.getTime() + 86400000);
  return d;
}

// ---- Common train extraction logic ----

// Does this feed value carry a time, as opposed to a status word? Both feed shapes put
// a ':' in every time they send (ISO on REST, HH:MM on SOAP) and none in "On time" or
// "Delayed", so this is the one test that works for both.
function hasTime(v) {
  return typeof v === 'string' && v.includes(':');
}

// Resolve an LDB time to a display string, best knowledge first: a published ACTUAL
// beats a forecast, a forecast beats "On time" ⇒ the scheduled time, and nothing at all
// stays blank (don't fabricate a time).
//
// The actual belongs here, not just on bestTime. This is the field the feedback picker
// shows and the calibration sheet records, and the train a user taps "Barriers Opening
// Now" for is by definition one that has just been past — precisely when the forecast is
// gone and the actual exists. It used to go out blank, so the picker tagged the train
// "timetabled" and the sheet stored no live time for the single most informative row.
function liveOf(sched, est, act) {
  if (hasTime(act)) return act;
  if (hasTime(est)) return est;
  if (est === 'On time') return sched || '';
  return '';
}

// LDBSVWS reports every location three ways — scheduled, forecast, and ACTUAL — and it
// stops sending the forecast once the actual exists (arrivalType/departureType flip
// Forecast -> Actual). Reading only the first two meant that at the instant a train's
// real time became known we threw it away and fell back to the timetable: 1H42 on
// 2026-08-14 was re-published as "17:29, delay 0" while it was on the crossing 9 minutes
// late, and ~180 services a day did the same for a median of 90s each.
//
// So: actual -> forecast -> timetable, and `timeSource` records which, because the caller
// cannot otherwise tell "genuinely on time" from "we have nothing". That distinction is
// the whole bug — a timetable fallback and a punctual train produced byte-identical
// output, so nothing downstream could decline to trust the one or the other.
function extractTrain(svc) {
  const { sta, eta, ata, std, etd, atd, origin, dest, operator, trainid } = svc;
  const source = svc.source || 'ldbsv';
  const uid = svc.uid === undefined ? null : svc.uid;
  const direction = isEastOrigin(origin) ? 'west' : 'east';

  // Each direction reads its own three values, and the choice is physical: the crossing
  // sits immediately west of the platform, so a westbound train pulls out of the platform
  // straight onto it (departure) while an eastbound one crosses on its way in (arrival).
  let sch, est, act;
  if (direction === 'east') {
    sch = sta || std; est = eta || etd; act = ata || atd;
  } else {
    sch = std || sta; est = etd || eta; act = atd || ata;
  }

  let bestTimeStr = sch;
  let timeSource = 'scheduled';
  let isUncertain = false;
  if (hasTime(act)) {
    bestTimeStr = act; timeSource = 'actual';
  } else if (hasTime(est)) {
    bestTimeStr = est; timeSource = 'forecast';
  } else if (est === 'On time') {
    // A forecast that happens to equal the timetable is still a forecast — the feed has
    // told us something. Not the same state as silence, however identical the time.
    timeSource = 'forecast';
  } else if (est === 'Delayed') {
    isUncertain = true;
  }

  const bestTime = parseTime(bestTimeStr);
  if (!bestTime) return null;
  const scheduledTime = parseTime(sch);

  let delayMins = 0;
  if (timeSource !== 'scheduled' && hasTime(bestTimeStr) && sch) {
    const b2 = parseTime(bestTimeStr), s2 = parseTime(sch);
    if (b2 && s2) delayMins = Math.round((b2 - s2) / 60000);
  }

  let trainType = 'passenger';
  if (trainid) {
    const fc = trainid.charAt(0);
    if ('67'.includes(fc)) trainType = 'freight';
    else if (fc === '5') trainType = 'ecs';
    else if (fc === '3') trainType = 'test';
  }

  return {
    origin, destination: dest, operator,
    scheduledTime: scheduledTime?.toISOString(),
    bestTime: bestTime.toISOString(),
    direction, delayMins, isUncertain,
    // Where bestTime came from: 'actual' | 'forecast' | 'scheduled'. Read by the LDB log
    // and by applyEstimateMemory below; nothing renders it.
    timeSource,
    // What the feed itself called each of its two times, verbatim. Recorded because a
    // withdrawn forecast is not diagnosable after the fact from the resolved time alone —
    // 1S30 on 2026-08-13 could only be described, not explained, from three days of logs.
    arrivalType: svc.arrivalType || null,
    departureType: svc.departureType || null,
    etaText: timeSource === 'actual' ? 'Actual' : (est || 'Timetabled'),
    headcode: trainid,
    uid,
    trainType,
    source,
    // Raw four-way Portslade times for the feedback picker's calibration capture:
    // scheduled & live arrival & departure, straight from LDB. "Live" means the best the
    // feed knows — a published actual once there is one, else the forecast.
    schedArr: sta || '',
    schedDep: std || '',
    liveArr: liveOf(sta, eta, ata),
    liveDep: liveOf(std, etd, atd),
    dedupKey: `${sch || ''}|${dest}`
  };
}

// --- A live estimate is not un-given by silence -------------------------------------
//
// The feed can also stop sending a forecast BEFORE the train has passed, and that is the
// case that moves a real prediction rather than merely mislabelling a row. 1S30 on
// 2026-08-13 (scheduled 11:36, actually crossed 11:47:32) fell back to "11:36" at 11:36
// and again 11:38-11:41 while it was eleven minutes away and not yet visible to TD; that
// put its predicted close in the past, which showed up as a phantom closure card in the
// list and a CLOSING_SOON that should have read OPEN.
//
// Falling back to the timetable there is strictly worse than keeping what we were last
// told, so we keep it. Replaced by any newer forecast (including an earlier one — the
// memory is a fallback, never a floor on the time itself) and by any actual; held only
// while the feed says nothing.
//
// HOW FAR THIS IS ACTUALLY ESTABLISHED, because it is less than it looks. The trigger is
// "the feed gave a time and now gives none". Whether 1S30 was in that state is NOT known:
// the LDB log stored only the resolved time, and a withdrawn etd and an etd equal to std
// are byte-identical once resolved. If the feed withdrew, this fixes it; if the feed
// actively re-asserted the timetable time, this never fires and 1S30 recurs. The
// arrType/depType fields added to logLdb alongside this exist to settle that the next time
// it happens — do not assume it is settled now.
//
// What IS measured: replaying three days through the real grouping code, substituting
// wherever the logs give positive evidence of a withdrawal, moves 12 grouping decisions
// and 2 banner states out of 7,386 polls, and produces no false BARRIERS DOWN. That is an
// upper bound on the disruption, and this function reproduces it exactly. Its 14
// divergences from that proxy are all cases where the proxy waited for the time to pass
// before calling it silence and this does not have to.
//
// Bounded risk in the other direction too: across 288 sampled service-observations on the
// live board, every one carried an estimate, so on today's evidence this rarely fires.
const ESTIMATE_MEMORY_TTL_MS = 30 * 60 * 1000;

// Identity for the memory. UID first — it is the only value that survives a headcode
// being reused later in the day — with headcode+scheduled time as the fallback.
function memoryKey(t) {
  if (t.uid) return `uid:${t.uid}`;
  return `hc:${t.headcode || ''}|${t.scheduledTime || ''}`;
}

function applyEstimateMemory(trains, memory, nowMs = Date.now()) {
  if (!memory) return trains;
  for (const t of trains) {
    const key = memoryKey(t);
    const held = memory[key];

    if (t.timeSource === 'forecast' || t.timeSource === 'actual') {
      memory[key] = { bestTime: t.bestTime, delayMins: t.delayMins, liveArr: t.liveArr, liveDep: t.liveDep, at: nowMs };
      continue;
    }
    // timeSource === 'scheduled' — the feed is telling us nothing. Prefer what it told us
    // last, while that is still recent enough to be about this run of this service.
    if (held && (nowMs - held.at) <= ESTIMATE_MEMORY_TTL_MS) {
      t.bestTime = held.bestTime;
      t.delayMins = held.delayMins;
      t.liveArr = held.liveArr;
      t.liveDep = held.liveDep;
      t.timeSource = 'forecast';
      t.estimateHeld = true;
      memory[key] = Object.assign({}, held, { at: nowMs });
    }
  }
  for (const k of Object.keys(memory)) {
    if (nowMs - memory[k].at > ESTIMATE_MEMORY_TTL_MS) delete memory[k];
  }
  return trains;
}

// ---- RDM REST JSON parsing ----

function parseRdmJson(body) {
  const results = [];
  let data;
  try {
    data = typeof body === 'string' ? JSON.parse(body) : body;
  } catch (e) {
    console.error('Failed to parse RDM JSON:', e.message, body.slice(0, 200));
    return results;
  }

  // Navigate the RDM response structure
  const trainServices = data?.trainServices ||
    data?.GetArrDepBoardWithDetailsResult?.trainServices?.service ||
    data?.GetStationBoardResult?.trainServices?.service ||
    [];
  const serviceList = Array.isArray(trainServices) ? trainServices : [trainServices].filter(Boolean);

  for (const svc of serviceList) {
    if (!svc) continue;
    if (svc.isCancelled) continue;
    if (svc.serviceType === 'bus') continue;
    if (svc.category === 'BR' || svc.category === 'BS') continue;

    const origin = svc.origin?.location?.[0]?.locationName ||
                   svc.origin?.[0]?.locationName || '?';
    const dest = svc.destination?.location?.[0]?.locationName ||
                 svc.destination?.[0]?.locationName || '?';

    const train = extractTrain({
      sta: svc.sta, eta: svc.eta, ata: svc.ata,
      std: svc.std, etd: svc.etd, atd: svc.atd,
      arrivalType: svc.arrivalType, departureType: svc.departureType,
      origin, dest,
      operator: svc.operator || '?',
      trainid: svc.trainid || svc.rid || svc.serviceID || null,
      source: 'ldbsv',
      uid: svc.uid || null
    });
    if (train) results.push(train);
  }

  results.sort((a, b) => new Date(a.bestTime) - new Date(b.bestTime));
  return results;
}

// ---- SOAP XML parsing ----

function getVal(xml, tag) {
  const patterns = [
    new RegExp(`<[^>]*:${tag}>([^<]*)`, 'i'),
    new RegExp(`<${tag}>([^<]*)`, 'i')
  ];
  for (const p of patterns) {
    const m = xml.match(p);
    if (m) return m[1].trim();
  }
  return null;
}

function parseSoapXml(xml, source = 'ldbsv') {
  const results = [];
  const services = xml.split(/service>/i);

  for (const sv of services) {
    if (!sv.match(/:?sta>/) && !sv.match(/:?std>/)) continue;
    if (/isCancelled>true/i.test(sv)) continue;
    if (/serviceType>bus/i.test(sv)) continue;

    let origin = '?', dest = '?';
    const origBlock = sv.match(/origin>[\s\S]*?<\/.*?origin>/i);
    if (origBlock) origin = getVal(origBlock[0], 'locationName') || '?';
    const destBlock = sv.match(/destination>[\s\S]*?<\/.*?destination>/i);
    if (destBlock) dest = getVal(destBlock[0], 'locationName') || '?';

    const train = extractTrain({
      sta: getVal(sv, 'sta'), eta: getVal(sv, 'eta'), ata: getVal(sv, 'ata'),
      std: getVal(sv, 'std'), etd: getVal(sv, 'etd'), atd: getVal(sv, 'atd'),
      arrivalType: getVal(sv, 'arrivalType'), departureType: getVal(sv, 'departureType'),
      origin, dest,
      operator: getVal(sv, 'operator') || '?',
      trainid: getVal(sv, 'trainid') || getVal(sv, 'rid') || null,
      source,
      uid: getVal(sv, 'uid') || null
    });
    if (train) results.push(train);
  }

  results.sort((a, b) => new Date(a.bestTime) - new Date(b.bestTime));
  return results;
}

function buildSoapRequest(station, token, staffVersion) {
  const ns = staffVersion ? SOAP_SV_NS : SOAP_NS;
  return `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope" xmlns:ldb="${ns}">
  <soap12:Header>
    <AccessToken xmlns="http://thalesgroup.com/RTTI/2013-11-28/Token/types">
      <TokenValue>${token}</TokenValue>
    </AccessToken>
  </soap12:Header>
  <soap12:Body>
    <ldb:GetArrDepBoardWithDetailsRequest>
      <ldb:numRows>30</ldb:numRows>
      <ldb:crs>${station}</ldb:crs>
      <ldb:timeWindow>120</ldb:timeWindow>
    </ldb:GetArrDepBoardWithDetailsRequest>
  </soap12:Body>
</soap12:Envelope>`;
}

// ---- Deduplication ----

// Same destination within 120s ⇒ assume one service reported twice. That was safe while
// a late train's time only ever moved BACKWARDS to its timetable slot; now that it moves
// forward to the truth it can land inside 120s of the genuinely-next service to the same
// destination, and the heuristic would silently discard a real upcoming train. Losing a
// closure is the one failure this project ranks above every other, so: a different
// identifier is positive proof of two different trains and settles it outright. RDM
// supplies uid on every service, which leaves the heuristic for identifier-less services
// only — exactly the case it was written for.
function sameService(a, b) {
  if (a.uid && b.uid) return a.uid === b.uid;
  if (a.headcode && b.headcode) return a.headcode === b.headcode;
  return true;   // nothing to tell them apart — fall through to destination + time
}

function deduplicateTrains(trains) {
  const sorted = trains.slice().sort((a, b) => new Date(a.bestTime) - new Date(b.bestTime));
  const results = [];
  for (const t of sorted) {
    const isDupe = results.some(r =>
      sameService(r, t) &&
      r.destination === t.destination &&
      Math.abs(new Date(r.bestTime) - new Date(t.bestTime)) <= 120000
    );
    if (!isDupe) results.push(t);
  }
  return results;
}

// ---- Station polling ----

async function pollStationRdm(station, apiKey) {
  const now = new Date();
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    }).formatToParts(now).map(({ type, value }) => [type, value])
  );
  const time = `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}`;
  const url = `${RDM_BASE}${RDM_LDBSV_PATH}/${station}/${time}`;
  const resp = await httpGet(url, { 'x-apikey': apiKey });

  if (resp.status !== 200) {
    throw new Error(`RDM HTTP ${resp.status}: ${resp.body.slice(0, 300)}`);
  }

  return parseRdmJson(resp.body);
}

async function pollStationSoap(station, token, staffVersion = false) {
  const url = staffVersion ? SOAP_LDBSV_URL : SOAP_LDB_URL;
  const body = buildSoapRequest(station, token, staffVersion);
  const resp = await httpPost(url, body, { 'Content-Type': 'application/soap+xml; charset=utf-8' });

  if (resp.status !== 200) {
    throw new Error(`SOAP HTTP ${resp.status}: ${resp.body.slice(0, 300)}`);
  }

  return parseSoapXml(resp.body, staffVersion ? 'ldbsv' : 'ldb');
}

// ---- Main polling function ----

// crossingId -> { <serviceKey>: heldEstimate }. Module-scoped because the memory has to
// outlive a poll; keyed by crossing because two crossings can see the same service.
const estimateMemory = new Map();

/**
 * Poll for a crossing. Returns deduplicated train list.
 *
 * auth = { mode: 'rdm', apiKey: '...' }     — RDM REST API
 *    or { mode: 'soap', token: '...' }       — Direct SOAP endpoint
 */
async function pollCrossing(crossingId, config, auth) {
  const station = config.ldb.station;
  const allTrains = [];

  try {
    let trains;
    if (auth.mode === 'rdm') {
      trains = await pollStationRdm(station, auth.apiKey);
      console.log(`  ${station}: ${trains.length} trains (RDM Staff Version)`);
    } else {
      // SOAP mode
      try {
        trains = await pollStationSoap(station, auth.token, true);
        console.log(`  ${station}: ${trains.length} trains (SOAP Staff Version)`);
      } catch (svErr) {
        console.warn(`  SOAP Staff Version failed: ${svErr.message}`);
        trains = await pollStationSoap(station, auth.token, false);
        console.log(`  ${station}: ${trains.length} trains (SOAP public LDB)`);
      }
    }
    allTrains.push(...trains);
  } catch (err) {
    console.error(`  LDB poll failed for ${station}:`, err.message);
  }

  // Held estimates are per crossing and persist across polls — that is the point of them.
  // Applied BEFORE dedup, so the 120s window compares the times we mean to serve.
  if (!estimateMemory.has(crossingId)) estimateMemory.set(crossingId, {});
  applyEstimateMemory(allTrains, estimateMemory.get(crossingId));

  const deduped = deduplicateTrains(allTrains);
  logger.logLdb(crossingId, deduped);
  return deduped;
}

module.exports = {
  pollCrossing, pollStationRdm, pollStationSoap, parseRdmJson, parseSoapXml,
  applyEstimateMemory, deduplicateTrains
};
