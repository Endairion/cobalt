'use strict';
/* Exercises the connection manager: several saved connections, connecting two
   of them at once, the grouped sidebar tree, and the manager dialog.
   Run: node test/manager.js   (needs cobalt-test-pg on :15432) */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

const outDir = path.join(__dirname, '..', 'shots');
fs.mkdirSync(outDir, { recursive: true });

const conn = (id, name, group, color, readOnly) => ({
  id, name, group, color, readOnly,
  host: 'localhost', port: 15432, database: 'cobalt', user: 'cobalt',
  ssl: 'disable', password: { plain: 'cobalt' },
});

const seed = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-mgr-'));
  fs.writeFileSync(path.join(dir, 'cobalt-connections.json'), JSON.stringify({
    connections: [
      { ...conn('s1', 'Local dev', 'Development', '#45c07d', false), order: 0 },
      { ...conn('s2', 'Staging', 'Development', '#e0a33c', false), order: 1 },
      { ...conn('s3', 'Production', 'Production', '#f2695c', true), order: 2 },
      { ...conn('s4', 'Analytics replica', 'Production', '#b07cf0', true), order: 3 },
    ],
    workspace: {
      tabs: [{ title: 'query', sql: 'select * from shop.customers limit 200;', savedId: 's1' }],
      activeIndex: 0,
    },
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
    const ok = code === 0 && !bad && fs.existsSync(target) && fs.statSync(target).size > 10000;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${file}`);
    if (bad) console.log(buf.slice(0, 3000));
    resolve(ok);
  });
  setTimeout(() => p.kill(), 60000);
});

const wait = (ms) => `new Promise(r => setTimeout(r, ${ms}))`;

(async () => {
  let fails = 0;

  // Connect two of the four, leaving the others listed but closed.
  const connectTwo = `(async () => {
    const click = (id) => document.querySelector('[data-conn="' + id + '"]').click();
    click('s1'); await ${wait(2200)};
    click('s3'); await ${wait(2600)};
    return {
      connRows: document.querySelectorAll('.tree-row.conn').length,
      live: document.querySelectorAll('.tree-row.conn.live').length,
      groups: [...document.querySelectorAll('.tree-group-label')].map(n => n.textContent),
      tables: document.querySelectorAll('.tree-row.rel').length,
      picker: document.getElementById('btn-conn').textContent,
      roFlags: document.querySelectorAll('.tree-row.conn .ro-flag').length
    };
  })()`;
  if (!await run('mgr-sidebar.png', ['query:run'], connectTwo)) fails++;

  // The manager dialog itself.
  const openManager = `(async () => {
    document.querySelector('[data-conn="s1"]').click(); await ${wait(2200)};
    document.querySelector('[data-manage]').click(); await ${wait(700)};
    document.querySelector('.mgr-row[data-id="s3"]').click(); await ${wait(400)};
    return {
      rows: document.querySelectorAll('.mgr-row').length,
      selected: document.querySelector('.mgr-row.sel .mgr-name').textContent,
      formName: document.getElementById('c-name').value,
      readOnlyChecked: document.getElementById('c-ro').checked,
      swatchOn: document.querySelector('.swatch.on').getAttribute('data-color'),
      hasConnect: !!document.getElementById('c-connect')
    };
  })()`;
  if (!await run('mgr-dialog.png', [], openManager)) fails++;

  // Rebinding the active tab to a different connection.
  const rebind = `(async () => {
    const click = (id) => document.querySelector('[data-conn="' + id + '"]').click();
    click('s1'); await ${wait(2200)};
    click('s2'); await ${wait(2400)};
    const before = window.__cobalt().tabs[0].connId;
    document.getElementById('btn-conn').click(); await ${wait(350)};
    const items = [...document.querySelectorAll('.ctx-item')];
    items.find(i => i.textContent.trim() === 'Staging').click();
    await ${wait(700)};
    const st = window.__cobalt();
    return { before, after: st.tabs[0].connId, picker: document.getElementById('btn-conn').textContent };
  })()`;
  if (!await run('mgr-rebind.png', [], rebind)) fails++;

  process.exit(fails ? 1 : 0);
})();
