// Station importance (which names to show first) and station search. Pure.
// Browser: window.RM.stations. Node: require().
(function (root) {
  'use strict';

  // The service gives us name and position, not size, so "major" is a short hand-kept list of the
  // stations most people mean when they say "the station in <city>": big hubs and city centres.
  // Listed by NAME (as spelt in the station data) rather than by three-letter code, because names
  // can be checked by eye and by a test; a wrong code silently promotes the wrong station.
  // Tier 1 names show from the national view; tier 2 once you are looking at a region; everything
  // else once you are looking at a town. A name that would collide with a more important one is
  // dropped by the map's label collision test, so this only sets the order of preference.
  var TIER1 = ['London Paddington', 'London Euston', 'London Kings Cross', 'London St Pancras International',
    'London Waterloo', 'London Victoria', 'London Liverpool Street', 'London Bridge', 'London Charing Cross',
    'London Marylebone', 'Birmingham New Street', 'Manchester Piccadilly', 'Leeds', 'Liverpool Lime Street',
    'Glasgow Central', 'Edinburgh Waverley', 'Newcastle', 'Bristol Temple Meads', 'Cardiff Central', 'Sheffield',
    'Nottingham', 'York', 'Southampton Central', 'Brighton', 'Reading', 'Exeter St Davids', 'Plymouth', 'Norwich',
    'Aberdeen', 'Inverness', 'Carlisle', 'Crewe', 'Preston', 'Leicester', 'Cambridge', 'Oxford', 'Gatwick Airport',
    'Swansea', 'Penzance', 'Stirling', 'Perth', 'Dundee', 'Doncaster', 'Peterborough', 'Derby', 'Bournemouth',
    'Portsmouth & Southsea', 'Salisbury', 'Milton Keynes Central', 'Coventry', 'Hull', 'Middlesbrough', 'Ipswich',
    'Bath Spa', 'Glasgow Queen Street', 'Manchester Victoria', 'Stoke-On-Trent', 'Wolverhampton', 'Lincoln Central',
    'Hereford', 'Gloucester', 'Shrewsbury', 'Chester', 'Holyhead', 'Aberystwyth', 'Fort William', 'Oban', 'Thurso',
    'Wick', 'Kyle of Lochalsh', 'Mallaig', 'Newquay', 'Truro', 'Barrow-In-Furness', 'Carmarthen'];
  var TIER2 = ['Clapham Junction', 'East Croydon', 'London Blackfriars', 'London Cannon Street',
    'London Fenchurch Street', 'Stratford (London)', 'Haywards Heath', 'Worthing', 'Lewes', 'Eastbourne', 'Hastings',
    'Havant', 'Chichester', 'Bognor Regis', 'Littlehampton', 'Ashford International', 'Tonbridge', 'Maidstone East',
    'Canterbury West', 'Dover Priory', 'Folkestone Central', 'Ramsgate', 'Margate', 'Dartford', 'Gravesend', 'Chatham',
    'Redhill', 'Three Bridges', 'Crawley', 'Horsham', 'Shoreham-By-Sea', 'Hove', 'Portslade', 'Basingstoke', 'Woking',
    'Guildford', 'Winchester', 'Twickenham', 'Wimbledon', 'Slough', 'Maidenhead', 'Didcot Parkway', 'Swindon',
    'Cheltenham Spa', 'Taunton', 'Weston-Super-Mare', 'Newport (South Wales)', 'Bridgend', 'Weymouth', 'Poole',
    'Chelmsford', 'Colchester', 'Southend Central', 'Southend Victoria', 'Ely', 'Kings Lynn', 'Stevenage',
    'Welwyn Garden City', 'Luton', 'Bedford', 'Northampton', 'Rugby', 'Watford Junction', 'Wigan North Western',
    'Bolton', 'Blackpool North', 'Lancaster', 'Blackburn', 'Huddersfield', 'Halifax', 'Bradford Interchange',
    'Wakefield Westgate', 'Harrogate', 'Scarborough', 'Darlington', 'Durham', 'Sunderland', 'Berwick-Upon-Tweed',
    'Alnmouth', 'Motherwell', 'Falkirk High', 'Kilmarnock', 'Ayr', 'Dumfries', 'Kirkcaldy', 'Dunblane', 'Arbroath',
    'Montrose', 'Elgin', 'Nuneaton', 'Tamworth', 'Stafford', 'Telford Central', 'Worcester Shrub Hill', 'Banbury',
    'Leamington Spa', 'Stratford-upon-Avon', 'Kettering', 'Grantham', 'Newark Northgate', 'Retford', 'Scunthorpe',
    'Grimsby Town', 'Skegness', 'Loughborough', 'Cambridge North', 'Stansted Airport', 'Heathrow Terminal 5 Rail',
    'Southampton Airport Parkway', 'Gillingham (Kent)', 'Tunbridge Wells', 'Orpington', 'Bromley South', 'Sevenoaks',
    'Hitchin', 'High Wycombe', 'Aylesbury', 'Newbury', 'Exeter Central', 'Barnstaple', 'Paignton', 'Newton Abbot',
    'Torquay', 'Falmouth Docks', 'St Erth', 'Par', 'Bodmin Parkway', 'Yeovil Junction', 'Bristol Parkway',
    'Llandudno', 'Rhyl', 'Wrexham General', 'Merthyr Tydfil', 'Port Talbot Parkway', 'Llanelli', 'Abergavenny',
    'Kidderminster', 'Great Malvern', 'Chesterfield', 'Mansfield', 'Barnsley', 'Hexham', 'Whitby', 'Morpeth',
    'Paisley Gilmour Street', 'Stranraer'];

  var BY_NAME = {};
  TIER2.forEach(function (n) { BY_NAME[n] = 2; });
  TIER1.forEach(function (n) { BY_NAME[n] = 1; });

  // Tier of a station object ({name, ...}); 3 when not on either list.
  function tierOf(s) {
    return (s && Object.prototype.hasOwnProperty.call(BY_NAME, s.name)) ? BY_NAME[s.name] : 3;
  }
  // First zoom at which a station's NAME may appear. Dots show a little earlier.
  var NAME_MIN_ZOOM = { 1: 5.2, 2: 8, 3: 10 };
  var DOT_MIN_ZOOM = { 1: 4, 2: 6.5, 3: 8.5 };
  function nameMinZoom(s) { return NAME_MIN_ZOOM[tierOf(s)]; }
  function dotMinZoom(s) { return DOT_MIN_ZOOM[tierOf(s)]; }

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/['’.]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // Rank: exact CRS, name starts with query, a word starts with it, anywhere in the name.
  // Ties: more important station first, then shorter name.
  function searchStations(list, q, limit) {
    var nq = norm(q);
    if (!nq) return [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var name = s._n || (s._n = norm(s.name));
      var score = -1;
      if (nq.length === 3 && s.crs && s.crs.toLowerCase() === nq) score = 0;
      else if (name.indexOf(nq) === 0) score = 1;
      else if (name.indexOf(' ' + nq) >= 0) score = 2;
      else if (nq.length >= 3 && name.indexOf(nq) >= 0) score = 3;
      if (score >= 0) out.push({ s: s, k: score * 10 + tierOf(s) });
    }
    out.sort(function (a, b) { return a.k - b.k || a.s.name.length - b.s.name.length; });
    return out.slice(0, limit || 8).map(function (x) { return x.s; });
  }

  // Headcode prefix match over a list of {id, hc, ...}. Case-insensitive.
  function searchTrains(list, q, limit) {
    var hq = String(q || '').trim().toUpperCase();
    if (!hq) return [];
    var out = [];
    for (var i = 0; i < list.length && out.length < (limit || 8); i++) {
      if (list[i].hc && list[i].hc.indexOf(hq) === 0) out.push(list[i]);
    }
    return out;
  }

  var api = {
    TIER1: TIER1, TIER2: TIER2, tierOf: tierOf, nameMinZoom: nameMinZoom, dotMinZoom: dotMinZoom,
    norm: norm, searchStations: searchStations, searchTrains: searchTrains
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.RM = root.RM || {}).stations = api;
})(typeof self !== 'undefined' ? self : this);
