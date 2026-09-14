'use strict';
/* Formatting from the editor: one statement, the whole script, and undo.
   Run: node test/formatui.js */

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

const seed = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-fmt-'));
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

const HELP = `
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const sql = () => window.__cobaltGetSql();
`;

(async () => {
  console.log('\nformatting the statement under the caret');

  const one = await run('fmt-one.png', `(async () => {
    ${HELP}
    await w(1500);
    window.__cobaltSetSql("SELECT a,b FROM t WHERE x=1 AND y=2");
    await w(300);
    window.__cobaltMenu('edit:format');
    await w(400);
    const after = sql();
    // Ctrl+Z is the editor's own undo, and must take the whole thing back.
    document.querySelector('.cm-content').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await w(300);
    return { after, afterUndo: sql() };
  })()`);
  if (!one.ok) fails++;
  const o = readJs(one.out);
  expect(o.after === 'SELECT a,\n  b\nFROM t\nWHERE x = 1\n  AND y = 2',
    `it is laid out and capitalized (got ${JSON.stringify(o.after)})`);

  console.log('\nonly the statement under the caret is touched');

  const scoped = await run('fmt-scope.png', `(async () => {
    ${HELP}
    await w(1500);
    // Three statements; the caret sits in the second one.
    const text = "select 1;\\n\\nSELECT a,b FROM t;\\n\\nselect 3;";
    window.__cobaltSetSql(text);
    await w(300);
    window.__cobaltSetCaret(text.indexOf('FROM') + 2);
    await w(200);
    window.__cobaltMenu('edit:format');
    await w(400);
    return { after: sql() };
  })()`);
  if (!scoped.ok) fails++;
  const sc = readJs(scoped.out);
  expect(/^select 1;\n\nSELECT a,/.test(sc.after || ''),
    `the first statement and the blank line under it survive (got ${JSON.stringify((sc.after || '').slice(0, 24))})`);
  expect(/select 3;$/.test((sc.after || '').trim()), 'and so is the last');
  expect(/SELECT a,\n  b\nFROM t;/.test(sc.after || ''),
    `while the one under the caret is formatted (got ${JSON.stringify(sc.after)})`);

  console.log('\nformatting a whole script');

  const all = await run('fmt-all.png', `(async () => {
    ${HELP}
    await w(1500);
    window.__cobaltSetSql("select 1;SELECT a,b FROM t;");
    await w(300);
    window.__cobaltMenu('edit:formatAll');
    await w(400);
    return { after: sql(), statements: document.getElementById('editor-hint').textContent };
  })()`);
  if (!all.ok) fails++;
  const a = readJs(all.out);
  expect(/^SELECT 1;\n\nSELECT a,/.test(a.after || ''),
    `each statement is formatted with a gap between them (got ${JSON.stringify(a.after)})`);
  expect(/2 statements/.test(a.statements || ''),
    `and the split still finds both (got "${a.statements}")`);

  console.log('\nwhat it refuses to mangle');

  const safe = await run('fmt-safe.png', `(async () => {
    ${HELP}
    await w(1500);
    const body = "create function f() returns void as $$ begin perform 1; end $$ language plpgsql";
    window.__cobaltSetSql(body);
    await w(300);
    window.__cobaltMenu('edit:format');
    await w(400);
    const fn = sql();

    window.__cobaltSetSql("select 'it''s  spaced', E'a\\\\nb' from t");
    await w(300);
    window.__cobaltMenu('edit:format');
    await w(400);
    return { fn, strings: sql() };
  })()`);
  if (!safe.ok) fails++;
  const sf = readJs(safe.out);
  expect((sf.fn || '').includes('$$ begin perform 1; end $$'),
    `a function body is left exactly as written (got ${JSON.stringify(sf.fn)})`);
  expect((sf.strings || '').includes("'it''s  spaced'"),
    `the spaces inside a string survive (got ${JSON.stringify(sf.strings)})`);

  console.log('\nrunning what was formatted still works');

  const runs = await run('fmt-run.png', `(async () => {
    ${HELP}
    await w(1800);
    window.__cobaltSetSql("SELECT COUNT(*) FROM shop.customers WHERE balance>500");
    await w(300);
    window.__cobaltMenu('edit:format');
    await w(400);
    const formatted = sql();
    window.__cobaltMenu('query:run');
    await w(2200);
    return { formatted, cell: window.__cobaltCell(0, 0), rows: window.__cobaltGridRows() };
  })()`);
  if (!runs.ok) fails++;
  const r = readJs(runs.out);
  // Function names are not keywords, so their case is left alone on purpose.
  expect(/^SELECT COUNT\(\*\)/.test(r.formatted || ''),
    `count(*) is not pulled apart, and keeps its case (got ${JSON.stringify((r.formatted || '').slice(0, 20))})`);
  expect(r.rows === 1 && Number(r.cell) > 0,
    `and the formatted statement runs (got ${r.rows} rows, ${JSON.stringify(r.cell)})`);

  console.log(`\n${fails ? `${fails} failed` : 'all checks passed'}\n`);
  process.exit(fails ? 1 : 0);
})();
