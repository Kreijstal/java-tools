const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../../test/fixtures/frontend/Cube3D.java'), 'utf8');

test('original Cube3D.main mounts, animates and handles dragging without a host-side mounting harness', async ({ page }) => {
  test.setTimeout(45000);
  await page.goto('/');
  await page.waitForFunction(() => window.JVMDebug && window.JVMDebug.javaTools);
  await page.evaluate(async source => {
    const { BrowserJVMDebug, javaTools } = window.JVMDebug;
    const debug = new BrowserJVMDebug();
    for (const artifact of javaTools.compileJava(source).artifacts) {
      debug.fileProvider.virtualFS.set(`${artifact.internalName}.class`, artifact.bytes);
    }
    await debug.initialize();
    window.frameMountTest = { debug, error: null, completed: false };
    // The original main has an intentional infinite animation loop. Observe
    // its rendering while run remains pending, just like a live application.
    debug.run('Cube3D').then(
      () => { window.frameMountTest.completed = true; },
      error => { window.frameMountTest.error = String(error); },
    );
  }, source);
  const frame = page.locator('#awt-container .jvm-awt-frame');
  const canvas = frame.locator('canvas');
  await expect(frame).toBeVisible({ timeout: 15000 });
  await expect(frame).toHaveAttribute('aria-label', 'Java 3D');
  await expect(canvas).toHaveAttribute('width', '650');
  await expect(canvas).toHaveAttribute('height', '390');
  await expect.poll(() => canvas.evaluate(c => c.getContext('2d').getImageData(325, 195, 1, 1).data[3]),
    { timeout: 15000 }).toBe(255);
  const first = await canvas.evaluate(c => c.toDataURL());
  await expect.poll(() => canvas.evaluate(c => c.toDataURL()), { timeout: 10000 }).not.toBe(first);
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + 280, box.y + 180);
  await page.mouse.down();
  const javaField = async name => page.evaluate(name => {
    const jvm = window.frameMountTest.debug.debugController.jvm;
    const cube = [...jvm._awtInputComponents.get('mouse')]
      .find(component => (component._className || component.type) === 'Cube3D');
    return cube.fields[`Cube3D.${name}`];
  }, name);
  // Java's mousePressed sets dragging, which pauses tick's auto-spin path.
  await expect.poll(() => javaField('dragging')).toBe(1);
  const beforeDrag = await canvas.evaluate(c => c.toDataURL());
  await page.mouse.move(box.x + 420, box.y + 240, { steps: 8 });
  await expect.poll(() => javaField('lastX')).toBeGreaterThan(350);
  await expect.poll(() => javaField('lastY')).toBeGreaterThan(210);
  await expect.poll(() => canvas.evaluate(c => c.toDataURL())).not.toBe(beforeDrag);
  await page.mouse.up();
  await expect.poll(() => javaField('dragging')).toBe(0);
  expect(await page.evaluate(() => window.frameMountTest.error)).toBeNull();
  expect(await page.evaluate(() => window.frameMountTest.completed)).toBe(false);
});
