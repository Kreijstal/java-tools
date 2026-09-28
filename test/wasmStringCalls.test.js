'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const Structured = require('../src/jit/StructuredWasmCompiler');
const Dispatcher = require('../src/jit/WasmJit')._test.MethodTranslator;
const Frame = require('../src/core/frame');
const compile = require('./javaFixture').makeJavaFixtureCompiler('wasm-string-calls-');

test('compiled String comparison preserves operands, nulls and native behavior', async t => {
  const classpath = compile(t, 'StringCalls', `
public class StringCalls {
  static int compare(String a, String b) { return 10 + (a.equalsIgnoreCase(b) ? 1 : 0); }
}`);
  for (const Backend of [Structured, Dispatcher]) {
    const j = new JVM({classpath, jit: {compileWorker: false, retainCompilerDiagnostics: false}});
    await j.preloadClasspathClasses();
    j._setClassInitializationState('StringCalls', 'INITIALIZED');
    const method = await j.findMethodInHierarchy('StringCalls', 'compare', '(Ljava/lang/String;Ljava/lang/String;)I');
    const compiler = new Backend(j, method, 'StringCalls', j.jit.wasmJit);
    const meta = Backend === Structured ? compiler.translateWith(true) : compiler.translate();
    t.equal(meta.fullyCompiled, true, 'comparison is fully compiled');
    const instance = new WebAssembly.Instance(new WebAssembly.Module(meta.bytes), meta.importObject);
    meta.box.frame = new Frame(method);
    const run = (a,b) => {
      const args = meta.paramSlots.map(({slot}) => slot === 0 ? a : slot === 1 ? b : 0);
      t.equal(instance.exports.run(...args, 0, 1000), -1, 'native Wasm completes');
      return meta.box.ret;
    };
    const string = x => x === null ? null : j.internString(x);
    for (const [a,b,expected] of [['brk','BRK',11],['brk','bra',10],['','',11],['',null,10],['brk',null,10]]) {
      t.equal(run(string(a),string(b)), expected, 'comparison preserves result and underlying operand');
      const native = require('../src/jre/java/lang/String').methods['equalsIgnoreCase(Ljava/lang/String;)Z'];
      t.equal(native(j, string(a), [string(b)]), expected - 10, 'JRE path agrees, including null arguments');
    }
    t.throws(() => run(null,string('brk')), error => error.type === 'java/lang/NullPointerException',
      'null receiver throws before native invocation');
  }
  t.end();
});

test('String call bridge admits only the exact final native method', t => {
  const {addStringCallImport} = require('../src/jit/wasmRuntimeImports');
  const registry = {addImport() {throw new Error('unexpected admission');}};
  for (const [op, owner, name, descriptor] of [
    ['invokeinterface','java/lang/String','equalsIgnoreCase','(Ljava/lang/String;)Z'],
    ['invokevirtual','GuestString','equalsIgnoreCase','(Ljava/lang/String;)Z'],
    ['invokevirtual','java/lang/String','toString','()Ljava/lang/String;'],
    ['invokevirtual','java/lang/String','equalsIgnoreCase','(Ljava/lang/Object;)Z'],
  ]) t.equal(addStringCallImport(registry, {}, {arg: ['Method',owner,[name,descriptor]]}, op), null,
    'other dispatch/signature remains on the ordinary path');
  t.end();
});
