'use strict';
/* Query history storage. Pure node, no database or Electron needed.
   Run: node test/history.test.js */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { History } = require('../src/main/history');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-hist-'));
let n = 0;
const fresh = (opts) => new History(path.join(dir, `h${++n}.jsonl`), opts);

console.log('\nhistory');

test('records a statement and reads it back', () => {
  const h = fresh();
  const rec = h.append({ sql: 'select 1', connectionId: 'c1', connectionName: 'Local', database: 'app', durationMs: 12.4, rowCount: 1 });
  assert.ok(rec.id && rec.at);
  assert.strictEqual(rec.durationMs, 12, 'durations are rounded');
  const [row] = h.search({});
  assert.strictEqual(row.sql, 'select 1');
  assert.strictEqual(row.connectionName, 'Local');
  assert.strictEqual(row.rowCount, 1);
});

test('ignores an empty statement', () => {
  const h = fresh();
  assert.strictEqual(h.append({ sql: '   ' }), null);
  assert.strictEqual(h.search({}).length, 0);
});

test('newest comes first', () => {
  const h = fresh();
  h.append({ sql: 'select 1' });
  h.append({ sql: 'select 2' });
  h.append({ sql: 'select 3' });
  assert.deepStrictEqual(h.search({}).map((r) => r.sql), ['select 3', 'select 2', 'select 1']);
});

test('consecutive repeats collapse with a run count', () => {
  const h = fresh();
  h.append({ sql: 'select 1', connectionId: 'c1', durationMs: 30 });
  h.append({ sql: 'select 1', connectionId: 'c1', durationMs: 9 });
  h.append({ sql: 'select 1', connectionId: 'c1', durationMs: 20 });
  h.append({ sql: 'select 2', connectionId: 'c1' });
  const rows = h.search({});
  assert.strictEqual(rows.length, 2, 'three identical runs became one row');
  assert.strictEqual(rows[1].runs, 3);
  assert.strictEqual(rows[1].durationMs, 9, 'keeps the fastest run, not the last');
});

test('the same statement on a different connection stays separate', () => {
  const h = fresh();
  h.append({ sql: 'select 1', connectionId: 'c1' });
  h.append({ sql: 'select 1', connectionId: 'c2' });
  assert.strictEqual(h.search({}).length, 2);
});

test('non-consecutive repeats are not merged', () => {
  const h = fresh();
  h.append({ sql: 'select 1', connectionId: 'c1' });
  h.append({ sql: 'select 2', connectionId: 'c1' });
  h.append({ sql: 'select 1', connectionId: 'c1' });
  const rows = h.search({});
  assert.strictEqual(rows.length, 3, 'history stays chronological');
  assert.ok(rows.every((r) => r.runs === 1));
});

test('search matches every term, across sql and connection', () => {
  const h = fresh();
  h.append({ sql: 'select * from customers', connectionName: 'Local' });
  h.append({ sql: 'select * from orders', connectionName: 'Prod' });
  assert.strictEqual(h.search({ q: 'customers' }).length, 1);
  assert.strictEqual(h.search({ q: 'SELECT CUSTOMERS' }).length, 1, 'case-insensitive, order-free');
  assert.strictEqual(h.search({ q: 'orders prod' }).length, 1, 'matches the connection name too');
  assert.strictEqual(h.search({ q: 'orders nope' }).length, 0, 'every term must match');
});

test('filters by connection and by failure', () => {
  const h = fresh();
  h.append({ sql: 'select 1', connectionId: 'c1' });
  h.append({ sql: 'select 2', connectionId: 'c2' });
  h.append({ sql: 'select bad', connectionId: 'c1', error: 'column "bad" does not exist' });
  assert.strictEqual(h.search({ connectionId: 'c1' }).length, 2);
  assert.strictEqual(h.search({ failedOnly: true }).length, 1);
  assert.strictEqual(h.search({ connectionId: 'c2', failedOnly: true }).length, 0);
});

test('limit caps the collapsed rows', () => {
  const h = fresh();
  for (let i = 0; i < 50; i++) h.append({ sql: `select ${i}` });
  assert.strictEqual(h.search({ limit: 10 }).length, 10);
});

test('a torn line does not lose the rest of the file', () => {
  const h = fresh();
  h.append({ sql: 'select 1' });
  fs.appendFileSync(h.file, '{"sql":"hal\n', 'utf8');   // interrupted write
  h.append({ sql: 'select 2' });
  const rows = h.search({});
  assert.strictEqual(rows.length, 2, 'the good entries still load');
  assert.deepStrictEqual(rows.map((r) => r.sql), ['select 2', 'select 1']);
});

test('a missing file reads as empty rather than throwing', () => {
  const h = new History(path.join(dir, 'does-not-exist.jsonl'));
  assert.deepStrictEqual(h.search({}), []);
  assert.strictEqual(h.stats().entries, 0);
});

test('trim keeps the newest entries', () => {
  const h = fresh({ maxEntries: 10 });
  for (let i = 0; i < 25; i++) h.append({ sql: `select ${i}` });
  assert.strictEqual(h.trim(), 10);
  const rows = h.search({ limit: 100 });
  assert.strictEqual(rows.length, 10);
  assert.strictEqual(rows[0].sql, 'select 24', 'newest survives');
  assert.strictEqual(rows[9].sql, 'select 15', 'oldest were dropped');
});

test('trim is a no-op below the limit', () => {
  const h = fresh({ maxEntries: 100 });
  for (let i = 0; i < 5; i++) h.append({ sql: `select ${i}` });
  assert.strictEqual(h.trim(), 5);
  assert.strictEqual(h.search({}).length, 5);
});

test('clear empties the history', () => {
  const h = fresh();
  h.append({ sql: 'select 1' });
  h.clear();
  assert.strictEqual(h.search({}).length, 0);
  h.append({ sql: 'select 2' });
  assert.strictEqual(h.search({}).length, 1, 'and it still records afterwards');
});

test('stats report size and age', () => {
  const h = fresh();
  h.append({ sql: 'select 1' });
  h.append({ sql: 'select 2' });
  const st = h.stats();
  assert.strictEqual(st.entries, 2);
  assert.ok(st.bytes > 0);
  assert.ok(st.oldest);
});

test('appending is cheap enough to sit in the query path', () => {
  const h = fresh();
  const started = Date.now();
  for (let i = 0; i < 500; i++) h.append({ sql: `select ${i} from some_table where x = ${i}` });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3000, `500 appends took ${elapsed}ms`);
  assert.strictEqual(h.all().length, 500);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
