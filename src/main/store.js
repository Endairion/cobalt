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
    this.data = { connections: [], workspace: null };
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.data = { connections: [], workspace: null, ...parsed };
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

  /** Connection records safe to send to the renderer. */
  list() {
    return this.data.connections.map((c) => {
      const { password, ...rest } = c;
      return { ...rest, hasPassword: !!password };
    });
  }

  find(id) {
    return this.data.connections.find((c) => c.id === id) || null;
  }

  /** Full config including the decrypted password — main process only. */
  resolve(id) {
    const c = this.find(id);
    if (!c) return null;
    const { password, ...rest } = c;
    return { ...rest, password: this.decrypt(password) };
  }

  upsert(record) {
    const id = record.id || `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const existing = this.find(id);
    const next = {
      id,
      name: record.name || 'Untitled',
      host: record.host || 'localhost',
      port: Number(record.port) || 5432,
      database: record.database || 'postgres',
      user: record.user || '',
      ssl: record.ssl || 'disable',
      color: record.color || null,
      readOnly: !!record.readOnly,
      password: existing ? existing.password : null,
    };
    // An undefined password means "leave it alone"; '' means "clear it".
    if (record.password !== undefined) next.password = this.encrypt(record.password);

    if (existing) Object.assign(existing, next);
    else this.data.connections.push(next);
    this.save();
    const { password, ...rest } = next;
    return { ...rest, hasPassword: !!next.password };
  }

  remove(id) {
    this.data.connections = this.data.connections.filter((c) => c.id !== id);
    this.save();
  }

  getWorkspace() { return this.data.workspace; }

  setWorkspace(ws) {
    this.data.workspace = ws;
    this.save();
  }
}

module.exports = { Store };
