'use strict';

// The runtime track model (contract section 8). See track/FORMAT.md for the file and track/README.md for use.
//
//   const { loadPack } = require('./track');
//   const pack = loadPack(file);
//   pack.nearestOnTrack(lat, lon, opts)      nearest point on the track
//   pack.route(fromSnap, toSnap, opts)       shortest path by length (A*), snaps or arrays of snaps
//   pack.slice(route, d0, d1)                polyline between two distances along a route
//   pack.pointAt(route, d)                   {lat, lon, bearing} at a distance along a route
//   pack.station(tiploc), pack.signals(), pack.network('lo'|'hi'), pack.sha256()

const { TrackPack, loadPack } = require('./pack');
const format = require('./format');

module.exports = { TrackPack, loadPack, format };
