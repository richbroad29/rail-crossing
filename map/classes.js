// What a headcode and an operator code mean, in plain words. Pure data and lookups.
// Browser: window.RM.classes. Node: require().
(function (root) {
  'use strict';

  // The first character of a headcode is the train's class. That is nearly all the signalling
  // system tells us about a train, and it is enough to colour the map.
  // `colour` is the same on both themes; the halo drawn around each train keeps it legible.
  var CLASSES = {
    express:  { key: 'express',  chip: 'Express',  label: 'Express passenger',
                colour: '#2f7cf6', meaning: 'A fast passenger train that skips most small stations.' },
    stopping: { key: 'stopping', chip: 'Stopping', label: 'Stopping passenger',
                colour: '#16a870', meaning: 'A passenger train that calls at most or all stations on its route.' },
    ecs:      { key: 'ecs',      chip: 'Empty',    label: 'Empty train',
                colour: '#8b96a8', meaning: 'A passenger train with no passengers on board, usually moving to or from a depot.' },
    freight:  { key: 'freight',  chip: 'Freight',  label: 'Freight',
                colour: '#f08c1a', meaning: 'A goods train, such as stone, containers, fuel or steel.' },
    special:  { key: 'special',  chip: 'Special',  label: 'Light engine or special',
                colour: '#b05cf0', meaning: 'A locomotive running on its own, a test train, or another special working.' },
    other:    { key: 'other',    chip: 'Other',    label: 'Unclassified',
                colour: '#d4d9e1', meaning: 'The signalling system gave this train a code we cannot read as a normal headcode.' }
  };
  var ORDER = ['express', 'stopping', 'ecs', 'freight', 'special', 'other'];

  // A standard headcode is digit, letter, digit, digit: "1H15".
  var HEADCODE_RE = /^[0-9][A-Z][0-9]{2}$/;

  function classOf(hc) {
    if (typeof hc !== 'string' || !HEADCODE_RE.test(hc)) return 'other';
    var c = hc.charAt(0);
    if (c === '1' || c === '9') return 'express';
    if (c === '2') return 'stopping';
    if (c === '5') return 'ecs';
    if (c === '4' || c === '6' || c === '7' || c === '8') return 'freight';
    return 'special';                                  // 0 light engine, 3 test / special
  }
  function classInfo(hc) { return CLASSES[classOf(hc)]; }
  function indexOfClass(key) { var i = ORDER.indexOf(key); return i < 0 ? ORDER.length - 1 : i; }

  // A sentence for the details panel. The first digit carries the meaning; say so.
  function explainHeadcode(hc) {
    var info = classInfo(hc);
    if (info.key === 'other') {
      return { cls: info, text: info.meaning };
    }
    var d = hc.charAt(0);
    var tail = {
      '0': 'A "0" headcode is a locomotive running without any wagons or coaches.',
      '1': 'A "1" headcode means an express passenger train.',
      '2': 'A "2" headcode means an ordinary stopping passenger train.',
      '3': 'A "3" headcode is used for special workings such as test trains.',
      '4': 'A "4" headcode means a freight train.',
      '5': 'A "5" headcode means empty coaching stock: a passenger train with nobody on board.',
      '6': 'A "6" headcode means a freight train.',
      '7': 'A "7" headcode means a freight train.',
      '8': 'A "8" headcode means a freight train.',
      '9': 'A "9" headcode means a passenger train on a busy route, for example Thameslink.'
    }[d];
    return { cls: info, text: tail };
  }

  // The short explanation behind the "?" next to a headcode.
  var HEADCODE_HELP =
    'A headcode is the four-character code, like 1H15, that signallers use to identify a train. ' +
    'The first digit says what kind of train it is. It is not the same as a train number on a ticket.';
  var BERTH_HELP =
    'Railway signalling splits the track into short sections called berths. Each berth has a code, ' +
    'and the system records which berth every train is in. That is how we know roughly where a train is.';

  // ATOC / train operator codes as they appear in timetable data.
  // Anything not listed is shown as its raw code rather than guessed at.
  var OPERATORS = {
    AW: 'Transport for Wales', CC: 'c2c', CH: 'Chiltern Railways', CS: 'Caledonian Sleeper',
    EM: 'East Midlands Railway', ES: 'Eurostar', GC: 'Grand Central', GN: 'Great Northern',
    GR: 'LNER', GW: 'Great Western Railway', GX: 'Gatwick Express', HC: 'Heathrow Connect',
    HT: 'Hull Trains', HX: 'Heathrow Express', IL: 'Island Line', LD: 'Lumo', LE: 'Greater Anglia',
    LM: 'West Midlands Trains', LO: 'London Overground', LT: 'London Underground', ME: 'Merseyrail',
    NT: 'Northern', SE: 'Southeastern', SN: 'Southern', SR: 'ScotRail', SW: 'South Western Railway',
    TL: 'Thameslink', TP: 'TransPennine Express', VT: 'Avanti West Coast', XC: 'CrossCountry',
    XR: 'Elizabeth line', NR: 'Network Rail',
    DB: 'DB Cargo UK', GB: 'GB Railfreight', FL: 'Freightliner', DR: 'Direct Rail Services'
  };
  function operatorName(code) {
    if (typeof code !== 'string' || !code) return null;
    var c = code.toUpperCase();
    return Object.prototype.hasOwnProperty.call(OPERATORS, c) ? OPERATORS[c] : null;
  }
  // For display: the name if known, else the raw code in words.
  function operatorLabel(code) {
    var n = operatorName(code);
    if (n) return n;
    return code ? 'Operator code ' + code : null;
  }

  // Station names from reference data are sometimes SHOUTED. Tidy only those.
  function titleCase(s) {
    if (typeof s !== 'string') return '';
    if (/[a-z]/.test(s) || !/[A-Z]{3}/.test(s)) return s;
    return s.toLowerCase().replace(/(^|[\s\-(/&.])([a-z])/g, function (m, p, c) { return p + c.toUpperCase(); });
  }

  var POWER = { EMU: 'electric multiple unit', DMU: 'diesel multiple unit', D: 'diesel', E: 'electric',
                DEM: 'diesel-electric multiple unit', HST: 'High Speed Train', EML: 'electric multiple unit' };
  function powerLabel(p) {
    if (!p) return null;
    return Object.prototype.hasOwnProperty.call(POWER, p) ? POWER[p] : null;
  }

  var api = {
    CLASSES: CLASSES, ORDER: ORDER, classOf: classOf, classInfo: classInfo, indexOfClass: indexOfClass,
    explainHeadcode: explainHeadcode, HEADCODE_HELP: HEADCODE_HELP, BERTH_HELP: BERTH_HELP,
    OPERATORS: OPERATORS, operatorName: operatorName, operatorLabel: operatorLabel,
    titleCase: titleCase, powerLabel: powerLabel
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.RM = root.RM || {}).classes = api;
})(typeof self !== 'undefined' ? self : this);
