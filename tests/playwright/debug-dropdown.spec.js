const { test, expect } = require('@playwright/test');

test.describe('Debug Initialization Issues', () => {
  test('debug dropdown loading issue', async ({ page }) => {
      // Monitor console messages and network requests
      const consoleMessages = [];
      const networkRequests = [];
      
      page.on('console', (msg) => {
          consoleMessages.push(`[${msg.type()}] ${msg.text()}`);
      });

      // Monitor JavaScript errors
      page.on('pageerror', (error) => {
          console.log('JavaScript error:', error.message);
      });

      page.on('request', (request) => {
          networkRequests.push(`${request.method()} ${request.url()}`);
      });

      page.on('response', (response) => {
          if (!response.ok()) {
              console.log(`Failed request: ${response.status()} ${response.url()}`);
          }
      });

      // Navigate to the page
      await page.goto('/dist/index.html');

      // Wait for page to load
      await page.waitForSelector('#sampleClassSelect', { timeout: 10000 });
      await page.waitForTimeout(5000); // Wait longer for loading

      // Check if JVM debug is loaded
      const jvmDebugExists = await page.evaluate(() => {
          return typeof window.JVMDebug !== 'undefined';
      });

      console.log('JVM Debug loaded:', jvmDebugExists);

      // Check if basic script execution is working
      const basicJSTest = await page.evaluate(() => {
          console.log('TEST: Basic JavaScript execution works');
          return true;
      });

      // Check if log function exists  
      const logFunctionExists = await page.evaluate(() => {
          return typeof window.log !== 'undefined';
      });

      console.log('Log function exists:', logFunctionExists);

      // Try to manually trigger initialization
      const manualInit = await page.evaluate(() => {
          if (typeof window.initializeJVM === 'function') {
              console.log('TEST: Calling initializeJVM manually');
              window.initializeJVM().catch(console.error);
              return true;
          }
          return false;
      });

      console.log('Manual initialization triggered:', manualInit);

      // Get dropdown options
      const options = await page.locator('#sampleClassSelect option').allTextContents();
      console.log('Dropdown options:', options);

      // Log network requests
      console.log('\nNetwork requests:');
      networkRequests.slice(0, 10).forEach(req => console.log('  ' + req));

      // Log console messages
      console.log('\nBrowser console messages:');
      consoleMessages.forEach(msg => console.log('  ' + msg));

      // Check if there are error messages
      const errorMessages = consoleMessages.filter(msg => msg.includes('[error]'));
      if (errorMessages.length > 0) {
          console.log('\nError messages found:');
          errorMessages.forEach(msg => console.log('  ' + msg));
      }
  });
});