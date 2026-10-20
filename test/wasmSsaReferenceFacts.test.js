'use strict';
const test = require('tape');
const { makeJavaFixtureCompiler } = require('./javaFixture');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const { takeWasmReturnValue } = require('../src/jit/wasmShared');
const StructuredWasmCompiler = require('../src/jit/StructuredWasmCompiler');
const { buildSsa } = require('../src/analysis/opgraph/ssa');
const fixture = makeJavaFixtureCompiler('wasm-ssa-facts-');

test('shared SSA proofs remove redundant null work while preserving execution and exceptions', async t => {
  const classpath = fixture(t, 'SharedFacts', `public class SharedFacts {
    public static int visits;
    public static Box next;
    public static Object guarded(Object value) {
      visits++;
      if(value != null) return value;
      Object copy = value;
      return (Unloaded)copy;
    }
    public static Object joined(boolean first) {
      Object value;
      if(first) value = null; else value = null;
      return (Unloaded)value;
    }
    public static int afterLength(int[] value) {
      int length = value.length;
      return value == null ? -1 : length;
    }
    public static int loop(int count) {
      int sum = 0;
      while(count-- > 0) {
        Box value = next;
        next = null;
        if(value == null) return sum;
        sum += value.number;
      }
      return sum;
    }
    public static Unloaded unknown(Object value) { return (Unloaded)value; }
  }
  class Box { public int number; }
  class Unloaded { }
  `);
  const j = new JVM({ classpath, jit: { compileWorker: false, codegen: false,
    retainCompilerDiagnostics: false, wasm: { structured: true, deepInline: false, checkcast: false } } });
  for (const name of ['SharedFacts', 'Box']) {
    await j.loadClassByName(name); j.classes[name].staticFieldsInitialized = true; j._markClassInitialized(name);
  }
  const w = j.jit.wasmJit; w.enabled = true;
  const states = new Map();
  for (const [name, descriptor] of [['guarded', '(Ljava/lang/Object;)Ljava/lang/Object;'],
    ['joined', '(Z)Ljava/lang/Object;'], ['afterLength', '([I)I'], ['loop', '(I)I']]) {
    const method = j.findMethod(j.classes.SharedFacts, name, descriptor);
    const state = w.methodState({ method });
    w.compile({ method, className: 'SharedFacts' }, state, { asCallee: true });
    t.equal(state.status, 'ready', name + ' installs');
    t.ok(state.meta?.structured && state.meta.normalFlowFullyCompiled, name + ' needs no null/cast demotion');
    states.set(name, { method, state });
  }
  const run = (name, ...args) => {
    const { method, state } = states.get(name);
    state.meta.box.frame = new Frame(method);
    const status = state.run(...args, 0, 1000000);
    if (status !== -1) throw new Error(name + ' unexpected native exit ' + status);
    return takeWasmReturnValue(state.meta);
  };
  t.equal(run('guarded', null), null, 'null cast returns null');
  const object = { type: 'java/lang/Object', fields: {} };
  t.equal(run('guarded', object), object, 'non-null arm preserves reference identity');
  t.equal(j.classes.SharedFacts.staticFields.get('visits:I'), 2, 'side effects occur exactly once per call');
  t.notOk(j.classes.Unloaded, 'known-null cast never loads or initializes its target');

  const method = states.get('joined').method, code = method.attributes.find(a => a.type === 'code').code;
  const fn = buildSsa({ ...code, method });
  const cast = fn.values.find(v => v.op === 'checkcast');
  t.equal(cast?.args[0]?.op, 'phi', 'fixture uses an actual reference join, not a literal-null operand');
  t.equal(run('joined', 0), null, 'false phi arm');
  t.equal(run('joined', 1), null, 'true phi arm');
  t.equal(run('afterLength', new Int32Array(3)), 3, 'array length result preserved');
  let error;
  try { run('afterLength', null); } catch (e) { error = e; }
  t.equal(error?.type, 'java/lang/NullPointerException', 'the first dereference still throws NPE');

  j.classes.SharedFacts.staticFields.set('next:LBox;', { type: 'Box', fields: { 'Box.number': 13 } });
  t.equal(run('loop', 4), 13, 'fresh field load becomes null on second iteration');
  t.equal(run('loop', 4), 0, 'next invocation also observes the updated field');
  const unknown = j.findMethod(j.classes.SharedFacts, 'unknown', '(Ljava/lang/Object;)LUnloaded;');
  const us = w.methodState({ method: unknown });
  w.compile({ method: unknown, className: 'SharedFacts' }, us, { asCallee: true });
  t.ok(us.status !== 'ready' || !us.meta.normalFlowFullyCompiled, 'unknown cast retains existing admission/fallback policy');
  t.notOk(w.checkcastEnabled, 'safe SSA facts require no general-cast opt-in');

  const compiler = new StructuredWasmCompiler(j, states.get('afterLength').method, 'SharedFacts', w);
  const metadata = compiler.translate();
  t.notOk(Object.hasOwn(metadata, 'referenceFacts'), 'compiler facts are absent from execution metadata');
  t.equal(compiler.fn, undefined, 'SSA graph and its fact cache released after compilation');
  t.end();
});

test('Wasm conditions consume shared facts without adding execution metadata', t => {
  const { OP } = require('../src/jit/wasmShared');
  const items = [
    { instruction: 'aload_0' }, { instruction: { op: 'ifnull', arg: 'Lnull' } },
    { instruction: 'aload_0' }, { instruction: { op: 'ifnonnull', arg: 'Lyes' } },
    { instruction: 'iconst_0' }, { instruction: 'ireturn' },
    { labelDef: 'Lyes:', instruction: 'iconst_1' }, { instruction: 'ireturn' },
    { labelDef: 'Lnull:', instruction: 'iconst_0' }, { instruction: 'ireturn' },
  ];
  const fn = buildSsa({ codeItems: items, method: { name: 'branch', descriptor: '(Ljava/lang/Object;)I', flags: ['static'] } });
  t.notOk(fn.rejected, 'shared graph builds');
  const compiler = Object.create(StructuredWasmCompiler.prototype);
  compiler.fn = fn;
  compiler.blockOf = id => fn.blocks[id];
  compiler.useOf = () => [OP.local_get, 0];
  const first = [], known = [], block = fn.blocks.find(b => b.term.insnOp === 'ifnonnull');
  compiler.emitCondition(fn.entry, first);
  compiler.emitCondition(block.id, known);
  t.deepEqual(first, [OP.local_get, 0, OP.ref_is_null], 'unknown entry reference retains its runtime test');
  t.deepEqual(known, [OP.i32_const, 1], 'dominated non-null condition needs neither a load nor a test');
  t.end();
});
