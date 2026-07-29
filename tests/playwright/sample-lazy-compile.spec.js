const { test, expect } = require('@playwright/test');

// Samples ship as .java sources plus a manifest; the browser compiles them
// with its own Java frontend the first time they are used. No data.zip.

test('sample manifest is served instead of data.zip', async ({ page }) => {
  const manifestResponse = await page.request.get('/dist/data/manifest.json');
  expect(manifestResponse.status()).toBe(200);
  const manifest = await manifestResponse.json();
  expect(manifest.samples.length).toBeGreaterThan(100);
  expect(manifest.samples.some((sample) => sample.source === 'Hello.java')).toBe(true);

  const sourceResponse = await page.request.get('/dist/data/Hello.java');
  expect(sourceResponse.status()).toBe(200);
  expect(await sourceResponse.text()).toContain('class Hello');

  const zipResponse = await page.request.get('/dist/data.zip');
  expect(zipResponse.status()).toBe(404);
});

test.describe('lazy sample compilation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dist/classic.html', { timeout: 10000 });
    await page.waitForFunction(
      () => window.jvmDebug
        && document.querySelectorAll('#sampleClassSelect option').length > 2,
      null,
      { timeout: 15000 },
    );
  });

  test('loading a sample compiles its source in the browser', async ({ page }) => {
    // Before loading, the class must not exist in the virtual classpath.
    const preloaded = await page.evaluate(
      () => window.jvmDebug.fileProvider.exists('VerySimple.class'),
    );
    expect(preloaded).toBe(false);

    await page.selectOption('#sampleClassSelect', 'VerySimple.class');
    await page.click('#loadBtn');
    await page.waitForFunction(
      () => document.querySelector('#output').textContent.includes('Compiled sample VerySimple.java'),
      null,
      { timeout: 15000 },
    );
    const loaded = await page.evaluate(
      () => window.jvmDebug.fileProvider.exists('VerySimple.class'),
    );
    expect(loaded).toBe(true);
    await expect(page.locator('#debugBtn')).toBeEnabled();
  });

  test('lazy compilation pulls in the cross-file dependency closure', async ({ page }) => {
    await page.selectOption('#sampleClassSelect', 'MainApp.class');
    await page.click('#loadBtn');
    await page.waitForFunction(
      () => document.querySelector('#output').textContent.includes('Compiled sample MainApp.java'),
      null,
      { timeout: 15000 },
    );
    const dependenciesLoaded = await page.evaluate(async () => ({
      thing: await window.jvmDebug.fileProvider.exists('Thing.class'),
      producer: await window.jvmDebug.fileProvider.exists('ThingProducer.class'),
    }));
    expect(dependenciesLoaded).toEqual({ thing: true, producer: true });

    // The closure makes the sample actually runnable.
    await page.click('#runBtn');
    await expect(page.locator('#status')).toContainText('completed', { timeout: 15000 });
  });
});
