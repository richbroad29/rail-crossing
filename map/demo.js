// Demo mode for the Sussex train map (?demo) — SIMULATED trains, not live data.
//
// Lets the map be previewed, and its interface tested, without the backend. It produces the same
// payload shape as GET /map/live, and moves trains the way the real map does: in jumps from one
// berth-sized step (~800 m) to the next, waiting at stations, dashed label between stations.
// The routes are real Sussex lines; the trains, headcodes and timings are made up. The page
// shows a "DEMO" banner whenever this file is in use.
//
// Deterministic in the clock: every viewer at the same moment sees the same trains.
(function () {
  'use strict';
  // CRS → [name, lat, lon], from backend config/map-stations.json (uk-railway-stations, ODbL).
  var ST = {"BTN":["Brighton",50.82886,-0.140739],"HOV":["Hove",50.835206,-0.17018],"AGT":["Aldrington",50.836601,-0.182151],"PLD":["Portslade",50.836044,-0.204898],"FSG":["Fishersgate",50.834469,-0.219161],"SWK":["Southwick",50.832471,-0.237142],"SSE":["Shoreham-By-Sea",50.834358,-0.271709],"LAC":["Lancing",50.827015,-0.323103],"EWR":["East Worthing",50.821592,-0.355108],"WRH":["Worthing",50.818768,-0.375924],"WWO":["West Worthing",50.818111,-0.392983],"DUR":["Durrington-On-Sea",50.817463,-0.411463],"GBS":["Goring-By-Sea",50.817753,-0.432751],"ANG":["Angmering",50.816515,-0.488127],"FOD":["Ford",50.829506,-0.578611],"BAA":["Barnham",50.830745,-0.640204],"CCH":["Chichester",50.83188,-0.781845],"FSB":["Fishbourne",50.839352,-0.815495],"BOH":["Bosham",50.842856,-0.847168],"NUT":["Nutbourne",50.846313,-0.883508],"SOB":["Southbourne",50.848343,-0.907601],"EMS":["Emsworth",50.851326,-0.938784],"WBL":["Warblington",50.853382,-0.967163],"HAV":["Havant",50.854441,-0.981562],"LIT":["Littlehampton",50.810226,-0.546547],"BOG":["Bognor Regis",50.787689,-0.675748],"PRP":["Preston Park",50.846054,-0.154787],"HSK":["Hassocks",50.924718,-0.145717],"BUG":["Burgess Hill",50.953552,-0.127749],"WVF":["Wivelsfield",50.964361,-0.120721],"HHE":["Haywards Heath",51.004904,-0.105399],"BAB":["Balcombe",51.055596,-0.137032],"TBD":["Three Bridges",51.117471,-0.161065],"GTW":["Gatwick Airport",51.156425,-0.161022],"HOR":["Horley",51.168791,-0.160952],"ARU":["Arundel",50.848003,-0.546796],"AMY":["Amberley",50.896507,-0.542446],"PUL":["Pulborough",50.957591,-0.516471],"BIG":["Billingshurst",51.015133,-0.449506],"CHH":["Christs Hospital",51.050629,-0.363538],"HRH":["Horsham",51.066174,-0.318753],"LVN":["Littlehaven",51.079514,-0.308276],"FGT":["Faygate",51.095943,-0.263403],"IFI":["Ifield",51.115538,-0.214465],"CRW":["Crawley",51.111874,-0.187083],"LRB":["London Road (Brighton)",50.836773,-0.136696],"MCB":["Moulsecoomb",50.846538,-0.119065],"FMR":["Falmer",50.862064,-0.087364],"LWS":["Lewes",50.870281,0.012455],"GLY":["Glynde",50.859118,0.070348],"BRK":["Berwick (Sussex)",50.840486,0.165724],"PLG":["Polegate",50.821128,0.246748],"HMD":["Hampden Park",50.795925,0.27968],"EBN":["Eastbourne",50.769443,0.281197],"SEE":["Southease",50.831284,0.03066],"NVN":["Newhaven Town",50.794888,0.054627],"NVH":["Newhaven Harbour",50.7898,0.055162],"BIP":["Bishopstone (Sussex)",50.78,0.0824],"SEF":["Seaford",50.772924,0.099946],"PEV":["Pevensey & Westham",50.815899,0.325291],"PEB":["Pevensey Bay",50.81767,0.343199],"NSB":["Normans Bay",50.82605,0.389576],"COB":["Cooden Beach",50.833371,0.426703],"CLL":["Collington",50.839272,0.457142],"BEX":["Bexhill",50.840679,0.475678],"SLQ":["St Leonards Warrior Square",50.855942,0.560326],"HGS":["Hastings",50.858303,0.576825],"ORE":["Ore",50.866864,0.591633],"TOK":["Three Oaks",50.900962,0.613218],"DLH":["Doleham",50.918625,0.610012],"WSE":["Winchelsea",50.933913,0.702519],"RYE":["Rye",50.952632,0.731021],"APD":["Appledore (Kent)",51.033287,0.816576],"AFK":["Ashford International",51.143353,0.875167],"WLD":["West St Leonards",50.853206,0.539964],"CWU":["Crowhurst",50.888702,0.500984],"BAT":["Battle",50.91312,0.495169],"RBR":["Robertsbridge",50.985554,0.468681],"ETC":["Etchingham",51.010479,0.441935],"SOG":["Stonegate",51.020184,0.364016],"WAD":["Wadhurst",51.07338,0.312483],"FRT":["Frant",51.104321,0.294034],"TBW":["Tunbridge Wells",51.130119,0.262435],"UCK":["Uckfield",50.968738,0.09663],"BXD":["Buxted",50.990475,0.131651],"COH":["Crowborough",51.046085,0.188422],"ERI":["Eridge",51.089024,0.200452],"PMP":["Plumpton",50.928463,-0.05981],"CBR":["Cooksbridge",50.903713,-0.009309]};

  var ROUTES = {
    wcw:  'BTN HOV AGT PLD FSG SWK SSE LAC EWR WRH WWO DUR GBS ANG FOD BAA CCH FSB BOH NUT SOB EMS WBL HAV',
    lit:  'BTN HOV AGT PLD FSG SWK SSE LAC EWR WRH WWO DUR GBS ANG LIT',
    bog:  'BAA BOG',
    bml:  'BTN PRP HSK BUG WVF HHE BAB TBD GTW HOR',
    arun: 'FOD ARU AMY PUL BIG CHH HRH LVN FGT IFI CRW TBD',
    ecw:  'BTN LRB MCB FMR LWS GLY BRK PLG HMD EBN',
    sef:  'LWS SEE NVN NVH BIP SEF',
    mlk:  'EBN HMD PEV PEB NSB COB CLL BEX SLQ HGS ORE TOK DLH WSE RYE APD AFK',
    hst:  'HGS SLQ WLD CWU BAT RBR ETC SOG WAD FRT TBW',
    uck:  'UCK BXD COH ERI',
    key:  'WVF PMP CBR LWS'
  };
  // [route, headcode, operator, kind, phase 0..1]
  var TRAINS = [
    ['wcw', '2W11', 'SN', 'stop', 0.02], ['wcw', '2W24', 'SN', 'stop', 0.27], ['wcw', '2W37', 'SN', 'stop', 0.52],
    ['wcw', '2W40', 'SN', 'stop', 0.77], ['wcw', '1F15', 'GW', 'fast', 0.40], ['wcw', '6Y42', 'GB', 'freight', 0.12],
    ['wcw', '3Q07', 'NR', 'fast', 0.66],
    ['lit', '2N12', 'SN', 'stop', 0.10], ['lit', '2N33', 'SN', 'stop', 0.60],
    ['bog', '2B05', 'SN', 'stop', 0.30],
    ['bml', '9J23', 'TL', 'fast', 0.05], ['bml', '9J41', 'TL', 'fast', 0.38], ['bml', '9R62', 'TL', 'fast', 0.71],
    ['bml', '1H15', 'SN', 'fast', 0.22], ['bml', '1H48', 'SN', 'fast', 0.88], ['bml', '2T19', 'SN', 'stop', 0.55],
    ['bml', '5H90', 'SN', 'fast', 0.95], ['bml', '0Z44', 'GB', 'freight', 0.47],
    ['arun', '1A27', 'SN', 'stop', 0.18], ['arun', '1A52', 'SN', 'stop', 0.68],
    ['ecw', '2E08', 'SN', 'stop', 0.08], ['ecw', '2E31', 'SN', 'stop', 0.42], ['ecw', '2E55', 'SN', 'stop', 0.75],
    ['ecw', '5E70', 'SN', 'fast', 0.30], ['ecw', '6E12', 'DB', 'freight', 0.85],
    ['sef', '2S14', 'SN', 'stop', 0.20], ['sef', '2S39', 'SN', 'stop', 0.70],
    ['mlk', '2C16', 'SN', 'stop', 0.12], ['mlk', '2C44', 'SN', 'stop', 0.47], ['mlk', '2C73', 'SN', 'stop', 0.81],
    ['hst', '1D29', 'SE', 'stop', 0.15], ['hst', '1D57', 'SE', 'stop', 0.50], ['hst', '1D84', 'SE', 'stop', 0.83],
    ['uck', '2U21', 'SN', 'stop', 0.35],
    ['key', '2K10', 'SN', 'stop', 0.60]
  ];
  var SPEED = { stop: 24, fast: 34, freight: 17 };    // m/s between stops
  var DWELL = 45, TURN = 360, BERTH_M = 800;

  function hav(a, b) {
    var R = 6371000, r = Math.PI / 180;
    var dLat = (b[1] - a[1]) * r, dLon = (b[2] - a[2]) * r;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function bearing(a, b) {
    var r = Math.PI / 180;
    var y = Math.sin((b[2] - a[2]) * r) * Math.cos(b[1] * r);
    var x = Math.cos(a[1] * r) * Math.sin(b[1] * r) - Math.sin(a[1] * r) * Math.cos(b[1] * r) * Math.cos((b[2] - a[2]) * r);
    return (Math.atan2(y, x) / r + 360) % 360;
  }

  // One full out-and-back cycle as a list of legs, each { t0, t1, kind, i, j, steps }.
  var plans = {};
  function plan(routeKey, kind) {
    var key = routeKey + '|' + kind;
    if (plans[key]) return plans[key];
    var codes = ROUTES[routeKey].split(' ');
    var legs = [], t = 0;
    [codes, codes.slice().reverse()].forEach(function (seq, dir) {
      for (var i = 0; i < seq.length - 1; i++) {
        var a = ST[seq[i]], b = ST[seq[i + 1]], len = hav(a, b);
        var dur = len / SPEED[kind];
        legs.push({ t0: t, t1: t + dur, move: true, a: seq[i], b: seq[i + 1], steps: Math.max(1, Math.round(len / BERTH_M)), dir: dir, origin: seq[0], dest: seq[seq.length - 1] });
        t += dur;
        var last = i === seq.length - 2;
        var wait = last ? TURN : (kind === 'stop' ? DWELL : 0);
        if (wait) { legs.push({ t0: t, t1: t + wait, move: false, a: seq[i + 1], b: seq[i + 1], prev: seq[i], dir: dir, origin: seq[0], dest: seq[seq.length - 1] }); t += wait; }
      }
    });
    plans[key] = { legs: legs, T: t };
    return plans[key];
  }

  var HM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  function hm(ms) { return HM.format(new Date(ms)); }

  function snapshot(nowMs) {
    var now = nowMs / 1000;
    var trains = TRAINS.map(function (d, n) {
      var p = plan(d[0], d[3]);
      var phase = ((now + d[4] * p.T) % p.T + p.T) % p.T;
      var leg = p.legs.filter(function (l) { return phase >= l.t0 && phase < l.t1; })[0] || p.legs[0];
      var a = ST[leg.a], b = ST[leg.b], lat, lon, placement, stepStart, heading, extra = {};
      if (leg.move) {
        var f = (phase - leg.t0) / (leg.t1 - leg.t0);
        var k = Math.floor(f * leg.steps);
        var g = k / leg.steps;
        lat = a[1] + (b[1] - a[1]) * g; lon = a[2] + (b[2] - a[2]) * g;
        stepStart = leg.t0 + k * (leg.t1 - leg.t0) / leg.steps;
        heading = bearing(a, b);
        if (k === 0) { placement = 'station'; extra.station = a[0]; }
        else { placement = 'interpolated'; extra.between = [a[0], b[0]]; }
      } else {
        lat = a[1]; lon = a[2]; stepStart = leg.t0; placement = 'station'; extra.station = a[0];
        heading = bearing(ST[leg.prev], a);
      }
      // The current leg's journey: start of this direction's run to its end.
      var dirLegs = p.legs.filter(function (l) { return l.dir === leg.dir; });
      var runStart = dirLegs[0].t0, runEnd = dirLegs[dirLegs.length - 1].t1 - (dirLegs[dirLegs.length - 1].move ? 0 : TURN);
      var t = {
        id: d[1], headcode: d[1],
        lat: +lat.toFixed(5), lon: +lon.toFixed(5), heading: Math.round(heading),
        area: 'DM', berth: String(1000 + (n * 37 + Math.round(phase / 60)) % 9000).slice(-4),
        lastStepAt: Math.round(nowMs - (phase - stepStart) * 1000),
        placement: placement,
        service: {
          origin: ST[leg.origin][0], destination: ST[leg.dest][0], operator: d[2],
          departs: hm(nowMs - (phase - runStart) * 1000), arrives: hm(nowMs + (runEnd - phase) * 1000)
        }
      };
      if (extra.station) t.station = extra.station;
      if (extra.between) t.between = extra.between;
      return t;
    });
    return {
      demo: true,
      region: { id: 'sussex', name: 'Sussex', bbox: [50.72, -0.96, 51.17, 0.87] },
      serverTime: nowMs, staleSecs: 600,
      feed: { connected: true, stale: false, staleSecs: 1 },
      areas: ['DM'], stats: { placed: trains.length }, trains: trains
    };
  }

  window.MAP_DEMO = { snapshot: snapshot };
})();
