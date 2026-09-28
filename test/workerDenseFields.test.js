const test = require('tape');
const {JVM} = require('../src/core/jvm');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const compileFixture = makeJavaFixtureCompiler('worker-dense-fields-');

test('worker bodies read and write dense instance fields through their runtime layout', async t => {
  const classpath = compileFixture(t, 'DenseList', `
class Link { Link next, previous; }
public class DenseList {
  Link head;
  DenseList() { head = new Link(); head.next = head; head.previous = head; }
  void append(Link node) {
    node.previous = head.previous; node.next = head;
    node.previous.next = node; node.next.previous = node;
  }
  public static void main(String[] args) {
    DenseList list = new DenseList(); Link first = new Link(); Link second = new Link();
    list.append(first); list.append(second);
    System.out.println(list.head.next == first && first.next == second &&
      second.previous == first && list.head.previous == second);
  }
}`);
  const jvm = new JVM({classpath, prepareBeforeMain: false, denseInstanceFields: true,
    jit: {compileWorker: true, warmupThreshold: 0, structuredSsa: true,
      preferWholeMethodJs: true, retainCompilerDiagnostics: false}});
  t.teardown(() => jvm.jit.compileWorker.dispose());
  t.equal(jvm.jit.resultStalenessReason({provenance: {
    ...jvm.jit.captureResultProvenance(), denseInstanceFields: false,
  }}), 'instance field layout differs from compiler', 'incompatible compiled layouts are rejected');
  let output = '';
  jvm.registerJreMethods({'java/io/PrintStream': {
    'println(Z)V': (_jvm, _receiver, args) => {output += String(args[0]);},
  }});
  await jvm.preloadClasspathClasses();
  await jvm.precompileInitializedClasses({effectful: true, initializedOnly: false, compileLocally: false});
  await jvm.jit.compileWorker.whenIdle();
  const method = await jvm.findMethodInHierarchy('DenseList', 'append', '(LLink;)V');
  t.ok(jvm.jit.codegenCache.get(method), 'append has an installed worker body');
  await jvm.run('DenseList');
  t.ok(output === '1' || output === 'true', 'all forward and backward links use the same field storage');
  t.end();
});
