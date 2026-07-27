'use strict';

const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { KrakatauWorkspace } = require('../src/workspace/KrakatauWorkspace');
const { applyRenameMap } = require('../src/workspace/applyRenameMap');
const { decompilePath } = require('../src/decompiler/cfr');

function classNode(workspace, name) {
  return workspace.getClassAST(name).classes[0];
}

function methodNames(cls) {
  return cls.items.filter((item) => item.type === 'method')
    .map((item) => `${item.method.name}${item.method.descriptor}`);
}

test('rename map is descriptor-safe, cross-class, and deterministic', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'java-tools-rename-map-'));
  const input = path.join(root, 'input');
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  const javaOut = path.join(root, 'java');
  const recompiled = path.join(root, 'recompiled');
  fs.mkdirSync(input, { recursive: true });
  fs.writeFileSync(path.join(root, 'A.java'), [
    'class A {',
    '  int x = 4;',
    '  int a(int value) { return this.x + value; }',
    '  String a(String value) { return value + this.x; }',
    '}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'B.java'), [
    'public class B {',
    '  public static void main(String[] args) {',
    '    A value = new A();',
    '    System.out.print(value.a(6) + ":" + value.a("v"));',
    '  }',
    '}',
    '',
  ].join('\n'));
  execFileSync('javac', ['-d', input, path.join(root, 'A.java'), path.join(root, 'B.java')]);

  const mapping = {
    formatVersion: 1,
    classes: { A: 'ReadableA' },
    fields: { 'A.x:I': 'number' },
    methods: { 'A.a(I)I': 'calculate' },
  };

  try {
    await applyRenameMap(input, first, mapping);
    await applyRenameMap(input, second, mapping);

    const output = execFileSync('java', ['-cp', first, 'B'], { encoding: 'utf8' });
    t.equal(output, '10:v4', 'renamed bytecode executes with rewritten cross-class references');

    const workspace = await KrakatauWorkspace.create(first);
    const readable = classNode(workspace, 'ReadableA');
    const methods = methodNames(readable);
    t.ok(methods.includes('calculate(I)I'), 'selected overload is renamed');
    t.ok(methods.includes('a(Ljava/lang/String;)Ljava/lang/String;'),
      'unselected overload keeps its original name');
    t.ok(readable.items.some((item) => item.type === 'field'
      && item.field.name === 'number' && item.field.descriptor === 'I'),
    'mapped field declaration uses the semantic ABI name');

    const firstClasses = fs.readdirSync(first).filter((name) => name.endsWith('.class')).sort();
    const secondClasses = fs.readdirSync(second).filter((name) => name.endsWith('.class')).sort();
    t.deepEqual(firstClasses, secondClasses, 'repeated runs emit the same class set');
    for (const name of firstClasses) {
      t.equal(
        fs.readFileSync(path.join(first, name)).toString('hex'),
        fs.readFileSync(path.join(second, name)).toString('hex'),
        `${name} is byte-for-byte deterministic`,
      );
    }

    const sources = await decompilePath(first, {
      classpath: first,
      preserveFieldNames: new Set(['number']),
    });
    fs.mkdirSync(javaOut, { recursive: true });
    for (const source of sources) {
      fs.writeFileSync(path.join(javaOut, source.name), source.source);
    }
    fs.mkdirSync(recompiled, { recursive: true });
    execFileSync('javac', [
      '-d', recompiled,
      ...fs.readdirSync(javaOut).filter((name) => name.endsWith('.java'))
        .sort().map((name) => path.join(javaOut, name)),
    ]);
    const recompiledOutput = execFileSync('java', ['-cp', recompiled, 'B'], { encoding: 'utf8' });
    t.equal(recompiledOutput, '10:v4', 'owned-decompiler output recompiles and preserves behavior');
  } catch (error) {
    t.fail(error && error.stack ? error.stack : String(error));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    t.end();
  }
});
