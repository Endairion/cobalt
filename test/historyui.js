'use strict';
/* Query history in the real app: running records, the panel recalls.
   Run: node test/historyui.js */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

const outDir = path.join(__dirname, '..', 'shots');
fs.mkdirSync(outDir, { recursive: true });

// One profile shared across runs, so history recorded in run 1 is there in run 2.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-histui-'));
const seed = (sql) => fs.writeFileSync(path.join(profile, 'cobalt-connections.json'), JSON.stringify({
  connections: [{
    id: 's1', name: 'Test DB', host: 'localhost', port: 15432, database: 'cobalt',
    user: 'cobalt', ssl: 'disable', order: 0, password: { plain: 'cobalt' },
  }],
  workspace: { tabs: [{ title: 'q', sql, savedId: 's1' }], activeIndex: 0, pageSize: 200 },
  seenVersion: require('../package.json').version,
}, null, 2));

const run = (file, sql, cmds, js) => new Promise((resolve) => {
  seed(sql);
  const target = path.join(outDir, file);
  const args = ['.', `--smoke=${[target, ...cmds].join(',')}`, `--user-data-dir=${profile}`];
  if (js) args.push(`--smoke-js=${js}`);
  const p = spawn(electron, args, { cwd: path.join(__dirname, '..') });
  let buf = '';
  p.stdout.on('data', (d) => { buf += d; process.stdout.write(d); });
  p.stderr.on('data', (d) => { buf += d; });
  p.on('close', (code) => {
    const bad = /\[renderer ERROR\]|Uncaught|is not a function|is not defined/.test(buf);
    if (bad) console.log(buf.slice(0, 3000));
    resolve({ ok: code === 0 && !bad, out: buf });
  });
  setTimeout(() => p.kill(), 90000);
});

const readJs = (out) => JSON.parse((/\[smoke\] js (.*)/.exec(out) || [])[1] || '{}');
const wait = (ms) => `new Promise(r => setTimeout(r, ${ms}))`;

let fails = 0;
const expect = (cond, label) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) fails++;
};

(async () => {
  console.log('\nrecording');

  // Run a good query, a failing one, and a repeat of the first.
  const rec = await run('hist-record.png',
    'select id, email from shop.customers limit 25;', [], `(async () => {
    ${'const w = (ms) => new Promise(r => setTimeout(r, ms));'}
    window.__cobaltMenu('query:run'); await w(1800);
    window.__cobaltSetSql('select * from nope_missing;'); await w(300);
    window.__cobaltMenu('query:run'); await w(1600);
    window.__cobaltSetSql('select id, email from shop.customers limit 25;'); await w(300);
    window.__cobaltMenu('query:run'); await w(1800);
    const rows = await window.cobalt.history.search({ limit: 50 });
    return {
      count: rows.length,
      sqls: rows.map(r => r.sql.slice(0, 40)),
      failed: rows.filter(r => r.error).length,
      withRows: rows.filter(r => r.rowCount != null).length,
      timed: rows.filter(r => r.durationMs != null).length
    };
  })()`);
  if (!rec.ok) fails++;
  const r = readJs(rec.out);
  expect(r.count === 3, `three runs recorded (got ${r.count}: ${JSON.stringify(r.sqls)})`);
  expect(r.failed === 1, `the failure is marked (got ${r.failed})`);
  expect(r.withRows >= 2, `row counts captured (got ${r.withRows})`);
  expect(r.timed === 3, `durations captured (got ${r.timed})`);

  console.log('\nrecall');

  const panel = await run('hist-panel.png', 'select 1;', ['history:open'], `(async () => {
    ${'const w = (ms) => new Promise(r => setTimeout(r, ms));'}
    await w(700);
    const rows = () => document.querySelectorAll('.hist-row').length;
    const before = rows();
    const search = document.getElementById('h-search');
    search.value = 'customers';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await w(600);
    const filtered = rows();
    const preview = document.getElementById('h-sql').textContent;
    const meta = document.getElementById('h-meta').textContent.replace(/\\s+/g, ' ').trim();
    // The panel is a two-column layout; catch it collapsing into one.
    const body = document.querySelector('.hist-body').getBoundingClientRect();
    const left = document.querySelector('.hist-left').getBoundingClientRect();
    const right = document.querySelector('.hist-right').getBoundingClientRect();
    return {
      before, filtered, preview, meta,
      stats: document.getElementById('h-stats').textContent,
      sideBySide: right.left >= left.right - 1 && Math.abs(left.top - right.top) < 2,
      bodyHeight: Math.round(body.height)
    };
  })()`);
  if (!panel.ok) fails++;
  const p2 = readJs(panel.out);
  expect(p2.before >= 3, `the panel lists earlier runs (got ${p2.before})`);
  expect(p2.filtered >= 1 && p2.filtered < p2.before,
    `searching narrows the list (${p2.before} -> ${p2.filtered})`);
  expect(/customers/.test(p2.preview || ''), `the preview shows the full statement (got "${(p2.preview || '').slice(0, 50)}")`);
  expect(/Connection/.test(p2.meta || ''), `metadata is shown (got "${(p2.meta || '').slice(0, 80)}")`);
  expect(/statements recorded/.test(p2.stats || ''), `stats footer (got "${p2.stats}")`);
  expect(p2.sideBySide === true, 'the list and the preview sit side by side');
  expect(p2.bodyHeight > 200 && p2.bodyHeight < 700, `the panel is a sane height (got ${p2.bodyHeight}px)`);

  console.log('\nreuse');

  const reuse = await run('hist-reuse.png', 'select 1;', ['history:open'], `(async () => {
    ${'const w = (ms) => new Promise(r => setTimeout(r, ms));'}
    await w(700);
    const search = document.getElementById('h-search');
    search.value = 'nope_missing';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await w(600);
    document.getElementById('h-use').click();
    await w(500);
    return { editor: window.__cobaltGetSql(), overlayClosed: document.getElementById('overlay').classList.contains('hidden') };
  })()`);
  if (!reuse.ok) fails++;
  const u = readJs(reuse.out);
  expect(/nope_missing/.test(u.editor || ''), `the statement went into the editor (got "${(u.editor || '').slice(0, 50)}")`);
  expect(u.overlayClosed === true, 'the panel closed after use');

  fs.rmSync(profile, { recursive: true, force: true });
  console.log(`\n${fails ? fails + ' failed' : 'all checks passed'}\n`);
  process.exit(fails ? 1 : 0);
})();
