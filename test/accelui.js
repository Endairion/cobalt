'use strict';
/* Every menu accelerator, pressed for real, with text selected in the editor.
 *
 * The command handlers are covered elsewhere by calling them directly, which
 * goes around the keystroke entirely — so a shortcut CodeMirror was quietly
 * eating looked fine everywhere else. Selection matters: Ctrl+Shift+L worked
 * with none and failed with some, because only then did selectSelectionMatches
 * claim the key.
 *
 * Run: node test/accelui.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');
const { MENU, formatAccel } = require('../src/shared/commands.js');

const outDir = path.join(__dirname, '..', 'shots');
fs.mkdirSync(outDir, { recursive: true });

let fails = 0;
const expect = (cond, label) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) fails++;
};
const readJs = (out) => JSON.parse((/\[smoke\] js (.*)/.exec(out) || [])[1] || '{}');

const SQL = 'select id from shop.customers where id = id;';

const seed = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-acc-'));
  fs.writeFileSync(path.join(dir, 'cobalt-connections.json'), JSON.stringify({
    connections: [{
      id: 's1', name: 'Test DB', engine: 'postgres', host: 'localhost', port: 15432,
      database: 'cobalt', user: 'cobalt', ssl: 'disable', order: 0, password: { plain: 'cobalt' },
    }],
    workspace: {
      tabs: [{ title: 'Query 1', sql: SQL, savedId: 's1' }],
      activeIndex: 0, pageSize: 200, openConnections: ['s1'], activeSavedId: 's1',
    },
    seenVersion: require('../package.json').version,
  }, null, 2));
  return dir;
};

/** The realistic state: caret in the editor, a word selected. */
const PREP = "document.querySelector('.cm-content').focus(); window.__cobaltSelect(7, 9)";

const press = (file, keys, probe) => new Promise((resolve) => {
  const profile = seed();
  const p = spawn(electron, ['.', `--smoke=${path.join(outDir, file)}`,
    `--user-data-dir=${profile}`, `--smoke-prep=${PREP}`,
    `--smoke-keys=${keys}`, `--smoke-js=${probe}`], { cwd: path.join(__dirname, '..') });
  let buf = '';
  p.stdout.on('data', (d) => { buf += d; });
  p.stderr.on('data', (d) => { buf += d; });
  p.on('close', (code) => {
    fs.rmSync(profile, { recursive: true, force: true });
    const bad = /\[renderer ERROR\]|Uncaught|is not a function|is not defined/.test(buf);
    if (bad) console.log(buf.slice(0, 2000));
    resolve({ ok: code === 0 && !bad, out: buf });
  });
  setTimeout(() => p.kill(), 90000);
});

const toKeys = (accel) => accel
  .replace(/CmdOrCtrl|CommandOrControl|Cmd|Command/g, 'Control')
  .replace(/Ctrl/g, 'Control');

/**
 * Two of these never reach the menu on purpose: the editor binds Mod-Enter
 * itself and consumes it, which is the right owner for "run what I am looking
 * at". For those, the effect is the proof.
 */
const BY_EFFECT = {
  // With a word selected, Run Statement runs the selection — which is one
  // identifier and not valid SQL. That it came back with *a* result, error or
  // not, is the proof the keystroke arrived.
  'query:run': { probe: 'window.__cobalt().tabs.some((t) => t.results > 0)', what: 'the statement runs' },
  'query:runAll': { probe: 'window.__cobalt().tabs.some((t) => t.results > 0)', what: 'the script runs' },
};

// Skipped: these would end the run rather than report on it.
const SKIP = new Set(['tab:close', 'file:open', 'file:save', 'query:cancel']);

(async () => {
  console.log('\nthe one that was reported, with text selected');

  const one = await press('acc-activity.png', 'Control+Shift+L', `(() => ({
    last: window.__cobaltLastCommand || null,
    panel: !!document.querySelector('.process-modal'),
    selected: window.__cobalt() && true
  }))()`);
  if (!one.ok) fails++;
  const o = readJs(one.out);
  expect(o.last === 'server:processes',
    `Ctrl+Shift+L reaches the app even with a selection (got ${JSON.stringify(o.last)})`);
  expect(o.panel === true, 'and opens the server activity panel');

  console.log('\nevery accelerator the app itself handles');

  const targets = [];
  for (const group of MENU) {
    for (const item of group.items) {
      if (!item.id || !item.accel || SKIP.has(item.id)) continue;
      targets.push(item);
    }
  }
  console.log(`  (${targets.length} shortcuts, each in its own run)`);

  for (const item of targets) {
    const effect = BY_EFFECT[item.id];
    const probe = effect
      ? `(() => ({ ok: ${effect.probe} }))()`
      : '(() => ({ last: window.__cobaltLastCommand || null }))()';
    const r = await press(`acc-${item.id.replace(/:/g, '-')}.png`, toKeys(item.accel), probe);
    const got = readJs(r.out);
    const label = formatAccel(item.accel, 'win32');
    if (effect) {
      expect(got.ok === true, `${label} — ${effect.what} (${item.id})`);
    } else {
      expect(got.last === item.id,
        `${label} runs ${item.id}${got.last === item.id ? '' : ` (got ${JSON.stringify(got.last)})`}`);
    }
  }

  console.log('\nand the editor keeps what belongs to a text box');

  const editing = await press('acc-editing.png', 'Control+Backspace', `(() => ({
    sql: window.__cobaltGetSql(), last: window.__cobaltLastCommand || null
  }))()`);
  const e = readJs(editing.out);
  expect(e.sql !== SQL,
    `Ctrl+Backspace still deletes a word rather than being taken by the menu (got ${JSON.stringify(e.sql)})`);
  expect(e.last === null, 'and does not fire a command');

  console.log(`\n${fails ? `${fails} failed` : 'all checks passed'}\n`);
  process.exit(fails ? 1 : 0);
})();
