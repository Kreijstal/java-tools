'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { firefox } = require('playwright');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'benchmarks', 'AwtHotLoop.java');
const bundle = path.join(root, 'dist', 'jvm-debug.js');
const executablePath = process.env.FIREFOX_EXECUTABLE_PATH;
const timeoutMs = Number(process.env.AWT_BENCHMARK_TIMEOUT_MS || 90000);

function compileFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-awt-hotloop-'));
  execFileSync('javac', ['-source', '8', '-target', '8', '-d', directory, source], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const jar = path.join(directory, 'awt-hotloop.jar');
  execFileSync('jar', ['cf', jar, '-C', directory, 'AwtHotLoop.class']);
  return { directory, jar };
}

function phase(frames, nanos) {
  const seconds = Number(nanos) / 1e9;
  return {
    frames,
    elapsedMs: Number(nanos) / 1e6,
    framesPerSecond: seconds > 0 ? frames / seconds : null,
  };
}

(async () => {
  if (!fs.existsSync(bundle)) {
    throw new Error('dist/jvm-debug.js is missing; run npm run build:bundle first');
  }
  const fixture = compileFixture();
  const launchOptions = { headless: true };
  if (executablePath) launchOptions.executablePath = executablePath;
  let browser;
  try {
    browser = await firefox.launch(launchOptions);
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const browserErrors = [];
    page.on('pageerror', (error) => browserErrors.push(error.stack || error.message));
    await page.setContent('<div id="awt-container"></div>');
    await page.addScriptTag({ path: bundle });
    const jarBase64 = fs.readFileSync(fixture.jar).toString('base64');
    const started = Date.now();
    await page.evaluate(async (encoded) => {
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      const file = new File([bytes], 'awt-hotloop.jar', { type: 'application/java-archive' });
      const debug = new JVMDebug.BrowserJVMDebug();
      window.jvmDebug = debug;
      await debug.initialize();
      await debug.loadFile(file);
      window.__awtHotLoopRun = { state: 'running' };
      debug.run('AwtHotLoop').then(
        () => { window.__awtHotLoopRun = { state: 'completed' }; },
        (error) => {
          window.__awtHotLoopRun = {
            state: 'failed',
            error: error && (error.stack || error.message || String(error)),
          };
        },
      );
    }, jarBase64);
    try {
      await page.waitForFunction(() => {
        const state = window.__awtHotLoopRun && window.__awtHotLoopRun.state;
        const fields = window.jvmDebug?.debugController?.jvm?.classes?.AwtHotLoop?.staticFields;
        return state === 'failed' || state === 'completed' || fields?.get('done:I') === 1;
      }, null, { timeout: timeoutMs });
    } catch (error) {
      const progress = await page.evaluate(() => {
        const jvm = window.jvmDebug?.debugController?.jvm;
        const fields = jvm?.classes?.AwtHotLoop?.staticFields;
        const value = (name, descriptor) => fields?.get(`${name}:${descriptor}`);
        return {
          run: window.__awtHotLoopRun,
          phase: value('phase', 'I') | 0,
          rasterFrames: value('rasterFrames', 'I') | 0,
          publishFrames: value('publishFrames', 'I') | 0,
          pacedFrames: value('pacedFrames', 'I') | 0,
          presentFrames: value('presentFrames', 'I') | 0,
          presentation: jvm?._awtPresentationStats || null,
        };
      });
      throw new Error(`${error.message}; progress=${JSON.stringify(progress)}`);
    }
    const raw = await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const jvm = window.jvmDebug.debugController.jvm;
      const fields = jvm.classes.AwtHotLoop.staticFields;
      const value = (name, descriptor) => fields.get(`${name}:${descriptor}`);
      return {
        rasterNanos: Number(value('rasterNanos', 'J')),
        publishNanos: Number(value('publishNanos', 'J')),
        pacedNanos: Number(value('pacedNanos', 'J')),
        presentNanos: Number(value('presentNanos', 'J')),
        rasterFrames: value('rasterFrames', 'I') | 0,
        publishFrames: value('publishFrames', 'I') | 0,
        pacedFrames: value('pacedFrames', 'I') | 0,
        presentFrames: value('presentFrames', 'I') | 0,
        checksum: value('checksum', 'I') | 0,
        phase: value('phase', 'I') | 0,
        done: value('done', 'I') | 0,
        run: window.__awtHotLoopRun,
        presentation: jvm._awtPresentationStats || null,
        canvas: [...document.querySelectorAll('canvas')].map((item) => ({
          width: item.width,
          height: item.height,
        })),
      };
    });
    const result = {
      browser: await page.evaluate(() => navigator.userAgent),
      wallTimeMs: Date.now() - started,
      rasterOnly: phase(raw.rasterFrames, raw.rasterNanos),
      rasterAndAwtPublish: phase(raw.publishFrames, raw.publishNanos),
      schedulerPaced: phase(raw.pacedFrames, raw.pacedNanos),
      awtPresentedWithoutRaster: phase(raw.presentFrames, raw.presentNanos),
      presentation: raw.presentation,
      checksum: raw.checksum,
      phase: raw.phase,
      done: raw.done,
      run: raw.run,
      surface: raw.canvas[0] || null,
      canvas: raw.canvas,
      browserErrors,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!raw.done || browserErrors.length) process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
