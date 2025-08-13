const { test, expect } = require('@playwright/test');

test.describe('JVM Debug Browser Interface', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the debug interface with timeout
    await page.goto('/dist/index.html', { timeout: 10000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 });
  });

  test('should load the debug interface successfully', async ({ page }) => {
    // Check that the page title is correct
    await expect(page).toHaveTitle(/JVM Debug API Example/, { timeout: 5000 });
    
    // Check that main elements are present
    await expect(page.locator('h1')).toContainText('JVM Debug API Example', { timeout: 5000 });
    await expect(page.locator('#status')).toContainText('Ready - No program loaded', { timeout: 5000 });
    
    // Check that control buttons are present
    await expect(page.locator('button:has-text("Start Debugging")')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#stepIntoBtn')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#stepOverBtn')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#continueBtn')).toBeVisible({ timeout: 5000 });
  });

  test('should have disabled step buttons initially', async ({ page }) => {
    // Step buttons should be disabled initially
    await expect(page.locator('#stepIntoBtn')).toBeDisabled();
    await expect(page.locator('#stepOverBtn')).toBeDisabled();
    await expect(page.locator('#stepOutBtn')).toBeDisabled();
    await expect(page.locator('#stepInstructionBtn')).toBeDisabled();
    await expect(page.locator('#continueBtn')).toBeDisabled();
    await expect(page.locator('#finishBtn')).toBeDisabled();
  });

  test('should start debugging and enable controls', async ({ page }) => {
    // Start debugging
    await page.click('button:has-text("Start Debugging")', { timeout: 5000 });
    
    // Wait for the status to change with shorter timeout
    await expect(page.locator('#status')).toContainText('Debugger started', { timeout: 5000 });
    
    // Check that step buttons are now enabled
    await expect(page.locator('#stepIntoBtn')).toBeEnabled();
    await expect(page.locator('#stepOverBtn')).toBeEnabled();
    await expect(page.locator('#stepOutBtn')).toBeEnabled();
    await expect(page.locator('#stepInstructionBtn')).toBeEnabled();
    await expect(page.locator('#continueBtn')).toBeEnabled();
    await expect(page.locator('#finishBtn')).toBeEnabled();
    
    // Check that execution state shows paused
    await expect(page.locator('#executionState')).toContainText('Status: paused');
    await expect(page.locator('#executionState')).toContainText('PC: 0');
    await expect(page.locator('#executionState')).toContainText('Method: main([Ljava/lang/String;)V');
  });

  test('should step through execution', async ({ page }) => {
    // Start debugging
    await page.click('button:has-text("Start Debugging")', { timeout: 5000 });
    await expect(page.locator('#status')).toContainText('Debugger started', { timeout: 5000 });
    
    // Step into
    await page.click('#stepIntoBtn', { timeout: 5000 });
    await page.waitForTimeout(500);
    
    // Check that PC has advanced
    const executionState = page.locator('#executionState');
    await expect(executionState).toContainText(/PC: [1-9]/, { timeout: 5000 });
  });

  test('should set and clear breakpoints', async ({ page }) => {
    // Start debugging
    await page.click('button:has-text("Start Debugging")', { timeout: 5000 });
    await expect(page.locator('#status')).toContainText('Debugger started', { timeout: 5000 });
    
    // Set a breakpoint
    await page.fill('#breakpointInput', '5');
    await page.click('button:has-text("Set Breakpoint")', { timeout: 5000 });
    
    // Check that breakpoint is set
    await expect(page.locator('#executionState')).toContainText('Breakpoints: [5]', { timeout: 5000 });
    await expect(page.locator('#output')).toContainText('Breakpoint set at PC=5', { timeout: 5000 });
    
    // Clear breakpoints
    await page.click('button:has-text("Clear All Breakpoints")', { timeout: 5000 });
    await expect(page.locator('#executionState')).toContainText('Breakpoints: []', { timeout: 5000 });
    await expect(page.locator('#output')).toContainText('All breakpoints cleared', { timeout: 5000 });
  });

  test('should serialize and restore state', async ({ page }) => {
    // Start debugging
    await page.click('button:has-text("Start Debugging")', { timeout: 5000 });
    await expect(page.locator('#status')).toContainText('Debugger started', { timeout: 5000 });
    
    // Set some breakpoints and step
    await page.fill('#breakpointInput', '3');
    await page.click('button:has-text("Set Breakpoint")', { timeout: 5000 });
    await page.click('#stepIntoBtn', { timeout: 5000 });
    await page.waitForTimeout(500);
    
    // Serialize state
    await page.click('button:has-text("Serialize State")', { timeout: 5000 });
    await expect(page.locator('#output')).toContainText('State serialized successfully', { timeout: 5000 });
    
    // Check that deserialize button is now enabled
    await expect(page.locator('#deserializeBtn')).toBeEnabled();
    
    // Restore state
    await page.click('#deserializeBtn', { timeout: 5000 });
    await expect(page.locator('#status')).toContainText('State restored', { timeout: 5000 });
    await expect(page.locator('#output')).toContainText('JVM state restored successfully', { timeout: 5000 });
  });

  test('should handle continue execution', async ({ page }) => {
    // First load a sample class
    await page.selectOption('#sampleClassSelect', 'VerySimple.class');
    await page.click('#loadSampleBtn', { timeout: 5000 });
    await expect(page.locator('#status')).toContainText('Sample class loaded', { timeout: 5000 });
    
    // Start debugging
    await page.click('button:has-text("Start Debugging")', { timeout: 5000 });
    await expect(page.locator('#status')).toContainText('Debugger started', { timeout: 5000 });
    
    // Continue execution
    await page.click('#continueBtn', { timeout: 5000 });
    await page.waitForTimeout(1200); // Wait for execution to complete
    
    // Check that execution either completes or hits a breakpoint
    const status = await page.locator('#status').textContent();
    expect(status).toMatch(/(completed|breakpoint)/);
  });

  test('should validate invalid breakpoint input', async ({ page }) => {
    // Start debugging
    await page.click('button:has-text("Start Debugging")', { timeout: 5000 });
    await expect(page.locator('#status')).toContainText('Debugger started', { timeout: 5000 });
    
    // Try to set invalid breakpoint
    await page.fill('#breakpointInput', '-1');
    await page.click('button:has-text("Set Breakpoint")', { timeout: 5000 });
    
    // Check that error is shown
    await expect(page.locator('#output')).toContainText('Invalid breakpoint location', { timeout: 5000 });
  });

  test('should show proper console output format', async ({ page }) => {
    // Start debugging
    await page.click('button:has-text("Start Debugging")', { timeout: 5000 });
    await expect(page.locator('#status')).toContainText('Debugger started', { timeout: 5000 });
    
    // Check that output has timestamps and proper formatting
    const output = page.locator('#output');
    const outputText = await output.textContent();
    
    // Should contain timestamps in bracket format (supporting both 12-hour and 24-hour format)
    expect(outputText).toMatch(/\[\d{1,2}:\d{2}:\d{2}(\s?(AM|PM))?\]/);
    
    // Should contain initial load message
    expect(outputText).toContain('JVM Debug API Example loaded');
  });

  test('should handle multiple step operations', async ({ page }) => {
    // Start debugging
    await page.click('button:has-text("Start Debugging")', { timeout: 5000 });
    await expect(page.locator('#status')).toContainText('Debugger started', { timeout: 5000 });
    
    // Perform multiple step operations
    for (let i = 0; i < 3; i++) {
      await page.click('#stepIntoBtn', { timeout: 5000 });
      await page.waitForTimeout(350); // Slightly shorter timeout
      
      // Check that we're still in a valid state
      const executionState = await page.locator('#executionState').textContent();
      expect(executionState).toMatch(/Status: (paused|completed)/);
    }
  });
});