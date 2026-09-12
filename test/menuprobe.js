'use strict';
/* Fire every menu command in turn and report what each one did.
   Run: node test/menuprobe.js [profileToCopy] */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');
const { commandIds } = require('../src/shared/commands');

const source = process.argv[2] || path.join(process.env.APPDATA || '', 'cobalt');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-menuprobe-'));
for (const f of ['cobalt-connections.json', 'Local State']) {
  const from = path.join(source, f);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(profile, f));
}
console.log(`probing with a copy of ${source}`);

// Commands that open a window or change the app in a way the probe cannot undo.
const SKIP = new Set(['tab:close', 'file:open', 'file:save']);
const ids = commandIds().filter((id) => !SKIP.has(id));

const js = `(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const ids = ${JSON.stringify(ids)};
  const out = [];
  for (const id of ids) {
    const before = {
      overlay: !document.getElementById('overlay').classList.contains('hidden'),
      menus: document.querySelectorAll('.ctx-menu, .col-panel').length,
      tabs: window.__cobalt().tabs.length,
      toasts: document.querySelectorAll('.toast').length
    };
    let threw = null;
    try { window.__cobaltMenu(id); } catch (e) { threw = e.message; }
    await w(260);
    const after = {
      overlay: !document.getElementById('overlay').classList.contains('hidden'),
      menus: document.querySelectorAll('.ctx-menu, .col-panel').length,
      tabs: window.__cobalt().tabs.length,
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent)
    };
    const changed = after.overlay !== before.overlay
      || after.menus !== before.menus
      || after.tabs !== before.tabs
      || after.toasts.length !== before.toasts;
    out.push({ id, threw, changed, toast: after.toasts[after.toasts.length - 1] || null });
    // Close anything that opened, so the next command starts clean.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.querySelectorAll('.ctx-menu, .col-panel').forEach(n => n.remove());
    await w(120);
  }
  return out;
})()`;

const p = spawn(electron, ['.', `--smoke=${path.join(profile, 'shot.png')}`,
  `--user-data-dir=${profile}`, `--smoke-js=${js}`], { cwd: path.join(__dirname, '..') });
let buf = '';
p.stdout.on('data', (d) => { buf += d; });
p.stderr.on('data', (d) => { buf += d; });
p.on('close', () => {
  fs.rmSync(profile, { recursive: true, force: true });
  const errs = buf.match(/\[renderer ERROR\][^\n]*/g) || [];
  if (errs.length) {
    console.log('\nrenderer errors:');
    for (const e of [...new Set(errs)]) console.log('  ' + e.slice(0, 200));
  }
  const m = /\[smoke\] js (.*)/.exec(buf);
  if (!m) {
    console.log('\nno result; raw output:\n' + buf.slice(0, 2500));
    process.exit(1);
  }
  const rows = JSON.parse(m[1]);
  console.log('\ncommand                       effect');
  for (const r of rows) {
    const note = r.threw ? `THREW ${r.threw}`
      : r.changed ? 'did something'
      : 'no visible effect';
    console.log(`  ${r.id.padEnd(28)} ${note}${r.toast ? `  · toast: "${r.toast}"` : ''}`);
  }
  const dead = rows.filter((r) => !r.changed && !r.threw);
  console.log(`\n${rows.length - dead.length}/${rows.length} did something; ${dead.length} had no visible effect`);
});
setTimeout(() => p.kill(), 120000);
