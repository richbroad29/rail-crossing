'use strict';

// The two shared modules: literal .env parsing and the report writer's scrubbing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseEnv, loadEnvFile, feedCredentials, redact, secretsFor } = require('../lib/env');
const { Report } = require('../lib/report');

test('a $ in the password is kept literally, never expanded', () => {
  const env = parseEnv('NR_FEED_USER=rich@example.com\nNR_FEED_PASS=p$i$d"x\\y\n');
  assert.equal(env.NR_FEED_PASS, 'p$i$d"x\\y');
});

test('comments, blank lines, export, CRLF and matching quotes are handled', () => {
  const env = parseEnv('# c\r\n\r\nexport A=1\r\nB="two words"\r\nC=\'x\'\r\nD="unbalanced\r\nE=a=b\r\n bad line\r\n');
  assert.deepEqual(env, { A: '1', B: 'two words', C: 'x', D: '"unbalanced', E: 'a=b' });
});

test('a missing file says which path and how to fix it', () => {
  assert.throws(() => loadEnvFile('/nonexistent/.env'), e => e.code === 'ENV_UNREADABLE' && /--env/.test(e.message));
});

test('missing credentials are reported without values', () => {
  assert.throws(() => feedCredentials({ NR_FEED_USER: 'u' }, '.env'), e => e.code === 'ENV_MISSING_CREDS');
});

test('redact removes plain, JSON-escaped, base64 and URL-encoded forms, and the login', () => {
  const creds = { user: 'rich@example.com', pass: 'p$i"d\\9' };
  const s = secretsFor(creds);
  const basic = Buffer.from(`${creds.user}:${creds.pass}`).toString('base64');
  const text = `pass=${creds.pass} json=${JSON.stringify(creds.pass)} auth=Basic ${basic} url=${encodeURIComponent(creds.pass)} user=${creds.user}`;
  const out = redact(text, s);
  for (const leaked of [creds.pass, basic, encodeURIComponent(creds.pass), creds.user, JSON.stringify(creds.pass).slice(1, -1)]) {
    assert.ok(!out.includes(leaked), `leaked ${leaked}`);
  }
});

test('report files and summary never contain a secret, and FAIL sets the exit code', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase0-report-'));
  const secret = 'hunter2$"x';
  const r = new Report('unit', { outDir, secrets: [secret], now: () => new Date('2026-11-02T10:15:00Z') });
  r.fact('rows', 42, { summary: true }).fact('err', `connect failed for ${secret}`);
  r.check('A', 'PASS', 'fine').check('B', 'WARN', `saw ${secret}`).note(`note ${secret}`);
  assert.equal(r.exitCode, 0);
  r.check('C', 'FAIL', 'broken');
  assert.equal(r.exitCode, 1);
  const chunks = []; const code = r.finish({ write: s => chunks.push(s) });
  assert.equal(code, 1);
  const printed = chunks.join('');
  assert.match(printed, /===== unit · 2026-11-02T10:15:00.000Z · paste from here =====/);
  assert.match(printed, /fact  rows = 42/);
  for (const f of fs.readdirSync(outDir)) {
    const body = fs.readFileSync(path.join(outDir, f), 'utf8');
    assert.ok(!body.includes(secret) && !body.includes(JSON.stringify(secret).slice(1, -1)), `secret in ${f}`);
  }
  assert.ok(!printed.includes(secret));
});

test('a repeated check id replaces the earlier verdict', () => {
  const r = new Report('unit', { outDir: os.tmpdir() });
  r.check('X', 'FAIL', 'first').check('X', 'PASS', 'second');
  assert.equal(r.checks.length, 1);
  assert.equal(r.exitCode, 0);
});
