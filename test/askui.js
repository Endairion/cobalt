'use strict';
/* Questions are asked by the app, not by Windows: the dialog is in the page,
   it stacks over whatever modal raised it, Escape means no, and a destructive
   one opens on Cancel.
   Run: node test/askui.js   (needs cobalt-test-pg on :15432) */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

const outDir = path.join(__dirname, '..', 'shots');
fs.mkdirSync(outDir, { recursive: true });

const seed = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-ask-'));
  fs.writeFileSync(path.join(dir, 'cobalt-connections.json'), JSON.stringify({
    connections: [{
      id: 's1', name: 'Test DB', host: 'localhost', port: 15432, database: 'cobalt',
      user: 'cobalt', ssl: 'disable', order: 0, password: { plain: 'cobalt' },
    }],
    workspace: {
      tabs: [{ title: 'customers', sql: 'select id, email, full_name, balance from shop.customers;', savedId: 's1' }],
      activeIndex: 0, pageSize: 200,
    },
    seenVersion: require('../package.json').version,
  }, null, 2));
  return dir;
};

const run = (file, js) => new Promise((resolve) => {
  const profile = seed();
  const target = path.join(outDir, file);
  const p = spawn(electron, ['.', `--smoke=${target}`, `--user-data-dir=${profile}`, `--smoke-js=${js}`],
    { cwd: path.join(__dirname, '..') });
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
  const ask = () => document.querySelector('.ask-layer .ask-modal');
  const read = () => {
    const m = ask();
    if (!m) return null;
    return {
      title: m.querySelector('h2').textContent,
      message: m.querySelector('.ask-message').textContent,
      detail: (m.querySelector('.ask-detail') || {}).textContent || '',
      buttons: [...m.querySelectorAll('[data-ask]')].map(b => b.textContent),
      danger: m.classList.contains('danger'),
      focused: (document.activeElement && document.activeElement.dataset)
        ? document.activeElement.dataset.ask : null
    };
  };
  const press = (key) => window.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  // Stage an edit so the "you have uncommitted changes" question is real.
  const stageOne = async () => {
    window.__cobaltMenu('query:run'); await w(1800);
    const c = document.querySelector('.grow[data-row="0"] .gc[data-col="2"]');
    c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.querySelector('.grid').dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    await w(300);
    const ed = document.querySelector('.cell-editor');
    if (ed) ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await w(400);
  };
`;

(async () => {
  console.log('\na destructive question is drawn by the app, and Escape means no');

  const escape = await run('ask-escape.png', `(async () => {
    ${HELP}
    await w(900);
    await stageOne();
    const dirtyBefore = window.__cobaltDirty();
    const tabsBefore = window.__cobalt().tabs.length;

    // Closing the tab has to ask, because the edit would be thrown away.
    window.__cobaltMenu('tab:close');
    await w(500);
    const shown = read();
    const native = { visible: !!ask(), only: document.querySelectorAll('.ask-layer').length };

    press('Escape');
    await w(400);
    return {
      shown, native, dirtyBefore,
      tabsBefore,
      gone: !ask(),
      tabsAfter: window.__cobalt().tabs.length,
      dirtyAfter: window.__cobaltDirty()
    };
  })()`);
  if (!escape.ok) fails++;
  const e = readJs(escape.out);
  expect(e.dirtyBefore === 1, `an edit is staged first (got ${e.dirtyBefore})`);
  expect(!!e.shown, 'the question is a node in the page, not a Windows message box');
  expect(e.native && e.native.only === 1, `exactly one question is open (got ${e.native && e.native.only})`);
  expect(/Unsaved grid changes/.test((e.shown || {}).title || ''),
    `titled like the question it is (got ${JSON.stringify((e.shown || {}).title)})`);
  expect(((e.shown || {}).buttons || []).join('|') === 'Cancel|Discard and close',
    `Cancel then the action, in that order (got ${JSON.stringify((e.shown || {}).buttons)})`);
  expect((e.shown || {}).danger === true, 'and it is marked as destructive');
  expect((e.shown || {}).focused === 'no',
    `a destructive question opens on Cancel (got ${JSON.stringify((e.shown || {}).focused)})`);
  expect(e.gone === true, 'Escape closes it');
  expect(e.tabsAfter === e.tabsBefore && e.dirtyAfter === 1,
    `and answers no — the tab and the edit survive (got ${e.tabsAfter} tabs, ${e.dirtyAfter} staged)`);

  console.log('\nand clicking the action goes through');

  const yes = await run('ask-confirm.png', `(async () => {
    ${HELP}
    await w(900);
    await stageOne();
    const before = window.__cobalt().tabs[0];
    window.__cobaltMenu('tab:close');
    await w(500);
    document.querySelector('[data-ask="yes"]').click();
    await w(500);
    const after = window.__cobalt().tabs[0];
    return {
      before: { id: before.id, title: before.title },
      // Closing the last tab leaves a fresh empty one, so it is the identity
      // that changes here, not the count.
      after: { id: after.id, title: after.title },
      dirty: window.__cobaltDirty(),
      gone: !ask()
    };
  })()`);
  if (!yes.ok) fails++;
  const y = readJs(yes.out);
  expect(y.gone === true, 'the question closes');
  expect(y.after && y.after.id !== y.before.id,
    `and the tab is closed (${JSON.stringify(y.before)} -> ${JSON.stringify(y.after)})`);
  expect(y.dirty === 0, `taking the staged edit with it (got ${y.dirty})`);

  console.log('\nasked from inside a dialog, it stacks instead of replacing it');

  const stacked = await run('ask-stacked.png', `(async () => {
    ${HELP}
    await w(1200);
    document.querySelector('[data-manage]').click();
    await w(700);
    document.querySelector('.mgr-row[data-id="s1"]').click();
    await w(400);
    document.getElementById('c-delete').click();
    await w(500);
    const shown = read();
    const behind = {
      manager: !!document.querySelector('.modal.manager'),
      rows: document.querySelectorAll('.mgr-row').length
    };
    // Escape has to answer this question only — not also close the manager
    // underneath, which has an Escape handler of its own.
    press('Escape');
    await w(600);
    return {
      shown, behind,
      managerStillThere: !!document.querySelector('.modal.manager'),
      rowsAfter: document.querySelectorAll('.mgr-row').length
    };
  })()`);
  if (!stacked.ok) fails++;
  const s = readJs(stacked.out);
  expect(!!s.shown && /Delete connection/.test((s.shown || {}).title || ''),
    `the delete question appears (got ${JSON.stringify((s.shown || {}).title)})`);
  expect(s.behind && s.behind.manager === true && s.behind.rows === 1,
    'the manager is still behind it, not torn down');
  expect(s.managerStillThere === true && s.rowsAfter === 1,
    'and Escape answers the question without closing the manager too');

  console.log(`\n${fails ? `${fails} failed` : 'all checks passed'}\n`);
  process.exit(fails ? 1 : 0);
})();
