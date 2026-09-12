'use strict';

const net = require('net');
const fs = require('fs');
const { Client } = require('ssh2');

/**
 * An SSH tunnel to a database that is not directly reachable.
 *
 * A local listener accepts connections and forwards each one over SSH to the
 * database host as seen from the jump box. The driver then connects to the
 * local end and knows nothing about any of this.
 *
 * The listener binds to 127.0.0.1 and nothing else. Binding to 0.0.0.0 — which
 * is the default if you pass no address, and an easy mistake — would publish
 * the production database to every machine on the network the laptop happens to
 * be on, with no password prompt of its own. There is a test that asserts the
 * bound address.
 *
 * Port 0 asks the OS for a free port, so two connections through two different
 * jump hosts cannot collide.
 */

const DEFAULT_PORT = 22;
const READY_TIMEOUT_MS = 20000;
const KEEPALIVE_MS = 15000;

/** Fill in defaults and reject a configuration that cannot work. */
function normalizeSshConfig(raw = {}) {
  const cfg = {
    host: String(raw.host || '').trim(),
    port: Number(raw.port) || DEFAULT_PORT,
    user: String(raw.user || '').trim(),
    auth: raw.auth === 'key' ? 'key' : 'password',
    password: raw.password || '',
    keyPath: String(raw.keyPath || '').trim(),
    passphrase: raw.passphrase || '',
  };
  if (!cfg.host) throw new Error('The SSH host is required.');
  if (!cfg.user) throw new Error('The SSH user is required.');
  if (cfg.port < 1 || cfg.port > 65535) throw new Error(`${raw.port} is not a usable SSH port.`);
  if (cfg.auth === 'key' && !cfg.keyPath) throw new Error('Choose a private key file, or switch to password authentication.');
  return cfg;
}

/**
 * ssh2's errors are accurate and unhelpful. Say what to do about them.
 * The original is kept on `.cause` so nothing is actually hidden.
 */
function friendlyError(err, cfg) {
  const msg = String((err && err.message) || err || '');
  const where = `${cfg.user}@${cfg.host}:${cfg.port}`;
  let text = msg;

  if (/All configured authentication methods failed/i.test(msg)) {
    text = cfg.auth === 'key'
      ? `${where} rejected the key in ${cfg.keyPath}. Check the key is authorized for this user, and that any passphrase is right.`
      : `${where} rejected the password.`;
  } else if (/ECONNREFUSED/.test(msg)) {
    text = `Nothing is listening on ${cfg.host}:${cfg.port} — check the SSH host and port.`;
  } else if (/ENOTFOUND|EAI_AGAIN/.test(msg)) {
    text = `The SSH host ${cfg.host} could not be resolved.`;
  } else if (/ETIMEDOUT|Timed out while waiting for handshake/i.test(msg)) {
    text = `${cfg.host}:${cfg.port} did not answer. A firewall or a VPN that is not up would do that.`;
  } else if (/Cannot parse privateKey|Unsupported key format/i.test(msg)) {
    text = `${cfg.keyPath} is not a private key Cobalt can read. OpenSSH and PEM keys both work; a PuTTY .ppk has to be converted first.`;
  } else if (/no passphrase given|Encrypted private key detected/i.test(msg)) {
    text = `${cfg.keyPath} is encrypted — enter its passphrase.`;
  }

  const out = new Error(`SSH: ${text}`);
  out.cause = err;
  return out;
}

class Tunnel {
  constructor(rawConfig) {
    this.config = normalizeSshConfig(rawConfig);
    this.ssh = null;
    this.server = null;
    this.dead = false;
    this.deadReason = null;
    this.opened = 0;        // forwarded connections, for the status line
    this.sockets = new Set();   // live forwards, so close() can actually finish
  }

  /** Read the key here rather than in ssh2, so the error names the file. */
  readKey() {
    try {
      return fs.readFileSync(this.config.keyPath);
    } catch (err) {
      throw new Error(`SSH: could not read the private key ${this.config.keyPath} (${err.code || err.message}).`);
    }
  }

  connectOptions() {
    const c = this.config;
    const opts = {
      host: c.host,
      port: c.port,
      username: c.user,
      readyTimeout: READY_TIMEOUT_MS,
      keepaliveInterval: KEEPALIVE_MS,
    };
    if (c.auth === 'key') {
      opts.privateKey = this.readKey();
      if (c.passphrase) opts.passphrase = c.passphrase;
    } else {
      opts.password = c.password;
      // Some servers offer the password through keyboard-interactive instead.
      opts.tryKeyboard = true;
    }
    return opts;
  }

  /** dst: { host, port } as the jump host sees the database. */
  async open(dst) {
    const cfg = this.config;
    const opts = this.connectOptions();

    await new Promise((resolve, reject) => {
      const ssh = new Client();
      this.ssh = ssh;
      const fail = (err) => { cleanup(); reject(friendlyError(err, cfg)); };
      const cleanup = () => {
        ssh.removeListener('ready', onReady);
        ssh.removeListener('error', fail);
      };
      const onReady = () => { cleanup(); resolve(); };

      ssh.on('ready', onReady);
      ssh.on('error', fail);
      if (opts.tryKeyboard) {
        ssh.on('keyboard-interactive', (_n, _i, _l, _p, finish) => finish([cfg.password]));
      }
      ssh.connect(opts);
    });

    // Once it is up, a drop is not this call's problem — but it must stop the
    // listener, so a query fails immediately with a reason instead of hanging.
    this.ssh.on('error', (err) => this.markDead(friendlyError(err, cfg).message));
    this.ssh.on('close', () => this.markDead('SSH: the tunnel closed.'));
    this.ssh.on('end', () => this.markDead('SSH: the tunnel ended.'));

    const server = net.createServer((socket) => {
      socket.on('error', () => socket.destroy());
      // net.Server#close waits for every open connection, so a pool holding a
      // socket would make close() hang forever. Track them and cut them.
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      if (this.dead || !this.ssh) { socket.destroy(); return; }
      this.opened++;
      this.ssh.forwardOut('127.0.0.1', socket.remotePort || 0, dst.host, dst.port, (err, stream) => {
        if (err) {
          this.lastForwardError = `SSH: the jump host could not reach ${dst.host}:${dst.port} (${err.message}).`;
          socket.destroy();
          return;
        }
        stream.on('error', () => socket.destroy());
        socket.pipe(stream).pipe(socket);
      });
    });
    this.server = server;

    const port = await new Promise((resolve, reject) => {
      server.once('error', reject);
      // 127.0.0.1 explicitly: see the note at the top of this file.
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });

    this.local = { host: '127.0.0.1', port };
    this.dst = dst;
    return this.local;
  }

  markDead(reason) {
    if (this.dead) return;
    this.dead = true;
    this.deadReason = reason;
    if (this.server) { try { this.server.close(); } catch { /* already closing */ } }
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }

  /** Whatever went wrong most recently, for a connection error to quote. */
  reason() {
    return this.deadReason || this.lastForwardError || null;
  }

  describe() {
    const c = this.config;
    return `${c.user}@${c.host}:${c.port}`;
  }

  async close() {
    this.dead = true;
    const server = this.server;
    const ssh = this.ssh;
    this.server = null;
    this.ssh = null;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    if (server) {
      await new Promise((resolve) => {
        // Belt and braces: if something still holds the server, do not hang the
        // app on the way out.
        const done = setTimeout(resolve, 2000);
        server.close(() => { clearTimeout(done); resolve(); });
      });
    }
    if (ssh) { try { ssh.end(); } catch { /* already gone */ } }
  }
}

module.exports = { Tunnel, normalizeSshConfig, friendlyError };
