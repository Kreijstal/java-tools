// A class that is both an application class and a targeted JRE override
// (applicationFallback) starts as the override's stub. Ahead-of-main
// preparation compiles against that stub, binding static-field targets to
// the stub's StaticFieldStore; loading the real class later must keep that
// store, or every prepared body writes into a store nothing reads.
'use strict';
const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JVM } = require('../src/core/jvm');
const { StaticFieldStore } = require('../src/core/StaticFieldStore');
const frontend = require('../src/java-frontend');

function compileProbe(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-store-'));
  t.teardown(() => fs.rmSync(dir, {recursive: true, force: true}));
  const source = path.join(dir, 'FallbackProbe.java');
  fs.writeFileSync(source, [
    'public class FallbackProbe {',
    '  static int[] c;',
    '  static int total;',
    '  static void fill(int n) { c = new int[n]; for (int i = 0; i < n; i++) c[i] = i + 1; }',
    '  public static void main(String[] args) {',
    '    fill(4);',
    '    int sum = 0;',
    '    for (int i = 0; i < c.length; i++) sum += c[i];',
    '    total = sum;',
    '  }',
    '}',
  ].join('\n'));
  frontend.compileJavaFile(source, {outputDir: dir, sourceFileName: 'FallbackProbe.java'});
  return dir;
}

const overrides = {FallbackProbe: {natives: {applicationFallback: true}, methods: {}}};

test('loading the real class over an application-fallback stub keeps the stub\'s static store', async (t) => {
  const dir = compileProbe(t);
  const jvm = new JVM({classpath: dir, prepareBeforeMain: false,
    jit: {compileWorker: false}, jreOverrides: overrides});
  const stub = jvm.classes.FallbackProbe;
  t.ok(stub && stub.isJreStub, 'the override registers a stub up front');
  t.ok(stub.staticFields instanceof StaticFieldStore, 'with a static field store');
  const store = stub.staticFields;
  const cell = store.cell('c:[I');
  const real = await jvm.loadClassByName('FallbackProbe');
  t.equal(real.isJreStub, undefined, 'the record is no longer a stub');
  t.equal(real, stub, 'and it is the same record object the stub was (filled in place)');
  t.equal(jvm.classes.FallbackProbe, real, 'and is what the class table holds');
  t.equal(real.staticFields, store, 'the real class adopted the stub\'s store');
  t.equal(store.cell('c:[I'), cell, 'so a cell handed out against the stub is still the live cell');
  t.end();
});

test('a program prepared against the stub runs against the real class', async (t) => {
  const dir = compileProbe(t);
  const jvm = new JVM({classpath: dir, prepareBeforeMain: true,
    jit: {compileWorker: false}, jreOverrides: overrides});
  const store = jvm.classes.FallbackProbe.staticFields;
  await jvm.run('FallbackProbe');
  const classData = jvm.classes.FallbackProbe;
  t.equal(classData.staticFields, store, 'main() ran against the adopted store');
  t.equal(classData.staticFields.get('total:I'), 10, 'and the statics it wrote are the ones it read back');
  t.end();
});
