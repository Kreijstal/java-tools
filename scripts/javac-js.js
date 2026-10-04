#!/usr/bin/env node
'use strict';
// Command line front end for src/javac-js.
// usage: javac-js.js [-d outdir] [-sourcepath r1:r2] [--major N] [--fail-fast] [-v] files... | @argfile
//
// The compiler runs in a worker thread with a large, explicitly sized stack:
// the recursive descent over deeply nested expressions needs more stack than
// a main thread gets on Windows.
const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');

// @file arguments (one argument per line), as with javac; needed on Windows
// where a module's file list exceeds the command line length limit
function expandArgs(list) {
  const out = [];
  for (const a of list) {
    if (a.startsWith('@')) {
      for (const line of fs.readFileSync(a.slice(1), 'utf8').split(/\r?\n/)) if (line.trim()) out.push(line.trim());
    } else out.push(a);
  }
  return out;
}

function parseArgs(argv) {
  const o = { out: '.', roots: [], major: 72, failFast: false, verbose: false, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-d') o.out = argv[++i];
    else if (a === '-sourcepath' || a === '--source-path') o.roots = argv[++i].split(path.delimiter);
    else if (a === '--major') o.major = +argv[++i];
    else if (a === '--fail-fast') o.failFast = true;
    else if (a === '-v') o.verbose = true;
    else o.files.push(a);
  }
  return o;
}

function run(o) {
  const { Compiler } = require('../src/javac-js/compiler');
  const c = new Compiler({ sourceRoots: o.roots, major: o.major });
  const t0 = Date.now();
  let files = o.files;
  if (process.env.JAVAC_JS_SHUFFLE) {
    // deterministic shuffle, to find attribution-order dependent bugs
    let seed = +process.env.JAVAC_JS_SHUFFLE || 1;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    files = files.slice();
    for (let i = files.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [files[i], files[j]] = [files[j], files[i]]; }
  }
  const r = c.compile(files, o.out, { failFast: o.failFast });
  const lines = [];
  for (const e of r.errors) {
    const msg = e.error.message || String(e.error);
    const where = e.file && !msg.includes(e.file) ? `${e.file}: ` : '';
    lines.push(`${e.phase}: ${e.cls ? e.cls + ': ' : ''}${where}${msg}`);
    if (o.verbose && e.error.stack) lines.push(e.error.stack.split('\n').slice(1, 8).join('\n'));
  }
  lines.push(`${r.written.length} class files written, ${r.errors.length} errors, ${Date.now() - t0} ms`);
  return { lines, errors: r.errors.length };
}

if (isMainThread) {
  const o = parseArgs(expandArgs(process.argv.slice(2)));
  const w = new Worker(__filename, {
    workerData: o,
    resourceLimits: { stackSizeMb: 256, maxOldGenerationSizeMb: +(process.env.JAVAC_JS_HEAP_MB || 12000) },
  });
  w.on('message', (m) => {
    for (const l of m.lines) console.error(l);
    process.exitCode = m.errors ? 1 : 0;
  });
  w.on('error', (e) => { console.error(e && e.stack || String(e)); process.exitCode = 2; });
  w.on('exit', (code) => { if (code && !process.exitCode) { console.error(`compiler worker exited with code ${code}`); process.exitCode = 2; } });
} else {
  parentPort.postMessage(run(workerData));
}
