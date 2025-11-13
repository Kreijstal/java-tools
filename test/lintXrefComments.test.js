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

test('lint --fix -n --xref-comments emits caller/reference comments', (t) => {
  withTempDir('lint-xref-', (dir) => {
    const fooSource = `
.class public Foo
.super java/lang/Object

.field public static counter I

.method public static callee : ()V
    .code stack 1 locals 0
L0:    iconst_0
L1:    putstatic Field Foo counter I
L4:    return
    .end code
.end method

.method public static caller : ()V
    .code stack 1 locals 0
L0:    invokestatic Method Foo callee ()V
L3:    return
    .end code
.end method

.method public static dummy : ()V
    .code stack 1 locals 0
L0:    goto L2
L1:    return
L2:    return
    .end code
.end method

.method public static read : ()I
    .code stack 1 locals 0
L0:    getstatic Field Foo counter I
L3:    ireturn
    .end code
.end method

.method public static pureFun : ()I
    .code stack 1 locals 0
L0:    iconst_0
L1:    ireturn
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
      [
        cli,
        'lint',
        fooClassPath,
        '--fix',
        '-n',
        '--classpath',
        dir,
        '--xref-comments',
      ],
      { encoding: 'utf8' },
    ).replace(/\r\n/g, '\n');

    t.ok(output.includes('+;   Foo.caller()V'), 'diff should include Foo caller reference');
    t.ok(output.includes('+;   Helper.invokeCallee()V'), 'diff should include Helper caller reference');
    t.ok(output.includes('+;   getstatic by Foo.read()I'), 'diff should include Foo field reference');
    t.ok(
      output.includes('+;   getstatic by Helper.loadCounter()I'),
      'diff should include Helper field reference',
    );
    t.ok(
      output.includes('+; purity: pure'),
      'diff should include purity annotation for pure methods',
    );
    t.ok(
      output.includes('+; purity: impure'),
      'diff should include impurity annotation for impure methods',
    );
    t.ok(output.includes('+; throws declared: (none)'), 'diff should include declared throws info');
    t.ok(output.includes('+; throws implicit: (none)'), 'diff should include implicit throws info');
    t.end();
  });
});
