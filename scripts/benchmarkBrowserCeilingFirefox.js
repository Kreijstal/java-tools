'use strict';

const { firefox } = require('playwright');

const baseUrl = process.env.BROWSER_CEILING_URL ||
  'http://127.0.0.1:3765/diagnostics';
const executablePath = process.env.FIREFOX_EXECUTABLE_PATH;
const timeoutMs = Number(process.env.BROWSER_CEILING_TIMEOUT_MS || 180000);

(async () => {
  const launchOptions = { headless: true };
  if (executablePath) launchOptions.executablePath = executablePath;
  const browser = await firefox.launch(launchOptions);
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (error) =>
      pageErrors.push(error.stack || error.message || String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() =>
      window.__browserCeilingResult || window.__browserCeilingFailure,
    null, { timeout: timeoutMs });
    const outcome = await page.evaluate(() => ({
      result: window.__browserCeilingResult || null,
      failure: window.__browserCeilingFailure || null,
    }));
    const report = {
      url: baseUrl,
      ...outcome,
      pageErrors,
      consoleErrors,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (outcome.failure || pageErrors.length || consoleErrors.length) {
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
