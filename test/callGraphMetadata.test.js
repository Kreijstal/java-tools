'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('tape');
const { collectMethodCallers } = require('../src/callGraphMetadata');
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

test('collectMethodCallers attaches callers to callee entries', (t) => {
  const ast = {
    classes: [
      {
        className: 'Foo',
        items: [
          {
            type: 'method',
            method: {
              name: 'called',
              descriptor: '()V',
              attributes: [
                {
                  type: 'code',
                  code: {
                    codeItems: [{ pc: 0, instruction: 'return' }],
                    exceptionTable: [],
                    attributes: [],
                  },
                },
              ],
            },
          },
          {
            type: 'method',
            method: {
              name: 'caller',
              descriptor: '()V',
              attributes: [
                {
                  type: 'code',
                  code: {
                    codeItems: [
                      {
                        pc: 0,
                        instruction: {
                          op: 'invokestatic',
                          arg: ['Method', 'Foo', ['called', '()V']],
                        },
                      },
                      { pc: 1, instruction: 'return' },
                    ],
                    exceptionTable: [],
                    attributes: [],
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const metadata = collectMethodCallers(ast);
  t.equal(metadata.length, 2, 'two methods discovered');
  const called = metadata.find((entry) => entry.methodName === 'called');
  t.equal(called.callers.length, 1, 'callee should have one caller');
  t.equal(called.callers[0].methodName, 'caller', 'caller name tracked');
  t.ok(ast.classes[0].items[0].method.callers, 'callers attached to method node');
  t.end();
});

test('jvm-cli callers command filters and emits JSON', (t) => {
  withTempDir('callers-cli-', (dir) => {
    const targetSource = `
.class public Foo
.super java/lang/Object

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
.end class
`.trim();
    const input = path.join(dir, 'Foo.j');
    fs.writeFileSync(input, targetSource, 'utf8');

    const helperSource = `
.class public Helper
.super java/lang/Object

.method public static invokeCallee : ()V
    .code stack 1 locals 0
L0:    invokestatic Method Foo callee ()V
L3:    return
    .end code
.end method
.end class
`.trim();
    assembleJasmin(helperSource, path.join(dir, 'Helper.class'));

    const cli = path.join(__dirname, '..', 'scripts', 'jvm-cli.js');
    const output = execFileSync(
      'node',
      [cli, 'callers', input, '--json', '--method', 'callee', '--classpath', dir],
      { encoding: 'utf8' },
    );
    const metadata = JSON.parse(output);
    t.equal(metadata.length, 1, 'filter should return one method');
    const callerNames = metadata[0].callers.map(
      (caller) => `${caller.className}.${caller.methodName}`,
    );
    t.ok(callerNames.includes('Foo.caller'), 'callee should list the caller');
    t.ok(
      callerNames.includes('Helper.invokeCallee'),
      'workspace class should be included',
    );
    t.end();
  });
});
