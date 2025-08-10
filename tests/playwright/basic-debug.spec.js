const { test, expect } = require('@playwright/test');

test.describe('JVM Debug Browser Interface - Basic Tests', () => {
  test('should serve the debug interface without errors', async ({ page }) => {
    // Simple test to check if the interface loads with timeout
    await page.goto('/examples/debug-web-interface.html');
    
    // Check that the page loads without console errors
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    
    await page.waitForLoadState('networkidle', { timeout: 10000 });
    
    // Verify basic elements are present
    await expect(page.locator('h1')).toContainText('JVM Debug API Example', { timeout: 5000 });
    await expect(page.locator('#status')).toBeVisible({ timeout: 5000 });
    
    // Check no major JavaScript errors occurred
    expect(consoleErrors.length).toBe(0);
  });

  test('should run browser debug functionality test', async ({ page }) => {
    // Navigate to our test page with timeout
    await page.goto('/examples/browser-debug-test.html', { timeout: 10000 });
    
    // Wait for tests to complete with shorter timeout
    await page.waitForFunction(() => window.testResult !== undefined, { timeout: 15000 });
    
    // Get test results
    const testResult = await page.evaluate(() => window.testResult);
    
    // Verify that tests passed
    expect(testResult.failed).toBe(0);
    expect(testResult.passed).toBeGreaterThan(0);
    
    console.log(`Browser debug tests: ${testResult.passed}/${testResult.total} passed`);
  });
});