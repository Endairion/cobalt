'use strict';
/* Writes CHANGELOG.md from src/shared/changelog.js so the file and the in-app
   history can never drift. Run: npm run changelog  (add --check to verify only) */

const fs = require('fs');
const path = require('path');
const { releases, grouped } = require('../src/shared/changelog');

const file = path.join(__dirname, '..', 'CHANGELOG.md');

function render() {
  const out = [
    '# Changelog',
    '',
    'Generated from `src/shared/changelog.js` by `npm run changelog` — edit that file, not this one.',
    'The same data is what the app shows under Help → What\'s New.',
    '',
  ];
  for (const r of releases) {
    out.push(`## ${r.version} — ${r.title}`);
    out.push(`*${r.date}*`);
    out.push('');
    if (r.summary) { out.push(r.summary); out.push(''); }
    for (const g of grouped(r)) {
      out.push(`### ${g.label}`);
      for (const item of g.items) out.push(`- ${item.text}`);
      out.push('');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

const text = render();

if (process.argv.includes('--check')) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (existing !== text) {
    console.error('CHANGELOG.md is out of date — run `npm run changelog`.');
    process.exit(1);
  }
  console.log('CHANGELOG.md is up to date.');
} else {
  fs.writeFileSync(file, text, 'utf8');
  console.log(`wrote CHANGELOG.md (${releases.length} releases)`);
}
