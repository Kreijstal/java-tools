#!/usr/bin/env node
'use strict';
// Bulk pipeline runner: applies our deobfuscation passes to a directory
// of .class files in a single Node.js process. Between passes we
// serialize the AST back to bytecode and re-parse it — the round trip
// normalizes stack-map frames / label aliases / constant pool ordering
// that subsequent passes depend on (matches the per-pass CLI behaviour
// exactly).
const fs = require('fs');
const path = require('path');
const JT = path.resolve(__dirname, '..');
const { getAST } = require('jvm_parser');
const { convertJson } = require(JT + '/src/convert_tree');
const { writeClassAstToClassFile } = require(JT + '/src/classAstToClassFile');
const os = require('os');
const { runPeepholeClean } = require(JT + '/src/peepholeClean');
const { removeTrivialRethrowHandlers } = require(JT + '/src/removeTrivialRethrowHandlers');
const { runMultiEntryLoopNormalizer } = require(JT + '/src/multiEntryLoopNormalizer');
const { runCoalesceLoopLoad } = require(JT + '/src/coalesceLoopLoad');
const { runDeadStaticBoolFlag } = require(JT + '/src/deadStaticBoolFlag');
const { runInlineSharedExitGoto } = require(JT + '/src/inlineSharedExitGoto');
const { runInlineSharedReturn } = require(JT + '/src/inlineSharedReturn');

const inDir = process.argv[2];
const outDir = process.argv[3];
const skipInline = process.argv.includes('--skip-inline');
fs.mkdirSync(outDir, { recursive: true });

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulkpipe-'));
const tmpFile = path.join(tmpDir, 'tmp.class');

function loadAst(filePath) {
  const buf = fs.readFileSync(filePath);
  const parsed = getAST(new Uint8Array(buf));
  return { ast: convertJson(parsed.ast, parsed.constantPool), cp: parsed.constantPool };
}
function saveAndReload(ast, cp) {
  writeClassAstToClassFile(ast, tmpFile, cp);
  return loadAst(tmpFile);
}

const passes = [
  { name: 'peephole', fn: (a) => runPeepholeClean(a) },
  { name: 'strip-rethrow', fn: (a) => removeTrivialRethrowHandlers(a, { keepHandlerCode: true }) },
  { name: 'normalizer', fn: (a) => runMultiEntryLoopNormalizer(a) },
  { name: 'coalesce', fn: (a) => runCoalesceLoopLoad(a) },
  { name: 'dead-flag', fn: (a) => runDeadStaticBoolFlag(a) },
  ...(skipInline ? [] : [{ name: 'inline-exit', fn: (a) => runInlineSharedExitGoto(a, { maxBodyInsns: 50 }) }]),
  { name: 'inline-return', fn: (a) => runInlineSharedReturn(a, { oncePerMethod: false }) },
  { name: 'peephole2', fn: (a) => runPeepholeClean(a) },
];

const files = fs.readdirSync(inDir).filter((f) => f.endsWith('.class'));
let processed = 0;
let failed = 0;
for (const f of files) {
  const inPath = path.join(inDir, f);
  const outPath = path.join(outDir, f);
  try {
    let { ast, cp } = loadAst(inPath);
    for (const p of passes) {
      p.fn(ast);
      ({ ast, cp } = saveAndReload(ast, cp));
    }
    writeClassAstToClassFile(ast, outPath, cp);
    processed += 1;
  } catch (err) {
    failed += 1;
    fs.copyFileSync(inPath, outPath);
  }
}
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`Done: ${processed}/${files.length} processed, ${failed} failed (passthrough)`);
