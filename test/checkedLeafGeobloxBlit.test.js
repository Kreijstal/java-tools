const test = require('tape');
const path = require('path');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

// The real FunOrb Geoblox sprite blit, `dm.b([I[IIIIIIII)V`, compiled from
// the ORIGINAL class bytes (test/fixtures/geoblox/dm.class, the 2022 gamepack
// class as shipped). Its shape is the SiblingBlit fixture of
// checkedLeafSiblingLoops.test.js with two obfuscator quirks: the remainder
// count is stored back into the width argument's slot, and both inner loops
// reuse one induction slot. Geoblox draws its panels with ~150,000 1x1 calls
// of this method per frame, so whether it runs as a frame-free checked leaf
// or as a polled framed loop is the frame time.
//
// The class needs no other gamepack class to compile this method: superclass
// resolution is lazy and the method touches nothing but its two arrays.
const classpath = path.join(__dirname, 'fixtures', 'geoblox');
const className = 'dm';
const descriptor = '([I[IIIIIIII)V';

// apps/launcher/browser-runtime.json (dekobloko-work) as of 2026-09-30, the
// options the game-library server boots the browser JVM with. Kept inline so
// this test pins what the browser actually enables; when that file changes,
// update this copy.
const browserJvmOptions = {
  prepareBeforeMain: true,
  eventLoopYieldStrategy: 'message-channel',
  schedulerTimingRate: 256,
  awtWebGlPresentation: true,
  denseInstanceFields: true,
  wasmHeap: true,
  wasmHeapMb: 256,
  jit: {
    codegen: true,
    retainCompilerDiagnostics: false,
    effectfulMonitorCodegen: true,
    preferWholeMethodJs: true,
    rendererPipeline: true,
    scalarLoops: true,
    scalarGuestBodies: true,
    hotCallGraphRegions: false,
    hotCallGraphDirectSafePointBudget: 10000,
    hotCallGraphMaxRootCodeItems: 1024,
    structuredSsa: true,
    compiledCallChains: true,
    positionalCallSafePointPolling: true,
    structuredLinearPartition: false,
    structuredLinearPartitionUnitBytes: 98304,
    structuredLinearPartitionSegmentBytes: 49152,
    structuredLinearPartitionMinimumSegmentBytes: 8192,
    oversizedWasmFirstCodeItems: 1024,
    wasmStructured: true,
    wasmSynchronizedInstanceLinks: true,
    wasmCheckcast: true,
    wasmRelaxedReferenceReturns: true,
    structuredDeferredCallMaterialization: true,
    ordinaryAdaptiveFramelessPositional: true,
    ordinaryAdaptiveCallChainSafePointBudget: 4000000,
    adaptiveFramelessBudgetMultiplier: 100,
    adaptiveWholeMethodEscalationThreshold: 100000,
    profileMethods: false,
    profileTimings: false,
  },
};

async function loadBlit(jvmOptions) {
  const jvm = new JVM({classpath, ...jvmOptions});
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(className, 'b', descriptor);
  return {jvm, method};
}

test('the real Geoblox blit is admitted under the browser options, but the ' +
  'checked-leaf tier itself is gated on jit.checkedLeafDirectPositional',
  async (t) => {
  const {jvm, method} = await loadBlit({...browserJvmOptions,
    jit: {...browserJvmOptions.jit, compileWorker: false, warmupThreshold: 0}});
  const generated = jvm.jit.getGeneratedFunction(method);
  t.equal(generated?.jvmStructuredLoopCount, 3, 'three loops');
  t.equal(generated?.jvmStructuredCountedLoopCount, 3, 'all counted');
  t.equal(generated?.jvmStructuredCarriedIndexRangeGuardCount, 10,
    'all ten pixel accesses are proven by carried-index region guards');
  t.equal(generated?.jvmStructuredArrayRangeGuardCount -
    generated?.jvmStructuredCoalescedArrayRangeGuardCount, 2,
  'one hoisted guard per (array, carried counter)');
  // The browser runs with retainCompilerDiagnostics: false, so no `*Source`
  // text survives on the result; the installed function's own text does.
  t.ok(/ssaCarriedRange\d+Stride/.test(
    String(generated?.jvmRestoringDirectPositionalBody)),
  'the restoring direct positional body carries the region guards');
  // This is the clause that kept the browser A/B on the polled body: the
  // whole checked-leaf ABI is opt-in (JitCompiler/JvmSsaBlockRenderer
  // `checkedLeafDirectPositionalEnabled`), and browser-runtime.json does not
  // opt in. Admission of the region is not the problem.
  t.equal(generated?.jvmStructuredNestedRuntimeCheckedLeaf, false,
    'without the option no nested-region leaf is published');
  t.notEqual(typeof generated?.jvmCheckedLeafDirectPositionalBody, 'function',
    'without the option there is no checked-leaf body');
  t.end();
});

test('with jit.checkedLeafDirectPositional the browser options install the ' +
  'real blit as a checked leaf through a compile worker', async (t) => {
  const {jvm, method} = await loadBlit({...browserJvmOptions,
    prepareBeforeMain: false,
    jit: {...browserJvmOptions.jit, compileWorker: true, warmupThreshold: 0,
      checkedLeafDirectPositional: true}});
  t.teardown(() => jvm.jit.compileWorker.dispose());
  jvm.jit.markMainStarted();
  jvm.guestStarted = true;
  jvm.jit.getGeneratedFunction(method, {allowEffectfulCalls: true});
  await jvm.jit.compileWorker.whenIdle();
  const stats = jvm.jit.compileWorker.stats;
  t.ok(stats.installed >= 1 && stats.failed === 0 && stats.refused === 0,
    'the worker compiled and the main thread installed the result: ' +
    JSON.stringify(stats));
  const generated = jvm.jit.getGeneratedFunction(method);
  t.ok(generated?.jvmStructuredNestedRuntimeCheckedLeaf,
    'the sibling-loop region is admitted through the nested counted rule');
  t.equal(typeof generated?.jvmCheckedLeafDirectPositionalBody, 'function',
    'the transported result carries the checked-leaf body');
  const leaf = String(generated?.jvmCheckedLeafDirectPositionalBody);
  t.ok(/ssaCarriedRange\d+Stride/.test(leaf),
    'the leaf carries the carried-index region guards');
  t.notOk(/safePointBudget/.test(leaf),
    'the leaf polls no scheduler budget');
  t.ok(/ssaArrayRangeGuard0 && ssaArrayRangeGuard1\)\) return/.test(leaf),
    'the leaf bails on the two region guards before its first store');
  t.ok(/ssaCheckedLeafTrips\d+ \* \(ssaCheckedLeafTrips\d+ \+ ssaCheckedLeafTrips\d+\)/
    .test(leaf), 'the entry work bound sums the sibling loops');
  t.end();
});

test('the framed body compiled from the original bytes blits like the ' +
  'reference, in range and when the last pixel overflows', async (t) => {
  const {jvm, method} = await loadBlit({...browserJvmOptions,
    jit: {...browserJvmOptions.jit, compileWorker: false, warmupThreshold: 0,
      checkedLeafDirectPositional: true}});
  const generated = jvm.jit.getGeneratedFunction(method);
  const reference = (dst, src, srcOff, dstOff, w, h, dstStep, srcStep) => {
    const at = (array, index) => {
      if (index < 0 || index >= array.length) throw new RangeError('AIOOBE');
      return index;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = src[at(src, srcOff)]; srcOff = (srcOff + 1) | 0;
        if (p !== 0) dst[at(dst, dstOff)] = p;
        dstOff = (dstOff + 1) | 0;
      }
      dstOff = (dstOff + dstStep) | 0;
      srcOff = (srcOff + srcStep) | 0;
    }
  };
  const run = (dst, src, ...rest) => {
    dst.type = '[I';
    src.type = '[I';
    const frame = new Frame(method);
    frame.className = className;
    frame.locals.splice(0, 9, dst, src, 0, ...rest);
    const callStack = new Stack();
    callStack.push(frame);
    let error = null;
    try {
      generated(frame, {status: 'runnable', pendingException: null, callStack},
        jvm.jit, false);
    } catch (thrown) {
      error = thrown;
    }
    return error;
  };
  const fresh = (length, seed) => Array.from({length}, (_unused, i) =>
    (i % 3 === seed) ? 0 : seed * 1000 + i);
  const scenarios = [
    // srcOff, dstOff, w, h, dstStep, srcStep
    [0, 5 * 64 + 3, 13, 7, 64 - 13, 16 - 13],
    [0, 2, 1, 1, 63, 15],
    [3, 7, 3, 4, 64 - 3, 16 - 3],
    [0, 9, 8, 4, 64 - 8, 16 - 8],
    [0, 15 * 64 + 20, 13, 7, -64 - 13, 16 - 13],
    [0, 64 * 16 - 13 * 7 - 6 * 51 + 1, 13, 7, 64 - 13, 16 - 13],
  ];
  for (const scenario of scenarios) {
    const dst = fresh(64 * 16, 0), src = fresh(16 * 16, 1);
    const expectedDst = fresh(64 * 16, 0), expectedSrc = fresh(16 * 16, 1);
    let expectedThrow = false;
    try {
      reference(expectedDst, expectedSrc, ...scenario);
    } catch (error) {
      expectedThrow = true;
    }
    const error = run(dst, src, ...scenario);
    t.equal(Boolean(error), expectedThrow,
      `throws iff the reference does for ${JSON.stringify(scenario)}` +
      (error ? `: ${error.type || error}` : ''));
    if (error) {
      t.equal(error.type, 'java/lang/ArrayIndexOutOfBoundsException',
        'the overflow is the Java bounds exception');
    }
    t.deepEqual(dst.slice(), expectedDst,
      `destination matches the reference for ${JSON.stringify(scenario)}`);
  }
  t.end();
});

// The caller: dm.b(II)V, the instance method that clips a sprite against the
// static clip rectangle and calls the blit at pc 135. The browser prepares
// every method before main(), i.e. while dm is still cold, and keeps those
// bodies for the run; a caller compiled cold must therefore already absorb
// the callee leaf, or the ~150,000 calls per frame all go through the
// late-linked fastPositional site.
test('the real dm.b(II)V, prepared cold through a compile worker, inserts ' +
  'the blit leaf lexically instead of calling it', async (t) => {
  const jvm = new JVM({classpath, ...browserJvmOptions,
    prepareBeforeMain: false,
    jit: {...browserJvmOptions.jit, compileWorker: true, warmupThreshold: 0,
      checkedLeafDirectPositional: true}});
  t.teardown(() => jvm.jit.compileWorker.dispose());
  await jvm.loadClassByName(className);
  // Deliberately NOT initialized: this is the preparation-time state.
  const callee = await jvm.findMethodInHierarchy(className, 'b', descriptor);
  const caller = await jvm.findMethodInHierarchy(className, 'b', '(II)V');
  for (const method of [callee, caller]) {
    jvm.jit.getGeneratedFunction(method, {allowEffectfulCalls: true});
    await jvm.jit.compileWorker.whenIdle();
  }
  const stats = jvm.jit.compileWorker.stats;
  t.ok(stats.installed >= 2 && stats.failed === 0 && stats.refused === 0,
    'both bodies were installed from the worker: ' + JSON.stringify(stats));
  const generated = jvm.jit.getGeneratedFunction(caller);
  t.equal(generated?.jvmStructuredLexicalCheckedLeafCallCount, 1,
    'the blit call site is a lexical checked-leaf insertion');
  t.equal(generated?.jvmStructuredLexicalVoidFastPathCallCount, 1,
    'the void leaf takes the fast path without a result sentinel');
  const body = String(generated?.jvmRestoringDirectPositionalBody);
  t.ok(/ssaInlineCheckedLeaf\d+_135: \{/.test(body),
    'the leaf block is inserted at the call pc');
  t.ok(/ssaCarriedRange\d+Stride1S3/.test(body),
    'the inserted leaf carries the carried-index region guards');
  t.ok(/ssaCheckedLeafTrips\d+ \* \(ssaCheckedLeafTrips\d+ \+ ssaCheckedLeafTrips\d+\)/
    .test(body), 'the inserted leaf keeps its entry work bound');
  t.notOk(/fastPositional/.test(body),
    'no positional call to the blit remains in the caller');
  t.ok(/reason: 'checked leaf admission'/.test(body),
    'a rejected admission leaves the restoring body for the canonical call');
  t.notOk(/safePointBudget/.test(body.slice(body.indexOf('ssaInlineCheckedLeaf'))),
    'the inserted leaf polls no scheduler budget');
  t.end();
});
