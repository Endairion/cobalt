'use strict';
/* The health panel in the app, on both engines. Run: node test/healthui.js */

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-hl-'));
  fs.writeFileSync(path.join(dir, 'cobalt-connections.json'), JSON.stringify({
    connections: [PG, MY],
    workspace: {
      tabs: [{ title: 'Query 1', sql: 'select * from shop.customers;', savedId: openWith }],
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
  const statFor = (label) => {
    const k = [...document.querySelectorAll('.hl-k')].find(n => n.textContent.trim() === label);
    return k ? k.parentElement.querySelector('.hl-v').textContent.trim() : null;
  };
`;

(async () => {
  console.log('\nthe panel on Postgres');

  const pg = await run('hl-pg.png', `(async () => {
    ${HELP}
    await w(2600);
    window.__cobaltMenu('server:health');
    await w(2000);
    const opened = !!document.querySelector('.health-modal');
    const headings = texts('.hl-col h3');
    const sections = texts('.hl-table h4').map(t => t.split(' · ')[0]);
    return {
      opened, headings, sections,
      size: statFor('database size'),
      hit: statFor('cache hit ratio'),
      conns: statFor('connections'),
      shared: statFor('shared_buffers'),
      memory: statFor('memory'),
      cpu: statFor('cpu'),
      electron: statFor('electron'),
      counters: texts('.hl-ck'),
      biggest: texts('.hl-table td').slice(0, 4)
    };
  })()`);
  if (!pg.ok) fails++;
  const p = readJs(pg.out);
  expect(p.opened === true, 'it opens');
  expect(JSON.stringify(p.headings) === '["The server PostgreSQL","Cobalt"]',
    `both halves are there (got ${JSON.stringify(p.headings)})`);
  expect(/MB|KB|GB/.test(p.size || ''), `the database size is shown in a readable unit (got ${JSON.stringify(p.size)})`);
  expect(/%$/.test(p.hit || ''), `the cache hit ratio is a percentage (got ${JSON.stringify(p.hit)})`);
  expect(/^\d+ of \d+$/.test(p.conns || ''), `connections are shown against the limit (got ${JSON.stringify(p.conns)})`);
  expect(/\d/.test(p.shared || ''), `shared_buffers is reported (got ${JSON.stringify(p.shared)})`);
  expect((p.counters || []).includes('commits') && (p.counters || []).includes('temp files'),
    `the counters that matter are there (got ${JSON.stringify(p.counters)})`);
  expect((p.sections || []).includes('Biggest tables'),
    `and the table breakdown (got ${JSON.stringify(p.sections)})`);

  console.log('\nwhat Cobalt itself costs');

  expect(/MB|KB|GB/.test(p.memory || ''), `the app's own memory is shown (got ${JSON.stringify(p.memory)})`);
  expect(/%$/.test(p.cpu || ''), `and its cpu (got ${JSON.stringify(p.cpu)})`);
  expect(/^\d+\./.test(p.electron || ''), `with the Electron version behind it (got ${JSON.stringify(p.electron)})`);

  console.log('\nit counts what this window is actually holding');

  const loaded = await run('hl-loaded.png', `(async () => {
    ${HELP}
    await w(2600);
    window.__cobaltMenu('query:run');
    await w(2600);
    const rowsInGrid = window.__cobaltGridRows();
    window.__cobaltMenu('server:health');
    await w(2000);
    return { rowsInGrid, reported: statFor('rows held in grids'), tabs: statFor('open tabs') };
  })()`);
  if (!loaded.ok) fails++;
  const l = readJs(loaded.out);
  expect(l.rowsInGrid > 0, `the query loaded rows (got ${l.rowsInGrid})`);
  expect(Number(String(l.reported || '').replace(/,/g, '')) === l.rowsInGrid,
    `and the panel reports exactly those (grid ${l.rowsInGrid}, panel ${JSON.stringify(l.reported)})`);
  expect(Number(l.tabs) >= 1, `with the tab count (got ${JSON.stringify(l.tabs)})`);

  console.log('\nthe same panel on MySQL');

  const my = await run('hl-mysql.png', `(async () => {
    ${HELP}
    await w(2600);
    window.__cobaltMenu('server:health');
    await w(2000);
    const sections = texts('.hl-table h4').map(t => t.split(' · ')[0]);
    return {
      opened: !!document.querySelector('.health-modal'),
      heading: texts('.hl-col h3')[0],
      pool: statFor('innodb_buffer_pool_size'),
      hit: statFor('cache hit ratio'),
      sections,
      counters: texts('.hl-ck')
    };
  })()`, 'my');
  if (!my.ok) fails++;
  const mm = readJs(my.out);
  expect(mm.opened === true && /MySQL/.test(mm.heading || ''),
    `it opens and names the engine (got ${JSON.stringify(mm.heading)})`);
  expect(/\d/.test(mm.pool || ''), `the buffer pool size is the headline (got ${JSON.stringify(mm.pool)})`);
  expect(/%$/.test(mm.hit || ''), `with its hit ratio (got ${JSON.stringify(mm.hit)})`);
  expect((mm.counters || []).includes('slow queries'),
    `MySQL's own counters are used (got ${JSON.stringify(mm.counters)})`);
  // InnoDB reclaims its own dead rows, so that section should simply not appear.
  expect(!(mm.sections || []).includes('Dead rows waiting on vacuum'),
    `no vacuum section where there is no vacuum (got ${JSON.stringify(mm.sections)})`);

  console.log('\ncopying it out');

  const copied = await run('hl-copy.png', `(async () => {
    ${HELP}
    await w(2600);
    window.__cobaltMenu('server:health');
    await w(2000);
    document.querySelector('[data-hl="copy"]').click();
    await w(500);
    return { toast: (document.querySelector('.toast') || {}).textContent || '' };
  })()`);
  if (!copied.ok) fails++;
  expect(/Copied/.test(readJs(copied.out).toast || ''), 'Copy as text works');

  console.log(`\n${fails ? `${fails} failed` : 'all checks passed'}\n`);
  process.exit(fails ? 1 : 0);
})();
