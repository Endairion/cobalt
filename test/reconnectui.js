'use strict';
/* Startup connects something, and restores what was open. Run: node test/reconnectui.js */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

const outDir = path.join(__dirname, '..', 'shots');
fs.mkdirSync(outDir, { recursive: true });

const conn = (id, name, port) => ({
  id, name, host: 'localhost', port, database: 'cobalt', user: 'cobalt',
  ssl: 'disable', password: { plain: 'cobalt' },
});

/** Three saved connections, all pointing at the fixture database. */
const seed = (workspace) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-rc-'));
  fs.writeFileSync(path.join(dir, 'cobalt-connections.json'), JSON.stringify({
    connections: [
      { ...conn('a', 'First', 15432), order: 0 },
      { ...conn('b', 'Second', 15432), order: 1 },
      { ...conn('c', 'Third', 15432), order: 2 },
    ],
    workspace,
    seenVersion: require('../package.json').version,
  }, null, 2));
  return dir;
};

const run = (file, workspace, js) => new Promise((resolve) => {
  const profile = seed(workspace);
  const p = spawn(electron, ['.', `--smoke=${path.join(outDir, file)}`,
    `--user-data-dir=${profile}`, `--smoke-js=${js}`], { cwd: path.join(__dirname, '..') });
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

const REPORT = `(() => {
  const st = window.__cobalt();
  return {
    live: document.querySelectorAll('.tree-row.conn.live').length,
    names: [...document.querySelectorAll('.tree-row.conn.live .name')].map(n => n.textContent),
    active: (document.querySelector('.tree-row.conn.active .name') || {}).textContent || null,
    tabHasConnection: !!st.tabs[st.tabs.findIndex(t => t.id === st.activeTabId)].connId,
    picker: document.getElementById('btn-conn').textContent
  };
})()`;

(async () => {
  console.log('\nnothing remembered yet');

  // Several saved connections and no record of what was open: the old behaviour
  // was to connect none of them, which made every command refuse.
  const fresh = await run('rc-fresh.png',
    { tabs: [{ title: 'Query 1', sql: 'select 1;', savedId: null }], activeIndex: 0 }, REPORT);
  if (!fresh.ok) fails++;
  const f = readJs(fresh.out);
  expect(f.live === 1, `one connection opens rather than none (got ${f.live})`);
  expect(f.names[0] === 'First', `the first saved one (got ${JSON.stringify(f.names)})`);
  expect(f.tabHasConnection === true, 'and the tab is attached to it');

  console.log('\nrestoring what was open');

  const restored = await run('rc-restored.png', {
    tabs: [{ title: 'Query 1', sql: 'select 1;', savedId: 'b' }],
    activeIndex: 0,
    openConnections: ['a', 'c'],
    activeSavedId: 'c',
  }, REPORT);
  if (!restored.ok) fails++;
  const r = readJs(restored.out);
  expect(r.live === 2, `both remembered connections reopen (got ${r.live})`);
  expect(JSON.stringify(r.names) === '["First","Third"]',
    `exactly the ones that were open (got ${JSON.stringify(r.names)})`);
  expect(r.active === 'Third', `the one that was focused stays focused (got ${r.active})`);

  console.log('\na connection that has gone away');

  const missing = await run('rc-missing.png', {
    tabs: [{ title: 'Query 1', sql: 'select 1;', savedId: 'a' }],
    activeIndex: 0,
    openConnections: ['a', 'deleted-since'],
    activeSavedId: 'a',
  }, REPORT);
  if (!missing.ok) fails++;
  const m = readJs(missing.out);
  expect(m.live === 1, `the surviving one still opens (got ${m.live})`);
  expect(m.tabHasConnection === true, 'and the tab is usable');

  console.log(`\n${fails ? fails + ' failed' : 'all checks passed'}\n`);
  process.exit(fails ? 1 : 0);
})();
