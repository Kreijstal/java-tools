const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
// This suite asserts diagnostic counters throughout. Production execution
// deliberately leaves invocation accounting off unless it is requested.
process.env.JVM_PROFILE_JIT_METHODS = '1';
const { JVM } = require('../src/core/jvm');
const { _test: wasmJitTest } = require('../src/jit/WasmJit');
const {
  supportsWasmTryTable,
  mathIntrinsicFunction,
} = require('../src/jit/wasmShared');
const {
  addTypedArrayStoreImports,
} = require('../src/jit/wasmRuntimeImports');
const { _test: structuredRendererTest } = require('../src/jit/JvmSsaBlockRenderer');
const HandwrittenFusedGradient = require('../src/jit/HandwrittenFusedGradient');
const HandwrittenAffineSpriteRaster =
  require('../src/jit/HandwrittenAffineSpriteRaster');
const invokeHandlers = require('../src/instructions/invoke');
const objectHandlers = require('../src/instructions/object');
const controlHandlers = require('../src/instructions/control');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const awt = require('../src/platform/awt');

const WASM_TRY_TABLE_SUPPORTED = supportsWasmTryTable();

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

test('large dynamic primitive-array loops select structured JavaScript first',
  (t) => {
    const jvm = new JVM({ jit: { profileMethods: false } });
    const shape = (name, {
      length = 512, primitiveArrayAccesses = 32,
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
      shape('shortLoop', {length: 511})),
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
  site.fastPositional.invoke = () => deopt;
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
    /if \(ssaRuntimeCoarseLoop\d+ && ssaArrayRangeGuard\d+\)/.exec(spanSource);
  const fastArmStart = fastArmMatch?.index ?? -1;
  const fastStoreMatch = /ssaEntryStaticArrayData\d+\[ssaValue\d+\] =/
    .exec(spanSource.slice(fastArmStart));
  const fastStore = fastStoreMatch
    ? fastArmStart + fastStoreMatch.index : -1;
  const slowBoundsMatch = /if \(!ssaArrayRangeGuard\d+ &&/
    .exec(spanSource.slice(fastArmStart));
  const slowBounds = slowBoundsMatch
    ? fastArmStart + slowBoundsMatch.index : -1;
  t.ok(fastArmStart >= 0 && fastStore > fastArmStart &&
      slowBounds > fastStore &&
      !spanSource.slice(fastArmStart, fastStore).includes('ssaMaterialize'),
    'the range-proven fast loop contains only the direct array store');
  t.ok(slowBounds > fastStore,
  'the slow loop retains the throwing bounds/materialization branch');
  const checkedLeaf = genericSpan.jvmCheckedLeafDirectPositionalBody;
  const checkedLeafSource =
    genericSpan.jvmCheckedLeafDirectPositionalSource || '';
  t.equal(typeof checkedLeaf, 'function',
    'one bounded call-free loop publishes a compact checked leaf ABI');
  t.notOk(checkedLeafSource.includes('helpers.materialize(') ||
      checkedLeafSource.includes('helpers.arrayStore('),
  'the checked leaf contains no successful-path Frame or array helper');
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

test('handler-protected non-void calls keep their parent frame visible',
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
  t.equal(typeof generated?.jvmRestoringDirectPositionalBody, 'function',
    'the protected call publishes a restoring positional entry');
  t.ok(generated.jvmStructuredRequiresBaselineFramedEntry,
    'the call and handler shape marks the ordinary frame ABI unsafe');
  const selected = jvm.jit.compileMethod(method);
  t.notOk(selected.jvmStructuredSsa,
    'ordinary frame entry uses the baseline pending-return handoff');
  t.ok(selected.jvmStructuredPositionalOnly,
    'tier selection records that SSA is retained only as a positional body');
  t.equal(typeof selected.jvmRestoringDirectPositionalBody, 'function',
    'baseline selection preserves the verified nested-call kernel');
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
  t.ok(/if \(ssaRuntimeCoarseLoop\d+ && ssaArrayRangeGuard\d+\)/.test(source),
    'the call-free inner pixel loop receives a range-versioned fast arm');
  const pollCount = (source.match(/--safePointBudget === 0/g) || []).length;
  t.ok(pollCount >= 2,
    'the slow inner arm and the helper-containing outer loop retain polls');
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
    const pureGenerated = jvm.jit.structuredSsa.compile(pureLoop);
    const writingGenerated = jvm.jit.structuredSsa.compile(writingLoop);
    const pureInstanceGenerated =
      jvm.jit.structuredSsa.compile(pureInstanceLoop);
    const writingInstanceGenerated =
      jvm.jit.structuredSsa.compile(writingInstanceLoop);
    const entryCacheCount = (generated) =>
      (generated.jvmStructuredSource
        .match(/(?:const|let) ssaEntryStaticValue/g) || []).length;
    t.equal(entryCacheCount(pureGenerated), 2,
      'a transitively pure static call preserves both caller static caches');
    t.equal(entryCacheCount(writingGenerated), 1,
      'a callee write invalidates only the matching static cache key');
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
}
`);
  const jvm = new JVM({ classpath, jit: {
    warmupThreshold: 0, structuredSsa: true, profileMethods: false,
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
  t.notOk(generated.jvmStructuredSource.includes(
    'if (helpers.continueStructuredQuantum(thread)) { safePointBudget = 10000;'),
  'generated source does not retain the old fixed 10k-backedge deadline check');
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
  t.equal(yieldingFrame.locals[1], 19999,
    'ordinary deoptimization spills its scalar induction local');
  t.deepEqual(yieldingFrame.stack.items, [5 + (19998 * 19999) / 2],
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

test('structured SSA versions eager field-array views at loop preheaders',
  async (t) => {
  const className = 'StructuredFieldArrayRangeHarness';
  const classpath = compileJavaFixture(t, className, `
public final class StructuredFieldArrayRangeHarness {
  int[] source;
  byte[] destination;
  static int calls;

  void copy() {
    for (int index = 0; index < 512; index++) {
      destination[index] = (byte) source[index];
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
  const method = await jvm.findMethodInHierarchy(className, 'copy', '()V');
  const generated = jvm.jit.structuredSsa.compile(method);
  const sourceText = generated?.jvmStructuredSource || '';
  t.ok(generated?.jvmStructuredSsa,
    'the field-array counted loop still selects structured SSA');
  t.ok(sourceText.includes('ssaArrayRangeGuard'),
    'an entry-stable field view receives a loop-preheader range proof');
  t.ok(sourceText.includes('ssaRuntimeCoarseTrips') &&
      !/ssaRuntimeCoarseTrips\d+ < safePointBudget/.test(sourceText),
    'the bounded block is not fragmented by a smaller abstract poll budget');

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

  // The canonical interpreter executes the void invocation at PC 1 and leaves
  // the caller at its post-call PC after the child completes.
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
  jvm.jit.tryInvokeSyncAt = (_id, frame) => {
    frame.stack.items.length = 0;
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

  const resumed = generated(frame, thread, jvm.jit, false);
  t.equal(resumed.value, 42, 'execution resumes after the void child');
  t.notOk(generated.jvmHasStructuredContinuation(frame),
    'normal return clears the continuation');
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

  public static void compute(int[] out, int value) {
    Box box = new Box();
    box.value = value;
    out[0] = box.value * 3;
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

  static class NestedAllocation extends Base {
    Object marker;

    NestedAllocation(int limit) {
      marker = new Object();
      for (int i = 0; i < limit; i++) {
        if (marker == null) throw new AssertionError();
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
