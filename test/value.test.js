'use strict';
/* Showing a value without changing it. Run: node test/value.test.js */

const assert = require('assert');
const { prettyJson, hexDump, classify, present, oneLine } = require('../src/shared/valueview.js');

let n = 0;
const check = (label, fn) => {
  try { fn(); n++; console.log(`  ok   ${label}`); }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); process.exitCode = 1; }
};

console.log('\npretty-printing JSON');

check('indents an object', () => {
  const r = prettyJson('{"a":1,"b":2}');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, '{\n  "a": 1,\n  "b": 2\n}');
});

check('nests', () => {
  const r = prettyJson('{"a":{"b":[1,2]}}');
  assert.strictEqual(r.text, '{\n  "a": {\n    "b": [\n      1,\n      2\n    ]\n  }\n}');
});

check('leaves an empty object and array inline', () => {
  assert.strictEqual(prettyJson('{"a":{},"b":[]}').text, '{\n  "a": {},\n  "b": []\n}');
});

// The whole reason this is not JSON.parse + JSON.stringify.
check('a bigint keeps every digit', () => {
  const big = '12345678901234567890';
  const r = prettyJson(`{"id":${big}}`);
  assert.ok(r.text.includes(big), `lost precision: ${r.text}`);
  assert.notStrictEqual(String(JSON.parse(`{"id":${big}}`).id), big);   // what the easy way would do
});

check('a trailing zero on a numeric survives', () => {
  assert.ok(prettyJson('{"amount":1.10}').text.includes('1.10'));
});

check('exponents are copied as written', () => {
  assert.ok(prettyJson('{"x":1.5e-9}').text.includes('1.5e-9'));
});

check('braces and commas inside a string are not structure', () => {
  const r = prettyJson('{"note":"a,b{c}"}');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, '{\n  "note": "a,b{c}"\n}');
});

check('an escaped quote does not end the string', () => {
  const r = prettyJson('{"note":"say \\"hi\\", ok"}');
  assert.strictEqual(r.ok, true);
  assert.ok(r.text.includes('say \\"hi\\", ok'));
});

check('true, false and null pass through', () => {
  assert.strictEqual(prettyJson('[true,false,null]').text, '[\n  true,\n  false,\n  null\n]');
});

console.log('\nand refusing what is not JSON');

check('prose is refused, not reflowed', () => {
  const r = prettyJson('{this is a note, not json}');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.text, '{this is a note, not json}');
});

check('a Postgres array is refused', () => {
  assert.strictEqual(prettyJson('{alice,bob}').ok, false);
});

check('unbalanced braces are refused', () => {
  assert.strictEqual(prettyJson('{"a":1').ok, false);
  assert.strictEqual(prettyJson('{"a":1}}').ok, false);
});

check('an unterminated string is refused', () => {
  assert.strictEqual(prettyJson('{"a":"oops}').ok, false);
});

console.log('\nclassifying a value');

check('null is its own thing', () => {
  assert.strictEqual(classify(null), 'null');
  assert.strictEqual(classify(''), 'text');           // and empty is not null
});

check('a json column is JSON even when it holds a scalar object', () => {
  assert.strictEqual(classify('{"a":1}', { dataType: 'jsonb' }), 'json');
});

check('a text column holding a document is spotted', () => {
  assert.strictEqual(classify('{"a":1}', { dataType: 'text' }), 'json');
});

check('a text column holding prose is not', () => {
  assert.strictEqual(classify('{not json}', { dataType: 'text' }), 'text');
  assert.strictEqual(classify('hello', { dataType: 'text' }), 'text');
});

check('bytea by type or by shape', () => {
  assert.strictEqual(classify('\\xdeadbeef', { dataType: 'bytea' }), 'bytea');
  assert.strictEqual(classify('\\xdeadbeef', {}), 'bytea');
  assert.strictEqual(classify('\\xzz', {}), 'text');                 // not hex
});

check('text with newlines is multiline', () => {
  assert.strictEqual(classify('a\nb'), 'multiline');
});

console.log('\nhex dump');

check('offsets, bytes and ascii', () => {
  const d = hexDump('\\x48656c6c6f');                                 // "Hello"
  assert.strictEqual(d.total, 5);
  assert.ok(d.text.startsWith('00000000  48 65 6c 6c 6f'), d.text);
  assert.ok(d.text.endsWith('|Hello|'), d.text);
});

check('sixteen bytes to a line', () => {
  const d = hexDump(`\\x${'ff'.repeat(20)}`);
  assert.strictEqual(d.text.split('\n').length, 2);
  assert.ok(d.text.includes('00000010'));
});

check('unprintable bytes show as dots', () => {
  assert.ok(hexDump('\\x0001').text.endsWith('|..|'));
});

check('a big value is cut off and says so', () => {
  const d = hexDump(`\\x${'ab'.repeat(5000)}`, { maxBytes: 64 });
  assert.strictEqual(d.total, 5000);
  assert.strictEqual(d.shown, 64);
  assert.strictEqual(d.truncated, true);
});

console.log('\nwhat the panel is handed');

check('NULL is labelled, not blank', () => {
  const p = present(null, { dataType: 'text' });
  assert.strictEqual(p.kind, 'null');
  assert.strictEqual(p.display, 'NULL');
});

check('an empty string is distinguishable from NULL', () => {
  const p = present('', { dataType: 'text' });
  assert.strictEqual(p.kind, 'text');
  assert.strictEqual(p.display, '');
  assert.ok(/0 chars/.test(p.meta), p.meta);
});

check('the raw text is kept alongside the pretty one', () => {
  const p = present('{"a":1}', { dataType: 'jsonb' });
  assert.strictEqual(p.text, '{"a":1}');
  assert.strictEqual(p.display, '{\n  "a": 1\n}');
  assert.strictEqual(p.pretty, true);
});

check('unparseable JSON is shown as it came', () => {
  const p = present('{"a":}', { dataType: 'jsonb' });
  assert.strictEqual(p.display, '{"a":}');
  assert.strictEqual(p.pretty, false);
  assert.ok(/unparsed/.test(p.meta), p.meta);
});

check('pretty can be turned off to see the original', () => {
  const p = present('{"a":1}', { dataType: 'jsonb' }, { pretty: false });
  assert.strictEqual(p.display, '{"a":1}');
});

check('size is in UTF-8 bytes, not characters', () => {
  const p = present('é€', { dataType: 'text' });
  assert.strictEqual(p.chars, 2);
  assert.strictEqual(p.bytes, 5);
});

check('bytea reports its real size', () => {
  const p = present(`\\x${'00'.repeat(2048)}`, { dataType: 'bytea' });
  assert.strictEqual(p.bytes, 2048);
  assert.ok(/2\.0 KB binary/.test(p.meta), p.meta);
});

console.log('\none-line summaries for the row list');

check('newlines collapse', () => {
  assert.strictEqual(oneLine('a\n\nb'), 'a b');
});

check('long values are clipped', () => {
  assert.strictEqual(oneLine('x'.repeat(300), 10), `${'x'.repeat(10)}…`);
});

check('null stays null so the list can style it', () => {
  assert.strictEqual(oneLine(null), null);
});

console.log(`\n${process.exitCode ? 'failures above' : `all ${n} checks passed`}\n`);
