'use strict';
/* The SQL formatter. Run: node test/sqlformat.test.js */

const assert = require('assert');
const { format, formatScript, tokenize, significant } = require('../src/shared/sqlformat.js');

let n = 0;
const check = (label, fn) => {
  try { fn(); n++; console.log(`  ok   ${label}`); }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); process.exitCode = 1; }
};

/**
 * The property that actually matters: formatting moves whitespace and changes
 * keyword case, and does nothing else. Everything below is decoration; this is
 * the guarantee.
 */
const sameMeaning = (input) => {
  const before = significant(tokenize(input));
  const after = significant(tokenize(format(input)));
  assert.strictEqual(after.length, before.length,
    `token count changed: ${before.length} -> ${after.length}\n${format(input)}`);
  before.forEach((t, i) => {
    const b = after[i];
    assert.strictEqual(b.kind, t.kind, `token ${i} kind changed: ${t.kind} -> ${b.kind}`);
    const expected = t.kind === 'word' ? t.text.toLowerCase() : t.text;
    const got = b.kind === 'word' ? b.text.toLowerCase() : b.text;
    assert.strictEqual(got, expected, `token ${i} changed: ${JSON.stringify(t.text)} -> ${JSON.stringify(b.text)}`);
  });
};

console.log('\ntokenizing');

check('strings keep their doubled quotes', () => {
  const t = significant(tokenize("select 'it''s fine'"));
  assert.strictEqual(t[1].kind, 'string');
  assert.strictEqual(t[1].text, "'it''s fine'");
});

check('an E-string takes backslash escapes', () => {
  const t = significant(tokenize("select E'a\\'b' from t"));
  assert.strictEqual(t[1].text, "E'a\\'b'");
});

check('dollar quoting swallows everything up to its tag', () => {
  const t = significant(tokenize("create function f() returns void as $body$ select 'x'; $body$ language sql"));
  const d = t.find((x) => x.kind === 'dollar');
  assert.ok(d, 'expected a dollar-quoted token');
  assert.ok(d.text.includes("select 'x';"), d.text);
});

check('a placeholder is not dollar quoting', () => {
  const t = significant(tokenize('select * from t where id = $1'));
  assert.ok(!t.some((x) => x.kind === 'dollar'), 'a lone $1 must stay a placeholder');
});

check('quoted identifiers survive in both dialects', () => {
  assert.strictEqual(significant(tokenize('select "odd name" from t'))[1].text, '"odd name"');
  assert.strictEqual(significant(tokenize('select `odd name` from t'))[1].text, '`odd name`');
});

check('two-character operators are one token', () => {
  const t = significant(tokenize('select a <= b, c::text, d->>e'));
  assert.ok(t.some((x) => x.text === '<='), 'expected <=');
  assert.ok(t.some((x) => x.text === '::'), 'expected ::');
});

check('nested block comments close in the right place', () => {
  const t = significant(tokenize('select 1 /* a /* b */ c */ , 2'));
  const c = t.find((x) => x.kind === 'blockComment');
  assert.strictEqual(c.text, '/* a /* b */ c */');
});

console.log('\nlayout');

// The house style: a clause keeps its first item on the keyword's line, and
// anything after that is indented under it.
check('each clause starts a line, with its continuation indented', () => {
  assert.strictEqual(
    format('select a, b from t where x = 1'),
    'select a,\n  b\nfrom t\nwhere x = 1');
});

check('AND and OR line up under the condition', () => {
  const out = format('select a from t where x = 1 and y = 2 or z = 3');
  assert.ok(/\n  and y = 2\n  or z = 3/.test(out), out);
});

check('a join and its ON each get a line', () => {
  const out = format('select a from t left join u on u.id = t.id');
  assert.ok(/\nleft join u\n  on u\.id = t\.id/.test(out), out);
});

check('left( is a function call, not a join', () => {
  const out = format("select left(name, 3) from t");
  assert.ok(!/\nleft/.test(out), out);
});

check('qualified names and casts do not get spaces', () => {
  const out = format('select t . a :: text from s . t');
  assert.ok(out.includes('t.a::text'), out);
  assert.ok(out.includes('s.t'), out);
});

check('a short parenthesised list stays on one line', () => {
  const out = format('select * from t where id in (1, 2, 3)');
  assert.ok(out.includes('id in (1, 2, 3)'), out);
});

check('a long list is broken up', () => {
  const long = Array.from({ length: 30 }, (_, i) => `'value-${i}'`).join(', ');
  const out = format(`select * from t where x in (${long})`);
  assert.ok(out.split('\n').length > 10, `expected it to wrap:\n${out}`);
});

check('keywords are lowercased, identifiers are not', () => {
  const out = format('SELECT UserName FROM Accounts WHERE Id = 1');
  assert.ok(out.includes('select'), out);
  assert.ok(out.includes('UserName'), 'the column name must keep its case');
  assert.ok(out.includes('Accounts'), 'the table name must keep its case');
});

check('upper case is available for people who like it', () => {
  const out = format('select a from t', { keywordCase: 'upper' });
  assert.ok(out.startsWith('SELECT'), out);
});

check('a quoted identifier is never re-cased', () => {
  const out = format('select "MixedCase" from t', { keywordCase: 'upper' });
  assert.ok(out.includes('"MixedCase"'), out);
});

check('insert and values read as a statement', () => {
  const out = format("insert into t (a, b) values (1, 'x')");
  assert.ok(/^insert into/.test(out), out);
  assert.ok(/\nvalues/.test(out), out);
});

check('group by and order by are treated as one clause each', () => {
  const out = format('select a, count(*) from t group by a order by a desc');
  assert.ok(/\ngroup by a/.test(out), out);
  assert.ok(/\norder by a desc/.test(out), out);
  assert.ok(out.includes('count(*)'), 'nothing is separated from the paren it opens');
});

console.log('\ncomments stay where they were');

check('a trailing comment stays on its line', () => {
  const out = format('select a, -- the important one\n b from t');
  assert.ok(/a, -- the important one/.test(out), out);
});

check('a comment on its own line keeps its own line', () => {
  const out = format('-- header\nselect a from t');
  assert.ok(out.startsWith('-- header\n'), out);
});

console.log('\nnothing is ever changed but the whitespace');

const CORPUS = [
  'select 1',
  'select a, b from t where x = 1 and y = 2',
  "select * from t where name = 'O''Brien'",
  "select * from t where note = E'line\\nbreak'",
  'select "Odd Name", `other` from s.t',
  'select * from t where id in (1,2,3) order by id desc limit 10 offset 5',
  'insert into t (a,b) values (1,2), (3,4) on conflict do nothing',
  'update t set a = 1, b = 2 where id = $1 returning *',
  'delete from t where id = any($1::int[])',
  'with recursive x as (select 1 union all select n+1 from x where n < 10) select * from x',
  'select a from t left join u on u.id = t.id inner join v on v.id = u.id',
  "create function f() returns void as $$ begin perform 1; end $$ language plpgsql",
  'select case when a then 1 else 2 end from t',
  'select count(*) filter (where x) over (partition by y order by z) from t',
  'select /* keep */ a -- and this\nfrom t',
  'select a::text, b::numeric(12,2) from t',
  'select * from t where j @> \'{"a":1}\'::jsonb',
  'select 1.5e-9, .25, 100',
  'SELECT DISTINCT ON (a) a, b FROM t ORDER BY a, b DESC',
];

for (const sql of CORPUS) {
  check(`round trip: ${sql.slice(0, 46)}${sql.length > 46 ? '…' : ''}`, () => sameMeaning(sql));
}

check('formatting is stable — running it twice changes nothing', () => {
  for (const sql of CORPUS) {
    const once = format(sql);
    assert.strictEqual(format(once), once, `unstable for: ${sql}\n--- once ---\n${once}\n--- twice ---\n${format(once)}`);
  }
});

console.log('\nscripts');

check('every statement is formatted, with a gap between them', () => {
  const out = formatScript('select a from t; select b from u;');
  assert.ok(/;\n\nselect/.test(out), out);
});

check('a function body is not split on its inner semicolons', () => {
  const out = formatScript("create function f() returns void as $$ select 1; select 2; $$ language sql;");
  assert.strictEqual((out.match(/create function/g) || []).length, 1, out);
});

check('empty input comes back empty rather than throwing', () => {
  assert.strictEqual(format(''), '');
  assert.strictEqual(format('   '), '');
  assert.strictEqual(formatScript(''), '');
});

check('a comment-only statement survives', () => {
  assert.strictEqual(format('-- nothing here'), '-- nothing here');
});

console.log(`\n${process.exitCode ? 'failures above' : `all ${n} checks passed`}\n`);
