const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../../test/fixtures/frontend/RoundedRectangles.java'), 'utf8');

test('Graphics2D inherits rounded rectangle methods and renders native canvas pixels', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.JVMDebug && window.JVMDebug.javaTools);
  const pixels = await page.evaluate(async source => {
    const { BrowserJVMDebug, javaTools } = window.JVMDebug;
    const debug = new BrowserJVMDebug();
    for (const artifact of javaTools.compileJava(source).artifacts) {
      debug.fileProvider.virtualFS.set(`${artifact.internalName}.class`, artifact.bytes);
    }
    await debug.initialize();
    await debug.run('RoundedRectangles');
    const canvas = document.querySelector('#awt-container .jvm-awt-frame canvas');
    const ctx = canvas.getContext('2d');
    return [[30,25], [10,10], [30,10], [85,25], [85,10], [105,25], [85,42],
      [65,10], [30,65], [10,55], [65,55], [95,65], [110,64], [0,80], [85,75], [85,80], [0,0]]
      .map(([x,y]) => Array.from(ctx.getImageData(x, y, 1, 1).data));
  }, source);
  const red = [255,0,0,255], blue = [0,0,255,255], green = [0,255,0,255], white = [255,255,255,255];
  expect(pixels).toEqual([red, blue, red, blue, green, green, green, blue,
    [128,0,127,255], blue, white, white, white, white, [128,0,127,255], blue, blue]);
});
