'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const Compiler = require('../src/jit/StructuredWasmCompiler');
const Frame = require('../src/core/frame');
const compile = require('./javaFixture').makeJavaFixtureCompiler('structured-retention-');

const analysisKeys = ['labelIndex', 'origIdx', 'deoptStubs', 'deoptBlocks',
  'declared', 'frames', 'guardSites', 'liveRanges', 'demoteBlockersByBlock',
  'importDecls', 'importFns', 'importIndexByName', 'sigTypes', 'sigTypeIndex'];

test('structured compiler releases emission plans while imports remain executable', async t => {
  const classpath = compile(t, 'RetainedWasm', `
public class RetainedWasm {
  int value(int n) { return n * 3; }
  static int sum(RetainedWasm receiver, int[] values) {
    int result = 0;
    for (int i = 0; i < values.length; i++) result += receiver.value(values[i]);
    return result;
  }
}`);
  for (const retainCompilerDiagnostics of [true, false]) {
    const j = new JVM({classpath, jit: {compileWorker: false, retainCompilerDiagnostics}});
    await j.preloadClasspathClasses();
    j._setClassInitializationState('RetainedWasm', 'INITIALIZED');
    const method = await j.findMethodInHierarchy('RetainedWasm', 'sum', '(LRetainedWasm;[I)I');
    const compiler = new Compiler(j, method, 'RetainedWasm', j.jit.wasmJit);
    const meta = compiler.translateWith(true);
    t.ok(meta.deoptStubCount > 0, 'fixture includes an inline receiver guard and deopt plan');
    if (retainCompilerDiagnostics) {
      t.ok(compiler.labelIndex.size > 0, 'diagnostic label map remains available');
      t.ok(compiler.origIdx.length > 0, 'diagnostic expanded-index map remains available');
      t.comment(`retained labels=${compiler.labelIndex.size}, indices=${compiler.origIdx.length}, locals=${compiler.declared.length}, imports=${compiler.importDecls.length}`);
    } else {
      for (const key of analysisKeys) t.equal(compiler[key], undefined, `${key} is released`);
    }
    const instance = new WebAssembly.Instance(new WebAssembly.Module(meta.bytes), meta.importObject);
    const receiver = {type: 'RetainedWasm'}, values = [2, 5, 7]; values.type = '[I';
    const frame = new Frame(method); frame.className = 'RetainedWasm'; meta.box.frame = frame;
    t.equal(instance.exports.run(receiver, values, 0, 1000), -1, 'compiled module completes');
    t.equal(meta.box.ret, 42, 'retained import callbacks produce the correct result');
    const resume = instance.exports.run(receiver, values, 0, 0);
    t.ok(resume >= 0 && meta.blockOfItem.has(resume), 'fuel exit retains original resume metadata');
    const guardMiss = instance.exports.run({type: 'java/lang/Object'}, values, 0, 1000);
    t.ok(guardMiss >= 0 && frame.stack.items.length > 0, 'guard miss materializes its guest operands');
    t.throws(() => instance.exports.run(receiver, null, 0, 1000),
      error => error.type === 'java/lang/NullPointerException', 'null exception still propagates');
    if (!retainCompilerDiagnostics) {
      const failed = new Compiler(j, method, 'RetainedWasm', j.jit.wasmJit);
      const failure = new Error('injected emission failure');
      failed.lowerNode = () => { throw failure; };
      t.throws(() => failed.translateWith(true), error => error === failure, 'emission failure propagates');
      for (const key of analysisKeys) t.equal(failed[key], undefined, `${key} released after failure`);
    }
  }
  t.end();
});

test('dispatcher compiler releases analysis but retains execution and fuel recovery', async t => {
  const Dispatcher = require('../src/jit/WasmJit')._test.MethodTranslator;
  const keys = ['items', 'labelIndex', 'blockStarts', 'slotTypes', 'declared',
    'localOfSlot', 'stackLocals', 'entryStacks', 'fieldCaches',
    'importDecls', 'importFns', 'importIndexByName'];
  const classpath = compile(t, 'RetainedDispatcher', `
public class RetainedDispatcher {
  static int sum(int[] values, int count) {
    int result = 0;
    for (int i = 0; i < count; i++) result += values[i] * 3;
    return result;
  }
}`);
  for (const retainCompilerDiagnostics of [true, false]) {
    const j = new JVM({classpath, jit: {compileWorker: false, retainCompilerDiagnostics}});
    await j.preloadClasspathClasses();
    j._setClassInitializationState('RetainedDispatcher', 'INITIALIZED');
    const method = await j.findMethodInHierarchy('RetainedDispatcher', 'sum', '([II)I');
    const compiler = new Dispatcher(j, method, 'RetainedDispatcher', j.jit.wasmJit);
    const meta = compiler.translate();
    if (retainCompilerDiagnostics) {
      t.ok(compiler.labelIndex.size > 0, 'dispatcher diagnostic labels retained');
      t.ok(compiler.entryStacks.size > 0, 'dispatcher diagnostic stacks retained');
    } else {
      for (const key of keys) t.equal(compiler[key], undefined, `dispatcher ${key} released`);
    }
    const instance = new WebAssembly.Instance(new WebAssembly.Module(meta.bytes), meta.importObject);
    const frame = new Frame(method); frame.className = 'RetainedDispatcher'; meta.box.frame = frame;
    const run = (values, count, fuel) => instance.exports.run(
      ...meta.paramSlots.map(({slot}) => slot === 0 ? values : slot === 1 ? count : 0), 0, fuel);
    const values = [2, 5, 7]; values.type = '[I';
    t.equal(run(values, 3, 1000), -1, 'dispatcher completes after cleanup');
    t.equal(meta.box.ret, 42, 'dispatcher result is exact');
    const resume = run(values, 3, 1);
    t.ok(resume >= 0 && meta.blockOfItem.has(resume), 'dispatcher retains resume mapping');
    t.equal(frame.locals[0], values, 'fuel exit retains array identity');
    t.equal(frame.locals[1], 3, 'fuel exit retains scalar argument');
    t.throws(() => run(values, 4, 1000), error => error.type === 'java/lang/ArrayIndexOutOfBoundsException',
      'dispatcher bounds exception survives cleanup');
    t.throws(() => run(null, 3, 1000), error => error.type === 'java/lang/NullPointerException',
      'dispatcher null exception survives cleanup');
    if (!retainCompilerDiagnostics) {
      const failed = new Dispatcher(j, method, 'RetainedDispatcher', j.jit.wasmJit);
      const failure = new Error('injected assembly failure');
      failed.assemble = () => {throw failure;};
      t.throws(() => failed.translate(), error => error === failure, 'assembly error propagated');
      for (const key of keys) t.equal(failed[key], undefined, `failed dispatcher ${key} released`);
    }
  }
  t.end();
});
