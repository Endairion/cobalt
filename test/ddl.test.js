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
    'alter table shop.customers\n  add column nickname text;');
});

check('add with a default and not null, in that order', () => {
  const sql = d.addColumn({
    schema: 'shop', table: 'customers', name: 'tier', type: 'text',
    defaultExpr: "'basic'", notNull: true,
  });
  assert.strictEqual(sql, "alter table shop.customers\n  add column tier text default 'basic' not null;");
});

check('drop, with and without cascade', () => {
  assert.strictEqual(d.dropColumn({ schema: 'shop', table: 'customers', name: 'notes' }),
    'alter table shop.customers\n  drop column notes;');
  assert.ok(d.dropColumn({ schema: 'shop', table: 'customers', name: 'notes', cascade: true }).endsWith('cascade;'));
});

check('rename', () => {
  assert.strictEqual(d.renameColumn({ schema: 'shop', table: 'customers', name: 'notes', to: 'memo' }),
    'alter table shop.customers\n  rename column notes to memo;');
});

check('change the type, with a USING when the cast needs one', () => {
  assert.strictEqual(d.alterColumnType({ schema: 'shop', table: 'customers', name: 'balance', type: 'numeric(14,4)' }),
    'alter table shop.customers\n  alter column balance type numeric(14,4);');
  assert.ok(d.alterColumnType({
    schema: 'shop', table: 'customers', name: 'balance', type: 'text', using: 'balance::text',
  }).includes('\n  using balance::text'));
});

check('set and drop not null', () => {
  assert.ok(d.setNotNull({ schema: 'shop', table: 'c', name: 'x', notNull: true }).endsWith('set not null;'));
  assert.ok(d.setNotNull({ schema: 'shop', table: 'c', name: 'x', notNull: false }).endsWith('drop not null;'));
});

check('an empty default means DROP DEFAULT, not a default of nothing', () => {
  assert.ok(d.setDefault({ schema: 'shop', table: 'c', name: 'x', defaultExpr: '' }).endsWith('drop default;'));
  assert.ok(d.setDefault({ schema: 'shop', table: 'c', name: 'x', defaultExpr: 'now()' }).endsWith('set default now();'));
});

console.log('\ntables');

check('rename and drop', () => {
  assert.strictEqual(d.renameTable({ schema: 'shop', table: 'customers', to: 'clients' }),
    'alter table shop.customers\n  rename to clients;');
  assert.strictEqual(d.dropTable({ schema: 'shop', table: 'customers' }), 'drop table shop.customers;');
});

check('a view is dropped as a view, not as a table', () => {
  assert.strictEqual(d.dropTable({ schema: 'shop', table: 'order_totals', kind: 'v' }),
    'drop view shop.order_totals;');
  assert.strictEqual(d.dropTable({ schema: 'shop', table: 'mv', kind: 'm' }),
    'drop materialized view shop.mv;');
});

check('truncate, with its options', () => {
  assert.strictEqual(d.truncateTable({ schema: 'shop', table: 'audit_log' }), 'truncate table shop.audit_log;');
  assert.strictEqual(
    d.truncateTable({ schema: 'shop', table: 'audit_log', restartIdentity: true, cascade: true }),
    'truncate table shop.audit_log restart identity cascade;');
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
    'create index orders_customer_id_idx\n  on shop.orders (customer_id);');
});

check('unique, concurrent, and a named index', () => {
  const sql = d.createIndex({
    schema: 'shop', table: 'orders', columns: ['a', 'b'],
    unique: true, concurrently: true, name: 'my_idx',
  });
  assert.strictEqual(sql, 'create unique index concurrently my_idx\n  on shop.orders (a, b);');
});

check('btree is the default and is not spelled out; anything else is', () => {
  assert.ok(!d.createIndex({ schema: 's', table: 't', columns: ['c'], method: 'btree' }).includes('using'));
  assert.ok(d.createIndex({ schema: 's', table: 't', columns: ['c'], method: 'gin' }).includes('using gin'));
});

check('an expression is parenthesized, a bare column is not', () => {
  const sql = d.createIndex({ schema: 's', table: 't', columns: ['lower(email)'] });
  assert.ok(sql.includes('((lower(email)))'), sql);
});

check('a partial index keeps its WHERE', () => {
  assert.ok(d.createIndex({ schema: 's', table: 't', columns: ['c'], where: 'deleted_at is null' })
    .includes('\n  where deleted_at is null'));
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
    'alter table s.t\n  add column "select" text;');
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
    "alter table shop.customers\n  add column tier varchar(32) not null default 'basic';");
});

// The one that would simply be a syntax error if Postgres syntax were emitted.
check('changing a type is MODIFY COLUMN, not ALTER COLUMN ... TYPE', () => {
  assert.strictEqual(
    d.alterColumnType({ ...my, name: 'balance', type: 'decimal(14,4)' }),
    'alter table shop.customers\n  modify column balance decimal(14,4);');
});

check('a USING cast is dropped rather than emitted where it is not legal', () => {
  const sql = d.alterColumnType({ ...my, name: 'balance', type: 'char(20)', using: 'balance::text' });
  assert.ok(!/using/.test(sql), sql);
});

check('NOT NULL restates the column, because MODIFY needs the type', () => {
  assert.strictEqual(
    d.setNotNull({ ...my, name: 'full_name', notNull: true, currentType: 'varchar(255)' }),
    'alter table shop.customers\n  modify column full_name varchar(255) not null;');
  assert.ok(d.setNotNull({ ...my, name: 'full_name', notNull: false, currentType: 'varchar(255)' })
    .endsWith('varchar(255) null;'));
});

check('an index puts USING before the table', () => {
  assert.strictEqual(
    d.createIndex({ ...my, columns: ['email'], method: 'hash' }),
    'create index customers_email_idx using hash\n  on shop.customers (email);');
});

check('CASCADE and CONCURRENTLY are left out where they do not exist', () => {
  assert.strictEqual(d.dropTable({ ...my, cascade: true }), 'drop table shop.customers;');
  assert.ok(!/cascade/.test(d.dropColumn({ ...my, name: 'notes', cascade: true })));
  assert.ok(!/concurrently/.test(d.createIndex({ ...my, columns: ['email'], concurrently: true })));
  assert.strictEqual(d.truncateTable({ ...my, restartIdentity: true, cascade: true }),
    'truncate table shop.customers;');
});

check('what is the same on both stays the same', () => {
  assert.strictEqual(d.renameColumn({ ...my, name: 'notes', to: 'memo' }),
    'alter table shop.customers\n  rename column notes to memo;');
  assert.strictEqual(d.setDefault({ ...my, name: 'balance', defaultExpr: '0' }),
    'alter table shop.customers\n  alter column balance set default 0;');
});

check('a typed fragment is checked on either engine', () => {
  throws(() => d.addColumn({ ...my, name: 'c', type: 'text; drop table x' }), /semicolon/i);
});

console.log(`\n${process.exitCode ? 'failures above' : `all ${n} checks passed`}\n`);
