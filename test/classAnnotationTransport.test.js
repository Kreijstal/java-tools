const test = require('tape');
const {JVM} = require('../src/core/jvm');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const compileFixture = makeJavaFixtureCompiler('annotation-transport-');

test('Object prototype method names do not become class annotations', async t => {
  const classpath = compileFixture(t, 'AnnotationTransport', `
public class AnnotationTransport {
  public String toString() { return "probe"; }
  public int constructor() { return 7; }
  public static int score() { return 42; }
}`);
  const jvm = new JVM({classpath, jit: {compileWorker: true, warmupThreshold: 0}});
  t.teardown(() => jvm.jit.compileWorker.dispose());
  await jvm.preloadClasspathClasses();
  const ast = jvm.classes.AnnotationTransport.ast;
  for (const name of ['toString', 'constructor']) {
    const method = ast.classes[0].items.find(item => item.method?.name === name).method;
    t.notOk(method.annotations, name + ' has no inherited annotation value');
  }
  t.doesNotThrow(() => structuredClone(ast), 'unannotated class remains transportable');
  const method = await jvm.findMethodInHierarchy('AnnotationTransport', 'score', '()I');
  jvm.jit.compileWorker.enqueue(method, {});
  await jvm.jit.compileWorker.whenIdle();
  t.notOk(jvm.jit.compileWorker.unsendableClasses.has('AnnotationTransport'), 'class is not quarantined');
  t.ok(jvm.jit.compileWorker.installedMethods.has(method), 'worker installs its method');
  t.end();
});
