'use strict';
/* Window chrome (frameless title bar, custom controls) and the grid's sticky
   header geometry. Run: node test/chrome.js   (needs cobalt-test-pg on :15432) */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

const outDir = path.join(__dirname, '..', 'shots');
fs.mkdirSync(outDir, { recursive: true });

const seed = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-chrome-'));
  fs.writeFileSync(path.join(dir, 'cobalt-connections.json'), JSON.stringify({
    connections: [{
      id: 's1', name: 'Test DB', host: 'localhost', port: 15432, database: 'cobalt',
      user: 'cobalt', ssl: 'disable', order: 0, password: { plain: 'cobalt' },
    }],
    workspace: {
      tabs: [{ title: 'q', sql: 'select id, email, full_name, balance from shop.customers order by id limit 300;', savedId: 's1' }],
      activeIndex: 0,
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
  setTimeout(() => p.kill(), 60000);
});

const readJs = (out) => JSON.parse((/\[smoke\] js (.*)/.exec(out) || [])[1] || '{}');
const wait = (ms) => `new Promise(r => setTimeout(r, ${ms}))`;

let fails = 0;
const expect = (cond, label) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) fails++;
};

(async () => {
  console.log('\nwindow chrome');

  const chrome = await run('chrome.png', ['query:run'], `(async () => {
    const st = await window.cobalt.window.state();
    return {
      buttons: [...document.querySelectorAll('.win-btn')].map(b => b.id),
      titlebarDrag: getComputedStyle(document.getElementById('titlebar')).webkitAppRegion,
      controlsDrag: getComputedStyle(document.getElementById('win-controls')).webkitAppRegion,
      tabDrag: getComputedStyle(document.querySelector('.tab')).webkitAppRegion,
      maximized: st.maximized,
      hasMaximizedClass: document.body.classList.contains('is-maximized'),
      maxIconVisible: getComputedStyle(document.querySelector('.ico-max')).display !== 'none',
      restoreIconVisible: getComputedStyle(document.querySelector('.ico-restore')).display !== 'none'
    };
  })()`);
  if (!chrome.ok) fails++;
  const c = readJs(chrome.out);
  expect(JSON.stringify(c.buttons) === '["win-min","win-max","win-close"]',
    `three controls in order (got ${JSON.stringify(c.buttons)})`);
  expect(c.titlebarDrag === 'drag', 'the title bar is a drag region');
  expect(c.controlsDrag === 'no-drag', 'the controls are clickable, not draggable');
  expect(c.tabDrag === 'no-drag', 'tabs stay clickable');
  expect(c.maxIconVisible && !c.restoreIconVisible, 'shows the maximise glyph while restored');

  const maxed = await run('chrome-max.png', ['query:run'], `(async () => {
    await window.cobalt.window.toggleMaximize();
    await ${wait(600)};
    const st = await window.cobalt.window.state();
    return {
      maximized: st.maximized,
      hasClass: document.body.classList.contains('is-maximized'),
      maxIconVisible: getComputedStyle(document.querySelector('.ico-max')).display !== 'none',
      restoreIconVisible: getComputedStyle(document.querySelector('.ico-restore')).display !== 'none',
      title: document.getElementById('win-max').title
    };
  })()`);
  if (!maxed.ok) fails++;
  const m = readJs(maxed.out);
  expect(m.maximized === true, 'toggleMaximize maximises the window');
  expect(m.hasClass === true, 'the body reflects the maximised state');
  expect(!m.maxIconVisible && m.restoreIconVisible, 'the glyph swaps to restore');
  expect(m.title === 'Restore', 'the tooltip follows the state');

  console.log('\ngrid header geometry');

  const geom = await run('chrome-grid.png', ['query:run'], `(async () => {
    const head = () => document.querySelector('.grid-head').getBoundingClientRect();
    const firstRow = () => document.querySelector('.grow').getBoundingClientRect();
    const filter = () => document.querySelector('.grid-filter');

    const collapsedGap = Math.round(firstRow().top - head().bottom);
    const collapsedHeight = Math.round(filter().getBoundingClientRect().height);

    document.querySelector('[data-act="filter"]').click();
    await ${wait(400)};
    const openGap = Math.round(firstRow().top - head().bottom);
    const openHeight = Math.round(filter().getBoundingClientRect().height);
    const inputs = document.querySelectorAll('input[data-filter]').length;

    document.querySelector('[data-act="filter"]').click();
    await ${wait(500)};
    const reclosedGap = Math.round(firstRow().top - head().bottom);

    return { collapsedGap, collapsedHeight, openGap, openHeight, inputs, reclosedGap };
  })()`);
  if (!geom.ok) fails++;
  const g = readJs(geom.out);
  expect(g.collapsedHeight === 0, `a hidden filter row takes no space (got ${g.collapsedHeight}px)`);
  expect(g.collapsedGap === 0, `rows start right under the header (got ${g.collapsedGap}px)`);
  expect(g.openHeight === 26 && g.openGap === 26, `opening it inserts exactly one row band (got ${g.openGap}px)`);
  expect(g.inputs > 0, 'the filter row has inputs when open');
  expect(g.reclosedGap === 0, `closing it gives the space back (got ${g.reclosedGap}px)`);

  console.log(`\n${fails ? fails + ' failed' : 'all checks passed'}\n`);
  process.exit(fails ? 1 : 0);
})();
