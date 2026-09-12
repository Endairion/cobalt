'use strict';
/* Boots the real Electron UI against the test database, drives a few menu
   commands and saves screenshots. Run: node test/smoke.js [outDir] */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const outDir = process.argv[2] || path.join(__dirname, '..', 'shots');
fs.mkdirSync(outDir, { recursive: true });

// A fresh profile per shot: the app persists workspace changes (active tab,
// pane sizes) as it goes, so a shared profile would make shots order-dependent.
const seed = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-smoke-'));
  fs.writeFileSync(path.join(dir, 'cobalt-connections.json'), JSON.stringify({
  connections: [{
    id: 'smoke', name: 'Test DB', host: 'localhost', port: 15432,
    database: 'cobalt', user: 'cobalt', ssl: 'disable', readOnly: false,
    password: { plain: 'cobalt' },
  }],
  workspace: {
    tabs: [
      { title: 'customers', sql: 'select id, email, full_name, balance, is_active, signed_up, prefs, notes\nfrom shop.customers\norder by id\nlimit 500;', savedId: 'smoke' },
      { title: 'report', sql: "select status, count(*) as orders, round(sum(total), 2) as revenue\nfrom shop.orders\ngroup by status\norder by revenue desc;", savedId: 'smoke' },
      { title: 'broken', sql: 'select id, emial\nfrom shop.customers\nwhere id < 10;', savedId: 'smoke' },
    ],
    activeIndex: 0,
  },
}, null, 2));
  return dir;
};

const electron = require('electron');
const shots = [
  { file: 'grid.png', cmds: ['query:run'] },
  { file: 'new-row.png', cmds: ['query:run', 'grid:addRow'] },
  { file: 'palette.png', cmds: ['palette:tables'] },
  { file: 'report.png', cmds: ['tab:next', 'query:run'] },
  { file: 'error.png', cmds: ['tab:next', 'tab:next', 'query:run'] },
  {
    file: 'filter.png',
    cmds: ['query:run', 'grid:filter'],
    // One expression across columns, the way a person would type it.
    js: `(() => {
      const i = document.getElementById('fb-input');
      i.value = "full_name ilike '%customer 1%' and balance >= 500";
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`,
  },
];

(async () => {
  let failures = 0;
  for (const s of shots) {
    const profile = seed();
    const target = path.join(outDir, s.file);
    const args = ['.', `--smoke=${[target, ...s.cmds].join(',')}`, `--user-data-dir=${profile}`];
    if (s.js) args.push(`--smoke-js=${s.js}`);
    const code = await new Promise((resolve) => {
      const p = spawn(electron, args, { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '';
      p.stdout.on('data', (d) => { buf += d; process.stdout.write(d); });
      p.stderr.on('data', (d) => { buf += d; });
      p.on('close', (c) => {
        const bad = /\[renderer ERROR\]|Uncaught|is not a function|is not defined/.test(buf);
        if (bad) { console.log('--- renderer errors detected ---\n' + buf.slice(0, 4000)); resolve(1); }
        else resolve(c);
      });
      setTimeout(() => p.kill(), 60000);
    });
    fs.rmSync(profile, { recursive: true, force: true });
    const ok = code === 0 && fs.existsSync(target) && fs.statSync(target).size > 10000;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${s.file}${ok ? ` (${Math.round(fs.statSync(target).size / 1024)} kB)` : ''}`);
    if (!ok) failures++;
  }
  process.exit(failures ? 1 : 0);
})();
