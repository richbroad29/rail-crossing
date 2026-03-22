const https = require('https');
const logger = require('./logger');

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
  if (!timeStr || !timeStr.includes(':')) return null;
  const [h, m] = timeStr.split(':').map(Number);
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
  if (d.getTime() < now.getTime() - 6 * 3600000) d.setDate(d.getDate() + 1);
  return d;
}

// ---- Common train extraction logic ----

function extractTrain(sta, eta, std, etd, origin, dest, operator, trainid) {
  const direction = isEastOrigin(origin) ? 'west' : 'east';

  let sch, et;
  if (direction === 'east') {
    sch = sta || std; et = eta || etd;
  } else {
    sch = std || sta; et = etd || eta;
  }

  let bestTimeStr = sch;
  let isUncertain = false;
  if (et && et !== 'On time' && et !== 'Delayed' && et.includes(':')) {
    bestTimeStr = et;
  } else if (et === 'Delayed') {
    isUncertain = true;
  }

  const bestTime = parseTime(bestTimeStr);
  if (!bestTime) return null;
  const scheduledTime = parseTime(sch);

  let delayMins = 0;
  if (et && et.includes(':') && sch) {
    const e2 = parseTime(et), s2 = parseTime(sch);
    if (e2 && s2) delayMins = Math.round((e2 - s2) / 60000);
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
    etaText: et || 'On time',
    headcode: trainid,
    trainType,
    source: 'ldb',
    dedupKey: `${sch || ''}|${dest}`
  };
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

    const origin = svc.origin?.location?.[0]?.locationName ||
                   svc.origin?.[0]?.locationName || '?';
    const dest = svc.destination?.location?.[0]?.locationName ||
                 svc.destination?.[0]?.locationName || '?';

    const train = extractTrain(
      svc.sta, svc.eta, svc.std, svc.etd,
      origin, dest,
      svc.operator || '?',
      svc.trainid || svc.rid || svc.serviceID || null
    );
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

function parseSoapXml(xml) {
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

    const train = extractTrain(
      getVal(sv, 'sta'), getVal(sv, 'eta'),
      getVal(sv, 'std'), getVal(sv, 'etd'),
      origin, dest,
      getVal(sv, 'operator') || '?',
      getVal(sv, 'trainid') || getVal(sv, 'rid') || null
    );
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

function deduplicateTrains(trains) {
  const sorted = trains.slice().sort((a, b) => new Date(a.bestTime) - new Date(b.bestTime));
  const results = [];
  for (const t of sorted) {
    const isDupe = results.some(r =>
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
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
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

  return parseSoapXml(resp.body);
}

// ---- Main polling function ----

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

  const deduped = deduplicateTrains(allTrains);
  logger.logLdb(crossingId, deduped);
  return deduped;
}

module.exports = { pollCrossing, pollStationRdm, pollStationSoap, parseRdmJson, parseSoapXml };
