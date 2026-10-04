#!/usr/bin/env node
'use strict';
// Enter every source under the roots and complete all class headers and members.
const fs = require('fs');
const path = require('path');
const { Compiler } = require('../../src/javac-js/compiler');

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.java') && e.name !== 'module-info.java' && e.name !== 'package-info.java') out.push(p);
  }
  return out;
}

const roots = process.argv.slice(2);
const c = new Compiler({ sourceRoots: roots });
const files = roots.flatMap((r) => walk(r, []));
let t0 = Date.now();
const units = c.parseFiles(files);
console.log(`parsed+entered ${units.length} units in ${Date.now() - t0} ms; classes=${c.syms.classes.size}`);
t0 = Date.now();
let bad = 0;
const msgs = new Map();
for (const sym of [...c.syms.classes.values()]) {
  try {
    c.syms.completeMembers(sym);
  } catch (e) {
    bad++;
    const m = e.message.replace(/^.*?: (?=[a-z])/, '');
    msgs.set(m, (msgs.get(m) || 0) + 1);
    if (bad <= 20) console.log(e.message);
  }
}
console.log(`completed ${c.syms.classes.size} classes in ${Date.now() - t0} ms, ${bad} failed`);
for (const [k, n] of [...msgs].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(n, k);
