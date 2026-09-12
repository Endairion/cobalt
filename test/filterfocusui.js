'use strict';
/* Opening the filter row must put you in it, and keystrokes there must stay
   there rather than editing the cell under the grid cursor.
   Run: node test/filterfocusui.js */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

const outDir = path.join(__dirname, '..', 'shots');
fs.mkdirSync(outDir, { recursive: true });

const seed = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-ff-'));
  fs.writeFileSync(path.join(dir, 'cobalt-connections.json'), JSON.stringify({
    connections: [{
      id: 's1', name: 'Test DB', host: 'localhost', port: 15432, database: 'cobalt',
      user: 'cobalt', ssl: 'disable', order: 0, password: { plain: 'cobalt' },
    }],
    workspace: {
      tabs: [{ title: 'Query 1', sql: 'select 1;', savedId: 's1' }],
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

// Browse a table the way a person does: click it in the sidebar.
const HELP = `
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const browse = async (name) => {
    [...document.querySelectorAll('.tree-row.rel')]
      .find(r => r.querySelector('.name').textContent === name).click();
    await w(2200);
  };
  const key = (el, k, opts) => el.dispatchEvent(
    new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true }, opts || {})));
  const active = () => {
    const a = document.activeElement;
    return a ? (a.dataset && a.dataset.filter !== undefined ? 'filter:' + a.dataset.filter : a.className || a.tagName) : 'none';
  };
`;

(async () => {
  console.log('\nopening the filter row');

  const open = await run('ff-open.png', `(async () => {
    ${HELP}
    await w(1200);
    await browse('customers');
    document.querySelector('[data-act="filter"]').click();
    await w(500);
    return {
      activeAfterButton: active(),
      inputs: document.querySelectorAll('input[data-filter]').length,
      rowVisible: !document.querySelector('.grid-filter').hidden
    };
  })()`);
  if (!open.ok) fails++;
  const o = readJs(open.out);
  expect(o.rowVisible === true, 'the filter row is shown');
  expect(o.activeAfterButton === 'filter:0',
    `focus lands in the first filter box (got "${o.activeAfterButton}")`);

  console.log('\ntyping goes to the filter, not the cell');

  const typing = await run('ff-typing.png', `(async () => {
    ${HELP}
    await w(1200);
    await browse('customers');
    document.querySelector('[data-act="filter"]').click();
    await w(500);
    const input = document.querySelector('input[data-filter="1"]');
    input.focus();
    // A plain character: this used to open a cell editor on the grid cursor.
    key(input, 'u');
    await w(250);
    const afterChar = {
      cellEditor: !!document.querySelector('.cell-editor'),
      dirty: window.__cobaltDirty(),
      active: active()
    };
    // Arrows used to move the grid cursor out from under you.
    key(input, 'ArrowDown');
    await w(200);
    const cursorRow = window.__cobaltCursor().row;
    return { afterChar, cursorRow };
  })()`);
  if (!typing.ok) fails++;
  const t = readJs(typing.out);
  expect(t.afterChar.cellEditor === false, 'no cell editor opens');
  expect(t.afterChar.dirty === 0, `nothing is staged (got ${t.afterChar.dirty})`);
  expect(t.afterChar.active === 'filter:1', `focus stays in the box (got "${t.afterChar.active}")`);
  expect(t.cursorRow === 0, `arrow keys do not move the grid cursor (got row ${t.cursorRow})`);

  console.log('\nEnter applies the filter instead of editing a cell');

  const enter = await run('ff-enter.png', `(async () => {
    ${HELP}
    await w(1200);
    await browse('customers');
    document.querySelector('[data-act="filter"]').click();
    await w(500);
    const input = document.querySelector('input[data-filter="1"]');
    input.focus();
    input.value = "'user123@example.com'";
    input.dispatchEvent(new Event('input', { bubbles: true }));
    key(input, 'Enter');
    await w(1800);
    return {
      cellEditor: !!document.querySelector('.cell-editor'),
      dirty: window.__cobaltDirty(),
      rows: window.__cobaltGridRows()
    };
  })()`);
  if (!enter.ok) fails++;
  const en = readJs(enter.out);
  expect(en.cellEditor === false, 'Enter does not open a cell editor');
  expect(en.dirty === 0, `and stages nothing (got ${en.dirty})`);
  expect(en.rows === 1, `the filter applied (got ${en.rows} rows)`);

  console.log(`\n${fails ? fails + ' failed' : 'all checks passed'}\n`);
  process.exit(fails ? 1 : 0);
})();
