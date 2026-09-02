const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
const {parse} = require('acorn');
const {JVM} = require('../src/core/jvm');
const Stack = require('../src/core/stack');
const Frame = require('../src/core/frame');

function fixture(className, source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-region-'));
  const sourcePath = path.join(directory, `${className}.java`);
  fs.writeFileSync(sourcePath, source);
  execFileSync('javac', ['-g', '-d', directory, sourcePath]);
  return directory;
}

function regionFunctionNames(source) {
  return parse(source, {
    ecmaVersion: 'latest', allowReturnOutsideFunction: true,
  }).body.filter((node) => node.type === 'FunctionDeclaration')
    .map((node) => node.id.name);
}

test('hot call-graph roots have a conservative structural size bound', (t) => {
  const ordinary = new JVM({jit: {hotCallGraphRegions: true}});
  const widened = new JVM({jit: {
    hotCallGraphRegions: true,
    hotCallGraphMaxRootCodeItems: 4096,
    hotCallGraphDirectSafePointBudget: 256,
  }});

  t.equal(ordinary.jit.hotCallGraphRegions.maxRootCodeItems, 2048,
    'the default admits large roots after structural edge verification');
  t.equal(widened.jit.hotCallGraphRegions.maxRootCodeItems, 4096,
    'an explicit structural experiment can widen the root bound');
  t.equal(widened.jit.hotCallGraphRegions.directSafePointBudget, 256,
    'a fused graph can use a browser-sized scheduler quantum');
  t.equal(ordinary.jit.hotCallGraphRegions.loopOutliningEnabled,
    process.env.JVM_ENABLE_HOT_CALL_GRAPH_LOOP_OUTLINING === '1',
    'post-render loop outlining stays off unless it is explicitly enabled');
  t.end();
});

test('hot call-graph roots compile whole SSA before local loop extraction',
  (t) => {
  const jvm = new JVM({jit: {
    structuredSsa: true,
    hotCallGraphRegions: true,
  }});
  const method = {
    name: 'arbitraryDenseLoop', descriptor: '()I', flags: ['static'],
    attributes: [{type: 'code', code: {
      codeItems: [], exceptionTable: [], localsSize: '0', stackSize: '0',
    }}],
  };
  let localExtractionAttempts = 0;
  const structured = function arbitraryWholeGraphBody() {};
  structured.jvmStructuredSsa = true;
  structured.jvmStructuredRequiresBaselineFramedEntry = false;
  jvm.jit.isDynamicArrayStructuredFirstMethod = () => true;
  jvm.jit.compileInlinePrimitiveLoopRegions = () => {
    localExtractionAttempts += 1;
    return [{}];
  };
  jvm.jit.structuredSsa.compile = () => structured;
  jvm.jit.withResumeBody = (body) => body;

  t.equal(jvm.jit.compileMethod(method), structured,
    'the initial method entry selects the complete structured body');
  t.equal(localExtractionAttempts, 0,
    'a local baseline fragment cannot postpone whole-graph compilation');
  t.end();
});

test('a hot graph can own SSA independently of a cached ordinary tier', (t) => {
  const jvm = new JVM({jit: {
    structuredSsa: true,
    hotCallGraphRegions: true,
    graphOwnedStructuredCandidates: true,
  }});
  const method = {
    name: 'arbitraryReachableCallee', descriptor: '(I)I', flags: ['static'],
    attributes: [{type: 'code', code: {
      codeItems: [
        {instruction: 'iload_0'},
        {instruction: 'ireturn'},
      ],
      exceptionTable: [], localsSize: '1', stackSize: '1',
    }}],
  };
  const canonical = function ordinaryMethodTier() {};
  const graphOwned = function graphOwnedStructuredTier() {};
  graphOwned.jvmStructuredSsa = true;
  let compiles = 0;
  jvm.jit.codegenCache.set(method, canonical);
  jvm.jit.structuredSsa.compile = (candidate) => {
    compiles += 1;
    t.equal(candidate, method,
      'graph lowering is requested by Method identity');
    return graphOwned;
  };

  t.equal(jvm.jit.getStructuredRegionCandidate(method, canonical), graphOwned,
    'the reachable callee receives a graph-owned structured body');
  t.equal(jvm.jit.getStructuredRegionCandidate(method, canonical), graphOwned,
    'the graph-owned lowering is reused');
  t.equal(compiles, 1,
    'the graph does not repeatedly lower the same reachable method');
  t.equal(jvm.jit.codegenCache.get(method), canonical,
    'the canonical method tier remains the fallback and guard identity');
  t.equal(jvm.jit.regionStructuredCandidateCompileCount, 1,
    'graph-owned compilation is observable without invocation profiling');
  t.end();
});

test('graph-owned SSA remains an explicit experiment', (t) => {
  const jvm = new JVM({jit: {
    structuredSsa: true,
    hotCallGraphRegions: true,
  }});
  const method = {
    name: 'comparisonCallee', descriptor: '()V', flags: ['static'],
    attributes: [{type: 'code', code: {codeItems: [{instruction: 'return'}],
      exceptionTable: [], localsSize: '0', stackSize: '0'}}],
  };
  const canonical = function ordinaryComparisonTier() {};
  let compiles = 0;
  jvm.jit.structuredSsa.compile = () => {
    compiles += 1;
    return null;
  };

  t.equal(jvm.jit.getStructuredRegionCandidate(method, canonical), null,
    'the production path leaves an ordinary callee at a graph boundary');
  t.equal(compiles, 0,
    'the disabled path performs no hidden structured compilation');
  t.end();
});

test('bounded call-free array leaves are graph-owned by structure', (t) => {
  const jvm = new JVM({jit: {
    structuredSsa: true,
    hotCallGraphRegions: true,
  }});
  const method = {
    name: 'arbitraryArrayLeaf', descriptor: '([II)V', flags: ['static'],
    attributes: [{type: 'code', code: {
      codeItems: [
        {labelDef: 'L0:', instruction: 'aload_0'},
        {instruction: 'iload_1'},
        {instruction: 'iconst_0'},
        {instruction: 'iastore'},
        {instruction: 'aload_0'},
        {instruction: 'iload_1'},
        {instruction: 'iconst_1'},
        {instruction: 'iastore'},
        {instruction: 'aload_0'},
        {instruction: 'iload_1'},
        {instruction: 'iconst_2'},
        {instruction: 'iastore'},
        {instruction: 'aload_0'},
        {instruction: 'iload_1'},
        {instruction: 'iconst_3'},
        {instruction: 'iastore'},
        {instruction: {op: 'goto', arg: 'L0'}},
      ],
      exceptionTable: [], localsSize: '2', stackSize: '3',
    }}],
  };
  const canonical = function ordinaryArrayLeafTier() {};
  const graphOwned = function graphOwnedArrayLeafTier() {};
  graphOwned.jvmStructuredSsa = true;
  let compiles = 0;
  jvm.jit.structuredSsa.compile = () => {
    compiles += 1;
    return graphOwned;
  };

  t.ok(jvm.jit.isGraphOwnedStructuredLeafCandidate(method),
    'CFG and primitive-array traffic select the bounded leaf');
  t.equal(jvm.jit.getStructuredRegionCandidate(method, canonical), graphOwned,
    'a caller-owned graph requests structured SSA without a global opt-in');
  t.equal(compiles, 1,
    'the structural leaf is lowered exactly once');
  t.end();
});

test('graph-owned SSA closes an edge across an ordinary-tier cache',
  async (t) => {
  const className = 'GraphOwnedCallee';
  const classpath = fixture(className, `
public class GraphOwnedCallee {
  static int leaf(int[] values, int index) { return values[index]; }
  static int root(int[] values, int rounds) {
    int sum = 0;
    for (int round = 0; round < rounds; round++) {
      for (int index = 0; index < values.length; index++) {
        sum += leaf(values, index);
      }
    }
    return sum;
  }
}
`);
  t.teardown(() => fs.rmSync(classpath, {recursive: true, force: true}));
  const jvm = new JVM({classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    hotCallGraphRegions: true,
    graphOwnedStructuredCandidates: true,
  }});
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const leaf = await jvm.findMethodInHierarchy(className, 'leaf', '([II)I');
  const root = await jvm.findMethodInHierarchy(className, 'root', '([II)I');
  const ordinaryLeaf = jvm.jit.compileBaselineMethod(leaf, []);
  t.notOk(ordinaryLeaf.jvmStructuredSsa,
    'the independent callee cache starts in the ordinary tier');
  jvm.jit.codegenCache.set(leaf, ordinaryLeaf);
  jvm.jit.getGeneratedFunction(root);
  const plan = jvm.jit.compileHotCallGraphRegion(root);
  const leafNode = plan?.nodes.find((node) => node.method === leaf);

  t.ok(plan?.backendEligible && leafNode,
    'graph traversal jointly admits the ordinary-tier callee');
  t.equal(leafNode.canonicalGenerated, ordinaryLeaf,
    'the plan guards the canonical fallback identity');
  t.ok(leafNode.generated.jvmStructuredSsa,
    'the emitted node uses graph-owned structured SSA');
  t.notEqual(leafNode.generated, ordinaryLeaf,
    'graph lowering does not replace the ordinary method cache');
  const values = [2, 5, 9];
  values.type = '[I';
  const thread = {status: 'runnable', callStack: new Stack()};
  t.equal(plan.body(jvm.jit, values, 4, thread, false), 64,
    'the jointly lowered graph preserves scalar call results');
  t.equal(thread.callStack.size(), 0,
    'the closed edge creates no canonical child Frame');
  t.end();
});

test('hot call-graph backend outlines oversized loops by AST structure',
  async (t) => {
  const className = 'OutlinedGraphLoop';
  const repeatedAdds = Array.from({length: 80}, () =>
    'sum += values[index];').join('\n');
  const classpath = fixture(className, `
public class ${className} {
  static int leaf(int[] values) {
    int sum = 0;
    for (int index = 0; index < values.length; index++) {
      ${repeatedAdds}
      sum += 100 / values[index];
      if (values[index] == 99) return sum;
    }
    return sum;
  }
  static int root(int[] values) { return leaf(values) + 1; }
}
`);
  t.teardown(() => fs.rmSync(classpath, {recursive: true, force: true}));
  const jvm = new JVM({classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    structuredRunCounters: false,
    hotCallGraphRegions: true,
    hotCallGraphLoopOutlining: true,
    hotCallGraphLoopOutlineSourceBytes: 4096,
  }});
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const root = await jvm.findMethodInHierarchy(
    className, 'root', '([I)I');
  const leaf = await jvm.findMethodInHierarchy(
    className, 'leaf', '([I)I');
  jvm.jit.getGeneratedFunction(leaf);
  jvm.jit.getGeneratedFunction(root);
  const plan = jvm.jit.compileHotCallGraphRegion(root);
  const moduleSource = plan?.positionalBody?.jvmHotCallGraphRegionSource || '';
  const values = [1, 99];
  values.type = '[I';
  const thread = {
    id: 0, status: 'runnable', pendingException: null,
    callStack: new Stack(),
  };

  t.ok(plan?.backendEligible,
    'the large numeric callee joins its caller region');
  t.ok(moduleSource.includes('function jvmRegionOutlinedLoop'),
    'the backend emits a separate host optimization unit for the loop');
  t.ok(plan.summary.outlinedLoops >= 1 &&
    plan.summary.outlinedLoopSourceBytes >= 4096,
  'telemetry records the structural split and its source budget');
  t.equal(plan.body(jvm.jit, values, thread, false), 8102,
    'a Java return from inside the outlined loop propagates exactly');
  t.equal(thread.callStack.size(), 0,
    'the successful outlined path creates no canonical child Frame');

  let thrown = null;
  const exceptionalValues = [0];
  exceptionalValues.type = '[I';
  try {
    plan.body(jvm.jit, exceptionalValues, thread, false);
  } catch (error) {
    thrown = error;
  }
  t.equal(thrown?.type, 'java/lang/ArithmeticException',
    'an outlined throwing operation preserves its Java exception');
  t.deepEqual(thread.callStack.items.map((frame) => frame.method),
    [root, leaf],
    'the cold exception path reconstructs omitted frames in call order');
  t.end();
});

test('a late structured upgrade is region-audited at its next stable entry',
  (t) => {
  const jvm = new JVM({jit: {
    warmupThreshold: 2,
    structuredSsa: true,
    hotCallGraphRegions: true,
  }});
  const method = {
    name: 'lateUpgradedLoop', descriptor: '()V', flags: ['static'],
    attributes: [{type: 'code', code: {
      codeItems: [
        {labelDef: 'L0:', instruction: 'iconst_0'},
        {instruction: {op: 'goto', arg: 'L0'}},
      ],
      exceptionTable: [], localsSize: '0', stackSize: '1',
    }}],
  };
  const generated = function lateStructuredBody() {};
  generated.jvmStructuredSsa = true;
  generated.jvmHotCallGraphFramedSource = 'return;';
  generated.jvmStructuredRegionCallSites = [{}];
  jvm.jit.codegenCache.set(method, generated);
  jvm.jit.invocationCounts.set(method, 2);
  let audits = 0;
  jvm.jit.compileHotCallGraphRegion = (candidate) => {
    audits += 1;
    t.equal(candidate, method,
      'the audit uses the upgraded Method identity');
    generated.jvmHotCallGraphRegionPlan = {backendEligible: false};
  };
  const frame = new Frame(method);
  const thread = {status: 'runnable', callStack: new Stack()};

  jvm.jit.runSelectedGeneratedFrame(generated, frame, thread);
  jvm.jit.runSelectedGeneratedFrame(generated, frame, thread);
  t.equal(audits, 1,
    'the attached structural plan suppresses repeated entry audits');
  t.end();
});

test('hot call-graph module executes a generic multi-method loop',
  async (t) => {
  const className = 'GenericCallGraphLoop';
  const classpath = fixture(className, `
public class GenericCallGraphLoop {
  static int leaf(int value, boolean bias) {
    return value * 3 + (bias ? 1 : 2);
  }
  static int middle(int value, boolean bias) {
    return leaf(value, bias) ^ 0x55aa;
  }
  static int hotAcyclicRoot(int value, boolean bias) {
    return middle(value, bias) + leaf(value + 1, !bias);
  }
  static int wideAcyclicRoot(int value, boolean bias) {
    return leaf(value, bias) + leaf(value + 1, bias) +
      leaf(value + 2, bias) + leaf(value + 3, bias) +
      leaf(value + 4, bias) + leaf(value + 5, bias) +
      leaf(value + 6, bias) + leaf(value + 7, bias) +
      leaf(value + 8, bias);
  }
  static int throwingLeaf(int value, boolean bias) {
    return 100 / value + (bias ? 0 : 1);
  }
  static int throwingMiddle(int value, boolean bias) {
    return throwingLeaf(value, bias) + 1;
  }
  static int root(int[] values, int rounds, boolean bias) {
    int sum = 0;
    for (int round = 0; round < rounds; round++) {
      for (int index = 0; index < values.length; index++) {
        sum += middle(values[index], bias) +
          throwingMiddle(values[index], bias);
      }
    }
    return sum;
  }
  static int rootWithCanonicalBoundary(int[] values, int rounds,
      boolean bias) {
    int sum = 0;
    for (int round = 0; round < rounds; round++) {
      for (int index = 0; index < values.length; index++) {
        sum += middle(values[index], bias) +
          throwingMiddle(values[index], bias);
      }
    }
    return sum;
  }
  static int framedRoot(Object[] markers, int[] values, int rounds,
      boolean bias) {
    if (markers[0] == null) return -1;
    int sum = 0;
    for (int round = 0; round < rounds; round++) {
      sum += root(values, 1, bias);
    }
    return sum;
  }
  static int singleEdgeRoot(int[] values, int rounds) {
    return loopingChild(values, rounds);
  }
  static int guardedBoundaryRoot(int[] values, int rounds) {
    return loopingChild(values, rounds);
  }
  static int nestedLoopRoot(int[] values, int outerRounds, int innerRounds) {
    return loopingMiddle(values, outerRounds, innerRounds);
  }
  static int loopingMiddle(int[] values, int outerRounds, int innerRounds) {
    int sum = 0;
    for (int round = 0; round < outerRounds; round++) {
      sum += loopingChild(values, innerRounds);
    }
    return sum;
  }
  static int loopingChild(int[] values, int rounds) {
    int sum = 0;
    for (int round = 0; round < rounds; round++) {
      for (int value : values) sum += value ^ round;
    }
    return sum;
  }
  static int lookupRoot(int[] table, int rounds) {
    int sum = 0;
    for (int index = 0; index < rounds; index++) sum += lookup(table, 0);
    return sum;
  }
  static int lookup(int[] table, int index) {
    return table[index];
  }
  int stable = 7;
  int mutated;
  int optionalFlag;
  int[] optionalValues;
  final int change(int delta) {
    mutated += delta;
    return stable;
  }
  static int cachedFieldRoot(GenericCallGraphLoop receiver, int rounds) {
    int sum = 0;
    for (int index = 0; index < rounds; index++) {
      sum += receiver.stable;
      sum += receiver.change(1);
      sum += receiver.stable;
    }
    return sum;
  }
  final int readOptional(int index) {
    return optionalFlag == 0 ? index + 1 : optionalValues[index];
  }
  static GenericCallGraphLoop[] fixedReceivers;
  static int readResolvedStaticReceiver(int index) {
    return fixedReceivers[index].stable;
  }
  static int resolvedStaticReceiverRoot(int rounds) {
    int sum = 0;
    for (int index = 0; index < rounds; index++) {
      sum += readResolvedStaticReceiver(index & 1);
    }
    return sum;
  }
  static int recursiveLeaf(int value) {
    return value <= 0 ? 0 : value + recursiveLeaf(value - 1);
  }
  static int recursiveRegionRoot(int rounds) {
    int sum = 0;
    for (int index = 0; index < rounds; index++) sum += recursiveLeaf(5);
    return sum;
  }
}
`);
  t.teardown(() => fs.rmSync(classpath, {recursive: true, force: true}));
  const jvm = new JVM({classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    structuredRunCounters: false,
    hotCallGraphRegions: true,
    hotCallGraphMaxInlineSitesPerTarget: 8,
    profileMethods: false,
  }});
  t.equal(jvm.jit.hotCallGraphRegions.expansionEntryThreshold, 1,
    'an opt-in hot graph expands a newly generated edge on its first entry');
  t.equal(jvm.jit.hotCallGraphRegions.expansionProbeInterval, 0,
    'stable graphs do not periodically rebuild without a changed dependency');
  const classData = await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const method = await jvm.findMethodInHierarchy(
    className, 'root', '([IIZ)I');
  const generatedRoot = jvm.jit.getGeneratedFunction(method);
  jvm.jit.invocationCounts.set(method, 1);
  t.ok(jvm.jit.shouldCompileHotCallGraphRegion(method),
    'ordinary JIT heat admits a loop with published call edges');
  const plan = jvm.jit.compileHotCallGraphRegion(method);

  t.ok(plan?.body && plan.backendEligible,
    'an acyclic exact graph emits one executable JavaScript module');
  const rebuiltBody = jvm.jit.hotCallGraphRegions.compileModule(plan, false);
  t.ok(rebuiltBody,
    'the same verified plan can be emitted again during graph expansion');
  t.equal(jvm.jit.hotCallGraphRegions.callBindingParseCount, 0,
    'region composition never parses a generated source');
  t.equal(plan.nodes.length, 5,
    'the module contains every transitive exact node');
  t.equal(plan.loweredEdgeCount, 2,
    'admission requires real cross-method lowering rather than a root wrapper');
  t.ok(plan.lexicallyInlinedEdgeCount >= 3,
    'non-throwing leaves and a restoring call chain share caller SSA namespaces');
  const leafMethodForInline = await jvm.findMethodInHierarchy(
    className, 'leaf', '(IZ)I');
  const middleMethodForInline = await jvm.findMethodInHierarchy(
    className, 'middle', '(IZ)I');
  const leafNodeIndex = plan.nodes.findIndex((node) =>
    node.method === leafMethodForInline);
  const middleNodeIndex = plan.nodes.findIndex((node) =>
    node.method === middleMethodForInline);
  const rootModuleSource = plan.positionalBody.jvmHotCallGraphRegionSource;
  const middleStartForInline = rootModuleSource.indexOf(
    `function jvmRegionNode${middleNodeIndex}(`);
  const middleEndForInline = rootModuleSource.indexOf(
    '\nfunction jvmRegionNode', middleStartForInline + 1);
  const scalarMiddleSource = rootModuleSource.slice(
    middleStartForInline,
    middleEndForInline < 0 ? undefined : middleEndForInline);
  t.notOk(scalarMiddleSource.includes(`jvmRegionNode${leafNodeIndex}(`),
    'the caller consumes leaf operands and returns without a JS call');
  t.notOk(rootModuleSource.includes(
    `function jvmRegionNode${leafNodeIndex}(`),
  'a leaf with no remaining incoming edge is removed from the emitted module');
  t.equal(plan.summary.locallyLinkedEdges, plan.connectedEdgeCount,
    'telemetry distinguishes local module links from scaffold deletion');
  t.equal(plan.summary.scaffoldElidedEdges, plan.loweredEdgeCount,
    'telemetry reports only proven restoration-scaffold deletion');
  t.ok(plan?.body?.jvmHotCallGraphRegionSource.includes('jvmRegionNode4'),
    'the emitted module owns multiple locally linked node functions');
  t.notOk(plan.body.jvmHotCallGraphRegionSource.includes(
    'structuredSsa.restoringDirectRunCount += 1'),
  'production region nodes contain no per-invocation profiling mutation');
  t.ok(generatedRoot.jvmStructuredContinuation,
    'the loop root retains scheduler-safe lexical continuation support');
  t.notOk(generatedRoot.jvmAdaptivePositionalOrdinary,
    'an opt-in hot-region positional root does not discard its iterator');
  const rootTarget = {
    method, lookupClass: className, generated: generatedRoot,
  };
  const rootSite = {
    op: 'invokestatic', descriptor: '([IIZ)I',
    params: ['int[]', 'int', 'boolean'], returnType: 'int',
    initializationToken: {initialized: true},
    declaredClassName: className,
  };
  const rootInvoker = jvm.jit.getPositionalGeneratedInvoker(
    rootSite, rootTarget);
  t.ok(rootInvoker, 'the region root still publishes a positional caller ABI');
  t.notEqual(rootInvoker.jvmRawInvoke,
    generatedRoot.jvmHotCallGraphDirectPositionalBody,
  'a continuation-capable caller does not discard the regional iterator after one finite quantum');
  t.equal(typeof generatedRoot.jvmHotCallGraphDirectPositionalBody, 'function',
    'the bounded ordinary module remains available for differential execution');
  t.ok(plan.positionalBody.jvmHotCallGraphRegionSource.includes(
    `let safePointBudget = ${jvm.jit.hotCallGraphRegions
      .directSafePointBudget};`),
  'the ordinary module retains a bounded structural safe-point counter');
  t.equal((plan.positionalBody.jvmHotCallGraphRegionSource.match(
    /let safePointBudget =/g) || []).length, 1,
  'the fused graph owns one shared quantum instead of resetting it per node');
  t.ok(generatedRoot.jvmAdaptivePositionalSource.includes('yield '),
    'the bounded ordinary module retains an iterator-owning fallback ABI');
  t.equal(generatedRoot.jvmStructuredRuntimeCoarseTripLimit,
    jvm.jit.hotCallGraphRegions.directSafePointBudget,
    'a region root admits verified counted subloops within its finite quantum');

  const leafMethod = await jvm.findMethodInHierarchy(
    className, 'leaf', '(IZ)I');
  t.notOk(jvm.jit.shouldCompileHotCallGraphRegion(leafMethod),
    'a warmed call-free leaf does not manufacture a region root');
  const singleton = jvm.jit.compileHotCallGraphRegion(leafMethod);
  t.notOk(singleton.backendEligible || singleton.body,
    'a single-node wrapper cannot be installed as a call-graph region');

  const hotAcyclicRoot = await jvm.findMethodInHierarchy(
    className, 'hotAcyclicRoot', '(IZ)I');
  const generatedHotAcyclicRoot = jvm.jit.getGeneratedFunction(hotAcyclicRoot);
  t.notOk(jvm.jit.hasBackwardBranch(hotAcyclicRoot),
    'the acyclic caller has no loop of its own');
  t.notOk(jvm.jit.shouldCompileHotCallGraphRegion(hotAcyclicRoot),
    'an unproven cold acyclic caller is not region-compiled');
  jvm.jit.promoteAdaptiveCodegen(hotAcyclicRoot);
  t.ok(jvm.jit.shouldCompileHotCallGraphRegion(hotAcyclicRoot),
    'runtime heat admits an acyclic caller above hot descendants');
  const hotAcyclicPlan = jvm.jit.compileHotCallGraphRegion(hotAcyclicRoot);
  t.ok(hotAcyclicPlan?.backendEligible && hotAcyclicPlan.nodes.length > 1,
    'the promoted caller and its reachable callees share one region');
  const hotAcyclicSource = hotAcyclicPlan.positionalBody
    .jvmHotCallGraphRegionSource;
  t.deepEqual(regionFunctionNames(hotAcyclicSource), ['jvmRegionNode0'],
    'the three-level closed call graph is one generated SSA function');
  t.notOk(hotAcyclicSource.includes('jvmRegionNode1('),
    'the root has no remaining JavaScript call to its wrapper');
  const middleNode = hotAcyclicPlan.nodes.find((node) =>
    node.method === middleMethodForInline);
  t.equal(typeof middleNode.generated.jvmDirectPositionalBody, 'object',
    'a call-bearing wrapper is not exposed as a standalone direct ABI');
  t.equal(typeof middleNode.generated.jvmInternalRegionPositionalSource,
    'string',
    'the same wrapper publishes internal IR for guarded graph composition');
  t.equal(generatedHotAcyclicRoot.jvmHotCallGraphRegionPlan, hotAcyclicPlan,
    'the jointly lowered entry is published without a guest identity rule');

  const wideAcyclicRoot = await jvm.findMethodInHierarchy(
    className, 'wideAcyclicRoot', '(IZ)I');
  jvm.jit.promoteAdaptiveCodegen(wideAcyclicRoot);
  const wideAcyclicPlan = jvm.jit.compileHotCallGraphRegion(wideAcyclicRoot);
  const wideAcyclicSource = wideAcyclicPlan.positionalBody
    .jvmHotCallGraphRegionSource;
  t.equal(wideAcyclicPlan.connectedEdgeCount, 9,
    'the wide graph retains every exact call edge');
  t.deepEqual(regionFunctionNames(wideAcyclicSource),
    ['jvmRegionNode0', 'jvmRegionNode1'],
    'the per-target site budget keeps a wide leaf as one local function');
  t.deepEqual(wideAcyclicPlan.summary.inlineAdmissionReasons,
    [{reason: 'target-site-budget', count: 9}],
    'telemetry identifies the structural anti-bloat decision');

  const values = [2, -4, 9, 17];
  values.type = '[I';
  const thread = {
    id: 0, status: 'runnable', pendingException: null,
    callStack: new Stack(),
  };
  const yieldingThread = {
    id: 1, status: 'runnable', pendingException: null,
    callStack: new Stack(),
  };
  jvm._nextEventLoopYieldAt = 0;
  const yieldedRoot = rootInvoker(values, 1000001, 1, yieldingThread);
  t.ok(yieldedRoot?.deopt,
    'an expired regional quantum returns to canonical scheduling');
  const yieldedFrame = yieldingThread.callStack.peek();
  t.equal(yieldedFrame?.method, method,
    'the scheduler sees exactly one canonical region-root Frame');
  t.ok(generatedRoot.jvmHotCallGraphHasContinuation(yieldedFrame),
    'the yielded positional root retains the regional iterator');
  t.equal(yieldingThread.callStack.size(), 1,
    'internal region nodes remain omitted across the scheduler boundary');
  jvm._nextEventLoopYieldAt = Infinity;
  const singleEdgeRoot = await jvm.findMethodInHierarchy(
    className, 'singleEdgeRoot', '([II)I');
  const singleEdgePlan = jvm.jit.compileHotCallGraphRegion(singleEdgeRoot);
  t.ok(singleEdgePlan?.backendEligible && singleEdgePlan.body,
    'one exact call site into a looping child forms a region');
  t.equal(singleEdgePlan.connectedEdgeCount, 1,
    'connected-graph admission does not require duplicate bytecode sites');
  t.equal(singleEdgePlan.loweredEdgeCount, 0,
    'the looping child remains a local region function, not a leaf splice');
  const expectedSingleEdge = Array.from({length: 7}, (_unused, round) =>
    values.reduce((sum, value) => (sum + (value ^ round)) | 0, 0))
    .reduce((sum, value) => (sum + value) | 0, 0);
  t.equal(singleEdgePlan.body(jvm.jit, values, 7, thread, false),
    expectedSingleEdge,
  'the single-edge region feeds scalar arguments and return values exactly');
  const atomicRounds = 20000;
  const expectedAtomic = Array.from({length: atomicRounds}, (_unused, round) =>
    values.reduce((sum, value) => (sum + (value ^ round)) | 0, 0))
    .reduce((sum, value) => (sum + value) | 0, 0);
  jvm._nextEventLoopYieldAt = 0;
  t.equal(singleEdgePlan.body(
    jvm.jit, values, atomicRounds, thread, false), expectedAtomic,
  'a regional child loop stays scalar when its root owns the scheduler quantum');
  t.equal(thread.callStack.size(), 0,
    'the internal loop does not materialize a child Frame at its poll budget');
  jvm._nextEventLoopYieldAt = Infinity;

  const guardedBoundaryRoot = await jvm.findMethodInHierarchy(
    className, 'guardedBoundaryRoot', '([II)I');
  const guardedLoopingChildMethod = await jvm.findMethodInHierarchy(
    className, 'loopingChild', '([II)I');
  const loopingChildGenerated = jvm.jit.getGeneratedFunction(
    guardedLoopingChildMethod);
  const priorRangeGuardDeopts =
    loopingChildGenerated.jvmStructuredRestoringRangeGuardDeoptCount;
  const priorRestoringSource =
    loopingChildGenerated.jvmRestoringDirectPositionalSource;
  loopingChildGenerated.jvmStructuredRestoringRangeGuardDeoptCount = 1;
  loopingChildGenerated.jvmRestoringDirectPositionalSource = [
    "'use strict';",
    'const child = new plan.Frame(plan.method);',
    'child.locals = [argument0, argument1];',
    'child.pc = 0;',
    'thread.callStack.push(child);',
    "return {deopt: true, transient: true, reason: 'fixture child deopt'};",
  ].join('\n');
  const guardedBoundaryPlan = jvm.jit.compileHotCallGraphRegion(
    guardedBoundaryRoot);
  t.ok(guardedBoundaryPlan.nodes.some((node) =>
    node.method === guardedLoopingChildMethod),
  'a transiently deoptimizing callee remains in the jointly emitted graph');
  t.equal(guardedBoundaryPlan.nodes.flatMap((node) =>
    node.boundaries).length, 0,
  'the deoptimizing edge does not fall back to method-at-a-time dispatch');
  const guardedThread = {
    id: 2, status: 'runnable', pendingException: null,
    callStack: new Stack(),
  };
  const guardedResult = guardedBoundaryPlan.body(
    jvm.jit, values, 2, guardedThread, false);
  t.ok(guardedResult?.deopt,
    'the child deoptimization escapes the regional host call stack');
  t.deepEqual(guardedThread.callStack.items.map((entry) => entry.method),
    [guardedBoundaryRoot, guardedLoopingChildMethod],
  'the region reconstructs omitted callers outside-to-inside');
  const guardedInvokePc = jvm.jit.getCodeItems(guardedBoundaryRoot)
    .findIndex((item) => String(item.instruction?.op || item.instruction)
      .startsWith('invokestatic'));
  t.equal(guardedThread.callStack.items[0].pc, guardedInvokePc + 1,
    'the omitted caller resumes after its active child returns');
  guardedThread.callStack.items.length = 0;
  loopingChildGenerated.jvmStructuredRestoringRangeGuardDeoptCount =
    priorRangeGuardDeopts;
  loopingChildGenerated.jvmRestoringDirectPositionalSource =
    priorRestoringSource;

  const nestedRootMethod = await jvm.findMethodInHierarchy(
    className, 'nestedLoopRoot', '([III)I');
  const nestedPlan = jvm.jit.compileHotCallGraphRegion(nestedRootMethod);
  const nestedMiddleMethod = await jvm.findMethodInHierarchy(
    className, 'loopingMiddle', '([III)I');
  const nestedChildMethod = await jvm.findMethodInHierarchy(
    className, 'loopingChild', '([II)I');
  const middleIndex = nestedPlan.nodes.findIndex((node) =>
    node.method === nestedMiddleMethod);
  const childIndex = nestedPlan.nodes.findIndex((node) =>
    node.method === nestedChildMethod);
  const moduleSource = nestedPlan.positionalBody.jvmHotCallGraphRegionSource;
  const middleStart = moduleSource.indexOf(
    `function jvmRegionNode${middleIndex}(`);
  const middleEnd = moduleSource.indexOf(
    '\nfunction jvmRegionNode', middleStart + 1);
  const middleSource = moduleSource.slice(
    middleStart, middleEnd < 0 ? undefined : middleEnd);
  t.ok(nestedPlan.nodes[middleIndex].edges.some((edge) =>
    edge.node === nestedPlan.nodes[childIndex]),
  'the graph IR links the closed non-atomic child through its scalar ABI');
  t.equal(middleSource.split('helpers.tryInvokeSyncAt').length - 1, 1,
    'the closed internal edge retains one cold-only canonical call island');
  const nestedExpected = 3 * Array.from({length: 5}, (_unused, round) =>
    values.reduce((sum, value) => (sum + (value ^ round)) | 0, 0))
    .reduce((sum, value) => (sum + value) | 0, 0);
  t.equal(nestedPlan.body(jvm.jit, values, 3, 5, thread, false),
    nestedExpected,
  'three non-atomic call-graph levels preserve scalar results');
  t.equal(thread.callStack.size(), 0,
    'the compact normal path materializes no child Frame');
  let nestedException = null;
  try {
    nestedPlan.body(jvm.jit, null, 1, 1, thread, false);
  } catch (error) {
    nestedException = error;
  }
  t.equal(nestedException?.type, 'java/lang/NullPointerException',
    'the compact nested path retains Java null semantics');
  t.deepEqual(thread.callStack.items.map((frame) => frame.method.name),
    ['nestedLoopRoot', 'loopingMiddle', 'loopingChild'],
    'cold restoration reconstructs every omitted frame in call order');
  thread.callStack.items.length = 0;

  const staticReceiverReader = await jvm.findMethodInHierarchy(
    className, 'readResolvedStaticReceiver', '(I)I');
  const staticReceiverGenerated = jvm.jit.getGeneratedFunction(
    staticReceiverReader);
  t.equal(typeof staticReceiverGenerated.jvmRestoringDirectPositionalSource,
    'string',
  'a resolved static reference-array element has a restoring scalar ABI');
  const staticReceivers = jvm.jit.newReferenceArray(2, className);
  for (let index = 0; index < staticReceivers.length; index += 1) {
    staticReceivers[index] = jvm.jit.allocateObject(className);
    staticReceivers[index].fields[`${className}.stable`] = 7 + index;
  }
  classData.staticFields.set(
    `fixedReceivers:[L${className};`, staticReceivers);
  const staticReceiverRoot = await jvm.findMethodInHierarchy(
    className, 'resolvedStaticReceiverRoot', '(I)I');
  const staticReceiverPlan = jvm.jit.compileHotCallGraphRegion(
    staticReceiverRoot);
  t.ok(staticReceiverPlan?.backendEligible,
    'the resolved static object-table reader joins its numeric caller region');
  t.equal(staticReceiverPlan.body(jvm.jit, 6, thread, false), 45,
    'the proven reference element feeds direct instance-field access exactly');
  const optionalReader = await jvm.findMethodInHierarchy(
    className, 'readOptional', '(I)I');
  const optionalGenerated = jvm.jit.getGeneratedFunction(optionalReader);
  const sparseReceiver = jvm.jit.allocateObject(className);
  const optionalPlan = jvm.jit.hotCallGraphRegions.restorationPlan({
    method: optionalReader,
    owner: className,
    generated: optionalGenerated,
  });
  t.equal(optionalGenerated.jvmRestoringDirectPositionalBody(
    jvm.jit, optionalPlan, sparseReceiver, 4, thread, 1), 5,
  'absent resolved fields use JVM zero/null defaults without generic fallback');
  t.equal(thread.callStack.size(), 0,
    'an untaken null optional-array branch does not materialize a Frame');
  const recursiveRoot = await jvm.findMethodInHierarchy(
    className, 'recursiveRegionRoot', '(I)I');
  const recursivePlan = jvm.jit.compileHotCallGraphRegion(recursiveRoot);
  t.ok(recursivePlan?.backendEligible &&
      recursivePlan.standaloneRecursiveNodes.size === 1,
    'a closed singleton recursive SCC joins its enclosing numeric region');
  t.equal(recursivePlan.body(jvm.jit, 9, thread, false), 135,
    'the captured recursive scalar node preserves operands and return values');

  const lookupRoot = await jvm.findMethodInHierarchy(
    className, 'lookupRoot', '([II)I');
  const lookupPlan = jvm.jit.compileHotCallGraphRegion(lookupRoot);
  const lookupMethod = await jvm.findMethodInHierarchy(
    className, 'lookup', '([II)I');
  const lookupNodeIndex = lookupPlan.nodes.findIndex((node) =>
    node.method === lookupMethod);
  const lookupGenerated = jvm.jit.getGeneratedFunction(lookupMethod);
  t.equal(typeof lookupGenerated.jvmTrustedCheckedLeafDirectPositionalSource,
    'string', 'a pure acyclic array lookup publishes a checked scalar ABI');
  const lookupStart = lookupPlan.positionalBody.jvmHotCallGraphRegionSource
    .indexOf(`function jvmRegionNode${lookupNodeIndex}(`);
  const lookupEnd = lookupPlan.positionalBody.jvmHotCallGraphRegionSource
    .indexOf('\nfunction jvmRegionNode', lookupStart + 1);
  const lookupSource = lookupPlan.positionalBody.jvmHotCallGraphRegionSource
    .slice(lookupStart, lookupEnd < 0 ? undefined : lookupEnd);
  t.ok(lookupPlan?.backendEligible && lookupNodeIndex > 0,
    'a loop and its pure array-reading child form a connected region');
  t.equal(lookupPlan.lexicallyInlinedEdgeCount, 1,
    'the bounds-checked lookup is inlined with precise cold restoration');
  t.notOk(lookupSource.includes('new plan.Frame') ||
      lookupSource.includes('materializeDirectFrame') ||
      lookupSource.includes('const restorationDepth'),
    'the internal checked lookup omits cold Frame restoration scaffolding');
  t.equal(lookupPlan.body(jvm.jit, values, 9, thread, false), 18,
    'the compact internal lookup preserves scalar return feeding');

  const cachedFieldRoot = await jvm.findMethodInHierarchy(
    className, 'cachedFieldRoot', '(LGenericCallGraphLoop;I)I');
  const receiver = {
    type: className,
    fields: {
      [`${className}.stable`]: 7,
      [`${className}.mutated`]: 0,
    },
  };
  const cachedFieldGenerated = jvm.jit.getGeneratedFunction(cachedFieldRoot);
  const cachedFieldVirtualSite = cachedFieldGenerated
    .jvmStructuredRegionCallSites.find((site) => site.dynamic);
  const cachedFieldCaller = new Frame(cachedFieldRoot);
  cachedFieldCaller.className = className;
  cachedFieldCaller.stack.items.push(receiver, 1);
  thread.callStack.push(cachedFieldCaller);
  jvm.jit.tryInvokeSyncAt(
    cachedFieldVirtualSite.id, cachedFieldCaller, thread);
  while (thread.callStack.peek() !== cachedFieldCaller) {
    thread.callStack.pop();
  }
  thread.callStack.pop();
  receiver.fields[`${className}.mutated`] = 0;
  const cachedFieldPlan = jvm.jit.compileHotCallGraphRegion(
    cachedFieldRoot, {forceExpansion: true});
  t.ok(cachedFieldPlan?.backendEligible,
    'an exact final receiver edge closes the instance-field region');
  const originalTryInvokeSyncAt = jvm.jit.tryInvokeSyncAt.bind(jvm.jit);
  let genericRegionCalls = 0;
  jvm.jit.tryInvokeSyncAt = (...args) => {
    genericRegionCalls += 1;
    return originalTryInvokeSyncAt(...args);
  };
  t.equal(cachedFieldPlan.body(jvm.jit, receiver, 5, thread, false), 105,
    'the narrowed cache effects preserve the exact scalar result');
  jvm.jit.tryInvokeSyncAt = originalTryInvokeSyncAt;
  t.equal(genericRegionCalls, 0,
    'an exact virtual edge calls its local region node without dispatch');
  t.equal(receiver.fields[`${className}.mutated`], 5,
    'the child field write remains visible on every iteration');
  receiver.fields[`${className}.mutated`] = 0;
  const cachedFramedParent = new Frame(cachedFieldRoot);
  const cachedFramedRoot = new Frame(cachedFieldRoot);
  cachedFramedRoot.className = className;
  cachedFramedRoot.locals.splice(0, 2, receiver, 3);
  thread.callStack.push(cachedFramedParent);
  thread.callStack.push(cachedFramedRoot);
  let cachedFramedGenericCalls = 0;
  jvm.jit.tryInvokeSyncAt = (...args) => {
    cachedFramedGenericCalls += 1;
    return originalTryInvokeSyncAt(...args);
  };
  const cachedFramedResult = jvm.jit.runSelectedGeneratedFrame(
    cachedFieldPlan.framedBody, cachedFramedRoot, thread);
  jvm.jit.tryInvokeSyncAt = originalTryInvokeSyncAt;
  t.ok(cachedFramedResult?.handled,
    'the profiled exact virtual edge executes from a framed module root');
  t.equal(cachedFramedGenericCalls, 0,
    'the framed exact virtual edge removes its redundant PIC scaffold');
  t.equal(cachedFramedParent.stack.pop(), 63,
    'direct framed lowering preserves the child result');
  t.equal(receiver.fields[`${className}.mutated`], 3,
    'direct framed lowering preserves receiver field writes');
  thread.callStack.items.length = 0;

  let expected = 0;
  for (let round = 0; round < 7; round += 1) {
    for (const value of values) {
      const leaf = (value * 3 + 1) | 0;
      expected = (expected + (leaf ^ 0x55aa) + ((100 / value) | 0) + 1) | 0;
    }
  }
  const runsBeforeRoot = jvm.jit.hotCallGraphRegions.runCount;
  const actual = plan.body(jvm.jit, values, 7, 1, thread, false);
  t.equal(actual, expected,
    'cross-method scalar operands feed the jointly emitted region exactly');
  t.equal(thread.callStack.size(), 0,
    'the normal region path creates no canonical child Frame');
  t.equal(jvm.jit.hotCallGraphRegions.runCount, runsBeforeRoot + 1,
    'the guarded region entry is observable');

  jvm.classInitializationState.set(className, 'UNINITIALIZED');
  const rejected = plan.body(jvm.jit, values, 1, 1, thread, false);
  t.equal(rejected, jvm.jit.asyncInvokeSentinel(),
    'a lifecycle guard rejects before entering the generated module');
  t.equal(jvm.jit.hotCallGraphRegions.guardFallbackCount, 1,
    'the before-effects fallback is counted');

  jvm.classInitializationState.set(className, 'INITIALIZED');
  const exceptionalValues = [0];
  exceptionalValues.type = '[I';
  let thrown = null;
  try {
    plan.body(jvm.jit, exceptionalValues, 1, 1, thread, false);
  } catch (error) {
    thrown = error;
  }
  t.equal(thrown?.type, 'java/lang/ArithmeticException',
    'an exception from the innermost jointly lowered node is preserved');
  t.deepEqual(thread.callStack.items.map((frame) => frame.method.name),
    ['root', 'throwingMiddle', 'throwingLeaf'],
    'omitted Java frames are reconstructed in outer-to-inner order');
  const leafFrame = thread.callStack.peek();
  const dividePc = jvm.jit.getCodeItems(leafFrame.method).findIndex((item) =>
    (item.instruction?.op || item.instruction) === 'idiv');
  t.equal(leafFrame.pc, dividePc,
    'the innermost frame records the precise throwing bytecode PC');

  thread.callStack.items.length = 0;
  const framedMethod = await jvm.findMethodInHierarchy(
    className, 'framedRoot', '([Ljava/lang/Object;[IIZ)I');
  const framedGenerated = jvm.jit.getGeneratedFunction(framedMethod);
  jvm.jit.compileHotCallGraphRegion(framedMethod);
  t.equal(typeof framedGenerated.jvmHotCallGraphFramedBody, 'function',
    'a reference-bearing caller publishes a framed multi-method region');
  const markers = [{type: 'java/lang/Object', fields: {}}];
  markers.type = '[Ljava/lang/Object;';
  const framedFrame = new (require('../src/core/frame'))(framedMethod);
  const framedParent = new (require('../src/core/frame'))(framedMethod);
  framedFrame.className = className;
  framedFrame.locals.splice(0, 4, markers, values, 7, 1);
  thread.callStack.push(framedParent);
  thread.callStack.push(framedFrame);
  const originalFramedTryInvoke = jvm.jit.tryInvokeSyncAt.bind(jvm.jit);
  let framedGenericCalls = 0;
  jvm.jit.tryInvokeSyncAt = (...args) => {
    framedGenericCalls += 1;
    return originalFramedTryInvoke(...args);
  };
  const framedResult = jvm.jit.runSelectedGeneratedFrame(
    framedGenerated, framedFrame, thread);
  jvm.jit.tryInvokeSyncAt = originalFramedTryInvoke;
  t.ok(framedResult?.handled,
    'the framed call-graph entry completes through normal JVM return state');
  t.equal(framedGenericCalls, 0,
    'a canonical framed root calls its non-atomic local child directly');
  t.equal(framedParent.stack.pop(), expected,
    'the framed module feeds the same transitive scalar result');
  t.deepEqual(thread.callStack.items, [framedParent],
    'the framed root removes only its own canonical entry frame');

  const throwingLeafGenerated = jvm.jit.getGeneratedFunction(leafFrame.method);
  throwingLeafGenerated.jvmDirectPositionalSource = null;
  throwingLeafGenerated.jvmRestoringDirectPositionalSource = null;
  const boundaryRoot = await jvm.findMethodInHierarchy(
    className, 'rootWithCanonicalBoundary', '([IIZ)I');
  const boundaryPlan = jvm.jit.compileHotCallGraphRegion(boundaryRoot);
  t.ok(boundaryPlan?.backendEligible,
    'one child without a positional ABI does not poison the numeric region');
  t.ok(boundaryPlan.nodes.some((node) => node.boundaries.some((boundary) =>
    boundary.reason === 'target-without-positional-region-abi')),
  'the unsupported child remains an explicit canonical boundary');
  t.notOk(boundaryPlan.nodes.some((node) =>
    node.method === leafFrame.method),
  'the backend never attempts to emit the unsupported child as a local node');
  t.end();
});

test('hot call-graph module scalarizes nested float-filter methods',
  async (t) => {
  const className = 'GenericFloatFilterGraph';
  const classpath = fixture(className, `
public final class GenericFloatFilterGraph {
  static float[][] coefficients;
  static int[] widths;
  static float scale;

  static float curve(float value) {
    return value * value * 0.25f - value * 0.125f;
  }

  static float tap(int index, float phase) {
    return curve(phase + (float) index) * scale;
  }

  static int build(int channel, float phase) {
    float value = tap(0, phase);
    coefficients[channel][0] = value;
    for (int index = 1; index < widths[channel]; index++) {
      value = coefficients[channel][index - 1] * 0.5f + tap(index, phase);
      coefficients[channel][index] = value;
    }
    return (int) (coefficients[channel][widths[channel] - 1] * 65536.0f);
  }

  static int render(int rounds, float phase) {
    int total = 0;
    for (int round = 0; round < rounds; round++) {
      total += build(round & 1, phase + (float) round * 0.01f);
    }
    return total;
  }

  public static void main(String[] arguments) {
    coefficients = new float[][] {new float[4], new float[4]};
    widths = new int[] {4, 3};
    scale = 0.75f;
    System.out.println(render(7, 0.35f));
  }
}
`);
  t.teardown(() => fs.rmSync(classpath, {recursive: true, force: true}));
  const expected = Number(execFileSync(
    'java', ['-cp', classpath, className], {encoding: 'utf8'}).trim());
  const jvm = new JVM({classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    structuredRunCounters: false,
    hotCallGraphRegions: true,
    profileMethods: false,
  }});
  await jvm.loadClassByName(className);
  jvm.classInitializationState.set(className, 'INITIALIZED');
  const widths = jvm.jit.newPrimitiveArray(2, 'int');
  widths[0] = 4;
  widths[1] = 3;
  const rows = [
    jvm.jit.newPrimitiveArray(4, 'float'),
    jvm.jit.newPrimitiveArray(4, 'float'),
  ];
  rows.type = '[[F';
  const staticFields = jvm.classes[className].staticFields;
  staticFields.set('coefficients:[[F', rows);
  staticFields.set('widths:[I', widths);
  staticFields.set('scale:F', Math.fround(0.75));

  const root = await jvm.findMethodInHierarchy(
    className, 'render', '(IF)I');
  const build = await jvm.findMethodInHierarchy(
    className, 'build', '(IF)I');
  const plan = jvm.jit.compileHotCallGraphRegion(root);
  t.ok(plan?.backendEligible && plan.body,
    'a loop-bearing float graph emits one executable region');
  t.ok(plan.nodes.some((node) => node.method === build),
    'the float-array builder is a scalar region node, not a canonical boundary');
  t.notOk(plan.nodes.some((node) => node.boundaries.some((boundary) =>
    boundary.reason === 'target-without-positional-region-abi' &&
      boundary.site?.resolvedMethod === build)),
  'float parameters, returns, casts, and matrix rows retain the positional ABI');
  const buildGenerated = jvm.jit.getGeneratedFunction(build);
  t.equal(typeof buildGenerated.jvmRestoringDirectPositionalSource, 'string',
    'the structural renderer publishes a restoring scalar source for the builder');

  const thread = {
    id: 0, status: 'runnable', pendingException: null,
    callStack: new Stack(),
  };
  jvm._nextEventLoopYieldAt = Infinity;
  t.equal(plan.body(jvm.jit, 7, Math.fround(0.35), thread, false), expected,
    'the fused float graph matches the native JRE result exactly');
  t.equal(thread.callStack.size(), 0,
    'the successful float graph creates no canonical child Frame');

  rows[1] = null;
  let thrown = null;
  try {
    plan.body(jvm.jit, 2, Math.fround(0.35), thread, false);
  } catch (error) {
    thrown = error;
  }
  t.equal(thrown?.type, 'java/lang/NullPointerException',
    'an intermediate null matrix row preserves the Java exception');
  t.deepEqual(thread.callStack.items.map((frame) => frame.method.name),
    ['render', 'build'],
  'the float region reconstructs omitted frames in outer-to-inner order');
  t.end();
});

test('runtime type feedback closes a previously open virtual-call region',
  async (t) => {
  const className = 'DynamicCallGraphLoop';
  const operationName = 'DynamicRegionOperation';
  const classpath = fixture(className, `
class DynamicRegionOperation {
  int apply(int value, boolean bias) {
    return value * 5 + (bias ? 3 : 4);
  }
}
class AlternateDynamicRegionOperation extends DynamicRegionOperation {
  int apply(int value, boolean bias) {
    return value * 7 + (bias ? 9 : 10);
  }
}
public final class DynamicCallGraphLoop {
  static int root(DynamicRegionOperation operation, int[] values,
      int rounds, boolean bias) {
    int sum = 0;
    for (int round = 0; round < rounds; round++) {
      for (int index = 0; index < values.length; index++) {
        sum += operation.apply(values[index], bias);
        sum ^= operation.apply(values[index] + 1, bias);
      }
    }
    return sum;
  }
}
`);
  t.teardown(() => fs.rmSync(classpath, {recursive: true, force: true}));
  const jvm = new JVM({classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    structuredRunCounters: false,
    hotCallGraphRegions: true,
    profileMethods: false,
  }});
  const alternateName = 'AlternateDynamicRegionOperation';
  for (const owner of [className, operationName, alternateName]) {
    await jvm.loadClassByName(owner);
    jvm.classInitializationState.set(owner, 'INITIALIZED');
  }
  const root = await jvm.findMethodInHierarchy(
    className, 'root', `(L${operationName};[IIZ)I`);
  const generated = jvm.jit.getGeneratedFunction(root);
  const initial = jvm.jit.compileHotCallGraphRegion(root);
  t.notOk(initial.backendEligible,
    'unobserved virtual targets keep the first plan open');
  const virtualSites = generated.jvmStructuredRegionCallSites.filter(
    (site) => site.dynamic);
  t.equal(virtualSites.length, 2,
    'the arbitrary loop contains two independent dynamic bytecode edges');

  const receiver = {type: operationName, fields: {}};
  const caller = new Frame(root);
  caller.className = className;
  const thread = {
    id: 0, status: 'runnable', pendingException: null,
    callStack: new Stack(),
  };
  thread.callStack.push(caller);
  for (const site of virtualSites) {
    caller.stack.items.splice(0, caller.stack.items.length, receiver, 7, 1);
    jvm.jit.tryInvokeSyncAt(site.id, caller, thread);
    while (thread.callStack.peek() !== caller) thread.callStack.pop();
  }
  const nextRootEntry = new Frame(root);
  nextRootEntry.className = className;
  jvm.jit.refreshHotCallGraphRegionAtEntry(generated, nextRootEntry);
  const closed = generated.jvmHotCallGraphRegionPlan;
  t.ok(closed?.backendEligible,
    'the next root entry batches receiver feedback into an executable region');
  t.equal(closed?.root.edges.filter((edge) =>
    edge.proof === 'runtime-monomorphic').length, 2,
  'both warmed virtual edges are jointly linked');
  t.equal(closed?.lexicallyInlinedEdgeCount, 2,
    'both monomorphic leaf calls feed their operands into the root SSA body');
  t.deepEqual(closed?.summary.inlineAdmissionReasons,
    [{reason: 'selected', count: 2}],
    'telemetry records both guarded virtual selections');
  t.equal(typeof generated.jvmHotCallGraphFramedBody, 'function',
    'the warmed virtual graph receives one framed module entry');
  const upgradedTarget = jvm.jit.syncCallSites[virtualSites[0].id]
    .fastDynamicTarget.target;
  const modulesBeforePublication =
    jvm.jit.hotCallGraphRegions.moduleCompileCount;
  jvm.jit.publishGeneratedTargetUpgrade(
    upgradedTarget.method, upgradedTarget.generated);
  t.ok(jvm.jit.hotCallGraphRegions.isPlanDirty(
    generated.jvmHotCallGraphRegionPlan),
  'target publication marks a dependent region dirty');
  generated.jvmHotCallGraphRegionPlan.entryCount = 1;
  jvm.jit.maybeExpandHotCallGraphRegion(
    jvm.jit.syncCallSites[virtualSites[0].id]);
  t.equal(jvm.jit.hotCallGraphRegions.moduleCompileCount,
    modulesBeforePublication,
  'target publication does not compile an unusable mid-activation module');
  jvm.jit.refreshHotCallGraphRegionAtEntry(generated, nextRootEntry);
  t.equal(jvm.jit.hotCallGraphRegions.moduleCompileCount,
    modulesBeforePublication,
  'an unchanged participating target does not rebuild the module at entry');
  t.notOk(jvm.jit.hotCallGraphRegions.isPlanDirty(
    generated.jvmHotCallGraphRegionPlan),
  'the entry audit acknowledges an unchanged target publication');
  const stableModuleCount = jvm.jit.hotCallGraphRegions.moduleCompileCount;
  const captureBoundaryStates =
    jvm.jit.hotCallGraphRegions.captureExpandableBoundaryStates.bind(
      jvm.jit.hotCallGraphRegions);
  let stableBoundaryScans = 0;
  jvm.jit.hotCallGraphRegions.captureExpandableBoundaryStates = (...args) => {
    stableBoundaryScans += 1;
    return captureBoundaryStates(...args);
  };
  for (let repeat = 0; repeat < 100; repeat += 1) {
    jvm.jit.maybeExpandHotCallGraphRegion(
      jvm.jit.syncCallSites[virtualSites[0].id]);
  }
  jvm.jit.hotCallGraphRegions.captureExpandableBoundaryStates =
    captureBoundaryStates;
  t.equal(jvm.jit.hotCallGraphRegions.moduleCompileCount, stableModuleCount,
    'an unchanged runtime boundary cannot trigger a region compile storm');
  t.equal(stableBoundaryScans, 0,
    'event-driven invalidation does not rescan a stable graph on hot calls');
  jvm.jit.publishGeneratedTargetUpgrade(root, generated, {
    regionEntryOnly: true,
  });
  t.notOk(jvm.jit.hotCallGraphRegions.isPlanDirty(
    generated.jvmHotCallGraphRegionPlan),
  'publishing an entry for the same implementation cannot dirty peer regions');

  const alternate = {type: alternateName, fields: {}};
  for (const site of virtualSites) {
    caller.stack.items.splice(0, caller.stack.items.length, alternate, 7, 1);
    jvm.jit.tryInvokeSyncAt(site.id, caller, thread);
    while (thread.callStack.peek() !== caller) thread.callStack.pop();
    const runtimeSite = jvm.jit.syncCallSites[site.id];
    t.equal(Object.keys(runtimeSite.fastPositionalTargets || {}).length, 2,
      'each dynamic bytecode site retains both positional receiver targets');
  }

  const values = [2, 4];
  values.type = '[I';
  let expected = 0;
  for (let round = 0; round < 3; round += 1) {
    for (const value of values) {
      expected = (expected + value * 7 + 9) | 0;
      expected = (expected ^ ((value + 1) * 7 + 9)) | 0;
    }
  }
  thread.callStack.items.length = 0;
  const parent = new Frame(root);
  const polymorphicFrame = new Frame(root);
  polymorphicFrame.className = className;
  polymorphicFrame.locals.splice(0, 4, alternate, values, 3, 1);
  thread.callStack.push(parent);
  thread.callStack.push(polymorphicFrame);
  const polymorphicResult = jvm.jit.runSelectedGeneratedFrame(
    generated, polymorphicFrame, thread);
  t.ok(polymorphicResult?.handled,
    'the region completes with a receiver different from its first profile');
  t.equal(parent.stack.pop(), expected,
    'the polymorphic inline cache preserves virtual dispatch semantics');
  t.end();
});

test('internal loop callees use guarded regional virtual edges', async (t) => {
  const className = 'GuardedInternalGraphRoot';
  const operationName = 'GuardedInternalLoopOperation';
  const alternateName = 'AlternateGuardedInternalLoopOperation';
  const classpath = fixture(className, `
class GuardedInternalLoopOperation {
  int fold(int seed, int rounds) {
    int value = seed;
    for (int index = 0; index < rounds; index++) value = value * 3 + index;
    return value;
  }
  int cold(int value) {
    return value ^ 0x55aa;
  }
}
class AlternateGuardedInternalLoopOperation
    extends GuardedInternalLoopOperation {
  int fold(int seed, int rounds) {
    int value = seed;
    for (int index = 0; index < rounds; index++) value = value * 5 - index;
    return value;
  }
}
public final class GuardedInternalGraphRoot {
  static int middle(GuardedInternalLoopOperation operation,
      int seed, int rounds) {
    int result = operation.fold(seed, rounds);
    if (seed == -999) return operation.cold(seed);
    return result;
  }
  static int root(GuardedInternalLoopOperation operation,
      int seed, int rounds) {
    return middle(operation, seed, rounds) + 1;
  }
}
`);
  t.teardown(() => fs.rmSync(classpath, {recursive: true, force: true}));
  const jvm = new JVM({classpath, jit: {
    warmupThreshold: 0,
    structuredSsa: true,
    structuredRunCounters: false,
    hotCallGraphRegions: true,
    profileMethods: false,
    // The cold-island count below is a statement about the node body as it
    // is emitted, so this case states that it measures the unpartitioned
    // shape rather than inheriting a forced experiment from the environment.
    hotCallGraphLinearPartition: false,
    hotCallGraphFramedPartition: false,
    hotCallGraphLoopOutlining: false,
  }});
  for (const owner of [className, operationName, alternateName]) {
    await jvm.loadClassByName(owner);
    jvm.classInitializationState.set(owner, 'INITIALIZED');
  }
  const root = await jvm.findMethodInHierarchy(
    className, 'root', `(L${operationName};II)I`);
  const middle = await jvm.findMethodInHierarchy(
    className, 'middle', `(L${operationName};II)I`);
  const generatedMiddle = jvm.jit.getGeneratedFunction(middle);
  const virtualSite = generatedMiddle.jvmStructuredRegionCallSites.find(
    (site) => site.dynamic);
  const receiver = {type: operationName, fields: {}};
  const caller = new Frame(middle);
  caller.className = className;
  caller.stack.items.push(receiver, 2, 4);
  const thread = {
    id: 0, status: 'runnable', pendingException: null,
    callStack: new Stack(),
  };
  thread.callStack.push(caller);
  jvm.jit.tryInvokeSyncAt(virtualSite.id, caller, thread);
  while (thread.callStack.peek() !== caller) thread.callStack.pop();
  thread.callStack.pop();

  const plan = jvm.jit.compileHotCallGraphRegion(root, {
    forceExpansion: true,
  });
  const middleIndex = plan.nodes.findIndex((node) => node.method === middle);
  const moduleSource = plan.positionalBody.jvmHotCallGraphRegionSource;
  const middleStart = moduleSource.indexOf(
    `function jvmRegionNode${middleIndex}(`);
  const middleEnd = moduleSource.indexOf(
    '\nfunction jvmRegionNode', middleStart + 1);
  const middleSource = moduleSource.slice(
    middleStart, middleEnd < 0 ? undefined : middleEnd);
  t.ok(plan?.backendEligible && middleIndex > 0,
    'runtime feedback closes the non-atomic internal edge');
  t.notOk(plan.closed,
    'an unrelated unresolved edge keeps the surrounding graph open');
  t.equal(middleSource.split('helpers.tryInvokeSyncAt').length - 1, 2,
    'the guarded edge and unrelated boundary each retain one cold island');
  t.ok(middleSource.includes(`=== ${JSON.stringify(operationName)}`),
    'the local call is guarded by the profiled receiver class');
  t.ok(plan.summary.guardedInternalEdges >= 1,
    'region telemetry records the guarded internal dispatch removal');
  t.ok(jvm.jit.hotCallGraphRegions.guardedInternalEdgeCount >= 1,
    'the compiler publishes a cumulative guarded-edge counter');
  t.equal(plan.body(jvm.jit, receiver, 2, 4, thread, false), 181,
    'the admitted receiver executes the loop callee inside the region');
  t.equal(thread.callStack.size(), 0,
    'the admitted path creates no canonical child Frame');

  const alternateReceiver = {type: alternateName, fields: {}};
  t.equal(plan.body(jvm.jit, alternateReceiver, 2, 4, thread, false), 1213,
    'a different receiver takes canonical dispatch and preserves its override');
  t.equal(thread.callStack.size(), 0,
    'the cold polymorphic path retires its reconstructed Frames');
  t.end();
});

// The framed root of a region is emitted from the renderer's continuation
// body, which publishes statement fragments like every other variant. At the
// default budgets the structural passes decline every cut; forced to the
// smallest budgets the options accept they have to fire *and* be a pure
// refactor, so this case compiles the same graph twice and compares both the
// pass statistics and the observable result.
test('a framed region root environment-lifts and partitions at forced budgets',
  async (t) => {
  const className = 'FramedPartitionHarness';
  // A long straight-line run inside the loop, so a segment of the forced
  // minimum size exists to cut; the calls around it keep the body a real
  // multi-method region.
  const grind = Array.from({length: 160}, (_unused, step) =>
    `      scratch = ((scratch * ${3 + (step % 7)}) ^ ${step + 11}) + ` +
    `${step * 13 + 5};`).join('\n');
  const classpath = fixture(className, `
public class FramedPartitionHarness {
  static int leaf(int value, boolean bias) {
    return value * 3 + (bias ? 1 : 2);
  }
  static int middle(int value, boolean bias) {
    return leaf(value, bias) ^ 0x55aa;
  }
  static int throwingLeaf(int value, boolean bias) {
    return 100 / value + (bias ? 0 : 1);
  }
  static int throwingMiddle(int value, boolean bias) {
    return throwingLeaf(value, bias) + 1;
  }
  static int root(int[] values, int rounds, boolean bias) {
    int sum = 0;
    for (int round = 0; round < rounds; round++) {
      for (int index = 0; index < values.length; index++) {
        int scratch = values[index];
${grind}
        sum += scratch + middle(values[index], bias) +
          throwingMiddle(values[index], bias);
      }
    }
    return sum;
  }
}
`);
  t.teardown(() => fs.rmSync(classpath, {recursive: true, force: true}));

  const compileGraph = async (options) => {
    const jvm = new JVM({classpath, jit: {
      warmupThreshold: 0,
      structuredSsa: true,
      structuredRunCounters: false,
      hotCallGraphRegions: true,
      profileMethods: false,
      ...options,
    }});
    await jvm.loadClassByName(className);
    jvm.classInitializationState.set(className, 'INITIALIZED');
    const method = await jvm.findMethodInHierarchy(
      className, 'root', '([IIZ)I');
    jvm.jit.invocationCounts.set(method, 1);
    const plan = jvm.jit.compileHotCallGraphRegion(method);
    return {jvm, method, plan};
  };

  const forced = {
    hotCallGraphFramedPartition: true,
    hotCallGraphLinearPartitionUnitBytes: 16384,
    hotCallGraphLinearPartitionSegmentBytes: 4096,
  };
  const baseline = await compileGraph({
    hotCallGraphFramedPartition: false,
    hotCallGraphLinearPartitionUnitBytes: 49152,
    hotCallGraphLinearPartitionSegmentBytes: 32768,
  });
  const cut = await compileGraph(forced);

  t.ok(baseline.plan?.body && baseline.plan.framedBody,
    'the graph emits both a positional and a framed module');
  t.equal(baseline.jvm.jit.hotCallGraphRegions.liftedEnvironmentNameCount, 0,
    'no name is lifted at the default budgets');
  t.equal(baseline.jvm.jit.hotCallGraphRegions.framedPartitionedSegmentCount,
    0, 'no framed segment is cut at the default budgets');

  t.ok(cut.plan?.body && cut.plan.framedBody,
    'the same graph still emits both modules at the forced budgets');
  t.ok(cut.jvm.jit.hotCallGraphRegions.liftedEnvironmentNameCount > 0,
    'the forced budgets lift framed unit locals into an environment array');
  t.ok(cut.jvm.jit.hotCallGraphRegions.framedPartitionedSegmentCount > 0,
    'the forced budgets cut at least one framed segment');
  t.ok(cut.plan.framedBody.jvmHotCallGraphRegionSource.includes(
    'jvmRegionEnv0_'),
  'the framed module declares the environment array it lifted into');
  t.ok(cut.plan.framedBody.jvmHotCallGraphRegionSource.includes(
    'jvmRegionSegment0_'),
  'the framed module calls the segment helper it cut');

  // Both modules must still be a pure refactor of the same graph.
  const values = [2, 3, 5];
  values.type = '[I';
  const runPositional = ({jvm, plan}) => {
    const thread = {
      id: 0, status: 'runnable', pendingException: null,
      callStack: new Stack(),
    };
    return plan.body(jvm.jit, values, 3, 1, thread, false);
  };
  t.equal(runPositional(cut), runPositional(baseline),
    'the partitioned graph computes the identical scalar result');

  const runFramed = ({jvm, method, plan}) => {
    const thread = {
      id: 0, status: 'runnable', pendingException: null,
      callStack: new Stack(),
    };
    const parent = new Frame(method);
    const entry = new Frame(method);
    entry.className = className;
    entry.locals.splice(0, 3, values, 3, 1);
    thread.callStack.push(parent);
    thread.callStack.push(entry);
    const generated = jvm.jit.getGeneratedFunction(method);
    const outcome = jvm.jit.runSelectedGeneratedFrame(
      generated, entry, thread);
    return {handled: Boolean(outcome?.handled), value: parent.stack.pop()};
  };
  t.deepEqual(runFramed(cut), runFramed(baseline),
    'the framed module returns the identical value through the JVM entry');
  t.end();
});
