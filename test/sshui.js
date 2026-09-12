'use strict';
/* The SSH tunnel in the app: the dialog, and a real connection through a real
   jump host. Run: node test/sshui.js */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');
const { startSshServer } = require('./sshfixture.js');

const outDir = path.join(__dirname, '..', 'shots');
fs.mkdirSync(outDir, { recursive: true });

let fails = 0;
const expect = (cond, label) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) fails++;
};

const readJs = (out) => JSON.parse((/\[smoke\] js (.*)/.exec(out) || [])[1] || '{}');

/** `ssh` is the jump-host block to store, or null for a direct connection. */
const seed = (ssh) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-sshui-'));
  const record = {
    id: 's1', name: 'Behind a bastion', host: 'localhost', port: 15432,
    database: 'cobalt', user: 'cobalt', ssl: 'disable', order: 0,
    password: { plain: 'cobalt' },
  };
  if (ssh) {
    record.ssh = { enabled: true, host: '127.0.0.1', port: ssh.port, user: 'jump', auth: 'password', keyPath: '' };
    record.sshPassword = { plain: ssh.password };
  }
  fs.writeFileSync(path.join(dir, 'cobalt-connections.json'), JSON.stringify({
    connections: [record],
    workspace: {
      tabs: [{ title: 'Query 1', sql: 'select count(*) from shop.customers;', savedId: 's1' }],
      activeIndex: 0, pageSize: 200, openConnections: ['s1'], activeSavedId: 's1',
    },
    seenVersion: require('../package.json').version,
  }, null, 2));
  return dir;
};

const run = (file, js, ssh) => new Promise((resolve) => {
  const profile = seed(ssh);
  const p = spawn(electron, ['.', `--smoke=${path.join(outDir, file)}`,
    `--user-data-dir=${profile}`, `--smoke-js=${js}`], { cwd: path.join(__dirname, '..') });
  let buf = '';
  p.stdout.on('data', (d) => { buf += d; process.stdout.write(d); });
  p.stderr.on('data', (d) => { buf += d; });
  p.on('close', (code) => {
    const saved = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(profile, 'cobalt-connections.json'), 'utf8')); }
      catch { return null; }
    })();
    fs.rmSync(profile, { recursive: true, force: true });
    const bad = /\[renderer ERROR\]|Uncaught|is not a function|is not defined/.test(buf);
    if (bad) console.log(buf.slice(0, 3000));
    resolve({ ok: code === 0 && !bad, out: buf, saved });
  });
  setTimeout(() => p.kill(), 90000);
});

const HELP = `
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const g = (id) => document.getElementById(id);
  const set = (id, v) => { const e = g(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
  const tick = (id, on) => { const e = g(id); e.checked = on; e.dispatchEvent(new Event('change', { bubbles: true })); };
  const pick = (id, v) => { const e = g(id); e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); };
`;

(async () => {
  const sshd = await startSshServer();

  console.log('\nthe tunnel section of the connection dialog');

  const dialog = await run('ssh-dialog.png', `(async () => {
    ${HELP}
    await w(1200);
    window.__cobaltMenu('connection:new');
    await w(500);
    const hiddenAtFirst = g('f-ssh-block').hidden;
    tick('f-ssh', true);
    await w(200);
    const shown = !g('f-ssh-block').hidden;
    const passRowShown = !g('f-ssh-passrow').hidden;
    const keyRowShown = !g('f-ssh-keyrow').hidden;
    // Switching to a key swaps which secret you are asked for.
    pick('f-ssh-auth', 'key');
    await w(200);
    const afterKey = { pass: !g('f-ssh-passrow').hidden, key: !g('f-ssh-keyrow').hidden };
    pick('f-ssh-auth', 'password');
    await w(200);
    const backToPassword = { pass: !g('f-ssh-passrow').hidden, key: !g('f-ssh-keyrow').hidden };
    return { hiddenAtFirst, shown, passRowShown, keyRowShown, afterKey, backToPassword };
  })()`, null);
  if (!dialog.ok) fails++;
  const d = readJs(dialog.out);
  expect(d.hiddenAtFirst === true, 'the tunnel fields are out of the way until you ask for them');
  expect(d.shown === true, 'ticking the box reveals them');
  expect(d.passRowShown === true && d.keyRowShown === false, 'password authentication by default');
  expect(d.afterKey && d.afterKey.key === true && d.afterKey.pass === false,
    'choosing a key asks for the key, not a password');
  expect(d.backToPassword && d.backToPassword.pass === true && d.backToPassword.key === false,
    'and switching back swaps them again');

  console.log('\nwhat the dialog saves');

  const saved = await run('ssh-save.png', `(async () => {
    ${HELP}
    await w(1200);
    window.__cobaltMenu('connection:new');
    await w(500);
    set('f-name', 'Via bastion');
    set('f-host', 'db.internal');
    set('f-port', '5432');
    set('f-db', 'app');
    set('f-user', 'app');
    set('f-pass', 'dbsecret');
    tick('f-ssh', true);
    await w(150);
    set('f-ssh-host', 'bastion.example.com');
    set('f-ssh-port', '2222');
    set('f-ssh-user', 'deploy');
    set('f-ssh-pass', 'jumpsecret');
    g('f-save').click();
    await w(1500);
    const list = await window.cobalt.connections.list();
    const rec = list.find(c => c.name === 'Via bastion');
    return { rec };
  })()`, null);
  const sv = readJs(saved.out);
  const rec = sv.rec || {};
  expect(rec.ssh && rec.ssh.enabled === true, 'the tunnel is saved as enabled');
  expect(rec.ssh && rec.ssh.host === 'bastion.example.com' && rec.ssh.port === 2222 && rec.ssh.user === 'deploy',
    `with its host, port and user (got ${JSON.stringify(rec.ssh)})`);
  expect(rec.hasSshPassword === true, 'and it remembers that there is an SSH password');
  // The renderer must never be handed a secret, only told one exists.
  expect(rec.sshPassword === undefined && rec.password === undefined,
    `no secret is sent to the window (got keys ${JSON.stringify(Object.keys(rec))})`);

  const onDisk = (saved.saved && saved.saved.connections || []).find((c) => c.name === 'Via bastion');
  expect(!!onDisk, 'the record reached the file');
  expect(onDisk && onDisk.sshPassword && !onDisk.sshPassword.plain,
    `the SSH password is encrypted on disk, not in plain text (got ${JSON.stringify(onDisk && onDisk.sshPassword)})`);

  console.log('\nconnecting through a real jump host');

  const live = await run('ssh-live.png', `(async () => {
    ${HELP}
    await w(3000);
    const st = window.__cobalt();
    const conns = [...document.querySelectorAll('.tree-row.conn.live .name')].map(n => n.textContent);
    const tables = [...document.querySelectorAll('.tree-row.rel .name')].map(n => n.textContent);
    window.__cobaltMenu('query:run');
    await w(2200);
    return {
      conns, tables,
      rows: window.__cobaltGridRows(),
      firstCell: window.__cobaltCell(0, 0),
      status: (document.getElementById('status-left') || {}).textContent || ''
    };
  })()`, { port: sshd.port, password: 'secret' });
  if (!live.ok) fails++;
  const l = readJs(live.out);
  expect(JSON.stringify(l.conns) === '["Behind a bastion"]',
    `the connection comes up (got ${JSON.stringify(l.conns)})`);
  expect((l.tables || []).includes('customers'),
    `the schema loads through the tunnel (got ${JSON.stringify((l.tables || []).slice(0, 6))})`);
  expect(l.firstCell === '2500', `a query runs and returns the right answer (got ${JSON.stringify(l.firstCell)})`);
  expect(sshd.state.forwards.some((f) => f.destPort === 15432),
    `the jump host really was asked for the database (got ${JSON.stringify(sshd.state.forwards.slice(0, 3))})`);

  console.log('\na jump host that says no');

  const wrong = await run('ssh-wrong.png', `(async () => {
    ${HELP}
    await w(3500);
    const errs = [...document.querySelectorAll('.toast, .form-msg.err, .tree-row.conn .err')].map(n => n.textContent);
    return {
      live: document.querySelectorAll('.tree-row.conn.live').length,
      errs,
      body: document.body.textContent.includes('rejected the password')
    };
  })()`, { port: sshd.port, password: 'wrong-on-purpose' });
  const w2 = readJs(wrong.out);
  expect(w2.live === 0, `nothing connects (got ${w2.live} live)`);
  expect(w2.body === true || (w2.errs || []).some((t) => /rejected the password/.test(t)),
    `and the window says the jump host rejected the password (got ${JSON.stringify(w2.errs)})`);

  sshd.srv.close();
  console.log(`\n${fails ? `${fails} failed` : 'all checks passed'}\n`);
  process.exit(fails ? 1 : 0);
})();
