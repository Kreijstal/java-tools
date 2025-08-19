const { test, expect } = require('@playwright/test');

test.describe('Console Error Detection', () => {
  test('should not have console errors during Hello class step-by-step execution', async ({ page }) => {
    const consoleMessages = [];
    
    // Capture all console messages
    page.on('console', (msg) => {
      consoleMessages.push(`[${msg.type()}] ${msg.text()}`);
    });

    // Load the debug interface
    await page.goto('/dist/index.html', { timeout: 10000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 });
    
    // Wait for initialization
    await page.waitForSelector('#sampleClassSelect', { timeout: 10000 });
    await page.waitForTimeout(2000);
    
    // Load Hello.class which contains System.out.println
    await page.selectOption('#sampleClassSelect', 'Hello.class');
    await page.click('button:has-text("Load Sample")');
    await page.waitForTimeout(1000);
    
    // Start debugging
    await page.click('button:has-text("Start Debugging")', { timeout: 5000 });
    await expect(page.locator('#status')).toContainText('Debugger started', { timeout: 5000 });
    
    // Clear console messages collected during initialization
    consoleMessages.length = 0;
    
    // Step through execution - this should trigger the System.out access
    await page.click('#stepIntoBtn', { timeout: 5000 });
    await page.waitForTimeout(500);
    
    // Step again to hit the getstatic instruction for System.out
    await page.click('#stepIntoBtn', { timeout: 5000 });
    await page.waitForTimeout(500);
    
    // Step again to potentially hit the invokevirtual for println
    await page.click('#stepIntoBtn', { timeout: 5000 });
    await page.waitForTimeout(500);
    
    // Log all console messages for debugging
    if (consoleMessages.length > 0) {
      console.log('All console messages during steps:');
      consoleMessages.forEach(msg => console.log(`  - ${msg}`));
    }
    
    // Check if the browser override was called
    const browserOverrideMessages = consoleMessages.filter(msg => 
      msg.includes('BROWSER OVERRIDE')
    );
    
    console.log(`Browser override messages: ${browserOverrideMessages.length}`);
    browserOverrideMessages.forEach(msg => console.log(`  ${msg}`));
    
    // Assert no console errors related to the specific issues mentioned
    const systemClassErrors = consoleMessages.filter(msg => 
      msg.includes('Unresolved static field: java/lang/System.out')
    );
    
    expect(systemClassErrors).toHaveLength(0);
  });
});