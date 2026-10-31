const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const cubeSource = fs.readFileSync(
  path.join(__dirname, '../../test/fixtures/frontend/Cube3D.java'), 'utf8');

test('unchanged software cube paints and RGBA colors reach native canvas pixels', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.JVMDebug && window.JVMDebug.javaTools);
  const result = await page.evaluate(async source => {
    const { BrowserJVMDebug, javaTools } = window.JVMDebug;
    const compiled = javaTools.compileJava(source + `
      class BrowserCubeProbe {
        public static Cube3D cube;
        public static Canvas alphaSurface;
        public static void main(String[] args) {
          cube = new Cube3D();
          cube.setSize(650, 390);
          cube.paint(cube.getGraphics());
          alphaSurface = new Canvas();
          alphaSurface.setSize(10, 10);
          Graphics2D g = (Graphics2D)alphaSurface.getGraphics();
          g.setColor(new Color(54, 124, 223, 165));
          g.fillRect(0, 0, 10, 10);
        }
      }
    `);
    const debug = new BrowserJVMDebug();
    for (const artifact of compiled.artifacts) {
      debug.fileProvider.virtualFS.set(`${artifact.internalName}.class`, artifact.bytes);
    }
    await debug.initialize();
    await debug.run('BrowserCubeProbe');
    const fields = debug.debugController.jvm.classes.BrowserCubeProbe.staticFields;
    const cube = fields.get('cube:LCube3D;')._canvasElement;
    const alpha = fields.get('alphaSurface:Ljava/awt/Canvas;')._canvasElement;
    return {
      rgba: Array.from(alpha.getContext('2d').getImageData(5, 5, 1, 1).data),
      cubePixel: Array.from(cube.getContext('2d').getImageData(325, 195, 1, 1).data),
    };
  }, cubeSource);
  expect(result.rgba).toEqual([54, 124, 223, 165]);
  expect(result.cubePixel).not.toEqual([8, 13, 26, 255]);
});
