#!/usr/bin/env node
'use strict';
// Debug helper: attribute one file and print the types of local variables
// (and their initializers) declared on a given line.
// usage: typeof.js --roots r1:r2 file line
const fs = require('fs');
const { Compiler } = require('../../src/javac-js/compiler');
const T = require('../../src/javac-js/types');
const argv = process.argv.slice(2);
let roots = [];
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--roots') roots = argv[++i].split(':');
  else rest.push(argv[i]);
}
const [file, lineStr] = rest;
const line = +lineStr;
const c = new Compiler({ sourceRoots: roots });
const [cu] = c.parseFiles([file]);
let err = null;
try { for (const d of cu.types) c.attr.attribClass(d.sym); } catch (e) { err = e; }
const seen = new Set();
function visit(n) {
  if (!n || typeof n !== 'object' || seen.has(n)) return;
  seen.add(n);
  if (Array.isArray(n)) { n.forEach(visit); return; }
  if (n.tag && typeof n.pos === 'number' && cu.lineCol(n.pos).line === line && n.type && n.tag !== 'Literal') {
    const lc = cu.lineCol(n.pos);
    console.log(`${lc.line}:${lc.col} ${n.tag}${n.name ? ' ' + n.name : ''} : ${T.typeToString(n.type)}${n.sym && n.sym.type ? '  sym: ' + T.typeToString(n.sym.type) : ''}`);
  }
  if (n.tag === 'VarDecl' && n.sym && cu.lineCol(n.pos).line === line) console.log(`var ${n.name} : ${T.typeToString(n.sym.type)}`);
  for (const k of Object.keys(n)) {
    if (k === 'sym' || k === 'type' || k === 'lambdaInfo' || k === 'fn' || k === 'target' || k === 'coerceTo' || k === 'mtype' || k === 'env') continue;
    const v = n[k];
    if (v && typeof v === 'object') visit(v);
  }
}
visit(cu);
if (err) console.log('ERROR:', err.message);
