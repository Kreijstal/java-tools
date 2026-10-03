const test = require('tape');
const {JVM} = require('../src/core/jvm');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const compileFixture = makeJavaFixtureCompiler('diagnostic-retention-');

test('preparation without diagnostics keeps execution and exception fallback intact', async t => {
  const classpath = compileFixture(t, 'RetentionProbe', `
public class RetentionProbe {
  static int[] values = new int[20];
  static int fill(int count) {
    try {
      for (int i = 0; i < count; i++) values[i] = i * 3;
      return values[count - 1];
    } catch (ArrayIndexOutOfBoundsException e) { return -7; }
  }
  public static void main(String[] args) {
    System.out.println(fill(10));
    System.out.println(fill(21));
  }
}`);
  for (const compileWorker of [false, true]) {
    const jvm = new JVM({classpath, prepareBeforeMain: false, jit: {
      compileWorker, structuredSsa: true, warmupThreshold: 0,
      retainCompilerDiagnostics: false,
    }});
    t.teardown(() => jvm.jit.compileWorker.dispose());
    let output = '';
    jvm.registerJreMethods({'java/io/PrintStream': {
      'println(I)V': (_jvm, _receiver, args) => {output += args[0] + '\n';},
    }});
    await jvm.loadClassByName('RetentionProbe');
    await jvm.precompileInitializedClasses({effectful: true, initializedOnly: false,
      compileLocally: !compileWorker});
    await jvm.jit.compileWorker.whenIdle();
    const method = await jvm.findMethodInHierarchy('RetentionProbe', 'fill', '(I)I');
    const body = jvm.jit.codegenCache.get(method);
    t.ok(body, 'method has a generated body');
    t.notOk(body.jvmGeneratedSource, 'transport source released at publication');
    t.notOk(body.jvmRestoringDirectPositionalInsertion, 'unused insertion does not retain compiler scope');
    t.equal(Object.keys(body.jvmStructuredRegionFragments || {}).length, 0, 'unused region plans omitted');
    if (compileWorker) t.ok(jvm.jit.compileWorker.stats.installed > 0, 'worker transport still installed');
    await jvm.run('RetentionProbe');
    t.equal(output, '27\n-7\n', 'normal and exceptional execution preserved');
  }
  t.end();
});
