'use strict';
/* Find in database, in the app: searching, what it reports, and opening a hit.
   Run: node test/searchui.js */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

const outDir = path.join(__dirname, '..', 'shots');
fs.mkdirSync(outDir, { recursive: true });

let fails = 0;
const expect = (cond, label) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) fails++;
};
const readJs = (out) => JSON.parse((/\[smoke\] js (.*)/.exec(out) || [])[1] || '{}');

const PG = {
  id: 'pg', name: 'Postgres', engine: 'postgres', host: 'localhost', port: 15432,
  database: 'cobalt', user: 'cobalt', ssl: 'disable', order: 0, password: { plain: 'cobalt' },
};
const MY = {
  id: 'my', name: 'MySQL', engine: 'mysql', host: '127.0.0.1', port: 13306,
  database: 'cobalt', user: 'cobalt', ssl: 'disable', order: 1, password: { plain: 'cobalt' },
};

const seed = (openWith) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cobalt-sr-'));
  fs.writeFileSync(path.join(dir, 'cobalt-connections.json'), JSON.stringify({
    connections: [PG, MY],
    workspace: {
      tabs: [{ title: 'Query 1', sql: 'select 1;', savedId: openWith }],
      activeIndex: 0, pageSize: 200, openConnections: [openWith], activeSavedId: openWith,
    },
    seenVersion: require('../package.json').version,
  }, null, 2));
  return dir;
};

const run = (file, js, openWith = 'pg') => new Promise((resolve) => {
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
  setTimeout(() => p.kill(), 120000);
});

const HELP = `
  const w = (ms) => new Promise(r => setTimeout(r, ms));
  const g = (id) => document.getElementById(id);
  const texts = (sel) => [...document.querySelectorAll(sel)].map(n => n.textContent.trim());
  const search = async (needle, opts = {}) => {
    window.__cobaltMenu('search:database');
    await w(500);
    g('sr-needle').value = needle;
    if (opts.numbers) { g('sr-num').checked = true; g('sr-num').dispatchEvent(new Event('change', { bubbles: true })); }
    if (opts.cap != null) { g('sr-cap').value = String(opts.cap); g('sr-cap').dispatchEvent(new Event('change', { bubbles: true })); }
    if (opts.mode) { g('sr-mode').value = opts.mode; g('sr-mode').dispatchEvent(new Event('change', { bubbles: true })); }
    document.querySelector('[data-sr="go"]').click();
    await w(opts.wait || 6000);
  };
  const rows = () => [...document.querySelectorAll('.sr-table tr[data-hit]')].map(tr => ({
    where: tr.children[0].textContent.trim(),
    column: tr.children[1].textContent.trim(),
    count: tr.children[2].textContent.trim(),
    sample: tr.children[3].textContent.trim()
  }));
`;

(async () => {
  console.log('\nfinding a value');

  const found = await run('sr-find.png', `(async () => {
    ${HELP}
    await w(2800);
    await search('user1234@example.com');
    const hits = rows();
    return {
      hits,
      summary: texts('.sr-summary .pill'),
      marked: (document.querySelector('.sr-sample mark') || {}).textContent || null,
      opened: !!document.querySelector('.search-modal')
    };
  })()`);
  if (!found.ok) fails++;
  const f = readJs(found.out);
  expect(f.opened === true, 'the panel opens and stays open with results');
  expect((f.hits || []).some((h) => /customers/.test(h.where) && /email/.test(h.column)),
    `it finds the value and names the table and column (got ${JSON.stringify(f.hits)})`);
  expect((f.summary || []).some((s) => /1 match/.test(s)),
    `it says how many matched (got ${JSON.stringify(f.summary)})`);
  expect((f.summary || []).some((s) => /of \d+ tables/.test(s)),
    `and how much it covered (got ${JSON.stringify(f.summary)})`);
  expect(f.marked === 'user1234@example.com',
    `the match is highlighted inside the sample (got ${JSON.stringify(f.marked)})`);

  console.log('\nwhat it refuses to guess at');

  const literal = await run('sr-literal.png', `(async () => {
    ${HELP}
    await w(2800);
    await search('%');
    const wild = rows().length;
    document.querySelector('[data-sr="close"]').click();
    await w(300);
    await search('zzz-definitely-not-here');
    const none = document.querySelector('.sr-none');
    return { wild, noneText: none ? none.textContent.trim() : null };
  })()`);
  if (!literal.ok) fails++;
  const l = readJs(literal.out);
  // The bug that would make the whole feature useless.
  expect(l.wild === 0, `a lone "%" matches nothing, it is not a wildcard (got ${l.wild} hits)`);
  expect(/Nothing matched/.test(l.noneText || ''),
    `nothing found says so plainly (got ${JSON.stringify(l.noneText)})`);
  expect(/numbers and dates were not searched/.test(l.noneText || ''),
    'and reminds you what was left out');

  console.log('\nnumbers are opt-in, and the cap is honest');

  const opts = await run('sr-opts.png', `(async () => {
    ${HELP}
    await w(2800);
    await search('1234');
    const withoutNums = rows().length;
    document.querySelector('[data-sr="close"]').click();
    await w(300);
    await search('1234', { numbers: true });
    const withNums = rows();
    document.querySelector('[data-sr="close"]').click();
    await w(300);
    await search('Customer', { cap: 1000 });
    return {
      withoutNums,
      withNums: withNums.length,
      capOptions: [...document.querySelectorAll('#sr-cap option')].map(o => o.value),
      numColumns: withNums.map(h => h.column),
      cappedPills: texts('.sr-summary .pill'),
      cappedCounts: rows().map(h => h.count)
    };
  })()`);
  if (!opts.ok) fails++;
  const o = readJs(opts.out);
  expect(o.withNums > o.withoutNums,
    `ticking numbers widens the search (${o.withoutNums} -> ${o.withNums})`);
  expect((o.numColumns || []).some((c) => /^id/.test(c)),
    `and reaches id columns (got ${JSON.stringify(o.numColumns)})`);
  expect((o.cappedPills || []).some((p) => /capped at 1,000 rows/.test(p)),
    `a capped scan says so rather than implying it saw everything (got ${JSON.stringify(o.cappedPills)})`);
  expect((o.cappedCounts || []).some((c) => /\+$/.test(c)),
    `and marks the counts as partial (got ${JSON.stringify(o.cappedCounts)})`);
  expect(JSON.stringify(o.capOptions) === '["1000","10000","250000","0"]'
    || (o.capOptions || []).includes('0'),
    `"every row" is offered explicitly (got ${JSON.stringify(o.capOptions)})`);

  console.log('\nclicking a hit lands on the rows');

  const opened = await run('sr-open.png', `(async () => {
    ${HELP}
    await w(2800);
    await search('user1234@example.com');
    document.querySelector('.sr-table tr[data-hit]').click();
    await w(5000);
    const st = window.__cobalt();
    const tab = st.tabs[st.tabs.findIndex(t => t.id === st.activeTabId)];
    const cols = [...document.querySelectorAll('.gh[data-col] .gh-name')].map(n => n.textContent);
    const emailIdx = cols.findIndex(c => /email/.test(c));
    return {
      closed: !document.querySelector('.search-modal'),
      title: tab.title,
      rows: window.__cobaltGridRows(),
      email: window.__cobaltCell(0, emailIdx),
      filterShown: !document.getElementById('filter-bar').hidden,
      where: (document.getElementById('fb-input') || {}).value || ''
    };
  })()`);
  if (!opened.ok) fails++;
  const op = readJs(opened.out);
  expect(op.closed === true, 'the panel closes');
  expect(op.title === 'customers', `the table opens (got ${JSON.stringify(op.title)})`);
  expect(op.rows === 1, `filtered to the matching rows (got ${op.rows})`);
  expect(op.email === 'user1234@example.com', `which is the row you searched for (got ${JSON.stringify(op.email)})`);
  expect(op.filterShown === true && /user1234/.test(op.where),
    `and the filter is visible so you can see why (got ${JSON.stringify(op.where)})`);

  console.log('\nthe same on MySQL');

  const mysql = await run('sr-mysql.png', `(async () => {
    ${HELP}
    await w(3000);
    await search('user1234@example.com');
    const hits = rows();
    const err = document.querySelector('.im-error');
    return { hits, error: err ? err.textContent.trim() : null };
  })()`, 'my');
  if (!mysql.ok) fails++;
  const mm = readJs(mysql.out);
  // A table that errors would otherwise look exactly like a table with no matches.
  expect(mm.error === null, `no table failed to read (got ${JSON.stringify(mm.error)})`);
  expect((mm.hits || []).some((h) => /customers/.test(h.where)),
    `and it finds the value (got ${JSON.stringify(mm.hits)})`);

  console.log(`\n${fails ? `${fails} failed` : 'all checks passed'}\n`);
  process.exit(fails ? 1 : 0);
})();
