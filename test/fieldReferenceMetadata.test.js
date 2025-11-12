'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('tape');
const { collectFieldReferences } = require('../src/fieldReferenceMetadata');
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

test('collectFieldReferences tracks intra-class accesses', (t) => {
  const ast = {
    classes: [
      {
        className: 'Foo',
        items: [
          {
            type: 'field',
            field: {
              name: 'answer',
              descriptor: 'I',
              flags: ['static'],
            },
          },
          {
            type: 'method',
            method: {
              name: 'reader',
              descriptor: '()I',
              attributes: [
                {
                  type: 'code',
                  code: {
                    codeItems: [
                      {
                        pc: 0,
                        instruction: {
                          op: 'getstatic',
                          arg: ['Field', 'Foo', ['answer', 'I']],
                        },
                      },
                      { pc: 1, instruction: 'ireturn' },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const metadata = collectFieldReferences(ast);
  t.equal(metadata.length, 1, 'one field entry expected');
  t.equal(metadata[0].references.length, 1, 'field should have one reference');
  t.equal(metadata[0].references[0].methodName, 'reader', 'reference records method');
  t.ok(ast.classes[0].items[0].field.references, 'references array attached to field node');
  t.end();
});

test('jvm-cli fieldrefs command emits JSON filtered by field', (t) => {
  withTempDir('fieldrefs-cli-', (dir) => {
    const targetSource = `
.class public Foo
.super java/lang/Object

.field public static counter I

.method public static read : ()I
    .code stack 1 locals 0
L0:    getstatic Field Foo counter I
L3:    ireturn
    .end code
.end method
.end class
`.trim();
    const input = path.join(dir, 'Foo.j');
    fs.writeFileSync(input, targetSource, 'utf8');

    const helperSource = `
.class public Helper
.super java/lang/Object

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
      [cli, 'fieldrefs', input, '--json', '--field', 'counter', '--classpath', dir],
      {
        encoding: 'utf8',
      },
    );
    const metadata = JSON.parse(output);
    t.equal(metadata.length, 1, 'filter should limit to one field');
    const refNames = metadata[0].references.map(
      (ref) => `${ref.className}.${ref.methodName}`,
    );
    t.ok(refNames.includes('Foo.read'), 'local reference should be listed');
    t.ok(refNames.includes('Helper.loadCounter'), 'workspace reference should be listed');
    t.end();
  });
});
