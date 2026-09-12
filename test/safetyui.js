'use strict';
/* Nothing is written until you commit: the pending bar, undo, and that
   filtering leaves staged edits and the table alone.
   Run: node test/safetyui.js */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');
const { Client } = require('pg');

const outDir = path.join(__dirname, '..', 'shots');
fs.mkdirSync(outDir, { recursive: true });
const CFG = { host: 'localhost', port: 15432, database: 'cobalt', user: 'cobalt', password: 'cobalt' };

const seed = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-safety-'));
  fs.writeFileSync(path.join(dir, 'cobalt-connections.json'), JSON.stringify({
    connections: [{
      id: 's1', name: 'Test DB', host: 'localhost', port: 15432, database: 'cobalt',
      user: 'cobalt', ssl: 'disable', order: 0, password: { plain: 'cobalt' },
    }],
    workspace: {
      tabs: [{ title: 'customers', sql: 'select id, email, full_name, balance from shop.customers;', savedId: 's1' }],
      activeIndex: 0, pageSize: 200,
    },
    seenVersion: require('../package.json').version,
  }, null, 2));
  return dir;
};

const run = (file, js) => new Promise((resolve) => {
  const profile = seed();
  const target = path.join(outDir, file);
  const p = spawn(electron, ['.', `--smoke=${target}`, `--user-data-dir=${profile}`, `--smoke-js=${js}`],
    { cwd: path.join(__dirname, '..') });
  let buf = '';
  p.stdout.on('data', (d) => { buf += d; process.stdout.write(d); });
  p.stderr.on('data', (d) => { buf += d; });
  p.on('close', (code) => {
    fs.rmSync(profile, { recursive: true, force: true });
    const bad = /\[renderer ERROR\]|Uncaught|is not a function|is not defined/.test(buf);
    if (bad) console.log(buf.slice(0, 3000));
    resolve({ ok: code === 0 && !bad, out: buf });
  });
  setTimeout(() => p.kill(), 90000);
});

const readJs = (out) => JSON.parse((/\[smoke\] js (.*)/.exec(out) || [])[1] || '{}');

let fails = 0;
const expect = (cond, label) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) fails++;
};

async function fingerprint() {
  const c = new Client(CFG);
  await c.connect();
  const r = await c.query(
    "select count(*)::text || ':' || coalesce(md5(string_agg(t::text, '|' order by id)), '') as fp from shop.customers t");
  await c.end();
  return r.rows[0].fp;
}

const HELP = `
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const runQuery = async () => { window.__cobaltMenu('query:run'); await w(1800); };
  const cell = (row, col) => document.querySelector('.grow[data-row="' + row + '"] .gc[data-col="' + col + '"]');
  const type = (el, ch) => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.querySelector('.grid').dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
  };
`;

(async () => {
  const before = await fingerprint();

  console.log('\nan accidental edit is visible and undoable');

  const edit = await run('safety-pending.png', `(async () => {
    ${HELP}
    await w(900);
    await runQuery();
    const barBefore = !document.getElementById('pending-bar').hidden;
    // What happens if you type while the grid has focus, meaning to filter.
    type(cell(0, 2), 'x');
    await w(300);
    const editor = document.querySelector('.cell-editor');
    if (editor) { editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }
    await w(500);
    const bar = document.getElementById('pending-bar');
    const after = {
      barShown: !bar.hidden,
      text: bar.textContent.replace(/\\s+/g, ' ').trim(),
      dirty: window.__cobaltDirty()
    };
    // Ctrl+Z should take it back.
    document.querySelector('.grid').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await w(400);
    return {
      barBefore, after,
      dirtyAfterUndo: window.__cobaltDirty(),
      barAfterUndo: !document.getElementById('pending-bar').hidden
    };
  })()`);
  if (!edit.ok) fails++;
  const e = readJs(edit.out);
  expect(e.barBefore === false, 'no bar while nothing is staged');
  expect(e.after.dirty === 1, `typing in the grid stages one change (got ${e.after.dirty})`);
  expect(e.after.barShown === true, 'and the bar appears');
  expect(/nothing has been written/i.test(e.after.text || ''),
    `saying nothing is written yet (got "${e.after.text}")`);
  expect(e.dirtyAfterUndo === 0, `Ctrl+Z takes it back (got ${e.dirtyAfterUndo})`);
  expect(e.barAfterUndo === false, 'and the bar goes away');

  console.log('\nthe filter row is labelled and does not touch data');

  const filter = await run('safety-filter.png', `(async () => {
    ${HELP}
    await w(900);
    await runQuery();
    document.querySelector('[data-act="filter"]').click();
    await w(400);
    const input = document.getElementById('fb-input');
    const focused = document.activeElement === input;
    input.value = "email = 'user123@example.com'";
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await w(1800);
    return {
      focused,
      dirty: window.__cobaltDirty(),
      rows: window.__cobaltGridRows(),
      barShown: !document.getElementById('pending-bar').hidden
    };
  })()`);
  if (!filter.ok) fails++;
  const f = readJs(filter.out);
  expect(f.focused === true, 'the caret goes straight into the filter bar');
  expect(f.rows === 1, `it narrowed to the one matching row (got ${f.rows})`);
  expect(f.dirty === 0, `and staged no changes (got ${f.dirty})`);
  expect(f.barShown === false, 'so no pending bar appears');

  const after = await fingerprint();
  expect(after === before, 'the table is untouched by all of the above');

  console.log(`\n${fails ? fails + ' failed' : 'all checks passed'}\n`);
  process.exit(fails ? 1 : 0);
})();
