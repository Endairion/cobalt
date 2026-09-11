'use strict';
/* Server-side paging and sorting. Run: node test/paging.test.js */

const assert = require('assert');
const { Manager, buildPagedQuery, parseLimitTail } = require('../src/main/db');

const CFG = { host: 'localhost', port: 15432, database: 'cobalt', user: 'cobalt', password: 'cobalt' };

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

const ids = (res) => res.results[0].rows.map((r) => r[0]);

(async () => {
  console.log('\nquery construction');

  await test('parses a trailing limit and offset', () => {
    assert.deepStrictEqual(parseLimitTail('select * from t limit 50 offset 10'),
      { inner: 'select * from t', baseLimit: 50, baseOffset: 10 });
    assert.strictEqual(parseLimitTail('select * from t').baseLimit, null);
  });

  await test('offset paging wraps the query and orders outside it', () => {
    const q = buildPagedQuery('select * from t', { sort: [{ name: 'id', dir: 'desc' }], limit: 10, offset: 30 });
    assert.strictEqual(q.strategy, 'offset');
    assert.match(q.text, /order by "id" desc/);
    assert.match(q.text, /limit 10 offset 30/);
  });

  await test('keyset paging compares a row constructor', () => {
    const q = buildPagedQuery('select * from t', {
      sort: [{ name: 'a', dir: 'asc' }, { name: 'id', dir: 'asc' }],
      limit: 10, after: ['x', 5],
    });
    assert.strictEqual(q.strategy, 'keyset');
    assert.match(q.text, /\("a", "id"\) > \(\$1, \$2\)/);
    assert.ok(!/offset/.test(q.text), 'keyset never offsets');
    assert.deepStrictEqual(q.values, ['x', 5]);
  });

  await test('mixed sort directions fall back to offset', () => {
    const q = buildPagedQuery('select * from t', {
      sort: [{ name: 'a', dir: 'asc' }, { name: 'id', dir: 'desc' }],
      limit: 10, after: ['x', 5],
    });
    assert.strictEqual(q.strategy, 'offset', 'a row constructor has only one direction');
  });

  await test('sort column names are quoted, not interpolated', () => {
    const q = buildPagedQuery('select * from t', { sort: [{ name: 'we"ird', dir: 'asc' }], limit: 5 });
    assert.match(q.text, /order by "we""ird" asc/);
  });

  await test('a caller LIMIT caps the set and paging works inside it', () => {
    const first = buildPagedQuery('select * from t limit 120', { limit: 50, offset: 0 });
    assert.match(first.text, /limit 50/);
    const last = buildPagedQuery('select * from t limit 120', { limit: 50, offset: 100 });
    assert.match(last.text, /limit 20 offset 100/, 'the final page is clipped to the caller limit');
    const past = buildPagedQuery('select * from t limit 120', { limit: 50, offset: 200 });
    assert.match(past.text, /limit 0/);
  });

  await test('a caller LIMIT forces offset paging', () => {
    const q = buildPagedQuery('select * from t limit 100', {
      sort: [{ name: 'id', dir: 'asc' }], limit: 10, after: [5],
    });
    assert.strictEqual(q.strategy, 'offset');
  });

  const m = new Manager();
  const { id } = await m.open(CFG);

  console.log('\npaging a table');

  await test('the first page reports that there is more', async () => {
    const res = await m.runPaged(id, 'p1', 'select * from shop.customers', { limit: 100 });
    const r = res.results[0];
    assert.strictEqual(r.rows.length, 100, 'exactly one page, the probe row is trimmed');
    assert.strictEqual(r.page.hasMore, true);
    assert.strictEqual(r.truncated, false, 'paging replaces the old hard cap');
  });

  await test('a unique key is appended so the order is total', async () => {
    const res = await m.runPaged(id, 'p1', 'select * from shop.customers',
      { limit: 10, sort: [{ name: 'is_active', dir: 'asc' }] });
    const page = res.results[0].page;
    assert.deepStrictEqual(page.effectiveSort.map((x) => x.name), ['is_active', 'id'],
      'the key is added as a tiebreaker');
    assert.deepStrictEqual(page.tiebreak, ['id']);
  });

  await test('walking every page yields each row exactly once', async () => {
    const seen = [];
    let after = null;
    let offset = 0;
    for (let i = 0; i < 30; i++) {
      const res = await m.runPaged(id, 'p1', 'select id, email from shop.customers',
        { limit: 100, offset, after });
      const page = res.results[0].page;
      seen.push(...ids(res));
      offset += res.results[0].rows.length;
      after = page.nextAfter;
      if (!page.hasMore) break;
    }
    assert.strictEqual(seen.length, 2500, `expected every row once, got ${seen.length}`);
    assert.strictEqual(new Set(seen).size, 2500, 'no duplicates across pages');
  });

  await test('keyset and offset walk the same rows in the same order', async () => {
    const byOffset = [];
    for (let off = 0; off < 400; off += 100) {
      const res = await m.runPaged(id, 'p1', 'select id from shop.customers', { limit: 100, offset: off });
      byOffset.push(...ids(res));
    }
    const byKeyset = [];
    let after = null;
    for (let i = 0; i < 4; i++) {
      const res = await m.runPaged(id, 'p1', 'select id from shop.customers', { limit: 100, after });
      byKeyset.push(...ids(res));
      after = res.results[0].page.nextAfter;
      if (!after) break;
    }
    assert.deepStrictEqual(byKeyset, byOffset);
  });

  await test('keyset is used once a key is available, and skipped when it is not', async () => {
    const keyed = await m.runPaged(id, 'p1', 'select id, email from shop.customers', { limit: 5 });
    assert.strictEqual(keyed.results[0].page.keysetSafe, true);
    assert.ok(keyed.results[0].page.nextAfter, 'a cursor is handed back');

    // An aggregate has no unique key in the result, so it must page by offset.
    const agg = await m.runPaged(id, 'p1',
      'select status, count(*) as n from shop.orders group by status', { limit: 2 });
    assert.strictEqual(agg.results[0].page.keysetSafe, false);
    assert.strictEqual(agg.results[0].page.nextAfter, null);
    assert.strictEqual(agg.results[0].rows.length, 2);
    assert.strictEqual(agg.results[0].page.hasMore, true);
  });

  await test('a nullable sort column is not keyset paged', async () => {
    // full_name is nullable: a NULL inside a row comparison would drop rows.
    const res = await m.runPaged(id, 'p1', 'select * from shop.customers',
      { limit: 5, sort: [{ name: 'full_name', dir: 'asc' }] });
    assert.strictEqual(res.results[0].page.keysetSafe, false);
  });

  console.log('\nsorting');

  await test('sorting happens on the server, across the whole table', async () => {
    const res = await m.runPaged(id, 'p1', 'select id, balance from shop.customers',
      { limit: 5, sort: [{ name: 'balance', dir: 'desc' }] });
    const vals = res.results[0].rows.map((r) => Number(r[1]));
    assert.deepStrictEqual(vals, [...vals].sort((a, b) => b - a), 'the page is ordered');

    const max = await m.run(id, 'p1', 'select max(balance) from shop.customers');
    assert.strictEqual(Number(vals[0]), Number(max.results[0].rows[0][0]),
      'the first row is the table maximum, not the maximum of a loaded page');
  });

  await test('sort composes with filters', async () => {
    const res = await m.runPaged(id, 'p1', 'select id, email, balance from shop.customers', {
      limit: 5,
      filters: [{ name: 'balance', op: '>', value: '500' }],
      sort: [{ name: 'balance', dir: 'asc' }],
    });
    const rows = res.results[0].rows;
    assert.ok(rows.every((r) => Number(r[2]) > 500), 'filter applied');
    const vals = rows.map((r) => Number(r[2]));
    assert.deepStrictEqual(vals, [...vals].sort((a, b) => a - b), 'sort applied');
  });

  await test('a paged, sorted, filtered result is still editable', async () => {
    const res = await m.runPaged(id, 'p1', 'select * from shop.customers', {
      limit: 5,
      filters: [{ name: 'balance', op: '>', value: '100' }],
      sort: [{ name: 'email', dir: 'asc' }],
    });
    assert.strictEqual(res.results[0].editable, true, res.results[0].notEditableReason || '');
  });

  console.log('\ncounting');

  await test('counts the whole result, not the page', async () => {
    const { count } = await m.countRows(id, 'p1', 'select * from shop.customers', []);
    assert.strictEqual(count, 2500);
  });

  await test('the count respects filters', async () => {
    const { count } = await m.countRows(id, 'p1', 'select * from shop.customers',
      [{ name: 'email', op: 'ilike', value: '%user1%' }]);
    const check = await m.run(id, 'p1', "select count(*) from shop.customers where email ilike '%user1%'");
    assert.strictEqual(count, Number(check.results[0].rows[0][0]));
  });

  await test('the count respects a caller LIMIT', async () => {
    const { count } = await m.countRows(id, 'p1', 'select * from shop.customers limit 42', []);
    assert.strictEqual(count, 42);
  });

  await test('an error comes back as a result, not a throw', async () => {
    const res = await m.runPaged(id, 'p1', 'select * from nope_missing', { limit: 10 });
    assert.ok(res.results[0].error);
    assert.strictEqual(res.results[0].error.code, '42P01');
  });

  await m.close(id);
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
