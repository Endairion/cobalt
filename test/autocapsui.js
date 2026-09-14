'use strict';
/* Keywords capitalize themselves as you finish typing them — and leave alone
   the things that only look like keywords: strings, comments, quoted names,
   and the half of a qualified name after the dot.
   Run: node test/autocapsui.js   (needs cobalt-test-pg on :15432) */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

const outDir = path.join(__dirname, '..', 'shots');
fs.mkdirSync(outDir, { recursive: true });

const seed = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-caps-'));
  fs.writeFileSync(path.join(dir, 'cobalt-connections.json'), JSON.stringify({
    connections: [{
      id: 's1', name: 'Test DB', host: 'localhost', port: 15432, database: 'cobalt',
      user: 'cobalt', ssl: 'disable', order: 0, password: { plain: 'cobalt' },
    }],
    workspace: { tabs: [{ title: 'q', sql: '', savedId: 's1' }], activeIndex: 0, pageSize: 200 },
    seenVersion: require('../package.json').version,
  }, null, 2));
  return dir;
};

const run = (file, js, extra = []) => new Promise((resolve) => {
  const profile = seed();
  const target = path.join(outDir, file);
  const args = ['.', `--smoke=${target}`, `--user-data-dir=${profile}`, ...extra];
  if (js) args.push(`--smoke-js=${js}`);
  const p = spawn(electron, args, { cwd: path.join(__dirname, '..') });
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

// Each of these is typed one character at a time, and the whole document is
// read back afterwards.
const CASES = [
  ['select a, b from t where x = 1 and y = 2;',
   'SELECT a, b FROM t WHERE x = 1 AND y = 2;',
   'a plain statement'],

  ['select * from orders.order;',
   'SELECT * FROM orders.order;',
   'the half of a qualified name after the dot is a column, not ORDER'],

  ["select 'select me' from t;",
   "SELECT 'select me' FROM t;",
   'a keyword inside a string is someone’s data'],

  ['select a -- from here on is a note about select\n',
   'SELECT a -- from here on is a note about select\n',
   'and a keyword inside a comment is a note'],

  ['select "order" from t;',
   'SELECT "order" FROM t;',
   'a quoted identifier keeps the case it was given'],

  ['explain analyze select count(*) from t;',
   'EXPLAIN ANALYZE SELECT count(*) FROM t;',
   'EXPLAIN and ANALYZE too, and count() is a function, not a keyword'],

  ['insert into t (a) values (1) on conflict do nothing;',
   'INSERT INTO t (a) VALUES (1) ON CONFLICT DO NOTHING;',
   'multi-word clauses, one word at a time'],
];

(async () => {
  console.log('\ntyping, one character at a time');

  const typed = await run('caps-typed.png', `(async () => {
    const w = (ms) => new Promise(r => setTimeout(r, ms));
    await w(1200);
    const cases = ${JSON.stringify(CASES.map((c) => c[0]))};
    const out = [];
    for (const text of cases) {
      window.__cobaltSetSql('');
      await w(60);
      window.__cobaltTypeSql(text);
      await w(60);
      out.push(window.__cobaltGetSql());
    }
    return { out };
  })()`);
  if (!typed.ok) fails++;
  const got = readJs(typed.out).out || [];
  CASES.forEach(([, want, label], i) => {
    expect(got[i] === want, `${label}\n       want ${JSON.stringify(want)}\n       got  ${JSON.stringify(got[i])}`);
  });

  console.log('\nnothing happens until the word is finished');

  const midWord = await run('caps-midword.png', `(async () => {
    const w = (ms) => new Promise(r => setTimeout(r, ms));
    await w(1200);
    window.__cobaltSetSql('');
    await w(60);
    window.__cobaltTypeSql('sele');
    await w(60);
    const partial = window.__cobaltGetSql();
    window.__cobaltTypeSql('ct');
    await w(60);
    const whole = window.__cobaltGetSql();
    window.__cobaltTypeSql(' ');
    await w(60);
    return { partial, whole, done: window.__cobaltGetSql() };
  })()`);
  if (!midWord.ok) fails++;
  const m = readJs(midWord.out);
  expect(m.partial === 'sele', `a prefix is left alone (got ${JSON.stringify(m.partial)})`);
  expect(m.whole === 'select', `so is the finished word, until it is delimited (got ${JSON.stringify(m.whole)})`);
  expect(m.done === 'SELECT ', `the space is what does it (got ${JSON.stringify(m.done)})`);

  console.log('\nwith real keystrokes, not dispatched changes');

  const real = await run('caps-real.png', `(async () => {
    const w = (ms) => new Promise(r => setTimeout(r, ms));
    await w(300);
    return { sql: window.__cobaltGetSql() };
  })()`, ['--smoke-type=select a from t where x = 1 and y = 2']);
  if (!real.ok) fails++;
  const r = readJs(real.out);
  expect(r.sql === 'SELECT a FROM t WHERE x = 1 AND y = 2',
    `typed into the window for real (got ${JSON.stringify(r.sql)})`);

  console.log('\nand undo leaves no capitals behind');

  // The capital rides in the same transaction as the keystroke that triggered
  // it, so it is part of the same undo step. CodeMirror groups a burst of
  // typing into one of those, which is why undoing the lot gives back an empty
  // document rather than a lowercase one: what would fail here is an extension
  // that capitalized in a transaction of its own outside the history, leaving
  // SELECT sitting there after everything that typed it had been undone.
  const undo = await run('caps-undo.png', `(async () => {
    const w = (ms) => new Promise(r => setTimeout(r, ms));
    await w(300);
    return { after: window.__cobaltGetSql() };
  })()`, ['--smoke-type=select a from t where x = ', '--smoke-keys=control+Z']);
  if (!undo.ok) fails++;
  const u = readJs(undo.out);
  expect(u.after === '', `undo took the whole burst, capitals included (got ${JSON.stringify(u.after)})`);

  console.log(`\n${fails ? `${fails} failed` : 'all checks passed'}\n`);
  process.exit(fails ? 1 : 0);
})();
