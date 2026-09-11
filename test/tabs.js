'use strict';
/* Tab lifecycle: naming, reuse of freed numbers, and the replacement tab you get
   when the last one is closed. Run: node test/tabs.js */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

const outDir = path.join(__dirname, '..', 'shots');
fs.mkdirSync(outDir, { recursive: true });

const seed = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-tabs-'));
  fs.writeFileSync(path.join(dir, 'cobalt-connections.json'), JSON.stringify({
    connections: [{
      id: 's1', name: 'Test DB', host: 'localhost', port: 15432, database: 'cobalt',
      user: 'cobalt', ssl: 'disable', order: 0, password: { plain: 'cobalt' },
    }],
    workspace: { tabs: [{ title: 'Query 1', sql: 'select 1;', savedId: 's1' }], activeIndex: 0 },
    seenVersion: require('../package.json').version,
  }, null, 2));
  return dir;
};

const run = (file, js) => new Promise((resolve) => {
  const profile = seed();
  const target = path.join(outDir, file);
  const p = spawn(electron, ['.', `--smoke=${target}`, `--user-data-dir=${profile}`, `--smoke-js=${js}`],
    { cwd: path.join(__dirname, '..') });
  let buf = '';
  p.stdout.on('data', (d) => { buf += d; process.stdout.write(d); });
  p.stderr.on('data', (d) => { buf += d; });
  p.on('close', (code) => {
    fs.rmSync(profile, { recursive: true, force: true });
    const bad = /\[renderer ERROR\]|Uncaught|is not a function|is not defined/.test(buf);
    if (bad) console.log(buf.slice(0, 3000));
    resolve({ ok: code === 0 && !bad, out: buf });
  });
  setTimeout(() => p.kill(), 60000);
});

const readJs = (out) => JSON.parse((/\[smoke\] js (.*)/.exec(out) || [])[1] || '{}');
const wait = (ms) => `new Promise(r => setTimeout(r, ${ms}))`;

let fails = 0;
const expect = (cond, label) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) fails++;
};

// Helpers injected into the page.
const HELPERS = `
  const titles = () => [...document.querySelectorAll('.tab .t-label')].map(n => n.textContent);
  const addTab = () => document.getElementById('tab-add').click();
  const closeTitled = (t) => {
    const tab = [...document.querySelectorAll('.tab')]
      .find(el => el.querySelector('.t-label').textContent === t);
    tab.querySelector('.t-close').click();
  };
  const closeActive = () => document.querySelector('.tab.active .t-close').click();
`;

(async () => {
  console.log('\ntab naming');

  const seq = await run('tabs-seq.png', `(async () => {
    ${HELPERS}
    addTab(); await ${wait(200)};
    addTab(); await ${wait(200)};
    const afterAdding = titles();
    closeTitled('Query 2'); await ${wait(300)};
    const afterClosing = titles();
    addTab(); await ${wait(300)};
    return { afterAdding, afterClosing, afterReopening: titles() };
  })()`);
  if (!seq.ok) fails++;
  const s = readJs(seq.out);
  expect(JSON.stringify(s.afterAdding) === '["Query 1","Query 2","Query 3"]',
    `new tabs count up (got ${JSON.stringify(s.afterAdding)})`);
  expect(JSON.stringify(s.afterClosing) === '["Query 1","Query 3"]',
    `closing removes the right one (got ${JSON.stringify(s.afterClosing)})`);
  expect(JSON.stringify(s.afterReopening) === '["Query 1","Query 3","Query 2"]',
    `the freed number is reused (got ${JSON.stringify(s.afterReopening)})`);

  console.log('\nhammering the close button');

  // The reported bug: closing the last tab spawns a replacement, and that used to
  // bump the same counter the label came from, so the number ran away.
  const hammer = await run('tabs-hammer.png', `(async () => {
    ${HELPERS}
    for (let i = 0; i < 25; i++) { closeActive(); await ${wait(60)}; }
    const afterHammering = titles();
    addTab(); await ${wait(250)};
    const afterNewTab = titles();
    const st = window.__cobalt();
    return {
      afterHammering,
      afterNewTab,
      tabCount: st.tabs.length,
      ids: st.tabs.map(t => t.id)
    };
  })()`);
  if (!hammer.ok) fails++;
  const h = readJs(hammer.out);
  expect(h.tabCount === 2, `25 closes then one add leaves 2 tabs (got ${h.tabCount})`);
  expect(JSON.stringify(h.afterHammering) === '["Query 1"]',
    `the replacement tab stays Query 1 (got ${JSON.stringify(h.afterHammering)})`);
  expect(JSON.stringify(h.afterNewTab) === '["Query 1","Query 2"]',
    `the next tab is Query 2, not a runaway number (got ${JSON.stringify(h.afterNewTab)})`);
  expect(new Set(h.ids).size === h.ids.length, `tab ids stay unique (got ${JSON.stringify(h.ids)})`);

  console.log('\nnamed tabs are left alone');

  const named = await run('tabs-named.png', `(async () => {
    ${HELPERS}
    addTab(); await ${wait(200)};
    // A table tab carries the table's name, so it must not consume a Query number.
    const row = [...document.querySelectorAll('[data-rel]')]
      .find(r => r.querySelector('.name').textContent === 'customers');
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await ${wait(1600)};
    const withTable = titles();
    addTab(); await ${wait(250)};
    return { withTable, after: titles() };
  })()`);
  if (!named.ok) fails++;
  const n = readJs(named.out);
  expect((n.withTable || []).includes('customers'), `a table tab keeps its own name (got ${JSON.stringify(n.withTable)})`);
  expect(JSON.stringify(n.after) === '["Query 1","Query 2","customers","Query 3"]',
    `named tabs do not consume Query numbers (got ${JSON.stringify(n.after)})`);

  console.log(`\n${fails ? fails + ' failed' : 'all checks passed'}\n`);
  process.exit(fails ? 1 : 0);
})();
