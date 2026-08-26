const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
// This suite asserts diagnostic counters throughout. Production execution
// deliberately leaves invocation accounting off unless it is requested.
process.env.JVM_PROFILE_JIT_METHODS = '1';
const { JVM } = require('../src/core/jvm');
const { _test: jitCompilerTest } = require('../src/jit/JitCompiler');
const { _test: wasmJitTest } = require('../src/jit/WasmJit');
const {
  supportsWasmTryTable,
  mathIntrinsicFunction,
} = require('../src/jit/wasmShared');
const {
  addTypedArrayStoreImports,
} = require('../src/jit/wasmRuntimeImports');
const { _test: structuredRendererTest } = require('../src/jit/JvmSsaBlockRenderer');
const HandwrittenFusedGradient =
  require('../scripts/oracles/FusedGradientOracle');
const HandwrittenAffineSpriteRaster =
  require('../scripts/oracles/AffineSpriteRasterOracle');
const invokeHandlers = require('../src/instructions/invoke');
const objectHandlers = require('../src/instructions/object');
const controlHandlers = require('../src/instructions/control');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const awt = require('../src/platform/awt');

const WASM_TRY_TABLE_SUPPORTED = supportsWasmTryTable();

test('JIT analysis reuses immutable bytecode label maps', (t) => {
  const codeItems = [
    {labelDef: 'L0:', instruction: 'iconst_0'},
    {instruction: {op: 'goto', arg: 'L0'}},
  ];
  const first = jitCompilerTest.buildLabelMap(codeItems);
  const second = jitCompilerTest.buildLabelMap(codeItems);
  t.equal(second, first,
    'repeated tiers share one label analysis for the same code array');
  t.equal(second.get('L0'), 0, 'the cached map preserves label offsets');
  t.notEqual(jitCompilerTest.buildLabelMap(codeItems.slice()), first,
    'a distinct bytecode array receives an independent analysis');
  t.end();
});

test('graph handoffs discard an impossible stale primitive above a receiver',
  (t) => {
  const owner = 'GraphReceiverResidueOwner';
  const callee = {
    className: owner,
    name: 'value', descriptor: '()I', flags: ['private'],
    attributes: [{type: 'code', code: {
      codeItems: [
        {labelDef: 'L0:', instruction: 'iconst_0'},
        {labelDef: 'L1:', instruction: 'ireturn'},
      ],
      exceptionTable: [], localsSize: '1', stackSize: '1',
    }}],
  };
  const callerMethod = {
    className: owner, name: 'caller', descriptor: '()V',
    flags: ['static'], attributes: [{type: 'code', code: {
      codeItems: [], exceptionTable: [], localsSize: '0', stackSize: '0',
    }}],
  };
  const jvm = new JVM({jit: {
    warmupThreshold: 0, hotCallGraphRegions: true,
  }});
  jvm.classes[owner] = {
    staticFields: new Map(),
    ast: {classes: [{superClassName: null, items: [
      {type: 'method', method: callee},
    ]}]},
  };
  jvm.classInitializationState.set(owner, 'INITIALIZED');
  const siteId = jvm.jit.registerSyncCallSite('invokespecial', {
    arg: ['Method', owner, ['value', '()I']],
  }, callerMethod, 0);
  const caller = new Frame(callerMethod);
  caller.className = owner;
  const receiver = {type: owner, fields: {}};
  caller.stack.items.push(receiver, 1);
  const thread = {status: 'runnable', callStack: new Stack()};
  thread.callStack.push(caller);

  t.equal(jvm.jit.tryInvokeSyncAt(siteId, caller, thread), 0,
    'the verified receiver beneath the residue reaches the callee');
  t.equal(jvm.jit.graphStaleReceiverOperandRecoveryCount, 1,
    'the graph recovery is counted explicitly');
  t.equal(caller.stack.items.length, 0,
    'the receiver and stale primitive are consumed exactly once');
  t.end();
});

test('loaded Method identities retain their declaring-class index', (t) => {
  const method = {name: 'work', descriptor: '()V'};
  const jvm = new JVM();
  jvm.classes.ArbitraryOwner = {ast: {classes: [{items: [
    {type: 'method', method},
  ]}]}};

  t.equal(jvm.findClassNameForMethod(method), 'ArbitraryOwner',
    'the first lookup indexes loaded class metadata');
  delete jvm.classes.ArbitraryOwner;
  t.equal(jvm.findClassNameForMethod(method), 'ArbitraryOwner',
    'subsequent compiler tiers reuse the Method identity index');
  t.end();
});

test('substantial call-bearing loops prefer whole call-graph lowering', (t) => {
  const calls = Array.from({length: 8}, () => ({instruction: {
    op: 'invokestatic',
    arg: ['Method', 'ArbitraryNumericHelper', ['mix', '(I)I']],
  }}));
  const padding = Array.from({length: 119}, () => ({instruction: 'nop'}));
  const method = {
    name: 'arbitraryCallBearingLoop', descriptor: '(I)I', flags: ['static'],
    attributes: [{type: 'code', code: {
      localsSize: '1', stackSize: '1', exceptionTable: [],
      codeItems: [
        {labelDef: 'Lloop:', instruction: 'nop'},
        ...calls,
        ...padding,
        {instruction: {op: 'goto', arg: 'Lloop'}},
      ],
    }}],
  };
  const jvm = new JVM({jit: {hotCallGraphRegions: true}});
  t.ok(jvm.jit.isCallGraphStructuredFirstMethod(method),
    'bytecode size, call density, and a backedge select the complete CFG');
  t.ok(jvm.jit.isWholeMethodJsEntryPreferred(method),
    'the selected call graph reaches whole-method entry policy');
  const shortMethod = {
    ...method,
    attributes: [{type: 'code', code: {
      ...method.attributes[0].code,
      codeItems: [
        {labelDef: 'Lshort:', instruction: 'nop'},
        ...calls,
        {instruction: {op: 'goto', arg: 'Lshort'}},
      ],
    }}],
  };
  t.notOk(jvm.jit.isCallGraphStructuredFirstMethod(shortMethod),
    'a small call loop retains the lower-cost method policy');
  const acyclicFanout = {
    ...method,
    name: 'arbitraryAcyclicFanout',
    attributes: [{type: 'code', code: {
      ...method.attributes[0].code,
      codeItems: [
        ...Array.from({length: 16}, () => calls[0]),
        ...padding,
        {instruction: 'return'},
      ],
    }}],
  };
  t.ok(jvm.jit.isCallGraphStructuredFirstMethod(acyclicFanout),
    'a large fan-out root can jointly lower its loop-bearing descendants');
  t.end();
});

test('operand-stack clearing preserves generated backing-array aliases', (t) => {
  const stack = new Stack();
  const generatedAlias = stack.items;
  stack.push(17);
  stack.clear();
  const exception = {type: 'java/lang/RuntimeException'};
  stack.push(exception);

  t.equal(stack.items, generatedAlias,
    'exception dispatch clears the existing backing array');
  t.deepEqual(generatedAlias, [exception],
    'a live generated caller observes the caught exception operand');
  t.end();
});

test('generated returns retain a parent while a child Frame is active', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedReturnGuardHarness', `
public class GeneratedReturnGuardHarness {
  public static int value() { return 7; }
}
`);
  const jvm = new JVM({classpath, jit: {warmupThreshold: 0}});
  await jvm.loadClassByName('GeneratedReturnGuardHarness');
  const method = await jvm.findMethodInHierarchy(
    'GeneratedReturnGuardHarness', 'value', '()I');
  const generated = jvm.jit.compileBaselineMethod(method);
  const frame = new Frame(method);
  frame.className = 'GeneratedReturnGuardHarness';
  const activeChild = new Frame(method);
  activeChild.className = 'GeneratedReturnGuardHarness';
  const thread = {
    id: 0, status: 'runnable', pendingException: null,
    callStack: new Stack(),
  };
  thread.callStack.push(frame);
  thread.callStack.push(activeChild);

  const suspended = generated(frame, thread, jvm.jit, false);
  t.ok(suspended?.deopt && suspended.transient,
    'the generated return suspends instead of popping another Frame');
  t.equal(suspended?.reason, 'generated return with active child',
    'the suspension reports the structural call-stack invariant');
  t.deepEqual(thread.callStack.items, [frame, activeChild],
    'both the returning parent and active child remain scheduler-visible');

  thread.callStack.pop();
  const completed = generated(frame, thread, jvm.jit, false);
  t.ok(completed?.returned, 'the parent returns after its child retires');
  t.equal(completed?.value, 7, 'the replayed return preserves its operand');
  t.equal(thread.callStack.size(), 0, 'the parent removes only its own Frame');
  t.end();
});

test('baseline callers stop immediately when synchronous dispatch leaves a child', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedInvokeChildGuardHarness', `
public class GeneratedInvokeChildGuardHarness {
  private static int child() { return 7; }
  public static int caller() { return child(); }
}
`);
  const jvm = new JVM({classpath, jit: {warmupThreshold: 0}});
  await jvm.loadClassByName('GeneratedInvokeChildGuardHarness');
  const method = await jvm.findMethodInHierarchy(
    'GeneratedInvokeChildGuardHarness', 'caller', '()I');
  const generated = jvm.jit.compileBaselineMethod(method);
  const frame = new Frame(method);
  frame.className = 'GeneratedInvokeChildGuardHarness';
  const activeChild = new Frame(method);
  activeChild.className = 'ArbitrarySchedulerVisibleChild';
  const thread = {
    id: 0, status: 'runnable', pendingException: null,
    callStack: new Stack(),
  };
  thread.callStack.push(frame);
  const originalInvoke = jvm.jit.tryInvokeSyncAt;
  jvm.jit.tryInvokeSyncAt = () => {
    thread.callStack.push(activeChild);
    return jvm.jit.returnVoid();
  };
  t.teardown(() => { jvm.jit.tryInvokeSyncAt = originalInvoke; });

  let result;
  t.doesNotThrow(() => { result = generated(frame, thread, jvm.jit, false); },
    'a missing non-void result cannot underflow the generated operand stack');
  t.ok(result?.deopt && result.transient,
    'the caller yields to the scheduler while its child owns execution');
  t.equal(result?.reason, 'synchronous invokestatic left active child',
    'the call boundary reports the structural ownership failure');
  t.equal(frame.pc, 1,
    'the caller remains at the verified post-invoke continuation');
  t.deepEqual(frame.stack.items, [],
    'the caller does not fabricate or consume a return operand');
  t.deepEqual(thread.callStack.items, [frame, activeChild],
    'both frames remain visible to canonical scheduling');
  t.end();
});

test('baseline callers do not replay a consumed asynchronous child call', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedAsyncChildGuardHarness', `
public class GeneratedAsyncChildGuardHarness {
  private static void child(int value) { }
  public static int caller(int value) { child(value); return value + 1; }
}
`);
  const jvm = new JVM({classpath, jit: {warmupThreshold: 0}});
  await jvm.loadClassByName('GeneratedAsyncChildGuardHarness');
  const method = await jvm.findMethodInHierarchy(
    'GeneratedAsyncChildGuardHarness', 'caller', '(I)I');
  const generated = jvm.jit.compileBaselineMethod(method);
  const frame = new Frame(method);
  frame.className = 'GeneratedAsyncChildGuardHarness';
  frame.locals[0] = 41;
  const activeChild = new Frame(method);
  activeChild.className = 'ArbitrarySchedulerVisibleChild';
  const thread = {
    id: 0, status: 'runnable', pendingException: null,
    callStack: new Stack(),
  };
  thread.callStack.push(frame);
  const originalInvoke = jvm.jit.tryInvokeSyncAt;
  let consumesInvocation = true;
  jvm.jit.tryInvokeSyncAt = (_id, caller, currentThread) => {
    if (consumesInvocation) {
      caller.stack.pop();
      activeChild.jitGeneratedReturnParent = caller;
    } else {
      delete activeChild.jitGeneratedReturnParent;
    }
    currentThread.callStack.push(activeChild);
    return jvm.jit.asyncInvokeSentinel();
  };
  t.teardown(() => { jvm.jit.tryInvokeSyncAt = originalInvoke; });

  const result = generated(frame, thread, jvm.jit, false);
  t.ok(result?.deopt && result.transient,
    'the dispatched asynchronous child suspends the generated caller');
  t.equal(result?.reason, 'asynchronous invokestatic left active child',
    'the consumed-call handoff is distinguished from a cold fallback');
  t.equal(frame.pc, 2,
    'the caller retains its verified post-invoke continuation');
  t.deepEqual(frame.stack.items, [],
    'the already-consumed argument is not reconstructed for replay');
  t.deepEqual(thread.callStack.items, [frame, activeChild],
    'the scheduler retains both the caller and dispatched child');

  thread.callStack.pop();
  frame.pc = 0;
  frame.stack.clear();
  consumesInvocation = false;
  const initialization = generated(frame, thread, jvm.jit, false);
  t.ok(initialization?.deopt && initialization.transient,
    'an unconsumed asynchronous child also suspends the generated caller');
  t.equal(initialization?.reason,
    'asynchronous callee from synchronous invokestatic',
    'class-initialization-style handoff remains a cold replay');
  t.equal(frame.pc, 1,
    'the caller returns to the invoke that has not executed yet');
  t.deepEqual(frame.stack.items, [41],
    'the unconsumed invocation operands remain available for retry');
  t.end();
});

test('structured returns materialize instead of retiring an active child', async (t) => {
  const classpath = compileJavaFixture(t, 'StructuredReturnGuardHarness', `
public class StructuredReturnGuardHarness {
  public static int value() { return 11; }
}
`);
  const jvm = new JVM({classpath, jit: {
    warmupThreshold: 0, structuredSsa: true,
  }});
  await jvm.loadClassByName('StructuredReturnGuardHarness');
  const method = await jvm.findMethodInHierarchy(
    'StructuredReturnGuardHarness', 'value', '()I');
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated?.jvmStructuredSsa,
    'the fixture uses the structured return implementation');
  const frame = new Frame(method);
  frame.className = 'StructuredReturnGuardHarness';
  const activeChild = new Frame(method);
  activeChild.className = 'StructuredReturnGuardHarness';
  const thread = {
    id: 0, status: 'runnable', pendingException: null,
    callStack: new Stack(),
  };
  thread.callStack.push(frame);
  thread.callStack.push(activeChild);

  const suspended = generated(frame, thread, jvm.jit, false);
  t.ok(suspended?.deopt && suspended.transient,
    'the structured return suspends while another Frame is active');
  t.equal(suspended?.reason, 'structured SSA return with active child',
    'the structural invariant selects the canonical fallback');
  t.deepEqual(thread.callStack.items, [frame, activeChild],
    'the structured return does not pop the child Frame');
  t.equal(frame.pc, 1, 'the parent resumes at its return bytecode');
  t.deepEqual(frame.stack.items, [11],
    'the return operand is reconstructed for canonical execution');
  t.end();
});

test('partial Wasm OSR yields to restored child frames', async (t) => {
  const classpath = compileJavaFixture(t, 'WasmOsrChildHandoffHarness', `
public final class WasmOsrChildHandoffHarness {
  static int sum(int count) {
    int total = 0;
    for (int index = 0; index < count; index++) total += index;
    return total;
  }
}
`);
  const jvm = new JVM({classpath, jit: {
    warmupThreshold: 0, inlineLoopRegions: false, structuredSsa: false,
  }});
  await jvm.loadClassByName('WasmOsrChildHandoffHarness');
  const method = await jvm.findMethodInHierarchy(
    'WasmOsrChildHandoffHarness', 'sum', '(I)I');
  const generated = jvm.jit.compileBaselineMethod(method);
  const originalPrepare = jvm.jit.wasmJit.prepare;
  const originalExecute = jvm.jit.wasmJit.execute;
  let partialExecutions = 0;
  jvm.jit.wasmJit.enabled = true;
  jvm.jit.wasmJit.prepare = () => ({
    st: {meta: {fullyCompiled: false, deoptableCalls: 0}}, blk: 0,
  });
  jvm.jit.wasmJit.execute = () => {
    partialExecutions += 1;
    return {handled: true};
  };
  const admissionFrame = new Frame(method);
  admissionFrame.className = 'WasmOsrChildHandoffHarness';
  const admissionThread = {callStack: new Stack()};
  admissionThread.callStack.push(admissionFrame);
  t.equal(jvm.jit.wasmOsrProbe(
    admissionFrame, admissionThread, 0, 0), null,
  'a partial module is not entered from a live JavaScript activation');
  t.equal(partialExecutions, 0,
    'partial OSR rejection happens before Wasm side effects');
  jvm.jit.wasmJit.prepare = originalPrepare;
  jvm.jit.wasmJit.execute = originalExecute;
  const makeThread = () => ({
    id: 0, status: 'runnable', pendingException: null,
    callStack: new Stack(),
  });
  const installPartialOsr = (thread, caller) => {
    let probes = 0;
    const child = new Frame(method);
    child.className = 'StructurallyRestoredWasmChild';
    jvm.jit.wasmOsrProbe = (frame, _thread, pc) => {
      probes += 1;
      frame.pc = pc;
      thread.callStack.push(child);
      return {deopted: true, resumePc: pc};
    };
    return {child, probes: () => probes, caller};
  };

  const generatedFrame = new Frame(method);
  generatedFrame.className = 'WasmOsrChildHandoffHarness';
  generatedFrame.locals[0] = 20000;
  const generatedThread = makeThread();
  generatedThread.callStack.push(generatedFrame);
  const generatedOsr = installPartialOsr(generatedThread, generatedFrame);
  const generatedResult = generated(
    generatedFrame, generatedThread, jvm.jit, false);
  t.ok(generatedResult?.deopt && generatedResult.transient,
    'the baseline generator stops when OSR materializes a child');
  t.equal(generatedResult.reason, 'wasm OSR left active child',
    'the handoff has a distinct structural deoptimization reason');
  t.equal(generatedOsr.probes(), 1, 'the caller does not probe past the handoff');
  t.equal(generatedThread.callStack.peek(), generatedOsr.child,
    'the restored child keeps scheduler ownership');

  const runnerFrame = new Frame(method);
  runnerFrame.className = 'WasmOsrChildHandoffHarness';
  runnerFrame.locals[0] = 20000;
  const runnerThread = makeThread();
  runnerThread.callStack.push(runnerFrame);
  const runnerOsr = installPartialOsr(runnerThread, runnerFrame);
  const runnerResult = await jvm.jit.runFrame(runnerFrame, runnerThread);
  t.ok(runnerResult?.deopt && runnerResult.transient,
    'the bytecode runner also yields after partial OSR');
  t.equal(runnerResult.reason, 'wasm OSR left active child',
    'runner and generated tiers share the same handoff protocol');
  t.equal(runnerOsr.probes(), 1, 'the runner does not execute the parent again');
  t.equal(runnerThread.callStack.peek(), runnerOsr.child,
    'the runner leaves the restored child on top');
  t.end();
});

test('structured deoptimization preserves block-local stores', async (t) => {
  const classpath = compileJavaFixture(t, 'StructuredLocalSpillHarness', `
public class StructuredLocalSpillHarness {
  public static int value(Object input, int[] absent) {
    Object retained = input;
    int length = absent.length;
    return retained == null ? length + 1 : length;
  }
}
`);
  const jvm = new JVM({classpath, jit: {
    warmupThreshold: 0, structuredSsa: true,
  }});
  await jvm.loadClassByName('StructuredLocalSpillHarness');
  const method = await jvm.findMethodInHierarchy(
    'StructuredLocalSpillHarness', 'value', '(Ljava/lang/Object;[I)I');
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated?.jvmStructuredSsa,
    'the fixture uses structured local value numbering');
  const retained = {type: 'java/lang/Object', fields: {}};
  const frame = new Frame(method);
  frame.className = 'StructuredLocalSpillHarness';
  frame.locals[0] = retained;
  frame.locals[1] = null;
  const thread = {
    id: 0, status: 'runnable', pendingException: null,
    callStack: new Stack(),
  };
  thread.callStack.push(frame);
  let thrown = null;
  try {
    generated(frame, thread, jvm.jit, false);
  } catch (error) {
    thrown = error;
  }
  t.equal(thrown?.type, 'java/lang/NullPointerException',
    'the later throwing operation follows canonical JVM semantics');
  t.equal(frame.locals[2], retained,
    'a same-block local needed after the throw is present in the Frame');
  t.end();
});

test('Wasm Math imports preserve exact Java long semantics', (t) => {
  const abs = mathIntrinsicFunction('abs', '(J)J');
  const max = mathIntrinsicFunction('max', '(JJ)J');
  const min = mathIntrinsicFunction('min', '(JJ)J');
  const minimumLong = -0x8000000000000000n;
  t.equal(abs(-37n), 37n, 'long abs never crosses through Number');
  t.equal(abs(minimumLong), minimumLong,
    'Long.MIN_VALUE abs preserves Java overflow semantics');
  t.equal(max(0x7fffffffffffffffn, -1n), 0x7fffffffffffffffn,
    'long max remains exact above Number safe-integer range');
  t.equal(min(-0x8000000000000000n, 1n), minimumLong,
    'long min remains exact below Number safe-integer range');
  t.equal(mathIntrinsicFunction('sqrt', '(J)J'), null,
    'nonexistent long Math overloads stay outside the intrinsic tier');
  t.end();
});

test('typed Wasm array-store imports preserve JVM narrowing and traps', (t) => {
  const imports = new Map();
  const registry = {
    addImport(name, _params, _results, fn) {
      imports.set(name, fn);
    },
  };
  addTypedArrayStoreImports(registry, 'arbitraryMethod');

  const bytes = [0];
  bytes.type = '[B';
  imports.get('aset_bastore')(bytes, 0, 0x1ff);
  t.equal(bytes[0], -1, 'bastore narrows plain byte arrays to signed byte');

  const booleans = [0];
  booleans.type = '[Z';
  imports.get('aset_bastore')(booleans, 0, 6);
  t.equal(booleans[0], 0, 'bastore narrows boolean arrays to the low bit');

  const chars = [0];
  chars.type = '[C';
  imports.get('aset_castore')(chars, 0, -1);
  t.equal(chars[0], 0xffff, 'castore narrows to unsigned 16-bit');

  const shorts = [0];
  shorts.type = '[S';
  imports.get('aset_sastore')(shorts, 0, 0xffff);
  t.equal(shorts[0], -1, 'sastore narrows to signed 16-bit');

  t.throws(() => imports.get('aset_iastore')(null, 0, 1),
    (error) => error?.type === 'java/lang/NullPointerException',
    'null stores retain the guest NullPointerException');
  t.throws(() => imports.get('aset_iastore')([0], 1, 1),
    (error) => error?.type === 'java/lang/ArrayIndexOutOfBoundsException',
    'out-of-bounds stores retain the guest bounds exception');
  t.end();
});

test('handwritten region fingerprints ignore guest class and method names', (t) => {
  const shape = (owner, dependency, methodName, fieldName, constant = 7) => ({
    descriptor: `(L${owner};)V`,
    items: [
      { instruction: { op: 'invokestatic', arg: ['Method', owner,
        [methodName, `(L${dependency};I)V`]] } },
      { instruction: { op: 'getstatic', arg: ['Field', dependency, [fieldName, 'I']] } },
      { instruction: { op: 'new', arg: dependency } },
      { instruction: { op: 'bipush', arg: String(constant) } },
      { instruction: 'return' },
    ],
  });
  const jit = { getCodeItems: (method) => method.items };
  const original = HandwrittenFusedGradient.fingerprintMethods(jit,
    [shape('game/A', 'game/B', 'draw', 'pixels')]);
  const renamed = HandwrittenFusedGradient.fingerprintMethods(jit,
    [shape('renamed/X', 'renamed/Y', 'method_17', 'field_42')]);
  const altered = HandwrittenFusedGradient.fingerprintMethods(jit,
    [shape('renamed/X', 'renamed/Y', 'method_17', 'field_42', 8)]);
  t.equal(renamed, original,
    'consistent owner, member, and descriptor renaming leaves the shape unchanged');
  t.notEqual(altered, original, 'an altered bytecode constant changes the verified shape');
  const longConstant = {
    descriptor: '()J',
    items: [
      {instruction: {op: 'ldc2_w', arg: 0x1fffffffffffffn}},
      {instruction: 'lreturn'},
    ],
  };
  const otherLongConstant = {
    ...longConstant,
    items: [
      {instruction: {op: 'ldc2_w', arg: 0x1ffffffffffffen}},
      {instruction: 'lreturn'},
    ],
  };
  const longFingerprint =
    HandwrittenFusedGradient.fingerprintMethods(jit, [longConstant]);
  t.equal(typeof longFingerprint, 'number',
    'unrelated long constants cannot crash an opt-in oracle scan');
  t.notEqual(longFingerprint,
    HandwrittenFusedGradient.fingerprintMethods(jit, [otherLongConstant]),
  'distinct long constants remain distinct in canonical fingerprints');
  t.end();
});

test('complete guest-kernel substitutions are differential oracles, not a default tier', (t) => {
  const flag = ['Field', 'ArbitraryFlags', ['enabled', 'Z']];
  const codeItems = [
    { instruction: { op: 'getstatic', arg: flag } },
    ...[
      'istore', 'iload_1', 'bipush', 'if_icmpeq', 'bipush', 'bipush',
      'aconst_null', 'checkcast', 'bipush', 'bipush',
    ].map((instruction) => ({ instruction })),
    { instruction: {
      op: 'invokestatic',
      arg: ['Method', 'ArbitraryMasks', ['and', '(II)I']],
    } },
    ...['goto', 'athrow', 'iinc', 'iaload', 'iastore']
      .map((instruction) => ({ instruction })),
    ...[57, 16711422, -59233087]
      .map((arg) => ({ instruction: { op: 'ldc', arg } })),
  ];
  const method = {
    name: 'arbitraryPixelLoop',
    descriptor: '(IB[III)V',
    attributes: [{ type: 'code', code: { codeItems } }],
  };
  const genericJvm = new JVM({ jit: { warmupThreshold: 0 } });
  t.notOk(genericJvm.jit.guestKernelOraclesEnabled,
    'normal JIT configuration keeps complete guest algorithms disabled');
  t.equal(genericJvm.jit.getSynchronousIntrinsic(method, method.descriptor), null,
    'an exact historical fingerprint is not substituted in production');

  const oracleJvm = new JVM({ jit: {
    warmupThreshold: 0,
    guestKernelOracles: true,
  } });
  t.equal(typeof oracleJvm.jit.getSynchronousIntrinsic(method, method.descriptor),
    'function', 'the same replacement remains available for explicit differential tests');
  t.end();
});

test('structured SSA derives packed pixel loops from bytecode values', (t) => {
  const instructions = [
    'iconst_0',
    { op: 'istore', arg: 5 },
    { op: 'iload', arg: 5 },
    { op: 'iload', arg: 4 },
    { op: 'if_icmpge', arg: 'Lreturn' },
    'aload_2',
    'iload_0',
    'iload_3',
    'aload_2',
    'iload_0',
    'iaload',
    { op: 'ldc', arg: 16711422 },
    'iand',
    'iconst_1',
    'ishr',
    'iadd',
    'iastore',
    { op: 'iinc', varnum: 0, incr: 1 },
    { op: 'iinc', varnum: 5, incr: 1 },
    { op: 'goto', arg: 'Lloop' },
    'return',
  ];
  const method = {
    className: 'ArbitraryPixels',
    name: 'arbitraryPackedLoop',
    descriptor: '(IB[III)V',
    flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: instructions.map((instruction, index) => ({
        labelDef: index === 2 ? 'Lloop:'
          : index === 20 ? 'Lreturn:' : `L${index}:`,
        instruction,
      })),
      localsSize: '6',
      stackSize: '5',
      exceptionTable: [],
    } }],
  };
  const jvm = new JVM({ jit: {
    warmupThreshold: 0,
    structuredSsa: true,
  } });
  t.equal(jvm.jit.getSynchronousIntrinsic(method, method.descriptor), null,
    'the packed-pixel descriptor does not select a prewritten algorithm');
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated?.jvmStructuredSsa,
    'the generic CFG, stack, and array-loop analysis selects structured SSA');
  t.notOk(generated.jvmStructuredSource.includes('packedColorScanlineDirect') ||
      generated.jvmStructuredSource.includes('Handwritten'),
    'generated source contains no guest-kernel call');

  const pixels = [0x123456, 0xabcdef];
  pixels.type = '[I';
  const color = 0x010203;
  const expected = pixels.map((pixel) =>
    (color + ((pixel & 16711422) >> 1)) | 0);
  const frame = new Frame(method);
  frame.className = 'ArbitraryPixels';
  frame.locals.splice(0, 6, 0, 57, pixels, color, pixels.length, 0);
  const thread = { status: 'runnable', callStack: new Stack() };
  thread.callStack.push(frame);
  generated(frame, thread, jvm.jit, false);
  t.deepEqual(pixels.slice(), expected,
    'emitted arithmetic is derived from the bytecode operands and constant');
  t.end();
});

test('affine sprite raster preserves Java sampling and rejects before writes', (t) => {
  const { roundedFloorDivide, runRaster } = HandwrittenAffineSpriteRaster._test;
  for (let numerator = -7; numerator <= 7; numerator += 1) {
    t.equal(roundedFloorDivide(3, numerator), Math.floor(numerator / 3),
      `verified division helper preserves floor semantics for ${numerator}`);
  }

  const base = {
    width: 2,
    height: 2,
    source: Int32Array.from([10, 20, 30, 40]),
    mask: null,
    destination: new Int32Array(4),
    clipOuterStart: 0,
    clipOuterEnd: 2,
    clipInnerStart: 0,
    clipInnerEnd: 2,
    surfaceStride: 2,
  };
  const args = [0, 2, 0, 0, 2, 2, 0, 0, 0, -1];
  t.ok(runRaster(base, args), 'ordinary affine raster input is accepted');
  t.deepEqual(Array.from(base.destination), [10, 20, 30, 40],
    'column scan writes the same moving source coordinates');

  const masked = {
    ...base,
    mask: Int8Array.from([1, 0, 1, 1]),
    destination: new Int32Array(4),
  };
  t.ok(runRaster(masked, args), 'masked affine raster input is accepted');
  t.deepEqual(Array.from(masked.destination), [10, 0, 30, 40],
    'mask coordinates independently suppress source pixels');

  const invalidDestination = Int32Array.from([101, 102, 103]);
  const invalid = {
    ...base,
    destination: invalidDestination,
  };
  t.notOk(runRaster(invalid, args), 'short destination rejects the fast path');
  t.deepEqual(Array.from(invalidDestination), [101, 102, 103],
    'bounds rejection happens before the first destination write');

  const negativeSourceX = {
    ...base,
    destination: Int32Array.from([201, 202, 203, 204]),
  };
  t.notOk(runRaster(negativeSourceX,
    [0, 2, 0, 0, 2, 2, 0, 0, -4, -1]),
  'unsupported negative remainder rejects the fast path');
  t.deepEqual(Array.from(negativeSourceX.destination), [201, 202, 203, 204],
    'source-coordinate rejection is also side-effect free');
  t.end();
});

function referenceAffineSpriteRaster(data, inputArgs) {
  const divide = (numerator, denominator) => (numerator / denominator) | 0;
  const floorDivide = (denominator, numerator) => {
    const sign = numerator >>> 31;
    return (divide((numerator + sign) | 0, denominator) - sign) | 0;
  };
  const args = inputArgs.map(value => value | 0);
  const [outerStart, outerEnd, leftStart, leftEnd, rightStart, rightEnd,
    dim, blend, sourceOffset, maskOverride] = args;
  const outerSpan = (outerEnd - outerStart) | 0;
  let firstOuter = outerStart;
  if (firstOuter < data.clipOuterStart) firstOuter = data.clipOuterStart;
  let lastOuter = outerEnd;
  if (lastOuter > data.clipOuterEnd) lastOuter = data.clipOuterEnd;
  for (let outer = firstOuter; outer < lastOuter; outer += 1) {
    let maskX = divide((
      Math.imul(data.width, (outer - outerStart) | 0) +
      (outerSpan >> 1)
    ) | 0, outerSpan);
    if (maskX >= data.width) maskX = (data.width - 1) | 0;
    const sourceX = ((maskX + sourceOffset) | 0) % data.width;
    if (maskOverride >= 0) maskX = maskOverride;
    const leftDelta = (leftEnd - leftStart) | 0;
    const rightDelta = (rightEnd - rightStart) | 0;
    const left = (
      Math.imul(leftStart, outerSpan) +
      Math.imul(leftDelta, (outer - outerStart) | 0) +
      (leftDelta >> 1)
    ) | 0;
    const right = (
      Math.imul(rightStart, outerSpan) +
      Math.imul(rightDelta, (outer - outerStart) | 0) +
      (rightDelta >> 1)
    ) | 0;
    const innerSpan = (right - left) | 0;
    let firstInner = floorDivide(
      outerSpan, (left + (outerSpan >> 1)) | 0);
    if (firstInner < data.clipInnerStart) firstInner = data.clipInnerStart;
    let lastInner = floorDivide(
      outerSpan, (right + (outerSpan >> 1)) | 0);
    if (lastInner > data.clipInnerEnd) lastInner = data.clipInnerEnd;
    if (lastInner <= firstInner) continue;
    let sourceFixed = (
      Math.imul(data.height,
        (Math.imul(firstInner, outerSpan) - left) | 0) +
      (innerSpan >> 1)
    ) | 0;
    let sourceFixedLast = (
      Math.imul(data.height,
        (Math.imul((lastInner - 1) | 0, outerSpan) - left) | 0) +
      (innerSpan >> 1)
    ) | 0;
    if (sourceFixed <= -innerSpan) sourceFixed = (-innerSpan + 1) | 0;
    const sourceLimit = Math.imul(data.height, innerSpan);
    if (sourceFixed >= sourceLimit) sourceFixed = (sourceLimit - 1) | 0;
    if (sourceFixedLast >= sourceLimit) {
      sourceFixedLast = (sourceLimit - 1) | 0;
    }
    let sourceStep = 0;
    if (sourceFixedLast > sourceFixed) {
      sourceStep = divide(
        (sourceFixedLast - sourceFixed) | 0,
        (lastInner - firstInner - 1) | 0);
    }
    let destinationIndex =
      (Math.imul(firstInner, data.surfaceStride) + outer) | 0;
    for (let inner = firstInner; inner < lastInner; inner += 1) {
      const sourceY = divide(sourceFixed, innerSpan);
      const sourceRow = Math.imul(sourceY, data.width);
      let color = data.source[(sourceRow + sourceX) | 0] | 0;
      if (color !== 0 &&
          (!data.mask || (data.mask[(sourceRow + maskX) | 0] | 0) !== 0)) {
        if (dim) color = (color >> 1) & 8355711;
        if (blend) {
          color = (
            color + ((data.destination[destinationIndex] >> 1) & 8355711)
          ) | 0;
        }
        data.destination[destinationIndex] = color;
      }
      destinationIndex = (destinationIndex + data.surfaceStride) | 0;
      sourceFixed = (sourceFixed + sourceStep) | 0;
    }
  }
}

test('affine sprite raster differentially matches 200 moving invocations', (t) => {
  const { runRaster } = HandwrittenAffineSpriteRaster._test;
  let randomState = 0x51f15e;
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState;
  };
  const failures = [];
  for (let invocation = 0; invocation < 200; invocation += 1) {
    const width = 1 + random() % 6;
    const height = 1 + random() % 6;
    const source = Int32Array.from({ length: width * height }, () =>
      random() % 5 === 0 ? 0 : random() & 0xffffff);
    const mask = invocation % 3 === 0
      ? Int8Array.from({ length: width * height }, () => random() & 1)
      : null;
    const initial = Int32Array.from({ length: 16 * 16 }, () =>
      random() & 0xffffff);
    const actual = initial.slice();
    const expected = initial.slice();
    const outerStart = random() % 4;
    const outerSpan = 2 + random() % 8;
    const leftStart = random() % 4;
    const leftEnd = random() % 4;
    const drawWidth = 1 + random() % 7;
    const args = [
      outerStart,
      outerStart + outerSpan,
      leftStart,
      leftEnd,
      leftStart + drawWidth,
      leftEnd + drawWidth,
      random() & 1,
      random() & 1,
      random() % width,
      invocation % 4 === 0 ? random() % width : -1,
    ];
    const shared = {
      width,
      height,
      source,
      mask,
      clipOuterStart: random() % 4,
      clipOuterEnd: 12 + random() % 5,
      clipInnerStart: random() % 4,
      clipInnerEnd: 12 + random() % 5,
      surfaceStride: 16,
    };
    referenceAffineSpriteRaster({ ...shared, destination: expected }, args);
    const accepted = runRaster({ ...shared, destination: actual }, args);
    if (!accepted ||
        actual.some((value, index) => value !== expected[index])) {
      failures.push({ invocation, accepted, args, actual, expected });
      break;
    }
  }
  t.equal(failures.length, 0,
    'all moving, clipped, masked, dimmed, and blended surfaces are bit exact');
  t.end();
});

function compileJavaFixture(t, className, source) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jit-fixture-'));
  t.teardown(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const sourcePath = path.join(tempDir, `${className}.java`);
  fs.writeFileSync(sourcePath, source);
  execFileSync('javac', ['-g', '-d', tempDir, sourcePath], { stdio: 'inherit' });
  return tempDir;
}

async function invoke(jvm, thread, className, methodName, descriptor, locals) {
  const method = await jvm.findMethodInHierarchy(className, methodName, descriptor);
  const frame = new Frame(method);
  frame.className = className;
  locals.forEach((value, index) => {
    frame.locals[index] = value;
  });
  const before = thread.callStack.size();
  thread.callStack.push(frame);
  let ticks = 0;
  while (thread.callStack.size() > before) {
    const result = await jvm.executeTick();
    ticks += 1;
    if (result.completed) break;
    if (ticks > 50000000) throw new Error('tick limit');
  }
  return ticks;
}

async function createPyramidHarness(jitOptions) {
  const jvm = new JVM({ classpath: 'sources', jit: jitOptions });
  await jvm.loadClassByName('PyramidApplet');
  const thread = {
    id: 0,
    name: 'jit-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;

  const applet = await jvm.createAppletInstance('PyramidApplet');
  await invoke(jvm, thread, 'PyramidApplet', '<init>', '()V', [applet]);
  jvm._jreFindMethod('java/awt/Component', 'setSize', '(II)V')(jvm, applet, [800, 600]);
  await invoke(jvm, thread, 'PyramidApplet', 'init', '()V', [applet]);
  return { jvm, thread, applet };
}

test('Wasm value imports preserve JavaScript boolean fields', (t) => {
  t.equal(wasmJitTest.toWasmValue(wasmJitTest.T.i32, true), 1,
    'true is imported as Java boolean 1');
  t.equal(wasmJitTest.toWasmValue(wasmJitTest.T.i32, false), 0,
    'false is imported as Java boolean 0');
  t.end();
});

test('oversized loop policy selects Wasm by structure, not guest identity', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0 } });
  const shape = (name, length = 2048, backward = true) => ({
    name,
    descriptor: '()V',
    flags: ['private'],
    attributes: [{ type: 'code', code: {
      localsSize: '1',
      stackSize: '1',
      codeItems: Array.from({ length }, (_unused, index) => ({
        labelDef: index === 0 ? 'Lentry:' : `L${index}:`,
        instruction: index === length - 1 && backward
          ? { op: 'goto', arg: 'Lentry' }
          : 'nop',
      })),
      exceptionTable: [],
    } }],
  });
  t.ok(jvm.jit.isOversizedLoopMethod(shape('arbitraryAudioStateMachine')),
    'an arbitrary 2048-instruction loop selects the oversized policy');
  t.notOk(jvm.jit.isOversizedLoopMethod(shape('renamedShortBody', 2047)),
    'a shorter loop retains the ordinary tier policy');
  t.notOk(jvm.jit.isOversizedLoopMethod(shape('renamedAcyclicBody', 2048, false)),
    'a large acyclic body does not need loop-tier intervention');
  const constructor = shape('<init>');
  t.notOk(jvm.jit.isOversizedLoopMethod(constructor),
    'constructors retain their observable initialization policy');
  t.equal(jvm.jit.oversizedWasmFirstMethodCount, 1,
    'the runtime counter records structurally selected methods once');
  const lowered = new JVM({ jit: {
    warmupThreshold: 0, oversizedWasmFirstCodeItems: 128,
    wasmRelaxedReferenceReturns: true, wasmStructured: true,
    wasmCheckcast: true, wasmDirectStaticLink: true,
    wasmDirectInstanceLink: true,
  } });
  t.equal(lowered.jit.wasmJit.structuredEnabled, true,
    'browser integrations can explicitly enable structured Wasm');
  t.equal(lowered.jit.wasmJit.checkcastEnabled, true,
    'browser integrations can explicitly enable Wasm cast lowering');
  t.equal(lowered.jit.wasmJit.relaxedRefReturn, true,
    'the normal-flow reference-return proof is explicitly configurable');
  t.equal(lowered.jit.wasmJit.directStaticLinkEnabled, true,
    'browser integrations can explicitly enable direct static Wasm links');
  t.equal(lowered.jit.wasmJit.directInstanceLinkEnabled, true,
    'browser integrations can explicitly enable guarded instance Wasm links');
  t.ok(lowered.jit.isOversizedLoopMethod(shape('loweredThreshold', 128)),
    'browser integrations can lower the structural threshold explicitly');
  t.notOk(lowered.jit.isOversizedLoopMethod(shape('belowLowered', 127)),
    'the configured threshold retains an exact lower boundary');

  const childMethod = shape('nestedLargeLoop', 128);
  childMethod.descriptor = '()I';
  const parentMethod = shape('parent', 1, false);
  const parent = new Frame(parentMethod);
  parent.className = 'ThresholdHarness';
  const thread = {
    status: 'runnable', pendingException: null, callStack: new Stack(),
  };
  thread.callStack.push(parent);
  let generatedRuns = 0;
  const generated = () => {
    generatedRuns += 1;
    return { returned: true, value: 9 };
  };
  generated.jvmSynchronous = true;
  let nestedRuns = 0;
  lowered.jit.wasmJit.enabled = true;
  lowered.jit.wasmJit.runNested = (child) => {
    nestedRuns += 1;
    thread.callStack.pop();
    return { returned: true, value: 7, isVoid: false, child };
  };
  const nested = lowered.jit.tryInvokeResolvedTarget({
    op: 'invokestatic', descriptor: '()I', params: [], returnType: 'I',
  }, {
    method: childMethod, lookupClass: 'ThresholdHarness', generated,
  }, parent, thread);
  t.equal(nested, 7,
    'a selected synchronous child enters the nested Wasm protocol');
  t.equal(nestedRuns, 1,
    'the nested Wasm gate is consulted exactly once');
  t.equal(generatedRuns, 0,
    'successful nested Wasm execution bypasses the JavaScript child body');
  t.end();
});

test('long-arithmetic loop policy selects Wasm by opcode shape, not method identity', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0 } });
  const shape = (name, longOps = 8, length = 256, backward = true) => {
    const codeItems = Array.from({ length }, (_unused, index) => ({
      labelDef: index === 0 ? 'Lentry:' : `L${index}:`,
      instruction: index < longOps
        ? { op: index % 2 ? 'lmul' : 'i2l' }
        : index === length - 1 && backward
          ? { op: 'goto', arg: 'Lentry' }
          : 'nop',
    }));
    return {
      name,
      descriptor: '(II)[I',
      flags: ['private'],
      attributes: [{ type: 'code', code: { codeItems, exceptionTable: [] } }],
    };
  };
  t.ok(jvm.jit.isLongArithmeticLoopMethod(shape('arbitrarySynthesizer')),
    'a substantial loop with repeated Java long operations selects Wasm');
  t.notOk(jvm.jit.isLongArithmeticLoopMethod(shape('renamedFewLongOps', 7)),
    'a loop with sparse long arithmetic retains the ordinary tier policy');
  t.notOk(jvm.jit.isLongArithmeticLoopMethod(shape('renamedSmallBody', 8, 255)),
    'a small helper avoids Wasm module and crossing overhead');
  t.notOk(jvm.jit.isLongArithmeticLoopMethod(shape('renamedAcyclicBody', 8, 256, false)),
    'an acyclic numeric body retains the ordinary tier policy');
  const constructor = shape('<init>');
  t.notOk(jvm.jit.isLongArithmeticLoopMethod(constructor),
    'constructors retain their observable initialization policy');
  t.equal(jvm.jit.longArithmeticWasmFirstMethodCount, 1,
    'the runtime counter records a structurally selected method once');
  t.end();
});

test('dense nested array kernels select Wasm without guest-name matching', (t) => {
  const jvm = new JVM({
    jit: { warmupThreshold: 0, arrayKernelWasmFirst: true },
  });
  const shape = (name, {
    primitiveArrayAccesses = 24, referenceArrayAccesses = 0,
    length = 192, backward = true,
    nonStaticCall = false,
  } = {}) => {
    const totalArrayAccesses =
      primitiveArrayAccesses + referenceArrayAccesses;
    const codeItems = Array.from({ length }, (_unused, index) => ({
      labelDef: index === 0 ? 'Lentry:' : `L${index}:`,
      instruction: index < referenceArrayAccesses
        ? 'aaload'
        : index < totalArrayAccesses
          ? 'iaload'
          : index === totalArrayAccesses && nonStaticCall
          ? { op: 'invokevirtual',
            arg: ['Method', 'ArbitraryReceiver', ['leaf', '()V']] }
          : index === length - 1 && backward
            ? { op: 'goto', arg: 'Lentry' }
            : 'nop',
    }));
    return {
      name,
      descriptor: '([[I[I)V',
      flags: ['private', 'static'],
      attributes: [{ type: 'code', code: { codeItems, exceptionTable: [] } }],
    };
  };
  t.ok(jvm.jit.isArrayKernelWasmFirstMethod(shape('renamedArchiveKernel')),
    'bytecode size, array density, and a backedge select the Wasm policy');
  const rasterKernel = shape('renamedRasterKernel');
  t.ok(jvm.jit.isImportedArrayLoopJsPreferred(rasterKernel),
    'call-free imported-array loops prefer direct structured JavaScript');
  jvm.jit.wasmJit.enabled = true;
  jvm.jit.wasmJit.state.set(rasterKernel, {
    status: 'ready', meta: {fullyCompiled: true},
  });
  t.notOk(jvm.jit.hasReadyFullWasm(rasterKernel),
    'full bytecode coverage does not override per-element import locality');
  const wrapper = {
    name: 'renamedRasterWrapper', descriptor: '(II)V',
    flags: ['private'],
    attributes: [{ type: 'code', code: { codeItems: [{
      labelDef: 'Lentry:', instruction: { op: 'invokestatic',
        arg: ['Method', 'ArbitraryRasterOwner',
          ['renamedRasterKernel', '([[I[I)V']] },
    }, { labelDef: 'Lreturn:', instruction: 'return' }],
    exceptionTable: [] } }],
  };
  rasterKernel.className = 'ArbitraryRasterOwner';
  wrapper.className = 'ArbitraryRasterOwner';
  jvm.classes.ArbitraryRasterOwner = { ast: { classes: [{
    className: 'ArbitraryRasterOwner', items: [
      { type: 'method', method: rasterKernel },
      { type: 'method', method: wrapper },
    ],
  }] } };
  t.ok(jvm.jit.isImportedArrayJsClosurePreferred(wrapper),
    'a same-class static wrapper remains in JavaScript with its array loop');
  jvm.jit.wasmJit.state.set(wrapper, {
    status: 'ready', meta: {fullyCompiled: true},
  });
  t.notOk(jvm.jit.hasReadyFullWasm(wrapper),
    'Wasm readiness cannot split a wrapper from its imported-array callee');
  t.notOk(jvm.jit.isArrayKernelWasmFirstMethod(
    shape('anotherName', { primitiveArrayAccesses: 23 })),
  'a sparse array body retains the ordinary generated tier');
  t.notOk(jvm.jit.isArrayKernelWasmFirstMethod(
    shape('referenceHeavyName', {
      primitiveArrayAccesses: 0,
      referenceArrayAccesses: 24,
    })),
  'reference-array traffic does not satisfy primitive-array density');
  t.notOk(jvm.jit.isArrayKernelWasmFirstMethod(
    shape('acyclicName', { backward: false })),
  'an acyclic array helper avoids module compilation overhead');
  t.notOk(jvm.jit.isArrayKernelWasmFirstMethod(
    shape('dynamicName', { nonStaticCall: true })),
  'a dynamic call boundary retains the single-tier JavaScript policy');
  t.equal(jvm.jit.arrayKernelWasmFirstMethodCount, 1,
    'the structural selection is counted once');
  t.end();
});

test('small reference-field cursors stay in positional JavaScript', async (t) => {
  const classpath = compileJavaFixture(t, 'ReferenceCursorHarness', `
public class ReferenceCursorHarness {
  static int diagnostic;
  ReferenceCursorHarness head;
  ReferenceCursorHarness cursor;
  ReferenceCursorHarness step(int mode) {
    if (mode != 1) return null;
    ReferenceCursorHarness value = cursor;
    if (value == head) {
      cursor = null;
      return null;
    }
    cursor = value.cursor;
    if (mode != 0) diagnostic = -122;
    return value;
  }
  void unlink(boolean keep) {
    if (keep || cursor == null) return;
    cursor.cursor = null;
    cursor = null;
  }
  void clear(int mode) {
    head = null;
    cursor = null;
    if (mode != 0) diagnostic = 41;
  }
}
`);
  const jvm = new JVM({classpath, jit: {warmupThreshold: 0}});
  const classData = await jvm.loadClassByName('ReferenceCursorHarness');
  const method = jvm.findMethod(classData, 'step',
    '(I)LReferenceCursorHarness;');
  t.ok(jvm.jit.isReferenceFieldHelperJsPreferred(method),
    'structure selects an arbitrary acyclic reference cursor');
  jvm.jit.wasmJit.enabled = true;
  jvm.jit.wasmJit.state.set(method, {
    status: 'ready', meta: {fullyCompiled: true},
  });
  t.notOk(jvm.jit.hasReadyFullWasm(method),
    'ready Wasm cannot withdraw the positional cursor body');
  classData.staticFieldsInitialized = true;
  classData.staticFields.set('diagnostic:I', 0);
  jvm.classInitializationState.set('ReferenceCursorHarness', 'INITIALIZED');
  const tail = {type: 'ReferenceCursorHarness', fields: {
    'ReferenceCursorHarness.cursor': null,
  }};
  const value = {type: 'ReferenceCursorHarness', fields: {
    'ReferenceCursorHarness.cursor': tail,
  }};
  const head = {type: 'ReferenceCursorHarness', fields: {}};
  const receiver = {type: 'ReferenceCursorHarness', fields: {
    'ReferenceCursorHarness.head': head,
    'ReferenceCursorHarness.cursor': value,
  }};
  const thread = {
    id: 0, name: 'reference-cursor', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  await invoke(jvm, thread, 'ReferenceCursorHarness', 'step',
    '(I)LReferenceCursorHarness;', [receiver, 1]);
  t.equal(receiver.fields['ReferenceCursorHarness.cursor'], tail,
    'generated cursor execution advances the reference link');
  t.equal(classData.staticFields.get('diagnostic:I'), -122,
    'the admitted primitive static side effect is preserved');
  const unlink = jvm.findMethod(classData, 'unlink', '(Z)V');
  t.ok(jvm.jit.isReferenceFieldHelperJsPreferred(unlink),
    'the same structural rule selects a bounded void link mutator');
  receiver.fields['ReferenceCursorHarness.cursor'] = value;
  value.fields['ReferenceCursorHarness.cursor'] = tail;
  await invoke(jvm, thread, 'ReferenceCursorHarness', 'unlink', '(Z)V',
    [receiver, 0]);
  t.equal(receiver.fields['ReferenceCursorHarness.cursor'], null,
    'generated void helper clears the receiver link');
  t.equal(value.fields['ReferenceCursorHarness.cursor'], null,
    'generated void helper preserves the nested link update');
  const clear = jvm.findMethod(classData, 'clear', '(I)V');
  t.ok(jvm.jit.isReferenceFieldHelperJsPreferred(clear),
    'bounded reference-field cleanup needs no preceding field read');
  receiver.fields['ReferenceCursorHarness.head'] = head;
  receiver.fields['ReferenceCursorHarness.cursor'] = value;
  await invoke(jvm, thread, 'ReferenceCursorHarness', 'clear', '(I)V',
    [receiver, 1]);
  t.equal(receiver.fields['ReferenceCursorHarness.head'], null,
    'generated cleanup clears its first reference field');
  t.equal(receiver.fields['ReferenceCursorHarness.cursor'], null,
    'generated cleanup clears its second reference field');
  t.equal(classData.staticFields.get('diagnostic:I'), 41,
    'generated cleanup preserves its primitive static side effect');
  receiver.fields['ReferenceCursorHarness.head'] = head;
  receiver.fields['ReferenceCursorHarness.cursor'] = value;
  classData.staticFields.set('diagnostic:I', 0);
  const parent = new Frame(method);
  parent.className = 'ReferenceCursorHarness';
  parent.stack.items.push(receiver, 1);
  thread.callStack.items.length = 0;
  thread.callStack.push(parent);
  const depth = thread.callStack.size();
  invokeHandlers.invokevirtualSync(parent, {
    arg: ['Method', 'ReferenceCursorHarness', ['clear', '(I)V']],
  }, jvm, thread);
  t.equal(thread.callStack.size(), depth,
    'the synchronous interpreter invokes the positional helper without a child frame');
  t.equal(receiver.fields['ReferenceCursorHarness.head'], null,
    'the interpreter positional edge preserves the first field clear');
  t.equal(receiver.fields['ReferenceCursorHarness.cursor'], null,
    'the interpreter positional edge preserves the second field clear');
  t.equal(classData.staticFields.get('diagnostic:I'), 41,
    'the interpreter positional edge preserves the static effect');
  receiver.fields['ReferenceCursorHarness.head'] = head;
  receiver.fields['ReferenceCursorHarness.cursor'] = value;
  classData.staticFields.set('diagnostic:I', 0);
  parent.stack.items.push(receiver, 1);
  const resolvedDepth = thread.callStack.size();
  jvm.jit.tryInvokeSync('invokevirtual', parent, {
    arg: ['Method', 'ReferenceCursorHarness', ['clear', '(I)V']],
  }, thread);
  t.equal(thread.callStack.size(), resolvedDepth,
    'the resolved-target path also avoids a child frame');
  t.equal(receiver.fields['ReferenceCursorHarness.cursor'], null,
    'the resolved-target positional edge preserves cleanup effects');
  const clearCode = clear.attributes.find(attribute => attribute.type === 'code')
    .code.codeItems;
  clearCode.push({instruction: 'athrow'});
  jvm.jit.referenceFieldHelperJsMethods.delete(clear);
  jvm.jit.codegenSupportCache.delete(clear);
  t.ok(jvm.jit.isReferenceFieldHelperJsPreferred(clear),
    'an unreachable throw sentinel after return does not reject cleanup');
  t.end();
});

test('large dynamic primitive-array loops select structured JavaScript first',
  (t) => {
    const jvm = new JVM({ jit: { profileMethods: false } });
    const shape = (name, {
      length = 384, primitiveArrayAccesses = 32,
      dynamicCalls = 2, backward = true,
    } = {}) => {
      const codeItems = Array.from({length}, (_unused, index) => ({
        labelDef: index === 0 ? 'Lentry:' : `L${index}:`,
        instruction: index < primitiveArrayAccesses
          ? 'iaload'
          : index < primitiveArrayAccesses + dynamicCalls
            ? {op: 'invokevirtual',
              arg: ['Method', 'ArbitraryReceiver', ['leaf', '()V']]}
            : index === length - 1 && backward
              ? {op: 'goto', arg: 'Lentry'}
              : 'nop',
      }));
      return {
        name,
        descriptor: '([I)V',
        flags: ['private', 'static'],
        attributes: [{type: 'code', code: {codeItems, exceptionTable: []}}],
      };
    };
    t.ok(jvm.jit.isDynamicArrayStructuredFirstMethod(
      shape('run')),
    'selection uses size, array traffic, calls, and CFG rather than a method name');
    t.notOk(jvm.jit.isDynamicArrayStructuredFirstMethod(
      shape('shortLoop', {length: 383})),
    'a shorter body retains the ordinary tier policy');
    t.notOk(jvm.jit.isDynamicArrayStructuredFirstMethod(
      shape('sparseLoop', {primitiveArrayAccesses: 31})),
    'a sparse body does not pay structured compilation at entry');
    t.notOk(jvm.jit.isDynamicArrayStructuredFirstMethod(
      shape('staticFriendlyLoop', {dynamicCalls: 1})),
    'a body without repeated dynamic islands retains Wasm-first policy');
    t.notOk(jvm.jit.isDynamicArrayStructuredFirstMethod(
      shape('acyclicBody', {backward: false})),
    'an acyclic body is not selected as a loop region');
    t.equal(jvm.jit.dynamicArrayStructuredFirstMethodCount, 1,
      'the generic structural selection is counted once');
    t.end();
  });

test('Wasm identifies captured boolean statics without method-name gates', (t) => {
  const method = {
    name: 'arbitraryName',
    attributes: [{ type: 'code', code: { codeItems: [
      { instruction: { op: 'getstatic',
        arg: ['Field', 'renamed/Owner', ['renamedField', 'Z']] } },
      { instruction: { op: 'istore_3' } },
      { instruction: { op: 'invokestatic',
        arg: ['Method', 'another/Owner', ['arbitraryCall', '()V']] } },
      { instruction: { op: 'iload_3' } },
      { instruction: { op: 'ifeq', arg: 'L0' } },
      { instruction: { op: 'goto', arg: 'L0' } },
    ] } }],
  };
  const integer = {
    ...method,
    attributes: [{ type: 'code', code: { codeItems: [
      { instruction: { op: 'getstatic',
        arg: ['Field', 'other/Owner', ['otherField', 'I']] } },
    ] } }],
  };
  const directBranch = {
    ...method,
    attributes: [{ type: 'code', code: { codeItems: [
      { instruction: { op: 'getstatic',
        arg: ['Field', 'renamed/Owner', ['renamedField', 'Z']] } },
      { instruction: { op: 'ifeq', arg: 'L0' } },
    ] } }],
  };
  const unusedCapture = {
    ...method,
    attributes: [{ type: 'code', code: { codeItems: [
      { instruction: { op: 'getstatic',
        arg: ['Field', 'renamed/Owner', ['renamedField', 'Z']] } },
      { instruction: { op: 'istore_3' } },
      { instruction: { op: 'invokestatic',
        arg: ['Method', 'another/Owner', ['arbitraryCall', '()V']] } },
      { instruction: { op: 'return' } },
    ] } }],
  };
  t.ok(wasmJitTest.capturesBooleanStatic(method),
    'descriptor and opcode shape identify the unsafe partial-module input');
  t.notOk(wasmJitTest.capturesBooleanStatic(integer),
    'an integer static does not match the boolean guard');
  t.notOk(wasmJitTest.capturesBooleanStatic(directBranch),
    'a boolean consumed directly by its branch remains eligible');
  t.notOk(wasmJitTest.capturesBooleanStatic(unusedCapture),
    'an unused obfuscator flag does not demote a call-dense hot loop');
  method.descriptor = '()V';
  method.flags = ['static'];
  const compatibilityJvm = new JVM({ jit: { profileMethods: false } });
  t.notOk(compatibilityJvm.jit.isSupported(method),
    'call-dense captured control stays on the canonical interpreter');
  t.notOk(compatibilityJvm.jit.codegenSupportCache.has(method),
    'a legacy-tier rejection does not poison another compiler tier');
  t.ok(compatibilityJvm.jit.enabled,
    'the structural rejection does not disable JIT for unrelated methods');
  t.end();
});

test('structured SSA preserves byte-array narrowing on direct storage views', async (t) => {
  const classpath = compileJavaFixture(t, 'StructuredByteArrays', `
public class StructuredByteArrays {
  static void sumInto(byte[] values, int[] out) {
    int sum = 0;
    for (int i = 0; i < values.length; i++) sum += values[i];
    out[0] = sum;
  }
  static void fill(byte[] values, int value) {
    for (int i = 0; i < values.length; i++) values[i] = (byte)value;
  }
  static void fillFloats(float[] values, float value) {
    for (int i = 0; i < values.length; i++) values[i] = value;
  }
  static void countTrue(boolean[] values, int[] out) {
    int count = 0;
    for (int i = 0; i < values.length; i++) if (values[i]) count++;
    out[0] = count;
  }
  static void fillBooleans(boolean[] values, int value) {
    for (int i = 0; i < values.length; i++) values[i] = value != 0;
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0, profileMethods: false,
  } });
  await jvm.loadClassByName('StructuredByteArrays');
  jvm.classInitializationState.set('StructuredByteArrays', 'INITIALIZED');
  const thread = {
    id: 0, name: 'structured-byte-arrays', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;

  const input = [255, 128, 127];
  input.type = '[B';
  const sum = [0];
  sum.type = '[I';
  await invoke(jvm, thread, 'StructuredByteArrays', 'sumInto', '([B[I)V', [input, sum]);
  t.equal(sum[0], -2, 'direct baload paths sign-extend bytes');
  const sumMethod = await jvm.findMethodInHierarchy(
    'StructuredByteArrays', 'sumInto', '([B[I)V');
  t.ok(jvm.jit.codegenCache.get(sumMethod)?.jvmStructuredSsa,
    'byte-array loop selects structured SSA');
  t.notOk(jvm.jit.codegenCache.get(sumMethod).jvmStructuredSource.includes(
    '.type === "[Z"'),
  'the byte[] descriptor removes the per-element byte/boolean type test');
  const normalizeArrayLoad = jvm.jit.normalizeArrayLoad;
  let normalizedLoadCalls = 0;
  jvm.jit.normalizeArrayLoad = function countedNormalizeArrayLoad(...args) {
    normalizedLoadCalls += 1;
    return normalizeArrayLoad.apply(this, args);
  };
  sum[0] = 0;
  await invoke(jvm, thread, 'StructuredByteArrays', 'sumInto', '([B[I)V', [input, sum]);
  t.equal(sum[0], -2, 'the warmed generated loop keeps byte-load semantics');
  t.equal(normalizedLoadCalls, 0,
    'valid primitive loads normalize inline without a per-element helper call');

  const output = [0, 0, 0];
  output.type = '[B';
  const normalizeArrayStore = jvm.jit.normalizeArrayStore;
  let normalizedStoreCalls = 0;
  jvm.jit.normalizeArrayStore = function countedNormalizeArrayStore(...args) {
    normalizedStoreCalls += 1;
    return normalizeArrayStore.apply(this, args);
  };
  await invoke(jvm, thread, 'StructuredByteArrays', 'fill', '([BI)V', [output, 255]);
  t.deepEqual(output.slice(), [-1, -1, -1],
    'direct bastore paths narrow values to signed bytes');

  const booleans = [0, 1, 2, 0];
  booleans.type = '[Z';
  const trueCount = [0];
  trueCount.type = '[I';
  await invoke(jvm, thread, 'StructuredByteArrays', 'countTrue', '([Z[I)V',
    [booleans, trueCount]);
  t.equal(trueCount[0], 2,
    'a statically boolean baload still normalizes every truthy element to one');
  const countTrueMethod = await jvm.findMethodInHierarchy(
    'StructuredByteArrays', 'countTrue', '([Z[I)V');
  const countTrueSource =
    jvm.jit.codegenCache.get(countTrueMethod)?.jvmStructuredSource || '';
  t.notOk(countTrueSource.includes('.type === "[Z"'),
    'the boolean[] descriptor removes the same runtime kind test');
  await invoke(jvm, thread, 'StructuredByteArrays', 'fillBooleans', '([ZI)V',
    [booleans, 0]);
  t.deepEqual(booleans.slice(), [0, 0, 0, 0],
    'statically boolean bastore preserves zero/one normalization');
  const floats = [0, 0, 0];
  floats.type = '[F';
  await invoke(jvm, thread, 'StructuredByteArrays',
    'fillFloats', '([FF)V', [floats, 1 / 3]);
  t.deepEqual(floats.slice(), new Array(3).fill(Math.fround(1 / 3)),
    'direct fastore paths preserve Java float32 narrowing');
  t.equal(normalizedStoreCalls, 0,
    'valid primitive stores normalize inline without a per-element helper call');
  t.end();
});

test('baseline generated methods scalarize bounded primitive-array loop regions', async (t) => {
  const classpath = compileJavaFixture(t, 'InlineArrayRegionHarness', `
public class InlineArrayRegionHarness {
  static int touches;
  static int result;
  static void touch() { touches++; }
  static void convert(int[] mixed, byte[] pcm, int hash) {
    touch();
    try {
      for (int frame = 0; frame < mixed.length; frame++) {
        int sample = mixed[frame] >> 8;
        if (sample < -32768) sample = -32768;
        if (sample > 32767) sample = 32767;
        int offset = frame * 2;
        pcm[offset] = (byte) sample;
        pcm[offset + 1] = (byte) (sample >> 8);
        hash = hash * 31 + pcm[offset];
        hash = hash * 31 + pcm[offset + 1];
      }
      touch();
      result = hash;
    } catch (ArrayIndexOutOfBoundsException exception) {
      result = -77;
    }
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0, profileMethods: false,
  } });
  await jvm.loadClassByName('InlineArrayRegionHarness');
  jvm.classInitializationState.set('InlineArrayRegionHarness', 'INITIALIZED');
  jvm.classes.InlineArrayRegionHarness.staticFields.set('touches:I', 0);
  jvm.classes.InlineArrayRegionHarness.staticFields.set('result:I', 0);
  const thread = {
    id: 0, name: 'inline-array-region', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const mixed = [0x123400, -0x123400, 0x7fffffff, -0x80000000];
  mixed.type = '[I';
  const pcm = new Array(8).fill(0);
  pcm.type = '[B';

  await invoke(jvm, thread, 'InlineArrayRegionHarness',
    'convert', '([I[BI)V', [mixed, pcm, 17]);
  const method = await jvm.findMethodInHierarchy(
    'InlineArrayRegionHarness', 'convert', '([I[BI)V');
  const generated = jvm.jit.codegenCache.get(method);
  t.equal(generated?.jvmInlineLoopRegionCount, 1,
    'a name-independent region is embedded in the surrounding baseline body');
  t.ok(jvm.jit.inlineLoopRegionRunCount > 0,
    'the bounded array loop executes through its scalar region');
  t.deepEqual(pcm.slice(), [52, 18, -52, -19, -1, 127, 0, -128],
    'region stores preserve signed byte narrowing and saturation');
  const expectedHash = pcm.reduce((hash, value) =>
    (Math.imul(hash, 31) + value) | 0, 17);
  const fields = jvm.classes.InlineArrayRegionHarness.staticFields;
  t.equal(fields.get('result:I'), expectedHash,
    'scalar live-out locals are spilled back into the surrounding method');
  t.equal(fields.get('touches:I'), 2,
    'calls before and after the extracted region retain their effects');

  const plan = jvm.jit.compileInlinePrimitiveLoopRegions(method)[0];
  const osrFrame = new Frame(method);
  osrFrame.className = 'InlineArrayRegionHarness';
  osrFrame.pc = plan.header;
  osrFrame.locals[0] = mixed;
  osrFrame.locals[1] = pcm;
  osrFrame.locals[2] = 17;
  osrFrame.locals[plan.counterSlot] = 0;
  thread.callStack.push(osrFrame);
  t.ok(jvm.jit.tryRunInlineLoopRegionOsr(osrFrame, thread),
    'an interpreted frame enters the verified region at its loop header');
  t.equal(osrFrame.pc, plan.exit,
    'region OSR resumes at the original bytecode loop exit');
  thread.callStack.pop();

  const shortPcm = new Array(2).fill(0);
  shortPcm.type = '[B';
  await invoke(jvm, thread, 'InlineArrayRegionHarness',
    'convert', '([I[BI)V', [mixed, shortPcm, 17]);
  t.equal(fields.get('result:I'), -77,
    'an array exception resumes in the original surrounding handler');
  t.end();
});

test('monitor-bearing methods isolate scalar-bounded byte-copy regions', (t) => {
  const owner = 'ArbitraryScalarBoundedRegion';
  const field = ['Field', owner, ['source', '[B']];
  const method = {
    className: owner,
    name: 'copyChunk',
    descriptor: '([BIIIZLjava/lang/Object;)V',
    flags: ['static'],
    attributes: [{ type: 'code', code: {
      localsSize: '7',
      stackSize: '3',
      exceptionTable: [],
      codeItems: [
        { labelDef: 'L0:', instruction: 'aload_6' },
        { instruction: 'monitorenter' },
        { instruction: { op: 'goto', arg: 'Lheader' } },
        { labelDef: 'Lexit:', instruction: 'aload_6' },
        { instruction: 'monitorexit' },
        { instruction: 'return' },
        { labelDef: 'Lheader:', instruction: { op: 'iload', arg: 3 } },
        { instruction: { op: 'iload', arg: 2 } },
        { instruction: { op: 'if_icmpgt', arg: 'Lbody' } },
        { instruction: { op: 'goto', arg: 'Lexit' } },
        { labelDef: 'Lbody:', instruction: { op: 'iload', arg: 1 } },
        { instruction: { op: 'istore', arg: 5 } },
        { instruction: { op: 'iinc', varnum: 1, incr: 1 } },
        { instruction: 'aload_0' },
        { instruction: { op: 'iload', arg: 5 } },
        { instruction: { op: 'getstatic', arg: field } },
        { instruction: { op: 'iload', arg: 2 } },
        { instruction: 'baload' },
        { instruction: 'bastore' },
        { instruction: { op: 'iinc', varnum: 2, incr: 1 } },
        { instruction: { op: 'iload', arg: 4 } },
        { instruction: { op: 'ifeq', arg: 'Lheader' } },
        { instruction: { op: 'goto', arg: 'Lexit' } },
        { instruction: 'nop' },
      ],
    } }],
  };
  const jvm = new JVM({ jit: {
    structuredSsa: true,
    fusedRegions: false,
    profileMethods: false,
    scalarBoundedInlineRegions: true,
  } });
  const source = [1, 255, 3];
  source.type = '[B';
  jvm.classes[owner] = {
    staticFields: new Map([['source:[B', source]]),
    ast: { classes: [{ superClassName: null, items: [] }] },
  };
  jvm.classInitializationState.set(owner, 'INITIALIZED');

  const computeStackDepths = jvm.jit.computeStackDepths.bind(jvm.jit);
  let rejectOuterHandlerGraph = true;
  jvm.jit.computeStackDepths = (...args) => {
    if (rejectOuterHandlerGraph) {
      rejectOuterHandlerGraph = false;
      return null;
    }
    return computeStackDepths(...args);
  };
  const plans = jvm.jit.compileInlinePrimitiveLoopRegions(method);
  jvm.jit.computeStackDepths = computeStackDepths;
  t.equal(plans.length, 1,
    'an isolated natural loop is retried after the outer depth pass rejects');
  t.ok(plans[0]?.scalarBounded,
    'the region records a runtime scalar trip-count guard');

  const destination = [0, 0, 0];
  destination.type = '[B';
  const frame = new Frame(method);
  frame.className = owner;
  frame.locals.splice(0, 7,
    destination, 0, 0, 3, 0, undefined, { fields: {} });
  const thread = { status: 'runnable', callStack: new Stack() };
  thread.callStack.push(frame);
  t.ok(jvm.jit.canRunInlineLoopRegion(plans[0].id, frame),
    'a bounded three-byte copy passes the runtime guard');
  jvm.jit.runInlineLoopRegion(plans[0].id, frame, thread);
  t.deepEqual(destination.slice(), [1, -1, 3],
    'the generic SSA region preserves byte load/store narrowing');
  t.equal(frame.locals[1], 3,
    'the destination induction local is spilled to the outer method');
  t.equal(frame.locals[2], 3,
    'the source induction local is spilled to the outer method');

  frame.locals[2] = 0;
  frame.locals[3] = 4097;
  t.notOk(jvm.jit.canRunInlineLoopRegion(plans[0].id, frame),
    'an oversized chunk stays on the canonical scheduler path');
  t.end();
});

test('loaded class literals keep arbitrary hot-loop callers synchronous', async (t) => {
  const classpath = compileJavaFixture(t, 'ClassLiteralLoopHarness', `
class ArbitraryLiteralTarget {
  static int initialized;
  static { initialized = 1; }
}
public class ClassLiteralLoopHarness {
  static Class<?> seen;
  static int visit(int count) {
    int value = 0;
    for (int index = 0; index < count; index++) value += index;
    seen = ArbitraryLiteralTarget.class;
    return value;
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0, structuredSsa: false, profileMethods: false,
  } });
  await jvm.loadClassByName('ClassLiteralLoopHarness');
  jvm.classInitializationState.set('ClassLiteralLoopHarness', 'INITIALIZED');
  const thread = {
    id: 0, name: 'class-literal-loop', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;

  t.equal(jvm.getClassObjectSync('ArbitraryLiteralTarget'), null,
    'a genuinely cold literal target requests the normal loading path');
  await invoke(jvm, thread, 'ClassLiteralLoopHarness', 'visit', '(I)I', [8]);
  const method = await jvm.findMethodInHierarchy(
    'ClassLiteralLoopHarness', 'visit', '(I)I');
  const generated = jvm.jit.codegenCache.get(method);
  t.ok(generated?.jvmSynchronous,
    'the class literal no longer makes the complete caller asynchronous');
  const fields = jvm.classes.ClassLiteralLoopHarness.staticFields;
  const classObject = fields.get('seen:Ljava/lang/Class;');
  t.equal(classObject, jvm.getClassObjectSync('ArbitraryLiteralTarget'),
    'cold deopt and loaded synchronous lookup preserve Class identity');
  t.notEqual(
    jvm.classInitializationState.get('ArbitraryLiteralTarget'), 'INITIALIZED',
    'resolving the class literal does not initialize its target');

  fields.set('seen:Ljava/lang/Class;', null);
  await invoke(jvm, thread, 'ClassLiteralLoopHarness', 'visit', '(I)I', [8]);
  t.equal(fields.get('seen:Ljava/lang/Class;'), classObject,
    'the warmed synchronous body reuses the resolved literal');
  t.end();
});

test('structured SSA elides exact array casts and caches hierarchy checks', async (t) => {
  const classpath = compileJavaFixture(t, 'StructuredCastHarness', `
class StructuredCastParent {}
class StructuredCastChild extends StructuredCastParent {}
public class StructuredCastHarness {
  static void copy(Object input, int[] output) {
    for (int i = 0; i < output.length; i++) {
      output[i] = ((int[])input)[i];
    }
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0, structuredSsa: true, profileMethods: false,
  } });
  await jvm.loadClassByName('StructuredCastHarness');
  await jvm.loadClassByName('StructuredCastChild');
  jvm.classInitializationState.set('StructuredCastHarness', 'INITIALIZED');
  const thread = {
    id: 0, name: 'structured-cast', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;

  const input = [3, 5, 8, 13];
  input.type = '[I';
  const output = [0, 0, 0, 0];
  output.type = '[I';
  await invoke(jvm, thread, 'StructuredCastHarness', 'copy',
    '(Ljava/lang/Object;[I)V', [input, output]);
  t.deepEqual(output.slice(), input.slice(), 'the exact array cast preserves results');
  const method = await jvm.findMethodInHierarchy(
    'StructuredCastHarness', 'copy', '(Ljava/lang/Object;[I)V');
  t.ok(jvm.jit.codegenCache.get(method)?.jvmStructuredSsa,
    'the cast loop selects structured SSA');

  const tryCheckCastSourceSync = jvm.jit.tryCheckCastSourceSync;
  let slowCastCalls = 0;
  jvm.jit.tryCheckCastSourceSync = function countedCast(...args) {
    slowCastCalls += 1;
    return tryCheckCastSourceSync.apply(this, args);
  };
  output.fill(0);
  await invoke(jvm, thread, 'StructuredCastHarness', 'copy',
    '(Ljava/lang/Object;[I)V', [input, output]);
  t.deepEqual(output.slice(), input.slice(), 'the warmed exact-cast path stays correct');
  t.equal(slowCastCalls, 0,
    'an exact runtime type match avoids generic cast dispatch inside the loop');

  const isInstanceOfSync = jvm.isInstanceOfSync;
  let hierarchyCalls = 0;
  jvm.isInstanceOfSync = function countedInstanceOf(...args) {
    hierarchyCalls += 1;
    return isInstanceOfSync.apply(this, args);
  };
  t.equal(tryCheckCastSourceSync.call(
    jvm.jit, 'StructuredCastChild', 'StructuredCastParent'), true,
  'a loaded subclass remains assignable');
  const firstHierarchyCalls = hierarchyCalls;
  t.equal(tryCheckCastSourceSync.call(
    jvm.jit, 'StructuredCastChild', 'StructuredCastParent'), true,
  'the cached subclass result remains assignable');
  t.equal(hierarchyCalls, firstHierarchyCalls,
    'definitive hierarchy checks are reused instead of recursively walking again');
  t.throws(
    () => tryCheckCastSourceSync.call(jvm.jit, '[B', '[I'),
    (error) => error && error.type === 'java/lang/ClassCastException',
    'a non-assignable array still throws the exact guest exception',
  );
  t.end();
});

test('Wasm modules expose arbitrary guest identities to native profilers', (t) => {
  const method = { name: 'renamedLoop', descriptor: '([II)V' };
  const name = wasmJitTest.wasmProfilerName('ArbitraryOwner', method);
  const section = wasmJitTest.wasmFunctionNameSection(37, name);
  t.equal(name, 'jvm$wasm$ArbitraryOwner$renamedLoop__II_V',
    'profiler identity comes from the runtime owner and descriptor');
  t.equal(section[0], 0, 'identity is emitted as a standard custom section');
  t.ok(String.fromCharCode(...section).includes(name),
    'function-name subsection contains the generated guest identity');
  t.end();
});

test('sampled generated-method timing attributes arbitrary method identities', (t) => {
  const jvm = new JVM({ jit: {
    warmupThreshold: 0, profileMethods: false, profileTimings: true,
    methodTimingSampleRate: 1,
  } });
  const method = { name: 'renamedRegion', descriptor: '(I)V', attributes: [] };
  const frame = new Frame(method);
  frame.className = 'ArbitraryOwner';
  const generated = () => ({ returned: true });
  generated.jvmSynchronous = true;
  jvm.jit.runGeneratedFrame(generated, frame, { status: 'runnable' }, false);
  const timing = jvm.jit.methodTimingSamples.get('ArbitraryOwner.renamedRegion(I)V');
  t.equal(timing?.samples, 1, 'sample is recorded without enabling method-count profiling');
  t.equal(timing?.tier, 'generated-sync', 'sample retains its generated tier');
  t.ok(timing?.totalMs >= 0, 'sample records monotonic elapsed time');
  t.end();
});

test('unsampled generated-method timing avoids guest identity formatting', (t) => {
  const jvm = new JVM({ jit: {
    warmupThreshold: 0, profileMethods: false, profileTimings: true,
    methodTimingSampleRate: 1_000_000_000,
  } });
  const method = { name: 'unsampledRegion', descriptor: '()V', attributes: [] };
  const frame = new Frame(method);
  frame.className = 'ArbitraryOwner';
  jvm.jit.getFrameClassName = () => {
    throw new Error('unsampled entry formatted a guest identity');
  };
  const generated = () => ({ returned: true });
  generated.jvmSynchronous = true;
  t.doesNotThrow(() =>
    jvm.jit.runGeneratedFrame(generated, frame, { status: 'runnable' }, false),
  'an unsampled entry executes without allocating its method key');
  t.equal(jvm.jit.methodTimingSamples.size, 0,
    'the unsampled entry records no timing row');
  t.end();
});

test('method-entry tracing remains inactive until a target identity is configured', (t) => {
  const jvm = new JVM({ jit: {
    warmupThreshold: 0, profileMethods: false, profileTimings: false,
  } });
  const method = { name: 'arbitraryEntry', descriptor: '()V', attributes: [] };
  const frame = new Frame(method);
  frame.className = 'ArbitraryOwner';
  const generated = () => ({ returned: true });
  generated.jvmSynchronous = true;
  let saveStateCalls = 0;
  jvm.saveState = () => {
    saveStateCalls += 1;
    return { format: 'test-state' };
  };

  jvm.jit.runGeneratedFrame(generated, frame, { status: 'runnable' }, false);
  t.equal(jvm.jit.methodEntryTrace, null,
    'an unset trace target does not capture the first generated method');
  t.equal(saveStateCalls, 0, 'an unset target does not serialize JVM state');

  jvm.jit.methodEntryTraceKey = 'ArbitraryOwner.arbitraryEntry()V';
  jvm.jit.runGeneratedFrame(generated, frame, { status: 'runnable' }, false);
  t.equal(jvm.jit.methodEntryTrace?.methodKey,
    'ArbitraryOwner.arbitraryEntry()V',
    'the configured arbitrary identity is captured at bytecode entry');
  t.equal(saveStateCalls, 1, 'the matching target serializes state exactly once');
  t.end();
});

test('generated bodies expose profiler identities without runtime probes', (t) => {
  const jvm = new JVM({ jit: { profileMethods: false } });
  const method = { name: 'renamedHotBody', descriptor: '([II)V' };
  const labeled = jvm.jit.generatedSource(method, 'structured-ssa',
    '"use strict"; return 7;', 'ArbitraryOwner');
  t.equal(labeled.url,
    'jvm-generated://ArbitraryOwner/renamedHotBody(%5BII)V?tier=structured-ssa',
  'source identity is derived from the arbitrary owner, descriptor, and tier');
  t.ok(labeled.source.endsWith(`//# sourceURL=${labeled.url}`),
    'the label is static source metadata rather than a hot-path timing call');
  const generated = jvm.jit.createGeneratedFunction(method, 'structured-ssa', [],
    '"use strict"; return 7;', 'ArbitraryOwner');
  t.equal(generated.name, 'jvm$structured_ssa$ArbitraryOwner$renamedHotBody__II_V',
    'generated function name is visible to native stack sampling');
  t.equal(generated(), 7, 'the profiler label does not change generated behavior');
  const captured = jvm.jit.createGeneratedFunction(method, 'structured-ssa',
    ['value'], '"use strict"; return addend + value;', 'ArbitraryOwner',
    false, false, { addend: 5 });
  t.equal(captured(7), 12,
    'generated helpers can capture a compile-time monomorphic dependency');
  t.notOk(String(captured).includes('function anonymous'),
    'captured helpers retain the profiler-visible generated function name');
  t.end();
});

test('exclusive region timing subtracts nested generated and fused time', (t) => {
  const jvm = new JVM({ jit: { profileMethods: false } });
  const jit = jvm.jit;
  jit.exclusiveTimingsEnabled = true;
  jit.exclusiveTimingRootKey = 'ArbitraryRoot.work()V';
  const unrelatedFrame = new Frame({
    name: 'work', descriptor: '()V', attributes: [],
  });
  unrelatedFrame.className = 'Unrelated';
  t.notOk(jit.matchesExclusiveTimingRoot(unrelatedFrame),
    'an unrelated generated entry is rejected without starting a clock');
  t.notOk(jit.shouldBeginExclusiveTimingKey('Unrelated.work()V'),
    'a positional entry outside the selected root is rejected');
  t.ok(jit.shouldBeginExclusiveTimingKey('ArbitraryRoot.work()V'),
    'the selected positional root is admitted');
  const times = [0, 2, 5, 9];
  jit.monotonicNow = () => times.shift();
  t.equal(jit.beginExclusiveTiming('Unrelated.work()V', 'generated-sync'), null,
    'root filter ignores unrelated outer regions');
  const outer = jit.beginExclusiveTiming('ArbitraryRoot.work()V', 'generated-sync');
  const child = jit.beginExclusiveTiming('RenamedChild.draw()V', 'fused-gradient');
  jit.endExclusiveTiming(child);
  jit.endExclusiveTiming(outer);
  t.equal(jit.exclusiveTimingSamples.get('ArbitraryRoot.work()V').totalMs, 6,
    'outer time excludes the nested interval');
  t.equal(jit.exclusiveTimingSamples.get('RenamedChild.draw()V').totalMs, 3,
    'nested region owns its complete interval');
  t.equal([...jit.exclusiveTimingSamples.values()].reduce((sum, value) =>
    sum + value.totalMs, 0), 9, 'exclusive totals do not overlap');
  t.equal(jit.exclusiveTimingEdges.get(
    'ArbitraryRoot.work()V\0RenamedChild.draw()V').totalMs, 3,
  'parent-child edge records nested inclusive time');
  t.end();
});

test('generated JIT supports generic long fixed-point multiply and shift helpers', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0, profileMethods: false } });
  const instructions = [
    'iload_0', 'i2l', 'iload_1', 'i2l', 'lmul', 'iload_2', 'lshr', 'l2i', 'ireturn',
  ];
  const method = {
    name: 'arbitraryFixedPoint', descriptor: '(III)I', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: instructions.map((instruction, index) => ({
        labelDef: `L${index}:`, instruction,
      })),
      localsSize: '3', stackSize: '3', exceptionTable: [],
    } }],
  };
  t.ok(jvm.jit.isSupported(method) && jvm.jit.isCodegenSupported(method),
    'long arithmetic capability is selected by opcode structure');
  const generated = jvm.jit.getGeneratedFunction(method);
  const frame = new Frame(method);
  frame.className = 'RenamedFixedPointOwner';
  frame.locals.splice(0, 3, 2147483647, -2147483648, 71);
  const thread = { status: 'runnable', callStack: new Stack() };
  const caller = new Frame({ name: 'caller', descriptor: '()V', attributes: [] });
  thread.callStack.push(caller);
  thread.callStack.push(frame);
  const result = generated(frame, thread, jvm.jit, false);
  const product = BigInt.asIntN(64, 2147483647n * -2147483648n);
  const expected = Number(BigInt.asIntN(32, product >> 7n));
  t.equal(result.value, expected,
    'lmul, masked arithmetic lshr, and l2i preserve Java fixed-point semantics');
  t.end();
});

test('structured SSA supports generic long fixed-point arithmetic', (t) => {
  const jvm = new JVM({ jit: {
    warmupThreshold: 0, profileMethods: false, structuredSsa: true,
  } });
  const instructions = [
    'iload_0', 'i2l', 'iload_1', 'i2l', 'lmul',
    'iload_2', 'lshr', 'l2i', 'ireturn',
  ];
  const method = {
    name: 'arbitraryStructuredFixedPoint', descriptor: '(III)I', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: instructions.map((instruction, index) => ({
        labelDef: `L${index}:`, instruction,
      })),
      localsSize: '3', stackSize: '3', exceptionTable: [],
    } }],
  };
  const generated = jvm.jit.getGeneratedFunction(method);
  t.ok(generated.jvmStructuredSsa,
    'long capability is admitted by opcode semantics rather than a method identity');
  t.ok(generated.jvmStructuredSource.includes('BigInt'),
    'a runtime-variable long shift retains the general exact long lowering');
  for (const [left, right, shift] of [
    [2147483647, -2147483648, 7], [-129, 257, 3], [0, -1, 63],
  ]) {
    const frame = new Frame(method);
    frame.className = 'RenamedStructuredFixedPointOwner';
    frame.locals.splice(0, 3, left, right, shift);
    const thread = { status: 'runnable', callStack: new Stack() };
    thread.callStack.push(frame);
    const result = generated(frame, thread, jvm.jit, false);
    const product = BigInt.asIntN(64, BigInt(left) * BigInt(right));
    const expected = Number(BigInt.asIntN(32,
      product >> (BigInt(shift) & 63n)));
    t.equal(result.value, expected,
      `structured long arithmetic preserves ${left} * ${right} >> ${shift}`);
  }
  const gatedJvm = new JVM({ jit: {
    warmupThreshold: 0, profileMethods: false, structuredSsa: true,
    structuredLongOpcodes: false,
  } });
  const gated = gatedJvm.jit.getGeneratedFunction(method);
  t.notOk(gated?.jvmStructuredSsa,
    'the comparison gate retains the prior non-SSA tier');
  t.end();
});

test('structured SSA exactly scalarizes constant-16 fixed-point products', (t) => {
  const jvm = new JVM({ jit: {
    warmupThreshold: 0, profileMethods: false, structuredSsa: true,
  } });
  const instructions = [
    'iload_0', 'i2l', 'iload_1', 'i2l', 'lmul',
    {op: 'bipush', arg: 16}, 'lshr', 'l2i', 'ireturn',
  ];
  const method = {
    name: 'renamedQ16Product', descriptor: '(II)I', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: instructions.map((instruction, index) => ({
        labelDef: `L${index}:`, instruction,
      })),
      localsSize: '2', stackSize: '4', exceptionTable: [],
    } }],
  };
  const generated = jvm.jit.getGeneratedFunction(method);
  t.ok(generated.jvmStructuredSsa,
    'the optimization is selected from the typed bytecode graph');
  t.ok(generated.jvmStructuredSource.includes('Math.imul'),
    'the fixed-point graph lowers to scalar integer multiplication');
  t.notOk(generated.jvmStructuredSource.includes('BigInt'),
    'the proven graph emits no runtime BigInt operations');
  t.equal(generated.jvmStructuredFixedPointScalarizationCount, 1,
    'the generated metadata reports one typed fixed-point graph');

  const comparisonJvm = new JVM({ jit: {
    warmupThreshold: 0, profileMethods: false, structuredSsa: true,
    structuredFixedPointScalarization: false,
  } });
  const comparison = comparisonJvm.jit.getGeneratedFunction(method);
  t.ok(comparison.jvmStructuredSource.includes('BigInt'),
    'the comparison gate retains the general Java-long implementation');

  const cases = [
    [0, 0], [1, 1], [-1, 1], [-1, -1],
    [2147483647, 2147483647],
    [2147483647, -2147483648],
    [-2147483648, -2147483648],
    [0x12345678, -0x7654321],
  ];
  let state = 0x6d2b79f5;
  for (let index = 0; index < 512; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    const left = state;
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    cases.push([left, state]);
  }
  const thread = { status: 'runnable', callStack: new Stack() };
  for (const [left, right] of cases) {
    const frame = new Frame(method);
    frame.className = 'ArbitraryFixedPointOwner';
    frame.locals.splice(0, 2, left, right);
    thread.callStack.push(frame);
    const result = generated(frame, thread, jvm.jit, false);
    thread.callStack.clear();
    const expected = Number(BigInt.asIntN(32,
      (BigInt(left) * BigInt(right)) >> 16n));
    t.equal(result.value, expected,
      `scalar fixed-point result is exact for ${left} * ${right}`);
  }
  t.end();
});

test('structured SSA reuses block-local primitive array data views', async (t) => {
  const className = 'BlockArrayDataViewHarness';
  const classpath = compileJavaFixture(t, className, `
public final class BlockArrayDataViewHarness {
  static float sample(Object source, int index) {
    float[] values = (float[]) source;
    return values[index] + values[index + 1] +
        values[index + 2] + values[index + 3];
  }
}
`);
  const jvm = new JVM({classpath, jit: {
    warmupThreshold: 0, structuredSsa: true, profileMethods: false,
    structuredBlockArrayDataViews: true,
  }});
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className, 'sample', '(Ljava/lang/Object;I)F');
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated?.jvmStructuredSsa,
    'the optimization is selected from primitive array bytecodes');
  t.equal(generated.jvmStructuredBlockArrayDataViewCount, 1,
    'four loads from one local array share one raw-storage snapshot');
  t.equal((generated.jvmStructuredSource.match(/\.elements \?/g) || []).length,
    0, 'the normal path contains no repeated array-representation branches');

  const run = (source, index) => {
    const frame = new Frame(method);
    frame.className = className;
    frame.locals.splice(0, 2, source, index);
    const thread = {
      status: 'runnable', pendingException: null, callStack: new Stack(),
    };
    thread.callStack.push(frame);
    let result = null;
    let error = null;
    try {
      result = generated(frame, thread, jvm.jit, false);
    } catch (thrown) {
      error = thrown;
    }
    return {frame, result, error};
  };
  const values = [1.25, 2.5, 3.75, 4.5];
  values.type = '[F';
  const valid = run(values, 0);
  t.equal(valid.error, null, 'the shared view executes normally');
  t.equal(valid.result?.value, Math.fround(12),
    'reused storage preserves float32 arithmetic');

  const short = [1.25, 2.5];
  short.type = '[F';
  const bounds = run(short, 0);
  const loadPcs = jvm.jit.getCodeItems(method)
    .map((item, pc) => ({op: item.instruction?.op || item.instruction, pc}))
    .filter(({op}) => op === 'faload').map(({pc}) => pc);
  t.equal(bounds.error?.type, 'java/lang/ArrayIndexOutOfBoundsException',
    'the dynamic view retains Java bounds failures');
  t.equal(bounds.frame.pc, loadPcs[2],
    'the third load records its exact throwing bytecode PC');
  const missing = run(null, 0);
  t.equal(missing.error?.type, 'java/lang/NullPointerException',
    'the dynamic view retains Java null failures');
  t.equal(missing.frame.pc, loadPcs[0],
    'the first null load records its exact bytecode PC');

  const gatedJvm = new JVM({classpath, jit: {
    warmupThreshold: 0, structuredSsa: true, profileMethods: false,
    structuredBlockArrayDataViews: false,
  }});
  await gatedJvm.loadClassByName(className);
  const gatedMethod = await gatedJvm.findMethodInHierarchy(
    className, 'sample', '(Ljava/lang/Object;I)F');
  const gated = gatedJvm.jit.structuredSsa.compile(gatedMethod);
  t.equal(gated.jvmStructuredBlockArrayDataViewCount, 0,
    'the comparison gate retains representation checks per access');
  t.ok((gated.jvmStructuredSource.match(/\.elements \?/g) || []).length >= 4,
    'the comparison source exposes the former repeated hot-path branches');
  t.end();
});

test('structured SSA normalizes descriptor scalar locals at entry', (t) => {
  const jvm = new JVM({ jit: {
    warmupThreshold: 0, profileMethods: false, structuredSsa: true,
  } });
  const method = {
    name: 'descriptorNormalizedByte', descriptor: '(B)I', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: [
        { instruction: {op: 'bipush', arg: 47} },
        { instruction: 'iload_0' },
        { instruction: 'isub' },
        { instruction: 'ireturn' },
      ],
      localsSize: '1', stackSize: '2', exceptionTable: [],
    } }],
  };
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated?.jvmStructuredSsa,
    'the arbitrary byte-scalar body selects structured SSA');
  const frame = new Frame(method);
  frame.locals[0] = 5n;
  const thread = {status: 'runnable', callStack: new Stack()};
  thread.callStack.push(frame);
  t.equal(generated(frame, thread, jvm.jit, false).value, 42,
    'descriptor normalization prevents host BigInt/Number type leakage');
  t.end();
});

test('structured SSA renders verified lookup switches', (t) => {
  const jvm = new JVM({ jit: {
    warmupThreshold: 0, profileMethods: false, structuredSsa: true,
  } });
  const method = {
    name: 'arbitrarySwitch', descriptor: '(I)I', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: [
        {labelDef: 'L0:', instruction: 'iload_0'},
        {labelDef: 'L1:', instruction: 'iconst_0'},
        {labelDef: 'L2:', instruction: 'iadd'},
        {labelDef: 'L3:', instruction: {op: 'lookupswitch', arg: {
          pairs: [[1, 'L4'], [5, 'L6']], defaultLabel: 'L8',
        }}},
        {labelDef: 'L4:', instruction: {op: 'bipush', arg: '10'}},
        {labelDef: 'L5:', instruction: 'ireturn'},
        {labelDef: 'L6:', instruction: {op: 'bipush', arg: '20'}},
        {labelDef: 'L7:', instruction: 'ireturn'},
        {labelDef: 'L8:', instruction: 'iconst_m1'},
        {labelDef: 'L9:', instruction: 'ireturn'},
      ],
      localsSize: '1', stackSize: '1', exceptionTable: [],
    } }],
  };
  const generated = jvm.jit.getGeneratedFunction(method);
  t.ok(generated.jvmStructuredSsa,
    'switch CFG structure, not a method identity, selects the SSA renderer');
  for (const [selector, expected] of [[1, 10], [5, 20], [0, -1]]) {
    const frame = new Frame(method);
    frame.className = 'RenamedSwitchOwner';
    frame.locals[0] = selector;
    const thread = {status: 'runnable', callStack: new Stack()};
    thread.callStack.push(frame);
    t.equal(generated(frame, thread, jvm.jit, false).value, expected,
      `lookup selector ${selector} takes the verified target`);
  }
  const gatedJvm = new JVM({ jit: {
    warmupThreshold: 0, profileMethods: false, structuredSsa: true,
    structuredSwitches: false,
  } });
  const gated = gatedJvm.jit.getGeneratedFunction(method);
  t.notOk(gated?.jvmStructuredSsa,
    'the comparison gate retains the prior non-SSA tier');
  const baseline = gatedJvm.jit.compileBaselineMethod(method);
  t.ok(baseline, 'the continuation fallback compiles the lookup switch');
  for (const [selector, expected] of [[1, 10], [5, 20], [0, -1]]) {
    const frame = new Frame(method);
    frame.locals[0] = selector;
    const thread = {status: 'runnable', callStack: new Stack()};
    thread.callStack.push(frame);
    t.equal(baseline(frame, thread, gatedJvm.jit, false).value, expected,
      `legacy generated lookup selector ${selector} preserves its target`);
  }
  t.end();
});

test('structured SSA renders verified table switches', (t) => {
  const jvm = new JVM({ jit: {
    warmupThreshold: 0, profileMethods: false, structuredSsa: true,
  } });
  const method = {
    name: 'arbitraryDenseSwitch', descriptor: '(I)I', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: [
        {labelDef: 'L0:', instruction: 'iload_0'},
        {labelDef: 'L1:', instruction: 'iconst_0'},
        {labelDef: 'L2:', instruction: 'iadd'},
        {labelDef: 'L3:', instruction: {op: 'tableswitch', low: 3,
          labels: ['L4', 'L6'], defaultLbl: 'L8'}},
        {labelDef: 'L4:', instruction: {op: 'bipush', arg: '30'}},
        {labelDef: 'L5:', instruction: 'ireturn'},
        {labelDef: 'L6:', instruction: {op: 'bipush', arg: '40'}},
        {labelDef: 'L7:', instruction: 'ireturn'},
        {labelDef: 'L8:', instruction: 'iconst_m1'},
        {labelDef: 'L9:', instruction: 'ireturn'},
      ],
      localsSize: '1', stackSize: '1', exceptionTable: [],
    } }],
  };
  const generated = jvm.jit.getGeneratedFunction(method);
  t.ok(generated.jvmStructuredSsa,
    'dense switch CFG structure selects the SSA renderer');
  for (const [selector, expected] of [[3, 30], [4, 40], [2, -1]]) {
    const frame = new Frame(method);
    frame.className = 'RenamedDenseSwitchOwner';
    frame.locals[0] = selector;
    const thread = {status: 'runnable', callStack: new Stack()};
    thread.callStack.push(frame);
    t.equal(generated(frame, thread, jvm.jit, false).value, expected,
      `table selector ${selector} takes the verified target`);
  }
  t.end();
});

test('unsafe constructor loop admission is structured-only', (t) => {
  const method = {
    name: 'arbitraryAllocatingArrayLoop', descriptor: '([I)V', flags: ['static'],
    attributes: [{type: 'code', code: {
      codeItems: [
        'iconst_0', 'istore_1', 'iload_1', 'aload_0', 'arraylength',
        {op: 'if_icmpge', arg: 'L16'},
        'aload_0', 'iload_1', 'iaload', 'pop',
        {op: 'new', arg: 'ArbitraryAllocation'}, 'dup',
        {op: 'invokespecial', arg: ['Method', 'ArbitraryAllocation',
          ['<init>', '()V']]}, 'pop',
        {op: 'iinc', varnum: '1', incr: '1'}, {op: 'goto', arg: 'L2'},
        'return',
      ].map((instruction, index) => ({labelDef: `L${index}:`, instruction})),
      localsSize: '2', stackSize: '2', exceptionTable: [],
    }}],
  };
  const jvm = new JVM({jit: {
    structuredSsa: true, structuredUnsafeConstructorCallers: true,
  }});
  jvm.jit.hasOnlyJitSafeInitializationCalls = () => false;
  t.ok(jvm.jit.isCodegenSupported(method, true),
    'a generic hot array loop may reach adaptive structured verification');
  t.ok(jvm.jit.structuredOnlyCodegenMethods.has(method),
    'unsafe constructor replay excludes every less precise JS tier');
  const originalCompile = jvm.jit.structuredSsa.compile;
  jvm.jit.structuredSsa.compile = () => null;
  t.equal(jvm.jit.compileMethod(method), null,
    'failed structured verification cannot fall through to baseline codegen');
  let baselineCompiles = 0;
  jvm.jit.structuredSsa.compile = () => ({
    jvmStructuredSsa: true,
    jvmStructuredRequiresBaselineFramedEntry: true,
  });
  const originalBaselineCompile = jvm.jit.compileBaselineMethod;
  jvm.jit.compileBaselineMethod = () => {
    baselineCompiles += 1;
    return () => undefined;
  };
  t.equal(jvm.jit.compileMethod(method), null,
    'a structured-only caller rejects an unsafe baseline Frame entry');
  t.equal(baselineCompiles, 0,
    'tier selection never compiles the replay-prone baseline body');
  const structuredEntry = () => ({ returned: true, value: undefined });
  structuredEntry.jvmStructuredSsa = true;
  structuredEntry.jvmSynchronous = true;
  jvm.jit.structuredSsa.compile = () => structuredEntry;
  const selected = jvm.jit.compileMethod(method);
  t.ok(selected?.jvmStructuredSsa,
    'a safe structured entry remains in the verified structured tier');
  jvm.jit.compileBaselineMethod = originalBaselineCompile;
  jvm.jit.structuredSsa.compile = originalCompile;

  const gatedJvm = new JVM({jit: {
    structuredSsa: true, structuredUnsafeConstructorCallers: false,
  }});
  gatedJvm.jit.hasOnlyJitSafeInitializationCalls = () => false;
  t.notOk(gatedJvm.jit.isCodegenSupported(method, true),
    'the comparison gate retains conservative constructor admission');
  t.end();
});

test('structured-only admission covers reader construction before array loops',
  async (t) => {
  const classpath = compileJavaFixture(t, 'ConstructedReaderLoopHarness', `
public final class ConstructedReaderLoopHarness {
  static final class Reader {
    final byte[] bytes;
    int position;

    Reader(byte[] bytes) {
      this.bytes = normalize(bytes);
    }

    private static byte[] normalize(byte[] bytes) {
      return bytes;
    }

    synchronized int read() {
      return bytes[position++] & 255;
    }
  }

  static int decode(byte[] bytes, int[] output) {
    Reader reader = new Reader(bytes);
    int sum = 0;
    try {
      for (int index = 0; index < output.length; index++) {
        int value = reader.read();
        output[index] = value;
        sum += value;
      }
      return sum;
    } catch (ArrayIndexOutOfBoundsException error) {
      output[0] = -7;
      return -1;
    }
  }

  static int repeat(byte[] bytes, int[] output, int passes) {
    int result = 0;
    for (int pass = 0; pass < passes; pass++) result += decode(bytes, output);
    return result;
  }
}
`);
  const jvm = new JVM({
    classpath,
    jit: {
      warmupThreshold: 0,
      preferWholeMethodJs: true,
      structuredSsa: true,
      structuredUnsafeConstructorCallers: true,
      compiledCallChains: true,
      profileMethods: false,
    },
  });
  jvm.jit.wasmJit.enabled = false;
  await jvm.loadClassByName('ConstructedReaderLoopHarness');
  await jvm.loadClassByName('ConstructedReaderLoopHarness$Reader');
  const method = await jvm.findMethodInHierarchy(
    'ConstructedReaderLoopHarness', 'decode', '([B[I)I');

  t.ok(jvm.jit.isCodegenSupported(method, true),
    'an unsafe reader constructed before a verified primitive-array loop is admitted');
  t.ok(jvm.jit.structuredOnlyCodegenMethods.has(method),
    'the broader shape cannot fall through to replay-prone baseline codegen');
  jvm.jit.promoteAdaptiveCodegen(method);
  const generated = jvm.jit.getGeneratedFunction(method);
  t.ok(generated?.jvmStructuredSsa,
    'the complete caller passes structured CFG and continuation verification: ' +
      jvm.jit.structuredSsa.lastRejectionReason);
  t.ok(generated.jvmCompiledCallChain &&
      typeof generated.jvmAdaptivePositionalBody === 'function',
    'the verified non-recursive caller publishes a persistent compiled-chain entry');

  const thread = {
    id: 0, name: 'constructed-reader-loop', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const bytes = jvm.jit.newPrimitiveArray(4, 'byte');
  bytes[0] = 3;
  bytes[1] = 5;
  bytes[2] = 7;
  bytes[3] = 11;
  const output = jvm.jit.newPrimitiveArray(4, 'int');
  await invoke(jvm, thread, 'ConstructedReaderLoopHarness',
    'decode', '([B[I)I', [bytes, output]);
  t.deepEqual(Array.from(output), [3, 5, 7, 11],
    'generated normal flow writes every decoded value exactly once');

  await invoke(jvm, thread, 'ConstructedReaderLoopHarness',
    'repeat', '([B[II)I', [bytes, output, 8]);

  const shortBytes = jvm.jit.newPrimitiveArray(1, 'byte');
  shortBytes[0] = 9;
  const exceptionalOutput = jvm.jit.newPrimitiveArray(2, 'int');
  await invoke(jvm, thread,
    'ConstructedReaderLoopHarness', 'repeat', '([B[II)I',
    [shortBytes, exceptionalOutput, 8]);
  t.deepEqual(Array.from(exceptionalOutput), [-7, 0],
    'a child bounds failure resumes the original guest handler precisely');
  t.end();
});

test('generated JIT admits call-free post-increment field helpers structurally', (t) => {
  const field = ['Field', 'ArbitraryCounter', ['value', 'I']];
  const method = {
    name: 'unrelatedPostIncrement', descriptor: '()I',
    attributes: [{ type: 'code', code: {
      codeItems: [
        'aload_0', 'aload_0', { op: 'getfield', arg: field }, 'dup_x1',
        'iconst_1', 'iadd', { op: 'putfield', arg: field }, 'ireturn',
      ].map((instruction, index) => ({ labelDef: `L${index}:`, instruction })),
      localsSize: '1', stackSize: '3', exceptionTable: [],
    } }],
  };
  const jvm = new JVM({ jit: { warmupThreshold: 0, profileMethods: false } });
  jvm.classes.ArbitraryCounter = {
    staticFields: new Map(),
    ast: { classes: [{ superClassName: null, items: [] }] },
  };
  jvm.classInitializationState.set('ArbitraryCounter', 'INITIALIZED');
  t.ok(jvm.jit.isSupported(method) && jvm.jit.isCodegenSupported(method),
    'dup_x1 helper is selected by supported bytecode and compute shape');
  const generated = jvm.jit.getGeneratedFunction(method);
  const object = { type: 'ArbitraryCounter', fields: { 'ArbitraryCounter.value': 41 } };
  const frame = new Frame(method);
  frame.className = 'ArbitraryCounter';
  frame.locals[0] = object;
  const stack = new Stack();
  stack.push(frame);
  const result = generated(frame, { status: 'runnable', callStack: stack }, jvm.jit, false);
  t.deepEqual(result, { returned: true, value: 41 },
    'post-increment returns the value that preceded the field write');
  t.equal(object.fields['ArbitraryCounter.value'], 42,
    'post-increment stores the incremented value');

  const alternateObject = {
    type: 'ArbitraryCounter',
    fields: { 'LegacyCounter.value': 9 },
  };
  const alternateFrame = new Frame(method);
  alternateFrame.className = 'ArbitraryCounter';
  alternateFrame.locals[0] = alternateObject;
  const alternateStack = new Stack();
  alternateStack.push(alternateFrame);
  const alternateResult = generated(
    alternateFrame,
    { status: 'runnable', callStack: alternateStack },
    jvm.jit,
    false,
  );
  t.equal(alternateResult.value, 9,
    'generated putfield reads an alternate owner-qualified slot');
  t.equal(alternateObject.fields['LegacyCounter.value'], 10,
    'generated putfield updates the resolved alternate slot');
  t.notOk(Object.prototype.hasOwnProperty.call(
    alternateObject.fields, 'ArbitraryCounter.value'),
  'generated putfield does not invent the direct slot on unusual objects');

  const disabled = new JVM({ jit: {
    warmupThreshold: 0, profileMethods: false, postIncrementHelpers: false,
  } });
  t.notOk(disabled.jit.isSupported(method),
    'the differential control restores the previous interpreter selection');
  t.end();
});

test('initialized static fields stay on the synchronous generated fast path', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0 } });
  jvm.classes.FastStatics = {
    staticFields: new Map([['value:I', 41]]),
    ast: { classes: [{ superClassName: null }] },
  };
  jvm.classInitializationState.set('FastStatics', 'INITIALIZED');
  const field = [null, 'FastStatics', ['value', 'I']];
  const value = jvm.jit.getStatic(field, {});

  t.equal(value, 41, 'warm getstatic returns its value directly');
  t.notOk(value && typeof value.then === 'function', 'warm getstatic creates no Promise');
  const changed = jvm.jit.putStatic(field, 42, {});
  t.equal(changed, true, 'warm putstatic completes synchronously');
  t.equal(jvm.classes.FastStatics.staticFields.get('value:I'), 42,
    'warm putstatic updates the field');
  t.end();
});

test('resolved class initialization uses stable hot-site tokens', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0 } });
  jvm.classes.ArbitraryStaticOwner = {
    ast: { classes: [{ superClassName: null, items: [] }] },
    staticFields: new Map([['value:I', 37]]),
  };
  jvm.classInitializationState.set('ArbitraryStaticOwner', 'INITIALIZED');
  const site = jvm.jit.registerFieldSite(
    ['Field', 'ArbitraryStaticOwner', ['value', 'I']]);
  let stateLookups = 0;
  const originalGet = jvm.classInitializationState.get;
  jvm.classInitializationState.get = function countedGet(...args) {
    stateLookups += 1;
    return originalGet.apply(this, args);
  };
  for (let iteration = 0; iteration < 100; iteration += 1) {
    t.equal(jvm.jit.getStaticSyncAt(site), 37,
      'resolved static access retains the current value');
  }
  t.equal(stateLookups, 0,
    'warm static accesses do not repeat class-state Map lookups');
  jvm.classInitializationState.set('ArbitraryStaticOwner', 'UNINITIALIZED');
  t.equal(jvm.jit.getStaticSyncAt(site), jvm.jit.staticDeopt(),
    'an observed lifecycle change invalidates the stable token');
  jvm.classInitializationState.set('ArbitraryStaticOwner', 'INITIALIZED');
  t.equal(jvm.jit.getStaticSyncAt(site), 37,
    'the same token resumes after initialization is published');
  t.end();
});

test('interpreted warm getstatic sites reuse class-initialization tokens', (t) => {
  const jvm = new JVM({ jit: { enabled: false } });
  jvm.classes.ArbitraryStaticOwner = {
    ast: { classes: [{ superClassName: null, items: [] }] },
    staticFields: new Map([['value:I', 19]]),
  };
  jvm.classInitializationState.set('ArbitraryStaticOwner', 'INITIALIZED');
  const instruction = { op: 'getstatic',
    arg: ['Field', 'ArbitraryStaticOwner', ['value', 'I']] };
  const frame = { stack: new Stack() };
  const thread = { id: 7 };
  let stateLookups = 0;
  const originalGet = jvm.classInitializationState.get;
  jvm.classInitializationState.get = function countedGet(...args) {
    stateLookups += 1;
    return originalGet.apply(this, args);
  };
  for (let iteration = 0; iteration < 100; iteration += 1) {
    objectHandlers.getstaticSync(frame, instruction, jvm, thread);
    t.equal(frame.stack.pop(), 19, 'warm interpreted static read stays exact');
  }
  t.equal(stateLookups, 1,
    'the interpreted site resolves initialization state only once');
  jvm.classInitializationState.set('ArbitraryStaticOwner', 'ERRONEOUS');
  t.equal(objectHandlers.getstaticSync(frame, instruction, jvm, thread),
    objectHandlers.SYNC_STATIC_FALLBACK,
  'the stable token observes lifecycle changes without another map lookup');
  t.end();
});

test('generated call sites execute proven synchronous JRE leaves directly', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0 } });
  const instruction = {
    op: 'invokevirtual',
    arg: ['Method', 'java/lang/String', ['charAt', '(I)C']],
  };
  const siteId = jvm.jit.registerSyncCallSite('invokevirtual', instruction);
  const method = {
    name: 'arbitraryCaller', descriptor: '(Ljava/lang/String;I)C',
    attributes: [{ type: 'code', code: {
      codeItems: [], exceptionTable: [], localsSize: '2', stackSize: '2',
    } }],
  };
  const frame = new Frame(method);
  const thread = { status: 'runnable', callStack: new Stack() };
  const value = jvm.internString('abc');
  frame.stack.items.push(value, 1);
  t.equal(jvm.jit.tryInvokeSyncAt(siteId, frame, thread), 'b'.charCodeAt(0),
    'ordinary non-async JRE method returns in the generated caller');
  t.equal(frame.stack.items.length, 0, 'direct JRE call consumes receiver and arguments');
  t.ok(jvm.jit.syncCallSites[siteId].fastJreTarget,
    'monomorphic JRE target is retained at the call site');

  const secondSiteId = jvm.jit.registerSyncCallSite(
    'invokevirtual', instruction);
  frame.stack.items.push(value, 2);
  t.equal(jvm.jit.tryInvokeSyncAt(secondSiteId, frame, thread),
    'c'.charCodeAt(0),
  'another call site preserves the same positional JRE behavior');
  t.equal(jvm.jit.positionalJreTemplateCompileCount, 1,
    'one resolved JRE ABI shape compiles one positional template');
  t.equal(jvm.jit.positionalJreTemplateReuseCount, 1,
    'another call site reuses the parsed positional template');

  frame.stack.items.push(value, 99);
  let thrown;
  try { jvm.jit.tryInvokeSyncAt(siteId, frame, thread); } catch (error) { thrown = error; }
  t.equal(thrown?.type, 'java/lang/StringIndexOutOfBoundsException',
    'direct JRE call preserves its declared Java exception');
  t.deepEqual(frame.stack.items, [value, 99],
    'throwing direct JRE call retains operands for caller-frame reconstruction');

  t.equal(jvm.jit.resolveSynchronousJreMethod(
    'javax/sound/sampled/SourceDataLine', 'javax/sound/sampled/SourceDataLine',
    'drain', '()V'), null,
  'declared async JRE methods retain the canonical scheduler path');
  t.end();
});

test('generated call sites share resolved positional ABI templates', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0 } });
  const method = {
    name: 'compute', descriptor: '(I)I', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: [], exceptionTable: [], localsSize: '1', stackSize: '1',
    } }],
  };
  const generated = () => ({ returned: true, value: 0 });
  generated.jvmSynchronous = true;
  const site = {
    op: 'invokestatic', params: ['int'], returnType: 'int',
    descriptor: '(I)I', initializationToken: { initialized: true },
  };
  const first = jvm.jit.getPositionalGeneratedInvoker(site, {
    method, lookupClass: 'ArbitraryOwner', generated,
  });
  const second = jvm.jit.getPositionalGeneratedInvoker(site, {
    method, lookupClass: 'ArbitraryOwner', generated,
  });
  t.equal(typeof first, 'function',
    'the first resolved generated target publishes its positional ABI');
  t.equal(typeof second, 'function',
    'another call site publishes the same ABI');
  t.equal(jvm.jit.positionalGeneratedTemplateCompileCount, 1,
    'the shared method and ABI parse one adapter template');
  t.equal(jvm.jit.positionalGeneratedTemplateReuseCount, 1,
    'the second target binds the existing parsed template');
  t.end();
});

test('legacy synchronous probes retain their resolved call site', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0 } });
  const instruction = {
    op: 'invokevirtual',
    arg: ['Method', 'java/lang/String', ['charAt', '(I)C']],
  };
  const method = {
    name: 'caller', descriptor: '()V',
    attributes: [{ type: 'code', code: {
      codeItems: [], exceptionTable: [], localsSize: '0', stackSize: '2',
    } }],
  };
  const frame = new Frame(method);
  const thread = { status: 'runnable', callStack: new Stack() };
  const value = jvm.internString('abc');
  frame.stack.items.push(value, 0);
  t.equal(jvm.jit.tryInvokeSync(
    'invokevirtual', frame, instruction, thread), 'a'.charCodeAt(0),
  'the first legacy probe resolves normally');
  frame.stack.items.push(value, 2);
  t.equal(jvm.jit.tryInvokeSync(
    'invokevirtual', frame, instruction, thread), 'c'.charCodeAt(0),
  'the warmed legacy probe preserves behavior');
  t.equal(jvm.jit.positionalJreTemplateCompileCount, 1,
    'the legacy path compiles one adapter');
  t.equal(jvm.jit.positionalJreTemplateReuseCount, 0,
    'the warmed path reuses its bound target without rebinding');
  t.equal(jvm.jit.legacySyncCallSites.size, 1,
    'the cache is scoped to the JVM and symbolic call identity');
  t.end();
});

test('polymorphic JRE sites retain each resolved receiver target', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0 } });
  const instruction = {
    op: 'invokevirtual',
    arg: ['Method', 'ArbitraryBase', ['value', '()I']],
  };
  const siteId = jvm.jit.registerSyncCallSite(
    'invokevirtual', instruction);
  const method = {
    name: 'caller', descriptor: '()V',
    attributes: [{ type: 'code', code: {
      codeItems: [], exceptionTable: [], localsSize: '0', stackSize: '1',
    } }],
  };
  const frame = new Frame(method);
  const thread = { status: 'runnable', callStack: new Stack() };
  const nativeValue = (_jvm, receiver) => receiver.number;
  jvm.jit.resolveSynchronousJreMethod = () => nativeValue;
  const first = { type: 'FirstRuntimeType', number: 11 };
  const second = { type: 'SecondRuntimeType', number: 29 };
  frame.stack.push(first);
  t.equal(jvm.jit.tryInvokeSyncAt(siteId, frame, thread), 11,
    'the first runtime receiver resolves');
  frame.stack.push(second);
  t.equal(jvm.jit.tryInvokeSyncAt(siteId, frame, thread), 29,
    'a second runtime receiver resolves');
  frame.stack.push(first);
  t.equal(jvm.jit.tryInvokeSyncAt(siteId, frame, thread), 11,
    'returning to the first receiver reuses its resolved target');
  t.equal(jvm.jit.syncCallSites[siteId].jreTargets.size, 2,
    'the symbolic site retains both receiver targets');
  t.equal(jvm.jit.positionalJreTemplateCompileCount, 2,
    'each runtime ABI identity binds once');
  t.equal(jvm.jit.positionalJreTemplateReuseCount, 0,
    'alternating receivers do not rebind an existing adapter');
  t.end();
});

test('generated instance-call operand underflow falls back before callee execution', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0 } });
  const caller = {
    name: 'caller', descriptor: '(I)V',
    attributes: [{ type: 'code', code: {
      codeItems: [], exceptionTable: [], localsSize: '1', stackSize: '2',
    } }],
  };
  const callee = {
    name: 'callee', descriptor: '(I)V',
    attributes: [{ type: 'code', code: {
      codeItems: [], exceptionTable: [], localsSize: '2', stackSize: '0',
    } }],
  };
  const frame = new Frame(caller);
  frame.className = 'GenericCaller';
  frame.pc = 17;
  // The argument is present but the required instance receiver is not.
  frame.stack.items.push(41);
  let calleeRuns = 0;
  const generated = () => {
    calleeRuns += 1;
    return { value: undefined };
  };
  generated.jvmSynchronous = true;
  const site = {
    op: 'invokevirtual',
    declaredClassName: 'GenericCallee',
    methodName: 'callee',
    descriptor: '(I)V',
    params: ['int'],
    returnType: 'void',
  };
  const target = {
    method: callee,
    lookupClass: 'GenericCallee',
    generated,
  };
  const originalError = console.error;
  const diagnostics = [];
  console.error = (...args) => diagnostics.push(args);
  let result;
  try {
    result = jvm.jit.tryInvokeResolvedTarget(site, target, frame, {
      callStack: new Stack(),
    });
  } finally {
    console.error = originalError;
  }
  t.equal(result, jvm.jit.asyncInvokeSentinel(),
    'malformed generated state returns the canonical fallback sentinel');
  t.equal(calleeRuns, 0, 'callee has no side effect before the fallback');
  t.deepEqual(frame.stack.items, [41], 'caller operands remain reconstructible');
  t.equal(jvm.jit.syncOperandUnderflowFallbackCount, 1,
    'the invariant failure is visible in runtime telemetry');
  t.equal(diagnostics.length, 1, 'the failing call shape is reported once');
  t.deepEqual({
    ...diagnostics[0][1],
    hostStack: typeof diagnostics[0][1].hostStack,
  }, {
    caller: 'GenericCaller.caller(I)V',
    callerPc: 17,
    callee: 'GenericCallee.callee(I)V',
    op: 'invokevirtual',
    availableOperands: 1,
    requiredOperands: 2,
    callerLocals: ['undefined'],
    callStack: [],
    hostStack: 'string',
  }, 'diagnostic identifies the structural producer and consumer');
  t.end();
});

test('deoptimized generated children return to their recorded parent frame', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0 } });
  const method = (name, descriptor) => ({
    name, descriptor,
    attributes: [{ type: 'code', code: {
      codeItems: [], exceptionTable: [], localsSize: '0', stackSize: '1',
    } }],
  });
  const expectedParent = new Frame(method('expectedParent', '()V'));
  const restoredIntervening = new Frame(method('restoredIntervening', '()V'));
  const interpretedChild = new Frame(method('interpretedChild', '()I'));
  interpretedChild.stack.push(7);
  interpretedChild.jitGeneratedReturnParent = expectedParent;
  interpretedChild.jitGeneratedReturnType = 'int';
  const thread = { callStack: new Stack() };
  thread.callStack.push(expectedParent);
  thread.callStack.push(restoredIntervening);
  thread.callStack.push(interpretedChild);
  controlHandlers.ireturn(interpretedChild, null, jvm, thread);
  t.deepEqual(expectedParent.stack.items, [7],
    'an interpreted completion uses the explicit generated caller');
  t.equal(restoredIntervening.stack.items.length, 0,
    'a restored intervening frame does not steal the return value');

  const generatedChild = new Frame(method('generatedChild', '()I'));
  generatedChild.className = 'GenericChild';
  generatedChild.jitGeneratedReturnParent = expectedParent;
  generatedChild.jitGeneratedReturnType = 'int';
  jvm.jit.finishTryRunFrame(generatedChild, thread,
    'GenericChild.generatedChild()I', { returned: true, value: 9 });
  t.deepEqual(expectedParent.stack.items, [7, 9],
    'a generated completion uses the same explicit return handoff');
  t.equal(restoredIntervening.stack.items.length, 0,
    'generated completion also ignores the unrelated top frame');

  for (const [op, value] of [
    ['lreturn', 11n], ['freturn', 1.25], ['dreturn', 2.5],
  ]) {
    const typedChild = new Frame(method(`typed${op}`, '()V'));
    typedChild.stack.push(value);
    typedChild.jitGeneratedReturnParent = expectedParent;
    typedChild.jitGeneratedReturnType = op[0];
    thread.callStack.push(typedChild);
    controlHandlers[op](typedChild, null, jvm, thread);
    t.equal(expectedParent.stack.pop(), value,
      `${op} uses the explicit generated caller`);
    t.equal(restoredIntervening.stack.items.length, 0,
      `${op} does not leak into a restored intervening frame`);
  }
  t.end();
});

test('ad-hoc static generated calls carry initialization tokens', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0 } });
  jvm.classInitializationState.set('ArbitraryStaticTarget', 'INITIALIZED');
  const instruction = {
    op: 'invokestatic',
    arg: ['Method', 'ArbitraryStaticTarget', ['work', '()V']],
  };
  const frame = new Frame({
    name: 'caller', descriptor: '()V',
    attributes: [{ type: 'code', code: {
      codeItems: [], exceptionTable: [], localsSize: '0', stackSize: '0',
    } }],
  });
  let capturedSite = null;
  const original = jvm.jit.tryInvokeSyncSite;
  jvm.jit.tryInvokeSyncSite = (site) => {
    capturedSite = site;
    return null;
  };
  jvm.jit.tryInvokeSync('invokestatic', frame, instruction, {});
  jvm.jit.tryInvokeSyncSite = original;
  t.ok(capturedSite.initializationToken,
    'the ad-hoc static site carries a class-initialization token');
  t.ok(capturedSite.initializationToken.initialized,
    'the token exposes the initialized target state');
  t.end();
});

test('JRE-published final intrinsics receive generated operands positionally', (t) => {
  const jvm = new JVM({ jit: {
    warmupThreshold: 0, profileMethods: false, structuredSsa: false,
  } });
  const method = {
    name: 'arbitraryCharacterRead',
    descriptor: '(Ljava/lang/String;I)C',
    flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: [
        'aload_0', 'iload_1',
        { op: 'invokevirtual',
          arg: ['Method', 'java/lang/String', ['charAt', '(I)C']] },
        'ireturn',
      ].map((instruction, index) => ({ labelDef: `L${index}:`, instruction })),
      exceptionTable: [], localsSize: '2', stackSize: '2',
    } }],
  };
  const generated = jvm.jit.getGeneratedFunction(method);
  t.ok(generated.toString().includes('directJreIntrinsics') &&
      !generated.toString().includes('tryInvokeSyncAt'),
    'metadata published by the JRE removes generic call dispatch without a compiler name table');

  const frame = new Frame(method);
  frame.className = 'RenamedCaller';
  frame.locals[0] = jvm.internString('abc');
  frame.locals[1] = 1;
  const thread = { status: 'runnable', callStack: new Stack() };
  thread.callStack.push(frame);
  const result = generated(frame, thread, jvm.jit, false);
  t.equal(result.value, 'b'.charCodeAt(0),
    'the direct positional intrinsic preserves the return value');

  const throwing = new Frame(method);
  throwing.className = 'RenamedCaller';
  throwing.locals[0] = jvm.internString('abc');
  throwing.locals[1] = 9;
  thread.callStack.push(throwing);
  let error;
  try { generated(throwing, thread, jvm.jit, false); } catch (thrown) { error = thrown; }
  t.equal(error?.type, 'java/lang/StringIndexOutOfBoundsException',
    'the positional intrinsic preserves the Java exception type');
  t.equal(throwing.pc, 2, 'the throwing invoke retains its precise bytecode PC');
  t.deepEqual(throwing.stack.items, [throwing.locals[0], 9],
    'the throwing invoke retains receiver and operands for normal dispatch');
  t.end();
});

test('JRE-published static intrinsics bypass dispatch after initialization', (t) => {
  const jvm = new JVM({ jit: {
    warmupThreshold: 0, profileMethods: false, structuredSsa: true,
  } });
  const method = {
    name: 'arbitraryStaticMath', descriptor: '(D)D', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: [
        'dload_0',
        { op: 'invokestatic',
          arg: ['Method', 'java/lang/Math', ['sin', '(D)D']] },
        'dreturn',
      ].map((instruction, index) => ({ labelDef: `L${index}:`, instruction })),
      exceptionTable: [], localsSize: '2', stackSize: '2',
    } }],
  };
  const generated = jvm.jit.getGeneratedFunction(method);
  t.ok(generated.toString().includes('directJreIntrinsics') &&
      !generated.toString().includes('tryInvokeSyncAt'),
    'static JRE metadata removes generic call dispatch without a compiler name table');

  const thread = { status: 'runnable', callStack: new Stack() };
  const cold = new Frame(method);
  cold.className = 'RenamedStaticCaller';
  cold.locals[0] = 0.5;
  thread.callStack.push(cold);
  const deferred = generated(cold, thread, jvm.jit, false);
  t.ok(deferred?.deopt && /class initialization/.test(deferred.reason),
    'the direct static call falls back before execution while its owner is uninitialized');
  t.equal(cold.pc, 1, 'the fallback records the exact static invoke pc');
  t.deepEqual(cold.stack.items, [0.5], 'the fallback preserves the invoke operands');

  jvm._setClassInitializationState('java/lang/Math', 'INITIALIZED');
  const frame = new Frame(method);
  frame.className = 'RenamedStaticCaller';
  frame.locals[0] = 0.5;
  thread.callStack = new Stack();
  thread.callStack.push(frame);
  const result = generated(frame, thread, jvm.jit, false);
  t.equal(result.value, Math.sin(0.5),
    'the initialized positional intrinsic preserves the return value');
  t.end();
});

test('runtime-resolved generated callees receive structured SSA operands positionally', (t) => {
  const child = {
    name: 'arbitraryVirtualLeaf',
    descriptor: '(Ljava/lang/Object;I)I',
    attributes: [{ type: 'code', code: {
      codeItems: [
        'iload_2', 'iconst_1', 'iadd', 'ireturn',
      ].map((instruction, index) => ({ labelDef: `L${index}:`, instruction })),
      exceptionTable: [], localsSize: '3', stackSize: '2',
    } }],
  };
  const caller = {
    name: 'unrelatedCaller',
    descriptor: '(LArbitraryPositionalOwner;Ljava/lang/Object;I)I',
    flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: [
        'aload_0', 'aload_1', 'iload_2',
        { op: 'invokevirtual', arg: ['Method', 'ArbitraryPositionalOwner',
          [child.name, child.descriptor]] },
        'ireturn',
      ].map((instruction, index) => ({ labelDef: `L${index}:`, instruction })),
      exceptionTable: [], localsSize: '3', stackSize: '3',
    } }],
  };
  const jvm = new JVM({ jit: {
    warmupThreshold: 0,
    profileMethods: false,
    preferWholeMethodJs: true,
    structuredSsa: true,
  } });
  jvm.classes.ArbitraryPositionalOwner = {
    staticFields: new Map(),
    ast: { classes: [{ superClassName: null, items: [
      { type: 'method', method: child },
      { type: 'method', method: caller },
    ] }] },
  };
  jvm.classInitializationState.set('ArbitraryPositionalOwner', 'INITIALIZED');
  const generated = jvm.jit.structuredSsa.compile(caller);
  t.ok(generated?.jvmStructuredSsa &&
      generated.jvmStructuredSource.includes('fastPositional'),
  'an arbitrary virtual call site emits the runtime positional cache probe');

  const receiver = { type: 'ArbitraryPositionalOwner', fields: {} };
  const execute = (input) => {
    const frame = new Frame(caller);
    frame.className = 'ArbitraryPositionalOwner';
    frame.locals.splice(0, 3, receiver, { type: 'java/lang/Object', fields: {} }, input);
    const thread = { status: 'runnable', callStack: new Stack() };
    thread.callStack.push(frame);
    return generated(frame, thread, jvm.jit, false);
  };
  t.equal(execute(40).value, 41, 'the resolving invocation preserves the generated result');
  const site = jvm.jit.syncCallSites.find((candidate) => candidate?.fastPositional);
  t.ok(site?.fastPositional?.invoke,
    'ordinary JVM virtual resolution installs a fixed-arity positional entry');

  const generic = jvm.jit.tryInvokeSyncAt;
  jvm.jit.tryInvokeSyncAt = () => {
    throw new Error('generic call dispatch should not run after monomorphic resolution');
  };
  t.equal(execute(41).value, 42,
    'the warmed call feeds SSA operands directly without generic dispatch');
  jvm.jit.tryInvokeSyncAt = generic;
  const positional = site.fastPositional.invoke;
  const deopt = {
    deopt: true,
    transient: true,
    reason: 'synthetic positional child suspension',
  };
  site.fastPositional.invoke = (...argumentsList) => {
    const currentThread = argumentsList[argumentsList.length - 2];
    currentThread.callStack.push(new Frame(child));
    return deopt;
  };
  const suspended = new Frame(caller);
  suspended.className = 'ArbitraryPositionalOwner';
  suspended.locals.splice(0, 3,
    receiver, { type: 'java/lang/Object', fields: {} }, 99);
  const suspendedThread = { status: 'runnable', callStack: new Stack() };
  suspendedThread.callStack.push(suspended);
  t.equal(generated(suspended, suspendedThread, jvm.jit, false), deopt,
    'a positional child deopt suspends the caller instead of becoming a Java return value');
  t.equal(suspended.pc, 4, 'the suspended caller records its post-invoke bytecode PC');
  t.deepEqual(suspended.stack.items, [],
    'the suspended caller materializes its post-invoke operand stack');
  t.equal(suspendedThread.callStack.peek().jitGeneratedReturnParent, suspended,
    'the restored positional child records its exact return owner');
  t.equal(suspendedThread.callStack.peek().jitGeneratedReturnType, 'int',
    'the restored positional child records its descriptor return type');
  site.fastPositional.invoke = positional;
  t.end();
});

test('acyclic reference-returning callees execute positionally without child Frames', (t) => {
  const child = {
    name: 'arbitraryReferenceLeaf',
    descriptor: '(Ljava/lang/Object;Z)Ljava/lang/Object;',
    attributes: [{ type: 'code', code: {
      codeItems: [
        { labelDef: 'L0:', instruction: 'iload_2' },
        { labelDef: 'L1:', instruction: { op: 'ifeq', arg: 'L4' } },
        { labelDef: 'L2:', instruction: 'aload_1' },
        { labelDef: 'L3:', instruction: 'areturn' },
        { labelDef: 'L4:', instruction: 'aload_0' },
        { labelDef: 'L5:', instruction: 'areturn' },
      ],
      exceptionTable: [], localsSize: '3', stackSize: '1',
    } }],
  };
  const caller = {
    name: 'unrelatedReferenceCaller',
    descriptor: '(LArbitraryReferenceOwner;Ljava/lang/Object;Z)Ljava/lang/Object;',
    flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: [
        'aload_0', 'aload_1', 'iload_2',
        { op: 'invokevirtual', arg: ['Method', 'ArbitraryReferenceOwner',
          [child.name, child.descriptor]] },
        'areturn',
      ].map((instruction, index) => ({
        labelDef: `C${index}:`, instruction,
      })),
      exceptionTable: [], localsSize: '3', stackSize: '3',
    } }],
  };
  const jvm = new JVM({ jit: {
    warmupThreshold: 0,
    profileMethods: false,
    profileTimings: true,
    methodTimingSampleRate: 1,
    preferWholeMethodJs: true,
    structuredSsa: true,
  } });
  jvm.classes.ArbitraryReferenceOwner = {
    staticFields: new Map(),
    ast: { classes: [{ superClassName: null, items: [
      { type: 'method', method: child },
      { type: 'method', method: caller },
    ] }] },
  };
  jvm.classInitializationState.set('ArbitraryReferenceOwner', 'INITIALIZED');
  const childGenerated = jvm.jit.getGeneratedFunction(child);
  t.ok(childGenerated?.jvmFramelessPositional,
    'the acyclic reference body is structurally proven non-suspending');
  const generated = jvm.jit.structuredSsa.compile(caller);
  const receiver = { type: 'ArbitraryReferenceOwner', fields: {} };
  const selected = { type: 'java/lang/Object', fields: {} };
  const execute = (choice) => {
    const frame = new Frame(caller);
    frame.className = 'ArbitraryReferenceOwner';
    frame.locals.splice(0, 3, receiver, selected, choice);
    const thread = { status: 'runnable', callStack: new Stack() };
    thread.callStack.push(frame);
    return generated(frame, thread, jvm.jit, false);
  };
  t.equal(execute(1).value, selected,
    'the resolving reference call preserves its object result');
  const site = jvm.jit.syncCallSites.find((candidate) =>
    candidate?.methodName === child.name);
  t.ok(site?.fastPositional?.invoke,
    'runtime resolution installs the positional reference entry');
  const before = jvm.jit.referenceFramelessPositionalRunCount;
  const timingBefore =
    jvm.jit.methodTimingSamples.get(
      'ArbitraryReferenceOwner.arbitraryReferenceLeaf(Ljava/lang/Object;Z)Ljava/lang/Object;'
    )?.samples || 0;
  t.equal(execute(0).value, receiver,
    'the warmed call returns the alternate reference exactly');
  t.equal(jvm.jit.referenceFramelessPositionalRunCount, before + 1,
    'the warmed reference leaf executes without a child Frame');
  t.equal(jvm.jit.methodTimingSamples.get(
    'ArbitraryReferenceOwner.arbitraryReferenceLeaf(Ljava/lang/Object;Z)Ljava/lang/Object;'
  )?.samples, timingBefore + 1,
  'sampled timing attributes a frameless positional reference body');
  t.end();
});

test('contended synchronized frameless entries restore above their caller', (t) => {
  const method = {
    name: 'arbitrarySynchronizedFloat', descriptor: '()F',
    flags: ['synchronized'],
    attributes: [{ type: 'code', code: {
      codeItems: [
        { labelDef: 'L0:', instruction: 'fconst_1' },
        { labelDef: 'L1:', instruction: 'freturn' },
      ],
      exceptionTable: [], localsSize: '1', stackSize: '1',
    } }],
  };
  const jvm = new JVM({ jit: {
    warmupThreshold: 0, preferWholeMethodJs: true, structuredSsa: true,
  } });
  jvm.classes.ArbitrarySynchronizedOwner = {
    staticFields: new Map(),
    ast: { classes: [{ superClassName: null, items: [
      { type: 'method', method },
    ] }] },
  };
  jvm.classInitializationState.set(
    'ArbitrarySynchronizedOwner', 'INITIALIZED');
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated?.jvmFramelessPositional,
    'the call-free float getter publishes its frameless scalar ABI');
  const site = {
    op: 'invokevirtual', declaredClassName: 'ArbitrarySynchronizedOwner',
    methodName: method.name, descriptor: method.descriptor,
    params: [], returnType: 'float',
    initializationToken: { initialized: true },
  };
  const target = {
    method, lookupClass: 'ArbitrarySynchronizedOwner', generated,
  };
  const positional = jvm.jit.getPositionalGeneratedInvoker(site, target);
  const parentMethod = {
    name: 'caller', descriptor: '()V', attributes: [{ type: 'code', code: {
      codeItems: [], exceptionTable: [], localsSize: '0', stackSize: '0',
    } }],
  };
  const parent = new Frame(parentMethod);
  const receiver = {
    type: 'ArbitrarySynchronizedOwner', fields: {},
    isLocked: true, lockOwner: 99, lockCount: 1, waitSet: [],
  };
  const thread = {
    id: 7, status: 'runnable', pendingException: null, callStack: new Stack(),
  };
  thread.callStack.push(parent);
  const result = positional(receiver, thread);

  t.ok(result?.deopt,
    'monitor contention exits through the canonical child-frame path');
  t.equal(thread.callStack.items.length, 2,
    'the omitted synchronized child is restored exactly once');
  t.equal(thread.callStack.items[0], parent,
    'the caller retains its original stack position');
  t.equal(thread.callStack.peek().method, method,
    'the contended child is restored above the caller for scheduling');
  t.equal(thread.status, 'BLOCKED',
    'the scheduler observes the monitor-contended child');
  receiver.isLocked = false;
  receiver.lockOwner = null;
  receiver.lockCount = 0;
  thread.status = 'runnable';
  const child = thread.callStack.peek();
  t.ok(jvm.enterFrameMonitorIfNeeded(child, thread),
    'the restored child can acquire the released monitor');
  const completion = jvm.jit.tryRunFrame(child, thread);
  t.ok(completion?.handled,
    'the scheduler-visible child completes through the normal JIT entry');
  t.deepEqual(parent.stack.items, [1],
    'the non-void synchronized return reaches the original caller');
  t.end();
});

test('acyclic call-bearing structured bodies retain their scalar entry', (t) => {
  const leaf = {
    name: 'arbitraryNestedLeaf', descriptor: '()I', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: [
        { labelDef: 'L0:', instruction: { op: 'bipush', arg: 23 } },
        { labelDef: 'L1:', instruction: 'ireturn' },
      ],
      exceptionTable: [], localsSize: '0', stackSize: '1',
    } }],
  };
  const caller = {
    name: 'arbitraryCallBearingBody', descriptor: '()I', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: [
        { labelDef: 'C0:', instruction: { op: 'invokestatic',
          arg: ['Method', 'ArbitraryCallBearingOwner',
            [leaf.name, leaf.descriptor]] } },
        { labelDef: 'C1:', instruction: 'ireturn' },
      ],
      exceptionTable: [], localsSize: '0', stackSize: '1',
    } }],
  };
  const jvm = new JVM({ jit: {
    warmupThreshold: 0, preferWholeMethodJs: true, structuredSsa: true,
  } });
  jvm.classes.ArbitraryCallBearingOwner = {
    staticFields: new Map(),
    ast: { classes: [{ superClassName: null, items: [
      { type: 'method', method: leaf },
      { type: 'method', method: caller },
    ] }] },
  };
  jvm.classInitializationState.set('ArbitraryCallBearingOwner', 'INITIALIZED');

  const generated = jvm.jit.structuredSsa.compile(caller);
  t.ok(generated?.jvmStructuredSsa,
    'the arbitrary call-bearing fixture compiles through structured SSA');
  t.equal(generated?.jvmFramelessPositional, true,
    'an acyclic nested call keeps the restorable scalar entry');

  const site = {
    op: 'invokestatic', declaredClassName: 'ArbitraryCallBearingOwner',
    methodName: caller.name, descriptor: caller.descriptor,
    params: [], returnType: 'int',
    initializationToken: { initialized: true },
  };
  let observedChild = null;
  const observedGenerated = (child, thread) => {
    observedChild = child;
    t.notOk(thread.callStack.items.includes(child),
      'the fast positional wrapper omits the acyclic caller Frame');
    return 23;
  };
  observedGenerated.jvmSynchronous = true;
  observedGenerated.jvmFramelessPositional =
    generated.jvmFramelessPositional;
  const target = {
    method: caller, lookupClass: 'ArbitraryCallBearingOwner',
    generated: observedGenerated,
  };
  const positional = jvm.jit.getPositionalGeneratedInvoker(site, target);
  t.ok(positional, 'the scalar positional ABI remains available');
  const parent = new Frame(leaf);
  parent.className = 'ArbitraryCallBearingOwner';
  const thread = {
    id: 0, status: 'runnable', pendingException: null, callStack: new Stack(),
  };
  thread.callStack.push(parent);
  t.equal(positional(thread), 23,
    'the scalar positional entry preserves the nested return value');
  t.ok(observedChild, 'the call-bearing body receives a concrete child Frame');
  t.deepEqual(thread.callStack.items, [parent],
    'the scalar call leaves its parent stack unchanged');
  t.end();
});

test('private generated callees cache invokespecial positionally', (t) => {
  const child = {
    name: 'arbitraryPrivateLeaf',
    descriptor: '(I)I',
    flags: ['private'],
    attributes: [{ type: 'code', code: {
      codeItems: [
        'iload_1', 'iconst_1', 'iadd', 'ireturn',
      ].map((instruction, index) => ({ labelDef: `L${index}:`, instruction })),
      exceptionTable: [], localsSize: '2', stackSize: '2',
    } }],
  };
  const caller = {
    name: 'unrelatedPrivateCaller',
    descriptor: '(LArbitrarySpecialOwner;I)I',
    flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: [
        'aload_0', 'iload_1',
        { op: 'invokespecial', arg: ['Method', 'ArbitrarySpecialOwner',
          [child.name, child.descriptor]] },
        'ireturn',
      ].map((instruction, index) => ({ labelDef: `L${index}:`, instruction })),
      exceptionTable: [], localsSize: '2', stackSize: '2',
    } }],
  };
  const jvm = new JVM({ jit: {
    warmupThreshold: 0,
    profileMethods: false,
    preferWholeMethodJs: true,
    structuredSsa: true,
  } });
  jvm.classes.ArbitrarySpecialOwner = {
    staticFields: new Map(),
    ast: { classes: [{ superClassName: null, items: [
      { type: 'method', method: child },
      { type: 'method', method: caller },
    ] }] },
  };
  jvm.classInitializationState.set('ArbitrarySpecialOwner', 'INITIALIZED');
  const generated = jvm.jit.structuredSsa.compile(caller);
  t.ok(generated?.jvmStructuredSsa,
    'arbitrary private-helper caller selects structured SSA');

  const receiver = { type: 'ArbitrarySpecialOwner', fields: {} };
  const execute = (value, object = receiver) => {
    const frame = new Frame(caller);
    frame.className = 'ArbitrarySpecialOwner';
    frame.locals.splice(0, 2, object, value);
    const thread = { status: 'runnable', callStack: new Stack() };
    thread.callStack.push(frame);
    let result;
    let error;
    try {
      result = generated(frame, thread, jvm.jit, false);
    } catch (thrown) {
      error = thrown;
    }
    return { frame, thread, result, error };
  };
  t.equal(execute(40).result.value, 41,
    'resolving invokespecial preserves the private helper result');
  const site = jvm.jit.syncCallSites.find(candidate =>
    candidate?.op === 'invokespecial' && candidate.fastSpecialTarget);
  t.ok(site?.fastPositional?.invoke,
    'monomorphic special target publishes a fixed-arity positional entry');

  const generic = jvm.jit.tryInvokeSyncAt;
  jvm.jit.tryInvokeSyncAt = () => {
    throw new Error('generic call dispatch should not run after special resolution');
  };
  t.equal(execute(41).result.value, 42,
    'warmed private call feeds SSA operands without generic dispatch');
  jvm.jit.tryInvokeSyncAt = generic;

  const nullRun = execute(7, null);
  t.equal(nullRun.error?.type, 'java/lang/NullPointerException',
    'null receiver retains JVM invokespecial semantics');
  t.equal(nullRun.frame.pc, 2, 'null receiver records the invoke bytecode PC');
  t.deepEqual(nullRun.frame.stack.items, [null, 7],
    'null receiver reconstructs the caller operands in JVM order');
  t.end();
});

test('acyclic primitive-array callees omit frames and restore them on exceptions',
  async (t) => {
    const className = 'ArbitraryRestoringRaster';
    const classpath = compileJavaFixture(t, className, `
public final class ArbitraryRestoringRaster {
  int[] source;
  static int[] destination;

  private void mix(int destinationIndex, int sourceIndex, int divisor) {
    int value = source[sourceIndex] / divisor;
    destination[destinationIndex] = value == 0 ? 1 : value;
  }

  static void invoke(ArbitraryRestoringRaster self,
      int destinationIndex, int sourceIndex, int divisor) {
    self.mix(destinationIndex, sourceIndex, divisor);
  }
}
`);
    const jvm = new JVM({ classpath, jit: {
      warmupThreshold: 0,
      profileMethods: false,
      preferWholeMethodJs: true,
      structuredSsa: true,
    } });
    await jvm.loadClassByName(className);
    jvm.classInitializationState.set(className, 'INITIALIZED');
    const owner = jvm.classes[className];
    const source = [84, 21];
    source.type = '[I';
    const destination = [0, 0];
    destination.type = '[I';
    owner.staticFields.set('destination:[I', destination);
    const receiver = {
      type: className,
      fields: { [`${className}.source`]: source },
    };
    const caller = await jvm.findMethodInHierarchy(
      className, 'invoke', `(L${className};III)V`);
    const child = await jvm.findMethodInHierarchy(className, 'mix', '(III)V');
    const generated = jvm.jit.structuredSsa.compile(caller);
    t.ok(generated?.jvmStructuredSsa,
      'an arbitrary private primitive-array caller selects structured SSA');

    const execute = (destinationIndex, sourceIndex, divisor) => {
      const frame = new Frame(caller);
      frame.className = className;
      frame.locals.splice(
        0, 4, receiver, destinationIndex, sourceIndex, divisor);
      const thread = {
        id: 0,
        name: 'direct-restoring-test',
        status: 'runnable',
        pendingException: null,
        callStack: new Stack(),
      };
      thread.callStack.push(frame);
      let result;
      let error;
      try {
        result = generated(frame, thread, jvm.jit, false);
      } catch (thrown) {
        error = thrown;
      }
      return { frame, thread, result, error };
    };

    execute(0, 0, 2);
    t.equal(destination[0], 42,
      'the resolving call preserves field reads, division, and the array write');
    const site = jvm.jit.syncCallSites.find((candidate) =>
      candidate?.methodName === 'mix' &&
      (candidate.fastSpecialTarget || candidate.fastDynamicTarget));
    const target = site?.fastSpecialTarget || site?.fastDynamicTarget?.target;
    t.ok(target?.generated?.jvmRestoringDirectPositionalBody &&
      site?.fastPositional?.invoke,
    'verified field and primitive-array shape publishes the restoring scalar ABI');
    const reusableFrame = target.freeFrame;
    t.ok(reusableFrame, 'the resolving call leaves one reusable canonical frame');

    const generic = jvm.jit.tryInvokeSyncAt;
    jvm.jit.tryInvokeSyncAt = () => {
      throw new Error('generic call dispatch should not run after scalar resolution');
    };
    const warm = execute(1, 1, 3);
    t.notOk(warm.error, 'the warmed direct call completes normally');
    t.equal(destination[1], 7, 'the warmed direct result is exact');
    t.equal(target.freeFrame, reusableFrame,
      'the successful scalar call neither takes nor resets the cached Frame');

    const bounds = execute(0, 99, 1);
    t.equal(bounds.error?.type, 'java/lang/ArrayIndexOutOfBoundsException',
      'the direct scalar path preserves the Java bounds exception');
    t.equal(bounds.thread.callStack.size(), 2,
      'a throwing direct call reconstructs the omitted child Frame');
    const boundsChild = bounds.thread.callStack.peek();
    const childItems = jvm.jit.getCodeItems(child);
    const boundsPc = childItems.findIndex((item) =>
      (item.instruction?.op || item.instruction) === 'iaload');
    t.equal(boundsChild.method, child, 'the restored inner frame has the exact method');
    t.equal(boundsChild.pc, boundsPc, 'the restored inner frame has the exact load PC');
    t.deepEqual(boundsChild.locals.slice(0, 4), [receiver, 0, 99, 1],
      'the restored inner frame has exact receiver and scalar locals');
    t.equal(boundsChild.stack.items[0], source,
      'the restored load operands retain the source array');
    t.equal(boundsChild.stack.items[1], 99,
      'the restored load operands retain the failing index');
    const invokePc = jvm.jit.getCodeItems(caller).findIndex((item) => {
      const instruction = item.instruction;
      return instruction?.op?.startsWith('invoke') &&
        instruction.arg?.[2]?.[0] === 'mix';
    });
    t.equal(bounds.frame.pc, invokePc,
      'the outer frame remains at the throwing invoke PC');
    t.deepEqual(bounds.frame.stack.items, [receiver, 0, 99, 1],
      'the outer frame retains invoke operands in JVM order');

    const arithmetic = execute(0, 0, 0);
    t.equal(arithmetic.error?.type, 'java/lang/ArithmeticException',
      'the direct scalar path preserves integer division by zero');
    const arithmeticChild = arithmetic.thread.callStack.peek();
    const arithmeticPc = childItems.findIndex((item) =>
      (item.instruction?.op || item.instruction) === 'idiv');
    t.equal(arithmeticChild.pc, arithmeticPc,
      'the restored arithmetic frame has the exact division PC');
    t.deepEqual(arithmeticChild.stack.items, [84, 0],
      'the restored arithmetic operands remain in JVM order');
    jvm.jit.tryInvokeSyncAt = generic;

    const direct = site.fastPositional.invoke;
    const guardThread = {
      status: 'runnable', pendingException: null, callStack: new Stack(),
    };
    destination[0] = 1234;
    jvm.classInitializationState.set(className, 'INITIALIZING');
    jvm.classInitializationEpoch += 1;
    t.equal(direct(receiver, 0, 0, 2, guardThread),
      jvm.jit.asyncInvokeSentinel(),
    'class initialization guard falls back before entering the scalar body');
    t.equal(destination[0], 1234,
      'class initialization fallback occurs before the array side effect');
    t.equal(guardThread.callStack.size(), 0,
      'a guarded fallback does not create an omitted child frame');
    jvm.classInitializationState.set(className, 'INITIALIZED');
    jvm.classInitializationEpoch += 1;

    jvm.debugManager.enable();
    t.equal(direct(receiver, 0, 0, 2, guardThread),
      jvm.jit.asyncInvokeSentinel(),
    'debugger guard falls back before entering the scalar body');
    t.equal(destination[0], 1234,
      'debugger fallback occurs before the array side effect');
    jvm.debugManager.disable();
    t.ok(jvm.jit.structuredSsa.restoredDirectExceptionFrameCount >= 2,
      'runtime diagnostics count lazily restored exception frames');
    t.end();
  });

test('structured primitive-array loops use the generic restoring positional ABI',
  async (t) => {
    const className = 'ArbitraryDirectArrayLoop';
    const classpath = compileJavaFixture(t, className, `
public final class ArbitraryDirectArrayLoop {
  private static int transform(int value) {
    return (value * 13 + 7) & 255;
  }

  private static void store(int[] destination, int index, int value) {
    destination[index] = value;
  }

  private static void fill(int[] destination, int start, int count, int seed) {
    for (int index = 0; index < count; index++) {
      store(destination, start + index, transform(seed + index));
    }
  }

  static void invoke(int[] destination, int start, int count, int seed) {
    fill(destination, start, count, seed);
  }
}
`);
    const jvm = new JVM({ classpath, jit: {
      warmupThreshold: 0,
      profileMethods: false,
      preferWholeMethodJs: true,
      structuredSsa: true,
    } });
    await jvm.loadClassByName(className);
    jvm.classInitializationState.set(className, 'INITIALIZED');
    const caller = await jvm.findMethodInHierarchy(
      className, 'invoke', '([IIII)V');
    const child = await jvm.findMethodInHierarchy(
      className, 'fill', '([IIII)V');
    const leaf = await jvm.findMethodInHierarchy(
      className, 'store', '([III)V');
    const generated = jvm.jit.structuredSsa.compile(caller);
    t.ok(generated?.jvmStructuredSsa,
      'an arbitrary array-loop caller selects structured SSA');

    const execute = (destination, start, count, seed) => {
      const frame = new Frame(caller);
      frame.className = className;
      frame.locals.splice(0, 4, destination, start, count, seed);
      const thread = {
        id: 0,
        name: 'direct-array-loop-test',
        status: 'runnable',
        pendingException: null,
        callStack: new Stack(),
      };
      thread.callStack.push(frame);
      let result;
      let error;
      try {
        result = generated(frame, thread, jvm.jit, false);
      } catch (thrown) {
        error = thrown;
      }
      return { frame, thread, result, error };
    };

    const destination = new Array(16).fill(-1);
    destination.type = '[I';
    execute(destination, 2, 6, 10);
    t.deepEqual(destination.slice(2, 8),
      Array.from({ length: 6 }, (_unused, index) =>
        ((10 + index) * 13 + 7) & 255),
    'the resolving run derives every result from the guest bytecode');

    const site = jvm.jit.syncCallSites.find((candidate) =>
      candidate?.methodName === 'fill' && candidate.fastStaticTarget);
    const target = site?.fastStaticTarget;
    t.ok(target?.generated?.jvmRestoringDirectPositionalBody &&
      site?.fastPositional?.invoke,
    'the verified loop publishes the generic restoring positional entry');
    t.ok(target.generated.jvmStructuredLoopCount > 0,
      'the direct entry comes from a structured loop rather than an acyclic leaf');
    t.equal(target.generated.jvmStructuredInlinedRestoringSpills, true,
      'a bounded loop inlines its cold Frame reconstruction within budget');
    t.equal(target.generated.jvmStructuredCaptureFreeRestoringSpills, true,
      'loop reconstruction uses the capture-free cold helper');
    t.ok(target.generated.jvmStructuredRestoringSpillCallCount > 0 &&
      target.generated.jvmStructuredRestoringSpillInlineCost <= 512,
    'the generic decision is derived from spill sites and live JVM state');
    t.notOk(target.generated.jvmRestoringDirectPositionalSource.includes(
      'function spillLocals()'),
    'the successful loop does not capture scalar locals in a spill closure');
    const reusableFrame = target.freeFrame;

    const generic = jvm.jit.tryInvokeSyncAt;
    jvm.jit.tryInvokeSyncAt = () => {
      throw new Error('generic dispatch should not run for the warmed array loop');
    };
    const warm = execute(destination, 0, 2, 30);
    t.notOk(warm.error, 'the warmed direct loop completes normally');
    t.deepEqual(destination.slice(0, 2), [141, 154],
      'the warmed direct loop preserves exact Java integer results');
    t.equal(target.freeFrame, reusableFrame,
      'the normal direct loop creates no child Frame');
    t.ok(jvm.jit.structuredSsa.restoringDirectRunCount > 0,
      'restoring entries retain their dedicated runtime counter');
    t.equal(jvm.jit.structuredSsa.totalRunCount,
      jvm.jit.structuredSsa.runCount +
        jvm.jit.structuredSsa.restoringDirectRunCount,
    'reported structured runs combine disjoint entry counters off the hot path');

    const bounds = execute(destination, 15, 2, 40);
    t.equal(bounds.error?.type, 'java/lang/ArrayIndexOutOfBoundsException',
      'a throwing loop iteration preserves the Java bounds exception');
    t.equal(bounds.thread.callStack.size(), 3,
      'the throwing iteration restores both omitted child Frames');
    const restoredOuter = bounds.thread.callStack.items[1];
    const restored = bounds.thread.callStack.peek();
    const childItems = jvm.jit.getCodeItems(child);
    const invokePc = childItems.findIndex((item) =>
      item.instruction?.op === 'invokestatic' &&
      item.instruction.arg?.[2]?.[0] === 'store');
    t.equal(restoredOuter.method, child,
      'the omitted outer loop is below its throwing callee');
    t.equal(restoredOuter.pc, invokePc,
      'the outer loop remains at the exact throwing invoke PC');
    t.equal(restoredOuter.locals[1], 15,
      'the restored loop retains its start local');
    t.equal(restoredOuter.locals[2], 2,
      'the restored loop retains its count local');
    t.equal(restoredOuter.locals[4], 1,
      'the restored loop retains its induction local');
    const leafItems = jvm.jit.getCodeItems(leaf);
    const storePc = leafItems.findIndex((item) =>
      (item.instruction?.op || item.instruction) === 'iastore');
    t.equal(restored.method, leaf,
      'the innermost restored frame has the exact store method');
    t.equal(restored.pc, storePc,
      'the innermost restored frame has the exact store PC');
    t.deepEqual(restored.locals.slice(0, 3), [destination, 16, 28],
      'the inner store retains its exact array, index, and value locals');
    t.deepEqual(restored.stack.items, [destination, 16, 28],
      'the inner store retains the exact failing array-store operands');
    jvm.jit.tryInvokeSyncAt = generic;
    t.end();
  });

test('large restoring loops outline capture-free exception materialization',
  async (t) => {
    const className = 'ArbitraryOutlinedDirectArrayLoop';
    const classpath = compileJavaFixture(t, className, `
public final class ArbitraryOutlinedDirectArrayLoop {
  private static int transform(int value) {
    return (value * 13 + 7) & 255;
  }

  private static void store(int[] destination, int index, int value) {
    destination[index] = value;
  }

  private static void fill(int[] destination, int start, int count, int seed) {
    for (int index = 0; index < count; index++) {
      store(destination, start + index, transform(seed + index));
    }
  }

  static void invoke(int[] destination, int start, int count, int seed) {
    fill(destination, start, count, seed);
  }
}
`);
    const jvm = new JVM({ classpath, jit: {
      warmupThreshold: 0,
      profileMethods: false,
      preferWholeMethodJs: true,
      structuredSsa: true,
      structuredLoopInlineRestoringSpillBudget: 0,
    } });
    await jvm.loadClassByName(className);
    jvm.classInitializationState.set(className, 'INITIALIZED');
    const caller = await jvm.findMethodInHierarchy(
      className, 'invoke', '([IIII)V');
    const child = await jvm.findMethodInHierarchy(
      className, 'fill', '([IIII)V');
    const leaf = await jvm.findMethodInHierarchy(
      className, 'store', '([III)V');
    const generated = jvm.jit.structuredSsa.compile(caller);

    const execute = (destination, start, count, seed) => {
      const frame = new Frame(caller);
      frame.className = className;
      frame.locals.splice(0, 4, destination, start, count, seed);
      const thread = {
        id: 0,
        name: 'outlined-direct-array-loop-test',
        status: 'runnable',
        pendingException: null,
        callStack: new Stack(),
      };
      thread.callStack.push(frame);
      let error;
      try {
        generated(frame, thread, jvm.jit, false);
      } catch (thrown) {
        error = thrown;
      }
      return { thread, error };
    };

    const destination = new Array(16).fill(-1);
    destination.type = '[I';
    execute(destination, 2, 6, 10);
    const site = jvm.jit.syncCallSites.find((candidate) =>
      candidate?.methodName === 'fill' && candidate.fastStaticTarget);
    const target = site?.fastStaticTarget;
    t.ok(target?.generated?.jvmRestoringDirectPositionalBody,
      'the arbitrary child publishes a restoring positional body');
    t.equal(target.generated.jvmStructuredInlinedRestoringSpills, false,
      'the zero inline budget keeps large cold materialization out of the body');
    t.equal(target.generated.jvmStructuredOutlinedCaptureFreeRestoringSpills,
      true, 'the generic spill-cost decision selects the outlined helper');
    t.equal(target.generated.jvmStructuredCaptureFreeRestoringSpills, true,
      'the outlined body keeps successful scalar locals out of a closure');
    t.equal(target.generated.jvmStructuredRestoringFrameSlotCount, 5,
    'restoration retains four entry arguments and one distinct spill slot exactly once');
    t.ok(target.generated.jvmRestoringDirectPositionalSource.includes(
      'materializeDirectFrame('),
    'throwing operations call the capture-free materialization helper');
    t.notOk(target.generated.jvmRestoringDirectPositionalSource.includes(
      'function spillLocals()'),
    'the successful loop contains no local-capturing spill closure');

    const bounds = execute(destination, 15, 2, 40);
    t.equal(bounds.error?.type, 'java/lang/ArrayIndexOutOfBoundsException',
      'the outlined path preserves the Java bounds exception');
    t.equal(bounds.thread.callStack.size(), 3,
      'both omitted child Frames are reconstructed exactly once');
    const restoredOuter = bounds.thread.callStack.items[1];
    const restored = bounds.thread.callStack.peek();
    const childItems = jvm.jit.getCodeItems(child);
    const invokePc = childItems.findIndex((item) =>
      item.instruction?.op === 'invokestatic' &&
      item.instruction.arg?.[2]?.[0] === 'store');
    t.equal(restoredOuter.method, child,
      'the outer reconstructed Frame retains the loop method');
    t.equal(restoredOuter.pc, invokePc,
      'the outer reconstructed Frame retains the exact invoke PC');
    t.deepEqual(restoredOuter.locals.slice(0, 5),
      [destination, 15, 2, 40, 1],
    'the outer reconstructed Frame retains its exact live locals');
    const leafItems = jvm.jit.getCodeItems(leaf);
    const storePc = leafItems.findIndex((item) =>
      (item.instruction?.op || item.instruction) === 'iastore');
    t.equal(restored.method, leaf,
      'the reconstructed Frame retains the throwing method');
    t.equal(restored.pc, storePc,
      'the reconstructed Frame retains the exact throwing bytecode PC');
    t.deepEqual(restored.locals.slice(0, 3), [destination, 16, 28],
      'the reconstructed Frame retains its exact live locals');
    t.deepEqual(restored.stack.items, [destination, 16, 28],
      'the reconstructed Frame retains the exact throwing operands');
    t.end();
  });

test('reference-parameter array loops use the generic restoring positional ABI',
  async (t) => {
    const className = 'ArbitraryReferenceArrayLoop';
    const classpath = compileJavaFixture(t, className, `
public final class ArbitraryReferenceArrayLoop {
  static final class State {
    int bias;
  }

  private static void fill(int[] destination, Object expected,
      Object actual, State state) {
    int bias = expected != actual ? state.bias : 0;
    for (int index = 0; index < destination.length; index++) {
      destination[index] = index + bias;
    }
  }

  static void invoke(int[] destination, Object expected,
      Object actual, State state) {
    fill(destination, expected, actual, state);
  }
}
`);
    const jvm = new JVM({ classpath, jit: {
      warmupThreshold: 0,
      profileMethods: false,
      preferWholeMethodJs: true,
      structuredSsa: true,
    } });
    await jvm.loadClassByName(className);
    await jvm.loadClassByName(`${className}$State`);
    jvm.classInitializationState.set(className, 'INITIALIZED');
    jvm.classInitializationState.set(`${className}$State`, 'INITIALIZED');
    const caller = await jvm.findMethodInHierarchy(
      className, 'invoke',
      `([ILjava/lang/Object;Ljava/lang/Object;L${className}$State;)V`);
    const child = await jvm.findMethodInHierarchy(
      className, 'fill',
      `([ILjava/lang/Object;Ljava/lang/Object;L${className}$State;)V`);
    const generated = jvm.jit.structuredSsa.compile(caller);
    const destination = new Array(4).fill(-1);
    destination.type = '[I';
    const expected = {type: 'java/lang/Object', fields: {}};
    const actual = {type: 'java/lang/Object', fields: {}};
    const state = {
      type: `${className}$State`,
      fields: {[`${className}$State.bias`]: 9},
    };
    const execute = (array, left = expected, right = actual) => {
      const frame = new Frame(caller);
      frame.className = className;
      frame.locals.splice(0, 4, array, left, right, state);
      const thread = {
        id: 0,
        name: 'reference-array-loop-test',
        status: 'runnable',
        pendingException: null,
        callStack: new Stack(),
      };
      thread.callStack.push(frame);
      let result;
      let error;
      try {
        result = generated(frame, thread, jvm.jit, false);
      } catch (thrown) {
        error = thrown;
      }
      return {frame, thread, result, error};
    };

    execute(destination);
    t.deepEqual(destination.slice(), [9, 10, 11, 12],
      'a distinct reference selects the field-backed loop result');
    const site = jvm.jit.syncCallSites.find((candidate) =>
      candidate?.methodName === 'fill' && candidate.fastStaticTarget);
    const target = site?.fastStaticTarget;
    t.ok(target?.generated?.jvmRestoringDirectPositionalBody &&
      site?.fastPositional?.invoke,
    'reference parameters, arraylength, and reference comparison publish the direct ABI');
    const reusableFrame = target.freeFrame;
    const generic = jvm.jit.tryInvokeSyncAt;
    jvm.jit.tryInvokeSyncAt = () => {
      throw new Error('generic dispatch should not run for the warmed reference loop');
    };
    try {
      execute(destination, expected, expected);
    } finally {
      jvm.jit.tryInvokeSyncAt = generic;
    }
    t.deepEqual(destination.slice(), [0, 1, 2, 3],
      'the warmed direct entry observes reference identity exactly');
    t.equal(target.freeFrame, reusableFrame,
      'the warmed reference loop creates no child Frame');

    const failure = execute(null);
    t.notOk(failure.error,
      'a null array leaves exception delivery to the canonical JVM path');
    t.equal(failure.result?.deopt, true,
      'a null array rejects the direct entry before executing the loop');
    t.equal(failure.thread.callStack.size(), 2,
      'the rejected direct entry reconstructs the omitted child Frame');
    t.equal(failure.thread.callStack.peek().pc, 0,
      'the canonical child resumes before any direct-entry side effect');
    t.end();
  });

test('reference-static wrapper branches use the generic restoring positional ABI',
  async (t) => {
    const className = 'ArbitraryReferenceStaticWrapper';
    const classpath = compileJavaFixture(t, className, `
public final class ArbitraryReferenceStaticWrapper {
  static Object hook;
  static int total;

  private static void add(int value) {
    total += value;
  }

  private static void optional() {
    total += 100;
  }

  private static void wrapper(int a, int b, int c, boolean enabled) {
    add(a);
    add(b);
    add(c);
    if (hook != null) optional();
  }

  static void invoke(int a, int b, int c, boolean enabled) {
    wrapper(a, b, c, enabled);
  }
}
`);
    const jvm = new JVM({ classpath, jit: {
      warmupThreshold: 0,
      profileMethods: false,
      preferWholeMethodJs: true,
      structuredSsa: true,
    } });
    const owner = await jvm.loadClassByName(className);
    owner.staticFields.set('hook:Ljava/lang/Object;', null);
    owner.staticFields.set('total:I', 0);
    owner.staticFieldsInitialized = true;
    jvm.classInitializationState.set(className, 'INITIALIZED');
    const caller = await jvm.findMethodInHierarchy(
      className, 'invoke', '(IIIZ)V');
    const generated = jvm.jit.structuredSsa.compile(caller);
    t.ok(generated?.jvmStructuredSsa,
      'an arbitrarily named primitive wrapper selects structured SSA');

    const execute = (a, b, c, enabled) => {
      const frame = new Frame(caller);
      frame.className = className;
      frame.locals.splice(0, 4, a, b, c, enabled ? 1 : 0);
      const thread = {
        id: 0,
        name: 'reference-static-wrapper-test',
        status: 'runnable',
        pendingException: null,
        callStack: new Stack(),
      };
      thread.callStack.push(frame);
      return generated(frame, thread, jvm.jit, false);
    };

    execute(1, 2, 3, false);
    t.equal(owner.staticFields.get('total:I'), 6,
      'the resolving wrapper preserves all child effects');
    const site = jvm.jit.syncCallSites.find((candidate) =>
      candidate?.methodName === 'wrapper' && candidate.fastStaticTarget);
    const target = site?.fastStaticTarget;
    t.ok(target?.generated?.jvmRestoringDirectPositionalBody &&
      site?.fastPositional?.invoke,
    'a resolved reference static and null branch publish a generic direct entry');
    t.ok(target.generated.jvmRestoringDirectPositionalSource.includes(
      'hook:Ljava/lang/Object;'),
    'the direct body reads the resolved static location instead of a guest identity');
    owner.staticFields.set('hook:Ljava/lang/Object;', {
      type: 'java/lang/Object',
      fields: {},
    });
    execute(4, 5, 6, true);
    t.equal(owner.staticFields.get('total:I'), 121,
      'the direct entry observes a changed reference and links the live branch');
    const reusableFrame = target.freeFrame;
    const generic = jvm.jit.tryInvokeSyncAt;
    jvm.jit.tryInvokeSyncAt = () => {
      throw new Error('generic dispatch should not run for the warmed wrapper');
    };
    try {
      execute(1, 1, 1, true);
    } finally {
      jvm.jit.tryInvokeSyncAt = generic;
    }
    t.equal(owner.staticFields.get('total:I'), 224,
      'the fully warmed wrapper and children avoid generic call dispatch');
    t.equal(target.freeFrame, reusableFrame,
      'the warmed wrapper creates no child Frame');
    t.end();
  });

test('structured callers capture cold monomorphic callees before loop entry',
  async (t) => {
  const className = 'ArbitraryEagerMonomorphicCallHarness';
  const classpath = compileJavaFixture(t, className, `
public final class ArbitraryEagerMonomorphicCallHarness {
  private static Object identity(Object value) {
    return value;
  }

  static int repeat(Object value, int count) {
    while (count-- > 0) value = identity(value);
    return value == null ? 0 : 1;
  }
}
`);
  const jvm = new JVM({classpath, jit: {
    warmupThreshold: 0,
    profileMethods: false,
    preferWholeMethodJs: true,
    structuredSsa: true,
    // Opt in explicitly: eager monomorphic linking is off by default because it
    // miscompiles (see the flag's comment in JitCompiler).
    eagerMonomorphicCalls: true,
  }});
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const caller = await jvm.findMethodInHierarchy(
    className, 'repeat', '(Ljava/lang/Object;I)I');
  const generated = jvm.jit.structuredSsa.compile(caller);
  const site = jvm.jit.syncCallSites.find((candidate) =>
    candidate?.declaredClassName === className &&
    candidate?.methodName === 'identity');
  t.ok(generated?.jvmStructuredSsa,
    'the arbitrary reference-returning loop receives structured lowering');
  t.equal(typeof site?.fastPositional?.invoke, 'function',
    'the monomorphic helper is linked before caller execution');
  t.match(generated.jvmStructuredSource,
    /let ssaFastPositionalInvoke\d+ = /,
    'the generated region captures a scalar positional target');
  t.match(generated.jvmStructuredSource, /isClassJitDeopted/,
    'the immutable target remains guarded by debugger deoptimization');

  const frame = new Frame(caller);
  frame.className = className;
  frame.locals[0] = {type: 'java/lang/Object', fields: {}};
  frame.locals[1] = 25;
  const thread = {
    id: 0, name: 'eager-monomorphic-call', status: 'runnable',
    pendingException: null, callStack: new Stack(),
  };
  thread.callStack.push(frame);
  let genericCalls = 0;
  const tryInvokeSyncAt = jvm.jit.tryInvokeSyncAt;
  jvm.jit.tryInvokeSyncAt = function (...args) {
    genericCalls += 1;
    return tryInvokeSyncAt.apply(this, args);
  };
  let result;
  try {
    jvm._nextEventLoopYieldAt = Date.now() + 60000;
    result = generated(frame, thread, jvm.jit, false);
  } finally {
    jvm.jit.tryInvokeSyncAt = tryInvokeSyncAt;
  }
  t.deepEqual(result, {returned: true, value: 1},
    'eager lowering preserves the complete Java result');
  t.equal(genericCalls, 0,
    'the loop performs no generic call dispatch');
  t.equal(jvm.jit.eagerMonomorphicCallLinkCount, 1,
    'the compile-time link is recorded once');
  t.equal(thread.callStack.size(), 0,
    'successful intermethod execution leaves no child Frame');

  const disabledJvm = new JVM({classpath, jit: {
    warmupThreshold: 0,
    profileMethods: false,
    preferWholeMethodJs: true,
    structuredSsa: true,
    eagerMonomorphicCalls: false,
  }});
  await disabledJvm.loadClassByName(className);
  disabledJvm.classInitializationState.set(className, 'INITIALIZED');
  const disabledCaller = await disabledJvm.findMethodInHierarchy(
    className, 'repeat', '(Ljava/lang/Object;I)I');
  disabledJvm.jit.structuredSsa.compile(disabledCaller);
  const disabledSite = disabledJvm.jit.syncCallSites.find((candidate) =>
    candidate?.declaredClassName === className &&
    candidate?.methodName === 'identity');
  t.notOk(disabledSite?.fastPositional,
    'the explicit gate leaves the cold site on generic dispatch');
  t.equal(disabledJvm.jit.eagerMonomorphicCallLinkCount, 0,
    'the disabled path records no eager link');

  const uninitializedJvm = new JVM({classpath, jit: {
    warmupThreshold: 0,
    profileMethods: false,
    preferWholeMethodJs: true,
    structuredSsa: true,
  }});
  await uninitializedJvm.loadClassByName(className);
  const uninitializedCaller = await uninitializedJvm.findMethodInHierarchy(
    className, 'repeat', '(Ljava/lang/Object;I)I');
  uninitializedJvm.jit.structuredSsa.compile(uninitializedCaller);
  const uninitializedSite = uninitializedJvm.jit.syncCallSites.find(
    (candidate) => candidate?.declaredClassName === className &&
      candidate?.methodName === 'identity');
  t.notOk(uninitializedSite?.fastPositional,
    'an uninitialized static owner is not eagerly linked');
  t.end();
});

test('effectful instance wrappers invalidate direct field caches positionally',
  async (t) => {
    const className = 'ArbitraryEffectfulInstanceWrapper';
    const classpath = compileJavaFixture(t, className, `
public final class ArbitraryEffectfulInstanceWrapper {
  int value;

  public final void change(int delta) {
    value += delta;
  }

  public final int wrapper(int delta) {
    int before = value;
    change(delta);
    return before + value;
  }

  static int invoke(ArbitraryEffectfulInstanceWrapper receiver, int delta) {
    return receiver.wrapper(delta);
  }
}
`);
    const jvm = new JVM({ classpath, jit: {
      warmupThreshold: 0,
      profileMethods: false,
      preferWholeMethodJs: true,
      structuredSsa: true,
    } });
    const owner = await jvm.loadClassByName(className);
    owner.staticFieldsInitialized = true;
    jvm.classInitializationState.set(className, 'INITIALIZED');
    const caller = await jvm.findMethodInHierarchy(
      className, 'invoke',
      '(LArbitraryEffectfulInstanceWrapper;I)I');
    const wrapper = await jvm.findMethodInHierarchy(
      className, 'wrapper', '(I)I');
    const generated = jvm.jit.structuredSsa.compile(caller);
    t.ok(generated?.jvmStructuredSsa,
      'an arbitrarily named reference caller selects structured SSA');

    const receiver = {
      type: className,
      fields: {[`${className}.value`]: 10},
    };
    const execute = (delta) => {
      const frame = new Frame(caller);
      frame.className = className;
      frame.locals.splice(0, 2, receiver, delta);
      const thread = {
        id: 0,
        name: 'effectful-instance-wrapper-test',
        status: 'runnable',
        pendingException: null,
        callStack: new Stack(),
      };
      thread.callStack.push(frame);
      return generated(frame, thread, jvm.jit, false);
    };

    t.deepEqual(execute(3), {returned: true, value: 23},
      'the resolving call observes the field value before and after its child');
    const site = jvm.jit.syncCallSites.find((candidate) =>
      candidate?.methodName === 'wrapper' && candidate.fastDynamicTarget);
    const target = site?.fastDynamicTarget?.target;
    t.ok(target?.generated?.jvmRestoringDirectPositionalBody &&
      site?.fastPositional?.invoke,
    'the verified instance wrapper publishes a restoring positional entry');
    t.equal(target.generated.jvmRestoringDirectPositionalPlan, undefined,
      'the entry is emitted generically rather than by a semantic oracle');

    const reusableFrame = target.freeFrame;
    const generic = jvm.jit.tryInvokeSyncAt;
    jvm.jit.tryInvokeSyncAt = () => {
      throw new Error('generic dispatch should not run for the warmed wrapper');
    };
    let warm;
    try {
      warm = execute(4);
    } finally {
      jvm.jit.tryInvokeSyncAt = generic;
    }
    t.deepEqual(warm, {returned: true, value: 30},
      'the warmed call reloads the field after its effectful child');
    t.equal(receiver.fields[`${className}.value`], 17,
      'the child mutation remains visible to the positional caller');
    t.equal(target.freeFrame, reusableFrame,
      'the warmed instance wrapper creates no child Frame');
    t.equal(wrapper.name, 'wrapper',
      'selection is attached to the loaded method identity, not its name');
    t.end();
  });

test('effectful numeric leaves lower internal floating point positionally',
  async (t) => {
    const className = 'ArbitraryNumericStateLeaf';
    const classpath = compileJavaFixture(t, className, `
public final class ArbitraryNumericStateLeaf {
  int value = 32768;

  public final int scale(int input) {
    value = (int) ((double) value / 65536.0 * (double) input);
    return value;
  }

  static int invoke(ArbitraryNumericStateLeaf receiver, int input) {
    return receiver.scale(input);
  }
}
`);
    const jvm = new JVM({ classpath, jit: {
      warmupThreshold: 0,
      profileMethods: false,
      preferWholeMethodJs: true,
      structuredSsa: true,
    } });
    const owner = await jvm.loadClassByName(className);
    owner.staticFieldsInitialized = true;
    jvm.classInitializationState.set(className, 'INITIALIZED');
    const caller = await jvm.findMethodInHierarchy(
      className, 'invoke', `(L${className};I)I`);
    const generated = jvm.jit.structuredSsa.compile(caller);
    const receiver = {
      type: className,
      fields: {[`${className}.value`]: 32768},
    };
    const execute = (input) => {
      const frame = new Frame(caller);
      frame.className = className;
      frame.locals.splice(0, 2, receiver, input);
      const thread = {
        id: 0,
        name: 'numeric-state-leaf-test',
        status: 'runnable',
        pendingException: null,
        callStack: new Stack(),
      };
      thread.callStack.push(frame);
      return generated(frame, thread, jvm.jit, false);
    };

    t.deepEqual(execute(4), {returned: true, value: 2},
      'the resolving call preserves Java double conversion semantics');
    const site = jvm.jit.syncCallSites.find((candidate) =>
      candidate?.methodName === 'scale' && candidate.fastDynamicTarget);
    t.equal(typeof site?.fastDynamicTarget?.target?.generated
      ?.jvmRestoringDirectPositionalBody, 'function',
    'a verified internal floating-point expression publishes the scalar ABI');

    const generic = jvm.jit.tryInvokeSyncAt;
    jvm.jit.tryInvokeSyncAt = () => {
      throw new Error('generic dispatch should not run for the warmed leaf');
    };
    try {
      t.deepEqual(execute(65536), {returned: true, value: 2},
        'the warmed call feeds operands directly into generated JavaScript');
    } finally {
      jvm.jit.tryInvokeSyncAt = generic;
    }
    t.end();
  });

test('short primitive-array field helpers stay synchronous', async (t) => {
  const classpath = compileJavaFixture(t, 'ArbitraryArrayStateLeaf', `
public class ArbitraryArrayStateLeaf {
  static int a, b, c, d;
  static void save(int[] out) {
    out[0] = a; out[1] = b; out[2] = c; out[3] = d;
  }
  static void restore(int[] in) {
    a = in[0]; b = in[1]; c = in[2]; d = in[3];
  }
  public static void roundTrip(int[] state) {
    save(state);
    a = b = c = d = 0;
    restore(state);
  }
}
`);
  const jvm = new JVM({
    classpath, jit: { warmupThreshold: 0, preferWholeMethodJs: true },
  });
  await jvm.loadClassByName('ArbitraryArrayStateLeaf');
  jvm.classInitializationState.set('ArbitraryArrayStateLeaf', 'INITIALIZED');
  const owner = jvm.classes.ArbitraryArrayStateLeaf;
  owner.staticFields.set('a:I', 11);
  owner.staticFields.set('b:I', 22);
  owner.staticFields.set('c:I', 33);
  owner.staticFields.set('d:I', 44);
  const save = await jvm.findMethodInHierarchy(
    'ArbitraryArrayStateLeaf', 'save', '([I)V');
  const restore = await jvm.findMethodInHierarchy(
    'ArbitraryArrayStateLeaf', 'restore', '([I)V');
  t.ok(jvm.jit.isShortSupportedHelper(save) && jvm.jit.isShortSupportedHelper(restore),
    'renamed four-slot primitive-array leaves pass the structural helper gate');
  t.equal(jvm.jit.shortSupportedHelperCache.get(save), true,
    'the immutable helper-shape decision is retained for warmed call sites');
  t.equal(jvm.jit.isShortSupportedHelper(save), true,
    'repeated admission reuses the cached structural decision');
  const thread = {
    id: 0, name: 'short-array-leaf', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const state = [0, 0, 0, 0];
  state.type = '[I';
  await invoke(jvm, thread, 'ArbitraryArrayStateLeaf', 'roundTrip', '([I)V', [state]);
  t.deepEqual(state.slice(), [11, 22, 33, 44],
    'synchronous save preserves all primitive array stores');
  t.deepEqual([
    owner.staticFields.get('a:I'), owner.staticFields.get('b:I'),
    owner.staticFields.get('c:I'), owner.staticFields.get('d:I'),
  ], [11, 22, 33, 44], 'synchronous restore preserves all static writes');
  t.end();
});

test('pure direct JRE intrinsics preserve structured field caches',
  async (t) => {
    const className = 'ArbitraryPureIntrinsicFieldLoop';
    const classpath = compileJavaFixture(t, className, `
public final class ArbitraryPureIntrinsicFieldLoop {
  int stable = 7;

  public int compute(int rounds) {
    int total = 0;
    for (int index = -rounds; index < rounds; index++) {
      total += stable + Math.abs(index);
    }
    return total + stable;
  }
}
`);
    const jvm = new JVM({ classpath, jit: {
      warmupThreshold: 0,
      profileMethods: false,
      preferWholeMethodJs: true,
      structuredSsa: true,
    } });
    await jvm.loadClassByName(className);
    jvm.classInitializationState.set(className, 'INITIALIZED');
    jvm.classInitializationState.set('java/lang/Math', 'INITIALIZED');
    const method = await jvm.findMethodInHierarchy(
      className, 'compute', '(I)I');
    const generated = jvm.jit.structuredSsa.compile(method);
    t.ok(generated?.jvmStructuredSsa,
      'an arbitrarily named intrinsic caller selects structured SSA');
    t.ok(generated?.jvmStructuredFieldReadCacheCount > 0,
      'the repeated instance read creates a field cache');
    t.equal((generated.jvmStructuredSource.match(
      /ssaFieldCache0Valid = false/g) || []).length, 1,
    'an explicitly pure intrinsic only initializes, and never invalidates, the field cache');

    const receiver = {
      type: className,
      fields: {[`${className}.stable`]: 7},
    };
    const frame = new Frame(method);
    frame.className = className;
    frame.locals.splice(0, 2, receiver, 4);
    const thread = {
      id: 0, name: 'pure-intrinsic-field-test', status: 'runnable',
      pendingException: null, callStack: new Stack(),
    };
    thread.callStack.push(frame);
    t.deepEqual(generated(frame, thread, jvm.jit, false),
      {returned: true, value: 79},
      'retaining the cache preserves the Java result');
    t.end();
  });

test('short conditional state helpers stay synchronous', async (t) => {
  const classpath = compileJavaFixture(t, 'ArbitraryConditionalStateLeaf', `
public class ArbitraryConditionalStateLeaf {
  static int left, top, right, bottom;
  static void narrow(int nextLeft, int nextTop, int nextRight, int nextBottom) {
    if (left < nextLeft) left = nextLeft;
    if (top < nextTop) top = nextTop;
    if (right > nextRight) right = nextRight;
    if (bottom > nextBottom) bottom = nextBottom;
  }
  public static void run() {
    narrow(10, 20, 90, 80);
  }
}
`);
  const jvm = new JVM({
    classpath, jit: { warmupThreshold: 0, preferWholeMethodJs: true },
  });
  await jvm.loadClassByName('ArbitraryConditionalStateLeaf');
  jvm.classInitializationState.set('ArbitraryConditionalStateLeaf', 'INITIALIZED');
  const owner = jvm.classes.ArbitraryConditionalStateLeaf;
  owner.staticFields.set('left:I', 0);
  owner.staticFields.set('top:I', 0);
  owner.staticFields.set('right:I', 100);
  owner.staticFields.set('bottom:I', 100);
  const narrow = await jvm.findMethodInHierarchy(
    'ArbitraryConditionalStateLeaf', 'narrow', '(IIII)V');
  t.ok(jvm.jit.isShortSupportedHelper(narrow),
    'renamed short conditional field leaf passes the structural helper gate');
  const thread = {
    id: 0, name: 'short-conditional-leaf', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  await invoke(jvm, thread, 'ArbitraryConditionalStateLeaf', 'run', '()V', []);
  t.deepEqual([
    owner.staticFields.get('left:I'), owner.staticFields.get('top:I'),
    owner.staticFields.get('right:I'), owner.staticFields.get('bottom:I'),
  ], [10, 20, 90, 80], 'all conditional static writes execute synchronously');
  t.end();
});

test('generated field sites preserve inherited instance and static storage', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0 } });
  jvm.classes.FieldBase = {
    staticFields: new Map([['shared:I', 7]]),
    ast: { classes: [{ superClassName: null }] },
  };
  jvm.classes.FieldChild = {
    staticFields: new Map(),
    ast: { classes: [{ superClassName: 'FieldBase' }] },
  };
  jvm.classInitializationState.set('FieldBase', 'INITIALIZED');
  jvm.classInitializationState.set('FieldChild', 'INITIALIZED');
  const object = {
    type: 'FieldChild',
    fields: { 'FieldBase.value': 11 },
  };
  const instanceSite = jvm.jit.registerFieldSite([
    null, 'FieldBase', ['value', 'I'],
  ]);
  const staticSite = jvm.jit.registerFieldSite([
    null, 'FieldChild', ['shared', 'I'],
  ]);

  t.equal(jvm.jit.getFieldAt(instanceSite, object), 11,
    'field site resolves inherited instance storage');
  jvm.jit.putFieldAt(instanceSite, object, 12);
  t.equal(object.fields['FieldBase.value'], 12,
    'cached instance field site writes the resolved owner slot');
  t.equal(jvm.jit.getStaticSyncAt(staticSite), 7,
    'static field site resolves inherited static storage');
  jvm.jit.putStaticSyncAt(staticSite, 8);
  t.equal(jvm.classes.FieldBase.staticFields.get('shared:I'), 8,
    'cached static field site writes the declaring class storage');
  t.end();
});

test('structural primitive array-copy intrinsic preserves overlap semantics', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0 } });
  const prefix = [
    'aload_0', 'aload_2', 'if_acmpne', 'iload_1', 'iload_3',
    'if_icmpne', 'return', 'iload_3', 'iload_1', 'if_icmple',
  ];
  const body = [];
  for (let i = 0; i < 16; i += 1) body.push('iaload', 'iastore');
  const method = {
    attributes: [{
      type: 'code',
      code: { codeItems: [...prefix, ...body].map((instruction) => ({ instruction })) },
    }],
  };
  const intrinsic = jvm.jit.getSynchronousIntrinsic(method, '([II[III)V');
  t.equal(typeof intrinsic, 'function', 'unrolled primitive copy shape is recognized');

  const source = [1, 2, 3, 4];
  const destination = [0, 0, 0, 0];
  intrinsic([source, 1, destination, 0, 3], 0);
  t.deepEqual(destination, [2, 3, 4, 0], 'distinct arrays copy the selected range');

  const overlapping = [1, 2, 3, 4, 5];
  intrinsic([overlapping, 0, overlapping, 1, 4], 0);
  t.deepEqual(overlapping, [1, 1, 2, 3, 4], 'overlapping copies retain memmove ordering');

  const identical = [1, 2, 3];
  t.doesNotThrow(() => intrinsic([identical, 99, identical, 99, -1], 0),
    'identical ranges return before bounds checks like the Java method');
  t.equal(jvm.jit.intrinsicArrayCopyNoopCount, 1,
    'identical range is counted as an eliminated copy');
  t.equal(jvm.jit.intrinsicArrayCopyWithinCount, 1,
    'overlapping self-copy uses the native memmove path');

  method.name = 'copy';
  method.descriptor = '([II[III)V';
  method.flags = ['static'];
  jvm.classes.Copies = {
    ast: { classes: [{ superClassName: null, items: [{ type: 'method', method }] }] },
  };
  jvm.classInitializationState.set('Copies', 'INITIALIZED');
  jvm.jit.supportCache.set(method, true);
  const siteId = jvm.jit.registerSyncCallSite('invokestatic', {
    arg: ['Method', 'Copies', ['copy', '([II[III)V']],
  });
  const fastSource = [4, 5, 6];
  const fastDestination = [0, 0, 0];
  const frame = { stack: { items: [fastSource, 0, fastDestination, 0, 3] } };
  jvm.jit.tryInvokeSyncAt(siteId, frame, {});
  t.deepEqual(fastDestination, [4, 5, 6], 'resolved intrinsic call site copies correctly');
  t.ok(jvm.jit.syncCallSites[siteId].fastIntrinsic,
    'first resolution installs the direct intrinsic call-site target');

  frame.stack.items.push(fastDestination, 0, fastDestination, 1, 2);
  jvm.jit.tryInvokeSyncAt(siteId, frame, {});
  t.deepEqual(fastDestination, [4, 4, 5], 'direct intrinsic call site preserves overlap');
  t.equal(frame.stack.items.length, 0, 'direct intrinsic consumes its arguments');

  jvm.jit.structuredSsa.enabled = true;
  const callerInstructions = [
    'iconst_0', 'istore', 'iload', 'iconst_1', { op: 'if_icmpge', arg: 'Lreturn' },
    'aload_0', 'iload_1', 'aload_2', 'iload_3', 'iload',
    { op: 'invokestatic', arg: ['Method', 'Copies', ['copy', '([II[III)V']] },
    { op: 'iinc', varnum: 5, incr: 1 }, { op: 'goto', arg: 'Lloop' }, 'return',
  ];
  callerInstructions[1] = { op: 'istore', arg: 5 };
  callerInstructions[2] = { op: 'iload', arg: 5 };
  callerInstructions[9] = { op: 'iload', arg: 4 };
  const caller = {
    name: 'arbitraryCopyLoop', descriptor: '([II[III)V', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: callerInstructions.map((instruction, index) => ({
        labelDef: index === 2 ? 'Lloop:' : index === 13 ? 'Lreturn:' : `L${index}:`,
        instruction,
      })),
      localsSize: '6', stackSize: '5', exceptionTable: [],
    } }],
  };
  const directGenerated = jvm.jit.structuredSsa.compile(caller);
  t.ok(directGenerated?.jvmStructuredSsa,
    'loop caller with a verified copy shape selects structured SSA');
  t.ok(directGenerated.jvmStructuredSource.includes('primitiveArrayCopyDirect') &&
      !directGenerated.jvmStructuredSource.includes('tryInvokeSyncAt'),
    'verified copy intrinsic is emitted positionally without generic dispatch');

  const directSource = [9, 8, 7, 6];
  const directDestination = [0, 0, 0, 0];
  const directFrame = new Frame(caller);
  directFrame.locals.splice(0, 5, directSource, 1, directDestination, 0, 3);
  const directThread = { status: 'runnable', callStack: new Stack() };
  directThread.callStack.push(directFrame);
  directGenerated(directFrame, directThread, jvm.jit, false);
  t.deepEqual(directDestination, [8, 7, 6, 0],
    'positionally emitted copy preserves distinct-array results');

  const throwingFrame = new Frame(caller);
  throwingFrame.locals.splice(0, 5, null, 0, directDestination, 0, 1);
  directThread.callStack.push(throwingFrame);
  let directThrown;
  try {
    directGenerated(throwingFrame, directThread, jvm.jit, false);
  } catch (error) {
    directThrown = error;
  }
  t.equal(directThrown?.type, 'java/lang/NullPointerException',
    'positionally emitted copy preserves the JVM null exception');
  t.equal(throwingFrame.pc, 10, 'direct intrinsic exception records the invoke PC');
  t.deepEqual(throwingFrame.stack.items, [null, 0, directDestination, 0, 1],
    'direct intrinsic exception reconstructs call operands in JVM order');
  directThread.callStack.pop();
  t.end();
});

test('structured SSA emits verified clipped static spans without call dispatch',
  async (t) => {
  const jvm = new JVM({ jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: true,
  } });
  const field = (name, descriptor = 'I') => [null, 'SpanShape', [name, descriptor]];
  const top = field('top'), bottom = field('bottom'), left = field('left');
  const right = field('right'), width = field('width'), pixelsField = field('pixels', '[I');
  const spanOps = [
    'iload_1', ['getstatic', top], 'if_icmplt', 'iload_1', ['getstatic', bottom],
    'if_icmplt', 'return', 'iload_0', ['getstatic', left], 'if_icmpge', 'iload_2',
    ['getstatic', left], 'iload_0', 'isub', 'isub', 'istore_2', ['getstatic', left],
    'istore_0', 'iload_0', 'iload_2', 'iadd', ['getstatic', right], 'if_icmple',
    ['getstatic', right], 'iload_0', 'isub', 'istore_2', 'iload_0', 'iload_1',
    ['getstatic', width], 'imul', 'iadd', ['istore', 4], 'iconst_0', ['istore', 5],
    ['iload', 5], 'iload_2', 'if_icmpge', ['getstatic', pixelsField], ['iload', 4],
    ['iload', 5], 'iadd', 'iload_3', 'iastore', 'iinc', 'goto', 'return',
  ];
  const spanMethod = {
    name: 'arbitrarySpan', descriptor: '(IIII)V', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: spanOps.map((entry) => ({
        instruction: Array.isArray(entry) ? { op: entry[0], arg: entry[1] } : entry,
      })),
      localsSize: '6', stackSize: '4', exceptionTable: [],
    } }],
  };
  const call = { op: 'invokestatic',
    arg: ['Method', 'SpanShape', ['arbitrarySpan', '(IIII)V']] };
  const callerInstructions = [
    'iconst_0', { op: 'istore', arg: 4 }, { op: 'iload', arg: 4 }, 'iconst_1',
    { op: 'if_icmpge', arg: 'Lreturn' }, 'iload_0', 'iload_1', 'iload_2', 'iload_3',
    call, { op: 'iinc', varnum: 4, incr: 1 }, { op: 'goto', arg: 'Lloop' }, 'return',
  ];
  const caller = {
    name: 'arbitrarySpanLoop', descriptor: '(IIII)V', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: callerInstructions.map((instruction, index) => ({
        labelDef: index === 2 ? 'Lloop:' : index === 12 ? 'Lreturn:' : `L${index}:`,
        instruction,
      })),
      localsSize: '5', stackSize: '4', exceptionTable: [],
    } }],
  };
  const pixels = new Array(32).fill(0);
  jvm.classes.SpanShape = {
    staticFields: new Map([
      ['top:I', 0], ['bottom:I', 4], ['left:I', 0], ['right:I', 8], ['width:I', 8],
      ['pixels:[I', pixels],
    ]),
    ast: { classes: [{ superClassName: null,
      items: [{ type: 'method', method: spanMethod }, { type: 'method', method: caller }] }] },
  };
  jvm.classInitializationState.set('SpanShape', 'INITIALIZED');

  const intrinsic = jvm.jit.getSynchronousIntrinsic(spanMethod, '(IIII)V');
  t.equal(intrinsic?.jvmDirectKind, 'clippedStaticSpan',
    'descriptor, bytecodes, and repeated field identities recognize an arbitrary method name');
  const generated = jvm.jit.structuredSsa.compile(caller);
  t.ok(generated?.jvmStructuredSsa, 'verified span caller selects structured SSA');
  t.ok(generated.jvmStructuredSource.includes('clippedStaticSpanDirectAt') &&
      !generated.jvmStructuredSource.includes('tryInvokeSyncAt'),
    'verified span is emitted positionally without generic call dispatch');

  const thread = { status: 'runnable', callStack: new Stack() };
  const frame = new Frame(caller);
  frame.locals.splice(0, 4, -1, 1, 4, 0x123456);
  thread.callStack.push(frame);
  generated(frame, thread, jvm.jit, false);
  t.deepEqual(pixels.slice(8, 16), [0x123456, 0x123456, 0x123456, 0, 0, 0, 0, 0],
    'direct span preserves clipping and pixel writes');

  const genericClass = 'GenericSpanShape';
  const genericClasspath = compileJavaFixture(t, genericClass, `
public final class GenericSpanShape {
  static int top;
  static int bottom;
  static int left;
  static int right;
  static int width;
  static int[] pixels;

  static void span(int x, int y, int count, int color) {
    if (y < top || y >= bottom) return;
    if (x < left) {
      count -= left - x;
      x = left;
    }
    if (x + count > right) count = right - x;
    int base = x + y * width;
    for (int index = 0; index < count; index++) {
      pixels[base + index] = color;
    }
  }

  static void rows(int color) {
    for (int y = 0; y < 2; y++) span(0, y, 2, color);
  }

  static void dynamicRows(int item, int color) {
    for (int row = 0; row < 16; row++) {
      int sample = item + row;
      int x = sample * 17 % 80 - 8;
      int y = sample & 63;
      int count = 8 + sample * 13 % 56;
      span(x, y, count, color + row * 0x10203);
    }
  }
}
`);
  const genericJvm = new JVM({ classpath: genericClasspath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: false,
    checkedLeafDirectPositional: true,
  } });
  const genericClassData = await genericJvm.loadClassByName(genericClass);
  genericJvm.classInitializationState.set(genericClass, 'INITIALIZED');
  const genericFields = genericClassData.staticFields;
  genericFields.set('top:I', 0);
  genericFields.set('bottom:I', 4);
  genericFields.set('left:I', 0);
  genericFields.set('right:I', 8);
  genericFields.set('width:I', 8);
  const firstStaticPixels = new Array(32).fill(0);
  firstStaticPixels.type = '[I';
  genericFields.set('pixels:[I', firstStaticPixels);
  const genericSpanMethod = await genericJvm.findMethodInHierarchy(
    genericClass, 'span', '(IIII)V');
  const genericSpan = genericJvm.jit.structuredSsa.compile(genericSpanMethod);
  t.ok(genericSpan?.jvmStructuredSsa &&
      genericSpan.jvmRestoringDirectPositionalSource
        ?.includes('ssaEntryStaticValue') &&
      genericSpan.jvmRestoringDirectPositionalSource
        ?.includes('ssaArrayRangeGuard'),
    'generic span SSA hoists stable statics and versions its affine store range');
  const spanSource = genericSpan.jvmRestoringDirectPositionalSource;
  const fastArmMatch =
    /if \(!\(ssaRuntimeCoarseLoop\d+ && ssaArrayRangeGuard\d+\)\)/.exec(
      spanSource);
  const fastArmStart = fastArmMatch?.index ?? -1;
  const fastStoreMatch = /ssaEntryStaticArrayData\d+\[[^\n]+\] =/
    .exec(spanSource.slice(fastArmStart));
  const fastStore = fastStoreMatch
    ? fastArmStart + fastStoreMatch.index : -1;
  const rangeDeopt = spanSource.indexOf(
    "reason: 'structured SSA range guard'", fastArmStart);
  t.ok(fastArmStart >= 0 && fastStore > fastArmStart &&
      rangeDeopt > fastArmStart && rangeDeopt < fastStore,
    'the restoring entry deopts at a failed guard then runs one direct-store loop');
  t.notOk(/if \(!ssaArrayRangeGuard\d+ &&/.test(
    spanSource.slice(fastStore)),
  'the restoring function does not duplicate a checked slow loop');
  const checkedLeaf = genericSpan.jvmCheckedLeafDirectPositionalBody;
  const checkedLeafSource =
    genericSpan.jvmCheckedLeafDirectPositionalSource || '';
  t.equal(typeof checkedLeaf, 'function',
    'one bounded call-free loop publishes a compact checked leaf ABI');
  t.notOk(checkedLeafSource.includes('helpers.materialize(') ||
      checkedLeafSource.includes('helpers.arrayStore('),
  'the checked leaf contains no successful-path Frame or array helper');
  const genericRowsMethod = await genericJvm.findMethodInHierarchy(
    genericClass, 'rows', '(I)V');
  const genericRows = genericJvm.jit.structuredSsa.compile(genericRowsMethod);
  t.equal(genericRows?.jvmStructuredCapturedCheckedLeafCallCount, 1,
    'a generic caller snapshots one verified checked-child static capture set');
  t.equal(genericRows?.jvmStructuredLexicalVoidFastPathCallCount, 1,
    'a proven synchronous void child keeps fallback bookkeeping off its success path');
  t.notOk(genericRows.jvmStructuredContinuation,
    'captured child statics resume canonically rather than surviving a scheduler slice');
  const runGenericRows = (color, debug = false) => {
    const rowsThread = {
      status: 'runnable', pendingException: null, callStack: new Stack(),
    };
    const rowsFrame = new Frame(genericRowsMethod);
    rowsFrame.className = genericClass;
    rowsFrame.locals[0] = color;
    rowsThread.callStack.push(rowsFrame);
    const result = genericRows(
      rowsFrame, rowsThread, genericJvm.jit, debug, false);
    return { result, frame: rowsFrame, thread: rowsThread };
  };
  firstStaticPixels.fill(0);
  runGenericRows(17);
  t.deepEqual(firstStaticPixels.slice(0, 10),
    [17, 17, 0, 0, 0, 0, 0, 0, 17, 17],
    'captured checked child preserves repeated generated caller stores');
  const runGenericSpan = (x, y, count, color, debug = false) => {
    const genericThread = {
      status: 'runnable', pendingException: null, callStack: new Stack(),
    };
    const genericFrame = new Frame(genericSpanMethod);
    genericFrame.className = genericClass;
    genericFrame.locals.splice(0, 4, x, y, count, color);
    genericThread.callStack.push(genericFrame);
    let result;
    let error;
    try {
      result = genericSpan(
        genericFrame, genericThread, genericJvm.jit, debug);
    } catch (thrownError) {
      error = thrownError;
    }
    return { frame: genericFrame, thread: genericThread, result, error };
  };
  runGenericSpan(0, 1, 2, 11);
  const reboundStaticPixels = new Array(32).fill(0);
  reboundStaticPixels.type = '[I';
  genericFields.set('pixels:[I', reboundStaticPixels);
  runGenericSpan(2, 1, 2, 22);
  t.deepEqual(firstStaticPixels.slice(8, 12), [11, 11, 0, 0],
    'entry static cache leaves the previous surface untouched after rebinding');
  t.deepEqual(reboundStaticPixels.slice(8, 12), [0, 0, 22, 22],
    'the next generated entry reloads the rebound static surface');
  reboundStaticPixels.fill(0);
  runGenericRows(23);
  t.deepEqual(reboundStaticPixels.slice(0, 10),
    [23, 23, 0, 0, 0, 0, 0, 0, 23, 23],
    'captured child reloads a rebound static surface at the next caller entry');

  reboundStaticPixels.fill(0);
  const checkedThread = {
    status: 'runnable', pendingException: null, callStack: new Stack(),
  };
  checkedLeaf(genericJvm.jit, 1, 1, 2, 29, checkedThread, true);
  t.deepEqual(reboundStaticPixels.slice(8, 12), [0, 29, 29, 0],
    'the compact leaf preserves valid clipped stores');

  const rejectedPixels = new Array(10).fill(0);
  rejectedPixels.type = '[I';
  genericFields.set('right:I', 20);
  genericFields.set('pixels:[I', rejectedPixels);
  t.equal(checkedLeaf(
    genericJvm.jit, 7, 0, 5, 44, checkedThread, true),
  genericJvm.jit.asyncInvokeSentinel(),
  'a failed leaf range predicate returns to canonical invocation');
  t.ok(rejectedPixels.every((value) => value === 0),
    'checked-leaf rejection occurs before its first guest effect');
  genericFields.set('right:I', 8);
  genericFields.set('pixels:[I', reboundStaticPixels);

  reboundStaticPixels.fill(0);
  const debuggerFallback = runGenericSpan(0, 1, 2, 33, true);
  t.ok(debuggerFallback.result?.deopt,
    'generic span debugger guard uses the canonical fallback');
  t.ok(reboundStaticPixels.every((value) => value === 0),
    'debugger guard runs before cached static reads can cause a side effect');

  const shortPixels = new Array(10).fill(0);
  shortPixels.type = '[I';
  genericFields.set('right:I', 20);
  genericFields.set('pixels:[I', shortPixels);
  const rangedBounds = runGenericSpan(7, 0, 5, 44);
  const storePc = genericJvm.jit.getCodeItems(genericSpanMethod)
    .findIndex((item) =>
      (item.instruction?.op || item.instruction) === 'iastore');
  t.equal(rangedBounds.error?.type, 'java/lang/ArrayIndexOutOfBoundsException',
    'failed affine range guard retains the Java bounds exception');
  t.deepEqual(shortPixels.slice(7), [44, 44, 44],
    'failed affine range guard retains stores before the exceptional iteration');
  t.equal(rangedBounds.frame.pc, storePc,
    'range-versioned store records the exact throwing bytecode PC');
  t.equal(rangedBounds.frame.locals[5], 3,
    'range-versioned store materializes the exact induction value');
  t.deepEqual(rangedBounds.frame.stack.items, [shortPixels, 10, 44],
    'range-versioned store materializes its exact JVM operands');
  genericFields.set('right:I', 8);

  jvm.classes.SpanShape.staticFields.set('pixels:[I', null);
  const throwingFrame = new Frame(caller);
  throwingFrame.locals.splice(0, 4, 0, 1, 1, 7);
  thread.callStack.push(throwingFrame);
  let thrown;
  try { generated(throwingFrame, thread, jvm.jit, false); } catch (error) { thrown = error; }
  t.equal(thrown?.type, 'java/lang/NullPointerException',
    'direct span preserves the JVM null exception');
  t.equal(throwingFrame.pc, 9, 'direct span exception records the exact invoke PC');
  t.deepEqual(throwingFrame.stack.items, [0, 1, 1, 7],
    'direct span reconstructs call operands in JVM order');
  thread.callStack.pop();

  const untouched = new Array(32).fill(0);
  jvm.classes.SpanShape.staticFields.set('pixels:[I', untouched);
  jvm.classInitializationState.set('SpanShape', 'UNINITIALIZED');
  const guardedFrame = new Frame(caller);
  guardedFrame.locals.splice(0, 4, 0, 1, 1, 9);
  thread.callStack.push(guardedFrame);
  const guarded = generated(guardedFrame, thread, jvm.jit, false);
  t.ok(guarded?.deopt, 'runtime class-initialization guard falls back');
  t.equal(guardedFrame.pc, 9, 'guard falls back at the unexecuted call');
  t.deepEqual(guardedFrame.stack.items, [0, 1, 1, 9],
    'guard reconstructs the unconsumed call operands');
  t.ok(untouched.every((value) => value === 0), 'guard runs before span side effects');
  thread.callStack.pop();
  t.end();
});

test('structured SSA hoists cold-linked loop statics per generated entry',
  async (t) => {
  const className = 'ColdLinkedStaticLoopHarness';
  const classpath = compileJavaFixture(t, className, `
public final class ColdLinkedStaticLoopHarness {
  static int width = 8;
  static int[] pixels = new int[16];
  static void fill(int start, int count, int color) {
    for (int index = 0; index < count; index++) {
      pixels[start + index] = color + width;
    }
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    profileMethods: false,
    structuredSsa: true,
    guestKernelOracles: false,
  } });
  const classData = await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className, 'fill', '(III)V');
  // Compile before the synthetic test performs <clinit>'s field writes. This
  // reproduces a hot method discovered while its static targets are cold.
  const generated = jvm.jit.structuredSsa.compile(method);
  const sourceText = generated?.jvmRestoringDirectPositionalSource || '';
  t.ok(sourceText.includes('helpers.getStaticSyncAt') &&
      sourceText.includes('ssaEntryStaticValue') &&
      !sourceText.includes('ssaEntryStaticValid'),
  'the scalar entry links cold statics before emitting unconditional uses');

  const run = (pixels, start, count, color) => {
    classData.staticFields.set('width:I', 8);
    classData.staticFields.set('pixels:[I', pixels);
    const frame = new Frame(method);
    frame.className = className;
    frame.locals.splice(0, 3, start, count, color);
    const thread = {
      status: 'runnable', pendingException: null, callStack: new Stack(),
    };
    thread.callStack.push(frame);
    let error = null;
    try {
      generated(frame, thread, jvm.jit, false);
    } catch (thrown) {
      error = thrown;
    }
    return {frame, error};
  };
  const first = new Array(16).fill(0);
  first.type = '[I';
  t.equal(run(first, 1, 3, 10).error, null,
    'the unresolved first entry links and executes normally');
  t.deepEqual(first.slice(0, 6), [0, 18, 18, 18, 0, 0],
    'the cold path preserves every loop store');

  const rebound = new Array(16).fill(0);
  rebound.type = '[I';
  t.equal(run(rebound, 4, 2, 20).error, null,
    'the linked entry reloads the current static storage');
  t.deepEqual(first.slice(0, 6), [0, 18, 18, 18, 0, 0],
    'a later invocation does not mutate the previous static array');
  t.deepEqual(rebound.slice(2, 8), [0, 0, 28, 28, 0, 0],
    'rebinding remains visible at the next generated entry');

  const siteId = jvm.jit.registerSyncCallSite('invokestatic', {
    arg: ['Method', className, ['fill', '(III)V']],
  });
  const callerMethod = {
    name: 'caller', descriptor: '()V',
    attributes: [{ type: 'code', code: {
      codeItems: [], exceptionTable: [], localsSize: '0', stackSize: '3',
    } }],
  };
  const callerFrame = new Frame(callerMethod);
  callerFrame.className = 'GenericCaller';
  callerFrame.stack.items.push(0, 1, 30);
  const callerThread = {
    status: 'runnable', pendingException: null, callStack: new Stack(),
  };
  callerThread.callStack.push(callerFrame);
  jvm.jit.tryInvokeSyncAt(siteId, callerFrame, callerThread);
  const positional = jvm.jit.syncCallSites[siteId].fastPositional?.invoke;
  t.equal(typeof positional, 'function',
    'ordinary linkage publishes the name-independent scalar ABI');
  const directPixels = new Array(16).fill(0);
  directPixels.type = '[I';
  classData.staticFields.set('pixels:[I', directPixels);
  positional(5, 2, 40, callerThread, true);
  t.deepEqual(directPixels.slice(3, 9), [0, 0, 48, 48, 0, 0],
    'the scalar ABI reloads a rebound static and preserves exact stores');
  t.end();
});

test('structured SSA versions cyclic primitive-array indexes', async (t) => {
  const className = 'CyclicArrayRangeHarness';
  const classpath = compileJavaFixture(t, className, `
public final class CyclicArrayRangeHarness {
  static void copy(int[] destination, int[] source, int destinationIndex,
      int width, int count, int phase, int sourceIndex) {
    for (int index = 0; index < count; index++) {
      destination[destinationIndex++] = source[sourceIndex++];
      if (++phase == width) {
        sourceIndex -= width;
        phase = 0;
      }
    }
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: false,
  } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className, 'copy', '([I[IIIIII)V');
  const generated = jvm.jit.structuredSsa.compile(method);
  t.equal(generated?.jvmStructuredCyclicRangeCount, 1,
    'the verifier-derived increment/wrap recurrence receives one range proof');
  t.ok(generated.jvmRestoringDirectPositionalSource
      ?.includes('ssaArrayRangeGuard'),
  'the scalar source emits a guarded fast loop for the recurrence');

  const run = (destination, source, destinationIndex,
    width, count, phase, sourceIndex) => {
    const frame = new Frame(method);
    frame.className = className;
    frame.locals.splice(0, 7, destination, source, destinationIndex,
      width, count, phase, sourceIndex);
    const thread = {
      status: 'runnable', pendingException: null, callStack: new Stack(),
    };
    thread.callStack.push(frame);
    let error = null;
    try {
      generated(frame, thread, jvm.jit, false);
    } catch (thrown) {
      error = thrown;
    }
    return {frame, error};
  };
  const source = [10, 20, 30, 40];
  source.type = '[I';
  const destination = new Array(6).fill(0);
  destination.type = '[I';
  t.equal(run(destination, source, 0, 4, 6, 2, 2).error, null,
    'a valid cyclic window executes through the versioned loop');
  t.deepEqual(destination.slice(), [30, 40, 10, 20, 30, 40],
    'cyclic source order is exact');

  const shortSource = [7, 8, 9, 10];
  shortSource.type = '[I';
  const partialDestination = new Array(4).fill(0);
  partialDestination.type = '[I';
  const failed = run(partialDestination, shortSource, 0, 4, 2, 0, 3);
  const loadPc = jvm.jit.getCodeItems(method).findIndex((item) =>
    (item.instruction?.op || item.instruction) === 'iaload');
  t.equal(failed.error?.type, 'java/lang/ArrayIndexOutOfBoundsException',
    'a rejected cyclic proof retains the Java bounds exception');
  t.deepEqual(partialDestination.slice(), [10, 0, 0, 0],
    'the slow loop retains stores before the exceptional iteration');
  t.equal(failed.frame.pc, loadPc,
    'the failing source load records its exact bytecode PC');
  t.deepEqual(failed.frame.stack.items,
    [partialDestination, 1, shortSource, 4],
    'the slow loop reconstructs the exact nested array operands');
  t.end();
});

test('structured SSA proves complete nested cyclic array layouts', async (t) => {
  const className = 'NestedCyclicArrayRangeHarness';
  const classpath = compileJavaFixture(t, className, `
public final class NestedCyclicArrayRangeHarness {
  static void copy(int destinationIndex, int sourceWidth, int rowCount,
      int sourceRow, byte tag, int[] destination, int copyWidth,
      int[] source, int destinationRowSkip, int sourceX,
      int sourceIndex, int sourceHeight) {
    if (tag != -64) return;
    int sourceStartX = sourceX;
    int sourceCycle = sourceHeight * sourceWidth;
    for (int row = 0; row < rowCount; row++) {
      for (int column = 0; column < copyWidth; column++) {
        destination[destinationIndex++] = source[sourceIndex++];
        if (++sourceX == sourceWidth) {
          sourceIndex -= sourceWidth;
          sourceX = 0;
        }
      }
      destinationIndex += destinationRowSkip;
      sourceIndex = sourceIndex - sourceX + sourceStartX + sourceWidth;
      sourceX = sourceStartX;
      if (++sourceRow == sourceHeight) {
        sourceRow = 0;
        sourceIndex -= sourceCycle;
      }
    }
  }

  static void callCopy(int[] destination, int[] source, int item) {
    int sourceX = item & 3;
    int sourceRow = item & 2;
    copy(0, 4, 2, sourceRow, (byte) -64, destination, 4,
      source, 0, sourceX, sourceRow * 4 + sourceX, 3);
  }

  static void altered(int destinationIndex, int sourceWidth, int rowCount,
      int sourceRow, byte tag, int[] destination, int copyWidth,
      int[] source, int destinationRowSkip, int sourceX,
      int sourceIndex, int sourceHeight) {
    if (tag != -64) return;
    int sourceStartX = sourceX;
    int sourceCycle = sourceHeight * sourceWidth;
    for (int row = 0; row < rowCount; row++) {
      for (int column = 0; column < copyWidth; column++) {
        destination[destinationIndex++] = source[sourceIndex++];
        if (++sourceX == sourceWidth) {
          sourceIndex -= sourceWidth;
          sourceX = 0;
        }
      }
      destinationIndex += destinationRowSkip;
      sourceIndex += sourceWidth;
      sourceX = sourceStartX;
      if (++sourceRow == sourceHeight) {
        sourceRow = 0;
        sourceIndex -= sourceCycle;
      }
    }
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: false,
    checkedLeafDirectPositional: true,
  } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const descriptor = '(IIIIB[II[IIIII)V';
  const method = await jvm.findMethodInHierarchy(
    className, 'copy', descriptor);
  const generated = jvm.jit.getGeneratedFunction(method);
  const checked = generated?.jvmCheckedLeafDirectPositionalBody;
  const checkedSource =
    generated?.jvmCheckedLeafDirectPositionalSource || '';
  const trustedChecked =
    generated?.jvmTrustedCheckedLeafDirectPositionalBody;
  const trustedCheckedSource =
    generated?.jvmTrustedCheckedLeafDirectPositionalSource || '';
  t.equal(generated?.jvmStructuredHoistedArrayRangeGuardCount, 2,
    'both destination and full cyclic source rectangles are entry guarded');
  t.equal(typeof checked, 'function',
    'a fully bounded nested numeric region publishes a checked leaf');
  t.equal(typeof trustedChecked, 'function',
    'the checked leaf also publishes a trusted nested-call entry');
  t.notOk(trustedCheckedSource.includes('nestedEntryGuarded'),
    'the trusted entry specializes the already-dominated outer guard');
  t.ok(trustedCheckedSource.includes(
    'ssaRestoringClassInitializationGuard'),
  'the trusted entry retains its class-initialization epoch guard');
  const nestedPositional = jvm.jit.getPositionalGeneratedInvoker({
    op: 'invokestatic', descriptor, params: new Array(12),
  }, { method, lookupClass: className, generated });
  t.equal(nestedPositional?.jvmRawInvoke, trustedChecked,
    'generated positional call sites select the trusted nested ABI');
  t.notOk(checkedSource.includes('safePointBudget') ||
      checkedSource.includes('ssaRuntimeCoarse') ||
      checkedSource.includes('helpers.arrayLoad(') ||
      checkedSource.includes('helpers.arrayStore('),
  'the atomic checked leaf contains no dead scheduler or checked-array path');
  const outerLoop = checkedSource.indexOf('L3: while');
  const rangeBailout = checkedSource.search(
    /if \(!\([^\n]*\.length[^\n]*&&[^\n]*\.length[^\n]*\)\)/);
  t.ok(rangeBailout >= 0 && rangeBailout < outerLoop,
    'the combined layout guard executes once before the outer loop');

  const source = Array.from({length: 12}, (_unused, index) => index);
  source.type = '[I';
  const destination = new Array(8).fill(-1);
  destination.type = '[I';
  const thread = {
    status: 'runnable', pendingException: null, callStack: new Stack(),
  };
  const valid = checked(jvm.jit,
    0, 4, 2, 2, -64, destination, 4,
    source, 0, 2, 10, 3, thread, true);
  t.notEqual(valid, jvm.jit.asyncInvokeSentinel(),
    'a valid dynamic rectangular layout enters the checked leaf');
  t.deepEqual(destination.slice(), [10, 11, 8, 9, 2, 3, 0, 1],
    'the leaf preserves horizontal and vertical wrap order exactly');

  destination.fill(-1);
  const trustedValid = trustedChecked(jvm.jit,
    0, 4, 2, 2, -64, destination, 4,
    source, 0, 2, 10, 3, thread);
  t.notEqual(trustedValid, jvm.jit.asyncInvokeSentinel(),
    'the trusted nested-call entry accepts the same valid layout');
  t.deepEqual(destination.slice(), [10, 11, 8, 9, 2, 3, 0, 1],
    'trusted entry execution preserves the checked leaf result');

  destination.fill(63);
  jvm.classInitializationState.set(className, 'UNINITIALIZED');
  jvm.classInitializationEpoch += 1;
  t.equal(trustedChecked(jvm.jit,
    0, 4, 2, 2, -64, destination, 4,
    source, 0, 2, 10, 3, thread),
  jvm.jit.asyncInvokeSentinel(),
  'the trusted entry still rejects a changed class lifecycle');
  t.ok(destination.every((value) => value === 63),
    'class-lifecycle rejection precedes every trusted-entry write');
  jvm.classInitializationState.set(className, 'INITIALIZED');
  jvm.classInitializationEpoch += 1;

  const shortSource = source.slice(0, 11);
  shortSource.type = '[I';
  const untouched = new Array(8).fill(77);
  untouched.type = '[I';
  t.equal(checked(jvm.jit,
    0, 4, 2, 2, -64, untouched, 4,
    shortSource, 0, 2, 10, 3, thread, true),
  jvm.jit.asyncInvokeSentinel(),
  'an incomplete backing rectangle rejects the checked entry');
  t.equal(trustedChecked(jvm.jit,
    0, 4, 2, 2, -64, untouched, 4,
    shortSource, 0, 2, 10, 3, thread),
  jvm.jit.asyncInvokeSentinel(),
  'the trusted entry retains the same before-effects range rejection');
  t.ok(untouched.every((value) => value === 77),
    'the rejected layout performs no guest write');
  t.equal(checked(jvm.jit,
    0, 4, 1025, 2, -64, untouched, 4,
    source, 0, 2, 10, 3, thread, true),
  jvm.jit.asyncInvokeSentinel(),
  'an oversized dynamic trip count retains scheduler-owned execution');

  const callerMethod = await jvm.findMethodInHierarchy(
    className, 'callCopy', '([I[II)V');
  const callerGenerated = jvm.jit.getGeneratedFunction(callerMethod);
  const callerChecked = callerGenerated?.jvmCheckedLeafDirectPositionalBody;
  const callerCheckedSource =
    callerGenerated?.jvmCheckedLeafDirectPositionalSource || '';
  t.equal(typeof callerChecked, 'function',
    'a capture-free checked child is inserted into a checked wrapper caller');
  t.equal(callerGenerated?.jvmStructuredLexicalCheckedLeafCallCount, 1,
    'the generic tier records one lexical checked-leaf call');
  t.equal(callerGenerated?.jvmStructuredLexicalCheckedLeafWrapper, true,
    'the call-only wrapper records its before-effects bailout proof');
  t.notOk(callerCheckedSource.includes('ssaFastPositional') ||
      callerCheckedSource.includes('tryInvokeSyncAt') ||
      callerCheckedSource.includes('helpers.materialize(') ||
      callerCheckedSource.includes('new plan.Frame'),
  'the wrapper checked leaf contains no child dispatch or Frame fallback');
  const callerDestination = new Array(8).fill(-1);
  callerDestination.type = '[I';
  t.notEqual(callerChecked(jvm.jit, callerDestination, source, 2,
    thread, true), jvm.jit.asyncInvokeSentinel(),
  'the wrapper admits a layout satisfying the inserted child assumptions');
  t.deepEqual(callerDestination.slice(), [10, 11, 8, 9, 2, 3, 0, 1],
    'the lexical wrapper preserves the child cyclic writes');
  const callerRejected = new Array(8).fill(91);
  callerRejected.type = '[I';
  t.equal(callerChecked(jvm.jit, callerRejected, shortSource, 2,
    thread, true), jvm.jit.asyncInvokeSentinel(),
  'a failed inserted-child layout returns to the canonical caller');
  t.ok(callerRejected.every((value) => value === 91),
    'the wrapper rejection occurs before the child first effect');

  const frame = new Frame(method);
  frame.className = className;
  const partial = new Array(8).fill(0);
  partial.type = '[I';
  frame.locals.splice(0, 12,
    0, 4, 2, 2, -64, partial, 4,
    shortSource, 0, 2, 10, 3);
  thread.callStack.push(frame);
  let error = null;
  try {
    generated(frame, thread, jvm.jit, false);
  } catch (thrown) {
    error = thrown;
  }
  const loadPc = jvm.jit.getCodeItems(method).findIndex((item) =>
    (item.instruction?.op || item.instruction) === 'iaload');
  t.equal(error?.type, 'java/lang/ArrayIndexOutOfBoundsException',
    'a rejected leaf resumes the canonical throwing execution');
  t.deepEqual(partial.slice(0, 3), [10, 0, 0],
    'canonical fallback retains writes before the exceptional access');
  t.equal(frame.pc, loadPc,
    'canonical fallback records the precise exceptional bytecode PC');
  thread.callStack.pop();

  const altered = await jvm.findMethodInHierarchy(
    className, 'altered', descriptor);
  const alteredGenerated = jvm.jit.structuredSsa.compile(altered);
  t.equal(alteredGenerated?.jvmStructuredHoistedArrayRangeGuardCount, 1,
    'an altered row recurrence does not receive the rectangular source proof');
  t.equal(alteredGenerated?.jvmCheckedLeafDirectPositionalBody, null,
    'an unproved nested source access retains the restoring implementation');
  t.end();
});

test('structured SSA versions shrinking primitive-array windows generically', async (t) => {
  const className = 'RenamedShrinkingWindowHarness';
  const classpath = compileJavaFixture(t, className, `
public final class RenamedShrinkingWindowHarness {
  static void reorder(int[] cells, int floor, int ceiling) {
    while (ceiling >= floor + 8) {
      int ordered = 1;
      for (int cursor = floor + 4; cursor < ceiling; cursor += 4) {
        int left = cells[cursor - 4];
        int right = cells[cursor];
        if (left > right) {
          ordered = 0;
          cells[cursor - 4] = right;
          cells[cursor] = left;
          int temporary = cells[cursor - 2];
          cells[cursor - 2] = cells[cursor + 2];
          cells[cursor + 2] = temporary;
          temporary = cells[cursor - 1];
          cells[cursor - 1] = cells[cursor + 3];
          cells[cursor + 3] = temporary;
        }
      }
      if (ordered != 0) return;
      ceiling -= 4;
    }
  }

  static void applyWindow(int[] cells, int floor, int ceiling) {
    reorder(cells, floor, ceiling);
  }

  static void changedReach(int[] cells, int floor, int ceiling) {
    while (ceiling >= floor + 8) {
      int ordered = 1;
      for (int cursor = floor + 4; cursor < ceiling; cursor += 4) {
        int left = cells[cursor - 4];
        int right = cells[cursor];
        if (left > right) {
          ordered = 0;
          cells[cursor + 4] = left;
        }
      }
      if (ordered != 0) return;
      ceiling -= 4;
    }
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: false,
    checkedLeafDirectPositional: true,
  } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className, 'reorder', '([III)V');
  const generated = jvm.jit.getGeneratedFunction(method);
  const checked = generated?.jvmCheckedLeafDirectPositionalBody;
  const sourceText = generated?.jvmCheckedLeafDirectPositionalSource || '';
  t.equal(typeof checked, 'function',
    'a renamed shrinking-window shape publishes a checked leaf');
  t.equal(generated?.jvmStructuredShrinkingArrayWindowCheckedLeaf, true,
    'the generated metadata records the structural proof');
  t.equal(generated?.jvmStructuredShrinkingArrayWindowAccessCount, 12,
    'the proof covers every primitive load and store in the window');
  t.ok(sourceText.includes('ssaShrinkingArrayWindow0Delta') &&
      !sourceText.includes('Math.floor') &&
      !sourceText.includes('OuterTrips *'),
  'equal shrinking-window trip counts collapse to one algebraic guard');
  t.notOk(sourceText.includes('safePointBudget') ||
      sourceText.includes('helpers.arrayLoad(') ||
      sourceText.includes('helpers.arrayStore(') ||
      sourceText.includes('helpers.materialize('),
  'the admitted leaf contains no poll, checked access, or Frame path');
  t.notOk(/\blocal(?:5|6|7)\b/.test(sourceText),
    'write-only and single-definition source temporaries leave the checked leaf');

  const wrapperMethod = await jvm.findMethodInHierarchy(
    className, 'applyWindow', '([III)V');
  const wrapperGenerated = jvm.jit.getGeneratedFunction(wrapperMethod);
  const wrapperChecked =
    wrapperGenerated?.jvmCheckedLeafDirectPositionalBody;
  const wrapperSource =
    wrapperGenerated?.jvmCheckedLeafDirectPositionalSource || '';
  t.equal(typeof wrapperChecked, 'function',
    'an arbitrarily named wrapper receives the lexical checked child');
  t.equal(wrapperGenerated?.jvmStructuredLexicalCheckedLeafCallCount, 1,
    'the wrapper is selected by verified call and CFG structure');
  t.equal((wrapperSource.match(/helpers\.arrayData\(/g) || []).length, 1,
    'the lexical child consumes the caller raw-array operand without re-extracting it');
  t.notOk(wrapperSource.includes(
    'const ssaEntryArrayData0 = ssaEntryArrayData0'),
  'same-slot operand feeding does not introduce a temporal-dead-zone alias');

  const thread = {
    status: 'runnable', pendingException: null, callStack: new Stack(),
  };
  const cells = [
    5, 9, 50, 51,
    1, 9, 10, 11,
    3, 9, 30, 31,
  ];
  cells.type = '[I';
  t.notEqual(checked(jvm.jit, cells, 0, 12, thread, true),
    jvm.jit.asyncInvokeSentinel(),
  'an aligned in-bounds window enters the specialized leaf');
  t.deepEqual(cells.slice(), [
    1, 9, 10, 11,
    3, 9, 30, 31,
    5, 9, 50, 51,
  ], 'the generated leaf preserves record ordering and payload swaps');

  const wrappedCells = [
    5, 9, 50, 51,
    1, 9, 10, 11,
    3, 9, 30, 31,
  ];
  wrappedCells.type = '[I';
  t.notEqual(wrapperChecked(
    jvm.jit, wrappedCells, 0, 12, thread, true),
  jvm.jit.asyncInvokeSentinel(),
  'the fed operand preserves valid wrapper execution');
  t.deepEqual(wrappedCells.slice(), [
    1, 9, 10, 11,
    3, 9, 30, 31,
    5, 9, 50, 51,
  ], 'the lexical wrapper preserves every payload mutation');

  const wrappedRejected = [
    5, 9, 50, 51,
    1, 9, 10, 11,
    3, 9, 30, 31,
  ];
  wrappedRejected.type = '[I';
  const wrappedBefore = wrappedRejected.slice();
  t.equal(wrapperChecked(
    jvm.jit, wrappedRejected, 0, 10, thread, true),
  jvm.jit.asyncInvokeSentinel(),
  'a fed operand retains the child range fallback');
  t.deepEqual(wrappedRejected.slice(), wrappedBefore,
    'the wrapper range fallback still precedes every effect');

  for (const [label, input, floor, ceiling] of [
    ['misaligned', [5, 9, 50, 51, 1, 9, 10, 11, 3, 9, 30, 31], 0, 10],
    ['out-of-bounds', [5, 9, 50, 51, 1, 9, 10, 11], 0, 12],
  ]) {
    input.type = '[I';
    const before = input.slice();
    t.equal(checked(jvm.jit, input, floor, ceiling, thread, true),
      jvm.jit.asyncInvokeSentinel(),
    `${label} input returns to canonical execution`);
    t.deepEqual(input.slice(), before,
      `${label} rejection precedes the first array effect`);
  }

  const changed = await jvm.findMethodInHierarchy(
    className, 'changedReach', '([III)V');
  const changedGenerated = jvm.jit.getGeneratedFunction(changed);
  t.equal(changedGenerated?.jvmCheckedLeafDirectPositionalBody, null,
    'an access outside the verified record window is rejected structurally');
  t.end();
});

test('structured SSA lowers recursive primitive-array partitions generically', async (t) => {
  const className = 'RenamedRecursivePartitionHarness';
  const classpath = compileJavaFixture(t, className, `
public final class RenamedRecursivePartitionHarness {
  static void partitionRecords(int[] cells, int floor, int ceiling) {
    if (ceiling <= floor + 4) return;
    int pivot = floor;
    int value0 = cells[pivot];
    int value1 = cells[pivot + 1];
    int value2 = cells[pivot + 2];
    int value3 = cells[pivot + 3];
    for (int cursor = floor + 4; cursor < ceiling; cursor += 4) {
      int key = cells[cursor + 1];
      if (key < value1) {
        cells[pivot] = cells[cursor];
        cells[pivot + 1] = key;
        cells[pivot + 2] = cells[cursor + 2];
        cells[pivot + 3] = cells[cursor + 3];
        pivot += 4;
        cells[cursor] = cells[pivot];
        cells[cursor + 1] = cells[pivot + 1];
        cells[cursor + 2] = cells[pivot + 2];
        cells[cursor + 3] = cells[pivot + 3];
      }
    }
    cells[pivot] = value0;
    cells[pivot + 1] = value1;
    cells[pivot + 2] = value2;
    cells[pivot + 3] = value3;
    partitionRecords(cells, floor, pivot);
    partitionRecords(cells, pivot + 4, ceiling);
  }

  static void changedRecursion(int[] cells, int floor, int ceiling) {
    if (ceiling <= floor + 4) return;
    int pivot = floor;
    for (int cursor = floor + 4; cursor < ceiling; cursor += 4) {
      if (cells[cursor + 1] < cells[pivot + 1]) pivot += 4;
    }
    changedRecursion(cells, floor, pivot);
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: false,
    checkedLeafDirectPositional: true,
  } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className, 'partitionRecords', '([III)V');
  const generated = jvm.jit.getGeneratedFunction(method);
  const checked = generated?.jvmCheckedLeafDirectPositionalBody;
  const sourceText = generated?.jvmCheckedLeafDirectPositionalSource || '';
  const workerSource =
    generated?.jvmStructuredRecursiveArrayPartitionWorkerSource || '';
  t.equal(typeof checked, 'function',
    'an arbitrarily named recursive partition publishes a checked leaf');
  t.equal(generated?.jvmStructuredRecursiveArrayPartitionCheckedLeaf, true,
    'the generated metadata records the structural recursive proof');
  t.ok(sourceText.includes('ssaRecursiveArrayWorker'),
    'the checked entry converts the JVM array once before entering its worker');
  t.notOk(workerSource.includes('helpers.') ||
      workerSource.includes('arrayData(') ||
      workerSource.includes('__SSA_PRIMITIVE_ARRAY_ACCESS_'),
  'recursive worker calls contain no JVM dispatch or checked-array helpers');

  const thread = {
    status: 'runnable', pendingException: null, callStack: new Stack(),
  };
  const cells = [
    100, 9, 102, 103,
    200, 2, 202, 203,
    300, 7, 302, 303,
    400, 1, 402, 403,
  ];
  cells.type = '[I';
  t.notEqual(checked(jvm.jit, cells, 0, 16, thread, true),
    jvm.jit.asyncInvokeSentinel(),
  'an aligned in-bounds record window enters the recursive worker');
  t.deepEqual(cells.slice(), [
    400, 1, 402, 403,
    200, 2, 202, 203,
    300, 7, 302, 303,
    100, 9, 102, 103,
  ], 'the generated recursive worker preserves record ordering and payloads');

  for (const [label, input, floor, ceiling] of [
    ['misaligned', [100, 9, 102, 103, 200, 2, 202, 203], 0, 7],
    ['out-of-bounds', [100, 9, 102, 103, 200, 2, 202, 203], 0, 12],
  ]) {
    input.type = '[I';
    const before = input.slice();
    t.equal(checked(jvm.jit, input, floor, ceiling, thread, true),
      jvm.jit.asyncInvokeSentinel(),
    `${label} input returns to canonical execution`);
    t.deepEqual(input.slice(), before,
      `${label} rejection precedes the first recursive-array effect`);
  }

  const changed = await jvm.findMethodInHierarchy(
    className, 'changedRecursion', '([III)V');
  const changedGenerated = jvm.jit.getGeneratedFunction(changed);
  t.equal(changedGenerated?.jvmStructuredRecursiveArrayPartitionCheckedLeaf,
    false, 'an altered recursion shape is rejected structurally');
  t.equal(changedGenerated?.jvmCheckedLeafDirectPositionalBody, null,
    'the rejected shape retains the restoring implementation');
  t.end();
});

test('structured SSA publishes transactional acyclic checked leaves', async (t) => {
  const className = 'TransactionalAcyclicLeafHarness';
  const classpath = compileJavaFixture(t, className, `
public final class TransactionalAcyclicLeafHarness {
  int[] source;
  int divisor;
  static int[] destination;
  void copyDivided(int index) {
    int value = source[index] / divisor;
    destination[index] = value;
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: false,
    checkedLeafDirectPositional: true,
  } });
  const classData = await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const destination = new Array(4).fill(77);
  destination.type = '[I';
  classData.staticFields.set('destination:[I', destination);
  const method = await jvm.findMethodInHierarchy(
    className, 'copyDivided', '(I)V');
  const generated = jvm.jit.structuredSsa.compile(method);
  const checked = generated?.jvmCheckedLeafDirectPositionalBody;
  const sourceText = generated?.jvmCheckedLeafDirectPositionalSource || '';
  t.equal(typeof checked, 'function',
    'one final array effect admits a transactional checked leaf');
  t.equal(generated?.jvmStructuredTransactionalAcyclicCheckedLeaf, true,
    'the structural tier records its transactional proof');
  t.notOk(sourceText.includes('new plan.Frame') ||
      sourceText.includes('helpers.materialize(') ||
      sourceText.includes('helpers.arrayLoad(') ||
      sourceText.includes('helpers.arrayStore(') ||
      sourceText.includes('ArithmeticException'),
  'the checked leaf contains only pre-effect bailouts');

  const values = [20, 30, 40, 50];
  values.type = '[I';
  const receiver = {
    type: className,
    fields: {
      [`${className}.source`]: values,
      [`${className}.divisor`]: 10,
    },
  };
  const thread = {
    status: 'runnable', pendingException: null, callStack: new Stack(),
  };
  t.notEqual(checked(jvm.jit, receiver, 2, thread, true),
    jvm.jit.asyncInvokeSentinel(),
  'canonical fields and arrays enter the checked leaf');
  t.deepEqual(destination.slice(), [77, 77, 4, 77],
    'the admitted leaf preserves the final Java store');

  receiver.fields[`${className}.source`] = values.slice(0, 1);
  receiver.fields[`${className}.source`].type = '[I';
  t.equal(checked(jvm.jit, receiver, 2, thread, true),
    jvm.jit.asyncInvokeSentinel(),
  'a source bounds failure returns to canonical execution');
  t.deepEqual(destination.slice(), [77, 77, 4, 77],
    'source rejection occurs before the destination effect');
  receiver.fields[`${className}.source`] = values;
  receiver.fields[`${className}.divisor`] = 0;
  t.equal(checked(jvm.jit, receiver, 1, thread, true),
    jvm.jit.asyncInvokeSentinel(),
  'division by zero returns to precise canonical execution');
  t.deepEqual(destination.slice(), [77, 77, 4, 77],
    'arithmetic rejection also occurs before the destination effect');
  t.end();
});

test('structured SSA proves nonzero divisors from crossing predicates',
  async (t) => {
    const className = 'CrossingDivisionHarness';
    const classpath = compileJavaFixture(t, className, `
public final class CrossingDivisionHarness {
  static int crossing(int y0, int y1, int y, int x0, int x1) {
    if ((y0 <= y && y < y1) || (y1 <= y && y < y0)) {
      return x0 + (y - y0) * (x1 - x0) / (y1 - y0);
    }
    return 0;
  }
  static int unsafe(int y0, int y1, int y, int x0, int x1) {
    return x0 + (y - y0) * (x1 - x0) / (y1 - y0);
  }
  static int literalRemainder(int value) {
    return value % 37;
  }
}
`);
    const jvm = new JVM({ classpath, jit: {
      warmupThreshold: 0, structuredSsa: true, guestKernelOracles: false,
    } });
    await jvm.loadClassByName(className);
    jvm.classInitializationState.set(className, 'INITIALIZED');
    const descriptor = '(IIIII)I';
    const crossing = await jvm.findMethodInHierarchy(
      className, 'crossing', descriptor);
    const unsafe = await jvm.findMethodInHierarchy(
      className, 'unsafe', descriptor);
    const literal = await jvm.findMethodInHierarchy(
      className, 'literalRemainder', '(I)I');
    const crossingGenerated = jvm.jit.structuredSsa.compile(crossing);
    const unsafeGenerated = jvm.jit.structuredSsa.compile(unsafe);
    const literalGenerated = jvm.jit.structuredSsa.compile(literal);
    t.equal(crossingGenerated?.jvmStructuredDominatedArithmeticGuardCount, 1,
      'both crossing arms prove the unordered endpoints unequal');
    t.notOk(crossingGenerated?.jvmRestoringDirectPositionalSource
      ?.includes('ArithmeticException'),
    'the dominated division omits its impossible exceptional arm');
    t.ok(unsafeGenerated?.jvmRestoringDirectPositionalSource
      ?.includes('ArithmeticException'),
    'an unguarded divisor retains exact arithmetic exception machinery');
    t.equal(literalGenerated?.jvmStructuredDominatedArithmeticGuardCount, 1,
      'a nonzero integer literal proves its own divisor guard');
    t.notOk(literalGenerated?.jvmRestoringDirectPositionalSource
      ?.includes('ArithmeticException'),
    'literal division omits its statically impossible exceptional arm');
    t.end();
  });

test('structured SSA versions scaled and carried induction indexes',
  async (t) => {
  const className = 'ScaledCarriedArrayRangeHarness';
  const classpath = compileJavaFixture(t, className, `
public final class ScaledCarriedArrayRangeHarness {
  static int walk(int[] values, int bound) {
    int previous = bound - 1;
    int sum = 0;
    for (int current = 0; current < bound; current++) {
      sum += values[previous << 1];
      sum += values[(previous << 1) + 1];
      sum += values[current << 1];
      sum += values[(current << 1) + 1];
      previous = current;
    }
    return sum;
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: false,
  } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className, 'walk', '([II)I');
  const generated = jvm.jit.structuredSsa.compile(method);
  t.equal(generated?.jvmStructuredScaledIndexRangeCount, 4,
    'four shifted current/previous accesses receive structural range proofs');
  t.equal(generated?.jvmStructuredSpecializedArrayRangeAccessCount, 4,
    'the guarded direct loop removes all four successful-path checks');

  const run = (values, bound) => {
    const frame = new Frame(method);
    frame.className = className;
    frame.locals.splice(0, 2, values, bound);
    const thread = {
      status: 'runnable', pendingException: null, callStack: new Stack(),
    };
    thread.callStack.push(frame);
    let result = null;
    let error = null;
    try {
      result = generated(frame, thread, jvm.jit, false);
    } catch (thrown) {
      error = thrown;
    }
    return {frame, result, error};
  };
  const values = [1, 2, 3, 4, 5, 6, 7, 8];
  values.type = '[I';
  const valid = run(values, 4);
  t.equal(valid.error, null,
    'the scaled fast loop executes valid carried indexes');
  t.equal(valid.result?.value, 72,
    'current and previous pairs retain exact Java ordering');

  const short = [1, 2, 3, 4, 5, 6, 7];
  short.type = '[I';
  const failed = run(short, 4);
  const loadPcs = jvm.jit.getCodeItems(method)
    .map((item, index) => ({item, index}))
    .filter(({item}) =>
      (item.instruction?.op || item.instruction) === 'iaload')
    .map(({index}) => index);
  t.equal(failed.error?.type, 'java/lang/ArrayIndexOutOfBoundsException',
    'a failed scaled guard retains the Java bounds exception');
  t.equal(failed.frame.pc, loadPcs[1],
    'the second carried load records its exact failing bytecode PC');
  t.equal(failed.frame.locals[3], 7,
    'the slow loop retains the first load and local mutation');
  t.deepEqual(failed.frame.stack.items, [7, short, 7],
    'the failing scaled load reconstructs its exact operands');
  t.end();
});

test('structured SSA coalesces identical load and store range guards',
  async (t) => {
  const className = 'CoalescedArrayRangeHarness';
  const classpath = compileJavaFixture(t, className, `
public final class CoalescedArrayRangeHarness {
  static void bump(int[] values, int start, int count) {
    for (int index = 0; index < count; index++) {
      values[start + index] = values[start + index] + 1;
    }
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: false,
  } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className, 'bump', '([III)V');
  const generated = jvm.jit.structuredSsa.compile(method);
  t.equal(generated?.jvmStructuredArrayRangeGuardCount, 2,
    'the load and store each contribute an independently verified access');
  t.equal(generated?.jvmStructuredCoalescedArrayRangeGuardCount, 1,
    'identical access predicates share one generated entry guard');
  const declarations = generated.jvmRestoringDirectPositionalSource.match(
    /const ssaArrayRangeGuard\d+ =/g) || [];
  t.equal(declarations.length, 1,
    'the restoring source computes the shared range predicate once');

  const values = [1, 2, 3, 4, 5];
  values.type = '[I';
  const thread = {
    status: 'runnable', pendingException: null, callStack: new Stack(),
  };
  const result = generated.jvmRestoringDirectPositionalBody(
    jvm.jit, {
      target: { freeFrame: null }, Frame, lookupClass: className, method,
      restoreFrame(targetThread, frame, depth) {
        targetThread.callStack.items.splice(depth, 0, frame);
      },
    }, values, 1, 3, thread, true);
  t.equal(result, jvm.jit.returnVoid(),
    'the coalesced guard accepts the valid Java range');
  t.deepEqual(Array.from(values), [1, 3, 4, 5, 5],
    'load/store ordering and mutations remain exact');
  t.end();
});

test('structured SSA binds verified renamed static self recursion directly',
  async (t) => {
  const className = 'ArbitraryRecursivePartition';
  const classpath = compileJavaFixture(t, className, `
public final class ArbitraryRecursivePartition {
  static int combine(int[] values, int lower, int upper) {
    if (upper - lower == 1) return values[lower];
    int middle = (lower + upper) >>> 1;
    return combine(values, lower, middle) +
        combine(values, middle, upper);
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: false,
  } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className, 'combine', '([III)I');
  const generated = jvm.jit.structuredSsa.compile(method);
  const source = generated?.jvmRestoringDirectPositionalSource || '';
  t.equal(typeof generated?.jvmRestoringDirectPositionalBody, 'function',
    'an arbitrary recursive shape publishes a restoring positional body');
  t.ok(source.includes('thread, 2)') &&
      !source.includes('const ssaCallSite'),
  'exact self calls bind to the generated body without dispatch snapshots');

  const values = [1, 2, 3, 4, 5, 6, 7, 8];
  values.type = '[I';
  const thread = {
    status: 'runnable', pendingException: null, callStack: new Stack(),
  };
  const plan = {
    target: { freeFrame: null }, Frame, lookupClass: className, method,
    restoreFrame(targetThread, frame, depth) {
      targetThread.callStack.items.splice(depth, 0, frame);
    },
  };
  const result = generated.jvmRestoringDirectPositionalBody(
    jvm.jit, plan, values, 0, values.length, thread, true);
  t.equal(result, 36,
    'direct recursive calls preserve the scalar result');
  t.equal(thread.callStack.size(), 0,
    'successful recursion does not materialize child Frames');
  t.end();
});

test('structured SSA scalarizes category-one dup_x1 field post-increment',
  async (t) => {
  const className = 'GenericPostIncrementReader';
  const classpath = compileJavaFixture(t, className, `
public final class GenericPostIncrementReader {
  int cursor;
  byte[] values;
  byte read(byte guard) {
    if (guard < 27) return -82;
    return values[cursor++];
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: false,
  } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className, 'read', '(B)B');
  const generated = jvm.jit.structuredSsa.compile(method);
  t.equal(typeof generated?.jvmRestoringDirectPositionalBody, 'function',
    'a verified dup_x1 post-increment publishes the scalar ABI');

  const receiver = jvm.jit.allocateObject(className);
  const values = jvm.jit.newPrimitiveArray(3, 'byte');
  values[0] = 4;
  values[1] = -7;
  values[2] = 9;
  receiver.fields[`${className}.cursor`] = 1;
  receiver.fields[`${className}.values`] = values;
  const thread = {
    status: 'runnable', pendingException: null, callStack: new Stack(),
  };
  const plan = {
    target: { freeFrame: null }, Frame, lookupClass: className, method,
    restoreFrame(targetThread, frame, depth) {
      targetThread.callStack.items.splice(depth, 0, frame);
    },
  };
  const result = generated.jvmRestoringDirectPositionalBody(
    jvm.jit, plan, receiver, 27, thread, true);
  t.equal(result, -7, 'the old cursor value indexes the array');
  t.equal(receiver.fields[`${className}.cursor`], 2,
    'the incremented cursor is stored once');
  t.equal(thread.callStack.size(), 0,
    'normal execution does not materialize an omitted Frame');
  t.end();
});

test('structured SSA returns object arrays across dup_x2 assignment',
  async (t) => {
  const className = 'GenericReferenceArrayAssignment';
  const classpath = compileJavaFixture(t, className, `
public final class GenericReferenceArrayAssignment {
  static Object[] replace(Object[][] rows, Object[] value, int index) {
    Object[] assigned = rows[index] = value;
    for (int i = 0; i < assigned.length; i++) assigned[i] = assigned[i];
    return assigned;
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: false,
  } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className, 'replace',
    '([[Ljava/lang/Object;[Ljava/lang/Object;I)[Ljava/lang/Object;');
  const ops = jvm.jit.getCodeItems(method).map((item) =>
    typeof item.instruction === 'string'
      ? item.instruction : item.instruction?.op);
  t.ok(ops.includes('dup_x2'),
    'the fixture exercises verifier-derived category-one dup_x2');
  const generated = jvm.jit.structuredSsa.compile(method);
  t.equal(typeof generated?.jvmRestoringDirectPositionalBody, 'function',
    'a loop returning an object array publishes the restoring scalar ABI');
  t.deepEqual(generated.jvmStructuredPositionalAstRejections, [],
    'SSA copy aliases are also rewritten in deoptimization snapshots');

  const rows = jvm.jit.newReferenceArray(2, '[Ljava/lang/Object;');
  const value = jvm.jit.newReferenceArray(3, 'java/lang/Object');
  const marker = jvm.jit.allocateObject('java/lang/Object');
  value[1] = marker;
  const thread = {
    status: 'runnable', pendingException: null, callStack: new Stack(),
  };
  const plan = {
    target: { freeFrame: null }, Frame, lookupClass: className, method,
    restoreFrame(targetThread, frame, depth) {
      targetThread.callStack.items.splice(depth, 0, frame);
    },
  };
  const returned = generated.jvmRestoringDirectPositionalBody(
    jvm.jit, plan, rows, value, 1, thread, true);
  t.equal(returned, value, 'the returned reference preserves object identity');
  t.equal(rows[1], value, 'the nested reference-array store occurs once');
  t.equal(returned[1], marker, 'the loop preserves reference elements');
  t.equal(thread.callStack.size(), 0,
    'the successful path does not materialize a Frame');
  t.end();
});

test('structured SSA direct instance recursion omits stale receiver aliases',
  async (t) => {
  const className = 'InstanceRecursivePartition';
  const classpath = compileJavaFixture(t, className, `
public final class InstanceRecursivePartition {
  InstanceRecursivePartition next;
  int combine(int[] values, int lower, int upper) {
    if (upper - lower == 1) return values[lower];
    int middle = (lower + upper) >>> 1;
    return combine(values, lower, middle) +
        combine(values, middle, upper);
  }
  boolean walk(byte guard) {
    if (guard > -108) return false;
    if (next != null) return next.walk((byte) -113);
    return true;
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: false,
  } });
  const cls = await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className, 'combine', '([III)I');
  const generated = jvm.jit.structuredSsa.compile(method);
  const source = generated?.jvmRestoringDirectPositionalSource || '';
  t.equal(typeof generated?.jvmRestoringDirectPositionalBody, 'function',
    'instance recursion publishes its restoring positional entry');
  t.equal(/ssaInvariantPositionalRaw/.test(source), false,
    'specialized self calls do not retain an undeclared receiver alias');

  const receiver = {type: className, cls, fields: {}};
  const values = [1, 2, 3, 4, 5, 6, 7, 8];
  values.type = '[I';
  const thread = {
    status: 'runnable', pendingException: null, callStack: new Stack(),
  };
  const plan = {
    target: {freeFrame: null}, Frame, lookupClass: className, method,
    restoreFrame(targetThread, frame, depth) {
      targetThread.callStack.items.splice(depth, 0, frame);
    },
  };
  const result = generated.jvmRestoringDirectPositionalBody(
    jvm.jit, plan, receiver, values, 0, values.length, thread, true);
  t.equal(result, 36, 'instance self recursion preserves its scalar result');
  t.equal(thread.callStack.size(), 0,
    'successful instance recursion does not materialize Frames');

  const walkMethod = await jvm.findMethodInHierarchy(
    className, 'walk', '(B)Z');
  const walkGenerated = jvm.jit.structuredSsa.compile(walkMethod);
  const walkSource = walkGenerated?.jvmRestoringDirectPositionalSource || '';
  t.equal(typeof walkGenerated?.jvmRestoringDirectPositionalBody, 'function',
    'field-receiver recursion publishes its restoring entry');
  t.notOk(/ssaCallSite|ssaFastPositional/.test(walkSource),
    'direct self recursion removes the complete obsolete PIC preamble');
  const tail = {
    type: className, cls,
    fields: {'InstanceRecursivePartition.next': null},
  };
  const head = {
    type: className, cls,
    fields: {'InstanceRecursivePartition.next': tail},
  };
  const walkPlan = {
    target: {freeFrame: null}, Frame, lookupClass: className,
    method: walkMethod,
    restoreFrame(targetThread, frame, depth) {
      targetThread.callStack.items.splice(depth, 0, frame);
    },
  };
  const walked = walkGenerated.jvmRestoringDirectPositionalBody(
    jvm.jit, walkPlan, head, -113, thread, true);
  t.equal(walked, 1,
    'field-receiver recursion preserves the boolean scalar result');
  t.equal(thread.callStack.size(), 0,
    'field-receiver recursion also avoids materialized Frames');
  t.end();
});

test('recursive methods with suspendable child calls retain JVM Frames',
  async (t) => {
  const className = 'RecursiveSchedulerHandoffHarness';
  const classpath = compileJavaFixture(t, className, `
public final class RecursiveSchedulerHandoffHarness {
  abstract static class Node {
    boolean active;
    abstract Node first();
    abstract Node next();
  }
  void visit(Node node) {
    node.active = false;
    Node child = node.first();
    while (child != null) {
      visit(child);
      child = node.next();
    }
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: false,
  } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className, 'visit', `(L${className}$Node;)V`);
  const generated = jvm.jit.structuredSsa.compile(method);

  t.ok(generated?.jvmStructuredSsa,
    'the mixed recursive call graph still receives structured compilation');
  t.notOk(generated.jvmRestoringDirectPositionalBody,
    'the recursive region does not omit Frames across suspendable children');
  t.equal(generated.jvmStructuredRestoringDirectRejection,
    'self recursion mixed with independently suspendable calls',
    'the rejection records the generic call-graph proof that failed');
  t.notOk(generated.jvmFramelessPositional,
    'the remaining positional entry is explicitly Frame-backed');
  t.equal(generated.jvmStructuredContinuation, true,
    'the loop retains its cooperative structured continuation');
  t.equal(generated.jvmStructuredCanonicalNestedCalls, true,
    'mixed recursive scheduler handoffs keep nested calls canonical');
  t.match(generated.jvmStructuredSource,
    /let ssaFastPositional\d+ = null;/,
    'the generated continuation cannot enter a positional child');
  t.end();
});

test('handler-protected non-void calls retain exact structured continuations',
  async (t) => {
  const className = 'HandledReturnHandoffHarness';
  const classpath = compileJavaFixture(t, className, `
public final class HandledReturnHandoffHarness {
  static boolean child(int value) {
    return value > 0;
  }
  static int parent(int value) {
    try {
      while (value > 0) {
        if (child(value)) return 1;
        value--;
      }
      return 0;
    } catch (RuntimeException error) {
      return -1;
    }
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: false,
  } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className, 'parent', '(I)I');
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated?.jvmStructuredSsa,
    'the renderer retains the verified positional candidate');
  t.notOk(generated.jvmStructuredRequiresBaselineFramedEntry,
    'a loop continuation gives the child return a canonical frame owner');
  t.notOk(generated?.jvmRestoringDirectPositionalBody,
    'the protected non-void handoff does not bypass the framed-entry proof');
  t.equal(generated.jvmStructuredRestoringDirectRejection,
    'handler-protected non-void call requires a canonical caller frame',
    'the positional rejection records the scheduler ownership invariant');
  const selected = jvm.jit.compileMethod(method);
  t.ok(selected.jvmStructuredSsa,
    'ordinary frame entry retains the verified structured continuation');
  t.notOk(selected.jvmStructuredPositionalOnly,
    'tier selection does not retain an unsafe positional-only body');
  t.notOk(selected.jvmRestoringDirectPositionalBody,
    'baseline selection keeps the protected caller wholly frame-backed');
  t.end();
});

test('structured SSA refreshes entry static snapshots after a continuation',
  async (t) => {
  const className = 'ContinuationStaticRefreshHarness';
  const classpath = compileJavaFixture(t, className, `
public final class ContinuationStaticRefreshHarness {
  static int width;
  static int[] pixels;
  static void fill(int count, int color) {
    for (int index = 0; index < count; index++) {
      pixels[index] = color + width;
    }
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: false,
  } });
  const classData = await jvm.loadClassByName(className);
  classData.staticFields.set('width:I', 1);
  const first = new Array(20001).fill(0);
  first.type = '[I';
  classData.staticFields.set('pixels:[I', first);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className, 'fill', '(II)V');
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated?.jvmStructuredContinuation,
    'the long loop retains a cooperative structured continuation');

  const frame = new Frame(method);
  frame.className = className;
  frame.locals.splice(0, 2, 20001, 10);
  const thread = {
    status: 'runnable', pendingException: null, callStack: new Stack(),
  };
  thread.callStack.push(frame);
  jvm._nextEventLoopYieldAt = 0;
  const yielded = generated(frame, thread, jvm.jit, false);
  t.ok(yielded?.deopt && generated.jvmHasStructuredContinuation(frame),
    'the first quantum suspends with exact lexical state');

  const rebound = new Array(20001).fill(0);
  rebound.type = '[I';
  classData.staticFields.set('width:I', 2);
  classData.staticFields.set('pixels:[I', rebound);
  jvm._nextEventLoopYieldAt = Number.POSITIVE_INFINITY;
  const resumed = generated(frame, thread, jvm.jit, false);
  t.ok(resumed?.returned && !generated.jvmHasStructuredContinuation(frame),
    'the second quantum completes the suspended loop');
  const firstWrites = first.filter((value) => value !== 0).length;
  const reboundWrites = rebound.filter((value) => value !== 0).length;
  t.ok(firstWrites > 0 && reboundWrites > 0 &&
      firstWrites + reboundWrites === 20001,
  'the two scheduler quanta account for every store exactly once');
  t.ok(first.every((value) => value === 0 || value === 11),
    'the first quantum observes the original scalar and array statics');
  t.ok(rebound.every((value) => value === 0 || value === 12),
    'resumption reloads both rebound static values');
  t.end();
});

test('structured SSA coarsens a call-free inner loop independently of its caller loop',
  async (t) => {
  const className = 'NestedRasterShape';
  const classpath = compileJavaFixture(t, className, `
public final class NestedRasterShape {
  static int clamp(int value, int maximum) {
    return value < maximum ? value : maximum;
  }

  static void raster(int[] destination, int rows, int columns) {
    for (int row = 0; row < rows; row++) {
      int base = row * columns;
      int limit = clamp(columns, destination.length - base);
      for (int column = 0; column < limit; column++) {
        destination[base + column] = row + column;
      }
    }
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    profileMethods: false,
  } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className, 'raster', '([III)V');
  const generated = jvm.jit.structuredSsa.compile(method);
  const source = generated?.jvmRestoringDirectPositionalSource || '';
  t.ok(generated?.jvmStructuredSsa,
    'the nested raster selects the generic structured SSA tier');
  t.ok(/if \(!\(ssaRuntimeCoarseLoop\d+ && ssaArrayRangeGuard\d+\)\)/.test(source) &&
      source.includes("reason: 'structured SSA range guard'"),
    'the call-free inner pixel loop deopts before its range-proven fast arm');
  const pollCount = (source.match(/--safePointBudget <= 0/g) || []).length;
  t.equal(generated.jvmStructuredRestoringCoarseLoopDeoptCount, 1,
    'the helper-containing outer loop versions its trip-count proof');
  t.ok(source.includes("reason: 'structured SSA coarse loop guard'") &&
      pollCount === 0,
    'an oversized outer loop restores at its header instead of polling every row');
  const fastArm = source.indexOf('&& ssaArrayRangeGuard');
  const fastStore = source.indexOf('] =', fastArm);
  t.ok(fastArm >= 0 && fastStore > fastArm &&
      !source.slice(fastArm, fastStore).includes('--safePointBudget'),
    'the proven inner fast arm has no per-pixel scheduler branch');

  const destination = new Array(24).fill(-1);
  destination.type = '[I';
  const thread = {
    id: 0, name: 'nested-raster',
    status: 'runnable', pendingException: null, callStack: new Stack(),
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  await invoke(jvm, thread, className, 'raster', '([III)V',
    [destination, 3, 8]);
  t.deepEqual(destination.slice(), [
    0, 1, 2, 3, 4, 5, 6, 7,
    1, 2, 3, 4, 5, 6, 7, 8,
    2, 3, 4, 5, 6, 7, 8, 9,
  ], 'per-loop safety analysis preserves the nested raster result');
  t.end();
});

test('handler-only reporters do not block scalar positional helper compilation',
  async (t) => {
  const className = 'ReporterGuardedIntegerHelper';
  const classpath = compileJavaFixture(t, className, `
public final class ReporterGuardedIntegerHelper {
  static byte diagnostic;

  static int divide(int tag, int denominator, int numerator) {
    try {
      if (tag != 7) diagnostic = 1;
      int sign = numerator >>> 31;
      return (numerator + sign) / denominator - sign;
    } catch (RuntimeException exception) {
      throw exception;
    }
  }
}
`);
  const jvm = new JVM({classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    profileMethods: false,
  }});
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  jvm.getClassInitializationToken(className).initialized = true;
  const classData = jvm.classes[className];
  classData.staticFields.set('diagnostic:B', 0);
  const method = await jvm.findMethodInHierarchy(
    className, 'divide', '(III)I');
  const summary = jvm.jit.wasmJit.staticWriteSummary(
    className, 'divide', '(III)I');
  t.deepEqual([...summary], ['diagnostic:B'],
    'normal-flow summary retains the real guarded write but omits reporter calls');
  const generated = jvm.jit.structuredSsa.compile(method);
  t.equal(typeof generated?.jvmRestoringDirectPositionalBody, 'function',
    'the verified integer helper publishes a frame-free restoring ABI');
  t.notOk(generated.jvmRestoringDirectPositionalSource.includes('Handwritten'),
    'the helper body remains derived entirely from bytecode');
  t.end();
});

test('structured SSA self-links static locations resolved after compilation',
  async (t) => {
    const className = 'LateStaticLinkShape';
    const classpath = compileJavaFixture(t, className, `
public final class LateStaticLinkShape {
  static int bias;

  static int sum(int count) {
    int result = 0;
    for (int index = 0; index < count; index++) result += bias;
    return result;
  }
}
`);
    const jvm = new JVM({ classpath, jit: {
      warmupThreshold: 0,
      structuredSsa: true,
      guestKernelOracles: false,
    } });
    const classData = await jvm.loadClassByName(className);
    classData.staticFieldsInitialized = true;
    jvm.classInitializationState.set(className, 'INITIALIZED');
    // Model a method compiled while its symbolic owner is loaded but before
    // the concrete static slot has been installed by class initialization.
    classData.staticFields.delete('bias:I');
    const method = await jvm.findMethodInHierarchy(className, 'sum', '(I)I');
    const generated = jvm.jit.structuredSsa.compile(method);
    t.ok(generated?.jvmStructuredSsa,
      'an unresolved static location does not reject the generic SSA body');
    t.ok(generated.jvmStructuredSource.includes('ssaLazyStaticTarget'),
      'the cold site emits a location cache instead of a guest-specific kernel');

    classData.staticFields.set('bias:I', 3);
    let genericReads = 0;
    const originalGetStaticSyncAt = jvm.jit.getStaticSyncAt;
    jvm.jit.getStaticSyncAt = function countedStaticRead(...args) {
      genericReads += 1;
      return originalGetStaticSyncAt.apply(this, args);
    };
    const execute = (count) => {
      const frame = new Frame(method);
      frame.className = className;
      frame.locals[0] = count;
      const thread = {
        status: 'runnable', pendingException: null, callStack: new Stack(),
      };
      thread.callStack.push(frame);
      return generated(frame, thread, jvm.jit, false);
    };
    t.equal(execute(5).value, 15,
      'the first linked execution preserves the static value');
    t.equal(genericReads, 1,
      'the loop resolves its storage location once rather than once per iteration');
    t.equal(jvm.jit.structuredSsa.lazyStaticTargetLinkCount, 1,
      'a successful late location link is observable in diagnostics');

    classData.staticFields.set('bias:I', 7);
    t.equal(execute(2).value, 14,
      'the location cache reads the current field value on a later entry');
    t.equal(genericReads, 1,
      'later entries reuse the published location without generic dispatch');

    jvm.classInitializationState.set(className, 'UNINITIALIZED');
    jvm.classInitializationEpoch += 1;
    const guarded = execute(1);
    t.ok(guarded?.deopt && guarded.transient,
      'class lifecycle changes fall back before using the cached location');
    t.equal(genericReads, 1,
      'the entry guard rejects before the static read');
    jvm.jit.getStaticSyncAt = originalGetStaticSyncAt;
    t.end();
  });

test('structured SSA keeps static reads cached across proven pure callees',
  async (t) => {
    const className = 'ArbitraryStaticSummaryLoop';
    const classpath = compileJavaFixture(t, className, `
public final class ArbitraryStaticSummaryLoop {
  static int bias;
  static int other;
  int scale;
  int offset;

  private static int pure(int value) {
    return value * 2;
  }

  private static void writeBias() {
    bias++;
  }

  private static int recursivePure(int value) {
    if (value <= 0) return 0;
    return value + recursivePure(value - 1);
  }

  private static void recursiveWriteBias(int count) {
    if (count <= 0) return;
    bias++;
    recursiveWriteBias(count - 1);
  }

  private static void writeScale(ArbitraryStaticSummaryLoop self) {
    self.scale++;
  }

  static int pureLoop(int count) {
    int sum = 0;
    for (int index = 0; index < count; index++) {
      sum += bias + pure(index) + other;
    }
    return sum;
  }

  static int writingLoop(int count) {
    int sum = 0;
    for (int index = 0; index < count; index++) {
      sum += bias + pure(index) + other;
      writeBias();
    }
    return sum;
  }

  static int recursivePureLoop(int count) {
    int sum = 0;
    for (int index = 0; index < count; index++) {
      sum += bias + recursivePure(index) + other;
    }
    return sum;
  }

  static int recursiveWritingLoop(int count) {
    int sum = 0;
    for (int index = 0; index < count; index++) {
      sum += bias + other;
      recursiveWriteBias(1);
    }
    return sum;
  }

  int pureInstanceLoop(int count) {
    int sum = 0;
    for (int index = 0; index < count; index++) {
      sum += scale + pure(index) + offset;
    }
    return sum;
  }

  int writingInstanceLoop(int count) {
    int sum = 0;
    for (int index = 0; index < count; index++) {
      sum += scale + pure(index) + offset;
      writeScale(this);
    }
    return sum;
  }
}
`);
    const jvm = new JVM({ classpath, jit: {
      warmupThreshold: 0,
      structuredSsa: true,
      guestKernelOracles: false,
    } });
    const classData = await jvm.loadClassByName(className);
    classData.staticFieldsInitialized = true;
    jvm.classInitializationState.set(className, 'INITIALIZED');
    classData.staticFields.set('bias:I', 1);
    classData.staticFields.set('other:I', 7);
    const pureLoop = await jvm.findMethodInHierarchy(
      className, 'pureLoop', '(I)I');
    const writingLoop = await jvm.findMethodInHierarchy(
      className, 'writingLoop', '(I)I');
    const pureInstanceLoop = await jvm.findMethodInHierarchy(
      className, 'pureInstanceLoop', '(I)I');
    const writingInstanceLoop = await jvm.findMethodInHierarchy(
      className, 'writingInstanceLoop', '(I)I');
    const recursivePureLoop = await jvm.findMethodInHierarchy(
      className, 'recursivePureLoop', '(I)I');
    const recursiveWritingLoop = await jvm.findMethodInHierarchy(
      className, 'recursiveWritingLoop', '(I)I');
    const pureGenerated = jvm.jit.structuredSsa.compile(pureLoop);
    const writingGenerated = jvm.jit.structuredSsa.compile(writingLoop);
    const pureInstanceGenerated =
      jvm.jit.structuredSsa.compile(pureInstanceLoop);
    const writingInstanceGenerated =
      jvm.jit.structuredSsa.compile(writingInstanceLoop);
    const recursivePureGenerated =
      jvm.jit.structuredSsa.compile(recursivePureLoop);
    const recursiveWritingGenerated =
      jvm.jit.structuredSsa.compile(recursiveWritingLoop);
    const entryCacheCount = (generated) =>
      (generated.jvmStructuredSource
        .match(/(?:const|let) ssaEntryStaticValue/g) || []).length;
    t.equal(entryCacheCount(pureGenerated), 2,
      'a transitively pure static call preserves both caller static caches');
    t.equal(entryCacheCount(writingGenerated), 1,
      'a callee write invalidates only the matching static cache key');
    t.equal(entryCacheCount(recursivePureGenerated), 2,
      'a pure direct-recursive callee preserves caller static caches');
    t.equal(entryCacheCount(recursiveWritingGenerated), 1,
      'a recursive callee still reports its concrete static write');
    const eagerFieldCacheCount = (generated) =>
      (generated.jvmStructuredSource
        .match(/ssaFieldCache\d+Object = local0/g) || []).length;
    t.equal(eagerFieldCacheCount(pureInstanceGenerated), 2,
      'a pure static callee preserves both receiver-field caches');
    t.equal(eagerFieldCacheCount(writingInstanceGenerated), 1,
      'a private callee write invalidates only its matching receiver field');

    const execute = (method, generated, count) => {
      const frame = new Frame(method);
      frame.className = className;
      frame.locals[0] = count;
      const thread = {
        status: 'runnable', pendingException: null, callStack: new Stack(),
      };
      thread.callStack.push(frame);
      return generated(frame, thread, jvm.jit, false);
    };
    t.equal(execute(pureLoop, pureGenerated, 3).value, 30,
      'cached values across a pure callee preserve exact guest results');
    t.equal(execute(writingLoop, writingGenerated, 3).value, 33,
      'the writing callee remains visible on every later loop iteration');
    t.equal(classData.staticFields.get('bias:I'), 4,
      'the transitive write summary never hides the callee side effect');
    t.equal(execute(
      recursivePureLoop, recursivePureGenerated, 3).value, 37,
    'cached values across pure recursion preserve exact guest results');
    t.equal(execute(
      recursiveWritingLoop, recursiveWritingGenerated, 3).value, 36,
    'recursive writes remain visible on every later loop iteration');
    t.equal(classData.staticFields.get('bias:I'), 7,
      'recursive summary convergence retains the recursive write effect');

    const receiver = {
      type: className,
      fields: {
        [`${className}.scale`]: 1,
        [`${className}.offset`]: 7,
      },
    };
    const executeInstance = (method, generated, count) => {
      const frame = new Frame(method);
      frame.className = className;
      frame.locals.splice(0, 2, receiver, count);
      const thread = {
        status: 'runnable', pendingException: null, callStack: new Stack(),
      };
      thread.callStack.push(frame);
      return generated(frame, thread, jvm.jit, false);
    };
    t.equal(executeInstance(
      pureInstanceLoop, pureInstanceGenerated, 3).value, 30,
    'receiver caches across a pure callee preserve exact guest results');
    t.equal(executeInstance(
      writingInstanceLoop, writingInstanceGenerated, 3).value, 33,
    'the private writing callee remains visible on later iterations');
    t.equal(receiver.fields[`${className}.scale`], 4,
      'selective receiver caching never hides the private callee write');
    t.end();
  });

test('clipped gradient intrinsic preserves Java pixel and exception semantics', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0, structuredSsa: true } });
  const pixels = new Array(16).fill(-1);
  jvm.jit.clippedGradientDirect(
    0, 0, 4, 4, 0, 0xffffff, 1, 1, 4, 4, 4, pixels);
  t.deepEqual(pixels, [
    -1, -1, -1, -1,
    -1, 0x3f3f3f, 0x3f3f3f, 0x3f3f3f,
    -1, 0x7f7f7f, 0x7f7f7f, 0x7f7f7f,
    -1, 0xbfbfbf, 0xbfbfbf, 0xbfbfbf,
  ], 'clipping retains the original vertical interpolation phase');
  t.equal(jvm.jit.clippedGradientRunCount, 1,
    'the generic gradient path publishes an observable runtime counter');

  let arithmetic;
  try {
    jvm.jit.clippedGradientDirect(
      0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 1, null);
  } catch (error) {
    arithmetic = error;
  }
  t.equal(arithmetic?.type, 'java/lang/ArithmeticException',
    'division by zero occurs before the first array access');

  t.doesNotThrow(() => jvm.jit.clippedGradientDirect(
    0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 1, null),
  'an empty clipped width does not dereference the pixel array');

  const shortPixels = new Array(3).fill(-1);
  let bounds;
  try {
    jvm.jit.clippedGradientDirect(
      0, 0, 2, 2, 0, 0xffffff, 0, 0, 2, 2, 2, shortPixels);
  } catch (error) {
    bounds = error;
  }
  t.equal(bounds?.type, 'java/lang/ArrayIndexOutOfBoundsException',
    'an invalid raster retains the JVM bounds exception');
  t.deepEqual(shortPixels, [0, 0, 0x7f7f7f],
    'bounds failure retains all pixel writes before the throwing store');
  t.end();
});

test('structured SSA emits verified alpha-blended static spans without call dispatch', async (t) => {
  const classpath = compileJavaFixture(t, 'ArbitraryAlphaSpanShape', `
public class ArbitraryAlphaSpanShape {
  static int top, bottom, left, right, width;
  static int[] pixels;

  static void arbitraryBlend(int x, int y, int count, int color, int alpha) {
    if (y >= top) {
      if (y >= bottom) return;
      if (x < left) {
        count -= left - x;
        x = left;
      }
      if (x + count > right) count = right - x;
      int inverse = 256 - alpha;
      int sourceRed = (color >> 16 & 255) * alpha;
      int sourceGreen = (color >> 8 & 255) * alpha;
      int sourceBlue = (color & 255) * alpha;
      int index = x + y * width;
      for (int offset = 0; offset < count; offset++) {
        int red = (pixels[index] >> 16 & 255) * inverse;
        int green = (pixels[index] >> 8 & 255) * inverse;
        int blue = (pixels[index] & 255) * inverse;
        int blended = (sourceRed + red >> 8 << 16)
          + (sourceGreen + green >> 8 << 8) + (sourceBlue + blue >> 8);
        pixels[index++] = blended;
      }
    }
  }

  static void arbitraryRecompiledBlend(int x, int y, int count, int color, int alpha) {
    int inverse = 0;
    int sourceRed = 0;
    int sourceGreen = 0;
    int sourceBlue = 0;
    int index = 0;
    int offset = 0;
    int red = 0;
    int green = 0;
    int blue = 0;
    int blended = 0;
    int oldIndex = 0;
    if (y >= top) {
      if (y >= bottom) return;
      if (x < left) {
        count -= left - x;
        x = left;
      }
      if (x + count > right) count = right - x;
      inverse = 256 - alpha;
      sourceRed = (color >> 16 & 255) * alpha;
      sourceGreen = (color >> 8 & 255) * alpha;
      sourceBlue = (color & 255) * alpha;
      index = x + y * width;
      for (offset = 0; offset < count; offset++) {
        red = (pixels[index] >> 16 & 255) * inverse;
        green = (pixels[index] >> 8 & 255) * inverse;
        blue = (pixels[index] & 255) * inverse;
        blended = (sourceRed + red >> 8 << 16)
          + (sourceGreen + green >> 8 << 8) + (sourceBlue + blue >> 8);
        oldIndex = index;
        index++;
        pixels[oldIndex] = blended;
      }
    }
  }

  public static void arbitraryCaller(int x, int y, int count, int color, int alpha) {
    arbitraryBlend(x, y, count, color, alpha);
  }
}
`);
  const jvm = new JVM({
    classpath,
    jit: {
      warmupThreshold: 0,
      structuredSsa: true,
      preferWholeMethodJs: true,
      guestKernelOracles: true,
    },
  });
  await jvm.loadClassByName('ArbitraryAlphaSpanShape');
  const owner = jvm.classes.ArbitraryAlphaSpanShape;
  jvm.classInitializationState.set('ArbitraryAlphaSpanShape', 'INITIALIZED');
  const pixels = new Array(24).fill(0x204060);
  pixels.type = '[I';
  owner.staticFields.set('top:I', 0);
  owner.staticFields.set('bottom:I', 3);
  owner.staticFields.set('left:I', 1);
  owner.staticFields.set('right:I', 7);
  owner.staticFields.set('width:I', 8);
  owner.staticFields.set('pixels:[I', pixels);

  const blend = await jvm.findMethodInHierarchy(
    'ArbitraryAlphaSpanShape', 'arbitraryBlend', '(IIIII)V');
  const intrinsic = jvm.jit.getSynchronousIntrinsic(blend, '(IIIII)V');
  t.equal(intrinsic?.jvmDirectKind, 'clippedStaticAlphaSpan',
    'descriptor, full bytecode shape, constants, and field identities recognize the span');
  const recompiledBlend = await jvm.findMethodInHierarchy(
    'ArbitraryAlphaSpanShape', 'arbitraryRecompiledBlend', '(IIIII)V');
  const recompiledIntrinsic =
    jvm.jit.getSynchronousIntrinsic(recompiledBlend, '(IIIII)V');
  t.equal(recompiledIntrinsic?.jvmDirectKind, 'clippedStaticAlphaSpan',
    'proven-dead entry stores and a one-use javac post-increment temporary normalize to the same shape');

  const caller = await jvm.findMethodInHierarchy(
    'ArbitraryAlphaSpanShape', 'arbitraryCaller', '(IIIII)V');
  const generated = jvm.jit.structuredSsa.compile(caller);
  t.ok(generated?.jvmStructuredSsa, 'alpha-span caller selects structured SSA');
  t.ok(generated.jvmStructuredSource.includes('clippedStaticAlphaSpanDirectAt') &&
      !generated.jvmStructuredSource.includes('tryInvokeSyncAt'),
    'verified alpha span is emitted positionally without generic call dispatch');

  const frame = new Frame(caller);
  frame.className = 'ArbitraryAlphaSpanShape';
  frame.locals.splice(0, 5, -2, 1, 5, 0xc08040, 128);
  const thread = { status: 'runnable', callStack: new Stack() };
  thread.callStack.push(frame);
  generated(frame, thread, jvm.jit, false);
  const expected = 0x706050;
  t.deepEqual(pixels.slice(8, 16),
    [0x204060, expected, expected, 0x204060, 0x204060, 0x204060, 0x204060, 0x204060],
    'direct alpha span preserves clipping and packed-channel arithmetic');

  const constantItem = blend.attributes.find((attribute) => attribute.type === 'code')
    .code.codeItems.find((item) =>
      item.instruction?.op === 'sipush' && Number(item.instruction.arg) === 256);
  const originalArg = constantItem.instruction.arg;
  constantItem.instruction.arg = 255;
  t.equal(jvm.jit.getSynchronousIntrinsic(blend, '(IIIII)V'), null,
    'an altered arithmetic constant rejects the structural intrinsic');
  constantItem.instruction.arg = originalArg;
  t.end();
});

test('structured SSA emits verified masked color blits without call dispatch', (t) => {
  const ops = [
    "iload", "iconst_2", "ishr", "ineg", "istore",
    "iload", "iconst_3", "iand", "ineg", "istore",
    "iload", "ineg", "istore", "iload", "ifge", "iload", "istore",
    "iload", "ifge",
    "aload_1", "iload_3", "iinc", "baload", "ifeq",
    "aload_0", "iload", "iinc", "iload_2", "iastore", "goto", "iinc",
    "aload_1", "iload_3", "iinc", "baload", "ifeq",
    "aload_0", "iload", "iinc", "iload_2", "iastore", "goto", "iinc",
    "aload_1", "iload_3", "iinc", "baload", "ifeq",
    "aload_0", "iload", "iinc", "iload_2", "iastore", "goto", "iinc",
    "aload_1", "iload_3", "iinc", "baload", "ifeq",
    "aload_0", "iload", "iinc", "iload_2", "iastore", "goto", "iinc",
    "iinc", "goto", "iload", "istore", "iload", "ifge",
    "aload_1", "iload_3", "iinc", "baload", "ifeq",
    "aload_0", "iload", "iinc", "iload_2", "iastore", "goto", "iinc",
    "iinc", "goto", "iload", "iload", "iadd", "istore",
    "iload_3", "iload", "iadd", "istore_3", "iinc", "goto", "return",
  ];
  const blit = {
    name: 'arbitraryMaskedBlit', descriptor: '([I[BIIIIIII)V', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: ops.map((instruction) => ({ instruction })),
      localsSize: '12', stackSize: '4', exceptionTable: [],
    } }],
  };
  const call = { op: 'invokestatic',
    arg: ['Method', 'ArbitraryMaskedOwner', [blit.name, blit.descriptor]] };
  const caller = {
    name: 'arbitraryMaskedCaller', descriptor: blit.descriptor, flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: [
        'aload_0', 'aload_1', 'iload_2', 'iload_3',
        { op: 'iload', arg: 4 }, { op: 'iload', arg: 5 },
        { op: 'iload', arg: 6 }, { op: 'iload', arg: 7 },
        { op: 'iload', arg: 8 }, call, 'return',
      ].map((instruction) => ({ instruction })),
      localsSize: '9', stackSize: '9', exceptionTable: [],
    } }],
  };
  const jvm = new JVM({ jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: true,
  } });
  jvm.classes.ArbitraryMaskedOwner = {
    staticFields: new Map(),
    ast: { classes: [{ superClassName: null,
      items: [{ type: 'method', method: blit }, { type: 'method', method: caller }] }] },
  };
  jvm.classInitializationState.set('ArbitraryMaskedOwner', 'INITIALIZED');
  const intrinsic = jvm.jit.getSynchronousIntrinsic(blit, blit.descriptor);
  t.equal(intrinsic?.jvmDirectKind, 'maskedColorBlit',
    'descriptor and complete unrolled bytecode shape recognize an arbitrary method name');
  const generated = jvm.jit.structuredSsa.compile(caller);
  t.ok(generated?.jvmStructuredSsa, 'masked-blit caller selects structured SSA');
  t.ok(generated.jvmStructuredSource.includes('maskedColorBlitDirect') &&
      !generated.jvmStructuredSource.includes('tryInvokeSyncAt'),
    'verified masked blit is emitted positionally without generic call dispatch');

  const destination = new Array(16).fill(0);
  destination.type = '[I';
  const mask = [0, 1, 0, 1, 1, 99, 1, 0, 1, 0, 1];
  mask.type = '[B';
  const frame = new Frame(caller);
  frame.className = 'ArbitraryMaskedOwner';
  frame.locals.splice(0, 9, destination, mask, 0x345678, 0, 1, 5, 2, 3, 1);
  const thread = { status: 'runnable', callStack: new Stack() };
  thread.callStack.push(frame);
  generated(frame, thread, jvm.jit, false);
  t.deepEqual(destination.slice(),
    [0, 0, 0x345678, 0, 0x345678, 0x345678, 0, 0, 0,
      0x345678, 0, 0x345678, 0, 0x345678, 0, 0],
  'direct masked blit preserves mask indexing, destination strides, and writes');

  blit.attributes[0].code.codeItems[2].instruction = 'iushr';
  t.equal(jvm.jit.getSynchronousIntrinsic(blit, blit.descriptor), null,
    'an altered shift rejects the structural intrinsic');
  t.end();
});

test('structured SSA emits verified transparent int blits without call dispatch', (t) => {
  const javacJsCounts = {
    iconst_0: 18, istore: 26, iload: 26, iconst_2: 1, ishr: 1,
    ineg: 3, iconst_3: 1, iand: 1, if_icmplt: 3, return: 1,
    athrow: 15, iadd: 2, iload_3: 6, istore_3: 1, iinc: 20,
    goto: 14, aload_1: 5, iaload: 5, istore_2: 5, iload_2: 10,
    if_icmpne: 5, aload_0: 5, iastore: 5,
  };
  const javacJsOps = Object.entries(javacJsCounts)
    .flatMap(([op, count]) => Array(count).fill(op));
  t.ok(jitCompilerTest.matchesJavacJsTransparentIntBlit(javacJsOps),
    'the complete javac.js transparent-blit lowering is recognized');
  javacJsOps[0] = 'iconst_1';
  t.notOk(jitCompilerTest.matchesJavacJsTransparentIntBlit(javacJsOps),
    'an altered javac.js lowering is rejected');
  const ops = [
    'iload', 'iconst_2', 'ishr', 'ineg', 'istore',
    'iload', 'iconst_3', 'iand', 'ineg', 'istore',
    'iload', 'ineg', 'istore', 'iload', 'ifge',
    'iload', 'istore', 'iload', 'ifge',
    'aload_1', 'iload_3', 'iinc', 'iaload', 'istore_2', 'iload_2', 'ifeq',
    'aload_0', 'iload', 'iinc', 'iload_2', 'iastore', 'goto', 'athrow', 'iinc',
    'aload_1', 'iload_3', 'iinc', 'iaload', 'istore_2', 'iload_2', 'ifeq',
    'aload_0', 'iload', 'iinc', 'iload_2', 'iastore', 'goto', 'athrow', 'iinc',
    'aload_1', 'iload_3', 'iinc', 'iaload', 'istore_2', 'iload_2', 'ifeq',
    'aload_0', 'iload', 'iinc', 'iload_2', 'iastore', 'goto', 'athrow', 'iinc',
    'aload_1', 'iload_3', 'iinc', 'iaload', 'istore_2', 'iload_2', 'ifeq',
    'aload_0', 'iload', 'iinc', 'iload_2', 'iastore', 'goto', 'athrow', 'iinc',
    'iinc', 'goto',
    'iload', 'istore', 'iload', 'ifge',
    'aload_1', 'iload_3', 'iinc', 'iaload', 'istore_2', 'iload_2', 'ifeq',
    'aload_0', 'iload', 'iinc', 'iload_2', 'iastore', 'goto', 'athrow', 'iinc',
    'iinc', 'goto',
    'iload', 'iload', 'iadd', 'istore',
    'iload_3', 'iload', 'iadd', 'istore_3',
    'iinc', 'goto', 'return',
  ];
  const branches = new Map([
    [14, 112], [18, 81], [25, 33], [31, 34],
    [40, 48], [46, 49], [55, 63], [61, 64],
    [70, 78], [76, 79], [80, 17], [84, 102],
    [91, 99], [97, 100], [101, 83], [111, 13],
  ]);
  const instructions = ops.map((op, index) => {
    if (branches.has(index)) return { op, arg: `L${branches.get(index)}` };
    if (op === 'iinc') return { op, varnum: 3, incr: 1 };
    if (op === 'iload' || op === 'istore') return { op, arg: 3 };
    return op;
  });
  const blit = {
    name: 'arbitraryTransparentCopy', descriptor: '([I[IIIIIIII)V',
    flags: ['private', 'static', 'final'],
    attributes: [{ type: 'code', code: {
      codeItems: instructions.map((instruction, index) => ({
        labelDef: `L${index}:`, instruction,
      })),
      localsSize: '12', stackSize: '4', exceptionTable: [],
    } }],
  };
  const call = { op: 'invokestatic',
    arg: ['Method', 'ArbitraryTransparentOwner', [blit.name, blit.descriptor]] };
  const caller = {
    name: 'arbitraryTransparentCaller', descriptor: blit.descriptor,
    flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: [
        'aload_0', 'aload_1', 'iload_2', 'iload_3',
        { op: 'iload', arg: 4 }, { op: 'iload', arg: 5 },
        { op: 'iload', arg: 6 }, { op: 'iload', arg: 7 },
        { op: 'iload', arg: 8 }, call, 'return',
      ].map((instruction, index) => ({
        labelDef: `C${index}:`, instruction,
      })),
      localsSize: '9', stackSize: '9', exceptionTable: [],
    } }],
  };
  const jvm = new JVM({ jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: true,
  } });
  jvm.classes.ArbitraryTransparentOwner = {
    staticFields: new Map(),
    ast: { classes: [{ superClassName: null,
      items: [{ type: 'method', method: blit }, { type: 'method', method: caller }] }] },
  };
  jvm.classInitializationState.set('ArbitraryTransparentOwner', 'INITIALIZED');
  const intrinsic = jvm.jit.getSynchronousIntrinsic(blit, blit.descriptor);
  t.equal(intrinsic?.jvmDirectKind, 'transparentIntBlit',
    'descriptor, verified CFG/stack, and complete bytecodes recognize an arbitrary name');
  const generated = jvm.jit.structuredSsa.compile(caller);
  t.ok(generated?.jvmStructuredSsa,
    'transparent int blit caller selects structured SSA');
  t.ok(generated.jvmStructuredSource.includes('transparentIntBlitDirect') &&
      !generated.jvmStructuredSource.includes('tryInvokeSyncAt'),
    'verified transparent int blit is positional and avoids generic dispatch');

  const destination = new Array(12).fill(7);
  destination.type = '[I';
  const source = [0, 11, 99, 0, 33, 99];
  source.type = '[I';
  jvm.jit.transparentIntBlitDirect(
    destination, source, 0, 0, 1, 2, 2, 2, 1);
  t.deepEqual(destination.slice(),
    [7, 7, 11, 7, 7, 7, 33, 7, 7, 7, 7, 7],
  'direct copy preserves transparent pixels and both row strides');
  t.equal(jvm.jit.transparentIntBlitRunCount, 1,
    'the intrinsic exposes a method-name-independent run counter');
  t.equal(jvm.jit.transparentIntBlitSlowPathCount, 0,
    'valid rectangles use the prevalidated raw-array path');

  const transparentDestination = [7];
  transparentDestination.type = '[I';
  const transparentSource = [0];
  transparentSource.type = '[I';
  t.doesNotThrow(() => jvm.jit.transparentIntBlitDirect(
    transparentDestination, transparentSource, 0, 0, 99, 1, 1, 0, 0),
  'a transparent source pixel does not access an invalid destination');

  const throwingFrame = new Frame(caller);
  throwingFrame.className = 'ArbitraryTransparentOwner';
  const opaqueSource = [123];
  opaqueSource.type = '[I';
  throwingFrame.locals.splice(0, 9,
    transparentDestination, opaqueSource, 0, 0, 99, 1, 1, 0, 0);
  const thread = { status: 'runnable', callStack: new Stack() };
  thread.callStack.push(throwingFrame);
  let thrown;
  try {
    generated(throwingFrame, thread, jvm.jit, false);
  } catch (error) {
    thrown = error;
  }
  t.equal(thrown?.type, 'java/lang/ArrayIndexOutOfBoundsException',
    'the slow path preserves a destination bounds exception');
  t.equal(throwingFrame.pc, 9,
    'direct intrinsic failure records the exact invoke PC');
  t.deepEqual(throwingFrame.stack.items,
    [transparentDestination, opaqueSource, 0, 0, 99, 1, 1, 0, 0],
    'direct intrinsic failure reconstructs all invoke operands');
  thread.callStack.pop();

  jvm.classInitializationState.set('ArbitraryTransparentOwner', 'LOADED');
  const guardedGenerated = jvm.jit.structuredSsa.compile(caller);
  t.ok(guardedGenerated?.jvmStructuredSource.includes(
    'class initialization in direct transparent int blit'),
  'a loaded target retains the intrinsic behind an initialization guard');
  const guardedDestination = [0];
  guardedDestination.type = '[I';
  const guardedSource = [456];
  guardedSource.type = '[I';
  const guardedFrame = new Frame(caller);
  guardedFrame.className = 'ArbitraryTransparentOwner';
  guardedFrame.locals.splice(0, 9,
    guardedDestination, guardedSource, 0, 0, 0, 1, 1, 0, 0);
  thread.callStack.push(guardedFrame);
  const guardedResult =
    guardedGenerated(guardedFrame, thread, jvm.jit, false);
  t.ok(guardedResult.deopt && guardedResult.transient,
    'the initialization guard requests canonical execution');
  t.equal(guardedDestination[0], 0,
    'the initialization guard runs before pixel effects');
  t.equal(guardedFrame.pc, 9,
    'the initialization fallback records the unexecuted invoke PC');
  thread.callStack.pop();

  jvm.classInitializationState.set('ArbitraryTransparentOwner', 'INITIALIZED');
  const initializedFrame = new Frame(caller);
  initializedFrame.className = 'ArbitraryTransparentOwner';
  initializedFrame.locals.splice(0, 9,
    guardedDestination, guardedSource, 0, 0, 0, 1, 1, 0, 0);
  thread.callStack.push(initializedFrame);
  guardedGenerated(initializedFrame, thread, jvm.jit, false);
  t.equal(guardedDestination[0], 456,
    'the same compiled caller enters the intrinsic after initialization');

  blit.attributes[0].code.codeItems[22].instruction = 'baload';
  t.equal(jvm.jit.getSynchronousIntrinsic(blit, blit.descriptor), null,
    'an altered array operation rejects the structural intrinsic');
  blit.attributes[0].code.codeItems[22].instruction = 'iaload';
  blit.attributes[0].code.exceptionTable = [{
    startLbl: 'L0', endLbl: 'L1', handlerLbl: 'L33',
    catch_type: 'java/lang/RuntimeException',
  }];
  t.equal(jvm.jit.getSynchronousIntrinsic(blit, blit.descriptor), null,
    'an unsupported exception handler rejects the intrinsic');
  t.end();
});

test('structured SSA emits verified alpha-masked color blits without call dispatch', (t) => {
  const instructions = [
    { op: 'iload', arg: 6 }, 'ineg', { op: 'istore', arg: 10 },
    { op: 'iload', arg: 10 }, { op: 'ifge', arg: 'Lreturn' },
    { op: 'iload', arg: 5 }, 'ineg', { op: 'istore', arg: 11 },
    { op: 'iload', arg: 11 }, { op: 'ifge', arg: 'Lrow' },
    'aload_1', 'iload_3', { op: 'iinc', varnum: 3, incr: 1 },
    'iaload', 'istore_2', 'iload_2', { op: 'ifeq', arg: 'Ltransparent' },
    'iload_2', { op: 'ldc', arg: 0x00ff00ff }, 'iand', { op: 'iload', arg: 9 },
    'imul', { op: 'ldc', arg: 0xff00ff00 | 0 }, 'iand', { op: 'istore', arg: 12 },
    'iload_2', { op: 'ldc', arg: 0x0000ff00 }, 'iand', { op: 'iload', arg: 9 },
    'imul', { op: 'ldc', arg: 0x00ff0000 }, 'iand', { op: 'istore', arg: 13 },
    'aload_0', { op: 'iload', arg: 4 }, { op: 'iinc', varnum: 4, incr: 1 },
    { op: 'iload', arg: 12 }, { op: 'iload', arg: 13 }, 'ior',
    { op: 'bipush', arg: 8 }, 'iushr', 'iastore', { op: 'goto', arg: 'Lafter' },
    { op: 'iinc', varnum: 4, incr: 1 },
    { op: 'iinc', varnum: 11, incr: 1 }, { op: 'goto', arg: 'Linner' },
    { op: 'iload', arg: 4 }, { op: 'iload', arg: 7 }, 'iadd', { op: 'istore', arg: 4 },
    'iload_3', { op: 'iload', arg: 8 }, 'iadd', 'istore_3',
    { op: 'iinc', varnum: 10, incr: 1 }, { op: 'goto', arg: 'Louter' },
    'return',
  ];
  const labels = new Map([
    [3, 'Louter:'], [8, 'Linner:'], [43, 'Ltransparent:'],
    [44, 'Lafter:'], [46, 'Lrow:'], [56, 'Lreturn:'],
  ]);
  const blit = {
    name: 'arbitraryAlphaMaskedBlit', descriptor: '([I[IIIIIIIII)V',
    flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: instructions.map((instruction, index) => ({
        labelDef: labels.get(index) || `L${index}:`, instruction,
      })),
      localsSize: '14', stackSize: '4', exceptionTable: [],
    } }],
  };
  const call = { op: 'invokestatic',
    arg: ['Method', 'ArbitraryAlphaMaskedOwner', [blit.name, blit.descriptor]] };
  const callerInstructions = [
    'aload_0', 'aload_1', 'iload_2', 'iload_3',
    { op: 'iload', arg: 4 }, { op: 'iload', arg: 5 },
    { op: 'iload', arg: 6 }, { op: 'iload', arg: 7 },
    { op: 'iload', arg: 8 }, { op: 'iload', arg: 9 }, call, 'return',
  ];
  const caller = {
    name: 'arbitraryAlphaMaskedCaller', descriptor: blit.descriptor,
    flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: callerInstructions.map((instruction, index) => ({
        labelDef: `C${index}:`, instruction,
      })),
      localsSize: '10', stackSize: '10', exceptionTable: [],
    } }],
  };
  const jvm = new JVM({ jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: true,
  } });
  jvm.classes.ArbitraryAlphaMaskedOwner = {
    staticFields: new Map(),
    ast: { classes: [{ superClassName: null,
      items: [{ type: 'method', method: blit }, { type: 'method', method: caller }] }] },
  };
  jvm.classInitializationState.set('ArbitraryAlphaMaskedOwner', 'INITIALIZED');
  const intrinsic = jvm.jit.getSynchronousIntrinsic(blit, blit.descriptor);
  t.equal(intrinsic?.jvmDirectKind, 'alphaMaskedColorBlit',
    'descriptor, complete bytecodes, and packed constants recognize an arbitrary method');
  const generated = jvm.jit.structuredSsa.compile(caller);
  t.ok(generated?.jvmStructuredSsa,
    'alpha-masked blit caller selects structured SSA');
  t.ok(generated.jvmStructuredSource.includes('alphaMaskedColorBlitDirect') &&
      !generated.jvmStructuredSource.includes('tryInvokeSyncAt'),
    'verified alpha-masked blit is emitted positionally without generic dispatch');

  const destination = new Array(12).fill(0x010203);
  destination.type = '[I';
  const source = [0, 0x804020, 99, 0, 0xabcdef, 99];
  source.type = '[I';
  const frame = new Frame(caller);
  frame.className = 'ArbitraryAlphaMaskedOwner';
  frame.locals.splice(0, 10,
    destination, source, 0, 0, 1, 2, 2, 2, 1, 128);
  const thread = { status: 'runnable', callStack: new Stack() };
  thread.callStack.push(frame);
  generated(frame, thread, jvm.jit, false);
  t.deepEqual(destination.slice(),
    [0x010203, 0x010203, 0x402010, 0x010203, 0x010203, 0x010203,
      0x556677, 0x010203, 0x010203, 0x010203, 0x010203, 0x010203],
  'direct alpha-masked blit preserves transparency, row strides, and packed arithmetic');
  t.equal(jvm.jit.alphaMaskedColorBlitRunCount, 1,
    'the structural intrinsic exposes a method-name-independent run counter');
  t.equal(jvm.jit.alphaMaskedColorBlitSlowPathCount, 0,
    'valid rectangles use the prevalidated raw-array path');

  const transparentDestination = [7];
  transparentDestination.type = '[I';
  const transparentSource = [0];
  transparentSource.type = '[I';
  t.doesNotThrow(() => jvm.jit.alphaMaskedColorBlitDirect(
    transparentDestination, transparentSource, 0, 0, 99, 1, 1, 0, 0, 128),
  'a transparent source pixel does not access an invalid destination');

  const throwingFrame = new Frame(caller);
  throwingFrame.className = 'ArbitraryAlphaMaskedOwner';
  const opaqueSource = [0xffffff];
  opaqueSource.type = '[I';
  throwingFrame.locals.splice(0, 10,
    transparentDestination, opaqueSource, 0, 0, 99, 1, 1, 0, 0, 128);
  thread.callStack.push(throwingFrame);
  let thrown;
  try {
    generated(throwingFrame, thread, jvm.jit, false);
  } catch (error) {
    thrown = error;
  }
  t.equal(thrown?.type, 'java/lang/ArrayIndexOutOfBoundsException',
    'the slow path preserves a destination bounds exception');
  t.equal(throwingFrame.pc, 10,
    'direct intrinsic failure records the exact invoke bytecode PC');
  t.deepEqual(throwingFrame.stack.items,
    [transparentDestination, opaqueSource, 0, 0, 99, 1, 1, 0, 0, 128],
    'direct intrinsic failure reconstructs all invoke operands in JVM order');
  thread.callStack.pop();

  jvm.classInitializationState.set('ArbitraryAlphaMaskedOwner', 'LOADED');
  const guardedGenerated = jvm.jit.structuredSsa.compile(caller);
  t.ok(guardedGenerated?.jvmStructuredSource.includes(
    'class initialization in direct alpha-masked blit'),
  'a loaded target retains the intrinsic behind a runtime initialization guard');
  const guardedDestination = [0];
  guardedDestination.type = '[I';
  const guardedSource = [0xffffff];
  guardedSource.type = '[I';
  const guardedFrame = new Frame(caller);
  guardedFrame.className = 'ArbitraryAlphaMaskedOwner';
  guardedFrame.locals.splice(0, 10,
    guardedDestination, guardedSource, 0, 0, 0, 1, 1, 0, 0, 128);
  thread.callStack.push(guardedFrame);
  const guardedResult =
    guardedGenerated(guardedFrame, thread, jvm.jit, false);
  t.ok(guardedResult.deopt && guardedResult.transient,
    'the initialization guard requests canonical execution');
  t.deepEqual(guardedDestination, Object.assign([0], { type: '[I' }),
    'the initialization guard runs before pixel side effects');
  t.equal(guardedFrame.pc, 10,
    'the initialization fallback records the unexecuted invoke PC');
  thread.callStack.pop();

  jvm.classInitializationState.set('ArbitraryAlphaMaskedOwner', 'INITIALIZED');
  const initializedFrame = new Frame(caller);
  initializedFrame.className = 'ArbitraryAlphaMaskedOwner';
  initializedFrame.locals.splice(0, 10,
    guardedDestination, guardedSource, 0, 0, 0, 1, 1, 0, 0, 128);
  thread.callStack.push(initializedFrame);
  guardedGenerated(initializedFrame, thread, jvm.jit, false);
  t.equal(guardedDestination[0], 0x7f7f7f,
    'the same compiled caller enters the intrinsic after initialization');

  blit.attributes[0].code.codeItems[39].instruction.arg = 7;
  t.equal(jvm.jit.getSynchronousIntrinsic(blit, blit.descriptor), null,
    'an altered packed shift rejects the structural intrinsic');
  t.end();
});

test('javac glyph wrappers are recognized structurally after arbitrary renaming', async (t) => {
  const classpath = compileJavaFixture(t, 'ArbitraryGlyphWrapperFixture', `
final class ArbitraryRasterState {
  static int surfaceWidth;
  static int clipTop;
  static int clipBottom;
  static int clipLeft;
  static int clipRight;
  static int[] scanlineClip;
  static int[] pixels;
  static int[] auxiliaryClip;
}

public final class ArbitraryGlyphWrapperFixture {
  private byte[][] arbitraryMasks;

  private static void arbitraryComplexRaster(int[] pixels, byte[] mask, int x, int y,
      int width, int height, int color, int maskOffset, int destinationOffset,
      int destinationSkip, int maskSkip, int[] scanlineClip, int[] auxiliaryClip) {
  }

  private static void arbitrarySimpleRaster(int[] pixels, byte[] mask, int color,
      int maskOffset, int destinationOffset, int width, int height,
      int destinationSkip, int maskSkip) {
  }

  final void arbitraryRender(int glyph, int x, int y, int width, int height,
      int color, boolean ignored) {
    int destinationOffset = 0;
    int destinationSkip = 0;
    int maskSkip = 0;
    int maskOffset = 0;
    int clipped = 0;
    L0: {
      destinationOffset = x + y * ArbitraryRasterState.surfaceWidth;
      destinationSkip = ArbitraryRasterState.surfaceWidth - width;
      maskSkip = 0;
      maskOffset = 0;
      if (y >= ArbitraryRasterState.clipTop) {
        break L0;
      } else {
        clipped = ArbitraryRasterState.clipTop - y;
        height = height - clipped;
        y = ArbitraryRasterState.clipTop;
        maskOffset = maskOffset + clipped * width;
        destinationOffset =
            destinationOffset + clipped * ArbitraryRasterState.surfaceWidth;
        break L0;
      }
    }
    L1: {
      if (y + height <= ArbitraryRasterState.clipBottom) {
        break L1;
      } else {
        height = height -
            (y + height - ArbitraryRasterState.clipBottom);
        break L1;
      }
    }
    L2: {
      if (x >= ArbitraryRasterState.clipLeft) {
        break L2;
      } else {
        clipped = ArbitraryRasterState.clipLeft - x;
        width = width - clipped;
        x = ArbitraryRasterState.clipLeft;
        maskOffset = maskOffset + clipped;
        destinationOffset = destinationOffset + clipped;
        maskSkip = maskSkip + clipped;
        destinationSkip = destinationSkip + clipped;
        break L2;
      }
    }
    L3: {
      if (x + width <= ArbitraryRasterState.clipRight) {
        break L3;
      } else {
        clipped = x + width - ArbitraryRasterState.clipRight;
        width = width - clipped;
        maskSkip = maskSkip + clipped;
        destinationSkip = destinationSkip + clipped;
        break L3;
      }
    }
    L4: {
      if (width <= 0) {
        break L4;
      } else {
        if (height > 0) {
          L5: {
            if (ArbitraryRasterState.scanlineClip == null) {
              ArbitraryGlyphWrapperFixture.arbitrarySimpleRaster(
                  ArbitraryRasterState.pixels, this.arbitraryMasks[glyph],
                  color, maskOffset, destinationOffset, width, height,
                  destinationSkip, maskSkip);
              break L5;
            } else {
              ArbitraryGlyphWrapperFixture.arbitraryComplexRaster(
                  ArbitraryRasterState.pixels, this.arbitraryMasks[glyph],
                  x, y, width, height, color, maskOffset, destinationOffset,
                  destinationSkip, maskSkip, ArbitraryRasterState.scanlineClip,
                  ArbitraryRasterState.auxiliaryClip);
              break L5;
            }
          }
          return;
        } else {
          break L4;
        }
      }
    }
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: true,
  } });
  await jvm.loadClassByName('ArbitraryGlyphWrapperFixture');
  const method = await jvm.findMethodInHierarchy(
    'ArbitraryGlyphWrapperFixture', 'arbitraryRender', '(IIIIIIZ)V');
  const intrinsic = jvm.jit.getSynchronousIntrinsic(method, method.descriptor);
  t.equal(intrinsic?.jvmDirectKind, 'maskedGlyph',
    'the complete javac shape is recognized without owner, method, or field names');

  const codeItems = method.attributes.find((attribute) => attribute.type === 'code')
    .code.codeItems;
  const calls = codeItems.filter((item) => item.instruction?.op === 'invokestatic');
  const originalDescriptor = calls[0].instruction.arg[2][1];
  calls[0].instruction.arg[2][1] = '([I[BIIIIII)V';
  t.equal(jvm.jit.getSynchronousIntrinsic(method, method.descriptor), null,
    'an altered raster descriptor rejects the wrapper');
  calls[0].instruction.arg[2][1] = originalDescriptor;

  const branches = codeItems.filter((item) => item.instruction?.op === 'if_icmplt');
  branches[0].instruction.op = 'if_icmpge';
  t.equal(jvm.jit.getSynchronousIntrinsic(method, method.descriptor), null,
    'an altered clipping branch rejects the wrapper');
  branches[0].instruction.op = 'if_icmplt';

  const statics = codeItems.filter((item) => item.instruction?.op === 'getstatic');
  const originalField = statics[15].instruction.arg;
  statics[15].instruction.arg =
    ['Field', 'ArbitraryRasterState', ['differentPixels', '[I']];
  t.equal(jvm.jit.getSynchronousIntrinsic(method, method.descriptor), null,
    'an altered repeated-field relationship rejects the wrapper');
  statics[15].instruction.arg = originalField;
  t.end();
});

test('generated callers memoize structurally pure integral leaves', async (t) => {
  const classpath = compileJavaFixture(t, 'ArbitraryPureIntegralLeaf', `
public class ArbitraryPureIntegralLeaf {
  static boolean alternate;
  static int sideEffects;
  static int observed;

  static byte transform(char value, byte tag) {
    int bias = alternate ? 7 : 3;
    if (value == 101) bias += 1;
    if (value == 102) bias += 2;
    if (value == 103) bias += 3;
    if (value == 104) bias += 4;
    if (value == 105) bias += 5;
    if (value == 106) bias += 6;
    if (value == 107) bias += 7;
    if (value == 108) bias += 8;
    if (value == 109) bias += 9;
    if (value == 110) bias += 10;
    return (byte) (value + tag + bias);
  }

  static byte impure(char value, byte tag) {
    sideEffects++;
    return (byte) (value + tag);
  }

  public static int repeat(int count, char value) {
    int result = 0;
    for (int index = 0; index < count; index++) {
      result += transform(value, (byte) 28);
    }
    return result;
  }

  public static void run(int count, char value) {
    observed = repeat(count, value);
  }
}
`);
  const jvm = new JVM({
    classpath,
    jit: {
      warmupThreshold: 0,
      structuredSsa: true,
      preferWholeMethodJs: true,
      memoizedIntegralLeaves: true,
    },
  });
  await jvm.loadClassByName('ArbitraryPureIntegralLeaf');
  const owner = jvm.classes.ArbitraryPureIntegralLeaf;
  jvm.classInitializationState.set('ArbitraryPureIntegralLeaf', 'INITIALIZED');
  owner.staticFields.set('alternate:Z', 0);
  owner.staticFields.set('sideEffects:I', 0);
  owner.staticFields.set('observed:I', 0);
  const transform = await jvm.findMethodInHierarchy(
    'ArbitraryPureIntegralLeaf', 'transform', '(CB)B');
  const impure = await jvm.findMethodInHierarchy(
    'ArbitraryPureIntegralLeaf', 'impure', '(CB)B');
  t.ok(jvm.jit.getMemoizedIntegralLeaf(
    transform, ['char', 'byte'], 'byte'),
  'a renamed pure primitive leaf with a scalar static dependency is admitted');
  t.equal(jvm.jit.getMemoizedIntegralLeaf(
    impure, ['char', 'byte'], 'byte'), null,
  'a static write rejects memoization');

  const thread = {
    id: 0, name: 'memoized-integral-leaf', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  await invoke(jvm, thread, 'ArbitraryPureIntegralLeaf', 'run', '(IC)V', [100, 65]);
  t.equal(owner.staticFields.get('observed:I'), 9600,
    'memoization preserves the first dependency state result');
  const hitsAfterFirst = jvm.jit.memoizedIntegralLeafHitCount;
  t.ok(hitsAfterFirst >= 99,
    'all repeated inputs after the first successful execution use the cached scalar result');

  owner.staticFields.set('alternate:Z', 1);
  const beforeMisses = jvm.jit.memoizedIntegralLeafMissCount;
  await invoke(jvm, thread, 'ArbitraryPureIntegralLeaf', 'run', '(IC)V', [100, 65]);
  t.equal(owner.staticFields.get('observed:I'), 10000,
    'memoization preserves the changed dependency state result');
  t.ok(jvm.jit.memoizedIntegralLeafMissCount > beforeMisses,
    'a changed static dependency selects a new key instead of reusing stale output');
  t.equal(owner.staticFields.get('sideEffects:I'), 0,
    'the optimization never executes or caches an impure sibling');
  t.end();
});

test('structural packed-color scanline intrinsic preserves pixel arithmetic', (t) => {
  const jvm = new JVM({ jit: {
    warmupThreshold: 0,
    guestKernelOracles: true,
  } });
  jvm.classes.Flags = {
    staticFields: new Map([['enabled:Z', 0]]),
    ast: { classes: [{ superClassName: null }] },
  };
  jvm.classInitializationState.set('Flags', 'INITIALIZED');
  const flag = ['Field', 'Flags', ['enabled', 'Z']];
  const integerAnd = () => ({
    instruction: { op: 'invokestatic', arg: ['Method', 'Masks', ['and', '(II)I']] },
  });
  const items = [
    { instruction: { op: 'getstatic', arg: flag } },
    ...['istore', 'iload', 'bipush', 'if_icmpeq', 'bipush'].map((instruction) => ({ instruction })),
    integerAnd(),
    ...['goto', 'athrow', 'iinc', 'iaload'].map((instruction) => ({ instruction })),
    integerAnd(), integerAnd(),
    { instruction: 'iastore' },
    ...[
      9, 8355711, -852264639, 65280, -1295343735,
      1494704929, 16711680, 200866833, 255,
    ].map((arg) => ({ instruction: { op: 'ldc', arg } })),
  ];
  const method = {
    attributes: [{ type: 'code', code: { codeItems: items } }],
  };
  const intrinsic = jvm.jit.getSynchronousIntrinsic(method, '(IIIIIII[III)V');
  t.equal(typeof intrinsic, 'function', 'packed-color scanline shape is recognized');

  const pixels = [0x123456, 0xabcdef];
  intrinsic([0x224400, 0, 0x200, 2, 0x6688aa, 2, 9, pixels, 0x336699, 0x20000], 0);
  t.deepEqual(pixels, [0x3c2b44, 0x887791],
    'native scanline loop matches generated integer shifts, masks, and overflow');
  const directPixels = [0x123456, 0xabcdef];
  jvm.classInitializationState.set('RasterLine', 'INITIALIZED');
  jvm.jit.packedColorScanlineDirect(
    0x224400, 0, 0x200, 2, 0x6688aa, 2, 9, directPixels, 0x336699, 0x20000, 0,
    'RasterLine',
  );
  t.deepEqual(directPixels, pixels,
    'stackless direct scanline path preserves intrinsic pixel arithmetic');
  t.end();
});

test('structural constant-color scanline intrinsic preserves pixel arithmetic', (t) => {
  const jvm = new JVM({ jit: {
    warmupThreshold: 0,
    guestKernelOracles: true,
  } });
  jvm.classes.Flags = {
    staticFields: new Map([['enabled:Z', 0]]),
    ast: { classes: [{ superClassName: null }] },
  };
  jvm.classInitializationState.set('Flags', 'INITIALIZED');
  const flag = ['Field', 'Flags', ['enabled', 'Z']];
  const prefix = [
    { instruction: { op: 'getstatic', arg: flag } },
    ...[
      'istore', 'iload_1', 'bipush', 'if_icmpeq', 'bipush', 'bipush',
      'aconst_null', 'checkcast', 'bipush', 'bipush',
    ].map((instruction) => ({ instruction })),
    { instruction: {
      op: 'invokestatic', arg: ['Method', 'Masks', ['and', '(II)I']],
    } },
    ...['goto', 'athrow', 'iinc', 'iaload', 'iastore'].map((instruction) => ({ instruction })),
    ...[57, 16711422, -59233087].map((arg) => ({ instruction: { op: 'ldc', arg } })),
  ];
  const method = {
    attributes: [{ type: 'code', code: { codeItems: prefix } }],
  };
  const intrinsic = jvm.jit.getSynchronousIntrinsic(method, '(IB[III)V');
  t.equal(typeof intrinsic, 'function', 'constant-color scanline shape is recognized');

  const pixels = [0x123456, 0xabcdef];
  intrinsic([0, 57, pixels, 0x10203, 2], 0);
  t.deepEqual(pixels, [0x0a1c2e, 0x56687a],
    'native constant-color loop matches generated mask, shift, and addition');
  t.end();
});

test('stackless integer raster preserves operands across chained branches', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0 } });
  const codeItems = [
    { labelDef: 'L0:', instruction: 'iload_0' },
    { labelDef: 'L1:', instruction: 'iload_1' },
    { labelDef: 'L2:', instruction: 'iload_2' },
    { labelDef: 'L3:', instruction: { op: 'ifne', arg: 'Lnonzero' } },
    { labelDef: 'L4:', instruction: { op: 'if_icmplt', arg: 'Lless' } },
    { labelDef: 'L5:', instruction: 'iconst_0' },
    { labelDef: 'L6:', instruction: { op: 'istore', arg: 17 } },
    { labelDef: 'L7:', instruction: { op: 'goto', arg: 'Lreturn' } },
    { labelDef: 'Lless:', instruction: 'iconst_1' },
    { labelDef: 'L9:', instruction: { op: 'istore', arg: 17 } },
    { labelDef: 'L10:', instruction: { op: 'goto', arg: 'Lreturn' } },
    { labelDef: 'Lnonzero:', instruction: 'pop' },
    { labelDef: 'L12:', instruction: 'pop' },
    { labelDef: 'L13:', instruction: 'iconst_2' },
    { labelDef: 'L14:', instruction: { op: 'istore', arg: 17 } },
    { labelDef: 'Lreturn:', instruction: 'return' },
  ];
  for (let i = 0; i < 301; i += 1) {
    codeItems.push({ labelDef: `LUload${i}:`, instruction: { op: 'iload', arg: 0 } });
  }
  for (let i = 0; i < 101; i += 1) {
    codeItems.push({ labelDef: `LUstore${i}:`, instruction: { op: 'istore', arg: 20 } });
  }
  for (let i = 0; i < 5; i += 1) {
    codeItems.push({
      labelDef: `LUcall${i}:`,
      instruction: {
        op: 'invokestatic',
        arg: ['Method', 'RasterLine', ['draw', '(IIIIIII[III)V']],
      },
    });
  }
  while (codeItems.length < 1000) {
    codeItems.push({ labelDef: `LUnop${codeItems.length}:`, instruction: 'nop' });
  }
  const method = {
    name: 'a',
    descriptor: '(IIIIIIIBIIII[IIIII)V',
    attributes: [{ type: 'code', code: { codeItems, exceptionTable: [] } }],
  };
  const generated = jvm.jit.compileStacklessIntegerRaster(method);
  t.ok(generated && generated.jvmStacklessRaster,
    'large structurally recognized raster selects stackless code generation');

  const run = (left, right, bypass) => {
    const frame = {
      method,
      instructions: codeItems,
      locals: new Array(43).fill(null),
      stack: { items: [] },
      pc: 0,
    };
    frame.locals[0] = left;
    frame.locals[1] = right;
    frame.locals[2] = bypass;
    const callStack = new Stack();
    callStack.push(frame);
    generated(frame, { status: 'runnable', callStack }, jvm.jit, false);
    return frame.locals[17];
  };
  t.equal(run(5, 10, 0), 1,
    'second branch sees the two values preserved by the first branch');
  t.equal(run(10, 5, 0), 0, 'comparison false path remains correct');
  t.equal(run(5, 10, 1), 2, 'first branch target retains and discards both values');
  t.end();
});

function scalarIntegerLoopMethod(name = 'nameDoesNotMatter', exceptionTable = []) {
  const instructions = [
    'iconst_0', 'istore_2', 'iload_2', 'iload_0',
    { op: 'if_icmpge', arg: 'Lreturn' },
    'iload_1', 'iload_2', 'iadd', 'istore_1',
    { op: 'iinc', varnum: 2, incr: 1 },
    { op: 'goto', arg: 'Lloop' }, 'iload_1', 'ireturn',
  ];
  return {
    name, descriptor: '(II)I', flags: ['public', 'static'],
    attributes: [{ type: 'code', code: {
      codeItems: instructions.map((instruction, index) => ({
        labelDef: index === 2 ? 'Lloop:' : index === 11 ? 'Lreturn:' : `L${index}:`,
        instruction,
      })),
      localsSize: '3', stackSize: '2', exceptionTable,
    } }],
  };
}

test('scalar integer loops are selected by verified structure and spill at safe points', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0, profileMethods: false } });
  // Force the "yield due" side of the safe-point policy so the spill path is
  // exercised deterministically; quantum continuation has its own test.
  jvm._nextEventLoopYieldAt = 0;
  const method = scalarIntegerLoopMethod('arbitraryObfuscatedName');
  const generated = jvm.jit.compileScalarIntegerLoop(method);
  t.ok(generated && generated.jvmScalarLoop,
    'a handler-free integer backedge selects scalar code generation');

  const frame = new Frame(method);
  frame.className = 'ShapeOwner';
  frame.locals[0] = 10001;
  frame.locals[1] = 7;
  const callStack = new Stack();
  callStack.push(frame);
  const thread = { status: 'runnable', callStack };
  const safePoint = generated(frame, thread, jvm.jit, false);
  t.ok(safePoint.deopt && safePoint.transient,
    'the generated loop exits transiently at its bounded backedge safe point');
  t.equal(frame.pc, 2, 'safe point records the exact loop-header PC');
  t.equal(frame.locals[2], 10000, 'scalar induction variable is materialized');
  t.equal(frame.locals[1], 49995007, 'scalar accumulator is materialized');
  t.deepEqual(frame.stack.items, [], 'operand stack is materialized at the empty join');
  t.equal(jvm.jit.scalarLoopSafePointCount, 1, 'safe-point exit is counted');

  delete frame.jitSkipOnce;
  const completed = generated(frame, thread, jvm.jit, false);
  t.ok(completed.returned, 'materialized loop state resumes and completes');
  t.equal(completed.value, 50005007, 'resumed scalar result matches Java integer arithmetic');
  t.equal(jvm.jit.scalarLoopRunCount, 2, 'both scalar entries are counted');

  const renamed = scalarIntegerLoopMethod('totallyDifferentName');
  t.ok(jvm.jit.compileScalarIntegerLoop(renamed)?.jvmScalarLoop,
    'renaming the same bytecode shape does not affect selection');
  const guarded = scalarIntegerLoopMethod('guarded', [{ handlerLbl: 'Lreturn' }]);
  t.equal(jvm.jit.compileScalarIntegerLoop(guarded), null,
    'an exception table rejects the scalar tier');
  const disabled = new JVM({ jit: { scalarLoops: false, profileMethods: false } });
  t.equal(disabled.jit.compileScalarIntegerLoop(method), null,
    'the scalar tier can be disabled for differential measurement');
  t.end();
});

test('safe points continue the quantum when the scheduler has nothing due', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0, profileMethods: false } });
  jvm._nextEventLoopYieldAt = Date.now() + 60000;
  const method = scalarIntegerLoopMethod('arbitraryObfuscatedName');
  const generated = jvm.jit.compileScalarIntegerLoop(method);

  const run = (thread) => {
    const frame = new Frame(method);
    frame.locals[0] = 25001;
    frame.locals[1] = 7;
    thread.callStack.push(frame);
    return { result: generated(frame, thread, jvm.jit, false), frame };
  };

  const soloStack = new Stack();
  const solo = run({ status: 'runnable', callStack: soloStack });
  t.ok(solo.result.returned, 'a solo runnable thread runs past the budget boundary');
  t.equal(solo.result.value, (25000 * 25001) / 2 + 7 | 0,
    'the continued quantum preserves Java integer arithmetic');
  t.equal(jvm.jit.scalarLoopSafePointCount, 0, 'no safe-point exit was recorded');

  jvm.threads.push({ status: 'runnable' });
  const contendedStack = new Stack();
  const contended = run({ status: 'runnable', callStack: contendedStack });
  t.ok(contended.result.deopt && contended.result.transient,
    'a second runnable thread forces the safe-point exit');
  t.equal(jvm.jit.scalarLoopSafePointCount, 1, 'the contended safe point is counted');
  jvm.threads.pop();

  jvm.threads.push({ status: 'SLEEPING', sleepUntil: Date.now() - 1 });
  const timerStack = new Stack();
  const timed = run({ status: 'runnable', callStack: timerStack });
  t.ok(timed.result.deopt && timed.result.transient,
    'an expired sleep deadline forces the safe-point exit');
  jvm.threads.pop();

  jvm._nextEventLoopYieldAt = 0;
  const dueStack = new Stack();
  const due = run({ status: 'runnable', callStack: dueStack });
  t.ok(due.result.deopt && due.result.transient,
    'an expired event-loop yield deadline forces the safe-point exit');
  t.end();
});

test('scalar loop debugger entry guard falls back before side effects', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0, profileMethods: false } });
  const method = scalarIntegerLoopMethod();
  const generated = jvm.jit.compileScalarIntegerLoop(method);
  const frame = new Frame(method);
  frame.locals[0] = 20;
  frame.locals[1] = 9;
  const callStack = new Stack();
  callStack.push(frame);
  const result = generated(frame, { status: 'runnable', callStack }, jvm.jit, true);
  t.ok(result.deopt && result.transient, 'debug entry takes the existing execution path');
  t.equal(frame.pc, 0, 'debug fallback leaves the bytecode PC unchanged');
  t.equal(frame.locals[1], 9, 'debug fallback leaves locals unchanged');
  t.equal(jvm.jit.scalarLoopRunCount, 0, 'guard runs before the scalar-loop side effect counter');
  t.end();
});

function structuredSsaJoinMethod() {
  const instructions = [
    { op: 'bipush', arg: '5' }, 'iconst_0', 'istore_1', 'iload_1', 'iload_0',
    { op: 'if_icmpge', arg: 'Lreturn' },
    'iload_1', 'iadd', { op: 'iinc', varnum: 1, incr: 1 },
    { op: 'goto', arg: 'Lloop' }, 'ireturn',
  ];
  return {
    name: 'operandJoin', descriptor: '(I)I', flags: ['public', 'static'],
    attributes: [{ type: 'code', code: {
      codeItems: instructions.map((instruction, index) => ({
        labelDef: index === 3 ? 'Lloop:' : index === 10 ? 'Lreturn:' : `L${index}:`,
        instruction,
      })),
      localsSize: '2', stackSize: '3', exceptionTable: [],
    } }],
  };
}

function invertedCountedLoopMethod() {
  const instructions = [
    'iconst_0', 'istore_1', 'iload_1', 'iload_0',
    { op: 'if_icmplt', arg: 'Lbody' },
    'iload_1', 'ireturn',
    { op: 'iinc', varnum: 1, incr: 1 },
    { op: 'goto', arg: 'Lheader' },
  ];
  return {
    name: 'invertedCountedLoop', descriptor: '(I)I',
    flags: ['public', 'static'],
    attributes: [{ type: 'code', code: {
      codeItems: instructions.map((instruction, index) => ({
        labelDef: index === 2 ? 'Lheader:' :
          index === 7 ? 'Lbody:' : `L${index}:`,
        instruction,
      })),
      localsSize: '2', stackSize: '2', exceptionTable: [],
    } }],
  };
}

test('structured SSA recognizes javac inverted counted-loop layout', (t) => {
  const jvm = new JVM({ jit: {
    structuredSsa: true,
    structuredAtomicBoundedLoops: false,
    profileMethods: false,
  } });
  const method = invertedCountedLoopMethod();
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated?.jvmStructuredSsa,
    'the structurally inverted loop selects structured SSA');
  t.equal(generated.jvmStructuredCountedLoopCount, 1,
    'the taken-body/fallthrough-exit layout retains its induction proof');
  t.ok(generated.jvmStructuredSource.includes('while (local1 < local0)') &&
      !generated.jvmStructuredSource.includes('if (ssaValue'),
    'the inverted header canonicalizes to one ordinary counted loop');

  const frame = new Frame(method);
  frame.locals[0] = 17;
  const callStack = new Stack();
  callStack.push(frame);
  const result = generated(frame,
    { status: 'runnable', callStack }, jvm.jit, false);
  t.deepEqual(result, { returned: true, value: 17 },
    'the canonical loop preserves the original taken-body semantics');
  t.end();
});

test('structured JVM SSA feeds operand values across block joins', (t) => {
  const jvm = new JVM({ jit: { structuredSsa: true, profileMethods: false } });
  const method = structuredSsaJoinMethod();
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated?.jvmStructuredSsa, 'verified reducible loop selects the structured SSA renderer');
  t.ok(generated.jvmStructuredSource.includes('while (') &&
      !generated.jvmStructuredSource.includes('switch (pc)'),
    'renderer emits lexical JavaScript control flow instead of a bytecode dispatcher');
  t.ok(/ssaStack\d+_0 = ssaValue\d+/.test(generated.jvmStructuredSource),
    'predecessor edge explicitly feeds its operand value into the successor join');
  t.ok(generated.jvmStructuredReusedLocalLoadCount > 0,
    'repeated block-local JVM loads reuse an immutable SSA snapshot');

  const frame = new Frame(method);
  frame.locals[0] = 10;
  const callStack = new Stack();
  callStack.push(frame);
  const result = generated(frame, { status: 'runnable', callStack }, jvm.jit, false);
  t.deepEqual(result, { returned: true, value: 50 }, 'loop result preserves the live operand phi value');
  t.equal(jvm.jit.structuredSsa.runCount, 1, 'successful structured entries are counted');
  t.equal(callStack.size(), 0, 'normal return removes the generated frame');

  const combined = new JVM({ jit: { rendererPipeline: true, profileMethods: false } });
  t.ok(combined.jit.scalarGuestBodiesEnabled &&
      combined.jit.structuredSsa.enabled,
    'renderer-pipeline composes the generic scalar and structured SSA tiers');
  t.ok(combined.jit.fusedRegions.enabled,
    'verified intermethod regions are enabled by default');
  const explicitlyDisabledFused = new JVM({ jit: {
    rendererPipeline: true,
    fusedRegions: false,
    profileMethods: false,
  } });
  t.notOk(explicitlyDisabledFused.jit.fusedRegions.enabled,
    'the generic region tier remains controllable through its explicit switch');
  t.end();
});

test('structured JVM SSA emits acyclic regions as ordinary functions', (t) => {
  const method = {
    name: 'acyclicBranch', descriptor: '(I)I', flags: ['static'],
    attributes: [{ type: 'code', code: {
      localsSize: '1', stackSize: '2', exceptionTable: [],
      codeItems: [
        { labelDef: 'L0:', instruction: 'iload_0' },
        { instruction: 'iconst_0' },
        { instruction: { op: 'if_icmple', arg: 'Lelse' } },
        { instruction: 'iload_0' },
        { instruction: 'iconst_2' },
        { instruction: 'imul' },
        { instruction: 'ireturn' },
        { labelDef: 'Lelse:', instruction: 'iconst_1' },
        { instruction: 'ireturn' },
      ],
    } }],
  };
  const jvm = new JVM({ jit: { structuredSsa: true } });
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated?.jvmStructuredSsa,
    'verified acyclic control flow selects the SSA block renderer');
  t.notOk(generated?.jvmStructuredContinuation,
    'acyclic region does not allocate a generator continuation');

  const run = (input) => {
    const frame = new Frame(method);
    frame.locals[0] = input;
    const callStack = new Stack();
    callStack.push(frame);
    const result = generated(frame, { status: 'runnable', callStack }, jvm.jit, false);
    return result.value;
  };
  t.equal(run(7), 14, 'taken acyclic arm preserves its operand values');
  t.equal(run(-3), 1, 'fall-through acyclic arm preserves its return value');
  t.end();
});

test('structured SSA reuses static array views only within an effect-free block', async (t) => {
  const classpath = compileJavaFixture(t, 'StructuredStaticArrayHarness', `
public class StructuredStaticArrayHarness {
  static int[] pixels;
  static int[] replacement;

  static void swap() {
    pixels = replacement;
  }

  public static void writeAcrossCall() {
    pixels[0] = 1;
    swap();
    pixels[0] = 2;
    for (int i = 1; i < 2; i++) pixels[i] = 3;
  }
}
`);
  const jvm = new JVM({
    classpath,
    jit: { warmupThreshold: 0, structuredSsa: true, preferWholeMethodJs: true },
  });
  await jvm.loadClassByName('StructuredStaticArrayHarness');
  const owner = jvm.classes.StructuredStaticArrayHarness;
  jvm.classInitializationState.set('StructuredStaticArrayHarness', 'INITIALIZED');
  const original = [0, 0];
  original.type = '[I';
  const replacement = [0, 0];
  replacement.type = '[I';
  owner.staticFields.set('pixels:[I', original);
  owner.staticFields.set('replacement:[I', replacement);
  const thread = {
    id: 0, name: 'structured-static-array', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  await invoke(jvm, thread, 'StructuredStaticArrayHarness',
    'writeAcrossCall', '()V', []);

  const method = await jvm.findMethodInHierarchy(
    'StructuredStaticArrayHarness', 'writeAcrossCall', '()V');
  const generated = jvm.jit.codegenCache.get(method);
  t.ok(generated?.jvmStructuredSsa,
    'verified static-array loop selects structured SSA');
  t.notOk(generated.jvmStructuredSource.includes('normalizeArrayStore'),
    'int stores narrow directly in generated JavaScript');
  t.deepEqual(original.slice(), [1, 0],
    'stores before a call retain the original static target');
  t.deepEqual(replacement.slice(), [2, 3],
    'a call invalidates the block-local target before later stores');
  t.end();
});

test('structured JVM SSA folds constant entry stores into exact local declarations', (t) => {
  const instructions = [
    'iconst_0', 'istore_2', 'aconst_null', 'astore_3',
    'iload_0', { op: 'ifne', arg: 'LloopInit' },
    'iconst_1', 'iconst_0', 'idiv', 'pop',
    'iconst_0', 'istore_1',
    'iload_1', 'iload_0', { op: 'if_icmpge', arg: 'Lreturn' },
    'iload_2', 'iload_1', 'iadd', 'istore_2',
    { op: 'iinc', varnum: 1, incr: 1 }, { op: 'goto', arg: 'Lloop' },
    'iload_2', 'ireturn',
  ];
  const method = {
    name: 'entryDefaults', descriptor: '(I)I', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: instructions.map((instruction, index) => ({
        labelDef: index === 10 ? 'LloopInit:' : index === 12 ? 'Lloop:'
          : index === 21 ? 'Lreturn:' : `L${index}:`,
        instruction,
      })),
      localsSize: '4', stackSize: '2', exceptionTable: [],
    } }],
  };
  const jvm = new JVM({ jit: { structuredSsa: true, profileMethods: false } });
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated?.jvmStructuredSsa, 'loop with a constant prologue selects structured SSA');
  t.ok(generated.jvmStructuredSource.includes('let local2 = 0;') &&
      generated.jvmStructuredSource.includes('locals[3] = null;'),
    'constant/null stores initialize or directly materialize exact values');
  t.notOk(generated.jvmStructuredSource.includes('local3 ='),
    'an unread immutable entry local is not captured as a mutable scalar');
  t.notOk(/^local(?:2 = 0|3 = null);$/m.test(generated.jvmStructuredSource),
    'the bytecode stores are not emitted a second time');
  t.equal(generated.jvmStructuredEliminatedLocalStoreCount, 2,
    'both folded prologue stores are reported');

  const normalFrame = new Frame(method);
  normalFrame.locals[0] = 5;
  normalFrame.locals[2] = 777;
  normalFrame.locals[3] = { stale: true };
  const normalStack = new Stack();
  normalStack.push(normalFrame);
  const normal = generated(normalFrame, { status: 'runnable', callStack: normalStack }, jvm.jit, false);
  t.deepEqual(normal, { returned: true, value: 10 }, 'folded locals preserve normal loop semantics');
  t.equal(normalFrame.locals[2], 10, 'normal return spills the final scalar value');
  t.equal(normalFrame.locals[3], null, 'normal return spills the folded null value');

  const throwingFrame = new Frame(method);
  throwingFrame.locals[0] = 0;
  throwingFrame.locals[2] = 777;
  throwingFrame.locals[3] = { stale: true };
  const throwingStack = new Stack();
  throwingStack.push(throwingFrame);
  let thrown;
  try {
    generated(throwingFrame, { status: 'runnable', callStack: throwingStack }, jvm.jit, false);
  } catch (error) {
    thrown = error;
  }
  t.equal(thrown?.type, 'java/lang/ArithmeticException', 'throwing path retains JVM arithmetic semantics');
  t.equal(throwingFrame.locals[2], 0, 'exception materialization observes the folded integer store');
  t.equal(throwingFrame.locals[3], null, 'exception materialization observes the folded null store');

  const guardedFrame = new Frame(method);
  guardedFrame.locals[0] = 5;
  guardedFrame.locals[2] = 777;
  const guardedStack = new Stack();
  guardedStack.push(guardedFrame);
  const guarded = generated(guardedFrame,
    { status: 'runnable', callStack: guardedStack }, jvm.jit, true);
  t.ok(guarded.deopt && guarded.transient, 'debug entry still falls back');
  t.equal(guardedFrame.locals[2], 777, 'entry guard runs before folded-local state exists');
  t.end();
});

test('structured JVM SSA guards and folds initialized boolean static control flow', (t) => {
  const flagField = ['Field', 'ArbitraryFlags', ['enabled', 'Z']];
  const instructions = [
    { op: 'getstatic', arg: flagField }, { op: 'ifeq', arg: 'Lfast' },
    { op: 'sipush', arg: 100 }, 'istore_1', { op: 'goto', arg: 'Lloop' },
    'iconst_0', 'istore_1',
    'iload_1', 'iload_0', { op: 'if_icmpge', arg: 'Lreturn' },
    { op: 'iinc', varnum: 1, incr: 1 }, { op: 'goto', arg: 'Lloop' },
    'iload_1', 'ireturn',
  ];
  const method = {
    name: 'unrelatedControlLoop', descriptor: '(I)I', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: instructions.map((instruction, index) => ({
        labelDef: index === 5 ? 'Lfast:' : index === 7 ? 'Lloop:'
          : index === 12 ? 'Lreturn:' : `L${index}:`,
        instruction,
      })),
      localsSize: '2', stackSize: '2', exceptionTable: [],
    } }],
  };
  const jvm = new JVM({ jit: { structuredSsa: true, profileMethods: false } });
  jvm.classes.ArbitraryFlags = {
    staticFields: new Map([['enabled:Z', 0]]),
    ast: { classes: [{ superClassName: null, items: [] }] },
  };
  jvm.classInitializationState.set('ArbitraryFlags', 'INITIALIZED');
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated?.jvmStructuredSsa, 'boolean-controlled loop selects structured SSA');
  t.equal(generated.jvmStructuredContinuation, true,
    'guarded loop retains lexical continuations with a resume-time guard');
  t.equal(generated.jvmStructuredGuardedBooleanSiteCount, 1,
    'one descriptor/location-derived boolean site is guarded');
  t.ok(generated.jvmStructuredSource.includes('structured SSA static boolean guard'),
    'the observed value is checked at entry');
  t.notOk(generated.jvmStructuredSource.includes('local1 = 100;'),
    'the unreachable diagnostic branch is absent from emitted JavaScript');

  const frame = new Frame(method);
  frame.locals[0] = 4;
  const stack = new Stack();
  stack.push(frame);
  const result = generated(frame, { status: 'runnable', callStack: stack }, jvm.jit, false);
  t.deepEqual(result, { returned: true, value: 4 }, 'constant-folded branch preserves the observed path');

  jvm.classes.ArbitraryFlags.staticFields.set('enabled:Z', 1);
  const changedFrame = new Frame(method);
  changedFrame.locals[0] = 4;
  changedFrame.locals[1] = 77;
  const changedStack = new Stack();
  changedStack.push(changedFrame);
  const changed = generated(changedFrame,
    { status: 'runnable', callStack: changedStack }, jvm.jit, false);
  t.ok(changed.deopt && changed.transient, 'changed static value falls back to normal execution');
  t.equal(changedFrame.pc, 0, 'guard fallback leaves the bytecode PC at entry');
  t.equal(changedFrame.locals[1], 77, 'guard fallback precedes guest local writes');
  t.equal(jvm.jit.structuredSsa.guardedBooleanFallbackCount, 1,
    'guarded fallback is counted');

  jvm.classes.ArbitraryFlags.staticFields.set('enabled:Z', 0);
  jvm._nextEventLoopYieldAt = 0;
  const yieldedFrame = new Frame(method);
  yieldedFrame.locals[0] = 20000;
  const yieldedStack = new Stack();
  yieldedStack.push(yieldedFrame);
  const yieldedThread = { status: 'runnable', callStack: yieldedStack };
  const yielded = generated(yieldedFrame, yieldedThread, jvm.jit, false);
  t.ok(yielded.deopt && generated.jvmHasStructuredContinuation(yieldedFrame),
    'the guarded loop retains its iterator at a scheduler yield');
  const yieldedPc = yieldedFrame.pc;
  const yieldedIndex = yieldedFrame.locals[1];
  jvm.classes.ArbitraryFlags.staticFields.set('enabled:Z', 1);
  const invalidated = generated(yieldedFrame, yieldedThread, jvm.jit, false);
  t.ok(invalidated.deopt && invalidated.transient,
    'a changed guarded static invalidates the suspended iterator');
  t.notOk(generated.jvmHasStructuredContinuation(yieldedFrame),
    'the stale lexical continuation is released');
  t.equal(yieldedFrame.pc, yieldedPc,
    'invalidation preserves the materialized loop bytecode PC');
  t.equal(yieldedFrame.locals[1], yieldedIndex,
    'invalidation preserves the materialized scalar loop state');
  t.equal(jvm.jit.structuredSsa.guardedBooleanFallbackCount, 2,
    'resume-time guarded fallback is counted');

  const writingMethod = {
    ...method,
    name: 'writesItsFlag',
    attributes: [{ type: 'code', code: {
      ...method.attributes[0].code,
      codeItems: [
        { labelDef: 'Lput:', instruction: 'iconst_0' },
        { labelDef: 'Lputstatic:', instruction: { op: 'putstatic', arg: flagField } },
        ...method.attributes[0].code.codeItems,
      ],
    } }],
  };
  jvm.classes.ArbitraryFlags.staticFields.set('enabled:Z', 0);
  const writingGenerated = jvm.jit.structuredSsa.compile(writingMethod);
  t.equal(writingGenerated?.jvmStructuredGuardedBooleanSiteCount, 0,
    'a method writing the same resolved location is not specialized');
  t.end();
});

test('structured JVM SSA prunes immutable local copies of guarded booleans', (t) => {
  const flagField = ['Field', 'UnrelatedRasterOptions', ['diagnostics', 'Z']];
  const instructions = [
    { op: 'getstatic', arg: flagField }, 'istore_2',
    'iconst_0', 'istore_1',
    'iload_1', 'iload_0', { op: 'if_icmpge', arg: 'Lreturn' },
    'iload_2', { op: 'ifne', arg: 'Ldiagnostic' },
    { op: 'iinc', varnum: 1, incr: 1 },
    'iload_2', { op: 'ifeq', arg: 'Lloop' },
    { op: 'goto', arg: 'Lreturn' },
    { op: 'sipush', arg: 100 }, 'istore_1',
    'iload_1', 'ireturn',
  ];
  const method = {
    name: 'arbitraryGuardedLoop', descriptor: '(I)I', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: instructions.map((instruction, index) => ({
        labelDef: index === 4 ? 'Lloop:' : index === 13 ? 'Ldiagnostic:'
          : index === 15 ? 'Lreturn:' : `L${index}:`,
        instruction,
      })),
      localsSize: '3', stackSize: '2', exceptionTable: [],
    } }],
  };
  const jvm = new JVM({ jit: { structuredSsa: true, profileMethods: false } });
  jvm.classes.UnrelatedRasterOptions = {
    staticFields: new Map([['diagnostics:Z', 0]]),
    ast: { classes: [{ superClassName: null, items: [] }] },
  };
  jvm.classInitializationState.set('UnrelatedRasterOptions', 'INITIALIZED');
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated?.jvmStructuredSsa,
    'the copied-boolean loop compiles without any guest identity gate');
  t.equal(generated.jvmStructuredPrunedBooleanCfgBranchCount, 2,
    'both branches consuming the immutable copied local are pruned');
  t.equal(generated.jvmStructuredGuardedBooleanSiteCount, 1,
    'the originating static location is guarded once before guest effects');

  const frame = new Frame(method);
  frame.locals[0] = 6;
  const stack = new Stack();
  stack.push(frame);
  const result = generated(frame,
    { status: 'runnable', callStack: stack }, jvm.jit, false);
  t.deepEqual(result, { returned: true, value: 6 },
    'the selected boolean path preserves loop results');

  jvm.classes.UnrelatedRasterOptions.staticFields.set('diagnostics:Z', 1);
  const changedFrame = new Frame(method);
  changedFrame.locals[0] = 6;
  changedFrame.locals[1] = 73;
  const changedStack = new Stack();
  changedStack.push(changedFrame);
  const changed = generated(changedFrame,
    { status: 'runnable', callStack: changedStack }, jvm.jit, false);
  t.ok(changed.deopt && changed.transient,
    'a changed source static falls back before executing the pruned CFG');
  t.equal(changedFrame.locals[1], 73,
    'the entry guard precedes every local or guest-state side effect');
  t.end();
});

test('integer leaf inlining ignores unreachable diagnostic catch tails', (t) => {
  const method = {
    name: 'arbitraryProtectedAnd', descriptor: '(II)I', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: [
        { labelDef: 'Lstart:', instruction: 'iload_0' },
        { labelDef: 'L1:', instruction: 'iload_1' },
        { labelDef: 'L2:', instruction: 'iand' },
        { labelDef: 'Lend:', instruction: 'ireturn' },
        { labelDef: 'Lhandler:', instruction: 'astore_2' },
        { labelDef: 'L5:', instruction: 'iconst_m1' },
        { labelDef: 'L6:', instruction: 'ireturn' },
      ],
      localsSize: '3', stackSize: '2',
      exceptionTable: [{ start: 'Lstart', end: 'Lend', handler: 'Lhandler', catchType: 0 }],
    } }],
  };
  const jvm = new JVM({ jit: { profileMethods: false } });
  const plan = jvm.jit.getInlineIntegerPlan(method, ['int', 'int'], 'int');
  t.ok(plan && plan.result,
    'a non-throwing normal CFG is inlined despite an obfuscator catch tail');
  t.ok(plan.statements.join(' ').includes('&'),
    'the plan is derived from the normal integer bytecodes');
  t.end();
});

test('guarded integer leaves deopt before diagnostic effects and restore arithmetic failures',
  async (t) => {
  const className = 'GuardedIntegerLeafHarness';
  const classpath = compileJavaFixture(t, className, `
public final class GuardedIntegerLeafHarness {
  static int diagnostic;

  static int rounded(int tag, int denominator, int numerator) {
    int sign = numerator >>> 31;
    if (tag != 23841) diagnostic = tag;
    return ((numerator + sign) / denominator) - sign;
  }

  static void fill(int[] destination, int tag, int denominator) {
    for (int index = 0; index < destination.length; index++) {
      destination[index] = rounded(tag, denominator, index - 4);
    }
  }
}
`);
  const jvm = new JVM({classpath, jit: {
    warmupThreshold: 0, structuredSsa: true, profileMethods: false,
  }});
  const classData = await jvm.loadClassByName(className);
  classData.staticFieldsInitialized = true;
  classData.staticFields.set('diagnostic:I', 0);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const thread = {
    id: 0, name: 'guarded-integer-leaf', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;

  const valid = new Array(8).fill(99);
  valid.type = '[I';
  await invoke(jvm, thread, className, 'fill', '([III)V',
    [valid, 23841, 3]);
  t.deepEqual(valid.slice(), [-2, -1, -1, -1, 0, 0, 0, 1],
    'the guarded lexical division preserves signed rounded results');
  const fillMethod = await jvm.findMethodInHierarchy(
    className, 'fill', '([III)V');
  const generated = jvm.jit.codegenCache.get(fillMethod);
  const generatedSource = generated?.jvmStructuredSource || '';
  t.ok(generated?.jvmStructuredSsa &&
      generatedSource.includes('guarded inline integer leaf'),
    'the caller contains a structural tag/divisor guard');
  t.notOk(generatedSource.includes('tryInvokeSyncAt'),
    'the accepted path contains no generic call dispatch');
  t.equal(classData.staticFields.get('diagnostic:I'), 0,
    'the accepted guard never executes the diagnostic branch');

  const diagnostic = new Array(2).fill(0);
  diagnostic.type = '[I';
  await invoke(jvm, thread, className, 'fill', '([III)V',
    [diagnostic, 17, 2]);
  t.equal(classData.staticFields.get('diagnostic:I'), 17,
    'a failed tag guard resumes canonical execution before the helper effect');
  t.deepEqual(diagnostic.slice(), [-2, -2],
    'canonical helper execution preserves the rejected call results');

  const arithmetic = new Array(2).fill(73);
  arithmetic.type = '[I';
  let thrown = null;
  try {
    await invoke(jvm, thread, className, 'fill', '([III)V',
      [arithmetic, 23841, 0]);
  } catch (error) {
    thrown = error;
  }
  t.equal(thrown?.type, 'java/lang/ArithmeticException',
    'a zero divisor is restored to the canonical helper exception path');
  t.deepEqual(arithmetic.slice(), [73, 73],
    'the arithmetic failure occurs before the caller store side effect');
  t.end();
});

test('counted-loop proofs follow a dominating split induction update', (t) => {
  const flagField = ['Field', 'SplitBackedgeOptions', ['diagnostics', 'Z']];
  const instructions = [
    { op: 'getstatic', arg: flagField }, { op: 'istore', arg: 4 },
    'iconst_0', 'istore_2', 'iload_1', 'ineg', 'istore_3',
    'iload_3', { op: 'ifge', arg: 'Lreturn' },
    'aload_0', 'iload_2', 'iload_2', 'iastore',
    { op: 'iinc', varnum: 2, incr: 1 },
    { op: 'iinc', varnum: 3, incr: 1 },
    { op: 'iload', arg: 4 }, { op: 'ifne', arg: 'Lreturn' },
    { op: 'iload', arg: 4 }, { op: 'ifeq', arg: 'Lloop' },
    'return',
  ];
  const method = {
    name: 'arbitrarySplitBackedge', descriptor: '([II)V', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: instructions.map((instruction, index) => ({
        labelDef: index === 7 ? 'Lloop:' : index === 19 ? 'Lreturn:'
          : `L${index}:`,
        instruction,
      })),
      localsSize: '5', stackSize: '3', exceptionTable: [],
    } }],
  };
  const jvm = new JVM({ jit: { structuredSsa: true, profileMethods: false } });
  jvm.classes.SplitBackedgeOptions = {
    staticFields: new Map([['diagnostics:Z', 0]]),
    ast: { classes: [{ superClassName: null, items: [] }] },
  };
  jvm.classInitializationState.set('SplitBackedgeOptions', 'INITIALIZED');
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated?.jvmStructuredSsa,
    'the split-backedge array loop compiles structurally');
  t.equal(generated.jvmStructuredCountedLoopCount, 1,
    'the unique update is accepted because it dominates the backedge');
  t.ok(generated.jvmStructuredArrayRangeGuardCount >= 1 &&
      generated.jvmStructuredSource.includes('ssaArrayRangeGuard'),
    'the dominance proof unlocks a versioned array-loop guard');

  const destination = new Array(8).fill(-1);
  destination.type = '[I';
  const frame = new Frame(method);
  frame.locals.splice(0, 2, destination, destination.length);
  const stack = new Stack();
  stack.push(frame);
  const result = generated(frame,
    { status: 'runnable', callStack: stack }, jvm.jit, false);
  t.ok(result?.returned, 'the ordinary generated entry returns normally');
  t.deepEqual(destination.slice(), [0, 1, 2, 3, 4, 5, 6, 7],
    'the branch-free fast arm preserves every store');
  t.end();
});

test('structured JVM SSA splits bounded irreducible integer regions without name gates', (t) => {
  const instructions = [
    'iload_0', { op: 'ifne', arg: 'Lsecondary' },
    { op: 'iinc', varnum: 1, incr: 1 }, 'iload_1', 'iload_2',
    { op: 'if_icmpge', arg: 'Lreturn' }, { op: 'goto', arg: 'Lsecondary' },
    { op: 'iinc', varnum: 1, incr: 2 }, 'iload_1', 'iload_2',
    { op: 'if_icmpge', arg: 'Lreturn' }, { op: 'goto', arg: 'Lprimary' },
    'return',
  ];
  const method = {
    name: 'arbitraryMultiEntryBody', descriptor: '(III)V', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: instructions.map((instruction, index) => ({
        labelDef: index === 2 ? 'Lprimary:' : index === 7 ? 'Lsecondary:'
          : index === 12 ? 'Lreturn:' : `L${index}:`,
        instruction,
      })),
      localsSize: '3', stackSize: '2', exceptionTable: [],
    } }],
  };
  const island = new JVM({ jit: { structuredSsa: true, profileMethods: false } });
  const islandGenerated = island.jit.structuredSsa.compile(method);
  t.ok(islandGenerated?.jvmStructuredDispatchIslands === 1 &&
      islandGenerated.jvmStructuredSplitBlocks === 0,
    'dispatch islands make the multi-entry CFG reducible by default without cloning');
  t.equal(island.jit.structuredSsa.dispatchIslandMethodCount, 1,
    'the island compilation is counted');
  const jvm = new JVM({ jit: { structuredSsa: true, structuredDispatchIslands: false,
    structuredIrreducibleSplitting: true, profileMethods: false } });
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated?.jvmStructuredSsa, 'controlled splitting makes the multi-entry CFG reducible');
  t.ok(generated.jvmStructuredSplitBlocks > 0 &&
      !generated.jvmStructuredSource.includes('switch (pc)'),
    'split remains bounded and emits lexical JavaScript control flow');
  t.equal(jvm.jit.structuredSsa.splitMethodCount, 1,
    'the structurally split compilation is counted');
  t.equal(jvm.jit.structuredSsa.splitBlockCount, generated.jvmStructuredSplitBlocks,
    'the bounded cloned-block count is exposed');

  for (const [entry, expected] of [[0, 6], [1, 5]]) {
    const frame = new Frame(method);
    frame.locals[0] = entry;
    frame.locals[1] = 0;
    frame.locals[2] = 5;
    const callStack = new Stack();
    callStack.push(frame);
    const result = generated(frame, { status: 'runnable', callStack }, jvm.jit, false);
    t.deepEqual(result, { returned: true, value: jvm.jit.returnVoid() },
      `entry ${entry} returns through the cloned CFG`);
    t.equal(frame.locals[1], expected, `entry ${entry} preserves local updates`);

    const islandFrame = new Frame(method);
    islandFrame.locals[0] = entry;
    islandFrame.locals[1] = 0;
    islandFrame.locals[2] = 5;
    const islandStack = new Stack();
    islandStack.push(islandFrame);
    const islandResult = islandGenerated(
      islandFrame, { status: 'runnable', callStack: islandStack }, island.jit, false);
    t.deepEqual(islandResult, { returned: true, value: island.jit.returnVoid() },
      `entry ${entry} returns through the dispatch island`);
    t.equal(islandFrame.locals[1], expected, `entry ${entry} matches the cloned CFG result`);
  }
  t.end();
});

test('structured JVM SSA recognizes bundled irreducibility errors structurally', (t) => {
  const bundledError = new Error('irreducible from another module instance');
  bundledError.name = 'IrreducibleError';
  bundledError.edges = ['7->3'];
  t.ok(structuredRendererTest.isIrreducibleError(bundledError),
    'constructor identity is not required across bundles or realms');
  bundledError.edges = null;
  t.notOk(structuredRendererTest.isIrreducibleError(bundledError),
    'an ordinary renamed error without verified edges is rejected');
  t.end();
});

test('structured JVM SSA materializes operand joins at safe points and guards debug entry', (t) => {
  const jvm = new JVM({ jit: { structuredSsa: true, profileMethods: false } });
  // Force the "yield due" side of the safe-point policy so the spill path is
  // exercised deterministically; quantum continuation has its own test.
  jvm._nextEventLoopYieldAt = 0;
  const method = structuredSsaJoinMethod();
  const generated = jvm.jit.structuredSsa.compile(method);

  const guarded = new Frame(method);
  guarded.locals[0] = 4;
  const guardedStack = new Stack();
  guardedStack.push(guarded);
  const fallback = generated(guarded, { status: 'runnable', callStack: guardedStack }, jvm.jit, true);
  t.ok(fallback.deopt && fallback.transient, 'debug mode uses the existing execution path');
  t.equal(guarded.pc, 0, 'debug guard leaves the bytecode PC unchanged');
  t.deepEqual(guarded.stack.items, [], 'debug guard runs before operand-stack changes');
  t.equal(jvm.jit.structuredSsa.runCount, 0, 'debug guard runs before SSA counters');

  const frame = new Frame(method);
  frame.locals[0] = 10001;
  const callStack = new Stack();
  callStack.push(frame);
  const safePoint = generated(frame, { status: 'runnable', callStack }, jvm.jit, false);
  t.ok(safePoint.deopt && safePoint.transient, 'bounded loop execution reaches a scheduler safe point');
  t.equal(frame.pc, 3, 'safe point records the loop-header bytecode PC');
  t.equal(frame.locals[1], 9999, 'safe point spills the scalar induction local');
  t.deepEqual(frame.stack.items, [5 + (9998 * 9999) / 2],
    'safe point reconstructs the live operand value at the block join');
  t.equal(jvm.jit.structuredSsa.safePointCount, 1, 'materialized SSA safe point is counted');
  t.end();
});

test('effectful nested counted loops retain scheduler polls', async (t) => {
  const classpath = compileJavaFixture(t, 'ArbitraryAssetWork', `
public class ArbitraryAssetWork {
  static int sink;
  static void publish(int value) { sink ^= value; }
  static void decode(int blocks) {
    for (int block = 0; block < blocks; block++) {
      int value = block;
      for (int index = 0; index < 100000; index++) value = value * 31 + index;
      publish(value);
    }
  }

  static int[] updateAndReturn(int[] values, int scale) {
    for (int index = 0; index < values.length; index++) {
      values[index] = values[index] / scale + 1;
    }
    return values;
  }

  static float[] updateFloats(Object values, int scale) {
    float[] result = (float[]) values;
    for (int index = 0; index < result.length; index++) {
      result[index] = result[index] / scale + 0.5f;
    }
    return result;
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0, structuredSsa: true, compiledCallChains: true,
    profileMethods: false, eagerMonomorphicCalls: false,
    structuredPerLoopPollBudgets: true,
  } });
  await jvm.loadClassByName('ArbitraryAssetWork');
  const method = await jvm.findMethodInHierarchy(
    'ArbitraryAssetWork', 'decode', '(I)V');
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated?.jvmStructuredSsa,
    'arbitrary call-bearing nested loop selects structured SSA');
  t.equal(generated.jvmStructuredCoarseCountedLoopCount, 0,
    'effectful methods do not hide a large inner loop behind an outer poll');
  t.ok(generated.jvmStructuredSafePointBudget < 10000,
    'verified per-iteration work scales the scheduler polling interval');
  const loopPollBudgets = Object.values(
    generated.jvmStructuredLoopPollBudgets || {});
  t.equal(loopPollBudgets.length, 2,
    'the nested fixture publishes one structural budget per natural loop');
  t.ok(new Set(loopPollBudgets).size > 1,
    'small inner and effectful outer loops receive independent poll budgets');
  t.ok(generated.jvmStructuredSource.includes(
    'safePointBudget = Math.min(safePointBudget,'),
  'entering a differently sized loop clamps the shared scheduler budget');
  t.ok(generated.jvmCompiledCallChain &&
      typeof generated.jvmAdaptivePositionalBody === 'function',
    'non-recursive call-bearing continuations publish a virtual-frame chain ABI');
  t.notOk(generated.jvmStructuredSource.includes(
    'if (helpers.continueStructuredQuantum(thread)) { safePointBudget = 10000;'),
  'generated source does not retain the old fixed 10k-backedge deadline check');
  const thread = {
    id: 0, name: 'late-positional-link', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  jvm.classes.ArbitraryAssetWork.staticFields.set('sink:I', 0);
  jvm.classInitializationState.set('ArbitraryAssetWork', 'INITIALIZED');
  const originalTryInvoke = jvm.jit.tryInvokeSyncAt.bind(jvm.jit);
  let canonicalCalls = 0;
  jvm.jit.tryInvokeSyncAt = (...args) => {
    canonicalCalls += 1;
    return originalTryInvoke(...args);
  };
  await invoke(jvm, thread, 'ArbitraryAssetWork', 'decode', '(I)V', [3]);
  t.equal(canonicalCalls, 1,
    'a cold child links once and later loop iterations feed its positional ABI');
  t.equal(thread.callStack.size(), 0,
    'late positional linkage leaves no scheduler-visible child Frames');
  const referenceReturn = await jvm.findMethodInHierarchy(
    'ArbitraryAssetWork', 'updateAndReturn', '([II)[I');
  const referenceGenerated = jvm.jit.structuredSsa.compile(referenceReturn);
  t.equal(typeof referenceGenerated?.jvmRestoringDirectPositionalBody,
    'function',
  'a verified loop can return its reference through the restoring scalar ABI');
  const values = jvm.jit.newPrimitiveArray(3, 'int');
  values[0] = 2;
  values[1] = 4;
  values[2] = 8;
  const returned = referenceGenerated.jvmRestoringDirectPositionalBody(
    jvm.jit, {target: {freeFrame: null}}, values, 1, thread, 1);
  t.equal(returned, values,
    'the scalar reference return preserves Java object identity');
  // Array.from, not slice(): under JVM_WASM_HEAP the array is a TypedArray
  // and slice() would keep that type, which deepEqual rejects against a
  // plain array even when every element matches.
  t.deepEqual(Array.from(values), [3, 5, 9],
    'reference-returning execution preserves loop effects');
  const floatReturn = await jvm.findMethodInHierarchy(
    'ArbitraryAssetWork', 'updateFloats', '(Ljava/lang/Object;I)[F');
  const floatGenerated = jvm.jit.structuredSsa.compile(floatReturn);
  t.equal(typeof floatGenerated?.jvmRestoringDirectPositionalBody, 'function',
    'a verified float-array loop publishes the same restoring scalar ABI');
  const floatValues = jvm.jit.newPrimitiveArray(2, 'float');
  floatValues[0] = 3;
  floatValues[1] = 7;
  const returnedFloats = floatGenerated.jvmRestoringDirectPositionalBody(
    jvm.jit, {target: {freeFrame: null}}, floatValues, 2, thread, 1);
  t.equal(returnedFloats, floatValues,
    'a primitive-array checkcast preserves the returned array identity');
  t.deepEqual(Array.from(floatValues), [2, 4],
    'float-array loads and stores preserve float32 loop effects');
  t.end();
});

test('structured JVM SSA keeps proven float-to-byte loops in one finite quantum', async (t) => {
  const classpath = compileJavaFixture(t, 'FloatByteConversionHarness', `
public class FloatByteConversionHarness {
  static float[] samples(float[] values) { return values; }
  static void convert(float[] values, byte[] output) {
    float[] decoded = samples(values);
    int length = decoded.length;
    if (length > output.length) length = output.length;
    for (int index = 0; index < length; index++) {
      int sample = (int) (128.0f + decoded[index] * 128.0f);
      if ((sample & -256) != 0) sample = ~sample >> 31;
      output[index] = (byte) (sample - 128);
    }
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    hotCallGraphRegions: true,
    hotCallGraphDirectSafePointBudget: 10000,
    profileMethods: false,
  } });
  await jvm.loadClassByName('FloatByteConversionHarness');
  const method = await jvm.findMethodInHierarchy(
    'FloatByteConversionHarness', 'convert', '([F[B)V');
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated?.jvmStructuredSsa,
    'the call-bearing conversion method selects structured SSA');
  t.ok(generated.jvmStructuredSource.includes(
    'ssaRuntimeCoarseTrips') && generated.jvmStructuredSource.includes(
      '<= 1000000'),
  'the proven float-to-byte loop receives a bounded million-element quantum');

  const values = [0.0, 0.5, -1.0, 2.0, -3.0];
  values.type = '[F';
  const output = new Int8Array(values.length);
  output.type = '[B';
  const thread = {
    id: 0, name: 'float-byte-conversion-test', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  jvm.classInitializationState.set(
    'FloatByteConversionHarness', 'INITIALIZED');
  await invoke(jvm, thread, 'FloatByteConversionHarness', 'convert',
    '([F[B)V', [values, output]);
  t.deepEqual(Array.from(output), [0, 64, -128, 127, -128],
    'the widened quantum preserves Java float conversion and byte narrowing');
  t.end();
});

test('verified primitive-return call graphs retain virtual intermediate frames',
  async (t) => {
  const className = 'ArbitraryCompiledCallChain';
  const classpath = compileJavaFixture(t, className, `
public final class ArbitraryCompiledCallChain {
  static int last;
  static Object identity(Object value) { return value; }

  static int scan(Object[] values, int passes) {
    int count = 0;
    for (int pass = 0; pass < passes; pass++) {
      for (int index = 0; index < values.length; index++) {
        if (identity(values[index]) != null) count++;
      }
    }
    return count;
  }

  static int repeat(Object[] values) {
    int count = 0;
    for (int pass = 0; pass < 8; pass++) count += scan(values, 1);
    last = count;
    return last;
  }

  static int caught(Object[] values) {
    try { return repeat(values); }
    catch (NullPointerException error) { last = -7; return last; }
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    compiledCallChains: true,
    profileMethods: false,
  } });
  const classData = await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const scan = await jvm.findMethodInHierarchy(
    className, 'scan', '([Ljava/lang/Object;I)I');
  const generated = jvm.jit.structuredSsa.compile(scan);
  t.ok(generated?.jvmCompiledCallChain &&
      typeof generated.jvmAdaptivePositionalBody === 'function',
    'descriptor, CFG, and call structure publish a compiled-chain entry');
  t.ok(generated.jvmAdaptivePositionalOrdinary &&
      !/^function\s*\*/.test(generated.jvmAdaptivePositionalBody.toString()),
    'the successful chain is one optimizable ordinary JavaScript activation');
  t.equal(generated.jvmRestoringDirectPositionalBody, null,
    'the reference-array body exercises the virtual Frame ABI, not a restoring leaf');

  const thread = {
    id: 0, name: 'compiled-call-chain', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const values = jvm.jit.newReferenceArray(4, 'java/lang/Object');
  values[0] = { type: 'java/lang/Object', fields: {} };
  values[2] = { type: 'java/lang/Object', fields: {} };
  await invoke(jvm, thread, className, 'repeat',
    '([Ljava/lang/Object;)I', [values]);
  await invoke(jvm, thread, className, 'repeat',
    '([Ljava/lang/Object;)I', [values]);
  t.equal(classData.staticFields.get('last:I'), 16,
    'the persistent chain preserves nested loop and reference semantics');
  t.ok(jvm.jit.compiledCallChainRunCount > 0,
    'the warmed intermediate method executes without a scheduler-visible Frame');

  await invoke(jvm, thread, className, 'caught',
    '([Ljava/lang/Object;)I', [null]);
  t.equal(classData.staticFields.get('last:I'), -7,
    'a virtual-chain bailout reconstructs frames for the ordinary JVM handler');
  t.equal(thread.callStack.size(), 0,
    'exception completion leaves no virtual or canonical frame behind');

  const disabledJvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    compiledCallChains: false,
    profileMethods: false,
  } });
  await disabledJvm.loadClassByName(className);
  disabledJvm.classInitializationState.set(className, 'INITIALIZED');
  const disabledScan = await disabledJvm.findMethodInHierarchy(
    className, 'scan', '([Ljava/lang/Object;I)I');
  const disabledGenerated = disabledJvm.jit.structuredSsa.compile(disabledScan);
  t.notOk(disabledGenerated.jvmCompiledCallChain ||
      disabledGenerated.jvmAdaptivePositionalBody,
    'the comparison gate restores canonical Frame-backed call boundaries');
  t.end();
});

test('hot call-graph regions discover exact multi-method SSA candidates',
  async (t) => {
  const className = 'ArbitraryHotGraphRegion';
  const classpath = compileJavaFixture(t, className, `
public final class ArbitraryHotGraphRegion {
  static int leaf(int value, boolean bias) {
    return value * 3 + (bias ? 1 : 2);
  }
  static int middle(int value, boolean bias) {
    return leaf(value, bias) ^ 0x55aa;
  }
  static int root(int[] values, int rounds, boolean bias) {
    int sum = 0;
    for (int round = 0; round < rounds; round++) {
      for (int index = 0; index < values.length; index++) {
        sum += middle(values[index], bias);
      }
    }
    return sum;
  }
  static int recursive(int value) {
    return value == 0 ? 0 : recursive(value - 1) + 1;
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0, structuredSsa: true,
    hotCallGraphRegions: true, profileMethods: false,
  } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const root = await jvm.findMethodInHierarchy(
    className, 'root', '([IIZ)I');
  const plan = jvm.jit.compileHotCallGraphRegion(root);
  t.ok(plan && plan.backendEligible,
    'a closed non-recursive graph is admitted as one backend region');
  t.deepEqual(plan.nodes.map((node) => node.method.name).sort(),
    ['leaf', 'middle', 'root'],
    'discovery follows exact bytecode targets transitively');
  t.equal(plan.components.length, 3,
    'acyclic methods form independent SCCs for backend scheduling');
  t.equal(plan.recursiveComponents.length, 0,
    'the acyclic region needs no recursive group lowering');
  t.ok(plan.root.effects.loops && plan.root.effects.invokes,
    'the root carries transitive-planning input independent of guest names');
  t.equal(plan.root.generated.jvmHotCallGraphRegionPlan, plan,
    'the generated root receives the backend-neutral region plan');
  t.equal(typeof plan.body, 'function',
    'the plan emits one locally linked multi-method JavaScript module');
  t.ok(plan.loweredEdgeCount > 0,
    'backend admission requires at least one eliminated call boundary');
  t.ok(jvm.jit.hotCallGraphRegions.enter(plan),
    'exact method, tier, initialization, and debugger guards admit entry');

  jvm.classInitializationState.set(className, 'UNINITIALIZED');
  t.notOk(jvm.jit.hotCallGraphRegions.enter(plan),
    'class lifecycle changes fall back before region effects');
  t.equal(jvm.jit.hotCallGraphRegions.guardFallbackCount, 1,
    'guarded region fallbacks are observable');
  jvm.classInitializationState.set(className, 'INITIALIZED');

  const recursive = await jvm.findMethodInHierarchy(
    className, 'recursive', '(I)I');
  const recursivePlan = jvm.jit.compileHotCallGraphRegion(recursive);
  t.equal(recursivePlan.recursiveComponents.length, 1,
    'recursive bytecode is represented as an SCC instead of traversed forever');
  t.notOk(recursivePlan.backendEligible,
    'the first backend milestone leaves recursive SCCs on canonical execution');
  t.end();
});

test('a coarse loop does not shrink unrelated later loop budgets', async (t) => {
  const className = 'SequentialLoopBudgetShape';
  const classpath = compileJavaFixture(t, className, `
public final class SequentialLoopBudgetShape {
  static int publish(int value) { return value ^ 0x55aa; }
  static int work(int count) {
    int value = 0;
    for (int pass = 0; pass < 1; pass++) {
      for (int index = 0; index < 256; index++) value += index;
    }
    for (int index = 0; index < count; index++) value = publish(value + index);
    return value;
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0, structuredSsa: true, profileMethods: false,
  } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className, 'work', '(I)I');
  const generated = jvm.jit.structuredSsa.compile(method);
  const source = generated?.jvmStructuredSource || '';
  t.ok(generated?.jvmStructuredSsa,
    'the sequential nested/effectful loop shape selects structured SSA');
  t.ok(generated.jvmStructuredCoarseCountedLoopCount >= 1,
    'the fixed inner arithmetic loop is admitted as a coarse loop');
  t.ok(generated.jvmStructuredSafePointBudget >= 64,
    'the shared budget is not globally divided by the coarse trip count');
  t.ok(source.includes('safePointBudget -= 256;'),
    'the admitted loop charges its own verified trip count once');
  t.ok(source.includes('--safePointBudget <= 0'),
    'the later effectful loop observes a coarse charge crossing zero');

  const thread = {
    id: 0, name: 'sequential-loop-budget',
    status: 'runnable', pendingException: null, callStack: new Stack(),
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  jvm._nextEventLoopYieldAt = Number.POSITIVE_INFINITY;
  const frame = new Frame(method);
  frame.className = className;
  frame.locals[0] = 3;
  thread.callStack.push(frame);
  const result = generated(frame, thread, jvm.jit, false);
  let expected = 32640;
  for (let index = 0; index < 3; index += 1) {
    expected = (expected + index) ^ 0x55aa;
  }
  t.ok(result?.returned, 'the complete generated invocation returns inline');
  t.equal(result?.value, expected | 0,
    'coarse accounting preserves the Java result');
  t.end();
});

test('structured JVM SSA preserves lexical continuations across scheduler yields', (t) => {
  const jvm = new JVM({ jit: {
    structuredSsa: true, scalarLoops: true, profileMethods: false,
  } });
  jvm._nextEventLoopYieldAt = 0;
  const method = structuredSsaJoinMethod();
  const generated = jvm.jit.compileMethod(method);
  t.ok(generated.jvmStructuredSsa && generated.jvmStructuredContinuation &&
      generated.jvmScalarResumeBody,
    'structured entry retains a verified scalar fallback behind its continuation');

  const frame = new Frame(method);
  frame.locals[0] = 10001;
  const callStack = new Stack();
  callStack.push(frame);
  const thread = { status: 'runnable', callStack };
  const yielded = generated(frame, thread, jvm.jit, false);
  t.ok(yielded.deopt && yielded.transient,
    'structured entry yields at its scheduler safe point');
  t.equal(frame.pc, 3, 'yield records the verified loop-header leader');

  // Give the resumed quantum a fresh browser deadline, just as executeTick
  // does after returning to the event loop.
  jvm._nextEventLoopYieldAt = Date.now() + 60000;
  const resumed = generated(frame, thread, jvm.jit, false);
  t.deepEqual(resumed, { returned: true, value: 50005005 },
    'lexical continuation completes from the materialized SSA join state');
  t.equal(jvm.jit.structuredSsa.runCount, 1,
    'resume continues the original structured invocation');
  t.equal(jvm.jit.scalarLoopRunCount, 0,
    'valid continuation does not enter the scalar fallback');
  t.equal(callStack.size(), 0, 'resumed return pops the original JVM frame');
  t.end();
});

test('adaptive positional SSA retains its iterator after a wall-clock yield', (t) => {
  const jvm = new JVM({ jit: {
    structuredSsa: true, scalarLoops: true,
    adaptiveFramelessPositional: true,
    adaptiveFramelessBudgetMultiplier: 1,
    profileMethods: false,
  } });
  jvm._nextEventLoopYieldAt = 0;
  const method = structuredSsaJoinMethod();
  const generated = jvm.jit.compileMethod(method);
  const fast = generated.jvmFastBody || generated;
  t.equal(typeof fast.jvmAdaptivePositionalBody, 'function',
    'a continuation method publishes an adaptive positional entry');

  const frame = new Frame(method);
  frame.locals[0] = 10001;
  const callStack = new Stack();
  const thread = { status: 'runnable', callStack };
  const yielded = fast.jvmAdaptivePositionalBody(
    frame, thread, jvm.jit, false, true);
  t.ok(yielded.deopt && yielded.reason === 'structured SSA continuation',
    'the enlarged positional quantum can still yield at its wall deadline');
  t.ok(fast.jvmHasStructuredContinuation(frame),
    'the yielded positional body retains its lexical iterator on the Frame');

  callStack.push(frame);
  jvm._nextEventLoopYieldAt = Date.now() + 60000;
  const resumed = generated(frame, thread, jvm.jit, false);
  t.deepEqual(resumed, { returned: true, value: 50005005 },
    'the canonical entry resumes the positional iterator instead of baseline bytecodes');
  t.equal(jvm.jit.scalarLoopRunCount, 0,
    'the valid adaptive continuation never enters the scalar/baseline resume body');
  t.equal(callStack.size(), 0, 'the resumed positional invocation returns normally');
  t.end();
});

test('adaptive positional SSA can use an ordinary guarded function', (t) => {
  const jvm = new JVM({ jit: {
    structuredSsa: true, scalarLoops: true,
    adaptiveFramelessPositional: true,
    ordinaryAdaptiveFramelessPositional: true,
    adaptiveFramelessBudgetMultiplier: 2,
    profileMethods: false,
  } });
  jvm._nextEventLoopYieldAt = Date.now() + 60000;
  const method = structuredSsaJoinMethod();
  const generated = jvm.jit.compileMethod(method);
  const fast = generated.jvmFastBody || generated;
  t.ok(fast.jvmAdaptivePositionalOrdinary,
    'the opt-in publishes an ordinary adaptive positional entry');
  t.notOk(/^function\s*\*/.test(fast.jvmAdaptivePositionalBody.toString()),
    'the adaptive hot-loop body is not a generator');

  const frame = new Frame(method);
  frame.locals[0] = 100;
  const callStack = new Stack();
  const thread = { status: 'runnable', callStack };
  const result = fast.jvmAdaptivePositionalBody(
    frame, thread, jvm.jit, false, true);
  t.equal(result, 4955,
    'the ordinary positional body returns its scalar Java value directly');
  t.equal(jvm.jit.ordinaryAdaptiveFramelessRunCount, 1,
    'ordinary adaptive entries are observable without method identities');
  t.notOk(fast.jvmHasStructuredContinuation(frame),
    'a completed ordinary body leaves no generator continuation');
  t.equal(frame.pc, 0,
    'normal frameless execution does not materialize canonical frame state');

  const canonicalFrame = new Frame(method);
  canonicalFrame.locals[0] = 100;
  const canonicalStack = new Stack();
  canonicalStack.push(canonicalFrame);
  const canonicalResult = generated(
    canonicalFrame, { status: 'runnable', callStack: canonicalStack },
    jvm.jit, false);
  t.deepEqual(canonicalResult, { returned: true, value: 4955 },
    'the canonical scheduler entry also uses the ordinary adaptive body');
  t.equal(canonicalStack.size(), 0,
    'an ordinary canonical return completes the normal Frame protocol');

  jvm._nextEventLoopYieldAt = 0;
  const yieldingFrame = new Frame(method);
  yieldingFrame.locals[0] = 20001;
  const safePoint = fast.jvmAdaptivePositionalBody(
    yieldingFrame, thread, jvm.jit, false, true);
  t.ok(safePoint.deopt && safePoint.transient &&
      safePoint.reason === 'structured SSA safe point',
    'an ordinary body deoptimizes when its enlarged quantum expires');
  t.equal(yieldingFrame.pc, 3,
    'ordinary deoptimization records the exact loop-header bytecode PC');
  const yieldedIterations = yieldingFrame.locals[1];
  t.ok(yieldedIterations > 0 && yieldedIterations < 20001,
    'ordinary deoptimization spills its scalar induction local');
  t.deepEqual(yieldingFrame.stack.items,
    [5 + ((yieldedIterations - 1) * yieldedIterations) / 2],
    'ordinary deoptimization reconstructs the live operand join value');
  t.notOk(fast.jvmHasStructuredContinuation(yieldingFrame),
    'ordinary deoptimization never publishes a generator continuation');
  t.end();
});

test('structured SSA versions quotient-product recurrence array loads',
  async (t) => {
  const className = 'StructuredRecurrenceRangeHarness';
  const classpath = compileJavaFixture(t, className, `
public final class StructuredRecurrenceRangeHarness {
  static void sample(int[] source, int[] destination, int recurrence,
      int divisor, int multiplier, int offset, int count, int step) {
    for (int index = 0; index < count; index++) {
      int quotient = recurrence / divisor;
      int derived = quotient * multiplier;
      destination[index] = source[derived + offset];
      recurrence += step;
    }
  }
}
`);
  const descriptor = '([I[IIIIIII)V';
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: false,
  } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className, 'sample', descriptor);
  const generated = jvm.jit.structuredSsa.compile(method);
  const sourceText = generated?.jvmRestoringDirectPositionalSource || '';
  t.ok(generated?.jvmStructuredSsa &&
      sourceText.includes('ssaArrayRangeRecurrence'),
  'bytecode-derived recurrence analysis publishes an endpoint range proof');
  t.ok(generated.jvmStructuredRecurrenceRangeCount >= 1 &&
      generated.jvmStructuredSpecializedArrayRangeAccessCount >= 1,
  'only the retained slow loop contains source-load exception materialization');

  const run = (source, destination, divisor, count) => {
    const frame = new Frame(method);
    frame.className = className;
    frame.locals.splice(0, 8,
      source, destination, 0, divisor, 1, 0, count, 1);
    const thread = {
      id: 1,
      status: 'runnable',
      pendingException: null,
      callStack: new Stack(),
    };
    thread.callStack.push(frame);
    let error = null;
    try {
      generated(frame, thread, jvm.jit, false);
    } catch (thrown) {
      error = thrown;
    }
    return {frame, error};
  };
  const source = Array.from({length: 8}, (_unused, index) => index + 10);
  source.type = '[I';
  const destination = new Array(8).fill(0);
  destination.type = '[I';
  const valid = run(source, destination, 1, 8);
  t.equal(valid.error, null, 'valid recurrence completes normally');
  t.deepEqual(destination, source,
    'range-versioned loads preserve every destination value');

  const shortSource = [21, 22, 23];
  shortSource.type = '[I';
  const partialDestination = new Array(5).fill(0);
  partialDestination.type = '[I';
  const rangedBounds = run(shortSource, partialDestination, 1, 5);
  const codeItems = jvm.jit.getCodeItems(method);
  const loadPc = codeItems.findIndex((item) =>
    (item.instruction?.op || item.instruction) === 'iaload');
  t.equal(rangedBounds.error?.type,
    'java/lang/ArrayIndexOutOfBoundsException',
  'a failed endpoint guard retains the Java bounds exception');
  t.equal(rangedBounds.frame.pc, loadPc,
    'the failed recurrence guard records the exact throwing load PC');
  t.deepEqual(partialDestination.slice(), [21, 22, 23, 0, 0],
    'the slow arm retains mutations before the exceptional iteration');

  const untouched = new Array(2).fill(0);
  untouched.type = '[I';
  const arithmetic = run(source, untouched, 0, 2);
  const dividePc = codeItems.findIndex((item) =>
    (item.instruction?.op || item.instruction) === 'idiv');
  t.equal(arithmetic.error?.type, 'java/lang/ArithmeticException',
    'a zero invariant divisor retains the Java arithmetic exception');
  t.equal(arithmetic.frame.pc, dividePc,
    'the rejected recurrence guard records the exact throwing divide PC');
  t.deepEqual(untouched.slice(), [0, 0],
    'the arithmetic failure occurs before the first array side effect');
  t.end();
});

test('structured SSA versions bit-bounded primitive array indexes',
  async (t) => {
  const className = 'StructuredBitBoundedRangeHarness';
  const classpath = compileJavaFixture(t, className, `
public final class StructuredBitBoundedRangeHarness {
  static void sample(int[] source, int[] destination, int coordinate,
      int coordinateStep, int count) {
    for (int index = 0; index < count; index++) {
      destination[index] =
          source[(coordinate & 4032) + (coordinate >>> 26)];
      coordinate += coordinateStep;
    }
  }
}
`);
  const descriptor = '([I[IIII)V';
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: false,
  } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className, 'sample', descriptor);
  const generated = jvm.jit.structuredSsa.compile(method);
  const sourceText = generated?.jvmRestoringDirectPositionalSource || '';
  t.ok(generated?.jvmStructuredSsa &&
      generated.jvmStructuredBoundedIndexRangeCount >= 1 &&
      generated.jvmStructuredSpecializedArrayRangeAccessCount >= 1,
  'masked and unsigned-shifted indexes receive a generic interval proof');
  t.ok(sourceText.includes('4095 < ssaEntryArrayData0.length'),
    'the fast loop is guarded solely by the derived maximum index');

  const run = (source, destination, coordinate, count) => {
    const frame = new Frame(method);
    frame.className = className;
    frame.locals.splice(
      0, 5, source, destination, coordinate, 0x04102040, count);
    const thread = {
      status: 'runnable', pendingException: null, callStack: new Stack(),
    };
    thread.callStack.push(frame);
    let error = null;
    try {
      generated(frame, thread, jvm.jit, false);
    } catch (thrown) {
      error = thrown;
    }
    return {frame, error};
  };
  const source = Array.from(
    {length: 4096}, (_unused, index) => (index * 17 + 3) | 0);
  source.type = '[I';
  const destination = new Array(32).fill(0);
  destination.type = '[I';
  const valid = run(source, destination, 0x7f123456, 32);
  t.equal(valid.error, null, 'the range-proven loop completes normally');
  for (let index = 0, coordinate = 0x7f123456; index < 32; index += 1) {
    t.equal(destination[index],
      source[(coordinate & 4032) + (coordinate >>> 26)],
    `the fast loop preserves bit-packed sample ${index}`);
    coordinate = (coordinate + 0x04102040) | 0;
  }

  const shortSource = new Array(64).fill(7);
  shortSource.type = '[I';
  const partial = new Array(2).fill(0);
  partial.type = '[I';
  const invalid = run(shortSource, partial, 0x7f123456, 2);
  const loadPc = jvm.jit.getCodeItems(method).findIndex((item) =>
    (item.instruction?.op || item.instruction) === 'iaload');
  t.equal(invalid.error?.type, 'java/lang/ArrayIndexOutOfBoundsException',
    'a short array retains the Java bounds exception');
  t.equal(invalid.frame.pc, loadPc,
    'the slow arm records the exact throwing bit-packed load PC');
  t.end();
});

test('structured SSA versions constant-step local array indexes',
  async (t) => {
  const className = 'StructuredConstantStepRangeHarness';
  const classpath = compileJavaFixture(t, className, `
public final class StructuredConstantStepRangeHarness {
  static void fill(int[] destination, int start, int count) {
    for (int index = 0; index < count; index++) {
      destination[start] = index + 1;
      start++;
    }
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: false,
  } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className, 'fill', '([III)V');
  const generated = jvm.jit.structuredSsa.compile(method);
  const sourceText = generated?.jvmRestoringDirectPositionalSource || '';
  t.ok(generated?.jvmStructuredSsa &&
      sourceText.includes('ssaArrayRangeGuard') &&
      generated.jvmStructuredSpecializedArrayRangeAccessCount >= 1,
    'a bytecode iinc recurrence receives a guarded branch-free store loop');

  const run = (destination, start, count) => {
    const frame = new Frame(method);
    frame.className = className;
    frame.locals.splice(0, 3, destination, start, count);
    const thread = {
      status: 'runnable', pendingException: null, callStack: new Stack(),
    };
    thread.callStack.push(frame);
    let error = null;
    try {
      generated(frame, thread, jvm.jit, false);
    } catch (thrown) {
      error = thrown;
    }
    return { frame, error };
  };
  const destination = new Array(8).fill(0);
  destination.type = '[I';
  const valid = run(destination, 2, 4);
  t.equal(valid.error, null, 'the guarded constant-step loop completes');
  t.deepEqual(destination.slice(), [0, 0, 1, 2, 3, 4, 0, 0],
    'the fast loop preserves all stores');

  const short = new Array(4).fill(0);
  short.type = '[I';
  const invalid = run(short, 2, 4);
  const storePc = jvm.jit.getCodeItems(method).findIndex((item) =>
    (item.instruction?.op || item.instruction) === 'iastore');
  t.equal(invalid.error?.type, 'java/lang/ArrayIndexOutOfBoundsException',
    'a failed endpoint guard retains the Java bounds exception');
  t.equal(invalid.frame.pc, storePc,
    'the slow arm records the exact throwing store PC');
  t.deepEqual(short.slice(), [0, 0, 1, 2],
    'the slow arm retains stores before the exceptional iteration');
  t.end();
});

test('structured SSA uses exact endpoints for positive-stride induction',
  async (t) => {
  const className = 'StructuredPositiveStrideRangeHarness';
  const classpath = compileJavaFixture(t, className, `
public final class StructuredPositiveStrideRangeHarness {
  static int sumPairs(int[] source) {
    int sum = 0;
    for (int index = 0; index < source.length; index += 2) {
      sum += source[index + 1];
    }
    return sum;
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: false,
  } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className, 'sumPairs', '([I)I');
  const generated = jvm.jit.structuredSsa.compile(method);
  const sourceText = generated?.jvmStructuredSource || '';
  t.ok(generated?.jvmStructuredSsa &&
      generated.jvmStructuredSpecializedArrayRangeAccessCount >= 1,
    'the stride-two array loop receives a specialized range arm');
  t.ok(sourceText.includes('Math.ceil') && sourceText.includes('/ 2'),
    'the endpoint proof uses the exact stride-two trip count');

  const run = (values) => {
    values.type = '[I';
    const frame = new Frame(method);
    frame.className = className;
    frame.locals[0] = values;
    const callStack = new Stack();
    callStack.push(frame);
    let result = null;
    let error = null;
    try {
      result = generated(frame,
        {status: 'runnable', pendingException: null, callStack},
        jvm.jit, false);
    } catch (thrown) {
      error = thrown;
    }
    return {frame, result, error};
  };
  const valid = run([1, 10, 2, 20, 3, 30]);
  t.equal(valid.error, null, 'an even-length array passes the exact guard');
  t.equal(valid.result?.value, 60,
    'the stride-two fast arm reads its final in-range offset');

  const invalid = run([1, 10, 2, 20, 3]);
  const loadPc = jvm.jit.getCodeItems(method).findIndex((item) =>
    (item.instruction?.op || item.instruction) === 'iaload');
  t.equal(invalid.error?.type, 'java/lang/ArrayIndexOutOfBoundsException',
    'an odd-length array retains the Java bounds exception');
  t.equal(invalid.frame.pc, loadPc,
    'the rejected guard records the exact throwing offset-load PC');
  t.end();
});

test('structured SSA versions eager field-array views at loop preheaders',
  async (t) => {
  const className = 'StructuredFieldArrayRangeHarness';
  const classpath = compileJavaFixture(t, className, `
public final class StructuredFieldArrayRangeHarness {
  int[] source;
  byte[] destination;
  static int calls;

  static void copy(StructuredFieldArrayRangeHarness self) {
    for (int index = 0; index < 512; index++) {
      self.destination[index] = (byte) self.source[index];
    }
    touch();
  }

  static void touch() {
    calls++;
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: false,
  } });
  const classData = await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  classData.staticFields.set('calls:I', 0);
  const method = await jvm.findMethodInHierarchy(
    className, 'copy', `(L${className};)V`);
  const generated = jvm.jit.structuredSsa.compile(method);
  const sourceText = generated?.jvmStructuredSource || '';
  t.ok(generated?.jvmStructuredSsa,
    'the field-array counted loop still selects structured SSA');
  t.ok(sourceText.includes('ssaArrayRangeGuard'),
    'an entry-stable field view receives a loop-preheader range proof');
  t.ok(sourceText.includes('ssaRuntimeCoarseTrips') &&
      !/ssaRuntimeCoarseTrips\d+ < safePointBudget/.test(sourceText),
    'the bounded block is not fragmented by a smaller abstract poll budget');
  t.ok(generated.jvmStructuredDominatedFieldReceiverCheckCount >= 1,
    'range-proven field arrays remove repeated receiver checks only in the fast loop');

  const source = Array.from({ length: 512 },
    (_unused, index) => index & 0x7f);
  source.type = '[I';
  const destination = new Array(512).fill(0);
  destination.type = '[B';
  const receiver = {
    type: className,
    fields: {
      [`${className}.source`]: source,
      [`${className}.destination`]: destination,
    },
  };
  const frame = new Frame(method);
  frame.className = className;
  frame.locals[0] = receiver;
  const thread = {
    status: 'runnable', pendingException: null, callStack: new Stack(),
  };
  thread.callStack.push(frame);
  let error = null;
  try {
    generated(frame, thread, jvm.jit, false);
  } catch (thrown) {
    error = thrown;
  }
  t.equal(error, null,
    'executing the loop never references an undeclared SSA temporary');
  t.deepEqual(destination.slice(), source.slice(),
    'the versioned field-array path preserves every element');

  const runExceptional = (exceptionReceiver) => {
    const exceptionalFrame = new Frame(method);
    exceptionalFrame.className = className;
    exceptionalFrame.locals[0] = exceptionReceiver;
    const exceptionalThread = {
      status: 'runnable', pendingException: null, callStack: new Stack(),
    };
    exceptionalThread.callStack.push(exceptionalFrame);
    let thrown = null;
    let result = null;
    try {
      result = generated(exceptionalFrame, exceptionalThread, jvm.jit, false);
    } catch (error) {
      thrown = error;
    }
    return {frame: exceptionalFrame, thrown, result};
  };
  const codeItems = jvm.jit.getCodeItems(method);
  const firstGetfieldPc = codeItems.findIndex((item) =>
    (item.instruction?.op || item.instruction) === 'getfield');
  const nullReceiver = runExceptional(null);
  t.equal(nullReceiver.thrown?.type, 'java/lang/NullPointerException',
    'a failed non-null field-range fact retains the receiver exception');
  t.equal(nullReceiver.frame.pc, firstGetfieldPc,
    'the slow path records the exact throwing getfield PC');

  const nullSourceReceiver = {
    type: className,
    fields: {
      [`${className}.source`]: null,
      [`${className}.destination`]: destination,
    },
  };
  const nullSource = runExceptional(nullSourceReceiver);
  const firstLoadPc = codeItems.findIndex((item) =>
    (item.instruction?.op || item.instruction) === 'iaload');
  t.equal(nullSource.thrown?.type, 'java/lang/NullPointerException',
    'a null cached array rejects the range version and throws canonically');
  t.equal(nullSource.frame.pc, firstLoadPc,
    'the null field array records the exact throwing load PC');
  t.end();
});

test('structured SSA preserves dominated late static-array local views',
  async (t) => {
  const className = 'StructuredLateStaticArrayRangeHarness';
  const classpath = compileJavaFixture(t, className, `
public final class StructuredLateStaticArrayRangeHarness {
  static float[] source;
  static float[] replacement;

  static float sum(int limit, boolean replace) {
    if (limit < 0) limit = -limit;
    float[] values = source;
    if (replace) source = replacement;
    float sum = 0.0f;
    for (int index = 0; index < limit; index++) {
      sum += values[index];
    }
    return sum;
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: false,
  } });
  const classData = await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const initial = [1.25, 2.5, 3.75, 5];
  initial.type = '[F';
  const replacement = [100, 200, 300, 400];
  replacement.type = '[F';
  classData.staticFields.set('source:[F', initial);
  classData.staticFields.set('replacement:[F', replacement);
  const method = await jvm.findMethodInHierarchy(
    className, 'sum', '(IZ)F');
  const generated = jvm.jit.structuredSsa.compile(method);
  const sourceText = generated?.jvmStructuredSource || '';
  t.ok(generated?.jvmStructuredSsa,
    'the late static-array loop selects structured SSA');
  t.equal(generated.jvmStructuredPersistentStaticArrayLocalViewCount, 1,
    'unique dominated astore keeps one persistent raw-array companion');
  t.ok(generated.jvmStructuredArrayRangeGuardCount >= 1 &&
      sourceText.includes('ssaStaticArrayLocalData'),
    'later blocks retain enough SSA provenance for a range guard');

  const run = (array, limit, replace) => {
    classData.staticFields.set('source:[F', array);
    classData.staticFields.set('replacement:[F', replacement);
    const frame = new Frame(method);
    frame.className = className;
    frame.locals.splice(0, 2, limit, replace ? 1 : 0);
    const callStack = new Stack();
    callStack.push(frame);
    let result = null;
    let error = null;
    try {
      result = generated(frame,
        {status: 'runnable', pendingException: null, callStack},
        jvm.jit, false);
    } catch (thrown) {
      error = thrown;
    }
    return {frame, result, error};
  };
  const normal = run(initial, 4, false);
  t.equal(normal.error, null, 'the guarded loop completes normally');
  t.equal(normal.result?.value, 12.5,
    'the persistent raw view reads every original value');

  const rebound = run(initial, 4, true);
  t.equal(rebound.error, null, 'rebinding the static field does not deopt');
  t.equal(rebound.result?.value, 12.5,
    'the local raw view remains attached to the pre-rebind Java reference');
  t.equal(classData.staticFields.get('source:[F'), replacement,
    'the Java static-field mutation remains observable');

  const codeItems = jvm.jit.getCodeItems(method);
  const loadPc = codeItems.findIndex((item) =>
    (item.instruction?.op || item.instruction) === 'faload');
  const nullRun = run(null, 1, false);
  t.equal(nullRun.error?.type, 'java/lang/NullPointerException',
    'a null late static array retains the Java exception');
  t.equal(nullRun.frame.pc, loadPc,
    'the null access records the exact faload PC');
  const boundsRun = run(initial, 5, false);
  t.equal(boundsRun.error?.type, 'java/lang/ArrayIndexOutOfBoundsException',
    'a failed late range retains the Java bounds exception');
  t.equal(boundsRun.frame.pc, loadPc,
    'the bounds failure records the exact faload PC');
  t.end();
});

test('structured SSA preserves raw views for dominated produced-array locals',
  async (t) => {
  const className = 'StructuredProducedArrayLocalHarness';
  const classpath = compileJavaFixture(t, className, `
public final class StructuredProducedArrayLocalHarness {
  static int[] identity(int[] values) {
    return values;
  }

  static int sumReturned(int[] input, int limit) {
    int[] values = identity(input);
    int total = 0;
    for (int index = 0; index < limit; index++) total += values[index];
    return total;
  }

  static int fillAllocated(int limit) {
    byte[] values = new byte[limit];
    int total = 0;
    for (int index = 0; index < limit; index++) {
      values[index] = (byte) (index * 3);
      total += values[index];
    }
    return total;
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    structuredProducedArrayLocalViews: true,
    guestKernelOracles: false,
  } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const returnedMethod = await jvm.findMethodInHierarchy(
    className, 'sumReturned', '([II)I');
  const returned = jvm.jit.structuredSsa.compile(returnedMethod);
  const returnedSource = returned?.jvmStructuredSource || '';
  t.ok(returned?.jvmStructuredSsa,
    'the call-returned array loop selects structured SSA');
  t.equal(returned.jvmStructuredPersistentProducedArrayLocalViewCount, 1,
    'a primitive-array call result receives one dominated raw companion');
  t.ok(returnedSource.includes('ssaProducedArrayLocalData'),
    'the call result refreshes and consumes the generated companion');

  const allocatedMethod = await jvm.findMethodInHierarchy(
    className, 'fillAllocated', '(I)I');
  const allocated = jvm.jit.structuredSsa.compile(allocatedMethod);
  const allocatedSource = allocated?.jvmStructuredSource || '';
  t.ok(allocated?.jvmStructuredSsa,
    'the allocated-array loop selects structured SSA');
  t.equal(allocated.jvmStructuredPersistentProducedArrayLocalViewCount, 1,
    'a newarray result receives one dominated raw companion');
  t.ok(allocatedSource.includes('ssaProducedArrayLocalData') &&
      !allocatedSource.includes('.elements ?'),
    'the numeric loop no longer performs per-element representation selection');

  const run = (limit) => {
    const frame = new Frame(allocatedMethod);
    frame.className = className;
    frame.locals[0] = limit;
    const callStack = new Stack();
    callStack.push(frame);
    let result = null;
    let error = null;
    try {
      result = allocated(frame,
        {status: 'runnable', pendingException: null, callStack},
        jvm.jit, false);
    } catch (thrown) {
      error = thrown;
    }
    return {frame, result, error};
  };
  const normal = run(16);
  t.equal(normal.error, null,
    'the produced-array raw path completes normally');
  t.equal(normal.result?.value, 360,
    'the raw companion preserves byte stores, loads, and narrowing');
  const negative = run(-1);
  t.equal(negative.error?.type, 'java/lang/NegativeArraySizeException',
    'allocation failure retains the Java exception');
  const newarrayPc = jvm.jit.getCodeItems(allocatedMethod).findIndex((item) =>
    (item.instruction?.op || item.instruction) === 'newarray');
  t.equal(negative.frame.pc, newarrayPc,
    'allocation failure records the exact newarray PC');
  const disabledJvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    structuredProducedArrayLocalViews: false,
    guestKernelOracles: false,
  } });
  await disabledJvm.loadClassByName(className);
  disabledJvm.classInitializationState.set(className, 'INITIALIZED');
  const disabledMethod = await disabledJvm.findMethodInHierarchy(
    className, 'fillAllocated', '(I)I');
  const disabled = disabledJvm.jit.structuredSsa.compile(disabledMethod);
  t.equal(disabled.jvmStructuredPersistentProducedArrayLocalViewCount, 0,
    'the default path omits the unproven produced-array companions');
  t.end();
});

test('structured SSA hoists static array views inside atomic counted loops',
  async (t) => {
  const className = 'LoopInvariantStaticArrayHarness';
  const operationName = 'LoopInvariantUnknownOperation';
  const classpath = compileJavaFixture(t, className, `
class LoopInvariantUnknownOperation {
  int seed(int value) { return value + 1; }
}
public final class LoopInvariantStaticArrayHarness {
  static int[] table;
  static int sum(LoopInvariantUnknownOperation operation,
      int rounds, int limit) {
    int total = 0;
    if (rounds < 0) total += operation.seed(rounds);
    for (int round = 0; round < rounds; round++) {
      for (int index = 0; index < limit; index++) total += table[index];
    }
    return total;
  }
}
`);
  const jvm = new JVM({classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    structuredLoopInvariantStaticArrayViews: true,
    guestKernelOracles: false,
  }});
  for (const owner of [className, operationName]) {
    await jvm.loadClassByName(owner);
    jvm.classInitializationState.set(owner, 'INITIALIZED');
  }
  const table = jvm.jit.newPrimitiveArray(4, 'int');
  table[0] = 3;
  table[1] = 5;
  table[2] = 7;
  table[3] = 11;
  jvm.classes[className].staticFields.set('table:[I', table);
  const method = await jvm.findMethodInHierarchy(
    className, 'sum', `(L${operationName};II)I`);
  const generated = jvm.jit.structuredSsa.compile(method);
  const source = generated?.jvmRestoringDirectPositionalSource || '';
  t.ok(generated?.jvmStructuredSsa,
    'the nested counted loop selects structured SSA');
  t.equal(generated.jvmStructuredLoopInvariantStaticArrayViewCount, 1,
    'the call-free inner loop receives one static-array preheader view');
  t.ok(source.includes('ssaLoopStaticArrayValue') &&
      source.includes('ssaLoopStaticArrayData'),
    'the generated source publishes the loop-local value and raw storage');
  t.notOk(source.includes('ssaEntryStaticValue'),
    'the unrelated virtual edge still prevents unsafe method-wide caching');

  const receiver = jvm.jit.allocateObject(operationName);
  const run = (rounds, limit) => {
    const frame = new Frame(method);
    frame.className = className;
    frame.locals[0] = receiver;
    frame.locals[1] = rounds;
    frame.locals[2] = limit;
    const callStack = new Stack();
    callStack.push(frame);
    let result = null;
    let error = null;
    try {
      result = generated(frame,
        {status: 'runnable', pendingException: null, callStack},
        jvm.jit, false);
    } catch (thrown) {
      error = thrown;
    }
    return {frame, result, error};
  };
  const normal = run(3, 4);
  t.equal(normal.error, null,
    'the loop-local static view completes normally');
  t.equal(normal.result?.value, 78,
    'the preheader snapshot preserves every nested-loop load');
  const bounds = run(2, 5);
  t.equal(bounds.error?.type, 'java/lang/ArrayIndexOutOfBoundsException',
    'an invalid limit retains the Java bounds exception');
  const loadPc = jvm.jit.getCodeItems(method).findIndex((item) =>
    (item.instruction?.op || item.instruction) === 'iaload');
  t.equal(bounds.frame.pc, loadPc,
    'the hoisted reference retains the exact failing load PC');

  const disabledJvm = new JVM({classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: false,
  }});
  for (const owner of [className, operationName]) {
    await disabledJvm.loadClassByName(owner);
    disabledJvm.classInitializationState.set(owner, 'INITIALIZED');
  }
  disabledJvm.classes[className].staticFields.set('table:[I', table);
  const disabledMethod = await disabledJvm.findMethodInHierarchy(
    className, 'sum', `(L${operationName};II)I`);
  const disabled = disabledJvm.jit.structuredSsa.compile(disabledMethod);
  t.equal(disabled.jvmStructuredLoopInvariantStaticArrayViewCount, 0,
    'the production default retains ordinary per-block static loads');
  t.end();
});

test('structured SSA versions consecutive counted-loop array ranges',
  async (t) => {
  const className = 'StructuredConsecutiveLoopRangeHarness';
  const classpath = compileJavaFixture(t, className, `
public final class StructuredConsecutiveLoopRangeHarness {
  static int sum(int[] values, int split, int limit) {
    int total = 0;
    int index = 0;
    for (; index < split; index++) total += values[index];
    for (; index < limit; index++) total += values[index];
    return total;
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: false,
  } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className, 'sum', '([III)I');
  const generated = jvm.jit.structuredSsa.compile(method);
  const sourceText = generated?.jvmStructuredSource || '';
  t.ok(generated?.jvmStructuredSsa,
    'the consecutive loops select structured SSA');
  t.ok(generated.jvmStructuredSpecializedArrayRangeAccessCount >= 2,
    'both array loops receive specialized fast paths');
  t.ok(sourceText.includes('local4') && sourceText.includes('Math.ceil'),
    'the second range guard snapshots its runtime induction start');

  const run = (values, split, limit) => {
    values.type = '[I';
    const frame = new Frame(method);
    frame.className = className;
    frame.locals.splice(0, 3, values, split, limit);
    const callStack = new Stack();
    callStack.push(frame);
    let result = null;
    let error = null;
    try {
      result = generated(frame,
        {status: 'runnable', pendingException: null, callStack},
        jvm.jit, false);
    } catch (thrown) {
      error = thrown;
    }
    return {frame, result, error};
  };
  const valid = run([2, 3, 5, 7, 11], 2, 5);
  t.equal(valid.error, null, 'both guarded loops complete normally');
  t.equal(valid.result?.value, 28,
    'the runtime-start fast loop preserves every array load');

  const invalid = run([2, 3, 5, 7], 2, 5);
  const loadPcs = jvm.jit.getCodeItems(method)
    .map((item, pc) => ({item, pc}))
    .filter(({item}) =>
      (item.instruction?.op || item.instruction) === 'iaload')
    .map(({pc}) => pc);
  t.equal(invalid.error?.type, 'java/lang/ArrayIndexOutOfBoundsException',
    'a rejected runtime-start guard retains the Java bounds exception');
  t.equal(invalid.frame.pc, loadPcs[loadPcs.length - 1],
    'the second loop records the exact throwing iaload PC');
  t.end();
});

test('structured SSA versions field-array indirect indexes generically',
  async (t) => {
  const className = 'StructuredIndirectFieldArrayHarness';
  const classpath = compileJavaFixture(t, className, `
public final class StructuredIndirectFieldArrayHarness {
  short[] indexes;
  int[] values;
  int[] output;

  static int gather(StructuredIndirectFieldArrayHarness self, int passes) {
    short[] indexes = self.indexes;
    int[] values = self.values;
    int[] output = self.output;
    int checksum = 0;
    for (int pass = 0; pass < passes; pass++) {
      for (int index = 0; index < indexes.length; index++) {
        int value = values[indexes[index]];
        output[index] = value;
        checksum = checksum * 31 + value;
      }
    }
    return checksum;
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: false,
  } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className, 'gather', `(L${className};I)I`);
  const generated = jvm.jit.structuredSsa.compile(method);
  const sourceText = generated?.jvmStructuredSource || '';
  t.ok(generated?.jvmStructuredSsa,
    'the nested field-array gather selects structured SSA');
  t.ok(sourceText.includes('ssaIndirectArrayRange') &&
      generated.jvmStructuredEntryFieldArrayLocalViewCount === 3 &&
      generated.jvmStructuredIndirectArrayRangeCount >= 1 &&
      generated.jvmStructuredHoistedArrayRangeGuardCount >= 3,
    'SSA array-load provenance creates entry-hoisted indirect range guards');

  const indexes = [2, 0, 3, 1];
  indexes.type = '[S';
  const values = [10, 20, 30, 40];
  values.type = '[I';
  const output = new Array(4).fill(0);
  output.type = '[I';
  const receiver = {
    type: className,
    fields: {
      [`${className}.indexes`]: indexes,
      [`${className}.values`]: values,
      [`${className}.output`]: output,
    },
  };
  const run = (target) => {
    const frame = new Frame(method);
    frame.className = className;
    frame.locals.splice(0, 2, target, 3);
    const callStack = new Stack();
    callStack.push(frame);
    let result = null;
    let error = null;
    try {
      result = generated(frame,
        {status: 'runnable', pendingException: null, callStack},
        jvm.jit, false);
    } catch (thrown) {
      error = thrown;
    }
    return {frame, result, error};
  };
  const valid = run(receiver);
  t.equal(valid.error, null, 'the guarded indirect gather completes');
  t.ok(valid.result?.returned, 'the guarded gather returns normally');
  t.deepEqual(output.slice(), [30, 10, 40, 20],
    'the branch-free gather preserves every indexed value');

  t.equal(generated.jvmStructuredContinuation, true,
    'field-backed range proofs retain guarded lexical continuations');
  const yieldingFrame = new Frame(method);
  yieldingFrame.className = className;
  yieldingFrame.locals.splice(0, 2, receiver, 20000);
  const yieldingStack = new Stack();
  yieldingStack.push(yieldingFrame);
  const yieldingThread = {
    status: 'runnable', pendingException: null, callStack: yieldingStack,
  };
  jvm._nextEventLoopYieldAt = 0;
  const yielded = generated(
    yieldingFrame, yieldingThread, jvm.jit, false);
  t.ok(yielded?.deopt && generated.jvmHasStructuredContinuation(
    yieldingFrame),
  'the nested array loop suspends with its exact scalar and range state');
  const yieldedPc = yieldingFrame.pc;
  const yieldedLocals = yieldingFrame.locals.slice();
  const reboundOutput = new Array(4).fill(0);
  reboundOutput.type = '[I';
  receiver.fields[`${className}.output`] = reboundOutput;
  const invalidated = generated(
    yieldingFrame, yieldingThread, jvm.jit, false);
  t.ok(invalidated?.deopt && invalidated.transient,
    'a rebound range input invalidates before resuming lexical array access');
  t.notOk(generated.jvmHasStructuredContinuation(yieldingFrame),
    'the stale field-backed iterator is released');
  t.equal(yieldingFrame.pc, yieldedPc,
    'field guard invalidation preserves the materialized loop PC');
  t.deepEqual(yieldingFrame.locals, yieldedLocals,
    'field guard invalidation preserves every materialized local value');
  t.deepEqual(reboundOutput.slice(), [0, 0, 0, 0],
    'field guard invalidation precedes writes through a rebound array');
  t.equal(jvm.jit.structuredSsa
    .fieldBackedArrayContinuationFallbackCount, 1,
  'field-backed continuation invalidation is counted');
  receiver.fields[`${className}.output`] = output;

  const invalidIndexes = [2, 9, 3, 1];
  invalidIndexes.type = '[S';
  const invalidOutput = new Array(4).fill(0);
  invalidOutput.type = '[I';
  const invalid = run({
    type: className,
    fields: {
      [`${className}.indexes`]: invalidIndexes,
      [`${className}.values`]: values,
      [`${className}.output`]: invalidOutput,
    },
  });
  const loadPc = jvm.jit.getCodeItems(method).findIndex((item) =>
    (item.instruction?.op || item.instruction) === 'iaload');
  t.equal(invalid.error?.type, 'java/lang/ArrayIndexOutOfBoundsException',
    'a rejected indirect range retains the Java bounds exception');
  t.equal(invalid.frame.pc, loadPc,
    'the slow arm records the exact throwing indirect load PC');
  t.deepEqual(invalidOutput.slice(), [30, 0, 0, 0],
    'the slow arm retains mutations before the exceptional index');
  t.end();
});

test('structured SSA snapshots field arrays after receiver-cache rebinding',
  async (t) => {
  const className = 'StructuredFieldArrayAliasHarness';
  const classpath = compileJavaFixture(t, className, `
public final class StructuredFieldArrayAliasHarness {
  Object[] values;

  static void compare(StructuredFieldArrayAliasHarness first,
      StructuredFieldArrayAliasHarness second, int[] out) {
    out[0] = first.values[0] == second.values[1] ? 1 : 0;
    out[1] = second.values[1] == null ? -1 : 7;
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: false,
  } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(className, 'compare',
    `(L${className};L${className};[I)V`);
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated?.jvmStructuredSsa,
    'the two-receiver field-array method selects structured SSA');

  const shared = { type: 'java/lang/Object', fields: {} };
  const firstValues = [shared];
  firstValues.type = '[Ljava/lang/Object;';
  const secondValues = [{ type: 'java/lang/Object', fields: {} }, shared];
  secondValues.type = '[Ljava/lang/Object;';
  const first = {
    type: className,
    fields: { [`${className}.values`]: firstValues },
  };
  const second = {
    type: className,
    fields: { [`${className}.values`]: secondValues },
  };
  const out = [0, 0];
  out.type = '[I';
  const frame = new Frame(method);
  frame.className = className;
  frame.locals[0] = first;
  frame.locals[1] = second;
  frame.locals[2] = out;
  const thread = {
    status: 'runnable', pendingException: null, callStack: new Stack(),
  };
  thread.callStack.push(frame);
  let error = null;
  try {
    generated(frame, thread, jvm.jit, false);
  } catch (thrown) {
    error = thrown;
  }
  t.equal(error, null, 'receiver cache rebinding completes without an exception');
  t.deepEqual(out.slice(), [1, 7],
    'each loaded array keeps the backing storage of its own receiver');
  t.end();
});

test('structured SSA copy propagation rewrites deferred call edges',
  async (t) => {
  const className = 'StructuredAliasFallbackHarness';
  const classpath = compileJavaFixture(t, className, `
public final class StructuredAliasFallbackHarness {
  static final class Reader {
    int value;
    int next() { return value; }
  }
  static final class Box {
    int value;
    void read(Reader reader) { value = reader.next(); }
  }
  Box box;
  void decode(Reader reader) {
    box = new Box();
    box.read(reader);
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: false,
  } });
  await Promise.all([
    jvm.loadClassByName(className),
    jvm.loadClassByName(`${className}$Reader`),
    jvm.loadClassByName(`${className}$Box`),
  ]);
  for (const loaded of [className, `${className}$Reader`, `${className}$Box`]) {
    jvm.classInitializationState.set(loaded, 'INITIALIZED');
  }
  const method = await jvm.findMethodInHierarchy(
    className, 'decode', `(L${className}$Reader;)V`);
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated?.jvmStructuredSsa,
    'the constructor and deferred call compile through structured SSA');
  t.ok(generated.jvmStructuredCoalescedSsaCopyCount >= 1,
    'bytecode stack copies are coalesced without guest identity rules');
  t.deepEqual(structuredRendererTest.unboundGeneratedSsaIdentifiers(
    generated.jvmStructuredSource), [],
  'ordinary, asynchronous, deopt, and yield edges bind every SSA value');

  const rejected = structuredRendererTest.unboundGeneratedSsaIdentifiers([
    'const ssaValue0 = 1;',
    'if (thread.status !== "runnable") {',
    '  helpers.materialize(frame, ssaValue1);',
    '}',
  ].join('\n'));
  t.deepEqual(rejected, ['ssaValue1'],
    'the AST audit catches a value referenced only on a cold alternate edge');
  const outOfScope = structuredRendererTest.unboundGeneratedSsaIdentifiers([
    'let ssaValue0;',
    '{',
    '  const ssaValue1 = 7;',
    '}',
    'ssaValue0 = ssaValue1;',
  ].join('\n'));
  t.deepEqual(outOfScope, ['ssaValue1'],
    'the AST scope graph rejects nested declarations used from outer scope');

  const escapedInlineResult = [
    'let ssaValue13;',
    '{',
    '  let inlineValue0;',
    '  inlineValue0 = 7;',
    '  ssaValue13 = inlineValue0;',
    '}',
    'helpers.consume(ssaValue13);',
  ].join('\n');
  t.equal(structuredRendererTest.sinkSingleAssignmentSsaDeclarations(
    escapedInlineResult), escapedInlineResult,
  'const sinking keeps an inlined result visible to its outer consumer');
  const localResult = [
    'let ssaValue14;',
    '{',
    '  ssaValue14 = 9;',
    '  helpers.consume(ssaValue14);',
    '}',
  ].join('\n');
  const sunkLocalResult = structuredRendererTest
    .sinkSingleAssignmentSsaDeclarations(localResult);
  t.notOk(sunkLocalResult.includes('let ssaValue14;'),
    'the AST transform removes a declaration whose uses stay in the block');
  t.ok(sunkLocalResult.includes('const ssaValue14 = 9;'),
    'the definition becomes a block-local const');
  t.deepEqual(structuredRendererTest.unboundGeneratedSsaIdentifiers(
    sunkLocalResult), [], 'the sunk declaration remains lexically valid');

  const guardedEscapedResult = [
    'let ssaValue54;',
    'if (helpers.guard()) {',
    '  {',
    '    const inlineValue1 = 11;',
    '    ssaValue54 = inlineValue1;',
    '  }',
    '}',
    'if (ssaValue54 !== undefined) helpers.consume(ssaValue54);',
  ].join('\n');
  t.equal(structuredRendererTest.sinkSingleAssignmentSsaDeclarations(
    guardedEscapedResult), guardedEscapedResult,
  'conditional inline results remain declared outside their defining branch');
  t.deepEqual(structuredRendererTest.unboundGeneratedSsaIdentifiers(
    guardedEscapedResult), [],
  'the Safari-style missing-variable shape remains lexically bound');
  t.end();
});

test('structured SSA keeps inlined leaf results in their lexical scope',
  async (t) => {
  const className = 'StructuredInlineScopeHarness';
  const classpath = compileJavaFixture(t, className, `
public final class StructuredInlineScopeHarness {
  static int mask(int value, int bits) {
    return value & bits;
  }

  static void transform(int[] values) {
    for (int index = 0; index < values.length; index++) {
      int low = mask(values[index], 255);
      values[index] = mask(low, 127);
    }
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    guestKernelOracles: false,
  } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className, 'transform', '([I)V');
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated?.jvmStructuredSsa,
    'the arbitrary array loop with integral leaves compiles');
  t.equal(typeof generated.jvmRestoringDirectPositionalBody, 'function',
    'the verified loop publishes its direct restoring ABI');
  t.deepEqual(structuredRendererTest.unboundGeneratedSsaIdentifiers(
    generated.jvmRestoringDirectPositionalSource), [],
  'scope-aware promotion leaves every direct-body value lexically bound');

  const values = [0x1234, 0x80ff, 0x7f, -1];
  values.type = '[I';
  const result = generated.jvmRestoringDirectPositionalBody(
    jvm.jit,
    {target: {freeFrame: null}},
    values,
    {status: 'runnable', callStack: {items: []}},
    1,
  );
  t.equal(result, jvm.jit.returnVoid(),
    'the direct positional loop returns its canonical void sentinel');
  t.deepEqual(values.slice(), [0x34, 0x7f, 0x7f, 0x7f],
    'nested inlined leaves preserve every transformed value');
  t.end();
});

test('structured JVM SSA emits atomic kernels for fully bounded counted loops', async (t) => {
  const classpath = compileJavaFixture(t, 'StructuredAtomicHarness', `
public class StructuredAtomicHarness {
  int[] values;
  public void transform() {
    int index = 0;
    for (int y = 0; y < 4; y++) {
      for (int x = 0; x < 8; x++) {
        int old = values[index];
        values[index++] = old + 1;
      }
    }
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    rendererPipeline: true,
    structuredSsa: true,
    profileMethods: false,
  } });
  await jvm.loadClassByName('StructuredAtomicHarness');
  jvm.classInitializationState.set('StructuredAtomicHarness', 'INITIALIZED');
  const thread = {
    id: 0,
    name: 'structured-atomic-counted-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const values = new Array(32).fill(7);
  values.type = '[I';
  const receiver = {
    type: 'StructuredAtomicHarness',
    fields: { 'StructuredAtomicHarness.values': values },
  };

  await invoke(jvm, thread, 'StructuredAtomicHarness', 'transform', '()V', [receiver]);
  const method = await jvm.findMethodInHierarchy(
    'StructuredAtomicHarness', 'transform', '()V');
  const generated = jvm.jit.codegenCache.get(method);
  const fast = generated.jvmFastBody || generated;
  t.deepEqual(values.slice(), new Array(32).fill(8),
    'bounded nested loop preserves every array mutation');
  t.ok(fast.jvmStructuredSsa, 'arbitrary counted-loop method selects structured SSA');
  t.equal(fast.jvmStructuredAtomicBoundedLoops, true,
    'CFG/local-update proof selects the atomic ordinary-function kernel');
  t.equal(fast.jvmStructuredBoundedIterationProduct, 32,
    'the structural trip-count product is recorded');
  t.equal(fast.jvmStructuredContinuation, false,
    'atomic kernel does not carry generator continuation state');
  t.equal((fast.jvmStructuredSource.match(/continueStructuredQuantum/g) || []).length, 0,
    'proven bounded loops contain no per-iteration scheduler branch');
  t.equal(fast.jvmStructuredSentinelArrayLoadCount, 1,
    'primitive load uses the exact exceptional sentinel');
  t.equal(fast.jvmStructuredEliminatedArrayStoreCheckCount, 1,
    'same-array/index store reuses the successful-load proof');

  const shortValues = new Array(5).fill(3);
  shortValues.type = '[I';
  const shortReceiver = {
    type: 'StructuredAtomicHarness',
    fields: { 'StructuredAtomicHarness.values': shortValues },
  };
  const frame = new Frame(method);
  frame.className = 'StructuredAtomicHarness';
  frame.locals[0] = shortReceiver;
  thread.callStack.push(frame);
  let thrown = null;
  try {
    generated(frame, thread, jvm.jit, false);
  } catch (error) {
    thrown = error;
  }
  const loadIndex = frame.instructions.findIndex((item) => {
    const instruction = item && item.instruction;
    return (typeof instruction === 'string' ? instruction : instruction?.op) === 'iaload';
  });
  t.equal(thrown?.type, 'java/lang/ArrayIndexOutOfBoundsException',
    'sentinel slow path retains the precise JVM bounds exception');
  t.equal(frame.pc, loadIndex, 'exception records the exact throwing bytecode');
  t.deepEqual(shortValues.slice(), new Array(5).fill(4),
    'effects before the exceptional element are retained exactly once');
  thread.callStack.pop();
  t.end();
});

test('structured continuations serialize canonical state and invalidate after interpretation', (t) => {
  const jvm = new JVM({ jit: {
    structuredSsa: true, scalarLoops: true, profileMethods: false,
  } });
  jvm._nextEventLoopYieldAt = 0;
  const method = structuredSsaJoinMethod();
  const generated = jvm.jit.compileMethod(method);
  const frame = new Frame(method);
  frame.className = 'ContinuationHarness';
  frame.locals[0] = 10001;
  const callStack = new Stack();
  callStack.push(frame);
  const thread = {
    id: 7, status: 'runnable', callStack, pendingException: null,
  };
  jvm.threads = [thread];
  const yielded = generated(frame, thread, jvm.jit, false);
  t.ok(yielded.deopt && generated.jvmHasStructuredContinuation(frame),
    'safe point retains a lexical continuation');

  const snapshot = jvm.serialize();
  t.equal(snapshot.threads[0].callStack[0].pc, frame.pc,
    'snapshot records the materialized loop-header PC');
  t.deepEqual(snapshot.threads[0].callStack[0].locals, frame.locals,
    'snapshot records canonical locals instead of generator internals');
  t.notOk(JSON.stringify(snapshot).includes('structuredSsaContinuation'),
    'non-serializable continuation state is excluded from snapshots');

  // One interpreted instruction changes the canonical PC. A later JIT probe
  // must discard, rather than resume, the now-stale lexical state.
  frame.pc += 1;
  const invalidated = generated(frame, thread, jvm.jit, false);
  t.ok(invalidated.deopt && invalidated.transient,
    'changed canonical state invalidates the continuation');
  t.notOk(generated.jvmHasStructuredContinuation(frame),
    'invalidated generator state is released');
  t.end();
});

test('structured JVM SSA keeps a bounded wall-clock slice under thread contention', (t) => {
  const jvm = new JVM({ jit: { structuredSsa: true, profileMethods: false } });
  const current = { status: 'runnable' };
  const competing = { status: 'runnable' };
  jvm.threads = [current, competing];
  jvm._nextEventLoopYieldAt = Date.now() + 60000;
  t.ok(jvm.jit.continueStructuredQuantum(current),
    'another runnable Java thread does not force scalar-state materialization');

  jvm.threads[1] = { status: 'SLEEPING', sleepUntil: Date.now() - 1 };
  t.notOk(jvm.jit.continueStructuredQuantum(current),
    'an expired Java timer still forces the scheduler safe point');

  jvm.threads[1] = competing;
  jvm._nextEventLoopYieldAt = 0;
  t.notOk(jvm.jit.continueStructuredQuantum(current),
    'the browser wall-clock deadline bounds the contended region');

  t.end();
});

test('generated quanta compare realtime fake-clock deadlines in guest time', (t) => {
  const fakeEpoch = 1000000000000;
  const jvm = new JVM({
    fakeTime: fakeEpoch,
    fakeTimeRealtime: true,
    jit: { structuredSsa: true, profileMethods: false },
  });
  const current = { status: 'runnable' };
  const sleeping = {
    status: 'SLEEPING',
    sleepUntil: fakeEpoch + 60000,
  };
  jvm.threads = [current, sleeping];
  jvm._nextEventLoopYieldAt = Date.now() + 60000;

  t.ok(jvm.jit.continueQuantum(current),
    'a future guest sleep does not expire against the host epoch');
  t.ok(jvm.jit.continueStructuredQuantum(current),
    'structured execution keeps its wall-clock slice with a realtime clock');

  sleeping.sleepUntil = fakeEpoch - 1;
  t.notOk(jvm.jit.continueQuantum(current),
    'an expired realtime guest sleep still forces a safe point');
  t.notOk(jvm.jit.continueStructuredQuantum(current),
    'structured execution observes the expired guest deadline');

  const deterministic = new JVM({
    fakeTime: fakeEpoch,
    jit: { structuredSsa: true, profileMethods: false },
  });
  const deterministicThread = { status: 'runnable' };
  deterministic.threads = [deterministicThread];
  deterministic._nextEventLoopYieldAt = Date.now() + 60000;
  t.notOk(deterministic.jit.continueStructuredQuantum(deterministicThread),
    'a step-driven deterministic clock retains exact safe-point behavior');
  t.end();
});

test('scalar loop arithmetic exceptions materialize precise frame state', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0, profileMethods: false } });
  const instructions = [
    'iconst_0', 'istore_2', 'iload_2', 'iload_0',
    { op: 'if_icmpge', arg: 'Lreturn' },
    'iload_1', 'iload_2', 'idiv', 'istore_1',
    { op: 'iinc', varnum: 2, incr: 1 }, { op: 'goto', arg: 'Lloop' },
    'iload_1', 'ireturn',
  ];
  const method = {
    name: 'divisionShape', descriptor: '(II)I', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: instructions.map((instruction, index) => ({
        labelDef: index === 2 ? 'Lloop:' : index === 11 ? 'Lreturn:' : `L${index}:`,
        instruction,
      })),
      localsSize: '3', stackSize: '2', exceptionTable: [],
    } }],
  };
  const generated = jvm.jit.compileScalarIntegerLoop(method);
  t.ok(generated?.jvmScalarLoop, 'division loop remains structurally scalarizable');
  const frame = new Frame(method);
  frame.locals[0] = 1;
  frame.locals[1] = 12;
  const callStack = new Stack();
  callStack.push(frame);
  let thrown;
  try {
    generated(frame, { status: 'runnable', callStack }, jvm.jit, false);
  } catch (error) {
    thrown = error;
  }
  t.equal(thrown?.type, 'java/lang/ArithmeticException', 'division by zero throws Java arithmetic exception');
  t.equal(frame.pc, 7, 'throwing bytecode PC is precise');
  t.deepEqual(frame.stack.items, [12, 0], 'throwing operands are reconstructed in JVM order');
  t.equal(frame.locals[2], 0, 'scalar locals are reconstructed before throwing');
  t.end();
});

test('scalar feature loops preserve arrays, fields, calls, and reporter handlers', async (t) => {
  const classpath = compileJavaFixture(t, 'ScalarFeatureHarness', `
public class ScalarFeatureHarness {
  static int staticBias = 3;
  static class Box { int[] values; int bias; volatile int changing; }
  static void record(int[] out, int index, int value) { out[index] = value; }
  static int adjust(int value) { return value * 3 + 1; }
  static int branchedAdjust(int value, int threshold) {
    int mixed = (value ^ (value >>> 16)) + 13;
    if (mixed < threshold) mixed = threshold - mixed;
    return (mixed & 255) * 65793;
  }
  static void inlineInto(int[] out) {
    for (int i = 0; i < out.length; i++) out[i] = adjust(i);
  }
  static void inlineBranchInto(int[] out) {
    for (int i = 0; i < out.length; i++) out[i] = branchedAdjust(i - 20, 7);
  }
  static void clearPostIncrement(int[] out) {
    int index = 0;
    while (index < out.length) out[index++] = 0;
  }
  static void repeatedReads(Box box, int[] out) {
    for (int i = 0; i < out.length; i++) {
      out[i] = box.bias + box.bias + box.values.length + box.values.length;
    }
  }
  static void volatileReads(Box box, int[] out) {
    for (int i = 0; i < out.length; i++) out[i] = box.changing + box.changing;
  }
  public static void compute(Box box, int rounds, int[] out) {
    try {
      int sum = 0;
      for (int i = 0; i < rounds; i++) {
        int[] values = box.values;
        sum += values[i % values.length] + box.bias + staticBias;
        record(out, i, sum);
      }
      out[rounds] = sum;
    } catch (RuntimeException error) {
      throw error;
    }
  }
}
`);

  async function run(scalarLoops, scalarGuestBodies = scalarLoops,
      scalarSsaOptimizations = true, wrappedValues = false,
      structuredSsa = false, ordinaryAdaptive = false) {
    const jvm = new JVM({ classpath, jit: {
      warmupThreshold: 0, preferWholeMethodJs: true, profileMethods: false, scalarLoops,
      scalarGuestBodies, scalarSsaOptimizations, structuredSsa,
      ordinaryAdaptiveFramelessPositional: ordinaryAdaptive,
    } });
    for (const className of ['ScalarFeatureHarness', 'ScalarFeatureHarness$Box']) {
      const classData = await jvm.loadClassByName(className);
      jvm.classInitializationState.set(className, 'INITIALIZED');
      if (!classData.staticFields) classData.staticFields = new Map();
    }
    jvm.classes.ScalarFeatureHarness.staticFields.set('staticBias:I', 3);
    const thread = {
      id: 0, name: `scalar-features-${scalarLoops}`, callStack: new Stack(),
      status: 'runnable', pendingException: null,
    };
    jvm.threads = [thread];
    jvm.currentThreadIndex = 0;
    const rawValues = [2, 4];
    rawValues.type = '[I';
    const values = wrappedValues
      ? { type: '[I', elements: rawValues, length: rawValues.length }
      : rawValues;
    const box = { type: 'ScalarFeatureHarness$Box', fields: {
      'ScalarFeatureHarness$Box.values': values,
      'ScalarFeatureHarness$Box.bias': 8,
      'ScalarFeatureHarness$Box.changing': 6,
    } };
    const out = [0, 0, 0, 0];
    out.type = '[I';
    await invoke(jvm, thread, 'ScalarFeatureHarness', 'compute',
      '(LScalarFeatureHarness$Box;I[I)V', [box, 3, out]);
    const postIncrement = [9, 8, 7, 6];
    postIncrement.type = '[I';
    await invoke(jvm, thread, 'ScalarFeatureHarness', 'clearPostIncrement',
      '([I)V', [postIncrement]);
    const repeated = [0, 0];
    repeated.type = '[I';
    await invoke(jvm, thread, 'ScalarFeatureHarness', 'repeatedReads',
      '(LScalarFeatureHarness$Box;[I)V', [box, repeated]);
    const volatileOut = [0, 0];
    volatileOut.type = '[I';
    await invoke(jvm, thread, 'ScalarFeatureHarness', 'volatileReads',
      '(LScalarFeatureHarness$Box;[I)V', [box, volatileOut]);
    const inlineOut = [0, 0, 0, 0];
    inlineOut.type = '[I';
    await invoke(jvm, thread, 'ScalarFeatureHarness', 'inlineInto', '([I)V', [inlineOut]);
    const inlineBranchOut = new Array(32).fill(0);
    inlineBranchOut.type = '[I';
    await invoke(jvm, thread, 'ScalarFeatureHarness', 'inlineBranchInto', '([I)V',
      [inlineBranchOut]);
    const method = await jvm.findMethodInHierarchy('ScalarFeatureHarness', 'compute',
      '(LScalarFeatureHarness$Box;I[I)V');
    const clearMethod = await jvm.findMethodInHierarchy('ScalarFeatureHarness',
      'clearPostIncrement', '([I)V');
    const repeatedMethod = await jvm.findMethodInHierarchy('ScalarFeatureHarness',
      'repeatedReads', '(LScalarFeatureHarness$Box;[I)V');
    const volatileMethod = await jvm.findMethodInHierarchy('ScalarFeatureHarness',
      'volatileReads', '(LScalarFeatureHarness$Box;[I)V');
    const inlineMethod = await jvm.findMethodInHierarchy('ScalarFeatureHarness',
      'inlineInto', '([I)V');
    const inlineBranchMethod = await jvm.findMethodInHierarchy('ScalarFeatureHarness',
      'inlineBranchInto', '([I)V');
    return {
      jvm, thread, method, generated: jvm.jit.codegenCache.get(method), box, out,
      postIncrement, clearGenerated: jvm.jit.codegenCache.get(clearMethod),
      repeated, repeatedGenerated: jvm.jit.codegenCache.get(repeatedMethod),
      volatileOut, volatileGenerated: jvm.jit.codegenCache.get(volatileMethod),
      inlineOut, inlineGenerated: jvm.jit.codegenCache.get(inlineMethod),
      inlineBranchOut, inlineBranchGenerated: jvm.jit.codegenCache.get(inlineBranchMethod),
    };
  }

  const baseline = await run(false);
  const scalar = await run(true);
  const scalarWithoutSsa = await run(true, true, false);
  const wrappedScalar = await run(true, true, true, true);
  const defaultTier = await run(true, false);
  const structured = await run(false, false, false, false, true, true);
  t.deepEqual(scalar.out, baseline.out, 'scalar region matches baseline array mutations');
  t.deepEqual(scalar.out.slice(), [13, 28, 41, 41],
    'instance/static fields and synchronous record calls preserve results');
  t.ok(scalar.generated?.jvmScalarLoop,
    'array/field loop with a bare reporter handler selects scalar generation');
  t.deepEqual(scalar.postIncrement, baseline.postIncrement,
    'iload snapshots its operand before a following iinc');
  t.deepEqual(scalar.postIncrement.slice(), [0, 0, 0, 0],
    'post-increment array stores preserve every destination index');
  t.ok(scalar.clearGenerated?.jvmScalarLoop,
    'post-increment array stores stay in scalar generation');
  t.deepEqual(scalar.out, scalarWithoutSsa.out,
    'SSA-style scalar optimizations preserve the non-optimized result');
  t.deepEqual(wrappedScalar.out, scalar.out,
    'cached raw array views preserve wrapped-array reads');
  t.deepEqual(scalar.repeated.slice(), [20, 20],
    'repeated field and length reads preserve their values');
  t.ok(scalar.repeatedGenerated?.jvmScalarEliminatedReadCount >= 2,
    'local value numbering removes redundant field and array-length reads');
  t.deepEqual(scalar.volatileOut.slice(), [12, 12],
    'volatile field reads preserve their values');
  t.equal((scalar.volatileGenerated?.toString().match(/helpers\.getFieldAt/g) || []).length, 4,
    'both volatile field reads remain in the generated body');
  t.ok(scalar.generated?.jvmScalarArrayViewCount > 0,
    'scalar array operations use cached raw-storage companions');
  t.ok(scalar.generated?.jvmScalarThreadedEdgeCount > 0,
    'verified fall-through edges are threaded without redispatch');
  t.notOk(scalarWithoutSsa.generated?.jvmScalarSsa,
    'the SSA-style pass can be disabled for differential measurement');
  t.notOk(defaultTier.generated?.jvmScalarLoop,
    'array/field/call guest bodies remain opt-in after performance acceptance fails');
  t.deepEqual(structured.out, baseline.out,
    'structured SSA preserves array, field, remainder, and static-call effects');
  t.ok(structured.generated?.jvmStructuredSsa,
    'array/field/call loop selects structured SSA without method-name recognition');
  t.ok(structured.generated?.jvmStructuredFieldReadCacheCount >= 2,
    'call-bearing loops cache non-volatile fields between effect boundaries');
  t.ok(structured.generated?.jvmStructuredSource.includes(
    'ssaFieldCache0Valid = false'),
  'calls invalidate cached field values before another guest effect');
  t.ok(structured.repeatedGenerated?.jvmStructuredFieldReadCacheCount >= 2,
    'call-free structured loops cache non-volatile fields by receiver identity');
  t.equal(structured.volatileGenerated?.jvmStructuredFieldReadCacheCount, 0,
    'volatile field reads are never cached by the structured tier');
  t.ok(structured.generated.jvmStructuredDeferredCallMaterializationCount > 0,
    'normal synchronous calls defer parent Frame materialization');
  t.notOk(structured.generated.jvmStructuredSource.includes('getStaticSyncAt'),
    'initialized static target is read directly without the generic helper');
  t.ok(structured.generated.jvmStructuredSource.includes('.get("staticBias:I")'),
    'direct static access retains a live read from the canonical field map');
  t.ok(structured.generated.jvmStructuredSource.includes(
    'structuredSsa.classInitializationGuards'),
  'structured entry uses an epoch-keyed class-initialization proof');
  t.notOk(structured.generated.jvmStructuredSource.includes(
    'classInitializationState.get('),
  'the hot structured entry does not repeat class-state map lookups');
  structured.jvm.classes.ScalarFeatureHarness.staticFields.set('staticBias:I', 9);
  const changedStaticOut = [0, 0];
  changedStaticOut.type = '[I';
  await invoke(structured.jvm, structured.thread, 'ScalarFeatureHarness', 'compute',
    '(LScalarFeatureHarness$Box;I[I)V', [structured.box, 1, changedStaticOut]);
  t.deepEqual(changedStaticOut.slice(), [19, 19],
    'direct static target observes values changed after compilation');

  structured.jvm.classInitializationState.set('ScalarFeatureHarness', 'UNINITIALIZED');
  structured.jvm.classInitializationEpoch += 1;
  const guardedStaticOut = [0, 0];
  guardedStaticOut.type = '[I';
  const guardedStaticFrame = new Frame(structured.method);
  guardedStaticFrame.className = 'ScalarFeatureHarness';
  guardedStaticFrame.locals[0] = structured.box;
  guardedStaticFrame.locals[1] = 1;
  guardedStaticFrame.locals[2] = guardedStaticOut;
  structured.thread.callStack.push(guardedStaticFrame);
  const guardedStatic = structured.generated(
    guardedStaticFrame, structured.thread, structured.jvm.jit, false);
  t.ok(guardedStatic.deopt && guardedStatic.transient,
    'class initialization guard falls back at structured entry');
  t.deepEqual(guardedStaticOut.slice(), [0, 0],
    'static entry guard runs before guest side effects');
  structured.thread.callStack.pop();
  structured.jvm.classInitializationState.set('ScalarFeatureHarness', 'INITIALIZED');
  t.deepEqual(structured.inlineOut, baseline.inlineOut,
    'structured SSA preserves a loop with an inlined integer leaf');
  t.notOk(structured.inlineGenerated.jvmStructuredSource.includes('tryInvokeSyncAt'),
    'verified integer leaf is emitted directly without generic call dispatch');
  t.deepEqual(structured.inlineBranchOut, baseline.inlineBranchOut,
    'forward-branching integer leaf preserves baseline results');
  t.notOk(structured.inlineBranchGenerated.jvmStructuredSource.includes('tryInvokeSyncAt'),
    'verified forward-branching integer leaf is emitted without generic call dispatch');

  const nullBox = { type: 'ScalarFeatureHarness$Box', fields: {
    'ScalarFeatureHarness$Box.values': null,
    'ScalarFeatureHarness$Box.bias': 8,
  } };
  const frame = new Frame(scalar.method);
  frame.className = 'ScalarFeatureHarness';
  frame.locals[0] = nullBox;
  frame.locals[1] = 1;
  frame.locals[2] = [0, 0];
  scalar.thread.callStack.push(frame);
  let thrown;
  try {
    scalar.generated(frame, scalar.thread, scalar.jvm.jit, false);
  } catch (error) {
    thrown = error;
  }
  const arrayLengthPc = frame.instructions.findIndex((item) =>
    (typeof item.instruction === 'string' ? item.instruction : item.instruction?.op) === 'arraylength');
  t.equal(thrown?.type, 'java/lang/NullPointerException', 'null array raises the JVM exception');
  t.equal(frame.pc, arrayLengthPc, 'null array records the exact throwing PC');
  t.deepEqual(frame.stack.items, [0, null, 0, null], 'the complete JVM operand stack is reconstructed');
  scalar.thread.callStack.pop();

  const structuredFrame = new Frame(structured.method);
  structuredFrame.className = 'ScalarFeatureHarness';
  structuredFrame.locals[0] = nullBox;
  structuredFrame.locals[1] = 1;
  structuredFrame.locals[2] = [0, 0];
  structured.thread.callStack.push(structuredFrame);
  let structuredThrown;
  try {
    structured.generated(structuredFrame, structured.thread, structured.jvm.jit, false);
  } catch (error) {
    structuredThrown = error;
  }
  t.equal(structuredThrown?.type, 'java/lang/NullPointerException',
    'structured SSA preserves the JVM null exception');
  t.equal(structuredFrame.pc, arrayLengthPc,
    'structured SSA records the exact throwing bytecode PC');
  t.deepEqual(structuredFrame.stack.items, [0, null, 0, null],
    'structured SSA reconstructs throwing operands in JVM order');
  structured.thread.callStack.pop();
  t.end();
});

// Doubles and putfield in a verified loop: the structured tier must produce
// the same result and heap effect as the baseline generated tier.
test('structured JVM SSA covers double arithmetic and putfield', (t) => {
  // Instance (I)I layout: locals[0]=this, locals[1]=n, locals[2]=i,
  // locals[3]=acc (double).
  const instructions = [
    'iconst_0', 'istore_2', 'dconst_0', { op: 'dstore', arg: '3' },
    'iload_2', 'iload_1', { op: 'if_icmpge', arg: 'Lexit' },
    { op: 'dload', arg: '3' }, 'iload_2', 'i2d',
    { op: 'ldc2_w', arg: 3.0 }, 'ddiv', 'dadd', { op: 'dstore', arg: '3' },
    'aload_0', { op: 'dload', arg: '3' }, 'd2i',
    { op: 'putfield', arg: [null, 'DoubleHolder', ['total', 'I']] },
    { op: 'iinc', varnum: 2, incr: 1 }, { op: 'goto', arg: 'Lloop' },
    { op: 'dload', arg: '3' }, { op: 'dload', arg: '3' }, 'dcmpl',
    { op: 'ifne', arg: 'Lnan' },
    { op: 'dload', arg: '3' }, 'dconst_1', 'dadd', 'd2i', 'ireturn',
    'iconst_m1', 'ireturn',
  ];
  const labelFor = (index) => index === 4 ? 'Lloop:' : index === 20 ? 'Lexit:'
    : index === 29 ? 'Lnan:' : `L${index}:`;
  const method = {
    name: 'accumulate', descriptor: '(I)I', flags: ['public'],
    attributes: [{ type: 'code', code: {
      codeItems: instructions.map((instruction, index) => ({
        labelDef: labelFor(index), instruction,
      })),
      localsSize: '5', stackSize: '6', exceptionTable: [],
    } }],
  };
  const run = (useStructured) => {
    const jvm = new JVM({ jit: useStructured
      ? { structuredSsa: true, profileMethods: false }
      : { structuredSsa: false, scalarLoops: false, profileMethods: false } });
    const receiver = { type: 'DoubleHolder', fields: { 'DoubleHolder.total': 0 } };
    const generated = useStructured
      ? jvm.jit.structuredSsa.compile(method)
      : jvm.jit.compileBaselineMethod(method);
    const frame = new Frame(method);
    frame.className = 'DoubleHolder';
    frame.locals[0] = receiver;
    frame.locals[1] = 9;
    const callStack = new Stack();
    callStack.push(frame);
    const result = generated(frame, { status: 'runnable', callStack }, jvm.jit, false);
    return { result, receiver, generated };
  };
  const structured = run(true);
  t.ok(structured.generated?.jvmStructuredSsa,
    'double/putfield loop selects the structured SSA renderer');
  const baseline = run(false);
  t.equal(structured.result.returned, true, 'structured loop returns normally');
  t.deepEqual(structured.result, baseline.result,
    'structured double arithmetic matches the baseline generated tier');
  t.equal(structured.receiver.fields['DoubleHolder.total'],
    baseline.receiver.fields['DoubleHolder.total'],
    'structured putfield stores the same narrowed value');
  t.end();
});

test('structured SSA restores ordinary guest handlers through the baseline resume body',
  async (t) => {
    const classpath = compileJavaFixture(t, 'StructuredCatchHarness', `
public class StructuredCatchHarness {
  static int effects;
  static int observed;

  public static int compute(int[] values) {
    int total = 0;
    try {
      for (int index = 0; index < values.length; index++) {
        effects++;
        total += 100 / values[index];
      }
    } catch (ArithmeticException expected) {
      total += 7;
    }
    observed = total;
    return total;
  }
}
`);
    const jvm = new JVM({ classpath, jit: {
      warmupThreshold: 0, structuredSsa: true, profileMethods: false,
    } });
    await jvm.loadClassByName('StructuredCatchHarness');
    jvm.classInitializationState.set('StructuredCatchHarness', 'INITIALIZED');
    jvm.classes.StructuredCatchHarness.staticFields.set('effects:I', 0);
    jvm.classes.StructuredCatchHarness.staticFields.set('observed:I', 0);
    const thread = {
      id: 0, name: 'structured-catch', callStack: new Stack(),
      status: 'runnable', pendingException: null,
    };
    jvm.threads = [thread];
    jvm.currentThreadIndex = 0;
    const values = [2, 0, 5];
    values.type = '[I';
    await invoke(jvm, thread, 'StructuredCatchHarness', 'compute', '([I)I', [values]);

    const method = await jvm.findMethodInHierarchy(
      'StructuredCatchHarness', 'compute', '([I)I');
    const generated = jvm.jit.getGeneratedFunction(method);
    t.ok(generated?.jvmStructuredSsa,
      'a method with a real recovery handler keeps its normal path in structured SSA');
    const statics = jvm.classes.StructuredCatchHarness.staticFields;
    t.equal(statics.get('effects:I'), 2,
      'effects preceding the throwing operation execute exactly once');
    t.equal(statics.get('observed:I'), 57,
      'the JVM dispatcher catches the exception and the baseline body resumes at the handler');

    const throwingPc = generated.jvmStructuredSource.indexOf(
      'java/lang/ArithmeticException');
    t.ok(throwingPc >= 0,
      'the structured body retains precise arithmetic-exception materialization');
    t.end();
  });

function fusedShapeMethod(name, descriptor, targetDescriptor, callCount, options = {}) {
  const targetOwner = options.targetOwner || 'ShapeTarget';
  const targetName = options.targetName || 'renderAnything';
  const codeItems = [];
  if (options.integerNative) {
    codeItems.push(
      { instruction: 'iconst_0' },
      { instruction: 'iconst_1' },
      { instruction: {
        op: 'invokestatic',
        arg: ['Method', 'java/lang/Math', ['min', '(II)I']],
      } },
      { instruction: 'pop' },
    );
  }
  const { params } = require('../src/parsing/typeParser').parseDescriptor(targetDescriptor);
  for (let call = 0; call < callCount; call += 1) {
    for (const type of params) {
      codeItems.push({ instruction: type.endsWith('[]') ? 'aconst_null' : 'iconst_0' });
    }
    codeItems.push({ instruction: {
      op: 'invokestatic',
      arg: ['Method', targetOwner, [targetName, targetDescriptor]],
    } });
  }
  codeItems.push({ instruction: 'return' });
  codeItems.forEach((item, index) => { item.labelDef = `L${index}:`; });
  return {
    name,
    descriptor,
    attributes: [{ type: 'code', code: {
      codeItems,
      localsSize: String(options.localsSize || 48),
      stackSize: '24',
      exceptionTable: options.exceptionTable || [],
    } }],
  };
}

test('fused bytecode-region verification is independent of descriptors and call counts', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0 } });
  const first = fusedShapeMethod('first', '(III)V', '(I[I)V', 3);
  const second = fusedShapeMethod('second', '(IIIIIII)V', '(II[I)V', 7);
  t.ok(jvm.jit.fusedRegions.verifyMethod(first),
    'an arbitrary descriptor and three repeated calls verify');
  t.ok(jvm.jit.fusedRegions.verifyMethod(second),
    'a different descriptor and call count verify through the same path');
  t.notOk(jvm.jit.fusedRegions.constructor.FAMILY_BY_WRAPPER,
    'there is no descriptor-to-guest-family selection table');

  const badStack = fusedShapeMethod('badStack', '(III)V', '(I[I)V', 3);
  badStack.attributes[0].code.codeItems.shift();
  t.notOk(jvm.jit.fusedRegions.verifyMethod(badStack),
    'an invalid operand-stack shape is rejected');
  const badHandler = fusedShapeMethod('badHandler', '(III)V', '(I[I)V', 3, {
    exceptionTable: [{ handlerLbl: 'L0', catch_type: 'java/lang/Exception' }],
  });
  t.notOk(jvm.jit.fusedRegions.verifyMethod(badHandler),
    'an unsupported exception handler is rejected');
  t.end();
});

test('fused bytecode-region discovery follows repeated calls into an array-store loop', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0, fusedRegions: true } });
  const wrapper = fusedShapeMethod('wrapper', '(IIIIII)V', '(I[I)V', 4, {
    targetOwner: 'RasterOwner', targetName: 'rasterTarget',
  });
  wrapper.flags = ['static'];
  const raster = fusedShapeMethod('rasterTarget', '(I[I)V', '([IIII)V', 3, {
    targetOwner: 'SpanOwner', targetName: 'spanTarget',
  });
  const span = {
    name: 'spanTarget', descriptor: '([IIII)V', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: [
        { labelDef: 'L0:', instruction: 'aload_0' },
        { instruction: 'iload_1' },
        { instruction: 'iload_2' },
        { instruction: 'iastore' },
        { instruction: { op: 'iinc', varnum: 1, incr: 1 } },
        { instruction: 'iload_1' },
        { instruction: 'iload_3' },
        { instruction: { op: 'if_icmplt', arg: 'L0' } },
        { instruction: 'return' },
      ], localsSize: '4', stackSize: '3', exceptionTable: [],
    } }],
  };
  const install = (owner, method) => {
    jvm.classes[owner] = {
      ast: { classes: [{ superClassName: null, items: [{ type: 'method', method }] }] },
      staticFields: new Map(),
    };
  };
  install('RasterOwner', raster);
  install('SpanOwner', span);
  const discovered = jvm.jit.fusedRegions.discoverRegion(wrapper);
  t.ok(discovered, 'the intermethod region is discovered from bytecode structure');
  t.equal(discovered.family.wrapper, '(IIIIII)V', 'wrapper descriptor is derived');
  t.equal(discovered.family.raster, '(I[I)V', 'raster descriptor is derived');
  t.equal(discovered.family.scanline, '([IIII)V', 'scanline descriptor is derived');
  t.equal(discovered.wrapper.calls.length, 4, 'non-six wrapper call count is retained');
  t.equal(discovered.raster.calls.length, 3, 'non-six raster call count is retained');
  t.ok(jvm.jit.fusedRegions.mayFuse(wrapper),
    'the synchronous resolver recognizes the wrapper without a descriptor allowlist');
  const unreachableCall = { instruction: {
    op: 'invokestatic',
    arg: ['Method', 'DeadOwner', ['deadHelper', '()V']],
  }, labelDef: 'Ldead:' };
  wrapper.attributes[0].code.codeItems.push(unreachableCall);
  t.ok(jvm.jit.fusedRegions.mayFuse(wrapper),
    'unreachable dead calls do not reject a structurally verified wrapper');
  const mixedCalls = fusedShapeMethod('mixed', '(J)V', '(I[I)V', 4, {
    targetOwner: 'RasterOwner', targetName: 'rasterTarget', integerNative: true,
  });
  mixedCalls.flags = ['static'];
  t.notOk(jvm.jit.fusedRegions.mayFuse(mixedCalls),
    'a mixed-call method does not enter the fused-only resolution path');
  t.end();
});

test('lexical fused kernels hoist only stable read-only statics',
  async (t) => {
  const className = 'FusedStaticHoistHarness';
  const classpath = compileJavaFixture(t, className, `
public final class FusedStaticHoistHarness {
  static int stable = 7;
  static volatile int changing = 9;

  static void readStable(int[] destination) {
    destination[0] = stable + stable;
  }

  static void readVolatile(int[] destination) {
    destination[0] = changing + changing;
  }

  static void readWrite(int[] destination) {
    stable++;
    destination[0] = stable;
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0, fusedRegions: true,
  } });
  const classData = await jvm.loadClassByName(className);
  classData.staticFieldsInitialized = true;
  classData.staticFields.set('stable:I', 7);
  classData.staticFields.set('changing:I', 9);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const compile = async (name) => {
    const method = await jvm.findMethodInHierarchy(
      className, name, '([I)V');
    const verified = jvm.jit.fusedRegions.verifyMethod(method);
    const region = {
      family: { name: 'static-hoist-test' },
      wrapperOwner: className,
      rasterOwner: className,
      scanlineOwner: className,
      staticTargets: [],
      staticSiteIds: [],
      staticOwners: [],
    };
    t.ok(verified, `${name} verifies as a lexical integer kernel`);
    const resolved = jvm.jit.fusedRegions.prepareStatics(
      region, verified.staticRefs);
    t.ok(resolved, `${name} resolves its static targets`);
    if (!resolved) return '';
    const generated = jvm.jit.fusedRegions.compileLexicalKernel(
      method, verified, region, 'scanline');
    t.ok(generated?.jvmLexicalFusedKernel,
      `${name} compiles through the generic lexical renderer`);
    return generated?.jvmLexicalFusedSource || '';
  };
  const stable = await compile('readStable');
  const volatile = await compile('readVolatile');
  const written = await compile('readWrite');
  t.ok(/const s\d+=region\.staticTargets/.test(stable),
    'a non-volatile read-only static is loaded once at kernel entry');
  t.notOk(/const s\d+=region\.staticTargets/.test(volatile),
    'a volatile static remains a distinct read at each bytecode');
  t.notOk(/const s\d+=region\.staticTargets/.test(written),
    'a static written by the method is never entry-hoisted');
  t.end();
});

test('fused discovery retries linkage misses after class lifecycle advances', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0, fusedRegions: true } });
  const wrapper = fusedShapeMethod('candidate', '()V', '()V', 2);
  const owner = 'DeferredRegionOwner';
  const frame = new Frame(wrapper);
  const callStack = new Stack();
  callStack.push(frame);
  const thread = { status: 'runnable', callStack };
  const site = { op: 'invokestatic', params: [], returnType: 'void' };
  const target = { method: wrapper, lookupClass: owner };
  const fused = jvm.jit.fusedRegions;
  let attempts = 0;
  let executions = 0;
  fused.compile = () => {
    attempts += 1;
    if (attempts === 1) return null;
    return {
      wrapperMethod: wrapper,
      wrapperOwner: owner,
      wrapperKernel: () => { executions += 1; },
    };
  };
  fused.guard = () => true;

  t.notOk(fused.tryInvoke(site, target, frame, thread).matched,
    'an unresolved child is initially left to normal invocation');
  t.notOk(fused.tryInvoke(site, target, frame, thread).matched,
    'the unchanged linkage epoch does not repeatedly rediscover the method');
  t.equal(attempts, 1, 'one discovery attempt is made per linkage epoch');

  jvm.classEpoch += 1;
  const retried = fused.tryInvoke(site, target, frame, thread);
  t.ok(retried.handled, 'loading another class makes the candidate eligible again');
  t.equal(attempts, 2, 'the advanced linkage epoch triggers rediscovery');
  t.equal(executions, 1, 'the newly linked region executes');

  fused.cache.delete(wrapper);
  fused.rejected.set(wrapper,
    `${jvm.classEpoch || 0}:${jvm.classInitializationEpoch || 0}`);
  jvm.classInitializationEpoch += 1;
  const initializedRetry = fused.tryInvoke(site, target, frame, thread);
  t.ok(initializedRetry.handled,
    'finishing class initialization also makes the candidate eligible again');
  t.equal(attempts, 3, 'the initialization epoch triggers rediscovery');
  t.end();
});

test('fused entry guards fall back before consuming operands or side effects', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0, fusedRegions: true } });
  const descriptor = '(IIIIIIII)V';
  const wrapper = fusedShapeMethod('arbitraryWrapper', descriptor, '(IIIIIBII[I)V', 6);
  const owner = 'ArbitraryRendererOwner';
  jvm.classes[owner] = {
    ast: { classes: [{ superClassName: null, items: [{ type: 'method', method: wrapper }] }] },
    staticFields: new Map(),
  };
  const callerMethod = {
    name: 'caller', descriptor: '()V',
    attributes: [{ type: 'code', code: {
      codeItems: [{ labelDef: 'L0:', instruction: 'return' }],
      localsSize: '0', stackSize: '8', exceptionTable: [],
    } }],
  };
  const caller = new Frame(callerMethod);
  const callStack = new Stack();
  callStack.push(caller);
  const thread = { status: 'runnable', callStack };
  caller.stack.items.push(1, 2, 3, 4, 5, 6, 7, 8);
  let sideEffects = 0;
  const codeItems = wrapper.attributes[0].code.codeItems;
  const region = {
    wrapperMethod: wrapper,
    wrapperOwner: owner,
    wrapperKernel: () => { sideEffects += 1; },
    dependencies: [{ owner, method: wrapper, codeItems }],
    staticOwners: [], falseGuardTargets: [],
  };
  jvm.jit.fusedRegions.cache.set(wrapper, region);
  const site = {
    op: 'invokestatic', descriptor,
    params: new Array(8).fill('int'), returnType: 'void',
  };
  const target = { method: wrapper, lookupClass: owner };

  let result = jvm.jit.fusedRegions.tryInvoke(site, target, caller, thread);
  t.notOk(result.handled, 'an uninitialized participant uses the normal path');
  t.equal(sideEffects, 0, 'class initialization guard runs before fused effects');
  t.equal(caller.stack.items.length, 8, 'guarded fallback leaves caller operands intact');

  jvm.classInitializationState.set(owner, 'INITIALIZED');
  jvm.debugManager.enable();
  result = jvm.jit.fusedRegions.tryInvoke(site, target, caller, thread);
  t.notOk(result.handled, 'debug mode uses the normal path');
  t.equal(sideEffects, 0, 'debug guard also precedes fused effects');
  t.equal(caller.stack.items.length, 8, 'debug fallback leaves operands intact');

  jvm.debugManager.disable();
  const originalFindMethod = jvm.findMethod.bind(jvm);
  let linkageLookups = 0;
  jvm.findMethod = (...args) => {
    linkageLookups += 1;
    return originalFindMethod(...args);
  };
  result = jvm.jit.fusedRegions.tryInvoke(site, target, caller, thread);
  t.ok(result.handled, 'the same structurally cached region runs after guards clear');
  t.equal(sideEffects, 1, 'unguarded invocation enters the fused kernel once');
  t.equal(caller.stack.items.length, 0, 'successful fused void call consumes its operands');
  t.equal(linkageLookups, 1, 'the first successful entry verifies dependency linkage');

  caller.stack.items.push(1, 2, 3, 4, 5, 6, 7, 8);
  result = jvm.jit.fusedRegions.tryInvoke(site, target, caller, thread);
  t.ok(result.handled, 'an unchanged lifecycle epoch reuses the linkage proof');
  t.equal(linkageLookups, 1, 'the cached proof skips repeated dependency lookup');

  caller.stack.items.push(1, 2, 3, 4, 5, 6, 7, 8);
  jvm.debugManager.enable();
  result = jvm.jit.fusedRegions.tryInvoke(site, target, caller, thread);
  t.notOk(result.handled, 'live debugger guards still run with cached linkage');
  t.equal(caller.stack.items.length, 8, 'a cached-linkage fallback preserves operands');
  jvm.debugManager.disable();

  wrapper.attributes[0].code.codeItems = codeItems.slice();
  jvm.classEpoch += 1;
  result = jvm.jit.fusedRegions.tryInvoke(site, target, caller, thread);
  t.notOk(result.handled, 'a class lifecycle change revalidates bytecode identity');
  t.equal(linkageLookups, 2, 'the advanced epoch performs dependency lookup again');
  t.equal(sideEffects, 2, 'failed revalidation occurs before fused side effects');
  t.equal(caller.stack.items.length, 8, 'failed revalidation preserves caller operands');
  t.equal(jvm.jit.fusedRunCount, 2, 'successful fused executions are counted');
  t.equal(jvm.jit.fusedGuardedFallbackCount, 4, 'all guarded fallbacks are counted');
  t.end();
});

test('the synchronous interpreter enters verified fused static regions', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0, fusedRegions: true } });
  const descriptor = '(II)V';
  const wrapper = fusedShapeMethod(
    'shapeSelectedWrapper', descriptor, '(I[I)V', 3);
  wrapper.flags = ['static'];
  const owner = 'InterpreterFusedShapeOwner';
  jvm.classes[owner] = {
    ast: { classes: [{
      className: owner,
      superClassName: null,
      items: [{ type: 'method', method: wrapper }],
    }] },
    staticFields: new Map(),
  };
  jvm.classInitializationState.set(owner, 'INITIALIZED');

  const callerMethod = {
    name: 'ordinaryCaller', descriptor: '()V',
    attributes: [{ type: 'code', code: {
      codeItems: [{ labelDef: 'L0:', instruction: 'return' }],
      localsSize: '0', stackSize: '2', exceptionTable: [],
    } }],
  };
  const caller = new Frame(callerMethod);
  caller.className = 'UnrelatedCallerOwner';
  caller.stack.items.push(17, 29);
  const callStack = new Stack();
  callStack.push(caller);
  const thread = { id: 1, status: 'runnable', callStack };

  let received = null;
  const codeItems = wrapper.attributes[0].code.codeItems;
  jvm.jit.fusedRegions.cache.set(wrapper, {
    wrapperMethod: wrapper,
    wrapperOwner: owner,
    wrapperKernel: (_state, _region, _helpers, first, second) => {
      received = [first, second];
    },
    dependencies: [{ owner, method: wrapper, codeItems }],
    staticOwners: [],
    falseGuardTargets: [],
  });

  const instruction = {
    op: 'invokestatic',
    arg: ['Method', owner, [wrapper.name, descriptor]],
  };
  const result = invokeHandlers.invokestaticSync(caller, instruction, jvm, thread);
  t.equal(result, undefined, 'the warm synchronous invoke completes inline');
  t.deepEqual(received, [17, 29], 'the fused kernel receives positional operands');
  t.equal(callStack.size(), 1, 'no wrapper Frame is pushed');
  t.equal(caller.stack.size(), 0, 'successful fused execution consumes operands');
  t.equal(jvm.jit.fusedRunCount, 1, 'interpreter-entered fusion is counted');
  t.end();
});

test('structured SSA feeds scalar operands directly into a verified fused region', (t) => {
  const jvm = new JVM({ jit: {
    warmupThreshold: 0, fusedRegions: true, structuredSsa: true,
  } });
  const callee = {
    name: 'calleeWithNoFixedIdentity', descriptor: '(I)V', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: [{ labelDef: 'L0:', instruction: 'return' }],
      localsSize: '1', stackSize: '0', exceptionTable: [],
    } }],
  };
  const owner = 'DirectFusedShapeOwner';
  jvm.classes[owner] = {
    ast: { classes: [{ superClassName: null, items: [{ type: 'method', method: callee }] }] },
    staticFields: new Map(),
  };
  jvm.classInitializationState.set(owner, 'INITIALIZED');
  const call = { op: 'invokestatic',
    arg: ['Method', owner, [callee.name, callee.descriptor]] };
  const caller = {
    name: 'loopWithNoFixedIdentity', descriptor: '(I)V', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: [
        { instruction: 'iconst_0' },
        { instruction: 'istore_1' },
        { labelDef: 'Lloop:', instruction: 'iload_1' },
        { instruction: 'iconst_1' },
        { instruction: { op: 'if_icmpge', arg: 'Lreturn' } },
        { instruction: 'iload_0' },
        { instruction: call },
        { instruction: { op: 'iinc', varnum: 1, incr: 1 } },
        { instruction: { op: 'goto', arg: 'Lloop' } },
        { labelDef: 'Lreturn:', instruction: 'return' },
      ],
      localsSize: '2', stackSize: '2', exceptionTable: [],
    } }],
  };
  const observed = [];
  const region = {
    wrapperMethod: callee, wrapperOwner: owner,
    wrapperKernel: (_state, _region, _jit, value) => observed.push(value),
    executionState: {}, dependencies: [], staticOwners: [], falseGuardTargets: [],
  };
  jvm.jit.fusedRegions.directEntries[0] = {
    id: 0, paramCount: 1, target: { method: callee, lookupClass: owner }, region,
  };
  jvm.jit.fusedRegions.getCompileTimeDirectCall = () =>
    ({ id: 0, paramCount: 1, returnsVoid: true });
  jvm.jit.fusedRegions.guard = () => true;
  const generated = jvm.jit.structuredSsa.compile(caller);
  t.ok(generated?.jvmStructuredSsa, 'loop caller selects structured SSA');
  t.ok(generated.jvmStructuredSource.includes('tryInvokeDirectAt') &&
      generated.jvmStructuredSource.includes('tryInvokeSyncAt'),
  'scalar direct entry is emitted with the ordinary dispatch fallback retained');
  const frame = new Frame(caller);
  frame.locals[0] = 37;
  const callStack = new Stack();
  callStack.push(frame);
  const thread = { status: 'runnable', callStack };
  generated(frame, thread, jvm.jit, false);
  t.deepEqual(observed, [37], 'the fused kernel receives the SSA operand positionally');
  t.equal(jvm.jit.fusedDirectRunCount, 1, 'direct fused execution is counted');
  t.equal(frame.stack.items.length, 0, 'successful direct entry does not materialize operands');
  t.ok(callStack.isEmpty(), 'normal return removes the structured caller frame');

  let sideEffects = 0;
  region.wrapperKernel = () => { sideEffects += 1; };
  jvm.jit.fusedRegions.guard = () => false;
  const guardedFrame = new Frame(caller);
  const guardedStack = new Stack();
  guardedStack.push(guardedFrame);
  const handled = jvm.jit.fusedRegions.tryInvokeDirectAt(
    0, guardedFrame, { status: 'runnable', callStack: guardedStack }, 91);
  t.notOk(handled, 'a failed entry guard requests the ordinary call path');
  t.equal(sideEffects, 0, 'the direct guard falls back before fused side effects');
  t.end();
});

test('structured fused sites resolve wrapper owners loaded after caller compilation', (t) => {
  const jvm = new JVM({ jit: {
    warmupThreshold: 0, fusedRegions: true, structuredSsa: true,
  } });
  const owner = 'LateLoadedDirectFusedOwner';
  const descriptor = '(I)V';
  const call = {
    op: 'invokestatic',
    arg: ['Method', owner, ['arbitraryMember', descriptor]],
  };
  const site = jvm.jit.fusedRegions.getCompileTimeDirectCall(call);
  t.ok(site, 'a cold wrapper owner retains an unresolved positional site');
  t.equal(jvm.jit.fusedRegions.directEntries[site.id].target, null,
    'caller compilation does not invent a cold method identity');

  const callee = {
    name: 'arbitraryMember', descriptor, flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: [{ labelDef: 'L0:', instruction: 'return' }],
      localsSize: '1', stackSize: '0', exceptionTable: [],
    } }],
  };
  jvm.classes[owner] = {
    ast: { classes: [{
      className: owner, superClassName: null,
      items: [{ type: 'method', method: callee }],
    }] },
    staticFields: new Map(),
  };
  jvm.classInitializationState.set(owner, 'INITIALIZED');
  const observed = [];
  const region = {
    wrapperMethod: callee,
    wrapperOwner: owner,
    wrapperKernel: (_state, _region, _jit, value) => observed.push(value),
    executionState: {},
    dependencies: [],
    staticOwners: [],
    falseGuardTargets: [],
  };
  jvm.jit.fusedRegions.mayFuse = (method) => method === callee;
  jvm.jit.fusedRegions.compile = (method, lookupClass) =>
    method === callee && lookupClass === owner ? region : null;
  jvm.jit.fusedRegions.guard = () => true;

  const caller = new Frame({
    name: 'caller', descriptor: '()V',
    attributes: [{ type: 'code', code: {
      codeItems: [{ labelDef: 'L0:', instruction: 'return' }],
      localsSize: '0', stackSize: '1', exceptionTable: [],
    } }],
  });
  const callStack = new Stack();
  callStack.push(caller);
  const handled = jvm.jit.fusedRegions.tryInvokeDirectAt(
    site.id, caller, { status: 'runnable', callStack }, 73);
  t.ok(handled, 'the same compiled site links after its owner loads');
  t.deepEqual(observed, [73], 'resolved direct site feeds the scalar operand');
  t.equal(jvm.jit.fusedRegions.directEntries[site.id].target.method, callee,
    'runtime linkage retains the exact verified method identity');
  t.equal(jvm.jit.fusedDirectRunCount, 1, 'late-linked direct execution is counted');
  t.end();
});

test('structured callers retain continuations across cold fused void calls', (t) => {
  const jvm = new JVM({ jit: {
    warmupThreshold: 0, fusedRegions: true, structuredSsa: true,
  } });
  const owner = 'ColdContinuationFusedOwner';
  const descriptor = '(I)V';
  const call = {
    op: 'invokestatic',
    arg: ['Method', owner, ['shapeOnlyMember', descriptor]],
  };
  const caller = {
    name: 'callerWithColdVoidSite', descriptor: '(I)I', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: [
        { instruction: 'iload_0' },
        { instruction: call },
        { instruction: 'iconst_0' },
        { instruction: 'istore_1' },
        { labelDef: 'Lloop:', instruction: 'iload_1' },
        { instruction: 'iconst_1' },
        { instruction: { op: 'if_icmpge', arg: 'Lreturn' } },
        { instruction: { op: 'iinc', varnum: 1, incr: 1 } },
        { instruction: { op: 'goto', arg: 'Lloop' } },
        { labelDef: 'Lreturn:', instruction: 'iload_0' },
        { instruction: 'iconst_1' },
        { instruction: 'iadd' },
        { instruction: 'ireturn' },
      ],
      localsSize: '2', stackSize: '2', exceptionTable: [],
    } }],
  };
  jvm.jit.fusedRegions.mayFuse = () => true;
  const generated = jvm.jit.structuredSsa.compile(caller);
  t.ok(generated?.jvmStructuredContinuation,
    'cold-call caller uses a resumable structured body');
  const frame = new Frame(caller);
  frame.locals[0] = 41;
  const callStack = new Stack();
  callStack.push(frame);
  const thread = { status: 'runnable', callStack };

  const first = generated(frame, thread, jvm.jit, false);
  t.ok(first?.deopt && first.transient,
    'cold owner requests the canonical invocation path');
  t.equal(frame.pc, 1, 'cold call operands are materialized at the invoke PC');
  t.ok(generated.jvmHasStructuredContinuation(frame),
    'the post-call scalar continuation is retained');

  frame.pc = 2;
  frame.stack.items.length = 0;
  delete frame.jitSkipOnce;
  const resumed = generated(frame, thread, jvm.jit, false);
  t.equal(resumed.value, 42, 'the exact post-call SSA continuation resumes');
  t.notOk(generated.jvmHasStructuredContinuation(frame),
    'normal return clears the retained continuation');
  t.ok(callStack.isEmpty(), 'resumed return completes the caller frame');
  t.end();
});

test('structured callers retain continuations while a void child is deoptimized', (t) => {
  const jvm = new JVM({ jit: {
    warmupThreshold: 0, fusedRegions: true, structuredSsa: true,
  } });
  const call = {
    op: 'invokestatic',
    arg: ['Method', 'ArbitraryDeoptimizingVoidOwner', ['member', '(I)V']],
  };
  const caller = {
    name: 'callerWithDeoptimizingVoidChild', descriptor: '(I)I', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: [
        { instruction: 'iload_0' },
        { instruction: call },
        { instruction: 'iconst_0' },
        { instruction: 'istore_1' },
        { labelDef: 'LvoidLoop:', instruction: 'iload_1' },
        { instruction: 'iconst_1' },
        { instruction: { op: 'if_icmpge', arg: 'LvoidReturn' } },
        { instruction: { op: 'iinc', varnum: 1, incr: 1 } },
        { instruction: { op: 'goto', arg: 'LvoidLoop' } },
        { labelDef: 'LvoidReturn:', instruction: 'iload_0' },
        { instruction: 'iconst_1' },
        { instruction: 'iadd' },
        { instruction: 'ireturn' },
      ],
      localsSize: '2', stackSize: '2', exceptionTable: [],
    } }],
  };
  jvm.jit.fusedRegions.getCompileTimeDirectCall = () => ({
    id: 0, paramCount: 1, returnsVoid: true,
  });
  jvm.jit.fusedRegions.tryInvokeDirectAt = () => false;
  const activeChild = new Frame(caller);
  jvm.jit.tryInvokeSyncAt = (_id, frame, currentThread) => {
    frame.stack.items.length = 0;
    activeChild.jitGeneratedReturnParent = frame;
    currentThread.callStack.push(activeChild);
    return { deopt: true, transient: true, reason: 'deoptimized void child' };
  };
  const generated = jvm.jit.structuredSsa.compile(caller);
  t.ok(generated?.jvmStructuredContinuation,
    'the caller uses a resumable structured body');
  const frame = new Frame(caller);
  frame.locals[0] = 41;
  const callStack = new Stack();
  callStack.push(frame);
  const thread = { status: 'runnable', callStack };

  const first = generated(frame, thread, jvm.jit, false);
  t.equal(first?.reason, 'deoptimized void child',
    'the exact child deoptimization is propagated');
  t.equal(frame.pc, 2, 'the completed void invoke records its post-call PC');
  t.ok(generated.jvmHasStructuredContinuation(frame),
    'the caller retains its scalar post-call continuation');
  t.equal(activeChild.jitGeneratedReturnParent, frame,
    'the deoptimized void child records its exact structured caller');
  t.equal(activeChild.jitGeneratedReturnType, 'void',
    'the deoptimized void child records its descriptor return type');

  t.equal(callStack.pop(), activeChild,
    'the scheduler-visible void child completes before its caller resumes');
  const resumed = generated(frame, thread, jvm.jit, false);
  t.equal(resumed.value, 42, 'execution resumes after the void child');
  t.notOk(generated.jvmHasStructuredContinuation(frame),
    'normal return clears the continuation');
  t.end();
});

test('structured callers feed a deoptimized non-void child return into SSA', (t) => {
  const jvm = new JVM({ jit: {
    warmupThreshold: 0, structuredSsa: true,
  } });
  const call = {
    op: 'invokestatic',
    arg: ['Method', 'ArbitraryDeoptimizingValueOwner', ['member', '(I)I']],
  };
  const caller = {
    name: 'callerWithDeoptimizingValueChild', descriptor: '(I)I', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: [
        { instruction: 'iload_0' },
        { instruction: call },
        { instruction: 'istore_1' },
        { instruction: 'iconst_0' },
        { instruction: 'istore_2' },
        { labelDef: 'LvalueLoop:', instruction: 'iload_2' },
        { instruction: 'iconst_1' },
        { instruction: { op: 'if_icmpge', arg: 'LvalueReturn' } },
        { instruction: { op: 'iinc', varnum: 2, incr: 1 } },
        { instruction: { op: 'goto', arg: 'LvalueLoop' } },
        { labelDef: 'LvalueReturn:', instruction: 'iload_1' },
        { instruction: 'iconst_1' },
        { instruction: 'iadd' },
        { instruction: 'ireturn' },
      ],
      localsSize: '3', stackSize: '2', exceptionTable: [],
    } }],
  };
  const activeChild = new Frame(caller);
  jvm.jit.tryInvokeSyncAt = (_id, frame, currentThread) => {
    frame.stack.items.length = 0;
    currentThread.callStack.push(activeChild);
    return { deopt: true, transient: true, reason: 'deoptimized value child' };
  };
  const generated = jvm.jit.structuredSsa.compile(caller);
  t.ok(generated?.jvmStructuredContinuation,
    'the non-void caller uses a resumable structured body');
  const frame = new Frame(caller);
  frame.locals[0] = 41;
  const callStack = new Stack();
  callStack.push(frame);
  const thread = { status: 'runnable', callStack };

  const first = generated(frame, thread, jvm.jit, false);
  t.equal(first?.reason, 'deoptimized value child',
    'the exact non-void child deoptimization is propagated');
  t.equal(frame.pc, 2, 'the suspended caller records its post-call PC');
  t.ok(generated.jvmHasStructuredContinuation(frame),
    'the caller retains the lexical result slot and post-call state');
  t.equal(activeChild.jitGeneratedReturnParent, frame,
    'the scheduler-visible child is linked to the omitted caller');
  t.equal(activeChild.jitGeneratedReturnType, 'int',
    'the child records the expected primitive return type');

  t.equal(callStack.pop(), activeChild,
    'the scheduler-visible child completes before its caller resumes');
  frame.stack.push(82);
  const resumed = generated(frame, thread, jvm.jit, false);
  t.equal(resumed.value, 83,
    'the canonical child result is consumed by the retained SSA expression');
  t.notOk(generated.jvmHasStructuredContinuation(frame),
    'normal return clears the non-void continuation');
  t.ok(callStack.isEmpty(), 'resumed return completes the caller frame');
  t.end();
});

test('frameless structured call exceptions retain invoke operands without a child', (t) => {
  const jvm = new JVM({ jit: {
    warmupThreshold: 0, structuredSsa: true,
  } });
  const caller = {
    name: 'framelessThrowingCaller', descriptor: '(I)I', flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: [
        { labelDef: 'Lloop:', instruction: 'iload_0' },
        { instruction: {
          op: 'invokestatic',
          arg: ['Method', 'ArbitraryThrowingOwner', ['value', '(I)I']],
        } },
        { instruction: 'istore_1' },
        { instruction: { op: 'iinc', varnum: 0, incr: -1 } },
        { instruction: 'iload_0' },
        { instruction: { op: 'ifgt', arg: 'Lloop' } },
        { instruction: 'iload_1' },
        { instruction: 'ireturn' },
      ],
      localsSize: '2', stackSize: '1', exceptionTable: [],
    } }],
  };
  const generated = jvm.jit.structuredSsa.compile(caller);
  t.ok(generated?.jvmStructuredContinuation,
    'the call-bearing loop uses a structured continuation');

  const frame = new Frame(caller);
  frame.className = 'ArbitraryFramelessCaller';
  frame.locals[0] = 7;
  const outer = new Frame(caller);
  outer.className = 'ArbitraryOuterCaller';
  const callStack = new Stack();
  callStack.push(outer);
  const thread = { status: 'runnable', callStack };
  const thrown = new Error('arbitrary positional call failure');
  const originalInvoke = jvm.jit.tryInvokeSyncAt;
  jvm.jit.tryInvokeSyncAt = () => { throw thrown; };
  t.teardown(() => { jvm.jit.tryInvokeSyncAt = originalInvoke; });

  let observed;
  try {
    generated(frame, thread, jvm.jit, false, true);
  } catch (error) {
    observed = error;
  }
  t.equal(observed, thrown, 'the original host failure is rethrown');
  t.equal(frame.pc, 1, 'the omitted caller is restored at the invoke PC');
  t.deepEqual(frame.stack.items, [7],
    'the invoke operand is retained when no child Frame was installed');
  t.deepEqual(callStack.items, [outer],
    'an unrelated outer Frame is not mistaken for an active child');

  frame.pc = 0;
  frame.stack.clear();
  frame.locals[0] = 7;
  delete frame.jitSkipOnce;
  const rejected = {
    deopt: true, transient: true, reason: 'arbitrary admission rejection',
  };
  jvm.jit.tryInvokeSyncAt = () => rejected;
  const deoptimized = generated(frame, thread, jvm.jit, false, true);
  t.equal(deoptimized, rejected,
    'the original admission deoptimization is propagated');
  t.equal(frame.pc, 1,
    'a deoptimization without a child retries the invoke bytecode');
  t.deepEqual(frame.stack.items, [7],
    'a deoptimization without a child retains the call operands');
  t.notOk(generated.jvmHasStructuredContinuation(frame),
    'an unconsumed call does not retain a post-invoke continuation');
  t.end();
});

test('fused exceptions restore omitted wrapper and raster frames', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0, fusedRegions: true } });
  const descriptor = '(IIIIIIII)V';
  const wrapper = fusedShapeMethod('wrapperWithNoFixedName', descriptor, '(IIIIIBII[I)V', 6);
  const raster = fusedShapeMethod('rasterWithNoFixedName', '(IIIIIBII[I)V', '(IB[III)V', 6,
    { integerNative: true });
  const owner = 'RestoredWrapperOwner';
  const rasterOwner = 'RestoredRasterOwner';
  jvm.classes[owner] = {
    ast: { classes: [{ superClassName: null, items: [{ type: 'method', method: wrapper }] }] },
    staticFields: new Map(),
  };
  jvm.classInitializationState.set(owner, 'INITIALIZED');
  const callerMethod = {
    name: 'caller', descriptor: '()V',
    attributes: [{ type: 'code', code: {
      codeItems: [{ labelDef: 'L0:', instruction: 'return' }],
      localsSize: '0', stackSize: '8', exceptionTable: [],
    } }],
  };
  const caller = new Frame(callerMethod);
  caller.stack.items.push(1, 2, 3, 4, 5, 6, 7, 8);
  const callStack = new Stack();
  callStack.push(caller);
  const thread = { status: 'runnable', callStack };
  const thrown = { type: 'java/lang/ArrayIndexOutOfBoundsException', message: null };
  const region = {
    wrapperMethod: wrapper, wrapperOwner: owner,
    rasterMethod: raster, rasterOwner,
    dependencies: [{
      owner, method: wrapper, codeItems: wrapper.attributes[0].code.codeItems,
    }],
    staticOwners: [], falseGuardTargets: [],
    wrapperKernel: (state) => {
      state.outerPc = 12;
      state.outerExtra = 9;
      state.method = 'raster';
      state.pc = 37;
      state.locals = [4, 5, 6];
      state.stack = [null, 99];
      throw thrown;
    },
  };
  jvm.jit.fusedRegions.cache.set(wrapper, region);
  const site = { op: 'invokestatic', descriptor,
    params: new Array(8).fill('int'), returnType: 'void' };
  const target = { method: wrapper, lookupClass: owner };
  let observed;
  try {
    jvm.jit.fusedRegions.tryInvoke(site, target, caller, thread);
  } catch (error) {
    observed = error;
  }
  t.equal(observed, thrown, 'the original JVM exception is rethrown');
  t.equal(callStack.size(), 3, 'caller plus both omitted frames are present');
  t.equal(callStack.items[1].method, wrapper, 'wrapper is restored outside the raster');
  t.equal(callStack.peek().method, raster, 'throwing raster is the innermost frame');
  t.equal(callStack.peek().pc, 37, 'throwing bytecode PC is restored exactly');
  t.deepEqual(callStack.peek().stack.items, [null, 99], 'throwing operands are restored');
  t.equal(jvm.jit.fusedRestoredExceptionFrameCount, 2, 'restored frames are counted');

  const directCaller = new Frame(callerMethod);
  const directCallStack = new Stack();
  directCallStack.push(directCaller);
  const directThread = { status: 'runnable', callStack: directCallStack };
  jvm.jit.fusedRegions.directEntries[0] = {
    id: 0, paramCount: 8, target, region,
  };
  const directArguments = [11, 12, 13, 14, 15, 16, 17, 18];
  observed = null;
  try {
    jvm.jit.fusedRegions.tryInvokeDirectAt(
      0, directCaller, directThread, ...directArguments);
  } catch (error) {
    observed = error;
  }
  t.equal(observed, thrown, 'the scalar direct entry rethrows the original JVM exception');
  t.equal(directCallStack.size(), 3,
    'the scalar direct entry restores both omitted frames');
  t.deepEqual(directCallStack.items[1].locals.slice(0, 8), directArguments,
    'restored wrapper locals contain the positional caller operands');
  t.equal(jvm.jit.fusedRestoredExceptionFrameCount, 4,
    'direct-entry restored frames use the same accounting');
  t.end();
});

test('JIT produces same PyramidApplet mock drawing operations as interpreter', async (t) => {
  const interpreted = await createPyramidHarness({ enabled: false });
  const jitted = await createPyramidHarness({ warmupThreshold: 0 });

  const interpretedGraphics = { type: 'java/awt/Graphics', _awtGraphics: new awt.MockGraphics() };
  const jittedGraphics = { type: 'java/awt/Graphics', _awtGraphics: new awt.MockGraphics() };

  await invoke(
    interpreted.jvm,
    interpreted.thread,
    'PyramidApplet',
    'paint',
    '(Ljava/awt/Graphics;)V',
    [interpreted.applet, interpretedGraphics],
  );
  await invoke(
    jitted.jvm,
    jitted.thread,
    'PyramidApplet',
    'paint',
    '(Ljava/awt/Graphics;)V',
    [jitted.applet, jittedGraphics],
  );

  t.deepEqual(
    jittedGraphics._awtGraphics.operations,
    interpretedGraphics._awtGraphics.operations,
    'JIT and interpreter should emit identical mock graphics operations',
  );
  t.end();
});

test('JIT bytecode safe point deopts at breakpoint with materialized frame state', async (t) => {
  const jvm = new JVM({ classpath: 'sources', jit: { warmupThreshold: 0 } });
  await jvm.loadClassByName('PyramidApplet');
  const method = await jvm.findMethodInHierarchy('PyramidApplet', 'dot', '([D[D)D');
  const frame = new Frame(method);
  frame.className = 'PyramidApplet';
  frame.locals[1] = [1, 2, 3];
  frame.locals[2] = [4, 5, 6];

  const thread = {
    id: 0,
    name: 'jit-breakpoint-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  thread.callStack.push(frame);
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  jvm.debugManager.addBreakpoint(3);

  await jvm.executeTick();

  t.equal(frame.pc, 3, 'JIT should materialize the frame at the breakpoint PC');
  t.deepEqual(frame.stack.items, [1], 'JIT should preserve operand stack at deopt point');
  t.deepEqual(frame.locals.slice(1, 3), [[1, 2, 3], [4, 5, 6]], 'JIT should preserve locals at deopt point');
  t.end();
});

test('generated JIT runs numeric hotpaths', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedNumericHarness', `
public class GeneratedNumericHarness {
  public static void compute(int[] out, int a, int b) {
    out[0] = a * b + 3;
    double x = (double) out[0] / 2.0;
    out[1] = (int) x;
  }
}
`);

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 0 } });
  await jvm.loadClassByName('GeneratedNumericHarness');
  const thread = {
    id: 0,
    name: 'generated-numeric-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;

  const out = [0, 0];
  out.type = '[I';
  out.length = 2;
  out.hashCode = jvm.nextHashCode++;

  await invoke(jvm, thread, 'GeneratedNumericHarness', 'compute', '([III)V', [out, 4, 5]);

  t.deepEqual(out.slice(0, 2), [23, 11], 'generated JIT should preserve numeric results');
  t.ok(jvm.jit.generatedRunCount > 0, 'numeric method should run through generated code');
  t.equal(jvm.jit.runnerRunCount, 0, 'numeric method should not need bytecode-runner fallback');
  t.end();
});

test('whole-method preference admits the complete JavaScript capability set', (t) => {
  const method = {
    name: 'arbitraryUnsignedShift', descriptor: '(I)I',
    flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: [
        { labelDef: 'L0:', instruction: 'iload_0' },
        { labelDef: 'L1:', instruction: 'iconst_1' },
        { labelDef: 'L2:', instruction: 'iushr' },
        { labelDef: 'L3:', instruction: 'ireturn' },
      ],
      localsSize: '1', stackSize: '2', exceptionTable: [],
    } }],
  };
  const jvm = new JVM({ jit: {
    warmupThreshold: 0,
    preferWholeMethodJs: true,
  } });
  t.notOk(jvm.jit.isSupported(method),
    'the legacy runner capability set rejects the branch shape');
  t.ok(jvm.jit.isCodegenSupported(method),
    'the complete JavaScript generator supports the method');

  const parentMethod = {
    name: 'parent', descriptor: '()V',
    attributes: [{ type: 'code', code: {
      codeItems: [{ labelDef: 'L0:', instruction: 'return' }],
      localsSize: '0', stackSize: '1', exceptionTable: [],
    } }],
  };
  const parent = new Frame(parentMethod);
  const child = new Frame(method);
  child.className = 'ArbitraryWholeMethodOwner';
  child.locals[0] = -2;
  const callStack = new Stack();
  callStack.push(parent);
  callStack.push(child);
  const thread = { status: 'runnable', callStack };
  const result = jvm.jit.tryRunFrame(child, thread);
  t.ok(result.handled, 'whole-method JavaScript executes the broader shape');
  t.equal(parent.stack.pop(), 0x7fffffff,
    'generated result preserves unsigned-shift semantics');
  t.equal(jvm.jit.generatedRunCount, 1,
    'execution is attributed to generated JavaScript');

  jvm.classes.ArbitraryWholeMethodOwner = {
    ast: { classes: [{ superClassName: null, items: [
      { type: 'method', method },
    ] }] },
    staticFields: new Map(),
  };
  jvm.classInitializationState.set('ArbitraryWholeMethodOwner', 'INITIALIZED');
  const nestedParent = new Frame(parentMethod);
  nestedParent.stack.push(-4);
  const nestedStack = new Stack();
  nestedStack.push(nestedParent);
  const nestedThread = { status: 'runnable', callStack: nestedStack };
  const site = jvm.jit.registerSyncCallSite('invokestatic', {
    arg: ['Method', 'ArbitraryWholeMethodOwner',
      ['arbitraryUnsignedShift', '(I)I']],
  });
  const nestedResult = jvm.jit.tryInvokeSyncAt(site, nestedParent, nestedThread);
  t.equal(nestedResult, 0x7ffffffe,
    'generated caller directly enters the broader whole-method callee');
  t.equal(nestedThread.callStack.peek(), nestedParent,
    'nested whole-method call completes without a scheduler-visible child frame');
  const cachedTarget = jvm.jit.syncCallSites[site].fastStaticTarget;
  t.ok(cachedTarget?.inlineIntegerRegion ||
    cachedTarget?.generated?.jvmSynchronous,
  'the resolved call site caches a synchronous whole-method target');
  t.end();
});

test('generated JIT resolves inherited instance fields from subclass references', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedInheritedFieldHarness', `
class GeneratedInheritedFieldBase {
  int cursor;
}
public class GeneratedInheritedFieldHarness extends GeneratedInheritedFieldBase {
  int output;
  public void sync() {
    output = 8 * cursor;
  }
}
`);

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 0 } });
  await jvm.loadClassByName('GeneratedInheritedFieldHarness');
  await jvm.loadClassByName('GeneratedInheritedFieldBase');
  const thread = {
    id: 0,
    name: 'generated-inherited-field-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const object = {
    type: 'GeneratedInheritedFieldHarness',
    _className: 'GeneratedInheritedFieldHarness',
    fields: {
      'GeneratedInheritedFieldBase.cursor': 7,
      'GeneratedInheritedFieldHarness.output': 0,
    },
  };

  await invoke(jvm, thread, 'GeneratedInheritedFieldHarness', 'sync', '()V', [object]);

  t.equal(object.fields['GeneratedInheritedFieldHarness.output'], 56,
    'subclass-owned getfield resolves the inherited storage slot');
  t.ok(jvm.jit.generatedRunCount > 0, 'method runs through generated code');
  t.end();
});

test('generated JIT falls back when Function codegen is unavailable', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedFallbackHarness', `
public class GeneratedFallbackHarness {
  public static void compute(int[] out, int a) {
    double x = (double) a + 2.0;
    out[0] = (int) x;
  }
}
`);

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 0 } });
  jvm.jit.codegenUnavailable = true;
  await jvm.loadClassByName('GeneratedFallbackHarness');
  const thread = {
    id: 0,
    name: 'generated-fallback-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;

  const out = [0];
  out.type = '[I';
  out.length = 1;
  out.hashCode = jvm.nextHashCode++;

  await invoke(jvm, thread, 'GeneratedFallbackHarness', 'compute', '([II)V', [out, 6]);

  t.deepEqual(out.slice(0, 1), [8], 'runner fallback should preserve behavior');
  t.equal(jvm.jit.generatedRunCount, 0, 'generated code should not run when unavailable');
  t.ok(jvm.jit.runnerRunCount > 0, 'bytecode runner should handle the fallback');
  t.end();
});

test('generated JIT accelerates integer bitwise loops on their first invocation', async (t) => {
  const classpath = compileJavaFixture(t, 'IntegerLoopJitHarness', `
public class IntegerLoopJitHarness {
  public static void compute(int[] out, int n) {
    for (int i = 0; i < n; i++) {
      out[i] = -((i ^ -1) >> 1);
    }
  }
}
`);

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 0 } });
  await jvm.loadClassByName('IntegerLoopJitHarness');
  const thread = {
    id: 0,
    name: 'integer-loop-jit-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;

  const out = [0, 0, 0, 0];
  out.type = '[I';
  out.length = 4;
  out.hashCode = jvm.nextHashCode++;
  await invoke(jvm, thread, 'IntegerLoopJitHarness', 'compute', '([II)V', [out, 4]);

  t.deepEqual(out.slice(0, 4), [1, 1, 2, 2], 'integer bitwise loop preserves interpreter semantics');
  t.equal(jvm.jit.generatedRunCount, 1, 'backward bitwise loop compiles without warmup calls');
  t.equal(jvm.jit.runnerRunCount, 0, 'generated bitwise loop bypasses the bytecode runner');
  t.end();
});

test('generated JIT expands wide local increments before eligibility checks', async (t) => {
  const classpath = compileJavaFixture(t, 'WideIncrementJitHarness', `
public class WideIncrementJitHarness {
  public static void compute(int[] out) {
    int value = 0;
    for (int i = 0; i < out.length; i++) {
      value += 3171;
      out[i] = value;
    }
  }
}
`);

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 0 } });
  await jvm.loadClassByName('WideIncrementJitHarness');
  const thread = {
    id: 0,
    name: 'wide-increment-jit-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;

  const out = [0, 0, 0, 0];
  out.type = '[I';
  await invoke(jvm, thread, 'WideIncrementJitHarness', 'compute', '([I)V', [out]);

  t.deepEqual(out.slice(), [3171, 6342, 9513, 12684],
    'wide iinc preserves Java integer loop results');
  t.equal(jvm.jit.generatedRunCount, 1,
    'wide iinc loop executes through generated code');
  t.equal(jvm.jit.runnerRunCount, 0,
    'wide iinc loop does not fall back to the bytecode runner');
  t.end();
});

test('generated callers dispatch supported child methods through generated code', async (t) => {
  const classpath = compileJavaFixture(t, 'NestedGeneratedJitHarness', `
public class NestedGeneratedJitHarness {
  private static int scale(int value) { return value * 3; }
  public static void compute(int[] out) {
    for (int i = 0; i < out.length; i++) out[i] = scale(i);
  }
}
`);
  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName('NestedGeneratedJitHarness');
  const thread = {
    id: 0,
    name: 'nested-generated-jit-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [0, 0, 0, 0];
  await invoke(jvm, thread, 'NestedGeneratedJitHarness', 'compute', '([I)V', [out]);
  t.deepEqual(out, [0, 3, 6, 9], 'nested generated calls preserve results');
  t.equal(jvm.jit.generatedRunCount, 2,
    'caller and first helper cross the initial class-initialization boundary');
  t.equal(jvm.jit.syncGeneratedRunCount, 2,
    'generated caller and helper complete synchronously without Promise handoffs');
  t.equal(jvm.jit.syncInlinedCallCount, 3,
    'remaining integer leaf calls execute inline without child frames');
  t.equal(jvm.jit.runnerRunCount, 0, 'nested generated calls avoid the bytecode runner');
  t.end();
});

test('execute keeps synchronous generated entries off the async tick path', async (t) => {
  const classpath = compileJavaFixture(t, 'SynchronousExecuteHarness', `
public class SynchronousExecuteHarness {
  public static void compute(int[] out) {
    int value = 0;
    for (int i = 0; i < 100; i++) value += i;
    out[0] = value;
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    preferWholeMethodJs: true,
    profileMethods: false,
  } });
  await jvm.loadClassByName('SynchronousExecuteHarness');
  jvm.classInitializationState.set(
    'SynchronousExecuteHarness', 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    'SynchronousExecuteHarness', 'compute', '([I)V');
  const out = [0];
  out.type = '[I';
  const frame = new Frame(method);
  frame.className = 'SynchronousExecuteHarness';
  frame.locals[0] = out;
  const thread = {
    id: 0,
    name: 'synchronous-execute-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  thread.callStack.push(frame);
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;

  const executeTick = jvm.executeTick.bind(jvm);
  let asyncEntriesWithGuestFrame = 0;
  jvm.executeTick = (...args) => {
    const scheduled = args[1];
    if (scheduled && scheduled.callStack &&
        !scheduled.callStack.isEmpty()) {
      asyncEntriesWithGuestFrame += 1;
    }
    return executeTick(...args);
  };

  const result = await jvm.execute();
  t.equal(out[0], 4950, 'generated execution preserves the loop result');
  t.ok(result.completed, 'the scheduler completes normally');
  t.equal(asyncEntriesWithGuestFrame, 0,
    'execute does not wrap a synchronous generated entry in executeTick');

  const secondFrame = new Frame(method);
  secondFrame.className = 'SynchronousExecuteHarness';
  secondFrame.locals[0] = out;
  const secondThread = {
    id: 1,
    name: 'stable-synchronous-execute-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  secondThread.callStack.push(secondFrame);
  jvm.threads = [secondThread];
  jvm.currentThreadIndex = 0;
  out[0] = 0;
  const secondResult = await jvm.execute();
  t.equal(out[0], 4950,
    'the stable generated entry preserves a later invocation');
  t.ok(secondResult.completed,
    'the stable entry completes through the normal scheduler protocol');
  t.ok(jvm.jit.stableGeneratedEntryRunCount > 0,
    'a warmed method bypasses repeated tier-admission work');

  const stableRuns = jvm.jit.stableGeneratedEntryRunCount;
  let wasmEntries = 0;
  jvm.jit.wasmJit.enabled = true;
  jvm.jit.wasmJit.state.set(method, {
    status: 'ready', meta: { fullyCompiled: true },
  });
  const linkedInvoke = () => undefined;
  const linkedSite = {
    op: 'invokestatic', descriptor: '([I)V',
    params: ['int[]'], returnType: 'void',
    fastPositional: { invoke: linkedInvoke },
  };
  const linkedTarget = {
    method, lookupClass: 'SynchronousExecuteHarness',
    generated: jvm.jit.getGeneratedFunction(method),
    positionalInvoker: linkedInvoke,
  };
  jvm.jit.trackGeneratedTarget(method, linkedTarget, linkedSite);
  let wasmGraphInvalidations = 0;
  const markGeneratedTargetUpgrade = jvm.jit.hotCallGraphRegions
    .markGeneratedTargetUpgrade.bind(jvm.jit.hotCallGraphRegions);
  jvm.jit.hotCallGraphRegions.markGeneratedTargetUpgrade = (candidate) => {
    if (candidate === method) wasmGraphInvalidations += 1;
    return markGeneratedTargetUpgrade(candidate);
  };
  jvm.jit.publishWasmTargetReady(method);
  t.equal(wasmGraphInvalidations, 1,
    'Wasm promotion invalidates fused graphs that captured the JavaScript child');
  t.equal(linkedSite.fastPositional, null,
    'a complete Wasm child withdraws an existing direct JavaScript edge');
  t.equal(jvm.jit.getPositionalGeneratedInvoker(linkedSite, linkedTarget), null,
    'new callers retain the canonical child Frame for Wasm tier selection');
  jvm.jit.wasmJit.tryRunFrame = (candidateFrame, candidateThread) => {
    wasmEntries += 1;
    out[0] = 777;
    candidateThread.callStack.pop();
    return { handled: true, returned: true };
  };
  const promotedFrame = new Frame(method);
  promotedFrame.className = 'SynchronousExecuteHarness';
  promotedFrame.locals[0] = out;
  const promotedThread = {
    id: 2,
    name: 'wasm-promoted-execute-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  promotedThread.callStack.push(promotedFrame);
  jvm.threads = [promotedThread];
  jvm.currentThreadIndex = 0;
  out[0] = 0;
  const promotedResult = await jvm.execute();
  t.equal(out[0], 777,
    'a fully compiled Wasm body supersedes the warmed JavaScript entry');
  t.equal(wasmEntries, 1,
    'the ready Wasm gate receives the promoted frame exactly once');
  t.equal(jvm.jit.stableGeneratedEntryRunCount, stableRuns,
    'promotion does not re-enter the stale stable JavaScript body');
  t.ok(promotedResult.completed,
    'the promoted frame completes through the normal scheduler protocol');

  jvm.jit.wasmJit.state.set(method, {
    status: 'ready', meta: { fullyCompiled: true },
    runs: 100, exits: 25, fuelExits: 0,
  });
  t.ok(jvm.jit.hasWasmExitStorm(method),
    'the generic exit-storm gate also covers partial Wasm priority');
  t.equal(typeof jvm.jit.getPositionalGeneratedInvoker(
    linkedSite, linkedTarget), 'function',
  'an exit-storm child can republish its complete JavaScript edge');
  const stormFrame = new Frame(method);
  stormFrame.className = 'SynchronousExecuteHarness';
  stormFrame.locals[0] = out;
  const stormThread = {
    id: 3,
    name: 'wasm-exit-storm-execute-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  stormThread.callStack.push(stormFrame);
  jvm.threads = [stormThread];
  jvm.currentThreadIndex = 0;
  out[0] = 0;
  const stormResult = await jvm.execute();
  t.equal(out[0], 4950,
    'a repeatedly exiting Wasm body yields ownership to complete JavaScript');
  t.equal(wasmEntries, 1,
    'the proven exit storm does not enter Wasm again');
  t.ok(jvm.jit.stableGeneratedEntryRunCount > stableRuns,
    'the stable generated entry receives the pathological Wasm method');
  t.ok(stormResult.completed,
    'the JavaScript takeover completes through normal scheduling');
  t.end();
});

test('generated JIT emits verified integer leaves directly into callers', async (t) => {
  const classpath = compileJavaFixture(t, 'DirectIntegerInlineHarness', `
class DirectIntegerLeafTarget {
  static int transform(int value) {
    return ((value + 7) * 3) ^ (value >>> 5);
  }
  static int guarded(int value) {
    if ((value & 63) == 63) return "abc".length() + value;
    return value * 3;
  }
  static int scopedGuarded(int value) {
    int selected = value;
    if ((value & 1) != 0) selected = (value + 5) * 3;
    if ((selected & 63) == 63) return "abc".length() + selected;
    return selected * 7;
  }
}
public class DirectIntegerInlineHarness {
  public static void compute(int[] out) {
    int value = 1;
    for (int i = 0; i < 100; i++) {
      value = DirectIntegerLeafTarget.transform(value + i);
    }
    out[0] = value;
  }
  public static void computeGuarded(int[] out) {
    int sum = 0;
    for (int i = 0; i < 128; i++) sum += DirectIntegerLeafTarget.guarded(i);
    out[0] = sum;
  }
  public static void computeScopedGuarded(int[] out) {
    int sum = 0;
    for (int i = 0; i < 128; i++) {
      sum += DirectIntegerLeafTarget.scopedGuarded(i);
    }
    out[0] = sum;
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0, preferWholeMethodJs: true, profileMethods: false,
    structuredSsa: false,
  } });
  for (const className of ['DirectIntegerInlineHarness', 'DirectIntegerLeafTarget']) {
    await jvm.loadClassByName(className);
    jvm.classInitializationState.set(className, 'INITIALIZED');
  }
  const thread = {
    id: 0,
    name: 'direct-integer-inline-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [0];
  out.type = '[I';

  const ticks = await invoke(jvm, thread, 'DirectIntegerInlineHarness',
    'compute', '([I)V', [out]);
  let expected = 1;
  for (let i = 0; i < 100; i++) {
    const input = (expected + i) | 0;
    expected = (Math.imul((input + 7) | 0, 3) ^ (input >>> 5)) | 0;
  }
  t.equal(out[0], expected, 'directly emitted expression preserves Java integer semantics');
  t.equal(ticks, 1, 'caller and leaves finish in one generated scheduler tick');

  const method = await jvm.findMethodInHierarchy(
    'DirectIntegerInlineHarness', 'compute', '([I)V');
  const generated = jvm.jit.codegenCache.get(method);
  t.equal(generated.jvmDirectInlineCount, 1,
    'generated source contains one structural direct-inline site');
  t.equal(jvm.jit.syncCallSites.filter(Boolean).length, 0,
    'direct inline creates no runtime dispatch call site');

  const guardedOut = [0];
  guardedOut.type = '[I';
  await invoke(jvm, thread, 'DirectIntegerInlineHarness',
    'computeGuarded', '([I)V', [guardedOut]);
  let guardedExpected = 0;
  for (let i = 0; i < 128; i++) {
    guardedExpected = (guardedExpected +
      ((i & 63) === 63 ? i + 3 : Math.imul(i, 3))) | 0;
  }
  t.equal(guardedOut[0], guardedExpected,
    'failed direct-inline guards resume the canonical helper at the invoke');

  const scopedGuardedOut = [0];
  scopedGuardedOut.type = '[I';
  await invoke(jvm, thread, 'DirectIntegerInlineHarness',
    'computeScopedGuarded', '([I)V', [scopedGuardedOut]);
  let scopedGuardedExpected = 0;
  for (let i = 0; i < 128; i++) {
    const selected = (i & 1) !== 0 ? Math.imul((i + 5) | 0, 3) : i;
    const value = (selected & 63) === 63
      ? (selected + 3) | 0 : Math.imul(selected, 7);
    scopedGuardedExpected = (scopedGuardedExpected + value) | 0;
  }
  t.equal(scopedGuardedOut[0], scopedGuardedExpected,
    'branch-local inline values remain available to later guards and results');

  const structuredJvm = new JVM({ classpath, jit: {
    warmupThreshold: 0, preferWholeMethodJs: true, profileMethods: false,
    structuredSsa: true,
  } });
  for (const className of ['DirectIntegerInlineHarness', 'DirectIntegerLeafTarget']) {
    await structuredJvm.loadClassByName(className);
    structuredJvm.classInitializationState.set(className, 'INITIALIZED');
  }
  const structuredThread = {
    id: 0,
    name: 'structured-direct-integer-inline-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  structuredJvm.threads = [structuredThread];
  structuredJvm.currentThreadIndex = 0;
  const structuredOut = [0];
  structuredOut.type = '[I';
  await invoke(structuredJvm, structuredThread, 'DirectIntegerInlineHarness',
    'computeScopedGuarded', '([I)V', [structuredOut]);
  t.equal(structuredOut[0], scopedGuardedExpected,
    'structured callers evaluate inline temporaries before dependent guards');
  const structuredMethod = await structuredJvm.findMethodInHierarchy(
    'DirectIntegerInlineHarness', 'computeScopedGuarded', '([I)V');
  const structuredGenerated = structuredJvm.jit.codegenCache.get(
    structuredMethod);
  const optionalSsaSources = Object.entries(structuredGenerated || {})
    .filter(([name, source]) => name.endsWith('Source') &&
      name !== 'jvmStructuredSource' && typeof source === 'string' &&
      source.includes('ssa'));
  t.ok(optionalSsaSources.length > 0,
    'the fixture emits at least one optional positional SSA source');
  t.deepEqual(optionalSsaSources.flatMap(([name, source]) =>
    structuredRendererTest.unboundGeneratedSsaIdentifiers(source)
      .map((identifier) => `${name}:${identifier}`)), [],
  'every installed optional positional source passes the final AST scope audit');

  jvm.debugManager.addBreakpoint(0, { className: 'DirectIntegerLeafTarget' });
  const debugOut = [0];
  debugOut.type = '[I';
  const debugFrame = new Frame(method);
  debugFrame.className = 'DirectIntegerInlineHarness';
  debugFrame.locals[0] = debugOut;
  thread.callStack.push(debugFrame);
  const result = generated(debugFrame, thread, jvm.jit);
  t.equal(result.reason, generated.jvmScalarLoop
    ? 'scalar loop debug entry' : 'debuggable direct integer inline',
  'callee breakpoint deoptimizes before executing the omitted call');
  const invokeIndex = debugFrame.instructions.findIndex((item) =>
    item.instruction && item.instruction.op === 'invokestatic');
  t.equal(debugFrame.pc, generated.jvmScalarLoop ? 0 : invokeIndex,
    'debug deoptimization restores the earliest unexecuted bytecode PC');
  thread.callStack.pop();

  const coldJvm = new JVM({ classpath, jit: {
    warmupThreshold: 0, preferWholeMethodJs: true, profileMethods: false,
    structuredSsa: false,
  } });
  await coldJvm.loadClassByName('DirectIntegerInlineHarness');
  await coldJvm.loadClassByName('DirectIntegerLeafTarget');
  coldJvm.classInitializationState.set('DirectIntegerInlineHarness', 'INITIALIZED');
  const coldMethod = await coldJvm.findMethodInHierarchy(
    'DirectIntegerInlineHarness', 'compute', '([I)V');
  const coldGenerated = coldJvm.jit.getGeneratedFunction(coldMethod);
  t.equal(coldGenerated.jvmDirectInlineCount, 0,
    'uninitialized target retains the class-initializing dispatch path');
  t.end();
});

test('generated JIT keeps call-dense static and monomorphic dynamic helpers synchronous', async (t) => {
  const classpath = compileJavaFixture(t, 'IntermethodCallJitHarness', `
public class IntermethodCallJitHarness {
  public abstract static class Base { public abstract int apply(int value); }
  public interface Contract { int apply(int value); }
  public static final class Worker extends Base implements Contract {
    public int apply(int value) { return chain(value); }
  }
  static int add(int value) { return value + 1; }
  static int multiply(int value) { return value * 3; }
  static int mix(int value) { return value ^ 7; }
  static int chain(int value) {
    value = add(value);
    value = multiply(value);
    return mix(value);
  }
  public static void runStatic(int[] out) {
    int value = 5;
    for (int i = 0; i < 20; i++) value = chain(value + i);
    out[0] = value;
  }
  public static void runVirtual(Base worker, int[] out) {
    int value = 5;
    for (int i = 0; i < 20; i++) value = worker.apply(value + i);
    out[1] = value;
  }
  public static void runInterface(Contract worker, int[] out) {
    int value = 5;
    for (int i = 0; i < 20; i++) value = worker.apply(value + i);
    out[2] = value;
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0, preferWholeMethodJs: true, profileMethods: true,
    structuredSsa: false,
  } });
  const classes = [
    'IntermethodCallJitHarness',
    'IntermethodCallJitHarness$Base',
    'IntermethodCallJitHarness$Contract',
    'IntermethodCallJitHarness$Worker',
  ];
  for (const className of classes) {
    await jvm.loadClassByName(className);
    jvm.classInitializationState.set(className, 'INITIALIZED');
  }
  const thread = {
    id: 0,
    name: 'intermethod-call-jit-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [0, 0, 0];
  out.type = '[I';
  const worker = { type: 'IntermethodCallJitHarness$Worker', fields: {} };

  await invoke(jvm, thread, 'IntermethodCallJitHarness', 'runStatic', '([I)V', [out]);
  await invoke(jvm, thread, 'IntermethodCallJitHarness', 'runVirtual',
    '(LIntermethodCallJitHarness$Base;[I)V', [worker, out]);
  await invoke(jvm, thread, 'IntermethodCallJitHarness', 'runInterface',
    '(LIntermethodCallJitHarness$Contract;[I)V', [worker, out]);

  t.deepEqual(out.slice(), [out[0], out[0], out[0]],
    'static, virtual, and interface dispatch preserve identical results');
  t.ok(jvm.jit.syncInlinedCallCount >= 60,
    'all three hot call sites execute through straight-line integer kernels');
  t.ok(jvm.jit.inlinedMethodRunCounts.get('IntermethodCallJitHarness.chain(I)I') >= 20,
    'static call chain is collapsed into one inline region');
  t.ok(jvm.jit.inlinedMethodRunCounts.get(
    'IntermethodCallJitHarness$Worker.apply(I)I') >= 40,
    'virtual and interface forwarding wrappers collapse their nested static chain');
  t.notOk(jvm.jit.generatedMethodRunCounts.has('IntermethodCallJitHarness.chain(I)I'),
    'collapsed chain creates no generated child frames');
  const dynamicSites = jvm.jit.syncCallSites.filter((site) => site &&
    (site.op === 'invokevirtual' || site.op === 'invokeinterface'));
  t.ok(dynamicSites.every((site) => site.fastDynamicTarget),
    'resolved dynamic sites retain a monomorphic fast target');
  t.equal(jvm.jit.runnerRunCount, 0, 'hot call chains avoid the bytecode runner');
  t.end();
});

test('large acyclic call decision trees enter generic structured SSA', (t) => {
  const owner = 'ArbitraryLargeDecisionTree';
  const items = [];
  for (let index = 0; index < 130; index += 1) {
    items.push({ instruction: 'iload_0' }, { instruction: 'istore_1' });
  }
  for (let index = 0; index < 4; index += 1) {
    items.push(
      { instruction: 'iload_0' },
      { instruction: {
        op: 'invokestatic',
        arg: ['Method', owner, ['sink', '(I)V']],
      } },
    );
  }
  items.push({ instruction: 'return' });
  const method = {
    className: owner,
    name: 'route',
    descriptor: '(I)V',
    flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: items,
      localsSize: '2',
      stackSize: '1',
      exceptionTable: [],
    } }],
  };
  const jvm = new JVM({ jit: {
    structuredSsa: true,
    fusedRegions: false,
    profileMethods: false,
  } });
  t.ok(items.length >= 256,
    'fixture exercises the large rather than short forwarding policy');
  t.ok(jvm.jit.hasCallDenseComputeShape(method, items),
    'size, acyclic CFG, and repeated invokes admit the generic shape');
  t.ok(jvm.jit.isCodegenSupported(method),
    'the complete JavaScript capability gate admits the verified body');
  t.ok(jvm.jit.isSupported(method),
    'the ordinary scheduler tier no longer waits in interpretation');
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated?.jvmStructuredSsa &&
      generated.jvmStructuredLoopCount === 0,
    'the block renderer emits one acyclic structured JavaScript region');
  t.ok(generated.jvmStructuredSource.includes('ssaFastPositionalInvoke'),
    'child calls use generic positional call-site snapshots');

  const tooFewCalls = {
    ...method,
    name: 'routeThree',
    attributes: [{ type: 'code', code: {
      ...method.attributes[0].code,
      codeItems: items.filter((_item, index) =>
        index < items.length - 3 || index >= items.length - 1),
    } }],
  };
  t.notOk(jvm.jit.hasCallDenseComputeShape(
    tooFewCalls, tooFewCalls.attributes[0].code.codeItems),
  'a large body with fewer than four calls retains the conservative policy');
  t.end();
});

test('Wasm leaves constructors and class initializers atomic', (t) => {
  const previous = process.env.JVM_WASM_JIT;
  process.env.JVM_WASM_JIT = '1';
  t.teardown(() => {
    if (previous === undefined) delete process.env.JVM_WASM_JIT;
    else process.env.JVM_WASM_JIT = previous;
  });
  const jvm = new JVM({ jit: { warmupThreshold: 100 } });
  const frame = (name) => ({ method: { name }, instructions: [{}] });
  const method = (name) => ({
    name,
    attributes: [{ type: 'code', code: { codeItems: [{ instruction: 'return' }] } }],
  });

  t.equal(jvm.jit.wasmJit.prepare(frame('<init>')), null,
    'instance constructor stays outside partial Wasm');
  t.equal(jvm.jit.wasmJit.prepare(frame('<clinit>')), null,
    'class initializer stays outside partial Wasm');
  t.notOk(jvm.jit.isSupported(method('<init>')),
    'instance constructor stays outside JavaScript JIT');
  t.notOk(jvm.jit.isSupported(method('<clinit>')),
    'class initializer stays outside JavaScript JIT');
  t.end();
});

test('ordinary generated call sites reuse canonical positional adapters', (t) => {
  t.equal(new JVM().jit.framePositionalCallsEnabled, false,
    'dispatcher-side positional calls remain an explicit experiment');
  const jvm = new JVM({jit: {
    warmupThreshold: 0,
    framePositionalCalls: true,
  }});
  const instruction = {op: 'invokestatic',
    arg: [null, 'ArbitraryTarget', ['value', '(I)I']]};
  const callerMethod = {name: 'caller', descriptor: '()V', flags: ['static'],
    attributes: [{type: 'code', code: {codeItems: [{instruction: 'return'}],
      exceptionTable: [], localsSize: '0', stackSize: '1'}}]};
  const siteId = jvm.jit.registerSyncCallSite(
    'invokestatic', instruction, callerMethod, 19);
  const site = jvm.jit.syncCallSites[siteId];
  const invoke = (value) => (value * 3) | 0;
  invoke.jvmCanonicalFrameAdapter = true;
  site.fastPositional = {invoke};
  site.fastStaticTarget = {method: callerMethod, lookupClass: 'ArbitraryTarget'};
  jvm.classInitializationState.set('ArbitraryTarget', 'INITIALIZED');
  const frame = new Frame(callerMethod);
  frame.stack.push(7);
  const thread = {status: 'runnable', callStack: new Stack()};
  thread.callStack.push(frame);
  const originalResolved = jvm.jit.tryInvokeResolvedTarget;
  jvm.jit.tryInvokeResolvedTarget = () => {
    throw new Error('resolved Frame path should not run');
  };

  t.equal(jvm.jit.tryInvokeSyncAt(siteId, frame, thread), 21,
    'the fixed-arity bridge feeds operands directly to the cached adapter');
  t.equal(frame.stack.items.length, 0,
    'successful positional execution consumes the invoke operands');
  t.equal(jvm.jit.framePositionalCallCount, 1,
    'the intermethod bridge is observable without method profiling');
  t.equal(site.callerMethod, callerMethod,
    'the site retains its arbitrary caller Method identity');
  t.equal(site.callerPc, 19,
    'the site retains its precise caller bytecode PC');

  const fallback = () => jvm.jit.asyncInvokeSentinel();
  fallback.jvmCanonicalFrameAdapter = true;
  site.fastPositional.invoke = fallback;
  frame.stack.push(9);
  let fallbackOperands = null;
  jvm.jit.tryInvokeResolvedTarget = () => {
    fallbackOperands = frame.stack.items.slice();
    frame.stack.items.length = 0;
    return 27;
  };
  t.equal(jvm.jit.tryInvokeSyncAt(siteId, frame, thread), 27,
    'a before-effects positional rejection uses the canonical target path');
  t.deepEqual(fallbackOperands, [9],
    'fallback observes the original unconsumed operands');
  t.equal(jvm.jit.framePositionalFallbackCount, 1,
    'guarded positional fallback is counted');
  jvm.jit.tryInvokeResolvedTarget = originalResolved;
  t.end();
});

test('structured continuations poll after accumulated positional child work',
  async (t) => {
  const className = 'PositionalQuantumPollHarness';
  const classpath = compileJavaFixture(t, className, `
public final class PositionalQuantumPollHarness {
  private static int read(int limit, int[] cursor) {
    while (cursor[0] < limit) cursor[0]++;
    return cursor[0] & 7;
  }
  static int accumulate(int count, int[] cursor) {
    int result = 0;
    for (int index = 0; index < count; index++) result += read(index, cursor);
    return result;
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    preferWholeMethodJs: true,
    structuredSsa: true,
    positionalCallSafePointPolling: true,
    profileMethods: false,
  } });
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const caller = await jvm.findMethodInHierarchy(
    className, 'accumulate', '(I[I)I');
  const child = await jvm.findMethodInHierarchy(
    className, 'read', '(I[I)I');
  const generated = jvm.jit.structuredSsa.compile(caller);
  t.ok(generated?.jvmStructuredContinuation,
    'the arbitrary call-bearing loop owns an exact continuation');

  const cursor = [0];
  cursor.type = '[I';
  const thread = {
    id: 0, name: 'positional-quantum-poll', status: 'runnable',
    pendingException: null, callStack: new Stack(),
  };
  const execute = (count) => {
    const frame = new Frame(caller);
    frame.className = className;
    frame.locals[0] = count;
    frame.locals[1] = cursor;
    thread.callStack.items.length = 0;
    thread.callStack.push(frame);
    return { frame, result: generated(frame, thread, jvm.jit, false) };
  };

  execute(4);
  const site = jvm.jit.syncCallSites.find((candidate) =>
    candidate?.callerMethod === caller && candidate.methodName === 'read' &&
    candidate.fastPositional?.invoke);
  t.equal(site?.fastPositional?.invoke?.jvmSafePointCharge,
    jvm.jit.getCodeItems(child).length,
  'the linked child publishes its structural bytecode charge');
  t.ok(generated.jvmStructuredSource.includes(
    "reason: 'structured SSA positional quantum'"),
  'the continuation polls at the exact positional call boundary');
  t.ok(generated.jvmStructuredSource.includes(
    'safePointBudget = Math.min(safePointBudget, 256);'),
  'the child-work poll clamps an inherited long parent quantum');
  t.notOk(generated.jvmRestoringDirectPositionalSource?.includes(
    "reason: 'structured SSA positional quantum'"),
  'ordinary restoring entries do not acquire an invalid generator yield');

  cursor[0] = 0;
  const continueStructuredQuantum = jvm.jit.continueStructuredQuantum;
  jvm.jit.continueStructuredQuantum = () => false;
  const yielded = execute(20000);
  t.ok(yielded.result?.deopt && yielded.result.transient,
    'accumulated child work yields through the parent continuation');
  t.equal(yielded.result.reason, 'structured SSA positional quantum',
    'the handoff is attributed to the positional call boundary');
  t.ok(yielded.frame.pc > 0 && yielded.frame.pc <
    jvm.jit.getCodeItems(caller).length,
  'the handoff materializes an exact in-method caller PC');
  t.ok(cursor[0] > 0 && cursor[0] < 19999,
    'the quantum yields after real progress but before completion');
  jvm.jit.continueStructuredQuantum = continueStructuredQuantum;
  t.end();
});

test('frame positional deoptimization links the canonical child return', (t) => {
  const jvm = new JVM({jit: {warmupThreshold: 0}});
  const method = {name: 'parent', descriptor: '()V', flags: ['static'],
    attributes: [{type: 'code', code: {codeItems: [{instruction: 'return'}],
      exceptionTable: [], localsSize: '0', stackSize: '1'}}]};
  const site = {
    op: 'invokestatic', params: ['int'], returnType: 'int',
  };
  const parent = new Frame(method);
  parent.stack.push(5);
  const child = new Frame(method);
  const thread = {status: 'runnable', callStack: new Stack()};
  thread.callStack.push(parent);
  const deopt = {deopt: true, transient: true};
  const invoke = () => {
    thread.callStack.push(child);
    deopt.jvmPositionalChild = child;
    return deopt;
  };

  t.equal(jvm.jit.tryInvokeFramePositional(
    site, invoke, parent, thread), deopt,
  'the bridge propagates the exact generated deoptimization');
  t.equal(child.jitGeneratedReturnParent, parent,
    'the active canonical child returns to the invoking Frame');
  t.equal(child.jitGeneratedReturnType, 'int',
    'the child records the descriptor return type');
  t.equal(parent.stack.items.length, 0,
    'a consumed deoptimizing call removes its parent operands');
  t.end();
});

test('generated callers resume around unsupported interpreted callees', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedTransientCallJitHarness', `
public class GeneratedTransientCallJitHarness {
  private static int selected(int value) {
    switch (value) {
      case 0: return 10;
      case 1: return 20;
      default: return 30;
    }
  }
  public static void compute(int[] out) {
    for (int i = 0; i < out.length; i++) out[i] = selected(i) + 1;
  }
}
`);
  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName('GeneratedTransientCallJitHarness');
  const thread = {
    id: 0,
    name: 'transient-call-generated-jit-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [0, 0, 0];
  out.type = '[I';
  await invoke(jvm, thread, 'GeneratedTransientCallJitHarness', 'compute', '([I)V', [out]);
  t.deepEqual(out.slice(0, 3), [11, 21, 31], 'unsupported child calls preserve results');
  t.equal(jvm.jit.generatedRunCount, 4,
    'caller resumes generated execution after each interpreted child');
  const callerMethod = await jvm.findMethodInHierarchy(
    'GeneratedTransientCallJitHarness', 'compute', '([I)V');
  t.notOk(jvm.jit.deoptedMethods.has(callerMethod),
  'unsupported child does not permanently deopt its caller');
  const callSite = jvm.jit.syncCallSites.find((candidate) =>
    candidate?.callerMethod === callerMethod);
  const invokePc = jvm.jit.getCodeItems(callerMethod).findIndex((item) =>
    item.instruction?.op === 'invokestatic');
  t.equal(callSite?.callerPc, invokePc,
    'ordinary generated call sites publish caller Method and bytecode PC');
  t.end();
});

test('generated invokevirtual resolves Object methods on arrays', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedArrayCloneJitHarness', `
public class GeneratedArrayCloneJitHarness {
  public static void copy(int[] input, int[][] out) {
    for (int i = 0; i < out.length; i++) out[i] = (int[]) input.clone();
  }
}
`);
  const jvm = new JVM({
    classpath,
    jit: { warmupThreshold: 0, experimentalControlFlow: true },
  });
  await jvm.loadClassByName('GeneratedArrayCloneJitHarness');
  const thread = {
    id: 0,
    name: 'array-clone-generated-jit-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const input = [3, 5, 8];
  input.type = '[I';
  const out = [null];
  out.type = '[[I';

  await invoke(jvm, thread, 'GeneratedArrayCloneJitHarness', 'copy',
    '([I[[I)V', [input, out]);

  t.deepEqual(out[0].slice(), [3, 5, 8], 'array clone preserves its elements');
  t.notEqual(out[0], input, 'array clone returns a distinct array');
  t.equal(out[0].type, '[I', 'array clone preserves runtime type metadata');
  t.ok(jvm.jit.generatedRunCount > 0, 'array clone call executes from generated code');
  t.end();
});

test('generated short helpers dispatch interface methods without runner fallback', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedInterfaceJitHarness', `
public class GeneratedInterfaceJitHarness {
  interface Value { int get(); }
  static class Fixed implements Value {
    private final int value;
    Fixed(int value) { this.value = value; }
    public int get() { return value; }
  }
  public static void compute(int[] out, Value value) {
    for (int i = 0; i < out.length; i++) out[i] = value.get();
  }
}
`);
  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName('GeneratedInterfaceJitHarness');
  await jvm.loadClassByName('GeneratedInterfaceJitHarness$Fixed');
  const thread = {
    id: 0,
    name: 'interface-generated-jit-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [0, 0, 0, 0];
  const value = {
    type: 'GeneratedInterfaceJitHarness$Fixed',
    fields: { 'GeneratedInterfaceJitHarness$Fixed.value': 7 },
  };
  await invoke(jvm, thread, 'GeneratedInterfaceJitHarness', 'compute',
    '([ILGeneratedInterfaceJitHarness$Value;)V', [out, value]);
  t.deepEqual(out, [7, 7, 7, 7], 'invokeinterface preserves dynamic dispatch and return values');
  t.equal(jvm.jit.runnerRunCount, 0, 'interface accessors avoid the bytecode runner');
  // The accessor body is aload_0/getfield/ireturn, which the inline-integer
  // plan now covers, so the four calls are folded into the caller instead of
  // each running as generated code. Only the outer loop keeps a frame; that
  // also leaves no completed child frame to recycle. Dynamic dispatch is still
  // proven by the returned values above and by the absence of runner fallback.
  t.equal(jvm.jit.generatedRunCount, 1, 'only the outer loop needs generated code');
  t.equal(jvm.jit.syncReusedFrameCount, 0,
    'the inlined interface accessor pushes no child frame to recycle');
  t.end();
});

test('an inlined integer getter observes writes made between calls', async (t) => {
  const classpath = compileJavaFixture(t, 'InlineGetterFieldHarness', `
public class InlineGetterFieldHarness {
  interface Value { int get(); }
  static class Counter implements Value {
    int value;
    public int get() { return value; }
    void bump(int by) { value = value + by; }
  }
  public static void compute(int[] out, Value value) {
    Counter counter = (Counter) value;
    for (int i = 0; i < out.length; i++) {
      out[i] = counter.get();
      counter.bump(2);
    }
  }
}
`);
  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName('InlineGetterFieldHarness');
  await jvm.loadClassByName('InlineGetterFieldHarness$Counter');
  const thread = {
    id: 0,
    name: 'inline-getter-field-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [0, 0, 0, 0];
  const value = {
    type: 'InlineGetterFieldHarness$Counter',
    fields: { 'InlineGetterFieldHarness$Counter.value': 5 },
  };
  await invoke(jvm, thread, 'InlineGetterFieldHarness', 'compute',
    '([ILInlineGetterFieldHarness$Value;)V', [out, value]);
  // The getter body is inlined into the caller, so this is the assertion that
  // the inlined read is a real load each time rather than a value captured
  // once: each iteration must see the write the previous one made.
  t.deepEqual(out, [5, 7, 9, 11], 'each inlined read observes the preceding write');
  t.equal(value.fields['InlineGetterFieldHarness$Counter.value'], 13,
    'the field ends at its final written value');
  t.equal(jvm.jit.runnerRunCount, 0, 'the inlined getter avoids the bytecode runner');
  t.end();
});

test('generated JIT accelerates integer byte-array loops', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedIntegerArrayLoopHarness', `
public class GeneratedIntegerArrayLoopHarness {
  public static void compute(int[] out, byte[][] left, byte[][] right, int length) {
    int score = 100;
    for (int i = 0; i < length; i++) {
      int value = left[0][i] + right[1][i];
      if (value < score) score = value;
    }
    out[0] = -score;
    out[1] = 2147483647 + length;
    out[2] = -7 / length;
  }
}
`);

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName('GeneratedIntegerArrayLoopHarness');
  const thread = {
    id: 0,
    name: 'generated-integer-array-loop-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;

  const out = [0, 0, 0];
  const left = [[5, 4, 3]];
  const right = [[0, 0, 0], [2, 1, 0]];
  await invoke(jvm, thread, 'GeneratedIntegerArrayLoopHarness', 'compute', '([I[[B[[BI)V',
    [out, left, right, 3]);

  t.deepEqual(out, [-3, -2147483646, -2],
    'generated integer array loop preserves int overflow and truncating division semantics');
  t.equal(jvm.jit.generatedRunCount, 1, 'backward integer array loop compiles on first invocation');
  t.equal(jvm.jit.runnerRunCount, 0, 'generated loop bypasses the bytecode runner');
  t.end();
});

test('generated JIT supports short-array loads and checked casts', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedShortArrayJitHarness', `
public class GeneratedShortArrayJitHarness {
  public static void compute(int[] out, short[] values, Object checked) {
    int sum = 0;
    for (int i = 0; i < values.length; i++) sum += values[i];
    out[0] = sum + ((int[]) checked).length;
  }
}
`);
  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName('GeneratedShortArrayJitHarness');
  const thread = {
    id: 0,
    name: 'short-array-generated-jit-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [0];
  out.type = '[I';
  const values = [300, -20, 7];
  values.type = '[S';
  const checked = [1, 2];
  checked.type = '[I';
  await invoke(jvm, thread, 'GeneratedShortArrayJitHarness', 'compute',
    '([I[SLjava/lang/Object;)V', [out, values, checked]);
  t.equal(out[0], 289, 'short loads and a valid array cast preserve results');
  t.equal(jvm.jit.generatedRunCount, 1, 'short-array loop uses generated code');
  t.equal(jvm.jit.runnerRunCount, 0, 'short-array loop avoids runner fallback');
  t.end();
});

test('generated JIT preserves long division, xor, and comparison semantics', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedLongJitHarness', `
public class GeneratedLongJitHarness {
  public static void compute(int[] out, int value) {
    out[0] = ((((long) value / 3L) ^ -1L) == -5L) ? 1 : 0;
  }
}
`);
  const jvm = new JVM({ classpath, jit: { warmupThreshold: 0 } });
  await jvm.loadClassByName('GeneratedLongJitHarness');
  const thread = {
    id: 0,
    name: 'long-generated-jit-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [0];
  out.type = '[I';
  await invoke(jvm, thread, 'GeneratedLongJitHarness', 'compute', '([II)V', [out, 12]);
  t.equal(out[0], 1, 'long expression preserves BigInt-backed JVM semantics');
  t.equal(jvm.jit.generatedRunCount, 1, 'long expression uses generated code');
  t.end();
});

test('generated JIT preserves float32 arithmetic in hot array loops', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedFloatLoopHarness', `
public class GeneratedFloatLoopHarness {
  public static float mix(float[] values, int rounds) {
    float total = 0.0f;
    for (int round = 0; round < rounds; round++) {
      for (int i = 0; i < values.length; i++) {
        values[i] = values[i] * 1.25f - 0.5f;
        total += values[i];
      }
    }
    return total;
  }
}
`);

  async function run(jit) {
    const jvm = new JVM({ classpath, jit });
    await jvm.loadClassByName('GeneratedFloatLoopHarness');
    const thread = {
      id: 0,
      name: 'generated-float-loop-test',
      callStack: new Stack(),
      status: 'runnable',
      pendingException: null,
    };
    jvm.threads = [thread];
    jvm.currentThreadIndex = 0;
    const values = [0.1, -2.25, 3.5];
    const ticks = await invoke(jvm, thread, 'GeneratedFloatLoopHarness', 'mix', '([FI)F',
      [values, 4]);
    return { jvm, values, ticks, result: thread.callStack.isEmpty() ? undefined : thread.callStack.peek() };
  }

  const interpreted = await run({ enabled: false });
  const jitted = await run({ warmupThreshold: 100 });
  t.deepEqual(jitted.values, interpreted.values,
    'generated loop should match interpreter float32 rounding after every operation');
  t.equal(jitted.jvm.jit.generatedRunCount, 1, 'backward float loop compiles on its first invocation');
  t.equal(jitted.jvm.jit.runnerRunCount, 0, 'generated float loop bypasses the bytecode runner');
  t.equal(jitted.ticks, 1, 'generated float loop completes in one scheduler tick');
  t.end();
});

test('Wasm JIT carries category-2 values across control-flow merges', async (t) => {
  const classpath = compileJavaFixture(t, 'WasmLongCarryHarness', `
public class WasmLongCarryHarness {
  public static void compute(long[] out, long[] state, long[] input) {
    for (int i = 0; i < out.length; i++) {
      out[i] = state[i] > input[i] ? state[i] : input[i];
    }
  }
}
`);

  const previous = process.env.JVM_WASM_JIT;
  process.env.JVM_WASM_JIT = '1';
  t.teardown(() => {
    if (previous === undefined) delete process.env.JVM_WASM_JIT;
    else process.env.JVM_WASM_JIT = previous;
  });

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName('WasmLongCarryHarness');
  jvm.classInitializationState.set('WasmLongCarryHarness', 'INITIALIZED');
  const thread = {
    id: 0,
    name: 'wasm-long-carry-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;

  const out = [0n, 0n, 0n];
  const state = [1n, 2n, 3n];
  const input = [4n, 6n, 7n];
  for (const array of [out, state, input]) array.type = '[J';
  await invoke(jvm, thread, 'WasmLongCarryHarness', 'compute', '([J[J[J)V',
    [out, state, input]);

  t.deepEqual(out.slice(0, 3), [4n, 6n, 7n], 'merged long branch values are preserved');
  const compiled = jvm.jit.wasmJit.compiled.map((entry) => entry.key);
  t.ok(compiled.includes('WasmLongCarryHarness.compute([J[J[J)V'), 'loop uses the Wasm tier');
  t.end();
});

test('Wasm JIT field-value caching observes same-run writes and slot reassignment', async (t) => {
  const classpath = compileJavaFixture(t, 'WasmFieldCacheHarness', `
public class WasmFieldCacheHarness {
  static int bias;
  int scale;
  public static int compute(int[] out) {
    bias = 1;
    WasmFieldCacheHarness h = new WasmFieldCacheHarness();
    h.scale = 2;
    int sum = 0;
    for (int i = 0; i < out.length; i++) {
      sum += bias + h.scale;
      if (i == 1) { bias = 5; h.scale = 9; }
      sum += bias + h.scale;
    }
    out[0] = sum;
    return sum;
  }
  public static int swapAlias(int[] out) {
    WasmFieldCacheHarness p = new WasmFieldCacheHarness();
    WasmFieldCacheHarness q = new WasmFieldCacheHarness();
    p.scale = 1;
    q.scale = 100;
    int sum = 0;
    for (int i = 0; i < out.length; i++) {
      sum += p.scale;
      WasmFieldCacheHarness t = p; p = q; q = t;
      sum += p.scale;
    }
    out[0] = sum;
    return sum;
  }
}
`);

  const previous = process.env.JVM_WASM_JIT;
  process.env.JVM_WASM_JIT = '1';
  t.teardown(() => {
    if (previous === undefined) delete process.env.JVM_WASM_JIT;
    else process.env.JVM_WASM_JIT = previous;
  });

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName('WasmFieldCacheHarness');
  jvm.classInitializationState.set('WasmFieldCacheHarness', 'INITIALIZED');
  const thread = {
    id: 0,
    name: 'wasm-field-cache-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;

  const out = [0, 0, 0, 0];
  out.type = '[I';
  await invoke(jvm, thread, 'WasmFieldCacheHarness', 'compute', '([I)I', [out]);
  t.equal(out[0], 79, 'putstatic and putfield invalidate cached reads mid-loop');

  const swapped = [0, 0, 0];
  swapped.type = '[I';
  await invoke(jvm, thread, 'WasmFieldCacheHarness', 'swapAlias', '([I)I', [swapped]);
  t.equal(swapped[0], 303, 'reassigning a receiver slot invalidates its field cache');

  const compiled = jvm.jit.wasmJit.compiled.map((entry) => entry.key);
  t.ok(compiled.includes('WasmFieldCacheHarness.compute([I)I'),
    'field-reading loop still uses the Wasm tier');
  t.ok(compiled.includes('WasmFieldCacheHarness.swapAlias([I)I'),
    'slot-swapping loop still uses the Wasm tier');
  t.end();
});

test('Wasm JIT field-write summaries keep caches alive across pure callees', async (t) => {
  const classpath = compileJavaFixture(t, 'WasmWriteSummaryHarness', `
public class WasmWriteSummaryHarness {
  static int base;
  static int scale;
  static int pure(int v) { return v * 2 + 1; }
  static int pureNested(int v) { return pure(v) + Math.abs(v); }
  static void bump(int d) { scale += d; }
  public static int drive(int[] out, int n) {
    base = 7;
    scale = 3;
    int sum = 0;
    for (int i = 0; i < n; i++) {
      sum += base + pureNested(i);
      if (i == n / 2) { bump(2); }
      sum += scale * base;
    }
    out[0] = sum;
    return sum;
  }
}
`);

  const previous = process.env.JVM_WASM_JIT;
  process.env.JVM_WASM_JIT = '1';
  t.teardown(() => {
    if (previous === undefined) delete process.env.JVM_WASM_JIT;
    else process.env.JVM_WASM_JIT = previous;
  });

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName('WasmWriteSummaryHarness');
  jvm.classInitializationState.set('WasmWriteSummaryHarness', 'INITIALIZED');
  const thread = {
    id: 0,
    name: 'wasm-write-summary-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;

  const n = 12;
  let expected = 0;
  let base = 7;
  let scale = 3;
  for (let i = 0; i < n; i++) {
    expected += base + (i * 2 + 1) + Math.abs(i);
    if (i === Math.floor(n / 2)) scale += 2;
    expected += scale * base;
  }
  const out = [0];
  out.type = '[I';
  await invoke(jvm, thread, 'WasmWriteSummaryHarness', 'drive', '([II)I', [out, n]);
  t.equal(out[0], expected, 'impure callee still invalidates exactly the field it writes');

  const wasmJit = jvm.jit.wasmJit;
  const pureSummary = wasmJit.staticWriteSummary('WasmWriteSummaryHarness', 'pureNested', '(I)I');
  t.ok(pureSummary && pureSummary.size === 0,
    'transitively pure helper (incl. Math call) summarizes to an empty write set');
  const bumpSummary = wasmJit.staticWriteSummary('WasmWriteSummaryHarness', 'bump', '(I)V');
  t.same(bumpSummary && [...bumpSummary], ['scale:I'],
    'writing helper summarizes to exactly its written field');
  const driveSummary = wasmJit.staticWriteSummary('WasmWriteSummaryHarness', 'drive', '([II)I');
  t.same(driveSummary && [...driveSummary].sort(), ['base:I', 'scale:I'],
    'caller summary is the transitive union of its own and its callees writes');
  t.equal(wasmJit.staticWriteSummary('WasmWriteSummaryHarness', 'missing', '()V'), null,
    'unknown methods stay unknowable (kill everything)');

  const compiled = jvm.jit.wasmJit.compiled.map((entry) => entry.key);
  t.ok(compiled.includes('WasmWriteSummaryHarness.drive([II)I'),
    'summary-guided loop uses the Wasm tier');
  t.end();
});

test('Wasm JIT links partial callees and deopts through their diagnostic guards', async (t) => {
  const classpath = compileJavaFixture(t, 'WasmPartialLinkHarness', `
public class WasmPartialLinkHarness {
  static boolean diag;
  static int mix(int v, int[] log) {
    if (diag) { log[0] = ("v=" + v).length(); }
    return v * 3 + 1;
  }
  public static int drive(int[] out, int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) {
      int t = mix(i, out);
      sum += t;
      if (i == 5) { diag = true; }
      if (i == 7) { diag = false; }
    }
    out[1] = sum;
    return sum;
  }
}
`);

  const previous = process.env.JVM_WASM_JIT;
  process.env.JVM_WASM_JIT = '1';
  t.teardown(() => {
    if (previous === undefined) delete process.env.JVM_WASM_JIT;
    else process.env.JVM_WASM_JIT = previous;
  });

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName('WasmPartialLinkHarness');
  jvm.classInitializationState.set('WasmPartialLinkHarness', 'INITIALIZED');
  jvm.classes.WasmPartialLinkHarness.staticFields.set('diag:Z', false);
  const thread = {
    id: 0,
    name: 'wasm-partial-link-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;

  const out = [0, 0];
  out.type = '[I';
  await invoke(jvm, thread, 'WasmPartialLinkHarness', 'drive', '([II)I', [out, 10]);

  // sum of 3i+1 for i in 0..9 = 145; the guard is true for i=6,7 so the
  // diagnostic path last logs "v=7".length() = 3
  t.equal(out[1], 145, 'loop result is exact across the deopt round trips');
  t.equal(out[0], 3, 'the diagnostic path executed interpreted with correct state');

  const compiled = new Map(jvm.jit.wasmJit.compiled.map((entry) => [entry.key, entry]));
  t.ok(compiled.has('WasmPartialLinkHarness.drive([II)I'), 'caller loop uses the Wasm tier');
  const mixState = compiled.get('WasmPartialLinkHarness.mix(I[I)I');
  t.ok(mixState, 'helper with a guarded diagnostic block still links');
  t.ok(mixState.meta && !mixState.meta.normalFlowFullyCompiled,
    'the helper is genuinely partial (its diagnostic block is demoted)');
  t.ok((mixState.nestedDeopts || 0) >= 1 && (mixState.nestedDeopts || 0) <= 4,
    `deopts happened only while the guard was hot (saw ${mixState.nestedDeopts})`);
  t.ok((mixState.nestedCalls || 0) > (mixState.nestedDeopts || 0),
    'most nested calls completed inside wasm');
  t.end();
});

test('Wasm JIT links loop-free static numeric helpers into hot loops', async (t) => {
  const classpath = compileJavaFixture(t, 'WasmLinkedHelperHarness', `
public class WasmLinkedHelperHarness {
  private static int mix(int[] values, int index, int salt) {
    int value = values[index];
    return (value * 31 + salt) ^ (value >>> 3);
  }
  public static void compute(int[] out) {
    for (int i = 0; i < out.length; i++) out[i] = mix(out, i, i + 7);
  }
}
`);

  const previous = process.env.JVM_WASM_JIT;
  process.env.JVM_WASM_JIT = '1';
  t.teardown(() => {
    if (previous === undefined) delete process.env.JVM_WASM_JIT;
    else process.env.JVM_WASM_JIT = previous;
  });

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName('WasmLinkedHelperHarness');
  jvm.classInitializationState.set('WasmLinkedHelperHarness', 'INITIALIZED');
  const thread = {
    id: 0,
    name: 'wasm-linked-helper-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [3, 5, 8];
  out.type = '[I';

  await invoke(jvm, thread, 'WasmLinkedHelperHarness', 'compute', '([I)V', [out]);

  t.deepEqual(out.slice(0, 3), [100, 163, 256], 'linked helper preserves JVM integer results');
  const compiled = new Map(jvm.jit.wasmJit.compiled.map((entry) => [entry.key, entry]));
  t.ok(compiled.has('WasmLinkedHelperHarness.mix([III)I'),
    'loop-free helper with a reference argument compiles on demand');
  t.ok(compiled.has('WasmLinkedHelperHarness.compute([I)V'), 'caller loop compiles with the linked helper');
  t.equal(compiled.get('WasmLinkedHelperHarness.compute([I)V').exits, 0,
    'linked call does not bounce through the interpreter');
  t.end();
});

test('Wasm JIT links helpers whose only unsupported blocks are exception reporters', async (t) => {
  const classpath = compileJavaFixture(t, 'WasmLinkedReporterHelperHarness', `
public class WasmLinkedReporterHelperHarness {
  private static int mix(int value) {
    try {
      return value * 31 + 7;
    } catch (RuntimeException failure) {
      throw new IllegalStateException("mix(" + value + ")", failure);
    }
  }
  public static void compute(int[] out) {
    for (int i = 0; i < out.length; i++) out[i] = mix(out[i]);
  }
}
`);

  const previous = process.env.JVM_WASM_JIT;
  process.env.JVM_WASM_JIT = '1';
  t.teardown(() => {
    if (previous === undefined) delete process.env.JVM_WASM_JIT;
    else process.env.JVM_WASM_JIT = previous;
  });

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName('WasmLinkedReporterHelperHarness');
  jvm.classInitializationState.set('WasmLinkedReporterHelperHarness', 'INITIALIZED');
  const thread = {
    id: 0,
    name: 'wasm-linked-reporter-helper-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [2, 4, 6];
  out.type = '[I';

  await invoke(jvm, thread, 'WasmLinkedReporterHelperHarness', 'compute', '([I)V', [out]);

  t.deepEqual(out.slice(0, 3), [69, 131, 193],
    'linked reporter helper preserves normal-flow results');
  const compiled = new Map(jvm.jit.wasmJit.compiled.map((entry) => [entry.key, entry]));
  t.ok(compiled.has('WasmLinkedReporterHelperHarness.mix(I)I'),
    'normal-flow-complete helper links despite handler-only blocks');
  t.equal(compiled.get('WasmLinkedReporterHelperHarness.compute([I)V').exits, 0,
    'linked reporter helper does not force caller exits');
  t.end();
});

test('Wasm JIT recognizes forward-branching wrap-and-rethrow reporters', async (t) => {
  const classpath = compileJavaFixture(t, 'WasmReporterHarness', `
public class WasmReporterHarness {
  public static void compute(int[] out, String site) {
    try {
      for (int i = 0; i < out.length; i++) out[i] = out[i] * 3 + i;
    } catch (RuntimeException failure) {
      String detail = site == null ? "null" : "{...}";
      throw new IllegalStateException("compute(" + detail + ")", failure);
    }
  }

  public static void recover(int[] out) {
    try {
      for (int i = 0; i <= out.length; i++) out[i]++;
    } catch (RuntimeException failure) {
      out[0] = 42;
    }
  }
}
`);

  const previous = process.env.JVM_WASM_JIT;
  process.env.JVM_WASM_JIT = '1';
  t.teardown(() => {
    if (previous === undefined) delete process.env.JVM_WASM_JIT;
    else process.env.JVM_WASM_JIT = previous;
  });

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName('WasmReporterHarness');
  jvm.classInitializationState.set('WasmReporterHarness', 'INITIALIZED');
  const thread = {
    id: 0,
    name: 'wasm-reporter-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [2, 4, 6];
  out.type = '[I';

  await invoke(jvm, thread, 'WasmReporterHarness', 'compute',
    '([ILjava/lang/String;)V', [out, null]);

  t.deepEqual(out.slice(0, 3), [6, 13, 20], 'normal reporter-covered loop preserves results');
  const compiled = new Map(jvm.jit.wasmJit.compiled.map((entry) => [entry.key, entry]));
  t.ok(compiled.has('WasmReporterHarness.compute([ILjava/lang/String;)V'),
    'forward-only diagnostic formatting does not poison the protected loop');
  t.equal(compiled.get('WasmReporterHarness.compute([ILjava/lang/String;)V').exits, 0,
    'successful protected loop remains in wasm');
  // Dispatcher-tier EH now compiles live handler ranges, so the recovery
  // handler runs in wasm; verify the out-of-bounds path still recovers.
  const recovered = [10, 20, 30];
  recovered.type = '[I';
  await invoke(jvm, thread, 'WasmReporterHarness', 'recover', '([I)V', [recovered]);
  t.deepEqual(recovered.slice(0, 3), [42, 21, 31],
    'a handler that writes a recovery value dispatches to the compiled handler');
  const compiledAfter = new Map(jvm.jit.wasmJit.compiled.map((entry) => [entry.key, entry]));
  t.equal(
    compiledAfter.has('WasmReporterHarness.recover([I)V'),
    WASM_TRY_TABLE_SUPPORTED,
    WASM_TRY_TABLE_SUPPORTED
      ? 'recovery handler compiles under dispatcher EH'
      : 'recovery handler preserves semantics through the engine fallback',
  );
  t.end();
});

test('Wasm JIT reporter scan skips unreachable throws before a forward join', (t) => {
  const codeItems = [
    { instruction: { op: 'astore', varnum: 1 } },
    { instruction: { op: 'aload', varnum: 2 } },
    { instruction: { op: 'ifnull', arg: 'Lnull' } },
    { instruction: { op: 'ldc', arg: '{...}' } },
    { instruction: { op: 'goto', arg: 'Ljoin' } },
    { instruction: 'athrow' },
    { labelDef: 'Lnull:' },
    { instruction: { op: 'ldc', arg: 'null' } },
    { labelDef: 'Ljoin:' },
    { instruction: { op: 'invokestatic', arg: [null, 'Reporter', ['wrap', '()V']] } },
    { instruction: 'athrow' },
  ];
  const labels = new Map([['Lnull', 6], ['Ljoin', 8]]);

  t.ok(wasmJitTest.isNoOpExceptionHandler(codeItems, 0, labels),
    'an unreachable trap before the pending join is not mistaken for handler recovery');
  t.end();
});

test('whole-method JS tier accepts invoke loops with rethrow-only handlers', (t) => {
  const codeItems = [
    { labelDef: 'Lstart:' },
    { instruction: { op: 'invokestatic', arg: [null, 'Helper', ['mix', '(I)I']] } },
    { instruction: { op: 'goto', arg: 'Lstart' } },
    { labelDef: 'Lend:' },
    { instruction: 'return' },
    { labelDef: 'Lhandler:' },
    { instruction: { op: 'astore', varnum: 1 } },
    { instruction: { op: 'aload', varnum: 1 } },
    { instruction: 'athrow' },
  ];
  const method = {
    name: 'render',
    descriptor: '()V',
    attributes: [{ type: 'code', code: {
      codeItems,
      exceptionTable: [{ startLbl: 'Lstart', endLbl: 'Lend', handlerLbl: 'Lhandler' }],
    } }],
  };
  const jvm = new JVM({ jit: { preferWholeMethodJs: true } });

  t.ok(jvm.jit.hasOnlyNoOpExceptionHandlers(method, codeItems),
    'bare rethrow handler is proven semantically transparent');
  t.ok(jvm.jit.hasJitSafeControlFlow(method, codeItems),
    'normal-flow invokes are eligible when every handler only rethrows');
  t.end();
});

test('Wasm JIT retries a deferred loop after its static helper becomes available', async (t) => {
  const classpath = compileJavaFixture(t, 'WasmDeferredHarness', `
public class WasmDeferredHarness {
  static class Helper {
    static int marker;
    static { marker = 1; }
    static int mix(int value) { return value * 3 + 1; }
  }
  public static void compute(int[] out) {
    for (int i = 0; i < out.length; i++) out[i] = Helper.mix(out[i]);
  }
}
`);

  const previous = process.env.JVM_WASM_JIT;
  process.env.JVM_WASM_JIT = '1';
  t.teardown(() => {
    if (previous === undefined) delete process.env.JVM_WASM_JIT;
    else process.env.JVM_WASM_JIT = previous;
  });

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 100 } });
  await jvm.loadClassByName('WasmDeferredHarness');
  jvm.classInitializationState.set('WasmDeferredHarness', 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy('WasmDeferredHarness', 'compute', '([I)V');
  const frame = new Frame(method);
  frame.className = 'WasmDeferredHarness';

  t.equal(jvm.jit.wasmJit.prepare(frame), null,
    'caller initially defers while the helper class is unavailable');
  t.equal(jvm.jit.wasmJit.methodState(frame).status, 'cold',
    'a dependency miss does not permanently reject the caller');

  await jvm.loadClassByName('WasmDeferredHarness$Helper');
  jvm.classInitializationState.set('WasmDeferredHarness$Helper', 'INITIALIZED');
  // The first retry observes the adaptive two-entry backoff.
  jvm.jit.wasmJit.prepare(frame);
  const prepared = jvm.jit.wasmJit.prepare(frame);
  t.ok(prepared, 'caller recompiles after its helper becomes linkable');
  t.equal(jvm.jit.wasmJit.methodState(frame).status, 'ready',
    'successfully retried caller remains ready');
  t.end();
});

test('Wasm JIT compiles loops protected only by checked-exception handlers', async (t) => {
  const classpath = compileJavaFixture(t, 'WasmCheckedHandlerHarness', `
import java.io.IOException;

public class WasmCheckedHandlerHarness {
  private static void maybeFail(boolean fail) throws IOException {
    if (fail) throw new IOException("expected");
  }

  public static void checked(int[] out, boolean fail) {
    try {
      for (int i = 0; i < out.length; i++) out[i] = out[i] * 3 + i;
      maybeFail(fail);
    } catch (IOException expected) {
      out[0] = 42;
    }
  }

  public static void broad(int[] out) {
    try {
      for (int i = 0; i <= out.length; i++) out[i]++;
    } catch (Exception expected) {
      out[0] = 99;
    }
  }
}
`);

  const previous = process.env.JVM_WASM_JIT;
  process.env.JVM_WASM_JIT = '1';
  t.teardown(() => {
    if (previous === undefined) delete process.env.JVM_WASM_JIT;
    else process.env.JVM_WASM_JIT = previous;
  });

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 0 } });
  await jvm.loadClassByName('WasmCheckedHandlerHarness');
  jvm.classInitializationState.set('WasmCheckedHandlerHarness', 'INITIALIZED');
  const thread = {
    id: 0,
    name: 'wasm-checked-handler-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;

  const success = [2, 4, 6];
  success.type = '[I';
  await invoke(jvm, thread, 'WasmCheckedHandlerHarness', 'checked', '([IZ)V', [success, 0]);
  t.deepEqual(success.slice(0, 3), [6, 13, 20],
    'normal protected loop preserves its result');

  const failure = [1, 2, 3];
  failure.type = '[I';
  await invoke(jvm, thread, 'WasmCheckedHandlerHarness', 'checked', '([IZ)V', [failure, 1]);
  t.deepEqual(failure.slice(0, 3), [42, 7, 11],
    'checked exception still exits at the invoke and reaches its handler');

  const compiled = new Map(jvm.jit.wasmJit.compiled.map((entry) => [entry.key, entry]));
  t.ok(compiled.has('WasmCheckedHandlerHarness.checked([IZ)V'),
    'checked-exception protection does not poison the numeric loop');

  // Dispatcher-tier EH compiles the broad-catch recovery range too; verify
  // the out-of-bounds path still reaches its handler and writes the marker.
  const recovered = [5, 6, 7];
  recovered.type = '[I';
  await invoke(jvm, thread, 'WasmCheckedHandlerHarness', 'broad', '([I)V', [recovered]);
  t.deepEqual(recovered.slice(0, 3), [99, 7, 8],
    'broad Exception recovery dispatches to the compiled handler');
  const compiledBroad = new Map(jvm.jit.wasmJit.compiled.map((entry) => [entry.key, entry]));
  t.equal(
    compiledBroad.has('WasmCheckedHandlerHarness.broad([I)V'),
    WASM_TRY_TABLE_SUPPORTED,
    WASM_TRY_TABLE_SUPPORTED
      ? 'broad-catch recovery handler compiles under dispatcher EH'
      : 'broad-catch recovery preserves semantics through the engine fallback',
  );
  t.end();
});

test('generated JS callers use proven rethrow-only children without deoptimizing', async (t) => {
  const classpath = compileJavaFixture(t, 'WasmBeforeDeoptHarness', `
public class WasmBeforeDeoptHarness {
  private static int increment(int value) {
    return value + 1;
  }

  private static void wrappedLoop(int[] out) {
    try {
      for (int i = 0; i < out.length; i++) out[i] = increment(out[i]);
    } catch (RuntimeException failure) {
      throw new IllegalStateException("wrappedLoop", failure);
    }
  }

  public static void caller(int[] out) {
    wrappedLoop(out);
    out[0] += 10;
  }
}
`);

  const previous = process.env.JVM_WASM_JIT;
  process.env.JVM_WASM_JIT = '1';
  t.teardown(() => {
    if (previous === undefined) delete process.env.JVM_WASM_JIT;
    else process.env.JVM_WASM_JIT = previous;
  });

  const jvm = new JVM({
    classpath,
    jit: { warmupThreshold: 0, preferWholeMethodJs: true },
  });
  await jvm.loadClassByName('WasmBeforeDeoptHarness');
  jvm.classInitializationState.set('WasmBeforeDeoptHarness', 'INITIALIZED');
  const wrapped = await jvm.findMethodInHierarchy(
    'WasmBeforeDeoptHarness', 'wrappedLoop', '([I)V');
  t.ok(jvm.jit.isCodegenSupported(wrapped),
    'rethrow-only handler permits whole-method generated code');

  const thread = {
    id: 0,
    name: 'wasm-before-deopt-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [1, 2, 3];
  out.type = '[I';

  await invoke(jvm, thread, 'WasmBeforeDeoptHarness', 'caller', '([I)V', [out]);

  t.deepEqual(out.slice(0, 3), [12, 3, 4], 'generated child and caller preserve results');
  const caller = await jvm.findMethodInHierarchy('WasmBeforeDeoptHarness', 'caller', '([I)V');
  t.notOk(jvm.jit.deoptedMethods.has(caller),
    'a generated child does not permanently deopt its generated caller');
  t.end();
});

test('debug mode keeps JIT off so executeTick remains one-instruction stepping', async (t) => {
  const classpath = compileJavaFixture(t, 'DebugJitHarness', `
public class DebugJitHarness {
  public static void compute(int[] out, int a) {
    double x = (double) a + 2.0;
    out[0] = (int) x;
  }
}
`);

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 0 } });
  await jvm.loadClassByName('DebugJitHarness');
  const method = await jvm.findMethodInHierarchy('DebugJitHarness', 'compute', '([II)V');
  const frame = new Frame(method);
  frame.className = 'DebugJitHarness';

  const out = [0];
  out.type = '[I';
  out.length = 1;
  out.hashCode = jvm.nextHashCode++;
  frame.locals[0] = out;
  frame.locals[1] = 6;

  const thread = {
    id: 0,
    name: 'debug-jit-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  thread.callStack.push(frame);
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  jvm.enableDebugMode();

  await jvm.executeTick();

  t.equal(jvm.jit.generatedRunCount, 0, 'generated JIT should not run in debug mode');
  t.equal(jvm.jit.runnerRunCount, 0, 'bytecode-runner JIT should not run in debug mode');
  t.ok(thread.callStack.size() > 0, 'one debug tick should not finish the whole method');
  t.equal(out[0], 0, 'one debug tick should not run through later stores');
  t.end();
});

test('debug continue only deopts classes that own breakpoints', async (t) => {
  const classpath = compileJavaFixture(t, 'SelectiveDeoptHarness', `
public class SelectiveDeoptHarness {
  public static void compute(int[] out, int a) {
    double x = (double) a + 2.0;
    out[0] = (int) x;
  }
}

class SelectiveOtherHotClass {
  public static void compute(int[] out, int a) {
    double x = (double) a + 3.0;
    out[0] = (int) x;
  }
}
`);

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 0 } });
  await jvm.loadClassByName('SelectiveDeoptHarness');
  await jvm.loadClassByName('SelectiveOtherHotClass');
  const thread = {
    id: 0,
    name: 'selective-deopt-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  jvm.enableDebugMode();
  jvm.debugManager.setRunMode('continuing');
  jvm.debugManager.addBreakpoint(3, { className: 'SelectiveDeoptHarness' });

  const otherOut = [0];
  otherOut.type = '[I';
  otherOut.length = 1;
  otherOut.hashCode = jvm.nextHashCode++;
  await invoke(jvm, thread, 'SelectiveOtherHotClass', 'compute', '([II)V', [otherOut, 4]);

  t.deepEqual(otherOut.slice(0, 1), [7], 'non-breakpointed class should execute correctly');
  t.ok(jvm.jit.generatedRunCount > 0, 'non-breakpointed class should still use generated JIT');

  const generatedAfterOther = jvm.jit.generatedRunCount;
  const runnerAfterOther = jvm.jit.runnerRunCount;
  const deoptedOut = [0];
  deoptedOut.type = '[I';
  deoptedOut.length = 1;
  deoptedOut.hashCode = jvm.nextHashCode++;
  await invoke(jvm, thread, 'SelectiveDeoptHarness', 'compute', '([II)V', [deoptedOut, 4]);

  t.deepEqual(deoptedOut.slice(0, 1), [6], 'breakpointed class should execute correctly');
  t.equal(jvm.jit.generatedRunCount, generatedAfterOther, 'breakpointed class should not use generated JIT');
  t.equal(jvm.jit.runnerRunCount, runnerAfterOther, 'breakpointed class should not use bytecode-runner JIT');
  t.end();
});

test('JIT routes thrown Java exceptions through exception tables', async (t) => {
  const classpath = compileJavaFixture(t, 'JitExceptionHarness', `
public class JitExceptionHarness {
  static class Box { int value; }

  public static void catchDivide(int[] out, int a, int b) {
    try {
      out[0] = a / b;
    } catch (ArithmeticException e) {
      out[0] = 42;
    }

    double x = (double) a + 1.0;
    out[1] = (int) x;
  }

  public static void catchNull(int[] out, Box box) {
    try {
      out[0] = box.value;
    } catch (NullPointerException e) {
      out[0] = 77;
    }
    double x = 3.0;
    out[1] = (int) x;
  }

  public static void catchExplicit(int[] out, RuntimeException failure) {
    try {
      if (failure != null) throw failure;
    } catch (RuntimeException e) {
      out[0] = 91;
    }
    for (int i = 1; i < out.length; i++) out[i] = i + 10;
  }
}
`);

  const jvm = new JVM({
    classpath,
    jit: { warmupThreshold: 0, experimentalControlFlow: true },
  });
  await jvm.loadClassByName('JitExceptionHarness');
  const thread = {
    id: 0,
    name: 'jit-exception-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;

  const out = [0, 0];
  out.type = '[I';
  out.length = 2;
  out.hashCode = jvm.nextHashCode++;

  await invoke(jvm, thread, 'JitExceptionHarness', 'catchDivide', '([III)V', [out, 10, 0]);

  t.deepEqual(out.slice(0, 2), [42, 11], 'JIT exception should be caught and execution should continue');
  const nullOut = [0, 0];
  nullOut.type = '[I';
  nullOut.length = 2;
  nullOut.hashCode = jvm.nextHashCode++;
  await invoke(jvm, thread, 'JitExceptionHarness', 'catchNull',
    '([ILJitExceptionHarness$Box;)V', [nullOut, null]);
  t.deepEqual(nullOut.slice(0, 2), [77, 3],
    'generated getfield should throw a catchable JVM NullPointerException');
  const explicitOut = [0, 0];
  explicitOut.type = '[I';
  explicitOut.length = 2;
  explicitOut.hashCode = jvm.nextHashCode++;
  await invoke(jvm, thread, 'JitExceptionHarness', 'catchExplicit',
    '([ILjava/lang/RuntimeException;)V', [explicitOut, { type: 'java/lang/RuntimeException' }]);
  t.deepEqual(explicitOut.slice(0, 2), [91, 11],
    'generated athrow should route through the method exception table');
  t.ok(jvm.jit.generatedRunCount > 0, 'exception test should exercise generated code');
  t.end();
});

test('generated JIT derives leaf exception and monitor control flow from bytecodes', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedRejectHarness', `
public class GeneratedRejectHarness implements Runnable {
  static class Box {
    int value;
  }

  public static void compute(int[] out) {
    synchronized (out) {
      Box box = new Box();
      box.value = 7;
      double x = 2.0 + 3.0;
      out[0] = box.value + (int) x;
    }
  }

  public static int leafWrapped(int value, int divisor) {
    try {
      return value / divisor;
    } catch (RuntimeException failure) {
      throw new IllegalStateException(failure);
    }
  }

  public static void leafSynchronized(int[] out) {
    synchronized (out) {
      for (int i = 0; i < out.length; i++) out[i] += 2;
    }
  }

  public void run() {
    int[] out = new int[2];
    synchronized (out) {
      for (int i = 0; i < out.length; i++) out[i]++;
    }
  }
}
`);

  const safeJvm = new JVM({ classpath, jit: { warmupThreshold: 0 } });
  await safeJvm.loadClassByName('GeneratedRejectHarness');
  const safeMethod = await safeJvm.findMethodInHierarchy('GeneratedRejectHarness', 'compute', '([I)V');
  t.notOk(safeJvm.jit.isCodegenSupported(safeMethod),
    'normal-flow constructor calls keep effectful control flow interpreted');
  const leafWrappedMethod = await safeJvm.findMethodInHierarchy(
    'GeneratedRejectHarness', 'leafWrapped', '(II)I');
  t.ok(safeJvm.jit.isCodegenSupported(leafWrappedMethod),
    'an invoke reachable only from the exception handler does not reject a leaf body');
  const leafSynchronizedMethod = await safeJvm.findMethodInHierarchy(
    'GeneratedRejectHarness', 'leafSynchronized', '([I)V');
  t.ok(safeJvm.jit.isCodegenSupported(leafSynchronizedMethod),
    'a leaf synchronized numeric loop is derived without a signature allowlist');
  const safeRunMethod = await safeJvm.findMethodInHierarchy('GeneratedRejectHarness', 'run', '()V');
  t.ok(safeJvm.jit.isCodegenSupported(safeRunMethod),
    'an ordinary run name does not override bytecode capability checks');

  const experimentalJvm = new JVM({
    classpath,
    jit: { warmupThreshold: 0, experimentalControlFlow: true },
  });
  await experimentalJvm.loadClassByName('GeneratedRejectHarness');
  const experimentalMethod = await experimentalJvm.findMethodInHierarchy(
    'GeneratedRejectHarness', 'compute', '([I)V');
  t.ok(experimentalJvm.jit.isCodegenSupported(experimentalMethod),
    'capability gate enables supported bytecodes without naming the method');
  const experimentalRunMethod = await experimentalJvm.findMethodInHierarchy(
    'GeneratedRejectHarness', 'run', '()V');
  t.ok(experimentalJvm.jit.isCodegenSupported(experimentalRunMethod),
    'the explicit gate remains compatible with the structurally supported body');
  t.end();
});

test('repeated constructor callers promote adaptively with safe forwarding constructors', async (t) => {
  const classpath = compileJavaFixture(t, 'AdaptiveConstructorCallerHarness', `
public class AdaptiveConstructorCallerHarness {
  static class Box {
    int value;
  }

  static class ComplexBox {
    int[][][] values = new int[2][2][4];
  }

  public static void compute(int[] out, int value) {
    Box box = new Box();
    box.value = value;
    out[0] = box.value * 3;
  }

  public static ComplexBox complex() {
    return new ComplexBox();
  }

  static int read(Box box) {
    return box.value;
  }

  public static void guarded(int[] out, Box box) {
    try {
      out[0] = read(box) * 5;
    } catch (RuntimeException failure) {
      if (out.length == 0) throw failure;
      out[0] = 91;
    }
  }
}
`);
  const jvm = new JVM({
    classpath,
    jit: {
      warmupThreshold: 0,
      preferWholeMethodJs: true,
      adaptiveConstructorCallers: true,
      adaptiveCodegenThreshold: 2,
    },
  });
  await jvm.loadClassByName('AdaptiveConstructorCallerHarness');
  await jvm.loadClassByName('AdaptiveConstructorCallerHarness$Box');
  const thread = {
    id: 0, name: 'adaptive-constructor-caller', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const method = await jvm.findMethodInHierarchy(
    'AdaptiveConstructorCallerHarness', 'compute', '([II)V');
  t.notOk(jvm.jit.isCodegenSupported(method),
    'a cold constructor caller retains the interpreted policy');
  t.ok(jvm.jit.isCodegenSupported(method, true),
    'the alternate capability check accepts its supported bytecodes');

  const out = [0];
  out.type = '[I';
  await invoke(jvm, thread, 'AdaptiveConstructorCallerHarness', 'compute',
    '([II)V', [out, 4]);
  t.notOk(jvm.jit.adaptiveCodegenMethods.has(method),
    'one cold entry does not trigger compilation');
  await invoke(jvm, thread, 'AdaptiveConstructorCallerHarness', 'compute',
    '([II)V', [out, 7]);
  t.ok(jvm.jit.adaptiveCodegenMethods.has(method),
    'the structural caller promotes after the configured entry threshold');
  t.ok(jvm.jit.codegenCache.get(method),
    'the promoted caller has generated code');
  t.equal(out[0], 21, 'promotion preserves allocation, field, and array effects');
  const constructor = await jvm.findMethodInHierarchy(
    'AdaptiveConstructorCallerHarness$Box', '<init>', '()V');
  t.ok(jvm.jit.isJitSafeConstructor(constructor),
    'the exact forwarding constructor satisfies the generic safety proof');
  t.ok(jvm.jit.isCodegenSupported(constructor, true),
    'a forwarding constructor does not create an interpreted boundary');

  await jvm.loadClassByName('AdaptiveConstructorCallerHarness$ComplexBox');
  const complex = await jvm.findMethodInHierarchy(
    'AdaptiveConstructorCallerHarness', 'complex',
    '()LAdaptiveConstructorCallerHarness$ComplexBox;');
  const complexConstructor = await jvm.findMethodInHierarchy(
    'AdaptiveConstructorCallerHarness$ComplexBox', '<init>', '()V');
  t.ok(jvm.jit.isJitSafeConstructor(complexConstructor),
    'a linear multidimensional-array field initializer satisfies the safety proof');
  t.ok(jvm.jit.isCodegenSupported(complexConstructor, true),
    'the verified array initializer can execute synchronously');
  t.ok(jvm.jit.isCodegenSupported(complex, true),
    'its caller no longer needs an interpreted constructor boundary');

  const guarded = await jvm.findMethodInHierarchy(
    'AdaptiveConstructorCallerHarness', 'guarded',
    '([ILAdaptiveConstructorCallerHarness$Box;)V');
  t.notOk(jvm.jit.isCodegenSupported(guarded),
    'a cold call-bearing throw/recovery body retains the conservative policy');
  t.ok(jvm.jit.isCodegenSupported(guarded, true),
    'adaptive capability accepts its verified non-monitor control flow');
  await invoke(jvm, thread, 'AdaptiveConstructorCallerHarness', 'guarded',
    '([ILAdaptiveConstructorCallerHarness$Box;)V', [out, null]);
  await invoke(jvm, thread, 'AdaptiveConstructorCallerHarness', 'guarded',
    '([ILAdaptiveConstructorCallerHarness$Box;)V', [out, null]);
  t.ok(jvm.jit.adaptiveCodegenMethods.has(guarded),
    'the effectful caller also promotes by entry heat');
  t.equal(out[0], 91,
    'an exception from a generated child resumes the original recovery handler');
  t.end();
});

test('linear array-initializer constructor callers compile generically', async (t) => {
  const classpath = compileJavaFixture(t, 'AdaptiveComplexConstructorHarness', `
public class AdaptiveComplexConstructorHarness {
  static class ComplexBox {
    int[][][] values = new int[2][2][4];
  }

  ComplexBox box;

  public void build(int[] out) {
    int sum = 0;
    for (int i = 0; i < out.length; i++) sum += out[i];
    box = new ComplexBox();
    out[0] = sum;
  }
}
`);
  const jvm = new JVM({
    classpath,
    jit: {
      preferWholeMethodJs: true,
      adaptiveConstructorCallers: true,
      adaptiveCodegenThreshold: 4,
    },
  });
  jvm.jit.wasmJit.enabled = false;
  await jvm.loadClassByName('AdaptiveComplexConstructorHarness');
  await jvm.loadClassByName('AdaptiveComplexConstructorHarness$ComplexBox');
  const thread = {
    id: 0, name: 'adaptive-complex-constructor', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const owner = jvm.jit.allocateObject('AdaptiveComplexConstructorHarness');
  const buildMethod = await jvm.findMethodInHierarchy(
    'AdaptiveComplexConstructorHarness', 'build', '([I)V');
  const out = jvm.jit.newPrimitiveArray(4, 'int');
  out[0] = 1;
  out[1] = 2;
  out[2] = 3;
  out[3] = 4;

  for (let invocation = 0; invocation < 8; invocation += 1) {
    await invoke(jvm, thread, 'AdaptiveComplexConstructorHarness', 'build',
      '([I)V', [owner, out]);
    t.equal(out[0], 10 + invocation * 9,
      `constructor receiver and array result survive invocation ${invocation + 1}`);
    t.ok(owner.fields['AdaptiveComplexConstructorHarness.box']
      .fields['AdaptiveComplexConstructorHarness$ComplexBox.values'],
    `constructor field initialization survives invocation ${invocation + 1}`);
  }

  t.ok(jvm.jit.adaptiveCodegenMethods.has(buildMethod),
    'the hot caller promotes after its constructor is proven synchronous');
  t.notOk(jvm.jit.structuredOnlyCodegenMethods.has(buildMethod),
    'the proof does not rely on unsafe structured-only admission');
  t.ok(jvm.jit.codegenCache.get(buildMethod),
    'the verified caller compiles a generated body');
  t.end();
});

test('structured SSA preserves instanceof and cold class resolution', async (t) => {
  const classpath = compileJavaFixture(t, 'StructuredInstanceofHarness', `
public class StructuredInstanceofHarness {
  static class Marker {}

  public static void count(Object value, int[] out) {
    int result = 0;
    for (int index = 0; index < 8; index++) {
      if (value instanceof Marker) result++;
    }
    out[0] = result;
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    preferWholeMethodJs: true,
    rendererPipeline: true,
    structuredSsa: true,
  } });
  jvm.jit.wasmJit.enabled = false;
  await jvm.loadClassByName('StructuredInstanceofHarness');
  jvm.classInitializationState.set(
    'StructuredInstanceofHarness', 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    'StructuredInstanceofHarness', 'count', '(Ljava/lang/Object;[I)V');
  const thread = {
    id: 0, name: 'structured-instanceof', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;

  const out = jvm.jit.newPrimitiveArray(1, 'int');
  await invoke(jvm, thread, 'StructuredInstanceofHarness', 'count',
    '(Ljava/lang/Object;[I)V', [null, out]);
  t.equal(out[0], 0,
  'null is never an instance and needs no class resolution');
  t.ok(jvm.jit.codegenCache.get(method)?.jvmStructuredSsa,
    'the loop containing instanceof compiles through structured SSA');

  const tryInstanceOfSync = jvm.jit.tryInstanceOfSync.bind(jvm.jit);
  let forcedColdFallbacks = 0;
  jvm.jit.tryInstanceOfSync = (...args) => {
    if (forcedColdFallbacks++ === 0) return jvm.jit.asyncInvokeSentinel();
    return tryInstanceOfSync(...args);
  };
  const plainObject = jvm.jit.allocateObject('java/lang/Object');
  await invoke(jvm, thread, 'StructuredInstanceofHarness', 'count',
    '(Ljava/lang/Object;[I)V', [plainObject, out]);
  t.equal(out[0], 0,
  'cold target resolution resumes with the correct false result');
  t.ok(forcedColdFallbacks > 0,
    'the structured path exercised its exact-PC cold fallback');

  const marker = jvm.jit.allocateObject(
    'StructuredInstanceofHarness$Marker');
  await invoke(jvm, thread, 'StructuredInstanceofHarness', 'count',
    '(Ljava/lang/Object;[I)V', [marker, out]);
  t.equal(out[0], 8,
  'the warm structured path preserves the true result on every iteration');
  t.end();
});

test('verified loop constructors and their trivial superclass chain use whole-method codegen', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedLoopConstructorHarness', `
public class GeneratedLoopConstructorHarness {
  static class Base {
  }

  static class Values extends Base {
    int sum;

    Values(int limit) {
      for (int i = 0; i < limit; i++) sum += i;
    }
  }

  static class RethrowingValues extends Base {
    int sum;

    RethrowingValues(int[] values) {
      for (int i = 0; i < values.length; i++) {
        try {
          sum += values[i];
        } catch (RuntimeException error) {
          throw error;
        }
      }
    }
  }

  static class ProtectedCallingValues extends Base {
    int sum;

    int read(int[] values, int index) {
      return values[index];
    }

    ProtectedCallingValues(int[] values) {
      for (int i = 0; i < values.length; i++) {
        try {
          sum += read(values, i);
        } catch (RuntimeException error) {
          throw error;
        }
      }
    }
  }

  static class ReferenceValues extends Base {
    int count;

    ReferenceValues(Object[] values) {
      for (int i = 0; i < values.length; i++) {
        if (values[i] != null) count++;
      }
    }

    static int count(Object[] values) {
      int result = 0;
      for (int i = 0; i < values.length; i++) {
        if (values[i] != null) result++;
      }
      return result;
    }
  }

  static class NestedAllocation extends Base {
    Object marker;

    NestedAllocation(int limit) {
      marker = new Object();
      for (int i = 0; i < limit; i++) {
        if (marker == null) throw new AssertionError();
      }
    }
  }

  static class WrappedAssignment extends Base {
    Object value;

    WrappedAssignment(Object value) {
      try {
        this.value = value;
      } catch (RuntimeException error) {
        throw new IllegalStateException(error);
      }
    }
  }
}
`);
  const jvm = new JVM({
    classpath,
    jit: {
      warmupThreshold: 0,
      preferWholeMethodJs: true,
      rendererPipeline: true,
      hotLoopConstructors: true,
    },
  });
  await jvm.loadClassByName('GeneratedLoopConstructorHarness$Values');
  await jvm.loadClassByName('GeneratedLoopConstructorHarness$Base');
  const thread = {
    id: 0, name: 'generated-loop-constructor', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;

  const constructor = await jvm.findMethodInHierarchy(
    'GeneratedLoopConstructorHarness$Values', '<init>', '(I)V');
  const forwardingConstructor = await jvm.findMethodInHierarchy(
    'GeneratedLoopConstructorHarness$Base', '<init>', '()V');
  t.ok(jvm.jit.isJitSafeConstructor(constructor),
    'a loop body with one leading direct-super initializer is admitted');
  t.ok(jvm.jit.isJitSafeConstructor(forwardingConstructor),
    'the exact direct-super forwarding constructor is admitted');
  t.ok(jvm.jit.isCodegenSupported(constructor),
    'the loop constructor is eligible for whole-method JavaScript');
  t.ok(jvm.jit.isCodegenSupported(forwardingConstructor),
    'its forwarding superclass does not force an interpreted boundary');

  const receiver = jvm.jit.allocateObject(
    'GeneratedLoopConstructorHarness$Values');
  await invoke(jvm, thread, 'GeneratedLoopConstructorHarness$Values',
    '<init>', '(I)V', [receiver, 100]);
  t.equal(receiver.fields['GeneratedLoopConstructorHarness$Values.sum'], 4950,
    'generated constructor preserves superclass and loop field effects');
  t.ok(jvm.jit.codegenCache.get(constructor)?.jvmStructuredSsa,
    'the hot constructor uses the structured SSA body');
  t.ok(jvm.jit.codegenCache.get(forwardingConstructor)?.jvmStructuredSsa,
    'the superclass forwarding call stays generated');
  t.notOk(jvm.jit.codegenCache.get(constructor)
    ?.jvmRestoringDirectPositionalBody,
  'a constructor never publishes an omitted-frame restoring ABI');
  t.notOk(jvm.jit.codegenCache.get(constructor)?.jvmFramelessPositional,
    'constructor initialization remains visible to canonical scheduling');

  await jvm.loadClassByName(
    'GeneratedLoopConstructorHarness$WrappedAssignment');
  const wrappedConstructor = await jvm.findMethodInHierarchy(
    'GeneratedLoopConstructorHarness$WrappedAssignment', '<init>',
    '(Ljava/lang/Object;)V');
  t.ok(jvm.jit.isJitSafeConstructor(wrappedConstructor),
    'an exception-wrapped normal path of direct this-field assignments is admitted');
  t.ok(jvm.jit.isCodegenSupported(wrappedConstructor),
    'the narrowly proven wrapped field initializer can use generated JavaScript');
  const wrappedReceiver = jvm.jit.allocateObject(
    'GeneratedLoopConstructorHarness$WrappedAssignment');
  const wrappedValue = jvm.jit.allocateObject('java/lang/Object');
  await invoke(jvm, thread,
    'GeneratedLoopConstructorHarness$WrappedAssignment', '<init>',
    '(Ljava/lang/Object;)V', [wrappedReceiver, wrappedValue]);
  t.equal(wrappedReceiver.fields[
    'GeneratedLoopConstructorHarness$WrappedAssignment.value'], wrappedValue,
  'the generated wrapped constructor preserves its field assignment');
  t.ok(jvm.jit.codegenCache.get(wrappedConstructor)?.jvmStructuredSsa,
    'the wrapped constructor retains the initialization-safe structured body');

  await jvm.loadClassByName(
    'GeneratedLoopConstructorHarness$RethrowingValues');
  const rethrowingConstructor = await jvm.findMethodInHierarchy(
    'GeneratedLoopConstructorHarness$RethrowingValues', '<init>', '([I)V');
  const rethrowingItems = jvm.jit.getCodeItems(rethrowingConstructor);
  t.ok(rethrowingConstructor.attributes.find((attribute) =>
    attribute.type === 'code').code.exceptionTable.length > 0,
  'the fixture retains a protected constructor loop');
  t.ok(jvm.jit.hasOnlyNoOpExceptionHandlers(
    rethrowingConstructor, rethrowingItems),
  'its handlers are structurally proven to only rethrow');
  t.ok(jvm.jit.isJitSafeConstructor(rethrowingConstructor),
    'a protected loop constructor with rethrow-only handlers is admitted');
  t.ok(jvm.jit.isCodegenSupported(rethrowingConstructor),
    'the protected constructor can use whole-method JavaScript');
  const rethrowingReceiver = jvm.jit.allocateObject(
    'GeneratedLoopConstructorHarness$RethrowingValues');
  await invoke(jvm, thread,
    'GeneratedLoopConstructorHarness$RethrowingValues', '<init>', '([I)V',
    [rethrowingReceiver, [3, 5, 7, 11]]);
  t.equal(rethrowingReceiver.fields[
    'GeneratedLoopConstructorHarness$RethrowingValues.sum'], 26,
  'the generated protected constructor preserves its loop effects');
  t.ok(jvm.jit.codegenCache.get(rethrowingConstructor)?.jvmStructuredSsa,
    'the protected constructor executes through structured SSA');
  const coldBaseline = jvm.jit.compileBaselineMethod(rethrowingConstructor);
  t.notOk(coldBaseline.jvmStructuredSsa,
    'a cold baseline body represents compilation before dependencies settle');
  jvm.jit.codegenCache.set(rethrowingConstructor, coldBaseline);
  jvm.jit.invocationCounts.set(rethrowingConstructor, 8);
  const coldConstructorEntry = jvm.jit.getGeneratedFunction(
    rethrowingConstructor);
  t.equal(coldConstructorEntry, coldBaseline,
    'the active call retains its stable baseline entry during promotion');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const upgradedConstructor = jvm.jit.codegenCache.get(
    rethrowingConstructor);
  t.ok(upgradedConstructor?.jvmStructuredSsa,
    'a hot protected loop constructor upgrades at a JavaScript safe point');
  t.equal(jvm.jit.structuredConstructorUpgradeCount, 1,
    'the successful structural upgrade is recorded once');

  const positionalBaseline = jvm.jit.compileBaselineMethod(
    rethrowingConstructor);
  const positionalBody = () => undefined;
  const compileStructured = jvm.jit.structuredSsa.compile;
  jvm.jit.structuredSsa.compile = () => ({
    jvmStructuredSsa: true,
    jvmStructuredRequiresBaselineFramedEntry: true,
    jvmStructuredContinuation: true,
    jvmRestoringDirectPositionalBody: positionalBody,
    jvmRestoringDirectPositionalSource: 'return undefined;',
  });
  jvm.jit.codegenCache.set(rethrowingConstructor, positionalBaseline);
  jvm.jit.structuredConstructorRetryState.delete(rethrowingConstructor);
  jvm.jit.invocationCounts.set(rethrowingConstructor, 8);
  const upgradedPositionalConstructor = jvm.jit.getGeneratedFunction(
    rethrowingConstructor);
  await new Promise((resolve) => setTimeout(resolve, 0));
  jvm.jit.structuredSsa.compile = compileStructured;
  t.equal(upgradedPositionalConstructor, positionalBaseline,
    'the active protected call retains its baseline frame entry');
  const upgradedPositionalCache = jvm.jit.codegenCache.get(
    rethrowingConstructor);
  t.equal(upgradedPositionalCache.jvmRestoringDirectPositionalBody,
    positionalBody,
  'the safe-point upgrade augments its structured positional entry');
  t.equal(jvm.jit.structuredConstructorUpgradeCount, 2,
    'the positional structural upgrade is recorded once');

  const publishedMethod = {
    name: 'arbitraryTieredLeaf', descriptor: '()I', flags: ['static'],
  };
  const oldGenerated = { jvmSynchronous: true };
  const newGenerated = {
    jvmSynchronous: true,
    jvmDirectPositionalBody: () => 41,
  };
  const oldInvoker = () => 7;
  const publishedTarget = {
    method: publishedMethod,
    lookupClass: 'ArbitraryTierOwner',
    generated: oldGenerated,
    positionalInvoker: oldInvoker,
  };
  const publishedSite = {
    op: 'invokestatic', descriptor: '()I', params: [], returnType: 'int',
    initializationToken: { initialized: true },
    fastStaticTarget: publishedTarget,
    fastPositional: { invoke: oldInvoker },
  };
  jvm.jit.trackGeneratedTarget(
    publishedMethod, publishedTarget, publishedSite);
  jvm.jit.publishGeneratedTargetUpgrade(publishedMethod, newGenerated);
  t.equal(publishedTarget.generated, newGenerated,
    'tier-up publication replaces a linked target body');
  t.notEqual(publishedSite.fastPositional.invoke, oldInvoker,
    'tier-up publication replaces a linked positional call entry');
  t.equal(publishedSite.fastPositional.invoke(), 41,
    'future callers execute the upgraded scalar body');
  t.equal(jvm.jit.generatedTargetUpgradePublicationCount, 1,
    'published target upgrades are counted');

  await jvm.loadClassByName(
    'GeneratedLoopConstructorHarness$ProtectedCallingValues');
  const protectedCallingConstructor = await jvm.findMethodInHierarchy(
    'GeneratedLoopConstructorHarness$ProtectedCallingValues', '<init>',
    '([I)V');
  const protectedCallingStructured = jvm.jit.structuredSsa.compile(
    protectedCallingConstructor);
  t.notOk(protectedCallingStructured?.jvmStructuredRequiresBaselineFramedEntry,
    'a protected non-void child call retains an exact structured continuation');
  t.notOk(protectedCallingStructured.jvmRestoringDirectPositionalBody,
    'a protected constructor retains a canonical initialization frame');
  const protectedCallingSelected = jvm.jit.compileMethod(
    protectedCallingConstructor);
  t.notOk(protectedCallingSelected.jvmRestoringDirectPositionalBody,
    'tier selection does not republish an omitted constructor frame');

  await jvm.loadClassByName(
    'GeneratedLoopConstructorHarness$ReferenceValues');
  const referenceConstructor = await jvm.findMethodInHierarchy(
    'GeneratedLoopConstructorHarness$ReferenceValues', '<init>',
    '([Ljava/lang/Object;)V');
  const referenceStructured = jvm.jit.structuredSsa.compile(
    referenceConstructor);
  t.notOk(referenceStructured?.jvmRestoringDirectPositionalBody,
    'reference-array constructor loops remain structured but frame-backed');
  const referenceCounter = await jvm.findMethodInHierarchy(
    'GeneratedLoopConstructorHarness$ReferenceValues', 'count',
    '([Ljava/lang/Object;)I');
  const referenceCounterStructured = jvm.jit.structuredSsa.compile(
    referenceCounter);
  t.equal(referenceCounterStructured?.jvmRestoringDirectPositionalBody, null,
    'a scalar method keeps ordinary reference-array loads frame-backed');

  await jvm.loadClassByName(
    'GeneratedLoopConstructorHarness$NestedAllocation');
  const nested = await jvm.findMethodInHierarchy(
    'GeneratedLoopConstructorHarness$NestedAllocation', '<init>', '(I)V');
  t.notOk(jvm.jit.isJitSafeConstructor(nested),
    'a constructor containing another object initialization is rejected');
  t.notOk(jvm.jit.isCodegenSupported(nested),
    'the rejected constructor retains canonical interpreted execution');

  const disabledJvm = new JVM({
    classpath,
    jit: {
      preferWholeMethodJs: true,
      rendererPipeline: true,
      hotLoopConstructors: false,
    },
  });
  await disabledJvm.loadClassByName(
    'GeneratedLoopConstructorHarness$Values');
  const disabledConstructor = await disabledJvm.findMethodInHierarchy(
    'GeneratedLoopConstructorHarness$Values', '<init>', '(I)V');
  t.notOk(disabledJvm.jit.isCodegenSupported(disabledConstructor),
    'the runtime capability switch restores the previous constructor policy');
  t.end();
});

test('a long one-shot constructor caller promotes by sampled elapsed time', async (t) => {
  const classpath = compileJavaFixture(t, 'AdaptiveOneShotCallerHarness', `
public class AdaptiveOneShotCallerHarness {
  static class Box {
    int value;
  }

  public static void compute(int[] out, int length) {
    Box box = new Box();
    for (int i = 0; i < length; i++) box.value += i;
    out[0] = box.value;
  }
}
`);
  const jvm = new JVM({
    classpath,
    jit: {
      warmupThreshold: 100,
      preferWholeMethodJs: false,
      adaptiveConstructorCallers: true,
      adaptiveCodegenThreshold: 100,
      adaptiveCodegenTimeThresholdMs: 5,
      adaptiveCodegenTimeSampleInterval: 2,
      profileMethods: true,
    },
  });
  await jvm.loadClassByName('AdaptiveOneShotCallerHarness');
  const thread = {
    id: 0, name: 'adaptive-one-shot-caller', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const method = await jvm.findMethodInHierarchy(
    'AdaptiveOneShotCallerHarness', 'compute', '([II)V');
  t.notOk(jvm.jit.prefersWholeMethodJs(method),
    'the Wasm-first policy does not start in whole-method mode');
  let now = 0;
  jvm.jit.monotonicNow = () => {
    now += 10;
    return now;
  };

  const out = [0];
  out.type = '[I';
  await invoke(jvm, thread, 'AdaptiveOneShotCallerHarness', 'compute',
    '([II)V', [out, 100]);

  t.ok(jvm.jit.adaptiveCodegenMethods.has(method),
    'elapsed execution promotes the first invocation without entry heat');
  t.ok(jvm.jit.prefersWholeMethodJs(method),
    'the hot method selects whole-method JS after promotion');
  t.equal(jvm.jit.adaptiveTimePromotionCount, 1,
    'promotion is attributed to the sampled time policy');
  t.equal(jvm.jit.adaptiveEntryPromotionCount, 0,
    'the high entry threshold did not cause promotion');
  t.ok(jvm.jit.generatedRunCount > 0,
    'the in-flight frame resumes in generated JavaScript');
  t.equal(out[0], 4950,
    'mid-method OSR preserves the partially executed frame and effects');

  const wasmJvm = new JVM({
    classpath,
    jit: {
      preferWholeMethodJs: false,
      adaptiveConstructorCallers: true,
      adaptiveCodegenTimeThresholdMs: 1,
      adaptiveCodegenTimeSampleInterval: 1,
    },
  });
  await wasmJvm.loadClassByName('AdaptiveOneShotCallerHarness');
  const wasmMethod = await wasmJvm.findMethodInHierarchy(
    'AdaptiveOneShotCallerHarness', 'compute', '([II)V');
  const wasmFrame = new Frame(wasmMethod);
  wasmFrame.className = 'AdaptiveOneShotCallerHarness';
  const wasmThread = {
    id: 0, name: 'adaptive-wasm-preference', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  wasmJvm.jit.wasmJit.enabled = true;
  wasmJvm.jit.wasmJit.tryRunFrame = () =>
    ({ handled: true, returned: true });
  const wasmResult = wasmJvm.jit.tryRunFrame(wasmFrame, wasmThread);
  t.ok(wasmResult.handled,
    'a fully handled Wasm entry retains tier priority');
  t.equal(wasmJvm.jit.adaptiveTimePromotionCount, 0,
    'handled Wasm execution does not accumulate JavaScript residency heat');
  t.notOk(wasmJvm.jit.prefersWholeMethodJs(wasmMethod),
    'the adaptive policy does not steal a method handled by Wasm');

  const defaultEscalationJvm = new JVM({ jit: {
    preferWholeMethodJs: false,
  } });
  defaultEscalationJvm.jit.promoteAdaptiveCodegen({});
  t.ok(defaultEscalationJvm.jit.preferWholeMethodJs,
    'one independently hot JavaScript method stops ordinary partial-Wasm probes');

  const escalationJvm = new JVM({ jit: {
    preferWholeMethodJs: false,
    adaptiveWholeMethodEscalationThreshold: 2,
  } });
  const firstHotMethod = {};
  const secondHotMethod = {};
  escalationJvm.jit.promoteAdaptiveCodegen(firstHotMethod);
  escalationJvm.jit.promoteAdaptiveCodegen(firstHotMethod);
  t.notOk(escalationJvm.jit.preferWholeMethodJs,
    'duplicate observations of one method do not escalate the application');
  escalationJvm.jit.promoteAdaptiveCodegen(secondHotMethod);
  t.ok(escalationJvm.jit.preferWholeMethodJs,
    'multiple distinct safe promotions escalate the tier policy');
  t.equal(escalationJvm.jit.adaptiveWholeMethodEscalationCount, 1,
    'application-wide escalation occurs at most once');
  t.end();
});

test('generated JIT preserves verifier-derived dup_x2 stack forms', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedDupX2Harness', `
public class GeneratedDupX2Harness {
  public static void compute(Object[][] out, int[] result, int index, int length) {
    Object[] value = out[index] = new Object[length + 1];
    result[0] = value.length;
  }
}
`);
  const jvm = new JVM({
    classpath,
    jit: {
      warmupThreshold: 0,
      preferWholeMethodJs: true,
      profileMethods: true,
    },
  });
  await jvm.loadClassByName('GeneratedDupX2Harness');
  const method = await jvm.findMethodInHierarchy(
    'GeneratedDupX2Harness', 'compute', '([[Ljava/lang/Object;[III)V');
  const ops = jvm.jit.getCodeItems(method)
    .map((item) => typeof item.instruction === 'string'
      ? item.instruction : item.instruction && item.instruction.op);
  t.ok(ops.includes('dup_x2'),
    'fixture contains the stack shape that blocked the large asset method');
  t.ok(jvm.jit.isCodegenSupported(method),
    'eligibility follows verified opcodes rather than a guest method identity');

  const thread = {
    id: 0, name: 'generated-dup-x2', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [null, null];
  out.type = '[[Ljava/lang/Object;';
  const result = [0];
  result.type = '[I';
  await invoke(jvm, thread, 'GeneratedDupX2Harness', 'compute',
    '([[Ljava/lang/Object;[III)V', [out, result, 1, 4]);

  t.equal(result[0], 5, 'generated dup_x2 preserves the assigned array value');
  t.equal(out[1].length, 5, 'generated dup_x2 preserves array/index/value order');
  t.ok(jvm.jit.generatedRunCount > 0,
    'the verified stack form executes in generated JavaScript');
  t.end();
});

test('generated JIT preserves verifier-derived dup2_x2 long array updates',
  async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedDup2X2Harness', `
public final class GeneratedDup2X2Harness {
  static long update(long[] values, int index, long mask) {
    long assigned = values[index] = mask;
    return assigned;
  }
}
`);
  const jvm = new JVM({
    classpath,
    jit: {
      warmupThreshold: 0,
      preferWholeMethodJs: true,
      profileMethods: true,
    },
  });
  await jvm.loadClassByName('GeneratedDup2X2Harness');
  const method = await jvm.findMethodInHierarchy(
    'GeneratedDup2X2Harness', 'update', '([JIJ)J');
  const ops = jvm.jit.getCodeItems(method)
    .map((item) => typeof item.instruction === 'string'
      ? item.instruction : item.instruction && item.instruction.op);
  t.ok(ops.includes('dup2_x2'),
    'fixture contains javac long-array compound-assignment shuffling');
  t.ok(jvm.jit.isCodegenSupported(method),
    'the category-aware verifier admits the arbitrary method');

  const values = [0x123456789abcdef0n, 7n];
  values.type = '[J';
  const thread = {
    id: 0, name: 'generated-dup2-x2', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  await invoke(jvm, thread, 'GeneratedDup2X2Harness', 'update',
    '([JIJ)J', [values, 0, 0x00ff00ff00ff00ffn]);
  t.equal(values[0], 0x00ff00ff00ff00ffn,
    'generated dup2_x2 preserves array, index, and long value order');
  t.ok(jvm.jit.generatedRunCount > 0,
    'the verified long-array stack form executes in generated JavaScript');
  t.end();
});

test('structured SSA preserves verified category-one dup2 aliases', async (t) => {
  const classpath = compileJavaFixture(t, 'RenamedDup2AliasHarness', `
public final class RenamedDup2AliasHarness {
  static void change(int[] values, int delta) {
    for (int index = 0; index < values.length; index++) {
      values[index] += delta;
    }
  }
}
`);
  const jvm = new JVM({
    classpath,
    jit: {
      warmupThreshold: 0,
      structuredSsa: true,
      preferWholeMethodJs: true,
      profileMethods: true,
    },
  });
  await jvm.loadClassByName('RenamedDup2AliasHarness');
  const method = await jvm.findMethodInHierarchy(
    'RenamedDup2AliasHarness', 'change', '([II)V');
  const ops = jvm.jit.getCodeItems(method)
    .map((item) => typeof item.instruction === 'string'
      ? item.instruction : item.instruction && item.instruction.op);
  t.ok(ops.includes('dup2'),
    'the renamed javac fixture contains a category-one dup2 pair');

  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated?.jvmStructuredSsa,
    'the arbitrary bytecode shape selects the generic structured tier: ' +
      jvm.jit.structuredSsa.lastRejectionReason);
  t.notOk(generated.jvmStructuredSource.includes('category-2 dup2'),
    'verifier widths remove the runtime BigInt category test');

  const values = [41, 7];
  values.type = '[I';
  const thread = {
    id: 0, name: 'renamed-dup2-alias', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  await invoke(jvm, thread, 'RenamedDup2AliasHarness', 'change',
    '([II)V', [values, 1]);
  t.equal(values[0], 42,
    'duplicated array and index aliases retain the exact update semantics');
  t.equal(values[1], 8,
    'every loop iteration updates its selected array element once');
  t.end();
});

test('generated post-increment helpers preserve nearby call paths', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedPostIncrementCallHarness', `
public class GeneratedPostIncrementCallHarness {
  int index;
  int calls;

  void touch() {
    calls++;
  }

  int read(byte[] values, boolean call) {
    if (call) touch();
    return values[index++];
  }
}
`);
  const jvm = new JVM({
    classpath,
    jit: {
      warmupThreshold: 0,
      preferWholeMethodJs: true,
      postIncrementHelpers: true,
      profileMethods: true,
    },
  });
  await jvm.loadClassByName('GeneratedPostIncrementCallHarness');
  const method = await jvm.findMethodInHierarchy(
    'GeneratedPostIncrementCallHarness', 'read', '([BZ)I');
  const ops = jvm.jit.getCodeItems(method)
    .map((item) => typeof item.instruction === 'string'
      ? item.instruction : item.instruction && item.instruction.op);
  t.ok(ops.includes('dup_x1') && ops.includes('invokevirtual'),
    'fixture combines javac post-increment shuffling with a call');
  t.ok(jvm.jit.isCodegenSupported(method),
    'call presence no longer excludes a verifier-safe stack operation');

  const instance = {
    type: 'GeneratedPostIncrementCallHarness',
    fields: {
      'GeneratedPostIncrementCallHarness.index': 0,
      'GeneratedPostIncrementCallHarness.calls': 0,
    },
  };
  const values = [11, 22];
  values.type = '[B';
  const thread = {
    id: 0, name: 'generated-post-increment-call', callStack: new Stack(),
    status: 'runnable', pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  await invoke(jvm, thread, 'GeneratedPostIncrementCallHarness', 'read',
    '([BZ)I', [instance, values, 0]);
  await invoke(jvm, thread, 'GeneratedPostIncrementCallHarness', 'read',
    '([BZ)I', [instance, values, 1]);

  t.equal(instance.fields['GeneratedPostIncrementCallHarness.index'], 2,
    'post-increment updates the receiver exactly once per read');
  t.equal(instance.fields['GeneratedPostIncrementCallHarness.calls'], 1,
    'the generated call branch executes exactly once');
  t.ok(jvm.jit.generatedRunCount > 0,
    'the mixed helper executes in generated JavaScript');
  t.end();
});

test('generated JIT leaves monitor-parking methods in the interpreter', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedMonitorWaitHarness', `
public class GeneratedMonitorWaitHarness {
  public static void compute(int[] out) throws InterruptedException {
    synchronized (out) {
      out.wait();
      for (int i = 0; i < out.length; i++) out[i]++;
    }
  }
}
`);

  const jvm = new JVM({
    classpath,
    jit: { warmupThreshold: 0, experimentalControlFlow: true },
  });
  await jvm.loadClassByName('GeneratedMonitorWaitHarness');
  const method = await jvm.findMethodInHierarchy('GeneratedMonitorWaitHarness', 'compute', '([I)V');

  t.notOk(jvm.jit.isCodegenSupported(method),
    'a wait while holding a monitor requires interpreter scheduler semantics');
  t.end();
});

test('generated JIT preserves monitors for structurally supported hot methods', async (t) => {
  const classpath = compileJavaFixture(t, 'GeneratedMonitorJitHarness', `
public class GeneratedMonitorJitHarness {
  public static void compute(int[] out, int value) {
    try {
      synchronized (out) {
        for (int i = 0; i < out.length; i++) out[i] += value;
      }
    } catch (RuntimeException failure) {
      throw new IllegalStateException(
        new StringBuilder().append("compute(").append(out).append(")").toString(),
        failure);
    }
  }
}
`);
  const jvm = new JVM({
    classpath,
    jit: { warmupThreshold: 0, structuredSsa: true },
  });
  await jvm.loadClassByName('GeneratedMonitorJitHarness');
  const method = await jvm.findMethodInHierarchy(
    'GeneratedMonitorJitHarness', 'compute', '([II)V');
  t.ok(jvm.jit.isCodegenSupported(method),
    'constructor calls reachable only from a monitor exception reporter do not reject the hot body');
  const structured = jvm.jit.structuredSsa.compile(method);
  t.ok(structured?.jvmStructuredSsa &&
      structured.jvmStructuredSource.includes('helpers.monitorEnter') &&
      structured.jvmStructuredSource.includes('helpers.monitorExit'),
    'explicit monitor bytecodes compile into generic structured operations');
  jvm.jit.codegenCache.set(method, structured);
  const thread = {
    id: 0,
    name: 'monitor-generated-jit-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [1, 2, 3];
  out.type = '[I';
  await invoke(jvm, thread, 'GeneratedMonitorJitHarness', 'compute', '([II)V', [out, 4]);
  t.deepEqual(out.slice(0, 3), [5, 6, 7], 'generated synchronized loop preserves results');
  t.notOk(out.isLocked, 'generated monitorexit releases the monitor');
  t.equal(out.lockOwner, null, 'released monitor clears its owner');
  t.equal(jvm.jit.generatedRunCount, 1, 'structurally supported synchronized loop uses generated code');

  const contended = [0, 0];
  contended.type = '[I';
  contended.isLocked = true;
  contended.lockOwner = 99;
  contended.lockCount = 1;
  const contendedFrame = new Frame(method);
  contendedFrame.className = 'GeneratedMonitorJitHarness';
  contendedFrame.locals.splice(0, 2, contended, 7);
  const contendedStack = new Stack();
  contendedStack.push(contendedFrame);
  const contendedThread = {
    id: 0, name: 'contended-structured-monitor', callStack: contendedStack,
    status: 'runnable', pendingException: null,
  };
  const contendedResult = structured(
    contendedFrame, contendedThread, jvm.jit, false);
  const monitorPc = jvm.jit.getCodeItems(method).findIndex((item) =>
    (item.instruction?.op || item.instruction) === 'monitorenter');
  t.ok(contendedResult?.deopt && contendedResult.transient,
    'a contended structured monitor returns to canonical scheduling');
  t.equal(contendedThread.status, 'BLOCKED',
    'monitor contention preserves the JVM blocked-thread state');
  t.equal(contendedFrame.pc, monitorPc,
    'monitor contention records the unexecuted monitorenter PC');
  t.deepEqual(contendedFrame.stack.items, [contended],
    'monitor contention reconstructs the unconsumed monitor operand');
  t.deepEqual(contended.slice(), [0, 0],
    'the contention guard runs before synchronized body effects');
  t.end();
});

test('generated synchronized regions resume around unsupported interpreted callees', async (t) => {
  const classpath = compileJavaFixture(t, 'MonitorCallIslandHarness', `
public class MonitorCallIslandHarness {
  private static int opaque(int value) {
    switch (value) {
      case 1: return 7;
      case 2: return 11;
      case 3: return 13;
      default: return value * 3;
    }
  }

  public static void compute(int[] out) {
    synchronized (out) {
      for (int i = 0; i < out.length; i++) out[i] = opaque(out[i]) + i;
    }
  }
}
`);

  const jvm = new JVM({ classpath, jit: { warmupThreshold: 0 } });
  await jvm.loadClassByName('MonitorCallIslandHarness');
  jvm.classInitializationState.set('MonitorCallIslandHarness', 'INITIALIZED');
  const thread = {
    id: 0,
    name: 'monitor-call-island-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [1, 2, 3, 4];
  out.type = '[I';
  out.isLocked = false;
  out.lockOwner = null;
  out.lockCount = 0;
  out.waitSet = [];

  await invoke(jvm, thread, 'MonitorCallIslandHarness', 'compute', '([I)V', [out]);

  t.deepEqual(out.slice(0, 4), [7, 12, 15, 15],
    'compiled parent and interpreted switch helper preserve results');
  const compute = await jvm.findMethodInHierarchy('MonitorCallIslandHarness', 'compute', '([I)V');
  t.notOk(jvm.jit.deoptedMethods.has(compute),
    'interpreted call islands do not permanently deopt the synchronized parent');
  t.ok(jvm.jit.generatedMethodRunCounts.get('MonitorCallIslandHarness.compute([I)V') >= 2,
    'generated parent resumes after interpreted children');
  t.notOk(out.isLocked, 'resumed generated monitorexit releases the monitor');
  t.end();
});

test('generated JIT resolves class literals for native-only JRE classes', async (t) => {
  const classpath = compileJavaFixture(t, 'JitClassLiteralHarness', `
public class JitClassLiteralHarness {
  public static void store(Object[] out) {
    for (int i = 0; i < out.length; i++) {
      out[i] = javax.sound.sampled.SourceDataLine.class;
    }
  }
}
`);
  const jvm = new JVM({ classpath, jit: { warmupThreshold: 1 } });
  await jvm.loadClassByName('JitClassLiteralHarness');
  const thread = {
    id: 0,
    name: 'jit-class-literal-test',
    callStack: new Stack(),
    status: 'runnable',
    pendingException: null,
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const out = [null, null];
  out.type = '[Ljava/lang/Object;';
  out.length = 2;
  out.hashCode = jvm.nextHashCode++;

  await invoke(jvm, thread, 'JitClassLiteralHarness', 'store', '([Ljava/lang/Object;)V', [out]);
  await invoke(jvm, thread, 'JitClassLiteralHarness', 'store', '([Ljava/lang/Object;)V', [out]);

  t.equal(out[0]._classData.ast.classes[0].className,
    'javax/sound/sampled/SourceDataLine', 'class literal becomes a usable java.lang.Class object');
  t.ok(jvm.jit.generatedRunCount + jvm.jit.runnerRunCount > 0,
    'class literal executes through a JIT tier');
  t.end();
});

test('Wasm OSR executes and reads back the module prepare() selected',
  async (t) => {
  const className = 'WasmOsrModuleSelectionHarness';
  const classpath = compileJavaFixture(t, className, `
public final class WasmOsrModuleSelectionHarness {
  static int spin(int count) {
    int total = 0;
    for (int index = 0; index < count; index++) total += index;
    return total;
  }
}
`);
  const jvm = new JVM({ classpath, jit: { warmupThreshold: 0 } });
  await jvm.loadClassByName(className);
  const method = await jvm.findMethodInHierarchy(className, 'spin', '(I)I');

  // prepare() answers with a block id indexed against the module IT chose:
  // the companion dispatcher when it reports osr. execute() re-derives the
  // module from that same flag, so losing the flag in between runs the
  // structured primary at the companion's block id -- a valid-but-wrong
  // entry point that resumes mid-method with desynchronized state rather
  // than failing. Both modules are therefore given distinct block ids and
  // distinct return boxes, and the probe must stay on one of them.
  const companion = { meta: {
    fullyCompiled: true, deoptableCalls: 0, retChar: 'I',
    box: { ret: 4242 },
  } };
  const primary = { meta: {
    fullyCompiled: true, deoptableCalls: 0, retChar: 'I',
    box: { ret: 77 },
  }, osr: companion };

  const executions = [];
  jvm.jit.wasmJit.enabled = true;
  jvm.jit.wasmJit.execute = (_frame, _thread, module, block, nested, osr) => {
    executions.push({ module, block, nested, osr });
    return { returned: true };
  };
  const probe = (prep) => {
    jvm.jit.wasmJit.prepare = () => prep;
    const frame = new Frame(method);
    frame.className = className;
    const thread = {
      id: 0, status: 'runnable', pendingException: null,
      callStack: new Stack(),
    };
    thread.callStack.push(frame);
    return jvm.jit.wasmOsrProbe(frame, thread, 0, 0);
  };

  const companionResult = probe({ st: primary, blk: 7, osr: true });
  t.equal(executions.length, 1, 'the companion selection reaches execute()');
  t.equal(executions[0].block, 7,
    'the block id prepare() resolved is the one entered');
  t.equal(executions[0].osr, true,
    'execute() re-derives the companion from the flag prepare() reported');
  t.ok(companionResult?.returned, 'a completed OSR reports its return');
  t.equal(companionResult.value, 4242,
    'the return value comes from the module that actually ran');

  const primaryResult = probe({ st: primary, blk: 3 });
  t.equal(executions.length, 2, 'an ordinary preparation also executes');
  t.equal(executions[1].block, 3, 'the primary keeps its own block id');
  t.notEqual(executions[1].osr, true,
    'a preparation without the companion flag stays on the primary');
  t.equal(primaryResult.value, 77,
    'the primary reports its own return box');

  const voidCompanion = { meta: {
    fullyCompiled: true, deoptableCalls: 0, retChar: 'V',
    box: { ret: 4242 },
  } };
  const voidResult = probe({
    st: { meta: primary.meta, osr: voidCompanion }, blk: 1, osr: true,
  });
  t.equal(typeof voidResult.value, 'symbol',
    'the return kind is read from the module that ran, not its sibling');

  // The admission gate must judge the same module. A companion that cannot
  // be entered is not redeemed by a fully compiled primary.
  const partialCompanion = { meta: {
    fullyCompiled: false, deoptableCalls: 0, retChar: 'I', box: { ret: 4242 },
  } };
  t.equal(probe({
    st: { meta: primary.meta, osr: partialCompanion }, blk: 2, osr: true,
  }), null, 'a partial companion is rejected behind a complete primary');
  t.equal(executions.length, 3,
    'the rejected companion runs no Wasm at all');
  t.end();
});

test('restoring calls withdraw the frame their synchronous fallback restored',
  async (t) => {
  const className = 'RestoringSyncFallbackHarness';
  const classpath = compileJavaFixture(t, className, `
public final class RestoringSyncFallbackHarness {
  interface Step { int apply(int value); }
  static Step step;
  static int root(int count) {
    int total = 0;
    for (int index = 0; index < count; index++) total += step.apply(index);
    return total;
  }
  static final class Doubler implements Step {
    public int apply(int value) { return value + value; }
  }
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0,
    profileMethods: false,
    structuredSsa: true,
    guestKernelOracles: false,
  } });
  const classData = await jvm.loadClassByName(className);
  await jvm.loadClassByName(`${className}$Doubler`);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  jvm.classInitializationState.set(`${className}$Doubler`, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(className, 'root', '(I)I');
  const generated = jvm.jit.structuredSsa.compile(method);
  t.equal(typeof generated?.jvmRestoringDirectPositionalBody, 'function',
    'an unlinked interface call publishes a restoring positional body');

  // A restoring body runs frameless. Its synchronous fallback splices the
  // omitted Frame in at restorationDepth so tryInvokeSyncAt has a canonical
  // caller -- and every arm that propagates a suspension returns while that
  // Frame is live. The normal completion path falls through instead, so
  // nothing there withdrew it: a plain return stranded a pc-0 Frame that the
  // scheduler later re-entered and ran from the top, re-executing a method
  // whose real caller had already moved on.
  const source = generated.jvmRestoringDirectPositionalSource;
  const endMarkers = source.match(/__JVM_REGION_CALL_END_\d+__/g) || [];
  t.ok(endMarkers.length > 0,
    'the unlinked call survives as a real call block');
  for (const marker of endMarkers) {
    t.ok(new RegExp(`${marker}\\*/\\s*\\n\\s*if \\(frame !== null\\) \\{\\s*` +
      '\\n\\s*frame = helpers\\.structuredSsa\\.releaseUnwindFrame\\(')
      .test(source),
    `a completed ${marker} withdraws any frame it restored`);
  }

  const receiver = {
    type: `${className}$Doubler`, fields: {}, hashCode: jvm.nextHashCode++,
  };
  classData.staticFields.set(`step:L${className}$Step;`, receiver);
  const thread = {
    id: 0, status: 'runnable', pendingException: null, callStack: new Stack(),
  };
  jvm.threads = [thread];
  jvm.currentThreadIndex = 0;
  const plan = {
    target: { freeFrame: null }, Frame, lookupClass: className, method,
    restoreFrame(targetThread, frame, depth) {
      targetThread.callStack.items.splice(depth, 0, frame);
    },
  };
  const result = generated.jvmRestoringDirectPositionalBody(
    jvm.jit, plan, 5, thread, true);
  t.equal(result, 20,
    'the cold interface call still produces the scalar result');
  t.equal(thread.callStack.size(), 0,
    'a normally completed call leaves no frame behind for the scheduler');
  t.equal(plan.target.freeFrame !== null, true,
    'the withdrawn frame returns to the plan for reuse');
  t.end();
});
