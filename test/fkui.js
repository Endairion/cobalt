'use strict';
/* Foreign key travel in the real app. Run: node test/fkui.js */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

const outDir = path.join(__dirname, '..', 'shots');
fs.mkdirSync(outDir, { recursive: true });

const seed = (sql) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-fk-'));
  fs.writeFileSync(path.join(dir, 'cobalt-connections.json'), JSON.stringify({
    connections: [{
      id: 's1', name: 'Test DB', host: 'localhost', port: 15432, database: 'cobalt',
      user: 'cobalt', ssl: 'disable', order: 0, password: { plain: 'cobalt' },
    }],
    workspace: { tabs: [{ title: 'orders', sql, savedId: 's1' }], activeIndex: 0, pageSize: 200 },
    seenVersion: require('../package.json').version,
  }, null, 2));
  return dir;
};

const run = (file, sql, cmds, js) => new Promise((resolve) => {
  const profile = seed(sql);
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
  setTimeout(() => p.kill(), 90000);
});

const readJs = (out) => JSON.parse((/\[smoke\] js (.*)/.exec(out) || [])[1] || '{}');

let fails = 0;
const expect = (cond, label) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) fails++;
};

const HELP = `
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const cellAt = (row, colName) => {
    const cols = [...document.querySelectorAll('.gh[data-col]')];
    const i = cols.findIndex(h => h.querySelector('.gh-name').textContent.replace(/[^a-z_]/gi,'') === colName);
    return document.querySelector('.grow[data-row="' + row + '"] .gc[data-col="' + i + '"]');
  };
  const rightClick = (el) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, clientX: Math.round(r.left + 5), clientY: Math.round(r.top + 5)
    }));
  };
  const menuItems = () => [...document.querySelectorAll('.ctx-item, .ctx-header')]
    .map(n => n.textContent.replace(/\\s+/g, ' ').trim());
`;

(async () => {
  console.log('\nfollowing a key outward');

  const out = await run('fk-menu.png',
    'select id, customer_id, total, status from shop.orders limit 50;', ['query:run'], `(async () => {
    ${HELP}
    await w(1400);
    const fkMarked = [...document.querySelectorAll('.gh')].filter(h => h.querySelector('.gh-fk'))
      .map(h => h.querySelector('.gh-name').textContent.replace(/[^a-z_]/gi,''));
    rightClick(cellAt(0, 'customer_id'));
    await w(400);
    return { fkMarked, items: menuItems() };
  })()`);
  if (!out.ok) fails++;
  const o = readJs(out.out);
  expect(JSON.stringify(o.fkMarked) === '["customer_id"]',
    `the foreign key column is marked in the header (got ${JSON.stringify(o.fkMarked)})`);
  expect((o.items || []).some((t) => /Go to shop\.customers/.test(t)),
    `the menu offers the target row (got ${JSON.stringify(o.items)})`);

  const travel = await run('fk-travel.png',
    'select id, customer_id, total, status from shop.orders limit 50;', ['query:run'], `(async () => {
    ${HELP}
    await w(1400);
    const customerId = window.__cobaltCell(0, 1);
    rightClick(cellAt(0, 'customer_id'));
    await w(400);
    [...document.querySelectorAll('.ctx-item')].find(n => /Go to shop\\.customers/.test(n.textContent)).click();
    await w(2000);
    const st = window.__cobalt();
    return {
      customerId,
      tabs: st.tabs.length,
      sql: window.__cobaltGetSql(),
      rows: window.__cobaltGridRows(),
      landedId: window.__cobaltCell(0, 0)
    };
  })()`);
  if (!travel.ok) fails++;
  const t = readJs(travel.out);
  expect(t.tabs === 2, `it opened a new tab (got ${t.tabs})`);
  expect(/FROM shop\.customers/.test(t.sql || ''), `on the referenced table (got "${(t.sql || '').replace(/\n/g, ' ')}")`);
  expect(t.rows === 1, `showing exactly the referenced row (got ${t.rows})`);
  expect(String(t.landedId) === String(t.customerId),
    `and it is the right row (${t.landedId} vs ${t.customerId})`);

  console.log('\nwalking back to children');

  const back = await run('fk-referenced.png',
    'select c.id, c.email, c.full_name from shop.customers c where exists (select 1 from shop.orders o where o.customer_id = c.id) limit 50;', ['query:run'], `(async () => {
    ${HELP}
    await w(1400);
    const parentId = window.__cobaltCell(0, 0);
    rightClick(cellAt(0, 'id'));
    await w(400);
    const items = menuItems();
    const target = [...document.querySelectorAll('.ctx-item')].find(n => /shop\\.orders/.test(n.textContent));
    const had = !!target;
    if (target) target.click();
    await w(2200);
    return {
      items, had, parentId,
      sql: window.__cobaltGetSql(),
      rows: window.__cobaltGridRows(),
      firstCustomer: window.__cobaltCell(0, 1)
    };
  })()`);
  if (!back.ok) fails++;
  const b = readJs(back.out);
  expect((b.items || []).some((t2) => /Referenced by/i.test(t2)),
    `a "referenced by" section appears (got ${JSON.stringify(b.items)})`);
  expect(b.had === true, 'orders is listed as referencing customers');
  expect(/FROM shop\.orders/.test(b.sql || ''), `it opened the child table (got "${(b.sql || '').replace(/\n/g, ' ')}")`);
  expect(b.rows > 0, `with the matching rows (got ${b.rows})`);
  expect(String(b.firstCustomer) === String(b.parentId),
    `all belonging to that parent (${b.firstCustomer} vs ${b.parentId})`);

  console.log('\na plain column');

  const plain = await run('fk-plain.png',
    'select id, email from shop.customers limit 10;', ['query:run'], `(async () => {
    ${HELP}
    await w(1400);
    rightClick(cellAt(0, 'email'));
    await w(400);
    return { items: menuItems() };
  })()`);
  if (!plain.ok) fails++;
  const pl = readJs(plain.out);
  expect(!(pl.items || []).some((t3) => /^Go to /.test(t3)),
    `no outward travel is offered from a non-key column (got ${JSON.stringify(pl.items)})`);
  expect((pl.items || []).some((t3) => /Copy value/.test(t3)), 'the ordinary actions are still there');

  console.log(`\n${fails ? fails + ' failed' : 'all checks passed'}\n`);
  process.exit(fails ? 1 : 0);
})();
