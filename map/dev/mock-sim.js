'use strict';
// The simulated railway behind the mock service, with NO clock of its own: every call is given `now`.
// The HTTP mock (mock-api.js) drives it with the wall clock; the fixture recorder (record-fixture.js)
// drives it with a virtual clock, hours of railway in seconds. Same trains either way.
//
// What it serves is CONTRACT section 5 plus the phase-2 additions: Train.mv (a berth's motion plan),
// svc.late and svc.next, calls[] with actual and expected times, platform changes and cancelled calls,
// the station board, the span geometry and the line layer.
const path = require('path');
const geo = require('../geo.js');
const classes = require('../classes.js');
const T = require('./mock-track.js');
const engine = require('../engine.js');

// Real Sussex / South-East sequences (CRS codes), checked at start-up. `usage: 'branch'` marks the
// branch lines (East Grinstead, Uckfield, Caterham...) that the tile layer loses at low zoom.
const SUSSEX = [
  { cls: 'express', stops: ['VIC', 'GTW', 'HHE', 'BTN'], all: ['VIC', 'ECR', 'GTW', 'TBD', 'HHE', 'BTN'] },
  { cls: 'stopping', stops: null, all: ['VIC', 'CLJ', 'ECR', 'GTW', 'TBD', 'HHE', 'BUG', 'HSK', 'PRP', 'BTN'] },
  { cls: 'stopping', stops: null, all: ['BTN', 'HOV', 'PLD', 'SWK', 'SSE', 'LAC', 'EWR', 'WRH', 'WWO', 'GBS', 'ANG', 'BAA', 'BOG'] },
  { cls: 'stopping', stops: null, all: ['BTN', 'HOV', 'PLD', 'SWK', 'SSE', 'LAC', 'EWR', 'WRH', 'WWO', 'GBS', 'ANG', 'LIT'] },
  { cls: 'express', stops: ['BTN', 'WRH', 'CCH', 'PMS'], all: ['BTN', 'HOV', 'SSE', 'WRH', 'ANG', 'BAA', 'CCH', 'HAV', 'PMS'] },
  { cls: 'stopping', stops: null, all: ['BTN', 'FMR', 'LWS', 'GLY', 'PLG', 'EBN'] },
  { cls: 'stopping', stops: null, all: ['BTN', 'MCB', 'LWS', 'PLG', 'BEX', 'HGS'] },
  { cls: 'stopping', stops: null, all: ['BTN', 'PRP', 'HSK', 'BUG', 'HHE', 'TBD', 'CRW'] },
  { cls: 'freight', stops: [], all: ['HAV', 'CCH', 'BAA', 'ANG', 'WRH', 'SSE', 'HOV', 'PLD', 'BTN'] },
  { cls: 'ecs', stops: [], all: ['VIC', 'CLJ', 'ECR', 'GTW', 'HHE', 'BTN'] },
  { cls: 'special', stops: [], all: ['HHE', 'BUG', 'HSK', 'PRP', 'BTN'] },
  { cls: 'express', stops: ['LBG', 'ECR', 'GTW', 'BTN'], all: ['LBG', 'ECR', 'RDH', 'GTW', 'HHE', 'BTN'] },
  // branches
  { cls: 'stopping', stops: null, usage: 'branch', all: ['ECR', 'SNR', 'RDD', 'UWL', 'WOH', 'OXT', 'HUR', 'EGR'] },
  { cls: 'stopping', stops: null, usage: 'branch', all: ['ECR', 'SNR', 'RDD', 'UWL', 'WOH', 'OXT', 'EBT', 'CWN', 'ERI', 'COH', 'BXD', 'UCK'] },
  { cls: 'stopping', stops: null, usage: 'branch', all: ['ECR', 'PUR', 'KLY', 'WHY', 'CAT'] },
  { cls: 'stopping', stops: null, usage: 'branch', all: ['RDH', 'REI', 'DKG', 'HRH'] },
  { cls: 'stopping', stops: null, usage: 'branch', all: ['LWS', 'SEF'] }
];
const AREAS = ['LA', 'LB', 'LC', 'GA', 'EA', 'MC', 'WA', 'ZA'];
const TOCS = {
  express: ['GX', 'SN', 'GR', 'VT', 'XC', 'GW'], stopping: ['SN', 'TL', 'SE', 'SW', 'NT', 'LO'],
  ecs: ['SN', 'TL', 'SE'], freight: ['DB', 'GB', 'FL', 'DR'], special: ['NR']
};
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('');
const HC_DIGIT = { express: ['1', '1', '1', '9'], stopping: ['2'], ecs: ['5'], freight: ['4', '6', '6', '7', '8'], special: ['0', '3'] };
const clockFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/London' });
const clock = (ms) => clockFmt.format(new Date(ms)).replace(/^24/, '00');

function addMin(hhmm, m) {
  if (!hhmm) return null;
  const [h, mi] = hhmm.split(':').map(Number), tot = ((h * 60 + mi + m) % 1440 + 1440) % 1440;
  return String(Math.floor(tot / 60)).padStart(2, '0') + ':' + String(tot % 60).padStart(2, '0');
}

function createSim(o) {
  o = o || {};
  const COUNT = o.count == null ? 60 : o.count, NATIONAL = !!o.national;
  const timescale = o.timescale || 1;
  const noise = T.makeNoise(o.noise);
  let seed = o.seed == null ? 12345 : o.seed;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];

  const raw = require(path.join(__dirname, '../../map-service/data/stations.json')).stations;
  const STATIONS = Object.keys(raw).map((crs) => ({ tiploc: crs, crs, name: raw[crs].name, lat: +raw[crs].lat.toFixed(5), lon: +raw[crs].lon.toFixed(5) }));
  const BY_CRS = {}; STATIONS.forEach((s) => { BY_CRS[s.crs] = s; });
  SUSSEX.forEach((r) => r.all.forEach((c) => { if (!BY_CRS[c]) throw new Error('mock: unknown CRS ' + c); }));
  const world = T.createWorld(BY_CRS);

  function nearest(from, used, maxKm) {
    let best = null, bd = maxKm;
    for (let i = 0; i < STATIONS.length; i++) {
      const s = STATIONS[i];
      if (used.has(s.crs)) continue;
      const d = geo.haversineKm(from.lat, from.lon, s.lat, s.lon);
      if (d < bd && d > 1.2) { bd = d; best = s; }
    }
    return best;
  }
  function randomChain(cls) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const start = STATIONS[Math.floor(rnd() * STATIONS.length)];
      const used = new Set([start.crs]);
      const chain = [start];
      const len = 6 + Math.floor(rnd() * 14);
      for (let i = 0; i < len; i++) {
        const next = nearest(chain[chain.length - 1], used, cls === 'express' ? 45 : 22);
        if (!next) break;
        if (chain.length > 2) {
          const a = geo.bearing(chain[chain.length - 2].lat, chain[chain.length - 2].lon, chain[chain.length - 1].lat, chain[chain.length - 1].lon);
          const b = geo.bearing(chain[chain.length - 1].lat, chain[chain.length - 1].lon, next.lat, next.lon);
          if (Math.abs(((b - a + 540) % 360) - 180) > 100) { used.add(next.crs); i--; if (used.size > 400) break; continue; }
        }
        used.add(next.crs); chain.push(next);
      }
      // the south-east has its own named routes and branches; random chains there would draw lines no railway has
      if (chain.length >= 4 && !chain.some((c) => c.lat > 50.55 && c.lat < 51.8 && c.lon > -1.5 && c.lon < 1.4)) return chain.map((s) => s.crs);
    }
    return ['HOV', 'PLD', 'SWK'];
  }
  function headcode(cls) { return pick(HC_DIGIT[cls]) + pick(LETTERS) + String(Math.floor(rnd() * 100)).padStart(2, '0'); }
  function pickClass() {
    const r = rnd();
    return r < 0.22 ? 'express' : r < 0.7 ? 'stopping' : r < 0.8 ? 'ecs' : r < 0.94 ? 'freight' : 'special';
  }

  // ---- trains -----------------------------------------------------------------------------------
  const TRAINS = new Map();
  let nextId = 1, globalVer = 1, removedSince = [];
  const ts = (ms) => ms * timescale;

  function ensureRuns(t, until) {
    for (;;) {
      const last = t.runs[t.runs.length - 1];
      if (last && last.end > until) return;
      const dir = last ? 1 - last.dir : t.dir0;
      const run = T.genRun(world, t, dir, last ? last.end : t.start, t.rnd, noise);
      if (timescale !== 1) rescale(run);
      t.runs.push(run);
      run.berths.forEach((e) => { e.run = run; t.flat.push(e); });
    }
  }
  function rescale(run) {
    // timescale shrinks every duration (tests want a step every few hundred ms); delivery delay is kept as is
    let tt = run.start, nt = run.nomStart, last = 0;
    run.berths.forEach((e) => {
      const f = timescale;
      e.T *= f; e.Tm *= f; e.Tn *= f; e.hold *= f; e.D *= f; e.dNom *= f;
      e.t0 = tt; e.nom0 = nt; e.deliverAt = Math.max(tt + e.delay, last); last = e.deliverAt; tt += e.T; nt += e.Tn;
    });
    run.end = tt;
  }

  function makeTrain(route, now, phase, opt) {
    opt = opt || {};
    const cls = route.cls || pickClass();
    const id = 't' + (nextId++).toString(36) + Math.floor(rnd() * 36).toString(36);
    const trnd = T.mulberry(T.hash32(id) ^ seed);
    const stopsSet = route.stops ? new Set(route.stops) : null;
    const calls = new Set(stopsSet ? Array.from(stopsSet) : route.all);
    calls.add(route.all[0]); calls.add(route.all[route.all.length - 1]);
    let cancelled = null;
    if (cls === 'stopping' && route.all.length > 4 && trnd() < 0.08) {
      cancelled = route.all[1 + Math.floor(trnd() * (route.all.length - 2))];
      calls.delete(cancelled);
    }
    const t = {
      id, cls, hc: headcode(cls), route, calls, cancelled, rnd: trnd, pace: 0.9 + trnd() * 0.2,
      toc: pick(TOCS[cls]), hasSvc: cls !== 'special' && rnd() > 0.1, approx: rnd() < 0.05,
      prev: rnd() < 0.12 ? [headcode(cls)] : [], area: pick(AREAS), dir0: trnd() < 0.5 ? 0 : 1,
      firstSeenAt: now - rnd() * 600000, runs: [], flat: [], cursor: -1, ver: 0, berthN: Math.floor(rnd() * 900), uid: 'C' + id.toUpperCase().slice(0, 5),
      trail: []
    };
    t.area = route.all.every((c) => ['VIC', 'CLJ', 'ECR', 'GTW', 'TBD', 'HHE', 'BTN', 'HOV', 'PLD'].includes(c)) ? 'LA' : t.area;
    // where in its run the train is now: phase through the nominal duration of a run
    const defs = world.routeBerths(route.all, calls, t.dir0, route.usage);
    let dur = 0; defs.forEach((d) => { dur += T.nominal(d, cls, calls); });
    t.start = opt.start != null ? opt.start : now - phase * dur * 1000 * timescale;
    ensureRuns(t, now + 120000);
    // jump the cursor to the latest step already delivered
    t.cursor = 0;
    advance(t, now);
    t.ver = ++globalVer;
    t.wire = toWire(t, now); t.held = t.wire.mv ? t.wire.mv.held : false;
    return t;
  }

  // Deliver every step whose delivery time has come. Returns true if the train moved to a new berth.
  function advance(t, now) {
    ensureRuns(t, now + 120000);
    let moved = false;
    while (t.cursor + 1 < t.flat.length && t.flat[t.cursor + 1].deliverAt <= now) { t.cursor++; moved = true; }
    if (moved) {
      t.ver = ++globalVer;
      const e = t.flat[t.cursor];
      t.berthN++;
      const p = anchor(t, e);
      t.trail.push([+p.lat.toFixed(5), +p.lon.toFixed(5), e.t0]);
      if (t.trail.length > 40) t.trail.shift();
      if (t.cursor > 60) { t.flat.splice(0, 30); t.cursor -= 30; }
      if (t.runs.length > 4) t.runs.shift();
    }
    return moved;
  }

  // The phase-1 style placed position for the berth: the platform when it is a station berth, else mid-span.
  const prepCache = new Map();
  function prep(id) { let p = prepCache.get(id); if (!p) { p = engine.prepareSpan(world.SPANS.get(id)); prepCache.set(id, p); } return p; }
  function anchor(t, e) {
    const pre = prep(e.def.id);
    const atStation = e.def.callsAtEnd || e.def.callsAtStart;
    const s = e.def.callsAtEnd ? pre.length : e.def.callsAtStart ? 0 : pre.length / 2;
    const q = engine.locate(pre, s, { x: 0, y: 0, brg: 0 });
    const hdg = engine.bearingAt(pre, s, 12);
    return { lat: q.y, lon: q.x, hdg: Math.round(hdg), pl: atStation ? 's' : 'i' };
  }

  function stopOf(e) { return e.def.callsAtEnd ? e.def.length : e.def.callsAtStart ? 0 : null; }
  function mvOf(t, e, now) {
    const stop = stopOf(e), eta = Math.round(e.t0 + e.Tn);
    const next = t.flat[t.cursor + 1];
    const heldAfter = Math.max(30000, 0.4 * e.Tn);
    return { sp: e.def.id, t0: Math.round(e.t0), eta, stop: stop == null ? null : Math.round(stop * 10) / 10,
      dwell: stop == null ? null : Math.round(e.dNom), held: !!(next && now > eta + heldAfter && next.deliverAt > now) };
  }

  // ---- the timetable view of a train: calls with booked / actual / expected times ---------------------
  function runOf(t) { return t.flat[t.cursor].run; }
  function nowLate(t) { const e = t.flat[t.cursor]; return e.t0 - e.nom0; }
  function callsOf(t, now) {
    const run = runOf(t), seq = run.dir ? t.route.all.slice().reverse() : t.route.all;
    const e0 = t.flat[t.cursor], late = nowLate(t);
    const out = [];
    for (let j = 0; j < seq.length; j++) {
      const crs = seq[j], st = BY_CRS[crs];
      const arrBerth = j > 0 ? run.berths.find((b) => b.def.arrival && b.def.to === crs) : null;
      const depBerth = j < seq.length - 1 ? run.berths.find((b) => b.def.depart && b.def.from === crs) : null;
      const calls = t.calls.has(crs);
      let bookedArr = null, bookedDep = null, actArr = null, actDep = null, actPass = null;
      if (arrBerth) {
        const endNom = arrBerth.nom0 + arrBerth.Tn;
        if (calls) { bookedArr = endNom - arrBerth.dNom; bookedDep = j < seq.length - 1 ? endNom : null; }
        else bookedDep = endNom;
        const nextB = run.berths[run.berths.indexOf(arrBerth) + 1];
        const appr = arrBerth.t0 + arrBerth.Tm - arrBerth.D;
        if (calls && now >= appr + 4000 && run.berths.indexOf(arrBerth) <= run.berths.indexOf(e0)) actArr = appr;
        if (nextB && nextB.deliverAt <= now) { if (calls) actDep = nextB.t0; else actPass = nextB.t0; }
      } else if (depBerth) { bookedDep = depBerth.nom0; if (depBerth.deliverAt <= now) actDep = depBerth.t0; }
      const cancelled = t.cancelled === crs;
      const plat = String(1 + (crs.charCodeAt(0) + j) % 6);
      const platChanged = calls && ((T.hash32(t.id + crs) % 9) === 0);
      const exp = (b) => b == null ? null : clock(Math.max(now, b + late));
      const isPass = !calls;
      out.push({
        name: st.name, tiploc: st.tiploc,
        arr: calls && bookedArr != null ? clock(bookedArr) : null,
        dep: calls && bookedDep != null ? clock(bookedDep) : null,
        pass: isPass ? clock(bookedDep != null ? bookedDep : bookedArr) : null,
        platform: calls || cancelled ? plat : null,
        actualArr: actArr != null ? clock(actArr) : null, actualDep: calls && actDep != null ? clock(actDep) : null,
        actualPass: isPass && actPass != null ? clock(actPass) : null,
        expArr: calls && actArr == null && bookedArr != null ? exp(bookedArr) : null,
        expDep: calls && actDep == null && bookedDep != null ? exp(bookedDep) : null,
        platformActual: platChanged ? String(1 + (+plat) % 6) : null,
        cancelled: cancelled || undefined,
        _bookedArr: bookedArr, _calls: calls, _j: j, _crs: crs
      });
    }
    return out;
  }
  function nextCall(t, now) {
    const calls = callsOf(t, now), e = t.flat[t.cursor], run = e.run;
    const seq = run.dir ? t.route.all.slice().reverse() : t.route.all;
    const toIdx = seq.indexOf(e.def.to);
    for (let j = Math.max(1, toIdx); j < calls.length; j++) {
      const c = calls[j];
      if (c._calls && c.actualArr == null && c._bookedArr != null) {
        return { name: c.name, time: c.arr, exp: c.expArr || c.arr, crs: c._crs };
      }
    }
    return null;
  }

  function toWire(t, now) {
    const e = t.flat[t.cursor], p = anchor(t, e);
    const o = { id: t.id, hc: t.hc, lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5), hdg: p.hdg, area: t.area,
      berth: String(1000 + (t.berthN % 9000)).padStart(4, '0'), at: Math.round(e.t0), pl: p.pl };
    if (t.approx) {                                  // a train with no span: phase-1 position only, roughly placed
      o.pl = 'a'; o.lat = +(o.lat + (T.mulberry(T.hash32(t.id + e.def.id))() - 0.5) * 0.004).toFixed(5);
    } else o.mv = mvOf(t, e, now);
    if (t.hasSvc) {
      const run = e.run, seq = run.dir ? t.route.all.slice().reverse() : t.route.all;
      const o0 = BY_CRS[seq[0]], d0 = BY_CRS[seq[seq.length - 1]];
      o.svc = {
        uid: t.uid, toc: t.toc, o: o0.name, d: d0.name, dep: clock(run.berths[0].nom0), arr: clock(run.berths[run.berths.length - 1].nom0 + run.berths[run.berths.length - 1].Tn),
        cat: t.cls === 'freight' || t.cls === 'ecs' ? 'EE' : 'OO', pwr: t.cls === 'freight' ? 'D' : 'EMU', load: t.cls === 'freight' ? '' : '377'
      };
      if (t.cls === 'express' || t.cls === 'stopping') {
        o.svc.late = Math.round(nowLate(t) / 60000);
        const nx = nextCall(t, now);
        if (nx) o.svc.next = { name: nx.name, time: nx.time, exp: nx.exp };
      }
    }
    return o;
  }

  function detail(t, now) {
    const w = toWire(t, now), e = t.flat[t.cursor], run = e.run;
    const seq = run.dir ? t.route.all.slice().reverse() : t.route.all;
    const calls = callsOf(t, now).map((c) => { const x = Object.assign({}, c); Object.keys(x).forEach((k) => { if (k[0] === '_' || x[k] === undefined) delete x[k]; }); return x; });
    const toIdx = seq.indexOf(e.def.to), fromIdx = seq.indexOf(e.def.from);
    let place;
    if (w.pl === 's') { const c = e.def.callsAtEnd ? e.def.to : e.def.from; place = { kind: 'station', station: { crs: c, name: BY_CRS[c].name } }; }
    else if (w.pl === 'a') place = { kind: 'near', station: { crs: e.def.from, name: BY_CRS[e.def.from].name } };
    else place = { kind: 'between', between: [fromIdx, toIdx].map((i) => ({ crs: seq[i], name: BY_CRS[seq[i]].name })) };
    const service = t.hasSvc ? {
      uid: t.uid, stp: 'P', toc: t.toc, headcode: t.hc, category: w.svc.cat, power: w.svc.pwr, timingLoad: w.svc.load,
      speedMph: t.cls === 'express' ? 100 : 75,
      origin: { name: BY_CRS[seq[0]].name, time: w.svc.dep }, destination: { name: BY_CRS[seq[seq.length - 1]].name, time: w.svc.arr }, calls
    } : null;
    const spd = e.def.callsAtEnd || e.def.callsAtStart ? null : Math.round(e.def.length / (e.Tm / 1000) * 2.237);
    const berths = [];
    for (let i = t.cursor; i >= 0 && berths.length < 20; i--) {
      const b = t.flat[i];
      berths.push({ area: t.area, berth: String(1000 + ((t.berthN - (t.cursor - i)) % 9000)).padStart(4, '0'), at: Math.round(b.t0), sp: b.def.id });
    }
    return {
      train: w, previousHeadcodes: t.prev, firstSeenAt: Math.round(t.firstSeenAt), recentBerths: berths, trail: t.trail.slice(-30),
      service, place, speedMphEstimate: spd
    };
  }

  // ---- station boards ---------------------------------------------------------------------------
  function board(crs, now) {
    const st = BY_CRS[crs];
    if (!st) return null;
    const rows = [], recent = [];
    TRAINS.forEach((t) => {
      if (!t.route.all.includes(crs)) return;
      const run = runOf(t), seq = run.dir ? t.route.all.slice().reverse() : t.route.all;
      const j = seq.indexOf(crs);
      if (j < 0) return;
      const calls = callsOf(t, now), c = calls[j];
      const late = Math.round(nowLate(t) / 60000);
      const push = (kind, bookedStr, expStr, actStr) => {
        const book = bookedStr;
        if (!book) return;
        const [hh, mm] = book.split(':').map(Number);
        const d = new Date(now);
        const lon = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/London' }));
        let ms = now + ((hh * 60 + mm) - (lon.getHours() * 60 + lon.getMinutes())) * 60000;
        if (ms < now - 12 * 3600000) ms += 86400000; if (ms > now + 12 * 3600000) ms -= 86400000;
        const row = {
          trainId: ms < now + 40 * 60000 ? t.id : null, hc: t.hc, uid: t.uid, toc: t.toc,
          o: BY_CRS[seq[0]].name, d: BY_CRS[seq[seq.length - 1]].name, kind, booked: book,
          expected: actStr ? null : expStr, actual: actStr || null, platform: c.platformActual || c.platform || null,
          late: actStr ? null : late, cancelled: !!c.cancelled
        };
        if (ms >= now - 30 * 60000 && ms <= now + 120 * 60000) rows.push({ ms, row });
        if (actStr && ms >= now - 30 * 60000) recent.push({ ms, hc: t.hc, kind, time: actStr, late: Math.round((late)) });
      };
      if (c._calls) {
        if (j > 0) push('arr', c.arr, c.expArr, c.actualArr);
        if (j < seq.length - 1) push('dep', c.dep, c.expDep, c.actualDep);
      } else push('pass', c.pass, addMin(c.pass, late), c.actualPass);
    });
    rows.sort((a, b) => a.ms - b.ms); recent.sort((a, b) => b.ms - a.ms);
    return { station: { crs: st.crs, name: st.name, lat: st.lat, lon: st.lon }, board: rows.slice(0, 60).map((r) => r.row), recent: recent.slice(0, 12).map((r) => ({ hc: r.hc, kind: r.kind, time: r.time, late: r.late })) };
  }

  // ---- population -------------------------------------------------------------------------------
  let spawnCount = 0;
  const routeUse = new Map();
  function spawn(now) {
    let route, slots;
    if (!NATIONAL || spawnCount < SUSSEX.length * 3) { route = SUSSEX[spawnCount % SUSSEX.length]; slots = NATIONAL ? 3 : Math.max(1, Math.ceil(COUNT / SUSSEX.length)); }
    else {
      const cls = pickClass();
      route = { cls, stops: cls === 'express' ? null : cls === 'stopping' ? null : [], all: randomChain(cls) };
      if (cls === 'express') route.stops = [route.all[0], route.all[Math.floor(route.all.length / 2)], route.all[route.all.length - 1]];
      slots = 1;
    }
    spawnCount++;
    const key = route.all.join('-'), n = routeUse.get(key) || 0;
    routeUse.set(key, n + 1);
    const t = makeTrain(route, now, ((n % slots) + rnd() * 0.8 + 0.1) / slots);
    TRAINS.set(t.id, t);
    return t;
  }
  // Put `n` extra trains standing at the platforms of one station (different routes: different headings),
  // for checking how stacked trains look.
  function stackAt(crs, n, now) {
    const routes = SUSSEX.filter((r) => r.all[0] === crs || r.all[r.all.length - 1] === crs);
    let made = 0;
    for (let k = 0; k < 40 && made < n; k++) {
      const route = routes[k % routes.length];
      if (!route) break;
      const atEnd = route.all[route.all.length - 1] === crs;
      const dir0 = atEnd ? 0 : 1;
      const t0 = makeTrain(Object.assign({}, route, { cls: route.cls }), now, 0, { start: now - 1 });
      TRAINS.delete(t0.id);
      t0.dir0 = dir0; t0.runs = []; t0.flat = []; t0.cursor = 0;
      // start so that `now` falls in the long wait at the terminus: just before the end of the run
      const defs = world.routeBerths(route.all, t0.calls, dir0, route.usage);
      let dur = 0; defs.forEach((d) => { dur += T.nominal(d, t0.cls, t0.calls); });
      t0.start = now - (dur - 90) * 1000 * timescale;
      ensureRuns(t0, now + 120000);
      t0.cursor = 0; advance(t0, now);
      const e = t0.flat[t0.cursor];
      if (!(e.def.callsAtEnd && e.def.terminus)) continue;
      TRAINS.set(t0.id, t0); made++;
    }
    return made;
  }
  // Make a train late for real: every later step is pushed back `secs` (it stands at a signal).
  function holdTrain(id, secs, now) {
    const t = TRAINS.get(id);
    if (!t) return false;
    for (let i = t.cursor + 1; i < t.flat.length; i++) { t.flat[i].t0 += secs * 1000; t.flat[i].deliverAt += secs * 1000; }
    t.runs.forEach((r) => { r.end += secs * 1000; });
    void now;
    return true;
  }
  function init(now) {
    for (let i = 0; i < COUNT; i++) spawn(now);
  }
  let tickN = 0;
  function tick(now) {
    tickN++;
    TRAINS.forEach((t) => {
      const moved = advance(t, now);
      const e = t.flat[t.cursor], heldNow = !t.approx && mvOf(t, e, now).held;
      if (moved || heldNow !== t.held || (tickN % 30 === 0 && t.hasSvc)) {
        if (!moved) t.ver = ++globalVer;
        t.held = heldNow; t.wire = toWire(t, now);
      }
    });
    if (tickN % 15 === 0 && TRAINS.size > 5) {
      const ids = Array.from(TRAINS.keys()), gone = ids[Math.floor(rnd() * ids.length)];
      TRAINS.delete(gone); removedSince.push(gone);
      spawn(now);
    }
  }
  function takeRemoved() { const r = removedSince; removedSince = []; return r; }

  return {
    STATIONS, BY_CRS, TRAINS, init, holdTrain, tick, takeRemoved, toWire, wireOf: (t) => t.wire, detail, board, stackAt, spawn,
    get ver() { return globalVer; }, span: (id) => world.SPANS.get(id) || null, network: (level) => world.network(level), world,
    searchRows: () => Array.from(TRAINS.values()).map((t) => {
      const seq = t.route.all; return { id: t.id, hc: t.hc, o: BY_CRS[seq[0]].name, d: BY_CRS[seq[seq.length - 1]].name };
    })
  };
}

module.exports = { createSim, SUSSEX, clock };
void classes;
