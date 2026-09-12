'use strict';
/* The menu tree against what the renderer actually handles.
   A menu item that does nothing is the whole failure mode here.
   Run: node test/commands.test.js */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { MENU, menuFor, commandIds, roleNames, formatAccel } = require('../src/shared/commands');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

const appJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
const mainJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');

/** The command ids the renderer's switch actually has a case for. */
const handled = new Set(
  [...appJs.matchAll(/case\s+'([a-zA-Z]+:[a-zA-Z]+)'\s*:/g)].map((m) => m[1])
);

console.log('\nmenu tree');

test('every group has a label and some items', () => {
  for (const g of MENU) {
    assert.ok(g.label, 'group has a label');
    assert.ok(Array.isArray(g.items) && g.items.length, `${g.label} has items`);
  }
});

test('every item is a separator, a command, or a role', () => {
  for (const g of MENU) {
    for (const it of g.items) {
      if (it.sep) continue;
      assert.ok(it.label, `item in ${g.label} has a label`);
      assert.ok(it.id || it.role, `"${it.label}" is wired to something`);
      assert.ok(!(it.id && it.role), `"${it.label}" is not both a command and a role`);
    }
  }
});

test('no duplicate command ids', () => {
  const ids = commandIds();
  const dupes = ids.filter((v, i) => ids.indexOf(v) !== i);
  assert.deepStrictEqual(dupes, [], `duplicated: ${dupes.join(', ')}`);
});

test('no accelerator is claimed twice', () => {
  const seen = new Map();
  for (const g of MENU) {
    for (const it of g.items) {
      if (!it.accel) continue;
      const key = it.accel.toLowerCase();
      // Edit roles legitimately share the platform shortcuts.
      if (seen.has(key)) {
        assert.fail(`${it.accel} is on both "${seen.get(key)}" and "${it.label}"`);
      }
      seen.set(key, it.label);
    }
  }
});

console.log('\nwiring');

test('every menu command is handled by the renderer', () => {
  const missing = commandIds().filter((id) => !handled.has(id));
  assert.deepStrictEqual(missing, [],
    `these menu items would do nothing: ${missing.join(', ')}`);
});

test('every role the menu uses is performed by the main process', () => {
  for (const role of roleNames()) {
    assert.ok(
      new RegExp(`case '${role}':`).test(mainJs),
      `performRole has no branch for "${role}"`
    );
  }
});

test('the renderer handles nothing that is not reachable', () => {
  // Commands reachable another way are fine; this catches typos in the tree.
  const reachableElsewhere = new Set([
    'history:open', 'palette:tables', 'palette:commands',   // also buttons/palette
  ]);
  const ids = new Set(commandIds());
  const orphans = [...handled].filter((id) => !ids.has(id) && !reachableElsewhere.has(id));
  assert.deepStrictEqual(orphans, [],
    `handled but absent from the menu: ${orphans.join(', ')}`);
});

console.log('\nplatform shaping');

test('Windows gets Quit, macOS gets Close Window', () => {
  const win = menuFor('win32').find((g) => g.label === 'File').items.map((i) => i.label);
  const mac = menuFor('darwin').find((g) => g.label === 'File').items.map((i) => i.label);
  assert.ok(win.includes('Quit') && !win.includes('Close Window'));
  assert.ok(mac.includes('Close Window') && !mac.includes('Quit'));
});

test('accelerators render for the platform', () => {
  assert.strictEqual(formatAccel('CmdOrCtrl+Shift+F', 'win32'), 'Ctrl+Shift+F');
  assert.strictEqual(formatAccel('CmdOrCtrl+Return', 'win32'), 'Ctrl+Enter');
  assert.strictEqual(formatAccel('CmdOrCtrl+Shift+F', 'darwin'), '⌘⇧F');
  assert.strictEqual(formatAccel(undefined, 'win32'), '');
});

test('the tree covers the features that have no other button', () => {
  const ids = new Set(commandIds());
  for (const id of ['history:open', 'perf:benchmark', 'perf:explain', 'perf:explainAnalyze',
    'grid:filter', 'result:export', 'connection:manage', 'help:about', 'schema:refresh']) {
    assert.ok(ids.has(id), `${id} is reachable from the menu`);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
