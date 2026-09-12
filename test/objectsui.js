'use strict';
/* The object browser: indexes, keys, triggers under a table, and functions and
   sequences under a schema. Run: node test/objectsui.js */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

const outDir = path.join(__dirname, '..', 'shots');
fs.mkdirSync(outDir, { recursive: true });

let fails = 0;
const expect = (cond, label) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) fails++;
};
const readJs = (out) => JSON.parse((/\[smoke\] js (.*)/.exec(out) || [])[1] || '{}');

const PG = {
  id: 'pg', name: 'Postgres', engine: 'postgres', host: 'localhost', port: 15432,
  database: 'cobalt', user: 'cobalt', ssl: 'disable', order: 0, password: { plain: 'cobalt' },
};
const MY = {
  id: 'my', name: 'MySQL', engine: 'mysql', host: '127.0.0.1', port: 13306,
  database: 'cobalt', user: 'cobalt', ssl: 'disable', order: 1, password: { plain: 'cobalt' },
};

const seed = (openWith) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-obj-'));
  fs.writeFileSync(path.join(dir, 'cobalt-connections.json'), JSON.stringify({
    connections: [PG, MY],
    workspace: {
      tabs: [{ title: 'Query 1', sql: 'select 1;', savedId: openWith }],
      activeIndex: 0, pageSize: 200, openConnections: [openWith], activeSavedId: openWith,
    },
    seenVersion: require('../package.json').version,
  }, null, 2));
  return dir;
};

const run = (file, js, openWith = 'pg') => new Promise((resolve) => {
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

const HELP = `
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const texts = (sel) => [...document.querySelectorAll(sel)].map(n => n.textContent.trim());
  const relRow = (name) => [...document.querySelectorAll('.tree-row.rel')]
    .find(r => r.querySelector('.name').textContent === name);
  const expand = async (name) => { relRow(name).querySelector('.twisty').click(); await w(900); };
  const groups = () => texts('.tree-row.objgroup .name');
  const objects = () => [...document.querySelectorAll('.tree-row.object')].map(r => ({
    kind: (r.querySelector('.kind') || {}).textContent || '',
    name: (r.querySelector('.name') || {}).textContent || '',
    meta: (r.querySelector('.meta') || {}).textContent || '',
    title: r.getAttribute('title') || ''
  }));
`;

(async () => {
  console.log('\nwhat hangs off a table');

  const table = await run('obj-table.png', `(async () => {
    ${HELP}
    await w(2800);
    await expand('customers');
    // The catalogue is fetched lazily, so the first draw may say so.
    await w(1200);
    return {
      groups: groups(),
      objects: objects(),
      columnsStillThere: texts('.tree-row.column .name').length
    };
  })()`);
  if (!table.ok) fails++;
  const t = readJs(table.out);
  expect((t.groups || []).includes('Indexes'), `indexes are shown (got ${JSON.stringify(t.groups)})`);
  expect((t.groups || []).includes('Triggers'), 'and triggers');
  expect(t.columnsStillThere >= 8, `columns are still listed too (got ${t.columnsStillThere})`);

  const idx = (t.objects || []).filter((o) => /^(PK|UQ|IX)$/.test(o.kind));
  expect(idx.some((o) => o.name === 'customers_pkey' && o.kind === 'PK'),
    `the primary key index is marked PK (got ${JSON.stringify(idx)})`);
  expect(idx.some((o) => o.name === 'customers_email_key' && o.kind === 'UQ'),
    'a unique index is marked UQ');
  expect(idx.every((o) => /B|kB|MB/.test(o.meta) || o.meta === ''),
    `index sizes are readable (got ${JSON.stringify(idx.map((o) => o.meta))})`);
  expect(idx.some((o) => /CREATE .*INDEX/i.test(o.title)),
    'and hovering shows the definition');

  const trg = (t.objects || []).find((o) => o.kind === 'TR');
  expect(trg && trg.name === 'customers_audit', `the trigger is listed (got ${JSON.stringify(trg)})`);
  expect(trg && /after update/i.test(trg.title), `with what it fires on (got ${JSON.stringify(trg && trg.title)})`);

  console.log('\na primary key is not listed twice');

  // It is an index and a constraint; showing both is noise.
  expect(!(t.objects || []).some((o) => o.kind === 'PK' && /constraint/i.test(o.meta)),
    'the PK appears under Indexes, not again under Keys');
  const keys = (t.objects || []).filter((o) => /foreign key/.test(o.meta));
  expect(keys.length === 0, `customers holds no foreign key (got ${JSON.stringify(keys)})`);

  console.log('\nforeign keys show on the table that holds them');

  const fk = await run('obj-fk.png', `(async () => {
    ${HELP}
    await w(2800);
    await expand('orders');
    await w(1200);
    return { groups: groups(), objects: objects() };
  })()`);
  if (!fk.ok) fails++;
  const f = readJs(fk.out);
  expect((f.groups || []).includes('Keys'), `orders has a Keys group (got ${JSON.stringify(f.groups)})`);
  expect((f.objects || []).some((o) => /foreign key/.test(o.meta)),
    `with its foreign key (got ${JSON.stringify((f.objects || []).map((o) => o.meta))})`);

  console.log('\nfunctions and sequences belong to the schema');

  const schema = await run('obj-schema.png', `(async () => {
    ${HELP}
    await w(2800);
    // Nothing is expanded yet, so nudge the catalogue into loading.
    await expand('customers');
    await w(1200);
    const folders = texts('.tree-row.objgroup.folder .name');
    const fnFolder = [...document.querySelectorAll('.tree-row.objgroup.folder')]
      .find(n => n.querySelector('.name').textContent === 'Functions');
    fnFolder.click();
    await w(500);
    const seqFolder = [...document.querySelectorAll('.tree-row.objgroup.folder')]
      .find(n => n.querySelector('.name').textContent === 'Sequences');
    if (seqFolder) seqFolder.click();
    await w(500);
    return { folders, objects: objects() };
  })()`);
  if (!schema.ok) fails++;
  const sc = readJs(schema.out);
  expect((sc.folders || []).includes('Functions'), `a Functions folder (got ${JSON.stringify(sc.folders)})`);
  expect((sc.folders || []).includes('Sequences'), 'and a Sequences folder');
  const fns = (sc.objects || []).filter((o) => o.kind === 'FN' || o.kind === 'PR');
  expect(fns.some((o) => o.name === 'customer_count'),
    `the function is listed (got ${JSON.stringify(fns.map((o) => o.name))})`);
  expect(fns.some((o) => /bigint/.test(o.meta)), 'with what it returns');
  const seqs = (sc.objects || []).filter((o) => o.kind === 'SQ');
  expect(seqs.length >= 1, `the identity sequences are there (got ${seqs.length})`);

  console.log('\nthe same tree on MySQL');

  const mysql = await run('obj-mysql.png', `(async () => {
    ${HELP}
    await w(3000);
    await expand('customers');
    await w(1500);
    const folders = texts('.tree-row.objgroup.folder .name');
    return { groups: groups(), folders, objects: objects() };
  })()`, 'my');
  if (!mysql.ok) fails++;
  const mm = readJs(mysql.out);
  expect((mm.groups || []).includes('Indexes') && (mm.groups || []).includes('Triggers'),
    `the same groups (got ${JSON.stringify(mm.groups)})`);
  expect((mm.objects || []).some((o) => o.kind === 'PK' && o.name === 'PRIMARY'),
    `MySQL names its primary key PRIMARY (got ${JSON.stringify((mm.objects || []).filter((o) => o.kind === 'PK'))})`);
  expect((mm.objects || []).some((o) => o.kind === 'TR' && o.name === 'customers_audit'),
    'and the trigger is found');
  // MySQL has no sequences, so that folder should simply not appear.
  expect(!(mm.folders || []).includes('Sequences'),
    `no Sequences folder where there are none (got ${JSON.stringify(mm.folders)})`);
  expect((mm.folders || []).includes('Functions'), 'but Functions is there');

  console.log(`\n${fails ? `${fails} failed` : 'all checks passed'}\n`);
  process.exit(fails ? 1 : 0);
})();
