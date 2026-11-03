'use strict';

// Memory hygiene for a process that lives in a 300 MB cgroup beside a safety-relevant service.
//
// V8 lets the old generation grow towards --max-old-space-size (192 MB) before it bothers to collect,
// which is right for throughput and wrong for a box with ~567 MB free: RSS would sit near the cap on
// garbage. So at the moments we KNOW a lot of garbage has just been made (after each reference file has
// been streamed in, before and after a CIF parse) and on a slow timer, we ask for a full collection.
// A full GC of a heap this size takes a few tens of milliseconds.
//
// `gc` is not exposed to a process started without --expose-gc (the systemd ExecStart is fixed), so it
// is obtained the documented-but-obscure way: switch the flag on at run time and take the function from
// a fresh context. If any of that fails, collect() is a no-op and the service is exactly as before.

const v8 = require('v8');
const vm = require('vm');

let gcFn = null;
let tried = false;

function init() {
  if (tried) return gcFn !== null;
  tried = true;
  if (typeof global.gc === 'function') { gcFn = global.gc; return true; }
  try {
    v8.setFlagsFromString('--expose-gc');
    const f = vm.runInNewContext('gc');
    if (typeof f === 'function') gcFn = f;
  } catch (_) { gcFn = null; }
  return gcFn !== null;
}

/** Run a full collection now. Returns whether one ran. Never throws. */
function collect() {
  if (!tried) init();
  if (!gcFn) return false;
  try { gcFn(); return true; } catch (_) { return false; }
}

module.exports = { init, collect };
