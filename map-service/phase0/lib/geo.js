'use strict';

const EARTH_RADIUS_KM = 6371.0088;

/** Great-circle distance in km between two { lat, lon } points. */
function haversineKm(a, b) {
  const rad = d => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** True if the point is inside the box { south, west, north, east } (edges inclusive). */
function inBox(p, box) {
  return p.lat >= box.south && p.lat <= box.north && p.lon >= box.west && p.lon <= box.east;
}

module.exports = { haversineKm, inBox, EARTH_RADIUS_KM };
