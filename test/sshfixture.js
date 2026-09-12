'use strict';

/**
 * A real SSH server, in process, for the tunnel tests.
 *
 * Testing a tunnel against a mock proves the mock works. This is an actual
 * ssh2 server with generated host and user keys: it does the handshake, checks
 * the password or the public key, and forwards direct-tcpip channels wherever
 * they ask — so the tunnel under test is doing real SSH.
 */

const net = require('net');
const crypto = require('crypto');
const ssh2 = require('ssh2');

const pem = () => crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const hostKeyPair = pem();
const userKeyPair = pem();

const hostKey = hostKeyPair.privateKey;
const userKey = userKeyPair;

/** Accepts one password and one public key; forwards anywhere it is asked. */
function startSshServer({ password = 'secret', user = 'jump', allowForward = true } = {}) {
  // ssh2 does not read a PKCS#1 PEM public key, and the private one carries the
  // public half anyway.
  const authorized = ssh2.utils.parseKey(userKey.privateKey);
  if (authorized instanceof Error) throw authorized;
  const state = { forwards: [], authAttempts: [] };

  return new Promise((resolve) => {
    const srv = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
      client.on('error', () => { /* a client hanging up is normal here */ });

      client.on('authentication', (ctx) => {
        state.authAttempts.push({ method: ctx.method, username: ctx.username });
        if (ctx.username !== user) return ctx.reject();
        if (ctx.method === 'password') {
          return ctx.password === password ? ctx.accept() : ctx.reject();
        }
        if (ctx.method === 'publickey') {
          const mine = authorized.getPublicSSH();
          const ok = ctx.key.algo === authorized.type
            && ctx.key.data.length === mine.length
            && crypto.timingSafeEqual(ctx.key.data, mine);
          if (!ok) return ctx.reject();
          // A signature is only present on the second round trip.
          if (ctx.signature && !authorized.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.reject();
          return ctx.accept();
        }
        return ctx.reject(['password', 'publickey']);
      });

      client.on('ready', () => {
        client.on('tcpip', (accept, reject, info) => {
          state.forwards.push({ destIP: info.destIP, destPort: info.destPort });
          if (!allowForward) return reject();
          const channel = accept();
          const sock = net.connect(info.destPort, info.destIP, () => {
            channel.pipe(sock).pipe(channel);
          });
          sock.on('error', () => channel.end());
          channel.on('error', () => sock.destroy());
        });
        client.on('session', (acceptSession) => acceptSession());
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, state }));
  });
}

module.exports = { startSshServer, hostKey, userKey };
