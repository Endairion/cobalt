'use strict';
/* The SQL the schema actions generate. Run: node test/ddl.test.js */

const assert = require('assert');
const d = require('../src/shared/ddl.js');

let n = 0;
const check = (label, fn) => {
  try { fn(); n++; console.log(`  ok   ${label}`); }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); process.exitCode = 1; }
};
const throws = (fn, re) => assert.throws(fn, (e) => re.test(e.message), `wanted ${re}`);

console.log('\nquoting');

check('an ordinary name is left bare, so the SQL reads naturally', () => {
  assert.strictEqual(d.q('email'), 'email');
  assert.strictEqual(d.rel('shop', 'customers'), 'shop.customers');
});

check('a reserved word is quoted', () => {
  assert.strictEqual(d.q('order'), '"order"');
  assert.strictEqual(d.q('user'), '"user"');
});

check('mixed case and punctuation are quoted', () => {
  assert.strictEqual(d.q('fullName'), '"fullName"');
  assert.strictEqual(d.q('my col'), '"my col"');
  assert.strictEqual(d.q('2legit'), '"2legit"');
});

check('a quote inside a name is doubled, not dropped', () => {
  assert.strictEqual(d.q('we"ird'), '"we""ird"');
});

console.log('\ncolumns');

check('add a column', () => {
  assert.strictEqual(
    d.addColumn({ schema: 'shop', table: 'customers', name: 'nickname', type: 'text' }),
    'ALTER TABLE shop.customers\n  ADD COLUMN nickname text;');
});

check('add with a default and not null, in that order', () => {
  const sql = d.addColumn({
    schema: 'shop', table: 'customers', name: 'tier', type: 'text',
    defaultExpr: "'basic'", notNull: true,
  });
  assert.strictEqual(sql, "ALTER TABLE shop.customers\n  ADD COLUMN tier text DEFAULT 'basic' NOT NULL;");
});

check('drop, with and without cascade', () => {
  assert.strictEqual(d.dropColumn({ schema: 'shop', table: 'customers', name: 'notes' }),
    'ALTER TABLE shop.customers\n  DROP COLUMN notes;');
  assert.ok(d.dropColumn({ schema: 'shop', table: 'customers', name: 'notes', cascade: true }).endsWith('CASCADE;'));
});

check('rename', () => {
  assert.strictEqual(d.renameColumn({ schema: 'shop', table: 'customers', name: 'notes', to: 'memo' }),
    'ALTER TABLE shop.customers\n  RENAME COLUMN notes TO memo;');
});

check('change the type, with a USING when the cast needs one', () => {
  assert.strictEqual(d.alterColumnType({ schema: 'shop', table: 'customers', name: 'balance', type: 'numeric(14,4)' }),
    'ALTER TABLE shop.customers\n  ALTER COLUMN balance TYPE numeric(14,4);');
  assert.ok(d.alterColumnType({
    schema: 'shop', table: 'customers', name: 'balance', type: 'text', using: 'balance::text',
  }).includes('\n  USING balance::text'));
});

check('set and drop not null', () => {
  assert.ok(d.setNotNull({ schema: 'shop', table: 'c', name: 'x', notNull: true }).endsWith('SET NOT NULL;'));
  assert.ok(d.setNotNull({ schema: 'shop', table: 'c', name: 'x', notNull: false }).endsWith('DROP NOT NULL;'));
});

check('an empty default means DROP DEFAULT, not a default of nothing', () => {
  assert.ok(d.setDefault({ schema: 'shop', table: 'c', name: 'x', defaultExpr: '' }).endsWith('DROP DEFAULT;'));
  assert.ok(d.setDefault({ schema: 'shop', table: 'c', name: 'x', defaultExpr: 'now()' }).endsWith('SET DEFAULT now();'));
});

console.log('\ntables');

check('rename and drop', () => {
  assert.strictEqual(d.renameTable({ schema: 'shop', table: 'customers', to: 'clients' }),
    'ALTER TABLE shop.customers\n  RENAME TO clients;');
  assert.strictEqual(d.dropTable({ schema: 'shop', table: 'customers' }), 'DROP TABLE shop.customers;');
});

check('a view is dropped as a view, not as a table', () => {
  assert.strictEqual(d.dropTable({ schema: 'shop', table: 'order_totals', kind: 'v' }),
    'DROP VIEW shop.order_totals;');
  assert.strictEqual(d.dropTable({ schema: 'shop', table: 'mv', kind: 'm' }),
    'DROP MATERIALIZED VIEW shop.mv;');
});

check('truncate, with its options', () => {
  assert.strictEqual(d.truncateTable({ schema: 'shop', table: 'audit_log' }), 'TRUNCATE TABLE shop.audit_log;');
  assert.strictEqual(
    d.truncateTable({ schema: 'shop', table: 'audit_log', restartIdentity: true, cascade: true }),
    'TRUNCATE TABLE shop.audit_log RESTART IDENTITY CASCADE;');
});

console.log('\nindexes');

check('the default name follows the Postgres convention', () => {
  assert.strictEqual(d.defaultIndexName({ table: 'orders', columns: ['customer_id'] }), 'orders_customer_id_idx');
  assert.strictEqual(d.defaultIndexName({ table: 'orders', columns: ['a', 'b'], unique: true }), 'orders_a_b_key');
});

check('a long generated name is cut to what Postgres will keep', () => {
  const name = d.defaultIndexName({ table: 'x'.repeat(60), columns: ['y'.repeat(60)] });
  assert.strictEqual(name.length, 63);
});

check('one column', () => {
  assert.strictEqual(
    d.createIndex({ schema: 'shop', table: 'orders', columns: ['customer_id'] }),
    'CREATE INDEX orders_customer_id_idx\n  ON shop.orders (customer_id);');
});

check('unique, concurrent, and a named index', () => {
  const sql = d.createIndex({
    schema: 'shop', table: 'orders', columns: ['a', 'b'],
    unique: true, concurrently: true, name: 'my_idx',
  });
  assert.strictEqual(sql, 'CREATE UNIQUE INDEX CONCURRENTLY my_idx\n  ON shop.orders (a, b);');
});

check('btree is the default and is not spelled out; anything else is', () => {
  assert.ok(!d.createIndex({ schema: 's', table: 't', columns: ['c'], method: 'btree' }).includes('USING'));
  assert.ok(d.createIndex({ schema: 's', table: 't', columns: ['c'], method: 'gin' }).includes('USING gin'));
});

check('an expression is parenthesized, a bare column is not', () => {
  const sql = d.createIndex({ schema: 's', table: 't', columns: ['lower(email)'] });
  assert.ok(sql.includes('((lower(email)))'), sql);
});

check('a partial index keeps its WHERE', () => {
  assert.ok(d.createIndex({ schema: 's', table: 't', columns: ['c'], where: 'deleted_at is null' })
    .includes('\n  WHERE deleted_at is null'));
});

check('no columns is refused', () => {
  throws(() => d.createIndex({ schema: 's', table: 't', columns: [] }), /at least one column/i);
});

console.log('\nwhat a typed fragment may not contain');

// Not a security boundary — the editor next door runs anything. This is so a
// pasted value cannot quietly become a second statement.
check('a semicolon in a type is refused', () => {
  throws(() => d.addColumn({ schema: 's', table: 't', name: 'c', type: 'text; drop table t' }),
    /semicolon/i);
});

check('a comment in a default is refused', () => {
  throws(() => d.addColumn({ schema: 's', table: 't', name: 'c', type: 'text', defaultExpr: "'x' -- trailing" }),
    /comment/i);
  throws(() => d.addColumn({ schema: 's', table: 't', name: 'c', type: 'text', defaultExpr: "'x' /* b */" }),
    /comment/i);
});

check('a missing name or type is refused, with which one it was', () => {
  throws(() => d.addColumn({ schema: 's', table: 't', name: '', type: 'text' }), /Column name is required/);
  throws(() => d.addColumn({ schema: 's', table: 't', name: 'c', type: '  ' }), /Type is required/);
  throws(() => d.renameColumn({ schema: 's', table: 't', name: 'c', to: '' }), /New name is required/);
});

check('a name Postgres would truncate is refused rather than silently cut', () => {
  throws(() => d.renameColumn({ schema: 's', table: 't', name: 'c', to: 'x'.repeat(64) }), /63 characters/);
});

check('a name that needs quoting is allowed — it just gets quoted', () => {
  assert.strictEqual(
    d.addColumn({ schema: 's', table: 't', name: 'select', type: 'text' }),
    'ALTER TABLE s.t\n  ADD COLUMN "select" text;');
});

console.log('\nthe same actions on MySQL');

const my = { engine: 'mysql', schema: 'shop', table: 'customers' };

check('identifiers are backquoted, and only when they need to be', () => {
  const qm = d.quoterFor('mysql');
  assert.strictEqual(qm('email'), 'email');
  assert.strictEqual(qm('order'), '`order`');
  assert.strictEqual(qm('my col'), '`my col`');
  assert.strictEqual(qm('we`ird'), '`we``ird`');
});

// MySQL wants NOT NULL before DEFAULT; Postgres takes either order.
check('adding a column puts NOT NULL where MySQL wants it', () => {
  assert.strictEqual(
    d.addColumn({ ...my, name: 'tier', type: 'varchar(32)', defaultExpr: "'basic'", notNull: true }),
    "ALTER TABLE shop.customers\n  ADD COLUMN tier varchar(32) NOT NULL DEFAULT 'basic';");
});

// The one that would simply be a syntax error if Postgres syntax were emitted.
check('changing a type is MODIFY COLUMN, not ALTER COLUMN ... TYPE', () => {
  assert.strictEqual(
    d.alterColumnType({ ...my, name: 'balance', type: 'decimal(14,4)' }),
    'ALTER TABLE shop.customers\n  MODIFY COLUMN balance decimal(14,4);');
});

check('a USING cast is dropped rather than emitted where it is not legal', () => {
  const sql = d.alterColumnType({ ...my, name: 'balance', type: 'char(20)', using: 'balance::text' });
  assert.ok(!/using/i.test(sql), sql);
});

check('NOT NULL restates the column, because MODIFY needs the type', () => {
  assert.strictEqual(
    d.setNotNull({ ...my, name: 'full_name', notNull: true, currentType: 'varchar(255)' }),
    'ALTER TABLE shop.customers\n  MODIFY COLUMN full_name varchar(255) NOT NULL;');
  assert.ok(d.setNotNull({ ...my, name: 'full_name', notNull: false, currentType: 'varchar(255)' })
    .endsWith('varchar(255) NULL;'));
});

check('an index puts USING before the table', () => {
  assert.strictEqual(
    d.createIndex({ ...my, columns: ['email'], method: 'hash' }),
    'CREATE INDEX customers_email_idx USING hash\n  ON shop.customers (email);');
});

check('CASCADE and CONCURRENTLY are left out where they do not exist', () => {
  assert.strictEqual(d.dropTable({ ...my, cascade: true }), 'DROP TABLE shop.customers;');
  assert.ok(!/cascade/i.test(d.dropColumn({ ...my, name: 'notes', cascade: true })));
  assert.ok(!/concurrently/i.test(d.createIndex({ ...my, columns: ['email'], concurrently: true })));
  assert.strictEqual(d.truncateTable({ ...my, restartIdentity: true, cascade: true }),
    'TRUNCATE TABLE shop.customers;');
});

check('what is the same on both stays the same', () => {
  assert.strictEqual(d.renameColumn({ ...my, name: 'notes', to: 'memo' }),
    'ALTER TABLE shop.customers\n  RENAME COLUMN notes TO memo;');
  assert.strictEqual(d.setDefault({ ...my, name: 'balance', defaultExpr: '0' }),
    'ALTER TABLE shop.customers\n  ALTER COLUMN balance SET DEFAULT 0;');
});

check('a typed fragment is checked on either engine', () => {
  throws(() => d.addColumn({ ...my, name: 'c', type: 'text; drop table x' }), /semicolon/i);
});

console.log(`\n${process.exitCode ? 'failures above' : `all ${n} checks passed`}\n`);
