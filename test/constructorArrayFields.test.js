const test = require('tape');
const {JVM} = require('../src/core/jvm');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const compileFixture = makeJavaFixtureCompiler('constructor-array-fields-');

for (const prepareBeforeMain of [false, true]) {
  for (const compileWorker of [false, true]) {
    test(`array fields survive constructor execution (prepare=${prepareBeforeMain}, worker=${compileWorker})`, async t => {
      const classpath = compileFixture(t, 'ConstructorArrayFields', `
class ArrayHolder {
  static java.util.zip.CRC32 checksum = new java.util.zip.CRC32();
  long[] a, b, c, g, k;
  byte[] i, j;
  private int e, h;
  ArrayHolder() {
    c = new long[8]; i = new byte[64]; j = new byte[32]; e = 0; h = 0;
    b = new long[8]; a = new long[8]; g = new long[8]; k = new long[8];
  }
  void clear() {
    for (int n = 0; n < 32; n++) j[n] = 0;
    i[0] = 0; h = 0; e = 0;
    for (int n = 0; n < 8; n++) c[n] = 0L;
  }
}
public class ConstructorArrayFields {
  public static void main(String[] args) {
    int total = 0;
    for (int n = 0; n < 16; n++) {
      ArrayHolder value = new ArrayHolder();
      value.clear(); total += value.i.length + value.j.length + value.a.length;
    }
    System.out.println(total);
  }
}`);
      const jvm = new JVM({classpath, prepareBeforeMain, denseInstanceFields: true,
        wasmHeap: true, wasmHeapMb: 32, jit: {compileWorker, warmupThreshold: 0,
          preferWholeMethodJs: true, structuredSsa: true, retainCompilerDiagnostics: false}});
      t.teardown(() => jvm.jit.compileWorker.dispose());
      let output = '';
      jvm.registerJreMethods({'java/io/PrintStream': {
        'println(I)V': (_jvm, _receiver, args) => {output += args[0] + '\n';},
      }});
      await jvm.run('ConstructorArrayFields');
      await jvm.jit.compileWorker.whenIdle();
      t.equal(output, '1664\n', 'every object has its constructor-initialized arrays');
      t.end();
    });
  }
}
