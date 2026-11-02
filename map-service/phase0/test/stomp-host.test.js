'use strict';

// The NROD login must never go to a host nobody intended. --stomp-host exists only so the scripts
// can be tested against a fake server on this machine, so it accepts EXACTLY loopback or the real
// NROD host and refuses everything else. That is enforced three times, because each is a different
// way in: at the command line (exit 2, before the credentials are read), in run() (any other
// caller), and in openSession (where the login is actually put on the wire).

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const stomp = require('../lib/stomp');
const cli = require('../lib/cli');
const tdMeasure = require('../bin/td-measure');
const feedsCheck = require('../bin/feeds-check');
const { makeRig } = require('./helpers/rig');

const NROD_HOST = 'publicdatafeeds.networkrail.co.uk';
const ACCEPTED = ['localhost', '127.0.0.1', '::1', NROD_HOST];
const BIN = name => path.join(__dirname, '..', 'bin', name);
const cleanups = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) { try { await c(); } catch (_) { /* best effort */ } }
  stomp._resetForTest();
});

// Every way a host might look right at a glance and not be.
const REFUSED = [
  ['an arbitrary host', 'example.com'],
  ['an NROD look-alike (suffix)', `${NROD_HOST}.evil.com`],
  ['an NROD look-alike (prefix)', `evil-${NROD_HOST}`],
  ['the NROD host with a trailing dot', `${NROD_HOST}.`],
  ['the NROD host in another case', 'PublicDataFeeds.NetworkRail.co.uk'],
  ['localhost in capitals', 'LOCALHOST'],
  ['localhost with a trailing dot', 'localhost.'],
  ['a host that merely starts with localhost', 'localhost.evil.com'],
  ['a host that merely starts with 127.0.0.1', '127.0.0.1.evil.com'],
  ['another loopback address', '127.0.0.2'],
  ['the far end of 127/8', '127.255.255.254'],
  ['the any-address', '0.0.0.0'],
  ['a public IP address', '93.184.216.34'],
  ['a LAN address', '192.168.1.10'],
  ['the cloud metadata address', '169.254.169.254'],
  ['IPv6 loopback in brackets', '[::1]'],
  ['IPv6 loopback written out', '0:0:0:0:0:0:0:1'],
  ['IPv4-mapped IPv6 loopback', '::ffff:127.0.0.1'],
  ['a host with a port', '127.0.0.1:61618'],
  ['a host with a user in front', 'user@127.0.0.1'],
  ['a leading space', ' localhost'],
  ['a trailing space', 'localhost '],
  ['a trailing newline', 'localhost\n'],
  ['a path after the host', 'localhost/evil'],
  ['a whole URL', 'http://localhost'],
  ['an empty string', '']
];

const REFUSAL = host => new RegExp(`^--stomp-host must be localhost, 127\\.0\\.0\\.1, ::1 or publicdatafeeds\\.networkrail\\.co\\.uk \\(you gave "${host.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"\\)\\. It exists so the scripts can be tested against a fake server on this machine, and the NROD login is never sent anywhere else\\.$`);

// ---- the rule itself -----------------------------------------------------------------------------------

test('the allowlist is exactly loopback and the real NROD host, and it cannot be edited at run time', () => {
  assert.deepEqual([...stomp.ALLOWED_STOMP_HOSTS], ACCEPTED);
  assert.ok(Object.isFrozen(stomp.ALLOWED_STOMP_HOSTS));
  assert.equal(stomp.NROD.host, NROD_HOST);
});

for (const host of ACCEPTED) {
  test(`accepted: ${host}`, () => {
    assert.equal(stomp.isAllowedStompHost(host), true);
    assert.equal(cli.resolveCommon({ 'stomp-host': host }).stomp.host, host, 'passes the command line, unchanged');
  });
}

for (const [why, host] of REFUSED) {
  test(`refused: ${why} (${JSON.stringify(host)})`, () => {
    assert.equal(stomp.isAllowedStompHost(host), false);
    assert.throws(() => cli.resolveCommon({ 'stomp-host': host }), e => e instanceof cli.UsageError && REFUSAL(host).test(e.message), 'the command line says so, in plain words');
  });
}

test('refused: anything that is not a string at all', () => {
  for (const bad of [undefined, null, 42, true, {}, ['localhost'], () => 'localhost', Symbol('localhost')]) {
    assert.equal(stomp.isAllowedStompHost(bad), false, String(typeof bad));
  }
});

test('no --stomp-host at all means the real NROD host, which is fine; the port is independent', () => {
  const d = cli.resolveCommon({});
  assert.equal(d.stomp.host, undefined);
  assert.equal(cli.resolveCommon({ 'stomp-port': '4242' }).stomp.port, 4242);
  assert.deepEqual(cli.resolveCommon({ 'stomp-host': '127.0.0.1', 'stomp-port': '4242' }).stomp, { host: '127.0.0.1', port: 4242 });
});

test('both scripts parse the flag through the same rule', () => {
  for (const { parseCli } of [tdMeasure, feedsCheck]) {
    for (const host of ACCEPTED) assert.equal(parseCli(['--stomp-host', host]).options.stomp.host, host);
    assert.throws(() => parseCli(['--stomp-host', 'evil.example.com']), e => e instanceof cli.UsageError && REFUSAL('evil.example.com').test(e.message));
    assert.throws(() => parseCli(['--stomp-host', '']), cli.UsageError, 'an empty value is "anything else", not "use the default"');
  }
});

// ---- the last line of defence: openSession -------------------------------------------------------------------------

const CREDS = { user: 'rich@example.com', pass: 'p$ssw0rd' };
const fakeClient = () => {
  const c = { on() { return c; }, destroy() {}, disconnect(cb) { setImmediate(() => cb(null)); }, subscribe() {} };
  return c;
};

test('openSession refuses a disallowed host BEFORE anything is opened or reserved', async () => {
  let connectCalls = 0;
  // If the guard ever goes missing this must fail at once and say why, not sit out the 30 s bound.
  const connect = (opts, cb) => {
    connectCalls++;
    setImmediate(() => cb(new Error('connect must never be called for a refused host')));
    return fakeClient();
  };
  for (const [, host] of REFUSED.filter(([, h]) => h !== '')) {
    const err = await stomp.openSession({ creds: CREDS, host, connect }).catch(e => e);
    assert.ok(err instanceof stomp.StompError, host);
    assert.equal(err.kind, 'refused', host);
    assert.equal(err.message, stomp.hostRefusal(host));
  }
  assert.equal(connectCalls, 0, 'stompit was never asked to connect, so no credentials could have been sent');
  // And it did not leave the one-connection slot taken.
  const s = await stomp.openSession({ creds: CREDS, host: '127.0.0.1', connect: (o, cb) => { const c = fakeClient(); setImmediate(() => cb(null, c)); return c; } });
  assert.ok(s.isOpen);
  await s.close();
});

test('openSession passes an allowed host through to stompit exactly as given', async () => {
  for (const host of ACCEPTED) {
    let seen;
    const s = await stomp.openSession({ creds: CREDS, host, port: 4242, connect: (o, cb) => { seen = o; const c = fakeClient(); setImmediate(() => cb(null, c)); return c; } });
    assert.equal(seen.host, host);
    assert.equal(seen.port, 4242);
    assert.equal(seen.connectHeaders.login, CREDS.user, 'the login goes to this host, and only because it is allowed');
    await s.close();
  }
  // No host given: the real NROD host and port.
  let seen;
  const s = await stomp.openSession({ creds: CREDS, connect: (o, cb) => { seen = o; const c = fakeClient(); setImmediate(() => cb(null, c)); return c; } });
  assert.equal(seen.host, NROD_HOST);
  assert.equal(seen.port, 61618);
  await s.close();
});

test('a refusal is explained in plain words by explain()', () => {
  const err = new stomp.StompError({ kind: 'refused', phase: 'connect', topic: null, code: null, serverMessage: null, serverDetail: null, message: stomp.hostRefusal('evil.example.com') });
  assert.equal(stomp.explain(err.info), stomp.hostRefusal('evil.example.com'));
});

// ---- run(): any caller, before the credentials are read ----------------------------------------------------------------

const rigs = {
  'td-measure': { run: tdMeasure.run, rig: makeRig(cleanups, { minutes: 1 }) },
  'feeds-check': { run: feedsCheck.run, rig: makeRig(cleanups, { minutes: { trust: 3, vstp: 10 }, only: null }) }
};

for (const [name, { run, rig }] of Object.entries(rigs)) {
  test(`${name}.run() refuses a disallowed host with exit 2, before reading credentials, opening anything, or looking at the crossing service`, async () => {
    const r = await rig();
    // An unreadable credentials file: if the host check came AFTER the credentials were read, the
    // complaint would be about the file. It must be about the host.
    const code = await run({ ...r.opts, envFile: '/nonexistent/.env', stomp: { host: 'evil.example.com', port: r.srv.port } }, r.deps);
    assert.equal(code, 2);
    const err = r.err.join('');
    assert.match(err.trim(), REFUSAL('evil.example.com'));
    assert.ok(!/credentials file/.test(err), 'the credentials were never read');
    assert.equal(r.out.join(''), '', 'nothing else was said');
    assert.equal(r.srv.connections.length, 0, 'no connection');
    assert.equal(r.health.requests, 0, 'not even a look at the crossing service');
    assert.equal(fs.existsSync(r.opts.outDir), false, 'nothing written');
  });

  test(`${name}.run() with a VALID credentials file still refuses a bad host, and the login appears nowhere`, async () => {
    const r = await rig();
    const code = await run({ ...r.opts, stomp: { host: '93.184.216.34', port: r.srv.port } }, r.deps);
    assert.equal(code, 2);
    assert.match(r.err.join('').trim(), REFUSAL('93.184.216.34'));
    assert.equal(r.srv.connections.length, 0);
    assert.ok(!r.text().includes('tester@example.com'));
  });

  test(`${name}.run() accepts the loopback host the fake server is on (the allowed path still works)`, async () => {
    const r = await rig({ extraDeps: { durationMs: 300, windowsMs: { trust: 300, vstp: 300 } }, extraOpts: { only: name === 'feeds-check' ? 'trust' : null } });
    const code = await run(r.opts, r.deps);
    assert.ok([0, 1].includes(code), `ran to a verdict (exit ${code}), not refused with 2`);
    assert.equal(r.srv.connections.length, 1, 'it connected');
  });
}

// ---- the real command line: a child process, exit status and stderr ----------------------------------------------------------

function spawnBin(bin, args) {
  return spawnSync(process.execPath, [BIN(bin), ...args], { encoding: 'utf8', timeout: 30000 });
}

for (const bin of ['td-measure.js', 'feeds-check.js']) {
  test(`${bin} as a real process: a bad host with an unreadable credentials file exits 2 and complains about the HOST`, () => {
    const t0 = Date.now();
    const r = spawnBin(bin, ['--stomp-host', 'evil.example.com', '--env', '/nonexistent/.env']);
    assert.equal(r.status, 2);
    assert.match(r.stderr.trim(), REFUSAL('evil.example.com'));
    assert.ok(!/credentials file/.test(r.stderr), 'the credentials file was never touched');
    assert.equal(r.stdout, '');
    assert.ok(Date.now() - t0 < 10000, 'refused at once: no DNS lookup, no connection attempt');
  });

  for (const host of ACCEPTED) {
    test(`${bin} as a real process: --stomp-host ${host} gets past the host check (and stops at the missing credentials file)`, () => {
      const r = spawnBin(bin, ['--stomp-host', host, '--env', '/nonexistent/.env']);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /^Cannot read the credentials file \/nonexistent\/\.env/);
      assert.ok(!/--stomp-host must be/.test(r.stderr), 'the host was accepted');
    });
  }

  test(`${bin} as a real process: with real credentials in the env file, a bad host still never touches them`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase0-host-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const env = path.join(dir, '.env');
    fs.writeFileSync(env, 'NR_FEED_USER=distinctive-login@example.org\nNR_FEED_PASS=distinctive$pass"word\n');
    const r = spawnBin(bin, ['--stomp-host', '203.0.113.9', '--env', env, '--out', path.join(dir, 'out')]);
    assert.equal(r.status, 2);
    assert.match(r.stderr.trim(), REFUSAL('203.0.113.9'));
    const all = r.stdout + r.stderr;
    assert.ok(!all.includes('distinctive-login') && !all.includes('distinctive$pass'), 'no credential in the output');
    assert.equal(fs.existsSync(path.join(dir, 'out')), false, 'no report folder was created either');
  });
}

test('--help for both scripts names the rule (so Rich never has to guess what the flag is for)', () => {
  for (const HELP of [tdMeasure.HELP, feedsCheck.HELP]) {
    assert.match(HELP, /HOST may only be localhost, 127\.0\.0\.1, ::1 or publicdatafeeds\.networkrail\.co\.uk:\n\s+the NROD login is never sent anywhere else\./);
  }
});
