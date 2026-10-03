const test = require('tape');
const {JVM} = require('../src/core/jvm');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const compileFixture = makeJavaFixtureCompiler('worker-boolean-snapshot-');

for (const browserMirror of [false, true]) test(`worker boolean specialization uses fresh runtime values with guarded execution (${browserMirror ? 'chunked browser' : 'node'})`, async t => {
  const classpath = compileFixture(t, 'BooleanSnapshot', `
public class BooleanSnapshot {
  static boolean wide;
  static int first() { int n = 4; if (wide) n = 8; int s = 0; for (int i=0;i<n;i++) s+=i; return s; }
  static int second() { int n = 4; if (wide) n = 8; int s = 0; for (int i=0;i<n;i++) s+=i; return s; }
  public static void main(String[] args) { System.out.println(first()); System.out.println(second()); }
}`);
  const jvm = new JVM({classpath, prepareBeforeMain: false, jit: {
    compileWorker: true, structuredSsa: true, preferWholeMethodJs: true,
    retainCompilerDiagnostics: false, warmupThreshold: 0,
  }});
  const jit = jvm.jit;
  if (browserMirror) {
    const createHost = jit.compileWorker.createNodeWorkerHost.bind(jit.compileWorker);
    jit.compileWorker.createNodeWorkerHost = () => {
      const host = createHost();
      host.kind = 'web-worker';
      return host;
    };
  }
  t.teardown(() => jit.compileWorker.dispose());
  await jvm.preloadClasspathClasses();
  await jvm.preloadReferencedClasses();
  jvm.classInitializationState.set('BooleanSnapshot', 'INITIALIZED');
  const fields = jvm.classes.BooleanSnapshot.staticFields;
  const first = await jvm.findMethodInHierarchy('BooleanSnapshot', 'first', '()I');
  const second = await jvm.findMethodInHierarchy('BooleanSnapshot', 'second', '()I');
  fields.set('wide:Z', 0);
  jit.compileWorker.enqueue(first, {});
  await jit.compileWorker.whenIdle();
  fields.set('wide:Z', 1);
  jit.markStaticLocationChanged(fields, 'wide:Z');
  jit.compileWorker.enqueue(second, {});
  await jit.compileWorker.whenIdle();
  t.ok(jit.compileWorker.installedMethods.has(first), 'first snapshot installs');
  t.ok(jit.compileWorker.installedMethods.has(second), 'changed snapshot installs without resending its AST');
  let output = [];
  jvm.registerJreMethods({'java/io/PrintStream': {'println(I)V': (_jvm, _receiver, args) => {output.push(args[0]);}}});
  await jvm.run('BooleanSnapshot');
  t.deepEqual(output, [28, 28], 'stale and fresh compiled results both preserve current Java behavior');
  t.ok(jit.structuredSsa.guardedBooleanFallbackCount > 0, 'old body guards the changed value before executing');
  const oldBody = jit.codegenCache.get(first);
  const freshBody = jit.codegenCache.get(second);
  t.equal(oldBody.jvmStructuredSpeculation?.guardedStaticBooleans?.[0]?.value, 0, 'first body retains its original guarded value');
  t.equal(freshBody.jvmStructuredSpeculation?.guardedStaticBooleans?.[0]?.value, 1, 'fresh body specializes the current true value');
  t.notEqual(jit.lastMethodDeoptReasons.get(second), 'structured SSA static boolean guard', 'fresh snapshot does not force permanent interpreter fallback');
  t.end();
});
