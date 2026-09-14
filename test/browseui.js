'use strict';
/* Browsing a table straight from the sidebar. Run: node test/browseui.js */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

const outDir = path.join(__dirname, '..', 'shots');
fs.mkdirSync(outDir, { recursive: true });

const seed = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-browse-'));
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
  const relRow = (name) => [...document.querySelectorAll('.tree-row.rel')]
    .find(r => r.querySelector('.name').textContent === name);
  const editorVisible = () => {
    const p = document.getElementById('editor-pane');
    return p.getBoundingClientRect().height > 5;
  };
`;

(async () => {
  console.log('\none click browses');

  const browse = await run('browse.png', `(async () => {
    ${HELP}
    await w(1400);
    const before = { tabs: window.__cobalt().tabs.length, editor: editorVisible() };
    relRow('customers').click();
    await w(2200);
    const g = document.querySelector('.grid');
    return {
      before,
      editorAfter: editorVisible(),
      rows: window.__cobaltGridRows(),
      // What is actually on screen, not just what was fetched.
      rendered: document.querySelectorAll('.grow').length,
      gridHeight: Math.round(g ? g.clientHeight : 0),
      hostHeight: Math.round(document.querySelector('.grid-host').getBoundingClientRect().height),
      head: (document.getElementById('data-head').textContent || '').replace(/\\s+/g, ' ').trim(),
      headShown: !document.getElementById('data-head').hidden,
      tabs: window.__cobalt().tabs.map(t => t.title),
      highlighted: !!document.querySelector('.tree-row.rel.browsing')
    };
  })()`);
  if (!browse.ok) fails++;
  const b = readJs(browse.out);
  expect(b.before.editor === true, 'the editor is there for a normal query tab');
  expect(b.editorAfter === false, 'and is out of the way once browsing');
  expect(b.rows === 200, `rows loaded without running anything (got ${b.rows})`);
  expect(b.rendered > 10,
    `and they are actually drawn (rendered ${b.rendered}, grid ${b.gridHeight}px in a ${b.hostHeight}px host)`);
  expect(b.headShown && /shop\.customers/.test(b.head), `the header names the table (got "${b.head}")`);
  expect(b.highlighted === true, 'the sidebar shows which table is open');

  console.log('\nclicking another table reuses the same tab');

  const swap = await run('browse-swap.png', `(async () => {
    ${HELP}
    await w(1400);
    relRow('customers').click();
    await w(2000);
    const first = { tabs: window.__cobalt().tabs.length, rows: window.__cobaltGridRows() };
    relRow('orders').click();
    await w(2200);
    return {
      first,
      tabs: window.__cobalt().tabs.length,
      titles: window.__cobalt().tabs.map(t => t.title),
      head: (document.getElementById('data-head').textContent || '').replace(/\\s+/g, ' ').trim(),
      rows: window.__cobaltGridRows()
    };
  })()`);
  if (!swap.ok) fails++;
  const sw = readJs(swap.out);
  expect(sw.tabs === sw.first.tabs, `no new tab per table (${sw.first.tabs} -> ${sw.tabs})`);
  expect(/shop\.orders/.test(sw.head), `it swapped to the new table (got "${sw.head}")`);
  expect(sw.rows === 200, 'and loaded its rows');

  console.log('\nthe twisty still opens columns');

  const cols = await run('browse-cols.png', `(async () => {
    ${HELP}
    await w(1400);
    const before = document.querySelectorAll('.tree-row.column').length;
    relRow('customers').querySelector('.twisty').click();
    await w(700);
    return {
      before,
      after: document.querySelectorAll('.tree-row.column').length,
      browsed: !!document.querySelector('.tree-row.rel.browsing'),
      editorStillThere: editorVisible()
    };
  })()`);
  if (!cols.ok) fails++;
  const c = readJs(cols.out);
  expect(c.after > c.before, `the arrow expands columns (${c.before} -> ${c.after})`);
  expect(c.browsed === false, 'and does not browse the table');
  expect(c.editorStillThere === true, 'so the editor stays put');

  console.log('\nopen as query');

  const asQuery = await run('browse-asquery.png', `(async () => {
    ${HELP}
    await w(1400);
    relRow('customers').click();
    await w(2200);
    document.querySelector('[data-data="query"]').click();
    await w(600);
    return {
      editor: editorVisible(),
      sql: window.__cobaltGetSql(),
      headShown: !document.getElementById('data-head').hidden,
      rowsKept: window.__cobaltGridRows()
    };
  })()`);
  if (!asQuery.ok) fails++;
  const q = readJs(asQuery.out);
  expect(q.editor === true, 'the editor comes back');
  expect(/FROM shop\.customers/.test(q.sql || ''), `carrying the statement (got "${(q.sql || '').replace(/\n/g, ' ')}")`);
  expect(q.headShown === false, 'and the browse header goes away');
  expect(q.rowsKept === 200, 'the rows already fetched stay on screen');

  console.log(`\n${fails ? fails + ' failed' : 'all checks passed'}\n`);
  process.exit(fails ? 1 : 0);
})();
