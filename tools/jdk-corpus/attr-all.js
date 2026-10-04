#!/usr/bin/env node
'use strict';
// Attribute every class of the given source files; summarize failures.
// usage: attr-all.js --roots r1:r2 [--limit N] [--filter substr] files-or-dirs...
const fs = require('fs');
const path = require('path');
const { Compiler } = require('../../src/javac-js/compiler');

function walk(dir, out) {
  const st = fs.statSync(dir);
  if (!st.isDirectory()) { out.push(dir); return out; }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.java') && !p.includes('snippet-files') && e.name !== 'module-info.java' && e.name !== 'package-info.java') out.push(p);
  }
  return out;
}

const argv = process.argv.slice(2);
let roots = [];
let limit = 30;
let filter = null;
const inputs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--roots') roots = argv[++i].split(':');
  else if (argv[i] === '--limit') limit = +argv[++i];
  else if (argv[i] === '--filter') filter = argv[++i];
  else inputs.push(argv[i]);
}
const c = new Compiler({ sourceRoots: roots });
let files = inputs.flatMap((r) => walk(r, []));
if (filter) files = files.filter((f) => f.includes(filter));
const t0 = Date.now();
const units = c.parseFiles(files);
let bad = 0;
const msgs = new Map();
const badFiles = [];
let classes = 0;
for (const cu of units) {
  for (const d of cu.types) {
    classes++;
    try {
      c.attr.attribClass(d.sym);
    } catch (e) {
      bad++;
      badFiles.push(cu.file);
      const m = e.message.replace(/^.*?:\d+:\d+: /, '').replace(/^\/\S+: /, '');
      const key = m.replace(/\b[a-z][\w$]*\.[\w.$]+/g, 'X').slice(0, 120);
      if (!msgs.has(key)) msgs.set(key, { n: 0, ex: e.message.slice(0, 300), stack: e.stack });
      msgs.get(key).n++;
    }
  }
}
console.log(`attributed ${classes} top-level classes in ${Date.now() - t0} ms, ${bad} failed`);
const sorted = [...msgs.entries()].sort((a, b) => b[1].n - a[1].n);
for (const [k, v] of sorted.slice(0, limit)) console.log(`${v.n}  ${v.ex}`);
if (process.env.STACKS) for (const [, v] of sorted.slice(0, 5)) console.log(v.stack.split('\n').slice(0, 12).join('\n'));
