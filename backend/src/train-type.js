'use strict';

// A train's type from its headcode — the first character is the train's class — and, for a
// timetable entry, its CIF category. The one rule for both the departure board (ldb-poller) and
// the timetable (schedule-parser), which used to carry a copy each.
//
//   0xxx  light locomotive      -> 'freight'
//   4xxx  freight up to 75 mph  -> 'freight'
//   6xxx  freight up to 60 mph  -> 'freight'
//   7xxx  freight up to 45 mph  -> 'freight'
//   8xxx  freight up to 35 mph  -> 'freight'
//   5xxx  empty coaching stock  -> 'ecs'   (and CIF category EE, whatever the headcode)
//   3xxx  test / railhead       -> 'test'
//   anything else               -> 'passenger'
//
// Until 2026-11-12 only 6 and 7 were freight, so 4xxx, 8xxx and light engines were timed as
// passenger trains. A light engine is a locomotive with no train: it is timed as freight because
// it is run under freight rules and speeds, and because Portslade has no measured transit for
// one — over 177 days of TD (2026-05-16..11-12) no 0xxx, 4xxx or 8xxx train crossed Boundary
// Road at all. The only such path in the timetable was 8Y91, a Horsham departmental working
// (category DD) that ran on 0 of its last 10 booked days.
const BY_CLASS = { 0: 'freight', 4: 'freight', 6: 'freight', 7: 'freight', 8: 'freight', 5: 'ecs', 3: 'test' };

function trainTypeOf(headcode, category) {
  if (category === 'EE') return 'ecs';
  return BY_CLASS[(headcode || '').charAt(0)] || 'passenger';
}

module.exports = { trainTypeOf };
