'use strict';

// Plane geometry for track coordinates. Everything is stored as integers in 1e-7 degrees (1.1 cm of
// latitude) and measured in metres with an equirectangular approximation at the local latitude: at
// the scale of one track segment (tens to hundreds of metres) it is exact to well under a millimetre,
// and the builder and the runtime use this one function set, so a length computed in one place is
// the length used in the other.

const KY = 6371008.8 * Math.PI / 180;   // metres per degree of latitude (mean-radius sphere, as geo.js)
const DEG7 = 1e-7;
const RAD = Math.PI / 180;

const kxAt = lat7 => KY * Math.cos(lat7 * DEG7 * RAD);   // metres per degree of longitude at this latitude

/** Metres between two points given in 1e-7 degrees. */
function dist7(la1, lo1, la2, lo2) {
  const kx = kxAt((la1 + la2) / 2);
  const dy = (la2 - la1) * DEG7 * KY, dx = (lo2 - lo1) * DEG7 * kx;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Bearing in degrees clockwise from north of the move a -> b (1e-7 degree integers). */
function bearing7(la1, lo1, la2, lo2) {
  const kx = kxAt((la1 + la2) / 2);
  const dy = (la2 - la1) * DEG7 * KY, dx = (lo2 - lo1) * DEG7 * kx;
  return (Math.atan2(dx, dy) / RAD + 360) % 360;
}

/** Smallest absolute difference of two bearings, 0..180. */
function angDiff(a, b) { const d = Math.abs(((a - b) % 360 + 540) % 360 - 180); return d; }

module.exports = { KY, DEG7, kxAt, dist7, bearing7, angDiff, RAD };
