'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../geo.js');

test('parseHash reads #t= and #s=', () => {
  assert.deepEqual(G.parseHash('#t=t8f2k'), { t: 't8f2k', s: null });
  assert.deepEqual(G.parseHash('#s=bTn'), { t: null, s: 'BTN' });
  assert.deepEqual(G.parseHash('t=abc'), { t: 'abc', s: null }, 'leading # optional');
  assert.deepEqual(G.parseHash('#s=BTN&t=x1'), { t: 'x1', s: 'BTN' });
  assert.deepEqual(G.parseHash(''), { t: null, s: null });
  assert.deepEqual(G.parseHash(undefined), { t: null, s: null });
});

test('parseHash refuses anything that could not be an id or a CRS', () => {
  ['#t=../../etc', '#t=a b', '#t=a/b', '#t=<script>', '#t=' + 'x'.repeat(41), '#t=', '#t=%E0%A4%A', '#t=a%2Fb'].forEach((h) => {
    assert.equal(G.parseHash(h).t, null, h);
  });
  ['#s=BT', '#s=BTNN', '#s=B1N', '#s=%20ab', '#s='].forEach((h) => assert.equal(G.parseHash(h).s, null, h));
  assert.equal(G.parseHash('#t=a&t=b').t, 'a', 'first wins');
  assert.equal(G.parseHash('#nonsense&=x&t').t, null);
});

test('buildHash round-trips and refuses bad input', () => {
  assert.equal(G.buildHash({ t: 't8f2k' }), '#t=t8f2k');
  assert.equal(G.buildHash({ s: 'btn' }), '#s=BTN');
  assert.equal(G.buildHash({ t: 'a b' }), '');
  assert.equal(G.buildHash(null), '');
  assert.equal(G.buildHash({}), '');
  assert.deepEqual(G.parseHash(G.buildHash({ t: 'Zz_9-x' })), { t: 'Zz_9-x', s: null });
});

test('resolveApiBase accepts loopback hosts only', () => {
  const D = 'https://api.railcrossing.uk';
  assert.equal(G.resolveApiBase('', D), D);
  assert.equal(G.resolveApiBase('?api=http://localhost:3100', D), 'http://localhost:3100');
  assert.equal(G.resolveApiBase('?api=http://127.0.0.1:3100/', D), 'http://127.0.0.1:3100');
  assert.equal(G.resolveApiBase('?api=http://[::1]:3100', D), 'http://[::1]:3100');
  assert.equal(G.resolveApiBase('?x=1&api=http://localhost', D), 'http://localhost');
  [
    'https://evil.example', 'http://localhost.evil.example', 'http://127.0.0.1.evil.example', 'http://evil.example/localhost',
    'http://user:pw@localhost:3100', 'http://localhost@evil.example', 'http://evil.example#@localhost', 'ftp://localhost',
    'javascript:alert(1)', '//evil.example', 'localhost:3100', 'http://127.0.0.2:3100', 'http://0.0.0.0:3100',
    'http://192.168.1.5:3100', 'http://[::ffff:7f00:1]', 'http://localhost.:3100', 'not a url', ''
  ].forEach((v) => assert.equal(G.resolveApiBase('?api=' + encodeURIComponent(v), D), D, v));
});

test('bounding boxes: clamp, pad, contain, area, string', () => {
  assert.deepEqual(G.clampBbox([0, -50, 80, 50]), [49.5, -9, 61, 2.5]);
  assert.deepEqual(G.clampBbox([51.2, 0.8, 50.7, -1.0]), [50.7, -1.0, 51.2, 0.8], 'swapped corners are fixed');
  const p = G.padBbox([50, -1, 51, 0], 0.5);
  assert.deepEqual(p, [49.5, -1.5, 51.5, 0.5]);
  assert.ok(G.bboxContains(p, [50, -1, 51, 0]));
  assert.ok(!G.bboxContains([50, -1, 51, 0], p));
  assert.equal(G.bboxArea([50, -1, 51, 1]), 2);
  assert.equal(G.bboxArea([51, 1, 50, -1]), 0, 'inverted box has no area');
  assert.equal(G.bboxToString([50.123456, -1.5, 51, 0.00004]), '50.1235,-1.5,51,0');
  assert.ok(G.inBbox([50, -1, 51, 0], 50.5, -0.5));
  assert.ok(!G.inBbox([50, -1, 51, 0], 52, -0.5));
});

test('distance and bearing', () => {
  const km = G.haversineKm(50.8286, -0.1407, 51.4949, -0.1446);          // Brighton to Victoria
  assert.ok(km > 73 && km < 76, String(km));
  assert.equal(G.haversineKm(51, 0, 51, 0), 0);
  assert.ok(Math.abs(G.bearing(50, 0, 51, 0) - 0) < 0.01);
  assert.ok(Math.abs(G.bearing(50, 0, 50, 1) - 90) < 0.6);
  assert.ok(Math.abs(G.bearing(51, 0, 50, 0) - 180) < 0.01);
  assert.ok(Math.abs(G.bearing(50, 1, 50, 0) - 270) < 0.6);
});

test('compass words', () => {
  assert.equal(G.compass(0), 'north');
  assert.equal(G.compass(92), 'east');
  assert.equal(G.compass(200), 'south');                                        // nearest of the eight points
  assert.equal(G.compass(225), 'south-west');
  assert.equal(G.compass(359), 'north');
  assert.equal(G.compass(-90), 'west');
  assert.equal(G.compass(null), null);
  assert.equal(G.compass(NaN), null);
});

test('time and number wording', () => {
  assert.equal(G.fmtAgo(1000), 'just now');
  assert.equal(G.fmtAgo(42000), '42 seconds ago');
  assert.equal(G.fmtAgo(60000), '1 minute ago');
  assert.equal(G.fmtAgo(185000), '3 minutes ago');
  assert.equal(G.fmtAgo(3600000), '1 hour ago');
  assert.equal(G.fmtAgo(-5000), 'just now');
  assert.equal(G.fmtAgo(null), 'unknown');
  assert.equal(G.fmtAgeShort(3000), '3 s');
  assert.equal(G.fmtAgeShort(125000), '2 min');
  assert.equal(G.fmtCount(1482), '1,482');
  assert.equal(G.fmtCount(12), '12');
  assert.equal(G.fmtCount(1234567), '1,234,567');
  assert.equal(G.fmtMph(47.6), '48 mph');
  assert.equal(G.fmtMph(null), null);
});
