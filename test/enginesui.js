'use strict';
/* The app on MySQL: the engine picker, browsing, editing, per-engine DDL, and
   the server activity panel. Run: node test/enginesui.js */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');
const mysql = require('mysql2/promise');

const outDir = path.join(__dirname, '..', 'shots');
fs.mkdirSync(outDir, { recursive: true });

let fails = 0;
const expect = (cond, label) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) fails++;
};
const readJs = (out) => JSON.parse((/\[smoke\] js (.*)/.exec(out) || [])[1] || '{}');

const MY = {
  id: 'my', name: 'MySQL', engine: 'mysql', host: '127.0.0.1', port: 13306,
  database: 'cobalt', user: 'cobalt', ssl: 'disable', order: 0, password: { plain: 'cobalt' },
};
const PG = {
  id: 'pg', name: 'Postgres', engine: 'postgres', host: 'localhost', port: 15432,
  database: 'cobalt', user: 'cobalt', ssl: 'disable', order: 1, password: { plain: 'cobalt' },
};

const seed = (openWith) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-eng-'));
  fs.writeFileSync(path.join(dir, 'cobalt-connections.json'), JSON.stringify({
    connections: [MY, PG],
    workspace: {
      tabs: [{ title: 'Query 1', sql: 'select count(*) from customers;', savedId: openWith }],
      activeIndex: 0, pageSize: 200, openConnections: [openWith], activeSavedId: openWith,
    },
    seenVersion: require('../package.json').version,
  }, null, 2));
  return dir;
};

const run = (file, js, openWith = 'my') => new Promise((resolve) => {
  const profile = seed(openWith);
  const p = spawn(electron, ['.', `--smoke=${path.join(outDir, file)}`,
    `--user-data-dir=${profile}`, `--smoke-js=${js}`], { cwd: path.join(__dirname, '..') });
  let buf = '';
  p.stdout.on('data', (d) => { buf += d; process.stdout.write(d); });
  p.stderr.on('data', (d) => { buf += d; });
  p.on('close', (code) => {
    const saved = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(profile, 'cobalt-connections.json'), 'utf8')); }
      catch { return null; }
    })();
    fs.rmSync(profile, { recursive: true, force: true });
    const bad = /\[renderer ERROR\]|Uncaught|is not a function|is not defined/.test(buf);
    if (bad) console.log(buf.slice(0, 3000));
    resolve({ ok: code === 0 && !bad, out: buf, saved });
  });
  setTimeout(() => p.kill(), 90000);
});

const HELP = `
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const g = (id) => document.getElementById(id);
  const set = (id, v) => { const e = g(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
  const pick = (id, v) => { const e = g(id); e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); };
  const relRow = (name) => [...document.querySelectorAll('.tree-row.rel')]
    .find(r => r.querySelector('.name').textContent === name);
  const browse = async (name) => { relRow(name).click(); await w(2400); };
  const rightClick = async (el) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 20, clientY: r.top + 5 }));
    await w(350);
  };
  const itemNamed = (t) => [...document.querySelectorAll('.ctx-menu .ctx-item')]
    .find(n => n.querySelector('.ctx-label').textContent === t);
  const realClick = (el) => {
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, clientX: Math.round(r.left + 5), clientY: Math.round(r.top + 5) };
    el.dispatchEvent(new MouseEvent('mousedown', at));
    if (!el.isConnected) return false;
    el.dispatchEvent(new MouseEvent('mouseup', at));
    el.dispatchEvent(new MouseEvent('click', at));
    return true;
  };
  const previewSql = () => (g('op-sql') || {}).textContent || '';
`;

(async () => {
  console.log('\nchoosing an engine');

  const dialog = await run('eng-dialog.png', `(async () => {
    ${HELP}
    await w(1500);
    window.__cobaltMenu('connection:new');
    await w(500);
    const options = [...document.querySelectorAll('#f-engine option')].map(o => o.textContent);
    const startPort = g('f-port').value;
    const startDb = g('f-db').value;
    pick('f-engine', 'mysql');
    await w(200);
    const afterSwitch = { port: g('f-port').value, db: g('f-db').value };
    // A port you typed yourself must survive the switch.
    pick('f-engine', 'postgres');
    await w(150);
    set('f-port', '6543');
    pick('f-engine', 'mysql');
    await w(150);
    const keptTyped = g('f-port').value;
    return { options, startPort, startDb, afterSwitch, keptTyped };
  })()`);
  if (!dialog.ok) fails++;
  const d = readJs(dialog.out);
  expect((d.options || []).length === 2 && /MySQL/.test((d.options || []).join(' ')),
    `both engines are offered (got ${JSON.stringify(d.options)})`);
  expect(d.startPort === '5432' && d.startDb === 'postgres', 'a new connection starts on Postgres defaults');
  expect(d.afterSwitch && d.afterSwitch.port === '3306',
    `switching engine moves the default port (got ${JSON.stringify(d.afterSwitch)})`);
  expect(d.keptTyped === '6543', `but a port you typed is left alone (got ${d.keptTyped})`);

  console.log('\nbrowsing a MySQL database');

  const browse = await run('eng-mysql.png', `(async () => {
    ${HELP}
    await w(3000);
    const conns = [...document.querySelectorAll('.tree-row.conn.live .name')].map(n => n.textContent);
    const schemas = [...document.querySelectorAll('.tree-row.schema .name')].map(n => n.textContent);
    const tables = [...document.querySelectorAll('.tree-row.rel .name')].map(n => n.textContent);
    await browse('docs');
    const headers = [...document.querySelectorAll('.gh[data-col] .gh-name')].map(n => n.textContent);
    const editable = !!document.querySelector('[data-act="commit"]');
    // The inspector should read a MySQL json column and a blob the same way.
    document.querySelector('[data-act="inspect"]').click();
    await w(400);
    const payloadIdx = headers.findIndex(h => /payload/.test(h));
    const cell = document.querySelector('.grow[data-row="0"] .gc[data-col="' + payloadIdx + '"]');
    const cr = cell.getBoundingClientRect();
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: cr.left + 5, clientY: cr.top + 5 }));
    await w(350);
    const shown = (document.querySelector('.insp-val') || {}).textContent || '';
    return { conns, schemas, tables, headers, editable, shown, status: (g('status-left') || {}).textContent };
  })()`);
  if (!browse.ok) fails++;
  const b = readJs(browse.out);
  expect(JSON.stringify(b.conns) === '["MySQL"]', `the MySQL connection opens (got ${JSON.stringify(b.conns)})`);
  expect(JSON.stringify(b.schemas) === '["cobalt"]',
    `the database fills the schema slot (got ${JSON.stringify(b.schemas)})`);
  expect((b.tables || []).includes('customers') && (b.tables || []).includes('order_totals'),
    `tables and views are listed (got ${JSON.stringify(b.tables)})`);
  expect(b.editable === true, 'a table with a primary key is editable');
  expect(/\n\s+"account"/.test(b.shown || ''),
    `the inspector pretty-prints a MySQL json column (got ${JSON.stringify((b.shown || '').slice(0, 50))})`);
  expect((b.shown || '').includes('12345678901234567890'),
    'and the 20-digit number inside it is intact');

  console.log('\nschema actions speak MySQL');

  const ddl = await run('eng-ddl.png', `(async () => {
    ${HELP}
    await w(2600);
    await rightClick(relRow('customers'));
    realClick(itemNamed('Add Column…'));
    await w(400);
    const types = [...document.querySelectorAll('#dl-type option')].map(o => o.value);
    document.querySelector('[data-f="name"]').value = 'nickname';
    document.querySelector('[data-f="name"]').dispatchEvent(new Event('input', { bubbles: true }));
    const addSql = previewSql();
    document.querySelector('[data-op="cancel"]').click();
    await w(300);

    // Change Type must be MODIFY COLUMN here, not ALTER COLUMN ... TYPE.
    relRow('customers').querySelector('.twisty').click();
    await w(500);
    const colRow = [...document.querySelectorAll('.tree-row.column')]
      .find(r => r.dataset.column && r.dataset.column.split('|')[2] === 'full_name');
    await rightClick(colRow);
    realClick(itemNamed('Change Type…'));
    await w(400);
    const typeSql = previewSql();
    const hasUsing = !!document.querySelector('[data-f="using"]');
    document.querySelector('[data-op="cancel"]').click();
    await w(200);

    await rightClick(relRow('customers'));
    realClick(itemNamed('Drop…'));
    await w(400);
    const dropSql = previewSql();
    const hasCascade = !!document.querySelector('[data-f="cascade"]');
    document.querySelector('[data-op="cancel"]').click();
    return { types, addSql, typeSql, hasUsing, dropSql, hasCascade };
  })()`);
  if (!ddl.ok) fails++;
  const dd = readJs(ddl.out);
  expect((dd.types || []).includes('varchar(255)') && !(dd.types || []).includes('jsonb'),
    `the type list is MySQL's (got ${JSON.stringify((dd.types || []).slice(0, 4))})`);
  expect(/add column nickname varchar\(255\)/.test(dd.addSql || ''),
    `Add Column defaults to a MySQL type (got ${JSON.stringify(dd.addSql)})`);
  expect(/modify column full_name/.test(dd.typeSql || ''),
    `Change Type is MODIFY COLUMN (got ${JSON.stringify(dd.typeSql)})`);
  expect(dd.hasUsing === false, 'and there is no USING box, which MySQL has no use for');
  expect(dd.dropSql === 'drop table cobalt.customers;',
    `Drop has no CASCADE (got ${JSON.stringify(dd.dropSql)})`);
  expect(dd.hasCascade === false, 'and no Cascade tickbox either');

  console.log('\nserver activity');

  const procs = await run('eng-procs.png', `(async () => {
    ${HELP}
    await w(2600);
    window.__cobaltMenu('server:processes');
    await w(1500);
    const opened = !!document.querySelector('.process-modal');
    const headers = [...document.querySelectorAll('.proc-table th')].map(n => n.textContent);
    const rows = document.querySelectorAll('.proc-table tr').length - 1;
    const mine = document.querySelectorAll('.proc-table tr.me').length;
    const buttonsOnSelf = document.querySelectorAll('.proc-table tr.me .proc-act button').length;
    return { opened, headers, rows, mine, buttonsOnSelf };
  })()`);
  if (!procs.ok) fails++;
  const pr = readJs(procs.out);
  expect(pr.opened === true, 'the panel opens');
  expect(JSON.stringify(pr.headers) === '["id","user","database","state","time","query",""]',
    `with the columns the driver normalized (got ${JSON.stringify(pr.headers)})`);
  expect(pr.rows >= 1, `and at least one connection listed (got ${pr.rows})`);
  expect(pr.mine >= 1, 'our own connection is marked');
  expect(pr.buttonsOnSelf === 0, 'and offers no button to kill ourselves');

  console.log('\nthe same panel on Postgres');

  const pgProcs = await run('eng-procs-pg.png', `(async () => {
    ${HELP}
    await w(2600);
    window.__cobaltMenu('server:processes');
    await w(1500);
    return {
      opened: !!document.querySelector('.process-modal'),
      rows: document.querySelectorAll('.proc-table tr').length - 1,
      mine: document.querySelectorAll('.proc-table tr.me').length,
      schemas: [...document.querySelectorAll('.tree-row.schema .name')].map(n => n.textContent)
    };
  })()`, 'pg');
  if (!pgProcs.ok) fails++;
  const pg = readJs(pgProcs.out);
  expect(pg.opened === true && pg.rows >= 1, `it works on Postgres too (${pg.rows} rows)`);
  expect(pg.mine >= 1, 'and marks our connection there as well');
  expect((pg.schemas || []).includes('shop'), `while Postgres still shows real schemas (got ${JSON.stringify(pg.schemas)})`);

  // Nothing above should have changed the database.
  const c = await mysql.createConnection({
    host: '127.0.0.1', port: 13306, user: 'cobalt', password: 'cobalt', database: 'cobalt',
  });
  const [cols] = await c.query(
    "select column_name from information_schema.columns where table_schema='cobalt' and table_name='customers'");
  await c.end();
  expect(!cols.some((x) => (x.COLUMN_NAME || x.column_name) === 'nickname'),
    'the previewed ALTER was never run');

  console.log(`\n${fails ? `${fails} failed` : 'all checks passed'}\n`);
  process.exit(fails ? 1 : 0);
})();
