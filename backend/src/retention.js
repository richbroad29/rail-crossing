'use strict';

// How long every log is kept on the VPS — ONE policy for all of them (Rich, 2026-11-19).
//
// 90 days is enough to study a crossing in detail (about 13 of each weekday, a timetable change,
// weekday/weekend contrast) without filling the disk: every log together is ~150-200 MB a day
// once compressed (nationwide S-Class ~45, TRUST ~40, national C-Class ~30-47, the rest ~10), so
// 90 days is ~14-18 GB of the 45 GB disk. Anything older that should be kept goes to the Mac
// (~/rc-data/archive), not here.
//
// Read by: td-rotation (area LA berth steps), sclass-rotation (S-Class, barrier events, the
// regional C-Class and the nationwide S-Class), feed-logger (TRUST, VSTP, national C-Class and
// the daily app log: LDB lateness, state, held).
const KEEP_DAYS = 90;

module.exports = { KEEP_DAYS };
