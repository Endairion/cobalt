'use strict';
/* Postgres through a real SSH tunnel: querying, sessions, cancel, cleanup.
   Run: node test/sshdb.test.js */

const assert = require('assert');
const net = require('net');
const { Manager } = require('../src/main/db.js');
const { startSshServer } = require('./sshfixture.js');

const DB = { host: 'localhost', port: 15432, database: 'cobalt', user: 'cobalt', password: 'cobalt', ssl: 'disable' };

let n = 0;
const withTimeout = (p, ms) => Promise.race([
  Promise.resolve(p),
  new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms).unref()),
]);
const check = async (label, fn) => {
  try { await withTimeout(fn(), 25000); n++; console.log(`  ok   ${label}`); }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); process.exitCode = 1; }
};

(async () => {
  const sshd = await startSshServer();
  const through = (extra = {}) => ({
    ...DB,
    id: 'x',
    name: 'Through the jump box',
    ssh: { enabled: true, host: '127.0.0.1', port: sshd.port, user: 'jump', auth: 'password', password: 'secret' },
    ...extra,
  });

  console.log('\nquerying through the tunnel');

  const m = new Manager();
  let id;

  await check('it connects and reports the server it reached', async () => {
    const info = await m.open(through());
    id = info.id;
    assert.ok(/^1[5-9]|^\d\d/.test(String(info.serverVersion)), `got ${info.serverVersion}`);
    assert.strictEqual(info.database, 'cobalt');
  });

  await check('the driver is talking to the local end, not the database host', () => {
    const conn = m.get(id);
    assert.strictEqual(conn.endpoint.host, '127.0.0.1');
    assert.notStrictEqual(conn.endpoint.port, 15432, 'that would mean no tunnel was used');
    assert.strictEqual(conn.clientConfig().port, conn.endpoint.port);
  });

  await check('the jump host was asked for the real database address', () => {
    const last = sshd.state.forwards[sshd.state.forwards.length - 1];
    assert.strictEqual(last.destPort, 15432);
  });

  await check('a query returns rows', async () => {
    const { results } = await m.run(id, 'tab1', 'select count(*)::text from shop.customers');
    assert.strictEqual(results[0].rows[0][0], '2500');
  });

  await check('a wide read survives the forwarding', async () => {
    // Enough bytes to need many TCP segments through the channel.
    const { results } = await m.run(id, 'tab1', 'select id, email, prefs from shop.customers order by id limit 2000');
    assert.strictEqual(results[0].rows.length, 2000);
    assert.strictEqual(results[0].rows[1999][0], '2000');
  });

  await check('the schema tree loads', async () => {
    const tree = await m.schemaTree(id);
    const shop = tree.schemas.find((s) => s.name === 'shop');
    assert.ok(shop.relations.find((r) => r.name === 'customers'));
  });

  await check('each tab still gets its own session', async () => {
    await m.run(id, 'tabA', 'create temp table t_ssh (x int); insert into t_ssh values (1);');
    const a = await m.run(id, 'tabA', 'select count(*)::text from t_ssh');
    assert.strictEqual(a.results[0].rows[0][0], '1');
    // run() reports a statement error inside the result rather than throwing.
    const b = await m.run(id, 'tabB', 'select count(*) from t_ssh');
    assert.ok(b.results[0].error, 'the other tab should not see the temp table');
    assert.ok(/does not exist/.test(b.results[0].error.message), b.results[0].error.message);
  });

  await check('cancel reaches the backend through its own forward', async () => {
    const started = Date.now();
    const slow = m.run(id, 'tabSlow', 'select pg_sleep(20)');
    await new Promise((r) => setTimeout(r, 900));
    assert.strictEqual(await m.cancel(id, 'tabSlow'), true);
    const { results } = await slow;
    assert.ok(results[0].error, 'expected a cancellation error');
    assert.strictEqual(results[0].error.code, '57014');
    assert.ok(Date.now() - started < 10000, 'and it should come back promptly');
  });

  await check('an edit commits through the tunnel', async () => {
    const { results } = await m.run(id, 'tab1',
      "select id, full_name from shop.customers where id = 1");
    const r = results[0];
    const nameIdx = r.columns.findIndex((c) => c.name === 'full_name');
    const before = r.rows[0][nameIdx];
    await m.applyChanges(id, {
      source: r.source, columns: r.columns, key: r.key,
      updates: [{ keyValues: [r.rows[0][0]], set: { [nameIdx]: 'through the tunnel' } }],
    });
    const after = await m.run(id, 'tab1', 'select full_name from shop.customers where id = 1');
    assert.strictEqual(after.results[0].rows[0][0], 'through the tunnel');
    await m.applyChanges(id, {
      source: r.source, columns: r.columns, key: r.key,
      updates: [{ keyValues: [r.rows[0][0]], set: { [nameIdx]: before } }],
    });
  });

  console.log('\nclosing up');

  let localPort;
  await check('closing the connection takes the tunnel with it', async () => {
    localPort = m.get(id).endpoint.port;
    await m.close(id);
    await assert.rejects(() => new Promise((resolve, reject) => {
      const s = net.connect(localPort, '127.0.0.1', () => { s.end(); resolve(); });
      s.on('error', reject);
      s.setTimeout(3000, () => { s.destroy(); reject(new Error('timed out')); });
    }), /ECONNREFUSED|ECONNRESET|timed out/);
  });

  console.log('\nwhen the jump box is wrong');

  await check('a bad SSH password fails before the database is dialled', async () => {
    const bad = new Manager();
    await assert.rejects(
      () => bad.open(through({ ssh: { enabled: true, host: '127.0.0.1', port: sshd.port, user: 'jump', auth: 'password', password: 'nope' } })),
      (e) => /rejected the password/.test(e.message));
  });

  await check('a database the jump host cannot reach says so, not "connection closed"', async () => {
    const strict = await startSshServer({ allowForward: false });
    const m2 = new Manager();
    await assert.rejects(
      () => m2.open(through({
        ssh: { enabled: true, host: '127.0.0.1', port: strict.port, user: 'jump', auth: 'password', password: 'secret' },
      })),
      (e) => /could not reach localhost:15432/.test(e.message)
        && /through jump@127\.0\.0\.1/.test(e.message));
    strict.srv.close();
  });

  await check('no tunnel configured still connects directly', async () => {
    const direct = new Manager();
    const info = await direct.open({ ...DB, id: 'd', name: 'Direct' });
    assert.strictEqual(direct.get(info.id).tunnel, null);
    assert.strictEqual(direct.get(info.id).clientConfig().port, 15432);
    await direct.closeAll();
  });

  await m.closeAll();
  sshd.srv.close();
  console.log(`\n${process.exitCode ? 'failures above' : `all ${n} checks passed`}\n`);
  process.exit(process.exitCode || 0);
})();
