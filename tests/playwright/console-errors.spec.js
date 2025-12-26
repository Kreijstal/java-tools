const { test, expect } = require('@playwright/test');

test.describe('Console Error Detection', () => {
  test('should not have console errors during Hello class step-by-step execution', async ({ page }) => {
    const consoleErrors = [];
    
    // Capture console errors only
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // Load the debug interface
    await page.goto('/dist/index.html', { timeout: 10000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 });
    
    // Wait for initialization
    await page.waitForSelector('#sampleClassSelect', { timeout: 10000 });
    await page.waitForTimeout(2000);
    
    // Load Hello.class which contains System.out.println
    await page.selectOption('#sampleClassSelect', 'Hello.class');
    await page.click('#loadSampleBtn');
    await page.waitForTimeout(1000);

    // Start debugging
    await page.click('#debugBtn', { timeout: 5000 });
    await expect(page.locator('#status')).toContainText('Debugger started', { timeout: 5000 });
    
    // Clear console errors collected during initialization
    consoleErrors.length = 0;
    
    // Step through execution - this should trigger the System.out access
    await page.click('#stepIntoBtn', { timeout: 5000 });
    await page.waitForTimeout(500);
    
    // Step again to hit the getstatic instruction for System.out
    await page.click('#stepIntoBtn', { timeout: 5000 });
    await page.waitForTimeout(500);
    
    // Step again to potentially hit the invokevirtual for println
    await page.click('#stepIntoBtn', { timeout: 5000 });
    await page.waitForTimeout(500);
    
    // Assert no console errors related to System class static field access
    const systemClassErrors = consoleErrors.filter(error => 
      error.includes('Unresolved static field: java/lang/System.out') ||
      error.includes('Class file not found: java/lang/System.class')
    );
    
    expect(systemClassErrors).toHaveLength(0);
  });
});