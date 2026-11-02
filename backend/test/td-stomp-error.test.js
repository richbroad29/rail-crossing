'use strict';

// A STOMP ERROR frame from the server must never crash the process.
//
// stompit 1.0.0's ERROR handler has a bug. For a frame with `content-type: text/plain` and a body of
// 4096 bytes or less, it reads the body and then calls `this.destroy(error)` inside a plain-function
// stream callback, where `this` is the FRAME rather than the client. The error is emitted on the frame,
// which has no listener, so Node throws it as an uncaught exception and the whole crossing service
// exits. Neither the connect callback nor `client.on('error')` ever sees it. NROD sends ERROR frames
// for a rejected login and for a topic the account is not subscribed to, so a password change, a
// revoked subscription or a broker fault could take Portslade down (goal 1).
//
// Each scenario runs the REAL stompit, through td-listener's own connect(), against a fake STOMP
// server in a CHILD process. A child process is needed because the failure being tested is the
// process dying, and because a scenario leaves reconnect timers behind. The child reports what it
// saw; the parent asserts on it.

const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

// ---- child: one scenario ---------------------------------------------------------------------

if (process.argv[2] === '--scenario') {
  const scenario = process.argv[3];          // 'login-refused' | 'subscribe-refused' | 'long-body'
  const report = obj => { process.stdout.write(JSON.stringify(obj) + '\n'); process.exit(0); };

  // An uncaught exception is the bug. Record it instead of dying, so the parent can say what happened.
  process.on('uncaughtException', e => report({ crashed: true, error: String(e && e.message) }));

  const logs = [];
  const orig = console.error;
  console.error = (...a) => { logs.push(a.join(' ')); };
  console.log = () => {};

  const body = scenario === 'long-body'
    ? 'java.lang.SecurityException: User is not authorized\n' + '\tat org.apache.activemq.Example(Example.java:1)\n'.repeat(120)
    : scenario === 'login-refused'
      ? 'User name [x] or password is invalid.'
      : 'User x is not authorized to read from: topic://TD_ALL_SIG_AREA';

  const sendError = sock => {
    const bytes = Buffer.byteLength(body);
    const message = scenario === 'login-refused' ? 'User name [x] or password is invalid.' : 'User x is not authorized to read from: topic://TD_ALL_SIG_AREA';
    sock.write(`ERROR\nmessage:${message}\ncontent-type:text/plain\ncontent-length:${bytes}\n\n${body}\0`);
    sock.end();
  };

  const server = net.createServer(sock => {
    let buf = '';
    sock.on('error', () => {});
    sock.on('data', d => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\0')) >= 0) {
        const frame = buf.slice(0, i).replace(/^\s+/, '');
        buf = buf.slice(i + 1);
        const command = frame.split('\n')[0];
        if (command === 'CONNECT' || command === 'STOMP') {
          if (scenario === 'login-refused') sendError(sock);
          else sock.write('CONNECTED\nversion:1.1\nheart-beat:0,0\n\n\0');
        } else if (command === 'SUBSCRIBE') {
          sendError(sock);
        }
      }
    });
  });

  server.listen(0, '127.0.0.1', () => {
    process.env.NR_FEED_USER = 'test-user';
    process.env.NR_FEED_PASS = 'test-pass';
    const td = require('../src/td-listener');
    td._setEndpointForTest('127.0.0.1', server.address().port);
    td._connectForTest();
    // Report after 0.8 s: ample for a local frame and the listener's reaction, and BEFORE the first
    // retry can fire (backoff starts at 1 s), so "exactly one reconnect" means no two at once.
    setTimeout(() => report({ crashed: false, logs }), 800);
  });
  return;
}

// ---- parent: run each scenario and check it ---------------------------------------------------

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { console.log(`  PASS  ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); fail++; }
}

function run(scenario) {
  const r = spawnSync(process.execPath, [__filename, '--scenario', scenario], { encoding: 'utf8', timeout: 20000, cwd: path.join(__dirname, '..') });
  const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop();
  try { return JSON.parse(line); } catch (_) { return { crashed: true, error: `no report (exit ${r.status}): ${(r.stderr || '').slice(0, 300)}` }; }
}

console.log('\nTD listener — a STOMP ERROR frame never crashes the process\n');

for (const [scenario, expectLog] of [
  ['login-refused', /TD STOMP connect failed: .*password is invalid/],
  ['subscribe-refused', /TD STOMP error: .*not authorized|TD subscribe failed: .*not authorized/],
  ['long-body', /TD STOMP error: .*not authorized|TD subscribe failed: .*not authorized/]
]) {
  const r = run(scenario);
  check(`${scenario}: the process survives`, r.crashed === false, r.error);
  const logs = r.logs || [];
  check(`${scenario}: the error reaches the listener's own handler`, logs.some(l => expectLog.test(l)), JSON.stringify(logs));
  // Exactly one: the subscribe callback and client.on('error') both see a refused subscription, and
  // scheduleReconnect's single-flight guard must turn that into one reconnect, never two sockets.
  const reconnects = logs.filter(l => /TD reconnecting in/.test(l)).length;
  check(`${scenario}: exactly one reconnect is scheduled`, reconnects === 1, `${reconnects} scheduled: ${JSON.stringify(logs)}`);
}

console.log(`\n${fail === 0 ? 'All' : ''} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
