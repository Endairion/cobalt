'use strict';
/* Drives the benchmark and plan panels in the real UI. Run: node test/perfui.js */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

const outDir = path.join(__dirname, '..', 'shots');
fs.mkdirSync(outDir, { recursive: true });

// Two ways to ask the same question, one with an index behind it and one without.
const SQL = [
  '-- A: indexed lookup',
  'select c.email, count(o.id) as orders',
  'from shop.customers c join shop.orders o on o.customer_id = c.id',
  'where c.id = 1234',
  'group by c.email;',
  '',
  '-- B: the same answer the slow way',
  'select c.email, count(o.id) as orders',
  'from shop.customers c join shop.orders o on o.customer_id = c.id',
  "where c.email = (select email from shop.customers where id = 1234)",
  'group by c.email;',
].join('\n');

const seed = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-perf-'));
  fs.writeFileSync(path.join(dir, 'cobalt-connections.json'), JSON.stringify({
    connections: [{
      id: 's1', name: 'Test DB', host: 'localhost', port: 15432, database: 'cobalt',
      user: 'cobalt', ssl: 'disable', order: 0, password: { plain: 'cobalt' },
    }],
    workspace: { tabs: [{ title: 'perf', sql: SQL, savedId: 's1' }], activeIndex: 0 },
    seenVersion: require('../package.json').version,
  }, null, 2));
  return dir;
};

const run = (file, cmds, js) => new Promise((resolve) => {
  const profile = seed();
  const target = path.join(outDir, file);
  const args = ['.', `--smoke=${[target, ...cmds].join(',')}`, `--user-data-dir=${profile}`];
  if (js) args.push(`--smoke-js=${js}`);
  const p = spawn(electron, args, { cwd: path.join(__dirname, '..') });
  let buf = '';
  p.stdout.on('data', (d) => { buf += d; process.stdout.write(d); });
  p.stderr.on('data', (d) => { buf += d; });
  p.on('close', (code) => {
    fs.rmSync(profile, { recursive: true, force: true });
    const bad = /\[renderer ERROR\]|Uncaught|is not a function|is not defined/.test(buf);
    if (bad) console.log(buf.slice(0, 3000));
    resolve({ ok: code === 0 && !bad, out: buf });
  });
  setTimeout(() => p.kill(), 120000);
});

const readJs = (out) => JSON.parse((/\[smoke\] js (.*)/.exec(out) || [])[1] || '{}');
const wait = (ms) => `new Promise(r => setTimeout(r, ${ms}))`;

let fails = 0;
const expect = (cond, label) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) fails++;
};

(async () => {
  console.log('\nbenchmark panel');

  const bench = await run('perf-benchmark.png', ['perf:benchmark'], `(async () => {
    await ${wait(500)};
    const dialogVariants = document.querySelectorAll('.bench-variant').length;
    document.getElementById('b-runs').value = '8';
    document.getElementById('b-run').click();
    await ${wait(9000)};
    const rows = [...document.querySelectorAll('.bench-table tbody tr:not(.sqlrow) .bv-label')]
      .map(n => n.textContent);
    return {
      dialogVariants,
      verdict: (document.querySelector('.verdict') || {}).textContent || '',
      verdictClass: (document.querySelector('.verdict') || {}).className || '',
      ranked: rows,
      bars: document.querySelectorAll('.bar-fill').length,
      hasPlansButton: !!document.querySelector('[data-perf="plans"]'),
      status: document.getElementById('status-left').textContent
    };
  })()`);
  if (!bench.ok) fails++;
  const b = readJs(bench.out);
  expect(b.dialogVariants === 2, `the dialog picked up both statements (got ${b.dialogVariants})`);
  expect((b.ranked || []).length === 2, `both variants ranked (got ${JSON.stringify(b.ranked)})`);
  expect(b.bars === 2, 'each variant gets a bar');
  expect(/wins|close to call|Median/.test(b.verdict), `a verdict is stated (got "${(b.verdict || '').slice(0, 80)}")`);
  expect(b.hasPlansButton === true, 'plans were collected and can be shown');

  console.log('\nplan panel');

  const plan = await run('perf-plan.png', ['perf:explainAnalyze'], `(async () => {
    await ${wait(2500)};
    const nodes = [...document.querySelectorAll('.plan-node .pn-type')].map(n => n.textContent);
    const box = document.querySelector('.perf-box');
    const head = document.querySelector('.plan-head');
    return {
      nodes,
      hot: document.querySelectorAll('.plan-node.hot').length,
      pills: [...document.querySelectorAll('.plan-head .pill')].map(n => n.textContent.trim()),
      stats: document.querySelectorAll('.pn-stats').length,
      scrollTop: box.scrollTop,
      headVisible: head.getBoundingClientRect().top >= box.getBoundingClientRect().top
    };
  })()`);
  if (!plan.ok) fails++;
  const pl = readJs(plan.out);
  expect((pl.nodes || []).length > 0, `the plan tree rendered (got ${JSON.stringify(pl.nodes)})`);
  expect(pl.hot === 1, `exactly one node is flagged slowest (got ${pl.hot})`);
  expect((pl.pills || []).some((p) => /execution/.test(p)), `execution time shown (got ${JSON.stringify(pl.pills)})`);
  expect(pl.stats > 0, 'per-node stats rendered');
  expect(pl.scrollTop === 0 && pl.headVisible === true,
    `the panel opens at the top with its header in view (scrollTop ${pl.scrollTop})`);

  console.log(`\n${fails ? fails + ' failed' : 'all checks passed'}\n`);
  process.exit(fails ? 1 : 0);
})();
