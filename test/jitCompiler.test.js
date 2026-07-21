const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JVM } = require('../src/core/jvm');
const { _test: wasmJitTest } = require('../src/jit/WasmJit');
const { _test: structuredRendererTest } = require('../src/jit/JvmSsaBlockRenderer');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const awt = require('../src/platform/awt');

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
  t.end();
});

test('exclusive region timing subtracts nested generated and fused time', (t) => {
  const jvm = new JVM({ jit: { profileMethods: false } });
  const jit = jvm.jit;
  jit.exclusiveTimingsEnabled = true;
  jit.exclusiveTimingRootKey = 'ArbitraryRoot.work()V';
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

test('structured SSA emits verified clipped static spans without call dispatch', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0, structuredSsa: true } });
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

test('structural packed-color scanline intrinsic preserves pixel arithmetic', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0 } });
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
  const jvm = new JVM({ jit: { warmupThreshold: 0 } });
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

test('structured JVM SSA feeds operand values across block joins', (t) => {
  const jvm = new JVM({ jit: { structuredSsa: true, profileMethods: false } });
  const method = structuredSsaJoinMethod();
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated?.jvmStructuredSsa, 'verified reducible loop selects the structured SSA renderer');
  t.ok(generated.jvmStructuredSource.includes('while (true)') &&
      !generated.jvmStructuredSource.includes('switch (pc)'),
    'renderer emits lexical JavaScript control flow instead of a bytecode dispatcher');
  t.ok(/ssaStack\d+_0 = ssaValue\d+/.test(generated.jvmStructuredSource),
    'predecessor edge explicitly feeds its operand value into the successor join');

  const frame = new Frame(method);
  frame.locals[0] = 10;
  const callStack = new Stack();
  callStack.push(frame);
  const result = generated(frame, { status: 'runnable', callStack }, jvm.jit, false);
  t.deepEqual(result, { returned: true, value: 50 }, 'loop result preserves the live operand phi value');
  t.equal(jvm.jit.structuredSsa.runCount, 1, 'successful structured entries are counted');
  t.equal(callStack.size(), 0, 'normal return removes the generated frame');

  const combined = new JVM({ jit: { rendererPipeline: true, profileMethods: false } });
  t.ok(combined.jit.scalarGuestBodiesEnabled && combined.jit.fusedRegions.enabled &&
      combined.jit.structuredSsa.enabled,
    'one renderer-pipeline option composes guest scalarization, fusion, and structured SSA');
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
      scalarSsaOptimizations = true, wrappedValues = false, structuredSsa = false) {
    const jvm = new JVM({ classpath, jit: {
      warmupThreshold: 0, preferWholeMethodJs: true, profileMethods: false, scalarLoops,
      scalarGuestBodies, scalarSsaOptimizations, structuredSsa,
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
  const structured = await run(false, false, false, false, true);
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
  t.notOk(structured.generated.jvmStructuredSource.includes('getStaticSyncAt'),
    'initialized static target is read directly without the generic helper');
  t.ok(structured.generated.jvmStructuredSource.includes('.get("staticBias:I")'),
    'direct static access retains a live read from the canonical field map');
  structured.jvm.classes.ScalarFeatureHarness.staticFields.set('staticBias:I', 9);
  const changedStaticOut = [0, 0];
  changedStaticOut.type = '[I';
  await invoke(structured.jvm, structured.thread, 'ScalarFeatureHarness', 'compute',
    '(LScalarFeatureHarness$Box;I[I)V', [structured.box, 1, changedStaticOut]);
  t.deepEqual(changedStaticOut.slice(), [19, 19],
    'direct static target observes values changed after compilation');

  structured.jvm.classInitializationState.set('ScalarFeatureHarness', 'UNINITIALIZED');
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

test('fused renderer families are selected by verified structure, not names', (t) => {
  const jvm = new JVM({ jit: { warmupThreshold: 0 } });
  const families = [
    ['(IIIIIIIIIIIIZIII)V', '(IIIIIIIBIIII[IIIII)V', '(IIIIIII[III)V'],
    ['(IIIIIIII)V', '(IIIIIBII[I)V', '(IB[III)V'],
  ];
  for (const [wrapperDescriptor, rasterDescriptor, scanlineDescriptor] of families) {
    const family = jvm.jit.fusedRegions.constructor.FAMILY_BY_WRAPPER.get(wrapperDescriptor);
    const wrapper = fusedShapeMethod(
      'nameChosenAtRandom', wrapperDescriptor, rasterDescriptor, 6,
      { targetName: 'alsoNotObfuscatedA' },
    );
    const raster = fusedShapeMethod(
      'differentRandomName', rasterDescriptor, scanlineDescriptor, 6,
      { integerNative: true, targetName: 'scanRowsWithoutANameDependency' },
    );
    t.ok(jvm.jit.fusedRegions.verifyMethod(wrapper, family, 'wrapper'),
      `${family.name} wrapper shape is accepted under an arbitrary method name`);
    t.ok(jvm.jit.fusedRegions.verifyMethod(raster, family, 'raster'),
      `${family.name} raster shape is accepted under an arbitrary method name`);

    const shortCalls = fusedShapeMethod('short', wrapperDescriptor, rasterDescriptor, 5);
    t.notOk(jvm.jit.fusedRegions.verifyMethod(shortCalls, family, 'wrapper'),
      `${family.name} rejects a changed wrapper call count`);
    const badStack = fusedShapeMethod('badStack', wrapperDescriptor, rasterDescriptor, 6);
    badStack.attributes[0].code.codeItems.shift();
    t.notOk(jvm.jit.fusedRegions.verifyMethod(badStack, family, 'wrapper'),
      `${family.name} rejects an invalid operand-stack shape`);
  }

  const family = jvm.jit.fusedRegions.constructor.FAMILY_BY_WRAPPER.get('(IIIIIIII)V');
  const wrongDescriptor = fusedShapeMethod('wrong', '(IIIIIIIV)V', '(IIIIIBII[I)V', 6);
  t.notOk(jvm.jit.fusedRegions.verifyMethod(wrongDescriptor, family, 'wrapper'),
    'an altered wrapper descriptor is rejected');
  const badHandler = fusedShapeMethod('badHandler', '(IIIIIIII)V', '(IIIIIBII[I)V', 6, {
    exceptionTable: [{ handlerLbl: 'L0', catch_type: 'java/lang/Exception' }],
  });
  t.notOk(jvm.jit.fusedRegions.verifyMethod(badHandler, family, 'wrapper'),
    'an unsupported exception handler is rejected');
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
  result = jvm.jit.fusedRegions.tryInvoke(site, target, caller, thread);
  t.ok(result.handled, 'the same structurally cached region runs after guards clear');
  t.equal(sideEffects, 1, 'unguarded invocation enters the fused kernel once');
  t.equal(caller.stack.items.length, 0, 'successful fused void call consumes its operands');
  t.equal(jvm.jit.fusedRunCount, 1, 'successful fused execution is counted');
  t.equal(jvm.jit.fusedGuardedFallbackCount, 2, 'both guarded fallbacks are counted');
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

test('generated JIT emits verified integer leaves directly into callers', async (t) => {
  const classpath = compileJavaFixture(t, 'DirectIntegerInlineHarness', `
class DirectIntegerLeafTarget {
  static int transform(int value) {
    return ((value + 7) * 3) ^ (value >>> 5);
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
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0, preferWholeMethodJs: true, profileMethods: false,
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
  t.notOk(jvm.jit.deoptedMethods.has(
    await jvm.findMethodInHierarchy('GeneratedTransientCallJitHarness', 'compute', '([I)V')),
  'unsupported child does not permanently deopt its caller');
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
  t.equal(jvm.jit.generatedRunCount, 5, 'outer loop and interface accessor use generated code');
  t.equal(jvm.jit.syncReusedFrameCount, 3,
    'repeated interface calls recycle their completed child frame');
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
  const recover = await jvm.findMethodInHierarchy('WasmReporterHarness', 'recover', '([I)V');
  const recoverFrame = new Frame(recover);
  recoverFrame.className = 'WasmReporterHarness';
  t.equal(jvm.jit.wasmJit.prepare(recoverFrame), null,
    'a handler that writes a recovery value remains interpreted');
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

  const broad = await jvm.findMethodInHierarchy('WasmCheckedHandlerHarness', 'broad', '([I)V');
  const broadFrame = new Frame(broad);
  broadFrame.className = 'WasmCheckedHandlerHarness';
  t.equal(jvm.jit.wasmJit.prepare(broadFrame), null,
    'broad Exception recovery remains interpreted');
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
  t.notOk(safeJvm.jit.isCodegenSupported(safeRunMethod),
    'thread lifecycle entrypoint remains interpreted by default');

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
    'explicit experimental gate can enable lifecycle control flow');
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
    jit: { warmupThreshold: 100 },
  });
  await jvm.loadClassByName('GeneratedMonitorJitHarness');
  const method = await jvm.findMethodInHierarchy(
    'GeneratedMonitorJitHarness', 'compute', '([II)V');
  t.ok(jvm.jit.isCodegenSupported(method),
    'constructor calls reachable only from a monitor exception reporter do not reject the hot body');
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
