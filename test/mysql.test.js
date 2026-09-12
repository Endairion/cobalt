'use strict';
/* The MySQL driver, against a real server. Run: node test/mysql.test.js
   Needs: docker run -d --name cobalt-test-mysql -e MYSQL_ROOT_PASSWORD=cobalt \
            -e MYSQL_DATABASE=cobalt -e MYSQL_USER=cobalt -e MYSQL_PASSWORD=cobalt \
            -p 13306:3306 mysql:8
          docker exec -i cobalt-test-mysql mysql -ucobalt -pcobalt cobalt < test/seed-mysql.sql */

const assert = require('assert');
const { Manager } = require('../src/main/db.js');

const CFG = {
  id: 'my', name: 'MySQL fixture', engine: 'mysql',
  host: '127.0.0.1', port: 13306, database: 'cobalt', user: 'cobalt', password: 'cobalt', ssl: 'disable',
};

let n = 0;
const check = async (label, fn) => {
  try { await fn(); n++; console.log(`  ok   ${label}`); }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); process.exitCode = 1; }
};

(async () => {
  const m = new Manager();
  const info = await m.open(CFG);
  const id = info.id;

  console.log('\nconnecting');

  await check('it reports the server and database', () => {
    assert.ok(/^\d+\.\d+/.test(info.serverVersion), `got ${info.serverVersion}`);
    assert.strictEqual(info.database, 'cobalt');
  });

  await check('the engine is remembered on the connection', () => {
    assert.strictEqual(m.get(id).driver.id, 'mysql');
  });

  console.log('\nvalues arrive as text, undamaged');

  await check('a bigint keeps every digit', async () => {
    const { results } = await m.run(id, 't1', 'select 9223372036854775807 as big');
    assert.strictEqual(results[0].rows[0][0], '9223372036854775807');
  });

  await check('a decimal keeps its scale', async () => {
    const { results } = await m.run(id, 't1', 'select cast(1.10 as decimal(10,2)) as d');
    assert.strictEqual(results[0].rows[0][0], '1.10');
  });

  // The trap that catches every client that lets its driver parse JSON.
  await check('a 20-digit integer inside a JSON column survives', async () => {
    const { results } = await m.run(id, 't1', "select payload from docs where label = 'precision'");
    assert.ok(String(results[0].rows[0][0]).includes('12345678901234567890'),
      `got ${results[0].rows[0][0]}`);
  });

  await check('a timestamp is text, not a JS Date', async () => {
    const { results } = await m.run(id, 't1', 'select signed_up from customers order by id limit 1');
    assert.strictEqual(typeof results[0].rows[0][0], 'string');
    assert.ok(/^\d{4}-\d{2}-\d{2} /.test(results[0].rows[0][0]), results[0].rows[0][0]);
  });

  // A TEXT and a BLOB column are the same protocol type; only the charset differs.
  await check('binary comes back as hex, and text next to it does not', async () => {
    const { results } = await m.run(id, 't1',
      "select blob_col, body from docs where label = 'precision'");
    const [blob, body] = results[0].rows[0];
    assert.strictEqual(blob, '\\x48656c6c6f2c20776f726c6421000102');
    assert.ok(body.startsWith('The quick brown fox'), `text was mangled: ${body.slice(0, 40)}`);
  });

  await check('NULL stays null', async () => {
    const { results } = await m.run(id, 't1', "select payload, blob_col from docs where label = 'empty bits'");
    assert.deepStrictEqual(results[0].rows[0], [null, null]);
  });

  console.log('\nresults and editability');

  await check('a plain select is editable through its primary key', async () => {
    const { results } = await m.run(id, 't1', 'select id, email, balance from customers order by id limit 5');
    const r = results[0];
    assert.strictEqual(r.editable, true, r.notEditableReason || '');
    assert.strictEqual(r.source.table, 'customers');
    assert.deepStrictEqual(r.key, [0]);
    assert.strictEqual(r.columns[1].dataType, 'varchar(255)');
  });

  await check('a result without any unique column is read-only, and says why', async () => {
    // email carries a unique index, so it would be a usable key; full_name does not.
    const { results } = await m.run(id, 't1', 'select full_name, balance from customers limit 5');
    assert.strictEqual(results[0].editable, false);
    assert.ok(/no primary or unique key/i.test(results[0].notEditableReason), results[0].notEditableReason);
  });

  await check('a join is read-only', async () => {
    const { results } = await m.run(id, 't1',
      'select c.id, o.total from customers c join orders o on o.customer_id = c.id limit 5');
    assert.strictEqual(results[0].editable, false);
    assert.ok(/more than one table/i.test(results[0].notEditableReason));
  });

  await check('a view is read-only', async () => {
    const { results } = await m.run(id, 't1', 'select * from order_totals limit 5');
    assert.strictEqual(results[0].editable, false);
    assert.ok(/view/i.test(results[0].notEditableReason), results[0].notEditableReason);
  });

  await check('a table with no key at all is read-only', async () => {
    const { results } = await m.run(id, 't1', 'select * from audit_log limit 5');
    assert.strictEqual(results[0].editable, false);
  });

  await check('an INSERT reports rows affected, not a result set', async () => {
    const { results } = await m.run(id, 't1',
      "insert into audit_log (actor, action) values ('test', 'one')");
    assert.strictEqual(results[0].rowCount, 1);
    assert.strictEqual(results[0].columns.length, 0);
    await m.run(id, 't1', "delete from audit_log where actor = 'test'");
  });

  await check('a broken statement comes back as an error, not a throw', async () => {
    const { results } = await m.run(id, 't1', 'select * from no_such_table');
    assert.ok(results[0].error, 'expected an error');
    assert.ok(/no_such_table/.test(results[0].error.message), results[0].error.message);
    assert.ok(results[0].error.code, 'and a code to go with it');
  });

  console.log('\npaging, sorting and filtering');

  await check('a page comes back with a total order', async () => {
    const r = await m.runPaged(id, 't1', 'select id, email from customers', { limit: 10 });
    const res = r.results[0];
    assert.strictEqual(res.rows.length, 10);
    assert.strictEqual(res.page.hasMore, true);
    assert.strictEqual(res.rows[0][0], '1');
  });

  await check('keyset paging walks the same rows as offset', async () => {
    const sort = [{ name: 'id', dir: 'asc' }];
    const first = await m.runPaged(id, 't1', 'select id, email from customers', { limit: 5, sort });
    const byKeyset = await m.runPaged(id, 't1', 'select id, email from customers',
      { limit: 5, sort, after: first.results[0].page.nextAfter });
    const byOffset = await m.runPaged(id, 't1', 'select id, email from customers',
      { limit: 5, sort, offset: 5 });
    // The first page has nothing to come after, so only the second one is keyset.
    assert.strictEqual(byKeyset.results[0].page.strategy, 'keyset');
    assert.deepStrictEqual(byKeyset.results[0].rows, byOffset.results[0].rows);
  });

  await check('a paged, sorted result is still editable', async () => {
    const r = await m.runPaged(id, 't1', 'select id, email, balance from customers',
      { limit: 5, sort: [{ name: 'balance', dir: 'desc' }] });
    assert.strictEqual(r.results[0].editable, true, r.results[0].notEditableReason || '');
  });

  await check('a filter runs on the server and keeps the result editable', async () => {
    const r = await m.runPaged(id, 't1', 'select id, email, balance from customers',
      { limit: 20, where: 'balance > 500' });
    assert.ok(r.results[0].rows.length > 0);
    assert.ok(r.results[0].rows.every((row) => Number(row[2]) > 500));
    assert.strictEqual(r.results[0].editable, true);
  });

  await check('ILIKE becomes LIKE rather than a syntax error', async () => {
    const r = await m.runPaged(id, 't1', 'select id, email from customers',
      { limit: 5, filters: [{ name: 'email', op: 'ilike', value: '%USER1@%' }] });
    assert.ok(!r.results[0].error, r.results[0].error && r.results[0].error.message);
    assert.strictEqual(r.results[0].rows.length, 1);
  });

  await check('counting the whole filtered set', async () => {
    const { count } = await m.countRows(id, 't1', 'select * from customers', [], 'balance > 500');
    const check2 = await m.run(id, 't1', 'select count(*) from customers where balance > 500');
    assert.strictEqual(String(count), String(check2.results[0].rows[0][0]));
  });

  console.log('\nediting');

  await check('an update commits and can be put back', async () => {
    const { results } = await m.run(id, 't1', 'select id, full_name from customers where id = 1');
    const r = results[0];
    const before = r.rows[0][1];
    const applied = await m.applyChanges(id, {
      source: r.source, columns: r.columns, key: r.key,
      updates: [{ keyValues: [r.rows[0][0]], set: { 1: 'Edited by the test' } }],
    });
    assert.strictEqual(applied.updated, 1);
    const after = await m.run(id, 't1', 'select full_name from customers where id = 1');
    assert.strictEqual(after.results[0].rows[0][0], 'Edited by the test');
    await m.applyChanges(id, {
      source: r.source, columns: r.columns, key: r.key,
      updates: [{ keyValues: [r.rows[0][0]], set: { 1: before } }],
    });
  });

  await check('an insert and a delete round-trip', async () => {
    const { results } = await m.run(id, 't1', 'select id, email, balance from customers limit 1');
    const r = results[0];
    const applied = await m.applyChanges(id, {
      source: r.source, columns: r.columns, key: r.key,
      inserts: [{ values: { 1: 'inserted@example.com', 2: '12.34' } }],
    });
    assert.strictEqual(applied.inserted, 1);
    const found = await m.run(id, 't1', "select balance from customers where email = 'inserted@example.com'");
    assert.strictEqual(found.results[0].rows[0][0], '12.34');
    const back = await m.run(id, 't1', "select id, email from customers where email = 'inserted@example.com'");
    await m.applyChanges(id, {
      source: back.results[0].source, columns: back.results[0].columns, key: back.results[0].key,
      deletes: [{ keyValues: [back.results[0].rows[0][0]] }],
    });
    const gone = await m.run(id, 't1', "select count(*) from customers where email = 'inserted@example.com'");
    assert.strictEqual(gone.results[0].rows[0][0], '0');
  });

  await check('a failed change set rolls the whole thing back', async () => {
    const { results } = await m.run(id, 't1', 'select id, email from customers order by id limit 2');
    const r = results[0];
    const firstEmail = r.rows[0][1];
    const secondEmail = r.rows[1][1];
    await assert.rejects(() => m.applyChanges(id, {
      source: r.source, columns: r.columns, key: r.key,
      updates: [
        // The first one is fine; the second collides with row 1's unique email,
        // so the whole set must come back out.
        { keyValues: [r.rows[1][0]], set: { 1: 'rolled-back@example.com' } },
        { keyValues: [r.rows[1][0]], set: { 1: firstEmail } },
      ],
    }), /Duplicate entry|duplicate/i);
    const after = await m.run(id, 't1', `select email from customers where id = ${r.rows[1][0]}`);
    assert.strictEqual(after.results[0].rows[0][0], secondEmail, 'the first update must not have stuck');
  });

  await check('a read-only connection refuses to write', async () => {
    const ro = new Manager();
    const conn = await ro.open({ ...CFG, id: 'ro', name: 'RO', readOnly: true });
    await assert.rejects(() => ro.ddl(conn.id, 'create table should_not_exist (x int)'), /read-only/i);
    await ro.closeAll();
  });

  console.log('\nintrospection');

  await check('the schema tree lists tables, views and columns', async () => {
    const tree = await m.schemaTree(id);
    assert.strictEqual(tree.engine, 'mysql');
    assert.strictEqual(tree.hasSchemas, false);
    const db = tree.schemas.find((s) => s.name === 'cobalt');
    assert.ok(db, `no cobalt schema in ${tree.schemas.map((s) => s.name)}`);
    const customers = db.relations.find((r) => r.name === 'customers');
    assert.strictEqual(customers.kind, 'r');
    assert.ok(customers.columns.find((c) => c.name === 'id').isPk, 'id should be flagged as the key');
    assert.strictEqual(customers.columns.find((c) => c.name === 'email').notNull, true);
    assert.strictEqual(db.relations.find((r) => r.name === 'order_totals').kind, 'v');
  });

  await check('foreign keys are found in both directions', async () => {
    const { outgoing, incoming } = await m.foreignKeys(id);
    const out = outgoing['cobalt.orders'];
    assert.ok(out && out.length, 'orders should hold a key');
    assert.deepStrictEqual(out[0].columns, ['customer_id']);
    assert.deepStrictEqual(out[0].refColumns, ['id']);
    assert.strictEqual(out[0].refTable, 'customers');
    assert.ok((incoming['cobalt.customers'] || []).some((fk) => fk.table === 'orders'));
  });

  await check('DDL comes back from the server', async () => {
    const ddl = await m.tableDdl(id, 'cobalt', 'customers');
    assert.ok(/CREATE TABLE/i.test(ddl), ddl.slice(0, 80));
    assert.ok(/`email`/.test(ddl), 'and it is the real thing, backticks and all');
  });

  await check('table stats are reported in a readable unit', async () => {
    const stats = await m.tableStats(id, 'cobalt', 'customers');
    assert.ok(/\d/.test(stats.total_size), stats.total_size);
    assert.ok(stats.index_count >= 1);
  });

  console.log('\nsessions, cancel and plans');

  await check('each tab gets its own session', async () => {
    await m.run(id, 'tabA', 'create temporary table t_my (x int)');
    await m.run(id, 'tabA', 'insert into t_my values (1)');
    const a = await m.run(id, 'tabA', 'select count(*) from t_my');
    assert.strictEqual(a.results[0].rows[0][0], '1');
    const b = await m.run(id, 'tabB', 'select count(*) from t_my');
    assert.ok(b.results[0].error, 'the other tab should not see the temporary table');
  });

  await check('cancel stops a long-running query', async () => {
    const started = Date.now();
    const slow = m.run(id, 'tabSlow', 'select sleep(20)');
    await new Promise((r) => setTimeout(r, 800));
    await m.cancel(id, 'tabSlow');
    const { results } = await slow;
    assert.ok(results[0].error || results[0].rows[0][0] === '1', 'expected it to stop');
    assert.ok(Date.now() - started < 12000, 'and to come back promptly');
  });

  await check('EXPLAIN comes back as readable text', async () => {
    const plan = await m.explain(id, 't1', 'select * from customers where balance > 500', { analyze: false });
    assert.ok(!plan.error, plan.error && plan.error.message);
    assert.ok(plan.planText && plan.planText.length > 10, 'expected plan text');
    assert.ok(/query_block|table/i.test(plan.planText), plan.planText.slice(0, 120));
  });

  await check('the process list shows this connection', async () => {
    const rows = await m.processList(id);
    assert.ok(rows.length >= 1);
    assert.ok(rows.some((r) => r.is_self), 'one row should be us');
    assert.ok(rows.every((r) => typeof r.id === 'number'));
  });

  console.log('\nimport');

  await check('rows import in one transaction', async () => {
    await m.ddl(id, 'drop table if exists tmp_import');
    await m.ddl(id, 'create table tmp_import (id bigint primary key, name varchar(64), note text)');
    const res = await m.importRows(id, {
      schema: 'cobalt', table: 'tmp_import',
      columns: ['id', 'name', 'note'],
      rows: [['1', 'a', 'hello'], ['2', 'b', null], ['3', 'c', '']],
    });
    assert.strictEqual(res.inserted, 3);
    const back = await m.run(id, 't1', 'select id, name, note from tmp_import order by id');
    assert.deepStrictEqual(back.results[0].rows[1], ['2', 'b', null]);
    assert.deepStrictEqual(back.results[0].rows[2], ['3', 'c', '']);
  });

  await check('a duplicate key rolls the whole import back', async () => {
    await assert.rejects(() => m.importRows(id, {
      schema: 'cobalt', table: 'tmp_import',
      columns: ['id', 'name'],
      rows: [['9', 'new'], ['1', 'dupe']],
    }), /rows 1-2 of the file/);
    const back = await m.run(id, 't1', 'select count(*) from tmp_import');
    assert.strictEqual(back.results[0].rows[0][0], '3', 'nothing should have been added');
  });

  await check('skipping conflicts inserts the rest', async () => {
    const res = await m.importRows(id, {
      schema: 'cobalt', table: 'tmp_import',
      columns: ['id', 'name'],
      rows: [['1', 'dupe'], ['9', 'new']],
      mode: 'skipConflicts',
    });
    assert.strictEqual(res.inserted, 1);
    await m.ddl(id, 'drop table tmp_import');
  });

  await m.closeAll();
  console.log(`\n${process.exitCode ? 'failures above' : `all ${n} checks passed`}\n`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
