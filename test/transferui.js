'use strict';
/* Exporting a result in each format, and importing a CSV into a table.
   Run: node test/transferui.js */

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
  const c = new Client(CFG); await c.connect();
  const r = await c.query(text);
  await c.end(); return r.rows;
};

const conn = (id, name, extra = {}) => ({
  id, name, host: 'localhost', port: 15432, database: 'cobalt', user: 'cobalt',
  ssl: 'disable', password: { plain: 'cobalt' }, ...extra,
});

const seed = (openWith = 's1') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-xfer-'));
  fs.writeFileSync(path.join(dir, 'cobalt-connections.json'), JSON.stringify({
    connections: [
      { ...conn('s1', 'Test DB'), order: 0 },
      { ...conn('s2', 'Prod (read-only)', { readOnly: true }), order: 1 },
    ],
    workspace: {
      tabs: [{ title: 'Query 1', sql: 'select 1;', savedId: openWith }],
      activeIndex: 0, pageSize: 200,
      openConnections: [openWith], activeSavedId: openWith,
    },
    seenVersion: require('../package.json').version,
  }, null, 2));
  return dir;
};

const run = (file, js, openWith) => new Promise((resolve) => {
  const profile = seed(openWith);
  const p = spawn(electron, ['.', `--smoke=${path.join(outDir, file)}`,
    `--user-data-dir=${profile}`, `--smoke-js=${js}`], { cwd: path.join(__dirname, '..') });
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
  const browse = async (name) => {
    [...document.querySelectorAll('.tree-row.rel')]
      .find(r => r.querySelector('.name').textContent === name).click();
    await w(2200);
  };
  const rightClick = async (el) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 20, clientY: r.top + 5 }));
    await w(350);
  };
  const relRow = (name) => [...document.querySelectorAll('.tree-row.rel')]
    .find(r => r.querySelector('.name').textContent === name);
  const menuLabels = () => [...document.querySelectorAll('.ctx-menu .ctx-item .ctx-label')].map(n => n.textContent);
  const preview = () => (document.getElementById('ex-preview') || {}).textContent || '';
  const setFormat = async (id) => {
    const sel = document.getElementById('ex-format');
    sel.value = id;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await w(250);
  };
`;

(async () => {
  const fresh = async () => {
    await sql('drop table if exists shop.tmp_in');
    await sql(`create table shop.tmp_in (
      id bigint primary key, email text not null, balance numeric(12,2), note text)`);
  };

  console.log('\nexporting a result');

  const exp = await run('xfer-export.png', `(async () => {
    ${HELP}
    await w(1400);
    await browse('docs');
    document.querySelector('[data-act="csv"]').click();
    await w(500);
    const opened = !!document.querySelector('.export-modal');
    const formats = [...document.querySelectorAll('#ex-format option')].map(o => o.textContent);
    const csv = preview();
    await setFormat('json');
    const json = preview();
    await setFormat('sql');
    const sqlText = preview();
    await setFormat('markdown');
    const md = preview();
    return { opened, formats, csv, json, sqlText, md };
  })()`);
  if (!exp.ok) fails++;
  const e = readJs(exp.out);
  expect(e.opened === true, 'the Export button opens the dialog');
  expect((e.formats || []).length === 5,
    `it offers every format (got ${JSON.stringify(e.formats)})`);
  expect(/^id,label,payload,blob,body/.test(e.csv || ''),
    `CSV starts with the header row (got ${JSON.stringify((e.csv || '').slice(0, 40))})`);
  expect(/^\[\n\s+\{/.test(e.json || '') && /"label": "precision"/.test(e.json || ''),
    `JSON is an array of objects (got ${JSON.stringify((e.json || '').slice(0, 40))})`);
  expect(/^INSERT INTO shop\.docs \(id, label/.test(e.sqlText || ''),
    `SQL names the source table (got ${JSON.stringify((e.sqlText || '').slice(0, 45))})`);
  expect(/^\| id \| label \|/.test(e.md || ''), `Markdown is a table (got ${JSON.stringify((e.md || '').slice(0, 30))})`);

  console.log('\nwhat the export contains');

  const content = await run('xfer-content.png', `(async () => {
    ${HELP}
    await w(1400);
    await browse('docs');
    // Hide a column: the export should follow what is on screen.
    document.querySelector('[data-act="columns"]').click();
    await w(400);
    const box = [...document.querySelectorAll('.col-panel input[data-col]')]
      .find(b => b.parentElement.querySelector('.cp-name').textContent === 'blob');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await w(400);
    document.body.click();
    await w(200);
    document.querySelector('[data-act="csv"]').click();
    await w(500);
    await setFormat('json');
    const json = preview();
    return { json, hasBlob: json.includes('"blob"') };
  })()`);
  if (!content.ok) fails++;
  const c = readJs(content.out);
  expect(c.hasBlob === false, 'a hidden column is not exported');
  // The precision guard, end to end through the UI.
  expect(/"account": "12345678901234567890"/.test(c.json || '') || /12345678901234567890/.test(c.json || ''),
    'a 20-digit number inside a document keeps its digits');

  console.log('\nimporting a CSV');

  await fresh();
  const imp = await run('xfer-import.png', `(async () => {
    ${HELP}
    await w(1600);
    const csv = [
      'id,email,balance,note',
      '1,a@example.com,10.50,"hello, world"',
      '2,b@example.com,0.00,""',
      '3,c@example.com,,',
      '4,"d@example.com","1.10","line one\\nline two"'
    ].join('\\n');
    window.__cobaltImport('shop', 'tmp_in', 'people.csv', csv);
    await w(600);
    const opened = !!document.querySelector('.import-modal');
    const targets = [...document.querySelectorAll('.im-row .im-target')].map(n => n.firstChild.textContent);
    const mapped = [...document.querySelectorAll('[data-map]')].map(s => ({
      col: s.dataset.map, pick: s.options[s.selectedIndex].textContent
    }));
    const previewCells = [...document.querySelectorAll('.im-preview tr')].map(
      tr => [...tr.children].map(td => td.textContent));
    document.querySelector('[data-im="run"]').click();
    await w(2200);
    return { opened, targets, mapped, previewCells, closed: !document.querySelector('.import-modal') };
  })()`);
  if (!imp.ok) fails++;
  const i = readJs(imp.out);
  expect(i.opened === true, 'the import dialog opens on the chosen file');
  expect(JSON.stringify(i.targets) === '["id","email","balance","note"]',
    `every table column is listed (got ${JSON.stringify(i.targets)})`);
  expect((i.mapped || []).every((m) => m.pick === m.col),
    `columns with matching names are mapped automatically (got ${JSON.stringify(i.mapped)})`);
  expect(i.closed === true, 'the dialog closes when the import succeeds');

  const rows = await sql('select id, email, balance, note from shop.tmp_in order by id');
  expect(rows.length === 4, `all four rows arrived (got ${rows.length})`);
  expect(rows[0] && rows[0].note === 'hello, world',
    `a quoted comma stayed inside its field (got ${JSON.stringify(rows[0] && rows[0].note)})`);
  // The distinction most importers throw away.
  expect(rows[1] && rows[1].note === '', `an empty quoted field is an empty string (got ${JSON.stringify(rows[1] && rows[1].note)})`);
  expect(rows[2] && rows[2].note === null, `an empty unquoted field is NULL (got ${JSON.stringify(rows[2] && rows[2].note)})`);
  expect(rows[2] && rows[2].balance === null, 'and so is an empty numeric');
  expect(rows[3] && rows[3].note === 'line one\nline two',
    `a quoted newline survived (got ${JSON.stringify(rows[3] && rows[3].note)})`);
  expect(rows[3] && String(rows[3].balance) === '1.10',
    `a numeric kept its scale (got ${JSON.stringify(rows[3] && String(rows[3].balance))})`);

  console.log('\na bad file leaves the table alone');

  await fresh();
  await sql("insert into shop.tmp_in values (1,'existing@example.com',5,'keep me')");
  const bad = await run('xfer-bad.png', `(async () => {
    ${HELP}
    await w(1600);
    // Row 2 duplicates the primary key, so the whole import must roll back.
    const csv = 'id,email\\n2,x@example.com\\n1,dupe@example.com\\n3,y@example.com';
    window.__cobaltImport('shop', 'tmp_in', 'dupes.csv', csv);
    await w(600);
    document.querySelector('[data-im="run"]').click();
    await w(2200);
    const stillOpen = !!document.querySelector('.import-modal');
    const msg = (document.querySelector('.im-error') || {}).textContent || '';
    // The file summary must still be there to read alongside the error.
    const summary = (document.querySelector('.import-modal .op-sub') || {}).textContent || '';
    return { stillOpen, msg, summary };
  })()`);
  if (!bad.ok) fails++;
  const b = readJs(bad.out);
  expect(b.stillOpen === true, 'the dialog stays open so you can fix it');
  expect(/nothing was inserted/i.test(b.msg || ''),
    `and says nothing was written (got ${JSON.stringify((b.msg || '').slice(0, 120))})`);
  expect(/rows 1-3 of the file/.test(b.msg || ''),
    `naming where it failed (got ${JSON.stringify((b.msg || '').slice(0, 160))})`);
  expect(/dupes\.csv/.test(b.summary || '') && /3 rows/.test(b.summary || ''),
    `and the file summary is still there to read beside it (got ${JSON.stringify((b.summary || '').trim().slice(0, 80))})`);

  const after = await sql('select id, note from shop.tmp_in order by id');
  expect(after.length === 1 && after[0].note === 'keep me',
    `the table is exactly as it was (got ${JSON.stringify(after)})`);

  console.log('\nskipping conflicts instead');

  const skip = await run('xfer-skip.png', `(async () => {
    ${HELP}
    await w(1600);
    const csv = 'id,email\\n1,dupe@example.com\\n2,new@example.com';
    window.__cobaltImport('shop', 'tmp_in', 'dupes.csv', csv);
    await w(600);
    const mode = document.getElementById('im-mode');
    mode.value = 'skipConflicts';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    await w(200);
    document.querySelector('[data-im="run"]').click();
    await w(2200);
    return { closed: !document.querySelector('.import-modal') };
  })()`);
  if (!skip.ok) fails++;
  expect(readJs(skip.out).closed === true, 'the import succeeds with conflicts skipped');
  const afterSkip = await sql('select id, email from shop.tmp_in order by id');
  expect(afterSkip.length === 2, `only the new row was added (got ${afterSkip.length})`);
  expect(afterSkip[0].email === 'existing@example.com', 'and the existing row was left as it was');

  console.log('\na read-only connection cannot import');

  const ro = await run('xfer-readonly.png', `(async () => {
    ${HELP}
    await w(1600);
    await rightClick(relRow('tmp_in'));
    const disabled = [...document.querySelectorAll('.ctx-menu .ctx-item.disabled .ctx-label')].map(n => n.textContent);
    return { disabled };
  })()`, 's2');
  if (!ro.ok) fails++;
  expect((readJs(ro.out).disabled || []).includes('Import CSV…'),
    `Import is disabled (got ${JSON.stringify(readJs(ro.out).disabled)})`);

  await sql('drop table if exists shop.tmp_in');
  console.log(`\n${fails ? `${fails} failed` : 'all checks passed'}\n`);
  process.exit(fails ? 1 : 0);
})();
