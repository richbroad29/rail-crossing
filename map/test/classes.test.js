'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../classes.js');

test('the first digit of a headcode decides the class', () => {
  const want = { '1': 'express', '9': 'express', '2': 'stopping', '5': 'ecs', '4': 'freight', '6': 'freight',
    '7': 'freight', '8': 'freight', '0': 'special', '3': 'special' };
  Object.keys(want).forEach((d) => assert.equal(C.classOf(d + 'A00'), want[d], 'digit ' + d));
});

test('anything that is not digit-letter-digit-digit is "other"', () => {
  ['', null, undefined, 42, '1H1', '1H155', 'H115', '1h15', '1 H15', '0000', 'XXXX', '1H1X'].forEach((hc) => {
    assert.equal(C.classOf(hc), 'other', String(hc));
  });
});

test('every class has a label, a colour and a plain meaning', () => {
  C.ORDER.forEach((k) => {
    const c = C.CLASSES[k];
    assert.match(c.colour, /^#[0-9a-f]{6}$/i);
    assert.ok(c.label && c.chip && c.meaning.length > 20, k);
  });
  assert.equal(new Set(C.ORDER.map((k) => C.CLASSES[k].colour)).size, C.ORDER.length, 'colours are distinct');
});

test('explainHeadcode talks about the digit and never uses jargon alone', () => {
  assert.match(C.explainHeadcode('1H15').text, /"1" headcode means an express/);
  assert.match(C.explainHeadcode('5Z10').text, /empty coaching stock/);
  assert.match(C.explainHeadcode('6V03').text, /freight/);
  assert.match(C.explainHeadcode('0Z00').text, /locomotive/);
  assert.equal(C.explainHeadcode('????').cls.key, 'other');
  assert.match(C.HEADCODE_HELP, /headcode is/);
  assert.match(C.BERTH_HELP, /berth/);
});

test('operator codes map to names; unknown codes are not guessed', () => {
  assert.equal(C.operatorName('SN'), 'Southern');
  assert.equal(C.operatorName('sn'), 'Southern');
  assert.equal(C.operatorName('TL'), 'Thameslink');
  assert.equal(C.operatorName('GX'), 'Gatwick Express');
  assert.equal(C.operatorName('XR'), 'Elizabeth line');
  assert.equal(C.operatorName('QQ'), null);
  assert.equal(C.operatorName(''), null);
  assert.equal(C.operatorName(null), null);
  assert.equal(C.operatorName('__proto__'), null, 'prototype keys are not operators');
  assert.equal(C.operatorName('constructor'), null);
  assert.equal(C.operatorLabel('QQ'), 'Operator code QQ');
  assert.equal(C.operatorLabel(undefined), null);
});

test('titleCase only repairs SHOUTED names', () => {
  assert.equal(C.titleCase('LONDON VICTORIA'), 'London Victoria');
  assert.equal(C.titleCase('SHOREHAM-BY-SEA'), 'Shoreham-By-Sea');
  assert.equal(C.titleCase('London Victoria'), 'London Victoria');
  assert.equal(C.titleCase('Brighton'), 'Brighton');
  assert.equal(C.titleCase('AB'), 'AB');
  assert.equal(C.titleCase(null), '');
});

test('powerLabel translates codes and ignores unknown ones', () => {
  assert.equal(C.powerLabel('EMU'), 'electric multiple unit');
  assert.equal(C.powerLabel('XYZ'), null);
  assert.equal(C.powerLabel(null), null);
});
