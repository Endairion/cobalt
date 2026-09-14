'use strict';
/* Connecting to a database that has nothing in it.
 *
 * This is easy to do by accident — `postgres` is the connection dialog's
 * default and exists on every server — and a green dot beside a blank sidebar
 * is a confusing way to find out. Run: node test/emptydbui.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');
const { Client } = require('pg');

const outDir = path.join(__dirname, '..', 'shots');
fs.mkdirSync(outDir, { recursive: true });

let fails = 0;
const expect = (cond, label) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) fails++;
};
const readJs = (out) => JSON.parse((/\[smoke\] js (.*)/.exec(out) || [])[1] || '{}');

/** Points at `postgres`, exactly as leaving the dialog's default would. */
const seed = (database) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-empty-'));
  fs.writeFileSync(path.join(dir, 'cobalt-connections.json'), JSON.stringify({
    connections: [{
      id: 's1', name: 'Fixture', engine: 'postgres', host: 'localhost', port: 15432,
      database, user: 'cobalt', ssl: 'disable', order: 0, password: { plain: 'cobalt' },
    }],
    workspace: {
      tabs: [{ title: 'Query 1', sql: 'select 1;', savedId: 's1' }],
      activeIndex: 0, pageSize: 200, openConnections: ['s1'], activeSavedId: 's1',
    },
    seenVersion: require('../package.json').version,
  }, null, 2));
  return dir;
};

const run = (file, js, database) => new Promise((resolve) => {
  const profile = seed(database);
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
    if (bad) console.log(buf.slice(0, 2500));
    resolve({ ok: code === 0 && !bad, out: buf, saved });
  });
  setTimeout(() => p.kill(), 90000);
});

const HELP = `
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const text = (sel) => (document.querySelector(sel) || {}).textContent || '';
  const chips = () => [...document.querySelectorAll('.db-switch')].map(b => b.textContent.trim());
`;

(async () => {
  console.log('\nan empty database says so');

  const empty = await run('empty-postgres.png', `(async () => {
    ${HELP}
    await w(3000);
    return {
      head: text('.db-empty-head'),
      sub: text('.db-empty-sub'),
      chips: chips(),
      tables: document.querySelectorAll('.tree-row.rel').length,
      live: document.querySelectorAll('.tree-row.conn.live').length
    };
  })()`, 'postgres');
  if (!empty.ok) fails++;
  const e = readJs(empty.out);
  expect(e.live === 1, 'the connection is up — this is not a failure to connect');
  expect(e.tables === 0, 'and there really are no tables');
  expect(/No tables in/.test(e.head || '') && /postgres/.test(e.head || ''),
    `it says which database is empty (got ${JSON.stringify(e.head)})`);
  expect(/also has/.test(e.sub || ''), `and that the server has others (got ${JSON.stringify(e.sub)})`);
  expect((e.chips || []).includes('cobalt'),
    `listing them by name (got ${JSON.stringify(e.chips)})`);
  expect(!(e.chips || []).includes('postgres'),
    'without offering the one you are already in');

  console.log('\nand one click moves you to a real one');

  const switched = await run('empty-switch.png', `(async () => {
    ${HELP}
    await w(3000);
    [...document.querySelectorAll('.db-switch')].find(b => b.textContent.trim() === 'cobalt').click();
    // Toasts fade, so catch them as they appear rather than reading once at the end.
    // Toasts stack, so read all of them — querySelector only ever returns the
    // oldest, which here is "Connected to…" and never the one under test.
    const seen = [];
    const watch = setInterval(() => {
      for (const n of document.querySelectorAll('.toast')) {
        const t = n.textContent.trim();
        if (t && !seen.includes(t)) seen.push(t);
      }
    }, 150);
    await w(4000);
    clearInterval(watch);
    return {
      toasts: seen,
      tables: [...document.querySelectorAll('.tree-row.rel .name')].map(n => n.textContent),
      db: text('.tree-row.conn.live .meta'),
      stillEmpty: !!document.querySelector('.db-empty'),
      toast: text('.toast')
    };
  })()`, 'postgres');
  if (!switched.ok) fails++;
  const sw = readJs(switched.out);
  expect((sw.tables || []).includes('customers'),
    `the tables appear (got ${JSON.stringify(sw.tables)})`);
  expect(sw.stillEmpty === false, 'and the hint goes away');
  expect(/cobalt/.test(sw.db || ''), `the sidebar shows the new database (got ${JSON.stringify(sw.db)})`);
  expect((sw.toasts || []).some((t) => /now opens cobalt/.test(t)),
    `and it says what it did (saw ${JSON.stringify(sw.toasts)})`);

  // Having to choose it again on every launch would be the annoying half.
  expect(sw.stillEmpty === false, 'the choice took effect');
  const saved = (switched.saved && switched.saved.connections || [])[0];
  expect(saved && saved.database === 'cobalt',
    `and is remembered for next time (saved database is ${JSON.stringify(saved && saved.database)})`);
  expect(saved && saved.password && (saved.password.enc || saved.password.plain),
    'without losing the stored password');

  console.log('\na database with tables is untouched by any of this');

  const normal = await run('empty-normal.png', `(async () => {
    ${HELP}
    await w(3000);
    return {
      hint: !!document.querySelector('.db-empty'),
      tables: document.querySelectorAll('.tree-row.rel').length
    };
  })()`, 'cobalt');
  if (!normal.ok) fails++;
  const n = readJs(normal.out);
  expect(n.hint === false, 'no hint where there is nothing to hint about');
  expect(n.tables >= 5, `and the tables are listed as usual (got ${n.tables})`);

  // Nothing above should have changed the fixture.
  const c = new Client({ host: 'localhost', port: 15432, database: 'cobalt', user: 'cobalt', password: 'cobalt' });
  await c.connect();
  const r = await c.query("select count(*)::text as n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace where ns.nspname='shop' and c.relkind='r'");
  await c.end();
  expect(Number(r.rows[0].n) >= 4, `the fixture is intact (${r.rows[0].n} base tables in shop)`);

  console.log(`\n${fails ? `${fails} failed` : 'all checks passed'}\n`);
  process.exit(fails ? 1 : 0);
})();
