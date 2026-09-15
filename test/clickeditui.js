'use strict';
/* Clicking a value edits it, leaving a changed row asks whether to write it,
   saying "not now" keeps the change without nagging, and Ctrl+I still opens
   the inspector on whatever is under the cursor.
   Run: node test/clickeditui.js   (needs cobalt-test-pg on :15432) */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');
const { Client } = require('pg');

const outDir = path.join(__dirname, '..', 'shots');
fs.mkdirSync(outDir, { recursive: true });
const CFG = { host: 'localhost', port: 15432, database: 'cobalt', user: 'cobalt', password: 'cobalt' };

const sql = async (text) => {
  const c = new Client(CFG);
  await c.connect();
  const r = await c.query(text);
  await c.end();
  return r.rows;
};

const SEED_SQL = 'select id, label, note from shop.tmp_click order by id;';

const seed = (readOnly = false) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-click-'));
  fs.writeFileSync(path.join(dir, 'cobalt-connections.json'), JSON.stringify({
    connections: [{
      id: 's1', name: 'Test DB', host: 'localhost', port: 15432, database: 'cobalt',
      user: 'cobalt', ssl: 'disable', order: 0, password: { plain: 'cobalt' }, readOnly,
    }],
    workspace: {
      tabs: [{ title: 'rows', sql: SEED_SQL, savedId: 's1' }],
      activeIndex: 0, pageSize: 200, openConnections: ['s1'], activeSavedId: 's1',
    },
    seenVersion: require('../package.json').version,
  }, null, 2));
  return dir;
};

const run = (file, js, { readOnly = false, extra = [] } = {}) => new Promise((resolve) => {
  const profile = seed(readOnly);
  const p = spawn(electron, ['.', `--smoke=${path.join(outDir, file)}`,
    `--user-data-dir=${profile}`, ...extra, `--smoke-js=${js}`], { cwd: path.join(__dirname, '..') });
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

// Runs before the harness presses anything, so there are rows to press on.
const PREP_RUN = `(async () => {
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  await w(2200);
  window.__cobaltMenu('query:run');
  await w(2200);
  return true;
})()`;

const HELP = `
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const cell = (row, col) => document.querySelector(
    '.grow[data-row="' + row + '"] .gc[data-col="' + col + '"]');
  // A left button press is what opens the editor now, so say which button.
  const click = (el) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  const editor = () => document.querySelector('.cell-editor');
  const type = (text) => {
    const e = editor();
    e.value = text;
    e.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const ask = () => document.querySelector('.ask-layer .ask-modal');
  const run = async () => { window.__cobaltMenu('query:run'); await w(1800); };
`;

(async () => {
  const reset = async () => {
    await sql('drop table if exists shop.tmp_click');
    await sql(`create table shop.tmp_click (
      id integer primary key, label text, note text)`);
    await sql(`insert into shop.tmp_click values
      (1, 'one', 'first'), (2, 'two', 'second'), (3, 'three', 'third')`);
  };

  console.log('\nclicking a value puts you in it');

  await reset();
  const open = await run('click-open.png', `(async () => {
    ${HELP}
    await w(900);
    await run();
    const before = !!editor();
    click(cell(0, 1));
    await w(300);
    const e = editor();
    return {
      before,
      opened: !!e,
      value: e ? e.value : null,
      selected: e ? (e.selectionStart === 0 && e.selectionEnd === e.value.length) : null,
    };
  })()`);
  if (!open.ok) fails++;
  const o = readJs(open.out);
  expect(o.before === false, 'nothing is being edited to start with');
  expect(o.opened === true, 'one click opens the editor');
  expect(o.value === 'one', `on the value that was clicked (got ${JSON.stringify(o.value)})`);
  expect(o.selected === true, 'with the text selected, so typing replaces it');

  console.log('\nand a read-only result just says nothing');

  const ro = await run('click-readonly.png', `(async () => {
    ${HELP}
    await w(900);
    await run();
    click(cell(0, 1));
    await w(300);
    return { opened: !!editor(), status: document.getElementById('status-right').textContent };
  })()`, { readOnly: true });
  if (!ro.ok) fails++;
  const r = readJs(ro.out);
  expect(r.opened === false, 'no editor opens on a read-only connection');
  expect(!/read-only/i.test(r.status || ''),
    `and it does not complain on every click (got ${JSON.stringify(r.status)})`);

  console.log('\nmoving within the row says nothing; leaving it asks');

  await reset();
  const asks = await run('click-asks.png', `(async () => {
    ${HELP}
    await w(900);
    await run();
    click(cell(0, 1));
    await w(250);
    type('ONE');
    click(cell(0, 2));          // same row, next column
    await w(500);
    const askedWithinRow = !!ask();
    click(cell(1, 1));          // a different row
    await w(700);
    const m = ask();
    return {
      askedWithinRow,
      askedOnLeaving: !!m,
      title: m ? m.querySelector('h2').textContent : null,
      buttons: m ? [...m.querySelectorAll('[data-ask]')].map(b => b.textContent) : null,
      staged: window.__cobaltDirty(),
    };
  })()`);
  if (!asks.ok) fails++;
  const a = readJs(asks.out);
  expect(a.staged === 1, `the edit is staged (got ${a.staged})`);
  expect(a.askedWithinRow === false, 'moving to the next column of the same row asks nothing');
  expect(a.askedOnLeaving === true, 'leaving the row does ask');
  expect(/Commit this row/.test(a.title || ''),
    `and the question says so (got ${JSON.stringify(a.title)})`);
  expect((a.buttons || []).join('|') === 'Not now|Commit',
    `with Not now beside Commit (got ${JSON.stringify(a.buttons)})`);

  console.log('\nCommit writes it');

  await reset();
  const wrote = await run('click-commit.png', `(async () => {
    ${HELP}
    await w(900);
    await run();
    click(cell(0, 1));
    await w(250);
    type('ONE');
    click(cell(1, 1));
    await w(700);
    document.querySelector('[data-ask="yes"]').click();
    await w(2500);
    return {
      staged: window.__cobaltDirty(),
      // A commit that worked must not then say it failed.
      toasts: [...document.querySelectorAll('.toast')].map(n => n.textContent),
      shown: window.__cobaltCell(0, 1),
    };
  })()`);
  if (!wrote.ok) fails++;
  const wr = readJs(wrote.out);
  expect(wr.staged === 0, 'nothing is left staged afterwards');
  expect((wr.toasts || []).some((t) => /Committed/.test(t)) && !(wr.toasts || []).some((t) => /failed/i.test(t)),
    `and it says so rather than claiming it failed (got ${JSON.stringify(wr.toasts)})`);
  expect(String(wr.shown) === 'ONE',
    `the grid shows the committed value (got ${JSON.stringify(wr.shown)})`);
  const after = await sql('select label from shop.tmp_click where id = 1');
  expect(after[0] && after[0].label === 'ONE',
    `and the row is changed on the server (got ${JSON.stringify(after[0])})`);

  console.log('\nNot now keeps the change, and does not ask again for it');

  await reset();
  const later = await run('click-notnow.png', `(async () => {
    ${HELP}
    await w(900);
    await run();
    click(cell(0, 1));
    await w(250);
    type('ONE');
    click(cell(1, 1));
    await w(700);
    document.querySelector('[data-ask="no"]').click();
    await w(400);
    const afterDeclining = window.__cobaltDirty();
    // Wander off the row again. It has been asked and answered.
    click(cell(2, 1));
    await w(600);
    const askedTwice = !!ask();
    // Nor does a further change: "not now" holds for the whole batch, because
    // correcting one column down a list leaves a row on every keystroke.
    click(cell(2, 2));
    await w(250);
    type('THIRD');
    click(cell(0, 1));
    await w(700);
    const askedAfterNewEdit = !!ask();
    // Committing ends the batch, so the next row asks again.
    document.querySelector('#grid-toolbar [data-act="commit"]').click();
    await w(600);
    const askedOnCommitButton = !!ask();
    if (askedOnCommitButton) { document.querySelector('[data-ask="yes"]').click(); await w(2500); }
    click(cell(0, 1));
    await w(250);
    type('AGAIN');
    click(cell(1, 1));
    await w(800);
    return {
      afterDeclining, askedTwice, askedAfterNewEdit,
      askedOnNextBatch: !!ask(),
      barShown: true,
    };
  })()`);
  if (!later.ok) fails++;
  const l = readJs(later.out);
  expect(l.afterDeclining === 1, `the change is still staged (got ${l.afterDeclining})`);
  expect(l.askedTwice === false, 'leaving another row does not ask the same thing again');
  expect(l.askedAfterNewEdit === false, 'and neither does a further edit — it was taken at its word');
  expect(l.askedOnNextBatch === true, 'but after committing, the next row asks again');

  console.log('\nthe Commit button sits with Filter, and Ctrl+I still works');

  await reset();
  const bits = await run('click-toolbar.png', `(async () => {
    ${HELP}
    await w(900);
    await run();
    const labels = [...document.querySelectorAll('#grid-toolbar [data-act]')]
      .map(b => b.dataset.act);
    click(cell(0, 1));
    await w(250);
    type('ONE');
    // Moving within the row closes the editor and stages the change without
    // raising the question, which is what we want before reading the toolbar.
    click(cell(0, 2));
    await w(400);
    const commit = document.querySelector('#grid-toolbar [data-act="commit"]');
    // Ctrl+I is the inspector, and the click-to-edit above must not have
    // stopped the cursor tracking it depends on.
    window.__cobaltMenu('grid:inspect');
    await w(400);
    const insp = window.__cobaltInspector();
    return {
      labels,
      commitEnabled: !commit.disabled,
      commitText: commit.textContent.trim(),
      inspectorOpen: !!insp.open,
      // What the inspector is showing is whatever is under the cursor.
      cursorValue: window.__cobaltCell(0, 1),
    };
  })()`);
  if (!bits.ok) fails++;
  const b = readJs(bits.out);
  const order = (b.labels || []).join(',');
  expect(/commit,discard,filter/.test(order),
    `Commit and Discard sit just before Filter (got ${order})`);
  expect(b.commitEnabled === true && /Commit \(/.test(b.commitText || ''),
    `the button says what it would write (got ${JSON.stringify(b.commitText)})`);
  expect(b.inspectorOpen === true, 'Ctrl+I still opens the inspector');
  expect(String(b.cursorValue) === 'ONE',
    `with the staged edit under the cursor for it to show (got ${JSON.stringify(b.cursorValue)})`);

  console.log('\nwith a real mouse press, not a dispatched one');

  // This is the check that matters, and the one that was missing.
  //
  // A dispatched MouseEvent carries no default behaviour. A real press moves
  // focus to what was clicked *after* the handler returns — which lands on the
  // grid, blurs the editor that was just opened and closes it again. Under
  // synthetic events the feature looked perfect and did nothing for a person.
  await reset();
  const real = await run('click-real.png', `(async () => {
    const w = (ms) => new Promise(r => setTimeout(r, ms));
    await w(300);
    const ed = document.querySelector('.cell-editor');
    return {
      editors: document.querySelectorAll('.cell-editor').length,
      value: ed ? ed.value : null,
      focused: document.activeElement === ed,
    };
  })()`, { extra: [
    `--smoke-prep=${PREP_RUN}`,
    '--smoke-click=.grow[data-row="0"] .gc[data-col="1"]',
    '--smoke-type=REALLY',
  ] });
  if (!real.ok) fails++;
  const rc = readJs(real.out);
  expect(rc.editors === 1, `a real press opens the editor and it stays open (got ${rc.editors})`);
  expect(rc.focused === true, 'and keeps the caret, so what you type goes into it');
  expect(rc.value === 'REALLY', `which is where the typing landed (got ${JSON.stringify(rc.value)})`);

  console.log('\nand Enter on top of that stages it and asks');

  await reset();
  const realDone = await run('click-real-enter.png', `(async () => {
    const w = (ms) => new Promise(r => setTimeout(r, ms));
    await w(500);
    const m = document.querySelector('.ask-layer .ask-modal');
    return {
      staged: window.__cobaltDirty(),
      cell: window.__cobaltCell(0, 1),
      asked: !!m,
    };
  })()`, { extra: [
    `--smoke-prep=${PREP_RUN}`,
    '--smoke-click=.grow[data-row="0"] .gc[data-col="1"]',
    '--smoke-type=REALLY',
    '--smoke-keys=Return',
  ] });
  if (!realDone.ok) fails++;
  const rd = readJs(realDone.out);
  expect(rd.cell === 'REALLY', `the typed value is staged on the cell (got ${JSON.stringify(rd.cell)})`);
  expect(rd.staged === 1, `one change staged (got ${rd.staged})`);
  expect(rd.asked === true, 'and dropping to the next row raises the question');

  console.log('\nopening another table does not throw the changes away');

  // One browse tab per connection, so the next table replaces what is in it.
  // That used to happen in silence, which is the worst way to lose work.
  const SWITCH = (answer) => `(async () => {
    ${HELP}
    await w(2600);
    const rel = (name) => [...document.querySelectorAll('.tree-row.rel')]
      .find(n => n.querySelector('.name').textContent === name);
    rel('tmp_click').click();
    await w(2600);
    click(cell(0, 1));
    await w(250);
    type('SWITCHED');
    click(cell(0, 2));               // close the editor, stay on the row
    await w(400);
    const staged = window.__cobaltDirty();
    rel('docs').click();             // a different table
    await w(700);
    const m = document.querySelector('.ask-layer .ask-modal');
    const asked = {
      shown: !!m,
      title: m ? m.querySelector('h2').textContent : null,
      buttons: m ? [...m.querySelectorAll('[data-choice]')].map(b => b.textContent) : null,
      message: m ? m.querySelector('.ask-message').textContent : null,
    };
    if (m) {
      const b = m.querySelector('[data-choice="${answer}"]');
      if (b) b.click(); else window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    await w(3000);
    const t = window.__cobalt().tabs.find(x => x.id === window.__cobalt().activeTabId);
    return { staged, asked, nowShowing: t ? t.title : null, stillStaged: window.__cobaltDirty() };
  })()`;

  await reset();
  const stay = await run('switch-stay.png', SWITCH('stay'));
  if (!stay.ok) fails++;
  const st = readJs(stay.out);
  expect(st.staged === 1, `an edit is staged on the first table (got ${st.staged})`);
  expect(st.asked && st.asked.shown === true, 'opening another table asks instead of discarding in silence');
  expect(/Uncommitted changes/.test((st.asked || {}).title || ''),
    `and says what it is about (got ${JSON.stringify((st.asked || {}).title)})`);
  expect(((st.asked || {}).buttons || []).join('|') === 'Stay here|Discard|Commit',
    `with all three answers (got ${JSON.stringify((st.asked || {}).buttons)})`);
  expect(st.nowShowing === 'tmp_click', `Stay here stays (got ${JSON.stringify(st.nowShowing)})`);
  expect(st.stillStaged === 1, `with the change intact (got ${st.stillStaged})`);

  await reset();
  const dropped = await run('switch-discard.png', SWITCH('discard'));
  if (!dropped.ok) fails++;
  const dp = readJs(dropped.out);
  expect(dp.nowShowing === 'docs', `Discard moves on (got ${JSON.stringify(dp.nowShowing)})`);
  expect(dp.stillStaged === 0, `with nothing staged (got ${dp.stillStaged})`);
  const notWritten = await sql('select label from shop.tmp_click where id = 1');
  expect(notWritten[0] && notWritten[0].label === 'one',
    `and nothing written (got ${JSON.stringify(notWritten[0])})`);

  await reset();
  const saved = await run('switch-commit.png', SWITCH('commit'));
  if (!saved.ok) fails++;
  const sv = readJs(saved.out);
  expect(sv.stillStaged === 0, `Commit leaves nothing staged (got ${sv.stillStaged})`);
  const written = await sql('select label from shop.tmp_click where id = 1');
  expect(written[0] && written[0].label === 'SWITCHED',
    `and the change is on the server (got ${JSON.stringify(written[0])})`);

  await sql('drop table if exists shop.tmp_click');

  console.log(`\n${fails ? `${fails} failed` : 'all checks passed'}\n`);
  process.exit(fails ? 1 : 0);
})();
