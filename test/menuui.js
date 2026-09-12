'use strict';
/* The in-app menu and toolbar buttons on a frameless window.
   Run: node test/menuui.js */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

const outDir = path.join(__dirname, '..', 'shots');
fs.mkdirSync(outDir, { recursive: true });

const seed = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-menu-'));
  fs.writeFileSync(path.join(dir, 'cobalt-connections.json'), JSON.stringify({
    connections: [{
      id: 's1', name: 'Test DB', host: 'localhost', port: 15432, database: 'cobalt',
      user: 'cobalt', ssl: 'disable', order: 0, password: { plain: 'cobalt' },
    }],
    workspace: {
      tabs: [{ title: 'q', sql: 'select id, email from shop.customers limit 20;', savedId: 's1' }],
      activeIndex: 0, pageSize: 200,
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
  setTimeout(() => p.kill(), 90000);
});

/** Same as run(), but presses real keys first so accelerators are exercised. */
const runKeys = (file, keys, js) => new Promise((resolve) => {
  const profile = seed();
  const target = path.join(outDir, file);
  const p = spawn(electron, ['.', `--smoke=${target}`, `--user-data-dir=${profile}`,
    `--smoke-keys=${keys}`, `--smoke-js=${js}`], { cwd: path.join(__dirname, '..') });
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

const HELP = `
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const labels = () => [...document.querySelectorAll('.ctx-menu .ctx-item .ctx-label')].map(n => n.textContent);
  // A browser sends mousedown first and only delivers a click if the element
  // survived the press. Dispatching click unconditionally hides anything that
  // tears the element down on mousedown.
  const realClick = (el) => {
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, clientX: Math.round(r.left + 5), clientY: Math.round(r.top + 5) };
    el.dispatchEvent(new MouseEvent('mousedown', at));
    if (!el.isConnected) return false;
    el.dispatchEvent(new MouseEvent('mouseup', at));
    el.dispatchEvent(new MouseEvent('click', at));
    return true;
  };
  const itemNamed = (t) => [...document.querySelectorAll('.ctx-menu .ctx-item')]
    .find(n => n.querySelector('.ctx-label').textContent === t);
  const hover = (el) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, clientX: Math.round(r.left + 5), clientY: Math.round(r.top + 5)
    }));
  };
`;

(async () => {
  console.log('\nthe menu button');

  const open = await run('menu-open.png', [], `(async () => {
    ${HELP}
    await w(900);
    document.getElementById('app-menu').click();
    await w(350);
    const groups = labels();
    // Hover Query to open its submenu.
    const query = [...document.querySelectorAll('.ctx-menu .ctx-item')]
      .find(n => n.querySelector('.ctx-label').textContent === 'Query');
    hover(query);
    await w(400);
    const menus = document.querySelectorAll('.ctx-menu').length;
    const all = labels();
    const accels = [...document.querySelectorAll('.ctx-menu .ctx-sub')].map(n => n.textContent).filter(Boolean);
    return { groups, menus, all, accels };
  })()`);
  if (!open.ok) fails++;
  const o = readJs(open.out);
  expect(JSON.stringify(o.groups) === '["File","Edit","Query","Go","View","Help"]',
    `all six groups are listed (got ${JSON.stringify(o.groups)})`);
  expect(o.menus === 2, `hovering a group opens its submenu (got ${o.menus} menus)`);
  expect((o.all || []).includes('Benchmark Statements…'), 'the submenu lists its commands');
  expect((o.accels || []).some((a) => /Ctrl\+Shift\+B/.test(a)),
    `shortcuts are shown beside the items (got ${JSON.stringify((o.accels || []).slice(0, 6))})`);

  console.log('\nclicking through the menu');

  const act = await run('menu-act.png', [], `(async () => {
    ${HELP}
    await w(900);
    document.getElementById('app-menu').click();
    await w(300);
    hover([...document.querySelectorAll('.ctx-menu .ctx-item')]
      .find(n => n.querySelector('.ctx-label').textContent === 'Help'));
    await w(400);
    const survived = realClick(itemNamed('About Cobalt'));
    await w(700);
    return {
      survived,
      aboutOpen: !!document.querySelector('.about-modal'),
      menusLeft: document.querySelectorAll('.ctx-menu').length,
      version: (document.querySelector('.about-ver') || {}).textContent || ''
    };
  })()`);
  if (!act.ok) fails++;
  const a = readJs(act.out);
  expect(a.survived === true, 'pressing a submenu item does not tear the menu down first');
  expect(a.aboutOpen === true, 'choosing About actually opened it');
  expect(a.menusLeft === 0, 'the menu and its submenu both closed');
  expect(/Version \d/.test(a.version), `and it rendered (got "${a.version}")`);

  console.log('\na File menu item, pressed the way a mouse does');

  const fileItem = await run('menu-file.png', [], `(async () => {
    ${HELP}
    await w(900);
    const before = window.__cobalt().tabs.length;
    document.getElementById('app-menu').click();
    await w(300);
    hover(itemNamed('File'));
    await w(400);
    const target = itemNamed('New Query Tab');
    const present = !!target;
    const survived = present ? realClick(target) : false;
    await w(600);
    return {
      present, survived, before,
      after: window.__cobalt().tabs.length,
      menusLeft: document.querySelectorAll('.ctx-menu').length
    };
  })()`);
  if (!fileItem.ok) fails++;
  const fi = readJs(fileItem.out);
  expect(fi.present === true, 'the File submenu lists New Query Tab');
  expect(fi.survived === true, 'the item is still there when the press lands');
  expect(fi.after === fi.before + 1, `clicking it opens a tab (${fi.before} -> ${fi.after})`);
  expect(fi.menusLeft === 0, 'and the menu closes afterwards');

  console.log('\ntoolbar buttons');

  const buttons = await run('menu-toolbar.png', [], `(async () => {
    ${HELP}
    await w(900);
    const present = ['btn-explain','btn-benchmark','btn-history','btn-more','app-menu']
      .filter(id => !!document.getElementById(id));
    document.getElementById('btn-history').click();
    await w(800);
    const historyOpen = !!document.querySelector('.history-modal');
    document.querySelector('#h-search').blur();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await w(400);
    document.getElementById('btn-more').click();
    await w(350);
    return { present, historyOpen, moreItems: labels().length };
  })()`);
  if (!buttons.ok) fails++;
  const b = readJs(buttons.out);
  expect((b.present || []).length === 5, `every new button is in the toolbar (got ${JSON.stringify(b.present)})`);
  expect(b.historyOpen === true, 'the History button opens history');
  expect(b.moreItems > 5, `the overflow button opens the Query menu (got ${b.moreItems} items)`);

  console.log('\nkeyboard accelerators still fire');

  // A frameless window draws no menu bar, but the menu is still set, and that is
  // what registers the accelerators. Send a real key event and check it lands.
  const accel = await runKeys('menu-accel.png', 'Control+H', `(() => ({
    last: window.__cobaltLastCommand,
    historyOpen: !!document.querySelector('.history-modal')
  }))()`);
  if (!accel.ok) fails++;
  const k = readJs(accel.out);
  expect(k.last === 'history:open',
    `Ctrl+H reached the app without a menu bar (got ${JSON.stringify(k.last)})`);
  expect(k.historyOpen === true, 'and it actually opened history');

  console.log(`\n${fails ? fails + ' failed' : 'all checks passed'}\n`);
  process.exit(fails ? 1 : 0);
})();
