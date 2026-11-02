'use strict';

// Facts about the machine the measurement ran on, recorded FIRST so that every number after them
// can be read against the hardware: the CPU model, count and architecture identify the Oracle
// shape (an AMD micro and an Ampere A1 behave very differently), and RAM / swap / load say how
// much room there was. Everything is read-only and tolerant: on a box without /proc (a Mac, a
// container) the fields are simply null, never an error.
//
// I/O is injected so tests can feed it a canned /proc/meminfo and a fake os.

const nodeOs = require('os');
const nodeFs = require('fs');

const KB_PER_MB = 1024;
const round1 = n => Math.round(n * 10) / 10;

/** Parse /proc/meminfo text. Returns MB figures (null for any line absent), or null if it is not meminfo. */
function parseMeminfo(text) {
  const kb = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (m) kb[m[1]] = Number(m[2]);
  }
  if (kb.MemTotal === undefined) return null;
  const mb = key => (kb[key] === undefined ? null : round1(kb[key] / KB_PER_MB));
  return {
    memTotalMB: mb('MemTotal'),
    memAvailableMB: mb('MemAvailable'),   // absent on kernels older than 3.14
    memFreeMB: mb('MemFree'),
    swapTotalMB: mb('SwapTotal'),
    swapFreeMB: mb('SwapFree')
  };
}

function readMeminfo({ readFileSync = nodeFs.readFileSync } = {}) {
  try { return parseMeminfo(readFileSync('/proc/meminfo', 'utf8')); }
  catch (_) { return null; }
}

/** "66MB" (the crossing service's /health `memory`) -> 66, or null. */
function parseHealthMemoryMB(s) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*MB\s*$/i.exec(String(s === undefined || s === null ? '' : s));
  return m ? Number(m[1]) : null;
}

function osName({ os = nodeOs, readFileSync = nodeFs.readFileSync } = {}) {
  let pretty = null;
  try {
    const m = /^PRETTY_NAME=(?:"([^"]*)"|(.*))$/m.exec(readFileSync('/etc/os-release', 'utf8'));
    if (m) pretty = m[1] || m[2];
  } catch (_) { /* not a Linux with os-release */ }
  return `${pretty || `${os.type()} ${os.platform()}`} (kernel ${os.release()})`;
}

/**
 * @param {object} [d]
 * @param {object} [d.os] / [d.readFileSync] / [d.statfsSync]  test seams
 * @param {object|null} [d.health]  the crossing service's /health body, if it was reachable
 */
function machineFacts(d = {}) {
  const os = d.os || nodeOs;
  const readFileSync = d.readFileSync || nodeFs.readFileSync;
  const statfsSync = d.statfsSync || nodeFs.statfsSync;
  const cpus = os.cpus() || [];
  const mem = readMeminfo({ readFileSync });
  const facts = {
    os: osName({ os, readFileSync }),
    arch: os.arch(),
    nodeVersion: process.version,
    cpuModel: cpus.length ? cpus[0].model.trim() : null,
    cpuCount: cpus.length,
    memTotalMB: mem ? mem.memTotalMB : round1(os.totalmem() / 1048576),
    memAvailableMB: mem ? mem.memAvailableMB : null,
    swapTotalMB: mem ? mem.swapTotalMB : null,
    swapUsedMB: mem && mem.swapTotalMB !== null && mem.swapFreeMB !== null ? round1(mem.swapTotalMB - mem.swapFreeMB) : null,
    loadAverage: os.loadavg().map(n => Math.round(n * 100) / 100),
    uptimeHours: round1(os.uptime() / 3600),
    homeDiskFreeGB: null,
    crossingServiceMemoryMB: null
  };
  // Free space on the filesystem holding the home folder — where the TD logs and the reports go.
  try {
    if (typeof statfsSync === 'function') {
      const st = statfsSync(os.homedir());
      facts.homeDiskFreeGB = round1((Number(st.bavail) * Number(st.bsize)) / 1073741824);
    }
  } catch (_) { /* statfs unavailable: leave null */ }
  if (d.health) facts.crossingServiceMemoryMB = parseHealthMemoryMB(d.health.memory);
  return facts;
}

module.exports = { parseMeminfo, readMeminfo, parseHealthMemoryMB, machineFacts, osName };
