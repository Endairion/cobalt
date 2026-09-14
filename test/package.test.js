'use strict';
/* What gets shipped, and what updating does to what you have saved.
   Run: node test/package.test.js */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');

let n = 0;
const check = (label, fn) => {
  try { fn(); n++; console.log(`  ok   ${label}`); }
  catch (e) { console.log(`  FAIL ${label}\n       ${e.message}`); process.exitCode = 1; }
};

const b = pkg.build || {};

console.log('\nwhat the installer is');

check('one NSIS installer, for x64 Windows', () => {
  const targets = (b.win || {}).target || [];
  assert.strictEqual(targets.length, 1, `expected one target, got ${JSON.stringify(targets)}`);
  assert.strictEqual(targets[0].target, 'nsis');
  assert.deepStrictEqual(targets[0].arch, ['x64']);
});

check('it is named after the version, so two builds never collide', () => {
  assert.ok(/\$\{version\}/.test((b.win || {}).artifactName || ''),
    `got ${JSON.stringify((b.win || {}).artifactName)}`);
});

check('the app id is stable — it is what an upgrade matches on', () => {
  assert.strictEqual(b.appId, 'com.endairion.cobalt');
  assert.strictEqual(b.productName, 'Cobalt');
});

console.log('\nupgrading in place');

// NSIS replaces an existing install of the same appId rather than sitting
// beside it. These are the settings that keep that true and keep it painless.
check('it installs per user, so no admin prompt and no second copy', () => {
  assert.strictEqual((b.nsis || {}).perMachine, false);
  assert.strictEqual((b.nsis || {}).allowElevation, false);
});

// The one that would actually lose your work.
check('uninstalling does not delete saved connections', () => {
  assert.strictEqual((b.nsis || {}).deleteAppDataOnUninstall, false,
    'userData holds the connections, workspace and history — the installer must not touch it');
});

check('you get a say in where it goes', () => {
  assert.strictEqual((b.nsis || {}).oneClick, false);
  assert.strictEqual((b.nsis || {}).allowToChangeInstallationDirectory, true);
});

console.log('\nwhere updates come from');

check('the feed is the project it is built from', () => {
  const p = (b.publish || [])[0] || {};
  assert.strictEqual(p.provider, 'github');
  assert.strictEqual(p.owner, 'Endairion');
  assert.strictEqual(p.repo, 'cobalt');
});

check('electron-updater ships with the app, not as a build tool', () => {
  assert.ok(pkg.dependencies['electron-updater'],
    'it runs inside the packaged app, so it belongs in dependencies');
  assert.ok(pkg.devDependencies['electron-builder'],
    'the builder only runs here, so it belongs in devDependencies');
});

console.log('\nwhat is inside');

check('the renderer bundle is included even though git ignores it', () => {
  assert.ok((b.files || []).some((f) => f === 'src/**/*'),
    `src must be packaged whole: ${JSON.stringify(b.files)}`);
  const ignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.ok(/bundle\.js/.test(ignore), 'the bundle is generated, so it is git-ignored');
});

check('the build script builds the bundle first', () => {
  // Packaging a stale bundle is the obvious way to ship yesterday's renderer.
  assert.ok(/npm run build && electron-builder/.test(pkg.scripts.dist), pkg.scripts.dist);
  assert.ok(/npm run build && electron-builder/.test(pkg.scripts.pack), pkg.scripts.pack);
});

check('tests, fixtures and screenshots are not shipped', () => {
  const files = b.files || [];
  assert.ok(!files.some((f) => /^test/.test(String(f))), JSON.stringify(files));
  assert.ok(!files.some((f) => /^shots/.test(String(f))), JSON.stringify(files));
});

check('there is an icon to build the installer and shortcuts from', () => {
  const icon = path.join(__dirname, '..', 'assets', 'icon.png');
  assert.ok(fs.existsSync(icon), 'run `npm run icon` — it is generated, not checked in by hand');
  assert.ok(fs.statSync(icon).size > 1000, 'and it should not be empty');
  assert.strictEqual((b.win || {}).icon, 'assets/icon.png');
});

console.log('\nthe built installer, if one has been made');

const dist = path.join(__dirname, '..', 'dist');
const setup = fs.existsSync(dist)
  ? fs.readdirSync(dist).find((f) => /^Cobalt-Setup-.*\.exe$/.test(f))
  : null;

if (!setup) {
  console.log('  --   no dist/ yet; run `npm run dist` to check the artifacts');
} else {
  check('it is named for the version in package.json', () => {
    assert.strictEqual(setup, `Cobalt-Setup-${pkg.version}.exe`,
      `found ${setup} but package.json says ${pkg.version}`);
  });

  check('the update feed file is written beside it', () => {
    // electron-updater reads latest.yml to decide whether there is anything new.
    const yml = path.join(dist, 'latest.yml');
    assert.ok(fs.existsSync(yml), 'latest.yml is what the updater checks');
    const text = fs.readFileSync(yml, 'utf8');
    assert.ok(text.includes(pkg.version), `latest.yml should name ${pkg.version}`);
    assert.ok(/sha512:/.test(text), 'and carry a checksum');
  });

  check('it is a plausible size rather than an empty shell', () => {
    const bytes = fs.statSync(path.join(dist, setup)).size;
    assert.ok(bytes > 40 * 1024 * 1024, `${Math.round(bytes / 1024 / 1024)} MB looks too small`);
  });
}

console.log(`\n${process.exitCode ? 'failures above' : `all ${n} checks passed`}\n`);
