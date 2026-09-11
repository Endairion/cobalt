'use strict';
/* Ad-hoc UI probe: run the app, drive it, and print what the grid rendered.
   node test/inspect.js "<menu,cmds>" "<js expression>" */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

const cmds = process.argv[2] || 'query:run';
const js = process.argv[3] || '1';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-inspect-'));
fs.writeFileSync(path.join(profile, 'cobalt-connections.json'), JSON.stringify({
  connections: [{
    id: 's', name: 'Test DB', host: 'localhost', port: 15432,
    database: 'cobalt', user: 'cobalt', ssl: 'disable', password: { plain: 'cobalt' },
  }],
  workspace: {
    tabs: [{
      title: 'c',
      sql: 'select id, email, full_name, balance from shop.customers order by id limit 500;',
      savedId: 's',
    }],
    activeIndex: 0,
  },
}));

const out = path.join(profile, 'shot.png');
const p = spawn(electron, ['.', `--smoke=${[out, ...cmds.split(',')].join(',')}`,
  `--user-data-dir=${profile}`, `--smoke-js=${js}`], { cwd: path.join(__dirname, '..') });
p.stdout.on('data', (d) => process.stdout.write(d));
p.stderr.on('data', (d) => process.stderr.write(d));
p.on('close', () => fs.rmSync(profile, { recursive: true, force: true }));
