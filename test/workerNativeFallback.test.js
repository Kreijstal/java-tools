const test = require('tape');
const {JVM} = require('../src/core/jvm');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const compileFixture = makeJavaFixtureCompiler('worker-native-fallback-');

test('worker compilation transports mixed linked and direct native calls', async t => {
  const classpath = compileFixture(t, 'NativeLoop', `
public class NativeLoop {
  static int score(String value) {
    int total = 0;
    for (int i = 0; i < 10; i++) total += value.length() + (int)Math.sqrt(9.0);
    return total;
  }
  public static void main(String[] args) { System.out.println(score("abcd")); }
}`);
  const jvm = new JVM({classpath, prepareBeforeMain: false, jit: {
    compileWorker: true, structuredSsa: true, preferWholeMethodJs: true,
    retainCompilerDiagnostics: false, warmupThreshold: 0,
  }});
  t.teardown(() => jvm.jit.compileWorker.dispose());
  await jvm.preloadClasspathClasses();
  await jvm.preloadReferencedClasses();
  const method = await jvm.findMethodInHierarchy('NativeLoop', 'score', '(Ljava/lang/String;)I');
  t.ok(jvm.jit.compileWorker.enqueue(method, {preparedWholeMethod: true}), 'worker accepts the method');
  await jvm.jit.compileWorker.whenIdle();
  t.ok(jvm.jit.codegenCache.get(method), 'native-call loop installs from the worker');
  t.equal(jvm.jit.compileWorker.stats.refused, 0, 'optional direct intrinsics do not strand the method');
  let output = '';
  jvm.registerJreMethods({'java/io/PrintStream': {'println(I)V': (_jvm, _receiver, args) => {output += args[0];}}});
  await jvm.run('NativeLoop');
  t.equal(output, '70', 'transported native calls preserve results');
  t.end();
});
