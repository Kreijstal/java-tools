'use strict';

const { firefox } = require('playwright');

const url = process.env.DEKOBLOKO_URL || 'http://127.0.0.1:3765/';
const waitMs = positiveNumber('PROBE_WAIT_MS', 65000);
const stride = positiveNumber('PROBE_SAMPLE_STRIDE', 16);
const changedFrameCount = positiveNumber('PROBE_CHANGED_FRAMES', 20);
const executablePath = process.env.FIREFOX_EXECUTABLE_PATH;

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
    await page.addInitScript((sampleStride) => {
      const probe = window.__dekoblokoFrameProbe = {
        started: performance.now(),
        surfaceAt: null,
        changes: [],
      };
      let previousHash = null;
      const sample = (now) => {
        const jvm = window.jvmDebug?.debugController?.jvm;
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
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, stride);

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
        runner: jit?.runnerRunCount || 0,
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
    result.animation = animationEstimate(result.probe.changes);
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
