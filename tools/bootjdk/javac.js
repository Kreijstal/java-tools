'use strict';
// The shim boot JDK's `javac`: translates the javac command line the JDK
// build uses into a javac-js compilation. The platform API comes from the
// JDK's own sources (config.platformRoots), since javac-js reads no class
// files. Options that only affect diagnostics are accepted and ignored.
const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');

// javac's @argfile syntax: whitespace separated, single or double quotes
function expandArgFiles(args) {
  const out = [];
  for (const a of args) {
    if (!a.startsWith('@')) { out.push(a); continue; }
    const text = fs.readFileSync(a.slice(1), 'utf8');
    for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) {
      out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] !== undefined ? m[2] : m[3]);
    }
  }
  return out;
}

const IGNORED_WITH_ARG = new Set([
  '--release', '-source', '--source', '-target', '--target', '-Xmaxwarns', '-Xmaxerrs',
  '--module-path', '-p', '--upgrade-module-path', '--add-modules', '--limit-modules',
  '--add-exports', '--add-reads', '--add-opens', '--patch-module', '--system', '--module-version',
  '--doclint-format', '-processorpath', '--processor-path', '-s',
]);
const IGNORED_FLAG = /^(-Werror|-nowarn|-deprecation|-parameters|-verbose|-g(:.*)?|-Xlint(:.*)?|-Xdoclint([:/].*)?|-XD.*|-implicit:.*|-proc:none|-Xprefer:.*|--enable-preview|-Xdiags:.*|-XDignore.symbol.file.*)$/;

function parseArgs(argv) {
  const o = { out: null, roots: [], files: [], encoding: 'utf-8' };
  const internalApi = (a) => /^-XDinternalAPIPath=/.test(a);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-J')) continue;
    if (a === '-d') o.out = argv[++i];
    else if (a === '-encoding') o.encoding = argv[++i];
    else if (a === '-cp' || a === '-classpath' || a === '--class-path' || a === '-sourcepath' || a === '--source-path') {
      o.roots.push(...argv[++i].split(path.delimiter).filter(Boolean));
    } else if (a === '-h') o.headerDir = argv[++i];
    else if (a === '--module-source-path') o.moduleSourcePath = argv[++i];
    // the build's dependency plugin: its API digest files are written as stamps
    else if (a.startsWith('-Xplugin:depend ')) o.pubapi = a.slice('-Xplugin:depend '.length);
    else if (internalApi(a)) o.internalApi = a.slice(a.indexOf('=') + 1);
    else if (a.startsWith('-Xplugin') || a.startsWith('-processor')) throw new Error(`${a} is not supported by the javac-js shim`);
    else if (IGNORED_WITH_ARG.has(a)) i++;
    else if (/^--[\w-]+=/.test(a) || IGNORED_FLAG.test(a)) continue;
    else if (a.startsWith('-')) throw new Error(`javac-js shim: unknown option ${a}`);
    else o.files.push(a);
  }
  if (!/^utf-?8$/i.test(o.encoding)) throw new Error(`javac-js shim: unsupported encoding ${o.encoding}`);
  if (!o.out) throw new Error('javac-js shim: -d is required');
  return o;
}

// --module-source-path: a pattern with * standing for the module name, or
// (unsupported here) module=path entries
function moduleRoots(pattern) {
  const roots = new Map(); // module -> existing source dirs
  const { conf } = require('./config');
  const parts = pattern.split(path.delimiter).filter(Boolean);
  const names = new Set();
  for (const p of parts) {
    const star = p.indexOf('*');
    if (star < 0) throw new Error(`javac-js shim: unsupported --module-source-path entry ${p}`);
    const base = p.slice(0, star);
    try { for (const n of fs.readdirSync(base)) names.add(n); } catch (e) { /* missing */ }
  }
  if (conf.jdkSrc) for (const n of fs.readdirSync(path.join(conf.jdkSrc, 'src'))) names.add(n);
  for (const m of [...names].sort()) {
    const dirs = parts.map((p) => p.replace('*', m)).filter((d) => fs.existsSync(d) && fs.statSync(d).isDirectory());
    if (dirs.length) roots.set(m, dirs.map((d) => path.resolve(d)));
  }
  return roots;
}

function writeStamp(file, text) {
  let old = null;
  try { old = fs.readFileSync(file, 'utf8'); } catch (e) { /* new */ }
  if (old !== text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
}

function compile(o) {
  const { Compiler } = require('../../src/javac-js/compiler');
  const { platformRoots } = require('./config');
  const { LNSEP } = require('./tools/util');
  const opts = (out, hdr) => ({ headerDir: hdr, headerNewline: LNSEP });
  let r;
  if (o.moduleSourcePath) {
    // multi-module mode: classes go to <-d>/<module>, headers to <-h>/<module>
    const mods = moduleRoots(o.moduleSourcePath);
    const all = [];
    for (const dirs of mods.values()) all.push(...dirs);
    const c = new Compiler({ sourceRoots: [...all, ...o.roots] });
    const byModule = new Map();
    for (const f of o.files) {
      const abs = path.resolve(f);
      let mod = null;
      for (const [m, dirs] of mods) if (dirs.some((d) => abs.startsWith(d + path.sep))) { mod = m; break; }
      if (!mod) throw new Error(`javac-js shim: ${f} is not in any module source directory`);
      if (!byModule.has(mod)) byModule.set(mod, []);
      byModule.get(mod).push(abs);
    }
    r = { written: [], errors: [] };
    for (const [m, files] of byModule) {
      const one = c.compile(files, path.join(o.out, m), opts(null, o.headerDir && path.join(o.headerDir, m)));
      r.written.push(...one.written);
      r.errors.push(...one.errors);
    }
  } else {
    const c = new Compiler({ sourceRoots: [...o.roots, ...platformRoots()] });
    r = c.compile(o.files, o.out, opts(null, o.headerDir));
  }
  if (!r.errors.length) {
    const digest = require('crypto').createHash('sha256');
    for (const f of [...o.files].sort()) digest.update(`${f}\0${fs.statSync(f).mtimeMs}\n`);
    if (o.pubapi) writeStamp(o.pubapi, `${digest.digest('hex')}\n`);
    if (o.internalApi) writeStamp(o.internalApi, '');
  }
  const lines = [];
  for (const e of r.errors) {
    const msg = e.error.message || String(e.error);
    const where = e.file && !msg.includes(e.file) ? `${e.file}: ` : '';
    lines.push(`${where}${e.cls ? e.cls + ': ' : ''}${msg}`);
  }
  if (r.errors.length) lines.push(`${r.errors.length} error${r.errors.length > 1 ? 's' : ''}`);
  return { lines, errors: r.errors.length };
}

function main(argv, finish) {
  let o;
  try {
    o = parseArgs(expandArgFiles(argv));
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    finish(2);
    return;
  }
  if (!o.files.length) { process.stderr.write('error: no source files\n'); finish(2); return; }
  // a worker with a large stack: attribution recurses deeply
  const w = new Worker(__filename, {
    workerData: o,
    env: process.env,
    resourceLimits: { stackSizeMb: 256, maxOldGenerationSizeMb: +(process.env.JAVAC_JS_HEAP_MB || 8000) },
  });
  let code = null;
  w.on('message', (m) => {
    for (const l of m.lines) process.stderr.write(`${l}\n`);
    code = m.errors ? 1 : 0;
  });
  w.on('error', (e) => { process.stderr.write(`${e && e.stack || e}\n`); code = 3; });
  w.on('exit', (c) => finish(code === null ? (c || 3) : code));
}

if (!isMainThread) parentPort.postMessage(compile(workerData));

module.exports = { main, parseArgs };
