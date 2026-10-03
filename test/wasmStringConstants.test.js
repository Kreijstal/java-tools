'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const Structured = require('../src/jit/StructuredWasmCompiler');
const Dispatcher = require('../src/jit/WasmJit')._test.MethodTranslator;
const Frame = require('../src/core/frame');
const {takeWasmReturnValue} = require('../src/jit/wasmShared');
const compile = require('./javaFixture').makeJavaFixtureCompiler('wasm-strings-');

test('Wasm string literals preserve lazy interning across both backends', async t => {
  const classpath = compile(t, 'WasmStrings', `
public class WasmStrings {
  static String choose(int n) {
    if (n == 0) return "";
    if (n == 1) return "same";
    if (n == 2) return "same";
    return "other";
  }
}`);
  for (const Backend of [Structured, Dispatcher]) {
    const j = new JVM({classpath, jit: {compileWorker: false, retainCompilerDiagnostics: false}});
    await j.preloadClasspathClasses();
    j._setClassInitializationState('WasmStrings', 'INITIALIZED');
    const method = await j.findMethodInHierarchy('WasmStrings', 'choose', '(I)Ljava/lang/String;');
    const seen = [], intern = j.internString.bind(j);
    j.internString = value => {seen.push(String(value)); return intern(value);};
    const compiler = new Backend(j, method, 'WasmStrings', j.jit.wasmJit);
    let meta;
    try { meta = Backend === Structured ? compiler.translateWith(true) : compiler.translate(); }
    catch (error) { t.fail(`${Backend.name}: ${error.message}`); continue; }
    t.equal(meta.fullyCompiled, true, 'literal branches are fully compiled');
    t.deepEqual(seen, [], 'compilation does not intern cold literals');
    t.equal(compiler.stringConstantImports, undefined, 'literal lookup analysis is released');
    const instance = new WebAssembly.Instance(new WebAssembly.Module(meta.bytes), meta.importObject);
    meta.box.frame = new Frame(method);
    meta.retv = instance.exports.retv;
    const run = n => {
      const args = meta.paramSlots.map(({slot}) => slot === 0 ? n : 0);
      t.equal(instance.exports.run(...args, 0, 1000), -1, 'native Wasm completes without fallback');
      return takeWasmReturnValue(meta);
    };
    t.equal(run(1), intern('same'), 'literal shares the interpreter string pool');
    t.equal(run(2), intern('same'), 'duplicate literal preserves identity');
    t.deepEqual(seen, ['same', 'same'], 'untaken literals remain unallocated');
    t.equal(run(0), intern(''), 'empty literal is a non-null Java string');
    t.equal(run(3), intern('other'), 'alternative literal remains distinct');
    t.equal(Object.keys(meta.importObject.env).filter(name => name.startsWith('string_constant_')).length,
      3, 'repeated discovery/emission and duplicate literals reuse imports');
  }
  t.end();
});

for (const Backend of [Structured, Dispatcher]) {
  test(`${Backend.name} handles wide and UTF-16 literals without name collisions`, t => {
    const j = new JVM({jit: {compileWorker: false, retainCompilerDiagnostics: false}});
    const literal = value => ({op: 'ldc_w', arg: value});
    const methodFor = (value, pool) => ({name: 'literal', descriptor: '()Ljava/lang/String;', flags: ['static'],
      constantPool: pool, attributes: [{type: 'code', code: {localsSize: '0', stackSize: '1',
        codeItems: [{instruction: literal(value)}, {instruction: 'areturn'}], exceptionTable: []}}]});
    for (const value of ['123', '\u0000', '\ud800', '\ud801', '\ud83d\ude00']) {
      const method = methodFor(value), compiler = new Backend(j, method, 'Literals', j.jit.wasmJit);
      const meta = Backend === Structured ? compiler.translateWith(true) : compiler.translate();
      const instance = new WebAssembly.Instance(new WebAssembly.Module(meta.bytes), meta.importObject);
      meta.box.frame = new Frame(method); meta.retv = instance.exports.retv;
      t.equal(instance.exports.run(0, 1000), -1, 'wide literal completes in native Wasm');
      t.equal(takeWasmReturnValue(meta), j.internString(value), 'exact UTF-16 identity is preserved');
      t.equal(meta.retv.value, null, 'reference return is consumed');
    }
    const method = methodFor('1', [null, 'resolved-from-pool']);
    const compiler = new Backend(j, method, 'Literals', j.jit.wasmJit);
    try {
      const meta = Backend === Structured ? compiler.translateWith(true) : compiler.translate();
      t.notEqual(meta.fullyCompiled, true, 'legacy pool-index operand retains canonical fallback');
    } catch (error) {
      t.match(error.message, /unresolved constant-pool index|no supported blocks/, 'legacy pool index rejects unsupported entry');
    }
    t.end();
  });
}

test('distinct UTF-16 literals receive distinct compact import names', t => {
  const {addStringConstantImport} = require('../src/jit/wasmRuntimeImports');
  const j = new JVM({jit: {compileWorker: false}}), entries = [];
  const registry = {addImport(name, params, returns, callback) {
    entries.push({name, callback}); return entries.length - 1;
  }};
  const a = addStringConstantImport(registry, j, '\ud800', 'ldc');
  const b = addStringConstantImport(registry, j, '\ud801', 'ldc');
  t.notEqual(a, b, 'different lone surrogates have different imports');
  t.notEqual(entries[a].name, entries[b].name, 'UTF-8 name encoding cannot merge literals');
  t.equal(addStringConstantImport(registry, j, '\ud800', 'ldc'), a, 'same literal shares its import');
  t.notEqual(entries[a].callback(), entries[b].callback(), 'callbacks preserve distinct interned identities');
  t.end();
});
