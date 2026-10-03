'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const compile = makeJavaFixtureCompiler('prepare-wasm-helpers-');

test('preparation can explicitly include selected non-loop Wasm dependencies', async t => {
  const classpath = compile(t, 'PreparedHelpers', `
public class PreparedHelpers {
  static int bits(int value) { return value & 255; }
  static byte next(int value) { return (byte)bits(value); }
  static int sum(int count) {
    int total = 0;
    for (int i = 0; i < count; i++) total += next(i + 254);
    return total;
  }
  public static void main(String[] args) { System.out.println(sum(4)); }
}`);
  const priorityMethods = ['PreparedHelpers.bits(I)I',
    'PreparedHelpers.next(I)B', 'PreparedHelpers.sum(I)I'];
  for (const includeHelpers of [false, true]) {
    const output = [];
    const policy = {priorityMethods, maxMethods: 3};
    if (includeHelpers) policy.wasmLoopsOnly = false;
    const j = new JVM({classpath, prepareBeforeMain: false, jit: {
      compileWorker: false, wasmStructured: true, preparationPolicy: policy,
    }});
    j.jit.wasmJit.enabled = true;
    await j.preloadClasspathClasses();
    const result = await j.precompileInitializedClasses({
      initializedOnly: false, effectful: true, wasm: true,
    });
    t.equal(result.wasmMethods, includeHelpers ? 3 : 1,
      includeHelpers ? 'explicit policy prepares all three selected methods'
        : 'default Wasm preparation remains limited to loops');
    if (includeHelpers) {
      for (const [name, descriptor] of [['bits', '(I)I'], ['next', '(I)B']]) {
        const method = await j.findMethodInHierarchy('PreparedHelpers', name, descriptor);
        const state = j.jit.wasmJit.state.get(method);
        t.equal(state?.status, 'ready', `${name} has a ready Wasm module`);
        t.ok(state?.meta?.fullyCompiled, `${name} has complete coverage`);
      }
    }
    j.registerJreMethods({'java/io/PrintStream': {
      'println(I)V': (_j, _o, args) => output.push(args[0]),
    }});
    await j.run('PreparedHelpers');
    t.deepEqual(output, [-2], 'prepared helper chain preserves signed-byte results');
  }
  t.end();
});
