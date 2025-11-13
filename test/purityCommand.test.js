'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('tape');
const { parseKrak2Assembly } = require('../src/parse_krak2');
const { convertKrak2AstToClassAst } = require('../src/convert_krak2_ast');
const { writeClassAstToClassFile } = require('../src/classAstToClassFile');

function withTempDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assembleJ(source, outPath) {
  const ast = convertKrak2AstToClassAst(parseKrak2Assembly(source), { sourceText: source });
  writeClassAstToClassFile(ast, outPath);
}

test('purity command emits JSON with reasons', (t) => {
  withTempDir('purity-cli-', (dir) => {
    const helperSource = `
.class public Helper
.super java/lang/Object

.method public static pureMethod : ()V
    .code stack 0 locals 0
L0:    return
    .end code
.end method

.method public static impureMethod : ()V
    .code stack 1 locals 0
L0:    getstatic Field java/lang/System out Ljava/io/PrintStream;
L3:    ldc "hi"
L6:    invokevirtual Method java/io/PrintStream println (Ljava/lang/String;)V
L9:    return
    .end code
.end method
.end class
`.trim();
    const helperPath = path.join(dir, 'Helper.class');
    assembleJ(helperSource, helperPath);

    const cli = path.join(__dirname, '..', 'scripts', 'jvm-cli.js');
    const output = execFileSync('node', [cli, 'purity', helperPath, '--json'], {
      encoding: 'utf8',
    });
    const metadata = JSON.parse(output);
    const pureEntry = metadata.find((entry) => entry.methodName === 'pureMethod');
    const impureEntry = metadata.find((entry) => entry.methodName === 'impureMethod');
    t.ok(pureEntry.pure, 'pureMethod should be reported pure');
    t.notOk(impureEntry.pure, 'impureMethod should not be pure');
    t.ok(impureEntry.reasons.some((reason) => reason.includes('reads static field')), 'impure reason should mention static field read');
    t.end();
  });
});
