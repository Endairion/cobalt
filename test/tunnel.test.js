'use strict';
/* The SSH tunnel, against a real in-process SSH server.
   Run: node test/tunnel.test.js */

const assert = require('assert');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { startSshServer, userKey } = require('./sshfixture.js');

const { Tunnel, normalizeSshConfig, friendlyError } = require('../src/main/tunnel.js');

let n = 0;
const results = [];
// A hung check must fail with its own name rather than stalling the whole run.
const withTimeout = (p, ms) => Promise.race([
  Promise.resolve(p),
  new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms).unref()),
]);

const check = async (label, fn) => {
  try { await withTimeout(fn(), 15000); n++; console.log(`  ok   ${label}`); }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); process.exitCode = 1; }
  results.push(label);
};

/* ------------------------- the test fixtures ------------------------- */

/** A stand-in for the database: answers every connection with a fixed banner. */
function startEchoServer() {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      sock.on('error', () => sock.destroy());
      sock.on('data', (d) => sock.write(`echo:${d.toString()}`));
      sock.write('HELLO\n');
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

/** Connect to host:port, return the first chunk it sends. */
function greet(host, port, send = null) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host, () => { if (send) sock.write(send); });
    let got = '';
    sock.on('data', (d) => {
      got += d.toString();
      if (!send || got.includes('echo:')) { sock.end(); resolve(got); }
    });
    sock.on('error', reject);
    // A forward the jump host refused closes cleanly with nothing on it, which
    // is neither data nor an error — without this the wait never ends.
    sock.on('close', () => { if (!got) reject(new Error('closed with no data')); });
    sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('timed out')); });
  });
}

/* ------------------------------ the tests ------------------------------ */

(async () => {
  console.log('\nconfiguration');

  await check('defaults are filled in', () => {
    const c = normalizeSshConfig({ host: 'jump.example.com', user: 'me' });
    assert.strictEqual(c.port, 22);
    assert.strictEqual(c.auth, 'password');
  });

  await check('a missing host, user or key is refused with which one', () => {
    assert.throws(() => normalizeSshConfig({ user: 'me' }), /SSH host is required/);
    assert.throws(() => normalizeSshConfig({ host: 'h' }), /SSH user is required/);
    assert.throws(() => normalizeSshConfig({ host: 'h', user: 'm', auth: 'key' }), /private key file/);
  });

  await check('an impossible port is refused', () => {
    assert.throws(() => normalizeSshConfig({ host: 'h', user: 'm', port: 99999 }), /not a usable SSH port/);
  });

  console.log('\nerror messages say what to do');

  const cfg = normalizeSshConfig({ host: 'jump', user: 'me', password: 'x' });
  await check('a rejected password', () => {
    const e = friendlyError(new Error('All configured authentication methods failed'), cfg);
    assert.ok(/rejected the password/.test(e.message), e.message);
    assert.ok(/me@jump:22/.test(e.message), e.message);
  });

  await check('a refused connection names the host and port', () => {
    assert.ok(/Nothing is listening on jump:22/.test(
      friendlyError(new Error('connect ECONNREFUSED 1.2.3.4:22'), cfg).message));
  });

  await check('a .ppk is called out, since it is the common trip-up', () => {
    const keyCfg = normalizeSshConfig({ host: 'jump', user: 'me', auth: 'key', keyPath: 'C:/k.ppk' });
    assert.ok(/converted first/.test(
      friendlyError(new Error('Cannot parse privateKey'), keyCfg).message));
  });

  await check('the original error is kept, not swallowed', () => {
    const original = new Error('ECONNREFUSED');
    assert.strictEqual(friendlyError(original, cfg).cause, original);
  });

  console.log('\nforwarding, through a real SSH server');

  const echo = await startEchoServer();
  const sshd = await startSshServer();

  let tunnel;
  await check('a password tunnel forwards to the target', async () => {
    tunnel = new Tunnel({ host: '127.0.0.1', port: sshd.port, user: 'jump', password: 'secret' });
    const local = await tunnel.open({ host: '127.0.0.1', port: echo.port });
    assert.strictEqual(local.host, '127.0.0.1');
    assert.ok(local.port > 0);
    const said = await greet(local.host, local.port);
    assert.ok(said.startsWith('HELLO'), `got ${JSON.stringify(said)}`);
  });

  await check('bytes travel both ways', async () => {
    const said = await greet(tunnel.local.host, tunnel.local.port, 'ping');
    assert.ok(said.includes('echo:ping'), `got ${JSON.stringify(said)}`);
  });

  await check('the jump host was asked for the right destination', () => {
    const last = sshd.state.forwards[sshd.state.forwards.length - 1];
    assert.strictEqual(last.destPort, echo.port);
    assert.strictEqual(last.destIP, '127.0.0.1');
  });

  // The whole point of the explicit bind address.
  await check('the listener is on loopback only, not every interface', () => {
    const addr = tunnel.server.address();
    assert.strictEqual(addr.address, '127.0.0.1',
      `bound to ${addr.address} — that would expose the database to the network`);
  });

  await check('several connections share the one tunnel', async () => {
    const before = tunnel.opened;
    await Promise.all([
      greet(tunnel.local.host, tunnel.local.port),
      greet(tunnel.local.host, tunnel.local.port),
      greet(tunnel.local.host, tunnel.local.port),
    ]);
    assert.strictEqual(tunnel.opened, before + 3);
  });

  await check('closing it stops the listener', async () => {
    const { port } = tunnel.local;
    await tunnel.close();
    await assert.rejects(() => greet('127.0.0.1', port), /ECONNREFUSED|ECONNRESET|closed with no data|timed out/);
  });

  console.log('\nkey authentication');

  await check('a private key file is accepted', async () => {
    const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-key-')), 'id_rsa');
    fs.writeFileSync(keyFile, userKey.privateKey);
    const t = new Tunnel({ host: '127.0.0.1', port: sshd.port, user: 'jump', auth: 'key', keyPath: keyFile });
    const local = await t.open({ host: '127.0.0.1', port: echo.port });
    assert.ok((await greet(local.host, local.port)).startsWith('HELLO'));
    await t.close();
    fs.rmSync(path.dirname(keyFile), { recursive: true, force: true });
  });

  await check('a key file that is not there names the file', async () => {
    const t = new Tunnel({ host: '127.0.0.1', port: sshd.port, user: 'jump', auth: 'key', keyPath: 'C:/nope/id_rsa' });
    await assert.rejects(() => t.open({ host: '127.0.0.1', port: echo.port }), /could not read the private key/);
  });

  console.log('\nwhen it goes wrong');

  await check('a wrong password is reported as a rejected password', async () => {
    const t = new Tunnel({ host: '127.0.0.1', port: sshd.port, user: 'jump', password: 'wrong' });
    await assert.rejects(
      () => t.open({ host: '127.0.0.1', port: echo.port }),
      (e) => /rejected the password/.test(e.message));
    await t.close();
  });

  await check('nothing listening on the SSH port is reported as such', async () => {
    const dead = await new Promise((r) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
    });
    const t = new Tunnel({ host: '127.0.0.1', port: dead, user: 'jump', password: 'secret' });
    await assert.rejects(
      () => t.open({ host: '127.0.0.1', port: echo.port }),
      (e) => /Nothing is listening on/.test(e.message));
    await t.close();
  });

  await check('a jump host that cannot reach the database says so', async () => {
    const strict = await startSshServer({ allowForward: false });
    const t = new Tunnel({ host: '127.0.0.1', port: strict.port, user: 'jump', password: 'secret' });
    const local = await t.open({ host: '10.0.0.1', port: 5432 });
    await assert.rejects(() => greet(local.host, local.port), /ECONNRESET|ECONNREFUSED|closed with no data|timed out/);
    assert.ok(/could not reach 10\.0\.0\.1:5432/.test(t.reason() || ''), `got ${t.reason()}`);
    await t.close();
    strict.srv.close();
  });

  await check('a dropped tunnel closes the listener and remembers why', async () => {
    const t = new Tunnel({ host: '127.0.0.1', port: sshd.port, user: 'jump', password: 'secret' });
    const local = await t.open({ host: '127.0.0.1', port: echo.port });
    t.ssh.end();                                   // as if the network went away
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(t.dead, true);
    assert.ok(/tunnel (closed|ended)/.test(t.reason() || ''), `got ${t.reason()}`);
    await assert.rejects(() => greet(local.host, local.port), /ECONNREFUSED|ECONNRESET|closed with no data|timed out/);
    await t.close();
  });

  echo.srv.close();
  sshd.srv.close();

  console.log(`\n${process.exitCode ? 'failures above' : `all ${n} checks passed`}\n`);
  process.exit(process.exitCode || 0);
})();
