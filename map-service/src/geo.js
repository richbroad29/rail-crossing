'use strict';

const R_KM = 6371.0088;
const rad = d => (d * Math.PI) / 180;

function haversineKm(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing a -> b in degrees clockwise from north, or null if the points are closer than minMetres. */
function bearingDeg(a, b, minMetres = 20) {
  if (!a || !b) return null;
  if (haversineKm(a, b) * 1000 < minMetres) return null;
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

const round5 = v => Math.round(v * 1e5) / 1e5;

/** Parse "S,W,N,E". Returns {s,w,n,e} or null if it is not four finite in-range numbers with S<=N, W<=E. */
function parseBbox(text) {
  if (typeof text !== 'string' || text.length > 100) return null;
  const parts = text.split(',');
  if (parts.length !== 4) return null;
  const v = parts.map(p => (p.trim() === '' ? NaN : Number(p)));
  if (!v.every(Number.isFinite)) return null;
  const [s, w, n, e] = v;
  if (s < -90 || n > 90 || w < -180 || e > 180 || s > n || w > e) return null;
  return { s, w, n, e };
}

const inBbox = (lat, lon, b) => lat >= b.s && lat <= b.n && lon >= b.w && lon <= b.e;
const bboxDeg2 = b => (b.n - b.s) * (b.e - b.w);

module.exports = { haversineKm, bearingDeg, round5, parseBbox, inBbox, bboxDeg2 };
