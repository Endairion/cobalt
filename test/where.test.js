'use strict';
/* The hand-written filter expression: what it accepts, what it refuses, and
   that it cannot escape the wrapper. Run: node test/where.test.js */

const assert = require('assert');
const { validateWhere, andWith } = require('../src/shared/whereclause');
const { buildPagedQuery, Manager } = require('../src/main/db');

const CFG = { host: 'localhost', port: 15432, database: 'cobalt', user: 'cobalt', password: 'cobalt' };

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

(async () => {
  console.log('\naccepted');

  await test('ordinary conditions pass', () => {
    for (const expr of [
      "balance > 500",
      "email ilike '%user1%' and is_active",
      "full_name is null or balance between 10 and 20",
      "id in (1, 2, 3)",
      "signed_up > now() - interval '7 days'",
      "prefs->>'tier' = 'gold'",
      `"weird Name" = 'x'`,
      "lower(email) like 'a%'",
      "(a = 1 and b = 2) or (c = 3)",
    ]) {
      const v = validateWhere(expr);
      assert.ok(v.ok, `${expr} -> ${v.error}`);
    }
  });

  await test('an empty expression is fine and means no filter', () => {
    assert.deepStrictEqual(validateWhere(''), { ok: true, empty: true });
    assert.deepStrictEqual(validateWhere('   '), { ok: true, empty: true });
  });

  await test('quotes containing awkward characters are respected', () => {
    assert.ok(validateWhere("note = 'a; b -- c'").ok, 'a semicolon inside a string is data');
    assert.ok(validateWhere("note = 'it''s fine'").ok, 'doubled quotes escape');
    assert.ok(validateWhere(`"col;name" = 1`).ok, 'and inside a quoted identifier');
  });

  console.log('\nrefused');

  await test('a second statement cannot be smuggled in', () => {
    assert.match(validateWhere('1=1; drop table t').error, /semicolon/i);
    assert.match(validateWhere("a = 1); delete from t; --").error, /parenthes|semicolon/i);
  });

  await test('comments cannot close the wrapper early', () => {
    assert.match(validateWhere('a = 1 -- rest').error, /comment/i);
    assert.match(validateWhere('a = 1 /* rest */').error, /comment/i);
  });

  await test('parentheses must balance', () => {
    assert.match(validateWhere('(a = 1').error, /parenthes/i);
    assert.match(validateWhere('a = 1)').error, /parenthes/i);
    assert.match(validateWhere('a = 1) or (1=1').error, /parenthes/i);
  });

  await test('unclosed quotes are caught rather than swallowing the rest', () => {
    assert.match(validateWhere("a = 'oops").error, /unclosed/i);
    assert.match(validateWhere('a = "oops').error, /unclosed/i);
  });

  await test('dollar quoting is refused', () => {
    assert.match(validateWhere('a = $$x$$').error, /dollar/i);
    assert.match(validateWhere('a = $tag$x$tag$').error, /dollar/i);
  });

  console.log('\nbuilding');

  await test('the expression is wrapped in its own parentheses', () => {
    const { text } = buildPagedQuery('select * from t', { where: 'a = 1 or b = 2', limit: 10 });
    assert.match(text, /where \(a = 1 or b = 2\)/);
  });

  await test('it composes with structured filters', () => {
    const { text, values } = buildPagedQuery('select * from t', {
      filters: [{ name: 'email', op: 'ilike', value: '%x%' }],
      where: 'balance > 100',
      limit: 10,
    });
    assert.match(text, /"email"::text ilike \$1/);
    assert.match(text, /and \(balance > 100\)/);
    assert.deepStrictEqual(values, ['%x%']);
  });

  await test('a refused expression throws rather than building', () => {
    assert.throws(() => buildPagedQuery('select * from t', { where: 'a = 1; drop table t' }), /semicolon/i);
  });

  await test('andWith joins conditions', () => {
    assert.strictEqual(andWith('', 'a = 1'), 'a = 1');
    assert.strictEqual(andWith('a = 1', ''), 'a = 1');
    assert.strictEqual(andWith('a = 1', 'b = 2'), 'a = 1 and b = 2');
  });

  console.log('\nagainst a live server');

  const m = new Manager();
  const { id } = await m.open(CFG);

  await test('filters across columns without naming them all', async () => {
    const r = await m.runPaged(id, 'w1', 'select * from shop.customers', {
      limit: 500,
      where: "balance > 500 and full_name is not null and email like '%1%'",
    });
    const rows = r.results[0].rows;
    const cols = r.results[0].columns.map((c) => c.name);
    assert.ok(rows.length > 0, 'some rows matched');
    const bal = cols.indexOf('balance');
    const name = cols.indexOf('full_name');
    assert.ok(rows.every((x) => Number(x[bal]) > 500 && x[name] !== null));
  });

  await test('an expression referencing a column works whatever its position', async () => {
    // The point of the change: no need to reach the column to filter on it.
    const r = await m.runPaged(id, 'w1', 'select * from shop.customers', {
      limit: 10, where: "notes is not null",
    });
    const cols = r.results[0].columns.map((c) => c.name);
    const notes = cols.indexOf('notes');
    assert.ok(notes > 3, 'notes is well to the right');
    assert.ok(r.results[0].rows.every((x) => x[notes] !== null));
  });

  await test('a filtered result is still editable', async () => {
    const r = await m.runPaged(id, 'w1', 'select * from shop.customers',
      { limit: 10, where: 'balance > 100' });
    assert.strictEqual(r.results[0].editable, true, r.results[0].notEditableReason || '');
  });

  await test('a bad expression comes back as a query error', async () => {
    const r = await m.runPaged(id, 'w1', 'select * from shop.customers',
      { limit: 10, where: 'no_such_column = 1' });
    assert.ok(r.results[0].error);
    assert.strictEqual(r.results[0].error.code, '42703');
  });

  await test('counting honours the expression', async () => {
    const where = 'balance > 500';
    const { count } = await m.countRows(id, 'w1', 'select * from shop.customers', [], where);
    const check = await m.run(id, 'w1', 'select count(*) from shop.customers where balance > 500');
    assert.strictEqual(count, Number(check.results[0].rows[0][0]));
  });

  await test('filtering by expression writes nothing', async () => {
    const fp = async () => (await m.run(id, 'w1',
      "select md5(string_agg(c::text, '|' order by id)) from shop.customers c")).results[0].rows[0][0];
    const before = await fp();
    await m.runPaged(id, 'w1', 'select * from shop.customers', { limit: 50, where: "email like '%2%'" });
    assert.strictEqual(await fp(), before);
  });

  await m.close(id);
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
