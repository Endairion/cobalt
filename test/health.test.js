'use strict';
/* The health snapshot, against both live servers. Run: node test/health.test.js */

const assert = require('assert');
const { Manager } = require('../src/main/db.js');
const { bytes, duration, hitVerdict, asText } = require('../src/renderer/health.js');

const PG = {
  id: 'pg', name: 'PG', engine: 'postgres',
  host: 'localhost', port: 15432, database: 'cobalt', user: 'cobalt', password: 'cobalt', ssl: 'disable',
};
const MY = {
  id: 'my', name: 'MySQL', engine: 'mysql',
  host: '127.0.0.1', port: 13306, database: 'cobalt', user: 'cobalt', password: 'cobalt', ssl: 'disable',
};

let n = 0;
const check = async (label, fn) => {
  try { await fn(); n++; console.log(`  ok   ${label}`); }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); process.exitCode = 1; }
};

/** The shape both engines must produce, so the panel needs no branch. */
const assertShape = (s, engine) => {
  assert.strictEqual(s.engine, engine);
  for (const key of ['sizeBytes', 'connections', 'maxConnections', 'uptimeSeconds']) {
    assert.ok(Number.isFinite(s[key]), `${key} should be a number, got ${JSON.stringify(s[key])}`);
  }
  assert.ok(s.cacheHitRatio === null || (s.cacheHitRatio >= 0 && s.cacheHitRatio <= 1),
    `cacheHitRatio out of range: ${s.cacheHitRatio}`);
  for (const list of ['memory', 'counters', 'biggest', 'vacuum', 'unusedIndexes']) {
    assert.ok(Array.isArray(s[list]), `${list} should be an array`);
  }
  for (const m of s.memory) assert.ok(m.name, 'a memory setting needs a name');
  for (const c of s.counters) {
    assert.ok(c.name, 'a counter needs a name');
    assert.ok(Number.isFinite(c.value), `counter ${c.name} is not a number: ${c.value}`);
  }
  for (const t of s.biggest) {
    assert.ok(t.name && Number.isFinite(t.bytes), `bad table row: ${JSON.stringify(t)}`);
  }
};

console.log('\nformatting');

check('bytes reads in the unit that suits the size, and unknown is not zero', () => {
  assert.strictEqual(bytes(0), '0 B');
  assert.strictEqual(bytes(undefined), '—');
  assert.strictEqual(bytes(512), '512 B');
  assert.strictEqual(bytes(2048), '2 KB');
  assert.strictEqual(bytes(5 * 1024 * 1024), '5.0 MB');
  assert.strictEqual(bytes(3 * 1024 * 1024 * 1024), '3.00 GB');
  assert.strictEqual(bytes(null), '—');
});

check('durations read in the unit that suits the span', () => {
  assert.strictEqual(duration(30), '30s');
  assert.strictEqual(duration(120), '2m');
  assert.strictEqual(duration(3700), '1h 1m');
  assert.strictEqual(duration(90000), '1d 1h');
});

check('the cache verdict says what the number means', () => {
  assert.strictEqual(hitVerdict(0.999).level, 'good');
  assert.strictEqual(hitVerdict(0.97).level, 'ok');
  assert.strictEqual(hitVerdict(0.6).level, 'warn');
  assert.ok(/too small/.test(hitVerdict(0.6).text));
  assert.strictEqual(hitVerdict(null).level, 'none');
});

(async () => {
  console.log('\nPostgres');

  const m = new Manager();
  const pg = await m.open(PG);
  let pgStats;

  await check('it reads without throwing, in the shape the panel expects', async () => {
    pgStats = await m.serverStats(pg.id);
    assertShape(pgStats, 'postgres');
  });

  await check('the size is real and the database is named', () => {
    assert.ok(pgStats.sizeBytes > 100000, `a seeded database should not be ${pgStats.sizeBytes} bytes`);
    assert.strictEqual(pgStats.database, 'cobalt');
  });

  await check('connections are counted against the server limit', () => {
    assert.ok(pgStats.connections >= 1, 'we are connected, so at least one');
    assert.ok(pgStats.maxConnections >= pgStats.connections);
  });

  await check('the memory settings are the ones worth knowing', () => {
    const names = pgStats.memory.map((x) => x.name);
    assert.deepStrictEqual(names,
      ['shared_buffers', 'effective_cache_size', 'work_mem', 'maintenance_work_mem']);
    assert.ok(/\d/.test(String(pgStats.memory[0].value)), `shared_buffers looks wrong: ${pgStats.memory[0].value}`);
  });

  await check('the biggest tables are ordered by size and split data from indexes', () => {
    assert.ok(pgStats.biggest.length >= 3, `expected several tables, got ${pgStats.biggest.length}`);
    const sizes = pgStats.biggest.map((t) => t.bytes);
    assert.deepStrictEqual(sizes, [...sizes].sort((a, b) => b - a), 'not ordered by size');
    const orders = pgStats.biggest.find((t) => t.name === 'orders');
    assert.ok(orders, `orders should be in the list: ${pgStats.biggest.map((t) => t.name)}`);
    assert.ok(orders.indexBytes > 0, 'orders has an index, so that should not be zero');
    assert.strictEqual(orders.bytes, orders.tableBytes + orders.indexBytes);
  });

  await check('dead rows are found after some are deleted', async () => {
    try {
      await m.ddl(pg.id, 'create table if not exists shop.churn (id int primary key, pad text)');
      await m.run(pg.id, 'churnTab',
        "insert into shop.churn select g, repeat('x', 100) from generate_series(1, 500) g on conflict do nothing");
      await m.run(pg.id, 'churnTab', 'delete from shop.churn');
      // A backend reports its stats on its own schedule, and the one that did
      // the work is now sitting idle. Closing it flushes them, which turns a
      // wait-and-hope into something that actually settles.
      await m.releaseTab(pg.id, 'churnTab');

      let found = null;
      for (let i = 0; i < 40 && !found; i++) {
        const s = await m.serverStats(pg.id);
        found = s.vacuum.find((v) => v.name === 'churn');
        if (!found) await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(found, 'a table with 500 deleted rows should show dead tuples');
      assert.ok(found.deadTuples > 0, `got ${found && found.deadTuples}`);
      assert.strictEqual(found.liveTuples, 0);
    } finally {
      // Always, so a failure does not leave the table behind to skew the next run.
      await m.ddl(pg.id, 'drop table if exists shop.churn').catch(() => {});
    }
  });

  await check('an index nothing reads is reported, and a primary key is not', async () => {
    try {
      await m.ddl(pg.id, 'create table if not exists shop.idxprobe (id int primary key, a int, b int)');
      await m.ddl(pg.id, 'create index if not exists idxprobe_never_read on shop.idxprobe (a)');
      const s = await m.serverStats(pg.id);
      const names = s.unusedIndexes.map((i) => i.name);
      assert.ok(names.includes('idxprobe_never_read'), `expected it in ${JSON.stringify(names)}`);
      assert.ok(!names.some((x) => /pkey/.test(x)),
        `a primary key is not an unused index: ${JSON.stringify(names)}`);
    } finally {
      await m.ddl(pg.id, 'drop table if exists shop.idxprobe').catch(() => {});
    }
  });

  await check('counters are totals, with a note on the ones that mean trouble', () => {
    const byName = new Map(pgStats.counters.map((c) => [c.name, c]));
    assert.ok(byName.get('commits').value > 0, 'something has committed by now');
    assert.ok(byName.has('temp files'), 'spilling to disk is worth surfacing');
    assert.ok(byName.get('temp files').note, 'and worth explaining');
    assert.ok(byName.has('deadlocks'));
  });

  console.log('\nMySQL');

  const my = await m.open(MY);
  let myStats;

  await check('the same shape comes back, so the panel needs no branch', async () => {
    myStats = await m.serverStats(my.id);
    assertShape(myStats, 'mysql');
  });

  await check('the buffer pool is the headline memory setting', () => {
    const names = myStats.memory.map((x) => x.name);
    assert.ok(names[0] === 'innodb_buffer_pool_size', `got ${JSON.stringify(names)}`);
    // Readable, not nine digits of bytes — the same as Postgres reports.
    assert.ok(/^\d+(\.\d+)?(B|kB|MB|GB)$/.test(String(myStats.memory[0].value)),
      `expected a formatted size, got ${myStats.memory[0].value}`);
    assert.ok(/%/.test(String(myStats.memory[1].value)), 'the pool usage should be a percentage');
  });

  await check('size and tables come from the connected database', () => {
    assert.ok(myStats.sizeBytes > 10000, `got ${myStats.sizeBytes}`);
    assert.ok(myStats.biggest.some((t) => t.name === 'customers'),
      `expected customers in ${JSON.stringify(myStats.biggest.map((t) => t.name))}`);
    assert.ok(myStats.biggest.every((t) => t.schema === 'cobalt'));
  });

  await check('InnoDB has no vacuum to chase, and says so by reporting none', () => {
    assert.deepStrictEqual(myStats.vacuum, []);
  });

  await check('the cache hit ratio is computed from the pool counters', () => {
    assert.ok(myStats.cacheHitRatio > 0.5, `a warm pool should be well above half: ${myStats.cacheHitRatio}`);
  });

  console.log('\nthe text version');

  check('it names both halves and is pasteable', () => {
    const text = asText(pgStats, {
      totalMemoryBytes: 300 * 1024 * 1024,
      totalCpuPercent: 4.2,
      processes: [{ type: 'Browser', memoryBytes: 100 * 1024 * 1024, cpuPercent: 1 }],
      versions: {},
    }, { tabs: 3, rows: 1200, dirty: 0 });
    assert.ok(/^Server/.test(text), text.slice(0, 40));
    assert.ok(/cache hit/.test(text));
    assert.ok(/Cobalt/.test(text));
    assert.ok(/300\.0 MB/.test(text), text);
    assert.ok(/3 tabs, 1,200 rows/.test(text), text);
  });

  await m.closeAll();
  console.log(`\n${process.exitCode ? 'failures above' : `all ${n} checks passed`}\n`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
