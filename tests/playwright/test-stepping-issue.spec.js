const { test, expect } = require('@playwright/test');

test('Test stepping functionality shows the issue', async ({ page }) => {
  // Go to the debug interface
  await page.goto('/examples/debug-web-interface.html', { timeout: 10000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 });
  await page.waitForSelector('#sampleClassSelect', { timeout: 10000 });
  await page.waitForTimeout(3000);

  console.log('=== Loading Hello.class ===');
  await page.selectOption('#sampleClassSelect', 'Hello.class');
  await page.click('#loadBtn');
  await page.waitForTimeout(2000);

  console.log('=== Starting debugging ===');
  await page.click('#debugBtn');
  await page.waitForTimeout(3000);

  // Test step functionality
  console.log('\n=== Testing step functionality ===');
  
  for (let i = 1; i <= 5; i++) {
    console.log(`\n--- Step ${i} ---`);
    
    // Get current state before step
    const stateBefore = await page.evaluate(() => {
      return window.jvmDebug ? window.jvmDebug.getCurrentState() : {};
    });
    console.log(`Before step ${i}: PC=${stateBefore.pc}, State=${stateBefore.executionState}`);
    
    // Perform step
    await page.click('#stepIntoBtn');
    await page.waitForTimeout(1000);
    
    // Get state after step
    const stateAfter = await page.evaluate(() => {
      return window.jvmDebug ? window.jvmDebug.getCurrentState() : {};
    });
    console.log(`After step ${i}: PC=${stateAfter.pc}, State=${stateAfter.executionState}`);
    
    // Check if step actually progressed
    if (stateAfter.pc !== stateBefore.pc || stateAfter.executionState !== 'paused') {
      console.log(`✅ Step ${i} progressed correctly`);
    } else {
      console.log(`❌ Step ${i} did not progress - PC stayed at ${stateAfter.pc}`);
    }
    
    // If program completed, stop
    if (stateAfter.executionState === 'stopped' || stateAfter.executionState === 'completed') {
      console.log(`Program completed after step ${i}`);
      break;
    }
  }
});