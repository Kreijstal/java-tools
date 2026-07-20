'use strict';

const { firefox } = require('playwright');

const executablePath = process.env.FIREFOX_EXECUTABLE_PATH;
const durationMs = Number(process.env.CANVAS_BENCHMARK_MS || 4000);

(async () => {
  const launchOptions = { headless: true };
  if (executablePath) launchOptions.executablePath = executablePath;
  const browser = await firefox.launch(launchOptions);
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.setContent('<canvas id="surface" width="800" height="600"></canvas>');
    const result = await page.evaluate(async (testDuration) => {
      const canvas = document.getElementById('surface');
      const context = canvas.getContext('2d', { alpha: false });
      const image = context.createImageData(800, 600);
      const pixels = new Uint32Array(image.data.buffer);

      const waitFrames = (count) => new Promise((resolve) => {
        let seen = 0;
        const wait = () => {
          seen += 1;
          if (seen >= count) resolve();
          else requestAnimationFrame(wait);
        };
        requestAnimationFrame(wait);
      });

      const rafTest = async (name, render) => {
        await waitFrames(10);
        let frames = 0;
        let renderMs = 0;
        let first = null;
        let last = null;
        await new Promise((resolve) => {
          const tick = (now) => {
            if (first === null) first = now;
            const renderStart = performance.now();
            render(frames);
            renderMs += performance.now() - renderStart;
            frames += 1;
            last = now;
            if (now - first >= testDuration) resolve();
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        return {
          name,
          frames,
          elapsedMs: last - first,
          fps: (frames - 1) * 1000 / (last - first),
          renderMsPerFrame: renderMs / frames,
        };
      };

      const tightTest = (name, render) => {
        const started = performance.now();
        let iterations = 0;
        let now = started;
        do {
          render(iterations);
          iterations += 1;
          // Avoid a clock read on every iteration when the tested body is tiny.
          if ((iterations & 15) === 0) now = performance.now();
        } while (now - started < testDuration);
        const elapsedMs = performance.now() - started;
        return {
          name,
          iterations,
          elapsedMs,
          iterationsPerSecond: iterations * 1000 / elapsedMs,
          msPerIteration: elapsedMs / iterations,
        };
      };

      const fullRaster = (frame) => {
        for (let y = 0, index = 0; y < 600; y += 1) {
          for (let x = 0; x < 800; x += 1, index += 1) {
            const red = (x + frame) & 255;
            const green = (y + (frame << 1)) & 255;
            const blue = (x + y + (frame << 2)) & 255;
            pixels[index] = (0xff000000 | blue << 16 | green << 8 | red) >>> 0;
          }
        }
      };

      const jagexStyleBlend = (frame) => {
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
      const tests = [
        await rafTest('requestAnimationFrame only', () => {}),
        await rafTest('putImageData only', (frame) => {
          pixels[frame % pixels.length] ^= 0x00ffffff;
          upload();
        }),
        await rafTest('full JavaScript raster and upload', (frame) => {
          fullRaster(frame);
          upload();
        }),
        await rafTest('Jagex-style blend and upload', (frame) => {
          jagexStyleBlend(frame);
          upload();
        }),
      ];
      const tightLoopTests = [
        tightTest('full JavaScript raster', fullRaster),
        tightTest('Jagex-style blend', jagexStyleBlend),
        tightTest('Jagex-style blend and upload', (frame) => {
          jagexStyleBlend(frame);
          upload();
        }),
      ];
      return {
        userAgent: navigator.userAgent,
        width: 800,
        height: 600,
        tests,
        tightLoopTests,
      };
    }, durationMs);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
