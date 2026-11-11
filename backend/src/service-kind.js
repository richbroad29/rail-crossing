'use strict';

// Is a timetabled or departure-board service something that does NOT run on the railway —
// a replacement or timetabled bus, or a ship? Such a service never crosses a level crossing,
// so it must never become a closure. One rule, shared by every source and therefore by every
// crossing (schedule-parser for the timetable, ldb-poller for the departure board).
//
// Found 2026-11-11: the departure board already dropped buses, but the timetable did not.
// Rail-replacement buses (category BR, headcode 0B00) were predicted as barrier closures —
// 237 on Saturday 7 Nov and 209 on Sunday 8 Nov while the line was closed, and 15–18 on a
// normal weeknight; the page showed them as upcoming closures that vanished about a minute
// before their time, when nothing appeared on the berths. In the logs since at least August.
//
// What counts (CIF, Network Rail's timetable format; the board uses the same codes):
//   train_status  B = bus (permanent timetable)   5 = bus (short-term plan)
//                 S = ship (permanent)            4 = ship (short-term plan)
//   category      BR = bus, replacement for engineering work
//                 BS = bus, timetabled service
//                 SS = ship
//   serviceType   'bus' / 'ferry' — the departure board's own flag
// Any one is enough. A service none of them mark is treated as a train, as before.

const NON_RAIL_STATUS = new Set(['B', '5', 'S', '4']);
const NON_RAIL_CATEGORY = new Set(['BR', 'BS', 'SS']);
const NON_RAIL_SERVICE_TYPE = new Set(['bus', 'ferry']);

function isNonRailService({ status, category, serviceType } = {}) {
  if (status && NON_RAIL_STATUS.has(String(status).toUpperCase())) return true;
  if (category && NON_RAIL_CATEGORY.has(String(category).toUpperCase())) return true;
  if (serviceType && NON_RAIL_SERVICE_TYPE.has(String(serviceType).toLowerCase())) return true;
  return false;
}

module.exports = { isNonRailService };
