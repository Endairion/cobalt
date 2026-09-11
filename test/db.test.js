'use strict';
/* Headless checks for the query/introspection/edit layer (no Electron needed).
   Run: node test/db.test.js  — expects the cobalt-test-pg container on :15432 */

const assert = require('assert');
const { Manager } = require('../src/main/db');
const { splitStatements } = require('../src/main/sqlsplit');

const CFG = { host: 'localhost', port: 15432, database: 'cobalt', user: 'cobalt', password: 'cobalt' };

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

(async () => {
  console.log('\nsqlsplit');
  await test('splits on semicolons outside literals', () => {
    const s = splitStatements("select 1; select ';' as x; select 2");
    assert.strictEqual(s.length, 3);
    assert.strictEqual(s[1].sql.trim(), "select ';' as x;");
  });
  await test('keeps dollar-quoted bodies intact', () => {
    const src = "create function f() returns int as $$ begin return 1; end $$ language plpgsql; select 9;";
    const s = splitStatements(src);
    assert.strictEqual(s.length, 2);
    assert.ok(s[0].sql.includes('end $$'));
  });
  await test('ignores semicolons in comments', () => {
    assert.strictEqual(splitStatements('-- a; b\nselect 1;').length, 1);
    assert.strictEqual(splitStatements('/* a; /* nested; */ b */ select 1;').length, 1);
  });
  await test('handles quoted identifiers and E-strings', () => {
    assert.strictEqual(splitStatements(`select "we;ird", E'x\\';y' from t;`).length, 1);
  });

  const m = new Manager();
  const { id } = await m.open(CFG);
  console.log('\nqueries');

  await test('runs multiple statements and reports each', async () => {
    const { results } = await m.run(id, 'tab1', 'select 1 as a; select 2 as b, 3 as c;');
    assert.strictEqual(results.length, 2);
    assert.deepStrictEqual(results[0].rows, [[1]]);   // int4 stays a JS number; wide types come back as text
    assert.strictEqual(results[1].columns.length, 2);
  });

  await test('stops at the first error and reports position', async () => {
    const { results } = await m.run(id, 'tab1', 'select 1; select * from nope_missing; select 3;');
    assert.strictEqual(results.length, 2);
    assert.ok(results[1].error, 'second statement should carry an error');
    assert.strictEqual(results[1].error.code, '42P01');
    assert.ok(results[1].error.position > 0);
  });

  await test('DDL/DML statements report command and rowCount', async () => {
    const { results } = await m.run(id, 'tab1', "update shop.orders set status = status where id = 1;");
    assert.strictEqual(results[0].command, 'UPDATE');
    assert.strictEqual(results[0].rowCount, 1);
  });

  await test('numeric and timestamp values arrive as exact text', async () => {
    const { results } = await m.run(id, 'tab1',
      "select 1234567890123456789::bigint as big, 9.99::numeric(12,2) as money, '2024-03-01 10:11:12+00'::timestamptz as ts");
    const [big, money] = results[0].rows[0];
    assert.strictEqual(big, '1234567890123456789');
    assert.strictEqual(money, '9.99');
  });

  await test('caps rows at maxRows and flags truncation', async () => {
    const { results } = await m.run(id, 'tab1', 'select * from shop.orders', { maxRows: 100 });
    assert.strictEqual(results[0].rows.length, 100);
    assert.strictEqual(results[0].truncated, true);
  });

  console.log('\neditability detection');

  await test('plain table select with PK is editable', async () => {
    const { results } = await m.run(id, 'tab1', 'select * from shop.customers limit 5');
    const r = results[0];
    assert.strictEqual(r.editable, true, r.notEditableReason || '');
    assert.strictEqual(r.source.table, 'customers');
    assert.deepStrictEqual(r.key, [0]);
    assert.strictEqual(r.columns[1].dataType, 'text');
  });

  await test('select with no key column at all is not editable', async () => {
    const { results } = await m.run(id, 'tab1', 'select full_name, balance from shop.customers limit 5');
    assert.strictEqual(results[0].editable, false);
    assert.match(results[0].notEditableReason, /key/i);
  });

  await test('unique key stands in for a missing PK', async () => {
    const { results } = await m.run(id, 'tab1', 'select email, balance from shop.customers limit 5');
    assert.strictEqual(results[0].editable, true, results[0].notEditableReason || '');
    assert.deepStrictEqual(results[0].key, [0]);
  });

  await test('joins are not editable', async () => {
    const { results } = await m.run(id, 'tab1',
      'select c.id, o.id from shop.customers c join shop.orders o on o.customer_id = c.id limit 5');
    assert.strictEqual(results[0].editable, false);
    assert.match(results[0].notEditableReason, /more than one table/i);
  });

  await test('views are not editable', async () => {
    const { results } = await m.run(id, 'tab1', 'select * from shop.order_totals limit 5');
    assert.strictEqual(results[0].editable, false);
    assert.match(results[0].notEditableReason, /view/i);
  });

  await test('keyless table is not editable', async () => {
    const { results } = await m.run(id, 'tab1', 'select * from shop.audit_log limit 5');
    assert.strictEqual(results[0].editable, false);
  });

  await test('expressions get no source column but rows still return', async () => {
    const { results } = await m.run(id, 'tab1', 'select id, upper(email) as e from shop.customers limit 3');
    assert.strictEqual(results[0].rows.length, 3);
    assert.strictEqual(results[0].columns[1].sourceColumn, null);
  });

  console.log('\ngrid commits');

  await test('update / insert / delete apply in one transaction', async () => {
    const { results } = await m.run(id, 'tab1',
      "select * from shop.customers where email = 'user1@example.com'");
    const r = results[0];
    const col = (name) => r.columns.findIndex((c) => c.name === name);
    const keyValues = r.key.map((k) => r.rows[0][k]);

    const applied = await m.applyChanges(id, {
      source: r.source, columns: r.columns, key: r.key,
      updates: [{ keyValues, set: { [col('full_name')]: 'Renamed Person', [col('balance')]: '42.50' } }],
      inserts: [{ values: { [col('email')]: 'inserted@example.com', [col('full_name')]: null } }],
      deletes: [],
    });
    assert.strictEqual(applied.updated, 1);
    assert.strictEqual(applied.inserted, 1);

    const check = await m.run(id, 'tab1',
      "select full_name, balance from shop.customers where email = 'user1@example.com'");
    assert.strictEqual(check.results[0].rows[0][0], 'Renamed Person');
    assert.strictEqual(check.results[0].rows[0][1], '42.50');

    const ins = await m.run(id, 'tab1', "select id from shop.customers where email = 'inserted@example.com'");
    assert.strictEqual(ins.results[0].rows.length, 1);

    const del = await m.applyChanges(id, {
      source: r.source, columns: r.columns, key: r.key,
      deletes: [{ keyValues: [ins.results[0].rows[0][0]] }],
    });
    assert.strictEqual(del.deleted, 1);
  });

  await test('setting a value to NULL works', async () => {
    const { results } = await m.run(id, 'tab1', "select * from shop.customers where email = 'user2@example.com'");
    const r = results[0];
    const notesIdx = r.columns.findIndex((c) => c.name === 'notes');
    await m.applyChanges(id, {
      source: r.source, columns: r.columns, key: r.key,
      updates: [{ keyValues: r.key.map((k) => r.rows[0][k]), set: { [notesIdx]: null } }],
    });
    const after = await m.run(id, 'tab1', "select notes from shop.customers where email = 'user2@example.com'");
    assert.strictEqual(after.results[0].rows[0][0], null);
  });

  await test('a failing batch rolls everything back', async () => {
    const { results } = await m.run(id, 'tab1', 'select * from shop.customers order by id limit 2');
    const r = results[0];
    const nameIdx = r.columns.findIndex((c) => c.name === 'full_name');
    const emailIdx = r.columns.findIndex((c) => c.name === 'email');
    const before = r.rows[0][nameIdx];
    let threw = false;
    try {
      await m.applyChanges(id, {
        source: r.source, columns: r.columns, key: r.key,
        updates: [
          { keyValues: [r.rows[0][0]], set: { [nameIdx]: 'Should Not Stick' } },
          // duplicate email violates the unique constraint -> whole batch rolls back
          { keyValues: [r.rows[1][0]], set: { [emailIdx]: r.rows[0][emailIdx] } },
        ],
      });
    } catch (e) { threw = true; assert.strictEqual(e.pgError.code, '23505'); }
    assert.ok(threw, 'expected the batch to fail');
    const after = await m.run(id, 'tab1', `select full_name from shop.customers where id = ${r.rows[0][0]}`);
    assert.strictEqual(after.results[0].rows[0][0], before);
  });

  await test('identifiers with quotes/dots are escaped, not interpolated', async () => {
    await m.run(id, 'tab1', 'create table if not exists "we ird.name" ("id" int primary key, "va""lue" text)');
    await m.run(id, 'tab1', 'truncate table "we ird.name"');
    const { results } = await m.run(id, 'tab1', 'select * from "we ird.name"');
    const r = results[0];
    assert.strictEqual(r.editable, true, r.notEditableReason || '');
    await m.applyChanges(id, {
      source: r.source, columns: r.columns, key: r.key,
      inserts: [{ values: { 0: '1', 1: 'ok' } }],
    });
    const back = await m.run(id, 'tab1', 'select * from "we ird.name"');
    assert.deepStrictEqual(back.results[0].rows, [[1, 'ok']]);
    await m.run(id, 'tab1', 'drop table "we ird.name"');
  });

  console.log('\nsessions & introspection');

  await test('each tab gets its own backend session', async () => {
    await m.run(id, 'tabA', 'create temp table t_a (x int); insert into t_a values (1);');
    const a = await m.run(id, 'tabA', 'select count(*) from t_a');
    assert.strictEqual(a.results[0].rows[0][0], '1');
    const b = await m.run(id, 'tabB', 'select count(*) from t_a');
    assert.ok(b.results[0].error, 'other tab should not see the temp table');
  });

  await test('cancel stops a long-running query', async () => {
    const started = Date.now();
    const run = m.run(id, 'tabSlow', 'select pg_sleep(30)');
    await new Promise((r) => setTimeout(r, 600));
    await m.cancel(id, 'tabSlow');
    const { results } = await run;
    assert.ok(results[0].error, 'expected a cancellation error');
    assert.strictEqual(results[0].error.code, '57014');
    assert.ok(Date.now() - started < 10000, 'should return promptly');
  });

  await test('schema tree lists relations, columns and PK flags', async () => {
    const tree = await m.schemaTree(id);
    const shop = tree.schemas.find((s) => s.name === 'shop');
    assert.ok(shop, 'shop schema present');
    const customers = shop.relations.find((r) => r.name === 'customers');
    assert.strictEqual(customers.kind, 'r');
    assert.ok(customers.columns.find((c) => c.name === 'id').isPk);
    assert.ok(shop.relations.find((r) => r.name === 'order_totals').kind === 'v');
    assert.ok(!tree.schemas.some((s) => s.name === 'pg_catalog'), 'system schemas hidden');
  });

  await test('DDL round-trips for a table and a view', async () => {
    const ddl = await m.tableDdl(id, 'shop', 'customers');
    assert.match(ddl, /CREATE TABLE shop\.customers/);
    assert.match(ddl, /^ {2}email text NOT NULL,$/m);
    assert.match(ddl, /PRIMARY KEY/);
    // constraint-backed indexes must not be repeated as CREATE INDEX
    assert.ok(!/CREATE UNIQUE INDEX customers_pkey/.test(ddl), 'pkey index should not be duplicated');
    const vdef = await m.tableDdl(id, 'shop', 'order_totals');
    assert.match(vdef, /CREATE OR REPLACE VIEW/);
  });

  await m.close(id);
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
