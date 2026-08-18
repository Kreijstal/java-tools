const test = require('tape');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

/*
 * JVM_JIT_DENY is the bisection lever: denying a class must remove every
 * compiled copy of its methods so a miscompile can be attributed to one
 * class without disabling a whole tier. A fused region compiles three
 * methods drawn from up to three different classes, and the fused compiler
 * used to consult no deny list at all, so denying any participant was a
 * silent no-op there. That made a class bisect over a fused region point
 * away from the class that actually owned the bug.
 *
 * The proxy below mirrors test/fusedHotLoopRegression.test.js: fusion is
 * selected from repeated-call and CFG structure, never from these names.
 */

function instruction(op, arg) {
  return { instruction: arg === undefined ? op : { op, arg } };
}

function staticCall(owner, name, descriptor) {
  return instruction('invokestatic', ['Method', owner, [name, descriptor]]);
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

// deniedClasses is applied to the compiler's cache directly rather than
// through process.env so one test cannot leak a deny list into another.
function buildFusedProxy(deniedClasses) {
  const jvm = new JVM({ jit: {
    warmupThreshold: 0,
    fusedRegions: true,
    structuredSsa: true,
    directFusedCalls: true,
    lexicalFusedKernels: true,
  } });
  const compiler = jvm.jit.fusedRegions;
  compiler.lexicalKernelsEnabled = true;
  jvm.jit.jitDenyClasses = new Set(deniedClasses || []);

  const proxy = makeProxy();
  install(jvm, proxy.owners.wrapper, proxy.wrapper);
  install(jvm, proxy.owners.raster, proxy.raster);
  install(jvm, proxy.owners.scanline, proxy.scanline);

  const callerMethod = hotCaller(
    proxy.owners.wrapper, proxy.names.wrapper, proxy.descriptor);
  return { jvm, compiler, proxy, callerMethod };
}

function directEntryFor(compiler, wrapper) {
  return compiler.directEntries.find((candidate) =>
    candidate.target && candidate.target.method === wrapper);
}

test('an undenied fused region still compiles across its three classes', (t) => {
  const { jvm, compiler, proxy, callerMethod } = buildFusedProxy([]);

  t.ok(compiler.mayFuse(proxy.wrapper),
    'the wrapper is admitted for fusion when no class is denied');
  const region = compiler.compile(proxy.wrapper, proxy.owners.wrapper);
  t.ok(region, 'the three-method region compiles');
  t.equal(region && region.family.name, 'bytecode-region',
    'the generic bytecode family is selected');

  jvm.jit.structuredSsa.compile(callerMethod);
  t.ok(directEntryFor(compiler, proxy.wrapper),
    'the caller gets a positional direct-call site into the region');
  t.end();
});

test('denying any class in a fused region dissolves the region', (t) => {
  const proxyOwners = makeProxy().owners;
  for (const role of ['wrapper', 'raster', 'scanline']) {
    const denied = proxyOwners[role];
    const { jvm, compiler, proxy, callerMethod } = buildFusedProxy([denied]);

    // Only the wrapper is reachable from mayFuse(); a denied raster or
    // scanline has to be caught by compile(), which is the case the old
    // code missed entirely.
    if (role === 'wrapper') {
      t.notOk(compiler.mayFuse(proxy.wrapper),
        `mayFuse refuses a denied ${role} (${denied})`);
    } else {
      t.ok(compiler.mayFuse(proxy.wrapper),
        `mayFuse still admits the undenied wrapper when ${role} is denied`);
    }

    t.equal(compiler.compile(proxy.wrapper, proxy.owners.wrapper), null,
      `compile refuses a region whose ${role} class is denied (${denied})`);

    // A positional site may still be emitted -- the entry is also the
    // deferred-resolution slot for a not-yet-loaded owner. What the deny
    // list has to guarantee is that no fused kernel ever runs behind it.
    jvm.jit.structuredSsa.compile(callerMethod);
    const entry = directEntryFor(compiler, proxy.wrapper);
    t.equal(entry ? entry.region : null, null,
      `no fused region is linked to the direct site when ${role} is denied`);
    if (entry) {
      const pixels = new Int32Array(8);
      const frame = new Frame(callerMethod);
      const callStack = new Stack();
      callStack.push(frame);
      const thread = { id: 1, status: 'runnable', pendingException: null, callStack };
      t.notOk(compiler.tryInvokeDirectAt(
        entry.id, frame, thread, pixels, 0, pixels.length, 1),
      `the direct site falls back to generic dispatch when ${role} is denied`);
      t.equal(pixels[0], 0,
        `the denied region produces no fused side effect for ${role}`);
    }
    t.equal(jvm.jit.fusedRunCount || 0, 0,
      `no fused region executes when ${role} is denied`);
  }
  t.end();
});
