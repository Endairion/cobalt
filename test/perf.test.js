'use strict';
/* Benchmark + EXPLAIN. Run: node test/perf.test.js  (needs cobalt-test-pg on :15432) */

const assert = require('assert');
const { Manager, isReadOnlyStatement } = require('../src/main/db');
const { quantile, summarize, compare, ratioLabel } = require('../src/shared/stats');

const CFG = { host: 'localhost', port: 15432, database: 'cobalt', user: 'cobalt', password: 'cobalt' };

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

(async () => {
  console.log('\nstatistics');

  await test('quantile interpolates', () => {
    const v = [1, 2, 3, 4];
    assert.strictEqual(quantile(v, 0), 1);
    assert.strictEqual(quantile(v, 1), 4);
    assert.strictEqual(quantile(v, 0.5), 2.5);
    assert.strictEqual(quantile([7], 0.5), 7);
  });

  await test('summarize reports median, not mean, for skewed samples', () => {
    const s = summarize([10, 10, 10, 10, 500]);   // one outlier
    assert.strictEqual(s.n, 5);
    assert.strictEqual(s.median, 10, 'median ignores the outlier');
    assert.ok(s.mean > 100, 'mean does not');
    assert.strictEqual(s.min, 10);
    assert.strictEqual(s.max, 500);
  });

  await test('a clear gap is called a win', () => {
    const c = compare([
      { label: 'A', stats: summarize([10, 11, 10, 12, 11]) },
      { label: 'B', stats: summarize([50, 52, 49, 51, 50]) },
    ]);
    assert.strictEqual(c.verdict, 'decisive');
    assert.strictEqual(c.winner.label, 'A');
    assert.ok(c.ratio > 4);
  });

  await test('overlapping timings are called a tie, not a win', () => {
    const c = compare([
      { label: 'A', stats: summarize([10, 14, 11, 16, 12]) },
      { label: 'B', stats: summarize([11, 15, 12, 17, 13]) },
    ]);
    assert.strictEqual(c.verdict, 'tie');
    assert.strictEqual(c.winner, null, 'no winner is crowned on noise');
  });

  await test('a small but separated gap is "clear", not "decisive"', () => {
    const c = compare([
      { label: 'A', stats: summarize([10, 10.1, 10.2, 10.1, 10]) },
      { label: 'B', stats: summarize([13, 13.1, 13.2, 13.1, 13]) },
    ]);
    assert.strictEqual(c.verdict, 'clear');
    assert.ok(c.ratio > 1.2 && c.ratio < 2);
  });

  await test('one variant reports without comparing', () => {
    const c = compare([{ label: 'A', stats: summarize([5, 6, 7]) }]);
    assert.strictEqual(c.verdict, 'single');
    assert.strictEqual(c.ranked.length, 1);
  });

  await test('ratioLabel phrases sensibly', () => {
    assert.match(ratioLabel(3), /3\.00x faster/);
    assert.match(ratioLabel(1.06), /6% faster/);
    assert.strictEqual(ratioLabel(1), 'about the same');
  });

  console.log('\nread-only detection');

  await test('reads are recognised through comments', () => {
    assert.ok(isReadOnlyStatement('select 1'));
    assert.ok(isReadOnlyStatement('  \n-- note\n /* block */ SELECT 1'));
    assert.ok(isReadOnlyStatement('with x as (select 1) select * from x'));
    assert.ok(isReadOnlyStatement('table shop.customers'));
    assert.ok(isReadOnlyStatement('values (1),(2)'));
  });

  await test('writes are recognised, including inside a CTE', () => {
    assert.ok(!isReadOnlyStatement('update shop.customers set balance = 0'));
    assert.ok(!isReadOnlyStatement('insert into t values (1)'));
    assert.ok(!isReadOnlyStatement('truncate t'));
    assert.ok(!isReadOnlyStatement('with d as (delete from t returning *) select * from d'),
      'a data-modifying CTE is not read-only');
  });

  const m = new Manager();
  const { id } = await m.open(CFG);

  console.log('\nbenchmark');

  await test('compares two variants and ranks them', async () => {
    const res = await m.benchmark(id, 'b1', [
      { label: 'A', sql: 'select * from shop.customers where id = 500' },
      { label: 'B', sql: 'select * from shop.customers where email = (select email from shop.customers where id = 500)' },
    ], { runs: 5, warmups: 1, collectPlans: false });

    assert.strictEqual(res.kind, 'benchmark');
    assert.strictEqual(res.variants.length, 2);
    for (const v of res.variants) {
      assert.strictEqual(v.samples.length, 5, `${v.label} has 5 timed samples`);
      assert.ok(v.stats.median > 0);
      assert.strictEqual(v.error, null);
    }
    assert.strictEqual(res.comparison.ranked.length, 2);
    assert.ok(['tie', 'clear', 'decisive'].includes(res.comparison.verdict));
  });

  await test('warmup runs are excluded from the samples', async () => {
    const res = await m.benchmark(id, 'b1', [{ label: 'A', sql: 'select 1' }],
      { runs: 3, warmups: 5, collectPlans: false });
    assert.strictEqual(res.variants[0].samples.length, 3, 'only the timed runs are kept');
  });

  await test('collects planning and execution time per variant', async () => {
    const res = await m.benchmark(id, 'b1', [
      { label: 'A', sql: 'select count(*) from shop.orders' },
    ], { runs: 2, warmups: 0, collectPlans: true });
    const p = res.variants[0].plan;
    assert.ok(p, 'a plan came back');
    assert.ok(p.executionMs >= 0 && p.planningMs >= 0);
    assert.ok(p.plan && p.plan['Node Type'], 'the plan tree is present');
  });

  await test('a failing variant is reported without sinking the run', async () => {
    const res = await m.benchmark(id, 'b1', [
      { label: 'A', sql: 'select 1' },
      { label: 'B', sql: 'select * from does_not_exist' },
    ], { runs: 3, warmups: 0, collectPlans: false });
    assert.strictEqual(res.variants[0].samples.length, 3);
    assert.ok(res.variants[1].error, 'the broken one carries its error');
    assert.strictEqual(res.variants[1].samples.length, 0);
    assert.strictEqual(res.comparison.ranked.length, 1, 'only the working variant is ranked');
  });

  await test('refuses to benchmark a write unless rollback is on', async () => {
    const before = (await m.run(id, 'b1', 'select count(*) from shop.audit_log')).results[0].rows[0][0];
    await assert.rejects(
      () => m.benchmark(id, 'b1', [{ label: 'A', sql: "insert into shop.audit_log (actor, action) values ('bench','x')" }],
        { runs: 5, warmups: 0 }),
      /roll back/i
    );
    const after = (await m.run(id, 'b1', 'select count(*) from shop.audit_log')).results[0].rows[0][0];
    assert.strictEqual(after, before, 'nothing was inserted');
  });

  await test('with rollback on, a write is timed but leaves nothing behind', async () => {
    const count = async () => (await m.run(id, 'b1', 'select count(*) from shop.audit_log')).results[0].rows[0][0];
    const before = await count();
    const res = await m.benchmark(id, 'b1', [
      { label: 'A', sql: "insert into shop.audit_log (actor, action) values ('bench','x')" },
    ], { runs: 4, warmups: 1, rollback: true, collectPlans: false });
    assert.strictEqual(res.variants[0].samples.length, 4);
    assert.strictEqual(res.variants[0].error, null);
    assert.strictEqual(await count(), before, 'every run was rolled back');
  });

  await test('interleaving means each variant is measured the same number of times', async () => {
    const res = await m.benchmark(id, 'b1', [
      { label: 'A', sql: 'select 1' },
      { label: 'B', sql: 'select 2' },
      { label: 'C', sql: 'select 3' },
    ], { runs: 4, warmups: 0, collectPlans: false });
    assert.deepStrictEqual(res.variants.map((v) => v.samples.length), [4, 4, 4]);
  });

  console.log('\nexplain');

  await test('plain explain does not execute the query', async () => {
    const count = async () => (await m.run(id, 'b1', 'select count(*) from shop.audit_log')).results[0].rows[0][0];
    const before = await count();
    const res = await m.explain(id, 'b1', "insert into shop.audit_log (actor, action) values ('x','y')", { analyze: false });
    assert.strictEqual(res.kind, 'plan');
    assert.strictEqual(res.analyze, false);
    assert.ok(res.plan['Node Type']);
    assert.strictEqual(res.executionMs, null, 'no execution time without analyze');
    assert.strictEqual(await count(), before, 'nothing was written');
  });

  await test('explain analyze on a select reports timings and a tree', async () => {
    const res = await m.explain(id, 'b1', 'select * from shop.orders where total > 100 order by total desc limit 20',
      { analyze: true });
    assert.ok(res.executionMs > 0, 'execution time present');
    assert.ok(res.planningMs >= 0, 'planning time present');
    assert.ok(res.plan['Actual Rows'] != null, 'actual row counts present');
    assert.strictEqual(res.rolledBack, false, 'a select needs no transaction');
  });

  await test('explain analyze on a write rolls the write back', async () => {
    const count = async () => (await m.run(id, 'b1', 'select count(*) from shop.audit_log')).results[0].rows[0][0];
    const before = await count();
    const res = await m.explain(id, 'b1', "insert into shop.audit_log (actor, action) values ('x','y')", { analyze: true });
    assert.strictEqual(res.rolledBack, true);
    assert.strictEqual(typeof res.executionMs, 'number', 'it really did run');
    assert.strictEqual(await count(), before, 'and was then undone');
  });

  await test('a broken statement comes back as an error, not a throw', async () => {
    const res = await m.explain(id, 'b1', 'select * from nope_missing', { analyze: false });
    assert.ok(res.error);
    assert.strictEqual(res.error.code, '42P01');
  });

  await test('an index scan is visible in the plan', async () => {
    const res = await m.explain(id, 'b1', 'select * from shop.customers where id = 42', { analyze: true });
    const types = [];
    (function walk(n) { types.push(n['Node Type']); (n.Plans || []).forEach(walk); })(res.plan);
    assert.ok(types.some((t) => /Index/.test(t)), `expected an index scan, got ${types.join(', ')}`);
  });

  await m.close(id);
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
