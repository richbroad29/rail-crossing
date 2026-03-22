const https = require('https');
const logger = require('./logger');

// LDBSVWS (Staff Version) endpoint — shows non-stopping + ECS trains
const LDBSVWS_URL = 'https://lite.realtime.nationalrail.co.uk/OpenLDBSVWS/ldbsv12.asmx';
const LDBSVWS_NS = 'http://thalesgroup.com/RTTI/2021-11-01/ldbsv/';
const LDBSVWS_TYPES_NS = 'http://thalesgroup.com/RTTI/2017-10-01/ldbsv/types';

// Fallback: public LDB (same as current Cloudflare Worker)
const LDB_URL = 'https://lite.realtime.nationalrail.co.uk/OpenLDBWS/ldb12.asmx';
const LDB_NS = 'http://thalesgroup.com/RTTI/2021-11-01/ldb/';

function buildSoapRequest(station, token, useStaffVersion) {
  const ns = useStaffVersion ? LDBSVWS_NS : LDB_NS;
  return `<?xml version="1.0" encoding="utf-8"?>
<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"
  xmlns:ldb="${ns}">
  <soap12:Header>
    <AccessToken xmlns="http://thalesgroup.com/RTTI/2013-11-28/Token/types">
      <TokenValue>${token}</TokenValue>
    </AccessToken>
  </soap12:Header>
  <soap12:Body>
    <ldb:GetArrDepBoardWithDetailsRequest>
      <ldb:numRows>30</ldb:numRows>
      <ldb:crs>${station}</ldb:crs>
      <ldb:time>${new Date().toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'})}</ldb:time>
      <ldb:timeWindow>120</ldb:timeWindow>
    </ldb:GetArrDepBoardWithDetailsRequest>
  </soap12:Body>
</soap12:Envelope>`;
}

function soapFetch(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/soap+xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`SOAP HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        } else {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('SOAP timeout')); });
    req.write(body);
    req.end();
  });
}

// Extract text content between XML tags (handles namespace prefixes)
function getVal(xml, tag) {
  // Match with or without namespace prefix
  const patterns = [
    new RegExp(`<[^>]*:${tag}>([^<]*)<`, 'i'),
    new RegExp(`<${tag}>([^<]*)<`, 'i')
  ];
  for (const p of patterns) {
    const m = xml.match(p);
    if (m) return m[1].trim();
  }
  return null;
}

// Determine direction from origin station name
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

// Parse time string "HH:MM" into a Date for today
function parseTime(timeStr) {
  if (!timeStr || !timeStr.includes(':')) return null;
  const [h, m] = timeStr.split(':').map(Number);
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
  // Handle overnight wrap
  if (d.getTime() < now.getTime() - 6 * 3600000) d.setDate(d.getDate() + 1);
  return d;
}

// Parse the SOAP XML response into an array of train objects
function parseTrains(xml) {
  const results = [];
  const services = xml.split(/service>/i);

  for (const sv of services) {
    // Must have scheduled arrival or departure
    if (!sv.match(/:?sta>/) && !sv.match(/:?std>/)) continue;
    // Skip cancelled
    if (/isCancelled>true/i.test(sv)) continue;
    // Skip bus
    if (/serviceType>bus/i.test(sv)) continue;

    const sta = getVal(sv, 'sta');
    const eta = getVal(sv, 'eta');
    const std = getVal(sv, 'std');
    const etd = getVal(sv, 'etd');

    // Extract origin and destination
    let origin = '?', dest = '?';
    const origBlock = sv.match(/origin>[\s\S]*?<\/.*?origin>/i);
    if (origBlock) origin = getVal(origBlock[0], 'locationName') || '?';
    const destBlock = sv.match(/destination>[\s\S]*?<\/.*?destination>/i);
    if (destBlock) dest = getVal(destBlock[0], 'locationName') || '?';

    // Operator
    const operator = getVal(sv, 'operator') || '?';

    // Headcode / train ID (Staff Version provides this)
    const trainid = getVal(sv, 'trainid') || getVal(sv, 'rid') || null;
    const rsid = getVal(sv, 'rsid') || null;

    // Direction
    const direction = isEastOrigin(origin) ? 'west' : 'east';

    // Pick reference time based on direction and crossing geometry
    let sch, et;
    if (direction === 'east') {
      sch = sta || std;
      et = eta || etd;
    } else {
      sch = std || sta;
      et = etd || eta;
    }

    let bestTimeStr = sch;
    let isUncertain = false;
    if (et && et !== 'On time' && et !== 'Delayed' && et.includes(':')) {
      bestTimeStr = et;
    } else if (et === 'Delayed') {
      isUncertain = true;
    }

    const bestTime = parseTime(bestTimeStr);
    if (!bestTime) continue;
    const scheduledTime = parseTime(sch);

    let delayMins = 0;
    if (et && et.includes(':') && sch) {
      const e2 = parseTime(et), s2 = parseTime(sch);
      if (e2 && s2) delayMins = Math.round((e2 - s2) / 60000);
    }

    // Determine train type from headcode
    let trainType = 'passenger';
    if (trainid) {
      const firstChar = trainid.charAt(0);
      if ('34567'.includes(firstChar)) trainType = 'non-passenger';
      if ('67'.includes(firstChar)) trainType = 'freight';
      if (firstChar === '5') trainType = 'ecs';
    }

    results.push({
      origin, destination: dest, operator,
      scheduledTime: scheduledTime?.toISOString(),
      bestTime: bestTime.toISOString(),
      direction, delayMins, isUncertain,
      etaText: et || 'On time',
      headcode: trainid,
      trainType,
      source: 'ldb',
      dedupKey: `${sch || ''}|${dest}`
    });
  }

  results.sort((a, b) => new Date(a.bestTime) - new Date(b.bestTime));
  return results;
}

// Deduplicate trains (same destination within 2 min window)
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

// Poll LDBSVWS for a single station, return parsed trains
async function pollStation(station, token, useStaffVersion = true) {
  const url = useStaffVersion ? LDBSVWS_URL : LDB_URL;
  const body = buildSoapRequest(station, token, useStaffVersion);
  const xml = await soapFetch(url, body);
  return parseTrains(xml);
}

// Poll all stations for a crossing, deduplicate, return combined list
async function pollCrossing(crossingId, config, token) {
  const stations = [config.ldb.station, ...(config.ldb.adjacentStations || [])];
  const allTrains = [];

  for (const station of stations) {
    try {
      // Try Staff Version first, fall back to public LDB
      let trains;
      try {
        trains = await pollStation(station, token, true);
      } catch (svErr) {
        console.warn(`LDBSVWS failed for ${station}, falling back to public LDB:`, svErr.message);
        trains = await pollStation(station, token, false);
      }
      allTrains.push(...trains);
    } catch (err) {
      console.error(`LDB poll failed for ${station}:`, err.message);
    }
  }

  const deduped = deduplicateTrains(allTrains);
  logger.logLdb(crossingId, deduped);
  return deduped;
}

module.exports = { pollCrossing, pollStation, parseTrains };
