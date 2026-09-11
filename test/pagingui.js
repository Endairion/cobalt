'use strict';
/* Paging and sorting in the real UI. Run: node test/pagingui.js */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

const outDir = path.join(__dirname, '..', 'shots');
fs.mkdirSync(outDir, { recursive: true });

const seed = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-paging-'));
  fs.writeFileSync(path.join(dir, 'cobalt-connections.json'), JSON.stringify({
    connections: [{
      id: 's1', name: 'Test DB', host: 'localhost', port: 15432, database: 'cobalt',
      user: 'cobalt', ssl: 'disable', order: 0, password: { plain: 'cobalt' },
    }],
    workspace: {
      tabs: [{ title: 'customers', sql: 'select id, email, full_name, balance, is_active from shop.customers;', savedId: 's1' }],
      activeIndex: 0,
      pageSize: 200,
    },
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

const HELP = `
  const grid = () => document.querySelector('.grid');
  const rowCount = () => window.__cobaltGridRows();
  const header = (name) => [...document.querySelectorAll('.gh[data-col]')]
    .find(h => h.querySelector('.gh-name').textContent.replace(/[^a-z_]/gi,'') === name);
`;

(async () => {
  console.log('\nscrolling loads more');

  const more = await run('paging-scroll.png', ['query:run'], `(async () => {
    ${HELP}
    await ${wait(1200)};
    const first = rowCount();
    const toolbarBefore = document.getElementById('grid-toolbar').textContent.replace(/\\s+/g,' ').trim();
    // Fall off the end of the loaded rows, three times.
    for (let i = 0; i < 3; i++) {
      grid().scrollTop = grid().scrollHeight;
      grid().dispatchEvent(new Event('scroll'));
      await ${wait(1200)};
    }
    return {
      first,
      after: rowCount(),
      toolbarBefore,
      toolbarAfter: document.getElementById('grid-toolbar').textContent.replace(/\\s+/g,' ').trim()
    };
  })()`);
  if (!more.ok) fails++;
  const m = readJs(more.out);
  expect(m.first === 200, `the first page is one page of 200 (got ${m.first})`);
  expect(m.after > m.first, `scrolling loaded more (${m.first} -> ${m.after})`);
  expect(m.after === 800, `three more pages arrived (got ${m.after})`);
  expect(/keyset/.test(m.toolbarAfter), `keyset paging is in use (toolbar: ${m.toolbarAfter})`);

  console.log('\nsorting hits the server');

  const sorted = await run('paging-sort.png', ['query:run'], `(async () => {
    ${HELP}
    await ${wait(1200)};
    const beforeTop = window.__cobaltCell(0, 3);
    header('balance').click();
    await ${wait(1400)};
    const ascTop = window.__cobaltCell(0, 3);
    const ascRows = rowCount();
    header('balance').click();
    await ${wait(1400)};
    const descTop = window.__cobaltCell(0, 3);
    header('balance').click();
    await ${wait(1400)};
    return {
      beforeTop, ascTop, descTop, ascRows,
      cleared: !document.querySelector('.gh-name').textContent.match(/[↑↓]/),
      sortedRows: rowCount()
    };
  })()`);
  if (!sorted.ok) fails++;
  const s = readJs(sorted.out);
  expect(Number(s.ascTop) < Number(s.descTop), `asc top < desc top (${s.ascTop} vs ${s.descTop})`);
  expect(Number(s.ascTop) <= Number(s.beforeTop), 'ascending starts at the minimum');
  expect(s.ascRows === 200, `sorting reloads one page rather than appending (got ${s.ascRows})`);

  console.log('\ncount all');

  const counted = await run('paging-count.png', ['query:run'], `(async () => {
    ${HELP}
    await ${wait(1200)};
    const btn = document.querySelector('[data-act="count"]');
    const had = !!btn;
    if (btn) btn.click();
    await ${wait(1500)};
    return {
      had,
      toolbar: document.getElementById('grid-toolbar').textContent.replace(/\\s+/g,' ').trim(),
      status: document.getElementById('status-left').textContent
    };
  })()`);
  if (!counted.ok) fails++;
  const c = readJs(counted.out);
  expect(c.had === true, 'a count button is offered while there is more');
  expect(/of 2,500|of 2500/.test(c.toolbar), `the total appears in the toolbar (got ${c.toolbar})`);

  console.log(`\n${fails ? fails + ' failed' : 'all checks passed'}\n`);
  process.exit(fails ? 1 : 0);
})();
