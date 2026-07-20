'use strict';

const { firefox } = require('playwright');

const url = process.env.DEKOBLOKO_URL || 'http://127.0.0.1:3765/';
const waitMs = positiveNumber('PROBE_WAIT_MS', 65000);
const stride = positiveNumber('PROBE_SAMPLE_STRIDE', 16);
const changedFrameCount = positiveNumber('PROBE_CHANGED_FRAMES', 20);
const executablePath = process.env.FIREFOX_EXECUTABLE_PATH;
const profileJitMethods = process.env.PROBE_JIT_METHODS === '1';

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
    await page.addInitScript(({ sampleStride, collectJitMethods }) => {
      const probe = window.__dekoblokoFrameProbe = {
        started: performance.now(),
        surfaceAt: null,
        changes: [],
        jitAtFirstNonBlack: null,
      };
      const snapshotJit = (jit) => jit ? {
        generated: jit.generatedRunCount,
        synchronous: jit.syncGeneratedRunCount,
        inlined: jit.syncInlinedCallCount,
        reusedFrames: jit.syncReusedFrameCount,
        intrinsics: jit.syncIntrinsicCallCount,
        arrayCopyNoops: jit.intrinsicArrayCopyNoopCount,
        arrayCopyWithin: jit.intrinsicArrayCopyWithinCount,
        runner: jit.runnerRunCount,
        generatedMethods: [...jit.generatedMethodRunCounts.entries()],
        inlinedMethods: [...jit.inlinedMethodRunCounts.entries()],
        intrinsicMethods: [...jit.intrinsicMethodRunCounts.entries()],
        deopts: [...jit.methodDeoptCounts.entries()],
      } : null;
      let previousHash = null;
      const sample = (now) => {
        const jvm = window.jvmDebug?.debugController?.jvm;
        if (jvm?.jit) jvm.jit.profileMethods = collectJitMethods;
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
          }
          if (nonBlack > 0 && probe.jitAtFirstNonBlack === null) {
            probe.jitAtFirstNonBlack = snapshotJit(jvm?.jit);
          }
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, { sampleStride: stride, collectJitMethods: profileJitMethods });

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(waitMs);
    const result = await page.evaluate(() => {
      const jvm = window.jvmDebug?.debugController?.jvm;
      const jit = jvm?.jit;
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
        runner: jit?.runnerRunCount || 0,
        presentation: jvm?._awtPresentationStats || null,
        generatedMethods: jit ? [...jit.generatedMethodRunCounts.entries()] : [],
        inlinedMethods: jit ? [...jit.inlinedMethodRunCounts.entries()] : [],
        intrinsicMethods: jit ? [...jit.intrinsicMethodRunCounts.entries()] : [],
        deopts: jit ? [...jit.methodDeoptCounts.entries()] : [],
        deoptReasons: jit ? [...jit.methodDeoptReasons.entries()] : [],
      };
    });

    result.url = url;
    result.waitMs = waitMs;
    result.sampleStride = stride;
    result.profileJitMethods = profileJitMethods;
    result.animation = animationEstimate(result.probe.changes);
    const initial = result.probe.jitAtFirstNonBlack;
    if (initial && profileJitMethods) {
      result.animationJit = {
        generated: result.generated - initial.generated,
        synchronous: result.synchronous - initial.synchronous,
        inlined: result.inlined - initial.inlined,
        reusedFrames: result.reusedFrames - initial.reusedFrames,
        intrinsics: result.intrinsics - initial.intrinsics,
        arrayCopyNoops: result.arrayCopyNoops - initial.arrayCopyNoops,
        arrayCopyWithin: result.arrayCopyWithin - initial.arrayCopyWithin,
        runner: result.runner - initial.runner,
        generatedMethods: ranked(subtractEntries(
          result.generatedMethods, initial.generatedMethods,
        )),
        inlinedMethods: ranked(subtractEntries(
          result.inlinedMethods, initial.inlinedMethods,
        )),
        intrinsicMethods: ranked(subtractEntries(
          result.intrinsicMethods, initial.intrinsicMethods,
        )),
        deopts: ranked(subtractEntries(result.deopts, initial.deopts)),
      };
    }
    delete result.probe.jitAtFirstNonBlack;
    result.generatedMethods = ranked(result.generatedMethods);
    result.inlinedMethods = ranked(result.inlinedMethods);
    result.intrinsicMethods = ranked(result.intrinsicMethods);
    result.deopts = ranked(result.deopts);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
