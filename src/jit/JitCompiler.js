const Frame = require("../core/frame");
const { ASYNC_METHOD_SENTINEL } = require("../core/constants");
const { parseDescriptor } = require("../parsing/typeParser");
const {
  resolveInstanceFieldKey, allocPrimitiveArray, allocReferenceArray,
} = require("../instructions/object");
const WasmJit = require("./WasmJit");
const FusedRegionCompiler = require("./FusedRegionCompiler");
const JvmSsaBlockRenderer = require("./JvmSsaBlockRenderer");
const HotCallGraphRegionCompiler = require("./HotCallGraphRegionCompiler");
const monoArray = require("./monoArray");
const {
  newFields, makeObjectRef, hasField,
} = require("../core/objectModel");
const {
  normalizeArrayLoad,
  normalizeArrayStore,
} = require("../instructions/utils");
const {
  isReflectiveTarget,
  completeReflectiveCall,
} = require("../instructions/control");
// Parsed once; see the matching set in instructions/invoke.js. Reading and
// splitting this per constructor dispatch cost two allocations on every `new`.
const debugConstructorOwners = new Set(
  ((typeof process !== "undefined" && process.env
    ? process.env.JVM_DEBUG_CONSTRUCTORS : "") || "").split(",").filter(Boolean));
const { buildSsa } = require("../analysis/opgraph/ssa");
const { kindWidth } = require("../analysis/opgraph/ssaTypes");
const { buildCfgFromCode } = require("../decompiler/structurer");
const { capturesBooleanStatic, isNoOpExceptionHandler } = WasmJit._test;

const RETURN_VOID = Symbol("jit.return.void");
const STATIC_DEOPT = Symbol("jit.static.deopt");
const ASYNC_INVOKE = Symbol("jit.invoke.async");
const NO_MEMO_KEY = Symbol("jit.memo.no-key");
const HANDLED_RESULT = Object.freeze({ handled: true });
const UNHANDLED_RESULT = Object.freeze({ handled: false });
const WASM_EXITED_RESULT = Object.freeze({ handled: false, wasmExited: true });
// ACC_SYNCHRONIZED has no bytecode: the monitor is implied by the flag and is
// entered/released by the interpreter around the frame. Generated code runs a
// body without going through those hooks, so a compiled or linked synchronized
// method would execute with the lock dropped. Keep them interpreted.
const isSynchronizedMethod = (method) =>
  !!method && (method.flags || []).includes("synchronized");
const WASM_NATIVE_LONG_OPS = new Set([
  "i2l", "l2i", "ladd", "land", "lcmp", "ldiv", "lmul", "lneg",
  "lor", "lrem", "lshl", "lshr", "lsub", "lushr", "lxor",
]);

// Widened opcode eligibility (long arithmetic/locals/arrays, instanceof,
// dup_x1, i2s/i2c). These originally regressed when enabled in isolation, but
// after broad synchronous child admission the same production-bundle
// wall-time probe improved from 319 to 333 presented frames at 45 seconds.
// Keep the capability structural: no guest class or method identity participates.
const EXTENDED_TIER_OPCODES_ENABLED = true;
const EXTENDED_TIER_OPCODES = EXTENDED_TIER_OPCODES_ENABLED ? [
  "i2c", "i2s", "dup_x1", "dup2_x2", "instanceof",
  "ladd", "land", "laload", "lastore", "lconst_0", "lconst_1",
  "lload", "lload_0", "lload_1", "lload_2", "lload_3", "lneg", "lor", "lrem", "lshl",
  "lstore", "lstore_0", "lstore_1", "lstore_2", "lstore_3", "lsub", "lushr",
] : [];
const PRIMITIVE_ARRAY_ACCESS_OPCODES = new Set([
  "baload", "bastore", "caload", "castore", "daload", "dastore",
  "faload", "fastore", "iaload", "iastore", "laload", "lastore",
  "saload", "sastore",
]);

class JitCompiler {
  constructor(jvm, options = {}) {
    this.jvm = jvm;
    this.enabled = options.enabled !== false &&
      !(typeof process !== "undefined" && process.env && process.env.JVM_DISABLE_JIT === "1");
    this.safePoints = options.safePoints || "bytecode";
    this.supportCache = new WeakMap();
    this.labelCache = new WeakMap();
    this.runningFrames = new WeakSet();
    this.deoptedMethods = new WeakSet();
    this.invocationCounts = new WeakMap();
    this.backwardBranchCache = new WeakMap();
    this.controlFlowBackedgeCache = new WeakMap();
    this.warmupThreshold = options.warmupThreshold ??
      Number(process.env.JVM_JIT_WARMUP || 2);
    // A method containing a backward branch bypasses the warmup threshold and
    // compiles on its FIRST invocation, because one call can run a long loop.
    // Unconditionally, though, that is why Tomb Racer compiles 597 guest
    // methods to service the 41 that hold 90% of guest time, at ~30s of
    // synchronous codegen. Set this to also require N invocations before a
    // loop-bearing method is compiled. Unset keeps the immediate-compile
    // behaviour, since a genuinely long first loop would otherwise crawl in
    // the interpreter.
    this.loopWarmupThreshold = process.env.JVM_JIT_LOOP_WARMUP
      ? Number(process.env.JVM_JIT_LOOP_WARMUP) : 0;
    this.codegenEnabled = options.codegen !== false;
    this.codegenCache = new WeakMap();
    this.stableGeneratedEntries = new WeakMap();
    this.stableGeneratedEntryRunCount = 0;
    this.codegenSupportCache = new WeakMap();
    this.shortSupportedHelperCache = new WeakMap();
    this.structuredConstructorRetryState = new WeakMap();
    this.structuredConstructorUpgradePending = new WeakSet();
    this.structuredConstructorUpgradeCount = 0;
    this.lastStructuredConstructorUpgrade = null;
    this.adaptiveCodegenSupportCache = new WeakMap();
    this.adaptiveCodegenDependencyPending = new WeakSet();
    this.adaptiveCodegenDependencyEpoch = new WeakMap();
    this.adaptiveCodegenMethods = new WeakSet();
    // Some hot loop bodies contain cold allocation/constructor islands. The
    // baseline generator cannot safely replay those boundaries after an
    // asynchronous handoff, while the structured renderer verifies and
    // materializes each boundary precisely. Track those bodies separately so
    // a failed structured compilation can never fall through to baseline.
    this.structuredOnlyCodegenMethods = new WeakSet();
    this.structuredUnsafeConstructorCallersEnabled =
      options.structuredUnsafeConstructorCallers !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_STRUCTURED_UNSAFE_CONSTRUCTOR_CALLERS === "1");
    this.adaptiveCodegenCounts = new WeakMap();
    this.adaptiveCodegenFrameHeat = new WeakMap();
    const envHotLoopConstructors =
      typeof process !== "undefined" && process.env
        ? process.env.JVM_HOT_LOOP_CONSTRUCTORS
        : undefined;
    // Most constructors are short and gain nothing from whole-method
    // compilation.  A constructor that contains a real loop can be a large
    // data-expansion kernel, though.  Admit only the verifier-simple shape
    // proven by isJitSafeConstructor, plus the exact forwarding constructors
    // needed to reach its superclass body; <clinit> remains scheduler-managed.
    this.hotLoopConstructorsEnabled =
      options.hotLoopConstructors ??
      (envHotLoopConstructors === "0" ? false : true);
    this.normalizedCodeItemsCache = new WeakMap();
    this.codegenUnavailable = false;
    this.codegenCompileErrors = new WeakMap();
    this.syncCallSites = [];
    this.nextSyncCallSiteId = 1;
    this.legacySyncCallSites = new Map();
    this.generatedTargetsByMethod = new WeakMap();
    this.generatedTargetUpgradePublicationCount = 0;
    // OFF BY DEFAULT: this miscompiles. On Tomb Racer it corrupts a reference
    // local in dj.b(IIIIII)V -- slot 10 holds the hr returned by an invoke, and
    // with eager linking on it instead reads back a raw int, which faults at
    // that local's first use as "Unsupported invokevirtual ... declared hr".
    // Verified by A/B on an identical class tree: linking on => the fault every
    // run at the same instruction with the same value; linking off => boots to
    // the main menu. The defect was localized to this feature by elimination
    // (the wasm tier, the interpreter's astore, frame recycling/aliasing, the
    // generated call-site return path and the structured restore layouts were
    // each instrumented and cleared), but the specific unsound step inside the
    // link has NOT been identified, so the speculation stays off until it is.
    // Re-enable with JVM_ENABLE_EAGER_MONOMORPHIC_CALLS=1 to investigate.
    this.eagerMonomorphicCallsEnabled =
      options.eagerMonomorphicCalls === true ||
      Boolean(typeof process !== "undefined" && process.env &&
        process.env.JVM_ENABLE_EAGER_MONOMORPHIC_CALLS === "1");
    const eagerMonomorphicCallMaxCodeItems = Number(
      options.eagerMonomorphicCallMaxCodeItems ??
      (typeof process !== "undefined" && process.env
        ? process.env.JVM_EAGER_MONOMORPHIC_CALL_MAX_CODE_ITEMS
        : undefined));
    this.eagerMonomorphicCallMaxCodeItems =
      Number.isFinite(eagerMonomorphicCallMaxCodeItems) &&
      eagerMonomorphicCallMaxCodeItems > 0
        ? Math.floor(eagerMonomorphicCallMaxCodeItems) : 96;
    this.eagerMonomorphicCallLinkCount = 0;
    // Positional adapters are code-shape templates. Many independent call
    // sites reach the same method and used to parse an identical Function for
    // every site during asset loading. Cache the unbound template by resolved
    // method and ABI shape; each site still binds its own live linkage plan.
    this.positionalGeneratedEntryTemplates = new WeakMap();
    this.positionalJreEntryTemplates = new WeakMap();
    this.positionalGeneratedTemplateCompileCount = 0;
    this.positionalGeneratedTemplateReuseCount = 0;
    this.positionalJreTemplateCompileCount = 0;
    this.positionalJreTemplateReuseCount = 0;
    this.fieldSites = [];
    this.nextFieldSiteId = 1;
    // Loaded class hierarchies are immutable. Cache definitive synchronous
    // assignability results by source/target identity, while deliberately not
    // caching "unknown" so later class loading can resolve it.
    this.syncAssignabilityCache = new Map();
    // Generated bodies may bind a verified static-field container once and
    // keep reading its current value directly. These are heap locations, not
    // constant values. loadState replaces the JIT after replacing static maps,
    // so a binding cannot outlive the canonical container it references.
    this.directStaticTargets = [];
    this.staticFieldVersionCells = new WeakMap();
    this.checkedLeafCaptureCaches = [];
    this.initializedStaticReadTargets = new Map();
    this.initializedStaticWriteTargets = new Map();
    // JRE methods may publish a final-receiver positional intrinsic. Generated
    // callers bind that function once instead of repeating native lookup,
    // argument slicing, and generic call dispatch.
    this.directJreIntrinsics = [];
    this.directJreInitializationTokens = [];
    this.directStaticJreIntrinsicsEnabled =
      options.directStaticJreIntrinsics !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_DIRECT_STATIC_JRE_INTRINSICS === "1");
    this.directSynchronousIntrinsics = [];
    this.directCheckedLeafBodies = [];
    this.directCheckedLeafBodyIds = new WeakMap();
    this.codegenCompiling = new WeakSet();
    // Whole guest algorithms are useful differential oracles, but they are
    // not a compiler tier. Production code must be derived from the loaded
    // bytecode through the generic SSA/block renderer. Keep the historical
    // raster/blit/polygon substitutions available only for explicit A/B tests.
    this.guestKernelOraclesEnabled =
      options.guestKernelOracles === true ||
      Boolean(typeof process !== "undefined" && process.env &&
        process.env.JVM_ENABLE_GUEST_KERNEL_ORACLES === "1");
    this.transparentIntBlitRunCount = 0;
    this.transparentIntBlitSlowPathCount = 0;
    this.clippedGradientRunCount = 0;
    this.clippedGradientSlowPathCount = 0;
    this.alphaMaskedColorBlitRunCount = 0;
    this.alphaMaskedColorBlitSlowPathCount = 0;
    this.positionalGeneratedCallsEnabled =
      options.positionalGeneratedCalls !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_POSITIONAL_GENERATED_CALLS === "1");
    // Compact checked leaves improve the Node proxy but currently regress the
    // real SpiderMonkey renderer. Keep the verified ABI available for focused
    // experiments without selecting it in production until a browser A/B
    // demonstrates a win.
    this.checkedLeafDirectPositionalEnabled =
      options.checkedLeafDirectPositional === true ||
      Boolean(typeof process !== "undefined" && process.env &&
        process.env.JVM_ENABLE_CHECKED_LEAF_POSITIONAL === "1");
    this.adaptiveFramelessPositionalEnabled =
      options.adaptiveFramelessPositional !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_ADAPTIVE_FRAMELESS_POSITIONAL === "1");
    this.compiledCallChainsEnabled =
      options.compiledCallChains === true ||
      Boolean(typeof process !== "undefined" && process.env &&
        process.env.JVM_ENABLE_COMPILED_CALL_CHAINS === "1");
    this.compiledCallChainRunCount = 0;
    this.hotCallGraphRegions = new HotCallGraphRegionCompiler(this, options);
    this.ordinaryAdaptiveFramelessPositionalEnabled =
      options.ordinaryAdaptiveFramelessPositional === true ||
      Boolean(typeof process !== "undefined" && process.env &&
        process.env.JVM_ENABLE_ORDINARY_ADAPTIVE_FRAMELESS === "1");
    this.ordinaryAdaptiveFramelessRunCount = 0;
    this.referenceFramelessPositionalRunCount = 0;
    this.framePositionalCallCount = 0;
    this.framePositionalFallbackCount = 0;
    this.framePositionalCallsEnabled =
      options.framePositionalCalls === true ||
      Boolean(typeof process !== "undefined" && process.env &&
        process.env.JVM_ENABLE_FRAME_POSITIONAL_CALLS === "1");
    this.debugPositionalDepth =
      Boolean(typeof process !== "undefined" && process.env &&
        process.env.JVM_DEBUG_POSITIONAL_DEPTH === "1");
    // Read once: tryInvokeSyncAt and wasmOsrProbe are hot, and a
    // process.env property access per call is not free in V8.
    this.debugNonTopInvoke =
      Boolean(typeof process !== "undefined" && process.env &&
        process.env.JVM_DEBUG_NONTOP_INVOKE === "1");
    this.debugOsrSnapshotDir = (typeof process !== "undefined" && process.env &&
      process.env.JVM_DEBUG_OSR_SNAPSHOT_DIR) || null;
    if (this.debugPositionalDepth) {
      const innerInvokeSync = this.tryInvokeSyncAt.bind(this);
      this.tryInvokeSyncAt = (id, frame, thread) => {
        const before = thread?.callStack?.items?.length ?? 0;
        const value = innerInvokeSync(id, frame, thread);
        const after = thread?.callStack?.items?.length ?? 0;
        if (after > before && value !== ASYNC_INVOKE &&
            !(value && value.deopt)) {
          const site = this.syncCallSites[id];
          console.error("[sync-depth-leak]", JSON.stringify({
            site: site ? `${site.className || site.declaredClassName}.`
              + `${site.methodName || "?"}${site.descriptor || ""}` : id,
            before, after,
            leaked: thread.callStack.items.slice(before).map((held) =>
              `${held.className}.${held.method?.name}@pc${held.pc}`),
          }) + "\n" + new Error().stack.split("\n").slice(2, 12)
            .map((line) => line.trim()).join("\n"));
        }
        return value;
      };
    }
    this.adaptiveFramelessBudgetMultiplier = Math.max(1, Math.min(100,
      Number(options.adaptiveFramelessBudgetMultiplier ??
        (typeof process !== "undefined" && process.env &&
          process.env.JVM_ADAPTIVE_FRAMELESS_BUDGET_MULTIPLIER) ?? 8) || 8));
    this.inlineIntegerRegionCache = new WeakMap();
    this.directInlineIntegerRegionCache = new WeakMap();
    this.inlineIntegerPlanCache = new WeakMap();
    this.memoizedIntegralLeafCache = new WeakMap();
    this.memoizedIntegralLeavesEnabled =
      options.memoizedIntegralLeaves === true &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_MEMOIZED_INTEGRAL_LEAVES === "1");
    this.memoizedIntegralLeafHitCount = 0;
    this.memoizedIntegralLeafMissCount = 0;
    const envAdaptiveConstructorCallers =
      typeof process !== "undefined" && process.env
        ? process.env.JVM_ADAPTIVE_CONSTRUCTOR_CALLERS
        : undefined;
    // This tier admits only verifier-supported effectful callers after entry
    // or elapsed-time heat. It was originally browser-only, but isolated Node
    // measurements showed that the same policy removes long scheduler-bound
    // object/audio loops without making constructors themselves eligible.
    this.adaptiveConstructorCallersEnabled =
      options.adaptiveConstructorCallers ??
      (envAdaptiveConstructorCallers === "1" ? true
        : envAdaptiveConstructorCallers === "0" ? false : true);
    this.adaptiveCodegenThreshold = Math.max(2,
      Number(options.adaptiveCodegenThreshold) || 64);
    this.adaptiveCodegenTimeThresholdMs = Math.max(0,
      Number(options.adaptiveCodegenTimeThresholdMs ?? 8) || 0);
    this.adaptiveCodegenTimeSampleInterval = Math.max(1,
      Number(options.adaptiveCodegenTimeSampleInterval) || 64);
    this.largeAcyclicCallTreesEnabled =
      options.largeAcyclicCallTrees !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_LARGE_ACYCLIC_CALL_TREES === "1");
    const configuredWholeMethodEscalation =
      options.adaptiveWholeMethodEscalationThreshold ??
      (typeof process !== "undefined" && process.env
        ? process.env.JVM_ADAPTIVE_WHOLE_METHOD_ESCALATION_THRESHOLD
        : undefined);
    this.adaptiveWholeMethodEscalationThreshold =
      configuredWholeMethodEscalation === undefined
        // One elapsed-time/entry-hot JavaScript promotion is already runtime
        // evidence that this workload contains effectful call islands. Keep
        // explicitly selected oversized/long kernels Wasm-first, but stop
        // paying partial Wasm entry/exit probes for every ordinary method.
        // Deployments can raise this threshold or set zero to disable the
        // workload-wide escalation.
        ? 1
        : Math.max(0, Number(configuredWholeMethodEscalation) || 0);
    this.adaptiveWholeMethodPromotionCount = 0;
    this.adaptiveWholeMethodEscalationCount = 0;
    this.adaptiveEntryPromotionCount = 0;
    this.adaptiveTimePromotionCount = 0;
    this.adaptiveTimeSampleCount = 0;
    const envProfileMethods = Boolean(typeof process !== "undefined" && process.env &&
      (process.env.JVM_DEBUG_JIT === "1" ||
        process.env.JVM_PROFILE_JIT_METHODS === "1"));
    // Invocation accounting mutates several Maps on every generated entry and
    // inlined call. Keep production execution free of that cost; diagnostics
    // can opt in explicitly (the browser profiler also toggles this field at
    // runtime).
    this.profileMethods = options.profileMethods ?? envProfileMethods;
    this.profileTimings = options.profileTimings === true;
    this.methodTimingSampleRate = Math.max(1, Number(options.methodTimingSampleRate) || 256);
    this.methodTimingFilter = options.methodTimingFilter instanceof Set
      ? options.methodTimingFilter : null;
    this.methodTimingRandomState = 0x6d2b79f5;
    this.methodTimingSamples = new Map();
    this.exclusiveTimingsEnabled = false;
    this.exclusiveTimingRootKey = null;
    this.exclusiveTimingStack = [];
    this.exclusiveTimingSamples = new Map();
    this.exclusiveTimingEdges = new Map();
    this.methodEntryTraceKey = null;
    this.methodEntryTrace = null;
    const jitEnvironment = typeof process !== "undefined" && process.env
      ? process.env : {};
    this.frameHandoffTracePattern = jitEnvironment.JVM_TRACE_FRAME_HANDOFF || "";
    this.frameHandoffTracePc = jitEnvironment.JVM_TRACE_FRAME_HANDOFF_PC === undefined
      ? null : Number(jitEnvironment.JVM_TRACE_FRAME_HANDOFF_PC);
    this.frameMaterializeTracePattern =
      jitEnvironment.JVM_TRACE_FRAME_MATERIALIZE || "";
    this.frameMaterializeTracePc =
      jitEnvironment.JVM_TRACE_FRAME_MATERIALIZE_PC === undefined
        ? null : Number(jitEnvironment.JVM_TRACE_FRAME_MATERIALIZE_PC);
    const envPreferWholeMethodJs = jitEnvironment.JVM_PREFER_WHOLE_METHOD_JS;
    const generatedBodyDefault =
      jitEnvironment.JVM_WASM_JIT === "0" ||
      typeof navigator !== "undefined" &&
        /Firefox\//.test(navigator.userAgent || "");
    // Keep one generated JavaScript body as the normal cross-runtime policy.
    // When Node explicitly disables Wasm (the fast-feedback game benchmark),
    // use the same policy as Firefox. An explicitly enabled Node Wasm tier
    // retains priority so Wasm-only deployments and differential tests do not
    // silently execute a different compiler.
    this.preferWholeMethodJs = options.preferWholeMethodJs ??
      (envPreferWholeMethodJs === "1" ? true
        : envPreferWholeMethodJs === "0" ? false : generatedBodyDefault);
    this.generatedRunCount = 0;
    this.syncGeneratedRunCount = 0;
    this.syncInlinedCallCount = 0;
    this.syncReusedFrameCount = 0;
    this.syncIntrinsicCallCount = 0;
    this.syncOperandUnderflowFallbackCount = 0;
    this.reportedSyncOperandUnderflows = new Set();
    this.intrinsicArrayCopyNoopCount = 0;
    this.intrinsicArrayCopyWithinCount = 0;
    this.fusedRunCount = 0;
    this.fusedDirectRunCount = 0;
    this.fusedGuardedFallbackCount = 0;
    this.fusedRestoredExceptionFrameCount = 0;
    this.scalarLoopRunCount = 0;
    this.scalarLoopSafePointCount = 0;
    this.scalarSsaRunCount = 0;
    this.scalarSsaArrayViewCount = 0;
    this.scalarSsaEliminatedReadCount = 0;
    this.scalarSsaThreadedEdgeCount = 0;
    this.inlineLoopRegionRunCount = 0;
    this.inlineLoopRegionOsrCount = 0;
    this.inlineLoopRegions = [];
    this.graphStaleReceiverOperandRecoveryCount = 0;
    this.inlineLoopRegionCache = new WeakMap();
    this.inlineLoopRegionPcCache = new WeakMap();
    this.inlineLoopRegionsEnabled = options.inlineLoopRegions !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_INLINE_LOOP_REGIONS === "1");
    this.scalarBoundedInlineRegionsEnabled =
      options.scalarBoundedInlineRegions === true ||
      Boolean(typeof process !== "undefined" && process.env &&
        process.env.JVM_ENABLE_SCALAR_BOUNDED_INLINE_REGIONS === "1");
    this.scalarLoopMethodRunCounts = new Map();
    this.structuredSsaMethodRunCounts = new Map();
    this.oversizedWasmFirstMethods = new WeakMap();
    this.oversizedWasmFirstMethodCount = 0;
    this.oversizedWasmFirstCodeItems = Math.max(128, Math.floor(Number(
      options.oversizedWasmFirstCodeItems ?? 2048) || 2048));
    this.longArithmeticWasmFirstMethods = new WeakMap();
    this.longArithmeticWasmFirstMethodCount = 0;
    this.longArithmeticWasmFirstEnabled =
      options.longArithmeticWasmFirst !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_LONG_ARITHMETIC_WASM_FIRST === "1");
    this.arrayKernelWasmFirstMethods = new WeakMap();
    this.arrayKernelWasmFirstMethodCount = 0;
    this.arrayKernelWasmFirstEnabled =
      options.arrayKernelWasmFirst === true ||
      Boolean(typeof process !== "undefined" && process.env &&
        process.env.JVM_ENABLE_ARRAY_KERNEL_WASM_FIRST === "1");
    this.dynamicArrayStructuredFirstMethods = new WeakMap();
    this.dynamicArrayStructuredFirstMethodCount = 0;
    this.dynamicArrayStructuredFirstEnabled =
      options.dynamicArrayStructuredFirst !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_DYNAMIC_ARRAY_STRUCTURED_FIRST === "1");
    this.callGraphStructuredFirstMethods = new WeakMap();
    this.callGraphStructuredFirstMethodCount = 0;
    this.callGraphStructuredFirstEnabled =
      options.callGraphStructuredFirst !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_CALL_GRAPH_STRUCTURED_FIRST === "1");
    this.rendererPipelineEnabled = options.rendererPipeline === true ||
      Boolean(typeof process !== "undefined" && process.env &&
        process.env.JVM_ENABLE_RENDERER_PIPELINE === "1");
    this.scalarLoopsEnabled = options.scalarLoops !== false;
    this.scalarGuestBodiesEnabled = this.rendererPipelineEnabled || options.scalarGuestBodies === true ||
      Boolean(typeof process !== "undefined" && process.env &&
        process.env.JVM_ENABLE_SCALAR_GUEST_BODIES === "1");
    this.scalarSsaOptimizationsEnabled = options.scalarSsaOptimizations === true ||
      Boolean(typeof process !== "undefined" && process.env &&
        process.env.JVM_ENABLE_SCALAR_SSA === "1");
    this.postIncrementHelpersEnabled = options.postIncrementHelpers !== false &&
      !(typeof process !== "undefined" && process.env &&
        process.env.JVM_DISABLE_POST_INCREMENT_HELPERS === "1");
    this.inlinedMethodRunCounts = new Map();
    this.intrinsicMethodRunCounts = new Map();
    this.runnerRunCount = 0;
    this.methodRunCounts = new Map();
    this.generatedMethodRunCounts = new Map();
    this.runnerMethodRunCounts = new Map();
    this.methodDeoptCounts = new Map();
    this.methodDeoptReasons = new Map();
    this.methodDeoptSites = new Map();
    this.experimentalControlFlow = options.experimentalControlFlow ?? (
      typeof process !== "undefined" && process.env
        ? process.env.JVM_JIT_EXPERIMENTAL_CONTROL_FLOW === "1"
        : false
    );
    // canRun runs on every scheduler tick; process.env reads cost ~150ns each,
    // so latch the instrumentation flags once.
    this._envInstrumented = Boolean(typeof process !== "undefined" && process.env &&
      (process.env.JVM_TRACE || process.env.JVM_PROFILE_HOT_METHODS === "1"));
    this.wasmJit = new WasmJit(jvm, this);
    if (options.wasmRelaxedReferenceReturns === true) {
      this.wasmJit.relaxedRefReturn = true;
    }
    const regionOptions = this.rendererPipelineEnabled
      ? { ...options, structuredSsa: true }
      : options;
    this.fusedRegions = new FusedRegionCompiler(this, regionOptions);
    this.structuredSsa = new JvmSsaBlockRenderer(this, regionOptions);
    // A method's independently selected tier is not necessarily the best
    // representation when that method becomes part of a closed hot graph.
    // Keep graph-owned structured lowering separate from the canonical
    // codegen cache: its Method identity remains the fallback/invalidation
    // authority, while the region may jointly emit a scalar SSA body.
    this.regionStructuredCandidates = new WeakMap();
    this.regionStructuredCandidateCompiling = new WeakSet();
    this.regionStructuredLeafCandidateCache = new WeakMap();
    this.regionStructuredCandidateCompileCount = 0;
    this.graphOwnedStructuredCandidatesEnabled =
      options.graphOwnedStructuredCandidates === true ||
      Boolean(typeof process !== "undefined" && process.env &&
        process.env.JVM_ENABLE_GRAPH_OWNED_STRUCTURED_CANDIDATES === "1");
  }

  requiresOpaqueControlInterpreter(method, codeItems) {
    // A static boolean captured in a long-lived local and carried across call
    // edges needs a verifier-backed spill/resume proof. Until that proof
    // exists, reject only this structurally matched method; unrelated methods
    // remain eligible for every JIT tier.
    return capturesBooleanStatic(method) && normalFlowContainsInvoke(codeItems);
  }

  canRun(frame, codegenEligible = false) {
    if (!this.enabled || !frame || !frame.method || !frame.instructions) {
      return false;
    }
    if (this.runningFrames.has(frame)) {
      return false;
    }
    if (frame.jitSkipOnce) {
      delete frame.jitSkipOnce;
      return false;
    }
    if (this.deoptedMethods.has(frame.method)) {
      frame.jitJsDisabled = true;
      return false;
    }
    // Tracing/profiling must observe every interpreted bytecode. Debug stepping
    // is handled below through DebugManager; these environment modes are used
    // by the headless runner and need the same one-instruction semantics.
    if (this._envInstrumented) {
      return false;
    }
    const debug = this.jvm.debugManager;
    if (debug.debugMode && debug.runMode !== "continuing") {
      return false;
    }
    if (debug.isClassJitDeopted(this.getFrameClassName(frame))) {
      return false;
    }
    const count = (this.invocationCounts.get(frame.method) || 0) + 1;
    this.invocationCounts.set(frame.method, count);
    if (count < this.warmupThreshold && !this.hasBackwardBranch(frame.method)) {
      return false;
    }
    // Loop-bearing methods otherwise compile on sight; JVM_JIT_LOOP_WARMUP
    // makes them serve a (shorter) warmup too, to measure how much of the
    // compile bill is methods that are touched once and never get hot.
    if (this.loopWarmupThreshold && count < this.loopWarmupThreshold) {
      return false;
    }
    const supported = codegenEligible
      ? this.isCodegenSupported(frame.method)
      : this.isSupported(frame.method);
    if (!supported) frame.jitJsDisabled = true;
    return supported;
  }

  // "Does this method have a loop the JIT may act on" — an ELIGIBILITY answer,
  // not a structural one. `hasControlFlowBackedge` is the structural predicate;
  // use that when you want the plain fact.
  //
  // Opaque-control methods report false here deliberately. That looks like a
  // lie about a real backedge, and it does bar those methods from every tier,
  // but it is load-bearing in two independent ways, both measured on Tomb
  // Racer: letting them into the JS codegen tier miscompiles the boot outright
  // (`IllegalStateException: Unrecognised component type: 120`), and letting
  // this predicate report the structural truth to the wasm-first routing and
  // region-formation callers below costs the boot >70 s even when every tier
  // still refuses to compile them. So the restriction stays, stated explicitly
  // at each tier entry (isSupported, isCodegenSupported, WasmJit.prepare) so
  // that no tier depends on this predicate to enforce it.
  //
  // What was genuinely wrong and is now fixed: this used to also poison
  // supportCache as a side effect of a structural query.
  hasBackwardBranch(method) {
    if (this.backwardBranchCache.has(method)) return this.backwardBranchCache.get(method);
    const codeItems = this.getCodeItems(method);
    const backward = !this.requiresOpaqueControlInterpreter(method, codeItems) &&
      this.hasControlFlowBackedge(method, codeItems);
    this.backwardBranchCache.set(method, backward);
    return backward;
  }

  hasControlFlowBackedge(method, codeItems = this.getCodeItems(method)) {
    if (this.controlFlowBackedgeCache.has(method)) {
      return this.controlFlowBackedgeCache.get(method);
    }
    const labels = buildLabelMap(codeItems);
    const backward = codeItems.some((item, index) => {
      const instruction = item && item.instruction;
      const op = getOp(instruction);
      if (!op || (op !== "goto" && !op.startsWith("if"))) return false;
      const target = instruction && typeof instruction === "object" ? labels.get(instruction.arg) : undefined;
      return target !== undefined && target <= index;
    });
    this.controlFlowBackedgeCache.set(method, backward);
    return backward;
  }

  hasConstructorBeforeOrInsideBackwardLoop(method, codeItems = null) {
    const items = codeItems || this.getCodeItems(method);
    const labels = buildLabelMap(items);
    const constructorIndexes = [];
    for (let index = 0; index < items.length; index += 1) {
      const instruction = items[index]?.instruction;
      if (getOp(instruction) === "invokespecial" &&
          Array.isArray(instruction?.arg) &&
          Array.isArray(instruction.arg[2]) &&
          instruction.arg[2][0] === "<init>") {
        constructorIndexes.push(index);
      }
    }
    if (!constructorIndexes.length) return false;
    return items.some((item, index) => {
      const instruction = item?.instruction;
      const op = getOp(instruction);
      if (!op || (op !== "goto" && !op.startsWith("if"))) return false;
      const target = typeof instruction === "object"
        ? labels.get(instruction.arg) : undefined;
      return Number.isInteger(target) && target <= index &&
        constructorIndexes.some((constructorIndex) =>
          constructorIndex <= index);
    });
  }

  getExceptionTable(method) {
    const code = method && method.attributes &&
      method.attributes.find((attr) => attr.type === "code");
    return (code && code.code && code.code.exceptionTable) || [];
  }

  getCodeItems(method) {
    if (this.normalizedCodeItemsCache.has(method)) {
      return this.normalizedCodeItemsCache.get(method);
    }
    const code = method.attributes.find((attr) => attr.type === "code");
    const original = code && code.code && code.code.codeItems || [];
    let normalized = original;
    for (let index = 0; index < original.length; index += 1) {
      const item = original[index];
      const instruction = item && item.instruction;
      if (getOp(instruction) !== "wide") continue;
      const expanded = expandWideInstruction(instruction);
      if (!expanded) continue;
      if (normalized === original) normalized = original.slice();
      normalized[index] = { ...item, instruction: expanded };
    }
    this.normalizedCodeItemsCache.set(method, normalized);
    return normalized;
  }

  tryRunFrame(frame, thread) {
    // Ask the wasm gate before any JS tier can win, so the census can account
    // for methods the JS tier claims first. Diagnostic mode only; a no-op
    // unless JVM_WASM_CENSUS_SHADOW=1.
    if (this.wasmJit.censusShadow) this.wasmJit.censusProbe(frame);
    const stableResult = this.tryRunStableGeneratedFrame(frame, thread);
    if (stableResult) return stableResult;

    // SpiderMonkey pays a high cost for frequent Wasm -> JS -> Wasm exits.
    // When the whole method has a generated implementation, prefer that
    // single tier over partial Wasm. Compilation is intentionally allowed to
    // cost more up front so animation/render loops remain in one engine tier.
    let canRunGenerated = null;
    let awaitingAdaptivePromotion = false;
    const canProbeGenerated = !this.runningFrames.has(frame) &&
      !frame.jitJsDisabled;
    if (canProbeGenerated && this.tryRunInlineLoopRegionOsr(frame, thread)) {
      return HANDLED_RESULT;
    }
    // The three predicates below match on static SHAPE. The fourth asks the
    // wasm gate directly whether it covers this method end to end, which is
    // evidence rather than a guess, and cannot select the partial-module
    // shape the JS preference exists to avoid. Off unless
    // JVM_WASM_PREFER_FULL_COVERAGE=1.
    const wasmPriorityLoop = this.wasmJit.enabled &&
      (this.isOversizedLoopMethod(frame.method) ||
        this.isLongArithmeticLoopMethod(frame.method) ||
        this.isArrayKernelWasmFirstMethod(frame.method) ||
        this.wasmJit.probeFullCoverage(frame));
    const wholeMethodPreferred =
      (this.prefersWholeMethodJs(frame.method) ||
        this.isDynamicArrayStructuredFirstMethod(frame.method)) &&
      !wasmPriorityLoop;
    if (wholeMethodPreferred && canProbeGenerated) {
      let codegenEligible = this.isCodegenSupported(frame.method);
      if (!codegenEligible && this.adaptiveConstructorCallersEnabled &&
          this.isCodegenSupported(frame.method, true)) {
        codegenEligible = this.observeAdaptiveCodegenHeat(frame);
        awaitingAdaptivePromotion = !codegenEligible;
      }
      if (codegenEligible) canRunGenerated = this.canRun(frame, true);
    }

    if (!canRunGenerated && this.wasmJit.enabled && !this.runningFrames.has(frame)) {
      const wasmResult = this.wasmJit.tryRunFrame(frame, thread);
      if (wasmResult.handled) {
        if (wasmResult.returned) return HANDLED_RESULT;
        // A partial-Wasm exit has already materialized locals, operand stack,
        // and the exact resume pc. Let executeTick interpret the unsupported
        // island immediately instead of consuming an otherwise empty thread
        // turn; the next tick can re-enter Wasm at the following eligible
        // block. Do not probe the JS tier in between these two regions.
        return WASM_EXITED_RESULT;
      }
    }
    // In Wasm-first mode, observe JavaScript heat only after Wasm declined the
    // current entry. This admits scheduler-heavy effectful/call-bearing bodies
    // without stealing fully compiled numeric loops from the faster Wasm tier.
    if (!wholeMethodPreferred && canProbeGenerated &&
        this.adaptiveConstructorCallersEnabled &&
        this.isCodegenSupported(frame.method, true)) {
      const codegenEligible = this.observeAdaptiveCodegenHeat(frame);
      awaitingAdaptivePromotion = !codegenEligible &&
        !this.isSupported(frame.method);
      if (codegenEligible) canRunGenerated = this.canRun(frame, true);
    }
    if (this.adaptiveCodegenDependencyPending.has(frame.method)) {
      awaitingAdaptivePromotion = true;
    }
    // Structural rejection and permanent deoptimization are method-stable.
    // Remember them on the frame so interpreted bytecodes do not repeat the
    // full JS-JIT policy check on every scheduler tick. The Wasm tier still
    // gets its probe above because it can compile supported regions of a
    // method that the JS tier rejects as a whole.
    if (frame.jitJsDisabled) {
      return UNHANDLED_RESULT;
    }
    // Do not permanently reject a structurally compilable constructor caller
    // while it is accumulating method-entry heat. Its bytecodes remain on the
    // canonical interpreter path until promotion.
    if (awaitingAdaptivePromotion) {
      return UNHANDLED_RESULT;
    }
    if ((canRunGenerated === null && !this.canRun(frame)) || canRunGenerated === false) {
      return UNHANDLED_RESULT;
    }

    const generated = this.getGeneratedFunction(frame.method);
    if (!generated && this.structuredOnlyCodegenMethods.has(frame.method)) {
      // Adaptive admission may prove only that this constructor-bearing
      // caller is safe for the structured renderer. If that renderer rejects
      // a later detail, the legacy runner is not a valid fallback: it cannot
      // suspend and replay an arbitrary new/dup/invokespecial boundary. Keep
      // the complete method on the canonical interpreter instead.
      return UNHANDLED_RESULT;
    }

    if (generated && (!this.wasmJit.enabled ||
        this.prefersWholeMethodJs(frame.method)) &&
        (frame.method.name !== "<init>" ||
        generated.jvmStructuredSsa ||
        generated.jvmRestoringDirectPositionalBody)) {
      let stableEntry = this.stableGeneratedEntries.get(frame.method);
      if (!stableEntry) {
        stableEntry = { jit: this, generated };
        this.stableGeneratedEntries.set(frame.method, stableEntry);
      } else {
        stableEntry.generated = generated;
      }
      frame.jitStableGeneratedEntry = stableEntry;
    }
    return this.runSelectedGeneratedFrame(generated, frame, thread);
  }

  tryRunStableGeneratedFrame(frame, thread) {
    if (!this.enabled || !frame || !frame.method || !frame.instructions ||
        frame.jitJsDisabled || this.runningFrames.has(frame) ||
        this._envInstrumented) return null;
    const stableEntry = frame.jitStableGeneratedEntry ||
      this.stableGeneratedEntries.get(frame.method);
    if (!stableEntry || stableEntry.jit !== this || !stableEntry.generated) {
      return null;
    }
    if (this.wasmJit.enabled && !this.prefersWholeMethodJs(frame.method)) {
      return null;
    }
    if (frame.jitSkipOnce) {
      // Leave the marker for canRun below. Consuming it in this preliminary
      // probe would let the ordinary tier re-enter during the same tick,
      // skipping the one canonical interpreter step requested by deopt.
      return null;
    }
    if (this.deoptedMethods.has(frame.method)) {
      frame.jitJsDisabled = true;
      return null;
    }
    const debug = this.jvm.debugManager;
    if (debug.debugMode && debug.runMode !== "continuing" ||
        debug.isClassJitDeopted(this.getFrameClassName(frame))) {
      return null;
    }
    frame.jitStableGeneratedEntry = stableEntry;
    this.stableGeneratedEntryRunCount += 1;
    return this.runSelectedGeneratedFrame(
      stableEntry.generated, frame, thread);
  }

  runSelectedGeneratedFrame(generated, frame, thread) {
    // A method can first publish a baseline body and upgrade to structured SSA
    // after its dependencies initialize. Stable generated entries intentionally
    // bypass ordinary tier admission, so without this one-time PC-0 audit such
    // a warmed loop could never become a region root. The attached plan makes
    // the check disappear after the first attempt.
    if (frame?.pc === 0 && generated?.jvmHotCallGraphFramedSource &&
        !generated.jvmHotCallGraphRegionPlan &&
        this.shouldCompileHotCallGraphRegion(frame.method)) {
      this.compileHotCallGraphRegion(frame.method);
    }
    generated = this.refreshHotCallGraphRegionAtEntry(generated, frame);
    if ((frame.pc === 0 ||
         generated?.jvmHotCallGraphHasContinuation?.(frame)) &&
        typeof generated?.jvmHotCallGraphFramedBody === "function") {
      generated = generated.jvmHotCallGraphFramedBody;
    }
    const methodKey = this.profileMethods
      ? `${this.getFrameClassName(frame)}.${frame.method.name}${frame.method.descriptor}`
      : null;
    if (this.profileMethods) {
      this.methodRunCounts.set(methodKey, (this.methodRunCounts.get(methodKey) || 0) + 1);
    }
    this.runningFrames.add(frame);
    let result;
    try {
      result = generated
        ? this.runGeneratedFrame(generated, frame, thread)
        : this.runFrame(frame, thread);
    } catch (error) {
      this.runningFrames.delete(frame);
      throw error;
    }
    if (result && typeof result.then === "function") {
      return result.then((resolved) => {
        try {
          return this.finishTryRunFrame(frame, thread, methodKey, resolved);
        } finally {
          this.runningFrames.delete(frame);
        }
      }, (error) => {
        this.runningFrames.delete(frame);
        throw error;
      });
    }
    try {
      return this.finishTryRunFrame(frame, thread, methodKey, result);
    } finally {
      this.runningFrames.delete(frame);
    }
  }

  isOversizedLoopMethod(method) {
    if (!method || method.name === "<init>" || method.name === "<clinit>") return false;
    if (this.oversizedWasmFirstMethods.has(method)) {
      return this.oversizedWasmFirstMethods.get(method);
    }
    const codeItems = this.getCodeItems(method);
    const oversized = codeItems.filter((item) => item?.instruction).length >=
      this.oversizedWasmFirstCodeItems &&
      this.hasBackwardBranch(method);
    this.oversizedWasmFirstMethods.set(method, oversized);
    if (oversized) this.oversizedWasmFirstMethodCount += 1;
    return oversized;
  }

  isLongArithmeticLoopMethod(method) {
    if (!this.longArithmeticWasmFirstEnabled) return false;
    if (!method || method.name === "<init>" || method.name === "<clinit>") return false;
    if (this.longArithmeticWasmFirstMethods.has(method)) {
      return this.longArithmeticWasmFirstMethods.get(method);
    }
    const codeItems = this.getCodeItems(method);
    let instructionCount = 0;
    let nativeLongOpCount = 0;
    for (const item of codeItems) {
      const op = getOp(item && item.instruction);
      if (!op) continue;
      instructionCount += 1;
      if (WASM_NATIVE_LONG_OPS.has(op)) nativeLongOpCount += 1;
    }
    // JavaScript implements exact Java long arithmetic with BigInt. In a
    // substantial numeric loop that conversion/allocation cost dominates,
    // while Wasm represents the same verified values directly as i64. Keep
    // small helpers in JavaScript so module compilation and crossings do not
    // outweigh the saved work.
    const selected = instructionCount >= 256 && nativeLongOpCount >= 8 &&
      this.hasBackwardBranch(method);
    this.longArithmeticWasmFirstMethods.set(method, selected);
    if (selected) this.longArithmeticWasmFirstMethodCount += 1;
    return selected;
  }

  isArrayKernelWasmFirstMethod(method) {
    if (!this.arrayKernelWasmFirstEnabled ||
        !method || method.name === "<init>" || method.name === "<clinit>") {
      return false;
    }
    if (this.arrayKernelWasmFirstMethods.has(method)) {
      return this.arrayKernelWasmFirstMethods.get(method);
    }
    const codeItems = this.getCodeItems(method);
    let instructionCount = 0;
    let primitiveArrayAccessCount = 0;
    let staticCallCount = 0;
    let nonStaticCallCount = 0;
    for (const item of codeItems) {
      const op = getOp(item && item.instruction);
      if (!op) continue;
      instructionCount += 1;
      if (PRIMITIVE_ARRAY_ACCESS_OPCODES.has(op) || op === "arraylength") {
        primitiveArrayAccessCount += 1;
      }
      if (op === "invokestatic") staticCallCount += 1;
      else if (op === "invokevirtual" || op === "invokeinterface" ||
          op === "invokespecial") nonStaticCallCount += 1;
    }
    // Dense primitive-array kernels with only statically linkable helpers are
    // a better fit for Wasm than a JavaScript generator: the loops keep
    // unboxed indices/values and linked helper calls stay in one module.
    // Require substantial bytecode and array density so ordinary archive/UI
    // methods do not pay module compilation or Wasm/JS transition costs.
    const selected = instructionCount >= 192 &&
      primitiveArrayAccessCount >= 24 &&
      staticCallCount <= 32 &&
      nonStaticCallCount === 0 &&
      this.hasBackwardBranch(method);
    this.arrayKernelWasmFirstMethods.set(method, selected);
    if (selected) this.arrayKernelWasmFirstMethodCount += 1;
    return selected;
  }

  isDynamicArrayStructuredFirstMethod(method) {
    if (!this.dynamicArrayStructuredFirstEnabled ||
        !method || method.name === "<init>" || method.name === "<clinit>") {
      return false;
    }
    if (this.dynamicArrayStructuredFirstMethods.has(method)) {
      return this.dynamicArrayStructuredFirstMethods.get(method);
    }
    let instructionCount = 0;
    let primitiveArrayAccessCount = 0;
    let dynamicCallCount = 0;
    for (const item of this.getCodeItems(method)) {
      const op = getOp(item && item.instruction);
      if (!op) continue;
      instructionCount += 1;
      if (PRIMITIVE_ARRAY_ACCESS_OPCODES.has(op) || op === "arraylength") {
        primitiveArrayAccessCount += 1;
      } else if (op === "invokevirtual" || op === "invokeinterface" ||
          op === "invokespecial") {
        dynamicCallCount += 1;
      }
    }
    // A large primitive-array loop with several dynamic call islands cannot
    // stay in one Wasm module: each island exits to JavaScript and resumes
    // later. Structured JavaScript can instead retain the verified operand
    // values and link monomorphic callees positionally. Select only a large,
    // dense shape so ordinary object/UI methods do not pay its cold compile
    // cost.
    const selected = instructionCount >= 384 &&
      primitiveArrayAccessCount >= 32 &&
      dynamicCallCount >= 2 &&
      this.hasControlFlowBackedge(method);
    this.dynamicArrayStructuredFirstMethods.set(method, selected);
    if (selected) this.dynamicArrayStructuredFirstMethodCount += 1;
    return selected;
  }

  isCallGraphStructuredFirstMethod(method) {
    if (!this.callGraphStructuredFirstEnabled || !method ||
        method.name === "<init>" || method.name === "<clinit>") return false;
    if (this.callGraphStructuredFirstMethods.has(method)) {
      return this.callGraphStructuredFirstMethods.get(method);
    }
    let instructionCount = 0;
    let callCount = 0;
    for (const item of this.getCodeItems(method)) {
      const op = getOp(item?.instruction);
      if (!op) continue;
      instructionCount += 1;
      if (op === "invokestatic" || op === "invokevirtual" ||
          op === "invokeinterface" || op === "invokespecial") callCount += 1;
    }
    // Partial-loop extraction is counterproductive for a body that repeatedly
    // crosses method boundaries: it prevents the full structured compiler
    // from publishing call metadata, so a loop or dense fan-out caller can
    // never become a jointly lowered region root. Require either substantial
    // fan-out, a backedge, or high call density; call-free numeric kernels
    // retain their existing scalar/Wasm policies.
    const selected = instructionCount >= 128 &&
      (callCount >= 16 || callCount >= 8 && this.hasBackwardBranch(method));
    this.callGraphStructuredFirstMethods.set(method, selected);
    if (selected) this.callGraphStructuredFirstMethodCount += 1;
    return selected;
  }

  prefersWholeMethodJs(method) {
    return this.preferWholeMethodJs ||
      this.adaptiveCodegenMethods.has(method);
  }

  shouldCompileHotCallGraphRegion(method) {
    if (!this.hotCallGraphRegions.enabled || !method) return false;
    const generated = this.codegenCache.get(method);
    if (generated?.jvmHotCallGraphRegionPlan) return true;
    // Loops are not the only useful region roots. A frequently entered small
    // caller can dominate execution by repeatedly crossing into loop-bearing
    // descendants; keeping the old backward-branch requirement stranded that
    // caller above the jointly lowered graph. Adaptive promotion is runtime
    // heat evidence, so admit any promoted structured caller that actually
    // publishes call edges. Leaves still use their ordinary positional ABI.
    const callSites = generated?.jvmStructuredRegionCallSites;
    const warmedLoop = this.hasBackwardBranch(method) &&
      // canRun deliberately compiles a backward-branch method on its first
      // entry, before the ordinary threshold. Stable entries then stop
      // incrementing invocationCounts, so "observed at least once" is the
      // matching heat proof for a loop root.
      (this.invocationCounts.get(method) || 0) > 0;
    return Array.isArray(callSites) && callSites.length > 0 &&
      (warmedLoop || this.adaptiveCodegenMethods.has(method) ||
        this.isDynamicArrayStructuredFirstMethod(method));
  }

  observeAdaptiveCodegenHeat(frame) {
    if (this.adaptiveCodegenMethods.has(frame.method)) return false;
    if (frame.pc === 0 && !frame.jitAdaptiveEntryCounted) {
      frame.jitAdaptiveEntryCounted = true;
      const count = (this.adaptiveCodegenCounts.get(frame.method) || 0) + 1;
      this.adaptiveCodegenCounts.set(frame.method, count);
      if (count >= this.adaptiveCodegenThreshold) {
        this.promoteAdaptiveCodegen(frame.method);
        this.adaptiveEntryPromotionCount += 1;
        this.adaptiveCodegenFrameHeat.delete(frame);
        return true;
      }
    }

    if (this.adaptiveCodegenTimeThresholdMs <= 0) return false;
    let heat = this.adaptiveCodegenFrameHeat.get(frame);
    if (!heat) {
      heat = { startedAt: this.monotonicNow(), probes: 0 };
      this.adaptiveCodegenFrameHeat.set(frame, heat);
    }
    heat.probes += 1;
    if (heat.probes < this.adaptiveCodegenTimeSampleInterval) return false;
    heat.probes = 0;
    this.adaptiveTimeSampleCount += 1;
    if (this.monotonicNow() - heat.startedAt < this.adaptiveCodegenTimeThresholdMs) {
      return false;
    }

    this.promoteAdaptiveCodegen(frame.method);
    this.adaptiveTimePromotionCount += 1;
    this.adaptiveCodegenFrameHeat.delete(frame);
    return true;
  }

  promoteAdaptiveCodegen(method) {
    if (this.adaptiveCodegenMethods.has(method)) return;
    this.adaptiveCodegenMethods.add(method);
    this.codegenSupportCache.set(method, true);
    this.adaptiveWholeMethodPromotionCount += 1;
    if (!this.preferWholeMethodJs &&
        this.adaptiveWholeMethodEscalationThreshold > 0 &&
        this.adaptiveWholeMethodPromotionCount >=
          this.adaptiveWholeMethodEscalationThreshold) {
      this.preferWholeMethodJs = true;
      this.adaptiveWholeMethodEscalationCount += 1;
    }
    // The sampled elapsed-time observation is already stronger heat evidence
    // than the ordinary entry counter. Let this frame OSR immediately even
    // when the method has no backward branch.
    this.invocationCounts.set(method, this.warmupThreshold);
  }

  finishTryRunFrame(frame, thread, methodKey, result) {
    if (result && result.deopt) {
      if (this.profileMethods) {
        this.lastDeoptReason = result.reason;
        this.methodDeoptCounts.set(
          methodKey, (this.methodDeoptCounts.get(methodKey) || 0) + 1,
        );
        this.methodDeoptReasons.set(methodKey, result.reason || "unspecified");
        const siteKey = `${methodKey}@${frame.pc}:` +
          `${result.reason || "unspecified"}`;
        this.methodDeoptSites.set(
          siteKey, (this.methodDeoptSites.get(siteKey) || 0) + 1,
        );
      }
      if (!result.transient) {
        this.deoptedMethods.add(frame.method);
        this.hotCallGraphRegions.markMethodDeoptimized(frame.method);
        frame.jitJsDisabled = true;
      }
      return HANDLED_RESULT;
    }
    if (result && result.returned) {
      const explicitReturnParent = frame.jitGeneratedReturnParent;
      const explicitReturnType = frame.jitGeneratedReturnType;
      delete frame.jitGeneratedReturnParent;
      delete frame.jitGeneratedReturnType;
      if (isReflectiveTarget(thread, frame)) {
        completeReflectiveCall(
          thread,
          result.value === RETURN_VOID ? null : result.value,
        );
      } else if (result.value !== RETURN_VOID) {
        const frames = thread.callStack.items;
        const returnParent = explicitReturnParent &&
            frames.includes(explicitReturnParent)
          ? explicitReturnParent
          : !thread.callStack.isEmpty() ? thread.callStack.peek() : null;
        if (returnParent) returnParent.stack.push(result.value);
        if (frame.jitFrameHandoffTrace) {
          console.error("[jvm-frame-handoff-return] " + JSON.stringify({
            ...frame.jitFrameHandoffTrace, tier: "generated",
            childDepth: frame.stack.items.length,
            parentDepth: returnParent ? returnParent.stack.items.length : null,
            parentPc: returnParent?.pc ?? null,
            valueType: result.value === null ? "null" : typeof result.value,
          }));
          delete frame.jitFrameHandoffTrace;
        }
      } else if (explicitReturnParent && explicitReturnType !== "void") {
        console.error("[jit-generated-return-underflow]", {
          child: `${frame.className || "<unknown>"}.` +
            `${frame.method?.name || "<unknown>"}${frame.method?.descriptor || ""}`,
          parent: `${explicitReturnParent.className || "<unknown>"}.` +
            `${explicitReturnParent.method?.name || "<unknown>"}` +
            `${explicitReturnParent.method?.descriptor || ""}`,
          expectedReturnType: explicitReturnType,
        });
      }
    }
    return HANDLED_RESULT;
  }

  dumpStats(limit = 10) {
    const rows = [...this.methodRunCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(0, limit));
    console.error(`JIT generated=${this.generatedRunCount} sync=${this.syncGeneratedRunCount} inlined=${this.syncInlinedCallCount} intrinsics=${this.syncIntrinsicCallCount} eagerMonomorphicLinks=${this.eagerMonomorphicCallLinkCount} hotGraphModules=${this.hotCallGraphRegions.moduleCompileCount} hotGraphRuns=${this.hotCallGraphRegions.runCount} hotGraphFallbacks=${this.hotCallGraphRegions.guardFallbackCount} syncOperandUnderflowFallbacks=${this.syncOperandUnderflowFallbackCount} reusedFrames=${this.syncReusedFrameCount} adaptiveWholeMethod=${this.adaptiveWholeMethodPromotionCount} adaptiveEscalations=${this.adaptiveWholeMethodEscalationCount} structuredSsa=${this.structuredSsa.totalRunCount} structuredSsaSafePoints=${this.structuredSsa.safePointCount} structuredLazyStatics=${this.structuredSsa.lazyStaticTargetLinkCount} structuredSplitMethods=${this.structuredSsa.splitMethodCount} structuredSplitBlocks=${this.structuredSsa.splitBlockCount} inlineLoopRegions=${this.inlineLoopRegionRunCount} inlineLoopOsr=${this.inlineLoopRegionOsrCount} scalarLoops=${this.scalarLoopRunCount} scalarSafePoints=${this.scalarLoopSafePointCount} scalarSsa=${this.scalarSsaRunCount} scalarArrayViews=${this.scalarSsaArrayViewCount} scalarEliminatedReads=${this.scalarSsaEliminatedReadCount} scalarThreadedEdges=${this.scalarSsaThreadedEdgeCount} fused=${this.fusedRunCount} fusedDirect=${this.fusedDirectRunCount} fusedFallback=${this.fusedGuardedFallbackCount} restoredFrames=${this.fusedRestoredExceptionFrameCount} runner=${this.runnerRunCount}`);
    for (const [method, count] of rows) {
      const deopts = this.methodDeoptCounts.get(method) || 0;
      console.error(`  ${count.toLocaleString()} runs ${method}${deopts ? ` (${deopts} deopt)` : ""}`);
    }
    this.dumpExecutionCounts("generated callees", this.generatedMethodRunCounts, limit);
    this.dumpExecutionCounts("inlined callees", this.inlinedMethodRunCounts, limit);
    this.dumpExecutionCounts("intrinsic callees", this.intrinsicMethodRunCounts, limit);
    this.dumpExecutionCounts("runner callees", this.runnerMethodRunCounts, limit);
    const deopts = [...this.methodDeoptCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(0, limit));
    if (deopts.length) console.error("JIT deoptimizations:");
    for (const [method, count] of deopts) {
      console.error(`  ${count.toLocaleString()} deopt ${method}: ${this.methodDeoptReasons.get(method)}`);
    }
    if (this.lastDeoptReason) console.error(`  last deopt: ${this.lastDeoptReason}`);
    if (this.wasmJit.enabled) this.wasmJit.dumpStats();
  }

  getGeneratedFunction(method) {
    if (!this.codegenEnabled || this.codegenUnavailable || !this.isCodegenSupported(method)) {
      return null;
    }
    if (this.codegenCache.has(method)) {
      const cached = this.codegenCache.get(method);
      // A verified loop constructor can initially retain its baseline Frame
      // entry while exposing a structured positional body to callers. Retry
      // that narrow structural case after additional invocation evidence;
      // broad late retries caused compiler churn in large applications.
      const retryableLoop = method.name === "<init>" &&
        this.isJitSafeConstructor(method) && this.hasBackwardBranch(method);
      if (cached && !cached.jvmStructuredSsa &&
          !cached.jvmRestoringDirectPositionalBody &&
          this.structuredSsa.enabled &&
          retryableLoop &&
          !this.codegenCompiling.has(method)) {
        const count = this.invocationCounts.get(method) || 0;
        const state = this.structuredConstructorRetryState.get(method) || {
          next: Math.max(8, this.warmupThreshold),
          delay: 8,
          attempts: 0,
        };
        if (count >= state.next && state.attempts < 16) {
          this.scheduleStructuredCacheUpgrade(method, cached);
          state.attempts += 1;
          state.delay = Math.min(8192, Math.max(8, state.delay * 4));
          state.next = count + state.delay;
          this.structuredConstructorRetryState.set(method, state);
        } else {
          this.structuredConstructorRetryState.set(method, state);
        }
      }
      return cached;
    }
    if (this.codegenCompiling.has(method)) return null;
    this.codegenCompiling.add(method);
    try {
      const generated = this.compileMethod(method);
      this.codegenCache.set(method, generated);
      if (generated?.jvmHotCallGraphFramedSource &&
          this.shouldCompileHotCallGraphRegion(method)) {
        this.compileHotCallGraphRegion(method);
      }
      return generated;
    } catch (err) {
      this.codegenCompileErrors.set(method, err);
      return null;
    } finally {
      this.codegenCompiling.delete(method);
    }
  }

  getStructuredRegionCandidate(method, canonical = null) {
    const ordinary = canonical || this.codegenCache.get(method) ||
      this.getGeneratedFunction(method);
    if (ordinary?.jvmStructuredSsa) return ordinary;
    if (!this.graphOwnedStructuredCandidatesEnabled &&
        !this.isGraphOwnedStructuredLeafCandidate(method)) return null;
    const cached = this.regionStructuredCandidates.get(method);
    if (cached) return cached;
    if (!this.structuredSsa.enabled ||
        this.regionStructuredCandidateCompiling.has(method) ||
        !this.canCompileSynchronously(method)) return null;
    this.regionStructuredCandidateCompiling.add(method);
    try {
      const candidate = this.structuredSsa.compile(method);
      if (!candidate?.jvmStructuredSsa) return null;
      this.regionStructuredCandidates.set(method, candidate);
      this.regionStructuredCandidateCompileCount += 1;
      return candidate;
    } catch (error) {
      this.codegenCompileErrors.set(method, error);
      return null;
    } finally {
      this.regionStructuredCandidateCompiling.delete(method);
    }
  }

  isGraphOwnedStructuredLeafCandidate(method) {
    if (!method || method.name === "<init>" || method.name === "<clinit>" ||
        isSynchronizedMethod(method)) return false;
    if (this.regionStructuredLeafCandidateCache.has(method)) {
      return this.regionStructuredLeafCandidateCache.get(method);
    }
    const items = this.getCodeItems(method);
    let primitiveArrayAccesses = 0;
    let calls = 0;
    for (const item of items) {
      const op = getOp(item?.instruction);
      if (PRIMITIVE_ARRAY_ACCESS_OPCODES.has(op)) {
        primitiveArrayAccesses += 1;
      } else if (op === "invokestatic" || op === "invokevirtual" ||
          op === "invokeinterface" || op === "invokespecial" ||
          op === "invokedynamic") {
        calls += 1;
      }
    }
    const code = method.attributes?.find((attribute) =>
      attribute.type === "code")?.code;
    // These leaves are precisely the case where an independently selected
    // baseline/Wasm tier prevents a caller-owned graph from passing scalar
    // operands across a very frequent edge. Jointly lower only a bounded,
    // call-free primitive-array loop. The structured renderer still performs
    // the complete CFG, stack, exception, and positional-ABI verification;
    // this predicate merely decides whether that verification is worth
    // requesting from a graph.
    const selected = items.length >= 16 && items.length <= 512 &&
      primitiveArrayAccesses >= 4 && calls === 0 &&
      this.hasBackwardBranch(method) &&
      (code?.exceptionTable?.length || 0) === 0;
    this.regionStructuredLeafCandidateCache.set(method, selected);
    return selected;
  }

  compileHotCallGraphRegion(method, options) {
    return this.hotCallGraphRegions.compile(method, options);
  }

  maybeExpandHotCallGraphRegion(site) {
    const callerMethod = site?.callerMethod;
    if (!callerMethod || !this.hotCallGraphRegions.enabled) return;
    const generated = this.codegenCache.get(callerMethod);
    const plan = generated?.jvmHotCallGraphRegionPlan;
    const dirty = this.hotCallGraphRegions.isPlanDirty(plan);
    // Publication marks every dependent root dirty. With blind periodic
    // probing disabled, a stable plan has no new information to inspect; do
    // not rescan all boundary target/source identities at every dynamic call.
    if (!dirty &&
        this.hotCallGraphRegions.expansionProbeInterval === 0) return;
    if (dirty) return;
    const probeCount = (this.hotCallGraphRegions.expansionProbeCounts.get(
      callerMethod) || 0) + 1;
    this.hotCallGraphRegions.expansionProbeCounts.set(
      callerMethod, probeCount);
    const periodicProbe =
      this.hotCallGraphRegions.expansionProbeInterval > 0 &&
      probeCount % this.hotCallGraphRegions.expansionProbeInterval === 0;
    if (!periodicProbe ||
        !this.hotCallGraphRegions.hasExpandableBoundaryChange(plan)) return;
    this.hotCallGraphRegions.stateExpansionCount += 1;
    this.hotCallGraphRegions.markCallSiteFeedback(site);
  }

  refreshHotCallGraphRegionAtEntry(generated, frame) {
    const plan = generated?.jvmHotCallGraphRegionPlan;
    if (!plan || frame?.pc !== 0 ||
        !this.hotCallGraphRegions.isPlanDirty(plan)) return generated;
    if (plan.backendEligible &&
        plan.entryCount + 1 <
          this.hotCallGraphRegions.expansionEntryThreshold) {
      return generated;
    }
    if (plan.backendEligible &&
        this.hotCallGraphRegions.expandableBoundaryCount(plan) === 0) {
      // Republishing the same generated identity can conservatively mark its
      // dependants dirty even though no boundary target/source changed. Once
      // the entry audit proves that there is nothing to add, acknowledge the
      // event instead of rescanning it on every subsequent activation.
      this.hotCallGraphRegions.dirtyRoots.delete(frame.method);
      this.hotCallGraphRegions.lastExpansionAttempts.set(frame.method,
        this.hotCallGraphRegions.captureExpandableBoundaryStates(plan));
      return generated;
    }
    // A root may publish many child targets during one long activation. A
    // module compiled at any of those call sites cannot affect that active
    // invocation. Consume all accumulated target/type feedback once here,
    // before the next activation selects its framed regional body.
    this.hotCallGraphRegions.dirtyExpansionCount += 1;
    this.compileHotCallGraphRegion(frame.method, {
      forceExpansion: true,
      ignoreExpansionAttempt: true,
    });
    return generated;
  }

  runGeneratedFrame(generated, frame, thread, initialBytecodeChecks) {
    // JVM_DEBUG_INVOKE_TRACE also covers generated frames: a JIT tier can run
    // a method without ever calling CallStack.push, so a push-site trace alone
    // reports only the interpreted half of an interleaving.
    if (JitCompiler.debugInvokeTrace) {
      this.traceGeneratedFrameEntry(frame);
    }
    if (this.profileMethods) {
      this.generatedRunCount += 1;
      if (generated.jvmSynchronous) this.syncGeneratedRunCount += 1;
      this.recordExecution(this.generatedMethodRunCounts, frame);
      if (generated.jvmScalarLoop) this.recordExecution(this.scalarLoopMethodRunCounts, frame);
      if (generated.jvmStructuredSsa) this.recordExecution(this.structuredSsaMethodRunCounts, frame);
    }
    // Method identity formatting allocates a comparatively large string and
    // used to run on every generated child entry even in production. Build it
    // only for diagnostics that consume it; hot nested calls otherwise need
    // no owner/name/descriptor lookup at all.
    let timingSelected = false;
    if (this.profileTimings) {
      // Decide whether this entry is sampled before formatting its guest
      // identity. The old order allocated an owner/name/descriptor string on
      // every generated entry even though 127 of 128 entries used no clock.
      this.methodTimingRandomState = (Math.imul(this.methodTimingRandomState, 1664525) +
        1013904223) >>> 0;
      timingSelected =
        this.methodTimingRandomState < 0x100000000 / this.methodTimingSampleRate;
    }
    const exclusiveTimingSelected = this.exclusiveTimingsEnabled &&
      (this.exclusiveTimingStack.length > 0 ||
        this.matchesExclusiveTimingRoot(frame));
    const needsMethodKey = Boolean(this.methodEntryTraceKey) ||
      timingSelected || exclusiveTimingSelected;
    const frameMethodKey = needsMethodKey
      ? `${this.getFrameClassName(frame)}.${frame.method.name}${frame.method.descriptor}`
      : null;
    if (this.methodEntryTraceKey &&
        this.methodEntryTraceKey === frameMethodKey &&
        !this.methodEntryTrace && frame.pc === 0) {
      try {
        this.methodEntryTrace = {
          methodKey: frameMethodKey,
          capturedAt: this.monotonicNow(),
          state: this.jvm.saveState(),
        };
      } catch (error) {
        this.methodEntryTrace = {
          methodKey: frameMethodKey,
          error: error?.stack || error?.message || String(error),
        };
      }
    }
    let timingKey = null;
    let timingStarted = 0;
    const candidateTimingKey = timingSelected ? frameMethodKey : null;
    if (candidateTimingKey &&
        (!this.methodTimingFilter || this.methodTimingFilter.has(candidateTimingKey))) {
      // Render call patterns are strongly periodic, so retain pseudo-random
      // sampling rather than every Nth call. Only the selected entry pays for
      // identity formatting and a clock read.
      timingKey = candidateTimingKey;
      timingStarted = this.monotonicNow();
    }
    const exclusiveTiming = exclusiveTimingSelected
      ? this.beginExclusiveTiming(frameMethodKey,
        generated.jvmStructuredSsa ? "structured"
          : generated.jvmScalarLoop ? "scalar"
            : generated.jvmSynchronous ? "generated-sync" : "generated-async")
      : null;
    if (!timingKey && !exclusiveTiming) {
      return generated(frame, thread, this, initialBytecodeChecks);
    }
    let result;
    try {
      result = generated(frame, thread, this, initialBytecodeChecks);
    } catch (error) {
      this.endExclusiveTiming(exclusiveTiming);
      throw error;
    }
    if (result && typeof result.then === "function") {
      return result.then((value) => {
        if (timingKey) this.recordMethodTiming(timingKey,
          this.monotonicNow() - timingStarted, generated);
        this.endExclusiveTiming(exclusiveTiming);
        return value;
      }, (error) => {
        if (timingKey) this.recordMethodTiming(timingKey,
          this.monotonicNow() - timingStarted, generated);
        this.endExclusiveTiming(exclusiveTiming);
        throw error;
      });
    }
    if (timingKey) this.recordMethodTiming(timingKey,
      this.monotonicNow() - timingStarted, generated);
    this.endExclusiveTiming(exclusiveTiming);
    return result;
  }

  beginExclusiveTiming(methodKey, tier) {
    if (!this.exclusiveTimingsEnabled) return null;
    const stack = this.exclusiveTimingStack;
    if (!stack.length && this.exclusiveTimingRootKey &&
        methodKey !== this.exclusiveTimingRootKey) return null;
    const now = this.monotonicNow();
    const parent = stack[stack.length - 1];
    if (parent) parent.exclusiveMs += now - parent.resumedAt;
    const context = {
      methodKey, tier, startedAt: now, resumedAt: now, exclusiveMs: 0,
    };
    stack.push(context);
    return context;
  }

  matchesExclusiveTimingRoot(frame) {
    const root = this.exclusiveTimingRootKey;
    if (!root) return true;
    const method = frame?.method;
    if (!method) return false;
    const suffix = `.${method.name}${method.descriptor}`;
    if (!root.endsWith(suffix)) return false;
    return root === `${this.getFrameClassName(frame)}${suffix}`;
  }

  shouldBeginExclusiveTimingKey(methodKey) {
    if (!this.exclusiveTimingsEnabled) return false;
    return this.exclusiveTimingStack.length > 0 ||
      !this.exclusiveTimingRootKey ||
      methodKey === this.exclusiveTimingRootKey;
  }

  endExclusiveTiming(context) {
    if (!context) return;
    const now = this.monotonicNow();
    const stack = this.exclusiveTimingStack;
    if (stack[stack.length - 1] !== context) {
      // A profiler must never affect guest execution. Drop inconsistent state
      // rather than throwing through the JVM if an unexpected async re-entry
      // violates the single-threaded nesting assumption.
      stack.length = 0;
      return;
    }
    context.exclusiveMs += now - context.resumedAt;
    stack.pop();
    const previous = this.exclusiveTimingSamples.get(context.methodKey) || {
      tier: context.tier, samples: 0, totalMs: 0, inclusiveMs: 0, maxMs: 0,
    };
    previous.samples += 1;
    previous.totalMs += context.exclusiveMs;
    previous.inclusiveMs += now - context.startedAt;
    previous.maxMs = Math.max(previous.maxMs, context.exclusiveMs);
    previous.tier = context.tier;
    this.exclusiveTimingSamples.set(context.methodKey, previous);
    const parent = stack[stack.length - 1];
    if (parent) {
      const edgeKey = `${parent.methodKey}\0${context.methodKey}`;
      const edge = this.exclusiveTimingEdges.get(edgeKey) || {
        parent: parent.methodKey, child: context.methodKey,
        tier: context.tier, totalMs: 0, maxMs: 0,
      };
      const inclusiveMs = now - context.startedAt;
      edge.totalMs += inclusiveMs;
      edge.maxMs = Math.max(edge.maxMs, inclusiveMs);
      edge.tier = context.tier;
      this.exclusiveTimingEdges.set(edgeKey, edge);
      parent.resumedAt = now;
    }
  }

  monotonicNow() {
    if (typeof performance !== "undefined" && performance &&
        typeof performance.now === "function") return performance.now();
    if (typeof process !== "undefined" && process.hrtime?.bigint) {
      return Number(process.hrtime.bigint()) / 1e6;
    }
    return Date.now();
  }

  generatedSource(method, tier, source, ownerOverride = null) {
    // A sourceURL lets Firefox's native sampling profiler identify generated
    // guest bodies without adding a clock read or counter to their hot path.
    // The identity is diagnostic metadata only; tier selection never reads it.
    const owner = ownerOverride || method?.className ||
      this.jvm.findClassNameForMethod?.(method) || "unknown";
    const methodIdentity = `${method?.name || "unknown"}${method?.descriptor || ""}`;
    const url = `jvm-generated://${encodeURIComponent(owner)}/` +
      `${encodeURIComponent(methodIdentity)}?tier=${encodeURIComponent(tier)}`;
    const functionName = `jvm$${tier}$${owner}$${methodIdentity}`
      .replace(/[^A-Za-z0-9_$]/g, "_");
    return { source: `${source}\n//# sourceURL=${url}`, url, functionName };
  }

  dumpGeneratedSource(labeled, method, tier, ownerOverride, hoistedSource) {
    const owner = ownerOverride || method?.className ||
      this.jvm.findClassNameForMethod?.(method) || "unknown";
    const name = method?.name || "unknown";
    const filter = (process.env.JVM_DUMP_GENERATED_METHODS || "")
      .split(",").map((entry) => entry.trim()).filter(Boolean);
    if (filter.length && !filter.includes(owner) &&
        !filter.includes(`${owner}.${name}`)) return;
    try {
      const fs = require("fs");
      const dir = process.env.JVM_DUMP_GENERATED_DIR;
      fs.mkdirSync(dir, { recursive: true });
      const safe = `${owner}.${name}${method?.descriptor || ""}.${tier}`
        .replace(/[^A-Za-z0-9_.$-]/g, "_");
      fs.writeFileSync(`${dir}/${safe}.js`,
        `${hoistedSource ? `${hoistedSource}\n` : ""}${labeled.source}\n`);
    } catch { /* dump only */ }
  }

  createGeneratedFunction(method, tier, parameters, source,
    ownerOverride = null, asynchronous = false, generator = false,
    captures = null, hoistedSource = null) {
    const labeled = this.generatedSource(method, tier, source, ownerOverride);
    // Reading a miscompile means reading the code that was generated. The
    // sourceURL only names it inside a debugger, so JVM_DUMP_GENERATED_DIR
    // writes each body to disk; JVM_DUMP_GENERATED_METHODS=ck.a,p.a narrows
    // the dump to the owners or owner.method pairs under suspicion.
    if (typeof process !== "undefined" && process.env &&
        process.env.JVM_DUMP_GENERATED_DIR) {
      this.dumpGeneratedSource(labeled, method, tier, ownerOverride,
        hoistedSource);
    }
    // Function constructors themselves remain anonymous in Gecko profiles.
    // Return a named literal so stack sampling exposes the guest identity.
    const prefix = generator ? "function* " : asynchronous ? "async function " : "function ";
    const captureNames = captures ? Object.keys(captures) : [];
    // Hoisted declarations evaluate once in the factory scope; the sourceURL
    // pragma inside the returned function's body names the whole script, so
    // profilers attribute the hoisted helpers to the same generated URL.
    const factory = new Function(...captureNames, `"use strict"; ${
      hoistedSource ? `\n${hoistedSource}\n` : ""}return ${prefix}` +
      `${labeled.functionName}(${parameters.join(",")}) {\n` +
      `${labeled.source}\n}`);
    const generated = factory(...captureNames.map((name) => captures[name]));
    generated.jvmSourceUrl = labeled.url;
    return generated;
  }

  recordMethodTiming(methodKey, elapsedMs, generated) {
    const previous = this.methodTimingSamples.get(methodKey) || {
      samples: 0, totalMs: 0, maxMs: 0,
      tier: generated.jvmStructuredSsa ? "structured"
        : generated.jvmScalarLoop ? "scalar"
          : generated.jvmSynchronous ? "generated-sync" : "generated-async",
    };
    previous.samples += 1;
    previous.totalMs += elapsedMs;
    previous.maxMs = Math.max(previous.maxMs, elapsedMs);
    this.methodTimingSamples.set(methodKey, previous);
  }

  recordExecution(counts, frame) {
    if (!this.profileMethods) return;
    const method = frame && frame.method;
    if (!method) return;
    const methodKey = `${this.getFrameClassName(frame)}.${method.name}${method.descriptor}`;
    counts.set(methodKey, (counts.get(methodKey) || 0) + 1);
  }

  dumpExecutionCounts(label, counts, limit) {
    const rows = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(0, limit));
    if (!rows.length) return;
    console.error(`JIT ${label}:`);
    for (const [method, count] of rows) {
      console.error(`  ${count.toLocaleString()} runs ${method}`);
    }
  }

  // Diagnostic bisection: JVM_JIT_DENY=a,b refuses JIT admission for methods
  // owned by those classes, so a miscompile can be attributed to one class
  // without disabling the whole tier. Empty by default.
  jitDenied(method) {
    if (!this.jitDenyClasses) {
      const raw = (typeof process !== "undefined" && process.env &&
        process.env.JVM_JIT_DENY) || "";
      this.jitDenyClasses = new Set(
        raw.split(",").map((name) => name.trim()).filter(Boolean));
    }
    if (this.jitDenyClasses.size === 0) return false;
    const owner = this.jvm.findClassNameForMethod?.(method) ||
      method.className || "";
    return this.jitDenyClasses.has(owner);
  }

  isSupported(method) {
    if (this.supportCache.has(method)) {
      return this.supportCache.get(method);
    }
    if (this.jitDenied(method)) {
      this.supportCache.set(method, false);
      return false;
    }

    if (method.name === "<init>" || method.name === "<clinit>") {
      this.supportCache.set(method, false);
      return false;
    }

    const code = method.attributes.find((attr) => attr.type === "code");
    if (!code) {
      this.supportCache.set(method, false);
      return false;
    }

    const codeItems = this.getCodeItems(method);
    if (this.requiresOpaqueControlInterpreter(method, codeItems)) {
      this.supportCache.set(method, false);
      return false;
    }
    if (!this.experimentalControlFlow && normalFlowContains(codeItems, (instruction, op) =>
      op === "invokespecial" && instruction &&
      Array.isArray(instruction.arg) && Array.isArray(instruction.arg[2]) &&
      instruction.arg[2][0] === "<init>")) {
      this.supportCache.set(method, false);
      return false;
    }
    if (hasExperimentalControlFlow(codeItems, this.getExceptionTable(method)) &&
      !this.experimentalControlFlow &&
      !this.hasJitSafeControlFlow(method, codeItems)) {
      this.supportCache.set(method, false);
      return false;
    }
    if (hasMonitorBytecode(codeItems) && !this.hasJitSafeMonitorBody(codeItems)) {
      this.supportCache.set(method, false);
      return false;
    }
    const doubleOps = new Set([
      "d2i", "dadd", "daload", "dastore", "dcmpg", "dcmpl",
      "dconst_0", "dconst_1", "ddiv", "dload", "dload_0", "dload_1",
      "dload_2", "dload_3", "dmul", "dneg", "dreturn", "dstore",
      "dstore_0", "dstore_1", "dstore_2", "dstore_3", "dsub",
    ]);
    const floatOps = new Set([
      "d2f", "f2d", "f2i", "fadd", "faload", "fastore", "fcmpg", "fcmpl",
      "fconst_0", "fconst_1", "fconst_2", "fdiv", "fload", "fload_0",
      "fload_1", "fload_2", "fload_3", "fmul", "fneg", "frem", "freturn",
      "fstore", "fstore_0", "fstore_1", "fstore_2", "fstore_3", "fsub", "i2f",
    ]);
    const integerOps = new Set([
      "i2b", "iadd", "iand", "idiv", "imul", "ineg", "ior", "irem",
      "ishl", "ishr", "isub", "ixor",
    ]);
    const longOps = new Set(["i2l", "l2i", "lcmp", "ldiv", "lmul", "lshr", "lxor"]);
    const hasNumericHotPath = codeItems.some((item) => {
      const op = typeof item.instruction === "string" ? item.instruction : item.instruction && item.instruction.op;
      return op && (doubleOps.has(op) || floatOps.has(op) || integerOps.has(op) || longOps.has(op) || op === "i2d" ||
        op === "newarray" && (item.instruction.arg === "double" || item.instruction.arg === "float" || item.instruction.arg === "int"));
    });
    const eligibleShape = hasNumericHotPath || this.hasBackwardBranch(method) ||
      this.hasCallDenseComputeShape(method, codeItems);
    const hasPostIncrementShuffle = codeItems.some((item) =>
      getOp(item && item.instruction) === "dup_x1");
    const supportedPostIncrementShape = !hasPostIncrementShuffle ||
      this.postIncrementHelpersEnabled;

    const allowed = new Set([
      "aconst_null", "aload", "aload_0", "aload_1", "aload_2", "aload_3",
      "areturn", "astore", "astore_0", "astore_1", "astore_2", "astore_3", "athrow",
      "aaload", "aastore", "anewarray", "arraylength", "bastore", "baload", "caload", "castore", "checkcast",
      "bipush", "d2i", "dadd", "daload", "dastore", "dcmpg", "dcmpl",
      "dconst_0", "dconst_1", "ddiv", "dload", "dload_0", "dload_1",
      "dload_2", "dload_3", "dmul", "dneg", "dreturn", "dstore",
      "dstore_0", "dstore_1", "dstore_2", "dstore_3", "dsub", "dup", "dup2",
      "d2f", "f2d", "f2i", "fadd", "faload", "fastore", "fcmpg", "fcmpl",
      "fconst_0", "fconst_1", "fconst_2", "fdiv", "fload", "fload_0",
      "fload_1", "fload_2", "fload_3", "fmul", "fneg", "frem", "freturn",
      "fstore", "fstore_0", "fstore_1", "fstore_2", "fstore_3", "fsub", "i2f",
      "getfield", "getstatic", "goto", "i2b", "i2d", "i2l", "iadd", "iaload", "iand", "iastore", "idiv",
      "iconst_m1", "iconst_0", "iconst_1", "iconst_2", "iconst_3", "iconst_4", "iconst_5",
      "if_acmpeq", "if_acmpne", "ifeq", "ifge", "ifgt", "ificmpge",
      "if_icmpeq", "if_icmpge", "if_icmpgt", "if_icmple", "if_icmplt", "if_icmpne",
      "ifle", "iflt", "ifne", "ifnonnull", "ifnull", "iload", "iload_0",
      "iload_1", "iload_2", "iload_3", "imul", "inc", "iinc",
      "invokeinterface", "invokespecial", "invokestatic", "invokevirtual", "istore", "istore_0",
      "ior", "irem", "ireturn", "ishl", "istore_1", "istore_2", "istore_3", "ineg", "ishr", "iushr", "isub", "ixor", "l2i", "lcmp", "ldc", "ldc_w", "ldc2_w", "ldiv", "lmul", "lreturn", "lshr", "lxor",
      ...(this.postIncrementHelpersEnabled ? ["dup_x1"] : []),
      ...EXTENDED_TIER_OPCODES,
      "monitorenter", "monitorexit", "multianewarray", "new", "newarray", "nop", "pop", "putfield", "putstatic", "return", "saload", "sastore",
      "sipush"
    ]);

    const supported = eligibleShape && supportedPostIncrementShape && codeItems.every((item) => {
        if (!item.instruction) return true;
        const op = typeof item.instruction === "string" ? item.instruction : item.instruction.op;
        return allowed.has(op);
      });

    this.supportCache.set(method, supported);
    return supported;
  }

  isCodegenSupported(method, allowEffectfulCalls = false) {
    if (this.jitDenied(method)) return false;
    if (!allowEffectfulCalls && this.adaptiveCodegenMethods.has(method)) {
      return true;
    }
    const supportCache = allowEffectfulCalls
      ? this.adaptiveCodegenSupportCache : this.codegenSupportCache;
    if (supportCache.has(method)) {
      return supportCache.get(method);
    }
    if (allowEffectfulCalls &&
        this.adaptiveCodegenDependencyPending.has(method) &&
        this.adaptiveCodegenDependencyEpoch.get(method) ===
          (this.jvm.classEpoch || 0)) {
      return false;
    }

    const code = method.attributes.find((attr) => attr.type === "code");
    if (!code) {
      supportCache.set(method, false);
      return false;
    }

    const codeItems = this.getCodeItems(method);
    // NOTE: no opaque-control rejection here, deliberately. Unlike isSupported,
    // this tier has always accepted those methods once they pass warmup, and
    // they are among the largest hot bodies in a Tomb Racer boot — adding the
    // restriction here costs the boot >70 s.
    const safeConstructor = this.hotLoopConstructorsEnabled &&
      this.isJitSafeConstructor(method, codeItems);
    if ((method.name === "<init>" && !safeConstructor) ||
        method.name === "<clinit>" ||
        !safeConstructor && !allowEffectfulCalls &&
        !this.experimentalControlFlow &&
        normalFlowContains(codeItems, (instruction, op) =>
          op === "invokespecial" && instruction &&
          Array.isArray(instruction.arg) && Array.isArray(instruction.arg[2]) &&
          instruction.arg[2][0] === "<init>")) {
      supportCache.set(method, false);
      return false;
    }
    const safeInitializationCalls = !safeConstructor && allowEffectfulCalls
      ? this.hasOnlyJitSafeInitializationCalls(codeItems) : true;
    if (safeInitializationCalls !== true) {
      // Adaptive compilation can start after an arbitrary number of
      // interpreter invocations.  Only omit a constructor boundary when its
      // complete initialization is already proven synchronous; otherwise a
      // cold/deoptimized constructor may leave the caller suspended between
      // `new`/`dup` and `invokespecial`, where replaying either side would
      // change the operand stack.  The proof follows constant-pool targets
      // and constructor bytecodes, independent of guest names.
      // An unloaded target is not a stable rejection: the first interpreted
      // invocation may load it and make the proof available to the next hot
      // entry.
      const structuredOnly = safeInitializationCalls === false &&
        this.structuredUnsafeConstructorCallersEnabled &&
        this.structuredSsa.enabled &&
        this.hasConstructorBeforeOrInsideBackwardLoop(method, codeItems) &&
        codeItems.some((item) =>
          PRIMITIVE_ARRAY_ACCESS_OPCODES.has(getOp(item?.instruction)));
      if (structuredOnly) {
        // This only admits the method to the adaptive heat counter. The full
        // CFG/stack/exception proof still happens in compileMethod, which is
        // barred above from falling through to the baseline generator.
        this.structuredOnlyCodegenMethods.add(method);
        if (typeof process !== "undefined" && process.env &&
            process.env.JVM_TRACE_STRUCTURED_ONLY === "1") {
          console.error("[jit-structured-only-admission] " +
            `${this.jvm.findClassNameForMethod?.(method) || method.className || "unknown"}.` +
            `${method.name}${method.descriptor}`);
        }
      } else if (safeInitializationCalls === null) {
        this.adaptiveCodegenDependencyPending.add(method);
        this.adaptiveCodegenDependencyEpoch.set(
          method, this.jvm.classEpoch || 0);
      } else {
        this.adaptiveCodegenDependencyPending.delete(method);
        this.adaptiveCodegenDependencyEpoch.delete(method);
        supportCache.set(method, false);
      }
      if (!structuredOnly) return false;
    }
    if (allowEffectfulCalls) {
      this.adaptiveCodegenDependencyPending.delete(method);
      this.adaptiveCodegenDependencyEpoch.delete(method);
    }
    if (!safeConstructor && !allowEffectfulCalls &&
        hasExperimentalControlFlow(codeItems, this.getExceptionTable(method)) &&
        !this.experimentalControlFlow &&
        !this.hasJitSafeControlFlow(method, codeItems)) {
      supportCache.set(method, false);
      return false;
    }
    if (hasMonitorBytecode(codeItems) &&
        (allowEffectfulCalls || !this.hasJitSafeMonitorBody(codeItems))) {
      supportCache.set(method, false);
      return false;
    }
    const supportedOps = new Set([
      "aconst_null", "aload", "aload_0", "aload_1", "aload_2", "aload_3",
      "areturn", "astore", "astore_0", "astore_1", "astore_2", "astore_3", "athrow",
      "aaload", "aastore", "anewarray", "arraylength", "bastore", "baload", "caload", "castore", "checkcast",
      "bipush", "d2i", "dadd", "daload", "dastore", "dcmpg", "dcmpl",
      "dconst_0", "dconst_1", "ddiv", "dload", "dload_0", "dload_1",
      "dload_2", "dload_3", "dmul", "dneg", "dreturn", "dstore",
      "dstore_0", "dstore_1", "dstore_2", "dstore_3", "dsub", "dup", "dup_x2", "dup2",
      "d2f", "f2d", "f2i", "fadd", "faload", "fastore", "fcmpg", "fcmpl",
      "fconst_0", "fconst_1", "fconst_2", "fdiv", "fload", "fload_0",
      "fload_1", "fload_2", "fload_3", "fmul", "fneg", "frem", "freturn",
      "fstore", "fstore_0", "fstore_1", "fstore_2", "fstore_3", "fsub", "i2f",
      "getfield", "getstatic", "goto", "i2b", "i2d", "iadd", "iaload", "iastore", "idiv",
      "iconst_m1", "iconst_0", "iconst_1", "iconst_2", "iconst_3", "iconst_4", "iconst_5",
      "if_acmpeq", "if_acmpne", "ifeq", "ifge", "ifgt", "if_icmpeq", "if_icmpge", "if_icmpgt",
      "if_icmple",
      "if_icmplt", "if_icmpne", "ifle", "iflt", "ifne", "ifnonnull",
      "ifnull", "iload", "iload_0", "iload_1", "iload_2", "iload_3",
      "iand", "imul", "ineg", "iinc", "invokeinterface", "invokespecial", "invokestatic", "invokevirtual",
      "i2l", "ior", "irem", "ireturn", "ishl", "ishr", "iushr", "istore", "istore_0", "istore_1", "istore_2",
      "istore_3", "isub", "ixor", "l2i", "lcmp", "ldc", "ldc_w", "ldc2_w", "ldiv", "lmul", "lreturn", "lshr", "lxor", "multianewarray", "new", "newarray", "pop", "putfield", "putstatic", "return",
      "lookupswitch", "nop", "tableswitch",
      ...(this.postIncrementHelpersEnabled ? ["dup_x1"] : []),
      ...EXTENDED_TIER_OPCODES,
      "monitorenter", "monitorexit", "saload", "sastore", "sipush",
      // drem/l2d were the only opcodes left rejecting regression corpus's hot
      // ja.a(B)I, which took the slow scheduler path on 100% of its samples
      // and 66% of scheduler time. stackEffect already scored both; only the
      // emitter cases and this gate entry were missing.
      "drem", "l2d",
    ]);

    const hasNumericHotPath = codeItems.some((item) => {
      const op = getOp(item && item.instruction);
      return op && (
        op.startsWith("d")
        || op.startsWith("f")
        || op === "i2d"
        || op === "i2f"
        || op === "i2l"
        || op === "i2b"
        || op === "iadd"
        || op === "iand"
        || op === "idiv"
        || op === "imul"
        || op === "ineg"
        || op === "ior"
        || op === "irem"
        || op === "ishl"
        || op === "ishr"
        || op === "isub"
        || op === "iushr"
        || op === "ixor"
        || op === "lcmp"
        || op === "ldiv"
        || op === "lmul"
        || op === "lshr"
        || op === "lxor"
        || (op === "newarray" && (item.instruction.arg === "double" || item.instruction.arg === "float"))
      );
    });
    const supported = (safeConstructor || hasNumericHotPath ||
      this.hasBackwardBranch(method) ||
      this.hasCallDenseComputeShape(method, codeItems) ||
      this.isShortSupportedHelper(method)) &&
      (!codeItems.some((item) => getOp(item && item.instruction) === "dup_x1") ||
        this.postIncrementHelpersEnabled) &&
      codeItems.every((item) => {
      const op = getOp(item && item.instruction);
      return !op || supportedOps.has(op);
    });

    supportCache.set(method, supported);
    return supported;
  }

  hasOnlyJitSafeInitializationCalls(codeItems) {
    for (const item of codeItems || []) {
      const instruction = item && item.instruction;
      if (getOp(instruction) !== "invokespecial" ||
          !Array.isArray(instruction.arg) ||
          !Array.isArray(instruction.arg[2]) ||
          instruction.arg[2][0] !== "<init>") continue;
      const className = instruction.arg[1];
      const descriptor = instruction.arg[2][1];
      if (this.resolveSynchronousJreMethod(
        className, className, "<init>", descriptor)) continue;
      const classData = this.jvm.classes[className];
      const constructor = classData &&
        this.jvm.findMethod(classData, "<init>", descriptor);
      if (!classData || !constructor) return null;
      if (!this.isJitSafeConstructor(constructor)) return false;
    }
    return true;
  }

  isJitSafeConstructor(method, codeItems = this.getCodeItems(method)) {
    if (!method || method.name !== "<init>" ||
        (method.flags || []).includes("static") ||
        !this.canCompileSynchronously(method)) {
      return false;
    }
    const code = method.attributes.find((attribute) => attribute.type === "code");
    if (!code) return false;
    const exceptionTable = code.code.exceptionTable || [];
    if (exceptionTable.length &&
        !this.hasOnlyNoOpExceptionHandlers(method, codeItems)) return false;

    // The only constructor call may initialize this object through its direct
    // superclass. This deliberately excludes allocation/initialization of
    // nested objects, this(...) chains, and effectful recovery/finally
    // construction shapes. Bare or wrap-and-rethrow diagnostic handlers are
    // admitted by the proof above because they do not alter normal flow.
    const instructions = codeItems
      .map((item) => item && item.instruction)
      .filter(Boolean);
    if (getOp(instructions[0]) !== "aload_0" ||
        getOp(instructions[1]) !== "invokespecial") {
      return false;
    }
    const initializationCalls = instructions.filter((instruction) =>
      getOp(instruction) === "invokespecial" &&
      Array.isArray(instruction.arg) && Array.isArray(instruction.arg[2]) &&
      instruction.arg[2][0] === "<init>");
    if (initializationCalls.length !== 1 ||
        initializationCalls[0] !== instructions[1]) {
      return false;
    }
    const owner = this.jvm.findClassNameForMethod?.(method);
    const ownerClass = owner && this.jvm.classes[owner]?.ast?.classes?.[0];
    const target = instructions[1].arg;
    if (!ownerClass?.superClassName ||
        target[1] !== ownerClass.superClassName ||
        target[2][1] !== "()V") {
      return false;
    }
    const trivialForwarder = instructions.length === 3 &&
      getOp(instructions[2]) === "return";

    // javac emits field initializers after the direct-super call. A common
    // form consists entirely of constants, array allocation and field stores.
    // It is just as scheduler-safe as a forwarding constructor: it contains
    // no Java call or control-flow edge at which generated execution could
    // suspend and later replay a partially initialized receiver. Keep the
    // proof deliberately structural. The ordinary codegen opcode gate still
    // verifies every instruction before such a constructor is compiled.
    const linearFieldInitializer =
      getOp(instructions[instructions.length - 1]) === "return" &&
      instructions.slice(2, -1).every((instruction) => {
        const op = getOp(instruction);
        return op && !op.startsWith("invoke") && !op.startsWith("if") &&
          op !== "goto" && op !== "goto_w" &&
          op !== "tableswitch" && op !== "lookupswitch" &&
          op !== "jsr" && op !== "jsr_w" && op !== "ret" &&
          op !== "monitorenter" && op !== "monitorexit" &&
          op !== "athrow" && op !== "getstatic" && op !== "putstatic" &&
          !op.endsWith("return");
      });
    return trivialForwarder || linearFieldInitializer ||
      this.hasBackwardBranch(method);
  }

  hasJitSafeMonitorBody(codeItems) {
    // A compiled frame may run across many interpreter scheduler ticks. Do
    // not keep it compiled across JVM operations that can park the current
    // thread while a Java monitor is in scope. Ordinary synchronized blocks
    // remain eligible; wait/join/sleep/park methods resume in the interpreter.
    return !codeItems.some((item) => {
      const instruction = item && item.instruction;
      const op = getOp(instruction);
      if (!op || !op.startsWith("invoke") || !instruction || typeof instruction !== "object") {
        return false;
      }
      const arg = instruction.arg;
      if (!Array.isArray(arg) || !Array.isArray(arg[2])) return false;
      const owner = arg[1];
      const name = arg[2][0];
      return owner === "java/lang/Object" && name === "wait"
        || owner === "java/lang/Thread" && (name === "join" || name === "sleep" || name === "yield")
        || owner === "java/util/concurrent/locks/LockSupport" && String(name).startsWith("park");
    });
  }

  hasJitSafeControlFlow(method, codeItems) {
    // A generated frame runs until it returns or deoptimizes, whereas the
    // interpreter rotates threads between bytecodes. Restrict automatic
    // exception/monitor compilation to leaf normal-flow regions so it cannot
    // move a call (and its arbitrary scheduling effects) across that boundary.
    // Invokes that exist only in an exception handler do not disqualify a
    // compute body: the generated exception table preserves those paths.
    if (method.name === "<init>" || method.name === "<clinit>") {
      return false;
    }
    if (this.hasOnlyNoOpExceptionHandlers(method, codeItems)) {
      return true;
    }
    if (hasMonitorBytecode(codeItems)) {
      // Generated monitorenter/exit keep frame.pc and frame locals live. Calls
      // that cannot run in a JIT tier yield as interpreted child frames, so
      // the parent can resume after the call without abandoning its compiled
      // numeric regions. Parking primitives remain excluded above.
      if (!this.hasJitSafeMonitorBody(codeItems)) return false;
      return !normalFlowContains(codeItems, (instruction, op) =>
        op === 'invokespecial' && instruction &&
          Array.isArray(instruction.arg) && Array.isArray(instruction.arg[2]) &&
          instruction.arg[2][0] === '<init>');
    }
    return !normalFlowContainsInvoke(codeItems);
  }

  hasOnlyNoOpExceptionHandlers(method, codeItems) {
    const codeAttr = method.attributes.find((attr) => attr.type === "code");
    const table = codeAttr && codeAttr.code && codeAttr.code.exceptionTable || [];
    if (!table.length) return false;
    const labels = buildLabelMap(codeItems);
    return table.every((entry) => {
      const label = entry.handlerLbl || `L${entry.handler_pc}`;
      const handler = labels.get(label);
      return handler !== undefined && isNoOpExceptionHandler(codeItems, handler, labels);
    });
  }

  isShortSupportedHelper(method) {
    if (this.shortSupportedHelperCache.has(method)) {
      return this.shortSupportedHelperCache.get(method);
    }
    const codeItems = this.getCodeItems(method);
    if (codeItems.filter((item) => item.instruction).length > 32) {
      this.shortSupportedHelperCache.set(method, false);
      return false;
    }
    const allowed = new Set([
      "aaload", "aastore", "aconst_null", "aload", "aload_0", "aload_1", "aload_2",
      "aload_3", "areturn", "arraylength", "baload", "bastore", "bipush", "caload",
      "castore", "freturn", "getfield", "getstatic", "iaload", "iastore",
      "iconst_m1", "iconst_0", "iconst_1", "iconst_2", "iconst_3", "iconst_4",
      "iconst_5", "iadd", "iand", "imul", "ineg", "ior", "ishl", "ishr", "isub",
      "iushr", "ixor", "iload", "iload_0", "iload_1", "iload_2", "iload_3",
      "istore", "istore_0", "istore_1", "istore_2", "istore_3",
      "goto", "if_acmpeq", "if_acmpne", "ifeq", "ifge", "ifgt",
      "if_icmpeq", "if_icmpge", "if_icmpgt", "if_icmple", "if_icmplt",
      "if_icmpne", "ifle", "iflt", "ifne", "ifnonnull", "ifnull",
      "invokeinterface", "invokestatic", "invokevirtual", "ireturn", "putfield",
      "putstatic", "return", "saload", "sastore", "sipush",
    ]);
    const supported = codeItems.every((item) =>
      !item.instruction || allowed.has(getOp(item.instruction)));
    this.shortSupportedHelperCache.set(method, supported);
    return supported;
  }

  hasCallDenseComputeShape(method, codeItems) {
    if (method.name === "<init>" || method.name === "<clinit>") return false;
    // Forwarding/call-chain bodies can be hot without containing a loop or
    // arithmetic of their own. This includes larger acyclic decision trees
    // that select several numeric kernels per entry. Keep this a bytecode-
    // shape decision; supported-op and control-flow checks still run at the
    // caller, and the large form excludes backedges.
    const instructions = codeItems.filter((item) => item && item.instruction);
    const invokeCount = instructions.filter((item) => {
      const op = getOp(item.instruction);
      return op && op.startsWith("invoke");
    }).length;
    if (instructions.length <= 64) return invokeCount >= 2;
    return this.largeAcyclicCallTreesEnabled &&
      instructions.length <= 2048 &&
      invokeCount >= 4 &&
      !this.hasBackwardBranch(method);
  }

  getLabelMap(frame) {
    if (this.labelCache.has(frame.method)) {
      return this.labelCache.get(frame.method);
    }
    const labels = new Map();
    frame.instructions.forEach((item, index) => {
      if (item.labelDef) {
        const label = item.labelDef.endsWith(":") ? item.labelDef.slice(0, -1) : item.labelDef;
        labels.set(label, index);
      }
    });
    this.labelCache.set(frame.method, labels);
    return labels;
  }

  materialize(frame, locals, stack, pc) {
    const tracePattern = this.frameMaterializeTracePattern;
    const tracePc = this.frameMaterializeTracePc;
    if (tracePattern && (!Number.isInteger(tracePc) || pc === tracePc)) {
      const identity = `${frame.className || "?"}.${frame.method?.name || "?"}${
        frame.method?.descriptor || ""}`;
      if (identity.includes(tracePattern)) {
        console.error("[jvm-frame-materialize] " + JSON.stringify({
          frame: identity, pc, depth: stack.length,
          host: new Error("frame materialization").stack,
        }));
      }
    }
    frame.locals = locals;
    frame.stack.items = stack;
    frame.pc = pc;
  }

  materializeCached(frame, locals, stack, sp, pc) {
    stack.length = sp;
    this.materialize(frame, locals, stack, pc);
  }

  getFrameClassName(frame) {
    if (!frame) {
      return null;
    }
    return frame.className || (
      typeof this.jvm.findClassNameForMethod === "function"
        ? this.jvm.findClassNameForMethod(frame.method)
        : null
    );
  }

  shouldDeopt(frame, pc) {
    if (this.safePoints !== "bytecode") {
      return false;
    }
    const debug = this.jvm.debugManager;
    if (debug.debugMode && debug.runMode !== "continuing") {
      return true;
    }
    if (debug.hasLocatedBreakpoints() && !debug.isClassJitDeopted(this.getFrameClassName(frame))) {
      return false;
    }
    if (debug.breakpoints.size === 0) {
      return false;
    }
    // pc is the instruction about to run, not the one just run: both callers
    // consult this before advancing. Reading pc - 1 asked whether a breakpoint
    // sat on the *previous* bytecode, which stopped one instruction late with
    // that instruction's effect already on the operand stack.
    const item = frame.instructions[pc];
    if (!item || !item.labelDef) {
      return false;
    }
    const numericPc = parseInt(item.labelDef.substring(1, item.labelDef.length - 1), 10);
    return debug.breakpoints.has(numericPc);
  }

  needsBytecodeChecks() {
    const debug = this.jvm.debugManager;
    return Boolean(debug && (debug.debugMode || debug.breakpoints.size > 0));
  }

  // A generated region's safe-point budget is a fairness heuristic, not a JVM
  // observable. At a budget boundary the region may keep running only while
  // nothing can observe the difference: no debugger, no deterministic clock,
  // no other runnable thread, no expired sleep/wait deadline, and the
  // wall-clock event-loop yield deadline has not passed.
  continueQuantum(thread) {
    const jvm = this.jvm;
    if (!jvm || !thread || thread.status !== "runnable") return false;
    const debug = jvm.debugManager;
    if (debug && (debug.debugMode || debug.breakpoints.size > 0)) return false;
    if (jvm.clock && jvm.clock.enabled && !jvm.clock.realtime) return false;
    const wallNow = Date.now();
    if (!(wallNow < jvm._nextEventLoopYieldAt)) return false;
    // Sleep/wait deadlines live in the guest clock domain. A realtime fake
    // clock deliberately uses a reproducible epoch which need not resemble
    // Date.now(), so comparing those deadlines with wall time makes every
    // parked thread appear overdue and spills every generated quantum.
    const schedulerNow = jvm.clock ? jvm.clock.millis() : wallNow;
    const threads = jvm.threads || [];
    for (let index = 0; index < threads.length; index += 1) {
      const other = threads[index];
      if (other === thread) continue;
      if (other.status === "runnable") return false;
      if (other.status === "SLEEPING" && other.sleepUntil !== undefined &&
          schedulerNow >= Number(other.sleepUntil)) return false;
      if (other.status === "WAITING" && other.waitDeadline !== undefined &&
          schedulerNow >= Number(other.waitDeadline)) return false;
    }
    return true;
  }

  // Structured scalar regions keep their state in JavaScript locals. Returning
  // at every 10k-backedge poll solely because another Java thread is runnable
  // would spill the region and resume through the generic bytecode dispatcher.
  // Give those regions the ordinary wall-clock scheduler slice instead. Due
  // timers, debugger observability, deterministic clocks, and the browser
  // event-loop deadline still force an exact materialized safe point.
  traceGeneratedFrameEntry(frame) {
    const method = frame && frame.method;
    if (!method) return;
    const owner = frame.className || method.className || "?";
    if (!JitCompiler.debugInvokeTrace.has(`${owner}.${method.name}`) &&
        !JitCompiler.debugInvokeTrace.has(owner)) return;
    const fields = ((process.env.JVM_DEBUG_INVOKE_FIELDS || "f")
      .split(",").map((entry) => entry.trim()).filter(Boolean));
    const seen = [];
    (frame.locals || []).forEach((item, slot) => {
      if (!item || typeof item !== "object" || !item.fields) return;
      for (const key of Object.keys(item.fields)) {
        if (!fields.includes(String(key).split(".").pop())) continue;
        seen.push(`${slot}:${key}=${item.fields[key]}`);
      }
    });
    const thread = this.jvm.threads?.[this.jvm.currentThreadIndex];
    const depth = thread?.callStack?.items?.length;
    const sameMethod = (thread?.callStack?.items || [])
      .filter((item) => item && item.method === method).length;
    const stackShape = (thread?.callStack?.items || []).map((item, index) => {
      const owned = item?.className || item?.method?.className || "?";
      return `${index}:${owned}.${item?.method?.name || "?"}@${item?.pc}`
        + (item === frame ? "*" : "");
    }).join(" ");
    console.error(`[generated-frame] ${owner}.${method.name}`
      + `${method.descriptor || ""} pc=${frame.pc} thread=${thread?.id}`
      + `/${thread?.name || "?"} depth=${depth} activations=${sameMethod} `
      + seen.join(" ") + ` || ${stackShape}`);
  }

  continueStructuredQuantum(thread) {
    const jvm = this.jvm;
    if (!jvm || !thread || thread.status !== "runnable") return false;
    const debug = jvm.debugManager;
    if (debug && (debug.debugMode || debug.breakpoints.size > 0)) return false;
    if (jvm.clock && jvm.clock.enabled && !jvm.clock.realtime) return false;
    const wallNow = Date.now();
    if (!(wallNow < jvm._nextEventLoopYieldAt)) return false;
    const schedulerNow = jvm.clock ? jvm.clock.millis() : wallNow;
    const threads = jvm.threads || [];
    for (let index = 0; index < threads.length; index += 1) {
      const other = threads[index];
      if (other === thread) continue;
      if (other.status === "SLEEPING" && other.sleepUntil !== undefined &&
          schedulerNow >= Number(other.sleepUntil)) return false;
      if (other.status === "WAITING" && other.waitDeadline !== undefined &&
          schedulerNow >= Number(other.waitDeadline)) return false;
    }
    return true;
  }

  skipJitOnce(frame) {
    frame.jitSkipOnce = true;
  }

  target(frame, label) {
    const index = this.getLabelMap(frame).get(label);
    if (index === undefined) {
      throw new Error(`Label ${label} not found`);
    }
    return index;
  }

  compileMethod(method) {
    const tracePattern = typeof process !== "undefined" && process.env
      ? process.env.JVM_TRACE_JIT_METHOD || "" : "";
    const traceIdentity = tracePattern
      ? `${method?.className || this.jvm.findClassNameForMethod?.(method) ||
        "unknown"}.${method?.name || "unknown"}${method?.descriptor || ""}`
      : "";
    // A structured-only method was admitted specifically because only the
    // complete CFG can preserve an allocation/call continuation. Extracting a
    // smaller baseline loop first would discard that proof and then reject
    // the required whole-method entry below.
    // A method selected as a hot call-graph root must keep its complete CFG.
    // Extracting a baseline loop first makes `inlineLoopRegions.length` block
    // structured compilation below, so the graph tier is published only by a
    // later retry after the long-running invocation is already mid-frame.
    // Prefer the whole structured body at the initial entry; the selection is
    // derived solely from bytecode size, array density, dynamic calls, and a
    // backedge. Ordinary methods retain the smaller local-region policy.
    const wholeGraphCandidate = this.hotCallGraphRegions.enabled &&
      (this.isDynamicArrayStructuredFirstMethod(method) ||
        this.isCallGraphStructuredFirstMethod(method));
    const inlineLoopRegions = this.structuredOnlyCodegenMethods.has(method) ||
      wholeGraphCandidate
      ? [] : this.compileInlinePrimitiveLoopRegions(method);
    const structuredSsa = inlineLoopRegions.length
      ? null : this.structuredSsa.compile(method);
    if (structuredSsa) {
      if (tracePattern && traceIdentity.includes(tracePattern)) {
        const source = String(structuredSsa);
        console.error("[jit-tier-selection] " + JSON.stringify({
          method: traceIdentity,
          tier: "structured-ssa",
          directFusedSiteIds: [...source.matchAll(
            /tryInvokeDirectAt\((\d+)/g)].map((match) => Number(match[1])),
          continuation: Boolean(structuredSsa.jvmStructuredContinuation),
          resumeBody: Boolean(structuredSsa.jvmResumeBody),
        }));
        if (typeof process !== "undefined" && process.env &&
            process.env.JVM_TRACE_JIT_SOURCE === "1") {
          const structuredSource =
            structuredSsa.jvmStructuredSource || source;
          const aroundLine = Number(
            process.env.JVM_TRACE_JIT_SOURCE_AROUND_LINE || 0);
          const tracedSource = aroundLine > 0
            ? structuredSource.split("\n").slice(
              Math.max(0, aroundLine - 16), aroundLine + 15,
            ).map((line, offset) =>
              `${Math.max(1, aroundLine - 15) + offset}: ${line}`).join("\n")
            : structuredSource;
          console.error("[jit-generated-source] " + traceIdentity + "\n" +
            tracedSource);
        }
      }
      if (structuredSsa.jvmStructuredRequiresBaselineFramedEntry) {
        if (this.structuredOnlyCodegenMethods.has(method)) return null;
        const baseline = this.compileBaselineMethod(method, inlineLoopRegions);
        if (baseline) {
          return this.attachStructuredPositionalEntry(
            baseline, structuredSsa);
        }
      }
      return this.withResumeBody(structuredSsa, method);
    }
    if (tracePattern) {
      if (traceIdentity.includes(tracePattern)) {
        console.error("[jit-tier-rejection] " + JSON.stringify({
          method: traceIdentity,
          structuredSsa: this.structuredSsa.lastRejectionReason,
          structuredError: this.structuredSsa.lastCompileError &&
            String(this.structuredSsa.lastCompileError.message ||
              this.structuredSsa.lastCompileError),
        }));
      }
    }
    if (this.structuredOnlyCodegenMethods.has(method)) {
      // Admission of this method relied on the structured renderer's exact
      // allocation/call continuation semantics. Do not silently substitute a
      // baseline body whose constructor replay rules are less capable.
      return null;
    }
    const scalarLoop = this.compileScalarIntegerLoop(method);
    if (scalarLoop) return this.withResumeBody(scalarLoop, method);

    const stackless = this.compileStacklessIntegerRaster(method);
    if (stackless) return this.withResumeBody(stackless, method);

    return this.compileBaselineMethod(method, inlineLoopRegions);
  }

  attachStructuredPositionalEntry(baseline, structured) {
    if (!baseline || !structured?.jvmRestoringDirectPositionalBody) {
      return baseline;
    }
    baseline.jvmStructuredPositionalOnly = true;
    baseline.jvmRestoringDirectPositionalBody =
      structured.jvmRestoringDirectPositionalBody;
    baseline.jvmRestoringDirectPositionalSource =
      structured.jvmRestoringDirectPositionalSource;
    if (structured.jvmRestoringDirectPositionalPlan) {
      baseline.jvmRestoringDirectPositionalPlan =
        structured.jvmRestoringDirectPositionalPlan;
    }
    return baseline;
  }

  scheduleStructuredCacheUpgrade(method, cached) {
    if (this.structuredConstructorUpgradePending.has(method)) return;
    this.structuredConstructorUpgradePending.add(method);
    const upgrade = () => {
      this.structuredConstructorUpgradePending.delete(method);
      if (this.codegenCache.get(method) !== cached ||
          this.codegenCompiling.has(method)) return;
      this.codegenCompiling.add(method);
      try {
        const structured = this.structuredSsa.compile(method);
        this.lastStructuredConstructorUpgrade = {
          structured: Boolean(structured?.jvmStructuredSsa),
          direct: Boolean(structured?.jvmDirectPositionalBody),
          positional: Boolean(structured?.jvmRestoringDirectPositionalBody),
          requiresBaseline: Boolean(
            structured?.jvmStructuredRequiresBaselineFramedEntry),
          rejection: this.structuredSsa.lastRejectionReason || null,
          restoringRejection:
            structured?.jvmStructuredRestoringDirectRejection || null,
          astRejections:
            structured?.jvmStructuredPositionalAstRejections || [],
          error: this.structuredSsa.lastCompileError
            ? String(this.structuredSsa.lastCompileError.message ||
              this.structuredSsa.lastCompileError) : null,
        };
        const upgraded = structured?.jvmStructuredRequiresBaselineFramedEntry
          ? this.structuredOnlyCodegenMethods.has(method) ||
              !structured.jvmStructuredContinuation
            ? null
            : this.attachStructuredPositionalEntry(cached, structured)
          : structured ? this.withResumeBody(structured, method) : null;
        if (upgraded?.jvmStructuredSsa ||
            upgraded?.jvmRestoringDirectPositionalBody) {
          this.codegenCache.set(method, upgraded);
          this.publishGeneratedTargetUpgrade(method, upgraded);
          this.structuredConstructorRetryState.delete(method);
          this.structuredConstructorUpgradeCount += 1;
        }
      } catch (error) {
        this.codegenCompileErrors.set(method, error);
      } finally {
        this.codegenCompiling.delete(method);
      }
    };
    if (typeof setTimeout === "function") setTimeout(upgrade, 0);
    else if (typeof queueMicrotask === "function") queueMicrotask(upgrade);
    else Promise.resolve().then(upgrade);
  }

  trackGeneratedTarget(method, target, site) {
    if (!method || !target || !site) return;
    let entries = this.generatedTargetsByMethod.get(method);
    if (!entries) {
      entries = new Set();
      this.generatedTargetsByMethod.set(method, entries);
    }
    entries.add({ target, site });
  }

  publishGeneratedTargetUpgrade(method, generated, options = {}) {
    const stableEntry = this.stableGeneratedEntries.get(method);
    if (stableEntry && generated) stableEntry.generated = generated;
    if (generated && !options.regionEntryOnly) {
      this.hotCallGraphRegions?.markGeneratedTargetUpgrade(method);
    }
    const entries = this.generatedTargetsByMethod.get(method);
    if (!entries || !generated) return;
    for (const entry of entries) {
      const { target, site } = entry;
      target.generated = generated;
      target.positionalInvoker = undefined;
      target.preferFrameless = false;
      target.framelessRejected = false;
      target.framelessBudgetYields = 0;
      target.framelessWarmCompletions = 0;
      const positional = this.getPositionalGeneratedInvoker(site, target);
      const ownsStatic = site.fastStaticTarget === target;
      const ownsSpecial = site.fastSpecialTarget === target;
      const ownsDynamic = site.fastDynamicTarget?.target === target;
      if (ownsDynamic) site.fastDynamicTarget.positional = positional;
      if (target.targetClassName && site.fastPositionalTargets) {
        if (positional) {
          site.fastPositionalTargets[target.targetClassName] = {
            invoke: positional,
            rawInvoke: positional.jvmRawInvoke || null,
            lookupClass: target.lookupClass,
            receiverType: target.targetClassName,
            debugGuarded: positional.jvmDebugGuarded === true,
          };
        } else {
          delete site.fastPositionalTargets[target.targetClassName];
        }
      }
      if (ownsStatic || ownsSpecial || ownsDynamic) {
        site.fastPositional = positional ? {
          invoke: positional,
          rawInvoke: positional.jvmRawInvoke || null,
          lookupClass: target.lookupClass,
          receiverType: ownsDynamic
            ? site.fastDynamicTarget.targetClassName : null,
          debugGuarded: positional.jvmDebugGuarded === true,
        } : null;
      }
      this.generatedTargetUpgradePublicationCount += 1;
    }
  }

  compileInlinePrimitiveLoopRegions(method) {
    if (this.inlineLoopRegionCache.has(method)) {
      return this.inlineLoopRegionCache.get(method);
    }
    const none = [];
    this.inlineLoopRegionCache.set(method, none);
    if (method.name === "<init>" || method.name === "<clinit>" ||
        !this.inlineLoopRegionsEnabled || !this.structuredSsa.enabled ||
        !this.canCompileSynchronously(method)) {
      return none;
    }
    const code = method.attributes.find((attribute) => attribute.type === "code");
    const items = this.getCodeItems(method);
    if (!code || items.length < 24) return none;
    const exceptionTable = code.code.exceptionTable || [];
    const hasOuterEffects = exceptionTable.length > 0 || items.some((item) => {
      const op = getOp(item?.instruction);
      return op?.startsWith("invoke") || op === "new" ||
        op === "newarray" || op === "anewarray" ||
        op === "multianewarray" || op === "monitorenter";
    });
    const hasMonitorRegion = items.some((item) =>
      getOp(item?.instruction) === "monitorenter");
    // Complete leaf kernels already receive better whole-method structured
    // code. Region extraction is for a small scalar/array loop embedded in a
    // larger scheduler-, exception-, allocation-, or call-bearing method.
    if (!hasOuterEffects) return none;

    const labels = buildLabelMap(items);
    // Some large obfuscated methods have verifier-consistent normal flow but
    // deliberately awkward, disconnected exception-table joins that defeat
    // this inexpensive whole-method depth pass. Existing array-length regions
    // still require that proof. A scalar natural-loop candidate can instead
    // be verified in its isolated synthetic method after handlers and
    // unreachable outer blocks have been removed.
    const computedDepths = this.computeStackDepths(items, labels, method);
    const depths = computedDepths || [];
    const localSlot = (instruction, op) => {
      const shorthand = /_(\d)$/.exec(op);
      return shorthand ? Number(shorthand[1])
        : Number(instruction?.varnum ?? instruction?.arg);
    };
    const allowed = new Set([
      "nop",
      "aload", "aload_0", "aload_1", "aload_2", "aload_3",
      "iload", "iload_0", "iload_1", "iload_2", "iload_3",
      "istore", "istore_0", "istore_1", "istore_2", "istore_3",
      "iconst_m1", "iconst_0", "iconst_1", "iconst_2", "iconst_3",
      "iconst_4", "iconst_5", "bipush", "sipush",
      "iadd", "isub", "imul", "iand", "ior", "ixor",
      "ishl", "ishr", "iushr", "ineg", "i2b", "i2c", "i2s", "iinc",
      "arraylength", "iaload", "baload", "caload", "saload",
      "iastore", "bastore", "castore", "sastore",
      "goto", "goto_w",
      "ifeq", "ifne", "iflt", "ifle", "ifgt", "ifge",
      "if_icmpeq", "if_icmpne", "if_icmplt", "if_icmple",
      "if_icmpgt", "if_icmpge",
    ]);
    const plans = [];
    for (let backedge = 0; backedge < items.length; backedge += 1) {
      const branch = items[backedge]?.instruction;
      const branchOp = getOp(branch);
      if (branchOp !== "goto" && branchOp !== "goto_w") continue;
      const header = labels.get(branch.arg);
      if (!Number.isInteger(header) || header <= 0 || header >= backedge ||
          depths[header] !== 0) continue;
      const headerOps = items.slice(header, header + 4)
        .map((item) => getOp(item?.instruction));
      if (!/^iload(?:_[0-3])?$/.test(headerOps[0] || "") ||
          !/^aload(?:_[0-3])?$/.test(headerOps[1] || "") ||
          headerOps[2] !== "arraylength" ||
          headerOps[3] !== "if_icmpge") continue;
      const exit = labels.get(items[header + 3].instruction.arg);
      if (!Number.isInteger(exit) || exit <= backedge || exit >= items.length ||
          depths[exit] !== 0) continue;
      const counterSlot = localSlot(items[header].instruction, headerOps[0]);
      const boundArraySlot = localSlot(items[header + 1].instruction, headerOps[1]);
      if (!Number.isInteger(counterSlot) || !Number.isInteger(boundArraySlot)) continue;

      let valid = true;
      let counterWrites = 0;
      const arrayLocalSlots = new Set();
      for (let index = header; index <= backedge && valid; index += 1) {
        const instruction = items[index]?.instruction;
        const op = getOp(instruction);
        if (!allowed.has(op)) { valid = false; break; }
        if (/^aload(?:_[0-3])?$/.test(op)) {
          arrayLocalSlots.add(localSlot(instruction, op));
        }
        if (op === "iinc" &&
            localSlot(instruction, op) === counterSlot) counterWrites += 1;
        if (op === "goto" || op === "goto_w" || op.startsWith("if")) {
          const target = labels.get(instruction.arg);
          if (!Number.isInteger(target) ||
              target !== exit && (target < header || target > backedge)) {
            valid = false;
          }
        }
      }
      if (!valid || counterWrites !== 1) continue;

      const loopOps = items.slice(header, backedge + 1)
        .map((item) => getOp(item?.instruction));
      const pairedPcmOps = [
        "iload", "aload", "arraylength", "if_icmpge",
        "aload", "iload", "iaload", "bipush", "ishr", "istore",
        "iload", "sipush", "if_icmpge", "sipush", "istore",
        "iload", "sipush", "if_icmple", "sipush", "istore",
        "iload", "iconst_2", "imul", "istore",
        "aload", "iload", "iload", "i2b", "bastore",
        "aload", "iload", "iconst_1", "iadd", "iload", "bipush",
        "ishr", "i2b", "bastore",
        "iload", "bipush", "imul", "aload", "iload", "baload",
        "iadd", "istore",
        "iload", "bipush", "imul", "aload", "iload", "iconst_1",
        "iadd", "baload", "iadd", "istore",
        "iinc", "goto",
      ];
      const pairedShape = loopOps.length === pairedPcmOps.length &&
        loopOps.every((op, index) => op === pairedPcmOps[index]);
      const at = (offset) => items[header + offset].instruction;
      const pairedConstants = pairedShape &&
        Number(at(7).arg) === 8 &&
        Number(at(11).arg) === -32768 &&
        Number(at(13).arg) === -32768 &&
        Number(at(16).arg) === 32767 &&
        Number(at(18).arg) === 32767 &&
        Number(at(34).arg) === 8 &&
        Number(at(39).arg) === 31 &&
        Number(at(47).arg) === 31 &&
        labels.get(at(12).arg) === header + 15 &&
        labels.get(at(17).arg) === header + 20;
      if (this.guestKernelOraclesEnabled && pairedConstants) {
        const inputSlot = localSlot(at(4), loopOps[4]);
        const sampleSlot = localSlot(at(9), loopOps[9]);
        const offsetSlot = localSlot(at(23), loopOps[23]);
        const outputSlot = localSlot(at(24), loopOps[24]);
        const hashSlot = localSlot(at(38), loopOps[38]);
        const slotChecks = [
          localSlot(at(5), loopOps[5]) === counterSlot,
          localSlot(at(10), loopOps[10]) === sampleSlot,
          localSlot(at(14), loopOps[14]) === sampleSlot,
          localSlot(at(15), loopOps[15]) === sampleSlot,
          localSlot(at(19), loopOps[19]) === sampleSlot,
          localSlot(at(20), loopOps[20]) === counterSlot,
          localSlot(at(25), loopOps[25]) === offsetSlot,
          localSlot(at(26), loopOps[26]) === sampleSlot,
          localSlot(at(29), loopOps[29]) === outputSlot,
          localSlot(at(30), loopOps[30]) === offsetSlot,
          localSlot(at(33), loopOps[33]) === sampleSlot,
          localSlot(at(38), loopOps[38]) === hashSlot,
          localSlot(at(41), loopOps[41]) === outputSlot,
          localSlot(at(42), loopOps[42]) === offsetSlot,
          localSlot(at(45), loopOps[45]) === hashSlot,
          localSlot(at(46), loopOps[46]) === hashSlot,
          localSlot(at(49), loopOps[49]) === outputSlot,
          localSlot(at(50), loopOps[50]) === offsetSlot,
          localSlot(at(55), loopOps[55]) === hashSlot,
        ];
        if (inputSlot === boundArraySlot && slotChecks.every(Boolean)) {
          const id = this.inlineLoopRegions.length;
          const kernel = {
            kind: "paired-saturating-int-to-bytes",
            inputSlot, outputSlot, counterSlot,
            sampleSlot, offsetSlot, hashSlot,
          };
          this.inlineLoopRegions.push({
            method, header, exit, counterSlot, boundArraySlot, kernel,
          });
          plans.push({
            id, header, exit, counterSlot, boundArraySlot, kernel: kernel.kind,
          });
          break;
        }
      }

      const syntheticItems = items.slice(0, exit + 1).map((item, index) => ({
        ...item,
        instruction: index < header ? "nop"
          : index === exit ? "return" : item.instruction,
      }));
      syntheticItems[0] = {
        ...syntheticItems[0],
        instruction: { op: "goto", arg: items[header].labelDef.slice(0, -1) },
      };
      const syntheticMethod = {
        ...method,
        name: `${method.name}$inlineLoop${header}`,
        descriptor: "()V",
        flags: ["private", "static"],
        accessFlags: 0x000a,
        attributes: [{
          ...code,
          code: {
            ...code.code,
            codeItems: syntheticItems,
            exceptionTable: [],
            attributes: [],
          },
        }],
        jvmStructuredAtomicRegionMaxIterations: 4096,
        jvmStructuredRegionSpillOnReturn: true,
        jvmStructuredEntryArrayLocals: [...arrayLocalSlots],
      };
      this.normalizedCodeItemsCache.set(syntheticMethod, syntheticItems);
      const generated = this.structuredSsa.compile(syntheticMethod);
      if (!generated || generated.jvmStructuredContinuation) continue;
      const id = this.inlineLoopRegions.length;
      this.inlineLoopRegions.push({
        generated, method, header, exit, counterSlot, boundArraySlot,
      });
      plans.push({ id, header, exit, counterSlot, boundArraySlot });
      // Do not create overlapping region entries. A later implementation may
      // admit multiple disjoint loops after proving their live ranges.
      break;
    }
    // A javac loop embedded in archive/image readers is often bounded by a
    // scalar chunk length rather than array.length, and obfuscation may place
    // its backedge on a conditional branch followed by one shared exit
    // trampoline. Extract that natural loop with the same SSA renderer. This
    // is a CFG/local/bytecode proof: no owner, member, or descriptor identity
    // participates.
    if (!plans.length && !computedDepths && hasMonitorRegion &&
        this.scalarBoundedInlineRegionsEnabled) {
      const scalarRegionAllowed = new Set([
        ...allowed,
        "getstatic",
      ]);
      for (let backedge = 0; backedge < items.length; backedge += 1) {
        const branch = items[backedge]?.instruction;
        const branchOp = getOp(branch);
        if (!branchOp?.startsWith("if")) continue;
        const header = labels.get(branch.arg);
        if (!Number.isInteger(header) || header <= 0 ||
            header >= backedge ||
            computedDepths && depths[header] !== 0) continue;

        const headerOps = items.slice(header, header + 3)
          .map((item) => getOp(item?.instruction));
        if (!/^iload(?:_[0-3])?$/.test(headerOps[0] || "") ||
            !/^iload(?:_[0-3])?$/.test(headerOps[1] || "") ||
            headerOps[2] !== "if_icmpgt") continue;
        const boundSlot = localSlot(items[header].instruction, headerOps[0]);
        const counterSlot =
          localSlot(items[header + 1].instruction, headerOps[1]);
        const bodyTarget = labels.get(items[header + 2].instruction.arg);
        if (!Number.isInteger(boundSlot) || !Number.isInteger(counterSlot) ||
            boundSlot === counterSlot ||
            !Number.isInteger(bodyTarget) ||
            bodyTarget <= header + 2 || bodyTarget > backedge) continue;

        // Include the common conditional-backedge fall trampoline when it is
        // a single goto. All exits from the candidate must converge on the
        // same original bytecode PC so the canonical Frame has one precise
        // resume location after the atomic region returns.
        let end = backedge;
        const fallInstruction = items[backedge + 1]?.instruction;
        if (getOp(fallInstruction) === "goto" ||
            getOp(fallInstruction) === "goto_w") end += 1;
        const outsideTargets = new Set();
        let valid = true;
        let counterWrites = 0;
        let primitiveArrayTraffic = 0;
        const arrayLocalSlots = new Set();
        for (let index = header; index <= end && valid; index += 1) {
          const instruction = items[index]?.instruction;
          const op = getOp(instruction);
          if (!scalarRegionAllowed.has(op)) {
            valid = false;
            break;
          }
          if (/^aload(?:_[0-3])?$/.test(op)) {
            arrayLocalSlots.add(localSlot(instruction, op));
          }
          if (op === "iinc") {
            const slot = localSlot(instruction, op);
            if (slot === boundSlot) {
              valid = false;
              break;
            }
            if (slot === counterSlot) {
              if (Number(instruction.incr) !== 1) {
                valid = false;
                break;
              }
              counterWrites += 1;
            }
          } else if (/^istore(?:_[0-3])?$/.test(op) &&
              localSlot(instruction, op) === boundSlot) {
            valid = false;
            break;
          }
          if (op?.endsWith("aload") || op?.endsWith("astore")) {
            primitiveArrayTraffic += 1;
          }
          if (op === "goto" || op === "goto_w" || op.startsWith("if")) {
            const target = labels.get(instruction.arg);
            if (!Number.isInteger(target)) {
              valid = false;
              break;
            }
            if (target < header || target > end) outsideTargets.add(target);
          }
        }
        if (!valid || counterWrites !== 1 || primitiveArrayTraffic === 0 ||
            outsideTargets.size !== 1) continue;
        const exit = [...outsideTargets][0];
        if (computedDepths && depths[exit] !== 0) continue;

        // Preserve labels/PCs from the original method but make every block
        // outside the natural loop unreachable. The one converged exit is a
        // synthetic void return that spills live locals for the original
        // baseline body to resume at `exit`.
        const syntheticItems = items.map((item, index) => ({
          ...item,
          instruction: index >= header && index <= end
            ? item.instruction : index === exit ? "return" : "nop",
        }));
        syntheticItems[0] = {
          ...syntheticItems[0],
          instruction: {
            op: "goto",
            arg: items[header].labelDef.slice(0, -1),
          },
        };
        const syntheticMethod = {
          ...method,
          name: `${method.name}$inlineScalarLoop${header}`,
          descriptor: "()V",
          flags: ["private", "static"],
          accessFlags: 0x000a,
          attributes: [{
            ...code,
            code: {
              ...code.code,
              codeItems: syntheticItems,
              exceptionTable: [],
              attributes: [],
            },
          }],
          jvmStructuredAtomicRegionMaxIterations: 4096,
          jvmStructuredRegionSpillOnReturn: true,
          jvmStructuredEntryArrayLocals: [...arrayLocalSlots],
        };
        this.normalizedCodeItemsCache.set(syntheticMethod, syntheticItems);
        const generated = this.structuredSsa.compile(syntheticMethod);
        if (!generated || generated.jvmStructuredContinuation) continue;
        const id = this.inlineLoopRegions.length;
        this.inlineLoopRegions.push({
          generated, method, header, exit, counterSlot, boundSlot,
          scalarBounded: true, maximumIterations: 4096,
        });
        plans.push({
          id, header, exit, counterSlot, boundSlot,
          scalarBounded: true,
        });
        break;
      }
    }
    this.inlineLoopRegionCache.set(method, plans);
    if (plans.length) {
      this.inlineLoopRegionPcCache.set(method,
        new Map(plans.map((plan) => [plan.header, plan])));
    }
    return plans;
  }

  runInlineLoopRegion(id, frame, thread) {
    const region = this.inlineLoopRegions[id];
    if (!region) return null;
    this.inlineLoopRegionRunCount += 1;
    if (region.kernel?.kind === "paired-saturating-int-to-bytes") {
      const locals = frame.locals;
      const input = this.arrayData(locals[region.kernel.inputSlot]);
      const output = this.arrayData(locals[region.kernel.outputSlot]);
      let counter = Number(locals[region.kernel.counterSlot] || 0) | 0;
      let hash = Number(locals[region.kernel.hashSlot] || 0) | 0;
      let sample = Number(locals[region.kernel.sampleSlot] || 0) | 0;
      let offset = Number(locals[region.kernel.offsetSlot] || 0) | 0;
      for (; counter < input.length; counter += 1) {
        sample = input[counter] >> 8;
        if (sample < -32768) sample = -32768;
        if (sample > 32767) sample = 32767;
        offset = counter * 2;
        const low = (sample << 24) >> 24;
        const high = ((sample >> 8) << 24) >> 24;
        output[offset] = low;
        output[offset + 1] = high;
        hash = (Math.imul(hash, 31) + low) | 0;
        hash = (Math.imul(hash, 31) + high) | 0;
      }
      locals[region.kernel.counterSlot] = counter;
      locals[region.kernel.sampleSlot] = sample;
      locals[region.kernel.offsetSlot] = offset;
      locals[region.kernel.hashSlot] = hash;
      return RETURN_VOID;
    }
    return region.generated(frame, thread, this, false, true);
  }

  canRunInlineLoopRegion(id, frame) {
    const region = this.inlineLoopRegions[id];
    if (!region) return false;
    if (region.scalarBounded) {
      const counter = Number(frame.locals[region.counterSlot]);
      const bound = Number(frame.locals[region.boundSlot]);
      const remaining = bound - counter;
      return Number.isInteger(counter) && Number.isInteger(bound) &&
        remaining >= 0 && remaining <= region.maximumIterations;
    }
    if (region.kernel?.kind !== "paired-saturating-int-to-bytes") return true;
    const locals = frame.locals;
    const inputRef = locals[region.kernel.inputSlot];
    const outputRef = locals[region.kernel.outputSlot];
    const input = this.arrayData(inputRef);
    const output = this.arrayData(outputRef);
    const counter = Number(locals[region.kernel.counterSlot] || 0) | 0;
    return input !== null && output !== null && counter >= 0 &&
      input.length - counter <= 4096 &&
      output.length >= input.length * 2;
  }

  tryRunInlineLoopRegionOsr(frame, thread) {
    if (!frame || !frame.method || !frame.instructions ||
        frame.jitSkipOnce || this.runningFrames.has(frame) ||
        this._envInstrumented || thread?.status !== "runnable") return false;
    let regionsByPc = this.inlineLoopRegionPcCache.get(frame.method);
    if (!regionsByPc) {
      this.compileInlinePrimitiveLoopRegions(frame.method);
      regionsByPc = this.inlineLoopRegionPcCache.get(frame.method);
    }
    if (!regionsByPc || frame.stack.size() !== 0) return false;
    const region = regionsByPc.get(frame.pc);
    if (!region || !this.canRunInlineLoopRegion(region.id, frame)) return false;
    const debug = this.jvm.debugManager;
    if (debug && (debug.debugMode || debug.breakpoints.size > 0 ||
        debug.isClassJitDeopted(this.getFrameClassName(frame)))) return false;
    const result = this.runInlineLoopRegion(region.id, frame, thread);
    if ((result && typeof result.then === "function") ||
        (result && result.deopt)) return false;
    frame.stack.items.length = 0;
    frame.pc = region.exit;
    this.inlineLoopRegionOsrCount += 1;
    return true;
  }

  // Fast tiers enter only at PC 0 (or block leaders). Without a resumable
  // companion, a frame that exits mid-method (safe point, transient deopt)
  // finishes its invocation one interpreted bytecode per scheduler tick. The
  // baseline generated body can resume at any PC, so entry dispatches on the
  // frame PC instead of deoptimizing.
  withResumeBody(fast, method) {
    let resume = null;
    try {
      // Structured SSA exits only at verified loop headers.  Its scalar-loop
      // sibling accepts those exact leaders and retains scalar locals across
      // the remaining control flow, avoiding a return to per-bytecode generic
      // dispatch after a cooperative scheduler safe point.
      resume = fast.jvmStructuredSsa && this.scalarLoopsEnabled
        ? this.compileScalarIntegerLoop(method) : null;
      if (!resume) resume = this.compileBaselineMethod(method);
    } catch (_) { resume = null; }
    if (!resume || resume.jvmSynchronous !== true) return fast;
    const hasStructuredContinuation = fast.jvmHasStructuredContinuation;
    const dispatcher = typeof hasStructuredContinuation === "function"
      ? function (
        frame, thread, helpers, initialBytecodeChecks, framelessEntry,
      ) {
        return frame.pc === 0 || hasStructuredContinuation(frame)
          ? fast(frame, thread, helpers, initialBytecodeChecks, framelessEntry)
          : resume(frame, thread, helpers, initialBytecodeChecks);
      }
      : function (
        frame, thread, helpers, initialBytecodeChecks, framelessEntry,
      ) {
        return frame.pc === 0
          ? fast(frame, thread, helpers, initialBytecodeChecks, framelessEntry)
          : resume(frame, thread, helpers, initialBytecodeChecks);
      };
    for (const key of Object.keys(fast)) dispatcher[key] = fast[key];
    dispatcher.jvmSynchronous = true;
    dispatcher.jvmResumeBody = true;
    dispatcher.jvmScalarResumeBody = resume.jvmScalarLoop === true;
    dispatcher.jvmFastBody = fast;
    dispatcher.jvmResumeBodyFn = resume;
    // Source inspection (diagnostics, tests) should see the fast tier's body.
    dispatcher.toString = () => fast.toString();
    return dispatcher;
  }

  compileScalarIntegerLoop(method) {
    if (!this.scalarLoopsEnabled || !this.canCompileSynchronously(method) ||
        !this.hasBackwardBranch(method)) {
      return null;
    }
    const code = method.attributes.find((attr) => attr.type === "code");
    if (!code) return null;
    const codeItems = this.getCodeItems(method);
    if ((code.code.exceptionTable || []).length &&
        !this.hasOnlyNoOpExceptionHandlers(method, codeItems)) return null;
    if (codeItems.length < 6 || codeItems.length > 1024) return null;
    const labels = buildLabelMap(codeItems);
    const depths = this.computeStackDepths(codeItems, labels, method);
    if (!depths) return null;
    const reachable = new Set(depths.map((depth, index) => depth === undefined ? -1 : index)
      .filter((index) => index >= 0));

    const localIndex = (instruction, op) => {
      if (instruction && typeof instruction === "object" && instruction.arg !== undefined) {
        return Number(instruction.arg);
      }
      const match = /_([0-3])$/.exec(op || "");
      return match ? Number(match[1]) : NaN;
    };
    const inlinePlans = new Map();
    const callSites = new Map();
    const fieldSites = new Map();
    const supported = codeItems.every((item, index) => {
      if (!reachable.has(index)) return true;
      const instruction = item && item.instruction;
      const op = getOp(instruction);
      if (op === "ldc" || op === "ldc_w") return typeof instruction.arg === "number";
      if (!op || op === "nop" || op === "goto" || op === "return" ||
          op === "ireturn" || op === "athrow" || op === "iinc" || op === "dup" ||
          op === "pop" || op === "aconst_null" || op === "arraylength" ||
          op === "newarray" || op === "checkcast" ||
          /^[ai]load(?:_[0-3])?$/.test(op) || /^[ai]store(?:_[0-3])?$/.test(op) ||
          /^iconst_(?:m1|[0-5])$/.test(op) || op === "bipush" || op === "sipush" ||
          ["iadd", "isub", "imul", "idiv", "irem", "iand", "ior", "ixor",
            "ishl", "ishr", "iushr", "ineg", "i2b"].includes(op) ||
          ["iaload", "saload", "aaload", "iastore"].includes(op) ||
          ["ifeq", "ifne", "iflt", "ifge", "ifgt", "ifle",
            "if_icmpeq", "if_icmpne", "if_icmplt", "if_icmpge",
            "if_icmpgt", "if_icmple", "if_acmpeq", "if_acmpne",
            "ifnull", "ifnonnull"].includes(op)) {
        return true;
      }
      if (op === "getfield" || op === "getstatic" || op === "putstatic") {
        fieldSites.set(index, this.registerFieldSite(instruction.arg));
        return true;
      }
      if (op === "invokestatic" && instruction && Array.isArray(instruction.arg) &&
          Array.isArray(instruction.arg[2])) {
        const plan = this.getCompileTimeIntegerLeaf(instruction);
        if (plan) inlinePlans.set(index, plan);
        else callSites.set(index, {
          id: this.registerSyncCallSite(op, instruction, method, index),
          op,
          ...parseDescriptor(instruction.arg[2][1]),
        });
        return true;
      }
      return false;
    });
    if (!supported) return null;
    const expandedGuestBody = (code.code.exceptionTable || []).length > 0 ||
      callSites.size > 0 || fieldSites.size > 0 || codeItems.some((item, index) => {
        if (!reachable.has(index)) return false;
        const op = getOp(item && item.instruction);
        return op && (/^a(?:load|store)(?:_[0-3])?$/.test(op) ||
          ["aconst_null", "arraylength", "newarray", "checkcast",
            "iaload", "saload", "aaload", "iastore",
            "if_acmpeq", "if_acmpne", "ifnull", "ifnonnull"].includes(op));
      });
    if (expandedGuestBody && !this.scalarGuestBodiesEnabled) return null;
    // Per-method profiling must retain observable callee entries. Pure loops
    // still use the scalar tier; loops with omitted static frames keep the
    // normal generated call path while profiling is active.
    if (this.profileMethods && inlinePlans.size) return null;

    const usedLocals = new Set();
    const referenceLocals = new Set();
    for (let itemIndex = 0; itemIndex < codeItems.length; itemIndex += 1) {
      if (!reachable.has(itemIndex)) continue;
      const item = codeItems[itemIndex];
      const instruction = item && item.instruction;
      const op = getOp(instruction);
      if (/^[ai]load(?:_[0-3])?$/.test(op) || /^[ai]store(?:_[0-3])?$/.test(op)) {
        const index = localIndex(instruction, op);
        if (!Number.isSafeInteger(index) || index < 0) return null;
        usedLocals.add(index);
        if (op[0] === "a") referenceLocals.add(index);
      } else if (op === "iinc") {
        const index = Number(instruction.varnum ?? instruction.arg);
        if (!Number.isSafeInteger(index) || index < 0) return null;
        usedLocals.add(index);
      }
    }

    const terminal = new Set(["athrow", "ireturn", "return"]);
    const leaders = new Set([0]);
    for (let index = 0; index < codeItems.length; index += 1) {
      if (!reachable.has(index)) continue;
      const instruction = codeItems[index] && codeItems[index].instruction;
      const op = getOp(instruction);
      if (op === "goto" || op && op.startsWith("if")) {
        const target = branchTargetIndex(instruction, labels);
        if (target === undefined) return null;
        leaders.add(target);
        if (index + 1 < codeItems.length) leaders.add(index + 1);
      } else if (callSites.has(index)) {
        leaders.add(index);
        if (index + 1 < codeItems.length) leaders.add(index + 1);
      } else if (terminal.has(op) && index + 1 < codeItems.length) {
        leaders.add(index + 1);
      }
    }
    const orderedLeaders = [...leaders].filter((index) => reachable.has(index))
      .sort((a, b) => a - b);
    const maxStackDepth = depths.reduce((maximum, depth) =>
      depth === undefined ? maximum : Math.max(maximum, depth), 0);
    const nextLeader = new Map();
    orderedLeaders.forEach((leader, position) => {
      nextLeader.set(leader, orderedLeaders[position + 1] ?? codeItems.length);
    });

    let temporary = 0;
    const temp = () => `scalarValue${temporary++}`;
    const ssaOptimizations = this.scalarSsaOptimizationsEnabled;
    let arrayViewCount = 0;
    let eliminatedReadCount = 0;
    let threadedEdgeCount = 0;
    const body = [
      '"use strict";',
      "const locals = frame.locals;",
      "const stack = frame.stack.items;",
      "let pc = frame.pc;",
      "let backedgesUntilSafePoint = 10000;",
      ...[...usedLocals].sort((a, b) => a - b)
        .map((index) => `let local${index} = locals[${index}];`),
      ...(ssaOptimizations ? [...referenceLocals].sort((a, b) => a - b)
        .map((index) => `let local${index}ArrayData = helpers.arrayData(local${index});`) : []),
      ...Array.from({ length: maxStackDepth }, (_unused, index) =>
        `let scalarJoin${index} = stack[${index}];`),
      ...(ssaOptimizations ? Array.from({ length: maxStackDepth }, (_unused, index) =>
        `let scalarJoin${index}ArrayData = helpers.arrayData(stack[${index}]);`) : []),
      "if ((initialBytecodeChecks === undefined ? helpers.needsBytecodeChecks() : initialBytecodeChecks)) return { deopt: true, transient: true, reason: 'scalar loop debug entry' };",
      "helpers.scalarLoopRunCount += 1;",
      ...(ssaOptimizations ? ["helpers.scalarSsaRunCount += 1;"] : []),
      "while (true) {",
      "switch (pc) {",
    ];
    const spillLocals = () => [...usedLocals].sort((a, b) => a - b)
      .map((index) => `locals[${index}] = local${index};`);
    const saveStack = (expressions) => [
      ...expressions.map((expression, index) => `stack[${index}] = ${expression};`),
      `stack.length = ${expressions.length};`,
    ];
    let activeArrayViews = null;
    const saveJoin = (expressions) => expressions.flatMap((expression, index) => {
      const lines = [`scalarJoin${index} = ${expression};`];
      if (ssaOptimizations) {
        lines.push(`scalarJoin${index}ArrayData = ${activeArrayViews?.get(expression) || "null"};`);
      }
      return lines;
    });
    const materialize = (expressions, pc) => [
      ...spillLocals(), ...saveStack(expressions),
      `helpers.materialize(frame, locals, stack, ${pc});`,
    ];
    const transfer = (expressions, target, source) => {
      const lines = [];
      if (target <= source) {
        lines.push("if (--backedgesUntilSafePoint === 0) {");
        lines.push("if (helpers.continueQuantum(thread)) { backedgesUntilSafePoint = 10000; } else {");
        lines.push(...materialize(expressions, target));
        lines.push("helpers.scalarLoopSafePointCount += 1;");
        lines.push("helpers.skipJitOnce(frame);");
        lines.push("return { deopt: true, transient: true, reason: 'scalar loop backedge safe point' };", "}", "}");
      }
      lines.push(...saveJoin(expressions), `pc = ${target};`, "continue;");
      return lines;
    };

    for (const leader of orderedLeaders) {
      const entryDepth = depths[leader];
      if (entryDepth === undefined) continue;
      body.push(`case ${leader}: {`);
      const expressions = [];
      const arrayViews = new Map();
      const valueIdentities = new Map();
      const localVersions = new Map();
      const fieldValues = new Map();
      const arrayLengths = new Map();
      activeArrayViews = arrayViews;
      for (let index = 0; index < entryDepth; index += 1) {
        const value = temp();
        body.push(`const ${value} = scalarJoin${index};`);
        expressions.push(value);
        if (ssaOptimizations) {
          arrayViews.set(value, `scalarJoin${index}ArrayData`);
          valueIdentities.set(value, `join:${index}`);
        }
      }
      const pop = () => expressions.length ? expressions.pop() : null;
      const binary = (format) => {
        const right = pop();
        const left = pop();
        if (left === null || right === null) return false;
        expressions.push(format(left, right));
        return true;
      };
      let terminated = false;
      const end = nextLeader.get(leader);
      for (let index = leader; index < end; index += 1) {
        const instruction = codeItems[index] && codeItems[index].instruction;
        const op = getOp(instruction);
        if (!op || op === "nop") continue;
        let valid = true;
        if (/^[ai]load(?:_[0-3])?$/.test(op)) {
          // A JVM load snapshots the local at this bytecode. A later iinc or
          // store must not change an operand that is already on the stack.
          const value = temp();
          const variable = localIndex(instruction, op);
          body.push(`const ${value} = local${variable};`);
          expressions.push(value);
          if (ssaOptimizations && op[0] === "a") {
            arrayViews.set(value, `local${variable}ArrayData`);
            valueIdentities.set(value, `local:${variable}:${localVersions.get(variable) || 0}`);
          }
        } else if (/^[ai]store(?:_[0-3])?$/.test(op)) {
          const value = pop();
          if (value === null) valid = false;
          else {
            const variable = localIndex(instruction, op);
            body.push(`local${variable} = ${value};`);
            if (ssaOptimizations && op[0] === "a") {
              body.push(`local${variable}ArrayData = ${arrayViews.get(value) || `helpers.arrayData(${value})`};`);
              localVersions.set(variable, (localVersions.get(variable) || 0) + 1);
            }
          }
        } else if (op === "aconst_null") {
          expressions.push("null");
        } else if (/^iconst_(?:m1|[0-5])$/.test(op)) {
          expressions.push(op === "iconst_m1" ? "-1" : op.slice(-1));
        } else if (op === "bipush" || op === "sipush") {
          expressions.push(String(Number(instruction.arg) | 0));
        } else if (op === "ldc" || op === "ldc_w") {
          expressions.push(String(Number(instruction.arg) | 0));
        } else if (op === "dup") {
          const value = pop();
          if (value === null) valid = false;
          else {
            const duplicate = temp();
            body.push(`const ${duplicate} = ${value};`);
            expressions.push(duplicate, duplicate);
            if (ssaOptimizations && arrayViews.has(value)) {
              arrayViews.set(duplicate, arrayViews.get(value));
            }
            if (ssaOptimizations && valueIdentities.has(value)) {
              valueIdentities.set(duplicate, valueIdentities.get(value));
            }
          }
        } else if (op === "pop") {
          if (pop() === null) valid = false;
        } else if (op === "iadd") valid = binary((a, b) => `((${a} + ${b}) | 0)`);
        else if (op === "isub") valid = binary((a, b) => `((${a} - ${b}) | 0)`);
        else if (op === "imul") valid = binary((a, b) => `Math.imul(${a}, ${b})`);
        else if (op === "iand") valid = binary((a, b) => `(${a} & ${b})`);
        else if (op === "ior") valid = binary((a, b) => `(${a} | ${b})`);
        else if (op === "ixor") valid = binary((a, b) => `(${a} ^ ${b})`);
        else if (op === "ishl") valid = binary((a, b) => `(${a} << (${b} & 31))`);
        else if (op === "ishr") valid = binary((a, b) => `(${a} >> (${b} & 31))`);
        else if (op === "iushr") valid = binary((a, b) => `((${a} >>> (${b} & 31)) | 0)`);
        else if (op === "ineg" || op === "i2b") {
          const value = pop();
          if (value === null) valid = false;
          else expressions.push(op === "ineg" ? `((-${value}) | 0)` : `((${value} << 24) >> 24)`);
        } else if (op === "idiv" || op === "irem") {
          const divisorExpression = pop();
          const dividendExpression = pop();
          if (divisorExpression === null || dividendExpression === null) valid = false;
          else {
            const dividend = temp();
            const divisor = temp();
            body.push(`const ${dividend} = ${dividendExpression};`, `const ${divisor} = ${divisorExpression};`);
            body.push(`if (${divisor} === 0) {`);
            body.push(...materialize([...expressions, dividend, divisor], index));
            body.push('throw { type: "java/lang/ArithmeticException", message: "/ by zero" };', "}");
            expressions.push(op === "idiv" ? `((${dividend} / ${divisor}) | 0)`
              : `((${dividend} % ${divisor}) | 0)`);
          }
        } else if (op === "iinc") {
          const variable = Number(instruction.varnum ?? instruction.arg);
          const increment = Number(instruction.incr ?? 0);
          body.push(`local${variable} = (local${variable} + ${increment}) | 0;`);
        } else if (op === "newarray") {
          const countExpression = pop();
          if (countExpression === null) valid = false;
          else {
            const count = temp();
            const value = temp();
            const caught = temp();
            body.push(`const ${count} = ${countExpression}; let ${value}; try { ${value} = helpers.newPrimitiveArray(${count}, ${JSON.stringify(instruction.arg)}); } catch (${caught}) {`);
            body.push(...materialize([...expressions, count], index));
            body.push(`throw ${caught};`, "}");
            expressions.push(value);
            if (ssaOptimizations) arrayViews.set(value, value);
          }
        } else if (op === "checkcast") {
          const value = expressions[expressions.length - 1];
          if (value === undefined) valid = false;
          else {
            const castValue = temp();
            const source = temp();
            const cast = temp();
            const caught = temp();
            const target = JSON.stringify(instruction.arg);
            body.push(`const ${castValue} = ${value}; if (${castValue} !== null && ${castValue} !== undefined) {`);
            body.push(`const ${source} = ${generatedRuntimeClassNameExpression(castValue)}; if (${source} !== ${target}) {`);
            body.push(`let ${cast}; try { ${cast} = helpers.tryCheckCastSourceSync(${source}, ${target}); } catch (${caught}) {`);
            body.push(...materialize(expressions, index));
            body.push(`throw ${caught};`, "}");
            body.push(`if (${cast} === helpers.asyncInvokeSentinel()) {`);
            body.push(...materialize(expressions, index));
            body.push("helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: 'cold scalar checkcast' };", "}");
            body.push("}", "}");
          }
        } else if (op === "arraylength") {
          const arrayExpression = pop();
          if (arrayExpression === null) valid = false;
          else {
            const identity = ssaOptimizations && valueIdentities.get(arrayExpression);
            const previousLength = identity && arrayLengths.get(identity);
            if (previousLength) {
              expressions.push(previousLength);
              eliminatedReadCount += 1;
              continue;
            }
            const array = temp();
            const length = temp();
            body.push(`const ${array} = ${arrayExpression};`);
            body.push(`if (${array} === null || ${array} === undefined) {`);
            body.push(...materialize([...expressions, array], index));
            body.push(`helpers.arrayLength(${array}, frame);`, "}");
            body.push(`const ${length} = ${array}.length;`);
            expressions.push(length);
            if (identity) arrayLengths.set(identity, length);
          }
        } else if (op === "iaload" || op === "saload" || op === "aaload") {
          const arrayIndexExpression = pop();
          const arrayExpression = pop();
          if (arrayIndexExpression === null || arrayExpression === null) valid = false;
          else {
            const array = temp();
            const arrayData = ssaOptimizations ? temp() : null;
            const arrayIndex = temp();
            const value = temp();
            body.push(`const ${array} = ${arrayExpression};${ssaOptimizations ? ` const ${arrayData} = ${arrayViews.get(arrayExpression) || `helpers.arrayData(${array})`};` : ""} const ${arrayIndex} = ${arrayIndexExpression}; let ${value};`);
            body.push(`if (${array} === null || ${array} === undefined || ${arrayIndex} < 0 || ${arrayIndex} >= ${array}.length) {`);
            body.push(...materialize([...expressions, array, arrayIndex], index));
            body.push(`${value} = helpers.arrayLoad(${arrayIndex}, ${array}, frame, ${JSON.stringify(op)});`, "} else {");
            if (ssaOptimizations) {
              body.push(`${value} = ${arrayData} !== null ? ${arrayData}[${arrayIndex}] : (${array}.elements ? ${array}.elements[${arrayIndex}] : ${array}[${arrayIndex}]);`, "}");
              arrayViewCount += 1;
            } else {
              body.push(`${value} = ${array}.elements ? ${array}.elements[${arrayIndex}] : ${array}[${arrayIndex}];`, "}");
            }
            expressions.push(value);
          }
        } else if (op === "iastore") {
          const valueExpression = pop();
          const arrayIndexExpression = pop();
          const arrayExpression = pop();
          if (valueExpression === null || arrayIndexExpression === null || arrayExpression === null) {
            valid = false;
          } else {
            const array = temp();
            const arrayData = ssaOptimizations ? temp() : null;
            const arrayIndex = temp();
            const value = temp();
            body.push(`const ${array} = ${arrayExpression};${ssaOptimizations ? ` const ${arrayData} = ${arrayViews.get(arrayExpression) || `helpers.arrayData(${array})`};` : ""} const ${arrayIndex} = ${arrayIndexExpression}; const ${value} = ${valueExpression};`);
            body.push(`if (${array} === null || ${array} === undefined || ${arrayIndex} < 0 || ${arrayIndex} >= ${array}.length) {`);
            body.push(...materialize([...expressions, array, arrayIndex, value], index));
            if (ssaOptimizations) {
              body.push(`helpers.arrayStore(${value}, ${arrayIndex}, ${array}, frame, "iastore");`, `} else if (${arrayData} !== null) {`, `${arrayData}[${arrayIndex}] = ${value} | 0;`, `} else if (${array}.elements) {`, `${array}.elements[${arrayIndex}] = ${value} | 0;`, "} else {", `${array}[${arrayIndex}] = ${value} | 0;`, "}");
              arrayViewCount += 1;
            } else {
              body.push(`helpers.arrayStore(${value}, ${arrayIndex}, ${array}, frame, "iastore");`, "} else if (", `${array}.elements) {`, `${array}.elements[${arrayIndex}] = ${value} | 0;`, "} else {", `${array}[${arrayIndex}] = ${value} | 0;`, "}");
            }
          }
        } else if (op === "getfield") {
          const objectExpression = pop();
          if (objectExpression === null) valid = false;
          else {
            const siteId = fieldSites.get(index);
            const identity = ssaOptimizations && valueIdentities.get(objectExpression);
            // Field-site ids are deliberately per-bytecode for inline caches;
            // value numbering instead uses the symbolic constant-pool target.
            const symbolicField = ssaOptimizations &&
              this.canEliminateFieldRead(instruction.arg) && JSON.stringify(instruction.arg);
            const fieldIdentity = symbolicField && identity && `${symbolicField}|${identity}`;
            const previousValue = fieldIdentity && fieldValues.get(fieldIdentity);
            if (previousValue) {
              expressions.push(previousValue);
              eliminatedReadCount += 1;
              continue;
            }
            const object = temp();
            const value = temp();
            body.push(`const ${object} = ${objectExpression};`);
            body.push(`if (${object} === null || ${object} === undefined) {`);
            body.push(...materialize([...expressions, object], index));
            body.push(`helpers.getFieldAt(${siteId}, ${object});`, "}");
            body.push(`const ${value} = helpers.getFieldAt(${siteId}, ${object});`);
            expressions.push(value);
            if (fieldIdentity) {
              fieldValues.set(fieldIdentity, value);
              valueIdentities.set(value, `field:${fieldIdentity}`);
            }
            if (ssaOptimizations && this.fieldSites[siteId]?.descriptor?.startsWith("[")) {
              const data = temp();
              body.push(`const ${data} = helpers.arrayData(${value});`);
              arrayViews.set(value, data);
            }
          }
        } else if (op === "getstatic") {
          const value = temp();
          const siteId = fieldSites.get(index);
          body.push(`const ${value} = helpers.getStaticSyncAt(${siteId});`);
          body.push(`if (${value} === helpers.staticDeopt()) {`);
          body.push(...materialize(expressions, index));
          body.push("helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: 'class initialization in scalar getstatic' };", "}");
          expressions.push(value);
          if (ssaOptimizations && this.fieldSites[siteId]?.descriptor?.startsWith("[")) {
            const data = temp();
            body.push(`const ${data} = helpers.arrayData(${value});`);
            arrayViews.set(value, data);
          }
        } else if (op === "putstatic") {
          const value = pop();
          if (value === null) valid = false;
          else {
            const changed = temp();
            const siteId = fieldSites.get(index);
            body.push(`const ${changed} = helpers.putStaticSyncAt(${siteId}, ${value});`);
            body.push(`if (${changed} === helpers.staticDeopt()) {`);
            body.push(...materialize([...expressions, value], index));
            body.push("helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: 'class initialization in scalar putstatic' };", "}");
          }
        } else if (op === "invokestatic") {
          const plan = inlinePlans.get(index);
          if (plan) {
            const callStack = [...expressions];
            const args = new Array(plan.paramCount);
            for (let argument = args.length - 1; argument >= 0; argument -= 1) {
              args[argument] = pop();
              if (args[argument] === null) valid = false;
            }
            if (!valid) return null;
            const result = temp();
            const substitute = (source) => source.replace(/stack\[base \+ (\d+)\]/g,
              (_match, argument) => `(${args[Number(argument)]})`);
            body.push(`let ${result};`, "{");
            body.push(...plan.statements.map(substitute));
            if (plan.guards?.length) {
              const guard = plan.guards.map((condition) =>
                `(${substitute(condition)})`).join(" && ");
              body.push(`if (!(${guard})) {`,
                ...materialize(callStack, index),
                "helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: 'guarded scalar integer inline' };",
                "}");
            }
            body.push(`${result} = ${substitute(plan.result)};`, "}");
            expressions.push(result);
          } else {
            const site = callSites.get(index);
            if (!site) valid = false;
            else {
              const argumentCount = site.params.length;
              const base = expressions.length - argumentCount;
              if (base < 0) valid = false;
              else {
                const beforeCall = expressions.slice();
                body.push(...saveStack(beforeCall), `frame.pc = ${index + 1};`);
                const value = temp();
                const caught = temp();
                body.push(`let ${value}; try { ${value} = helpers.tryInvokeSyncAt(${site.id}, frame, thread); } catch (${caught}) {`);
                body.push(...materialize(beforeCall, index));
                body.push(`throw ${caught};`, "}");
                body.push(`if (${value} === helpers.asyncInvokeSentinel()) {`);
                body.push("const activeChild = thread.callStack.items[thread.callStack.items.length - 1];",
                  "if (activeChild !== frame && activeChild && " +
                    "activeChild.jitGeneratedReturnParent === frame) {",
                  ...spillLocals(),
                  "return { deopt: true, transient: true, reason: 'asynchronous scalar callee left active child' };",
                  "}");
                body.push(...materialize(beforeCall, index));
                body.push("helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: 'asynchronous scalar callee' };", "}");
                body.push(`if (${value} && ${value}.deopt) {`, ...spillLocals(), `return ${value};`, "}");
                body.push(`if (${value} !== helpers.returnVoid()) stack.push(${value});`);
                body.push("if (thread.status !== 'runnable') {", ...spillLocals(),
                  `helpers.materialize(frame, locals, stack, ${index + 1});`,
                  "return { deopt: true, transient: true, reason: 'thread yielded in scalar callee' };", "}");
                const resultDepth = base + (site.returnType === "void" ? 0 : 1);
                body.push(`stack.length = ${resultDepth};`);
                body.push(...Array.from({ length: resultDepth }, (_unused, slot) =>
                  `scalarJoin${slot} = stack[${slot}];`));
                if (ssaOptimizations) {
                  body.push(...Array.from({ length: resultDepth }, (_unused, slot) =>
                    `scalarJoin${slot}ArrayData = helpers.arrayData(stack[${slot}]);`));
                }
                body.push(`pc = ${index + 1}; continue;`);
                terminated = true;
              }
            }
          }
        } else if (op === "goto") {
          const target = branchTargetIndex(instruction, labels);
          if (ssaOptimizations && target === end) {
            body.push(...saveJoin(expressions));
            threadedEdgeCount += 1;
            terminated = true;
          } else {
            body.push(...transfer(expressions, target, index));
            terminated = true;
          }
        } else if (op && op.startsWith("if")) {
          let condition;
          if (op.startsWith("if_icmp") || op.startsWith("if_acmp")) {
            const right = pop();
            const left = pop();
            const comparisons = {
              if_icmpeq: "===", if_icmpne: "!==", if_icmplt: "<", if_icmpge: ">=",
              if_icmpgt: ">", if_icmple: "<=", if_acmpeq: "===", if_acmpne: "!==",
            };
            if (left === null || right === null || !comparisons[op]) valid = false;
            else condition = `${left} ${comparisons[op]} ${right}`;
          } else {
            const value = pop();
            const comparisons = {
              ifeq: "=== 0", ifne: "!== 0", iflt: "< 0", ifge: ">= 0",
              ifgt: "> 0", ifle: "<= 0", ifnull: "=== null", ifnonnull: "!== null",
            };
            if (value === null || !comparisons[op]) valid = false;
            else condition = `${value} ${comparisons[op]}`;
          }
          if (valid) {
            const target = branchTargetIndex(instruction, labels);
            const backward = target <= index;
            if (backward) {
              body.push(`if (${condition}) {`);
              body.push(...transfer(expressions, target, index));
              body.push("}");
              if (ssaOptimizations && index + 1 === end) {
                body.push(...saveJoin(expressions));
                threadedEdgeCount += 1;
              } else {
                body.push(...transfer(expressions, index + 1, -1));
              }
            } else {
              body.push(...saveJoin(expressions));
              if (ssaOptimizations && index + 1 === end) {
                body.push(`if (${condition}) { pc = ${target}; continue; }`);
                threadedEdgeCount += 1;
              } else {
                body.push(`pc = (${condition}) ? ${target} : ${index + 1};`, "continue;");
              }
            }
            terminated = true;
          }
        } else if (op === "athrow") {
          const value = pop();
          if (value === null) valid = false;
          else {
            body.push(...materialize([...expressions, value], index));
            body.push(`throw ${value};`);
            terminated = true;
          }
        } else if (op === "ireturn") {
          const value = pop();
          if (value === null) valid = false;
          else {
            body.push(...materialize(expressions, index + 1));
            body.push(`thread.callStack.pop(); return { returned: true, value: ${value} };`);
            terminated = true;
          }
        } else if (op === "return") {
          body.push(...materialize(expressions, index + 1));
          body.push("thread.callStack.pop(); return { returned: true, value: helpers.returnVoid() };");
          terminated = true;
        } else valid = false;

        if (!valid) return null;
        if (terminated) break;
      }
      if (!terminated) {
        if (ssaOptimizations && orderedLeaders.includes(end)) {
          body.push(...saveJoin(expressions));
          threadedEdgeCount += 1;
        } else {
          body.push(...transfer(expressions, end, -1));
        }
      }
      body.push("}");
    }
    body.push("default: helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: 'scalar loop non-leader entry' };");
    body.push("}", "}");
    try {
      const generated = this.createGeneratedFunction(method,
        ssaOptimizations ? "scalar-ssa" : "scalar",
        ["frame", "thread", "helpers", "initialBytecodeChecks"], body.join("\n"));
      generated.jvmSynchronous = true;
      generated.jvmScalarLoop = true;
      generated.jvmScalarSsa = ssaOptimizations;
      generated.jvmScalarArrayViewCount = arrayViewCount;
      generated.jvmScalarEliminatedReadCount = eliminatedReadCount;
      generated.jvmScalarThreadedEdgeCount = threadedEdgeCount;
      generated.jvmDirectInlineCount = inlinePlans.size;
      if (ssaOptimizations) {
        this.scalarSsaArrayViewCount += arrayViewCount;
        this.scalarSsaEliminatedReadCount += eliminatedReadCount;
        this.scalarSsaThreadedEdgeCount += threadedEdgeCount;
      }
      return generated;
    } catch (_) {
      return null;
    }
  }

  compileBaselineMethod(method, inlineLoopRegions = null) {
    const synchronous = this.canCompileSynchronously(method);
    const GeneratedFunction = synchronous ? Function : getAsyncFunctionConstructor();
    if (!GeneratedFunction) {
      this.codegenUnavailable = true;
      return null;
    }

    const code = method.attributes.find((attr) => attr.type === "code");
    const codeItems = this.getCodeItems(method);
    const loopRegions = inlineLoopRegions ||
      this.compileInlinePrimitiveLoopRegions(method);
    const loopRegionsByHeader = new Map(
      loopRegions.map((region) => [region.header, region]));
    let stackWidthsBefore = null;
    if (codeItems.some((item) => {
      const op = getOp(item && item.instruction);
      return op === "dup_x2" || op === "dup2" || op === "dup2_x2";
    })) {
      const analysis = buildSsa({
        codeItems,
        exceptionTable: code && code.code && code.code.exceptionTable || [],
        method,
      });
      if (analysis && !analysis.rejected && analysis.stackKindsBefore) {
        stackWidthsBefore = new Map();
        for (const [index, kinds] of analysis.stackKindsBefore) {
          stackWidthsBefore.set(index, kinds.map(kindWidth));
        }
      }
    }
    this.compileLabelMap = buildLabelMap(codeItems);
    this.compileSynchronous = synchronous;
    const syncCallTracePattern = typeof process !== "undefined" && process.env
      ? process.env.JVM_TRACE_SYNC_CALLS || "" : "";
    const syncCallTraceIdentity = syncCallTracePattern
      ? `${method?.className || this.jvm.findClassNameForMethod?.(method) ||
        "unknown"}.${method?.name || "unknown"}${method?.descriptor || ""}`
      : "";
    this.compileTraceSyncCalls = Boolean(syncCallTracePattern &&
      syncCallTraceIdentity.includes(syncCallTracePattern));
    this.compileDirectInlineCount = 0;
    let directInlineCount = 0;
    const body = [
      '"use strict";',
      "const locals = frame.locals;",
      "const stack = frame.stack.items;",
      "let sp = stack.length;",
      "let pc = frame.pc;",
      "let bytecodesUntilYield = 10000;",
      "let bytecodeChecks = initialBytecodeChecks === undefined ? helpers.needsBytecodeChecks() : initialBytecodeChecks;",
      // Prime stride, as in the runner, so successive probes land on different
      // pcs of a loop body. It must stay below bytecodesUntilYield: the quantum
      // check below can end the activation, so a larger stride would make the
      // probe unreachable whenever the quantum declines to continue.
      "let osrCountdown = 9973;",
      `while (pc < ${codeItems.length}) {`,
      "if (--osrCountdown === 0) { osrCountdown = 9973; helpers.materializeCached(frame, locals, stack, sp, pc); const osr = helpers.wasmOsrProbe(frame, thread, pc, sp); if (osr) { if (osr.returned) return { returned: true, value: osr.value }; if (osr.deopted) return { deopt: true, transient: true, reason: 'wasm OSR left active child' }; pc = osr.resumePc; sp = stack.length; } }",
      synchronous
        // A synchronous baseline body also keeps its complete locals/operand
        // state in JavaScript between polls. As with structured SSA, another
        // runnable Java thread need not force a costly spill/re-entry every
        // 10k bytecodes; run until the existing wall-clock/timer/debug
        // deadline, then materialize the exact PC before yielding.
        ? "if (--bytecodesUntilYield === 0) { if (helpers.continueStructuredQuantum(thread)) { bytecodesUntilYield = 10000; } else { helpers.materializeCached(frame, locals, stack, sp, pc); helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: 'synchronous generated quantum' }; } }"
        : "if (--bytecodesUntilYield === 0) { if (helpers.continueQuantum(thread)) { bytecodesUntilYield = 10000; } else { helpers.materializeCached(frame, locals, stack, sp, pc); await helpers.cooperativeYield(); bytecodesUntilYield = 10000; bytecodeChecks = helpers.needsBytecodeChecks(); } }",
      "if (bytecodeChecks && helpers.shouldDeopt(frame, pc)) { helpers.materializeCached(frame, locals, stack, sp, pc); return { deopt: true }; }",
      "switch (pc) {",
    ];

    try {
      codeItems.forEach((item, index) => {
        body.push(`case ${index}:`);
        const loopRegion = loopRegionsByHeader.get(index);
        if (loopRegion) {
          if (loopRegion.scalarBounded) {
            body.push(
              "if (!bytecodeChecks && sp === 0 && " +
                `helpers.canRunInlineLoopRegion(${loopRegion.id}, frame)) {`,
              `  const regionResult = helpers.runInlineLoopRegion(${loopRegion.id}, frame, thread);`,
              "  if (regionResult && regionResult.deopt) return regionResult;",
              "  stack.length = 0;",
              "  sp = 0;",
              `  pc = ${loopRegion.exit};`,
              "  continue;",
              "}",
            );
          } else {
            body.push(
              "if (!bytecodeChecks && sp === 0) {",
              `  const regionArray = locals[${loopRegion.boundArraySlot}];`,
              `  const regionCounter = locals[${loopRegion.counterSlot}] | 0;`,
              "  if (regionArray !== null && regionArray !== undefined && " +
                "regionCounter >= 0 && regionArray.length - regionCounter <= 4096 && " +
                `helpers.canRunInlineLoopRegion(${loopRegion.id}, frame)) {`,
              `    const regionResult = helpers.runInlineLoopRegion(${loopRegion.id}, frame, thread);`,
              "    if (regionResult && regionResult.deopt) return regionResult;",
              "    stack.length = 0;",
              "    sp = 0;",
              `    pc = ${loopRegion.exit};`,
              "    continue;",
              "  }",
              "}",
            );
          }
        }
        const instruction = item.instruction;
        if (!instruction) {
          body.push(`if (bytecodeChecks) { pc = ${index + 1}; break; }`);
          return;
        }
        // Locals and operand stack are the frame's live arrays already. The
        // exact frame PC is only needed before an instruction that can throw
        // or deopt; control-flow edges materialize their own resume PC.
        if (this.instructionNeedsPrecisePc(instruction)) {
          body.push(`stack.length = sp; frame.pc = ${index};`);
        }
        body.push(this.emitInstruction(
          instruction, index, stackWidthsBefore && stackWidthsBefore.get(index),
          method,
        ));
      });
      directInlineCount = this.compileDirectInlineCount;
    } finally {
      this.compileLabelMap = null;
      this.compileSynchronous = false;
      this.compileTraceSyncCalls = false;
      this.compileDirectInlineCount = 0;
    }

    body.push("default: helpers.materializeCached(frame, locals, stack, sp, pc); return { deopt: true, reason: 'invalid generated pc ' + pc };");
    body.push("}");
    body.push("}");
    body.push("helpers.materializeCached(frame, locals, stack, sp, pc);");
    body.push("thread.callStack.pop();");
    body.push("return { returned: true, value: helpers.returnVoid() };");

    const generatedSource = body.join("\n");
    const tracePattern = typeof process !== "undefined" && process.env
      ? process.env.JVM_TRACE_JIT_METHOD || "" : "";
    if (tracePattern && process.env.JVM_TRACE_JIT_SOURCE === "1") {
      const traceIdentity =
        `${method?.className || this.jvm.findClassNameForMethod?.(method) ||
          "unknown"}.${method?.name || "unknown"}${method?.descriptor || ""}`;
      if (traceIdentity.includes(tracePattern)) {
        const aroundLine = Number(
          process.env.JVM_TRACE_JIT_SOURCE_AROUND_LINE || 0);
        const tracedSource = aroundLine > 0
          ? generatedSource.split("\n").slice(
            Math.max(0, aroundLine - 16), aroundLine + 15,
          ).map((line, offset) =>
            `${Math.max(1, aroundLine - 15) + offset}: ${line}`).join("\n")
          : generatedSource;
        console.error("[jit-generated-source] " + traceIdentity + "\n" +
          tracedSource);
      }
    }

    try {
      const generated = this.createGeneratedFunction(method,
        synchronous ? "generated-sync" : "generated-async",
        ["frame", "thread", "helpers", "initialBytecodeChecks"], generatedSource,
        null, !synchronous);
      generated.jvmSynchronous = synchronous;
      generated.jvmDirectInlineCount = directInlineCount;
      generated.jvmInlineLoopRegionCount = loopRegions.length;
      return generated;
    } catch (err) {
      if (err && err.name === "EvalError") {
        this.codegenUnavailable = true;
      }
      throw err;
    }
  }

  compileStacklessIntegerRaster(method) {
    const rasterDescriptor = "(IIIIIIIBIIII[IIIII)V";
    const wrapperDescriptor = "(IIIIIIIIIIIIZIII)V";
    if (method.descriptor !== rasterDescriptor && method.descriptor !== wrapperDescriptor) return null;
    const code = method.attributes.find((attr) => attr.type === "code");
    const codeItems = this.getCodeItems(method);
    if (!this.canCompileSynchronously(method)) return null;

    const ops = codeItems.map((item) => getOp(item && item.instruction)).filter(Boolean);
    const hotCalls = codeItems.filter((item) => {
      const instruction = item && item.instruction;
      return getOp(instruction) === "invokestatic" && instruction &&
        Array.isArray(instruction.arg) && Array.isArray(instruction.arg[2]) &&
        instruction.arg[2][1] === (method.descriptor === rasterDescriptor
          ? "(IIIIIII[III)V" : rasterDescriptor);
    }).length;
    const rasterShape = method.descriptor === rasterDescriptor && codeItems.length >= 1000 &&
      ops.filter((op) => op === "iload").length >= 300 &&
      ops.filter((op) => op === "istore").length >= 100 && hotCalls >= 5;
    const wrapperShape = method.descriptor === wrapperDescriptor && codeItems.length >= 170 &&
      ops.filter((op) => op === "iload").length >= 80 && hotCalls >= 6;
    if (!rasterShape && !wrapperShape) {
      return null;
    }

    const labels = buildLabelMap(codeItems);
    const depths = this.computeStackDepths(codeItems, labels, method);
    if (!depths) return null;
    const leaders = new Set([0]);
    const terminal = new Set([
      "areturn", "athrow", "dreturn", "freturn", "ireturn", "lreturn", "return",
    ]);
    for (let index = 0; index < codeItems.length; index += 1) {
      const instruction = codeItems[index] && codeItems[index].instruction;
      const op = getOp(instruction);
      if (op === "goto" || op && op.startsWith("if")) {
        const target = branchTargetIndex(instruction, labels);
        if (target === undefined) return null;
        leaders.add(target);
        if (index + 1 < codeItems.length) leaders.add(index + 1);
      }
      if (op && op.startsWith("invoke")) {
        leaders.add(index);
        if (index + 1 < codeItems.length) leaders.add(index + 1);
      }
      if (terminal.has(op) && index + 1 < codeItems.length) leaders.add(index + 1);
    }
    const exceptionTable = code.code.exceptionTable || [];
    for (const entry of exceptionTable) {
      const handler = labels.get(entry.handlerLbl || `L${entry.handler_pc}`);
      if (handler !== undefined) leaders.add(handler);
    }

    const orderedLeaders = [...leaders].sort((a, b) => a - b);
    const nextLeader = new Map();
    orderedLeaders.forEach((leader, position) => {
      nextLeader.set(leader, orderedLeaders[position + 1] ?? codeItems.length);
    });

    let temporary = 0;
    const temp = () => `v${temporary++}`;
    const body = [
      '"use strict";',
      "const locals = frame.locals;",
      "const stack = frame.stack.items;",
      "let pc = frame.pc;",
      "let blocksUntilYield = 10000;",
      "if ((initialBytecodeChecks === undefined ? helpers.needsBytecodeChecks() : initialBytecodeChecks)) return { deopt: true, transient: true, reason: 'stackless raster debug entry' };",
      "while (true) {",
      "if (--blocksUntilYield === 0) { if (helpers.continueQuantum(thread)) { blocksUntilYield = 10000; } else { helpers.materialize(frame, locals, stack, pc); helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: 'stackless raster quantum' }; } }",
      "switch (pc) {",
    ];

    const saveStack = (expressions) => {
      const lines = expressions.map((expression, index) => `stack[${index}] = ${expression};`);
      lines.push(`stack.length = ${expressions.length};`);
      return lines;
    };
    const transfer = (expressions, target) => [
      ...saveStack(expressions),
      `pc = ${target};`,
      "continue;",
    ];
    const deopt = (expressions, index, reason) => [
      ...saveStack(expressions),
      `helpers.materialize(frame, locals, stack, ${index});`,
      `return { deopt: true, reason: ${JSON.stringify(reason)} };`,
    ];
    const localIndex = (instruction, op) => {
      if (instruction && typeof instruction === "object" && instruction.arg !== undefined) {
        return Number(instruction.arg);
      }
      const match = /_([0-3])$/.exec(op || "");
      return match ? Number(match[1]) : NaN;
    };
    const constant = (instruction, op) => {
      if (op === "iconst_m1") return "-1";
      if (/^iconst_[0-5]$/.test(op)) return op.slice(-1);
      return jsLiteral(Number(instruction.arg));
    };

    for (const leader of orderedLeaders) {
      const entryDepth = depths[leader];
      if (entryDepth === undefined) continue;
      body.push(`case ${leader}: {`);
      const expressions = [];
      for (let index = 0; index < entryDepth; index += 1) {
        const value = temp();
        body.push(`const ${value} = stack[${index}];`);
        expressions.push(value);
      }
      let terminated = false;
      const end = nextLeader.get(leader);

      for (let index = leader; index < end; index += 1) {
        const instruction = codeItems[index] && codeItems[index].instruction;
        const op = getOp(instruction);
        if (!op || op === "nop") continue;
        const pop = () => expressions.pop();
        const binary = (format) => {
          const right = pop();
          const left = pop();
          if (left === undefined || right === undefined) return false;
          expressions.push(format(left, right));
          return true;
        };
        let valid = true;

        if (/^[ai]load(?:_[0-3])?$/.test(op)) {
          const value = temp();
          body.push(`const ${value} = locals[${localIndex(instruction, op)}];`);
          expressions.push(value);
        } else if (/^[ai]store(?:_[0-3])?$/.test(op)) {
          const value = pop();
          if (value === undefined) valid = false;
          else body.push(`locals[${localIndex(instruction, op)}] = ${value};`);
        } else if (op === "aconst_null") {
          expressions.push("null");
        } else if (/^iconst_(?:m1|[0-5])$/.test(op) ||
                   op === "bipush" || op === "sipush" || op === "ldc" || op === "ldc_w") {
          if ((op === "ldc" || op === "ldc_w") && typeof instruction.arg !== "number") {
            const value = temp();
            body.push(`const ${value} = helpers.constantValue(${jsLiteral(instruction.arg)});`);
            expressions.push(value);
          } else {
            expressions.push(constant(instruction, op));
          }
        } else if (op === "dup") {
          const value = pop();
          if (value === undefined) valid = false;
          else {
            const duplicate = temp();
            body.push(`const ${duplicate} = ${value};`);
            expressions.push(duplicate, duplicate);
          }
        } else if (op === "pop") {
          if (pop() === undefined) valid = false;
        } else if (op === "iadd") {
          valid = binary((a, b) => `((${a} + ${b}) | 0)`);
        } else if (op === "isub") {
          valid = binary((a, b) => `((${a} - ${b}) | 0)`);
        } else if (op === "imul") {
          valid = binary((a, b) => `Math.imul(${a}, ${b})`);
        } else if (op === "ixor") {
          valid = binary((a, b) => `(${a} ^ ${b})`);
        } else if (op === "iand") {
          valid = binary((a, b) => `(${a} & ${b})`);
        } else if (op === "ior") {
          valid = binary((a, b) => `(${a} | ${b})`);
        } else if (op === "ishl") {
          valid = binary((a, b) => `(${a} << (${b} & 31))`);
        } else if (op === "ishr") {
          valid = binary((a, b) => `(${a} >> (${b} & 31))`);
        } else if (op === "iushr") {
          valid = binary((a, b) => `((${a} >>> (${b} & 31)) | 0)`);
        } else if (op === "ineg") {
          const value = pop();
          if (value === undefined) valid = false;
          else expressions.push(`((-${value}) | 0)`);
        } else if (op === "idiv" || op === "irem") {
          const divisorExpression = pop();
          const dividendExpression = pop();
          if (divisorExpression === undefined || dividendExpression === undefined) valid = false;
          else {
            const divisor = temp();
            body.push(`frame.pc = ${index}; const ${divisor} = ${divisorExpression};`);
            body.push(`if (${divisor} === 0) throw { type: "java/lang/ArithmeticException", message: "/ by zero" };`);
            expressions.push(op === "idiv"
              ? `((${dividendExpression} / ${divisor}) | 0)`
              : `((${dividendExpression} % ${divisor}) | 0)`);
          }
        } else if (op === "iinc") {
          const variable = Number(instruction.varnum ?? instruction.arg);
          const increment = Number(instruction.incr ?? 0);
          body.push(`locals[${variable}] = (locals[${variable}] + ${increment}) | 0;`);
        } else if (op === "getstatic") {
          const value = temp();
          const fieldSiteId = this.registerFieldSite(instruction.arg);
          body.push(`frame.pc = ${index}; const ${value} = helpers.getStaticSyncAt(${fieldSiteId});`);
          if (expressions.length) body.push(...saveStack(expressions));
          body.push(`if (${value} === helpers.staticDeopt()) { helpers.materialize(frame, locals, stack, ${index}); helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: "class initialization in stackless raster" }; }`);
          expressions.push(value);
        } else if (op === "iaload") {
          const arrayIndex = pop();
          const array = pop();
          if (arrayIndex === undefined || array === undefined) valid = false;
          else {
            const value = temp();
            body.push(`frame.pc = ${index}; const ${value} = helpers.arrayLoad(${arrayIndex}, ${array}, frame, "iaload");`);
            expressions.push(value);
          }
        } else if (op && op.startsWith("invoke")) {
          const invokeDescriptor = instruction.arg[2][1];
          if (rasterShape && op === "invokestatic" &&
              invokeDescriptor === "(IIIIIII[III)V" && expressions.length >= 10) {
            const base = expressions.length - 10;
            const direct = temp();
            body.push(`const ${direct} = helpers.packedColorScanlineDirect(${expressions.slice(base).join(", ")}, locals[42], ${JSON.stringify(instruction.arg[1])});`);
            body.push(`if (${direct} !== helpers.asyncInvokeSentinel()) {`);
            body.push(...saveStack(expressions.slice(0, base)));
            body.push(`pc = ${index + 1}; continue;`);
            body.push("}");
          }
          const callSiteId = this.registerSyncCallSite(
            op, instruction, method, index);
          const parsed = parseDescriptor(instruction.arg[2][1]);
          body.push(...saveStack(expressions));
          body.push(`helpers.materialize(frame, locals, stack, ${index + 1});`);
          const value = temp();
          body.push(`const ${value} = helpers.tryInvokeSyncAt(${callSiteId}, frame, thread);`);
          body.push(`if (${value} === helpers.asyncInvokeSentinel()) { const activeChild = thread.callStack.items[thread.callStack.items.length - 1]; if (activeChild !== frame && activeChild && activeChild.jitGeneratedReturnParent === frame) { return { deopt: true, transient: true, reason: "asynchronous stackless raster callee left active child" }; } helpers.materialize(frame, locals, stack, ${index}); helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: "asynchronous stackless raster callee" }; }`);
          body.push(`if (${value} && ${value}.deopt) return ${value};`);
          body.push(`if (${value} !== helpers.returnVoid()) stack.push(${value});`);
          body.push(`if (thread.status !== "runnable") return { deopt: true, transient: true, reason: "thread yielded in stackless raster callee" };`);
          const resultDepth = expressions.length - parsed.params.length - (op === "invokestatic" ? 0 : 1) +
            (parsed.returnType === "void" ? 0 : 1);
          body.push(`stack.length = ${resultDepth}; pc = ${index + 1}; continue;`);
          terminated = true;
        } else if (op === "goto") {
          body.push(...transfer(expressions, branchTargetIndex(instruction, labels)));
          terminated = true;
        } else if (op && op.startsWith("if")) {
          let condition;
          if (op.startsWith("if_icmp") || op.startsWith("if_acmp")) {
            const right = pop();
            const left = pop();
            const comparisons = {
              if_icmpeq: "===", if_icmpne: "!==", if_icmplt: "<", if_icmpge: ">=",
              if_icmpgt: ">", if_icmple: "<=", if_acmpeq: "===", if_acmpne: "!==",
            };
            if (left === undefined || right === undefined || !comparisons[op]) valid = false;
            else condition = `${left} ${comparisons[op]} ${right}`;
          } else {
            const value = pop();
            const comparisons = {
              ifeq: "=== 0", ifne: "!== 0", iflt: "< 0", ifge: ">= 0",
              ifgt: "> 0", ifle: "<= 0", ifnull: "=== null", ifnonnull: "!== null",
            };
            if (value === undefined || !comparisons[op]) valid = false;
            else condition = `${value} ${comparisons[op]}`;
          }
          if (valid) {
            body.push(...saveStack(expressions));
            body.push(`pc = (${condition}) ? ${branchTargetIndex(instruction, labels)} : ${index + 1}; continue;`);
            terminated = true;
          }
        } else if (op === "athrow") {
          const value = pop();
          if (value === undefined) valid = false;
          else {
            body.push(`frame.pc = ${index}; throw ${value};`);
            terminated = true;
          }
        } else if (op === "return") {
          body.push(...saveStack(expressions));
          body.push(`helpers.materialize(frame, locals, stack, ${index + 1}); thread.callStack.pop(); return { returned: true, value: helpers.returnVoid() };`);
          terminated = true;
        } else if (/^[aifdl]return$/.test(op)) {
          const value = pop();
          if (value === undefined) valid = false;
          else {
            body.push(...saveStack(expressions));
            body.push(`helpers.materialize(frame, locals, stack, ${index + 1}); thread.callStack.pop(); return { returned: true, value: ${value} };`);
            terminated = true;
          }
        } else {
          valid = false;
        }

        if (!valid) {
          body.push(...deopt(expressions, index, `unsupported stackless raster opcode ${op}`));
          terminated = true;
        }
        if (terminated) break;
      }

      if (!terminated) body.push(...transfer(expressions, end));
      body.push("}");
    }

    body.push("default: helpers.materialize(frame, locals, stack, pc); return { deopt: true, reason: 'invalid stackless raster pc ' + pc };");
    body.push("}", "}");
    try {
      const generated = this.createGeneratedFunction(method, "stackless-raster",
        ["frame", "thread", "helpers", "initialBytecodeChecks"], body.join("\n"));
      generated.jvmSynchronous = true;
      generated.jvmStacklessRaster = true;
      return generated;
    } catch (_) {
      return null;
    }
  }

  computeStackDepths(codeItems, labels, method = null) {
    this.lastStackDepthError = null;
    const rejectDepths = (reason, index, op, details = null) => {
      this.lastStackDepthError = { reason, index, op, details };
      return null;
    };
    const depths = new Array(codeItems.length);
    let stackWidthsBefore = null;
    if (codeItems.some((item) => {
      const op = getOp(item && item.instruction);
      return op === "dup2" || op === "dup2_x2";
    })) {
      const code = method?.attributes?.find((attribute) =>
        attribute.type === "code");
      const analysis = buildSsa({
        codeItems,
        exceptionTable: code?.code?.exceptionTable || [],
        method,
      });
      if (!analysis || analysis.rejected || !analysis.stackKindsBefore) {
        return rejectDepths("category analysis failed", -1, null,
          analysis?.reason || null);
      }
      stackWidthsBefore = new Map();
      for (const [index, kinds] of analysis.stackKindsBefore) {
        stackWidthsBefore.set(index, kinds.map(kindWidth));
      }
    }
    const pending = [0];
    depths[0] = 0;
    const terminal = new Set([
      "areturn", "athrow", "dreturn", "freturn", "ireturn", "lreturn", "return",
    ]);
    while (pending.length) {
      const index = pending.pop();
      const instruction = codeItems[index] && codeItems[index].instruction;
      const op = getOp(instruction);
      const effect = stackEffect(
        instruction, stackWidthsBefore && stackWidthsBefore.get(index));
      if (effect === null) {
        return rejectDepths("unknown stack effect", index, op);
      }
      const after = depths[index] + effect;
      if (after < 0) {
        return rejectDepths("operand stack underflow", index, op, {
          before: depths[index], effect,
        });
      }
      const successors = [];
      if (op === "goto" || op === "goto_w") {
        successors.push(branchTargetIndex(instruction, labels));
      } else if (op && op.startsWith("if")) {
        successors.push(index + 1, branchTargetIndex(instruction, labels));
      } else if (op === "tableswitch") {
        for (const label of instruction.labels || []) {
          successors.push(labels.get(label));
        }
        successors.push(labels.get(instruction.defaultLbl));
      } else if (op === "lookupswitch") {
        for (const pair of instruction.arg?.pairs || []) {
          if (Array.isArray(pair)) successors.push(labels.get(pair[1]));
        }
        successors.push(labels.get(instruction.arg?.defaultLabel));
      } else if (!terminal.has(op) && index + 1 < codeItems.length) {
        successors.push(index + 1);
      }
      for (const successor of successors) {
        if (successor === undefined || successor < 0 ||
            successor >= codeItems.length) {
          return rejectDepths("invalid control-flow successor", index, op,
            { successor });
        }
        if (depths[successor] === undefined) {
          depths[successor] = after;
          pending.push(successor);
        } else if (depths[successor] !== after) {
          return rejectDepths("operand-stack join mismatch", index, op, {
            successor, expected: depths[successor], actual: after,
          });
        }
      }
    }
    return depths;
  }

  canCompileSynchronously(method) {
    // Every potentially asynchronous operation in a generated body has a
    // guarded synchronous probe and an exact-PC transient deopt. Class
    // constants used to be the sole blanket exclusion even when their target
    // was already loaded. They now follow the same guarded policy.
    return Boolean(method);
  }

  instructionNeedsPrecisePc(instruction) {
    const op = getOp(instruction);
    if (!op) return false;
    if (op.startsWith("invoke") || op === "athrow" || op === "checkcast" ||
        op === "getfield" || op === "putfield" || op === "getstatic" ||
        op === "putstatic" || op === "new" || op === "newarray" ||
        op === "anewarray" || op === "multianewarray" || op === "arraylength" ||
        op === "monitorenter" || op === "monitorexit" || op === "idiv" ||
        op === "irem" || op === "ldiv" || op === "lrem" ||
        op === "instanceof") return true;
    if (op.endsWith("aload") || op.endsWith("astore")) return true;
    return (op === "ldc" || op === "ldc_w") && isClassConstant(instruction.arg);
  }

  emitInstruction(instruction, index, stackWidthsBefore = null,
    callerMethod = null) {
    const op = getOp(instruction);
    const next = index + 1;
    // In normal execution, straight-line cases fall through to the next case
    // instead of returning to the while/switch dispatcher after every JVM
    // bytecode. Debug and breakpoint mode still redispatches each bytecode so
    // precise stepping and safe-point checks remain intact.
    const goNext = `if (bytecodeChecks) { pc = ${next}; break; }`;
    const target = (label) => this.targetInstructionIndex(instruction, label);
    const localIndex = (fallback) => Number(instruction.arg ?? fallback);

    switch (op) {
      case "aconst_null": return `stack[sp++] = null; ${goNext}`;
      case "aload": return `stack[sp++] = locals[${localIndex()}]; ${goNext}`;
      case "aload_0": return `stack[sp++] = locals[0]; ${goNext}`;
      case "aload_1": return `stack[sp++] = locals[1]; ${goNext}`;
      case "aload_2": return `stack[sp++] = locals[2]; ${goNext}`;
      case "aload_3": return `stack[sp++] = locals[3]; ${goNext}`;
      case "iload": return `stack[sp++] = locals[${localIndex()}]; ${goNext}`;
      case "iload_0": return `stack[sp++] = locals[0]; ${goNext}`;
      case "iload_1": return `stack[sp++] = locals[1]; ${goNext}`;
      case "iload_2": return `stack[sp++] = locals[2]; ${goNext}`;
      case "iload_3": return `stack[sp++] = locals[3]; ${goNext}`;
      case "dload": return `stack[sp++] = locals[${localIndex()}]; ${goNext}`;
      case "dload_0": return `stack[sp++] = locals[0]; ${goNext}`;
      case "dload_1": return `stack[sp++] = locals[1]; ${goNext}`;
      case "dload_2": return `stack[sp++] = locals[2]; ${goNext}`;
      case "dload_3": return `stack[sp++] = locals[3]; ${goNext}`;
      case "fload": return `stack[sp++] = locals[${localIndex()}]; ${goNext}`;
      case "fload_0": return `stack[sp++] = locals[0]; ${goNext}`;
      case "fload_1": return `stack[sp++] = locals[1]; ${goNext}`;
      case "fload_2": return `stack[sp++] = locals[2]; ${goNext}`;
      case "fload_3": return `stack[sp++] = locals[3]; ${goNext}`;
      case "lload": return `stack[sp++] = locals[${localIndex()}]; ${goNext}`;
      case "lload_0": return `stack[sp++] = locals[0]; ${goNext}`;
      case "lload_1": return `stack[sp++] = locals[1]; ${goNext}`;
      case "lload_2": return `stack[sp++] = locals[2]; ${goNext}`;
      case "lload_3": return `stack[sp++] = locals[3]; ${goNext}`;
      case "astore": return `locals[${localIndex()}] = stack[--sp]; ${goNext}`;
      case "astore_0": return `locals[0] = stack[--sp]; ${goNext}`;
      case "astore_1": return `locals[1] = stack[--sp]; ${goNext}`;
      case "astore_2": return `locals[2] = stack[--sp]; ${goNext}`;
      case "astore_3": return `locals[3] = stack[--sp]; ${goNext}`;
      case "istore": return `locals[${localIndex()}] = stack[--sp]; ${goNext}`;
      case "istore_0": return `locals[0] = stack[--sp]; ${goNext}`;
      case "istore_1": return `locals[1] = stack[--sp]; ${goNext}`;
      case "istore_2": return `locals[2] = stack[--sp]; ${goNext}`;
      case "istore_3": return `locals[3] = stack[--sp]; ${goNext}`;
      case "dstore": return `locals[${localIndex()}] = stack[--sp]; ${goNext}`;
      case "dstore_0": return `locals[0] = stack[--sp]; ${goNext}`;
      case "dstore_1": return `locals[1] = stack[--sp]; ${goNext}`;
      case "dstore_2": return `locals[2] = stack[--sp]; ${goNext}`;
      case "dstore_3": return `locals[3] = stack[--sp]; ${goNext}`;
      case "fstore": return `locals[${localIndex()}] = stack[--sp]; ${goNext}`;
      case "fstore_0": return `locals[0] = stack[--sp]; ${goNext}`;
      case "fstore_1": return `locals[1] = stack[--sp]; ${goNext}`;
      case "fstore_2": return `locals[2] = stack[--sp]; ${goNext}`;
      case "fstore_3": return `locals[3] = stack[--sp]; ${goNext}`;
      case "lstore": return `locals[${localIndex()}] = stack[--sp]; ${goNext}`;
      case "lstore_0": return `locals[0] = stack[--sp]; ${goNext}`;
      case "lstore_1": return `locals[1] = stack[--sp]; ${goNext}`;
      case "lstore_2": return `locals[2] = stack[--sp]; ${goNext}`;
      case "lstore_3": return `locals[3] = stack[--sp]; ${goNext}`;
      case "iconst_0": return `stack[sp++] = 0; ${goNext}`;
      case "iconst_m1": return `stack[sp++] = -1; ${goNext}`;
      case "iconst_1": return `stack[sp++] = 1; ${goNext}`;
      case "iconst_2": return `stack[sp++] = 2; ${goNext}`;
      case "iconst_3": return `stack[sp++] = 3; ${goNext}`;
      case "iconst_4": return `stack[sp++] = 4; ${goNext}`;
      case "iconst_5": return `stack[sp++] = 5; ${goNext}`;
      case "dconst_0": return `stack[sp++] = 0.0; ${goNext}`;
      case "dconst_1": return `stack[sp++] = 1.0; ${goNext}`;
      case "fconst_0": return `stack[sp++] = 0.0; ${goNext}`;
      case "fconst_1": return `stack[sp++] = 1.0; ${goNext}`;
      case "fconst_2": return `stack[sp++] = 2.0; ${goNext}`;
      case "lconst_0": return `stack[sp++] = 0n; ${goNext}`;
      case "lconst_1": return `stack[sp++] = 1n; ${goNext}`;
      case "bipush":
      case "sipush": return `stack[sp++] = ${Number(instruction.arg)}; ${goNext}`;
      case "ldc":
      case "ldc_w":
        if (isClassConstant(instruction.arg)) {
          if (this.compileSynchronous) {
            return `{ const value = helpers.classConstantSync(${JSON.stringify(instruction.arg[1])}); if (value === helpers.staticDeopt()) { helpers.materializeCached(frame, locals, stack, sp, ${index}); helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: "cold synchronous class constant" }; } stack[sp++] = value; } ${goNext}`;
          }
          return `stack[sp++] = await helpers.classConstant(${JSON.stringify(instruction.arg[1])}); ${goNext}`;
        }
        return `stack[sp++] = helpers.constantValue(${jsLiteral(instruction.arg)}); ${goNext}`;
      case "ldc2_w": return `stack[sp++] = helpers.constantValue(${jsLiteral(instruction.arg)}); ${goNext}`;
      case "dup": return `stack[sp] = stack[sp - 1]; sp += 1; ${goNext}`;
      case "dup_x1": return `{ const value1 = stack[--sp]; const value2 = stack[--sp]; stack[sp++] = value1; stack[sp++] = value2; stack[sp++] = value1; } ${goNext}`;
      case "dup_x2": {
        if (!stackWidthsBefore || stackWidthsBefore.length < 2) {
          return `helpers.materializeCached(frame, locals, stack, sp, ${index}); return { deopt: true, reason: "unverified dup_x2 stack widths" };`;
        }
        if (stackWidthsBefore[stackWidthsBefore.length - 2] === 2) {
          return `{ const value1 = stack[--sp]; const value2 = stack[--sp]; stack[sp++] = value1; stack[sp++] = value2; stack[sp++] = value1; } ${goNext}`;
        }
        return `{ const value1 = stack[--sp]; const value2 = stack[--sp]; const value3 = stack[--sp]; stack[sp++] = value1; stack[sp++] = value3; stack[sp++] = value2; stack[sp++] = value1; } ${goNext}`;
      }
      case "dup2": {
        const topIsCategory2 = stackWidthsBefore &&
          stackWidthsBefore[stackWidthsBefore.length - 1] === 2;
        if (topIsCategory2) {
          return `{ const value1 = stack[--sp]; stack[sp++] = value1; stack[sp++] = value1; } ${goNext}`;
        }
        return `{ const value1 = stack[--sp]; const value2 = stack[--sp]; stack[sp++] = value2; stack[sp++] = value1; stack[sp++] = value2; stack[sp++] = value1; } ${goNext}`;
      }
      case "dup2_x2": {
        if (!stackWidthsBefore || stackWidthsBefore.length < 2) {
          return `helpers.materializeCached(frame, locals, stack, sp, ${index}); return { deopt: true, reason: "unverified dup2_x2 stack widths" };`;
        }
        const top = stackWidthsBefore.length - 1;
        if (stackWidthsBefore[top] === 2) {
          if (stackWidthsBefore[top - 1] === 2) {
            // Form 4: ..., value2(category 2), value1(category 2)
            return `{ const value1 = stack[--sp]; const value2 = stack[--sp]; stack[sp++] = value1; stack[sp++] = value2; stack[sp++] = value1; } ${goNext}`;
          }
          if (stackWidthsBefore.length < 3 ||
              stackWidthsBefore[top - 1] !== 1 ||
              stackWidthsBefore[top - 2] !== 1) {
            return `helpers.materializeCached(frame, locals, stack, sp, ${index}); return { deopt: true, reason: "invalid dup2_x2 form 3" };`;
          }
          // Form 3: ..., value3(category 1), value2(category 1),
          // value1(category 2)
          return `{ const value1 = stack[--sp]; const value2 = stack[--sp]; const value3 = stack[--sp]; stack[sp++] = value1; stack[sp++] = value3; stack[sp++] = value2; stack[sp++] = value1; } ${goNext}`;
        }
        if (stackWidthsBefore[top] !== 1 ||
            stackWidthsBefore[top - 1] !== 1 ||
            stackWidthsBefore.length < 3) {
          return `helpers.materializeCached(frame, locals, stack, sp, ${index}); return { deopt: true, reason: "invalid dup2_x2 top pair" };`;
        }
        if (stackWidthsBefore[top - 2] === 2) {
          // Form 2: ..., value3(category 2), value2(category 1),
          // value1(category 1)
          return `{ const value1 = stack[--sp]; const value2 = stack[--sp]; const value3 = stack[--sp]; stack[sp++] = value2; stack[sp++] = value1; stack[sp++] = value3; stack[sp++] = value2; stack[sp++] = value1; } ${goNext}`;
        }
        if (stackWidthsBefore.length < 4 ||
            stackWidthsBefore[top - 2] !== 1 ||
            stackWidthsBefore[top - 3] !== 1) {
          return `helpers.materializeCached(frame, locals, stack, sp, ${index}); return { deopt: true, reason: "invalid dup2_x2 form 1" };`;
        }
        // Form 1: four category-1 values.
        return `{ const value1 = stack[--sp]; const value2 = stack[--sp]; const value3 = stack[--sp]; const value4 = stack[--sp]; stack[sp++] = value2; stack[sp++] = value1; stack[sp++] = value4; stack[sp++] = value3; stack[sp++] = value2; stack[sp++] = value1; } ${goNext}`;
      }
      case "pop": return `sp -= 1; ${goNext}`;
      case "iadd": return `{ const b = stack[--sp]; stack[sp - 1] = (stack[sp - 1] + b) | 0; } ${goNext}`;
      case "isub": return `{ const b = stack[--sp]; stack[sp - 1] = (stack[sp - 1] - b) | 0; } ${goNext}`;
      case "imul": return `{ const b = stack[--sp]; stack[sp - 1] = Math.imul(stack[sp - 1], b); } ${goNext}`;
      case "ineg": return `stack[sp - 1] = (-stack[sp - 1]) | 0; ${goNext}`;
      case "ixor": return `{ const b = stack[--sp]; stack[sp - 1] ^= b; } ${goNext}`;
      case "iand": return `{ const b = stack[--sp]; stack[sp - 1] &= b; } ${goNext}`;
      case "ior": return `{ const b = stack[--sp]; stack[sp - 1] |= b; } ${goNext}`;
      case "irem": return `{ const b = stack[--sp]; if (b === 0) throw { type: "java/lang/ArithmeticException", message: "/ by zero" }; stack[sp - 1] = (stack[sp - 1] % b) | 0; } ${goNext}`;
      case "ishl": return `{ const shift = stack[--sp]; stack[sp - 1] <<= shift & 31; } ${goNext}`;
      case "ishr": return `{ const shift = stack[--sp]; stack[sp - 1] >>= shift & 31; } ${goNext}`;
      case "iushr": return `{ const shift = stack[--sp]; stack[sp - 1] = (stack[sp - 1] >>> (shift & 31)) | 0; } ${goNext}`;
      case "idiv": return `{ const b = stack[--sp]; if (b === 0) throw { type: "java/lang/ArithmeticException", message: "/ by zero" }; stack[sp - 1] = (stack[sp - 1] / b) | 0; } ${goNext}`;
      case "dadd": return `{ const b = stack[--sp]; stack[sp - 1] += b; } ${goNext}`;
      case "dsub": return `{ const b = stack[--sp]; stack[sp - 1] -= b; } ${goNext}`;
      case "dmul": return `{ const b = stack[--sp]; stack[sp - 1] *= b; } ${goNext}`;
      case "ddiv": return `{ const b = stack[--sp]; stack[sp - 1] /= b; } ${goNext}`;
      case "dneg": return `stack[sp - 1] = -stack[sp - 1]; ${goNext}`;
      case "fadd": return `{ const b = stack[--sp]; stack[sp - 1] = Math.fround(stack[sp - 1] + b); } ${goNext}`;
      case "fsub": return `{ const b = stack[--sp]; stack[sp - 1] = Math.fround(stack[sp - 1] - b); } ${goNext}`;
      case "fmul": return `{ const b = stack[--sp]; stack[sp - 1] = Math.fround(stack[sp - 1] * b); } ${goNext}`;
      case "fdiv": return `{ const b = stack[--sp]; stack[sp - 1] = Math.fround(stack[sp - 1] / b); } ${goNext}`;
      case "frem": return `{ const b = stack[--sp]; stack[sp - 1] = Math.fround(stack[sp - 1] % b); } ${goNext}`;
      // Doubles need no rounding step, unlike frem above: JS % on two doubles
      // already matches the JVM's drem for every finite and non-finite case.
      case "drem": return `{ const b = stack[--sp]; stack[sp - 1] = stack[sp - 1] % b; } ${goNext}`;
      case "fneg": return `stack[sp - 1] = Math.fround(-stack[sp - 1]); ${goNext}`;
      case "i2d": return goNext;
      case "i2b": return `stack[sp - 1] = (stack[sp - 1] << 24) >> 24; ${goNext}`;
      case "i2s": return `stack[sp - 1] = (stack[sp - 1] << 16) >> 16; ${goNext}`;
      case "i2c": return `stack[sp - 1] = stack[sp - 1] & 0xffff; ${goNext}`;
      case "i2l": return `stack[sp - 1] = BigInt(stack[sp - 1]); ${goNext}`;
      case "i2f": return `stack[sp - 1] = Math.fround(stack[sp - 1]); ${goNext}`;
      case "f2d": return goNext;
      case "d2f": return `stack[sp - 1] = Math.fround(stack[sp - 1]); ${goNext}`;
      case "f2i": return `stack[sp - 1] = helpers.floatToInt(stack[sp - 1]); ${goNext}`;
      case "d2i": return `stack[sp - 1] = Math.trunc(stack[sp - 1]) | 0; ${goNext}`;
      // Long operands are BigInt on the fast path but may arrive as plain
      // Number 0 (uninitialized long fields); the interpreter wraps every
      // operand in BigInt() before operating, and mixing throws in JS, so the
      // generated tier must convert identically.
      case "l2i": return `{ const value = stack[sp - 1]; stack[sp - 1] = Number(BigInt.asIntN(32, typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value))))); } ${goNext}`;
      // Number() widens a BigInt long and leaves an already-Number long
      // (uninitialized field) alone, so no typeof branch is needed here.
      case "l2d": return `stack[sp - 1] = Number(stack[sp - 1]); ${goNext}`;
      case "lxor": return `{ const b = stack[--sp]; stack[sp - 1] = BigInt.asIntN(64, BigInt(stack[sp - 1]) ^ BigInt(b)); } ${goNext}`;
      case "ladd": return `{ const b = stack[--sp]; stack[sp - 1] = BigInt.asIntN(64, BigInt(stack[sp - 1]) + BigInt(b)); } ${goNext}`;
      case "lsub": return `{ const b = stack[--sp]; stack[sp - 1] = BigInt.asIntN(64, BigInt(stack[sp - 1]) - BigInt(b)); } ${goNext}`;
      case "land": return `{ const b = stack[--sp]; stack[sp - 1] = BigInt.asIntN(64, BigInt(stack[sp - 1]) & BigInt(b)); } ${goNext}`;
      case "lor": return `{ const b = stack[--sp]; stack[sp - 1] = BigInt.asIntN(64, BigInt(stack[sp - 1]) | BigInt(b)); } ${goNext}`;
      case "lneg": return `stack[sp - 1] = BigInt.asIntN(64, -BigInt(stack[sp - 1])); ${goNext}`;
      case "lshl": return `{ const shift = stack[--sp]; stack[sp - 1] = BigInt.asIntN(64, BigInt(stack[sp - 1]) << (BigInt(shift) & 63n)); } ${goNext}`;
      case "lushr": return `{ const shift = stack[--sp]; stack[sp - 1] = BigInt.asIntN(64, BigInt.asUintN(64, BigInt(stack[sp - 1])) >> (BigInt(shift) & 63n)); } ${goNext}`;
      case "lrem": return `{ const b = BigInt(stack[--sp]); if (b === 0n) throw { type: "java/lang/ArithmeticException", message: "/ by zero" }; stack[sp - 1] = BigInt.asIntN(64, BigInt(stack[sp - 1]) % b); } ${goNext}`;
      case "ldiv": return `{ const b = BigInt(stack[--sp]); if (b === 0n) throw { type: "java/lang/ArithmeticException", message: "/ by zero" }; stack[sp - 1] = BigInt.asIntN(64, BigInt(stack[sp - 1]) / b); } ${goNext}`;
      case "lmul": return `{ const b = stack[--sp]; stack[sp - 1] = BigInt.asIntN(64, BigInt(stack[sp - 1]) * BigInt(b)); } ${goNext}`;
      case "lshr": return `{ const shift = stack[--sp]; stack[sp - 1] = BigInt.asIntN(64, BigInt(stack[sp - 1]) >> (BigInt(shift) & 63n)); } ${goNext}`;
      case "lcmp": return `{ const b = BigInt(stack[--sp]); const a = BigInt(stack[sp - 1]); stack[sp - 1] = a < b ? -1 : (a > b ? 1 : 0); } ${goNext}`;
      case "iinc": return `locals[${Number(instruction.varnum)}] = (locals[${Number(instruction.varnum)}] + ${Number(instruction.incr)}) | 0; ${goNext}`;
      case "dcmpg": return `{ const b = stack[--sp]; stack[sp - 1] = helpers.compareDouble(b, stack[sp - 1], 1); } ${goNext}`;
      case "dcmpl": return `{ const b = stack[--sp]; stack[sp - 1] = helpers.compareDouble(b, stack[sp - 1], -1); } ${goNext}`;
      case "newarray": return `stack[sp - 1] = helpers.newPrimitiveArray(stack[sp - 1], ${JSON.stringify(instruction.arg)}); ${goNext}`;
      case "anewarray": return `stack[sp - 1] = helpers.newReferenceArray(stack[sp - 1], ${JSON.stringify(instruction.arg)}); ${goNext}`;
      case "arraylength": return `stack[sp - 1] = helpers.arrayLength(stack[sp - 1], frame); ${goNext}`;
      case "checkcast":
        if (this.compileSynchronous) {
          return `{ const value = stack[sp - 1]; if (value !== null && value !== undefined) { const source = ${generatedRuntimeClassNameExpression("value")}; if (source !== ${JSON.stringify(instruction.arg)}) { const cast = helpers.tryCheckCastSourceSync(source, ${JSON.stringify(instruction.arg)}); if (cast === helpers.asyncInvokeSentinel()) { helpers.materializeCached(frame, locals, stack, sp, ${index}); helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: "cold synchronous checkcast" }; } } } } ${goNext}`;
        }
        return `{ const value = stack[sp - 1]; await helpers.checkCast(value, ${JSON.stringify(instruction.arg)}); } ${goNext}`;
      case "instanceof":
        if (this.compileSynchronous) {
          return `{ const result = helpers.tryInstanceOfSync(stack[sp - 1], ${JSON.stringify(instruction.arg)}); if (result === helpers.asyncInvokeSentinel()) { helpers.materializeCached(frame, locals, stack, sp, ${index}); helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: "cold synchronous instanceof" }; } stack[sp - 1] = result; } ${goNext}`;
        }
        return `stack[sp - 1] = await helpers.instanceOf(stack[sp - 1], ${JSON.stringify(instruction.arg)}); ${goNext}`;
      case "aaload":
      case "iaload":
      case "daload":
      case "faload":
      case "baload":
      case "caload":
      case "laload":
      case "saload": {
        const rawValue = "arrayData[index]";
        const normalized = {
          baload: `(array.type === "[Z" || array.elementType === "boolean") ? (${rawValue} ? 1 : 0) : ((Number(${rawValue}) << 24) >> 24)`,
          caload: `(Number(${rawValue}) & 0xffff)`,
          saload: `((Number(${rawValue}) << 16) >> 16)`,
          iaload: `(Number(${rawValue}) | 0)`,
          faload: `Math.fround(Number(${rawValue}))`,
          laload: `BigInt.asIntN(64, BigInt(${rawValue}))`,
          aaload: rawValue,
          daload: rawValue,
        }[op] || rawValue;
        // Array representation is normally monomorphic at an individual JVM
        // bytecode. Keep the checked fast access at that generated site rather
        // than routing every element through one megamorphic helper. The slow
        // path still owns exact JVM exceptions and optional diagnostics.
        return `{ const index = stack[--sp]; const array = stack[sp - 1]; if (array === null || array === undefined || (index >>> 0) >= array.length) { stack[sp - 1] = helpers.arrayLoad(index, array, frame, ${JSON.stringify(op)}); } else { const arrayData = array.elements || array; stack[sp - 1] = ${normalized}; } } ${goNext}`;
      }
      case "aastore":
      case "iastore":
      case "dastore":
      case "fastore":
      case "bastore":
      case "castore":
      case "lastore":
      case "sastore": {
        const narrowed = {
          bastore: `(array.type === "[Z" || array.elementType === "boolean") ? (Number(value) & 1) : ((Number(value) << 24) >> 24)`,
          castore: `(Number(value) & 0xffff)`,
          sastore: `((Number(value) << 16) >> 16)`,
          iastore: `(Number(value) | 0)`,
          fastore: `Math.fround(Number(value))`,
          lastore: `BigInt.asIntN(64, BigInt(value))`,
          aastore: "value",
          dastore: "value",
        }[op] || "value";
        return `{ const value = stack[--sp]; const index = stack[--sp]; const array = stack[--sp]; if (array === null || array === undefined || (index >>> 0) >= array.length) { helpers.arrayStore(value, index, array, frame, ${JSON.stringify(op)}); } else { const arrayData = array.elements || array; arrayData[index] = ${narrowed}; } } ${goNext}`;
      }
      case "getfield": {
        const fieldSiteId = this.registerFieldSite(instruction.arg);
        const site = this.fieldSites[fieldSiteId];
        if (site.directInstanceKey) {
          const key = JSON.stringify(site.directInstanceKey);
          return `{ const object = stack[sp - 1]; stack[sp - 1] = ` +
            `(object !== null && object !== undefined && object.fields && ` +
            `object.fields[${key}] !== undefined) ? object.fields[${key}] : ` +
            `helpers.getFieldAt(${fieldSiteId}, object); } ${goNext}`;
        }
        return `stack[sp - 1] = helpers.getFieldAt(${fieldSiteId}, stack[sp - 1]); ${goNext}`;
      }
      case "putfield": {
        const fieldSiteId = this.registerFieldSite(instruction.arg);
        const site = this.fieldSites[fieldSiteId];
        if (site.directInstanceKey) {
          const key = JSON.stringify(site.directInstanceKey);
          const fieldName = JSON.stringify(site.fieldName);
          return `{ const value = stack[--sp]; const object = stack[--sp]; ` +
            `if (object !== null && object !== undefined && object.fields && ` +
            `${key} in object.fields) { ` +
            `object.fields[${key}] = value; object[${fieldName}] = value; ` +
            `} else { helpers.putFieldAt(${fieldSiteId}, object, value); } } ${goNext}`;
        }
        return `{ const value = stack[--sp]; helpers.putFieldAt(${fieldSiteId}, stack[--sp], value); } ${goNext}`;
      }
      case "getstatic":
        if (this.compileSynchronous) {
          const fieldSiteId = this.registerFieldSite(instruction.arg);
          const direct = this.registerDirectStaticTarget(fieldSiteId);
          if (direct) {
            const target = `helpers.directStaticTargets[${direct.targetId}]`;
            const read = direct.kind === "map"
              ? `${target}.fields.get(${JSON.stringify(direct.key)})`
              : `${target}.fields[${JSON.stringify(direct.key)}]`;
            return `{ const target = ${target}; if (!target.initializationToken.initialized) { ` +
              `helpers.materializeCached(frame, locals, stack, sp, ${index}); ` +
              `helpers.skipJitOnce(frame); return { deopt: true, transient: true, ` +
              `reason: "class initialization at direct synchronous getstatic" }; } ` +
              `stack[sp++] = ${read}; } ${goNext}`;
          }
          return `{ const value = helpers.getStaticSyncAt(${fieldSiteId}); if (value === helpers.staticDeopt()) { helpers.materializeCached(frame, locals, stack, sp, ${index}); helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: "class initialization at synchronous getstatic" }; } stack[sp++] = value; } ${goNext}`;
        }
        return `{ let value = helpers.getStatic(${JSON.stringify(instruction.arg)}, thread); if (value && typeof value.then === "function") value = await value; if (value === helpers.staticDeopt()) { helpers.materializeCached(frame, locals, stack, sp, ${index}); return { deopt: true, transient: true, reason: "class initialization at generated getstatic" }; } stack[sp++] = value; } ${goNext}`;
      case "putstatic":
        if (this.compileSynchronous) {
          const fieldSiteId = this.registerFieldSite(instruction.arg);
          const direct = this.registerDirectStaticTarget(fieldSiteId, true);
          if (direct?.kind === "map") {
            const target = `helpers.directStaticTargets[${direct.targetId}]`;
            return `{ const target = ${target}; if (!target.initializationToken.initialized) { ` +
              `helpers.materializeCached(frame, locals, stack, sp, ${index}); ` +
              `helpers.skipJitOnce(frame); return { deopt: true, transient: true, ` +
              `reason: "class initialization at direct synchronous putstatic" }; } ` +
              `target.fields.set(${JSON.stringify(direct.key)}, stack[--sp]); ` +
              `if (target.versionCell.captureCaches) ` +
              `helpers.markStaticTargetChanged(target); } ${goNext}`;
          }
          return `{ const changed = helpers.putStaticSyncAt(${fieldSiteId}, stack[sp - 1]); if (changed === helpers.staticDeopt()) { helpers.materializeCached(frame, locals, stack, sp, ${index}); helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: "class initialization at synchronous putstatic" }; } sp -= 1; } ${goNext}`;
        }
        return `{ let changed = helpers.putStatic(${JSON.stringify(instruction.arg)}, stack[sp - 1], thread); if (changed && typeof changed.then === "function") changed = await changed; if (changed === helpers.staticDeopt()) { helpers.materializeCached(frame, locals, stack, sp, ${index}); return { deopt: true, transient: true, reason: "class initialization at generated putstatic" }; } sp -= 1; } ${goNext}`;
      case "new":
        if (this.compileSynchronous) {
          return `{ const value = helpers.newObjectSync(${JSON.stringify(instruction.arg)}); if (value === helpers.staticDeopt()) { helpers.materializeCached(frame, locals, stack, sp, ${index}); helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: "class initialization at synchronous new" }; } stack[sp++] = value; } ${goNext}`;
        }
        return `{ const value = await helpers.newObject(${JSON.stringify(instruction.arg)}, thread); if (value === helpers.staticDeopt()) { helpers.materializeCached(frame, locals, stack, sp, ${index}); return { deopt: true, transient: true, reason: "class initialization at generated new" }; } stack[sp++] = value; } ${goNext}`;
      case "monitorenter": return `{ const monitor = stack[sp - 1]; if (!helpers.monitorEnter(monitor, thread)) { helpers.materializeCached(frame, locals, stack, sp, ${index}); return { deopt: true, transient: true, reason: "contended generated monitorenter" }; } sp -= 1; } ${goNext}`;
      case "monitorexit": return `helpers.monitorExit(stack[--sp], thread); ${goNext}`;
      case "invokestatic":
      case "invokevirtual":
      case "invokeinterface":
      case "invokespecial":
        if (this.compileSynchronous) {
          const directJre = this.getCompileTimeDirectJre(op, instruction);
          if (directJre) {
            const result = directJre.returnsVoid
              ? ""
              : "stack[sp++] = directResult;";
            const args = Array.from({ length: directJre.argumentCount }, (_unused, offset) =>
              `stack[directBase + ${offset}]`).join(", ");
            const initializationGuard = directJre.isStatic
              ? `if (!helpers.directJreInitializationTokens[${directJre.id}].initialized) { ` +
                `helpers.materializeCached(frame, locals, stack, sp, ${index}); ` +
                `helpers.skipJitOnce(frame); return { deopt: true, transient: true, ` +
                `reason: "class initialization at direct synchronous JRE call" }; } `
              : "";
            return `{ ${initializationGuard}const directBase = sp - ${directJre.argumentCount}; const directResult = helpers.directJreIntrinsics[${directJre.id}](${args}); sp = directBase; ${result} } ${goNext}`;
          }
          const directInline = op === "invokestatic" && !this.profileMethods
            ? this.getCompileTimeIntegerLeaf(instruction)
            : null;
          if (directInline) {
            this.compileDirectInlineCount += 1;
            const base = `inlineBase${this.compileDirectInlineCount}`;
            const substituteBase = (source) => source.split("base").join(base);
            const statements = directInline.statements
              .map(substituteBase).join(" ");
            const result = substituteBase(directInline.result);
            const guard = directInline.guards?.length
              ? directInline.guards.map((condition) =>
                `(${substituteBase(condition)})`).join(" && ")
              : null;
            const guardFailure = guard
              ? `if (!(${guard})) { helpers.materializeCached(frame, locals, stack, sp, ${index}); helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: "guarded direct integer inline" }; }`
              : "";
            return `{ if (bytecodeChecks) { helpers.materializeCached(frame, locals, stack, sp, ${index}); helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: "debuggable direct integer inline" }; } const ${base} = sp - ${directInline.paramCount}; ${statements} ${guardFailure} stack[${base}] = ${result}; sp = ${base} + 1; } ${goNext}`;
          }
          const callSiteId = this.registerSyncCallSite(
            op, instruction, callerMethod, index);
          const traceCall = this.compileTraceSyncCalls
            ? `helpers.traceSyncCallAt(${callSiteId}, frame, thread, value, sp);`
            : "";
          return `{ helpers.materializeCached(frame, locals, stack, sp, ${next}); const value = helpers.tryInvokeSyncAt(${callSiteId}, frame, thread); ${traceCall} if (value === helpers.asyncInvokeSentinel()) { const activeChild = thread.callStack.items[thread.callStack.items.length - 1]; if (activeChild !== frame && activeChild && activeChild.jitGeneratedReturnParent === frame) { return { deopt: true, transient: true, reason: "asynchronous ${op} left active child" }; } helpers.materializeCached(frame, locals, stack, sp, ${index}); helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: "asynchronous callee from synchronous ${op}" }; } if (value && value.deopt) return value; sp = stack.length; if (thread.callStack.items[thread.callStack.items.length - 1] !== frame) { return { deopt: true, transient: true, reason: "synchronous ${op} left active child" }; } if (value !== helpers.returnVoid()) stack[sp++] = value; if (thread.status !== "runnable") return { deopt: true, transient: true, reason: "thread yielded in synchronous ${op}" }; } ${goNext}`;
        }
        {
          // Async-capable generated bodies still execute the overwhelming
          // majority of their calls synchronously. Give them the same stable
          // call-site record as synchronous bodies. The previous path created
          // a fresh site and rebound an identical positional adapter on every
          // invocation; only the genuine async fallback needs the serialized
          // instruction below.
          const callSiteId = this.registerSyncCallSite(
            op, instruction, callerMethod, index);
          return `{ helpers.materializeCached(frame, locals, stack, sp, ${next}); let value = helpers.tryInvokeSyncAt(${callSiteId}, frame, thread); if (value === helpers.asyncInvokeSentinel()) value = await helpers.invoke(${JSON.stringify(op)}, frame, ${JSON.stringify(instruction)}, thread, ${index}); if (value && value.deopt) return value; sp = stack.length; if (value !== helpers.returnVoid()) stack[sp++] = value; if (thread.status !== "runnable") { helpers.materializeCached(frame, locals, stack, sp, ${next}); return { deopt: true, reason: "thread yielded in generated ${op}" }; } } ${goNext}`;
        }
      case "goto": return `pc = ${target(instruction.arg)}; break;`;
      case "ifeq": return `if (stack[--sp] === 0) pc = ${target(instruction.arg)}; else pc = ${next}; break;`;
      case "ifne": return `if (stack[--sp] !== 0) pc = ${target(instruction.arg)}; else pc = ${next}; break;`;
      case "iflt": return `if (stack[--sp] < 0) pc = ${target(instruction.arg)}; else pc = ${next}; break;`;
      case "ifge": return `if (stack[--sp] >= 0) pc = ${target(instruction.arg)}; else pc = ${next}; break;`;
      case "ifgt": return `if (stack[--sp] > 0) pc = ${target(instruction.arg)}; else pc = ${next}; break;`;
      case "ifle": return `if (stack[--sp] <= 0) pc = ${target(instruction.arg)}; else pc = ${next}; break;`;
      case "ifnull": return `if (stack[--sp] === null) pc = ${target(instruction.arg)}; else pc = ${next}; break;`;
      case "ifnonnull": return `if (stack[--sp] !== null) pc = ${target(instruction.arg)}; else pc = ${next}; break;`;
      case "if_icmpeq": return `{ const b = stack[--sp]; const a = stack[--sp]; if (a === b) pc = ${target(instruction.arg)}; else pc = ${next}; } break;`;
      case "if_icmpne": return `{ const b = stack[--sp]; const a = stack[--sp]; if (a !== b) pc = ${target(instruction.arg)}; else pc = ${next}; } break;`;
      case "if_icmplt": return `{ const b = stack[--sp]; const a = stack[--sp]; if (a < b) pc = ${target(instruction.arg)}; else pc = ${next}; } break;`;
      case "if_icmpge": return `{ const b = stack[--sp]; const a = stack[--sp]; if (a >= b) pc = ${target(instruction.arg)}; else pc = ${next}; } break;`;
      case "if_icmpgt": return `{ const b = stack[--sp]; const a = stack[--sp]; if (a > b) pc = ${target(instruction.arg)}; else pc = ${next}; } break;`;
      case "if_icmple": return `{ const b = stack[--sp]; const a = stack[--sp]; if (a <= b) pc = ${target(instruction.arg)}; else pc = ${next}; } break;`;
      case "if_acmpeq": return `{ const b = stack[--sp]; const a = stack[--sp]; if (a === b) pc = ${target(instruction.arg)}; else pc = ${next}; } break;`;
      case "if_acmpne": return `{ const b = stack[--sp]; const a = stack[--sp]; if (a !== b) pc = ${target(instruction.arg)}; else pc = ${next}; } break;`;
      case "athrow": return `throw stack[--sp];`;
      case "return":
        return `{ if (thread.callStack.items[thread.callStack.items.length - 1] !== frame) { helpers.materializeCached(frame, locals, stack, sp, ${index}); helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: "generated return with active child" }; } helpers.materializeCached(frame, locals, stack, sp, ${next}); thread.callStack.pop(); return { returned: true, value: helpers.returnVoid() }; }`;
      case "areturn":
      case "ireturn":
      case "lreturn":
      case "freturn":
      case "dreturn":
        return `{ if (thread.callStack.items[thread.callStack.items.length - 1] !== frame) { helpers.materializeCached(frame, locals, stack, sp, ${index}); helpers.skipJitOnce(frame); return { deopt: true, transient: true, reason: "generated return with active child" }; } const ret = stack[--sp]; helpers.materializeCached(frame, locals, stack, sp, ${next}); thread.callStack.pop(); return { returned: true, value: ret }; }`;
      default:
        return `helpers.materializeCached(frame, locals, stack, sp, ${index}); return { deopt: true, reason: "unsupported generated opcode ${op}" };`;
    }
  }

  targetInstructionIndex(instruction, label) {
    const labels = this.compileLabelMap;
    const index = labels && labels.get(label);
    if (index === undefined) {
      throw new Error(`Label ${label} not found`);
    }
    return index;
  }

  // OSR probe shared by the runner and generated code: a frame that has been
  // interpreting for thousands of bytecodes is exactly the kind the wasm tier
  // wants (single-invocation loop monsters like va.d never re-enter through
  // invoke()). prepare() warms/compiles regardless of position; entering
  // mid-method is only sound at a supported block leader with an empty
  // operand stack.
  wasmOsrProbe(frame, thread, pc, stackLength) {
    if (!this.wasmJit.enabled) return null;
    frame.pc = pc;
    const prep = this.wasmJit.prepare(frame);
    if (!prep || stackLength !== 0) return null;
    const module = prep.osr === true && prep.st.osr
      ? prep.st.osr : prep.st;
    // An OSR caller is already live in generated JavaScript. A partial Wasm
    // module may exit after a call at a continuation with carried operands;
    // resuming the still-active JS body would then duplicate scheduler
    // ownership or lose the callee's return value. Partial modules remain
    // valid as ordinary Frame entries, where execute() returns directly to
    // the scheduler. OSR is restricted to modules that cannot take such an
    // exit, independent of any guest method identity.
    if (!module.meta.fullyCompiled || module.meta.deoptableCalls > 0) {
      return null;
    }
    let result;
    const snapshotDir = this.debugOsrSnapshotDir;
    let entrySnapshot = null;
    if (snapshotDir) {
      try {
        const seen = new Map();
        let nextId = 1;
        const encode = (held, depth) => {
          if (held === null || held === undefined) return null;
          if (typeof held === "bigint") return { __big: String(held) };
          if (typeof held !== "object") return held;
          if (seen.has(held)) return { __ref: seen.get(held) };
          const id = nextId++;
          seen.set(held, id);
          if (Array.isArray(held) || ArrayBuffer.isView(held)) {
            return { __id: id,
              __typed: held.constructor ? held.constructor.name : "Array",
              __arr: depth > 6 ? [] : Array.from(held,
                (entry) => encode(entry, depth + 1)) };
          }
          const fields = {};
          if (held.fields && depth <= 6) {
            for (const [key, value] of Object.entries(held.fields)) {
              fields[key] = encode(value, depth + 1);
            }
          }
          return { __id: id, __guest: held.type || held._className || null,
            fields };
        };
        entrySnapshot = { pc,
          locals: frame.locals.map((held) => encode(held, 0)) };
      } catch (snapshotError) {
        entrySnapshot = { error: String(snapshotError) };
      }
    }
    try {
      // prep.blk indexes the module prepare() selected: the companion OSR
      // module when prep.osr is set. execute() picks the module from its osr
      // flag, so dropping it here ran the STRUCTURED PRIMARY at the
      // companion's block id — a wrong entry point that silently corrupted
      // state (kr.e's bzip2 selector on Tomb Racer, AIOOBE 6/6 downstream).
      result = this.wasmJit.execute(
        frame, thread, prep.st, prep.blk, true, prep.osr === true);
    } catch (error) {
      if (snapshotDir && entrySnapshot) {
        try {
          const fs = require("fs");
          fs.writeFileSync(`${snapshotDir}/osr-snapshot-${frame.className}.json`,
            JSON.stringify(entrySnapshot));
        } catch (writeError) {
          console.error("[osr-snapshot-write-failed]", String(writeError));
        }
      }
      if (typeof process !== "undefined" && process.env &&
          process.env.JVM_DEBUG_ARRAY_OOB === "1") {
        console.error("[wasm-osr-throw]", JSON.stringify({
          method: `${frame.className || "?"}.${frame.method?.name || "?"}${
            frame.method?.descriptor || ""}`,
          entryPc: pc,
          entryBlock: prep.blk,
          osrModule: prep.osr === true,
          error: error && (error.message ||
            (error.type ? `${error.type}: ${error.message}` : String(error))),
          locals: (frame.locals || []).map((held) =>
            held && typeof held === "object"
              ? (Array.isArray(held) || ArrayBuffer.isView(held)
                ? `[${held.length}]` : `<${held.type || "object"}>`)
              : held),
        }));
      }
      throw error;
    }
    const tracePattern = this.wasmJit.traceMethodPattern || "";
    const identity = tracePattern
      ? `${frame.className || "?"}.${frame.method?.name || "?"}${
        frame.method?.descriptor || ""}` : "";
    if (tracePattern && identity.includes(tracePattern)) {
      const top = thread.callStack.isEmpty() ? null : thread.callStack.peek();
      console.error("[wasmjit-osr-probe] " + JSON.stringify({
        method: identity, entryPc: pc, resumePc: frame.pc,
        entryStackDepth: stackLength, exitStackDepth: frame.stack.items.length,
        returned: result.returned === true, deopted: result.deopted === true,
        top: top ? `${top.className || "?"}.${top.method?.name || "?"}${
          top.method?.descriptor || ""}` : null,
        callerOwnsStack: top === frame,
      }));
    }
    if (result.returned) {
      // `module` is the meta execute() actually ran (companion when
      // prep.osr) — its box holds the return value, not the primary's.
      return {
        returned: true,
        value: module.meta.retChar === "V" ? RETURN_VOID : module.meta.box.ret,
      };
    }
    if (result.deopted || !thread.callStack.isEmpty() &&
        thread.callStack.peek() !== frame) {
      return { deopted: true, resumePc: frame.pc };
    }
    return { resumePc: frame.pc };
  }

  async runFrame(frame, thread) {
    if (this.profileMethods) {
      this.runnerRunCount += 1;
      this.recordExecution(this.runnerMethodRunCounts, frame);
    }
    const locals = frame.locals;
    const stack = frame.stack.items;
    const instructions = frame.instructions;
    let pc = frame.pc;
    let bytecodesUntilYield = 100000;
    // Prime stride so successive probes land on different pcs of a loop body —
    // a fixed multiple of the body length would hit the same (possibly
    // non-leader, non-empty-stack) offset forever.
    let bytecodesUntilOsrProbe = 10007;

    while (pc < instructions.length) {
      bytecodesUntilYield -= 1;
      bytecodesUntilOsrProbe -= 1;
      if (bytecodesUntilOsrProbe === 0) {
        bytecodesUntilOsrProbe = 10007;
        this.materialize(frame, locals, stack, pc);
        const osr = this.wasmOsrProbe(frame, thread, pc, stack.length);
        if (osr) {
          if (osr.returned) return { returned: true, value: osr.value };
          if (osr.deopted) {
            return {
              deopt: true, transient: true,
              reason: 'wasm OSR left active child',
            };
          }
          pc = osr.resumePc; // transient exit: resume interpreting there
        }
      }
      if (bytecodesUntilYield === 0) {
        this.materialize(frame, locals, stack, pc);
        await yieldToEventLoop();
        bytecodesUntilYield = 100000;
      }
      if (this.shouldDeopt(frame, pc)) {
        this.materialize(frame, locals, stack, pc);
        return { deopt: true };
      }

      const item = instructions[pc];
      const instruction = item.instruction;
      pc += 1;
      if (!instruction) {
        continue;
      }

      const op = typeof instruction === "string" ? instruction : instruction.op;
      this.materialize(frame, locals, stack, pc - 1);
      switch (op) {
        case "aconst_null": stack.push(null); break;
        case "aload": stack.push(locals[Number(instruction.arg)]); break;
        case "aload_0": stack.push(locals[0]); break;
        case "aload_1": stack.push(locals[1]); break;
        case "aload_2": stack.push(locals[2]); break;
        case "aload_3": stack.push(locals[3]); break;
        case "iload": stack.push(locals[Number(instruction.arg)]); break;
        case "iload_0": stack.push(locals[0]); break;
        case "iload_1": stack.push(locals[1]); break;
        case "iload_2": stack.push(locals[2]); break;
        case "iload_3": stack.push(locals[3]); break;
        case "dload": stack.push(locals[Number(instruction.arg)]); break;
        case "dload_0": stack.push(locals[0]); break;
        case "dload_1": stack.push(locals[1]); break;
        case "dload_2": stack.push(locals[2]); break;
        case "dload_3": stack.push(locals[3]); break;
        case "fload": stack.push(locals[Number(instruction.arg)]); break;
        case "fload_0": stack.push(locals[0]); break;
        case "fload_1": stack.push(locals[1]); break;
        case "fload_2": stack.push(locals[2]); break;
        case "fload_3": stack.push(locals[3]); break;
        case "astore": locals[Number(instruction.arg)] = stack.pop(); break;
        case "astore_0": locals[0] = stack.pop(); break;
        case "astore_1": locals[1] = stack.pop(); break;
        case "astore_2": locals[2] = stack.pop(); break;
        case "astore_3": locals[3] = stack.pop(); break;
        case "istore": locals[Number(instruction.arg)] = stack.pop(); break;
        case "istore_0": locals[0] = stack.pop(); break;
        case "istore_1": locals[1] = stack.pop(); break;
        case "istore_2": locals[2] = stack.pop(); break;
        case "istore_3": locals[3] = stack.pop(); break;
        case "dstore": locals[Number(instruction.arg)] = stack.pop(); break;
        case "dstore_0": locals[0] = stack.pop(); break;
        case "dstore_1": locals[1] = stack.pop(); break;
        case "dstore_2": locals[2] = stack.pop(); break;
        case "dstore_3": locals[3] = stack.pop(); break;
        case "fstore": locals[Number(instruction.arg)] = stack.pop(); break;
        case "fstore_0": locals[0] = stack.pop(); break;
        case "fstore_1": locals[1] = stack.pop(); break;
        case "fstore_2": locals[2] = stack.pop(); break;
        case "fstore_3": locals[3] = stack.pop(); break;
        case "iconst_0": stack.push(0); break;
        case "iconst_1": stack.push(1); break;
        case "iconst_2": stack.push(2); break;
        case "iconst_3": stack.push(3); break;
        case "iconst_4": stack.push(4); break;
        case "iconst_5": stack.push(5); break;
        case "iconst_m1": stack.push(-1); break;
        case "dconst_0": stack.push(0.0); break;
        case "dconst_1": stack.push(1.0); break;
        case "fconst_0": stack.push(0.0); break;
        case "fconst_1": stack.push(1.0); break;
        case "fconst_2": stack.push(2.0); break;
        case "bipush":
        case "sipush": stack.push(Number(instruction.arg)); break;
        case "ldc":
        case "ldc_w":
          stack.push(isClassConstant(instruction.arg)
            ? await this.classConstant(instruction.arg[1])
            : this.constantValue(instruction.arg));
          break;
        case "ldc2_w": stack.push(this.constantValue(instruction.arg)); break;
        case "dup": stack.push(stack[stack.length - 1]); break;
        case "dup2": {
          const value1 = stack.pop();
          if (typeof value1 === "bigint") stack.push(value1, value1);
          else {
            const value2 = stack.pop();
            stack.push(value2, value1, value2, value1);
          }
          break;
        }
        case "pop": stack.pop(); break;
        case "iadd": stack.push((stack.pop() + stack.pop()) | 0); break;
        case "isub": { const b = stack.pop(); const a = stack.pop(); stack.push((a - b) | 0); break; }
        case "imul": stack.push(Math.imul(stack.pop(), stack.pop())); break;
        case "ineg": stack.push((-stack.pop()) | 0); break;
        case "ixor": { const b = stack.pop(); const a = stack.pop(); stack.push(a ^ b); break; }
        case "ishr": { const shift = stack.pop(); const value = stack.pop(); stack.push(value >> (shift & 31)); break; }
        case "idiv": { const b = stack.pop(); const a = stack.pop(); if (b === 0) throw { type: "java/lang/ArithmeticException", message: "/ by zero" }; stack.push((a / b) | 0); break; }
        case "dadd": stack.push(stack.pop() + stack.pop()); break;
        case "dsub": { const b = stack.pop(); const a = stack.pop(); stack.push(a - b); break; }
        case "dmul": stack.push(stack.pop() * stack.pop()); break;
        case "ddiv": { const b = stack.pop(); const a = stack.pop(); stack.push(a / b); break; }
        case "dneg": stack.push(-stack.pop()); break;
        case "fadd": stack.push(Math.fround(stack.pop() + stack.pop())); break;
        case "fsub": { const b = stack.pop(); const a = stack.pop(); stack.push(Math.fround(a - b)); break; }
        case "fmul": stack.push(Math.fround(stack.pop() * stack.pop())); break;
        case "fdiv": { const b = stack.pop(); const a = stack.pop(); stack.push(Math.fround(a / b)); break; }
        case "frem": { const b = stack.pop(); const a = stack.pop(); stack.push(Math.fround(a % b)); break; }
        case "drem": { const b = stack.pop(); const a = stack.pop(); stack.push(a % b); break; }
        case "fneg": stack.push(Math.fround(-stack.pop())); break;
        case "i2d": break;
        case "i2l": stack.push(BigInt(stack.pop())); break;
        case "i2f": stack.push(Math.fround(stack.pop())); break;
        case "f2d": break;
        case "d2f": stack.push(Math.fround(stack.pop())); break;
        case "f2i": stack.push(floatToInt(stack.pop())); break;
        case "i2b": stack.push((stack.pop() << 24) >> 24); break;
        case "d2i": stack.push(Math.trunc(stack.pop()) | 0); break;
        case "l2i": stack.push(Number(BigInt.asIntN(32, stack.pop()))); break;
        case "l2d": stack.push(Number(stack.pop())); break;
        case "lxor": { const b = stack.pop(); const a = stack.pop(); stack.push(a ^ b); break; }
        case "ldiv": {
          const b = stack.pop();
          const a = stack.pop();
          if (b === 0n) throw { type: "java/lang/ArithmeticException", message: "/ by zero" };
          stack.push(a / b);
          break;
        }
        case "lmul": { const b = stack.pop(); const a = stack.pop(); stack.push(BigInt.asIntN(64, a * b)); break; }
        case "lshr": { const shift = stack.pop(); const value = stack.pop(); stack.push(value >> BigInt(shift & 63)); break; }
        case "lcmp": { const b = stack.pop(); const a = stack.pop(); stack.push(a < b ? -1 : (a > b ? 1 : 0)); break; }
        case "iand": stack.push(stack.pop() & stack.pop()); break;
        case "ior": stack.push(stack.pop() | stack.pop()); break;
        case "irem": {
          const b = stack.pop();
          const a = stack.pop();
          if (b === 0) throw { type: "java/lang/ArithmeticException", message: "/ by zero" };
          stack.push((a % b) | 0);
          break;
        }
        case "ishl": { const shift = stack.pop(); const value = stack.pop(); stack.push(value << (shift & 31)); break; }
        case "iushr": { const shift = stack.pop(); const value = stack.pop(); stack.push((value >>> (shift & 31)) | 0); break; }
        case "iinc": {
          const index = Number(instruction.varnum);
          locals[index] = (locals[index] + Number(instruction.incr)) | 0;
          break;
        }
        case "dcmpg": stack.push(compareDouble(stack.pop(), stack.pop(), 1)); break;
        case "dcmpl": stack.push(compareDouble(stack.pop(), stack.pop(), -1)); break;
        case "newarray": stack.push(this.newPrimitiveArray(stack.pop(), instruction.arg)); break;
        case "anewarray": stack.push(this.newReferenceArray(stack.pop(), instruction.arg)); break;
        case "multianewarray": stack.push(this.newMultiArray(instruction.arg, stack)); break;
        case "arraylength": stack.push(this.arrayLength(stack.pop(), frame)); break;
        case "checkcast": {
          const value = stack[stack.length - 1];
          if (value !== null && !await this.jvm.isInstanceOfAsync(runtimeClassName(value), instruction.arg)) {
            throw {
              type: "java/lang/ClassCastException",
              message: `${runtimeClassName(value)} cannot be cast to ${instruction.arg}`,
            };
          }
          break;
        }
        case "aaload":
        case "iaload":
        case "daload":
        case "faload":
        case "baload": stack.push(this.arrayLoad(stack.pop(), stack.pop(), frame, op)); break;
        case "caload":
        case "saload": stack.push(this.arrayLoad(stack.pop(), stack.pop(), frame, op)); break;
        case "aastore":
        case "iastore":
        case "dastore":
        case "fastore":
        case "bastore":
        case "castore":
        case "sastore": this.arrayStore(stack.pop(), stack.pop(), stack.pop(), frame, op); break;
        case "getfield": stack.push(this.getField(stack.pop(), instruction.arg)); break;
        case "putfield": { const value = stack.pop(); const obj = stack.pop(); this.putField(obj, instruction.arg, value); break; }
        case "getstatic": {
          const value = await this.getStatic(instruction.arg, thread);
          if (value === STATIC_DEOPT) {
            this.materialize(frame, locals, stack, pc - 1);
            return { deopt: true, transient: true, reason: "class initialization at getstatic" };
          }
          stack.push(value);
          break;
        }
        case "putstatic": {
          const changed = await this.putStatic(instruction.arg, stack[stack.length - 1], thread);
          if (changed === STATIC_DEOPT) {
            this.materialize(frame, locals, stack, pc - 1);
            return { deopt: true, transient: true, reason: "class initialization at putstatic" };
          }
          stack.pop();
          break;
        }
        case "new": {
          const value = await this.newObject(instruction.arg, thread);
          if (value === STATIC_DEOPT) {
            this.materialize(frame, locals, stack, pc - 1);
            return { deopt: true, transient: true, reason: "class initialization at new" };
          }
          stack.push(value);
          break;
        }
        case "monitorenter": {
          const monitor = stack[stack.length - 1];
          if (!this.monitorEnter(monitor, thread)) {
            this.materialize(frame, locals, stack, pc - 1);
            return { deopt: true, transient: true, reason: "contended monitorenter" };
          }
          stack.pop();
          break;
        }
        case "monitorexit": this.monitorExit(stack.pop(), thread); break;
        case "invokestatic":
        case "invokevirtual":
        case "invokeinterface":
        case "invokespecial": {
          const invokePc = pc - 1;
          this.materialize(frame, locals, stack, pc);
          const value = await this.invoke(op, frame, instruction, thread, invokePc);
          if (value && value.deopt) return value;
          if (value !== RETURN_VOID) stack.push(value);
          if (thread.status !== "runnable") {
            this.materialize(frame, locals, stack, pc);
            return { deopt: true, reason: `thread yielded in ${frame.className || ""}.${frame.method.name}` };
          }
          break;
        }
        case "goto": pc = this.target(frame, instruction.arg); break;
        case "ifeq": if (stack.pop() === 0) pc = this.target(frame, instruction.arg); break;
        case "ifne": if (stack.pop() !== 0) pc = this.target(frame, instruction.arg); break;
        case "iflt": if (stack.pop() < 0) pc = this.target(frame, instruction.arg); break;
        case "ifge": if (stack.pop() >= 0) pc = this.target(frame, instruction.arg); break;
        case "ifgt": if (stack.pop() > 0) pc = this.target(frame, instruction.arg); break;
        case "ifle": if (stack.pop() <= 0) pc = this.target(frame, instruction.arg); break;
        case "ifnull": if (stack.pop() === null) pc = this.target(frame, instruction.arg); break;
        case "ifnonnull": if (stack.pop() !== null) pc = this.target(frame, instruction.arg); break;
        case "if_icmpeq": { const b = stack.pop(); const a = stack.pop(); if (a === b) pc = this.target(frame, instruction.arg); break; }
        case "if_icmpne": { const b = stack.pop(); const a = stack.pop(); if (a !== b) pc = this.target(frame, instruction.arg); break; }
        case "if_icmplt": { const b = stack.pop(); const a = stack.pop(); if (a < b) pc = this.target(frame, instruction.arg); break; }
        case "if_icmpge": { const b = stack.pop(); const a = stack.pop(); if (a >= b) pc = this.target(frame, instruction.arg); break; }
        case "if_icmpgt": { const b = stack.pop(); const a = stack.pop(); if (a > b) pc = this.target(frame, instruction.arg); break; }
        case "if_icmple": { const b = stack.pop(); const a = stack.pop(); if (a <= b) pc = this.target(frame, instruction.arg); break; }
        case "if_acmpeq": { const b = stack.pop(); const a = stack.pop(); if (a === b) pc = this.target(frame, instruction.arg); break; }
        case "if_acmpne": { const b = stack.pop(); const a = stack.pop(); if (a !== b) pc = this.target(frame, instruction.arg); break; }
        case "athrow": throw stack.pop();
        case "return":
          this.materialize(frame, locals, stack, pc);
          thread.callStack.pop();
          return { returned: true, value: RETURN_VOID };
        case "areturn":
        case "ireturn":
        case "lreturn":
        case "freturn":
        case "dreturn": {
          const ret = stack.pop();
          this.materialize(frame, locals, stack, pc);
          thread.callStack.pop();
          return { returned: true, value: ret };
        }
        default:
          this.materialize(frame, locals, stack, pc - 1);
          return { deopt: true, reason: `unsupported opcode ${op} in ${frame.className || ""}.${frame.method.name}` };
      }
    }

    this.materialize(frame, locals, stack, pc);
    thread.callStack.pop();
    return { returned: true, value: RETURN_VOID };
  }

  returnVoid() {
    return RETURN_VOID;
  }

  staticDeopt() {
    return STATIC_DEOPT;
  }

  cooperativeYield() {
    return yieldToEventLoop();
  }

  compareDouble(value2, value1, nanValue) {
    return compareDouble(value2, value1, nanValue);
  }

  floatToInt(value) {
    return floatToInt(value);
  }

  constantValue(arg) {
    if (arg && typeof arg === "object" && Object.prototype.hasOwnProperty.call(arg, "value")) {
      return arg.value;
    }
    if (typeof arg === "string") {
      return this.jvm.internString(arg);
    }
    return arg;
  }

  async classConstant(className) {
    return this.jvm.getClassObject(className);
  }

  classConstantSync(className) {
    return this.jvm.getClassObjectSync(className) || STATIC_DEOPT;
  }

  // Shared with the interpreter and the wasm allocation imports (heap-backed
  // views with the linear heap on, long arrays default to 0n, negative sizes
  // throw the guest NegativeArraySizeException).
  newPrimitiveArray(count, type) {
    return allocPrimitiveArray(this.jvm, type, count);
  }

  newReferenceArray(count, elementType) {
    return allocReferenceArray(this.jvm, elementType, count);
  }

  newMultiArray(arg, stack) {
    const [className, dimensions] = arg;
    const counts = [];
    for (let i = 0; i < dimensions; i += 1) {
      counts.unshift(stack.pop());
    }
    const baseType = className.replace(/^\[+/, "");
    const leafDefault = baseType.startsWith("L") ? null : 0;
    const make = (depth) => {
      const count = counts[depth];
      const arr = new Array(count);
      arr.type = className.slice(depth);
      arr.hashCode = this.jvm.nextHashCode++;
      if (depth === counts.length - 1) {
        arr.fill(leafDefault);
      } else {
        for (let i = 0; i < count; i += 1) arr[i] = make(depth + 1);
      }
      return arr;
    };
    return make(0);
  }

  arrayLength(arrayRef, frame) {
    if (arrayRef === null || arrayRef === undefined) {
      throw { type: "java/lang/NullPointerException", message: `Attempted to get length of null array in ${frame.method.name}` };
    }
    return arrayRef.length;
  }

  async checkCast(value, className) {
    if (value === null || value === undefined) return;
    if (!await this.jvm.isInstanceOfAsync(runtimeClassName(value), className)) {
      throw {
        type: "java/lang/ClassCastException",
        message: `${runtimeClassName(value)} cannot be cast to ${className}`,
      };
    }
  }

  tryCheckCastSync(value, className) {
    if (value === null || value === undefined) return true;
    const source = runtimeClassName(value);
    return this.tryCheckCastSourceSync(source, className);
  }

  tryCheckCastSourceSync(source, className) {
    const assignable = this.tryAssignableSourceSync(source, className);
    if (assignable === null) return ASYNC_INVOKE;
    if (!assignable) {
      throw {
        type: "java/lang/ClassCastException",
        message: `${source} cannot be cast to ${className}`,
      };
    }
    return true;
  }

  async instanceOf(value, className) {
    if (value === null || value === undefined) return 0;
    return await this.jvm.isInstanceOfAsync(runtimeClassName(value), className) ? 1 : 0;
  }

  tryInstanceOfSync(value, className) {
    if (value === null || value === undefined) return 0;
    const source = runtimeClassName(value);
    const assignable = this.tryAssignableSourceSync(source, className);
    if (assignable === null) return ASYNC_INVOKE;
    return assignable ? 1 : 0;
  }

  tryAssignableSourceSync(source, className) {
    let bySource = this.syncAssignabilityCache.get(className);
    if (bySource && bySource.has(source)) return bySource.get(source);
    const assignable = this.jvm.isInstanceOfSync(source, className);
    if (assignable !== null) {
      if (!bySource) {
        bySource = new Map();
        this.syncAssignabilityCache.set(className, bySource);
      }
      bySource.set(source, assignable);
    }
    return assignable;
  }

  monitorEnter(monitor, thread) {
    if (monitor === null || monitor === undefined) {
      throw { type: "java/lang/NullPointerException", message: null };
    }
    if (!monitor.isLocked) {
      monitor.isLocked = true;
      monitor.lockOwner = thread.id;
      monitor.lockCount = 1;
      delete thread.blockingOn;
      return true;
    }
    if (monitor.lockOwner === thread.id) {
      monitor.lockCount += 1;
      return true;
    }
    thread.status = "BLOCKED";
    thread.blockingOn = monitor;
    return false;
  }

  monitorExit(monitor, thread) {
    if (monitor === null || monitor === undefined) {
      throw { type: "java/lang/NullPointerException", message: null };
    }
    if (monitor.lockOwner !== thread.id) {
      throw { type: "java/lang/IllegalMonitorStateException", message: null };
    }
    monitor.lockCount -= 1;
    if (monitor.lockCount === 0) {
      monitor.isLocked = false;
      monitor.lockOwner = null;
    }
  }

  arrayLoad(index, arrayRef, frame, kind) {
    if (arrayRef === null || arrayRef === undefined) {
      throw { type: "java/lang/NullPointerException", message: `Attempted to load from null array in ${frame.method.name}` };
    }
    const value = monoArray.load(arrayRef, index);
    if (value === monoArray.OOB) {
      if (typeof process !== "undefined" && process.env &&
          process.env.JVM_DEBUG_ARRAY_OOB === "1") {
        const scalar = (item) => {
          if (item === null || item === undefined) return item;
          if (typeof item === "bigint") return `${item}n`;
          if (typeof item !== "object") return item;
          if (Array.isArray(item) || ArrayBuffer.isView(item)) {
            return `[${item.length}]`;
          }
          return typeof item.type === "string" ? `<${item.type}>` : "<object>";
        };
        const activeThread = this.jvm.threads[this.jvm.currentThreadIndex];
        const callStack = activeThread?.callStack?.items || [];
        const callers = callStack.slice(Math.max(0, callStack.length - 8))
          .map((activeFrame) => ({
            owner: scalar(activeFrame.className),
            method: `${activeFrame.method?.name || "<unknown>"}` +
              `${activeFrame.method?.descriptor || ""}`,
            pc: activeFrame.pc,
            locals: (activeFrame.locals || []).map(scalar),
          }));
        console.error("[array-load-oob:jitted]", JSON.stringify({
          owner: scalar(frame.className),
          method: `${frame.method?.name || "<unknown>"}` +
            `${frame.method?.descriptor || ""}`,
          pc: frame.pc - 1,
          kind,
          index: scalar(index),
          length: monoArray.len(arrayRef),
          locals: (frame.locals || []).map(scalar),
          jsStack: new Error().stack.split("\n").slice(1, 26)
            .map((line) => line.trim().replace(/^at /, "")
              .replace(/ \(.*(jvm-generated:\/\/[^)?]*)[^)]*\)$/, " [$1]")
              .replace(/ \(\/home[^)]*\/src\//, " (src/")),
          callers,
        }));
        // Statics alone cannot say whether the *object* a frame is indexing
        // is the one it should be. JVM_DEBUG_ARRAY_OOB_FIELDS=f,r names guest
        // instance fields to print for every object local, which is what tells
        // a stale reference apart from a corrupt one.
        const debugFields = process.env.JVM_DEBUG_ARRAY_OOB_FIELDS || "";
        if (debugFields) {
          const wanted = new Set(debugFields.split(",").filter(Boolean));
          const pickFields = (locals) => {
            const objects = [];
            (locals || []).forEach((item, slot) => {
              if (!item || typeof item !== "object" || !item.fields) return;
              const picked = {};
              for (const key of Object.keys(item.fields)) {
                const name = String(key).split(".").pop();
                if (wanted.has(name) || wanted.has(String(key))) {
                  picked[key] = scalar(item.fields[key]);
                }
              }
              if (Object.keys(picked).length) {
                objects.push({ slot, type: scalar(item), fields: picked });
              }
            });
            return objects;
          };
          // Whether a caller has already advanced to the next object while
          // this frame still draws the previous one is only visible by
          // comparing the same field across the whole stack, so every frame
          // is reported, not just the one that went out of bounds.
          console.error("[array-load-oob:fields]", JSON.stringify({
            spec: debugFields,
            objects: pickFields(frame.locals),
            callers: callStack.slice(Math.max(0, callStack.length - 8))
              .map((activeFrame) => ({
                owner: scalar(activeFrame.className),
                method: `${activeFrame.method?.name || "<unknown>"}` +
                  `${activeFrame.method?.descriptor || ""}`,
                pc: activeFrame.pc,
                objects: pickFields(activeFrame.locals),
              })),
          }));
        }
        const debugStatics = process.env.JVM_DEBUG_ARRAY_OOB_STATICS || "";
        for (const spec of debugStatics.split(",").filter(Boolean)) {
          const [debugClass, debugField] = spec.split(".");
          const live = {};
          let cursor = debugClass;
          while (cursor) {
            const classData = this.jvm.classes[cursor];
            if (classData && classData.staticFields) {
              for (const [candidate, held] of classData.staticFields) {
                if (String(candidate).split(":")[0].replace(/'/g, "") ===
                    debugField) {
                  live[`${cursor}#${candidate}`] = scalar(held);
                }
              }
            }
            cursor = classData?.ast?.classes?.[0]?.superClassName || null;
          }
          const cachedSites = this.fieldSites
            .filter((site) => site && site.className === debugClass &&
              site.fieldName === debugField && site.staticTarget)
            .map((site) => ({
              key: String(site.staticTarget.key),
              kind: site.staticTarget.kind,
              value: scalar(site.staticTarget.kind === "map"
                ? site.staticTarget.fields.get(site.staticTarget.key)
                : site.staticTarget.fields[site.staticTarget.key]),
              sameContainer: site.staticTarget.fields ===
                this.jvm.classes[debugClass]?.staticFields,
            }));
          console.error("[array-load-oob:statics]", JSON.stringify({
            spec, live, cachedSites,
          }));
        }
      }
      throw { type: "java/lang/ArrayIndexOutOfBoundsException", message: `Index ${index} out of bounds for length ${monoArray.len(arrayRef)}` };
    }
    return normalizeArrayLoad(value, kind, arrayRef);
  }

  normalizeArrayLoad(value, kind, arrayRef) {
    return normalizeArrayLoad(value, kind, arrayRef);
  }

  normalizeArrayStore(value, kind, arrayRef) {
    return normalizeArrayStore(value, kind, arrayRef);
  }

  // A generated region may keep this raw storage pointer in a scalar local.
  // The Java array object itself remains canonical in locals/fields/snapshots.
  arrayData(arrayRef) {
    if (arrayRef === null || arrayRef === undefined) return null;
    if (arrayRef.elements) return arrayRef.elements;
    if (Array.isArray(arrayRef) || ArrayBuffer.isView(arrayRef)) return arrayRef;
    return null;
  }

  arrayStore(value, index, arrayRef, frame, kind) {
    if (arrayRef === null || arrayRef === undefined) {
      if (typeof process !== "undefined" && process.env &&
          process.env.JVM_DEBUG_NULL_ARRAY === "1") {
        const diagnosticScalar = (item) => {
          if (item === null || item === undefined) return item;
          if (typeof item === "string" || typeof item === "number" ||
              typeof item === "boolean" || typeof item === "bigint") {
            return typeof item === "bigint" ? `${item}n` : item;
          }
          if (Array.isArray(item) || ArrayBuffer.isView(item)) return `[${item.length}]`;
          if (typeof item === "object") {
            const type = typeof item.type === "string" ? item.type : null;
            return type ? `<${type}>` : `<${item.constructor && item.constructor.name || "object"}>`;
          }
          return typeof item;
        };
        const receiver = frame.locals && frame.locals[0];
        const fields = receiver && receiver.fields
          ? Object.fromEntries(Object.entries(receiver.fields).map(([key, fieldValue]) => [
            key,
            diagnosticScalar(fieldValue),
          ]))
          : null;
        console.error("[null-array-store:jitted]", JSON.stringify({
          owner: diagnosticScalar(frame.className),
          method: `${frame.method && frame.method.name}${frame.method && frame.method.descriptor || ""}`,
          pc: frame.pc - 1,
          index: diagnosticScalar(index),
          receiverType: diagnosticScalar(receiver && receiver.type),
          fields,
        }));
      }
      throw { type: "java/lang/NullPointerException", message: `Attempted to store into null array in ${frame.method.name}` };
    }
    const narrowed = normalizeArrayStore(value, kind, arrayRef);
    if (!monoArray.store(arrayRef, index, narrowed)) {
      if (typeof process !== "undefined" && process.env &&
          process.env.JVM_DEBUG_ARRAY_OOB === "1") {
        const scalar = (item) => {
          if (item === null || item === undefined) return item;
          if (typeof item === "bigint") return `${item}n`;
          if (typeof item !== "object") return item;
          if (Array.isArray(item) || ArrayBuffer.isView(item)) return `[${item.length}]`;
          return typeof item.type === "string" ? `<${item.type}>` : "<object>";
        };
        const activeThread = this.jvm.threads[this.jvm.currentThreadIndex];
        const callStack = activeThread?.callStack?.items || [];
        const callers = callStack.slice(Math.max(0, callStack.length - 8))
          .map((activeFrame) => ({
            owner: scalar(activeFrame.className),
            method: `${activeFrame.method && activeFrame.method.name || "<unknown>"}` +
              `${activeFrame.method && activeFrame.method.descriptor || ""}`,
            pc: activeFrame.pc,
            locals: (activeFrame.locals || []).map(scalar),
          }));
        console.error("[array-store-oob:jitted]", JSON.stringify({
          owner: scalar(frame.className),
          method: `${frame.method && frame.method.name}${frame.method && frame.method.descriptor || ""}`,
          pc: frame.pc - 1,
          index: scalar(index),
          length: monoArray.len(arrayRef),
          locals: (frame.locals || []).map(scalar),
          callers,
        }));
      }
      throw { type: "java/lang/ArrayIndexOutOfBoundsException", message: `Index ${index} out of bounds for length ${monoArray.len(arrayRef)}` };
    }
  }

  registerFieldSite(arg) {
    const [, className, [fieldName, descriptor]] = arg;
    // A fieldref resolves to one declaring-class slot regardless of the
    // receiver's runtime subclass. Bind that verified slot once from loaded
    // class metadata; generated code can then use the ordinary Java-object
    // field map directly and retain the generic resolver only for synthetic
    // or JRE objects with a nonstandard layout.
    let declaringClassName = className;
    let directInstanceKey = null;
    while (declaringClassName) {
      const classData = this.jvm.classes[declaringClassName];
      const classAst = classData?.ast?.classes?.[0];
      if (!classAst) break;
      const declared = (classAst.items || []).some((item) =>
        item?.type === "field" &&
        item.field?.name === fieldName &&
        item.field?.descriptor === descriptor &&
        !(item.field?.flags || []).includes("static") &&
        !(Number(item.field?.accessFlags) & 0x0008));
      if (declared) {
        directInstanceKey = `${declaringClassName}.${fieldName}`;
        break;
      }
      declaringClassName = classAst.superClassName || null;
    }
    const id = this.nextFieldSiteId++;
    this.fieldSites[id] = {
      arg,
      className,
      fieldName,
      descriptor,
      initializationToken: this.jvm.getClassInitializationToken(className),
      directKey: `${className}.${fieldName}`,
      directInstanceKey,
      instanceKeys: new Map(),
      staticTarget: null,
    };
    return id;
  }

  canEliminateFieldRead(arg) {
    if (!Array.isArray(arg) || !Array.isArray(arg[2])) return false;
    const [, declaredClassName, [fieldName, descriptor]] = arg;
    let className = declaredClassName;
    while (className) {
      const classData = this.jvm.classes[className];
      const classAst = classData?.ast?.classes?.[0];
      if (!classAst) return false;
      const field = (classAst.items || []).find((item) => item?.type === "field" &&
        item.field?.name === fieldName && item.field?.descriptor === descriptor);
      if (field) {
        if ((field.field.flags || []).includes("volatile")) return false;
        const accessFlags = Number(field.field.accessFlags);
        return Number.isFinite(accessFlags) && (accessFlags & 0x0040) === 0;
      }
      className = classAst.superClassName || null;
    }
    return false;
  }

  getFieldAt(id, objRef) {
    const site = this.fieldSites[id];
    if (!site) throw new Error(`Unknown generated field site ${id}`);
    if (objRef === null || objRef === undefined) {
      throw { type: "java/lang/NullPointerException", message: null };
    }
    if (!objRef.fields) {
      return objRef[site.directKey] ?? objRef[site.fieldName];
    }

    const runtimeType = objRef._className || objRef.type || site.className;
    if (hasField(objRef.fields, site.directKey)) {
      return objRef.fields[site.directKey];
    }
    const cachedKey = site.instanceKeys.get(runtimeType);
    if (cachedKey && hasField(objRef.fields, cachedKey)) {
      return objRef.fields[cachedKey];
    }
    const fieldKey = resolveInstanceFieldKey(
      this.jvm, objRef, site.className, site.fieldName,
    );
    if (fieldKey) site.instanceKeys.set(runtimeType, fieldKey);
    return fieldKey ? objRef.fields[fieldKey] : undefined;
  }

  putFieldAt(id, objRef, value) {
    const site = this.fieldSites[id];
    if (!site) throw new Error(`Unknown generated field site ${id}`);
    if (objRef === null || objRef === undefined) {
      throw { type: "java/lang/NullPointerException", message: null };
    }
    if (!objRef.fields) objRef.fields = {};
    const runtimeType = objRef._className || objRef.type || site.className;
    let fieldKey = hasField(objRef.fields, site.directKey)
      ? site.directKey
      : site.instanceKeys.get(runtimeType);
    if (!fieldKey || !hasField(objRef.fields, fieldKey)) {
      fieldKey = resolveInstanceFieldKey(this.jvm, objRef, site.className, site.fieldName)
        || site.directKey;
      site.instanceKeys.set(runtimeType, fieldKey);
    }
    objRef.fields[fieldKey] = value;
  }

  resolveStaticFieldSite(site, forWrite = false) {
    const key = `${site.fieldName}:${site.descriptor}`;
    let currentClassName = site.className;
    while (currentClassName) {
      const classData = this.jvm.classes[currentClassName];
      if (classData && classData.staticFields) {
        if (classData.staticFields.has(key)) {
          return { kind: "map", fields: classData.staticFields, key };
        }
        if (!forWrite && classData.staticFields.has(site.fieldName)) {
          return { kind: "map", fields: classData.staticFields, key: site.fieldName };
        }
        if (!forWrite) {
          for (const candidate of classData.staticFields.keys()) {
            if (typeof candidate === "string" &&
                candidate.split(":")[0].replace(/'/g, "") === site.fieldName) {
              return { kind: "map", fields: classData.staticFields, key: candidate };
            }
          }
        }
      }
      currentClassName = classData && classData.ast && classData.ast.classes[0]
        ? classData.ast.classes[0].superClassName
        : null;
    }

    if (!forWrite) {
      const jreFields = this.jvm.jre[site.className] &&
        this.jvm.jre[site.className].staticFields;
      if (jreFields) {
        for (const candidate of [
          key, `'${key}'`, `${key}'`, `'${key}`, site.fieldName, `'${site.fieldName}'`,
        ]) {
          if (Object.prototype.hasOwnProperty.call(jreFields, candidate)) {
            return { kind: "object", fields: jreFields, key: candidate };
          }
        }
      }
    }

    if (forWrite) {
      const classData = this.jvm.classes[site.className];
      if (classData && classData.staticFields) {
        return { kind: "map", fields: classData.staticFields, key };
      }
    }
    return null;
  }

  registerDirectStaticTarget(id, forWrite = false) {
    const site = this.fieldSites[id];
    if (!site) return null;
    let target = site.staticTarget;
    if (!target || (forWrite && target.kind !== "map")) {
      target = this.resolveStaticFieldSite(site, forWrite);
    }
    if (!target || (forWrite && target.kind !== "map")) return null;
    site.staticTarget = target;
    target.initializationToken = site.initializationToken;
    target.versionCell = this.getStaticFieldVersionCell(
      target.fields, target.key);
    const targetId = this.directStaticTargets.length;
    this.directStaticTargets.push(target);
    return { targetId, kind: target.kind, key: target.key, className: site.className };
  }

  getStaticFieldVersionCell(fields, key) {
    let cells = this.staticFieldVersionCells.get(fields);
    if (!cells) {
      cells = new Map();
      this.staticFieldVersionCells.set(fields, cells);
    }
    let cell = cells.get(key);
    if (!cell) {
      cell = { value: 0, captureCaches: null };
      cells.set(key, cell);
    }
    return cell;
  }

  markStaticTargetChanged(target) {
    if (!target) return;
    const caches = target.versionCell?.captureCaches;
    if (!caches) return;
    for (const cache of caches) {
      cache.dirty = true;
      cache.specializedMatches = false;
      for (const key of cache.derivedGuardKeys) cache[key] = undefined;
    }
  }

  markStaticLocationChanged(fields, key) {
    if (!fields || key === undefined) return;
    const caches = this.staticFieldVersionCells.get(fields)
      ?.get(key)?.captureCaches;
    if (!caches) return;
    for (const cache of caches) {
      cache.dirty = true;
      cache.specializedMatches = false;
      for (const guardKey of cache.derivedGuardKeys) {
        cache[guardKey] = undefined;
      }
    }
  }

  markStaticContainerChanged(fields) {
    if (!fields) return;
    const cells = this.staticFieldVersionCells.get(fields);
    if (!cells) return;
    const caches = new Set();
    for (const cell of cells.values()) {
      for (const cache of cell.captureCaches || []) caches.add(cache);
    }
    for (const cache of caches) {
      cache.dirty = true;
      cache.specializedMatches = false;
      for (const guardKey of cache.derivedGuardKeys) {
        cache[guardKey] = undefined;
      }
    }
  }

  registerCheckedLeafCaptureCache(captures) {
    const entries = captures.map((capture) => {
      const target = this.directStaticTargets[capture.targetId];
      if (!target) throw new Error("missing checked-leaf static capture");
      const cell = target.versionCell || this.getStaticFieldVersionCell(
        target.fields, target.key);
      target.versionCell = cell;
      return { capture, target, cell };
    });
    const cache = {
      entries,
      dirty: true,
      derivedGuardKeys: [],
      specializedMatches: false,
      specializationInitialized: false,
    };
    let valueCount = 0;
    for (const { capture } of entries) {
      cache[`value${valueCount++}`] = undefined;
      cache[`specializedValue${valueCount - 1}`] = undefined;
      if (capture.data) {
        cache[`value${valueCount++}`] = undefined;
        cache[`specializedValue${valueCount - 1}`] = undefined;
      }
    }
    for (const entry of entries) {
      if (!entry.cell.captureCaches) entry.cell.captureCaches = new Set();
      entry.cell.captureCaches.add(cache);
    }
    const id = this.checkedLeafCaptureCaches.length;
    this.checkedLeafCaptureCaches.push(cache);
    this.refreshCheckedLeafCaptureCache(id);
    for (let index = 0; index < valueCount; index += 1) {
      cache[`specializedValue${index}`] = cache[`value${index}`];
    }
    cache.specializedMatches = true;
    cache.specializationInitialized = true;
    return id;
  }

  refreshCheckedLeafCaptureCache(id) {
    const cache = this.checkedLeafCaptureCaches[id];
    if (!cache) throw new Error("missing checked-leaf capture cache");
    let valueIndex = 0;
    let specializedMatches = true;
    for (let index = 0; index < cache.entries.length; index += 1) {
      const { capture, target } = cache.entries[index];
      const value = target.kind === "map"
        ? target.fields.get(target.key) : target.fields[target.key];
      cache[`value${valueIndex}`] = value;
      if (cache.specializationInitialized &&
          cache[`specializedValue${valueIndex}`] !== value) {
        specializedMatches = false;
      }
      valueIndex += 1;
      if (capture.data) {
        const data = this.arrayData(value);
        cache[`value${valueIndex}`] = data;
        if (cache.specializationInitialized &&
            cache[`specializedValue${valueIndex}`] !== data) {
          specializedMatches = false;
        }
        valueIndex += 1;
      }
    }
    cache.specializedMatches = specializedMatches;
    cache.dirty = false;
    return cache;
  }

  registerCheckedLeafCaptureDerivedGuard(id) {
    const cache = this.checkedLeafCaptureCaches[id];
    if (!cache) throw new Error("missing checked-leaf capture cache");
    const key = `guard${cache.derivedGuardKeys.length}`;
    cache.derivedGuardKeys.push(key);
    cache[key] = undefined;
    return key;
  }

  getStaticSyncAt(id) {
    const site = this.fieldSites[id];
    if (!site) throw new Error(`Unknown generated static field site ${id}`);
    if (!site.initializationToken.initialized) {
      return STATIC_DEOPT;
    }
    let target = site.staticTarget;
    if (!target) {
      target = this.resolveStaticFieldSite(site);
      if (!target) {
        return this.getStaticInitialized(site.className, site.fieldName, site.descriptor);
      }
      site.staticTarget = target;
    }
    return target.kind === "map"
      ? target.fields.get(target.key)
      : target.fields[target.key];
  }

  putStaticSyncAt(id, value) {
    const site = this.fieldSites[id];
    if (!site) throw new Error(`Unknown generated static field site ${id}`);
    if (!site.initializationToken.initialized) {
      return STATIC_DEOPT;
    }
    let target = site.staticTarget;
    if (!target || target.kind !== "map") {
      target = this.resolveStaticFieldSite(site, true);
      if (!target) {
        return this.putStaticInitialized(
          site.className, site.fieldName, site.descriptor, value,
        );
      }
      site.staticTarget = target;
    }
    target.fields.set(target.key, value);
    this.markStaticTargetChanged(target);
    return true;
  }

  getField(objRef, arg) {
    const [, className, [fieldName]] = arg;
    if (objRef === null || objRef === undefined) {
      throw { type: "java/lang/NullPointerException", message: null };
    }
    if (objRef.fields) {
      const fieldKey = resolveInstanceFieldKey(this.jvm, objRef, className, fieldName);
      return fieldKey ? objRef.fields[fieldKey] : undefined;
    }
    return objRef[`${className}.${fieldName}`] ?? objRef[fieldName];
  }

  putField(objRef, arg, value) {
    const [, className, [fieldName]] = arg;
    if (objRef === null || objRef === undefined) {
      throw { type: "java/lang/NullPointerException", message: null };
    }
    if (!objRef.fields) objRef.fields = {};
    const fieldKey = resolveInstanceFieldKey(this.jvm, objRef, className, fieldName) || `${className}.${fieldName}`;
    objRef.fields[fieldKey] = value;
  }

  getStatic(arg, thread) {
    const [, className, [fieldName, descriptor]] = arg;
    if (this.jvm.classInitializationState.get(className) !== "INITIALIZED") {
      return this.getStaticCold(arg, thread);
    }
    return this.getStaticInitialized(className, fieldName, descriptor);
  }

  getStaticSync(arg) {
    const [, className, [fieldName, descriptor]] = arg;
    if (this.jvm.classInitializationState.get(className) !== "INITIALIZED") return STATIC_DEOPT;
    return this.getStaticInitialized(className, fieldName, descriptor);
  }

  async getStaticCold(arg, thread) {
    const [, className, [fieldName, descriptor]] = arg;
    const wasFramePushed = await this.jvm.initializeClassIfNeeded(className, thread);
    if (wasFramePushed) return STATIC_DEOPT;
    return this.getStaticInitialized(className, fieldName, descriptor);
  }

  getStaticInitialized(className, fieldName, descriptor) {
    const target = this.getInitializedStaticTarget(
      this.initializedStaticReadTargets,
      className,
      fieldName,
      descriptor,
      false,
    );
    if (!target) throw new Error(`Unresolved static field: ${className}.${fieldName}`);
    return target.kind === "map"
      ? target.fields.get(target.key)
      : target.fields[target.key];
  }

  putStatic(arg, value, thread) {
    const [, className, [fieldName, descriptor]] = arg;
    if (this.jvm.classInitializationState.get(className) !== "INITIALIZED") {
      return this.putStaticCold(arg, value, thread);
    }
    return this.putStaticInitialized(className, fieldName, descriptor, value);
  }

  putStaticSync(arg, value) {
    const [, className, [fieldName, descriptor]] = arg;
    if (this.jvm.classInitializationState.get(className) !== "INITIALIZED") return STATIC_DEOPT;
    return this.putStaticInitialized(className, fieldName, descriptor, value);
  }

  async putStaticCold(arg, value, thread) {
    const [, className, [fieldName, descriptor]] = arg;
    const wasFramePushed = await this.jvm.initializeClassIfNeeded(className, thread);
    if (wasFramePushed) return STATIC_DEOPT;
    return this.putStaticInitialized(className, fieldName, descriptor, value);
  }

  putStaticInitialized(className, fieldName, descriptor, value) {
    const target = this.getInitializedStaticTarget(
      this.initializedStaticWriteTargets,
      className,
      fieldName,
      descriptor,
      true,
    );
    if (!target || target.kind !== "map") {
      throw new Error(`Unsupported putstatic: ${className}.${fieldName}`);
    }
    target.fields.set(target.key, value);
    this.markStaticTargetChanged(target);
    return true;
  }

  getInitializedStaticTarget(
    cache, className, fieldName, descriptor, forWrite,
  ) {
    let classTargets = cache.get(className);
    if (!classTargets) {
      classTargets = new Map();
      cache.set(className, classTargets);
    }
    let fieldTargets = classTargets.get(fieldName);
    if (!fieldTargets) {
      fieldTargets = new Map();
      classTargets.set(fieldName, fieldTargets);
    }
    if (fieldTargets.has(descriptor)) return fieldTargets.get(descriptor);
    const target = this.resolveStaticFieldSite({
      className,
      fieldName,
      descriptor,
    }, forWrite);
    if (target && (!forWrite || target.kind === "map")) {
      fieldTargets.set(descriptor, target);
      return target;
    }
    return null;
  }

  async newObject(className, thread) {
    const wasFramePushed = await this.jvm.initializeClassIfNeeded(className, thread);
    if (wasFramePushed) return STATIC_DEOPT;
    await this.jvm.loadClassByName(className).catch(() => null);

    return this.allocateObject(className);
  }

  newObjectSync(className) {
    if (this.jvm.classInitializationState.get(className) !== "INITIALIZED" ||
        !this.jvm.classes[className]) return STATIC_DEOPT;
    return this.allocateObject(className);
  }

  allocateObject(className) {
    return makeObjectRef(this.jvm, className, newFields(this.jvm, className));
  }

  asyncInvokeSentinel() {
    return ASYNC_INVOKE;
  }

  registerSyncCallSite(op, instruction, callerMethod = null,
    callerPc = null) {
    const [, declaredClassName, [methodName, descriptor]] = instruction.arg;
    const id = this.nextSyncCallSiteId++;
    this.syncCallSites[id] = {
      op,
      declaredClassName,
      methodName,
      descriptor,
      callerMethod,
      callerPc: Number.isInteger(callerPc) ? callerPc : null,
      initializationToken:
        this.jvm.getClassInitializationToken(declaredClassName),
      ...parseDescriptor(descriptor),
      targets: new Map(),
      jreTargets: new Map(),
    };
    return id;
  }

  // A loaded static or special target is monomorphic by bytecode semantics.
  // Compile only bounded synchronous helpers while the caller is being built,
  // so its generated prologue can capture one immutable positional function.
  // This is deliberately descriptor/CFG driven: no owner or member identity
  // participates, and every ordinary class/debug/exception guard remains in
  // the positional entry selected by getPositionalGeneratedInvoker.
  primeMonomorphicSyncCallSite(id, method, lookupClass) {
    const site = this.syncCallSites[id];
    if (!this.eagerMonomorphicCallsEnabled || this.profileMethods || !site ||
        !method || method.name === "<init>" || method.name === "<clinit>" ||
        (site.op !== "invokestatic" && site.op !== "invokespecial") ||
        site.fastPositional ||
        site.op === "invokestatic" && !site.initializationToken.initialized) {
      return false;
    }
    const items = this.getCodeItems(method);
    if (!items.length ||
        items.length > this.eagerMonomorphicCallMaxCodeItems ||
        !this.canCompileSynchronously(method) ||
        this.fusedRegions.enabled && this.fusedRegions.mayFuse(method)) {
      return false;
    }
    const targetClassName = lookupClass || site.declaredClassName;
    let target = site.targets.get(targetClassName);
    if (!target) {
      target = {
        method,
        lookupClass: targetClassName,
        generated: this.getGeneratedFunction(method),
      };
      if (!target.generated?.jvmSynchronous) return false;
      site.targets.set(targetClassName, target);
      this.trackGeneratedTarget(method, target, site);
    }
    const positional = this.getPositionalGeneratedInvoker(site, target);
    if (!positional) return false;
    if (site.op === "invokestatic") site.fastStaticTarget = target;
    else site.fastSpecialTarget = target;
    site.fastPositional = {
      invoke: positional,
      rawInvoke: positional.jvmRawInvoke || null,
      lookupClass: targetClassName,
      receiverType: null,
      debugGuarded: positional.jvmDebugGuarded === true,
    };
    this.eagerMonomorphicCallLinkCount += 1;
    return true;
  }

  traceSyncCallAt(id, frame, thread, value, scalarDepth) {
    const site = this.syncCallSites[id];
    const top = thread.callStack.isEmpty() ? null : thread.callStack.peek();
    const identity = (candidate) => candidate
      ? `${candidate.className || "?"}.${candidate.method?.name || "?"}${
        candidate.method?.descriptor || ""}` : null;
    console.error("[jit-sync-call] " + JSON.stringify({
      caller: identity(frame),
      callerPc: frame.pc,
      target: site && `${site.declaredClassName}.${site.methodName}${
        site.descriptor}`,
      scalarDepth,
      materializedDepth: frame.stack.items.length,
      result: value === ASYNC_INVOKE ? "async"
        : value === RETURN_VOID ? "void"
          : value && value.deopt ? `deopt:${value.reason || "unspecified"}`
            : value === null ? "null"
              : value === undefined ? "undefined"
                : value && (value.type || value._className) || typeof value,
      top: identity(top),
      callerOwnsStack: top === frame,
    }));
  }

  linkStructuredCallChild(frame, thread, entryDepth, returnType) {
    const frames = thread?.callStack?.items;
    if (!frame || !Array.isArray(frames) ||
        !Number.isInteger(entryDepth) || frames.length <= entryDepth) {
      return false;
    }
    const child = frames[entryDepth];
    if (!child || child === frame) return false;
    if (!child.jitGeneratedReturnParent) {
      child.jitGeneratedReturnParent = frame;
    }
    if (child.jitGeneratedReturnParent === frame) {
      child.jitGeneratedReturnType = returnType;
    }
    return child.jitGeneratedReturnParent === frame;
  }

  getCompileTimeDirectJre(op, instruction) {
    if (this.profileMethods ||
        !instruction || !Array.isArray(instruction.arg) ||
        !Array.isArray(instruction.arg[2])) return null;
    const [, declaredClassName, [methodName, descriptor]] = instruction.arg;
    if (op === "invokestatic" && !this.directStaticJreIntrinsicsEnabled) {
      return null;
    }
    const method = this.resolveSynchronousJreMethod(
      declaredClassName, declaredClassName, methodName, descriptor);
    if (typeof method?.jvmDirectIntrinsic !== "function" ||
        method.jvmDirectFinal !== true) return null;
    let parsed;
    try { parsed = parseDescriptor(descriptor); } catch (_) { return null; }
    const id = this.directJreIntrinsics.length;
    this.directJreIntrinsics.push(method.jvmDirectIntrinsic);
    const isStatic = op === "invokestatic";
    this.directJreInitializationTokens.push(isStatic
      ? this.jvm.getClassInitializationToken(declaredClassName) : null);
    return {
      id,
      argumentCount: parsed.params.length + (isStatic ? 0 : 1),
      returnsVoid: parsed.returnType === "void",
      isStatic,
      fieldWriteKeys: Array.isArray(method.jvmDirectFieldWriteKeys)
        ? [...method.jvmDirectFieldWriteKeys] : null,
    };
  }

  tryInvokeSyncAt(id, frame, thread) {
    this.hotCallGraphRegions.recordGenericCallSite(id, frame);
    const site = this.syncCallSites[id];
    if (!site) return ASYNC_INVOKE;
    if (this.debugNonTopInvoke) {
      const items = thread?.callStack?.items || [];
      const top = items[items.length - 1];
      if (top !== frame) {
        console.error("[nontop-invoke]", JSON.stringify({
          site: `${site.className || site.declaredClassName}.`
            + `${site.methodName || site.name || "?"}${site.descriptor || ""}`,
          op: site.op,
          caller: `${frame.className}.${frame.method?.name}`
            + `${frame.method?.descriptor || ""}@pc${frame.pc}`,
          top: top ? `${top.className}.${top.method?.name}`
            + `${top.method?.descriptor || ""}@pc${top.pc}` : null,
          depth: items.length,
          callerDepth: items.indexOf(frame),
        }) + "\n" + new Error().stack.split("\n").slice(2, 14)
          .map((line) => line.trim()).join("\n"));
      }
    }
    const stack = frame.stack.items;
    let receiverIndex = stack.length - site.params.length - 1;
    let receiver = site.op === "invokestatic"
      ? null : stack[receiverIndex];
    // A graph handoff can complete a primitive-returning child after its
    // generated caller has already reconstructed the next zero-argument
    // instance receiver. The stale return then sits above that receiver and
    // would be mistaken for `this`. Verified bytecode cannot legally invoke
    // an instance method on a primitive, so remove exactly that impossible
    // one-slot residue and preserve the canonical receiver beneath it.
    if (this.hotCallGraphRegions.enabled && site.op !== "invokestatic" &&
        site.params.length === 0 && receiverIndex > 0 &&
        receiver !== null && typeof receiver !== "object" &&
        typeof receiver !== "string" && typeof receiver !== "function") {
      const candidate = stack[receiverIndex - 1];
      if (candidate !== null && candidate !== undefined &&
          (typeof candidate === "object" || typeof candidate === "string" ||
           typeof candidate === "function")) {
        stack.splice(receiverIndex, 1);
        receiverIndex -= 1;
        receiver = candidate;
        this.graphStaleReceiverOperandRecoveryCount += 1;
      }
    }
    if (site.op !== "invokestatic" &&
        (receiver === null || receiver === undefined)) {
      throw { type: "java/lang/NullPointerException", message: null };
    }
    // Test the feature flag before doing the lookup, not after. The virtual
    // branch is a string-keyed dictionary access, and it used to run on every
    // call even when frame-positional calls were switched off entirely.
    if (this.framePositionalCallsEnabled) {
      let framePositional = null;
      if (site.op === "invokestatic" || site.op === "invokespecial") {
        framePositional = site.fastPositional;
      } else {
        const receiverType = receiver.type || site.declaredClassName;
        framePositional = site.fastPositionalTargets?.[receiverType] || null;
      }
      if (framePositional?.invoke?.jvmCanonicalFrameAdapter === true) {
        const positionalResult = this.tryInvokeFramePositional(
          site, framePositional.invoke, frame, thread);
        if (positionalResult !== ASYNC_INVOKE) {
          this.framePositionalCallCount += 1;
          return positionalResult;
        }
        this.framePositionalFallbackCount += 1;
      }
    }
    const jre = site.fastJreTarget;
    if (jre) {
      const receiver = site.op === "invokestatic" ? null
        : frame.stack.items[frame.stack.items.length - site.params.length - 1];
      if (site.op === "invokestatic" ||
          receiver !== null && receiver !== undefined &&
          (receiver.type || site.declaredClassName) === jre.targetClassName) {
        return this.tryInvokeSynchronousJre(site, jre, frame, thread);
      }
    }
    const fast = site.fastIntrinsic;
    if (fast) {
      if (!site.initializationToken.initialized ||
          this.jvm.debugManager.isClassJitDeopted(fast.lookupClass)) {
        return ASYNC_INVOKE;
      }
      const base = frame.stack.items.length - site.params.length;
      const value = fast.intrinsic(frame.stack.items, base);
      if (value === ASYNC_INVOKE) return ASYNC_INVOKE;
      frame.stack.items.length = base;
      if (this.profileMethods) {
        this.syncIntrinsicCallCount += 1;
        this.intrinsicMethodRunCounts.set(
          fast.methodKey,
          (this.intrinsicMethodRunCounts.get(fast.methodKey) || 0) + 1,
        );
      }
      return value;
    }
    const target = site.fastStaticTarget;
    if (target) {
      if (!site.initializationToken.initialized) {
        return ASYNC_INVOKE;
      }
      return this.tryInvokeResolvedTarget(site, target, frame, thread);
    }
    const special = site.fastSpecialTarget;
    if (special) {
      const receiver =
        frame.stack.items[frame.stack.items.length - site.params.length - 1];
      if (receiver === null || receiver === undefined) {
        throw { type: "java/lang/NullPointerException", message: null };
      }
      return this.tryInvokeResolvedTarget(site, special, frame, thread);
    }
    const dynamicIntrinsic = site.fastDynamicIntrinsic;
    if (dynamicIntrinsic) {
      const base = frame.stack.items.length - site.params.length - 1;
      const receiver = frame.stack.items[base];
      if (receiver === null || receiver === undefined) {
        throw { type: "java/lang/NullPointerException", message: null };
      }
      if ((receiver.type || site.declaredClassName) ===
          dynamicIntrinsic.targetClassName) {
        if (this.jvm.debugManager.isClassJitDeopted(dynamicIntrinsic.lookupClass)) {
          return ASYNC_INVOKE;
        }
        const value = dynamicIntrinsic.intrinsic(frame.stack.items, base);
        if (value === ASYNC_INVOKE) return ASYNC_INVOKE;
        frame.stack.items.length = base;
        if (this.profileMethods) {
          this.syncIntrinsicCallCount += 1;
          this.intrinsicMethodRunCounts.set(
            dynamicIntrinsic.methodKey,
            (this.intrinsicMethodRunCounts.get(dynamicIntrinsic.methodKey) || 0) + 1,
          );
        }
        return value;
      }
    }
    const dynamic = site.fastDynamicTarget;
    if (dynamic) {
      const receiver = frame.stack.items[frame.stack.items.length - site.params.length - 1];
      if (receiver === null || receiver === undefined) {
        throw { type: "java/lang/NullPointerException", message: null };
      }
      const receiverType = receiver.type || site.declaredClassName;
      if (receiverType === dynamic.targetClassName) {
        this.maybeExpandHotCallGraphRegion(site);
        return this.tryInvokeResolvedTarget(site, dynamic.target, frame, thread);
      }
      // Secondary receiver types at a polymorphic site. Without this they reach
      // their already-resolved target only by re-running the whole generic
      // path, including the JRE lookup, on every call. Types that resolve to a
      // JRE method are never recorded here, so JRE precedence is unaffected.
      const polymorphic = site.fastDynamicTargets;
      if (polymorphic && site.fastDynamicTargetsVersion ===
          (this.jvm.jni ? this.jvm.jni.registryVersion : 0)) {
        const resolved = polymorphic[receiverType];
        if (resolved !== undefined) {
          this.maybeExpandHotCallGraphRegion(site);
          return this.tryInvokeResolvedTarget(site, resolved, frame, thread);
        }
      }
    }
    return this.tryInvokeSyncSite(site, frame, thread);
  }

  tryInvokeFramePositional(site, invoke, frame, thread) {
    const receiverSlots = site.op === "invokestatic" ? 0 : 1;
    const argumentCount = site.params.length + receiverSlots;
    const stack = frame.stack.items;
    const base = stack.length - argumentCount;
    if (base < 0) return ASYNC_INVOKE;
    let result;
    switch (argumentCount) {
      case 0: result = invoke(thread); break;
      case 1: result = invoke(stack[base], thread); break;
      case 2: result = invoke(stack[base], stack[base + 1], thread); break;
      case 3: result = invoke(
        stack[base], stack[base + 1], stack[base + 2], thread); break;
      case 4: result = invoke(
        stack[base], stack[base + 1], stack[base + 2], stack[base + 3],
        thread); break;
      case 5: result = invoke(
        stack[base], stack[base + 1], stack[base + 2], stack[base + 3],
        stack[base + 4], thread); break;
      case 6: result = invoke(
        stack[base], stack[base + 1], stack[base + 2], stack[base + 3],
        stack[base + 4], stack[base + 5], thread); break;
      case 7: result = invoke(
        stack[base], stack[base + 1], stack[base + 2], stack[base + 3],
        stack[base + 4], stack[base + 5], stack[base + 6], thread); break;
      case 8: result = invoke(
        stack[base], stack[base + 1], stack[base + 2], stack[base + 3],
        stack[base + 4], stack[base + 5], stack[base + 6], stack[base + 7],
        thread); break;
      default: return ASYNC_INVOKE;
    }
    if (result === ASYNC_INVOKE) return ASYNC_INVOKE;
    if (result && result.deopt) {
      const child = result.jvmPositionalChild || null;
      delete result.jvmPositionalChild;
      if (!child || child === frame ||
          !thread.callStack.items.includes(child)) return ASYNC_INVOKE;
      child.jitGeneratedReturnParent = frame;
      child.jitGeneratedReturnType = site.returnType;
    }
    stack.length = base;
    return result;
  }

  tryInvokeSync(op, frame, instruction, thread) {
    const [, declaredClassName, [methodName, descriptor]] = instruction.arg;
    const key = `${op}\0${declaredClassName}\0${methodName}\0${descriptor}`;
    let site = this.legacySyncCallSites.get(key);
    if (!site) {
      const id = this.registerSyncCallSite(
        op, instruction, frame?.method || null,
        Number.isInteger(frame?.pc) ? frame.pc : null);
      site = this.syncCallSites[id];
      site.id = id;
      this.legacySyncCallSites.set(key, site);
    }
    return this.tryInvokeSyncAt(site.id, frame, thread);
  }

  getPositionalGeneratedInvoker(site, target) {
    if (!this.positionalGeneratedCallsEnabled) return null;
    if (!target || target.positionalInvoker === null) return null;
    if (target.positionalInvoker) return target.positionalInvoker;
    const { method, lookupClass, generated } = target;
    const positionalTracePattern = typeof process !== "undefined" && process.env
      ? process.env.JVM_TRACE_POSITIONAL_GENERATED || "" : "";
    const positionalTraceKey = method
      ? `${lookupClass}.${method.name}${site.descriptor}` : "";
    const positionalTrace = Boolean(
      positionalTracePattern && positionalTraceKey.includes(positionalTracePattern));
    if (positionalTrace) {
      console.error("[positional-selection]", JSON.stringify({
        method: positionalTraceKey,
        synchronous: generated?.jvmSynchronous === true,
        direct: typeof generated?.jvmDirectPositionalBody === "function",
        checkedLeaf:
          typeof generated?.jvmCheckedLeafDirectPositionalBody === "function",
        restoring:
          typeof generated?.jvmRestoringDirectPositionalBody === "function",
        intrinsic: Boolean(target.intrinsic),
        inline: Boolean(target.inlineIntegerRegion),
        memoized: Boolean(target.memoizedIntegralLeaf),
        fused: Boolean(method && this.fusedRegions.enabled &&
          this.fusedRegions.mayFuse(method)),
      }));
    }
    if (target.inlineIntegerRegion) {
      target.positionalInvoker = this.getDirectInlineIntegerRegion(
        method, site.params, site.returnType);
      return target.positionalInvoker;
    }
    if (!method || !generated || generated.jvmSynchronous !== true ||
        target.intrinsic || target.memoizedIntegralLeaf ||
        this.fusedRegions.enabled && this.fusedRegions.mayFuse(method)) {
      target.positionalInvoker = null;
      return null;
    }
    const receiverSlots = site.op === "invokestatic" ? 0 : 1;
    const argumentCount = site.params.length + receiverSlots;
    // Avoid pathological generated signatures while covering ordinary Java
    // source methods (including the renderer call graph) without an arguments
    // array or rest-parameter allocation.
    if (argumentCount > 32) {
      target.positionalInvoker = null;
      return null;
    }
    if (this.shouldCompileHotCallGraphRegion(method) &&
        !generated.jvmHotCallGraphRegionPlan) {
      this.compileHotCallGraphRegion(method);
    }
    const resumableHotGraphPositional =
      this.hotCallGraphRegions.enabled &&
      generated.jvmStructuredContinuation === true &&
      typeof generated.jvmAdaptivePositionalBody === "function";
    if (!resumableHotGraphPositional &&
        typeof generated.jvmHotCallGraphDirectPositionalBody === "function") {
      target.positionalInvoker =
        generated.jvmHotCallGraphDirectPositionalBody.bind(null, this);
      target.positionalInvoker.jvmDebugGuarded = true;
      target.positionalInvoker.jvmRestoresExceptionFrames = true;
      target.positionalInvoker.jvmRawInvoke =
        generated.jvmHotCallGraphDirectPositionalBody;
      return target.positionalInvoker;
    }
    if (!resumableHotGraphPositional &&
        typeof generated.jvmDirectPositionalBody === "function") {
      // This structurally proven acyclic integral leaf has its own scalar ABI:
      // bind the JIT helpers once and let the SSA caller feed operands straight
      // into the generated body. The caller's trailing thread argument is an
      // ignored extra JavaScript argument, so no adapter or child Frame is
      // needed on the normal path.
      target.positionalInvoker =
        generated.jvmDirectPositionalBody.bind(null, this);
      target.positionalInvoker.jvmDebugGuarded = true;
      return target.positionalInvoker;
    }
    if (!resumableHotGraphPositional &&
        this.checkedLeafDirectPositionalEnabled &&
        typeof generated.jvmCheckedLeafDirectPositionalBody === "function") {
      // A single bounded call-free loop can publish a compact checked leaf:
      // all class/debug/array predicates execute before its first guest
      // effect, while predicate failure returns to the canonical call path.
      // Keeping cold Frame restoration out of this body lets JavaScript
      // engines inline it into loop-bearing callers without a handwritten
      // guest algorithm or identity-specific recognizer.
      const nestedBody =
        typeof generated.jvmTrustedCheckedLeafDirectPositionalBody === "function"
          ? generated.jvmTrustedCheckedLeafDirectPositionalBody
          : generated.jvmCheckedLeafDirectPositionalBody;
      target.positionalInvoker = nestedBody.bind(null, this);
      target.positionalInvoker.jvmDebugGuarded = true;
      target.positionalInvoker.jvmCheckedLeaf = true;
      // Generated callers already hold the JIT helper object. Expose the raw
      // fixed-arity body alongside the canonical bound entry so they can call
      // a normal JavaScript function that optimizing engines may inline. The
      // bound entry remains the public/cold ABI and preserves existing call
      // sites. Selection is based solely on the verified checked-leaf shape.
      target.positionalInvoker.jvmRawInvoke =
        nestedBody;
      return target.positionalInvoker;
    }
    if (!resumableHotGraphPositional &&
        typeof generated.jvmRestoringDirectPositionalBody === "function") {
      // A verified acyclic field/primitive-array leaf can use the same scalar
      // call ABI without eagerly constructing its child Frame.  Its generated
      // body materializes a cached Frame only at a throwing bytecode, then this
      // plan restores that omitted callee beneath the ordinary JVM exception
      // dispatcher.
      const plan = {
        target,
        Frame,
        method,
        lookupClass,
        semantic: generated.jvmRestoringDirectPositionalPlan || null,
        restoreFrame: (thread, child, restorationDepth) => {
          const frames = thread.callStack.items;
          if (frames.includes(child)) return;
          const insertion = Number.isInteger(restorationDepth)
            ? Math.max(0, Math.min(restorationDepth, frames.length))
            : frames.length;
          frames.splice(insertion, 0, child);
        },
      };
      target.positionalInvoker =
        generated.jvmRestoringDirectPositionalBody.bind(null, this, plan);
      target.positionalInvoker.jvmDebugGuarded = true;
      // The restoring scalar ABI reconstructs an omitted child Frame at the
      // precise throwing operation. Its caller must therefore retain the
      // invoke pc and operands until the ordinary exception dispatcher has
      // processed that reconstructed frame.
      target.positionalInvoker.jvmRestoresExceptionFrames = true;
      return target.positionalInvoker;
    }
    const argumentsList = Array.from(
      { length: argumentCount }, (_unused, index) => `argument${index}`);
    const localAssignments = [];
    let local = 0;
    if (receiverSlots) {
      localAssignments.push(`child.locals[0] = argument0;`);
      local = 1;
    }
    for (let index = 0; index < site.params.length; index += 1) {
      localAssignments.push(
        `child.locals[${local}] = argument${index + receiverSlots};`);
      local += site.params[index] === "long" || site.params[index] === "double" ? 2 : 1;
    }
    const staticGuard = site.op === "invokestatic"
      ? `if (!plan.staticInitialization.initialized) return plan.asyncInvoke;`
      : "";
    const tracePattern = positionalTracePattern;
    const methodKey = `${lookupClass}.${method.name}${site.descriptor}`;
    const trace = Boolean(tracePattern && methodKey.includes(tracePattern));
    const traceEntry = trace
      ? `console.error("[positional-entry] ${methodKey} args=" + [${
        argumentsList.join(", ")}].map(plan.describe).join(","));`
      : "";
    const traceResult = trace
      ? `console.error("[positional-exit] ${methodKey} " + ` +
        `(result && result.deopt ? "deopt:" + result.reason : ` +
        `plan.describe(useFrameless ? result : result && result.value)));`
      : "";
    // A call-bearing instance entry may restore a suspended child after a
    // graph module has republished one of its nested targets. Until that
    // restoration ABI carries an independently verified receiver slot, keep
    // the instance Frame canonical: otherwise a primitive nested return can
    // be restored into local0 and later be consumed as `this` by putfield.
    const graphUnsafeInstanceCallEntry =
      this.hotCallGraphRegions.enabled && receiverSlots === 1 &&
      generated.jvmStructuredRegionCallSites?.length > 0;
    const immediateFramelessBody = !graphUnsafeInstanceCallEntry &&
      generated.jvmFramelessPositional === true ? generated : null;
    // A continuation-capable region must own the iterator from its first
    // positional invocation. Running its finite ordinary module first can
    // exhaust the scalar budget, reconstruct the root at a mid-method PC, and
    // permanently resume method-at-a-time. The framed regional body keeps one
    // canonical root Frame across scheduler yields while every internal node
    // remains scalar/local to the module.
    const hotGraphFramedBody = resumableHotGraphPositional &&
      typeof generated.jvmHotCallGraphFramedBody === "function"
      ? generated.jvmHotCallGraphFramedBody : null;
    const adaptiveFramelessBody = graphUnsafeInstanceCallEntry ? null :
      hotGraphFramedBody || generated.jvmAdaptivePositionalBody || null;
    const canonicalGeneratedBody = hotGraphFramedBody || generated;
    // Reference-returning adaptive entries can hand an object back while a
    // nested scheduler-visible continuation still owns it. Keep those calls on
    // the canonical child-Frame path. Acyclic entries explicitly marked
    // jvmFramelessPositional cannot suspend, so their reference return is just
    // as safe as a primitive and needs no child Frame.
    const primitiveReturn = new Set([
      "boolean", "byte", "char", "short", "int",
      "long", "float", "double", "void",
    ]).has(site.returnType);
    const referenceFrameless =
      !primitiveReturn && Boolean(immediateFramelessBody);
    const framelessBody = immediateFramelessBody ||
      (primitiveReturn ? adaptiveFramelessBody : null);
    const framelessMode = !framelessBody ? 0
      : immediateFramelessBody ? 1 : 2;
    const source = [
      "'use strict';",
      "const jit = plan.jit;",
      staticGuard,
      traceEntry,
      "const target = plan.target;",
      "if (target.freeFrame && jit.profileMethods) jit.syncReusedFrameCount += 1;",
      "const child = target.freeFrame || new plan.Frame(plan.method);",
      "target.freeFrame = null;",
      "child.pc = 0;",
      "child.stack.items.length = 0;",
      "delete child.jitSkipOnce;",
      "delete child.jitJsDisabled;",
      "delete child.jitAdaptiveEntryCounted;",
      "delete child.jitGeneratedReturnParent;",
      "delete child.jitGeneratedReturnType;",
      "child.className = plan.lookupClass;",
      ...localAssignments,
      "const adaptiveFrameless = plan.framelessMode === 2;",
      "const useFrameless = plan.framelessMode === 1 ||",
      "  (adaptiveFrameless && target.preferFrameless === true);",
      "let result;",
      "let baseDepth = -1;",
      "const entryDepth = thread.callStack.items.length;",
      "let positionalTimingStarted = -1;",
      "let positionalExclusiveTiming = null;",
      "if (useFrameless) {",
      // Record the canonical insertion point before attempting the implied
      // synchronized-method monitor. A contended monitor is itself a deopt:
      // the child must be restored above its caller even though its generated
      // body never started. Leaving the sentinel -1 here would make
      // Array.splice insert the child below the caller, resume the caller at
      // its post-invoke PC, and lose a non-void return operand.
      "  baseDepth = thread.callStack.items.length;",
      // A frameless entry runs the body with no Frame on the call stack, so the
      // implied ACC_SYNCHRONIZED monitor is entered against the child Frame that
      // already exists for locals and released explicitly below -- CallStack.pop
      // never sees this call. Contention degrades to the ordinary deopt path,
      // which restores the child and lets the scheduler block on it.
      "  if (child.isSynchronizedMethod && !child.monitorEntered &&",
      "      !jit.jvm.enterFrameMonitorIfNeeded(child, thread)) {",
      "    result = { deopt: true, reason: 'synchronized monitor contended' };",
      "  } else {",
      "  if (plan.referenceFrameless) jit.referenceFramelessPositionalRunCount += 1;",
      "  if (plan.compiledCallChain) jit.compiledCallChainRunCount += 1;",
      "  if (jit.shouldBeginExclusiveTimingKey(plan.methodKey)) {",
      "    positionalExclusiveTiming = jit.beginExclusiveTiming(plan.methodKey, plan.exclusiveTier);",
      "  }",
      "  if (jit.profileTimings) {",
      "    jit.methodTimingRandomState = (Math.imul(jit.methodTimingRandomState, 1664525) + 1013904223) >>> 0;",
      "    if (jit.methodTimingRandomState < 0x100000000 / jit.methodTimingSampleRate) {",
      "      positionalTimingStarted = jit.monotonicNow();",
      "    }",
      "  }",
      "  try {",
      "    result = plan.framelessBody(child, thread, jit, false, true);",
      "  } catch (error) {",
      "    jit.endExclusiveTiming(positionalExclusiveTiming);",
      "    if (positionalTimingStarted >= 0) {",
      "      jit.recordMethodTiming(plan.methodKey, jit.monotonicNow() - positionalTimingStarted, plan.generated);",
      "    }",
      "    plan.restoreFrame(thread, baseDepth, child);",
      "    if (adaptiveFrameless) {",
      "      target.preferFrameless = false;",
      "      target.framelessRejected = true;",
      "    }",
      "    throw error;",
      "  }",
      "  if (positionalTimingStarted >= 0) {",
      "    jit.recordMethodTiming(plan.methodKey, jit.monotonicNow() - positionalTimingStarted, plan.generated);",
      "  }",
      "  jit.endExclusiveTiming(positionalExclusiveTiming);",
      "  }",
      "} else {",
      "  thread.callStack.push(child);",
      // The implied monitor of a synchronized callee has to be held before its
      // body runs. Uncontended entry is a couple of field writes and stays in
      // generated code; a contended one yields to the scheduler as BLOCKED and
      // the interpreter re-enters the already-pushed child once it is free.
      "  if (child.isSynchronizedMethod && !child.monitorEntered &&",
      "      !jit.jvm.enterFrameMonitorIfNeeded(child, thread)) {",
      "    result = { deopt: true, reason: 'synchronized monitor contended' };",
      "  } else {",
      "  result = jit.runGeneratedFrame(plan.canonicalGeneratedBody, child, thread, false);",
      "  if (result && typeof result.then === 'function') {",
      "    throw new Error('Synchronous positional method returned a Promise');",
      "  }",
      "  }",
      "}",
      traceResult,
      "if (result && result.deopt) {",
      "  if (useFrameless) {",
      "    plan.restoreFrame(thread, baseDepth, child);",
      "    if (adaptiveFrameless) {",
      "      target.preferFrameless = false;",
      "      target.framelessRejected = true;",
      "    }",
      "  } else if (adaptiveFrameless && !target.framelessRejected &&",
      "      result.reason === 'structured SSA continuation') {",
      "    target.framelessBudgetYields = (target.framelessBudgetYields || 0) + 1;",
      "    if (target.framelessBudgetYields >= plan.adaptiveYieldThreshold) {",
      "      target.preferFrameless = true;",
      "    }",
      "  }",
      "  result.jvmPositionalChild = child;",
      "  return result;",
      "}",
      "if (useFrameless && child.monitorEntered === true) {",
      "  jit.jvm.exitFrameMonitor(child);",
      "}",
      "if (adaptiveFrameless && !useFrameless && !target.framelessRejected) {",
      "  target.framelessWarmCompletions = (target.framelessWarmCompletions || 0) + 1;",
      "  if (target.framelessWarmCompletions >= plan.adaptiveThreshold) {",
      "    target.preferFrameless = true;",
      "  }",
      "}",
      "target.freeFrame = child;",
      "if (jit.debugPositionalDepth && thread.callStack.items.length !== entryDepth) {",
      "  const frames = thread.callStack.items;",
      "  console.error('[positional-depth-leak]', JSON.stringify({",
      "    callee: plan.methodKey, useFrameless, entryDepth,",
      "    depth: frames.length,",
      "    leaked: frames.slice(entryDepth).map(f =>",
      "      `${f.className}.${f.method && f.method.name}@pc${f.pc}`),",
      "  }) + '\\n' + new Error().stack.split('\\n').slice(2, 12).join('\\n'));",
      "}",
      site.returnType === "void"
        ? "return plan.returnVoid;"
        : "return useFrameless ? result : result.value;",
    ].filter(Boolean).join("\n");
    try {
      let templates = this.positionalGeneratedEntryTemplates.get(method);
      if (!templates) {
        templates = new Map();
        this.positionalGeneratedEntryTemplates.set(method, templates);
      }
      const templateKey = `${lookupClass}\0${site.op}\0${site.descriptor}\0${
        trace ? 1 : 0}`;
      let entry = templates.get(templateKey);
      if (entry) {
        this.positionalGeneratedTemplateReuseCount += 1;
      } else {
        entry = this.createGeneratedFunction(method, "positional-entry",
          ["plan", ...argumentsList, "thread"], source, lookupClass);
        templates.set(templateKey, entry);
        this.positionalGeneratedTemplateCompileCount += 1;
      }
      const plan = {
        jit: this,
        target,
        Frame,
        staticInitialization: site.initializationToken,
        method,
        methodKey,
        generated,
        canonicalGeneratedBody,
        exclusiveTier: generated.jvmStructuredSsa ? "structured"
          : generated.jvmScalarLoop ? "scalar" : "generated-sync",
        framelessMode,
        framelessBody,
        compiledCallChain: generated.jvmCompiledCallChain === true,
        referenceFrameless,
        adaptiveThreshold: 4,
        adaptiveYieldThreshold: 4,
        lookupClass,
        staticOwner: site.declaredClassName,
        asyncInvoke: ASYNC_INVOKE,
        returnVoid: RETURN_VOID,
        restoreFrame: (thread, baseDepth, child) => {
          const frames = thread.callStack.items;
          if (!frames.includes(child)) {
            frames.splice(Math.min(baseDepth, frames.length), 0, child);
          }
        },
        describe: (value) => value === null ? "null"
          : value === undefined ? "undefined"
            : value && (value._className || value.type) || typeof value,
      };
      target.positionalInvoker = entry.bind(null, plan);
      target.positionalInvoker.jvmCanonicalFrameAdapter = true;
      return target.positionalInvoker;
    } catch (_) {
      target.positionalInvoker = null;
      return null;
    }
  }

  getPositionalJreInvoker(site, target) {
    if (!target || target.positionalInvoker === null) return null;
    if (target.positionalInvoker) return target.positionalInvoker;
    const receiverSlots = site.op === "invokestatic" ? 0 : 1;
    const argumentCount = site.params.length + receiverSlots;
    if (argumentCount > 32 || typeof target.method !== "function") {
      target.positionalInvoker = null;
      return null;
    }
    const argumentsList = Array.from(
      { length: argumentCount }, (_unused, index) => `argument${index}`);
    const receiver = receiverSlots ? "argument0" : "null";
    const callArguments = argumentsList.slice(receiverSlots);
    const direct = typeof target.method.jvmDirectIntrinsic === "function" &&
      (receiverSlots === 1 || this.directStaticJreIntrinsicsEnabled) &&
      target.method.jvmDirectFinal === true
      ? target.method.jvmDirectIntrinsic : null;
    const invocation = direct
      ? `plan.direct(${argumentsList.join(", ")})`
      : `plan.method(plan.jvm, ${receiver}, [${
        callArguments.join(", ")}], thread)`;
    const staticGuard = site.op === "invokestatic"
      ? `if (!plan.staticInitialization.initialized) return plan.asyncInvoke;`
      : "";
    const source = [
      "'use strict';",
      staticGuard,
      `const result = ${invocation};`,
      "if (result === plan.asyncMethod || result && typeof result.then === 'function') {",
      "  return plan.asyncInvoke;",
      "}",
      site.returnType === "void"
        ? "return plan.returnVoid;"
        : "return typeof result === 'boolean' ? (result ? 1 : 0) : result;",
    ].filter(Boolean).join("\n");
    try {
      const identity = {
        name: site.methodName,
        descriptor: site.descriptor,
      };
      let templates = this.positionalJreEntryTemplates.get(target.method);
      if (!templates) {
        templates = new Map();
        this.positionalJreEntryTemplates.set(target.method, templates);
      }
      const templateKey = `${target.targetClassName}\0${site.op}\0${
        site.methodName}\0${site.descriptor}\0${direct ? 1 : 0}`;
      let entry = templates.get(templateKey);
      if (entry) {
        this.positionalJreTemplateReuseCount += 1;
      } else {
        entry = this.createGeneratedFunction(identity, "positional-jre",
          ["plan", ...argumentsList, "thread"], source, target.targetClassName);
        templates.set(templateKey, entry);
        this.positionalJreTemplateCompileCount += 1;
      }
      const plan = {
        jvm: this.jvm,
        method: target.method,
        direct,
        staticOwner: site.declaredClassName,
        staticInitialization: site.initializationToken,
        asyncMethod: ASYNC_METHOD_SENTINEL,
        asyncInvoke: ASYNC_INVOKE,
        returnVoid: RETURN_VOID,
      };
      target.positionalInvoker = entry.bind(null, plan);
      return target.positionalInvoker;
    } catch (_) {
      target.positionalInvoker = null;
      return null;
    }
  }

  tryInvokeSyncSite(site, frame, thread) {
    const { op, declaredClassName, methodName, descriptor, params, returnType } = site;
    if (op === "invokestatic" &&
        !site.initializationToken.initialized) {
      return ASYNC_INVOKE;
    }

    const receiverOffset = params.length + (op === "invokestatic" ? 0 : 1);
    const receiver = op === "invokestatic"
      ? null
      : frame.stack.items[frame.stack.items.length - receiverOffset];
    if (op !== "invokestatic" && (receiver === null || receiver === undefined)) {
      throw { type: "java/lang/NullPointerException", message: null };
    }

    let targetClassName = declaredClassName;
    if (op === "invokevirtual" || op === "invokeinterface") {
      targetClassName = receiver.type || declaredClassName;
    }
    // When Wasm is the preferred tier, leave static shims available to its
    // linker; consuming a Math call in a JS fallback can otherwise prevent a
    // numeric caller from reaching Wasm. Whole-method JavaScript mode instead
    // keeps both static and instance JRE leaves inside the generated region.
    const wholeMethodCaller = this.prefersWholeMethodJs(frame.method);
    const keepStaticForWasm = op === "invokestatic" &&
      this.wasmJit.enabled && !wholeMethodCaller;
    const cachedJreTarget = !keepStaticForWasm &&
      site.jreTargets?.get(targetClassName);
    if (cachedJreTarget) {
      site.fastJreTarget = cachedJreTarget;
      return this.tryInvokeSynchronousJre(
        site, cachedJreTarget, frame, thread);
    }
    const synchronousJre = keepStaticForWasm ? null
      : this.resolveSynchronousJreMethod(
        targetClassName, declaredClassName, methodName, descriptor);
    if (synchronousJre) {
      const target = { targetClassName, method: synchronousJre };
      if (!site.jreTargets) site.jreTargets = new Map();
      site.jreTargets.set(targetClassName, target);
      site.fastJreTarget = target;
      const positional = this.getPositionalJreInvoker(site, target);
      if (positional && !site.fastPositional) {
        site.fastPositional = {
          invoke: positional,
          lookupClass: targetClassName,
          receiverType: op === "invokestatic" ? null : targetClassName,
          debugGuarded: positional.jvmDebugGuarded === true,
        };
      }
      return this.tryInvokeSynchronousJre(site, target, frame, thread);
    }
    let target = site.targets.get(targetClassName);
    if (!target) {
      let classData = this.jvm.classes[targetClassName];
      if (!classData) return ASYNC_INVOKE;
      let method = this.jvm.findMethod(classData, methodName, descriptor);
      let lookupClass = targetClassName;
      while (!method && (op === "invokevirtual" || op === "invokeinterface") &&
        classData && classData.ast.classes[0].superClassName) {
        lookupClass = classData.ast.classes[0].superClassName;
        classData = this.jvm.classes[lookupClass];
        if (!classData) return ASYNC_INVOKE;
        method = this.jvm.findMethod(classData, methodName, descriptor);
      }
      if (!method) return ASYNC_INVOKE;
      // The Firefox whole-method tier deliberately accepts a wider verified
      // opcode/control-flow set than the legacy runner. Keep nested calls in
      // that same tier: otherwise a generated caller yields to the scheduler,
      // only for the child to be admitted by tryRunFrame on the next turn.
      // This is a structural capability check; no class or method identity is
      // involved.
      const normallySupported = this.isSupported(method) ||
        this.isShortSupportedHelper(method) ||
        (wholeMethodCaller && this.isCodegenSupported(method));
      const fusedCandidate = op === "invokestatic" &&
        this.fusedRegions.mayFuse(method);
      // A semantic intrinsic can cover a method whose raw bytecodes are too
      // large/irregular for the ordinary method tier.  Probe it before the
      // generic support rejection.  For the polygon family the final span
      // owner may still be cold; retain only the cheap dependency list and
      // perform the complete fingerprint proof once that owner loads.
      const structuralIntrinsic = op === "invokestatic"
        ? this.getSynchronousIntrinsic(method, descriptor)
        : null;
      if (!normallySupported && !fusedCandidate &&
          !structuralIntrinsic) {
        return ASYNC_INVOKE;
      }
      target = {
        method,
        lookupClass,
        targetClassName,
        intrinsic: structuralIntrinsic,
        inlineIntegerRegion: normallySupported &&
          (op === "invokestatic" || op === "invokevirtual" || op === "invokeinterface")
          ? this.getInlineIntegerRegion(method, params, returnType)
          : null,
      };
      if (normallySupported && op !== "invokestatic") {
        const instanceIntrinsic = this.getSynchronousIntrinsic(method, descriptor);
        if (instanceIntrinsic?.jvmReceiverSlots === 1) {
          target.intrinsic = instanceIntrinsic;
        }
      }
      if (normallySupported && op === "invokestatic" &&
          !target.intrinsic && !target.inlineIntegerRegion) {
        target.memoizedIntegralLeaf =
          this.getMemoizedIntegralLeaf(method, params, returnType);
      }
      if (normallySupported && !target.intrinsic && !target.inlineIntegerRegion) {
        target.generated = this.getGeneratedFunction(method);
        this.trackGeneratedTarget(method, target, site);
      }
      site.targets.set(targetClassName, target);
      if (op === "invokestatic" && target.intrinsic) {
        site.fastIntrinsic = {
          intrinsic: target.intrinsic,
          lookupClass,
          methodKey: `${lookupClass}.${method.name}${descriptor}`,
        };
      } else if (op === "invokestatic") {
        site.fastStaticTarget = target;
        const positional = this.getPositionalGeneratedInvoker(site, target);
        if (positional && !site.fastPositional) {
          site.fastPositional = {
            invoke: positional,
            rawInvoke: positional.jvmRawInvoke || null,
            lookupClass,
            receiverType: null,
            debugGuarded: positional.jvmDebugGuarded === true,
          };
          const tracePattern = typeof process !== "undefined" && process.env
            ? process.env.JVM_TRACE_POSITIONAL_GENERATED || "" : "";
          const traceKey = `${lookupClass}.${method.name}${descriptor}`;
          if (tracePattern && traceKey.includes(tracePattern)) {
            console.error("[positional-published]", JSON.stringify({
              method: traceKey,
              debugGuarded: site.fastPositional.debugGuarded,
            }));
          }
        }
      } else if (op === "invokespecial") {
        // Private/super helpers are monomorphic by bytecode semantics. Cache
        // them independently from virtual receiver types and publish the same
        // fixed-arity positional entry used by other generated callees.
        // Constructors never reach this branch because method admission keeps
        // <init> outside generated execution.
        site.fastSpecialTarget = target;
        const positional = this.getPositionalGeneratedInvoker(site, target);
        if (positional && !site.fastPositional) {
          site.fastPositional = {
            invoke: positional,
            rawInvoke: positional.jvmRawInvoke || null,
            lookupClass,
            receiverType: null,
            debugGuarded: positional.jvmDebugGuarded === true,
          };
        }
      } else if (op === "invokevirtual" || op === "invokeinterface") {
        // A virtual bytecode site may be polymorphic. Each resolved receiver
        // target still deserves its own positional adapter; limiting adapter
        // creation to the first monomorphic fast slot forced every secondary
        // receiver through a child Frame on every invocation.
        const positional = this.getPositionalGeneratedInvoker(site, target);
        const intrinsicPositional = typeof target.intrinsic?.jvmPositional ===
          "function" ? target.intrinsic.jvmPositional : null;
        const direct = intrinsicPositional || positional;
        if (direct) {
          if (!site.fastPositionalTargets) {
            site.fastPositionalTargets = Object.create(null);
          }
          site.fastPositionalTargets[targetClassName] = {
            invoke: direct,
            rawInvoke: direct.jvmRawInvoke || null,
            lookupClass,
            receiverType: targetClassName,
            debugGuarded: direct.jvmDebugGuarded === true,
          };
        }
        // The monomorphic slot below only ever holds the first receiver type.
        // Keep every resolved receiver in a by-type map as well, so a
        // polymorphic site does not walk the whole generic resolution path on
        // each call for its second and subsequent types. The stored value is
        // the same target object that site.targets holds, so an in-place
        // generated-code upgrade is visible through both.
        const registryVersion = this.jvm.jni ? this.jvm.jni.registryVersion : 0;
        if (!site.fastDynamicTargets ||
            site.fastDynamicTargetsVersion !== registryVersion) {
          site.fastDynamicTargets = Object.create(null);
          site.fastDynamicTargetsVersion = registryVersion;
        }
        site.fastDynamicTargets[targetClassName] = target;
        if (!site.fastDynamicTarget) {
          site.fastDynamicTarget = { targetClassName, target, positional };
          if (target.intrinsic) {
            site.fastDynamicIntrinsic = {
              targetClassName,
              intrinsic: target.intrinsic,
              positional: typeof target.intrinsic.jvmPositional === "function"
                ? target.intrinsic.jvmPositional : null,
              lookupClass,
              methodKey: `${lookupClass}.${method.name}${descriptor}`,
            };
          }
          const monomorphicDirect =
            site.fastDynamicIntrinsic?.positional || positional;
          if (monomorphicDirect && !site.fastPositional) {
            site.fastPositional = {
              invoke: monomorphicDirect,
              rawInvoke: monomorphicDirect.jvmRawInvoke || null,
              lookupClass,
              receiverType: targetClassName,
              debugGuarded: monomorphicDirect.jvmDebugGuarded === true,
            };
          }
          // Runtime receiver feedback closes this exact caller/bytecode edge.
          if (site.callerMethod &&
              this.shouldCompileHotCallGraphRegion(site.callerMethod)) {
            const callerGenerated = this.codegenCache.get(site.callerMethod);
            const callerPlan = callerGenerated?.jvmHotCallGraphRegionPlan;
            this.hotCallGraphRegions.markCallSiteFeedback(site);
            // Establish the first usable plan immediately. Later target/type
            // discoveries are batched by the region entry, but without an
            // initial plan a positional root has no shared entry at which it
            // could consume pending feedback.
            if (!callerPlan || !callerPlan.backendEligible) {
              this.compileHotCallGraphRegion(site.callerMethod);
            }
          }
        }
      }
    }

    return this.tryInvokeResolvedTarget(site, target, frame, thread);
  }

  resolveSynchronousJreMethod(targetClassName, declaredClassName, methodName, descriptor) {
    const method = this.jvm._jreFindMethod(targetClassName, methodName, descriptor) ||
      this.jvm._jreFindMethod(declaredClassName, methodName, descriptor);
    if (typeof method !== "function") return null;
    const constructorName = method.constructor && method.constructor.name;
    if (constructorName === "AsyncFunction") return null;
    // A small number of synchronous-looking reflection/thread shims install
    // Java frames and return this sentinel. They must retain the canonical
    // asynchronous handoff path.
    let source = "";
    try { source = Function.prototype.toString.call(method); } catch (_) { return null; }
    if (source.includes("ASYNC_METHOD_SENTINEL")) return null;
    return method;
  }

  tryInvokeSynchronousJre(site, target, frame, thread) {
    const { op, params, returnType } = site;
    const receiverSlots = op === "invokestatic" ? 0 : 1;
    const base = frame.stack.items.length - params.length - receiverSlots;
    const receiver = receiverSlots ? frame.stack.items[base] : null;
    if (receiverSlots && (receiver === null || receiver === undefined)) {
      throw { type: "java/lang/NullPointerException", message: null };
    }
    const args = frame.stack.items.slice(base + receiverSlots);
    const result = target.method(this.jvm, receiver, args, thread);
    // Classification above rejects declared async functions. Be conservative
    // if a plain shim unexpectedly returns an asynchronous handoff: leave the
    // operands untouched, disable this fast target, and use the canonical path.
    if (result === ASYNC_METHOD_SENTINEL ||
        result && typeof result.then === "function") {
      site.fastJreTarget = null;
      return ASYNC_INVOKE;
    }
    frame.stack.items.length = base;
    if (this.profileMethods) {
      this.syncIntrinsicCallCount += 1;
      const methodKey =
        `${target.targetClassName}.${site.methodName}${site.descriptor}`;
      this.intrinsicMethodRunCounts.set(
        methodKey, (this.intrinsicMethodRunCounts.get(methodKey) || 0) + 1);
    }
    if (returnType === "void" || result === undefined) return RETURN_VOID;
    return typeof result === "boolean" ? (result ? 1 : 0) : result;
  }

  tryInvokeResolvedTarget(site, target, frame, thread) {
    const { op, descriptor, params, returnType } = site;
    const receiverSlots = op === "invokestatic" ? 0 : 1;
    const availableOperands = frame.stack.items.length;
    const requiredOperands = params.length + receiverSlots;
    if (availableOperands < requiredOperands) {
      this.syncOperandUnderflowFallbackCount += 1;
      const callerMethod = frame.method || {};
      const caller = `${frame.className || callerMethod.className || "<unknown>"}.` +
        `${callerMethod.name || "<unknown>"}${callerMethod.descriptor || ""}`;
      const callee = `${target.lookupClass || site.declaredClassName || "<unknown>"}.` +
        `${target.method?.name || site.methodName || "<unknown>"}${descriptor}`;
      const signature = `${caller}@${frame.pc}:${op}:${callee}:` +
        `${availableOperands}/${requiredOperands}`;
      if (!this.reportedSyncOperandUnderflows.has(signature)) {
        this.reportedSyncOperandUnderflows.add(signature);
        console.error("[jit-sync-operand-underflow]", {
          caller,
          callerPc: frame.pc,
          callee,
          op,
          availableOperands,
          requiredOperands,
          callerLocals: frame.locals.slice(0, 8).map((value) =>
            value === null ? "null" : value === undefined ? "undefined"
              : value && (value._className || value.type) || typeof value),
          callStack: thread?.callStack?.items?.slice(-12).map((candidate) => ({
            method: `${candidate.className || "<unknown>"}.` +
              `${candidate.method?.name || "<unknown>"}` +
              `${candidate.method?.descriptor || ""}`,
            pc: candidate.pc,
            operands: candidate.stack?.items?.length,
            generatedParent: candidate.jitGeneratedReturnParent
              ? `${candidate.jitGeneratedReturnParent.className || "<unknown>"}.` +
                `${candidate.jitGeneratedReturnParent.method?.name || "<unknown>"}` +
                `${candidate.jitGeneratedReturnParent.method?.descriptor || ""}`
              : null,
            generatedReturnType: candidate.jitGeneratedReturnType || null,
          })),
          hostStack: new Error("generated invocation operand underflow").stack,
        });
      }
      return ASYNC_INVOKE;
    }
    const {
      method, lookupClass, inlineIntegerRegion, memoizedIntegralLeaf, generated,
    } = target;
    const intrinsic = target.intrinsic;
    const receiver = receiverSlots
      ? frame.stack.items[availableOperands - params.length - 1]
      : null;
    if (this.jvm.debugManager.isClassJitDeopted(lookupClass)) return ASYNC_INVOKE;
    if (this.fusedRegions.enabled) {
      const fused = this.fusedRegions.tryInvoke(site, target, frame, thread);
      if (fused.matched && fused.handled) return RETURN_VOID;
    }
    if (intrinsic) {
      const receiverSlots = intrinsic.jvmReceiverSlots | 0;
      const base = frame.stack.items.length - params.length - receiverSlots;
      const value = intrinsic(frame.stack.items, base);
      if (value === ASYNC_INVOKE) return ASYNC_INVOKE;
      frame.stack.items.length = base;
      if (this.profileMethods) {
        this.syncIntrinsicCallCount += 1;
        const methodKey = `${lookupClass}.${method.name}${descriptor}`;
        this.intrinsicMethodRunCounts.set(
          methodKey, (this.intrinsicMethodRunCounts.get(methodKey) || 0) + 1,
        );
      }
      return value;
    }
    if (inlineIntegerRegion) {
      if (inlineIntegerRegion.jvmNested && this.needsBytecodeChecks()) return ASYNC_INVOKE;
      const receiverSlots = op === "invokestatic" ? 0 : 1;
      const base = frame.stack.items.length - params.length - receiverSlots;
      const value = inlineIntegerRegion(frame.stack.items, base);
      frame.stack.items.length = base;
      if (this.profileMethods) {
        this.syncInlinedCallCount += 1;
        const methodKey = `${lookupClass}.${method.name}${descriptor}`;
        this.inlinedMethodRunCounts.set(
          methodKey, (this.inlinedMethodRunCounts.get(methodKey) || 0) + 1,
        );
      }
      return value;
    }
    if (!generated || !generated.jvmSynchronous) return ASYNC_INVOKE;

    const argumentBase = frame.stack.items.length - params.length;
    let memoKey = NO_MEMO_KEY;
    if (memoizedIntegralLeaf && !this.needsBytecodeChecks()) {
      memoKey = this.memoizedIntegralKey(
        memoizedIntegralLeaf, frame.stack.items, argumentBase);
      if (memoKey !== NO_MEMO_KEY && memoizedIntegralLeaf.values.has(memoKey)) {
        const value = memoizedIntegralLeaf.values.get(memoKey);
        frame.stack.items.length = argumentBase;
        if (this.profileMethods) this.memoizedIntegralLeafHitCount += 1;
        return value;
      }
      if (memoKey !== NO_MEMO_KEY && this.profileMethods) {
        this.memoizedIntegralLeafMissCount += 1;
      }
    }

    const child = target.freeFrame || new Frame(method);
    if (target.freeFrame && this.profileMethods) this.syncReusedFrameCount += 1;
    target.freeFrame = null;
    child.pc = 0;
    // Verified bytecode cannot read a non-parameter local before storing it, so
    // normal execution does not need to erase every slot in a recycled frame.
    // Keep the clear when debugger/breakpoint checks are active so a suspended
    // frame never exposes values left by its previous invocation.
    if (this.needsBytecodeChecks()) child.locals.fill(undefined);
    child.stack.items.length = 0;
    // Assign undefined rather than deleting. Every consumer of these five
    // fields tests them for truthiness or identity, so undefined and absent are
    // indistinguishable, but `delete` on a recycled frame drops the object into
    // dictionary mode on every single call through this boundary.
    child.jitSkipOnce = undefined;
    child.jitJsDisabled = undefined;
    child.jitAdaptiveEntryCounted = undefined;
    child.jitGeneratedReturnParent = undefined;
    child.jitGeneratedReturnType = undefined;
    child.className = lookupClass;
    if (this.frameHandoffTracePattern) {
      const parentIdentity = `${frame.className || "?"}.${frame.method?.name || "?"}${
        frame.method?.descriptor || ""}`;
      if (parentIdentity.includes(this.frameHandoffTracePattern) &&
          (!Number.isInteger(this.frameHandoffTracePc) ||
           frame.pc === this.frameHandoffTracePc)) {
        child.jitFrameHandoffTrace = {
          parent: parentIdentity,
          parentPc: frame.pc,
          child: `${child.className || "?"}.${child.method?.name || "?"}${
            child.method?.descriptor || ""}`,
          dispatchedBy: "generated",
        };
        console.error("[jvm-frame-handoff-push] " + JSON.stringify(
          child.jitFrameHandoffTrace));
      }
    }
    let localIndex = 0;
    if (op !== "invokestatic") {
      child.locals[0] = receiver;
      localIndex = 1;
    }
    for (let i = 0; i < params.length; i += 1) {
      child.locals[localIndex] = frame.stack.items[argumentBase + i];
      localIndex += params[i] === "long" || params[i] === "double" ? 2 : 1;
    }
    frame.stack.items.length = argumentBase - receiverSlots;
    thread.callStack.push(child);
    // See the positional emitter: a synchronized callee must hold its monitor
    // before its body runs, and a contended entry becomes an ordinary deopt so
    // the scheduler can block this thread on the already-pushed child.
    if (child.isSynchronizedMethod && !child.monitorEntered &&
        !this.jvm.enterFrameMonitorIfNeeded(child, thread)) {
      child.jitGeneratedReturnParent = frame;
      child.jitGeneratedReturnType = returnType;
      return { deopt: true, reason: "synchronized monitor contended" };
    }
    // A large loop selected for Wasm-first execution can be reached through
    // a synchronous generated call before it ever owns a scheduler tick.
    // Consult the same nested Wasm protocol used by asynchronous generated
    // calls; otherwise runGeneratedFrame below installs JavaScript directly
    // and the method's Wasm state remains permanently cold. A partial exit
    // keeps the materialized child on the stack and hands scheduling back to
    // the verified parent continuation.
    if (this.wasmJit.enabled && this.isOversizedLoopMethod(method)) {
      const wasmResult = this.wasmJit.runNested(child, thread);
      if (wasmResult.returned) {
        target.freeFrame = child;
        if (returnType === "V" || wasmResult.isVoid) return RETURN_VOID;
        return wasmResult.value;
      }
      if (wasmResult.exited) {
        child.jitGeneratedReturnParent = frame;
        child.jitGeneratedReturnType = returnType;
        return {
          deopt: true,
          transient: true,
          reason: `wasm-first synchronous callee exit ${lookupClass}.` +
            `${method.name}${descriptor}`,
        };
      }
    }
    const result = this.runGeneratedFrame(generated, child, thread, false);
    if (result && typeof result.then === "function") {
      throw new Error("Synchronous generated method returned a Promise");
    }
    if (result.deopt) {
      // Omitted/generated frame restoration can insert more than one caller
      // around a suspended child. Record the verified immediate parent rather
      // than assuming whichever Frame is on top when the child eventually
      // returns is the correct operand-stack recipient.
      child.jitGeneratedReturnParent = frame;
      child.jitGeneratedReturnType = returnType;
      return result;
    }
    target.freeFrame = child;
    if (memoKey !== NO_MEMO_KEY) {
      if (memoizedIntegralLeaf.values.size >= memoizedIntegralLeaf.maxEntries) {
        memoizedIntegralLeaf.values.clear();
      }
      memoizedIntegralLeaf.values.set(memoKey, result.value);
    }
    if (returnType === "void" || result.value === RETURN_VOID) return RETURN_VOID;
    return result.value;
  }

  getMemoizedIntegralLeaf(method, params, returnType) {
    if (!this.memoizedIntegralLeavesEnabled || !(method.flags || []).includes("static")) {
      return null;
    }
    if (this.memoizedIntegralLeafCache.has(method)) {
      return this.memoizedIntegralLeafCache.get(method);
    }
    const widths = params.map(integralMemoWidth);
    const returnWidth = integralMemoWidth(returnType);
    if (!returnWidth || widths.some((width) => !width)) {
      this.memoizedIntegralLeafCache.set(method, null);
      return null;
    }
    const code = method.attributes.find((attribute) => attribute.type === "code");
    const codeItems = code && this.getCodeItems(method);
    const labels = codeItems && buildLabelMap(codeItems);
    const depths = codeItems &&
      this.computeStackDepths(codeItems, labels, method);
    if (!code || !depths || codeItems.length > 4096) {
      this.memoizedIntegralLeafCache.set(method, null);
      return null;
    }
    const allowed = new Set([
      "nop", "getstatic", "goto", "goto_w", "i2b", "i2c", "i2s",
      "iadd", "iand", "imul", "ineg", "ior", "ishl", "ishr", "isub", "iushr", "ixor",
      "ireturn", "iinc", "bipush", "sipush", "ldc", "ldc_w",
      "iconst_m1", "iconst_0", "iconst_1", "iconst_2", "iconst_3", "iconst_4",
      "iconst_5", "ifeq", "ifne", "iflt", "ifle", "ifgt", "ifge",
      "if_icmpeq", "if_icmpne", "if_icmplt", "if_icmple", "if_icmpgt", "if_icmpge",
      "iload", "iload_0", "iload_1", "iload_2", "iload_3",
      "istore", "istore_0", "istore_1", "istore_2", "istore_3",
    ]);
    const staticFields = [];
    const staticKeys = new Set();
    let valid = true;
    for (let index = 0; index < codeItems.length && valid; index += 1) {
      if (depths[index] === undefined) continue;
      const instruction = codeItems[index] && codeItems[index].instruction;
      const op = getOp(instruction);
      if (!op || !allowed.has(op)) {
        valid = false;
        break;
      }
      if ((op === "ldc" || op === "ldc_w") &&
          !Number.isInteger(Number(instruction.arg))) {
        valid = false;
        break;
      }
      if (op === "getstatic") {
        const descriptor = instruction.arg?.[2]?.[1];
        const width = integralMemoDescriptorWidth(descriptor);
        const key = JSON.stringify(instruction.arg);
        if (!width || !key) {
          valid = false;
          break;
        }
        if (!staticKeys.has(key)) {
          staticKeys.add(key);
          staticFields.push({ field: instruction.arg, width });
        }
      }
    }
    const totalBits = widths.reduce((sum, width) => sum + width, 0) +
      staticFields.reduce((sum, field) => sum + field.width, 0);
    // Exact numeric keys avoid allocating a string in the hot caller. Above
    // 52 bits JavaScript cannot represent every packed combination exactly.
    if (!valid || totalBits > 52) {
      this.memoizedIntegralLeafCache.set(method, null);
      return null;
    }
    const plan = {
      widths,
      staticFields,
      values: new Map(),
      maxEntries: 4096,
    };
    this.memoizedIntegralLeafCache.set(method, plan);
    return plan;
  }

  memoizedIntegralKey(plan, stack, base) {
    let key = 0;
    let factor = 1;
    for (let index = 0; index < plan.widths.length; index += 1) {
      const width = plan.widths[index];
      key += unsignedIntegralMemoValue(stack[base + index], width) * factor;
      factor *= 2 ** width;
    }
    for (const entry of plan.staticFields) {
      const value = this.getStaticSync(entry.field);
      if (value === STATIC_DEOPT) return NO_MEMO_KEY;
      key += unsignedIntegralMemoValue(value, entry.width) * factor;
      factor *= 2 ** entry.width;
    }
    return key;
  }

  getSynchronousIntrinsic(method, descriptor) {
    // The only production intrinsic recognized from guest bytecode is the
    // small, general primitive-array memmove idiom below. Avoid canonicalizing
    // every arbitrary callee merely to discover that large guest-kernel
    // oracles are disabled.
    if (!this.guestKernelOraclesEnabled &&
        descriptor !== "([II[III)V") {
      return null;
    }
    const codeItems = this.getCodeItems(method);
    const rawOps = codeItems
      .map((item) => getOp(item.instruction))
      .filter(Boolean);
    const code = method.attributes.find((attribute) => attribute.type === "code");
    const intrinsicCodeItems = stripProvenDeadEntryInitializers(
      codeItems, code?.code?.exceptionTable || []);
    const ops = normalizeIntrinsicCompilerIdioms(intrinsicCodeItems);

    let parsedDescriptor = null;
    try { parsedDescriptor = parseDescriptor(descriptor); } catch (_) { /* not an intrinsic */ }
    const primitiveCopySignature = parsedDescriptor && parsedDescriptor.returnType === "void" &&
      parsedDescriptor.params.length === 5 && parsedDescriptor.params[0] === "int[]" &&
      parsedDescriptor.params[1] === "int" && parsedDescriptor.params[2] === "int[]" &&
      parsedDescriptor.params[3] === "int" && parsedDescriptor.params[4] === "int";
    if (primitiveCopySignature) {
      const prefix = [
        "aload_0", "aload_2", "if_acmpne", "iload_1", "iload_3",
        "if_icmpne", "return", "iload_3", "iload_1", "if_icmple",
      ];
      const loads = ops.filter((op) => op === "iaload").length;
      const stores = ops.filter((op) => op === "iastore").length;
      const legacyShape = prefix.every((op, index) => ops[index] === op);
      const increments = codeItems.filter((item) => getOp(item && item.instruction) === "iinc")
        .map((item) => Number(item.instruction.incr || 0));
      const expandedShape = loads >= 8 && stores === loads &&
        ops.some((op) => op === "if_acmpeq" || op === "if_acmpne") &&
        increments.some((increment) => increment > 0) &&
        increments.some((increment) => increment < 0) &&
        !ops.some((op) => op.startsWith("invoke") ||
          ["getfield", "putfield", "getstatic", "putstatic"].includes(op));
      if ((!legacyShape && !expandedShape) || loads < 8 || stores !== loads ||
          ops.some((op) => op.startsWith("invoke"))) {
        return null;
      }
      const intrinsic = (stack, base) => this.primitiveArrayCopyDirect(
        stack[base], stack[base + 1], stack[base + 2], stack[base + 3], stack[base + 4]);
      intrinsic.jvmDirectKind = "primitiveArrayCopy";
      return intrinsic;
    }

    // Everything below this point is a complete guest rendering algorithm,
    // selected by a long opcode/constant fingerprint and replaced by
    // handwritten JavaScript. It remains available as a differential oracle,
    // but normal execution must compile those bytecodes through structured SSA.
    if (!this.guestKernelOraclesEnabled) return null;

    if (descriptor === "(IIII)V") {
      const spanOps = [
        "iload_1", "getstatic", "if_icmplt", "iload_1", "getstatic", "if_icmplt", "return",
        "iload_0", "getstatic", "if_icmpge", "iload_2", "getstatic", "iload_0", "isub",
        "isub", "istore_2", "getstatic", "istore_0", "iload_0", "iload_2", "iadd",
        "getstatic", "if_icmple", "getstatic", "iload_0", "isub", "istore_2", "iload_0",
        "iload_1", "getstatic", "imul", "iadd", "istore", "iconst_0", "istore", "iload",
        "iload_2", "if_icmpge", "getstatic", "iload", "iload", "iadd", "iload_3",
        "iastore", "iinc", "goto", "return",
      ];
      if (ops.length !== spanOps.length || !spanOps.every((op, index) => ops[index] === op)) {
        return null;
      }
      const fields = codeItems.filter((item) => getOp(item.instruction) === "getstatic")
        .map((item) => item.instruction.arg);
      const fieldKey = (field) => JSON.stringify(field);
      if (fields.length !== 9 ||
          fields.slice(0, 8).some((field) => field?.[2]?.[1] !== "I") ||
          fields[8]?.[2]?.[1] !== "[I" ||
          fieldKey(fields[2]) !== fieldKey(fields[3]) ||
          fieldKey(fields[2]) !== fieldKey(fields[4]) ||
          fieldKey(fields[5]) !== fieldKey(fields[6])) return null;
      const staticFields = [fields[0], fields[1], fields[2], fields[5], fields[7], fields[8]];
      const intrinsic = (stack, base) => {
        const values = staticFields.map((field) => this.getStaticSync(field));
        if (values.some((item) => item === STATIC_DEOPT)) return ASYNC_INVOKE;
        return this.clippedSpanDirect(stack[base], stack[base + 1], stack[base + 2],
          stack[base + 3], ...values);
      };
      intrinsic.jvmDirectKind = "clippedStaticSpan";
      intrinsic.jvmDirectData = { staticFields };
      return intrinsic;
    }

    if (descriptor === "(IIIII)V") {
      // Clipped alpha-blended horizontal span.  This is deliberately a full
      // bytecode-shape match: neither the declaring class nor method/field
      // names participate in recognition.
      const alphaSpanOps = [
        "iload_1", "getstatic", "if_icmplt", "iload_1", "getstatic", "if_icmplt",
        "return", "iload_0", "getstatic", "if_icmpge", "iload_2", "getstatic",
        "iload_0", "isub", "isub", "istore_2", "getstatic", "istore_0",
        "iload_0", "iload_2", "iadd", "getstatic", "if_icmple", "getstatic",
        "iload_0", "isub", "istore_2", "sipush", "iload", "isub", "istore",
        "iload_3", "bipush", "ishr", "sipush", "iand", "iload", "imul", "istore",
        "iload_3", "bipush", "ishr", "sipush", "iand", "iload", "imul", "istore",
        "iload_3", "sipush", "iand", "iload", "imul", "istore",
        "iload_0", "iload_1", "getstatic", "imul", "iadd", "istore",
        "iconst_0", "istore", "iload", "iload_2", "if_icmpge",
        "getstatic", "iload", "iaload", "bipush", "ishr", "sipush", "iand",
        "iload", "imul", "istore",
        "getstatic", "iload", "iaload", "bipush", "ishr", "sipush", "iand",
        "iload", "imul", "istore",
        "getstatic", "iload", "iaload", "sipush", "iand", "iload", "imul", "istore",
        "iload", "iload", "iadd", "bipush", "ishr", "bipush", "ishl",
        "iload", "iload", "iadd", "bipush", "ishr", "bipush", "ishl", "iadd",
        "iload", "iload", "iadd", "bipush", "ishr", "iadd", "istore",
        "getstatic", "iload", "iinc", "iload", "iastore", "iinc", "goto", "return",
      ];
      if (ops.length !== alphaSpanOps.length ||
          !alphaSpanOps.every((op, index) => ops[index] === op)) return null;
      const fields = codeItems.filter((item) => getOp(item.instruction) === "getstatic")
        .map((item) => item.instruction.arg);
      const fieldKey = (field) => JSON.stringify(field);
      if (fields.length !== 12 ||
          fields.slice(0, 8).some((field) => field?.[2]?.[1] !== "I") ||
          fields.slice(8).some((field) => field?.[2]?.[1] !== "[I") ||
          fieldKey(fields[2]) !== fieldKey(fields[3]) ||
          fieldKey(fields[2]) !== fieldKey(fields[4]) ||
          fieldKey(fields[5]) !== fieldKey(fields[6]) ||
          fields.slice(9).some((field) => fieldKey(field) !== fieldKey(fields[8]))) {
        return null;
      }
      const pushedConstants = codeItems.filter((item) =>
        ["bipush", "sipush"].includes(getOp(item.instruction)))
        .map((item) => Number(item.instruction.arg));
      const expectedConstants = [
        256, 16, 255, 8, 255, 255, 16, 255, 8, 255, 255, 8, 16, 8, 8, 8,
      ];
      if (pushedConstants.length !== expectedConstants.length ||
          pushedConstants.some((value, index) => value !== expectedConstants[index])) {
        return null;
      }
      const staticFields = [fields[0], fields[1], fields[2], fields[5], fields[7], fields[8]];
      const intrinsic = (stack, base) => {
        const values = staticFields.map((field) => this.getStaticSync(field));
        if (values.some((item) => item === STATIC_DEOPT)) return ASYNC_INVOKE;
        return this.clippedAlphaSpanDirect(stack[base], stack[base + 1], stack[base + 2],
          stack[base + 3], stack[base + 4], ...values);
      };
      intrinsic.jvmDirectKind = "clippedStaticAlphaSpan";
      intrinsic.jvmDirectData = { staticFields };
      return intrinsic;
    }

    if (descriptor === "(IIIIII)V") {
      // Clipped vertical RGB gradient. Recognition deliberately uses the
      // complete bytecode shape, constants, CFG/stack proof, and repeated
      // static-field identities. Guest class, method, and field names do not
      // participate.
      const gradientOps = [
        "iconst_0", "istore", "ldc", "iload_3", "idiv", "istore",
        "iload_0", "getstatic", "if_icmpge",
        "iload_2", "getstatic", "iload_0", "isub", "isub", "istore_2",
        "getstatic", "istore_0",
        "iload_1", "getstatic", "if_icmpge",
        "iload", "getstatic", "iload_1", "isub", "iload", "imul", "iadd", "istore",
        "iload_3", "getstatic", "iload_1", "isub", "isub", "istore_3",
        "getstatic", "istore_1",
        "iload_0", "iload_2", "iadd", "getstatic", "if_icmple",
        "getstatic", "iload_0", "isub", "istore_2",
        "iload_1", "iload_3", "iadd", "getstatic", "if_icmple",
        "getstatic", "iload_1", "isub", "istore_3",
        "getstatic", "iload_2", "isub", "istore",
        "iload_0", "iload_1", "getstatic", "imul", "iadd", "istore",
        "iload_3", "ineg", "istore", "iload", "ifge",
        "ldc", "iload", "isub", "bipush", "ishr", "istore",
        "iload", "bipush", "ishr", "istore",
        "iload", "ldc", "iand", "iload", "imul",
        "iload", "ldc", "iand", "iload", "imul", "iadd", "ldc", "iand",
        "iload", "ldc", "iand", "iload", "imul",
        "iload", "ldc", "iand", "iload", "imul", "iadd", "ldc", "iand",
        "iadd", "bipush", "iushr", "istore",
        "iload_2", "ineg", "istore", "iload", "ifge",
        "getstatic", "iload", "iinc", "iload", "iastore",
        "iinc", "goto",
        "iload", "iload", "iadd", "istore",
        "iload", "iload", "iadd", "istore",
        "iinc", "goto", "return",
      ];
      const exceptionTable = code?.code?.exceptionTable || [];
      const codeVerified =
        (!exceptionTable.length ||
          this.hasOnlyNoOpExceptionHandlers(method, codeItems)) &&
        Boolean(this.computeStackDepths(
          codeItems, buildLabelMap(codeItems), method));
      if (!codeVerified || ops.length !== gradientOps.length ||
          !gradientOps.every((op, index) => ops[index] === op)) return null;
      const constants = codeItems.filter((item) =>
        ["ldc", "bipush"].includes(getOp(item.instruction)))
        .map((item) => Number(item.instruction.arg));
      const expectedConstants = [
        65536, 65536, 8, 8, 16711935, 16711935, -16711936,
        65280, 65280, 16711680, 8,
      ];
      if (constants.length !== expectedConstants.length ||
          constants.some((value, index) => value !== expectedConstants[index])) return null;
      const fields = codeItems.filter((item) => getOp(item.instruction) === "getstatic")
        .map((item) => item.instruction.arg);
      const fieldKey = (field) => JSON.stringify(field);
      const repeated = (indexes) => indexes.every((index) =>
        fieldKey(fields[index]) === fieldKey(fields[indexes[0]]));
      if (fields.length !== 14 ||
          fields.slice(0, 13).some((field) => field?.[2]?.[1] !== "I") ||
          fields[13]?.[2]?.[1] !== "[I" ||
          !repeated([0, 1, 2]) || !repeated([3, 4, 5, 6]) ||
          !repeated([7, 8]) || !repeated([9, 10]) ||
          !repeated([11, 12])) return null;
      const staticFields = [
        fields[0], fields[3], fields[7], fields[9], fields[11], fields[13],
      ];
      const intrinsic = (stack, base) => {
        const values = staticFields.map((field) => this.getStaticSync(field));
        if (values.some((item) => item === STATIC_DEOPT)) return ASYNC_INVOKE;
        return this.clippedGradientDirect(
          stack[base], stack[base + 1], stack[base + 2],
          stack[base + 3], stack[base + 4], stack[base + 5], ...values);
      };
      intrinsic.jvmDirectKind = "clippedStaticGradient";
      intrinsic.jvmDirectData = { staticFields };
      return intrinsic;
    }

    if (descriptor === "([I[BIIIIIII)V") {
      const maskedBlitOps = [
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
      if (ops.length !== maskedBlitOps.length ||
          !maskedBlitOps.every((op, index) => ops[index] === op)) return null;
      const intrinsic = (stack, base) => this.maskedColorBlitDirect(
        stack[base], stack[base + 1], stack[base + 2], stack[base + 3],
        stack[base + 4], stack[base + 5], stack[base + 6], stack[base + 7],
        stack[base + 8]);
      intrinsic.jvmDirectKind = "maskedColorBlit";
      return intrinsic;
    }

    if (descriptor === "([I[IIIIIIII)V") {
      // Transparent int-source rectangle copy, including the four-pixel
      // unroll used by older javac output. The complete verified bytecode
      // shape is the identity; declaring class and member names are irrelevant.
      const transparentIntBlitOps = [
        "iload", "iconst_2", "ishr", "ineg", "istore",
        "iload", "iconst_3", "iand", "ineg", "istore",
        "iload", "ineg", "istore", "iload", "ifge",
        "iload", "istore", "iload", "ifge",
        "aload_1", "iload_3", "iinc", "iaload", "istore_2", "iload_2", "ifeq",
        "aload_0", "iload", "iinc", "iload_2", "iastore", "goto", "athrow", "iinc",
        "aload_1", "iload_3", "iinc", "iaload", "istore_2", "iload_2", "ifeq",
        "aload_0", "iload", "iinc", "iload_2", "iastore", "goto", "athrow", "iinc",
        "aload_1", "iload_3", "iinc", "iaload", "istore_2", "iload_2", "ifeq",
        "aload_0", "iload", "iinc", "iload_2", "iastore", "goto", "athrow", "iinc",
        "aload_1", "iload_3", "iinc", "iaload", "istore_2", "iload_2", "ifeq",
        "aload_0", "iload", "iinc", "iload_2", "iastore", "goto", "athrow", "iinc",
        "iinc", "goto",
        "iload", "istore", "iload", "ifge",
        "aload_1", "iload_3", "iinc", "iaload", "istore_2", "iload_2", "ifeq",
        "aload_0", "iload", "iinc", "iload_2", "iastore", "goto", "athrow", "iinc",
        "iinc", "goto",
        "iload", "iload", "iadd", "istore",
        "iload_3", "iload", "iadd", "istore_3",
        "iinc", "goto", "return",
      ];
      const exceptionTable = code?.code?.exceptionTable || [];
      const codeVerified =
        (!exceptionTable.length ||
          this.hasOnlyNoOpExceptionHandlers(method, codeItems)) &&
        Boolean(this.computeStackDepths(
          codeItems, buildLabelMap(codeItems), method));
      if (!codeVerified || ops.length !== transparentIntBlitOps.length ||
          !transparentIntBlitOps.every((op, index) => ops[index] === op)) return null;
      const intrinsic = (stack, base) => this.transparentIntBlitDirect(
        stack[base], stack[base + 1], stack[base + 2], stack[base + 3],
        stack[base + 4], stack[base + 5], stack[base + 6], stack[base + 7],
        stack[base + 8]);
      intrinsic.jvmDirectKind = "transparentIntBlit";
      return intrinsic;
    }

    if (descriptor === "([I[IIIIIIIII)V") {
      // Transparent-source alpha rectangle. Match the complete loop and its
      // packed-channel constants; owner/member names are intentionally absent.
      const alphaMaskedBlitOps = [
        "iload", "ineg", "istore", "iload", "ifge",
        "iload", "ineg", "istore", "iload", "ifge",
        "aload_1", "iload_3", "iinc", "iaload", "istore_2", "iload_2", "ifeq",
        "iload_2", "ldc", "iand", "iload", "imul", "ldc", "iand", "istore",
        "iload_2", "ldc", "iand", "iload", "imul", "ldc", "iand", "istore",
        "aload_0", "iload", "iinc", "iload", "iload", "ior", "bipush",
        "iushr", "iastore", "goto", "iinc",
        "iinc", "goto",
        "iload", "iload", "iadd", "istore",
        "iload_3", "iload", "iadd", "istore_3",
        "iinc", "goto", "return",
      ];
      if (ops.length !== alphaMaskedBlitOps.length ||
          !alphaMaskedBlitOps.every((op, index) => ops[index] === op)) return null;
      const constants = codeItems.filter((item) =>
        getOp(item.instruction) === "ldc" || getOp(item.instruction) === "bipush")
        .map((item) => Number(item.instruction.arg));
      const expectedConstants = [
        0x00ff00ff, 0xff00ff00 | 0, 0x0000ff00, 0x00ff0000, 8,
      ];
      if (constants.length !== expectedConstants.length ||
          constants.some((value, index) => value !== expectedConstants[index])) return null;
      const intrinsic = (stack, base) => this.alphaMaskedColorBlitDirect(
        stack[base], stack[base + 1], stack[base + 2], stack[base + 3],
        stack[base + 4], stack[base + 5], stack[base + 6], stack[base + 7],
        stack[base + 8], stack[base + 9]);
      intrinsic.jvmDirectKind = "alphaMaskedColorBlit";
      return intrinsic;
    }

    if (descriptor === "(IIIIIIZ)V") {
      const glyphWrapperOps = [
        "iload_2", "iload_3", "getstatic", "imul", "iadd", "istore",
        "getstatic", "iload", "isub", "istore", "iconst_0", "istore",
        "iconst_0", "istore", "iload_3", "getstatic", "if_icmpge",
        "getstatic", "iload_3", "isub", "istore", "iload", "iload", "isub",
        "istore", "getstatic", "istore_3", "iload", "iload", "iload", "imul",
        "iadd", "istore", "iload", "iload", "getstatic", "imul", "iadd", "istore",
        "iload_3", "iload", "iadd", "getstatic", "if_icmple", "iload", "iload_3",
        "iload", "iadd", "getstatic", "isub", "isub", "istore",
        "iload_2", "getstatic", "if_icmpge", "getstatic", "iload_2", "isub",
        "istore", "iload", "iload", "isub", "istore", "getstatic", "istore_2",
        "iload", "iload", "iadd", "istore", "iload", "iload", "iadd", "istore",
        "iload", "iload", "iadd", "istore", "iload", "iload", "iadd", "istore",
        "iload_2", "iload", "iadd", "getstatic", "if_icmple", "iload_2", "iload",
        "iadd", "getstatic", "isub", "istore", "iload", "iload", "isub", "istore",
        "iload", "iload", "iadd", "istore", "iload", "iload", "iadd", "istore",
        "iload", "ifle", "iload", "ifgt", "return", "getstatic", "ifnull",
        "getstatic", "aload_0", "getfield", "iload_1", "aaload",
        "iload_2", "iload_3", "iload", "iload", "iload", "iload", "iload",
        "iload", "iload", "getstatic", "getstatic", "invokestatic", "goto",
        "getstatic", "aload_0", "getfield", "iload_1", "aaload",
        "iload", "iload", "iload", "iload", "iload", "iload", "iload",
        "invokestatic", "return",
      ];
      // javac preserves the same clipping and raster-call structure, but emits
      // dead local initializers and inverted branches for decompiled source.
      // Keep this as a second complete opcode fingerprint. Guest owner,
      // method, and field names deliberately remain outside the match.
      const javacGlyphWrapperOps = [
        "iconst_0", "istore", "iconst_0", "istore", "iconst_0", "istore",
        "iconst_0", "istore", "iconst_0", "istore",
        "iload_2", "iload_3", "getstatic", "imul", "iadd", "istore",
        "getstatic", "iload", "isub", "istore", "iconst_0", "istore",
        "iconst_0", "istore", "iload_3", "getstatic", "if_icmplt", "goto",
        "getstatic", "iload_3", "isub", "istore", "iload", "iload", "isub",
        "istore", "getstatic", "istore_3", "iload", "iload", "iload", "imul",
        "iadd", "istore", "iload", "iload", "getstatic", "imul", "iadd",
        "istore", "iload_3", "iload", "iadd", "getstatic", "if_icmpgt", "goto",
        "iload", "iload_3", "iload", "iadd", "getstatic", "isub", "isub",
        "istore", "iload_2", "getstatic", "if_icmplt", "goto", "getstatic",
        "iload_2", "isub", "istore", "iload", "iload", "isub", "istore",
        "getstatic", "istore_2", "iload", "iload", "iadd", "istore", "iload",
        "iload", "iadd", "istore", "iload", "iload", "iadd", "istore",
        "iload", "iload", "iadd", "istore", "iload_2", "iload", "iadd",
        "getstatic", "if_icmpgt", "goto", "iload_2", "iload", "iadd",
        "getstatic", "isub", "istore", "iload", "iload", "isub", "istore",
        "iload", "iload", "iadd", "istore", "iload", "iload", "iadd",
        "istore", "iload", "ifgt", "goto", "iload", "ifle", "getstatic",
        "ifnonnull", "getstatic", "aload_0", "getfield", "iload_1", "aaload",
        "iload", "iload", "iload", "iload", "iload", "iload", "iload",
        "invokestatic", "goto", "getstatic", "aload_0", "getfield", "iload_1",
        "aaload", "iload_2", "iload_3", "iload", "iload", "iload", "iload",
        "iload", "iload", "iload", "getstatic", "getstatic", "invokestatic",
        "return", "return",
      ];
      const sameOps = (expected) => ops.length === expected.length &&
        expected.every((op, index) => ops[index] === op);
      const sameRawOps = (expected) => rawOps.length === expected.length &&
        expected.every((op, index) => rawOps[index] === op);
      let glyphShape;
      if (sameOps(glyphWrapperOps)) {
        glyphShape = {
          calls: ["([I[BIIIIIIIII[I[I)V", "([I[BIIIIIII)V"],
          scanlineFields: [13, 15],
          pixelFields: [14, 17],
        };
      } else if (sameRawOps(javacGlyphWrapperOps)) {
        glyphShape = {
          calls: ["([I[BIIIIIII)V", "([I[BIIIIIIIII[I[I)V"],
          scanlineFields: [13, 16],
          pixelFields: [14, 15],
        };
      } else {
        return null;
      }
      const staticFields = codeItems.filter((item) => getOp(item.instruction) === "getstatic")
        .map((item) => item.instruction.arg);
      const instanceFields = codeItems.filter((item) => getOp(item.instruction) === "getfield")
        .map((item) => item.instruction.arg);
      const calls = codeItems.filter((item) => getOp(item.instruction) === "invokestatic")
        .map((item) => item.instruction.arg?.[2]?.[1]);
      const fieldKey = (field) => JSON.stringify(field);
      const sameAt = (indices) => indices.every((index) =>
        fieldKey(staticFields[index]) === fieldKey(staticFields[indices[0]]));
      if (staticFields.length !== 18 || instanceFields.length !== 2 ||
          calls.length !== 2 ||
          calls.some((call, index) => call !== glyphShape.calls[index]) ||
          staticFields.slice(0, 13).some((field) => field?.[2]?.[1] !== "I") ||
          staticFields.slice(13).some((field) => field?.[2]?.[1] !== "[I") ||
          !sameAt([0, 1, 5]) || !sameAt([2, 3, 4]) || !sameAt([6, 7]) ||
          !sameAt([8, 9, 10]) || !sameAt([11, 12]) ||
          !sameAt(glyphShape.scanlineFields) ||
          !sameAt(glyphShape.pixelFields) ||
          fieldKey(instanceFields[0]) !== fieldKey(instanceFields[1]) ||
          instanceFields[0]?.[2]?.[1] !== "[[B") return null;
      const selectedStatics = [
        staticFields[0], staticFields[2], staticFields[6], staticFields[8],
        staticFields[11], staticFields[13], staticFields[14],
      ];
      if (selectedStatics.slice(0, 5).some((field) => field?.[2]?.[1] !== "I") ||
          selectedStatics[5]?.[2]?.[1] !== "[I" ||
          selectedStatics[6]?.[2]?.[1] !== "[I") return null;
      const selectedStaticSites = selectedStatics.map((field) =>
        this.registerFieldSite(field));
      const staticOwners = [...new Set(selectedStaticSites.map((siteId) =>
        this.fieldSites[siteId].className))];
      const directStaticTargets = selectedStaticSites.map((siteId) => {
        const site = this.fieldSites[siteId];
        if (this.jvm.classInitializationState.get(site.className) !== "INITIALIZED") {
          return null;
        }
        const direct = this.registerDirectStaticTarget(siteId);
        return direct ? this.directStaticTargets[direct.targetId] : null;
      });
      const allStaticsDirect = directStaticTargets.every(Boolean);
      const masksFieldSite = this.registerFieldSite(instanceFields[0]);
      const positional = (receiver, glyphIndex, x, y, width, height, color) => {
        if (staticOwners.some((owner) =>
          this.jvm.classInitializationState.get(owner) !== "INITIALIZED")) {
          return ASYNC_INVOKE;
        }
        // Bind initialized storage locations, not values. Reads remain live,
        // but each glyph avoids repeated hierarchy/key resolution.
        const values = allStaticsDirect
          ? directStaticTargets.map((target) => target.kind === "map"
            ? target.fields.get(target.key) : target.fields[target.key])
          : selectedStaticSites.map((siteId) => this.getStaticSyncAt(siteId));
        if (values.some((value) => value === STATIC_DEOPT)) return ASYNC_INVOKE;
        const [surfaceWidth, clipTop, clipBottom, clipLeft, clipRight,
          scanlineClip, pixels] = values;
        if (scanlineClip !== null && scanlineClip !== undefined) return ASYNC_INVOKE;
        return this.maskedGlyphDirect(
          receiver, glyphIndex, x, y, width, height, color,
          surfaceWidth, clipTop, clipBottom, clipLeft, clipRight, pixels,
          masksFieldSite);
      };
      const intrinsic = (stack, base) => positional(
        stack[base], stack[base + 1], stack[base + 2], stack[base + 3],
        stack[base + 4], stack[base + 5], stack[base + 6]);
      intrinsic.jvmDirectKind = "maskedGlyph";
      intrinsic.jvmReceiverSlots = 1;
      // A runtime-resolved invokevirtual may use this only after the ordinary
      // resolver has installed the exact receiver-class target.  The structured
      // caller can then feed its SSA values directly, without first rebuilding
      // the canonical operand stack.  The final boolean parameter is deliberately
      // ignored by the verified guest shape, just as the bytecode body ignores it.
      intrinsic.jvmPositional = positional;
      return intrinsic;
    }

    if (descriptor === "(IIIIIII[III)V") {
      const prefix = [
        "getstatic", "istore", "iload", "bipush", "if_icmpeq",
        "bipush", "invokestatic", "goto", "athrow", "iinc",
      ];
      if (!prefix.every((op, index) => ops[index] === op)) return null;
      const integerAndCalls = codeItems.filter((item) => {
        const instruction = item && item.instruction;
        return getOp(instruction) === "invokestatic" && instruction &&
          Array.isArray(instruction.arg) && Array.isArray(instruction.arg[2]) &&
          instruction.arg[2][1] === "(II)I";
      });
      const constants = new Set(codeItems.map((item) => {
        const instruction = item && item.instruction;
        const op = getOp(instruction);
        return instruction && typeof instruction === "object" &&
          (op === "bipush" || op === "sipush" || op === "ldc" || op === "ldc_w")
          ? Number(instruction.arg) : NaN;
      }));
      const expectedConstants = [
        9, 8355711, -852264639, 65280, -1295343735,
        1494704929, 16711680, 200866833, 255,
      ];
      if (integerAndCalls.length !== 3 ||
          !ops.includes("iaload") || !ops.includes("iastore") ||
          !expectedConstants.every((value) => constants.has(value))) return null;
      const flagField = codeItems.find((item) => getOp(item && item.instruction) === "getstatic")
        ?.instruction?.arg;
      if (!flagField) return null;
      return (stack, base) => {
        if ((stack[base + 6] | 0) !== 9) return ASYNC_INVOKE;
        const flag = this.getStaticSync(flagField);
        if (flag === STATIC_DEOPT || flag) return ASYNC_INVOKE;
        const dest = stack[base + 7];
        let index = stack[base + 1] | 0;
        const count = stack[base + 5] | 0;
        if (dest === null || dest === undefined) {
          throw { type: "java/lang/NullPointerException", message: null };
        }
        if (count <= 0) return RETURN_VOID;
        if (index < 0 || index + count > dest.length) {
          throw { type: "java/lang/ArrayIndexOutOfBoundsException", message: null };
        }
        let green = stack[base] | 0;
        let red = stack[base + 4] | 0;
        let blue = stack[base + 8] | 0;
        const greenStep = stack[base + 2] | 0;
        const redStep = stack[base + 3] | 0;
        const blueStep = stack[base + 9] | 0;
        for (let i = 0; i < count; i += 1) {
          dest[index] = (((dest[index] >> 1) & 8355711) +
            ((green >> 9) & 65280) + ((red >> 1) & 16711680) +
            ((blue >> 17) & 255)) | 0;
          index += 1;
          green = (green + greenStep) | 0;
          red = (red + redStep) | 0;
          blue = (blue + blueStep) | 0;
        }
        return RETURN_VOID;
      };
    }

    if (descriptor === "(IB[III)V") {
      const prefix = [
        "getstatic", "istore", "iload_1", "bipush", "if_icmpeq",
        "bipush", "bipush", "aconst_null", "checkcast", "bipush",
        "bipush", "invokestatic", "goto", "athrow", "iinc",
      ];
      if (!prefix.every((op, index) => ops[index] === op)) return null;
      const integerAndCalls = codeItems.filter((item) => {
        const instruction = item && item.instruction;
        return getOp(instruction) === "invokestatic" && instruction &&
          Array.isArray(instruction.arg) && Array.isArray(instruction.arg[2]) &&
          instruction.arg[2][1] === "(II)I";
      });
      const constants = new Set(codeItems.map((item) => {
        const instruction = item && item.instruction;
        const op = getOp(instruction);
        return instruction && typeof instruction === "object" &&
          (op === "bipush" || op === "sipush" || op === "ldc" || op === "ldc_w")
          ? Number(instruction.arg) : NaN;
      }));
      if (integerAndCalls.length !== 1 ||
          !ops.includes("iaload") || !ops.includes("iastore") ||
          ![57, 16711422, -59233087].every((value) => constants.has(value))) return null;
      const flagField = codeItems.find((item) => getOp(item && item.instruction) === "getstatic")
        ?.instruction?.arg;
      if (!flagField) return null;
      return (stack, base) => {
        if ((stack[base + 1] | 0) !== 57) return ASYNC_INVOKE;
        const flag = this.getStaticSync(flagField);
        if (flag === STATIC_DEOPT || flag) return ASYNC_INVOKE;
        let index = stack[base] | 0;
        const dest = stack[base + 2];
        const color = stack[base + 3] | 0;
        const count = stack[base + 4] | 0;
        if (dest === null || dest === undefined) {
          throw { type: "java/lang/NullPointerException", message: null };
        }
        if (count <= 0) return RETURN_VOID;
        if (index < 0 || index + count > dest.length) {
          throw { type: "java/lang/ArrayIndexOutOfBoundsException", message: null };
        }
        for (let i = 0; i < count; i += 1) {
          dest[index] = (color + ((dest[index] & 16711422) >> 1)) | 0;
          index += 1;
        }
        return RETURN_VOID;
      };
    }

    return null;
  }

  primitiveArrayCopyDirect(source, sourceIndex, destination, destinationIndex, length) {
    sourceIndex |= 0;
    destinationIndex |= 0;
    length |= 0;
    if (source === null || source === undefined ||
        destination === null || destination === undefined) {
      throw { type: "java/lang/NullPointerException", message: null };
    }
    // The recognized Java implementation returns before checking length when
    // source, destination, and offsets are identical.
    if (source === destination && sourceIndex === destinationIndex) {
      if (this.profileMethods) this.intrinsicArrayCopyNoopCount += 1;
      return RETURN_VOID;
    }
    if (sourceIndex < 0 || destinationIndex < 0 || length < 0 ||
        sourceIndex + length > source.length || destinationIndex + length > destination.length) {
      throw { type: "java/lang/ArrayIndexOutOfBoundsException", message: null };
    }
    if (source === destination && destinationIndex > sourceIndex &&
        destinationIndex < sourceIndex + length) {
      // Array.prototype.copyWithin carries generic property/holes/species
      // semantics that Java primitive arrays do not need. For the small,
      // overlapping moves used by the renderer an explicit reverse loop is
      // dramatically cheaper and preserves memmove ordering exactly.
      for (let index = length - 1; index >= 0; index -= 1) {
        destination[destinationIndex + index] = source[sourceIndex + index];
      }
      if (this.profileMethods) this.intrinsicArrayCopyWithinCount += 1;
    } else {
      for (let index = 0; index < length; index += 1) {
        destination[destinationIndex + index] = source[sourceIndex + index];
      }
    }
    return RETURN_VOID;
  }

  clippedSpanDirect(x, y, count, color, clipTop, clipBottom,
    clipLeft, clipRight, surfaceWidth, pixels) {
    x |= 0;
    y |= 0;
    count |= 0;
    color |= 0;
    if (y < (clipTop | 0) || y >= (clipBottom | 0)) return RETURN_VOID;
    if (x < (clipLeft | 0)) {
      count = (count - ((clipLeft | 0) - x)) | 0;
      x = clipLeft | 0;
    }
    if (((x + count) | 0) > (clipRight | 0)) count = ((clipRight | 0) - x) | 0;
    if (count <= 0) return RETURN_VOID;
    if (pixels === null || pixels === undefined) {
      throw { type: "java/lang/NullPointerException", message: null };
    }
    const start = (x + Math.imul(y, surfaceWidth | 0)) | 0;
    const data = this.arrayData(pixels);
    if (start >= 0 && start + count <= pixels.length && data !== null) {
      for (let offset = 0; offset < count; offset += 1) data[start + offset] = color;
      return RETURN_VOID;
    }
    for (let offset = 0; offset < count; offset += 1) {
      const index = (start + offset) | 0;
      if (index < 0 || index >= pixels.length) {
        throw { type: "java/lang/ArrayIndexOutOfBoundsException", message: null };
      }
      if (data !== null) data[index] = color;
      else if (pixels.elements) pixels.elements[index] = color;
      else pixels[index] = color;
    }
    return RETURN_VOID;
  }

  clippedStaticSpanDirectAt(x, y, count, color,
    topSite, bottomSite, leftSite, rightSite, widthSite, pixelsSite) {
    const clipTop = this.getStaticSyncAt(topSite);
    const clipBottom = this.getStaticSyncAt(bottomSite);
    const clipLeft = this.getStaticSyncAt(leftSite);
    const clipRight = this.getStaticSyncAt(rightSite);
    const surfaceWidth = this.getStaticSyncAt(widthSite);
    const pixels = this.getStaticSyncAt(pixelsSite);
    if (clipTop === STATIC_DEOPT || clipBottom === STATIC_DEOPT ||
        clipLeft === STATIC_DEOPT || clipRight === STATIC_DEOPT ||
        surfaceWidth === STATIC_DEOPT || pixels === STATIC_DEOPT) return STATIC_DEOPT;
    return this.clippedSpanDirect(x, y, count, color, clipTop, clipBottom,
      clipLeft, clipRight, surfaceWidth, pixels);
  }

  clippedAlphaSpanDirect(x, y, count, color, alpha,
    clipTop, clipBottom, clipLeft, clipRight, surfaceWidth, pixels) {
    x |= 0; y |= 0; count |= 0; color |= 0; alpha |= 0;
    if (y < (clipTop | 0) || y >= (clipBottom | 0)) return RETURN_VOID;
    if (x < (clipLeft | 0)) {
      count = (count - ((clipLeft | 0) - x)) | 0;
      x = clipLeft | 0;
    }
    if (((x + count) | 0) > (clipRight | 0)) count = ((clipRight | 0) - x) | 0;
    if (count <= 0) return RETURN_VOID;
    if (pixels === null || pixels === undefined) {
      throw { type: "java/lang/NullPointerException", message: null };
    }
    const start = (x + Math.imul(y, surfaceWidth | 0)) | 0;
    const data = this.arrayData(pixels);
    const length = pixels.length ?? (data && data.length) ?? 0;
    const inverse = (256 - alpha) | 0;
    const sourceRed = Math.imul((color >> 16) & 255, alpha);
    const sourceGreen = Math.imul((color >> 8) & 255, alpha);
    const sourceBlue = Math.imul(color & 255, alpha);
    const blendAt = (destination) => (
      ((((sourceRed + Math.imul((destination >> 16) & 255, inverse)) >> 8) << 16) +
       (((sourceGreen + Math.imul((destination >> 8) & 255, inverse)) >> 8) << 8) +
       ((sourceBlue + Math.imul(destination & 255, inverse)) >> 8)) | 0
    );
    if (data !== null && start >= 0 && start + count <= length) {
      for (let offset = 0; offset < count; offset += 1) {
        data[start + offset] = blendAt(data[start + offset] | 0);
      }
      return RETURN_VOID;
    }
    // Preserve Java's partial-write behavior if a malformed span crosses the
    // array boundary instead of validating the entire range ahead of time.
    for (let offset = 0; offset < count; offset += 1) {
      const index = (start + offset) | 0;
      if (index < 0 || index >= length) {
        throw { type: "java/lang/ArrayIndexOutOfBoundsException", message: null };
      }
      const destination = data !== null ? data[index]
        : pixels.elements ? pixels.elements[index] : pixels[index];
      const blended = blendAt(destination | 0);
      if (data !== null) data[index] = blended;
      else if (pixels.elements) pixels.elements[index] = blended;
      else pixels[index] = blended;
    }
    return RETURN_VOID;
  }

  clippedStaticAlphaSpanDirectAt(x, y, count, color, alpha,
    topSite, bottomSite, leftSite, rightSite, widthSite, pixelsSite) {
    const clipTop = this.getStaticSyncAt(topSite);
    const clipBottom = this.getStaticSyncAt(bottomSite);
    const clipLeft = this.getStaticSyncAt(leftSite);
    const clipRight = this.getStaticSyncAt(rightSite);
    const surfaceWidth = this.getStaticSyncAt(widthSite);
    const pixels = this.getStaticSyncAt(pixelsSite);
    if (clipTop === STATIC_DEOPT || clipBottom === STATIC_DEOPT ||
        clipLeft === STATIC_DEOPT || clipRight === STATIC_DEOPT ||
        surfaceWidth === STATIC_DEOPT || pixels === STATIC_DEOPT) return STATIC_DEOPT;
    return this.clippedAlphaSpanDirect(x, y, count, color, alpha,
      clipTop, clipBottom, clipLeft, clipRight, surfaceWidth, pixels);
  }

  clippedGradientDirect(x, y, width, height, startColor, endColor,
    clipLeft, clipTop, clipRight, clipBottom, surfaceWidth, pixels) {
    this.clippedGradientRunCount += 1;
    x |= 0; y |= 0; width |= 0; height |= 0;
    startColor |= 0; endColor |= 0;
    clipLeft |= 0; clipTop |= 0; clipRight |= 0; clipBottom |= 0;
    surfaceWidth |= 0;
    // idiv is the first potentially throwing operation in the recognized
    // guest body, before any clipping or pixel side effect.
    if (height === 0) {
      throw { type: "java/lang/ArithmeticException", message: "/ by zero" };
    }
    let phase = 0;
    const phaseStep = (65536 / height) | 0;
    if (x < clipLeft) {
      width = (width - (clipLeft - x)) | 0;
      x = clipLeft;
    }
    if (y < clipTop) {
      phase = (phase + Math.imul((clipTop - y) | 0, phaseStep)) | 0;
      height = (height - (clipTop - y)) | 0;
      y = clipTop;
    }
    if (((x + width) | 0) > clipRight) width = (clipRight - x) | 0;
    if (((y + height) | 0) > clipBottom) height = (clipBottom - y) | 0;
    const rowSkip = (surfaceWidth - width) | 0;
    let pixelIndex = (x + Math.imul(y, surfaceWidth)) | 0;
    if (width <= 0 || height <= 0) return RETURN_VOID;
    const data = this.arrayData(pixels);
    const length = pixels?.length ?? (data && data.length) ?? 0;
    let rangesValid = data !== null;
    let checkedIndex = pixelIndex;
    for (let checkedRow = 0; rangesValid && checkedRow < height; checkedRow += 1) {
      if (checkedIndex < 0 || checkedIndex + width > length) rangesValid = false;
      checkedIndex = (checkedIndex + surfaceWidth) | 0;
    }
    if (rangesValid) {
      let fastRow = (-height) | 0;
      while (fastRow < 0) {
        const startWeight = ((65536 - phase) >> 8) | 0;
        const endWeight = (phase >> 8) | 0;
        const mixedRb = (
          (Math.imul(startColor & 16711935, startWeight) +
            Math.imul(endColor & 16711935, endWeight)) | 0) & -16711936;
        const mixedG = (
          (Math.imul(startColor & 65280, startWeight) +
            Math.imul(endColor & 65280, endWeight)) | 0) & 16711680;
        const color = ((mixedRb + mixedG) >>> 8) | 0;
        const rowEnd = (pixelIndex + width) | 0;
        while (pixelIndex < rowEnd) {
          data[pixelIndex] = color;
          pixelIndex += 1;
        }
        pixelIndex = (pixelIndex + rowSkip) | 0;
        phase = (phase + phaseStep) | 0;
        fastRow = (fastRow + 1) | 0;
      }
      return RETURN_VOID;
    }
    this.clippedGradientSlowPathCount += 1;
    let row = (-height) | 0;
    while (row < 0) {
      const startWeight = ((65536 - phase) >> 8) | 0;
      const endWeight = (phase >> 8) | 0;
      const mixedRb = (
        (Math.imul(startColor & 16711935, startWeight) +
          Math.imul(endColor & 16711935, endWeight)) | 0) & -16711936;
      const mixedG = (
        (Math.imul(startColor & 65280, startWeight) +
          Math.imul(endColor & 65280, endWeight)) | 0) & 16711680;
      const color = ((mixedRb + mixedG) >>> 8) | 0;
      let column = (-width) | 0;
      while (column < 0) {
        if (pixels === null || pixels === undefined) {
          throw { type: "java/lang/NullPointerException", message: null };
        }
        if (pixelIndex < 0 || pixelIndex >= length) {
          throw { type: "java/lang/ArrayIndexOutOfBoundsException", message: null };
        }
        if (data !== null) data[pixelIndex] = color;
        else if (pixels.elements) pixels.elements[pixelIndex] = color;
        else pixels[pixelIndex] = color;
        pixelIndex = (pixelIndex + 1) | 0;
        column = (column + 1) | 0;
      }
      pixelIndex = (pixelIndex + rowSkip) | 0;
      phase = (phase + phaseStep) | 0;
      row = (row + 1) | 0;
    }
    return RETURN_VOID;
  }

  clippedStaticGradientDirectAt(x, y, width, height, startColor, endColor,
    leftSite, topSite, rightSite, bottomSite, widthSite, pixelsSite) {
    const clipLeft = this.getStaticSyncAt(leftSite);
    const clipTop = this.getStaticSyncAt(topSite);
    const clipRight = this.getStaticSyncAt(rightSite);
    const clipBottom = this.getStaticSyncAt(bottomSite);
    const surfaceWidth = this.getStaticSyncAt(widthSite);
    const pixels = this.getStaticSyncAt(pixelsSite);
    if (clipLeft === STATIC_DEOPT || clipTop === STATIC_DEOPT ||
        clipRight === STATIC_DEOPT || clipBottom === STATIC_DEOPT ||
        surfaceWidth === STATIC_DEOPT || pixels === STATIC_DEOPT) return STATIC_DEOPT;
    return this.clippedGradientDirect(x, y, width, height, startColor, endColor,
      clipLeft, clipTop, clipRight, clipBottom, surfaceWidth, pixels);
  }

  maskedColorBlitDirect(destination, mask, color, maskIndex, destinationIndex,
    width, height, destinationRowSkip, maskRowSkip) {
    color |= 0;
    maskIndex |= 0;
    destinationIndex |= 0;
    width |= 0;
    height |= 0;
    destinationRowSkip |= 0;
    maskRowSkip |= 0;
    const destinationData = this.arrayData(destination);
    const maskData = this.arrayData(mask);
    const destinationLength = destination?.length ??
      (destinationData && destinationData.length) ?? 0;
    const maskLength = mask?.length ?? (maskData && maskData.length) ?? 0;
    if (width >= 0 && height >= 0 && destinationData !== null && maskData !== null) {
      let checkedMask = maskIndex;
      let checkedDestination = destinationIndex;
      let validRanges = true;
      for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
        if (checkedMask < 0 || checkedMask + width > maskLength ||
            checkedDestination < 0 || checkedDestination + width > destinationLength) {
          validRanges = false;
          break;
        }
        checkedMask = (checkedMask + width + maskRowSkip) | 0;
        checkedDestination = (checkedDestination + width + destinationRowSkip) | 0;
      }
      if (validRanges) {
        for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
          const rowEnd = (maskIndex + width) | 0;
          while (maskIndex < rowEnd) {
            if (maskData[maskIndex] !== 0) destinationData[destinationIndex] = color;
            maskIndex += 1;
            destinationIndex += 1;
          }
          destinationIndex = (destinationIndex + destinationRowSkip) | 0;
          maskIndex = (maskIndex + maskRowSkip) | 0;
        }
        return RETURN_VOID;
      }
    }
    const readMask = (index) => {
      if (mask === null || mask === undefined) {
        throw { type: "java/lang/NullPointerException", message: null };
      }
      if (index < 0 || index >= maskLength) {
        throw { type: "java/lang/ArrayIndexOutOfBoundsException", message: null };
      }
      return maskData !== null ? maskData[index]
        : mask.elements ? mask.elements[index] : mask[index];
    };
    const writeDestination = (index) => {
      if (destination === null || destination === undefined) {
        throw { type: "java/lang/NullPointerException", message: null };
      }
      if (index < 0 || index >= destinationLength) {
        throw { type: "java/lang/ArrayIndexOutOfBoundsException", message: null };
      }
      if (destinationData !== null) destinationData[index] = color;
      else if (destination.elements) destination.elements[index] = color;
      else destination[index] = color;
    };
    const groups = -(width >> 2);
    const remainder = -(width & 3);
    let row = -height;
    while (row < 0) {
      let group = groups;
      while (group < 0) {
        for (let lane = 0; lane < 4; lane += 1) {
          const present = readMask(maskIndex);
          maskIndex = (maskIndex + 1) | 0;
          if (present !== 0) writeDestination(destinationIndex);
          destinationIndex = (destinationIndex + 1) | 0;
        }
        group += 1;
      }
      let tail = remainder;
      while (tail < 0) {
        const present = readMask(maskIndex);
        maskIndex = (maskIndex + 1) | 0;
        if (present !== 0) writeDestination(destinationIndex);
        destinationIndex = (destinationIndex + 1) | 0;
        tail += 1;
      }
      destinationIndex = (destinationIndex + destinationRowSkip) | 0;
      maskIndex = (maskIndex + maskRowSkip) | 0;
      row += 1;
    }
    return RETURN_VOID;
  }

  transparentIntBlitDirect(destination, source, _pixel, sourceIndex,
    destinationIndex, width, height, destinationRowSkip, sourceRowSkip) {
    sourceIndex |= 0;
    destinationIndex |= 0;
    width |= 0;
    height |= 0;
    destinationRowSkip |= 0;
    sourceRowSkip |= 0;
    this.transparentIntBlitRunCount += 1;

    // The verified bytecodes perform no array access in these cases.
    if (height <= 0 || width === 0) return RETURN_VOID;

    const destinationData = this.arrayData(destination);
    const sourceData = this.arrayData(source);
    const destinationLength = destination?.length ??
      (destinationData && destinationData.length) ?? 0;
    const sourceLength = source?.length ?? (sourceData && sourceData.length) ?? 0;
    if (width > 0 && destinationData !== null && sourceData !== null) {
      let checkedSource = sourceIndex;
      let checkedDestination = destinationIndex;
      let validRanges = true;
      for (let row = 0; row < height; row += 1) {
        if (checkedSource < 0 || checkedSource + width > sourceLength ||
            checkedDestination < 0 ||
            checkedDestination + width > destinationLength) {
          validRanges = false;
          break;
        }
        checkedSource = (checkedSource + width + sourceRowSkip) | 0;
        checkedDestination =
          (checkedDestination + width + destinationRowSkip) | 0;
      }
      if (validRanges) {
        for (let row = 0; row < height; row += 1) {
          const rowEnd = (sourceIndex + width) | 0;
          while (sourceIndex < rowEnd) {
            const pixel = sourceData[sourceIndex++] | 0;
            if (pixel !== 0) destinationData[destinationIndex] = pixel;
            destinationIndex += 1;
          }
          destinationIndex =
            (destinationIndex + destinationRowSkip) | 0;
          sourceIndex = (sourceIndex + sourceRowSkip) | 0;
        }
        return RETURN_VOID;
      }
    }

    // Preserve source-before-destination access order and partial writes for
    // malformed inputs. A zero source pixel never touches its destination.
    this.transparentIntBlitSlowPathCount += 1;
    const readSource = (index) => {
      if (source === null || source === undefined) {
        throw { type: "java/lang/NullPointerException", message: null };
      }
      if (index < 0 || index >= sourceLength) {
        throw { type: "java/lang/ArrayIndexOutOfBoundsException", message: null };
      }
      return (sourceData !== null ? sourceData[index]
        : source.elements ? source.elements[index] : source[index]) | 0;
    };
    const writeDestination = (index, value) => {
      if (destination === null || destination === undefined) {
        throw { type: "java/lang/NullPointerException", message: null };
      }
      if (index < 0 || index >= destinationLength) {
        throw { type: "java/lang/ArrayIndexOutOfBoundsException", message: null };
      }
      if (destinationData !== null) destinationData[index] = value;
      else if (destination.elements) destination.elements[index] = value;
      else destination[index] = value;
    };
    const copyPixel = () => {
      const pixel = readSource(sourceIndex);
      sourceIndex = (sourceIndex + 1) | 0;
      if (pixel !== 0) writeDestination(destinationIndex, pixel);
      destinationIndex = (destinationIndex + 1) | 0;
    };
    const groups = -(width >> 2);
    const remainder = -(width & 3);
    let row = -height;
    while (row < 0) {
      let group = groups;
      while (group < 0) {
        copyPixel();
        copyPixel();
        copyPixel();
        copyPixel();
        group += 1;
      }
      let tail = remainder;
      while (tail < 0) {
        copyPixel();
        tail += 1;
      }
      destinationIndex = (destinationIndex + destinationRowSkip) | 0;
      sourceIndex = (sourceIndex + sourceRowSkip) | 0;
      row += 1;
    }
    return RETURN_VOID;
  }

  alphaMaskedColorBlitDirect(destination, source, _pixel, sourceIndex,
    destinationIndex, width, height, destinationRowSkip, sourceRowSkip, alpha) {
    sourceIndex |= 0;
    destinationIndex |= 0;
    width |= 0;
    height |= 0;
    destinationRowSkip |= 0;
    sourceRowSkip |= 0;
    alpha |= 0;
    this.alphaMaskedColorBlitRunCount += 1;

    // The verified bytecodes perform no array access for an empty rectangle.
    if (width <= 0 || height <= 0) return RETURN_VOID;

    const destinationData = this.arrayData(destination);
    const sourceData = this.arrayData(source);
    const destinationLength = destination?.length ??
      (destinationData && destinationData.length) ?? 0;
    const sourceLength = source?.length ?? (sourceData && sourceData.length) ?? 0;
    if (destinationData !== null && sourceData !== null) {
      let checkedSource = sourceIndex;
      let checkedDestination = destinationIndex;
      let validRanges = true;
      for (let row = 0; row < height; row += 1) {
        if (checkedSource < 0 || checkedSource + width > sourceLength ||
            checkedDestination < 0 ||
            checkedDestination + width > destinationLength) {
          validRanges = false;
          break;
        }
        checkedSource = (checkedSource + width + sourceRowSkip) | 0;
        checkedDestination =
          (checkedDestination + width + destinationRowSkip) | 0;
      }
      if (validRanges) {
        for (let row = 0; row < height; row += 1) {
          const rowEnd = (sourceIndex + width) | 0;
          while (sourceIndex < rowEnd) {
            const pixel = sourceData[sourceIndex++] | 0;
            if (pixel !== 0) {
              const redBlue =
                Math.imul(pixel & 0x00ff00ff, alpha) & 0xff00ff00;
              const green =
                Math.imul(pixel & 0x0000ff00, alpha) & 0x00ff0000;
              destinationData[destinationIndex] =
                ((redBlue | green) >>> 8) | 0;
            }
            destinationIndex += 1;
          }
          destinationIndex =
            (destinationIndex + destinationRowSkip) | 0;
          sourceIndex = (sourceIndex + sourceRowSkip) | 0;
        }
        return RETURN_VOID;
      }
    }

    // Preserve the bytecode's access order and partial-write behavior for
    // malformed inputs. In particular, a transparent source pixel does not
    // touch (and therefore cannot fault on) its destination index.
    this.alphaMaskedColorBlitSlowPathCount += 1;
    const readSource = (index) => {
      if (source === null || source === undefined) {
        throw { type: "java/lang/NullPointerException", message: null };
      }
      if (index < 0 || index >= sourceLength) {
        throw { type: "java/lang/ArrayIndexOutOfBoundsException", message: null };
      }
      return (sourceData !== null ? sourceData[index]
        : source.elements ? source.elements[index] : source[index]) | 0;
    };
    const writeDestination = (index, value) => {
      if (destination === null || destination === undefined) {
        throw { type: "java/lang/NullPointerException", message: null };
      }
      if (index < 0 || index >= destinationLength) {
        throw { type: "java/lang/ArrayIndexOutOfBoundsException", message: null };
      }
      if (destinationData !== null) destinationData[index] = value;
      else if (destination.elements) destination.elements[index] = value;
      else destination[index] = value;
    };
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const pixel = readSource(sourceIndex);
        sourceIndex = (sourceIndex + 1) | 0;
        if (pixel !== 0) {
          const redBlue =
            Math.imul(pixel & 0x00ff00ff, alpha) & 0xff00ff00;
          const green =
            Math.imul(pixel & 0x0000ff00, alpha) & 0x00ff0000;
          writeDestination(destinationIndex,
            ((redBlue | green) >>> 8) | 0);
        }
        destinationIndex = (destinationIndex + 1) | 0;
      }
      destinationIndex = (destinationIndex + destinationRowSkip) | 0;
      sourceIndex = (sourceIndex + sourceRowSkip) | 0;
    }
    return RETURN_VOID;
  }

  maskedGlyphDirect(receiver, glyphIndex, x, y, width, height, color,
    surfaceWidth, clipTop, clipBottom, clipLeft, clipRight, pixels, masksFieldSite) {
    glyphIndex |= 0; x |= 0; y |= 0; width |= 0; height |= 0; color |= 0;
    surfaceWidth |= 0; clipTop |= 0; clipBottom |= 0; clipLeft |= 0; clipRight |= 0;
    let destinationIndex = (x + Math.imul(y, surfaceWidth)) | 0;
    let destinationRowSkip = (surfaceWidth - width) | 0;
    let maskIndex = 0;
    let maskRowSkip = 0;
    if (y < clipTop) {
      const clipped = (clipTop - y) | 0;
      height = (height - clipped) | 0;
      y = clipTop;
      maskIndex = (maskIndex + Math.imul(clipped, width)) | 0;
      destinationIndex =
        (destinationIndex + Math.imul(clipped, surfaceWidth)) | 0;
    }
    if (((y + height) | 0) > clipBottom) {
      height = (height - (((y + height) | 0) - clipBottom)) | 0;
    }
    if (x < clipLeft) {
      const clipped = (clipLeft - x) | 0;
      width = (width - clipped) | 0;
      x = clipLeft;
      maskIndex = (maskIndex + clipped) | 0;
      destinationIndex = (destinationIndex + clipped) | 0;
      maskRowSkip = (maskRowSkip + clipped) | 0;
      destinationRowSkip = (destinationRowSkip + clipped) | 0;
    }
    if (((x + width) | 0) > clipRight) {
      const clipped = (((x + width) | 0) - clipRight) | 0;
      width = (width - clipped) | 0;
      maskRowSkip = (maskRowSkip + clipped) | 0;
      destinationRowSkip = (destinationRowSkip + clipped) | 0;
    }
    if (width <= 0 || height <= 0) return RETURN_VOID;
    const masks = this.getFieldAt(masksFieldSite, receiver);
    if (masks === null || masks === undefined) {
      throw { type: "java/lang/NullPointerException", message: null };
    }
    const masksData = this.arrayData(masks);
    const masksLength = masks.length ?? (masksData && masksData.length) ?? 0;
    if (glyphIndex < 0 || glyphIndex >= masksLength) {
      throw { type: "java/lang/ArrayIndexOutOfBoundsException", message: null };
    }
    const mask = masksData !== null ? masksData[glyphIndex]
      : masks.elements ? masks.elements[glyphIndex] : masks[glyphIndex];
    return this.maskedColorBlitDirect(pixels, mask, color, maskIndex,
      destinationIndex, width, height, destinationRowSkip, maskRowSkip);
  }

  packedColorScanlineDirect(green, index, greenStep, redStep, red, count,
    tag, dest, blue, blueStep, guarded, owner) {
    if ((tag | 0) !== 9 || guarded ||
        this.jvm.classInitializationState.get(owner) !== "INITIALIZED") return ASYNC_INVOKE;
    index |= 0;
    count |= 0;
    if (dest === null || dest === undefined) {
      throw { type: "java/lang/NullPointerException", message: null };
    }
    if (count <= 0) return true;
    if (index < 0 || index + count > dest.length) {
      throw { type: "java/lang/ArrayIndexOutOfBoundsException", message: null };
    }
    green |= 0;
    red |= 0;
    blue |= 0;
    greenStep |= 0;
    redStep |= 0;
    blueStep |= 0;
    for (let offset = 0; offset < count; offset += 1) {
      dest[index] = (((dest[index] >> 1) & 8355711) +
        ((green >> 9) & 65280) + ((red >> 1) & 16711680) +
        ((blue >> 17) & 255)) | 0;
      index += 1;
      green = (green + greenStep) | 0;
      red = (red + redStep) | 0;
      blue = (blue + blueStep) | 0;
    }
    return true;
  }

  packedColorScanlineFused(green, index, greenStep, redStep, red, count,
    tag, dest, blue, blueStep) {
    if ((tag | 0) !== 9) throw FusedRegionCompiler.BAILOUT;
    index |= 0;
    count |= 0;
    if (dest === null || dest === undefined) {
      throw { type: "java/lang/NullPointerException", message: null };
    }
    if (count <= 0) return;
    if (index < 0 || index + count > dest.length) {
      throw { type: "java/lang/ArrayIndexOutOfBoundsException", message: null };
    }
    green |= 0; red |= 0; blue |= 0;
    greenStep |= 0; redStep |= 0; blueStep |= 0;
    for (let offset = 0; offset < count; offset += 1) {
      dest[index] = (((dest[index] >> 1) & 8355711) +
        ((green >> 9) & 65280) + ((red >> 1) & 16711680) +
        ((blue >> 17) & 255)) | 0;
      index += 1;
      green = (green + greenStep) | 0;
      red = (red + redStep) | 0;
      blue = (blue + blueStep) | 0;
    }
  }

  constantColorScanlineFused(index, tag, dest, color, count) {
    if ((tag | 0) !== 57) throw FusedRegionCompiler.BAILOUT;
    index |= 0; color |= 0; count |= 0;
    if (dest === null || dest === undefined) {
      throw { type: "java/lang/NullPointerException", message: null };
    }
    if (count <= 0) return;
    if (index < 0 || index + count > dest.length) {
      throw { type: "java/lang/ArrayIndexOutOfBoundsException", message: null };
    }
    for (let offset = 0; offset < count; offset += 1) {
      dest[index] = (color + ((dest[index] & 16711422) >> 1)) | 0;
      index += 1;
    }
  }

  fusedBailout() {
    return FusedRegionCompiler.BAILOUT;
  }

  invokeFusedIntegerNative(nativeMethod, left, right) {
    const result = nativeMethod(this.jvm, null, [left | 0, right | 0]);
    if (result && typeof result.then === "function") throw FusedRegionCompiler.BAILOUT;
    return result;
  }

  getInlineIntegerRegion(method, params, returnType) {
    if (this.inlineIntegerRegionCache.has(method)) {
      return this.inlineIntegerRegionCache.get(method);
    }
    const plan = this.getInlineIntegerPlan(method, params, returnType);
    // The standalone stack ABI has no canonical call-site Frame to resume
    // when a speculative normal-path guard fails. Guarded plans are reserved
    // for structured callers, which can materialize the exact invoke PC.
    if (!plan || plan.guards.length > 0) return null;
    // Bound rather than passed: an inlined field read needs the helper table
    // for its fallback, while every existing call site keeps calling this as
    // (stack, base).
    const raw = this.createGeneratedFunction(
      method, "inline-integer", ["helpers", "stack", "base"],
      `"use strict"; ${plan.statements.join(" ")} return ${plan.result};`);
    const inline = raw.bind(null, this);
    inline.jvmPlan = plan;
    inline.jvmReceiverSlots = plan.receiverSlots;
    inline.jvmNested = plan.methodCount > 1;
    this.inlineIntegerRegionCache.set(method, inline);
    return inline;
  }

  getDirectInlineIntegerRegion(method, params, returnType) {
    if (this.directInlineIntegerRegionCache.has(method)) {
      return this.directInlineIntegerRegionCache.get(method);
    }
    if (returnType !== "int" || !params.every((type) => type === "int")) {
      this.directInlineIntegerRegionCache.set(method, null);
      return null;
    }
    const receiverSlots = (method.flags || []).includes("static") ? 0 : 1;
    const argumentNames = Array.from(
      { length: params.length + receiverSlots },
      (_unused, index) => `argument${index}`,
    );
    const plan = this.buildInlineIntegerPlan(
      method, params, returnType, argumentNames);
    if (!plan || plan.guards.length > 0) {
      this.directInlineIntegerRegionCache.set(method, null);
      return null;
    }
    const raw = this.createGeneratedFunction(
      method,
      "inline-integer-positional",
      ["helpers", ...argumentNames],
      `"use strict"; ${plan.statements.join(" ")} return ${plan.result};`,
    );
    raw.jvmInlineInteger = true;
    const direct = raw.bind(null, this);
    direct.jvmRawInvoke = raw;
    // The structured caller owns the debugger/class guard and its loop safe
    // points. A receiver-type mismatch never enters this body.
    direct.jvmDebugGuarded = false;
    direct.jvmInlineInteger = true;
    this.directInlineIntegerRegionCache.set(method, direct);
    return direct;
  }

  getInlineIntegerPlan(method, params, returnType) {
    if (this.inlineIntegerPlanCache.has(method)) {
      return this.inlineIntegerPlanCache.get(method);
    }
    if (returnType !== "int" || !params.every((type) => type === "int")) return null;
    const isStatic = (method.flags || []).includes("static");
    const receiverSlots = isStatic ? 0 : 1;
    const args = new Array(params.length + receiverSlots);
    for (let index = 0; index < args.length; index += 1) {
      args[index] = `stack[base + ${index}]`;
    }
    const plan = this.buildInlineIntegerPlan(method, params, returnType, args);
    this.inlineIntegerPlanCache.set(method, plan);
    return plan;
  }

  buildInlineIntegerPlan(method, params, returnType, args) {
    const receiverSlots = (method.flags || []).includes("static") ? 0 : 1;
    const state = {
      active: new Set(), declarations: [], statements: [], nextTemp: 0,
      instructionCount: 0, methodCount: 0, guards: [],
    };
    const result = this.emitInlineIntegerMethod(method, params, returnType, args, state, 0);
    if (result === null) return null;
    const plan = {
      statements: [...state.declarations, ...state.statements],
      result,
      receiverSlots,
      inputCount: args.length,
      methodCount: state.methodCount,
      guards: state.guards,
    };
    return plan;
  }

  emitInlineIntegerMethod(method, params, returnType, args, state, depth) {
    if (returnType !== "int" || !params.every((type) => type === "int") || depth > 4 ||
        state.active.has(method)) return null;
    const code = method.attributes.find((attr) => attr.type === "code");
    if (!code) return null;
    let items = this.getCodeItems(method);
    if ((code.code.exceptionTable || []).length) {
      // Obfuscators commonly wrap a pure integer helper in a catch/rethrow
      // diagnostic tail.  Exception handlers are not normal CFG successors,
      // so retain only blocks reachable from bytecode entry.  The opcode
      // whitelist below still proves that the retained body cannot throw;
      // consequently omitting the diagnostic-only handler preserves exact
      // Java behavior without recognizing any owner or method identity.
      const cfg = buildCfgFromCode(items);
      if (!cfg) return null;
      const reachableBlocks = new Set();
      const reachableItems = new Set();
      const work = [cfg.entry];
      while (work.length) {
        const block = work.pop();
        if (!Number.isInteger(block) || reachableBlocks.has(block) ||
            !cfg.blocks[block]) continue;
        reachableBlocks.add(block);
        for (const index of cfg.blocks[block].insns || []) {
          reachableItems.add(index);
        }
        for (const successor of cfg.succ[block] || []) work.push(successor);
      }
      items = items.filter((item, index) => reachableItems.has(index));
    }
    items = items.filter((item) => item && item.instruction);
    const instructions = items.map((item) => item.instruction);
    const labels = buildLabelMap(items);
    if (instructions.length > 64 || state.instructionCount + instructions.length > 256) return null;

    const isStatic = (method.flags || []).includes("static");
    const receiverSlots = isStatic ? 0 : 1;
    if (args.length !== params.length + receiverSlots) return null;
    const locals = [];
    for (let index = 0; index < params.length; index += 1) {
      locals[index + receiverSlots] = args[index + receiverSlots];
    }
    const stack = [];
    const pop = () => stack.length ? stack.pop() : null;
    const materialize = (expression) => {
      const temporary = `inlineValue${state.nextTemp++}`;
      state.declarations.push(`let ${temporary};`);
      state.statements.push(`${temporary} = ${expression};`);
      return temporary;
    };
    const binary = (format) => {
      const right = pop();
      const left = pop();
      if (left === null || right === null) return false;
      stack.push(materialize(format(left, right)));
      return true;
    };
    const emitStraightRange = (start, end, rangeLocals, rangeStack) => {
      const statements = [];
      const rangePop = () => rangeStack.length ? rangeStack.pop() : null;
      const rangeMaterialize = (expression) => {
        const temporary = `inlineValue${state.nextTemp++}`;
        state.declarations.push(`let ${temporary};`);
        statements.push(`${temporary} = ${expression};`);
        return temporary;
      };
      const rangeBinary = (format) => {
        const right = rangePop(), left = rangePop();
        if (left === null || right === null) return false;
        rangeStack.push(rangeMaterialize(format(left, right)));
        return true;
      };
      for (let index = start; index < end; index += 1) {
        const instruction = instructions[index];
        const op = getOp(instruction);
        const load = op === "iload" ? Number(instruction.arg)
          : /^iload_[0-3]$/.test(op) ? Number(op.slice(-1)) : null;
        if (load !== null) {
          if (rangeLocals[load] === undefined) return null;
          rangeStack.push(rangeLocals[load]);
          continue;
        }
        const store = op === "istore" ? Number(instruction.arg)
          : /^istore_[0-3]$/.test(op) ? Number(op.slice(-1)) : null;
        if (store !== null) {
          const stored = rangePop();
          if (stored === null) return null;
          rangeLocals[store] = stored;
          continue;
        }
        if (/^iconst_[0-5]$/.test(op)) { rangeStack.push(op.slice(-1)); continue; }
        if (op === "iconst_m1") { rangeStack.push("-1"); continue; }
        if (["bipush", "sipush", "ldc", "ldc_w"].includes(op) &&
            Number.isInteger(Number(instruction.arg))) {
          rangeStack.push(String(Number(instruction.arg) | 0));
          continue;
        }
        let valid = true;
        switch (op) {
          case "iadd": valid = rangeBinary((a, b) => `((${a} + ${b}) | 0)`); break;
          case "isub": valid = rangeBinary((a, b) => `((${a} - ${b}) | 0)`); break;
          case "imul": valid = rangeBinary((a, b) => `Math.imul(${a}, ${b})`); break;
          case "iand": valid = rangeBinary((a, b) => `(${a} & ${b})`); break;
          case "ior": valid = rangeBinary((a, b) => `(${a} | ${b})`); break;
          case "ixor": valid = rangeBinary((a, b) => `(${a} ^ ${b})`); break;
          case "ishl": valid = rangeBinary((a, b) => `(${a} << (${b} & 31))`); break;
          case "ishr": valid = rangeBinary((a, b) => `(${a} >> (${b} & 31))`); break;
          case "iushr": valid = rangeBinary((a, b) => `((${a} >>> (${b} & 31)) | 0)`); break;
          case "ineg": {
            const input = rangePop();
            valid = input !== null;
            if (valid) rangeStack.push(rangeMaterialize(`((-${input}) | 0)`));
            break;
          }
          case "i2b": {
            const input = rangePop();
            valid = input !== null;
            if (valid) rangeStack.push(rangeMaterialize(`((${input} << 24) >> 24)`));
            break;
          }
          default: valid = false; break;
        }
        if (!valid) return null;
      }
      return statements;
    };

    state.active.add(method);
    state.instructionCount += instructions.length;
    state.methodCount += 1;
    try {
      for (let index = 0; index < instructions.length; index += 1) {
        const instruction = instructions[index];
        const op = getOp(instruction);
        const load = op === "iload" ? Number(instruction.arg)
          : /^iload_[0-3]$/.test(op) ? Number(op.slice(-1)) : null;
        if (load !== null) {
          if (locals[load] === undefined) return null;
          stack.push(locals[load]);
          continue;
        }
        const store = op === "istore" ? Number(instruction.arg)
          : /^istore_[0-3]$/.test(op) ? Number(op.slice(-1)) : null;
        if (store !== null) {
          const value = pop();
          if (value === null) return null;
          locals[store] = value;
          continue;
        }
        if (/^iconst_[0-5]$/.test(op)) {
          stack.push(op.slice(-1));
          continue;
        }
        if (op === "iconst_m1") {
          stack.push("-1");
          continue;
        }
        if (op === "bipush" || op === "sipush") {
          stack.push(String(Number(instruction.arg) | 0));
          continue;
        }
        if ((op === "ldc" || op === "ldc_w") && Number.isInteger(Number(instruction.arg))) {
          stack.push(String(Number(instruction.arg) | 0));
          continue;
        }
        // Every parameter is proven int above, so on an instance method slot 0
        // is the only reference in scope and aload_0 is the only admissible
        // reference load. Accepting it is what lets an ordinary getter inline
        // instead of pushing a whole frame.
        if (receiverSlots === 1 &&
            (op === "aload_0" || (op === "aload" && Number(instruction.arg) === 0))) {
          stack.push(args[0]);
          continue;
        }
        if (op === "getfield") {
          // Unlike the arithmetic whitelist, a field read can throw, so it is
          // only admissible when no exception-handler blocks were dropped from
          // the body above.
          if ((code.code.exceptionTable || []).length) return null;
          const objectExpression = pop();
          // The receiver is the only reference that can be on this stack, and
          // the call boundary has already null-checked it. Refuse anything else
          // rather than reason about a second object's nullness.
          if (objectExpression === null || objectExpression !== args[0]) return null;
          const fieldSiteId = this.registerFieldSite(instruction.arg);
          const fieldSite = this.fieldSites[fieldSiteId];
          // The declaring slot must be known statically, and the value must be
          // an int for the arithmetic that follows to stay exact.
          if (!fieldSite.directInstanceKey) return null;
          if (fieldSite.descriptor !== "I" && fieldSite.descriptor !== "int") return null;
          const fieldKey = JSON.stringify(fieldSite.directInstanceKey);
          // Same guarded direct read the ordinary generated tier emits; the
          // fallback resolves nonstandard layouts and throws the correct NPE.
          stack.push(materialize(
            `((${objectExpression} !== null && ${objectExpression} !== undefined && `
            + `${objectExpression}.fields !== undefined && `
            + `${objectExpression}.fields[${fieldKey}] !== undefined) `
            + `? ${objectExpression}.fields[${fieldKey}] `
            + `: helpers.getFieldAt(${fieldSiteId}, ${objectExpression}))`));
          continue;
        }
        if (op && op.startsWith("if")) {
          let condition;
          if (op.startsWith("if_icmp")) {
            const right = pop(), left = pop();
            const comparison = { if_icmpeq: "===", if_icmpne: "!==", if_icmplt: "<",
              if_icmpge: ">=", if_icmpgt: ">", if_icmple: "<=" }[op];
            if (left === null || right === null || !comparison) return null;
            condition = `${left} ${comparison} ${right}`;
          } else {
            const input = pop();
            const comparison = { ifeq: "=== 0", ifne: "!== 0", iflt: "< 0",
              ifge: ">= 0", ifgt: "> 0", ifle: "<= 0" }[op];
            if (input === null || !comparison) return null;
            condition = `${input} ${comparison}`;
          }
          const target = branchTargetIndex(instruction, labels);
          if (!Number.isInteger(target) || target <= index || target >= instructions.length) return null;
          const fallLocals = [...locals], fallStack = [...stack];
          const branchStatements = emitStraightRange(index + 1, target, fallLocals, fallStack);
          if (!branchStatements || fallStack.length !== stack.length) {
            // The taken edge bypasses an unsupported diagnostic/effect path.
            // Publish that edge as a call-site precondition: a structured
            // caller can deopt at the invoke before the helper has executed
            // any bytecode, while the admitted path remains a pure integer
            // expression. This is derived solely from the verified forward
            // CFG and works for arbitrary obfuscator guards.
            state.guards.push(`(${condition})`);
            index = target - 1;
            continue;
          }
          const phis = [];
          const mergedLocals = [...locals], mergedStack = [...stack];
          const merge = (before, after, assign) => {
            if (before === after) return true;
            if (before === undefined || after === undefined) return false;
            const phi = `inlineValue${state.nextTemp++}`;
            state.declarations.push(`let ${phi};`);
            state.statements.push(`${phi} = ${before};`);
            phis.push(`${phi} = ${after};`);
            assign(phi);
            return true;
          };
          const localSlots = Math.max(locals.length, fallLocals.length);
          for (let slot = 0; slot < localSlots; slot += 1) {
            if (!merge(locals[slot], fallLocals[slot], (phi) => { mergedLocals[slot] = phi; })) {
              return null;
            }
          }
          for (let slot = 0; slot < stack.length; slot += 1) {
            if (!merge(stack[slot], fallStack[slot], (phi) => { mergedStack[slot] = phi; })) {
              return null;
            }
          }
          state.statements.push(`if (!(${condition})) {`, ...branchStatements, ...phis, "}");
          locals.length = 0; locals.push(...mergedLocals);
          stack.length = 0; stack.push(...mergedStack);
          index = target - 1;
          continue;
        }
        if (op === "invokestatic") {
          const target = this.resolveInlineIntegerStaticTarget(instruction);
          if (!target) return null;
          const callArgs = new Array(target.params.length);
          for (let argument = target.params.length - 1; argument >= 0; argument -= 1) {
            callArgs[argument] = pop();
            if (callArgs[argument] === null) return null;
          }
          const value = this.emitInlineIntegerMethod(target.method, target.params,
            target.returnType, callArgs, state, depth + 1);
          if (value === null) return null;
          stack.push(value);
          continue;
        }
        let valid = true;
        switch (op) {
          case "iadd": valid = binary((a, b) => `((${a} + ${b}) | 0)`); break;
          case "isub": valid = binary((a, b) => `((${a} - ${b}) | 0)`); break;
          case "imul": valid = binary((a, b) => `Math.imul(${a}, ${b})`); break;
          case "idiv": {
            const divisor = pop(), dividend = pop();
            valid = dividend !== null && divisor !== null;
            if (valid) {
              state.guards.push(`(${divisor} !== 0)`);
              stack.push(materialize(`((${dividend} / ${divisor}) | 0)`));
            }
            break;
          }
          case "irem": {
            const divisor = pop(), dividend = pop();
            valid = dividend !== null && divisor !== null;
            if (valid) {
              state.guards.push(`(${divisor} !== 0)`);
              stack.push(materialize(`((${dividend} % ${divisor}) | 0)`));
            }
            break;
          }
          case "iand": valid = binary((a, b) => `(${a} & ${b})`); break;
          case "ior": valid = binary((a, b) => `(${a} | ${b})`); break;
          case "ixor": valid = binary((a, b) => `(${a} ^ ${b})`); break;
          case "ishl": valid = binary((a, b) => `(${a} << (${b} & 31))`); break;
          case "ishr": valid = binary((a, b) => `(${a} >> (${b} & 31))`); break;
          case "iushr": valid = binary((a, b) => `((${a} >>> (${b} & 31)) | 0)`); break;
          case "ineg": {
            const value = pop();
            valid = value !== null;
            if (valid) stack.push(materialize(`((-${value}) | 0)`));
            break;
          }
          case "i2b": {
            const value = pop();
            valid = value !== null;
            if (valid) stack.push(materialize(`((${value} << 24) >> 24)`));
            break;
          }
          case "ireturn": {
            if (index !== instructions.length - 1 || stack.length !== 1) return null;
            return pop();
          }
          default: valid = false; break;
        }
        if (!valid) return null;
      }
      return null;
    } finally {
      state.active.delete(method);
    }
  }

  resolveInlineIntegerStaticTarget(instruction) {
    if (!instruction || !Array.isArray(instruction.arg) ||
        !Array.isArray(instruction.arg[2])) return null;
    const [, className, [methodName, descriptor]] = instruction.arg;
    if (this.jvm.classInitializationState.get(className) !== "INITIALIZED") return null;
    const classData = this.jvm.classes[className];
    if (!classData) return null;
    const method = this.jvm.findMethod(classData, methodName, descriptor);
    if (!method || !(method.flags || []).includes("static")) return null;
    const parsed = parseDescriptor(descriptor);
    if (parsed.returnType !== "int" || !parsed.params.every((type) => type === "int")) return null;
    return { method, ...parsed };
  }

  getCompileTimeIntegerLeaf(instruction) {
    if (!instruction || !Array.isArray(instruction.arg) ||
        !Array.isArray(instruction.arg[2])) return null;
    const [, className, [methodName, descriptor]] = instruction.arg;
    if (this.jvm.classInitializationState.get(className) !== "INITIALIZED") return null;
    const classData = this.jvm.classes[className];
    if (!classData) return null;
    const method = this.jvm.findMethod(classData, methodName, descriptor);
    if (!method || !(method.flags || []).includes("static")) return null;
    const { params, returnType } = parseDescriptor(descriptor);
    const plan = this.getInlineIntegerPlan(method, params, returnType);
    if (!plan || plan.receiverSlots) return null;
    return {
      statements: plan.statements,
      result: plan.result,
      guards: plan.guards,
      paramCount: params.length,
      className,
    };
  }

  getCompileTimeCheckedLeaf(instruction) {
    if (!this.checkedLeafDirectPositionalEnabled || !instruction ||
        !Array.isArray(instruction.arg) ||
        !Array.isArray(instruction.arg[2])) return null;
    const [, className, [methodName, descriptor]] = instruction.arg;
    if (this.jvm.classInitializationState.get(className) !== "INITIALIZED") {
      return null;
    }
    const classData = this.jvm.classes[className];
    if (!classData) return null;
    const method = this.jvm.findMethod(classData, methodName, descriptor);
    if (!method || !(method.flags || []).includes("static")) return null;
    const parsed = parseDescriptor(descriptor);
    const generated = this.getGeneratedFunction(method);
    const capturedBody =
      generated?.jvmCapturedCheckedLeafDirectPositionalBody;
    const capturedPlan =
      generated?.jvmCapturedCheckedLeafDirectPositionalPlan;
    const capturedSource =
      generated?.jvmCapturedCheckedLeafDirectPositionalSource;
    const ordinarySource = generated?.jvmCheckedLeafDirectPositionalSource;
    const rawAdmissionPlan =
      generated?.jvmStructuredCheckedLeafAdmissionPlan;
    let admissionPlan = null;
    if (rawAdmissionPlan?.kind === "record-window") {
      const slotArguments = new Map();
      let slot = 0;
      for (let argument = 0; argument < parsed.params.length; argument += 1) {
        slotArguments.set(slot, argument);
        slot += parsed.params[argument] === "long" ||
          parsed.params[argument] === "double" ? 2 : 1;
      }
      const arrayArgument = slotArguments.get(rawAdmissionPlan.arraySlot);
      const lowerArgument = slotArguments.get(rawAdmissionPlan.lowerSlot);
      const upperArgument = slotArguments.get(rawAdmissionPlan.upperSlot);
      if (Number.isInteger(arrayArgument) &&
          Number.isInteger(lowerArgument) &&
          Number.isInteger(upperArgument) &&
          Number.isInteger(rawAdmissionPlan.stride) &&
          rawAdmissionPlan.stride > 0) {
        admissionPlan = {
          kind: rawAdmissionPlan.kind,
          arrayArgument,
          lowerArgument,
          upperArgument,
          stride: rawAdmissionPlan.stride,
          maximumRecords: Number.isInteger(rawAdmissionPlan.maximumRecords) &&
            rawAdmissionPlan.maximumRecords > 0
            ? rawAdmissionPlan.maximumRecords : null,
          guardVariable: rawAdmissionPlan.guardVariable,
        };
      }
    } else if (rawAdmissionPlan?.kind === "clipped-affine-fill") {
      const integerKeys = [
        "xArgument", "yArgument", "countArgument", "valueArgument",
        "topCapture", "bottomCapture", "leftCapture", "rightCapture",
        "widthCapture", "arrayCapture", "arrayDataCapture", "maximumTrips",
      ];
      if (integerKeys.every((key) =>
        Number.isInteger(rawAdmissionPlan[key]) &&
        rawAdmissionPlan[key] >= 0)) {
        admissionPlan = Object.fromEntries([
          ["kind", rawAdmissionPlan.kind],
          ...integerKeys.map((key) => [key, rawAdmissionPlan[key]]),
        ]);
      }
    }
    const body = typeof capturedBody === "function"
      ? capturedBody : generated?.jvmCheckedLeafDirectPositionalBody;
    if (typeof body !== "function") return null;
    let id = this.directCheckedLeafBodyIds.get(body);
    if (!Number.isInteger(id)) {
      id = this.directCheckedLeafBodies.length;
      this.directCheckedLeafBodies.push(body);
      this.directCheckedLeafBodyIds.set(body, id);
    }
    return {
      id,
      paramCount: parsed.params.length,
      returnsVoid: parsed.returnType === "void",
      noThrow: true,
      inlineSource: generated.jvmStructuredRecursiveArrayPartitionCheckedLeaf
        ? null : typeof capturedBody === "function" &&
        typeof capturedSource === "string" ? capturedSource :
        typeof ordinarySource === "string" ? ordinarySource : null,
      captures: typeof capturedBody === "function" &&
        Array.isArray(capturedPlan?.captures)
        ? capturedPlan.captures : [],
      admissionPlan,
    };
  }

  getCompileTimeSynchronousIntrinsic(instruction) {
    if (!instruction || !Array.isArray(instruction.arg) ||
        !Array.isArray(instruction.arg[2])) return null;
    const [, className, [methodName, descriptor]] = instruction.arg;
    const classInitialized =
      this.jvm.classInitializationState.get(className) === "INITIALIZED";
    const classData = this.jvm.classes[className];
    if (!classData) return null;
    const method = this.jvm.findMethod(classData, methodName, descriptor);
    if (!method || !(method.flags || []).includes("static")) return null;
    let parsed;
    try { parsed = parseDescriptor(descriptor); } catch (_) { return null; }
    const intrinsic = this.getSynchronousIntrinsic(method, descriptor);
    if (!intrinsic?.jvmDirectKind) return null;
    // Most direct intrinsics retain the historical initialized-only binding.
    // The complete alpha-rectangle proof can also be installed while its
    // owner is merely loaded: the structured caller emits an initialization
    // guard and falls back before any pixel effect until publication.
    if (!classInitialized &&
        intrinsic.jvmDirectKind !== "transparentIntBlit" &&
        intrinsic.jvmDirectKind !== "alphaMaskedColorBlit") return null;
    const direct = {
      kind: intrinsic.jvmDirectKind,
      paramCount: parsed.params.length,
      returnsVoid: parsed.returnType === "void",
      initializationOwner: classInitialized ? null : className,
    };
    if (intrinsic.jvmDirectKind === "clippedStaticSpan" ||
        intrinsic.jvmDirectKind === "clippedStaticAlphaSpan" ||
        intrinsic.jvmDirectKind === "clippedStaticGradient") {
      const staticFields = intrinsic.jvmDirectData?.staticFields;
      if (!Array.isArray(staticFields) || staticFields.length !== 6) return null;
      direct.staticFieldSites = staticFields.map((field) => this.registerFieldSite(field));
    } else if (intrinsic.jvmDirectKind === "polygonFlatRaster" ||
        intrinsic.jvmDirectKind === "polygonAlphaRaster" ||
        intrinsic.jvmDirectKind === "tiledIntArrayBlit" ||
        intrinsic.jvmDirectKind === "perspectiveTexturedSpan" ||
        intrinsic.jvmDirectKind === "affineSpriteRaster") {
      if (typeof intrinsic.jvmPositional !== "function") return null;
      direct.positionalId = this.directSynchronousIntrinsics.length;
      this.directSynchronousIntrinsics.push(intrinsic.jvmPositional);
    }
    return direct;
  }

  async invoke(op, frame, instruction, thread, invokePc) {
    const [, declaredClassName, [methodName, descriptor]] = instruction.arg;
    const { params, returnType } = parseDescriptor(descriptor);
    const stackSnapshot = frame.stack.items.slice();
    if (op === "invokestatic") {
      const wasFramePushed = await this.jvm.initializeClassIfNeeded(declaredClassName, thread);
      if (wasFramePushed) {
        frame.pc = invokePc;
        return {
          deopt: true,
          transient: true,
          reason: `class initialization at invokestatic ${declaredClassName}.${methodName}${descriptor}`,
        };
      }
    }
    const args = [];
    for (let i = 0; i < params.length; i += 1) {
      args.unshift(frame.stack.items.pop());
    }

    let receiver = null;
    let targetClassName = declaredClassName;
    if (op !== "invokestatic") {
      receiver = frame.stack.items.pop();
      if (receiver === null || receiver === undefined) {
        throw { type: "java/lang/NullPointerException", message: null };
      }
      if (op === "invokevirtual" || op === "invokeinterface") {
        targetClassName = receiver.type || declaredClassName;
      }
    }

    const jreMethod = await this.findJreMethod(targetClassName, declaredClassName, methodName, descriptor);
    if (jreMethod) {
      let result = jreMethod(this.jvm, receiver, args, thread);
      if (result && typeof result.then === "function") result = await result;
      if (result === ASYNC_METHOD_SENTINEL) {
        // Some JRE shims (notably Method.invoke) install a Java child frame
        // and use the sentinel to tell the interpreter not to push a result.
        // Yield the compiled caller when that happened; its post-invoke PC is
        // already materialized and the child will supply the eventual value.
        if (!thread.callStack.isEmpty() && thread.callStack.peek() !== frame) {
          return {
            deopt: true,
            transient: true,
            reason: `async JRE handoff ${targetClassName}.${methodName}${descriptor}`,
          };
        }
        return RETURN_VOID;
      }
      if (returnType === "V" || result === undefined) return RETURN_VOID;
      return typeof result === "boolean" ? (result ? 1 : 0) : result;
    }

    // Platform classes are implemented by the JRE shim table. Their parsed
    // classfiles are linkage/type stubs and may contain native methods with no
    // Code attribute; treating such an empty Frame as a successful call
    // silently skips required work. Match the interpreter and fail explicitly
    // when no shim exists.
    if (this.jvm.jre[targetClassName] || this.jvm.jre[declaredClassName]) {
      frame.stack.items = stackSnapshot;
      frame.pc = invokePc;
      throw new Error(
        `Unsupported ${op}: ${targetClassName}.${methodName}${descriptor}`,
      );
    }

    let classData = this.jvm.classes[targetClassName] || await this.jvm.loadClassByName(targetClassName);
    let method = this.jvm.findMethod(classData, methodName, descriptor);
    let lookupClass = targetClassName;
    while (!method && (op === "invokevirtual" || op === "invokeinterface") &&
      classData && classData.ast.classes[0].superClassName) {
      lookupClass = classData.ast.classes[0].superClassName;
      classData = this.jvm.classes[lookupClass] || await this.jvm.loadClassByName(lookupClass);
      method = this.jvm.findMethod(classData, methodName, descriptor);
    }
    if (!method) {
      frame.stack.items = stackSnapshot;
      frame.pc = invokePc;
      throw new Error(`Unsupported ${op}: ${targetClassName}.${methodName}${descriptor}`);
    }
    if (debugConstructorOwners.size && methodName === "<init>" &&
        debugConstructorOwners.has(targetClassName)) {
      console.error(`[constructor] jit resolved ${targetClassName}${descriptor} ` +
        `from ${frame.className}.${frame.method && frame.method.name}@${invokePc}`);
    }
    // Match synchronous call-site admission above. A broad whole-method body
    // that is safe as a scheduler entry is equally safe as a nested generated
    // call and avoids a needless frame/scheduler round trip.
    const jsChildSupported = this.isSupported(method) ||
      this.isShortSupportedHelper(method) ||
      (this.prefersWholeMethodJs(frame.method) &&
        this.isCodegenSupported(method));

    const child = new Frame(method);
    child.className = lookupClass;
    let localIndex = 0;
    if (op !== "invokestatic") {
      child.locals[0] = receiver;
      localIndex = 1;
    }
    for (let i = 0; i < params.length; i += 1) {
      child.locals[localIndex] = args[i];
      localIndex += params[i] === "long" || params[i] === "double" ? 2 : 1;
    }
    thread.callStack.push(child);
    if (child.isSynchronizedMethod && !child.monitorEntered &&
        !this.jvm.enterFrameMonitorIfNeeded(child, thread)) {
      // Contended: leave the child pushed and let the scheduler resume it.
      return { deopt: true, reason: "synchronized monitor contended" };
    }
    if (this.wasmJit.enabled) {
      // Ask the Wasm tier before rejecting the child on JS-JIT policy. Wasm
      // can prove numeric loops covered by a wrap-and-rethrow diagnostic
      // handler even when the whole-method JS tier conservatively rejects the
      // same exceptional call graph. This ordering is important for callers
      // such as rasterizers: permanently deoptimizing the parent first meant a
      // child compiled successfully later but could no longer help it.
      const wasmResult = this.wasmJit.runNested(child, thread, {
        // A JS-policy-rejected child has no in-call runner fallback. Execute it
        // speculatively only when every normally reachable block is compiled;
        // handler-only diagnostic blocks may remain outside Wasm.
        requireNormalFlowFullyCompiled: !jsChildSupported,
      });
      if (wasmResult.returned) {
        if (returnType === "V" || wasmResult.isVoid) return RETURN_VOID;
        return wasmResult.value;
      }
      if (wasmResult.exited && (wasmResult.deopted || !jsChildSupported)) {
        // The child remains on the Java call stack at its materialized exit
        // PC (a deopt may also have materialized deeper callee frames above
        // it). Yield the generated parent transiently; executeTick will resume
        // the top frame through the normal scheduler and then continue the
        // parent at the already-materialized post-invoke PC.
        return {
          deopt: true,
          transient: true,
          reason: `wasm callee exit ${targetClassName}.${methodName}${descriptor}`,
        };
      }
    }
    if (!jsChildSupported) {
      // The generated caller materializes its post-invoke pc and operand stack
      // before entering this helper. Keep the initialized child on the Java
      // call stack so the interpreter can finish only that unsupported call;
      // its return instruction supplies any result to the caller's materialized
      // stack, after which the hot caller resumes generated execution. This is
      // also exception-safe: propagation uses parent.pc - 1 as the invoke site.
      return {
        deopt: true,
        transient: true,
        reason: `interpreted callee ${targetClassName}.${methodName}${descriptor}`,
      };
    }
    const generated = this.getGeneratedFunction(method);
    const result = generated
      ? await this.runGeneratedFrame(generated, child, thread)
      : await this.runFrame(child, thread);
    if (result.deopt) return result;
    if (returnType === "V" || result.value === RETURN_VOID) return RETURN_VOID;
    return result.value;
  }

  async findJreMethod(targetClassName, declaredClassName, methodName, descriptor) {
    const direct = this.jvm._jreFindMethod(targetClassName, methodName, descriptor)
      || this.jvm._jreFindMethod(declaredClassName, methodName, descriptor);
    if (direct) return direct;

    // Arrays implement Object's virtual methods even though they do not have
    // ordinary class metadata to walk. Keep generated invokevirtual behavior
    // aligned with the interpreter (notably for array clone()).
    if (typeof targetClassName === "string" && targetClassName.startsWith("[")) {
      const objectMethod = this.jvm._jreFindMethod(
        "java/lang/Object", methodName, descriptor,
      );
      if (objectMethod) return objectMethod;
    }

    let currentClassName = targetClassName;
    while (currentClassName) {
      const classData = this.jvm.classes[currentClassName] || await this.jvm.loadClassByName(currentClassName);
      if (!classData || !classData.ast || !classData.ast.classes[0]) break;
      currentClassName = classData.ast.classes[0].superClassName;
      const method = this.jvm._jreFindMethod(currentClassName, methodName, descriptor);
      if (method) return method;
    }
    return null;
  }

}

function isClassConstant(arg) {
  return Array.isArray(arg) && arg[0] === 'Class' && typeof arg[1] === 'string';
}

function compareDouble(value2, value1, nanValue) {
  if (Number.isNaN(value1) || Number.isNaN(value2)) return nanValue;
  if (value1 < value2) return -1;
  if (value1 > value2) return 1;
  return 0;
}

function floatToInt(value) {
  if (Number.isNaN(value)) return 0;
  if (value >= 2147483647) return 2147483647;
  if (value <= -2147483648) return -2147483648;
  return Math.trunc(value) | 0;
}

function runtimeClassName(value) {
  if (typeof value === "string" || value instanceof String) return "java/lang/String";
  return value && (value._className || value.type);
}

function generatedRuntimeClassNameExpression(value) {
  return `(typeof ${value} === "string" || ${value} instanceof String ` +
    `? "java/lang/String" : (${value}._className || ${value}.type))`;
}

function integralMemoWidth(type) {
  switch (type) {
    case "boolean": return 1;
    case "byte": return 8;
    case "short":
    case "char": return 16;
    case "int": return 32;
    default: return 0;
  }
}

function integralMemoDescriptorWidth(descriptor) {
  switch (descriptor) {
    case "Z": return 1;
    case "B": return 8;
    case "S":
    case "C": return 16;
    case "I": return 32;
    default: return 0;
  }
}

function unsignedIntegralMemoValue(value, width) {
  const integer = Number(value) | 0;
  if (width === 1) return integer === 0 ? 0 : 1;
  if (width === 8) return integer & 0xff;
  if (width === 16) return integer & 0xffff;
  return integer >>> 0;
}

function yieldToEventLoop() {
  return new Promise((resolve) => {
    if (typeof setImmediate === "function") setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}


function getOp(instruction) {
  if (!instruction) return null;
  return typeof instruction === "string" ? instruction : instruction.op;
}

function expandWideInstruction(instruction) {
  const parts = String(instruction && instruction.arg ? instruction.arg : "")
    .trim().split(/\s+/).filter(Boolean);
  const op = parts[0];
  if (!op) return null;
  if (op === "iinc") {
    return { op, varnum: parts[1], incr: parts[2] };
  }
  return { op, arg: parts[1] };
}

function stackEffect(instruction, stackWidthsBefore = null) {
  const op = getOp(instruction);
  if (!op || op === "nop" || op === "goto" || op === "goto_w" || op === "iinc" ||
      op === "ineg" || op === "i2b" || op === "i2s" || op === "i2c" ||
      op === "i2d" || op === "i2f" || op === "i2l" || op === "l2i" ||
      op === "d2i" || op === "f2i" || op === "d2f" || op === "f2d" ||
      op === "d2l" || op === "l2d" || op === "f2l" || op === "l2f" ||
      op === "dneg" || op === "fneg" || op === "lneg" || op === "instanceof" ||
      op === "checkcast" || op === "getfield" ||
      op === "arraylength" || op === "newarray" || op === "anewarray") return 0;
  if (/^[aifdl]load(?:_[0-3])?$/.test(op) || op === "aconst_null" ||
      /^iconst_(?:m1|[0-5])$/.test(op) || /^fconst_[0-2]$/.test(op) ||
      /^dconst_[01]$/.test(op) || /^lconst_[01]$/.test(op) ||
      op === "bipush" || op === "sipush" ||
      op === "ldc" || op === "ldc_w" || op === "ldc2_w" ||
      op === "getstatic" || op === "new") return 1;
  if (/^[aifdl]store(?:_[0-3])?$/.test(op) || op === "pop" ||
      op === "putstatic" || op === "athrow" || /^[aifdl]return$/.test(op)) return -1;
  if (op === "dup") return 1;
  if (op === "dup_x1") return 1;
  if (op === "dup_x2") return 1;
  if (op === "dup2") {
    if (!stackWidthsBefore || stackWidthsBefore.length < 1) return null;
    return stackWidthsBefore[stackWidthsBefore.length - 1] === 2 ? 1 : 2;
  }
  if (op === "dup2_x2") {
    if (!stackWidthsBefore || stackWidthsBefore.length < 2) return null;
    return stackWidthsBefore[stackWidthsBefore.length - 1] === 2 ? 1 : 2;
  }
  if (op === "putfield") return -2;
  if (op.endsWith("aload") || [
    "iadd", "isub", "imul", "idiv", "irem", "ishl", "ishr", "iushr",
    "iand", "ior", "ixor", "dadd", "dsub", "dmul", "ddiv", "drem", "fadd",
    "fsub", "fmul", "fdiv", "frem", "ladd", "lsub", "land", "lor",
    "lxor", "ldiv", "lrem", "lmul", "lshl", "lshr", "lushr",
    "lcmp", "dcmpg", "dcmpl", "fcmpg", "fcmpl",
  ].includes(op)) return -1;
  if (op.endsWith("astore")) return -3;
  if (op === "monitorenter" || op === "monitorexit") return -1;
  if (op === "tableswitch" || op === "lookupswitch") return -1;
  if (op.startsWith("if_icmp") || op.startsWith("if_acmp")) return -2;
  if (["ifeq", "ifne", "iflt", "ifge", "ifgt", "ifle", "ifnull", "ifnonnull"].includes(op)) {
    return -1;
  }
  if (op && op.startsWith("invoke") && instruction && typeof instruction === "object" &&
      Array.isArray(instruction.arg) && Array.isArray(instruction.arg[2])) {
    const parsed = parseDescriptor(instruction.arg[2][1]);
    return -parsed.params.length - (op === "invokestatic" ? 0 : 1) +
      (parsed.returnType === "void" ? 0 : 1);
  }
  if (op === "return") return 0;
  return null;
}

function hasMonitorBytecode(codeItems) {
  return codeItems.some((item) => {
    const op = getOp(item && item.instruction);
    return op === "monitorenter" || op === "monitorexit";
  });
}

// An exception-table entry may spell its range with labels or raw pcs, and the
// label key differs by producer. Resolve whichever form is present.
function exceptionEntryIndex(labels, entry, lblKeys, pcKey) {
  for (const key of lblKeys) {
    const label = entry && entry[key];
    if (typeof label === "string") {
      const index = labels.get(label);
      if (Number.isInteger(index)) return index;
    }
  }
  const pc = entry && entry[pcKey];
  if (pc != null) {
    const index = labels.get(`L${pc}`);
    if (Number.isInteger(index)) return index;
  }
  return null;
}

function reachableInstructionIndexes(codeItems, exceptionTable) {
  // Forward CFG reachability from the method entry. The frontend terminates
  // each unreachable dead run with an athrow (nops ending in athrow); those
  // terminators must not count as real control flow, or a method whose only
  // athrows are dead-code terminators is wrongly classified as
  // experimental-control and barred from the JIT tiers.
  //
  // Normal flow alone does not reach a catch handler: its only predecessor is
  // the implicit exception edge out of the protected range. Walking from the
  // entry by itself therefore declares every handler body dead, which would
  // hide a real `throw` in a catch block - and, worse, the monitorexit that
  // javac plants in a synchronized method's own handler.
  const labels = buildLabelMap(codeItems);
  const reachable = new Set();
  const queue = [0];
  const handlers = [];
  for (const entry of exceptionTable || []) {
    const handler = exceptionEntryIndex(
      labels, entry, ["handlerLbl", "handlerLabel", "handler"], "handler_pc");
    if (!Number.isInteger(handler)) continue;
    handlers.push({
      handler,
      start: exceptionEntryIndex(
        labels, entry, ["startLbl", "startLabel", "start"], "start_pc"),
      end: exceptionEntryIndex(
        labels, entry, ["endLbl", "endLabel", "end"], "end_pc"),
      seeded: false,
    });
  }
  const drain = () => {
  while (queue.length > 0) {
    const index = queue.pop();
    if (!Number.isInteger(index) || index < 0 || index >= codeItems.length) continue;
    if (reachable.has(index)) continue;
    reachable.add(index);
    const instruction = codeItems[index] && codeItems[index].instruction;
    const op = getOp(instruction);
    if (!op) {
      queue.push(index + 1);
      continue;
    }
    if (op === "goto" || op === "goto_w") {
      const target = labels.get(instruction.arg);
      if (Number.isInteger(target)) queue.push(target);
    } else if (op.startsWith("if") || op.startsWith("if_") || op === "ifnull" || op === "ifnonnull") {
      const target = labels.get(instruction.arg);
      if (Number.isInteger(target)) queue.push(target);
      queue.push(index + 1);
    } else if (op === "tableswitch" || op === "lookupswitch") {
      const arg = instruction.arg;
      if (arg && typeof arg === "object") {
        if (typeof arg.defaultLabel === "string") {
          const t = labels.get(arg.defaultLabel);
          if (Number.isInteger(t)) queue.push(t);
        }
        for (const c of arg.cases || []) {
          if (c && typeof c.label === "string") {
            const t = labels.get(c.label);
            if (Number.isInteger(t)) queue.push(t);
          }
        }
      }
    } else if (op === "return" || op === "ireturn" || op === "lreturn" ||
        op === "freturn" || op === "dreturn" || op === "areturn" ||
        op === "athrow" || op === "jsr" || op === "jsr_w" || op === "ret") {
      // no fall-through
    } else {
      queue.push(index + 1);
    }
  }
  };
  drain();
  // A handler is live once anything it protects is live, and entering one can
  // make a further range live, so iterate to a fixpoint rather than seeding
  // every handler up front - dead code inside a dead try must stay dead.
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of handlers) {
      if (item.seeded) continue;
      const from = Number.isInteger(item.start) ? item.start : 0;
      const to = Number.isInteger(item.end) ? item.end : codeItems.length;
      let protectedLive = false;
      for (let index = from; index < to; index += 1) {
        if (reachable.has(index)) { protectedLive = true; break; }
      }
      if (!protectedLive) continue;
      item.seeded = true;
      changed = true;
      queue.push(item.handler);
      drain();
    }
  }
  return reachable;
}

function hasExperimentalControlFlow(codeItems, exceptionTable) {
  const reachable = reachableInstructionIndexes(codeItems, exceptionTable);
  return codeItems.some((item, index) => {
    const op = getOp(item && item.instruction);
    return (op === "athrow" || op === "monitorenter" || op === "monitorexit") &&
      reachable.has(index);
  });
}

const normalFlowInvokeCache = new WeakMap();

function normalFlowContainsInvoke(codeItems) {
  if (codeItems && typeof codeItems === "object" &&
      normalFlowInvokeCache.has(codeItems)) {
    return normalFlowInvokeCache.get(codeItems);
  }
  const result = normalFlowContains(codeItems, (_instruction, op) =>
    Boolean(op && op.startsWith("invoke")));
  if (codeItems && typeof codeItems === "object") {
    normalFlowInvokeCache.set(codeItems, result);
  }
  return result;
}

function normalFlowContains(codeItems, predicate) {
  const labels = buildLabelMap(codeItems);
  const pending = [0];
  const visited = new Set();

  while (pending.length) {
    const index = pending.pop();
    if (index < 0 || index >= codeItems.length || visited.has(index)) continue;
    visited.add(index);

    const instruction = codeItems[index] && codeItems[index].instruction;
    const op = getOp(instruction);
    if (predicate(instruction, op)) return true;

    if (op === "athrow" || op === "return" || op === "areturn" ||
      op === "dreturn" || op === "freturn" || op === "ireturn" || op === "lreturn") {
      continue;
    }
    if (op === "goto" || op === "goto_w") {
      const target = branchTargetIndex(instruction, labels);
      if (target === undefined) {
        return codeItems.some((item) => {
          const candidate = item && item.instruction;
          return predicate(candidate, getOp(candidate));
        });
      }
      pending.push(target);
      continue;
    }
    if (op && op.startsWith("if")) {
      const target = branchTargetIndex(instruction, labels);
      if (target === undefined) {
        return codeItems.some((item) => {
          const candidate = item && item.instruction;
          return predicate(candidate, getOp(candidate));
        });
      }
      pending.push(target);
    }
    // Label-only entries and ordinary instructions both fall through.
    pending.push(index + 1);
  }

  return false;
}

function branchTargetIndex(instruction, labels) {
  if (!instruction || typeof instruction !== "object") return undefined;
  const arg = Array.isArray(instruction.arg) ? instruction.arg[0] : instruction.arg;
  return labels.get(arg);
}

function bytecodeLocalSlot(instruction, op) {
  if (!op) return null;
  const compact = /_([0-3])$/.exec(op);
  if (compact) return Number(compact[1]);
  if (instruction && typeof instruction === "object") {
    const raw = op === "iinc"
      ? instruction.varnum ?? instruction.arg
      : instruction.arg;
    const slot = Number(raw);
    return Number.isSafeInteger(slot) && slot >= 0 ? slot : null;
  }
  return null;
}

function localReadBeforeWrite(codeItems, start, slot, labels) {
  const pending = [start];
  const visited = new Set();
  while (pending.length) {
    const index = pending.pop();
    if (index < 0 || index >= codeItems.length || visited.has(index)) continue;
    visited.add(index);
    const instruction = codeItems[index]?.instruction;
    const op = getOp(instruction);
    if (op && /^[aifdl]load(?:_[0-3])?$/.test(op) &&
        bytecodeLocalSlot(instruction, op) === slot) return true;
    if (op === "iinc" && bytecodeLocalSlot(instruction, op) === slot) return true;
    if (op && /^[aifdl]store(?:_[0-3])?$/.test(op) &&
        bytecodeLocalSlot(instruction, op) === slot) {
      // Every use beyond this point observes the replacement, not the entry
      // initializer, so this path is proven dead without scanning its suffix.
      continue;
    }
    if (op === "tableswitch" || op === "lookupswitch" ||
        op === "jsr" || op === "jsr_w" || op === "ret") return true;
    if (op === "athrow" || op === "return" ||
        op === "areturn" || op === "dreturn" || op === "freturn" ||
        op === "ireturn" || op === "lreturn") continue;
    if (op === "goto" || op === "goto_w") {
      const target = branchTargetIndex(instruction, labels);
      if (target === undefined) return true;
      pending.push(target);
      continue;
    }
    if (op && op.startsWith("if")) {
      const target = branchTargetIndex(instruction, labels);
      if (target === undefined) return true;
      pending.push(target);
    }
    pending.push(index + 1);
  }
  return false;
}

function stripProvenDeadEntryInitializers(codeItems, exceptionTable) {
  if (!Array.isArray(codeItems) || codeItems.length < 2 ||
      Array.isArray(exceptionTable) && exceptionTable.length > 0) return codeItems;
  const candidates = [];
  const slots = new Set();
  let end = 0;
  while (end + 1 < codeItems.length) {
    const constant = getOp(codeItems[end]?.instruction);
    const storeInstruction = codeItems[end + 1]?.instruction;
    const store = getOp(storeInstruction);
    const compatible = constant === "iconst_0" &&
        /^istore(?:_[0-3])?$/.test(store) ||
      constant === "aconst_null" && /^astore(?:_[0-3])?$/.test(store);
    if (!compatible) break;
    const slot = bytecodeLocalSlot(storeInstruction, store);
    if (slot === null || slots.has(slot)) return codeItems;
    slots.add(slot);
    candidates.push(slot);
    end += 2;
  }
  if (!candidates.length) return codeItems;
  const labels = buildLabelMap(codeItems);
  if (candidates.some((slot) =>
    localReadBeforeWrite(codeItems, end, slot, labels))) return codeItems;
  return codeItems.slice(end);
}

function normalizeIntrinsicCompilerIdioms(codeItems) {
  const ops = [];
  for (let index = 0; index < codeItems.length; index += 1) {
    const instruction = codeItems[index]?.instruction;
    const op = getOp(instruction);
    if (!op) continue;
    if (index + 6 < codeItems.length &&
        /^iload(?:_[0-3])?$/.test(op)) {
      const storeInstruction = codeItems[index + 1]?.instruction;
      const incrementInstruction = codeItems[index + 2]?.instruction;
      const staticInstruction = codeItems[index + 3]?.instruction;
      const temporaryLoad = codeItems[index + 4]?.instruction;
      const valueLoad = codeItems[index + 5]?.instruction;
      const arrayStore = codeItems[index + 6]?.instruction;
      const storeOp = getOp(storeInstruction);
      const incrementOp = getOp(incrementInstruction);
      const temporaryLoadOp = getOp(temporaryLoad);
      if (/^istore(?:_[0-3])?$/.test(storeOp) &&
          incrementOp === "iinc" &&
          getOp(staticInstruction) === "getstatic" &&
          /^iload(?:_[0-3])?$/.test(temporaryLoadOp) &&
          /^iload(?:_[0-3])?$/.test(getOp(valueLoad)) &&
          getOp(arrayStore) === "iastore") {
        const source = bytecodeLocalSlot(instruction, op);
        const temporary = bytecodeLocalSlot(storeInstruction, storeOp);
        const incremented = bytecodeLocalSlot(incrementInstruction, incrementOp);
        const loadedTemporary =
          bytecodeLocalSlot(temporaryLoad, temporaryLoadOp);
        if (source !== null && temporary !== null && temporary !== source &&
            source === incremented && temporary === loadedTemporary &&
            Number(incrementInstruction.incr ?? 0) === 1) {
          // javac lowers `array[index++] = value` from some decompiled sources
          // through a one-use temporary. Canonicalize that verified lowering
          // back to the same operand behavior used by the original classfile
          // fingerprint. Local identities and increment direction are checked;
          // owner/member names are irrelevant.
          ops.push("getstatic", "iload", "iinc", "iload", "iastore");
          index += 6;
          continue;
        }
      }
    }
    ops.push(op);
  }
  // Labeled decompiled source can leave two adjacent void exits at the end of
  // an otherwise identical region. They have the same observable behavior.
  while (ops.length > 1 && ops[ops.length - 1] === "return" &&
      ops[ops.length - 2] === "return") {
    ops.pop();
  }
  return ops;
}

function jsLiteral(value) {
  if (typeof value === "bigint") return `${value}n`;
  return JSON.stringify(value);
}

const labelMapCache = new WeakMap();

function buildLabelMap(codeItems) {
  if (codeItems && typeof codeItems === "object") {
    const cached = labelMapCache.get(codeItems);
    if (cached) return cached;
  }
  const labels = new Map();
  codeItems.forEach((item, index) => {
    if (item && item.labelDef) {
      const label = item.labelDef.endsWith(":") ? item.labelDef.slice(0, -1) : item.labelDef;
      labels.set(label, index);
    }
  });
  if (codeItems && typeof codeItems === "object") {
    labelMapCache.set(codeItems, labels);
  }
  return labels;
}

function getAsyncFunctionConstructor() {
  try {
    return Object.getPrototypeOf(async function generatedProbe() {}).constructor;
  } catch (_) {
    return null;
  }
}

JitCompiler.debugInvokeTrace = (() => {
  const raw = (typeof process !== "undefined" && process.env &&
    process.env.JVM_DEBUG_INVOKE_TRACE) || "";
  if (!raw) return null;
  return new Set(raw.split(",").map((entry) => entry.trim()).filter(Boolean));
})();

module.exports = JitCompiler;
module.exports._test = {
  bytecodeLocalSlot,
  localReadBeforeWrite,
  normalizeIntrinsicCompilerIdioms,
  stripProvenDeadEntryInitializers,
  buildLabelMap,
};
