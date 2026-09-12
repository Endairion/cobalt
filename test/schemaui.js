'use strict';
/* Schema actions from the sidebar: the menu, the live SQL preview, and the
   change actually landing in the database. Run: node test/schemaui.js */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');
const { Client } = require('pg');

const outDir = path.join(__dirname, '..', 'shots');
fs.mkdirSync(outDir, { recursive: true });
const CFG = { host: 'localhost', port: 15432, database: 'cobalt', user: 'cobalt', password: 'cobalt' };

const sql = async (text) => {
  const c = new Client(CFG); await c.connect();
  const r = await c.query(text);
  await c.end(); return r.rows;
};

const conn = (id, name, extra = {}) => ({
  id, name, host: 'localhost', port: 15432, database: 'cobalt', user: 'cobalt',
  ssl: 'disable', password: { plain: 'cobalt' }, ...extra,
});

const seed = (openWith = 's1') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-schema-'));
  fs.writeFileSync(path.join(dir, 'cobalt-connections.json'), JSON.stringify({
    connections: [
      { ...conn('s1', 'Test DB'), order: 0 },
      { ...conn('s2', 'Prod (read-only)', { readOnly: true }), order: 1 },
    ],
    // Exactly one connection is opened, so every row in the tree belongs to it
    // and the test cannot accidentally read the other one's copy.
    workspace: {
      tabs: [{ title: 'Query 1', sql: 'select 1;', savedId: openWith }],
      activeIndex: 0,
      pageSize: 200,
      openConnections: [openWith],
      activeSavedId: openWith,
    },
    seenVersion: require('../package.json').version,
  }, null, 2));
  return dir;
};

const run = (file, js, openWith) => new Promise((resolve) => {
  const profile = seed(openWith);
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
  const rightClick = async (el) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 20, clientY: r.top + 5 }));
    await w(350);
  };
  const relRow = (name) => [...document.querySelectorAll('.tree-row.rel')]
    .find(r => r.querySelector('.name').textContent === name);
  const menuLabels = () => [...document.querySelectorAll('.ctx-menu .ctx-item .ctx-label')].map(n => n.textContent);
  const itemNamed = (t) => [...document.querySelectorAll('.ctx-menu .ctx-item')]
    .find(n => n.querySelector('.ctx-label').textContent === t);
  // A real press, so an item that tears its own menu down on mousedown is caught.
  const realClick = (el) => {
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, clientX: Math.round(r.left + 5), clientY: Math.round(r.top + 5) };
    el.dispatchEvent(new MouseEvent('mousedown', at));
    if (!el.isConnected) return false;
    el.dispatchEvent(new MouseEvent('mouseup', at));
    el.dispatchEvent(new MouseEvent('click', at));
    return true;
  };
  const field = (id) => document.querySelector('[data-f="' + id + '"]');
  const setField = (id, value) => {
    const f = field(id);
    f.value = value;
    f.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const previewSql = () => (document.getElementById('op-sql') || {}).textContent || '';
  const expandColumns = async (table) => {
    relRow(table).querySelector('.twisty').click();
    await w(400);
  };
  const colRow = (name) => [...document.querySelectorAll('.tree-row.column')]
    .find(r => r.dataset.column && r.dataset.column.split('|')[2] === name);
`;

(async () => {
  const fresh = async () => {
    await sql('drop table if exists shop.tmp_ops');
    await sql("create table shop.tmp_ops (id bigint primary key, name text, note text default 'hi')");
    await sql("insert into shop.tmp_ops values (1,'a'),(2,'b')");
  };
  const columnsOf = async (t) => (await sql(
    `select column_name, data_type, is_nullable, column_default
     from information_schema.columns where table_schema='shop' and table_name='${t}' order by ordinal_position`));

  console.log('\nwhat right-clicking a table offers');

  await fresh();
  const menu = await run('schema-menu.png', `(async () => {
    ${HELP}
    await w(1400);
    await rightClick(relRow('tmp_ops'));
    const labels = menuLabels();
    const dangerous = [...document.querySelectorAll('.ctx-menu .ctx-item.danger .ctx-label')].map(n => n.textContent);
    // A view has no columns to add and nothing to truncate.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await w(200);
    await rightClick(relRow('order_totals'));
    const viewLabels = menuLabels();
    return { labels, dangerous, viewLabels };
  })()`);
  if (!menu.ok) fails++;
  const m = readJs(menu.out);
  for (const want of ['Browse', 'Show DDL', 'Add Column…', 'Create Index…', 'Rename…', 'Empty Table…', 'Drop…']) {
    expect((m.labels || []).includes(want), `the menu offers ${want}`);
  }
  expect(JSON.stringify(m.dangerous) === '["Empty Table…","Drop…"]',
    `the destructive ones are marked as such (got ${JSON.stringify(m.dangerous)})`);
  expect(!(m.viewLabels || []).includes('Add Column…') && !(m.viewLabels || []).includes('Empty Table…'),
    `a view is not offered table-only actions (got ${JSON.stringify(m.viewLabels)})`);
  expect((m.viewLabels || []).includes('Drop…'), 'but a view can still be dropped');

  console.log('\nadding a column');

  await fresh();
  const add = await run('schema-add.png', `(async () => {
    ${HELP}
    await w(1400);
    await rightClick(relRow('tmp_ops'));
    realClick(itemNamed('Add Column…'));
    await w(400);
    setField('name', 'nickname');
    setField('type', 'text');
    const bare = previewSql();
    setField('defaultExpr', "'none'");
    field('notNull').checked = true;
    field('notNull').dispatchEvent(new Event('change', { bubbles: true }));
    const full = previewSql();
    // A semicolon in a free-text field must stop the run, not append a statement.
    setField('type', 'text; drop table shop.tmp_ops');
    const refused = { msg: previewSql(), disabled: document.querySelector('[data-op="run"]').disabled };
    setField('type', 'text');
    document.querySelector('[data-op="run"]').click();
    await w(1800);
    return {
      bare, full, refused,
      closed: !document.querySelector('.schema-op'),
      treeHasIt: !!document.body.textContent.match(/nickname/)
    };
  })()`);
  if (!add.ok) fails++;
  const a = readJs(add.out);
  expect(a.bare === 'alter table shop.tmp_ops\n  add column nickname text;',
    `the preview is the statement that will run (got ${JSON.stringify(a.bare)})`);
  expect(a.full === "alter table shop.tmp_ops\n  add column nickname text default 'none' not null;",
    `and it updates as you type (got ${JSON.stringify(a.full)})`);
  expect(/semicolon/i.test(a.refused.msg || '') && a.refused.disabled === true,
    `a semicolon in the type is refused and Run is disabled (got "${a.refused.msg}")`);
  expect(a.closed === true, 'the dialog closes once it has run');

  const cols = await columnsOf('tmp_ops');
  const nick = cols.find((c) => c.column_name === 'nickname');
  expect(!!nick, `the column is really there (got ${JSON.stringify(cols.map((c) => c.column_name))})`);
  expect(nick && nick.is_nullable === 'NO' && /'none'/.test(nick.column_default || ''),
    `with the default and NOT NULL asked for (got ${JSON.stringify(nick)})`);

  console.log('\ncreating an index');

  await fresh();
  const idx = await run('schema-index.png', `(async () => {
    ${HELP}
    await w(1400);
    await rightClick(relRow('tmp_ops'));
    realClick(itemNamed('Create Index…'));
    await w(400);
    const boxes = [...document.querySelectorAll('.op-cols input')];
    const listed = [...document.querySelectorAll('.op-cols .cn')].map(n => n.textContent);
    const emptyMsg = previewSql();
    boxes.find(b => b.value === 'name').checked = true;
    boxes[0].dispatchEvent(new Event('change', { bubbles: true }));
    const oneCol = previewSql();
    field('unique').checked = true;
    field('unique').dispatchEvent(new Event('change', { bubbles: true }));
    const uniq = previewSql();
    field('unique').checked = false;
    field('unique').dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('[data-op="run"]').click();
    await w(1800);
    return { listed, emptyMsg, oneCol, uniq, closed: !document.querySelector('.schema-op') };
  })()`);
  if (!idx.ok) fails++;
  const i = readJs(idx.out);
  expect(JSON.stringify(i.listed) === '["id","name","note"]',
    `every column is offered (got ${JSON.stringify(i.listed)})`);
  expect(/at least one column/i.test(i.emptyMsg || ''),
    `with nothing ticked it says so rather than showing broken SQL (got "${i.emptyMsg}")`);
  expect(i.oneCol === 'create index tmp_ops_name_idx\n  on shop.tmp_ops (name);',
    `the name follows the Postgres convention (got ${JSON.stringify(i.oneCol)})`);
  expect((i.uniq || '').startsWith('create unique index tmp_ops_name_key'),
    `ticking Unique changes the name too (got ${JSON.stringify(i.uniq)})`);

  const indexes = await sql("select indexname from pg_indexes where schemaname='shop' and tablename='tmp_ops'");
  expect(indexes.some((x) => x.indexname === 'tmp_ops_name_idx'),
    `the index exists (got ${JSON.stringify(indexes.map((x) => x.indexname))})`);

  console.log('\nchanging a column');

  await fresh();
  const colOps = await run('schema-column.png', `(async () => {
    ${HELP}
    await w(1400);
    await expandColumns('tmp_ops');
    const row = colRow('note');
    await rightClick(row);
    const labels = menuLabels();
    realClick(itemNamed('Rename…'));
    await w(400);
    const seeded = field('to').value;
    setField('to', 'memo');
    const preview = previewSql();
    document.querySelector('[data-op="run"]').click();
    await w(1800);
    return { labels, seeded, preview, stillOpen: !!document.querySelector('.schema-op') };
  })()`);
  if (!colOps.ok) fails++;
  const c = readJs(colOps.out);
  for (const want of ['Rename…', 'Change Type…', 'Set Default…', 'Drop Column…']) {
    expect((c.labels || []).includes(want), `a column offers ${want}`);
  }
  expect((c.labels || []).includes('Drop NOT NULL') || (c.labels || []).includes('Set NOT NULL'),
    `and the NOT NULL entry reflects the current state (got ${JSON.stringify(c.labels)})`);
  expect(c.seeded === 'note', `the rename box starts on the current name (got "${c.seeded}")`);
  expect(c.preview === 'alter table shop.tmp_ops\n  rename column note to memo;',
    `the preview is right (got ${JSON.stringify(c.preview)})`);

  const after = await columnsOf('tmp_ops');
  expect(after.some((x) => x.column_name === 'memo') && !after.some((x) => x.column_name === 'note'),
    `the column was renamed (got ${JSON.stringify(after.map((x) => x.column_name))})`);

  console.log('\na read-only connection offers nothing to change');

  await fresh();
  const ro = await run('schema-readonly.png', `(async () => {
    ${HELP}
    await w(1600);
    const live = [...document.querySelectorAll('.tree-row.conn.live .name')].map(n => n.textContent);
    await rightClick(relRow('tmp_ops'));
    const headers = [...document.querySelectorAll('.ctx-menu .ctx-header')].map(n => n.textContent);
    const disabled = [...document.querySelectorAll('.ctx-menu .ctx-item.disabled .ctx-label')].map(n => n.textContent);
    const enabled = [...document.querySelectorAll('.ctx-menu .ctx-item:not(.disabled) .ctx-label')].map(n => n.textContent);
    return { headers, disabled, enabled, live };
  })()`, 's2');
  if (!ro.ok) fails++;
  const q = readJs(ro.out);
  expect(JSON.stringify(q.live) === '["Prod (read-only)"]',
    `only the read-only connection is open (got ${JSON.stringify(q.live)})`);
  expect((q.headers || []).some((h) => /read-only/i.test(h)),
    `the menu says why (got ${JSON.stringify(q.headers)})`);
  expect((q.disabled || []).includes('Drop…') && (q.disabled || []).includes('Add Column…'),
    `the changing actions are disabled (got ${JSON.stringify(q.disabled)})`);
  expect((q.enabled || []).includes('Browse') && (q.enabled || []).includes('Show DDL'),
    `but reading is still offered (got ${JSON.stringify(q.enabled)})`);

  await sql('drop table if exists shop.tmp_ops');
  console.log(`\n${fails ? `${fails} failed` : 'all checks passed'}\n`);
  process.exit(fails ? 1 : 0);
})();
