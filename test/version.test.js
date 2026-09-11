'use strict';
/* Keeps the version story honest: package.json, the changelog data, the
   generated CHANGELOG.md and the git tags all have to agree.
   Run: node test/version.test.js */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const pkg = require('../package.json');
const { releases, current, since, compareVersions, grouped, TYPES } = require('../src/shared/changelog');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

console.log('\nchangelog data');

test('every release is well formed', () => {
  assert.ok(releases.length, 'there is at least one release');
  for (const r of releases) {
    assert.match(r.version, /^\d+\.\d+\.\d+$/, `${r.version} is a dotted version`);
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/, `${r.version} has an ISO date`);
    assert.ok(r.title && r.title.length, `${r.version} has a title`);
    assert.ok(Array.isArray(r.changes) && r.changes.length, `${r.version} lists changes`);
    for (const c of r.changes) {
      assert.ok(TYPES.includes(c.type), `${r.version}: "${c.type}" is a known change type`);
      assert.ok(c.text && c.text.length > 10, `${r.version}: change text is substantive`);
    }
  }
});

test('releases run newest first with no duplicates', () => {
  const versions = releases.map((r) => r.version);
  assert.strictEqual(new Set(versions).size, versions.length, 'no duplicate versions');
  for (let i = 1; i < releases.length; i++) {
    assert.strictEqual(
      compareVersions(releases[i - 1].version, releases[i].version), 1,
      `${releases[i - 1].version} must sort above ${releases[i].version}`
    );
  }
});

test('dates never go backwards as versions climb', () => {
  for (let i = 1; i < releases.length; i++) {
    assert.ok(releases[i - 1].date >= releases[i].date,
      `${releases[i - 1].version} (${releases[i - 1].date}) is not older than ${releases[i].version} (${releases[i].date})`);
  }
});

test('package.json matches the newest release', () => {
  assert.strictEqual(pkg.version, current().version,
    `package.json says ${pkg.version}, changelog says ${current().version}`);
});

console.log('\nversion comparison');

test('compareVersions orders correctly', () => {
  assert.strictEqual(compareVersions('0.2.0', '0.10.0'), -1, 'numeric, not lexical');
  assert.strictEqual(compareVersions('1.0.0', '0.9.9'), 1);
  assert.strictEqual(compareVersions('0.3.0', '0.3.0'), 0);
  assert.strictEqual(compareVersions('0.3', '0.3.0'), 0, 'missing parts count as zero');
  assert.strictEqual(compareVersions('0.4.1', '0.4.0'), 1);
});

test('since() returns only what came after a version', () => {
  const all = releases.map((r) => r.version);
  const oldest = all[all.length - 1];
  assert.deepStrictEqual(since(oldest).map((r) => r.version), all.slice(0, -1));
  assert.deepStrictEqual(since(current().version), [], 'nothing is newer than the newest');
  assert.deepStrictEqual(since(null), [], 'a first run has no catch-up');
  assert.deepStrictEqual(since('0.0.1').map((r) => r.version), all, 'an unknown old version shows everything');
});

test('grouped() buckets changes and drops empty types', () => {
  const g = grouped(releases.find((r) => r.changes.some((c) => c.type === 'fixed')));
  assert.ok(g.length, 'returns groups');
  assert.ok(g.every((x) => x.items.length), 'no empty groups');
  const order = g.map((x) => x.type);
  assert.deepStrictEqual(order, [...order].sort((a, b) => TYPES.indexOf(a) - TYPES.indexOf(b)),
    'groups follow the canonical type order');
});

console.log('\ngenerated file');

test('CHANGELOG.md is in sync with the data', () => {
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'gen-changelog.js'), '--check'],
    { stdio: 'pipe' });
});

test('CHANGELOG.md mentions every version', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  for (const r of releases) assert.ok(text.includes(`## ${r.version}`), `${r.version} is in the file`);
});

console.log('\ngit tags');

test('every release before the newest is tagged', () => {
  let tags;
  try {
    tags = execFileSync('git', ['tag', '--list'], { cwd: path.join(__dirname, '..'), stdio: 'pipe' })
      .toString().split('\n').map((t) => t.trim()).filter(Boolean);
  } catch {
    console.log('       (skipped — not a git repo)');
    return;
  }
  // The newest version is tagged only once its commit lands, so allow it to be missing.
  for (const r of releases.slice(1)) {
    assert.ok(tags.includes(`v${r.version}`), `v${r.version} is tagged (tags: ${tags.join(', ') || 'none'})`);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
