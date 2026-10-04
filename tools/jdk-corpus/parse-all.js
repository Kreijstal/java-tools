#!/usr/bin/env node
'use strict';
// Parse every .java file under the given roots with the javac-js parser.
const fs = require('fs');
const path = require('path');
const { parse } = require('../../src/javac-js/parser');

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.java')) out.push(p);
  }
  return out;
}

const files = process.argv.slice(2).flatMap((r) => walk(r, []));
let bad = 0;
const t0 = Date.now();
const kinds = new Map();
for (const f of files) {
  try {
    parse(fs.readFileSync(f, 'utf8'), f);
  } catch (e) {
    bad++;
    const msg = e.message.replace(/^.*?:\d+:\d+: /, '');
    kinds.set(msg, (kinds.get(msg) || 0) + 1);
    if (bad <= 25) console.log(e.message);
  }
}
console.log(`${files.length} files, ${bad} failed, ${Date.now() - t0} ms`);
for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(n, k);
