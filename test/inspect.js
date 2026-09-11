'use strict';
/*
 * Ad-hoc UI probe: boot the app against a database, drive it, print what the
 * grid actually rendered, and save a screenshot.
 *
 *   node test/inspect.js "<menu,cmds>" "<js expression>"
 *
 * Defaults to the seeded test database on :15432. Point it somewhere else with
 * COBALT_HOST / COBALT_PORT / COBALT_DB / COBALT_USER / COBALT_PASSWORD, set
 * the opening query with COBALT_SQL, and keep the screenshot with COBALT_OUT.
 * COBALT_READONLY=1 opens the connection read-only, which is what you want when
 * pointing this at a database you care about.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

const cmds = process.argv[2] || 'query:run';
const js = process.argv[3] || '1';
const env = process.env;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-inspect-'));
fs.writeFileSync(path.join(profile, 'cobalt-connections.json'), JSON.stringify({
  connections: [{
    id: 's',
    name: env.COBALT_NAME || 'Test DB',
    host: env.COBALT_HOST || 'localhost',
    port: Number(env.COBALT_PORT) || 15432,
    database: env.COBALT_DB || 'cobalt',
    user: env.COBALT_USER || 'cobalt',
    ssl: 'disable',
    readOnly: env.COBALT_READONLY === '1',
    password: { plain: env.COBALT_PASSWORD === undefined ? 'cobalt' : env.COBALT_PASSWORD },
  }],
  workspace: {
    tabs: [{
      title: env.COBALT_TITLE || 'q',
      sql: env.COBALT_SQL || 'select id, email, full_name, balance from shop.customers order by id limit 500;',
      savedId: 's',
    }],
    activeIndex: 0,
  },
}));

const out = env.COBALT_OUT || path.join(profile, 'shot.png');
const p = spawn(electron, ['.', `--smoke=${[out, ...cmds.split(',')].join(',')}`,
  `--user-data-dir=${profile}`, `--smoke-js=${js}`], { cwd: path.join(__dirname, '..') });
p.stdout.on('data', (d) => process.stdout.write(d));
p.stderr.on('data', (d) => process.stderr.write(d));
p.on('close', () => fs.rmSync(profile, { recursive: true, force: true }));
