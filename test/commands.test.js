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

/**
 * Electron gives several roles a default accelerator whether you ask or not —
 * reload is Ctrl+R, dev tools is Ctrl+Shift+I. A command that picks the same
 * key loses silently, which is how Refresh Schema was dead for a long time.
 */
const ROLE_DEFAULTS = {
  reload: 'CmdOrCtrl+R',
  forceReload: 'CmdOrCtrl+Shift+R',
  toggleDevTools: 'CmdOrCtrl+Shift+I',
  resetZoom: 'CmdOrCtrl+0',
  zoomIn: 'CmdOrCtrl+=',
  zoomOut: 'CmdOrCtrl+-',
  togglefullscreen: 'F11',
  quit: 'CmdOrCtrl+Q',
  close: 'CmdOrCtrl+W',
  minimize: 'CmdOrCtrl+M',
};

test('no command collides with a role default accelerator', () => {
  const { canonicalKey } = require('../src/shared/commands');
  // Per platform: an item marked mac-only is not on Windows to collide with.
  for (const platform of ['win32', 'darwin']) {
  const taken = new Map();
  for (const group of menuFor(platform)) {
    for (const item of group.items) {
      const accel = item.accel || (item.role ? ROLE_DEFAULTS[item.role] : null);
      if (!accel) continue;
      const key = canonicalKey(accel);
      const who = item.id || `role:${item.role}`;
      if (taken.has(key)) {
        throw new Error(`on ${platform}, ${accel} is claimed by both ${taken.get(key)} and ${who}`);
      }
      taken.set(key, who);
    }
  }
  }
});

test('the editor gives up the keys the app has claimed', () => {
  const { withoutAppKeys, appAcceleratorKeys, canonicalKey } = require('../src/shared/commands');
  const claimed = appAcceleratorKeys();

  // A binding whose whole key is ours goes.
  assert.strictEqual(withoutAppKeys([{ key: 'Shift-Mod-k' }]).length, 0);
  // One that only collides on its shift half keeps the binding, loses the half.
  const kept = withoutAppKeys([{ key: 'Mod-g', run: 1, shift: 2 }]);
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(kept[0].shift, undefined, 'Ctrl+Shift+G belongs to Find in Database');
  assert.strictEqual(kept[0].run, 1, 'but Ctrl+G is still the editor\'s find-next');
  // Text editing the app never claimed is untouched.
  assert.strictEqual(withoutAppKeys([{ key: 'Mod-a' }, { key: 'Mod-f' }]).length, 2);
  // Delete-word-backwards is deliberately left with the editor.
  assert.ok(!claimed.has(canonicalKey('Mod-Backspace')),
    'Ctrl+Backspace must stay word-delete; the grid shortcut moved instead');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
