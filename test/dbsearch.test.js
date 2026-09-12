'use strict';
/* Find in database: the SQL it builds, and finding things in both engines.
   Run: node test/dbsearch.test.js */

const assert = require('assert');
const { Manager } = require('../src/main/db.js');
const pg = require('../src/main/drivers/postgres.js');
const my = require('../src/main/drivers/mysql.js');
const {
  escapeLike, isSearchableType, buildSearchQuery, buildRowFilter, searchableColumns,
} = require('../src/shared/dbsearch.js');

let n = 0;
const check = async (label, fn) => {
  try { await fn(); n++; console.log(`  ok   ${label}`); }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); process.exitCode = 1; }
};

const PG = {
  id: 'pg', name: 'PG', engine: 'postgres',
  host: 'localhost', port: 15432, database: 'cobalt', user: 'cobalt', password: 'cobalt', ssl: 'disable',
};
const MY = {
  id: 'my', name: 'MySQL', engine: 'mysql',
  host: '127.0.0.1', port: 13306, database: 'cobalt', user: 'cobalt', password: 'cobalt', ssl: 'disable',
};

console.log('\nwhat counts as a literal');

// The bug that makes a search tool useless: "100%" matching every row.
check('LIKE wildcards in the needle are escaped', () => {
  assert.strictEqual(escapeLike('100%'), '100!%');
  assert.strictEqual(escapeLike('a_b'), 'a!_b');
  assert.strictEqual(escapeLike('plain'), 'plain');
});

check('the escape character escapes itself', () => {
  assert.strictEqual(escapeLike('wow!'), 'wow!!');
});

// A backslash would need to be written differently on each engine; ! does not.
check('a backslash in the needle is left alone, not treated as an escape', () => {
  assert.strictEqual(escapeLike('C:\\path'), 'C:\\path');
});

console.log('\nwhich columns are worth looking in');

check('text and its relatives, in either engine', () => {
  for (const t of ['text', 'varchar(255)', 'character varying', 'citext', 'uuid', 'jsonb', 'longtext', 'enum(\'a\')']) {
    assert.ok(isSearchableType(t), `${t} should be searchable`);
  }
});

check('numbers and dates only when asked', () => {
  assert.strictEqual(isSearchableType('bigint'), false);
  assert.strictEqual(isSearchableType('timestamptz'), false);
  assert.strictEqual(isSearchableType('bigint', { includeNumeric: true }), true);
  assert.strictEqual(isSearchableType('timestamp', { includeNumeric: true }), true);
  assert.strictEqual(isSearchableType('boolean', { includeNumeric: true }), true);
});

check('binary never, in either engine — a hex haystack helps nobody', () => {
  for (const t of ['bytea', 'blob', 'longblob', 'varbinary(16)', 'geometry']) {
    assert.strictEqual(isSearchableType(t, { includeNumeric: true }), false, t);
  }
});

check('a relation is filtered down to its searchable columns', () => {
  const rel = { columns: [
    { name: 'id', type: 'bigint' }, { name: 'email', type: 'text' },
    { name: 'blob', type: 'bytea' }, { name: 'prefs', type: 'jsonb' },
  ] };
  assert.deepStrictEqual(searchableColumns(rel, {}).map((c) => c.name), ['email', 'prefs']);
  assert.deepStrictEqual(searchableColumns(rel, { includeNumeric: true }).map((c) => c.name),
    ['id', 'email', 'prefs']);
});

console.log('\nthe query it builds');

const cols = [{ name: 'email', type: 'text' }, { name: 'notes', type: 'text' }];

// MySQL's ? is positional, so a placeholder reused for one bound value runs the
// list dry and leaves a bare ? in the SQL. The invariant that holds on both
// engines is one bound value per mark.
const countMarks = (text, dialect) => (dialect === pg
  ? (text.match(/\$\d+/g) || []).length
  : (text.match(/\?/g) || []).length);

check('every placeholder has exactly one bound value, on either engine', () => {
  for (const d of [pg, my]) {
    const q = buildSearchQuery({ dialect: d, schema: 's', table: 't', columns: cols, needle: 'x' });
    assert.strictEqual(countMarks(q.text, d), q.values.length,
      `${d.id}: ${countMarks(q.text, d)} placeholders for ${q.values.length} values`);
    assert.strictEqual(q.values.length, 4, `${d.id}: two columns, each counted and sampled`);
  }
});

check('a count and a sample per column, and one row scanned count', () => {
  const q = buildSearchQuery({ dialect: pg, schema: 's', table: 't', columns: cols, needle: 'x' });
  assert.ok(/as m0/.test(q.text) && /as s0/.test(q.text));
  assert.ok(/as m1/.test(q.text) && /as s1/.test(q.text));
  assert.ok(/count\(\*\) as scanned/.test(q.text));
});

check('the row cap wraps the table rather than the result', () => {
  const q = buildSearchQuery({ dialect: pg, schema: 's', table: 't', columns: cols, needle: 'x', rowCap: 1000 });
  assert.ok(/from \(select "email", "notes" from "s"\."t" limit 1000\)/.test(q.text), q.text);
  const none = buildSearchQuery({ dialect: pg, schema: 's', table: 't', columns: cols, needle: 'x', rowCap: null });
  assert.ok(/from "s"\."t"$/m.test(none.text), none.text);
});

check('each engine gets its own casting, quoting and placeholders', () => {
  const p = buildSearchQuery({ dialect: pg, schema: 's', table: 't', columns: cols, needle: 'x' });
  const m = buildSearchQuery({ dialect: my, schema: 's', table: 't', columns: cols, needle: 'x' });
  assert.ok(/"email"::text/.test(p.text), p.text);
  assert.ok(/ilike \$1/.test(p.text), p.text);
  assert.ok(/cast\(`email` as char\)/.test(m.text), m.text);
  assert.ok(/like lower\(\?\)/.test(m.text) && !/ilike/.test(m.text), m.text);
});

check('case sensitivity changes the comparison, not just the operator', () => {
  const ci = buildSearchQuery({ dialect: my, schema: 's', table: 't', columns: cols, needle: 'x' });
  const cs = buildSearchQuery({ dialect: my, schema: 's', table: 't', columns: cols, needle: 'x', caseSensitive: true });
  assert.ok(/lower\(/.test(ci.text), 'MySQL has no ILIKE, so both sides are lowered');
  assert.ok(!/lower\(cast/.test(cs.text), cs.text);
});

check('exact match does not use LIKE at all', () => {
  const q = buildSearchQuery({ dialect: pg, schema: 's', table: 't', columns: cols, needle: 'x', mode: 'exact' });
  assert.ok(!/like/i.test(q.text), q.text);
  assert.deepStrictEqual(q.values, ['x', 'x', 'x', 'x']);
});

check('starts-with anchors the pattern at the front only', () => {
  const q = buildSearchQuery({ dialect: pg, schema: 's', table: 't', columns: cols, needle: 'ab', mode: 'starts' });
  assert.deepStrictEqual(q.values, ['ab%', 'ab%', 'ab%', 'ab%']);
});

check('no searchable columns is refused rather than producing broken SQL', () => {
  assert.throws(() => buildSearchQuery({ dialect: pg, schema: 's', table: 't', columns: [], needle: 'x' }),
    /No searchable columns/);
});

console.log('\nthe filter that opens the matching rows');

check('the needle goes in as a literal, quotes and all', () => {
  const f = buildRowFilter({ dialect: pg, column: 'notes', needle: "o'brien" });
  assert.ok(f.includes("'%o''brien%'"), f);
});

check('and its wildcards are still escaped', () => {
  assert.ok(buildRowFilter({ dialect: pg, column: 'c', needle: '50%' }).includes('50!%'));
});

(async () => {
  console.log('\nfinding things in Postgres');

  const m = new Manager();
  const conn = await m.open(PG);
  const id = conn.id;

  await check('it finds a value and says which column held it', async () => {
    const r = await m.searchDatabase(id, 'search', { needle: 'user1234@example.com' });
    // Checked first: every table failing would otherwise read as "found nothing".
    assert.deepStrictEqual(r.errors, [], `tables errored: ${JSON.stringify(r.errors.slice(0, 2))}`);
    const hit = r.matches.find((x) => x.table === 'customers' && x.column === 'email');
    assert.ok(hit, `expected a hit in customers.email, got ${JSON.stringify(r.matches)}`);
    assert.strictEqual(hit.count, 1);
    assert.strictEqual(hit.sample, 'user1234@example.com');
  });

  await check('it looks in more than one table', async () => {
    const r = await m.searchDatabase(id, 'search', { needle: 'precision' });
    assert.ok(r.matches.some((x) => x.table === 'docs'), JSON.stringify(r.matches));
  });

  await check('it looks inside a json column', async () => {
    const r = await m.searchDatabase(id, 'search', { needle: 'gold' });
    const hit = r.matches.find((x) => x.column === 'prefs');
    assert.ok(hit, `expected a hit in the jsonb column, got ${JSON.stringify(r.matches.map((x) => x.column))}`);
    assert.ok(hit.count > 100, `gold is every third customer, got ${hit.count}`);
  });

  // The whole reason the wildcards are escaped.
  await check('a percent sign is a character, not a wildcard', async () => {
    const r = await m.searchDatabase(id, 'search', { needle: '%' });
    assert.strictEqual(r.matches.length, 0,
      `searching for "%" should match nothing here, got ${JSON.stringify(r.matches.slice(0, 3))}`);
  });

  await check('numbers are skipped unless asked for', async () => {
    const without = await m.searchDatabase(id, 'search', { needle: '1234' });
    const withNums = await m.searchDatabase(id, 'search', { needle: '1234', includeNumeric: true });
    assert.ok(withNums.matches.length > without.matches.length,
      `including numerics should widen the net: ${without.matches.length} -> ${withNums.matches.length}`);
    assert.ok(withNums.matches.some((x) => x.column === 'id'), 'an id column should be in there');
  });

  await check('views are skipped, since their tables are already being scanned', async () => {
    const r = await m.searchDatabase(id, 'search', { needle: 'user1@example.com' });
    assert.ok(!r.matches.some((x) => x.table === 'order_totals'), 'a view should not be scanned');
    assert.ok(r.skippedViews >= 1, `expected to have skipped one, got ${r.skippedViews}`);
  });

  await check('the row cap bounds the scan and says it was capped', async () => {
    const r = await m.searchDatabase(id, 'search', { needle: 'Customer', rowCap: 100 });
    const hit = r.matches.find((x) => x.table === 'customers');
    assert.ok(hit, 'should still find some');
    assert.strictEqual(hit.scanned, 100, `should have scanned exactly the cap, got ${hit.scanned}`);
    assert.strictEqual(hit.capped, true);
    assert.ok(hit.count <= 100);
  });

  await check('an uncapped search sees the whole table', async () => {
    const r = await m.searchDatabase(id, 'search', { needle: 'Customer', rowCap: null });
    const hit = r.matches.find((x) => x.table === 'customers');
    assert.strictEqual(hit.scanned, 2500);
    assert.strictEqual(hit.capped, false);
  });

  await check('nothing found is an empty answer, not an error', async () => {
    const r = await m.searchDatabase(id, 'search', { needle: 'zzz-not-in-this-database-zzz' });
    assert.deepStrictEqual(r.matches, []);
    assert.ok(r.scannedTables > 0, 'it still scanned');
    assert.deepStrictEqual(r.errors, []);
  });

  await check('an empty needle is refused before any scanning', async () => {
    await assert.rejects(() => m.searchDatabase(id, 'search', { needle: '' }), /Type something/);
  });

  await check('it reports what it covered', async () => {
    const r = await m.searchDatabase(id, 'search', { needle: 'precision' });
    assert.ok(r.scannedTables >= 3, `got ${r.scannedTables}`);
    assert.strictEqual(r.scannedTables, r.totalTables);
    assert.ok(r.elapsedMs >= 0);
    assert.strictEqual(r.cancelled, false);
  });

  await check('the filter it hands back really selects those rows', async () => {
    const where = m.searchFilter(id, { column: 'email', needle: 'user1234@example.com' });
    const r = await m.runPaged(id, 'search2', 'select id, email from shop.customers', { limit: 10, where });
    assert.strictEqual(r.results[0].rows.length, 1);
    assert.strictEqual(r.results[0].rows[0][1], 'user1234@example.com');
  });

  console.log('\nand in MySQL');

  const conn2 = await m.open(MY);
  const id2 = conn2.id;

  await check('the same search works on the other engine', async () => {
    const r = await m.searchDatabase(id2, 'search', { needle: 'user1234@example.com' });
    assert.deepStrictEqual(r.errors, [], `tables errored: ${JSON.stringify(r.errors.slice(0, 2))}`);
    const hit = r.matches.find((x) => x.table === 'customers' && x.column === 'email');
    assert.ok(hit, `got ${JSON.stringify(r.matches)}`);
    assert.strictEqual(hit.count, 1);
  });

  await check('including a json column', async () => {
    const r = await m.searchDatabase(id2, 'search', { needle: 'gold' });
    assert.ok(r.matches.some((x) => x.column === 'prefs'), JSON.stringify(r.matches.map((x) => x.column)));
  });

  await check('a percent sign is still a character there too', async () => {
    const r = await m.searchDatabase(id2, 'search', { needle: '%' });
    assert.strictEqual(r.matches.length, 0, JSON.stringify(r.matches.slice(0, 3)));
  });

  await check('and the filter it hands back works on MySQL syntax', async () => {
    const where = m.searchFilter(id2, { column: 'email', needle: 'user1234@example.com' });
    const r = await m.runPaged(id2, 'search2', 'select id, email from customers', { limit: 10, where });
    assert.ok(!r.results[0].error, r.results[0].error && r.results[0].error.message);
    assert.strictEqual(r.results[0].rows.length, 1);
  });

  await m.closeAll();
  console.log(`\n${process.exitCode ? 'failures above' : `all ${n} checks passed`}\n`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
