'use strict';

const fs = require('fs');
const { firefox } = require('playwright');

const url = process.env.DEKOBLOKO_URL || 'http://127.0.0.1:3765/';
const waitMs = positiveNumber('PROBE_WAIT_MS', 65000);
const stride = positiveNumber('PROBE_SAMPLE_STRIDE', 16);
const changedFrameCount = positiveNumber('PROBE_CHANGED_FRAMES', 20);
const executablePath = process.env.FIREFOX_EXECUTABLE_PATH;
const profileJitMethods = process.env.PROBE_JIT_METHODS === '1';
const profileJitTimings = process.env.PROBE_JIT_TIMINGS === '1';
const profileSchedulerTimings = process.env.PROBE_SCHEDULER_TIMINGS === '1';
const schedulerTimingRate = Math.max(1,
  Math.round(positiveNumber('PROBE_SCHEDULER_TIMING_RATE', 1)));
const profileExclusiveTimings = process.env.PROBE_EXCLUSIVE_TIMINGS === '1';
const exclusiveTimingRoot = process.env.PROBE_EXCLUSIVE_ROOT || '';
const diagnoseStructured = process.env.PROBE_STRUCTURED_DIAGNOSTICS === '1';
const jitTimingSampleRate = positiveNumber('PROBE_JIT_TIMING_RATE', 256);
const jitTimingFilter = (process.env.PROBE_JIT_TIMING_FILTER || '').split(',')
  .map((value) => value.trim()).filter(Boolean);
const traceMethod = process.env.PROBE_TRACE_METHOD || '';
const traceOutput = process.env.PROBE_TRACE_OUTPUT || '';
const fusedRegionsOverride = process.env.PROBE_FUSED_REGIONS === undefined
  ? null : process.env.PROBE_FUSED_REGIONS === '1';
const scalarLoopsOverride = process.env.PROBE_SCALAR_LOOPS === undefined
  ? null : process.env.PROBE_SCALAR_LOOPS === '1';
const scalarSsaOverride = process.env.PROBE_SCALAR_SSA === undefined
  ? null : process.env.PROBE_SCALAR_SSA === '1';
const structuredSsaOverride = process.env.PROBE_STRUCTURED_SSA === undefined
  ? null : process.env.PROBE_STRUCTURED_SSA === '1';
const structuredSplitOverride = process.env.PROBE_STRUCTURED_SPLIT === undefined
  ? null : process.env.PROBE_STRUCTURED_SPLIT === '1';
const rendererPipelineOverride = process.env.PROBE_RENDERER_PIPELINE === undefined
  ? null : process.env.PROBE_RENDERER_PIPELINE === '1';
const handwrittenFusedOverride = process.env.PROBE_HANDWRITTEN_FUSED === undefined
  ? null : process.env.PROBE_HANDWRITTEN_FUSED === '1';
const wasmJitOverride = process.env.PROBE_WASM_JIT === undefined
  ? null : process.env.PROBE_WASM_JIT === '1';
const wasmFieldCacheOverride = process.env.PROBE_WASM_FIELD_CACHE === undefined
  ? null : process.env.PROBE_WASM_FIELD_CACHE === '1';

function positiveNumber(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function ranked(entries, limit = 15) {
  return [...(entries || [])].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function subtractEntries(finalEntries, initialEntries) {
  const initial = new Map(initialEntries || []);
  return (finalEntries || []).map(([name, count]) => [
    name, count - (initial.get(name) || 0),
  ]).filter(([, count]) => count > 0);
}

function subtractTimingEntries(finalEntries, initialEntries, sampleRate) {
  const initial = new Map(initialEntries || []);
  return (finalEntries || []).map(([method, value]) => {
    const before = initial.get(method) || { samples: 0, totalMs: 0, maxMs: 0 };
    const samples = value.samples - before.samples;
    const sampledMs = value.totalMs - before.totalMs;
    return [method, {
      tier: value.tier,
      samples,
      sampledMs,
      averageMs: samples > 0 ? sampledMs / samples : 0,
      estimatedTotalMs: sampledMs * sampleRate,
      maxMs: value.maxMs,
    }];
  }).filter(([, value]) => value.samples > 0)
    .sort((a, b) => b[1].estimatedTotalMs - a[1].estimatedTotalMs);
}

function subtractExclusiveEntries(finalEntries, initialEntries) {
  const initial = new Map(initialEntries || []);
  return (finalEntries || []).map(([method, value]) => {
    const before = initial.get(method) || { totalMs: 0, inclusiveMs: 0 };
    return [method, {
      tier: value.tier,
      exclusiveMs: value.totalMs - before.totalMs,
      inclusiveMs: value.inclusiveMs - before.inclusiveMs,
      maxExclusiveMs: value.maxMs,
    }];
  }).filter(([, value]) => value.exclusiveMs > 0 || value.inclusiveMs > 0)
    .sort((a, b) => b[1].exclusiveMs - a[1].exclusiveMs);
}

function subtractExclusiveEdges(finalEntries, initialEntries) {
  const initial = new Map(initialEntries || []);
  return (finalEntries || []).map(([key, value]) => {
    const before = initial.get(key) || { totalMs: 0 };
    return [key, {
      parent: value.parent,
      child: value.child,
      tier: value.tier,
      timeMs: value.totalMs - before.totalMs,
      maxMs: value.maxMs,
    }];
  }).filter(([, value]) => value.timeMs > 0)
    .sort((a, b) => b[1].timeMs - a[1].timeMs);
}

function animationEstimate(changes) {
  const animated = changes.filter((change) => change.nonBlack > 0);
  if (animated.length < 2) return null;
  const usedFrames = Math.min(changedFrameCount, animated.length);
  const window = animated.slice(0, usedFrames);
  const elapsedMs = window[window.length - 1].t - window[0].t;
  if (elapsedMs <= 0) return null;
  return {
    changedFrames: usedFrames,
    transitionIntervals: usedFrames - 1,
    elapsedMs,
    // Retain the convention used during the original investigation while also
    // reporting the mathematically interval-based rate below.
    changedFramesPerSecond: usedFrames * 1000 / elapsedMs,
    transitionIntervalsPerSecond: (usedFrames - 1) * 1000 / elapsedMs,
    firstHash: window[0].hash,
    lastHash: window[window.length - 1].hash,
  };
}

(async () => {
  const launchOptions = { headless: true };
  if (executablePath) launchOptions.executablePath = executablePath;
  const browser = await firefox.launch(launchOptions);
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.stack || error.message || String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await page.addInitScript(({ sampleStride, animationChangeTarget, collectJitMethods, collectJitTimings,
      collectSchedulerTimings, schedulerSampleRate, collectExclusiveTimings, exclusiveRoot,
      timingSampleRate, timingFilter, methodTraceKey,
      fusedRegions, scalarLoops, scalarSsa, structuredSsa,
      structuredSplit,
      rendererPipeline, handwrittenFused, wasmJit, wasmFieldCache }) => {
      const probe = window.__dekoblokoFrameProbe = {
        started: performance.now(),
        surfaceAt: null,
        changes: [],
        jitAtFirstNonBlack: null,
        jitAtAnimationEnd: null,
      };
      const snapshotJit = (jit) => jit ? {
        generated: jit.generatedRunCount,
        synchronous: jit.syncGeneratedRunCount,
        inlined: jit.syncInlinedCallCount,
        reusedFrames: jit.syncReusedFrameCount,
        intrinsics: jit.syncIntrinsicCallCount,
        arrayCopyNoops: jit.intrinsicArrayCopyNoopCount,
        arrayCopyWithin: jit.intrinsicArrayCopyWithinCount,
        fused: jit.fusedRunCount,
        fusedFallbacks: jit.fusedGuardedFallbackCount,
        fusedRestoredFrames: jit.fusedRestoredExceptionFrameCount,
        scalarLoops: jit.scalarLoopRunCount,
        scalarLoopSafePoints: jit.scalarLoopSafePointCount,
        scalarSsa: jit.scalarSsaRunCount,
        scalarSsaArrayViews: jit.scalarSsaArrayViewCount,
        scalarSsaEliminatedReads: jit.scalarSsaEliminatedReadCount,
        scalarSsaThreadedEdges: jit.scalarSsaThreadedEdgeCount,
        structuredSsa: jit.structuredSsa?.runCount || 0,
        structuredSsaSafePoints: jit.structuredSsa?.safePointCount || 0,
        structuredSsaCompiledLoops: jit.structuredSsa?.compiledLoopCount || 0,
        structuredSsaSplitMethods: jit.structuredSsa?.splitMethodCount || 0,
        structuredSsaSplitBlocks: jit.structuredSsa?.splitBlockCount || 0,
        structuredSsaMethods: [...(jit.structuredSsaMethodRunCounts || new Map()).entries()],
        scalarLoopMethods: [...jit.scalarLoopMethodRunCounts.entries()],
        runner: jit.runnerRunCount,
        generatedMethods: [...jit.generatedMethodRunCounts.entries()],
        inlinedMethods: [...jit.inlinedMethodRunCounts.entries()],
        intrinsicMethods: [...jit.intrinsicMethodRunCounts.entries()],
        deopts: [...jit.methodDeoptCounts.entries()],
        methodTimings: [...jit.methodTimingSamples.entries()].map(([method, value]) =>
          [method, { ...value }]),
        schedulerTimings: [...(jit.schedulerTimingSamples || new Map()).entries()].map(
          ([method, value]) => [method, { ...value }]),
        exclusiveTimings: [...(jit.exclusiveTimingSamples || new Map()).entries()].map(
          ([method, value]) => [method, { ...value }]),
        exclusiveTimingEdges: [...(jit.exclusiveTimingEdges || new Map()).entries()].map(
          ([edge, value]) => [edge, { ...value }]),
      } : null;
      const installSchedulerTimer = (jvm) => {
        const jit = jvm?.jit;
        if (!jit || jit.schedulerTimingInstalled) return;
        jit.schedulerTimingInstalled = true;
        jit.schedulerTimingSamples = new Map();
        jit.schedulerTimingSampleRate = schedulerSampleRate;
        let randomState = 0x9e3779b9;
        const methodKeys = new WeakMap();
        const methodKey = (frame) => {
          if (!frame?.method) return '<idle-or-no-frame>';
          if (methodKeys.has(frame.method)) return methodKeys.get(frame.method);
          const owner = frame.className || jvm.findClassNameForMethod(frame.method) || '<unknown>';
          const key = `${owner}.${frame.method.name}${frame.method.descriptor}`;
          methodKeys.set(frame.method, key);
          return key;
        };
        const activeFrame = () => {
          const threads = jvm.threads || [];
          if (!threads.length) return null;
          for (let offset = 0; offset < threads.length; offset += 1) {
            const index = (jvm.currentThreadIndex + offset) % threads.length;
            const thread = threads[index];
            if (thread?.status === 'runnable' && !thread.callStack?.isEmpty()) {
              return thread.callStack.peek();
            }
          }
          return null;
        };
        const tierOf = (frame) => {
          if (!frame?.method) return 'idle';
          const generated = jit.codegenCache.get(frame.method);
          return generated?.jvmStructuredSsa ? 'structured'
            : generated?.jvmScalarLoop ? 'scalar'
              : generated?.jvmSynchronous ? 'generated-sync'
                : generated ? 'generated-async' : 'interpreter-or-cold';
        };
        const originalExecuteTick = jvm.executeTick;
        jvm.executeTick = async function timedExecuteTick(...args) {
          let sampled = schedulerSampleRate === 1;
          if (!sampled) {
            randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
            sampled = randomState < 0x100000000 / schedulerSampleRate;
          }
          if (!sampled) return originalExecuteTick.apply(this, args);
          const frame = activeFrame();
          const key = methodKey(frame);
          const tier = tierOf(frame);
          const started = performance.now();
          try {
            return await originalExecuteTick.apply(this, args);
          } finally {
            const elapsedMs = performance.now() - started;
            const previous = jit.schedulerTimingSamples.get(key) || {
              tier, samples: 0, totalMs: 0, maxMs: 0,
            };
            previous.samples += 1;
            previous.totalMs += elapsedMs;
            previous.maxMs = Math.max(previous.maxMs, elapsedMs);
            previous.tier = tier;
            jit.schedulerTimingSamples.set(key, previous);
          }
        };
      };
      let previousHash = null;
      let animatedChangeCount = 0;
      const sample = (now) => {
        const jvm = window.jvmDebug?.debugController?.jvm;
        if (jvm?.jit) jvm.jit.profileMethods = collectJitMethods;
        if (jvm?.jit) {
          jvm.jit.profileTimings = collectJitTimings;
          jvm.jit.methodTimingSampleRate = timingSampleRate;
          jvm.jit.methodTimingFilter = timingFilter.length ? new Set(timingFilter) : null;
          jvm.jit.methodEntryTraceKey = methodTraceKey || null;
          jvm.jit.exclusiveTimingsEnabled = collectExclusiveTimings;
          jvm.jit.exclusiveTimingRootKey = exclusiveRoot || null;
        }
        if (collectSchedulerTimings && jvm) installSchedulerTimer(jvm);
        if (jvm?.jit && rendererPipeline !== null) {
          jvm.jit.rendererPipelineEnabled = rendererPipeline;
          jvm.jit.scalarLoopsEnabled = rendererPipeline;
          jvm.jit.scalarGuestBodiesEnabled = rendererPipeline;
          if (jvm.jit.fusedRegions) jvm.jit.fusedRegions.enabled = rendererPipeline;
          if (jvm.jit.structuredSsa) jvm.jit.structuredSsa.enabled = rendererPipeline;
        }
        if (jvm?.jit?.fusedRegions && fusedRegions !== null) {
          jvm.jit.fusedRegions.enabled = fusedRegions;
        }
        if (jvm?.jit?.fusedRegions && handwrittenFused !== null) {
          jvm.jit.fusedRegions.handwrittenKernelsEnabled = handwrittenFused;
        }
        if (jvm?.jit?.wasmJit && wasmJit !== null) {
          jvm.jit.wasmJit.enabled = wasmJit;
        }
        // affects modules compiled after the flag lands (compilation happens
        // during warmup, so a first-frame set covers the hot bodies)
        if (jvm?.jit?.wasmJit && wasmFieldCache !== null) {
          jvm.jit.wasmJit.fieldCacheEnabled = wasmFieldCache;
        }
        if (jvm?.jit && scalarLoops !== null) {
          jvm.jit.scalarLoopsEnabled = scalarLoops;
          jvm.jit.scalarGuestBodiesEnabled = scalarLoops;
        }
        if (jvm?.jit && scalarSsa !== null) {
          jvm.jit.scalarSsaOptimizationsEnabled = scalarSsa;
        }
        if (jvm?.jit?.structuredSsa && structuredSsa !== null) {
          jvm.jit.structuredSsa.enabled = structuredSsa;
        }
        if (jvm?.jit?.structuredSsa && structuredSplit !== null) {
          jvm.jit.structuredSsa.irreducibleSplittingEnabled = structuredSplit;
        }
        const pixels = [...(jvm?._softCanvases || [])][0]?._pixels;
        if (pixels) {
          if (probe.surfaceAt === null) probe.surfaceAt = now - probe.started;
          let hash = 2166136261;
          let nonBlack = 0;
          for (let index = 0; index < pixels.length; index += sampleStride) {
            const value = Number(pixels[index]) >>> 0;
            if (value & 0xffffff) nonBlack += 1;
            hash = Math.imul(hash ^ value, 16777619) >>> 0;
          }
          if (hash !== previousHash) {
            probe.changes.push({ t: now - probe.started, hash, nonBlack });
            previousHash = hash;
            if (nonBlack > 0) {
              animatedChangeCount += 1;
              if (animatedChangeCount === animationChangeTarget) {
                probe.jitAtAnimationEnd = snapshotJit(jvm?.jit);
              }
            }
          }
          if (nonBlack > 0 && probe.jitAtFirstNonBlack === null) {
            probe.jitAtFirstNonBlack = snapshotJit(jvm?.jit);
          }
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, {
      sampleStride: stride,
      animationChangeTarget: changedFrameCount,
      collectJitMethods: profileJitMethods,
      collectJitTimings: profileJitTimings,
      collectSchedulerTimings: profileSchedulerTimings,
      schedulerSampleRate: schedulerTimingRate,
      collectExclusiveTimings: profileExclusiveTimings,
      exclusiveRoot: exclusiveTimingRoot,
      timingSampleRate: jitTimingSampleRate,
      timingFilter: jitTimingFilter,
      methodTraceKey: traceMethod,
      fusedRegions: fusedRegionsOverride,
      scalarLoops: scalarLoopsOverride,
      scalarSsa: scalarSsaOverride,
      structuredSsa: structuredSsaOverride,
      structuredSplit: structuredSplitOverride,
      rendererPipeline: rendererPipelineOverride,
      handwrittenFused: handwrittenFusedOverride,
      wasmJit: wasmJitOverride,
      wasmFieldCache: wasmFieldCacheOverride,
    });

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(waitMs);
    const result = await page.evaluate(({ inspectStructured }) => {
      const jvm = window.jvmDebug?.debugController?.jvm;
      const jit = jvm?.jit;
      const structuredCompileDiagnostics = [];
      if (inspectStructured && jit?.structuredSsa) {
        for (const [className, classData] of Object.entries(jvm.classes || {})) {
          for (const item of classData?.ast?.classes?.[0]?.items || []) {
            if (item?.type !== 'method' || !item.method) continue;
            const cached = jit.codegenCache.get(item.method);
            if (!cached?.jvmScalarLoop) continue;
            const generated = jit.structuredSsa.compile(item.method);
            structuredCompileDiagnostics.push({
              methodKey: `${className}.${item.method.name}${item.method.descriptor}`,
              instructions: jit.getCodeItems(item.method).filter((codeItem) =>
                codeItem?.instruction).length,
              compiled: Boolean(generated),
              splitBlocks: generated?.jvmStructuredSplitBlocks || 0,
              rejection: jit.structuredSsa.lastRejectionReason,
              error: jit.structuredSsa.lastCompileError?.stack ||
                jit.structuredSsa.lastCompileError?.message || null,
            });
          }
        }
      }
      return {
        probe: window.__dekoblokoFrameProbe,
        status: document.getElementById('status')?.textContent || null,
        generated: jit?.generatedRunCount || 0,
        synchronous: jit?.syncGeneratedRunCount || 0,
        inlined: jit?.syncInlinedCallCount || 0,
        reusedFrames: jit?.syncReusedFrameCount || 0,
        intrinsics: jit?.syncIntrinsicCallCount || 0,
        arrayCopyNoops: jit?.intrinsicArrayCopyNoopCount || 0,
        arrayCopyWithin: jit?.intrinsicArrayCopyWithinCount || 0,
        fused: jit?.fusedRunCount || 0,
        fusedFallbacks: jit?.fusedGuardedFallbackCount || 0,
        fusedRestoredFrames: jit?.fusedRestoredExceptionFrameCount || 0,
        scalarLoops: jit?.scalarLoopRunCount || 0,
        scalarLoopSafePoints: jit?.scalarLoopSafePointCount || 0,
        scalarSsa: jit?.scalarSsaRunCount || 0,
        scalarSsaArrayViews: jit?.scalarSsaArrayViewCount || 0,
        scalarSsaEliminatedReads: jit?.scalarSsaEliminatedReadCount || 0,
        scalarSsaThreadedEdges: jit?.scalarSsaThreadedEdgeCount || 0,
        structuredSsa: jit?.structuredSsa?.runCount || 0,
        structuredSsaSafePoints: jit?.structuredSsa?.safePointCount || 0,
        structuredSsaCompiledLoops: jit?.structuredSsa?.compiledLoopCount || 0,
        structuredSsaSplitMethods: jit?.structuredSsa?.splitMethodCount || 0,
        structuredSsaSplitBlocks: jit?.structuredSsa?.splitBlockCount || 0,
        structuredSsaLastRejection: jit?.structuredSsa?.lastRejectionReason || null,
        structuredSsaLastCompileError: jit?.structuredSsa?.lastCompileError?.stack ||
          jit?.structuredSsa?.lastCompileError?.message || null,
        structuredCompileDiagnostics,
        structuredSsaMethods: jit ? [...jit.structuredSsaMethodRunCounts.entries()] : [],
        scalarLoopMethods: jit ? [...jit.scalarLoopMethodRunCounts.entries()] : [],
        runner: jit?.runnerRunCount || 0,
        presentation: jvm?._awtPresentationStats || null,
        generatedMethods: jit ? [...jit.generatedMethodRunCounts.entries()] : [],
        inlinedMethods: jit ? [...jit.inlinedMethodRunCounts.entries()] : [],
        intrinsicMethods: jit ? [...jit.intrinsicMethodRunCounts.entries()] : [],
        deopts: jit ? [...jit.methodDeoptCounts.entries()] : [],
        deoptReasons: jit ? [...jit.methodDeoptReasons.entries()] : [],
        methodTimings: jit ? [...jit.methodTimingSamples.entries()].map(([method, value]) =>
          [method, { ...value }]) : [],
        schedulerTimings: jit ? [...(jit.schedulerTimingSamples || new Map()).entries()].map(
          ([method, value]) => [method, { ...value }]) : [],
        exclusiveTimings: jit ? [...(jit.exclusiveTimingSamples || new Map()).entries()].map(
          ([method, value]) => [method, { ...value }]) : [],
        exclusiveTimingEdges: jit ? [...(jit.exclusiveTimingEdges || new Map()).entries()].map(
          ([edge, value]) => [edge, { ...value }]) : [],
        methodEntryTrace: jit?.methodEntryTrace || null,
      };
    }, { inspectStructured: diagnoseStructured });

    result.url = url;
    result.pageErrors = pageErrors;
    result.consoleErrors = consoleErrors;
    result.waitMs = waitMs;
    result.sampleStride = stride;
    result.profileJitMethods = profileJitMethods;
    result.profileJitTimings = profileJitTimings;
    result.profileSchedulerTimings = profileSchedulerTimings;
    result.schedulerTimingRate = schedulerTimingRate;
    result.profileExclusiveTimings = profileExclusiveTimings;
    result.exclusiveTimingRoot = exclusiveTimingRoot || null;
    result.jitTimingSampleRate = jitTimingSampleRate;
    result.jitTimingFilter = jitTimingFilter;
    result.traceMethod = traceMethod || null;
    result.fusedRegions = fusedRegionsOverride;
    result.scalarLoopsEnabled = scalarLoopsOverride;
    result.scalarSsaEnabled = scalarSsaOverride;
    result.structuredSsaEnabled = structuredSsaOverride;
    result.structuredSplitEnabled = structuredSplitOverride;
    result.rendererPipelineEnabled = rendererPipelineOverride;
    result.wasmJitEnabled = wasmJitOverride;
    result.wasmFieldCacheEnabled = wasmFieldCacheOverride;
    result.animation = animationEstimate(result.probe.changes);
    const initial = result.probe.jitAtFirstNonBlack;
    const animationEnd = result.probe.jitAtAnimationEnd;
    if (initial && profileJitTimings) {
      result.animationMethodTimings = subtractTimingEntries(
        animationEnd?.methodTimings || result.methodTimings,
        initial.methodTimings, jitTimingSampleRate,
      );
    }
    if (initial && profileSchedulerTimings && result.animation) {
      const timings = subtractTimingEntries(
        animationEnd?.schedulerTimings || result.schedulerTimings,
        initial.schedulerTimings, schedulerTimingRate,
      );
      const measuredJvmMs = timings.reduce((sum, [, value]) =>
        sum + value.estimatedTotalMs, 0);
      result.animationSchedulerTiming = {
        windowMs: result.animation.elapsedMs,
        measuredJvmMs,
        measuredJvmPercent: measuredJvmMs * 100 / result.animation.elapsedMs,
        outsideMeasuredJvmMs: Math.max(0, result.animation.elapsedMs - measuredJvmMs),
        methods: timings.slice(0, 30).map(([method, value]) => [method, {
          ...value,
          percentOfWindow: value.estimatedTotalMs * 100 / result.animation.elapsedMs,
          percentOfMeasuredJvm: measuredJvmMs > 0
            ? value.estimatedTotalMs * 100 / measuredJvmMs : 0,
        }]),
      };
    }
    if (initial && profileExclusiveTimings && result.animation) {
      const timings = subtractExclusiveEntries(
        animationEnd?.exclusiveTimings || result.exclusiveTimings,
        initial.exclusiveTimings,
      );
      const attributedMs = timings.reduce((sum, [, value]) =>
        sum + value.exclusiveMs, 0);
      const root = timings.find(([method]) => method === exclusiveTimingRoot);
      const rootInclusiveMs = root?.[1].inclusiveMs || attributedMs;
      const edges = subtractExclusiveEdges(
        animationEnd?.exclusiveTimingEdges || result.exclusiveTimingEdges,
        initial.exclusiveTimingEdges,
      );
      result.animationExclusiveTiming = {
        root: exclusiveTimingRoot || null,
        rootInclusiveMs,
        attributedMs,
        percentOfWindow: attributedMs * 100 / result.animation.elapsedMs,
        methods: timings.slice(0, 40).map(([method, value]) => [method, {
          ...value,
          percentOfRoot: rootInclusiveMs > 0
            ? value.exclusiveMs * 100 / rootInclusiveMs : 0,
          millisecondsPerChangedImage: value.exclusiveMs /
            result.animation.changedFrames,
        }]),
        edges: edges.slice(0, 60).map(([, value]) => ({
          ...value,
          percentOfRoot: rootInclusiveMs > 0
            ? value.timeMs * 100 / rootInclusiveMs : 0,
          millisecondsPerChangedImage: value.timeMs /
            result.animation.changedFrames,
        })),
      };
    }
    if (initial && profileJitMethods) {
      const finish = animationEnd || result;
      result.animationJit = {
        generated: finish.generated - initial.generated,
        synchronous: finish.synchronous - initial.synchronous,
        inlined: finish.inlined - initial.inlined,
        reusedFrames: finish.reusedFrames - initial.reusedFrames,
        intrinsics: finish.intrinsics - initial.intrinsics,
        arrayCopyNoops: finish.arrayCopyNoops - initial.arrayCopyNoops,
        arrayCopyWithin: finish.arrayCopyWithin - initial.arrayCopyWithin,
        fused: finish.fused - initial.fused,
        fusedFallbacks: finish.fusedFallbacks - initial.fusedFallbacks,
        fusedRestoredFrames: finish.fusedRestoredFrames - initial.fusedRestoredFrames,
        scalarLoops: finish.scalarLoops - initial.scalarLoops,
        scalarLoopSafePoints: finish.scalarLoopSafePoints - initial.scalarLoopSafePoints,
        scalarSsa: finish.scalarSsa - initial.scalarSsa,
        structuredSsa: finish.structuredSsa - initial.structuredSsa,
        structuredSsaSafePoints: finish.structuredSsaSafePoints - initial.structuredSsaSafePoints,
        structuredSsaMethods: ranked(subtractEntries(
          finish.structuredSsaMethods, initial.structuredSsaMethods,
        )),
        scalarLoopMethods: ranked(subtractEntries(
          finish.scalarLoopMethods, initial.scalarLoopMethods,
        )),
        runner: finish.runner - initial.runner,
        generatedMethods: ranked(subtractEntries(
          finish.generatedMethods, initial.generatedMethods,
        )),
        inlinedMethods: ranked(subtractEntries(
          finish.inlinedMethods, initial.inlinedMethods,
        )),
        intrinsicMethods: ranked(subtractEntries(
          finish.intrinsicMethods, initial.intrinsicMethods,
        )),
        deopts: ranked(subtractEntries(finish.deopts, initial.deopts)),
      };
    }
    delete result.probe.jitAtFirstNonBlack;
    result.generatedMethods = ranked(result.generatedMethods);
    result.inlinedMethods = ranked(result.inlinedMethods);
    result.intrinsicMethods = ranked(result.intrinsicMethods);
    result.scalarLoopMethods = ranked(result.scalarLoopMethods);
    result.structuredSsaMethods = ranked(result.structuredSsaMethods);
    result.deopts = ranked(result.deopts);
    if (traceOutput && result.methodEntryTrace?.state) {
      fs.writeFileSync(traceOutput, JSON.stringify(result.methodEntryTrace, null, 2));
      result.methodEntryTrace = {
        methodKey: result.methodEntryTrace.methodKey,
        capturedAt: result.methodEntryTrace.capturedAt,
        output: traceOutput,
        bytes: fs.statSync(traceOutput).size,
      };
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
