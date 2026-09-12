'use strict';
/* The query-style filter bar and the column chooser.
   Run: node test/filterbarui.js */

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-fb-'));
  fs.writeFileSync(path.join(dir, 'cobalt-connections.json'), JSON.stringify({
    connections: [{
      id: 's1', name: 'Test DB', host: 'localhost', port: 15432, database: 'cobalt',
      user: 'cobalt', ssl: 'disable', order: 0, password: { plain: 'cobalt' },
    }],
    workspace: { tabs: [{ title: 'Query 1', sql: 'select 1;', savedId: 's1' }], activeIndex: 0, pageSize: 200 },
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

const HELP = `
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const browse = async (name) => {
    [...document.querySelectorAll('.tree-row.rel')]
      .find(r => r.querySelector('.name').textContent === name).click();
    await w(2200);
  };
  const openBar = async () => { document.querySelector('[data-act="filter"]').click(); await w(400); };
  const setWhere = async (text) => {
    const i = document.getElementById('fb-input');
    i.focus(); i.value = text;
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await w(1800);
  };
  const headers = () => [...document.querySelectorAll('.gh[data-col]')]
    .map(h => h.querySelector('.gh-name').textContent.replace(/[^a-z_]/gi, ''));
`;

(async () => {
  const fingerprint = async () => {
    const c = new Client(CFG); await c.connect();
    const r = await c.query("select md5(string_agg(t::text, '|' order by id)) as fp from shop.customers t");
    await c.end(); return r.rows[0].fp;
  };
  const before = await fingerprint();

  console.log('\none expression, any column');

  const filt = await run('fb-filter.png', `(async () => {
    ${HELP}
    await w(1200);
    await browse('customers');
    await openBar();
    const focused = document.activeElement === document.getElementById('fb-input');
    // notes is the last column: with a box per column you would have to scroll to it.
    await setWhere("notes is not null and balance > 890");
    const cols = headers();
    const notesIdx = cols.indexOf('notes');
    const balIdx = cols.indexOf('balance');
    const rows = [];
    const n = Math.min(5, window.__cobaltGridRows());
    for (let r = 0; r < n; r++) rows.push([window.__cobaltCell(r, notesIdx), window.__cobaltCell(r, balIdx)]);
    return {
      focused, rows,
      total: window.__cobaltGridRows(),
      dirty: window.__cobaltDirty(),
      pill: document.getElementById('grid-toolbar').textContent.includes('filtered')
    };
  })()`);
  if (!filt.ok) fails++;
  const f = readJs(filt.out);
  expect(f.focused === true, 'opening the bar puts the caret in it');
  expect(f.total > 0 && f.total < 200, `it filtered (got ${f.total} rows)`);
  expect(f.rows.length > 0 && (f.rows || []).every(([n, b]) => n !== null && Number(b) > 890),
    `every row matches both conditions (sample ${JSON.stringify(f.rows)})`);
  expect(f.dirty === 0, 'and nothing was staged');
  expect(f.pill === true, 'the toolbar shows it is filtered');

  console.log('\na bad expression is refused before it runs');

  const bad = await run('fb-bad.png', `(async () => {
    ${HELP}
    await w(1200);
    await browse('customers');
    await openBar();
    await setWhere("1=1; drop table shop.customers");
    const msg = document.getElementById('fb-msg').textContent;
    const cls = document.getElementById('fb-msg').className;
    // And one that is valid SQL but wrong, which the server must report.
    await setWhere("no_such_column = 1");
    return {
      msg, cls,
      serverMsg: document.getElementById('fb-msg').textContent,
      rowsStillThere: window.__cobaltGridRows()
    };
  })()`);
  if (!bad.ok) fails++;
  const b = readJs(bad.out);
  expect(/semicolon/i.test(b.msg || ''), `refused locally (got "${b.msg}")`);
  expect(/err/.test(b.cls || ''), 'and shown as an error');
  expect(/no_such_column/i.test(b.serverMsg || ''), `a server error lands in the bar too (got "${b.serverMsg}")`);

  console.log('\nchoosing columns');

  const cols = await run('fb-columns.png', `(async () => {
    ${HELP}
    await w(1200);
    await browse('customers');
    const before = headers();
    document.querySelector('[data-act="columns"]').click();
    await w(400);
    const boxes = [...document.querySelectorAll('.col-panel input[data-col]')];
    const panelCount = boxes.length;
    // Hide everything except id and email.
    boxes.forEach(b => {
      const name = b.parentElement.querySelector('.cp-name').textContent;
      b.checked = (name === 'id' || name === 'email');
    });
    boxes[0].dispatchEvent(new Event('change', { bubbles: true }));
    await w(500);
    const after = headers();
    // None should leave at least one column standing.
    document.querySelector('[data-cp="none"]').click();
    await w(400);
    return { before, after, panelCount, afterNone: headers().length };
  })()`);
  if (!cols.ok) fails++;
  const c = readJs(cols.out);
  expect((c.before || []).length === 8, `all columns to begin with (got ${JSON.stringify(c.before)})`);
  expect(c.panelCount === 8, `the chooser lists every column (got ${c.panelCount})`);
  expect(JSON.stringify(c.after) === '["id","email"]', `only the chosen ones remain (got ${JSON.stringify(c.after)})`);
  expect(c.afterNone >= 1, `"None" still leaves a column (got ${c.afterNone})`);

  console.log('\nfiltering by a cell value');

  const byCell = await run('fb-bycell.png', `(async () => {
    ${HELP}
    await w(1200);
    await browse('customers');
    const cols = headers();
    const emailIdx = cols.indexOf('email');
    const value = window.__cobaltCell(3, emailIdx);
    const cell = document.querySelector('.grow[data-row="3"] .gc[data-col="' + emailIdx + '"]');
    const r = cell.getBoundingClientRect();
    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }));
    await w(400);
    [...document.querySelectorAll('.ctx-item')].find(n => /Filter by this value/.test(n.textContent)).click();
    await w(2000);
    return {
      value,
      expr: document.getElementById('fb-input').value,
      rows: window.__cobaltGridRows(),
      landed: window.__cobaltCell(0, emailIdx)
    };
  })()`);
  if (!byCell.ok) fails++;
  const bc = readJs(byCell.out);
  expect((bc.expr || '').includes('email'), `it wrote a condition into the bar (got "${bc.expr}")`);
  expect(bc.rows === 1, `narrowing to that row (got ${bc.rows})`);
  expect(bc.landed === bc.value, `which is the right one (${bc.landed} vs ${bc.value})`);

  expect(await fingerprint() === before, 'the table is untouched throughout');

  console.log(`\n${fails ? fails + ' failed' : 'all checks passed'}\n`);
  process.exit(fails ? 1 : 0);
})();
