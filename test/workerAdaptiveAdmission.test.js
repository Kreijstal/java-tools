const test = require('tape');
const {JVM} = require('../src/core/jvm');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const compileFixture = makeJavaFixtureCompiler('worker-adaptive-admission-');

test('worker preserves effectful admission earned by adaptive methods', async t => {
  const classpath = compileFixture(t, 'AdaptiveAdmission', `
public class AdaptiveAdmission {
  public static int score(int n) { Object value = new Object(); return n + 1; }
}`);
  const jvm = new JVM({classpath, jit: {compileWorker: true, warmupThreshold: 0}});
  const jit = jvm.jit;
  t.teardown(() => jit.compileWorker.dispose());
  await jvm.preloadClasspathClasses();
  await jvm.preloadReferencedClasses();
  const method = await jvm.findMethodInHierarchy('AdaptiveAdmission', 'score', '(I)I');
  t.notOk(jit.isCodegenSupported(method), 'ordinary admission rejects the constructor caller');
  t.ok(jit.isCodegenSupported(method, true), 'effectful admission proves the constructor safe');
  jit.adaptiveCodegenMethods.add(method);
  jit.getGeneratedFunction(method);
  await jit.compileWorker.whenIdle();
  t.ok(jit.compileWorker.installedMethods.has(method), 'worker compiles under the admitted policy');
  t.equal(jit.compileWorker.stats.refused, 0, 'adaptive method is not stranded by ordinary admission');
  t.end();
});
