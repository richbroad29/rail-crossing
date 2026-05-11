const NR_ENDPOINT = 'https://lite.realtime.nationalrail.co.uk/OpenLDBWS/ldb12.asmx';
const NR_ENDPOINT_SV = 'https://lite.realtime.nationalrail.co.uk/OpenLDBSVWS/ldbsv12.asmx';
const ALLOWED_ORIGINS = [
  'https://richbroad29.github.io',
  'http://localhost',
  'http://127.0.0.1'
];
function getCorsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.find(function(o) { return origin.startsWith(o); });
  return {
    'Access-Control-Allow-Origin': allowed || ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}
function buildSoap(token, station, type, useStaffVersion) {
  var method;
  if (type === 'arr') {
    method = useStaffVersion ? 'GetArrBoardWithDetailsRequest' : 'GetArrBoardWithDetailsRequest';
  } else if (type === 'dep') {
    method = useStaffVersion ? 'GetDepBoardWithDetailsRequest' : 'GetDepBoardWithDetailsRequest';
  } else {
    method = 'GetArrDepBoardWithDetailsRequest';
  }
  var ns = useStaffVersion
    ? 'http://thalesgroup.com/RTTI/2021-11-01/ldbsv/'
    : 'http://thalesgroup.com/RTTI/2021-11-01/ldb/';
  let s = '<?xml version="1.0"?>';
  s += '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"';
  s += ' xmlns:typ="http://thalesgroup.com/RTTI/2013-11-28/Token/types"';
  s += ' xmlns:ldb="' + ns + '">';
  s += '<soap:Header><typ:AccessToken><typ:TokenValue>' + token + '</typ:TokenValue></typ:AccessToken></soap:Header>';
  s += '<soap:Body><ldb:' + method + '><ldb:numRows>15</ldb:numRows>';
  s += '<ldb:crs>' + station + '</ldb:crs><ldb:timeWindow>120</ldb:timeWindow>';
  s += '</ldb:' + method + '></soap:Body></soap:Envelope>';
  return s;
}
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: getCorsHeaders(request) });
    }
    const url = new URL(request.url);
    const station = url.searchParams.get('station');
    const type = url.searchParams.get('type');
    const sv = url.searchParams.get('sv');
    if (!station) {
      return new Response(
        JSON.stringify({ error: 'Missing station parameter. Use ?station=PLD or ?station=PLD&type=arr' }),
        { status: 400, headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' } }
      );
    }
    if (type && type !== 'arr' && type !== 'dep') {
      return new Response(
        JSON.stringify({ error: 'Type must be arr or dep (or omit for combined)' }),
        { status: 400, headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' } }
      );
    }
    const validStation = /^[A-Z]{3}$/.test(station.toUpperCase());
    if (!validStation) {
      return new Response(
        JSON.stringify({ error: 'Invalid station code' }),
        { status: 400, headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' } }
      );
    }
    const useStaffVersion = sv === '1';
    const endpoint = useStaffVersion ? NR_ENDPOINT_SV : NR_ENDPOINT;
    try {
      const soapBody = buildSoap(useStaffVersion ? env.NR_TOKEN_SV : env.NR_TOKEN, station.toUpperCase(), type, useStaffVersion);
      const nrResponse = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/soap+xml;charset=utf-8' },
        body: soapBody
      });
      if (!nrResponse.ok) {
        return new Response(
          JSON.stringify({ error: 'National Rail API returned ' + nrResponse.status }),
          { status: 502, headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' } }
        );
      }
      const xml = await nrResponse.text();
      return new Response(xml, {
        status: 200,
        headers: {
          ...getCorsHeaders(request),
          'Content-Type': 'application/xml',
          'Cache-Control': 'public, max-age=30'
        }
      });
    } catch (e) {
      return new Response(
        JSON.stringify({ error: 'Failed to reach National Rail API: ' + e.message }),
        { status: 502, headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' } }
      );
    }
  }
};