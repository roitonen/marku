// Reads license-checker JSON (from stdin or argv[2]), groups packages by their
// exact license text (the same dedup cargo-about does for Rust), and prints a
// text listing on stdout.
//
// Some npm packages ship no LICENSE file in their tarball - license-checker then
// falls back to the README as "licenseText". We detect that (text that does not
// look like a license) and substitute the real license, recorded once per source
// in OVERRIDES below (looked up by hand from each project's repository; this is
// the frontend analog of cargo-about's [clarifications]). Any package left
// without a real license text and no override is reported and fails the run.
'use strict';
const fs = require('fs');

const MIT_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const mit = (copyright) => `MIT License\n\nCopyright (c) ${copyright}\n\n${MIT_BODY}`;

// Packages that ship no license text in their npm tarball. Copyright lines taken
// by hand from each source repository. The @tauri-apps packages are dual
// "MIT OR Apache-2.0"; we record the MIT option.
const OVERRIDES = [
  { test: (n) => n.startsWith('@uiw/'), text: mit('2021 uiw') },                                       // github.com/uiwjs/react-codemirror
  { test: (n) => n.startsWith('@tauri-apps/'), text: mit('2017 - Present Tauri Apps Contributors') },  // github.com/tauri-apps
];

function looksLikeLicense(t) {
  return /permission is hereby granted|redistribution and use|mozilla public license|apache license|this is free and unencumbered|do what the f|isc license|warranties of merchantability/i.test(t);
}

const src = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8') : fs.readFileSync(0, 'utf8');
const data = JSON.parse(src);

const buckets = new Map(); // license text -> array of "name version"
const unresolved = [];

for (const info of Object.values(data)) {
  let text = String(info.licenseText || '').trim();
  if (!looksLikeLicense(text)) {
    const ov = OVERRIDES.find((o) => o.test(info.name));
    if (ov) text = ov.text;
    else { unresolved.push(`${info.name}@${info.version} (${info.licenses || 'no license'})`); continue; }
  }
  if (!buckets.has(text)) buckets.set(text, []);
  buckets.get(text).push(`${info.name} ${info.version}`);
}

if (unresolved.length) {
  process.stderr.write('Unresolved frontend licenses (look up by hand and add to OVERRIDES):\n');
  for (const u of unresolved) process.stderr.write(`  - ${u}\n`);
  process.exit(1);
}

const out = [];
out.push('='.repeat(80));
out.push('Frontend dependencies (npm, production tree)');
out.push('='.repeat(80));
out.push('');

const groups = [...buckets.entries()].sort((a, b) => a[1][0].localeCompare(b[1][0]));
for (const [text, pkgs] of groups) {
  out.push('-'.repeat(80));
  out.push('Used by:');
  for (const p of pkgs.sort((x, y) => x.localeCompare(y))) out.push(`  - ${p}`);
  out.push('-'.repeat(80));
  out.push('');
  out.push(text);
  out.push('');
}
process.stdout.write(out.join('\n') + '\n');
