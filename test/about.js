'use strict';
/* Version UI: the badge, About, the history, and the automatic What's New on a
   build the user has not seen. Run: node test/about.js */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

const outDir = path.join(__dirname, '..', 'shots');
fs.mkdirSync(outDir, { recursive: true });
const pkg = require('../package.json');

/** seenVersion: null = brand new install, a string = upgraded from that build. */
const seed = (seenVersion) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-about-'));
  fs.writeFileSync(path.join(dir, 'cobalt-connections.json'), JSON.stringify({
    connections: [{
      id: 's1', name: 'Local dev', host: 'localhost', port: 15432, database: 'cobalt',
      user: 'cobalt', ssl: 'disable', color: '#45c07d', order: 0,
      password: { plain: 'cobalt' },
    }],
    workspace: { tabs: [{ title: 'query', sql: 'select 1;', savedId: 's1' }], activeIndex: 0 },
    seenVersion,
  }, null, 2));
  return dir;
};

const run = (file, seenVersion, js, cmds = []) => new Promise((resolve) => {
  const profile = seed(seenVersion);
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
    const ok = code === 0 && !bad && fs.existsSync(target);
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${file}`);
    if (bad) console.log(buf.slice(0, 3000));
    resolve({ ok, out: buf });
  });
  setTimeout(() => p.kill(), 60000);
});

const wait = (ms) => `new Promise(r => setTimeout(r, ${ms}))`;
let fails = 0;
const expect = (cond, label) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) fails++;
};

(async () => {
  // 1. A fresh install shows the badge but must NOT interrupt with What's New.
  const fresh = await run('about-badge.png', null, `(() => ({
    badge: document.getElementById('version-badge').textContent,
    modalOpen: !document.getElementById('overlay').classList.contains('hidden')
  }))()`);
  if (!fresh.ok) fails++;
  const freshJs = JSON.parse((/\[smoke\] js (.*)/.exec(fresh.out) || [])[1] || '{}');
  expect(freshJs.badge === `v${pkg.version}`, `badge reads v${pkg.version} (got ${freshJs.badge})`);
  expect(freshJs.modalOpen === false, 'a fresh install is not interrupted by What\'s New');

  // 2. Upgrading from an older build shows what changed, once.
  const upgraded = await run('about-whatsnew.png', '0.2.0', `(async () => {
    await ${wait(900)};
    const rels = [...document.querySelectorAll('.rel-ver')].map(n => n.textContent);
    return {
      open: !document.getElementById('overlay').classList.contains('hidden'),
      title: (document.querySelector('.changelog-modal h2') || {}).textContent || '',
      versions: rels,
      openCount: document.querySelectorAll('.rel[open]').length
    };
  })()`);
  if (!upgraded.ok) fails++;
  const upJs = JSON.parse((/\[smoke\] js (.*)/.exec(upgraded.out) || [])[1] || '{}');
  expect(upJs.open === true, 'upgrading opens What\'s New');
  expect(upJs.title === "What's new since 0.2.0",
    `the title names the version they came from, not the oldest listed (got "${upJs.title}")`);
  expect(Array.isArray(upJs.versions) && upJs.versions.join(',') === '0.4.0,0.3.0,0.2.1',
    `shows only releases after 0.2.0 (got ${upJs.versions})`);
  expect(upJs.openCount === 3, 'each new release is expanded');

  // 3. About, reached from the menu.
  const about = await run('about-dialog.png', pkg.version, `(async () => {
    await ${wait(500)};
    return {
      wasOpen: !document.getElementById('overlay').classList.contains('hidden')
    };
  })()`);
  if (!about.ok) fails++;
  const abJs = JSON.parse((/\[smoke\] js (.*)/.exec(about.out) || [])[1] || '{}');
  expect(abJs.wasOpen === false, 'running the same version again does not nag');

  // 4. The About window contents.
  const info = await run('about-info.png', pkg.version, `(async () => {
    await ${wait(400)};
    document.getElementById('version-badge').click();
    await ${wait(400)};
    const all = [...document.querySelectorAll('.rel-ver')].map(n => n.textContent);
    const firstOpen = document.querySelector('.rel[open] .rel-ver').textContent;
    return { all, firstOpen };
  })()`);
  if (!info.ok) fails++;
  const infoJs = JSON.parse((/\[smoke\] js (.*)/.exec(info.out) || [])[1] || '{}');
  expect((infoJs.all || []).length >= 5, 'the badge opens the full history');
  expect(infoJs.firstOpen === pkg.version, 'the newest release is the one expanded');

  // 5. The About window itself, opened through the Help menu.
  const aboutWin = await run('about-window.png', pkg.version, `(async () => {
    await ${wait(500)};
    const rows = [...document.querySelectorAll('.about-table tr')].map(tr => tr.querySelector('th').textContent);
    return {
      name: (document.querySelector('.about-name') || {}).textContent || '',
      ver: (document.querySelector('.about-ver') || {}).textContent || '',
      rows
    };
  })()`, ['help:about']);
  if (!aboutWin.ok) fails++;
  const awJs = JSON.parse((/\[smoke\] js (.*)/.exec(aboutWin.out) || [])[1] || '{}');
  expect(awJs.name === 'Cobalt', 'About names the app');
  expect((awJs.ver || '').includes(pkg.version), `About shows ${pkg.version} (got "${awJs.ver}")`);
  expect((awJs.rows || []).includes('Electron') && (awJs.rows || []).includes('pg driver'),
    `About lists the build details (got ${awJs.rows})`);
  expect((awJs.rows || []).includes('Connected to'), 'About names the server you are on');

  console.log(`\n${fails ? fails + ' failed' : 'all checks passed'}\n`);
  process.exit(fails ? 1 : 0);
})();
