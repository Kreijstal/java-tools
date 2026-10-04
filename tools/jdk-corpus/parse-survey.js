#!/usr/bin/env node
'use strict';
// Parse every .java file under the given roots and count the syntax the
// parser could not model (Unsupported* nodes) and outright parse failures.
const fs = require('fs');
const path = require('path');
const frontend = require('../../src/java-frontend');

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.java')) out.push(p);
  }
  return out;
}

const files = process.argv.slice(2).flatMap(r => walk(r, []));
const kinds = new Map();
const samples = new Map();
let failed = 0, clean = 0;
const failures = new Map();
for (const f of files) {
  let doc;
  try {
    doc = frontend.parseJava(fs.readFileSync(f, 'utf8'), { sourceLevel: 25, sourceFileName: f });
  } catch (e) {
    failed++;
    const k = String(e.message).split('\n')[0].replace(/\d+/g, 'N').slice(0, 100);
    failures.set(k, (failures.get(k) || 0) + 1);
    continue;
  }
  let bad = 0;
  frontend.visitAst(doc, {
    enter(node) {
      if (node && typeof node.kind === 'string' && node.kind.startsWith('Unsupported')) {
        bad++;
        const key = node.kind + ' ' + String(node.reason || node.unsupportedReason || '').slice(0, 80);
        kinds.set(key, (kinds.get(key) || 0) + 1);
        if (!samples.has(key)) samples.set(key, path.relative(process.cwd(), f));
      }
    }
  });
  if (!bad) clean++;
}
console.log(`files=${files.length} clean=${clean} withUnsupported=${files.length - clean - failed} failed=${failed}`);
for (const [k, n] of [...failures].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`FAIL ${n} ${k}`);
for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`${n} ${k}   e.g. ${samples.get(k)}`);
