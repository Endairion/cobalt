'use strict';

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

/**
 * Saved connections + workspace state on disk.
 * Passwords are encrypted with the OS keychain/DPAPI via safeStorage and are
 * never handed back to the renderer — only a `hasPassword` flag is.
 */
class Store {
  constructor(filename) {
    this.file = path.join(app.getPath('userData'), filename);
    this.data = { connections: [], workspace: null, seenVersion: null };
    this.load();
    this.migratePasswords();
  }

  /**
   * Upgrade any password sitting in plain text to the OS keychain.
   *
   * The plaintext form is the documented fallback for machines where
   * safeStorage is unavailable, and it is also what an entry imported by hand
   * looks like. Either way, once encryption is available there is no reason to
   * leave it readable on disk.
   */
  migratePasswords() {
    if (!safeStorage.isEncryptionAvailable()) return 0;
    let upgraded = 0;
    for (const c of this.data.connections) {
      for (const field of SECRET_FIELDS) {
        if (c[field] && c[field].plain) {
          c[field] = this.encrypt(c[field].plain);
          upgraded++;
        }
      }
    }
    if (upgraded) this.save();
    return upgraded;
  }

  load() {
    try {
      // A byte order mark makes JSON.parse throw, and an editor on Windows will
      // happily add one. Losing every saved connection to that is not acceptable.
      const raw = fs.readFileSync(this.file, 'utf8').replace(/^﻿/, '');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.data = { connections: [], workspace: null, seenVersion: null, ...parsed };
      }
    } catch { /* first run, or unreadable — start clean */ }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  encrypt(plain) {
    if (plain == null || plain === '') return null;
    if (safeStorage.isEncryptionAvailable()) {
      return { enc: safeStorage.encryptString(plain).toString('base64') };
    }
    return { plain };
  }

  decrypt(stored) {
    if (!stored) return '';
    if (stored.enc) {
      try { return safeStorage.decryptString(Buffer.from(stored.enc, 'base64')); }
      catch { return ''; }
    }
    return stored.plain || '';
  }

  /** Connection records safe to send to the renderer, in display order. */
  list() {
    return this.data.connections
      .map((c, i) => ({ ...c, order: typeof c.order === 'number' ? c.order : i }))
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
      .map((c) => {
        const { password, sshPassword, sshPassphrase, ...rest } = c;
        return {
          ...rest,
          hasPassword: !!password,
          hasSshPassword: !!sshPassword,
          hasSshPassphrase: !!sshPassphrase,
        };
      });
  }

  find(id) {
    return this.data.connections.find((c) => c.id === id) || null;
  }

  /**
   * Full config including the decrypted password — main process only.
   *
   * `passwordUnavailable` means a password is stored but this profile cannot
   * read it. safeStorage keys off the profile's own Local State file, so a
   * connections file copied or restored without it decrypts to nothing, and
   * saying so beats letting the driver complain that the password is not a
   * string.
   */
  resolve(id) {
    const c = this.find(id);
    if (!c) return null;
    const { password, sshPassword, sshPassphrase, ...rest } = c;

    // The SSH secrets travel inside config.ssh, which is what Tunnel wants.
    if (rest.ssh && rest.ssh.enabled) {
      rest.ssh = {
        ...rest.ssh,
        password: this.decrypt(sshPassword),
        passphrase: this.decrypt(sshPassphrase),
      };
    }

    if (password && password.enc) {
      try {
        return {
          ...rest,
          password: safeStorage.decryptString(Buffer.from(password.enc, 'base64')),
          passwordUnavailable: false,
        };
      } catch {
        return { ...rest, password: '', passwordUnavailable: true };
      }
    }
    return { ...rest, password: this.decrypt(password), passwordUnavailable: false };
  }

  upsert(record) {
    const id = record.id || `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const existing = this.find(id);
    const engine = String(record.engine || (existing && existing.engine) || 'postgres');
    const next = {
      id,
      name: record.name || 'Untitled',
      engine,
      host: record.host || 'localhost',
      port: Number(record.port) || (engine === 'mysql' ? 3306 : 5432),
      // MySQL has no default database to fall back on; Postgres always has one.
      database: record.database || (engine === 'mysql' ? '' : 'postgres'),
      user: record.user || '',
      ssl: record.ssl || 'disable',
      color: record.color || null,
      group: (record.group || '').trim(),
      readOnly: !!record.readOnly,
      order: typeof record.order === 'number'
        ? record.order
        : (existing && typeof existing.order === 'number' ? existing.order : this.data.connections.length),
      ssh: normalizeSshRecord(record.ssh, existing && existing.ssh),
      password: existing ? existing.password : null,
      sshPassword: existing ? existing.sshPassword : null,
      sshPassphrase: existing ? existing.sshPassphrase : null,
    };
    // An undefined secret means "leave it alone"; '' means "clear it".
    if (record.password !== undefined) next.password = this.encrypt(record.password);
    if (record.sshPassword !== undefined) next.sshPassword = this.encrypt(record.sshPassword);
    if (record.sshPassphrase !== undefined) next.sshPassphrase = this.encrypt(record.sshPassphrase);

    if (existing) Object.assign(existing, next);
    else this.data.connections.push(next);
    this.save();
    return this.list().find((c) => c.id === id);
  }

  remove(id) {
    this.data.connections = this.data.connections.filter((c) => c.id !== id);
    this.save();
  }

  /** Copy a connection, password included, placed right after the original. */
  duplicate(id) {
    const src = this.find(id);
    if (!src) throw new Error('Connection not found.');
    const ordered = this.list();
    const copy = {
      ...src,
      id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: nextCopyName(src.name, new Set(ordered.map((c) => c.name))),
      order: (typeof src.order === 'number' ? src.order : 0) + 0.5,
    };
    this.data.connections.push(copy);
    this.normalizeOrder();
    this.save();
    return this.list().find((c) => c.id === copy.id);
  }

  /** Persist an explicit display order from a list of ids. */
  reorder(ids) {
    const pos = new Map(ids.map((id, i) => [id, i]));
    for (const c of this.data.connections) {
      if (pos.has(c.id)) c.order = pos.get(c.id);
    }
    this.normalizeOrder();
    this.save();
    return this.list();
  }

  /** Collapse fractional/duplicate order values back to 0..n-1. */
  normalizeOrder() {
    this.data.connections
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name))
      .forEach((c, i) => { c.order = i; });
  }

  getSeenVersion() { return this.data.seenVersion || null; }

  setSeenVersion(v) {
    if (this.data.seenVersion === v) return;
    this.data.seenVersion = v;
    this.save();
  }

  getWorkspace() { return this.data.workspace; }

  setWorkspace(ws) {
    this.data.workspace = ws;
    this.save();
  }
}

/** Every field whose value is a secret and never leaves the main process. */
const SECRET_FIELDS = ['password', 'sshPassword', 'sshPassphrase'];

/**
 * The jump-host half of a connection record. Absent or disabled both mean "no
 * tunnel"; the rest is kept either way so turning it off and on again does not
 * lose what you typed.
 */
function normalizeSshRecord(incoming, existing) {
  const src = incoming === undefined ? existing : incoming;
  if (!src) return null;
  return {
    enabled: !!src.enabled,
    host: String(src.host || '').trim(),
    port: Number(src.port) || 22,
    user: String(src.user || '').trim(),
    auth: src.auth === 'key' ? 'key' : 'password',
    keyPath: String(src.keyPath || '').trim(),
  };
}

/** "Local" -> "Local copy" -> "Local copy 2" … */
function nextCopyName(name, taken) {
  const base = /(.*) copy( \d+)?$/.exec(name);
  const stem = base ? base[1] : name;
  let candidate = `${stem} copy`;
  let n = 2;
  while (taken.has(candidate)) candidate = `${stem} copy ${n++}`;
  return candidate;
}

module.exports = { Store, nextCopyName, normalizeSshRecord, SECRET_FIELDS };
