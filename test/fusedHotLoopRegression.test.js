const test = require('tape');
const { performance } = require('perf_hooks');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

/*
 * Fast proxy for renderer-shaped guest work:
 *
 *   compiled caller -> wrapper -> raster -> array-store loop
 *
 * The identities and descriptor are deliberately ordinary. Fusion must be
 * selected from repeated-call and CFG/stack structure, never these names.
 * Code-shape assertions are the stable performance contract; the generous
 * wall-clock bound only catches catastrophic fallback or accidental hangs.
 */

function instruction(op, arg) {
  return { instruction: arg === undefined ? op : { op, arg } };
}

function staticCall(owner, name, descriptor) {
  return instruction('invokestatic',
    ['Method', owner, [name, descriptor]]);
}

function method(name, descriptor, codeItems, localsSize, stackSize) {
  return {
    name,
    descriptor,
    flags: ['static'],
    attributes: [{
      type: 'code',
      code: {
        codeItems,
        localsSize: String(localsSize),
        stackSize: String(stackSize),
        exceptionTable: [],
      },
    }],
  };
}

function forwardingMethod(name, childOwner, childName, descriptor) {
  const codeItems = [];
  for (let call = 0; call < 2; call += 1) {
    codeItems.push(
      instruction('aload_0'),
      instruction('iload_1'),
      instruction('iload_2'),
      instruction('iload_3'),
      staticCall(childOwner, childName, descriptor),
    );
  }
  codeItems.push(instruction('return'));
  return method(name, descriptor, codeItems, 4, 4);
}

function arrayStoreLoop(name, descriptor) {
  const codeItems = [
    instruction('aload_0'),
    instruction('iload_1'),
    instruction('iload_3'),
    instruction('iastore'),
    { instruction: { op: 'iinc', varnum: 1, incr: 1 } },
    instruction('iload_1'),
    instruction('iload_2'),
    instruction('if_icmplt', 'Lagain'),
    instruction('return'),
  ];
  codeItems[0].labelDef = 'Lagain:';
  return method(name, descriptor, codeItems, 4, 3);
}

function hotCaller(childOwner, childName, childDescriptor) {
  const codeItems = [
    instruction('iconst_0'),
    instruction('istore_3'),
    instruction('iload_3'),
    instruction('iload_2'),
    instruction('if_icmpge', 'Lreturn'),
    instruction('aload_0'),
    instruction('iconst_0'),
    instruction('iload_1'),
    instruction('iload_3'),
    instruction('iconst_1'),
    instruction('iadd'),
    staticCall(childOwner, childName, childDescriptor),
    { instruction: { op: 'iinc', varnum: 3, incr: 1 } },
    instruction('goto', 'Lloop'),
    instruction('return'),
  ];
  codeItems[2].labelDef = 'Lloop:';
  codeItems[14].labelDef = 'Lreturn:';
  return method('driveHotRegion', '([III)V', codeItems, 4, 4);
}

function install(jvm, owner, installedMethod) {
  jvm.classes[owner] = {
    ast: {
      classes: [{
        className: owner,
        superClassName: null,
        items: [{ type: 'method', method: installedMethod }],
      }],
    },
    staticFields: new Map(),
    staticFieldsInitialized: true,
  };
  jvm.classInitializationState.set(owner, 'INITIALIZED');
}

function makeProxy() {
  const descriptor = '([IIII)V';
  const owners = {
    wrapper: 'proxy/OuterStage',
    raster: 'proxy/MiddleStage',
    scanline: 'proxy/InnerStage',
  };
  const names = {
    wrapper: 'forwardTwice',
    raster: 'forwardAgain',
    scanline: 'writeRange',
  };
  const wrapper = forwardingMethod(
    names.wrapper, owners.raster, names.raster, descriptor);
  const raster = forwardingMethod(
    names.raster, owners.scanline, names.scanline, descriptor);
  const scanline = arrayStoreLoop(names.scanline, descriptor);
  return { descriptor, owners, names, wrapper, raster, scanline };
}

test('generic fused hot-loop proxy stays scalar, lexical, and direct', (t) => {
  const jvm = new JVM({ jit: {
    warmupThreshold: 0,
    fusedRegions: true,
    structuredSsa: true,
    directFusedCalls: true,
    lexicalFusedKernels: true,
    handwrittenFusedKernels: false,
    semanticFusedRasters: false,
  } });
  const compiler = jvm.jit.fusedRegions;
  // Make the regression independent of a developer's experimental env gates.
  compiler.lexicalKernelsEnabled = true;
  compiler.handwrittenKernelsEnabled = false;
  compiler.semanticRasterKernelsEnabled = false;

  const proxy = makeProxy();
  install(jvm, proxy.owners.wrapper, proxy.wrapper);
  install(jvm, proxy.owners.raster, proxy.raster);
  install(jvm, proxy.owners.scanline, proxy.scanline);

  const callerMethod = hotCaller(
    proxy.owners.wrapper, proxy.names.wrapper, proxy.descriptor);
  const generatedCaller = jvm.jit.structuredSsa.compile(callerMethod);
  t.ok(generatedCaller && generatedCaller.jvmStructuredSsa,
    'the guest caller loop is scalarized by the structured SSA renderer');
  t.ok(generatedCaller &&
      generatedCaller.jvmStructuredSource.includes('tryInvokeDirectAt'),
  'the compiled caller feeds operands to a positional fused site');
  t.notOk(generatedCaller &&
      /switch\s*\(\s*pc\s*\)/.test(generatedCaller.jvmStructuredSource),
  'the compiled caller has no bytecode-PC dispatcher');

  const entry = compiler.directEntries.find(candidate =>
    candidate.target && candidate.target.method === proxy.wrapper);
  const region = entry && entry.region;
  t.ok(entry, 'structural proof creates a positional direct-call site');
  t.ok(region, 'the three-method region compiles without an identity allowlist');
  t.equal(region && region.family.name, 'bytecode-region',
    'the generic bytecode family is selected');
  t.equal(jvm.jit.handwrittenFusedRegionCount | 0, 0,
    'no handwritten target is installed');

  const wrapperSource = region && region.wrapperKernel.jvmLexicalFusedSource;
  const rasterSource = region && region.rasterKernel.jvmLexicalFusedSource;
  const scanlineSource = region && region.scanlineKernel.jvmLexicalFusedSource;
  t.ok(wrapperSource, 'wrapper is emitted by the lexical compiler');
  t.ok(rasterSource, 'raster is emitted by the lexical compiler');
  t.ok(scanlineSource, 'array-store loop is emitted by the lexical compiler');

  const generatedSource = [wrapperSource, rasterSource, scanlineSource].join('\n');
  for (const forbidden of [
    'switch (pc)', 'switch(pc)', 'new Frame', '.stack.items',
    'tryInvokeSyncAt', 'runGeneratedFrame',
  ]) {
    t.notOk(generatedSource.includes(forbidden),
      `generated region does not contain ${forbidden}`);
  }
  t.ok(wrapperSource.includes('region.rasterKernel('),
    'wrapper calls the raster kernel positionally');
  t.ok(rasterSource.includes('region.scanlineKernel('),
    'raster calls the scanline kernel positionally');
  t.ok(scanlineSource.includes('while(true)'),
    'the guest back-edge is a lexical JavaScript loop');
  t.ok(/\blet l\d+/.test(scanlineSource),
    'guest locals are scalar JavaScript locals');

  const pixels = new Int32Array(256);
  const invocations = 2000;
  const caller = new Frame(callerMethod);
  caller.locals[0] = pixels;
  caller.locals[1] = pixels.length;
  caller.locals[2] = invocations;
  const callStack = new Stack();
  callStack.push(caller);
  const thread = {
    id: 1,
    status: 'runnable',
    pendingException: null,
    callStack,
  };
  jvm._nextEventLoopYieldAt = Date.now() + 60000;
  const started = performance.now();
  let quanta = 0;
  while (!callStack.isEmpty()) {
    const result = generatedCaller(caller, thread, jvm.jit, false);
    if (result && result.deopt && !result.transient) {
      t.fail(`compiled caller permanently deoptimized: ${result.reason || 'unknown'}`);
      break;
    }
    if (++quanta > 8) {
      t.fail('compiled caller exceeded its scheduler-quantum watchdog');
      break;
    }
    jvm._nextEventLoopYieldAt = Date.now() + 60000;
  }
  const elapsedMs = performance.now() - started;

  t.equal(jvm.jit.fusedDirectRunCount, invocations,
    'every hot-loop invocation uses the direct fused entry');
  t.equal(jvm.jit.fusedRunCount, invocations,
    'every direct entry completes the complete fused region');
  t.equal(jvm.jit.fusedGuardedFallbackCount, 0,
    'the hot path never falls through generic dispatch');
  t.equal(jvm.jit.structuredSsa.runCount, 1,
    'the caller remains in one structured invocation across the complete loop');
  t.ok(callStack.isEmpty(), 'the structured caller returns normally');
  t.equal(jvm.jit.handwrittenFusedRunCount | 0, 0,
    'the handwritten target never executes');
  t.equal(pixels[0], invocations, 'the first destination value is correct');
  t.equal(pixels[pixels.length - 1], invocations,
    'the final destination value is correct');
  t.ok(elapsedMs < 5000,
    `proxy completes under the 5s watchdog (${elapsedMs.toFixed(2)}ms)`);
  t.comment(`proxy ${invocations} regions / ${invocations * 4 * pixels.length} stores: ` +
    `${elapsedMs.toFixed(2)}ms`);
  t.end();
});
