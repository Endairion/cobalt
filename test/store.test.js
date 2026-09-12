'use strict';
/* Saved-connection store: ordering, duplication, password handling.
   Stubs Electron so it runs under plain node. Run: node test/store.test.js */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-store-'));

// Minimal Electron stub: a userData path and a safeStorage that is "unavailable",
// which exercises the plaintext fallback path.
let encryptionAvailable = false;
const stub = {
  app: { getPath: () => dir },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (b) => b.toString('utf8').replace(/^enc:/, ''),
  },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return origResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = { id: 'electron-stub', filename: 'electron-stub', loaded: true, exports: stub };

const { Store, nextCopyName } = require('../src/main/store');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

const fresh = () => {
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
  return new Store('conns.json');
};

console.log('\nstore');

test('saves and lists a connection without leaking the password', () => {
  const s = fresh();
  const rec = s.upsert({ name: 'Local', host: 'db', port: 5433, database: 'app', user: 'me', password: 'hunter2' });
  assert.strictEqual(rec.hasPassword, true);
  assert.strictEqual(rec.password, undefined, 'password must not come back');
  const [listed] = s.list();
  assert.strictEqual(listed.password, undefined);
  assert.strictEqual(listed.hasPassword, true);
  assert.strictEqual(s.resolve(rec.id).password, 'hunter2', 'main process can still read it');
});

test('a blank password leaves the stored one alone', () => {
  const s = fresh();
  const rec = s.upsert({ name: 'A', password: 'keep' });
  s.upsert({ id: rec.id, name: 'A renamed' });            // password key absent
  assert.strictEqual(s.resolve(rec.id).password, 'keep');
  assert.strictEqual(s.find(rec.id).name, 'A renamed');
  s.upsert({ id: rec.id, name: 'A', password: '' });      // explicitly cleared
  assert.strictEqual(s.resolve(rec.id).password, '');
});

test('uses safeStorage when it is available', () => {
  encryptionAvailable = true;
  const s = fresh();
  const rec = s.upsert({ name: 'Enc', password: 'secret' });
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'conns.json'), 'utf8'));
  assert.ok(raw.connections[0].password.enc, 'stored under .enc');
  assert.ok(!JSON.stringify(raw).includes('secret'), 'plaintext must not hit disk');
  assert.strictEqual(s.resolve(rec.id).password, 'secret');
  encryptionAvailable = false;
});

test('a plaintext password is upgraded to the keychain on load', () => {
  // What an entry imported by hand looks like, or one written on a machine
  // where safeStorage was unavailable.
  encryptionAvailable = false;
  const s = fresh();
  const rec = s.upsert({ name: 'Imported', password: 'from-outside' });
  const onDisk = () => JSON.parse(fs.readFileSync(path.join(dir, 'conns.json'), 'utf8'));
  assert.strictEqual(onDisk().connections[0].password.plain, 'from-outside', 'stored in the clear first');

  encryptionAvailable = true;
  const reopened = new Store('conns.json');
  const after = onDisk().connections[0].password;
  assert.ok(after.enc, 'upgraded to the encrypted form');
  assert.strictEqual(after.plain, undefined, 'and the plaintext is gone');
  assert.strictEqual(reopened.resolve(rec.id).password, 'from-outside', 'still readable');
  encryptionAvailable = false;
});

test('migration leaves already-encrypted entries alone', () => {
  encryptionAvailable = true;
  const s = fresh();
  s.upsert({ name: 'A', password: 'secret' });
  const before = JSON.parse(fs.readFileSync(path.join(dir, 'conns.json'), 'utf8')).connections[0].password.enc;
  const reopened = new Store('conns.json');
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'conns.json'), 'utf8')).connections[0].password.enc;
  assert.strictEqual(after, before, 'not re-encrypted needlessly');
  assert.strictEqual(reopened.list().length, 1);
  encryptionAvailable = false;
});

test('migration is a no-op when encryption is unavailable', () => {
  encryptionAvailable = false;
  const s = fresh();
  s.upsert({ name: 'A', password: 'secret' });
  assert.strictEqual(new Store('conns.json').migratePasswords(), 0);
  assert.strictEqual(
    JSON.parse(fs.readFileSync(path.join(dir, 'conns.json'), 'utf8')).connections[0].password.plain,
    'secret', 'left as-is rather than lost');
});

test('an undecryptable password is reported, not silently empty', () => {
  encryptionAvailable = true;
  const s = fresh();
  const rec = s.upsert({ name: 'Moved', password: 'secret' });
  assert.strictEqual(s.resolve(rec.id).passwordUnavailable, false, 'fine while the key works');

  // What a profile copied without its Local State file looks like.
  const original = stub.safeStorage.decryptString;
  stub.safeStorage.decryptString = () => { throw new Error('key mismatch'); };
  const moved = new Store('conns.json').resolve(rec.id);
  assert.strictEqual(moved.passwordUnavailable, true, 'flagged rather than blank');
  assert.strictEqual(moved.password, '');
  assert.strictEqual(moved.name, 'Moved', 'the rest of the record still resolves');
  stub.safeStorage.decryptString = original;
  encryptionAvailable = false;
});

test('a connection with no password is not flagged', () => {
  const s = fresh();
  const rec = s.upsert({ name: 'Trust', user: 'postgres' });
  const r = s.resolve(rec.id);
  assert.strictEqual(r.passwordUnavailable, false);
  assert.strictEqual(r.password, '');
});

test('list comes back in explicit order', () => {
  const s = fresh();
  const a = s.upsert({ name: 'Zebra' });
  const b = s.upsert({ name: 'Alpha' });
  const c = s.upsert({ name: 'Middle' });
  assert.deepStrictEqual(s.list().map((x) => x.name), ['Zebra', 'Alpha', 'Middle'], 'insertion order by default');
  s.reorder([c.id, a.id, b.id]);
  assert.deepStrictEqual(s.list().map((x) => x.name), ['Middle', 'Zebra', 'Alpha']);
});

test('reorder survives a reload from disk', () => {
  const s = fresh();
  const a = s.upsert({ name: 'One' });
  const b = s.upsert({ name: 'Two' });
  s.reorder([b.id, a.id]);
  const reloaded = new Store('conns.json');
  assert.deepStrictEqual(reloaded.list().map((x) => x.name), ['Two', 'One']);
});

test('duplicate copies the password and lands next to the original', () => {
  const s = fresh();
  const a = s.upsert({ name: 'Prod', password: 'pw', color: '#f2695c', group: 'Live', readOnly: true });
  s.upsert({ name: 'Other' });
  const copy = s.duplicate(a.id);
  assert.strictEqual(copy.name, 'Prod copy');
  assert.strictEqual(copy.readOnly, true);
  assert.strictEqual(copy.color, '#f2695c');
  assert.strictEqual(copy.group, 'Live');
  assert.strictEqual(s.resolve(copy.id).password, 'pw');
  assert.notStrictEqual(copy.id, a.id);
  assert.deepStrictEqual(s.list().map((x) => x.name), ['Prod', 'Prod copy', 'Other'], 'sits after the original');
});

test('duplicating twice keeps making distinct names', () => {
  const s = fresh();
  const a = s.upsert({ name: 'Box' });
  const one = s.duplicate(a.id);
  const two = s.duplicate(a.id);
  const three = s.duplicate(one.id);
  const names = [one.name, two.name, three.name];
  assert.strictEqual(new Set(names).size, 3, `expected distinct names, got ${names}`);
  assert.ok(names.every((n) => n.startsWith('Box copy')));
});

test('copy naming does not stack suffixes', () => {
  assert.strictEqual(nextCopyName('Local', new Set()), 'Local copy');
  assert.strictEqual(nextCopyName('Local copy', new Set(['Local copy'])), 'Local copy 2');
  assert.strictEqual(nextCopyName('Local copy 2', new Set(['Local copy'])), 'Local copy 2');
});

test('delete removes only the target', () => {
  const s = fresh();
  const a = s.upsert({ name: 'Keep' });
  const b = s.upsert({ name: 'Drop' });
  s.remove(b.id);
  assert.deepStrictEqual(s.list().map((x) => x.name), ['Keep']);
  assert.strictEqual(s.find(b.id), null);
  assert.ok(s.find(a.id));
});

test('group, colour and read-only round-trip', () => {
  const s = fresh();
  const rec = s.upsert({ name: 'P', group: '  Production  ', color: '#45c07d', readOnly: true });
  assert.strictEqual(rec.group, 'Production', 'group is trimmed');
  assert.strictEqual(rec.color, '#45c07d');
  assert.strictEqual(rec.readOnly, true);
  const back = new Store('conns.json').list()[0];
  assert.strictEqual(back.group, 'Production');
  assert.strictEqual(back.readOnly, true);
});

test('workspace state persists separately', () => {
  const s = fresh();
  s.setWorkspace({ tabs: [{ title: 't', sql: 'select 1', savedId: 'x' }], activeIndex: 0 });
  assert.strictEqual(new Store('conns.json').getWorkspace().tabs[0].sql, 'select 1');
});

test('a byte order mark does not wipe the connections', () => {
  const s = fresh();
  s.upsert({ name: 'Keeper', host: 'db' });
  const file = path.join(dir, 'conns.json');
  // What an editor on Windows leaves behind after a hand edit.
  fs.writeFileSync(file, '﻿' + fs.readFileSync(file, 'utf8'), 'utf8');
  const reopened = new Store('conns.json');
  assert.strictEqual(reopened.list().length, 1, 'still there');
  assert.strictEqual(reopened.list()[0].name, 'Keeper');
});

test('a corrupt file does not take the app down', () => {
  fresh();
  fs.writeFileSync(path.join(dir, 'conns.json'), '{ not json');
  const s = new Store('conns.json');
  assert.deepStrictEqual(s.list(), []);
  const rec = s.upsert({ name: 'Recovered' });
  assert.strictEqual(s.list().length, 1);
  assert.ok(rec.id);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
