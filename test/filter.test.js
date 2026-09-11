'use strict';
/* Filter builder + expression parser. Run: node test/filter.test.js
   Needs the cobalt-test-pg container on :15432 for the round-trip checks. */

const assert = require('assert');
const { Manager, buildFilteredQuery, splitLimitTail } = require('../src/main/db');

const CFG = { host: 'localhost', port: 15432, database: 'cobalt', user: 'cobalt', password: 'cobalt' };

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

// The parser is an ES module for the renderer; re-parse it here rather than
// duplicating the rules.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'filter.js'), 'utf8')
  .replace(/export function/g, 'function').replace(/export /g, '');
const parseFilter = new Function(`${src}; return parseFilter;`)();

(async () => {
  console.log('\nlimit hoisting');
  await test('peels a trailing LIMIT', () => {
    const r = splitLimitTail('select * from t limit 500');
    assert.strictEqual(r.inner, 'select * from t');
    assert.strictEqual(r.tail, ' limit 500');
  });
  await test('peels LIMIT with OFFSET and a semicolon', () => {
    const r = splitLimitTail('select * from t limit 10 offset 20;');
    assert.strictEqual(r.inner, 'select * from t');
    assert.strictEqual(r.tail, ' limit 10 offset 20');
  });
  await test('leaves a query without a limit alone', () => {
    assert.strictEqual(splitLimitTail('select * from t where a = 1').tail, '');
  });
  await test('does not mistake a trailing string for a limit', () => {
    assert.strictEqual(splitLimitTail("select 'limit 5'").tail, '');
  });

  console.log('\nexpression parsing');
  const textCol = { name: 'email', dataType: 'text' };
  const numCol = { name: 'balance', dataType: 'numeric(12,2)' };

  await test('bare word means contains on text, equals elsewhere', () => {
    assert.deepStrictEqual(parseFilter('bob', textCol), { op: 'ilike', value: '%bob%' });
    assert.deepStrictEqual(parseFilter('42', numCol), { op: '=', value: '42' });
  });
  await test('explicit comparisons win', () => {
    assert.deepStrictEqual(parseFilter('>= 100', numCol), { op: '>=', value: '100' });
    assert.deepStrictEqual(parseFilter('!= draft', textCol), { op: '!=', value: 'draft' });
    assert.deepStrictEqual(parseFilter('<5', numCol), { op: '<', value: '5' });
  });
  await test('longest operator wins over its prefix', () => {
    assert.strictEqual(parseFilter('<= 5', numCol).op, '<=');
    assert.strictEqual(parseFilter('not ilike x%', textCol).op, 'not ilike');
    assert.strictEqual(parseFilter('!~* x', textCol).op, '!~*');
  });
  await test('a word operator needs a space, so "inbox" is a value', () => {
    assert.deepStrictEqual(parseFilter('inbox', textCol), { op: 'ilike', value: '%inbox%' });
    assert.deepStrictEqual(parseFilter('likely', textCol), { op: 'ilike', value: '%likely%' });
  });
  await test('wildcards switch to ilike verbatim', () => {
    assert.deepStrictEqual(parseFilter('%ob%', textCol), { op: 'ilike', value: '%ob%' });
  });
  await test('null forms', () => {
    assert.deepStrictEqual(parseFilter('null', textCol), { op: 'is null' });
    assert.deepStrictEqual(parseFilter('is not null', textCol), { op: 'is not null' });
    assert.deepStrictEqual(parseFilter('!null', textCol), { op: 'is not null' });
  });
  await test('IN splits on commas and honours quotes', () => {
    assert.deepStrictEqual(parseFilter('in a, b, c', textCol), { op: 'in', values: ['a', 'b', 'c'] });
    assert.deepStrictEqual(parseFilter("in 'x, y', z", textCol), { op: 'in', values: ['x, y', 'z'] });
  });
  await test('quoting forces an exact match on a text column', () => {
    assert.deepStrictEqual(parseFilter("'bob'", textCol), { op: '=', value: 'bob' });
  });
  await test('an operator with no value reports an error', () => {
    assert.ok(parseFilter('>=', numCol).error);
    assert.ok(parseFilter('in', textCol).error);
  });
  await test('blank input means no filter', () => {
    assert.strictEqual(parseFilter('   ', textCol), null);
  });

  console.log('\nSQL construction');
  await test('wraps the base query and hoists the limit past the filter', () => {
    const { text, values } = buildFilteredQuery('select * from shop.customers limit 500',
      [{ name: 'email', op: 'ilike', value: '%1%' }]);
    assert.match(text, /select \* from \(/);
    assert.match(text, /\) as "_cobalt"/);
    assert.match(text, /where "email"::text ilike \$1/);
    assert.ok(text.trim().endsWith('limit 500'), 'limit must come after the filter');
    assert.deepStrictEqual(values, ['%1%']);
  });
  await test('values are parameters, never interpolated', () => {
    const { text, values } = buildFilteredQuery('select * from t',
      [{ name: 'name', op: '=', value: "'; drop table t; --" }]);
    assert.ok(!text.includes('drop table'), 'value must not reach the SQL text');
    assert.deepStrictEqual(values, ["'; drop table t; --"]);
  });
  await test('column names are quoted, not interpolated', () => {
    const { text } = buildFilteredQuery('select * from t', [{ name: 'we"ird', op: '=', value: 'x' }]);
    assert.match(text, /"we""ird" = \$1/);
  });
  await test('rejects an operator that is not on the allowlist', () => {
    assert.throws(() => buildFilteredQuery('select * from t',
      [{ name: 'a', op: '= 1 or true --', value: 'x' }]), /Unsupported filter operator/);
  });
  await test('null operators take no parameter', () => {
    const { text, values } = buildFilteredQuery('select * from t', [{ name: 'notes', op: 'is null' }]);
    assert.match(text, /"notes" is null/);
    assert.strictEqual(values.length, 0);
  });
  await test('IN expands to one placeholder per value', () => {
    const { text, values } = buildFilteredQuery('select * from t',
      [{ name: 'status', op: 'in', values: ['paid', 'shipped'] }]);
    assert.match(text, /"status" in \(\$1, \$2\)/);
    assert.deepStrictEqual(values, ['paid', 'shipped']);
  });
  await test('several filters are ANDed', () => {
    const { text } = buildFilteredQuery('select * from t', [
      { name: 'a', op: '>', value: '1' }, { name: 'b', op: '=', value: 'x' },
    ]);
    assert.match(text, /where "a" > \$1\s+and "b" = \$2/);
  });

  console.log('\nagainst a live server');
  const m = new Manager();
  const { id } = await m.open(CFG);

  await test('filter runs and narrows the result', async () => {
    const base = 'select id, email, full_name, balance from shop.customers order by id limit 500';
    const all = await m.runFiltered(id, 'f1', base, []);
    assert.strictEqual(all.results[0].rows.length, 500);

    const some = await m.runFiltered(id, 'f1', base, [{ name: 'email', op: 'ilike', value: '%user123%' }]);
    const rows = some.results[0].rows;
    assert.ok(rows.length > 0 && rows.length < 500);
    assert.ok(rows.every((r) => r[1].includes('user123')));
  });

  await test('the filter beats the limit, not just the loaded page', async () => {
    // user2000 is past the first 500 rows, so a client-side filter would miss it.
    const base = 'select id, email from shop.customers order by id limit 500';
    const r = await m.runFiltered(id, 'f1', base, [{ name: 'email', op: '=', value: 'user2000@example.com' }]);
    assert.strictEqual(r.results[0].rows.length, 1, 'should reach beyond the original limit');
    assert.strictEqual(r.results[0].rows[0][1], 'user2000@example.com');
  });

  await test('a filtered result is still editable', async () => {
    const r = await m.runFiltered(id, 'f1', 'select * from shop.customers limit 100',
      [{ name: 'balance', op: '>', value: '500' }]);
    const res = r.results[0];
    assert.strictEqual(res.editable, true, res.notEditableReason || '');
    assert.strictEqual(res.source.table, 'customers');
    assert.deepStrictEqual(res.key, [0]);
  });

  await test('editing a filtered row writes to the right row', async () => {
    const r = await m.runFiltered(id, 'f1', 'select * from shop.customers limit 100',
      [{ name: 'email', op: '=', value: 'user77@example.com' }]);
    const res = r.results[0];
    const nameIdx = res.columns.findIndex((c) => c.name === 'full_name');
    await m.applyChanges(id, {
      source: res.source, columns: res.columns, key: res.key,
      updates: [{ keyValues: res.key.map((k) => res.rows[0][k]), set: { [nameIdx]: 'Filtered Edit' } }],
    });
    const back = await m.run(id, 'f1', "select full_name from shop.customers where email = 'user77@example.com'");
    assert.strictEqual(back.results[0].rows[0][0], 'Filtered Edit');
  });

  await test('is null / in / regex filters work end to end', async () => {
    const base = 'select id, email, full_name, notes from shop.customers limit 3000';
    const nulls = await m.runFiltered(id, 'f1', base, [{ name: 'full_name', op: 'is null' }]);
    assert.ok(nulls.results[0].rows.length > 0);
    assert.ok(nulls.results[0].rows.every((r) => r[2] === null));

    const re = await m.runFiltered(id, 'f1', base, [{ name: 'email', op: '~', value: '^user1[0-9]@' }]);
    assert.strictEqual(re.results[0].rows.length, 10);

    const inList = await m.runFiltered(id, 'f1', 'select id, email from shop.customers limit 3000',
      [{ name: 'id', op: 'in', values: ['1', '2', '3'] }]);
    assert.strictEqual(inList.results[0].rows.length, 3);
  });

  await test('filtering a timestamp by substring works via the text cast', async () => {
    const r = await m.runFiltered(id, 'f1', 'select id, signed_up from shop.customers limit 100',
      [{ name: 'signed_up', op: 'ilike', value: '%20%' }]);
    assert.ok(r.results[0].rows.length > 0);
  });

  await test('a bad filter value surfaces as a normal query error', async () => {
    const r = await m.runFiltered(id, 'f1', 'select id, balance from shop.customers limit 10',
      [{ name: 'balance', op: '>', value: 'not-a-number' }]);
    assert.ok(r.results[0].error, 'expected an error result');
    assert.strictEqual(r.results[0].error.code, '22P02');
  });

  await test('filtering an aggregate query works on its output columns', async () => {
    const base = 'select status, count(*) as orders from shop.orders group by status';
    const r = await m.runFiltered(id, 'f1', base, [{ name: 'status', op: '=', value: 'paid' }]);
    assert.strictEqual(r.results[0].rows.length, 1);
    assert.strictEqual(r.results[0].rows[0][0], 'paid');
  });

  await m.close(id);
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
