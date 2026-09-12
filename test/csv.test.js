'use strict';
/* Reading and writing CSV, and the other export formats.
   Run: node test/csv.test.js */

const assert = require('assert');
const { parseCsv, toCsv, csvField, sniffDelimiter } = require('../src/shared/csv.js');
const ex = require('../src/shared/exporters.js');

let n = 0;
const check = (label, fn) => {
  try { fn(); n++; console.log(`  ok   ${label}`); }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); process.exitCode = 1; }
};

console.log('\nparsing');

check('a plain file', () => {
  const r = parseCsv('a,b\n1,2\n3,4');
  assert.deepStrictEqual(r.header, ['a', 'b']);
  assert.deepStrictEqual(r.rows, [['1', '2'], ['3', '4']]);
});

check('CRLF, and a trailing newline that is not a row', () => {
  const r = parseCsv('a,b\r\n1,2\r\n');
  assert.deepStrictEqual(r.rows, [['1', '2']]);
});

check('a BOM does not become part of the first column name', () => {
  assert.deepStrictEqual(parseCsv('﻿a,b\n1,2').header, ['a', 'b']);
});

check('a quoted field can hold the delimiter', () => {
  assert.deepStrictEqual(parseCsv('a,b\n"x,y",2').rows, [['x,y', '2']]);
});

check('a quoted field can hold a newline', () => {
  const r = parseCsv('a,b\n"line one\nline two",2');
  assert.deepStrictEqual(r.rows, [['line one\nline two', '2']]);
});

check('a doubled quote is one quote', () => {
  assert.deepStrictEqual(parseCsv('a\n"say ""hi"""').rows, [['say "hi"']]);
});

// The distinction a tool that splits on commas throws away.
check('empty unquoted is NULL, empty quoted is the empty string', () => {
  const r = parseCsv('a,b,c\n,"",x');
  assert.deepStrictEqual(r.rows, [[null, '', 'x']]);
});

check('the delimiter is sniffed', () => {
  assert.strictEqual(parseCsv('a;b;c\n1;2;3').delimiter, ';');
  assert.strictEqual(parseCsv('a\tb\n1\t2').delimiter, '\t');
  assert.strictEqual(sniffDelimiter('a|b|c'), '|');
});

check('a delimiter inside quotes does not win the sniff', () => {
  assert.strictEqual(parseCsv('"a;b;c;d",x\n1,2').delimiter, ',');
});

check('a short row is padded and reported, not dropped', () => {
  const r = parseCsv('a,b,c\n1,2\n4,5,6');
  assert.deepStrictEqual(r.rows, [['1', '2', null], ['4', '5', '6']]);
  assert.strictEqual(r.issues.length, 1);
  assert.strictEqual(r.issues[0].line, 2);
});

check('a long row is trimmed and reported', () => {
  const r = parseCsv('a,b\n1,2,3');
  assert.deepStrictEqual(r.rows, [['1', '2']]);
  assert.strictEqual(r.issues[0].got, 3);
});

check('a blank column heading gets a usable name', () => {
  assert.deepStrictEqual(parseCsv('a,,c\n1,2,3').header, ['a', 'column2', 'c']);
});

check('without a header the columns are numbered and no row is eaten', () => {
  const r = parseCsv('1,2\n3,4', { hasHeader: false });
  assert.deepStrictEqual(r.header, ['column1', 'column2']);
  assert.deepStrictEqual(r.rows, [['1', '2'], ['3', '4']]);
});

check('an empty file is empty, not a crash', () => {
  const r = parseCsv('');
  assert.deepStrictEqual(r.rows, []);
  assert.deepStrictEqual(r.header, []);
});

console.log('\nwriting');

check('only the fields that need quotes get them', () => {
  assert.strictEqual(csvField('plain'), 'plain');
  assert.strictEqual(csvField('has,comma'), '"has,comma"');
  assert.strictEqual(csvField('has"quote'), '"has""quote"');
  assert.strictEqual(csvField('has\nnewline'), '"has\nnewline"');
});

check('NULL is empty, an empty string is a pair of quotes', () => {
  assert.strictEqual(csvField(null), '');
  assert.strictEqual(csvField(''), '""');
});

check('a round trip keeps NULL and empty apart', () => {
  const text = toCsv(['a', 'b'], [[null, '']]);
  assert.deepStrictEqual(parseCsv(text).rows, [[null, '']]);
});

check('a round trip survives commas, quotes and newlines', () => {
  const rows = [['a,b', 'say "hi"'], ['line\nbreak', null]];
  assert.deepStrictEqual(parseCsv(toCsv(['x', 'y'], rows)).rows, rows);
});

check('tab separated uses tabs and does not quote commas', () => {
  assert.strictEqual(toCsv(['a', 'b'], [['x,y', 'z']], { delimiter: '\t', eol: '\n' }),
    'a\tb\nx,y\tz');
});

console.log('\nJSON');

const cols = [
  { name: 'id', dataTypeID: 20 },
  { name: 'amount', dataTypeID: 1700 },
  { name: 'ok', dataTypeID: 16 },
  { name: 'prefs', dataTypeID: 3802 },
  { name: 'note', dataTypeID: 25 },
];

check('types come out as JSON types, not all strings', () => {
  const out = ex.toJson(cols, [['7', '1.50', 't', '{"a":1}', 'hi']]);
  assert.ok(out.includes('"id": 7'), out);
  assert.ok(out.includes('"ok": true'), out);
  assert.ok(out.includes('"prefs": {"a":1}'), out);
  assert.ok(out.includes('"note": "hi"'), out);
});

// The precision trap again, from the other direction.
check('a bigint too large for JSON is quoted rather than rounded', () => {
  const out = ex.toJson([{ name: 'id', dataTypeID: 20 }], [['12345678901234567890']]);
  assert.ok(out.includes('"id": "12345678901234567890"'), out);
  assert.ok(!out.includes('12345678901234567000'), out);
});

check('a numeric whose text JSON cannot hold exactly is quoted', () => {
  assert.strictEqual(ex.isSafeNumber('1.10'), false);          // would print as 1.1
  assert.strictEqual(ex.isSafeNumber('1.5'), true);
  const out = ex.toJson([{ name: 'amount', dataTypeID: 1700 }], [['1.10']]);
  assert.ok(out.includes('"amount": "1.10"'), out);
});

check('NULL is null', () => {
  assert.ok(ex.toJson([{ name: 'a', dataTypeID: 25 }], [[null]]).includes('"a": null'));
});

check('no rows is an empty array', () => {
  assert.strictEqual(ex.toJson(cols, []), '[]');
});

check('the output parses', () => {
  const out = ex.toJson(cols, [['7', '1.50', 't', '{"a":1}', 'a "quoted" note']]);
  const back = JSON.parse(out);
  assert.strictEqual(back[0].id, 7);
  assert.deepStrictEqual(back[0].prefs, { a: 1 });
  assert.strictEqual(back[0].note, 'a "quoted" note');
});

console.log('\nSQL inserts');

check('column names and values are quoted properly', () => {
  const out = ex.toSqlInserts(
    [{ name: 'id', dataTypeID: 20 }, { name: 'order', dataTypeID: 25 }],
    [['1', "O'Brien"]],
    { schema: 'shop', table: 'customers' });
  assert.ok(out.includes('insert into shop.customers (id, "order") values'), out);
  assert.ok(out.includes(`(1, 'O''Brien')`), out);
});

check('NULL and booleans are literals, not strings', () => {
  const out = ex.toSqlInserts(
    [{ name: 'a', dataTypeID: 25 }, { name: 'b', dataTypeID: 16 }], [[null, 't']], {});
  assert.ok(out.includes('(null, true)'), out);
});

check('a numeric is quoted so its scale survives the round trip', () => {
  const out = ex.toSqlInserts([{ name: 'a', dataTypeID: 1700 }], [['1.10']], {});
  assert.ok(out.includes("('1.10')"), out);
});

check('rows are batched into several statements', () => {
  const rows = Array.from({ length: 250 }, (_, i) => [String(i)]);
  const out = ex.toSqlInserts([{ name: 'n', dataTypeID: 20 }], rows, { batch: 100 });
  assert.strictEqual((out.match(/insert into/g) || []).length, 3);
});

check('no rows says so instead of writing a broken statement', () => {
  assert.ok(/no rows/.test(ex.toSqlInserts([{ name: 'a' }], [], {})));
});

console.log('\nMarkdown');

check('a table with a rule under the header', () => {
  const out = ex.toMarkdown([{ name: 'a' }, { name: 'b' }], [['1', '2']]);
  assert.strictEqual(out, '| a | b |\n| --- | --- |\n| 1 | 2 |');
});

check('a pipe in a value does not break the table', () => {
  assert.ok(ex.toMarkdown([{ name: 'a' }], [['x|y']]).includes('x\\|y'));
});

check('a newline in a value is flattened', () => {
  assert.ok(!ex.toMarkdown([{ name: 'a' }], [['x\ny']]).split('\n')[2].includes('\n'));
});

console.log('\nthe format list');

check('render dispatches to each one', () => {
  for (const f of ex.FORMATS) {
    const out = ex.render(f.id, [{ name: 'a', dataTypeID: 25 }], [['x']]);
    assert.ok(typeof out === 'string' && out.length, `${f.id} produced nothing`);
  }
});

check('an unknown format is refused', () => {
  assert.throws(() => ex.render('pdf', [], []), /Unknown export format/);
});

console.log(`\n${process.exitCode ? 'failures above' : `all ${n} checks passed`}\n`);
