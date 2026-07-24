'use strict';

(async () => {
  const config = window.__BROWSER_CEILING_CONFIG__ || {};
  const query = new URLSearchParams(window.location.search);
  const wasmHeapEnabled = query.get('wasmHeap') !== '0';
  const preferWholeMethodJs = query.get('preferJs') !== '0';
  const summary = document.getElementById('summary');
  const resultNode = document.getElementById('result');
  const phasesNode = document.getElementById('phases');
  const canvas = document.getElementById('surface');
  const context = canvas.getContext('2d', { alpha: false });
  const image = context.createImageData(canvas.width, canvas.height);
  const pixels = new Uint32Array(image.data.buffer);
  const startedAt = performance.now();
  const session = 'ceiling-' + Date.now().toString(36) + '-' +
    Math.random().toString(36).slice(2, 10);
  const phaseNodes = new Map();

  const browserState = () => ({
    userAgent: navigator.userAgent,
    visibilityState: document.visibilityState,
    hidden: document.hidden,
    hasFocus: document.hasFocus(),
    hardwareConcurrency: Number(navigator.hardwareConcurrency || 0),
    deviceMemoryGiB: Number(navigator.deviceMemory || 0),
    viewport: { width: innerWidth, height: innerHeight },
  });

  const telemetry = (event, details) => fetch('/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session,
      event,
      elapsedMs: Math.round(performance.now() - startedAt),
      details: details || {},
    }),
    keepalive: true,
  }).catch(() => {});

  const setPhase = (name, state, detail = '') => {
    let node = phaseNodes.get(name);
    if (!node) {
      node = document.createElement('li');
      phasesNode.appendChild(node);
      phaseNodes.set(name, node);
    }
    node.className = state;
    node.textContent = name + (detail ? ': ' + detail : '');
    telemetry('ceiling_phase', { name, state, detail });
  };

  const waitAnimationFrames = (count) => new Promise((resolve) => {
    let seen = 0;
    const tick = () => {
      seen += 1;
      if (seen >= count) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const runTight = async (name, durationMs, operation) => {
    setPhase(name, 'running');
    await waitAnimationFrames(2);
    const started = performance.now();
    let iterations = 0;
    let now = started;
    do {
      operation(iterations);
      iterations += 1;
      if ((iterations & 7) === 0) now = performance.now();
    } while (now - started < durationMs);
    const elapsedMs = performance.now() - started;
    const value = {
      iterations,
      elapsedMs,
      iterationsPerSecond: iterations * 1000 / elapsedMs,
      msPerIteration: elapsedMs / iterations,
    };
    setPhase(name, 'complete',
      value.iterationsPerSecond.toFixed(1) + '/s');
    telemetry('ceiling_phase_result', { name, ...value });
    return value;
  };

  const runAnimation = async (name, durationMs, operation) => {
    setPhase(name, 'running');
    await waitAnimationFrames(5);
    let frames = 0;
    let operationMs = 0;
    let first = null;
    let last = null;
    await new Promise((resolve) => {
      const tick = (now) => {
        if (first === null) first = now;
        const operationStarted = performance.now();
        operation(frames);
        operationMs += performance.now() - operationStarted;
        frames += 1;
        last = now;
        if (now - first >= durationMs) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const elapsedMs = last - first;
    const value = {
      frames,
      elapsedMs,
      framesPerSecond: (frames - 1) * 1000 / elapsedMs,
      operationMsPerFrame: operationMs / frames,
    };
    setPhase(name, 'complete', value.framesPerSecond.toFixed(1) + ' FPS');
    telemetry('ceiling_phase_result', { name, ...value });
    return value;
  };

  const raster = (frame) => {
    let red = Math.imul(frame, 1234567);
    let green = Math.imul(frame, 7654321);
    let blue = Math.imul(frame, 334455);
    for (let y = 0, index = 0; y < 600; y += 1) {
      let rowRed = red;
      let rowGreen = green;
      let rowBlue = blue;
      for (let x = 0; x < 800; x += 1, index += 1) {
        const old = pixels[index] | 0;
        pixels[index] = (((old >> 1) & 8355711) +
          ((rowGreen >> 9) & 65280) +
          ((rowRed >> 1) & 16711680) +
          ((rowBlue >> 17) & 255)) >>> 0;
        rowRed = (rowRed + 3171) | 0;
        rowGreen = (rowGreen + 911) | 0;
        rowBlue = (rowBlue + 1777) | 0;
      }
      red = (red + 991) | 0;
      green = (green + 313) | 0;
      blue = (blue + 271) | 0;
    }
  };

  const upload = () => context.putImageData(image, 0, 0);
  const phaseRate = (frames, nanos) => {
    const elapsedMs = Number(nanos) / 1e6;
    return {
      frames,
      elapsedMs,
      framesPerSecond: elapsedMs > 0 ? frames * 1000 / elapsedMs : null,
      msPerFrame: frames > 0 ? elapsedMs / frames : null,
    };
  };
  const javaArrayNumbers = (array) => {
    if (!array) return [];
    const data = array.elements || array;
    return Array.from(data, (entry) => Number(entry));
  };
  const sourceCount = (source, fragment) =>
    source ? source.split(fragment).length - 1 : 0;

  const runJvmAwt = async () => {
    const name = 'Generated Java + browser JVM AWT';
    setPhase(name, 'running', 'loading 800×600 fixture');
    const response = await fetch(config.awtJarUrl);
    if (!response.ok) throw new Error('AWT fixture request failed: ' + response.status);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const file = new File([bytes], 'browser-awt-ceiling.jar', {
      type: 'application/java-archive',
    });
    const debug = new JVMDebug.BrowserJVMDebug();
    window.jvmCeilingDebug = debug;
    debug.debugController.options.jit = {
      ...(debug.debugController.options.jit || {}),
      profileMethods: false,
      preferWholeMethodJs,
      rendererPipeline: true,
      scalarLoops: true,
      scalarGuestBodies: true,
      scalarSsaOptimizations: false,
      fusedRegions: true,
      structuredSsa: true,
      structuredDeferredCallMaterialization: true,
    };
    debug.debugController.options.wasmHeap = wasmHeapEnabled;
    await debug.initialize();
    await debug.loadFile(file);
    let runError = null;
    let runFinished = false;
    debug.run('BrowserAwtCeiling').then(
      () => { runFinished = true; },
      (error) => {
        runFinished = true;
        runError = error;
      },
    );
    const deadline = performance.now() + 120000;
    let fields = null;
    while (performance.now() < deadline) {
      fields = debug.debugController.jvm.classes.BrowserAwtCeiling?.staticFields;
      if (runError || fields?.get('done:I') === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (runError) throw runError;
    if (!fields || fields.get('done:I') !== 1) {
      throw new Error('800×600 browser JVM AWT benchmark timed out');
    }
    await waitAnimationFrames(2);
    const jvm = debug.debugController.jvm;
    const value = (field, descriptor) => fields.get(field + ':' + descriptor);
    const rasterMethod = jvm.findMethod(
      { ast: jvm.classes.BrowserAwtCeiling.ast }, 'raster', '(I)V',
    );
    const rasterKey = 'BrowserAwtCeiling.raster(I)V';
    const generatedRaster = jvm.jit.codegenCache.get(rasterMethod);
    const fastRaster = generatedRaster?.jvmFastBody || generatedRaster;
    const rasterSource = fastRaster?.jvmStructuredSource || '';
    const benchmark = {
      rasterOnly: phaseRate(
        value('rasterFrames', 'I') | 0, value('rasterNanos', 'J')),
      rasterFrameMicros:
        javaArrayNumbers(value('rasterFrameMicros', '[I')),
      awtPublishOnly: phaseRate(
        value('publishFrames', 'I') | 0, value('publishNanos', 'J')),
      rasterAndAwt: phaseRate(
        value('fullFrames', 'I') | 0, value('fullNanos', 'J')),
      fullFrameMicros:
        javaArrayNumbers(value('fullFrameMicros', '[I')),
      checksum: value('checksum', 'I') | 0,
      phase: value('phase', 'I') | 0,
      runFinished,
      presentation: { ...(jvm._awtPresentationStats || {}) },
      rasterJit: {
        wasmHeap: Boolean(jvm.wasmHeap),
        methodProfiling: jvm.jit.profileMethods,
        supported: jvm.jit.isSupported(rasterMethod),
        codegenSupported: jvm.jit.isCodegenSupported(rasterMethod),
        invocations: jvm.jit.invocationCounts.get(rasterMethod) || 0,
        generatedRuns: jvm.jit.generatedMethodRunCounts.get(rasterKey) || 0,
        runnerRuns: jvm.jit.runnerMethodRunCounts.get(rasterKey) || 0,
        deoptimizations: jvm.jit.methodDeoptCounts.get(rasterKey) || 0,
        deoptReason: jvm.jit.methodDeoptReasons.get(rasterKey) || null,
        tier: generatedRaster?.jvmStructuredSsa ? 'structured-ssa' :
          generatedRaster?.jvmScalarLoop ? 'scalar-loop' :
            generatedRaster?.jvmSynchronous ? 'synchronous-generated' :
              generatedRaster ? 'generated' : 'none',
        scalarLoopRuns: jvm.jit.scalarLoopMethodRunCounts.get(rasterKey) || 0,
        structuredSsaRuns:
          jvm.jit.structuredSsaMethodRunCounts.get(rasterKey) || 0,
        structuredSafePoints: jvm.jit.structuredSsa.safePointCount,
        scalarSafePoints: jvm.jit.scalarLoopSafePointCount,
        structuredContinuations:
          fastRaster?.jvmStructuredContinuation === true,
        sourceMetrics: {
          bytes: rasterSource.length,
          getFieldAtSites: sourceCount(rasterSource, 'helpers.getFieldAt('),
          arrayLoadSlowSites: sourceCount(rasterSource, 'helpers.arrayLoad('),
          arrayStoreSlowSites: sourceCount(rasterSource, 'helpers.arrayStore('),
          elementsSelections: sourceCount(rasterSource, '.elements ?'),
          safePointSites:
            sourceCount(rasterSource, 'continueStructuredQuantum('),
          spillCalls: sourceCount(rasterSource, 'spillLocals();'),
          declaredLocals: fastRaster?.jvmStructuredDeclaredLocalCount || 0,
          spilledLocals: fastRaster?.jvmStructuredSpilledLocalCount || 0,
          reusedLocalLoads:
            fastRaster?.jvmStructuredReusedLocalLoadCount || 0,
          eliminatedLocalStores:
            fastRaster?.jvmStructuredEliminatedLocalStoreCount || 0,
          sentinelArrayLoads:
            fastRaster?.jvmStructuredSentinelArrayLoadCount || 0,
          eliminatedArrayStoreChecks:
            fastRaster?.jvmStructuredEliminatedArrayStoreCheckCount || 0,
          coarseCountedLoops:
            fastRaster?.jvmStructuredCoarseCountedLoopCount || 0,
          atomicBoundedLoops:
            fastRaster?.jvmStructuredAtomicBoundedLoops === true,
          boundedIterationProduct:
            fastRaster?.jvmStructuredBoundedIterationProduct || 0,
          fieldReadCaches:
            fastRaster?.jvmStructuredFieldReadCacheCount || 0,
          eagerThisFields:
            fastRaster?.jvmStructuredEagerThisFieldCount || 0,
        },
      },
    };
    setPhase(name, 'complete',
      benchmark.rasterAndAwt.framesPerSecond.toFixed(1) + ' full frames/s');
    telemetry('ceiling_phase_result', { name, ...benchmark });
    return benchmark;
  };

  telemetry('ceiling_start', {
    schema: 1,
    runtime: config.runtime,
    browser: browserState(),
    surface: { width: canvas.width, height: canvas.height },
  });
  try {
    const results = {};
    results.animationOnly = await runAnimation(
      'Animation clock', 1500, () => {});
    results.javascriptRaster = await runTight(
      'JavaScript 800×600 raster', 1200, raster);
    results.canvasUpload = await runTight(
      'Canvas 800×600 upload', 1200, (frame) => {
        pixels[frame % pixels.length] ^= 0x00ffffff;
        upload();
      });
    results.javascriptRasterAndUpload = await runTight(
      'JavaScript raster + canvas upload', 1500, (frame) => {
        raster(frame);
        upload();
      });
    results.pacedRasterAndUpload = await runAnimation(
      'Paced raster + canvas upload', 2000, (frame) => {
        raster(frame);
        upload();
      });
    results.jvmAwt = await runJvmAwt();
    const finalResult = {
      schema: 1,
      runtime: config.runtime,
      browser: browserState(),
      surface: { width: canvas.width, height: canvas.height },
      elapsedMs: performance.now() - startedAt,
      results,
    };
    window.__browserCeilingResult = finalResult;
    resultNode.textContent = JSON.stringify(finalResult, null, 2);
    summary.textContent = 'Diagnostics complete. Results were sent automatically.';
    telemetry('ceiling_complete', finalResult);
  } catch (error) {
    const failure = {
      message: String(error && (error.stack || error.message) || error),
      browser: browserState(),
      runtime: config.runtime,
    };
    window.__browserCeilingFailure = failure;
    resultNode.textContent = JSON.stringify(failure, null, 2);
    summary.textContent = 'Diagnostics failed. The failure report was sent automatically.';
    setPhase('Benchmark', 'failed', failure.message);
    telemetry('ceiling_failed', failure);
  }
})();
