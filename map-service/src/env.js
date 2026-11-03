'use strict';

// Reads the crossing back end's .env file for the Network Rail credentials, LITERALLY.
//
// Why not `source .env`: the NROD password contains `$`, and a shell expands it (CLAUDE.md,
// "Credential testing gotcha" — `p$i$d…` becomes `p`). So this does what systemd's
// EnvironmentFile does with an unquoted value: everything after the first `=` is the value.
// No variable expansion, no escape processing. Matching surrounding quotes are stripped, as
// systemd and dotenv both do, so a quoted value reads the same as an unquoted one.
//
// Read-only. Never logs a value: callers get them back and pass them to `redact` before
// anything is printed or written.

const fs = require('fs');
const os = require('os');
const path = require('path');

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const q = value[0];
      if ((q === '"' || q === "'") && value[value.length - 1] === q) value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadEnvFile(file) {
  const p = expandHome(file);
  let text;
  try { text = fs.readFileSync(p, 'utf8'); }
  catch (e) {
    const err = new Error(`Cannot read the credentials file ${p} (${e.code || e.message}). `
      + 'Pass --env with the path to the crossing back end\'s .env file.');
    err.code = 'ENV_UNREADABLE';
    throw err;
  }
  return parseEnv(text);
}

// The Network Rail feed login. Throws a message Rich can act on; never includes the values.
function feedCredentials(env, file) {
  const user = env.NR_FEED_USER, pass = env.NR_FEED_PASS;
  if (!user || !pass) {
    const err = new Error(`NR_FEED_USER and NR_FEED_PASS must both be set in ${file}.`);
    err.code = 'ENV_MISSING_CREDS';
    throw err;
  }
  return { user, pass };
}

// Replace every occurrence of each secret with ***, including its JSON-escaped form, so a
// password containing a quote or backslash is still caught after JSON.stringify.
function redact(text, secrets) {
  let s = String(text);
  for (const secret of secrets || []) {
    if (!secret || secret.length < 3) continue;
    const escaped = JSON.stringify(secret).slice(1, -1);
    for (const form of escaped === secret ? [secret] : [secret, escaped]) s = s.split(form).join('***');
  }
  return s;
}

// The strings to scrub for a given credential pair: the password in its plain, URL-encoded and
// basic-auth forms, and the login too — it is Rich's email address, and NROD error frames echo it
// ("User … is not authorized"). The reports are meant to be pasted into a chat.
function secretsFor(creds) {
  if (!creds) return [];
  const basic = Buffer.from(`${creds.user}:${creds.pass}`).toString('base64');
  return [creds.pass, basic, encodeURIComponent(creds.pass), creds.user, encodeURIComponent(creds.user)]
    .filter((v, i, a) => v && a.indexOf(v) === i);
}

module.exports = { parseEnv, loadEnvFile, feedCredentials, redact, secretsFor, expandHome };
