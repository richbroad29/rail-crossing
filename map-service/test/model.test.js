'use strict';

// Identity rules (contract section 4), each with a planted answer.

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeModel, smartRows } = require('./helpers');

const T0 = 1_000_000_000_000;
const ev = (type, area, descr, from, to, ts) => ({ type, area, descr, from, to, ts });

function setup(over) {
  let clock = T0;
  const ctx = makeModel({ now: () => clock, ...over });
  ctx.at = ms => { clock = T0 + ms; };
  return ctx;
}
const trainAt = (m, g, area, berth) => m.occ.get(g.lookup(area, berth));

test('CC creates a train with an opaque id; CA moves it and keeps the id', () => {
  const { model: m, graph: g } = setup();
  m.apply(ev('CC', 'LA', '1H15', null, '0001', T0));
  const t = trainAt(m, g, 'LA', '0001');
  assert.ok(t);
  assert.match(t.id, /^t[a-z0-9]+$/);
  assert.notEqual(t.id, '1H15');
  const id = t.id;
  m.apply(ev('CA', 'LA', '1H15', '0001', '0002', T0 + 5000));
  assert.equal(trainAt(m, g, 'LA', '0001'), undefined, 'the old berth is empty');
  assert.equal(trainAt(m, g, 'LA', '0002').id, id, 'same train, same id');
  assert.equal(m.byId.size, 1);
  assert.equal(trainAt(m, g, 'LA', '0002').at, T0 + 5000, 'at = when it entered this berth');
});

test('two trains never share an id, and an id is not the headcode', () => {
  const { model: m } = setup();
  m.apply(ev('CC', 'LA', '1H15', null, '0001', T0));
  m.apply(ev('CC', 'LA', '1H15', null, '0009', T0));      // same headcode elsewhere in the area: a different train
  assert.equal(m.byId.size, 2);
  assert.equal(new Set([...m.byId.keys()]).size, 2);
});

test('CA with nothing at `from` starts a train at `to`', () => {
  const { model: m, graph: g } = setup();
  m.apply(ev('CA', 'LA', '2S95', '0036', '0034', T0));
  assert.equal(trainAt(m, g, 'LA', '0034').hc, '2S95');
  assert.equal(m.byId.size, 1);
});

test('CB clears the berth (and carries `from` only); CC carries `to` only', () => {
  const { model: m, graph: g } = setup();
  m.apply(ev('CC', 'LA', '1H15', null, '0001', T0));
  m.apply(ev('CB', 'LA', '1H15', '0001', null, T0 + 1000));
  assert.equal(m.byId.size, 0);
  assert.equal(trainAt(m, g, 'LA', '0001'), undefined);
  // The swapped shapes are malformed and change nothing.
  const before = m.stats.malformed;
  m.apply(ev('CC', 'LA', '1H15', '0001', null, T0 + 2000));   // a CC that carries `from` only
  m.apply(ev('CB', 'LA', '1H15', null, '0001', T0 + 2000));   // a CB that carries `to` only
  assert.equal(m.stats.malformed, before + 2);
  assert.equal(m.byId.size, 0);
});

test('RENUMBERING: CB then CC on the same berth within 120 s keeps the id and records the old headcode', () => {
  const { model: m, graph: g } = setup();
  m.apply(ev('CC', 'LA', '1H15', null, '0001', T0));
  const id = trainAt(m, g, 'LA', '0001').id;
  m.apply(ev('CB', 'LA', '1H15', '0001', null, T0 + 10_000));
  m.apply(ev('CC', 'LA', '2K22', null, '0001', T0 + 11_000));
  const t = trainAt(m, g, 'LA', '0001');
  assert.equal(t.id, id);
  assert.equal(t.hc, '2K22');
  assert.deepEqual(t.prevHc, ['1H15']);
  assert.equal(m.stats.renumbered, 1);
  assert.equal(m.byId.size, 1);
});

test('renumbering twice keeps both old headcodes in order', () => {
  const { model: m, graph: g } = setup();
  m.apply(ev('CC', 'LA', 'AAAA', null, '0001', T0));
  const id = trainAt(m, g, 'LA', '0001').id;
  m.apply(ev('CB', 'LA', 'AAAA', '0001', null, T0 + 1000));
  m.apply(ev('CC', 'LA', 'BBBB', null, '0001', T0 + 2000));
  m.apply(ev('CB', 'LA', 'BBBB', '0001', null, T0 + 3000));
  m.apply(ev('CC', 'LA', 'CCCC', null, '0001', T0 + 4000));
  const t = trainAt(m, g, 'LA', '0001');
  assert.equal(t.id, id);
  assert.deepEqual(t.prevHc, ['AAAA', 'BBBB']);
});

test('a re-interpose of the SAME headcode after a cancel keeps the id and adds no previous headcode', () => {
  const { model: m, graph: g } = setup();
  m.apply(ev('CC', 'LA', '1H15', null, '0001', T0));
  const id = trainAt(m, g, 'LA', '0001').id;
  m.apply(ev('CB', 'LA', '1H15', '0001', null, T0 + 1000));
  m.apply(ev('CC', 'LA', '1H15', null, '0001', T0 + 2000));
  assert.equal(trainAt(m, g, 'LA', '0001').id, id);
  assert.equal(trainAt(m, g, 'LA', '0001').prevHc, null);
});

test('a cancelled train is forgotten after 120 s: a later CC at that berth is a NEW train', () => {
  const { model: m, graph: g, at } = setup();
  m.apply(ev('CC', 'LA', '1H15', null, '0001', T0));
  const id = trainAt(m, g, 'LA', '0001').id;
  m.apply(ev('CB', 'LA', '1H15', '0001', null, T0 + 1000));
  m.apply(ev('CC', 'LA', '2K22', null, '0001', T0 + 1000 + 121_000));
  assert.notEqual(trainAt(m, g, 'LA', '0001').id, id);
  // And pruning drops the record itself.
  m.apply(ev('CB', 'LA', '2K22', '0001', null, T0 + 200_000));
  at(200_000 + 121_000); m.prune();
  assert.equal(m.cancelledByKey.size, 0);
  assert.equal(m.cancelledByHc.size, 0);
});

test('a cancelled train at a DIFFERENT berth is not a renumbering', () => {
  const { model: m, graph: g } = setup();
  m.apply(ev('CC', 'LA', '1H15', null, '0001', T0));
  const id = trainAt(m, g, 'LA', '0001').id;
  m.apply(ev('CB', 'LA', '1H15', '0001', null, T0 + 1000));
  m.apply(ev('CC', 'LA', '2K22', null, '0005', T0 + 2000));
  assert.notEqual(trainAt(m, g, 'LA', '0005').id, id);
});

test('HANDOVER after a cancel: another area, same headcode, within 90 s -> same id, and the graph learns the edge', () => {
  const { model: m, graph: g } = setup();
  m.apply(ev('CC', 'LA', '1H15', null, '0099', T0));
  const id = trainAt(m, g, 'LA', '0099').id;
  m.apply(ev('CB', 'LA', '1H15', '0099', null, T0 + 1000));
  m.apply(ev('CC', 'LB', '1H15', null, '0001', T0 + 31_000));
  const t = trainAt(m, g, 'LB', '0001');
  assert.equal(t.id, id);
  assert.equal(m.stats.handovers, 1);
  assert.equal(m.byId.size, 1);
  const a = g.lookup('LA', '0099'), b = g.lookup('LB', '0001');
  assert.deepEqual(g.edgesFrom(a), [[b, 1, false]], 'one sighting of LA:0099 -> LB:0001');
  // Usable after 2 sightings: a second handover over the same edge makes it usable.
  assert.equal(g._usableEdge(g._findEdge(a, b)), false);
  m.apply(ev('CB', 'LB', '1H15', '0001', null, T0 + 40_000));
  m.apply(ev('CC', 'LA', '2Z22', null, '0099', T0 + 300_000));   // (>120 s on, so LB:0001's old cancel has expired)
  m.apply(ev('CB', 'LA', '2Z22', '0099', null, T0 + 301_000));
  m.apply(ev('CC', 'LB', '2Z22', null, '0001', T0 + 302_000));
  assert.deepEqual(g.edgesFrom(a), [[b, 2, false]]);
  assert.equal(g._usableEdge(g._findEdge(a, b)), true);
});

test('HANDOVER without a cancel: last stepped <= 90 s ago in another area -> same id, old berth emptied', () => {
  const { model: m, graph: g } = setup();
  m.apply(ev('CA', 'LA', '1H15', '0098', '0099', T0));
  const id = trainAt(m, g, 'LA', '0099').id;
  m.apply(ev('CC', 'LB', '1H15', null, '0001', T0 + 60_000));
  assert.equal(trainAt(m, g, 'LB', '0001').id, id);
  assert.equal(trainAt(m, g, 'LA', '0099'), undefined, 'the train left the old area');
  assert.equal(m.byId.size, 1);
});

test('NO handover past 90 s: the same headcode in another area is a different train', () => {
  const { model: m, graph: g } = setup();
  m.apply(ev('CA', 'LA', '1H15', '0098', '0099', T0));
  const id = trainAt(m, g, 'LA', '0099').id;
  m.apply(ev('CC', 'LB', '1H15', null, '0001', T0 + 91_000));
  assert.notEqual(trainAt(m, g, 'LB', '0001').id, id);
  assert.equal(m.byId.size, 2);
  assert.equal(m.stats.handovers, 0);
});

test('the same area is never a handover: same headcode cancelled elsewhere in the area gets a new id', () => {
  const { model: m, graph: g } = setup();
  m.apply(ev('CC', 'LA', '1H15', null, '0001', T0));
  const id = trainAt(m, g, 'LA', '0001').id;
  m.apply(ev('CB', 'LA', '1H15', '0001', null, T0 + 1000));
  m.apply(ev('CC', 'LA', '1H15', null, '0007', T0 + 2000));
  assert.notEqual(trainAt(m, g, 'LA', '0007').id, id);
  assert.equal(m.stats.handovers, 0);
});

test('a handover between places further apart than handoverMaxKm is refused (two trains sharing a headcode)', () => {
  const { model: m, graph: g } = setup();
  const stations = { 1: { key: 'N', name: 'North', lat: 55.0, lon: -1.0, crs: 'NNN' }, 2: { key: 'S', name: 'South', lat: 51.0, lon: -1.0, crs: 'SSS' } };
  g.loadSmart(smartRows([['LA', '0098', '0099', '1', 'A'], ['LB', '0000', '0001', '2', 'A']]), s => stations[s] || null);
  m.apply(ev('CA', 'LA', '1H15', '0098', '0099', T0));
  const id = trainAt(m, g, 'LA', '0099').id;
  m.apply(ev('CC', 'LB', '1H15', null, '0001', T0 + 30_000));
  assert.notEqual(trainAt(m, g, 'LB', '0001').id, id);
  assert.equal(m.stats.handoversRefused, 1);
  assert.equal(m.stats.handovers, 0);
});

test('idle drop: no event for maxIdleSecs (2700) drops the train, not before', () => {
  const { model: m, at } = setup();
  m.apply(ev('CC', 'LA', '1H15', null, '0001', T0));
  at(2_699_000); m.prune();
  assert.equal(m.byId.size, 1);
  at(2_701_000); m.prune();
  assert.equal(m.byId.size, 0);
  assert.equal(m.stats.idleDropped, 1);
});

test('any event refreshes idleness', () => {
  const { model: m, at } = setup();
  m.apply(ev('CC', 'LA', '1H15', null, '0001', T0));
  m.apply(ev('CA', 'LA', '1H15', '0001', '0002', T0 + 2_000_000));
  at(2_700_000 + 1000); m.prune();
  assert.equal(m.byId.size, 1, 'stepped 700 s ago: still alive');
});

test('CB for an empty berth is ignored and counted', () => {
  const { model: m } = setup();
  m.apply(ev('CB', 'LA', '1H15', '0001', null, T0));
  assert.equal(m.stats.cbMiss, 1);
  assert.equal(m.byId.size, 0);
});

test('a step into an occupied berth overwrites the occupant', () => {
  const { model: m, graph: g } = setup();
  m.apply(ev('CC', 'LA', 'AAAA', null, '0002', T0));
  const other = trainAt(m, g, 'LA', '0002').id;
  m.apply(ev('CC', 'LA', 'BBBB', null, '0001', T0));
  m.apply(ev('CA', 'LA', 'BBBB', '0001', '0002', T0 + 1000));
  assert.equal(trainAt(m, g, 'LA', '0002').hc, 'BBBB');
  assert.equal(m.byId.has(other), false);
  assert.equal(m.stats.overwritten, 1);
});

test('a CA whose `from` holds a DIFFERENT headcode means we missed an event: stale occupant dropped, new train', () => {
  const { model: m, graph: g } = setup();
  m.apply(ev('CC', 'LA', 'AAAA', null, '0001', T0));
  const old = trainAt(m, g, 'LA', '0001').id;
  m.apply(ev('CA', 'LA', 'BBBB', '0001', '0002', T0 + 1000));
  assert.equal(m.byId.has(old), false);
  assert.equal(trainAt(m, g, 'LA', '0002').hc, 'BBBB');
  assert.equal(m.stats.staleOccupant, 1);
});

test('a duplicate CC of the same headcode in its own berth changes nothing', () => {
  const { model: m, graph: g } = setup();
  m.apply(ev('CC', 'LA', '1H15', null, '0001', T0));
  const id = trainAt(m, g, 'LA', '0001').id;
  m.apply(ev('CC', 'LA', '1H15', null, '0001', T0 + 5000));
  assert.equal(trainAt(m, g, 'LA', '0001').id, id);
  assert.equal(m.byId.size, 1);
});

test('malformed messages never throw and never change state', () => {
  const { model: m } = setup();
  const bad = [null, undefined, 5, 'x', {}, { type: 'CA' }, { type: 'ZZ', area: 'LA', descr: 'X', to: '1' },
    { type: 'CA', area: 'LA', descr: '', from: '1', to: '2' }, { type: 'CA', area: 'LA', descr: 'ABCDEFGHIJKLM', from: '1', to: '2' },
    { type: 'CA', area: 'LONGAREA', descr: 'A', from: '1', to: '2' }, { type: 'CA', area: 'LA', descr: 'A', from: '1', to: '1' },
    { type: 'CA', area: 'LA', descr: 'A', from: 'x y', to: '2' }, { type: 'CC', area: 'LA', descr: 'A', to: '\u0000' },
    { type: 'CA', area: 'LA', descr: 'A', from: 12345, to: {} }];
  for (const b of bad) assert.doesNotThrow(() => m.apply(b));
  assert.equal(m.byId.size, 0);
  assert.equal(m.stats.malformed, bad.length);
});

test('the change set reports each train with its position BEFORE the first change', () => {
  const { model: m, graph: g, cs } = setup();
  const stations = { 1: { key: 'A', name: 'A', lat: 51.0, lon: -1.0, crs: 'AAA' }, 2: { key: 'B', name: 'B', lat: 51.1, lon: -1.1, crs: 'BBB' } };
  g.loadSmart(smartRows([['LA', '0001', '0002', '1', 'B'], ['LA', '0002', '0003', '2', 'A']]), s => stations[s] || null);
  m.apply(ev('CC', 'LA', '1H15', null, '0001', T0));
  let changes = cs.take();
  const id = trainAt(m, g, 'LA', '0001').id;
  assert.equal(changes.get(id).obox, null, 'a new train had no previous position');
  m.apply(ev('CA', 'LA', '1H15', '0001', '0003', T0 + 1000));
  m.apply(ev('CB', 'LA', '1H15', '0003', null, T0 + 2000));
  changes = cs.take();
  assert.deepEqual(changes.get(id).obox, [51.0, -1.0, 51.0, -1.0], 'the box at the START of the batch (a train without an mv: its point), however many changes followed');
  assert.equal(m.byId.has(id), false);
});

test('bounds: trains, cancelled records and per-train rings are capped', () => {
  const { model: m, graph: g, at } = setup({ cfgOverrides: { model: { maxTrains: 50, maxCancelled: 10, recentBerths: 20, trailMax: 40 } } });
  for (let i = 0; i < 200; i++) m.apply(ev('CC', 'LA', `T${String(i).padStart(3, '0')}`, null, String(1000 + i), T0 + i));
  at(1000); m.prune();
  assert.equal(m.byId.size, 50);
  assert.equal(m.stats.capEvicted, 150);
  assert.ok(m.byId.has(trainAt(m, g, 'LA', '1199').id), 'the most recently active survive');

  for (let i = 0; i < 40; i++) {
    m.apply(ev('CC', 'LB', `C${i}`, null, String(2000 + i), T0 + 5000));
    m.apply(ev('CB', 'LB', `C${i}`, String(2000 + i), null, T0 + 5001));
  }
  m.prune();
  assert.ok(m.cancelledByKey.size <= 10 && m.cancelledByHc.size <= 10);

  m.apply(ev('CC', 'LC', 'RING', null, '0100', T0));
  for (let i = 0; i < 100; i++) m.apply(ev('CA', 'LC', 'RING', String(100 + i).padStart(4, '0'), String(101 + i).padStart(4, '0'), T0 + 1000 * i));
  const t = trainAt(m, g, 'LC', '0200');
  assert.ok(t.recentKeys.length <= 20);
  assert.ok(t.trail.length / 3 <= 40);
  for (let i = 0; i < 12; i++) {
    m.apply(ev('CB', 'LC', t.hc, '0200', null, T0 + 200_000 + i * 2));
    m.apply(ev('CC', 'LC', `R${i}`, null, '0200', T0 + 200_001 + i * 2));
  }
  assert.ok(trainAt(m, g, 'LC', '0200').prevHc.length <= 5);
});
