const { test, expect } = require('@playwright/test');

test.describe('Thread Reset Issue Test', () => {
  test('should reset thread array when loading a class for debugging multiple times', async ({ page }) => {
    // Navigate to the debug interface
    await page.goto('/dist/index.html', { timeout: 10000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    console.log('=== Thread Reset Test ===');

    // Wait for the dropdown to be populated
    await page.waitForSelector('#sampleClassSelect', { timeout: 10000 });
    await page.waitForTimeout(3000); // Wait for initialization

    // Select Hello.class
    console.log('\n=== First Run: Load and run Hello to completion ===');
    await page.selectOption('#sampleClassSelect', 'Hello.class');
    await page.click('button:has-text("Load Sample")');
    await page.waitForTimeout(2000);

    // Start debugging
    await page.click('#debugBtn');
    await page.waitForTimeout(2000);

    // Continue until completion
    console.log('Running Hello to completion...');
    let executionState = await page.locator('#executionState').textContent();
    console.log(`Initial execution state: ${executionState}`);
    
    // Continue execution until it stops
    while (executionState.includes('paused')) {
      await page.click('#continueBtn');
      await page.waitForTimeout(1000);
      executionState = await page.locator('#executionState').textContent();
      console.log(`Execution state: ${executionState}`);
    }

    // Check thread count after first run
    const firstRunThreadCount = await page.evaluate(() => {
      if (typeof jvmDebug !== 'undefined' && jvmDebug && jvmDebug.getThreads) {
        const threads = jvmDebug.getThreads();
        return threads.length;
      }
      return -1; // Error indicator
    });
    
    console.log(`First run completed. Thread count: ${firstRunThreadCount}`);

    // Second run: Debug Hello again
    console.log('\n=== Second Run: Load and debug Hello again ===');
    await page.selectOption('#sampleClassSelect', 'Hello.class');
    await page.click('button:has-text("Load Sample")');
    await page.waitForTimeout(2000);

    // Start debugging again
    await page.click('#debugBtn');
    await page.waitForTimeout(2000);

    // Check thread count after second run start
    const secondRunThreadCount = await page.evaluate(() => {
      if (typeof jvmDebug !== 'undefined' && jvmDebug && jvmDebug.getThreads) {
        const threads = jvmDebug.getThreads();
        return { 
          count: threads.length, 
          details: threads.map(t => `${t.id}:${t.status}`) 
        };
      }
      return { count: -1, details: [] }; // Error indicator
    });
    
    console.log(`Second run started. Thread count: ${secondRunThreadCount.count}`);
    console.log(`Thread details: ${JSON.stringify(secondRunThreadCount.details)}`);

    // Verify that thread count is reset (should be 1, not accumulated)
    expect(secondRunThreadCount.count).toBe(1);
    console.log('✅ Thread array properly reset - only 1 thread present');

    // Verify execution state is correct
    const finalExecutionState = await page.locator('#executionState').textContent();
    expect(finalExecutionState).toContain('paused');
    console.log(`✅ Execution state correct: ${finalExecutionState}`);
  });
});