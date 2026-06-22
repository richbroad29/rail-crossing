'use strict';

// S-Class barrier decoder tests. Standalone — run:  node test/sclass-decoder.test.js
// Exits 1 on any failure. Pure logic (no I/O, no feed), so TZ-independent.

const { SClassDecoder, parseDataBytes, hexByte } = require('../src/sclass-decoder');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}\n          got:      ${a}\n          expected: ${e}`); fail++; }
}
function ok(label, cond) { check(label, !!cond, true); }

// BM/Yapton bit map (mirrors config/sclass.json): byte 09, bit7=raised(UP),
// bit6=lowered(DN), bit5=failed. 0x80=UP, 0x40=DN, 0x20=FAILD.
const CFG = { areas: { BM: { name: 'Barnham', logRaw: 'all', crossings: {
  YN: { name: 'Yapton', type: 'MCB-CCTV', bits: {
    raised: { byte: '09', bit: 7 }, lowered: { byte: '09', bit: 6 }, failed: { byte: '09', bit: 5 },
  } } } } } };
// Build an SG 4-byte group (addresses 08-0B) with a given byte-09 value.
const grp = b09 => '00' + hexByte(b09) + '0000';

// ---- parseDataBytes / hexByte (hex byte addressing) ----
console.log('\nparseDataBytes / hex addressing\n');
check('SG 4-byte group parses to 4 bytes', parseDataBytes('00800000'), [0, 128, 0, 0]);
check('single byte 0xC0', parseDataBytes('c0'), [192]);
check('lowercase hex', parseDataBytes('40'), [64]);
check('odd-length -> null', parseDataBytes('abc'), null);
check('non-hex -> null', parseDataBytes('zz'), null);
check('empty -> null', parseDataBytes(''), null);
check('hexByte pads + uppercases', hexByte(9), '09');
check('hexByte 0x80', hexByte(128), '80');

// ---- cold start: first observation emits nothing ----
console.log('\ncold start\n');
{
  const d = new SClassDecoder(CFG);
  const e1 = d.apply('BM', 'SG', '08', grp(0x80), { ts: 'T0' }); // baseline: raised/OPEN
  check('SG baseline emits no events', e1.length, 0);
  check('snapshot after baseline', d.snapshot('BM', 'YN'), { raised: true, lowered: false, failed: false });
  const d2 = new SClassDecoder(CFG);
  const e2 = d2.apply('BM', 'SF', '09', '40', { ts: 'T0' }); // first msg is an SF
  check('first-ever SF emits no event (cold-start guard)', e2.length, 0);
}

// ---- full lowering then raising sequence via SF ----
console.log('\nlowering / raising sequence (live SF)\n');
{
  const d = new SClassDecoder(CFG);
  d.apply('BM', 'SG', '08', grp(0x80), { ts: 'T0' }); // baseline OPEN
  const lowerStart = d.apply('BM', 'SF', '09', '00', { ts: 'T1' }); // raised 1->0
  check('LOWER_START count', lowerStart.length, 1);
  check('LOWER_START phase/kind/bit/transition', [lowerStart[0].phase, lowerStart[0].kind, lowerStart[0].bit, lowerStart[0].transition], ['LOWER_START', null, 'raised', '1->0']);
  check('LOWER_START not recovered (SF)', lowerStart[0].recovered, false);
  check('LOWER_START ts passed through', lowerStart[0].ts, 'T1');

  const closed = d.apply('BM', 'SF', '09', '40', { ts: 'T2' }); // lowered 0->1
  check('CLOSED count', closed.length, 1);
  check('CLOSED is the canonical CLOSE', [closed[0].phase, closed[0].kind], ['CLOSED', 'CLOSE']);
  check('CLOSED state lowered=true raised=false', [closed[0].lowered, closed[0].raised], [true, false]);
  check('CLOSED prev/new byte values', [closed[0].prevByteValue, closed[0].byteValue, closed[0].byte], ['00', '40', '09']);

  const raiseStart = d.apply('BM', 'SF', '09', '00', { ts: 'T3' }); // lowered 1->0
  check('RAISE_START phase/kind', [raiseStart[0].phase, raiseStart[0].kind], ['RAISE_START', null]);
  const open = d.apply('BM', 'SF', '09', '80', { ts: 'T4' }); // raised 0->1
  check('OPEN is the canonical OPEN', [open[0].phase, open[0].kind], ['OPEN', 'OPEN']);
}

// ---- SG refresh: no-change resend is silent ----
console.log('\nSG refresh handling\n');
{
  const d = new SClassDecoder(CFG);
  d.apply('BM', 'SG', '08', grp(0x80), { ts: 'T0' }); // baseline
  const resend = d.apply('BM', 'SG', '08', grp(0x80), { ts: 'T1' }); // identical refresh
  check('identical SG refresh emits no event', resend.length, 0);
  const otherByte = d.apply('BM', 'SG', '08', '01' + '80' + '0000', { ts: 'T2' }); // only byte 08 changes
  check('change on unwatched byte (08) emits no event', otherByte.length, 0);
}

// ---- missed-message gap: SG recovers a net change (raised+lowered both flip) ----
console.log('\nmissed-message gap recovery\n');
{
  const d = new SClassDecoder(CFG);
  d.apply('BM', 'SG', '08', grp(0x80), { ts: 'T0' }); // baseline OPEN
  const rec = d.apply('BM', 'SG', '08', grp(0x40), { ts: 'T1' }); // jumped to DN (missed SFs)
  check('recovered net change emits 2 events', rec.length, 2);
  check('start (1->0) ordered before complete (0->1)', [rec[0].phase, rec[1].phase], ['LOWER_START', 'CLOSED']);
  check('both flagged recovered', [rec[0].recovered, rec[1].recovered], [true, true]);
  check('recovered CLOSE is still kind=CLOSE', rec[1].kind, 'CLOSE');
}

// ---- failed bit ----
console.log('\nfailed bit\n');
{
  const d = new SClassDecoder(CFG);
  d.apply('BM', 'SG', '08', grp(0x80), { ts: 'T0' }); // OPEN, no fault
  const failed = d.apply('BM', 'SF', '09', 'a0', { ts: 'T1' }); // 0x80|0x20: failed 0->1, raised stays
  check('FAILED count', failed.length, 1);
  check('FAILED phase/bit, raised still set', [failed[0].phase, failed[0].bit, failed[0].raised, failed[0].failed], ['FAILED', 'failed', true, true]);
  const clr = d.apply('BM', 'SF', '09', '80', { ts: 'T2' }); // failed 1->0
  check('FAIL_CLEAR phase', clr[0].phase, 'FAIL_CLEAR');
}

// ---- <1s-before-midnight TD timestamp quirk: sub-second feedTime preserved ----
console.log('\nmidnight timestamp quirk\n');
{
  const d = new SClassDecoder(CFG);
  d.apply('BM', 'SG', '08', grp(0x00), { ts: 'S0', feedTime: '2026-06-22T22:59:58.000Z' }); // baseline: all down? no -> nothing set; cold start
  // baseline lowered=0 raised=0; set lowered to get a CLOSE with a near-midnight feedTime
  const ev = d.apply('BM', 'SF', '09', '40', { ts: '2026-06-23T05:00:00.000Z', feedTime: '2026-06-22T22:59:59.500Z' });
  check('CLOSE emitted from baseline-down', [ev[0].phase, ev[0].kind], ['CLOSED', 'CLOSE']);
  check('sub-second pre-midnight feedTime preserved verbatim', ev[0].feedTime, '2026-06-22T22:59:59.500Z');
  check('server ts is authoritative + distinct from feedTime', ev[0].ts, '2026-06-23T05:00:00.000Z');
}

// ---- bounds: S-Class is limited to configured areas (LA stays C-Class only) ----
console.log('\narea bounds\n');
{
  const d = new SClassDecoder(CFG);
  ok('hasArea(BM) true', d.hasArea('BM'));
  ok('hasArea(LA) false — LA not decoded as S-Class', !d.hasArea('LA'));
  check('apply to unknown area returns []', d.apply('LA', 'SF', '09', '40', { ts: 'T' }), []);
  ok("shouldLogRaw 'all' logs any address", d.shouldLogRaw('BM', 0x99, 1));
}

// ---- real config file constructs and contains YN ----
console.log('\nreal config/sclass.json\n');
{
  const real = require('../config/sclass.json');
  const rd = new SClassDecoder(real);
  ok('real config: BM area present', rd.hasArea('BM'));
  check('real config: YN snapshot keys', Object.keys(rd.snapshot('BM', 'YN') || {}).sort(), ['failed', 'lowered', 'raised']);
}

console.log(`\nS-Class decoder: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
