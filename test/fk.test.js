'use strict';
/* Foreign key introspection. Run: node test/fk.test.js */

const assert = require('assert');
const { Manager } = require('../src/main/db');

const CFG = { host: 'localhost', port: 15432, database: 'cobalt', user: 'cobalt', password: 'cobalt' };

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

(async () => {
  const m = new Manager();
  const { id } = await m.open(CFG);

  console.log('\nforeign keys');

  await test('reads the keys a table holds', async () => {
    const { outgoing } = await m.foreignKeys(id);
    const fks = outgoing['shop.orders'];
    assert.ok(fks && fks.length, 'orders has a foreign key');
    const fk = fks.find((f) => f.columns.includes('customer_id'));
    assert.ok(fk, 'the customer_id key is there');
    assert.deepStrictEqual(fk.columns, ['customer_id']);
    assert.strictEqual(fk.refSchema, 'shop');
    assert.strictEqual(fk.refTable, 'customers');
    assert.deepStrictEqual(fk.refColumns, ['id']);
  });

  await test('indexes the same key the other way round', async () => {
    const { incoming } = await m.foreignKeys(id);
    const back = incoming['shop.customers'];
    assert.ok(back && back.length, 'customers is referenced');
    const fk = back.find((f) => f.table === 'orders');
    assert.ok(fk, 'orders shows up as a referencing table');
    assert.deepStrictEqual(fk.columns, ['customer_id'], 'the child column');
    assert.deepStrictEqual(fk.refColumns, ['id'], 'the parent column');
  });

  await test('a table with no keys is simply absent', async () => {
    const { outgoing } = await m.foreignKeys(id);
    assert.strictEqual(outgoing['shop.audit_log'], undefined);
  });

  await test('system catalogs are left out', async () => {
    const { outgoing, incoming } = await m.foreignKeys(id);
    const all = [...Object.keys(outgoing), ...Object.keys(incoming)];
    assert.ok(!all.some((k) => k.startsWith('pg_catalog.') || k.startsWith('information_schema.')));
  });

  await test('composite and multi-key tables keep column order', async () => {
    await m.run(id, 'fk1', `
      create table if not exists shop.fk_parent (a int, b int, primary key (a, b));
      create table if not exists shop.fk_child (
        x int, y int, note text,
        constraint fk_child_ab foreign key (x, y) references shop.fk_parent (a, b));`);
    const { outgoing, incoming } = await m.foreignKeys(id);
    const fk = (outgoing['shop.fk_child'] || []).find((f) => f.name === 'fk_child_ab');
    assert.ok(fk, 'the composite key is found');
    assert.deepStrictEqual(fk.columns, ['x', 'y'], 'child columns in key order');
    assert.deepStrictEqual(fk.refColumns, ['a', 'b'], 'parent columns in matching order');
    assert.ok((incoming['shop.fk_parent'] || []).some((f) => f.name === 'fk_child_ab'));
    await m.run(id, 'fk1', 'drop table shop.fk_child; drop table shop.fk_parent;');
  });

  await test('two keys from one table to another stay separate', async () => {
    await m.run(id, 'fk1', `
      create table if not exists shop.fk_two (
        id int primary key,
        ship_to bigint references shop.customers(id),
        bill_to bigint references shop.customers(id));`);
    const { outgoing } = await m.foreignKeys(id);
    const fks = outgoing['shop.fk_two'] || [];
    assert.strictEqual(fks.length, 2, `expected two keys, got ${fks.length}`);
    const cols = fks.map((f) => f.columns[0]).sort();
    assert.deepStrictEqual(cols, ['bill_to', 'ship_to']);
    await m.run(id, 'fk1', 'drop table shop.fk_two;');
  });

  await test('the lookup a menu would do resolves to real rows', async () => {
    // Mirrors what the cell menu builds: follow orders.customer_id to customers.id.
    const { outgoing } = await m.foreignKeys(id);
    const fk = outgoing['shop.orders'].find((f) => f.columns[0] === 'customer_id');
    const order = (await m.run(id, 'fk1', 'select id, customer_id from shop.orders limit 1')).results[0];
    const customerId = order.rows[0][1];
    const target = await m.run(id, 'fk1',
      `select * from "${fk.refSchema}"."${fk.refTable}" where "${fk.refColumns[0]}" = ${customerId}`);
    assert.strictEqual(target.results[0].rows.length, 1, 'the referenced row exists');
    assert.strictEqual(target.results[0].editable, true, 'and is editable when you land on it');
  });

  await test('walking back finds the children of a row', async () => {
    const { incoming } = await m.foreignKeys(id);
    const fk = incoming['shop.customers'].find((f) => f.table === 'orders');
    const child = await m.run(id, 'fk1',
      `select count(*) from "${fk.schema}"."${fk.table}" where "${fk.columns[0]}" = 1`);
    const expected = await m.run(id, 'fk1', 'select count(*) from shop.orders where customer_id = 1');
    assert.strictEqual(child.results[0].rows[0][0], expected.results[0].rows[0][0]);
  });

  await m.close(id);
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
