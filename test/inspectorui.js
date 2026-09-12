'use strict';
/* The value inspector: reading a value in full, and editing it from there.
   Run: node test/inspectorui.js */

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-insp-'));
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
  const p = spawn(electron, ['.', `--smoke=${path.join(outDir, file)}`,
    `--user-data-dir=${profile}`, `--smoke-js=${js}`], { cwd: path.join(__dirname, '..') });
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
  const openPanel = async () => { document.querySelector('[data-act="inspect"]').click(); await w(400); };
  // Click a cell the way a mouse does, so the grid's own handler sets the cursor.
  const pick = async (row, col) => {
    const cell = document.querySelector('.grow[data-row="' + row + '"] .gc[data-col="' + col + '"]');
    const r = cell.getBoundingClientRect();
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }));
    await w(250);
  };
  const colIndex = (name) => [...document.querySelectorAll('.gh[data-col]')]
    .findIndex(h => h.querySelector('.gh-name').textContent.replace(/[^a-z_]/gi, '') === name);
  const shown = () => (document.querySelector('.insp-val') || {}).textContent || '';
  const act = (what) => document.querySelector('#inspector [data-ia="' + what + '"]');
`;

(async () => {
  const fingerprint = async () => {
    const c = new Client(CFG); await c.connect();
    const r = await c.query("select md5(string_agg(t::text, '|' order by id)) as fp from shop.docs t");
    await c.end(); return r.rows[0].fp;
  };
  const before = await fingerprint();

  console.log('\nreading a value that does not fit in a cell');

  const read = await run('insp-json.png', `(async () => {
    ${HELP}
    await w(1200);
    await browse('docs');
    const closedFirst = document.getElementById('inspector').hidden;
    await openPanel();
    const payloadCol = colIndex('payload');
    await pick(0, payloadCol);
    const pretty = shown();
    // The same value as stored, for comparison.
    act('pretty').click(); await w(250);
    const raw = shown();
    const meta = document.querySelector('.insp-meta').textContent;
    return {
      closedFirst, pretty, raw, meta,
      open: !document.getElementById('inspector').hidden,
      state: window.__cobaltInspector()
    };
  })()`);
  if (!read.ok) fails++;
  const r = readJs(read.out);
  expect(r.closedFirst === true, 'the panel starts closed');
  expect(r.open === true, 'the Value button opens it');
  expect(/\n\s+"account"/.test(r.pretty || ''), `JSON is indented over several lines (got ${JSON.stringify((r.pretty || '').slice(0, 60))})`);

  // The whole reason the formatter does not go through JSON.parse.
  expect((r.pretty || '').includes('12345678901234567890'),
    'a 20-digit number keeps every digit');
  expect((r.pretty || '').includes('1.10'), 'a numeric keeps its trailing zero');
  expect(!/\n/.test(r.raw || '') && (r.raw || '').includes('12345678901234567890'),
    `Raw shows the one-line original (got ${JSON.stringify((r.raw || '').slice(0, 50))})`);
  expect(/payload/.test(r.meta || '') && /jsonb/.test(r.meta || ''),
    `the header names the column and its type (got "${r.meta}")`);

  console.log('\nbinary, and following the cursor');

  const binary = await run('insp-bytea.png', `(async () => {
    ${HELP}
    await w(1200);
    await browse('docs');
    await openPanel();
    await pick(0, colIndex('blob'));
    const hex = shown();
    // Moving in the grid must redraw the panel, not leave the old value up.
    await pick(0, colIndex('label'));
    const afterMove = shown();
    await pick(2, colIndex('payload'));
    const nullValue = shown();
    const nullClass = (document.querySelector('.insp-val') || {}).className || '';
    return { hex, afterMove, nullValue, nullClass };
  })()`);
  if (!binary.ok) fails++;
  const b = readJs(binary.out);
  expect(/^00000000  48 65 6c 6c 6f/.test(b.hex || ''),
    `bytea is a hex dump with offsets (got ${JSON.stringify((b.hex || '').slice(0, 40))})`);
  expect(/\|Hello, world!\.\.\.\|/.test(b.hex || ''),
    `with the printable bytes beside it (got ${JSON.stringify((b.hex || '').slice(-24))})`);
  expect(b.afterMove === 'precision', `moving the cursor redraws it (got "${b.afterMove}")`);
  expect(b.nullValue === 'NULL' && /kind-null/.test(b.nullClass || ''),
    `NULL is labelled rather than blank (got "${b.nullValue}")`);

  console.log('\nthe whole row, down the page');

  const rowView = await run('insp-row.png', `(async () => {
    ${HELP}
    await w(1200);
    await browse('docs');
    await openPanel();
    await pick(0, colIndex('id'));
    document.querySelector('#inspector [data-iv="row"]').click();
    await w(300);
    const names = [...document.querySelectorAll('.insp-field .if-name')].map(n => n.firstChild.textContent);
    const emptyShown = [...document.querySelectorAll('.insp-field')]
      .map(f => f.querySelector('.if-val').textContent);
    // Clicking a field should take the grid cursor there.
    [...document.querySelectorAll('.insp-field')]
      .find(f => f.querySelector('.if-name').firstChild.textContent === 'body').click();
    await w(350);
    const st = window.__cobaltInspector();
    return {
      names, emptyShown, view: st.view,
      cursorCol: window.__cobaltCursor().col,
      bodyCol: colIndex('body'),
      // What is actually on screen, not just what the state says.
      showsValue: !!document.querySelector('.insp-val'),
      showsFieldList: !!document.querySelector('.insp-fields'),
      segOn: (document.querySelector('.insp-seg button.on') || {}).textContent
    };
  })()`);
  if (!rowView.ok) fails++;
  const rv = readJs(rowView.out);
  expect(JSON.stringify(rv.names) === '["id","label","payload","blob","body"]',
    `every column is listed once (got ${JSON.stringify(rv.names)})`);
  expect(rv.cursorCol === rv.bodyCol && rv.cursorCol > 0,
    `clicking a field moves the grid cursor to it (col ${rv.cursorCol}, wanted ${rv.bodyCol})`);
  expect(rv.view === 'value', 'and switches to the value view');
  expect(rv.showsValue === true && rv.showsFieldList === false,
    `which is what is drawn, not just what the state says (value pane ${rv.showsValue}, field list ${rv.showsFieldList})`);
  expect(rv.segOn === 'Value', `and the tab follows (got "${rv.segOn}")`);

  console.log('\nediting from the panel stages, it does not write');

  const edit = await run('insp-edit.png', `(async () => {
    ${HELP}
    await w(1200);
    await browse('docs');
    await openPanel();
    await pick(0, colIndex('label'));
    act('edit').click(); await w(300);
    const ta = document.querySelector('.insp-edit');
    const seeded = ta.value;
    ta.value = 'edited from the panel';
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await w(400);
    const staged = {
      dirty: window.__cobaltDirty(),
      bar: !document.getElementById('pending-bar').hidden,
      cell: window.__cobaltCell(0, colIndex('label')),
      shown: shown()
    };
    // Ctrl+Z in the grid is the same undo stack.
    document.querySelector('.grid').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await w(350);
    return { seeded, staged, dirtyAfterUndo: window.__cobaltDirty() };
  })()`);
  if (!edit.ok) fails++;
  const e = readJs(edit.out);
  expect(e.seeded === 'precision', `the editor opens on the current value (got "${e.seeded}")`);
  expect(e.staged.dirty === 1, `Ctrl+Enter stages one change (got ${e.staged.dirty})`);
  expect(e.staged.bar === true, 'the "nothing is written" bar appears');
  expect(e.staged.cell === 'edited from the panel',
    `and the grid shows the new value (got "${e.staged.cell}")`);
  expect(e.dirtyAfterUndo === 0, `Ctrl+Z in the grid takes it back (got ${e.dirtyAfterUndo})`);

  console.log('\na result you cannot edit offers no editor');

  const ro = await run('insp-readonly.png', `(async () => {
    ${HELP}
    await w(1200);
    await browse('audit_log');           // no primary key, so not editable
    await openPanel();
    await pick(0, 1);
    return {
      hasEdit: !!act('edit'),
      hasCopy: !!act('copy'),
      value: shown()
    };
  })()`);
  if (!ro.ok) fails++;
  const q = readJs(ro.out);
  expect(q.hasEdit === false, 'no Edit button on a read-only result');
  expect(q.hasCopy === true, 'but you can still read and copy it');

  const after = await fingerprint();
  expect(after === before, 'and the table is untouched by all of the above');

  console.log(`\n${fails ? `${fails} failed` : 'all checks passed'}\n`);
  process.exit(fails ? 1 : 0);
})();
