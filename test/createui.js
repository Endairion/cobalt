'use strict';
/* Making things from the tree: a schema, a table in it, an index on that, and
   a database — each through its own right-click menu, each landing in the
   server for real.
   Run: node test/createui.js   (needs cobalt-test-pg on :15432) */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');
const { Client } = require('pg');

const outDir = path.join(__dirname, '..', 'shots');
fs.mkdirSync(outDir, { recursive: true });
const CFG = { host: 'localhost', port: 15432, database: 'cobalt', user: 'cobalt', password: 'cobalt' };

const sql = async (text, db) => {
  const c = new Client(db ? { ...CFG, database: db } : CFG);
  await c.connect();
  const r = await c.query(text);
  await c.end();
  return r.rows;
};

const seed = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-create-'));
  fs.writeFileSync(path.join(dir, 'cobalt-connections.json'), JSON.stringify({
    connections: [{
      id: 's1', name: 'Test DB', host: 'localhost', port: 15432, database: 'cobalt',
      user: 'cobalt', ssl: 'disable', order: 0, password: { plain: 'cobalt' },
    }],
    workspace: {
      tabs: [{ title: 'Query 1', sql: 'select 1;', savedId: 's1' }],
      activeIndex: 0, pageSize: 200, openConnections: ['s1'], activeSavedId: 's1',
    },
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
  const rowFor = (sel, text) => [...document.querySelectorAll(sel)]
    .find(n => n.textContent.includes(text));
  // A context menu opens on the real event, and its items only answer to a
  // full mousedown/mouseup/click the way a menu item does.
  const rightClick = (el) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 5) }));
  };
  const pick = (label) => {
    const item = [...document.querySelectorAll('.ctx-menu .ctx-item')]
      .find(n => n.textContent.trim().startsWith(label));
    if (!item) throw new Error('no menu item ' + label + ' in ['
      + [...document.querySelectorAll('.ctx-menu .ctx-item')].map(n => n.textContent.trim()).join(', ') + ']');
    const r = item.getBoundingClientRect();
    const at = { bubbles: true, clientX: Math.round(r.left + 5), clientY: Math.round(r.top + 5) };
    item.dispatchEvent(new MouseEvent('mousedown', at));
    item.dispatchEvent(new MouseEvent('mouseup', at));
    item.dispatchEvent(new MouseEvent('click', at));
  };
  const set = (sel, value) => {
    const el = document.querySelector(sel);
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const opSql = () => (document.querySelector('#op-sql') || {}).textContent || '';
  const go = async () => {
    document.querySelector('[data-op="run"]').click();
    await w(1200);
    // Destructive actions ask first; say yes.
    const yes = document.querySelector('.ask-modal [data-ask="yes"]');
    if (yes) { yes.click(); await w(1500); }
  };
`;

(async () => {
  // Leave nothing behind from a previous run.
  await sql('drop schema if exists tmp_make cascade');
  await sql('drop database if exists cobalt_made');

  console.log('\na schema, from the connection row');

  const schema = await run('create-schema.png', `(async () => {
    ${HELP}
    await w(2600);
    rightClick(document.querySelector('.tree-row.conn.live'));
    await w(500);
    const menu = [...document.querySelectorAll('.ctx-menu .ctx-item')].map(n => n.textContent.trim());
    pick('New Schema');
    await w(600);
    set('[data-f="name"]', 'tmp_make');
    await w(200);
    const preview = opSql();
    await go();
    return { menu, preview, schemas: [...document.querySelectorAll('.tree-row.schema .name')].map(n => n.textContent) };
  })()`);
  if (!schema.ok) fails++;
  const sc = readJs(schema.out);
  expect((sc.menu || []).some((m) => /New Database/.test(m)) && (sc.menu || []).some((m) => /New Schema/.test(m)),
    `the connection row offers both (got ${JSON.stringify(sc.menu)})`);
  expect(sc.preview === 'CREATE SCHEMA tmp_make;',
    `the preview is the statement (got ${JSON.stringify(sc.preview)})`);
  const made = await sql("select 1 from information_schema.schemata where schema_name = 'tmp_make'");
  expect(made.length === 1, 'and the schema is on the server');
  expect((sc.schemas || []).includes('tmp_make'),
    `the tree picked it up without a manual refresh (got ${JSON.stringify(sc.schemas)})`);

  console.log('\na table in it, from the schema row');

  const table = await run('create-table.png', `(async () => {
    ${HELP}
    await w(2600);
    rightClick(rowFor('.tree-row.schema', 'tmp_make'));
    await w(500);
    pick('New Table');
    await w(600);
    set('#ct-name', 'widgets');
    // Row 0 is the id column the dialog starts with. Fill in the second.
    const rows = document.querySelectorAll('.ct-row');
    const second = rows[1];
    second.querySelector('[data-c="name"]').value = 'label';
    second.querySelector('[data-c="name"]').dispatchEvent(new Event('input', { bubbles: true }));
    second.querySelector('[data-c="type"]').value = 'text';
    second.querySelector('[data-c="type"]').dispatchEvent(new Event('input', { bubbles: true }));
    second.querySelector('[data-c="notNull"]').click();
    await w(200);
    const preview = opSql();
    const startedWith = rows.length;
    await go();
    return { preview, startedWith,
      rels: [...document.querySelectorAll('.tree-row.rel .name')].map(n => n.textContent) };
  })()`);
  if (!table.ok) fails++;
  const tb = readJs(table.out);
  expect(tb.startedWith === 2, `it opens with an id column and a blank one (got ${tb.startedWith})`);
  expect(tb.preview === [
    'CREATE TABLE tmp_make.widgets (',
    '  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,',
    '  label text NOT NULL',
    ');',
  ].join('\n'), `the preview is the statement (got ${JSON.stringify(tb.preview)})`);

  const cols = await sql(`select column_name, data_type, is_nullable
    from information_schema.columns where table_schema='tmp_make' and table_name='widgets'
    order by ordinal_position`);
  expect(cols.length === 2 && cols[0].column_name === 'id' && cols[1].column_name === 'label',
    `the table is on the server (got ${JSON.stringify(cols.map((c) => c.column_name))})`);
  expect(cols[1] && cols[1].is_nullable === 'NO', 'with NOT NULL where it was ticked');

  const keys = await sql(`select a.attname from pg_index i
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
    where i.indrelid = 'tmp_make.widgets'::regclass and i.indisprimary`);
  expect(keys.length === 1 && keys[0].attname === 'id',
    `and id is the key (got ${JSON.stringify(keys.map((k) => k.attname))})`);

  console.log('\nand an index on it can be dropped again from the tree');

  await sql('create index widgets_label_idx on tmp_make.widgets (label)');

  const idx = await run('create-dropindex.png', `(async () => {
    ${HELP}
    await w(2600);
    // A new schema starts collapsed, so open it, then the table inside it, to
    // reach the index underneath.
    rowFor('.tree-row.schema', 'tmp_make').click();
    await w(700);
    const relRow = rowFor('.tree-row.rel', 'widgets');
    if (!relRow) return { seen: [...document.querySelectorAll('.tree-row .name')].map(n => n.textContent) };
    relRow.querySelector('.twisty').click();
    await w(2000);
    const row = rowFor('.tree-row.object', 'widgets_label_idx');
    if (!row) return { seen: [...document.querySelectorAll('.tree-row.object .name')].map(n => n.textContent) };
    rightClick(row);
    await w(500);
    const menu = [...document.querySelectorAll('.ctx-menu .ctx-item')].map(n => n.textContent.trim());
    pick('Drop Index');
    await w(600);
    const preview = opSql();
    await go();
    return { menu, preview };
  })()`);
  if (!idx.ok) fails++;
  const ix = readJs(idx.out);
  expect(/Drop Index/.test((ix.menu || []).join('|')),
    `an index row has a menu (got ${JSON.stringify(ix.menu || ix.seen)})`);
  expect(ix.preview === 'DROP INDEX tmp_make.widgets_label_idx;',
    `the preview names the schema (got ${JSON.stringify(ix.preview)})`);
  const left = await sql("select 1 from pg_indexes where indexname = 'widgets_label_idx'");
  expect(left.length === 0, 'and the index is gone from the server');

  console.log('\na database, from the picker where you go looking for one');

  const db = await run('create-database.png', `(async () => {
    ${HELP}
    await w(2600);
    document.querySelector('[data-dbpicker]').click();
    await w(500);
    const menu = [...document.querySelectorAll('.ctx-menu .ctx-item')].map(n => n.textContent.trim());
    pick('New Database');
    await w(600);
    set('[data-f="name"]', 'cobalt_made');
    await w(200);
    const preview = opSql();
    await go();
    return { menu, preview };
  })()`);
  if (!db.ok) fails++;
  const dbr = readJs(db.out);
  expect(/New Database/.test((dbr.menu || []).join('|')),
    `the picker offers it under the list (got ${JSON.stringify(dbr.menu)})`);
  expect(dbr.preview === 'CREATE DATABASE cobalt_made;',
    `the preview is the statement (got ${JSON.stringify(dbr.preview)})`);
  const dbs = await sql("select 1 from pg_database where datname = 'cobalt_made'");
  expect(dbs.length === 1, 'and the database exists');

  console.log('\ndropping the schema takes the table with it');

  const drop = await run('create-dropschema.png', `(async () => {
    ${HELP}
    await w(2600);
    rightClick(rowFor('.tree-row.schema', 'tmp_make'));
    await w(500);
    pick('Drop Schema');
    await w(600);
    document.querySelector('[data-f="cascade"]').click();
    await w(200);
    const preview = opSql();
    const asked = [];
    document.querySelector('[data-op="run"]').click();
    await w(900);
    const m = document.querySelector('.ask-modal');
    if (m) asked.push(m.querySelector('.ask-message').textContent);
    if (m) { m.querySelector('[data-ask="yes"]').click(); await w(1800); }
    return { preview, asked,
      schemas: [...document.querySelectorAll('.tree-row.schema .name')].map(n => n.textContent) };
  })()`);
  if (!drop.ok) fails++;
  const dr = readJs(drop.out);
  expect(dr.preview === 'DROP SCHEMA tmp_make CASCADE;',
    `CASCADE goes in when ticked (got ${JSON.stringify(dr.preview)})`);
  expect((dr.asked || []).some((a) => /tmp_make/.test(a)),
    `it asks before doing it (got ${JSON.stringify(dr.asked)})`);
  const gone = await sql("select 1 from information_schema.schemata where schema_name = 'tmp_make'");
  expect(gone.length === 0, 'and the schema and its table are gone');
  expect(!(dr.schemas || []).includes('tmp_make'), 'the tree no longer lists it');

  // Tidy up after ourselves.
  await sql('drop database if exists cobalt_made');

  console.log(`\n${fails ? `${fails} failed` : 'all checks passed'}\n`);
  process.exit(fails ? 1 : 0);
})();
