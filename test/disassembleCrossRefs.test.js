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

function assembleJasmin(source, outputPath) {
  const ast = convertKrak2AstToClassAst(parseKrak2Assembly(source), { sourceText: source });
  writeClassAstToClassFile(ast, outputPath);
}

test('disassemble emits cross-reference comments when classpath provided', (t) => {
  withTempDir('disassemble-xref-', (dir) => {
    const fooSource = `
.class public Foo
.super java/lang/Object

.field public static counter I

.method public static callee : ()V
    .code stack 1 locals 0
L0:    return
    .end code
.end method

.method public static caller : ()V
    .code stack 1 locals 0
L0:    invokestatic Method Foo callee ()V
L3:    return
    .end code
.end method

.method public static read : ()I
    .code stack 1 locals 0
L0:    getstatic Field Foo counter I
L3:    ireturn
    .end code
.end method
.end class
`.trim();
    const fooClassPath = path.join(dir, 'Foo.class');
    assembleJasmin(fooSource, fooClassPath);

    const helperSource = `
.class public Helper
.super java/lang/Object

.method public static invokeCallee : ()V
    .code stack 1 locals 0
L0:    invokestatic Method Foo callee ()V
L3:    return
    .end code
.end method

.method public static loadCounter : ()I
    .code stack 1 locals 0
L0:    getstatic Field Foo counter I
L3:    ireturn
    .end code
.end method
.end class
`.trim();
    assembleJasmin(helperSource, path.join(dir, 'Helper.class'));

    const cli = path.join(__dirname, '..', 'scripts', 'jvm-cli.js');
    const output = execFileSync(
      'node',
      [cli, 'disassemble', fooClassPath, '--stdout', '--xref-classpath', dir],
      { encoding: 'utf8' },
    ).replace(/\r\n/g, '\n');

    t.ok(
      output.includes('; callers:\n;   Foo.caller()V\n;   Helper.invokeCallee()V'),
      'callee method should list callers',
    );
    t.ok(
      output.includes(
        '; references:\n;   getstatic by Foo.read()I\n;   getstatic by Helper.loadCounter()I',
      ),
      'field definition should include references',
    );
    t.end();
  });
});
