'use strict';
/* Read-only exercise of the data layer against a real database.
   SELECT and catalog queries only — never writes. Reports shapes, not values.
   Usage: node test/realdb.js [port] [database] [user] */

const { Manager } = require('../src/main/db');

const CFG = {
  host: 'localhost',
  port: Number(process.argv[2]) || 5434,
  database: process.argv[3] || 'overland',
  user: process.argv[4] || 'postgres',
  password: process.env.PGPASSWORD || '',
};

(async () => {
  const m = new Manager();
  let t0 = Date.now();
  const { id, serverVersion } = await m.open(CFG);
  console.log(`connected to ${CFG.database} — PostgreSQL ${serverVersion} (${Date.now() - t0} ms)\n`);

  t0 = Date.now();
  const tree = await m.schemaTree(id);
  const schemaMs = Date.now() - t0;
  const rels = tree.schemas.flatMap((s) => s.relations.map((r) => ({ ...r, schema: s.name })));
  const cols = rels.reduce((a, r) => a + r.columns.length, 0);
  console.log(`schema load: ${schemaMs} ms — ${tree.schemas.length} schemas, ${rels.length} relations, ${cols} columns`);
  console.log(`  kinds: ${['r', 'p', 'v', 'm', 'f'].map((k) => `${k}=${rels.filter((r) => r.kind === k).length}`).join(' ')}`);
  console.log(`  widest relation: ${Math.max(...rels.map((r) => r.columns.length))} columns`);

  const tables = rels.filter((r) => r.kind === 'r' || r.kind === 'p');
  const biggest = [...tables].sort((a, b) => b.estRows - a.estRows).slice(0, 12);
  console.log('\nlargest tables (estimated rows):');
  for (const t of biggest) console.log(`  ${`${t.schema}.${t.name}`.padEnd(46)} ${String(t.estRows).padStart(12)}`);

  // Editability detection across every table: how many would the grid let you edit?
  console.log('\neditability of "select * from <table> limit 1" across all tables:');
  const verdicts = { editable: 0, noKey: 0, other: 0 };
  const noKey = [];
  let slowest = { name: null, ms: 0 };
  for (const t of tables) {
    const q = `select * from "${t.schema}"."${t.name}" limit 1`;
    const started = Date.now();
    let r;
    try { r = (await m.run(id, 'probe', q, { maxRows: 1 })).results[0]; }
    catch { verdicts.other++; continue; }
    const ms = Date.now() - started;
    if (ms > slowest.ms) slowest = { name: `${t.schema}.${t.name}`, ms };
    if (r.error) { verdicts.other++; continue; }
    if (r.editable) verdicts.editable++;
    else if (/key/i.test(r.notEditableReason || '')) { verdicts.noKey++; noKey.push(`${t.schema}.${t.name}`); }
    else verdicts.other++;
  }
  console.log(`  editable: ${verdicts.editable} / ${tables.length}`);
  console.log(`  no usable key: ${verdicts.noKey}${noKey.length ? ` (${noKey.slice(0, 8).join(', ')}${noKey.length > 8 ? ', …' : ''})` : ''}`);
  console.log(`  other: ${verdicts.other}`);
  console.log(`  slowest describe: ${slowest.name} at ${slowest.ms} ms`);

  // DDL for a sample of tables — exercises the catalog queries on real shapes.
  console.log('\nDDL generation:');
  let ddlOk = 0, ddlFail = [];
  for (const t of tables.slice(0, 40)) {
    try { const d = await m.tableDdl(id, t.schema, t.name); if (d.includes('CREATE TABLE')) ddlOk++; }
    catch (e) { ddlFail.push(`${t.schema}.${t.name}: ${e.message}`); }
  }
  console.log(`  ${ddlOk} ok, ${ddlFail.length} failed${ddlFail.length ? '\n   ' + ddlFail.join('\n   ') : ''}`);

  // Wide read against the biggest table, to time the path the grid actually uses.
  if (biggest[0]) {
    const big = biggest[0];
    const q = `select * from "${big.schema}"."${big.name}" limit 5000`;
    const started = Date.now();
    const r = (await m.run(id, 'probe', q, { maxRows: 5000 })).results[0];
    console.log(`\nwide read: ${big.schema}.${big.name} limit 5000 -> ${r.rows.length} rows, ${r.columns.length} cols in ${Date.now() - started} ms`);
    console.log(`  editable: ${r.editable}${r.editable ? '' : ` (${r.notEditableReason})`}`);
    console.log(`  column types seen: ${[...new Set(r.columns.map((c) => c.dataType).filter(Boolean))].slice(0, 14).join(', ')}`);

    // And the same read through the filter path.
    const fstarted = Date.now();
    const f = await m.runFiltered(id, 'probe', q, [{ name: r.columns[0].name, op: 'is not null' }], { maxRows: 5000 });
    console.log(`  filtered (${r.columns[0].name} is not null): ${f.results[0].error ? 'ERROR ' + f.results[0].error.message : `${f.results[0].rows.length} rows in ${Date.now() - fstarted} ms`}`);
  }

  await m.close(id);
  console.log('\ndone — no writes were issued.');
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
