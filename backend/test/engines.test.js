'use strict';

// Berth-first v1 step 1, "the seam" (docs/berth-first-v1-plan.md §2-3 on main): the per-crossing
// engine setting, the routes file a berth-first crossing must have, the extra TD areas the listener
// then hears, and a shadow engine fed the same inputs and only logged.
//
// The property that matters most is the negative one: with no shadow configured nothing changes,
// and with one configured nothing it does — including throwing on every call — can reach the
// serving engine or the page.

const fs = require('fs');
const os = require('os');
const path = require('path');
require('../src/logger').logHeld = function () {};
const defs = require('../src/crossing-definitions');
const { crossingTdAreas } = require('../src/td-paths');
const { CrossingEngines, FACTORIES, _copyForTest } = require('../src/engines');
const { BerthFirstEngine } = require('../src/berth-first/engine');
const CrossingState = require('../src/crossing-state');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  if (actual === expected) { console.log(`  PASS  ${label}`); pass++; }
  else {
    console.log(`  FAIL  ${label}`);
    console.log(`          got:      ${actual}`);
    console.log(`          expected: ${expected}`);
    fail++;
  }
}
const throws = fn => { try { fn(); return null; } catch (e) { return e.message; } };

const crossings = defs.loadCrossings();
const portslade = crossings.portslade;
const withKeys = extra => ({ ...JSON.parse(JSON.stringify(portslade)), ...extra });

console.log('\nEngine setting\n');
{
  check('Portslade as shipped: engine classic', defs.engineOf(portslade), 'classic');
  check('  ...no shadow', defs.shadowEngineOf(portslade), null);
  check('  ...does not use berth-first', defs.usesBerthFirst(portslade), false);
  check('  ...no definition problems', defs.definitionProblems(portslade).length, 0);
  check('shadowEngine berth-first is accepted',
    defs.definitionProblems(withKeys({ shadowEngine: 'berth-first' })).length, 0);
  check('engine berth-first is refused while it is a stub',
    /cannot serve a page yet/.test(defs.definitionProblems(withKeys({ engine: 'berth-first' })).join()), true);
  check('engine classic, said explicitly, is accepted', defs.definitionProblems(withKeys({ engine: 'classic' })).length, 0);
  check('a shadow that is the serving engine is refused',
    /already serves/.test(defs.definitionProblems(withKeys({ shadowEngine: 'classic' })).join()), true);
  check('an unknown engine name is refused',
    /must be one of/.test(defs.definitionProblems(withKeys({ shadowEngine: 'berthfirst' })).join()), true);
}

console.log('\nRoutes file\n');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engines-test-'));
  const write = (f, o) => fs.writeFileSync(path.join(dir, f), JSON.stringify(o));
  write('portslade.json', withKeys({ shadowEngine: 'berth-first' }));
  check('berth-first without a routes file is refused at load',
    /routes file portslade\.routes\.json could not be read/.test(throws(() => defs.loadCrossings(dir))), true);
  write('portslade.routes.json', { areas: ['LA', 'tb'] });
  check('a routes file with a bad area id is refused',
    /"tb" is not a TD area id/.test(throws(() => defs.loadCrossings(dir))), true);
  write('portslade.routes.json', { areas: [] });
  check('a routes file with no areas is refused', /non-empty/.test(throws(() => defs.loadCrossings(dir))), true);
  write('portslade.routes.json', { areas: ['LA', 'TB'] });
  check('with a good routes file it loads', throws(() => defs.loadCrossings(dir)), null);
  check('  ...the routes file is not taken for a crossing of its own', Object.keys(defs.loadCrossings(dir)).join(), 'portslade');
  check('  ...loadRoutesFor returns its areas', defs.loadRoutesFor(defs.loadCrossings(dir), dir).portslade.areas.join(), 'LA,TB');
  check('a classic-only crossing needs no routes file', Object.keys(defs.loadRoutesFor(crossings)).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\nAreas the listener hears\n');
{
  check('Portslade as shipped: LA only, as before', crossingTdAreas(crossings).join(), 'LA');
  check('with berth-first routes: LA then the routes\' other areas',
    crossingTdAreas(crossings, { portslade: { areas: ['TB', 'LA'] } }).join(), 'LA,TB');
}

// --- the engines -------------------------------------------------------------------------------
const T0 = Date.now();
const iso = ms => new Date(ms).toISOString();
const board = () => [
  { origin: 'Brighton', destination: 'West Worthing', operator: 'SN', scheduledTime: iso(T0 + 8 * 60000),
    bestTime: iso(T0 + 8 * 60000), direction: 'west', delayMins: 0, isUncertain: false, timeSource: 'forecast',
    etaText: '', headcode: '1H96', uid: 'W11111', trainType: 'passenger', source: 'ldbsv', dedupKey: 'a' },
  { origin: 'West Worthing', destination: 'Brighton', operator: 'SN', scheduledTime: iso(T0 + 15 * 60000),
    bestTime: iso(T0 + 15 * 60000), direction: 'east', delayMins: 0, isUncertain: false, timeSource: 'forecast',
    etaText: '', headcode: '1N23', uid: 'E22222', trainType: 'passenger', source: 'ldbsv', dedupKey: 'b' }
];
const berths = [
  { headcode: '1H96', ts: iso(T0 - 60000), area: 'LA', event: 'CA', from: 'T682', to: 'T677' },
  { headcode: '1H96', ts: iso(T0 - 30000), area: 'TB', event: 'CA', from: '0682', to: '0677' },
  { headcode: '1N23', ts: iso(T0 - 20000), area: 'LA', event: 'CC', from: null, to: '0024' }
];
// lastRefresh is the time of the call and lastStateChange the time the engine was built; neither is
// a prediction, and the berth-first shadow takes a moment longer to build than the stub did.
const stable = api => JSON.stringify({ ...api, lastRefresh: null, lastStateChange: null });

console.log('\nNo shadow configured: exactly today\'s engine\n');
{
  const logged = [];
  const e = new CrossingEngines(crossings, {}, { log: (c, d) => logged.push(c) });
  check('the serving engine is the classic CrossingState', e.serving.portslade instanceof CrossingState, true);
  check('no shadows', e.shadowIds().length, 0);
  const control = new CrossingState('portslade', portslade);
  e.ldb('portslade', board()); control.updateLdbTrains(board());
  for (const b of berths) { e.berth(b); control.recordTdEvent(b); }
  check('there are closures to compare', control.getApiState(40).upcomingClosures.length >= 1, true);
  check('fed through the engines = fed directly', stable(e.serving.portslade.getApiState()), stable(control.getApiState()));
  e.logClosureChanges();
  check('nothing new is logged for a crossing without a shadow', logged.length, 0);
}

console.log('\nWith a berth-first shadow (routes file without learned routes: it tracks, it times nothing)\n');
{
  const cfg = { portslade: withKeys({ shadowEngine: 'berth-first' }) };
  const routes = { portslade: { areas: ['LA', 'TB'] } };
  const logged = [];
  const e = new CrossingEngines(cfg, routes, { log: (c, d) => logged.push([c, d]) });
  const control = new CrossingState('portslade', cfg.portslade);
  check('the shadow is the berth-first engine', e.shadows.portslade instanceof BerthFirstEngine, true);
  const trains = board();
  e.ldb('portslade', trains); control.updateLdbTrains(board());
  for (const b of berths) { e.berth(b); control.recordTdEvent(b); }
  check('the serving engine has closures to compare (the board trains)', e.serving.portslade.getApiState(40).upcomingClosures.length >= 1, true);
  check('the serving engine is unchanged by the shadow', stable(e.serving.portslade.getApiState()), stable(control.getApiState()));
  check('the shadow holds its own copy of the board, not the serving engine\'s',
    e.shadows.portslade.ldbTrains !== e.serving.portslade.ldbTrains && e.shadows.portslade.ldbTrains[0] !== trains[0], true);
  // The board's cancelled services (run-through, design §5.5): the shadow gets its own copy; the classic serving
  // engine has nothing that reads them and is unchanged.
  const cancelled = [{ uid: 'X00001', trainid: '1H96', sta: '2026-11-19T22:01:00', isCancelled: true }];
  e.ldb('portslade', board(), cancelled); control.updateLdbTrains(board());
  check('cancelled services: the classic serving engine is unchanged', stable(e.serving.portslade.getApiState()), stable(control.getApiState()));
  check('cancelled services: the shadow has them', e.shadows.portslade.ldbCancelled.length, 1);
  check('cancelled services: ...its own copy', e.shadows.portslade.ldbCancelled[0] !== cancelled[0], true);
  check('  ...equal in content', JSON.stringify(e.shadows.portslade.ldbTrains), JSON.stringify(trains));
  check('the shadow tracked berth events from both its areas (LA step + interpose, TB step)',
    JSON.stringify([e.shadows.portslade.tracker.stats.steps, e.shadows.portslade.tracker.stats.interposes]), JSON.stringify([2, 1]));
  check('the classic engine ignored the TB step (not its area)', e.serving.portslade.ownsTdArea('TB'), false);

  e.logClosureChanges();
  check('first check logs both engines', logged.map(([c, d]) => `${c}:${d.role}:${d.engine}`).join(),
    'closures:serving:classic,closures:shadow:berth-first');
  check('  ...the serving line carries the published closures',
    logged[0][1].closures.length, e.serving.portslade.getApiState().upcomingClosures.length);
  logged.length = 0;
  e.logClosureChanges();
  check('nothing changed: nothing logged', logged.length, 0);
  e.ldb('portslade', []);
  e.logClosureChanges();
  check('the serving closures changed: one serving line', logged.map(([c, d]) => d.role).join(), 'serving');
  logged.length = 0;
  e.logShadowSummary();
  check('hourly summary: one line for the shadow, with its tracker counts',
    logged.length === 1 && logged[0][0] === 'shadowSummary' && logged[0][1].detail.tracker.steps === 2, true);
}

console.log('\nA shadow that throws on every call\n');
{
  class Broken {
    constructor() { this.engine = 'berth-first'; }
    updateLdbTrains() { throw new Error('ldb boom'); }
    updateScheduleTrains() { throw new Error('schedule boom'); }
    recordTdEvent() { throw new Error('berth boom'); }
    getApiState() { throw new Error('api boom'); }
    ownsTdArea() { return true; }
  }
  const factories = { ...FACTORIES, 'berth-first': () => new Broken() };
  const cfg = { portslade: withKeys({ shadowEngine: 'berth-first' }) };
  const logged = [];
  const err = console.error; const errors = []; console.error = m => errors.push(m);
  let escaped = null;
  const e = new CrossingEngines(cfg, { portslade: { areas: ['LA'] } }, { factories, log: (c, d) => logged.push([c, d]) });
  const control = new CrossingState('portslade', cfg.portslade);
  try {
    e.ldb('portslade', board()); control.updateLdbTrains(board());
    e.schedule('portslade', []); control.updateScheduleTrains([]);
    for (const b of berths) { e.berth(b); control.recordTdEvent(b); }
    for (let i = 0; i < 30; i++) e.berth(berths[0]);
    for (let i = 0; i < 30; i++) control.recordTdEvent(berths[0]);
    e.logClosureChanges();
  } catch (x) { escaped = x.message; }
  console.error = err;
  check('no shadow fault escapes into the serving path', escaped, null);
  check('the serving engine has closures to compare', control.getApiState(40).upcomingClosures.length >= 1, true);
  check('the serving engine is exactly as if the shadow were absent', stable(e.serving.portslade.getApiState()), stable(control.getApiState()));
  check('every fault is counted', e.faults.portslade, 1 + 1 + 3 + 30 + 1);
  check('  ...but the journal gets at most 20 of them', errors.filter(m => /shadow berth-first fault/.test(m)).length, 20);
  check('the serving engine\'s closures were still logged', logged.filter(([c, d]) => d.role === 'serving').length, 1);
}

console.log('\nCopies keep Dates and Maps\n');
{
  const src = { d: new Date(T0), m: new Map([['a', 1]]), nested: [{ x: 1 }] };
  const c = _copyForTest(src);
  check('a Date stays a Date', c.d instanceof Date && c.d.getTime() === T0, true);
  check('a Map stays a Map', c.m instanceof Map && c.m.get('a') === 1, true);
  check('nested objects are new objects', c.nested[0] !== src.nested[0], true);
}

console.log();
if (fail > 0) { console.error(`${fail} FAILED, ${pass} passed`); process.exit(1); }
console.log(`All ${pass} checks passed.`);
