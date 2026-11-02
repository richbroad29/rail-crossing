'use strict';

// TRUST / VSTP field-presence analysis against planted fixtures. The shapes are from the
// documentation, not the feed, so the property that matters most is that NOTHING in here can
// throw or mis-count on a message that is not what the documentation says.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FeedAnalyser, lookup, isPopulated, trimForExample, MAX_TYPES, MAX_KEYS, EXAMPLE_LIMITS } = require('../lib/feed-fields');

const hdr = type => ({ msg_type: type, source_dev_id: '', user_id: '', original_data_source: 'SDR', msg_queue_timestamp: '1730000000000', source_system_id: 'TRUST' });
const mv = (over = {}, drop = []) => {
  const body = { train_id: '172A41MA02', event_type: 'ARRIVAL', loc_stanox: '87100', actual_timestamp: '1730000000000', planned_timestamp: '1730000000000', timetable_variation: '1', variation_status: 'LATE', platform: ' 2', ...over };
  for (const k of drop) delete body[k];
  return { header: hdr('0003'), body };
};
const act = (drop = []) => {
  const body = { train_id: '172A41MA02', train_uid: 'W12345', schedule_start_date: '2026-11-02' };
  for (const k of drop) delete body[k];
  return { header: hdr('0001'), body };
};
const frame = (...items) => JSON.stringify(items);

test('TRUST: counts by type, top-level keys, and planted presence AND populated rates', () => {
  const a = new FeedAnalyser('trust');
  a.ingest(frame(mv(), mv({ platform: '  ' }), act()));                                    // frame 1
  a.ingest(frame(mv({ planned_timestamp: '' }, ['platform']), act(['schedule_start_date'])));  // frame 2
  a.ingest(frame(mv({ planned_timestamp: null }, ['platform']),
    { header: hdr('0002'), body: { train_id: 'X', loc_stanox: '1' } },
    { header: hdr('9999'), body: { train_id: 'Y' } }));                                      // frame 3
  const s = a.summary();
  assert.equal(s.frames, 3);
  assert.equal(s.items, 8);
  assert.deepEqual(s.topLevelKeys, { body: 8, header: 8 });
  assert.deepEqual(Object.fromEntries(Object.entries(s.byType).map(([k, v]) => [k, v.count])), { '0003': 4, '0001': 2, '0002': 1, '9999': 1 });
  assert.deepEqual(Object.fromEntries(Object.entries(s.byType).map(([k, v]) => [k, v.sharePct])), { '0003': 50, '0001': 25, '0002': 12.5, '9999': 12.5 });
  assert.equal(s.byType['0003'].label, 'movement');
  assert.equal(s.byType['0001'].label, 'activation');
  assert.equal(s.byType['9999'].label, 'unrecognised type');

  const m = s.types['0003'].planned;
  assert.deepEqual(Object.keys(m), ['train_id', 'event_type', 'loc_stanox', 'actual_timestamp', 'planned_timestamp', 'timetable_variation', 'variation_status', 'platform']);
  assert.equal(m.train_id.presentPct, 100);
  // platform: present in 2 of 4 (the two with the key), populated in 1 of 4 (one of them is blank).
  assert.deepEqual(m.platform, { present: 2, populated: 1, presentPct: 50, populatedPct: 25 });
  // planned_timestamp: the key is in all 4, but "" and null are not values.
  assert.deepEqual(m.planned_timestamp, { present: 4, populated: 2, presentPct: 100, populatedPct: 50 });

  const ac = s.types['0001'].planned;
  assert.deepEqual(ac.schedule_start_date, { present: 1, populated: 1, presentPct: 50, populatedPct: 50 });
  assert.deepEqual(Object.keys(ac), ['train_id', 'train_uid', 'schedule_start_date']);

  // Types the brief gave no field list for are asked only for the join key.
  assert.deepEqual(Object.keys(s.types['0002'].planned), ['train_id']);
});

test('TRUST: the key census shows what is REALLY there, including fields nobody planned for', () => {
  const a = new FeedAnalyser('trust');
  a.ingest(frame(mv({ train_service_code: '21700000', toc_id: '88' }), mv()));
  const t = a.summary().types['0003'];
  assert.equal(t.bodyKeys.train_service_code, 1);
  assert.equal(t.bodyKeys.toc_id, 1);
  assert.equal(t.bodyKeys.train_id, 2);
  assert.equal(t.headerKeys.msg_type, 2);
  assert.equal(t.headerKeys.source_system_id, 2);
  assert.equal(t.planned.train_service_code, undefined, 'unplanned fields are not in the planned table...');
  // ...but a planned field the feed names differently reads as 0% next to the census that shows the real name.
  const b = new FeedAnalyser('trust');
  b.ingest(frame({ header: hdr('0003'), body: { trainId: 'x', eventType: 'ARRIVAL' } }));
  const s = b.summary().types['0003'];
  assert.equal(s.planned.train_id.presentPct, 0);
  assert.deepEqual(Object.keys(s.bodyKeys).sort(), ['eventType', 'trainId']);
});

test('VSTP: root key + transaction type, nested planned paths, and a single-object body', () => {
  const loc = (t, dep) => ({ location: { tiploc: { tiploc_id: t } }, scheduled_departure_time: dep });
  const create = (over = {}) => ({
    VSTPCIFMsgV1: {
      timestamp: '1730000000000', owner: 'Network Rail',
      schedule: {
        transaction_type: 'Create', CIF_train_uid: 'W12345', schedule_start_date: '2026-11-03', schedule_end_date: '2026-11-03',
        schedule_days_runs: '0100000', train_status: '1', CIF_stp_indicator: 'N',
        schedule_segment: [{ signalling_id: '1A23', CIF_train_category: 'EE', schedule_location: [loc('BRGHTN', '101500'), loc('HOVE', '102000')] }],
        ...over
      }
    }
  });
  const del = { VSTPCIFMsgV1: { schedule: { transaction_type: 'Delete', CIF_train_uid: 'W12345', schedule_start_date: '2026-11-03', schedule_end_date: '2026-11-03', schedule_days_runs: '0100000' } } };

  const a = new FeedAnalyser('vstp');
  a.ingest(JSON.stringify(create()));                                       // a bare object, not an array
  a.ingest(frame(create({ schedule_segment: [] }), del));                   // no first segment
  a.ingest(JSON.stringify(create({ schedule_segment: [{ signalling_id: '', schedule_location: [{ ...loc('X', ''), scheduled_departure_time: '' }] }] })));
  const s = a.summary();
  assert.equal(s.frames, 3);
  assert.equal(s.items, 4);
  assert.deepEqual(s.topLevelKeys, { VSTPCIFMsgV1: 4 });
  assert.deepEqual(Object.fromEntries(Object.entries(s.byType).map(([k, v]) => [k, v.count])), { 'VSTPCIFMsgV1:Create': 3, 'VSTPCIFMsgV1:Delete': 1 });

  const c = s.types['VSTPCIFMsgV1:Create'].planned;
  assert.equal(c.CIF_train_uid.presentPct, 100);
  assert.equal(c['schedule_segment[0].signalling_id'].present, 2, 'the empty-segment create has none');
  assert.equal(c['schedule_segment[0].signalling_id'].populated, 1, 'and one of the two is blank');
  assert.equal(c['schedule_segment[0].schedule_location[0].location.tiploc.tiploc_id'].present, 2);
  assert.equal(c['schedule_segment[0].schedule_location[0].scheduled_departure_time'].populated, 1);
  // A Delete is judged against the fields a Delete should have, not a Create's.
  const d = s.types['VSTPCIFMsgV1:Delete'].planned;
  assert.deepEqual(Object.keys(d), ['transaction_type', 'CIF_train_uid', 'schedule_start_date', 'schedule_end_date', 'schedule_days_runs']);
  assert.equal(d.CIF_train_uid.presentPct, 100);
  // The keys above `schedule` are counted separately from the keys inside it.
  assert.equal(s.types['VSTPCIFMsgV1:Create'].headerKeys.owner, 3);
  assert.equal(s.types['VSTPCIFMsgV1:Create'].bodyKeys.schedule_segment, 3);
});

test('VSTP: a root key other than the one the documentation names is reported, not rejected', () => {
  const a = new FeedAnalyser('vstp');
  a.ingest(JSON.stringify({ VSTPCIFMsgV2: { schedule: { transaction_type: 'Create' } } }));
  a.ingest(JSON.stringify({ VSTPCIFMsgV2: { schedule: { transaction_type: 'Update' } } }));
  a.ingest(JSON.stringify({ VSTPCIFMsgV2: { notASchedule: 1 } }));
  const s = a.summary();
  assert.deepEqual(Object.keys(s.byType).sort(), ['VSTPCIFMsgV2:?', 'VSTPCIFMsgV2:Create', 'VSTPCIFMsgV2:Update']);
  assert.equal(s.topLevelKeys.VSTPCIFMsgV2, 3);
});

test('hostile input is counted, never thrown', () => {
  for (const feed of ['trust', 'vstp']) {
    const a = new FeedAnalyser(feed);
    for (const body of ['garbage', 'null', '5', '"s"', 'true', '[]', '{}', '[null, 1, "x", [], {}]', '[{"header": 5, "body": "str"}]', '[{"header": null}]', '[{"header": {"msg_type": null}, "body": null}]',
      '{"VSTPCIFMsgV1": null}', '{"VSTPCIFMsgV1": {"schedule": "no"}}', '{"VSTPCIFMsgV1": {"schedule": {"transaction_type": 5}}}', '[[[[[[[[[[[[[1]]]]]]]]]]]]]', JSON.stringify({ __proto__: 1, constructor: { prototype: 1 } })]) {
      assert.doesNotThrow(() => a.ingest(body), `${feed}: ${body}`);
    }
    const s = a.summary();
    assert.equal(s.frames, 16);
    assert.equal(s.parseErrors, 1, 'only "garbage" is not JSON');
    assert.ok(s.unrecognisedItems >= 5);
    assert.doesNotThrow(() => JSON.stringify(a.examples()));
  }
  const t = new FeedAnalyser('trust');
  t.ingest('[{"header": null}]');
  t.ingest('[{"header": {"msg_type": null}, "body": null}]');
  assert.equal(t.summary().byType['(no header.msg_type)'].count, 2, 'untyped items are a type of their own');
});

test('a feed name that is not trust or vstp is a programming error', () => {
  assert.throws(() => new FeedAnalyser('darwin'), TypeError);
});

// ---- the helpers -----------------------------------------------------------------------------------

test('lookup: dotted paths and [n] indexes, own properties only, present even when null', () => {
  const o = { a: { b: [{ c: 1 }, { c: 2 }] }, n: null, z: 0, e: [] };
  assert.deepEqual(lookup(o, 'a.b[0].c'), { present: true, value: 1 });
  assert.deepEqual(lookup(o, 'a.b[1].c'), { present: true, value: 2 });
  assert.equal(lookup(o, 'a.b[2].c').present, false);
  assert.equal(lookup(o, 'a.x').present, false);
  assert.deepEqual(lookup(o, 'n'), { present: true, value: null });
  assert.deepEqual(lookup(o, 'z'), { present: true, value: 0 });
  assert.equal(lookup(o, 'e[0]').present, false);
  assert.equal(lookup(o, 'a.b.c').present, false, 'an array is not an object with key c');
  assert.equal(lookup(o, 'constructor').present, false, 'inherited properties are not fields');
  assert.equal(lookup(o, 'toString').present, false);
  assert.equal(lookup(null, 'a').present, false);
  assert.equal(lookup('str', 'length').present, false);
  assert.equal(lookup(o, 'a..b').present, false);
});

test('isPopulated: values that say something', () => {
  for (const v of ['x', ' x ', 0, 1, false, true, [0], { a: 1 }]) assert.equal(isPopulated(v), true, JSON.stringify(v));
  for (const v of [null, undefined, '', '   ', '\t\n', [], {}]) assert.equal(isPopulated(v), false, JSON.stringify(v));
});

test('trimForExample: cuts long strings, long arrays, wide objects and deep nesting, and marks each cut', () => {
  const long = 'x'.repeat(200);
  assert.equal(trimForExample(long), `${'x'.repeat(80)}…(+120 chars)`);
  assert.deepEqual(trimForExample([1, 2, 3, 4, 5]), [1, 2, '…(+3 more)']);
  const wide = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
  const tw = trimForExample(wide);
  assert.equal(Object.keys(tw).length, 41);
  assert.equal(tw['…'], '(+10 more keys)');
  const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
  assert.equal(trimForExample(deep, { ...EXAMPLE_LIMITS, maxDepth: 6 }).a.b.c.d.e.f, '…(nested deeper)');
  assert.deepEqual(trimForExample(deep).a.b.c.d.e.f, { g: 1 }, 'the default depth is generous enough for ordinary nesting');
  // ...and for a real VSTP location, nine levels down, which is what an example is for.
  const vstp = { VSTPCIFMsgV1: { schedule: { schedule_segment: [{ schedule_location: [{ location: { tiploc: { tiploc_id: 'BRGHTN' } } }] }] } } };
  assert.equal(trimForExample(vstp).VSTPCIFMsgV1.schedule.schedule_segment[0].schedule_location[0].location.tiploc.tiploc_id, 'BRGHTN');
  // Pathological nesting is still cut, and marked.
  let nest = { leaf: 1 };
  for (let i = 0; i < 30; i++) nest = { n: nest };
  assert.match(JSON.stringify(trimForExample(nest)), /…\(nested deeper\)/);
  assert.deepEqual(trimForExample({ n: 1, t: true, z: null, s: 'ok' }), { n: 1, t: true, z: null, s: 'ok' });
});

test('trimForExample does not touch what it was given', () => {
  const o = { list: [1, 2, 3, 4], s: 'x'.repeat(100) };
  const before = JSON.stringify(o);
  trimForExample(o);
  assert.equal(JSON.stringify(o), before);
});

test('examples: one per type, the FIRST seen, trimmed — and the VSTP example keeps its nesting', () => {
  const a = new FeedAnalyser('trust');
  a.ingest(frame(mv({ train_id: 'FIRST' })));
  a.ingest(frame(mv({ train_id: 'SECOND' }), act()));
  const ex = a.examples();
  assert.deepEqual(Object.keys(ex).sort(), ['0001', '0003']);
  assert.equal(ex['0003'].body.train_id, 'FIRST');
  const v = new FeedAnalyser('vstp');
  v.ingest(JSON.stringify({ VSTPCIFMsgV1: { schedule: { transaction_type: 'Create', schedule_segment: [{ a: 1 }, { a: 2 }, { a: 3 }] } } }));
  assert.deepEqual(v.examples()['VSTPCIFMsgV1:Create'].VSTPCIFMsgV1.schedule.schedule_segment, [{ a: 1 }, { a: 2 }, '…(+1 more)']);
});

test('bounded: a feed with endless types or keys cannot grow the analyser without limit', () => {
  const a = new FeedAnalyser('trust');
  for (let i = 0; i < MAX_TYPES + 10; i++) a.ingest(frame({ header: { msg_type: `T${i}` }, body: { train_id: 'x' } }));
  let s = a.summary();
  assert.equal(Object.keys(s.byType).length, MAX_TYPES + 1, 'the first 50 types, then everything else in one bucket');
  assert.equal(s.byType['(other)'].count, 10);
  assert.equal(s.items, MAX_TYPES + 10, 'no item is lost');
  assert.deepEqual(s.types['(other)'].planned, {}, 'the overflow bucket measures no fields');

  const b = new FeedAnalyser('trust');
  const body = Object.fromEntries(Array.from({ length: MAX_KEYS + 100 }, (_, i) => [`key${i}`, i]));
  b.ingest(frame({ header: hdr('0003'), body }));
  s = b.summary();
  assert.equal(Object.keys(s.types['0003'].bodyKeys).length, MAX_KEYS + 1);
  assert.equal(s.types['0003'].bodyKeys['(other)'], 100);
});
