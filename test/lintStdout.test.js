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

test('lint --fix --stdout prints updated Jasmin to stdout', (t) => {
  withTempDir('lint-stdout-', (dir) => {
    const fooSource = `
.class public Foo
.super java/lang/Object

.method public static dummy : ()V
    .code stack 1 locals 0
L0:    goto L2
L1:    return
L2:    return
    .end code
.end method
.end class
`.trim();
    const fooClassPath = path.join(dir, 'Foo.class');
    assembleJasmin(fooSource, fooClassPath);

    const cli = path.join(__dirname, '..', 'scripts', 'jvm-cli.js');
    const stdout = execFileSync(
      'node',
      [cli, 'lint', fooClassPath, '--fix', '--stdout'],
      { encoding: 'utf8' },
    );
    t.notOk(stdout.includes('1)'), 'stdout should not include diagnostics');
    t.ok(stdout.includes('.method public static dummy : ()V'), 'stdout should contain method');
    t.notOk(stdout.includes('goto'), 'stdout should exclude original goto');
    t.notOk(stdout.includes('@@'), 'stdout should not be a diff');
    t.end();
  });
});
