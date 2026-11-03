'use strict';

// Configuration: config/default.json, then environment, then the command line.
//
//   MAP_ENV_FILE   credentials file (read-only, literal)            default ~/rail-crossing/backend/.env
//   MAP_DATA_DIR   everything the service writes                     default ~/rail-map-data
//   PORT           HTTP port on 127.0.0.1                            default 3100
//   MAP_CONFIG_FILE  optional JSON merged over config/default.json    (local development and tests)
//
// FAKE mode (local development against dev/fake-nrod.js, no credentials, no downloads):
//   --fake[=host:port]  or  MAP_FAKE_NROD=host:port     (default 127.0.0.1:61613; LOOPBACK ONLY)
//   --ref-dir=DIR       or  MAP_REF_DIR=DIR              reference files are read from here, read-only

const fs = require('fs');
const os = require('os');
const path = require('path');
const { expandHome } = require('./env');

const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];

function deepMerge(a, b) {
  const out = Array.isArray(a) ? a.slice() : { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a && typeof a[k] === 'object' && !Array.isArray(a[k]) ? deepMerge(a[k], v) : v;
  }
  return out;
}

function parseFake(text) {
  const t = text === true || text === '' ? '127.0.0.1:61613' : String(text);
  const i = t.lastIndexOf(':');
  const host = i > 0 ? t.slice(0, i) : t, port = i > 0 ? Number(t.slice(i + 1)) : 61613;
  if (!LOOPBACK.includes(host)) throw new Error(`The fake NROD server must be on this machine (127.0.0.1, localhost or ::1), not "${host}".`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`"${t}" does not have a usable port.`);
  return { host, port };
}

function loadConfig({ env = process.env, argv = process.argv.slice(2), overrides = null } = {}) {
  let config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'default.json'), 'utf8'));
  const flags = {};
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`Unknown argument "${a}". Known: --fake[=host:port] --ref-dir=DIR`);
    flags[m[1]] = m[2] === undefined ? true : m[2];
  }
  for (const k of Object.keys(flags)) if (!['fake', 'ref-dir'].includes(k)) throw new Error(`Unknown argument "--${k}". Known: --fake[=host:port] --ref-dir=DIR`);

  const port = env.PORT ? Number(env.PORT) : config.port;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT "${env.PORT}" is not a usable port number.`);
  config.port = port;

  const fakeText = flags.fake !== undefined ? flags.fake : (env.MAP_FAKE_NROD || undefined);
  let fake = null;
  if (fakeText !== undefined) {
    fake = parseFake(fakeText);
    const refDir = flags['ref-dir'] || env.MAP_REF_DIR;
    if (!refDir || refDir === true) throw new Error('Fake mode needs --ref-dir=DIR (or MAP_REF_DIR): the folder holding smart-latest.json.gz, corpus-latest.json.gz and naptan-rail.csv.');
    fake.refDir = path.resolve(expandHome(String(refDir)));
  }
  if (env.MAP_CONFIG_FILE) {
    let extra;
    try { extra = JSON.parse(fs.readFileSync(env.MAP_CONFIG_FILE, 'utf8')); }
    catch (e) { throw new Error(`MAP_CONFIG_FILE ${env.MAP_CONFIG_FILE} cannot be read as JSON (${e.code || e.message}).`); }
    config = deepMerge(config, extra);
  }
  if (overrides) config = deepMerge(config, overrides);

  return {
    config,
    dataDir: path.resolve(expandHome(env.MAP_DATA_DIR || path.join(os.homedir(), 'rail-map-data'))),
    envFile: expandHome(env.MAP_ENV_FILE || path.join(os.homedir(), 'rail-crossing', 'backend', '.env')),
    fake
  };
}

module.exports = { loadConfig, deepMerge, parseFake, LOOPBACK };
