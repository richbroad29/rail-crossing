'use strict';

// Shared command-line plumbing for the two scripts: argument parsing that fails in plain words,
// the options both scripts share, progress lines that cannot leak a credential, signal wiring,
// and turning an exception into something Rich can act on.
//
// The audience is a person running commands over SSH and pasting the output back. So: no stack
// traces unless --debug, and every refusal says what to do next.

const { parseArgs } = require('util');
const fs = require('fs');
const path = require('path');
const { expandHome, redact } = require('./env');
const { utcClock } = require('./london');
const { isAllowedStompHost, hostRefusal } = require('./stomp');

const PHASE0_DIR = path.resolve(__dirname, '..');

const DEFAULTS = Object.freeze({
  env: '~/rail-crossing/backend/.env',
  healthUrl: 'http://127.0.0.1:3000/health',
  tdLogDir: '~/rail-crossing/backend/data/logs/td',
  // Resolved from this file, not the current directory: the same folder whether Rich runs
  // `node bin/td-measure.js` from phase0 or `node map-service/phase0/bin/...` from the repo root.
  out: path.join(PHASE0_DIR, 'out')
});

class UsageError extends Error {
  constructor(message) { super(message); this.name = 'UsageError'; this.code = 'USAGE'; }
}

// Options both scripts take. --stomp-host/--stomp-port exist so the scripts can be run against a
// fake server on this machine; they are listed under "for testing" in --help and default to NROD.
// --stomp-host is restricted to loopback or the real NROD host (see resolveCommon).
const COMMON_OPTIONS = Object.freeze({
  env: { type: 'string' },
  'health-url': { type: 'string' },
  'td-log-dir': { type: 'string' },
  out: { type: 'string' },
  'no-interlock': { type: 'boolean' },
  'stomp-host': { type: 'string' },
  'stomp-port': { type: 'string' },
  debug: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' }
});

function parseOptions(argv, extra = {}) {
  try {
    const { values } = parseArgs({ args: argv, options: { ...COMMON_OPTIONS, ...extra }, allowPositionals: false, strict: true });
    return { ...values }; // parseArgs returns a null-prototype object; callers want an ordinary one
  } catch (e) {
    const unknown = /Unknown option '([^']+)'/.exec(e.message);
    if (unknown) throw new UsageError(`Unknown option ${unknown[1]}. Run it with --help to see what is available.`);
    const missing = /Option '([^']+?)(?: <[^>]*>)?' argument missing/.exec(e.message);
    if (missing) throw new UsageError(`The option ${missing[1]} needs a value after it. Run it with --help for examples.`);
    if (e.code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') throw new UsageError('Unexpected extra word on the command line. Every option starts with --; run it with --help.');
    if (e.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') throw new UsageError(`${e.message.replace(/\.$/, '')}. Run it with --help.`);
    throw new UsageError(e.message);
  }
}

/** A whole number in [min, max], or `def` when the option was not given. */
function intOption(name, text, { min, max, def }) {
  if (text === undefined) return def;
  const n = /^\d+$/.test(String(text).trim()) ? Number(text) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new UsageError(`--${name} must be a whole number from ${min} to ${max} (you gave "${text}").`);
  }
  return n;
}

function webAddress(name, text) {
  try {
    const u = new URL(text);
    if (u.protocol === 'http:' || u.protocol === 'https:') return text;
  } catch (_) { /* fall through */ }
  throw new UsageError(`--${name} must be a web address such as ${DEFAULTS.healthUrl} (you gave "${text}").`);
}

/** The paths and switches both scripts share, resolved and validated. */
function resolveCommon(values) {
  // The NROD login goes to whatever host this names, so it is checked first and strictly (see
  // ALLOWED_STOMP_HOSTS in lib/stomp.js). This runs at parse time, before run() reads any credentials.
  // An empty string is "anything else" too, not "use the default".
  const stompHost = values['stomp-host'];
  if (stompHost !== undefined && !isAllowedStompHost(stompHost)) throw new UsageError(hostRefusal(stompHost));
  const port = intOption('stomp-port', values['stomp-port'], { min: 1, max: 65535, def: undefined });
  return {
    envFile: expandHome(values.env || DEFAULTS.env),
    healthUrl: webAddress('health-url', values['health-url'] || DEFAULTS.healthUrl),
    tdLogDir: expandHome(values['td-log-dir'] || DEFAULTS.tdLogDir),
    outDir: values.out ? path.resolve(expandHome(values.out)) : DEFAULTS.out,
    interlock: !values['no-interlock'],
    stomp: { host: stompHost, port },
    debug: !!values.debug
  };
}

/**
 * Make sure the report can be written BEFORE a run of up to four hours starts. Without this a
 * read-only or mistyped --out is found out at the very end — the summary would still print, but
 * the full report would be lost.
 */
function ensureOutDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (e) {
    throw new UsageError(`Cannot write the report to ${dir} (${e.code || e.message}). Pick a folder you can write to with --out.`);
  }
}

// ---- output ------------------------------------------------------------------------------------

/** A progress-line writer: UTC clock prefix, secrets scrubbed, and a closed pipe cannot crash us. */
function makeSay(stdout, secrets, now = Date.now) {
  return function say(message) {
    try { stdout.write(`[${utcClock(now())}] ${redact(message, secrets)}\n`); }
    catch (_) { /* the terminal went away (an SSH drop): the report file is what matters now */ }
  };
}

/** Write text with no prefix (boxes, multi-line explanations), scrubbed. */
function makeWrite(stdout, secrets) {
  return function write(text) {
    try { stdout.write(`${redact(text, secrets)}\n`); } catch (_) { /* as above */ }
  };
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

/** Turn whatever was thrown into text for Rich. With --debug, the stack as well. */
function friendlyError(err, { debug = false } = {}) {
  if (err instanceof UsageError) return err.message;
  if (err && (err.code === 'ENV_UNREADABLE' || err.code === 'ENV_MISSING_CREDS')) return err.message;
  const text = `Something unexpected went wrong: ${err && err.message ? err.message : String(err)}.`;
  if (debug && err && err.stack) return `${text}\n${err.stack}`;
  return `${text} Run it again with --debug for technical detail, and send that output back.`;
}

// ---- signals -----------------------------------------------------------------------------------

/**
 * Route SIGINT / SIGTERM / SIGHUP to `onSignal(name)`. SIGHUP is what an SSH session that drops
 * sends: without handling it a 60-minute run would die with no DISCONNECT and no report.
 * Returns a function that removes the handlers.
 */
function watchSignals(emitter, onSignal) {
  const names = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const handlers = names.map(name => { const fn = () => onSignal(name); emitter.on(name, fn); return [name, fn]; });
  return () => { for (const [name, fn] of handlers) emitter.removeListener(name, fn); };
}

/**
 * What to run on the crossing service afterwards. The interlock polls every 15 s, so a drop that
 * the crossing service recovered from inside one poll is invisible to it — but not to the
 * service's own journal, which logs every error and reconnect.
 */
function journalCheckLines(startMs, endMs) {
  const from = new Date(startMs - 60 * 1000), to = new Date(endMs + 30 * 1000);
  const fmt = d => d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  return [
    'One more check, on the VPS. The crossing service writes every drop and reconnect of its own',
    'connection to its journal; the safety check above can only see trouble that lasts a few seconds.',
    `  sudo journalctl -u rail-crossing --since "${fmt(from)}" --until "${fmt(to)}" | grep -E "TD (STOMP|subscribe|reconnecting|feed silent)"`,
    'No output means the crossing service\'s feed did not drop or reconnect once while this ran.',
    'If anything is printed, send it back with the report.'
  ];
}

module.exports = {
  PHASE0_DIR, DEFAULTS, COMMON_OPTIONS, UsageError,
  parseOptions, intOption, resolveCommon, ensureOutDir, makeSay, makeWrite, fmtDuration, friendlyError, watchSignals, journalCheckLines
};
