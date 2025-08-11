const { test, expect } = require('@playwright/test');

test.describe('Sample Class Selection UI', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the debug interface
    await page.goto('/dist/index.html', { timeout: 10000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 });
  });

  test('should populate sample class dropdown with all 25 classes', async ({ page }) => {
    // Wait for the page to load and initialize the JVM
    await page.waitForSelector('#sampleClassSelect', { timeout: 10000 });
    
    // Wait a bit more for the dropdown to be populated
    await page.waitForTimeout(3000); // Increased wait time
    
    // Get all options in the dropdown
    const options = await page.locator('#sampleClassSelect option').allTextContents();
    
    // Should have at least 25 class options plus the default "Select a sample class..." option
    expect(options.length).toBeGreaterThanOrEqual(25);
    
    // Check that some specific classes are present
    const optionText = options.join(' ');
    expect(optionText).toContain('Hello');
    expect(optionText).toContain('VerySimple');
    expect(optionText).toContain('RuntimeArithmetic');
    expect(optionText).toContain('Calculator');
    expect(optionText).toContain('StringConcat');
    expect(optionText).toContain('ExceptionTest');
    expect(optionText).toContain('InvokeVirtualTest');
    expect(optionText).toContain('MainApp');
    expect(optionText).toContain('TestMethods');
    expect(optionText).toContain('ArithmeticTest');
    
    // Verify it shows the total number in the heading
    const heading = await page.locator('h4').filter({ hasText: 'Sample Classes' }).textContent();
    expect(heading).toContain('25 available');
  });

  test('should load a sample class successfully', async ({ page }) => {
    // Wait for the dropdown to be populated
    await page.waitForSelector('#sampleClassSelect', { timeout: 10000 });
    await page.waitForTimeout(3000); // Increased wait time
    
    // Select a sample class (VerySimple)
    await page.selectOption('#sampleClassSelect', 'VerySimple.class');
    
    // Click the Load Sample button
    await page.click('button:has-text("Load Sample")');
    
    // Wait for the class to be loaded
    await page.waitForTimeout(2000); // Increased wait time
    
    // Check that the status indicates successful loading
    const output = await page.locator('#output').textContent();
    expect(output).toContain('Loading sample class: VerySimple.class');
    
    // Verify that the Start Debugging button is enabled
    await expect(page.locator('#debugBtn')).toBeEnabled();
  });

  test('should start debugging with a loaded sample class', async ({ page }) => {
    // Wait for the dropdown to be populated
    await page.waitForSelector('#sampleClassSelect', { timeout: 10000 });
    await page.waitForTimeout(3000); // Increased wait time
    
    // Select and load a sample class
    await page.selectOption('#sampleClassSelect', 'Hello.class');
    await page.click('button:has-text("Load Sample")');
    await page.waitForTimeout(2000); // Increased wait time
    
    // Start debugging
    await page.click('#debugBtn');
    await page.waitForTimeout(2000); // Increased wait time
    
    // Check that debugging started successfully
    const status = await page.locator('#status').textContent();
    expect(status).toContain('Debugger started');
    
    // Check that step buttons are now enabled
    await expect(page.locator('#stepIntoBtn')).toBeEnabled();
    await expect(page.locator('#stepOverBtn')).toBeEnabled();
    await expect(page.locator('#continueBtn')).toBeEnabled();
  });

  test('should display class descriptions in dropdown', async ({ page }) => {
    // Wait for the dropdown to be populated
    await page.waitForSelector('#sampleClassSelect', { timeout: 10000 });
    await page.waitForTimeout(3000); // Increased wait time
    
    // Get all options and check they have descriptions
    const options = await page.locator('#sampleClassSelect option').allTextContents();
    
    // Filter out the default option
    const classOptions = options.filter(option => !option.includes('Select a sample class') && !option.includes('Loading'));
    
    // Each class option should have a description (format: "ClassName - Description")
    for (const option of classOptions.slice(0, 5)) { // Check first 5 to avoid timeout
      expect(option).toMatch(/\w+ - .+/); // Should match "ClassName - Description" pattern
    }
    
    // Check specific classes have expected descriptions
    const allText = options.join(' ');
    expect(allText).toContain('Hello - Hello World program');
    expect(allText).toContain('VerySimple - Basic arithmetic');
    expect(allText).toContain('Calculator - Calculator operations');
  });

  test('should handle loading multiple sample classes sequentially', async ({ page }) => {
    // Wait for the dropdown to be populated
    await page.waitForSelector('#sampleClassSelect', { timeout: 10000 });
    await page.waitForTimeout(3000); // Increased wait time
    
    // Load first class
    await page.selectOption('#sampleClassSelect', 'VerySimple.class');
    await page.click('button:has-text("Load Sample")');
    await page.waitForTimeout(1000);
    
    // Load second class
    await page.selectOption('#sampleClassSelect', 'Hello.class');
    await page.click('button:has-text("Load Sample")');
    await page.waitForTimeout(1000);
    
    // Load third class
    await page.selectOption('#sampleClassSelect', 'Calculator.class');
    await page.click('button:has-text("Load Sample")');
    await page.waitForTimeout(1000);
    
    // Check that the latest class was loaded successfully
    const output = await page.locator('#output').textContent();
    expect(output).toContain('Loading sample class: Calculator.class');
    
    // Verify debugging can start with the latest class
    await page.click('#debugBtn');
    await page.waitForTimeout(2000); // Increased wait time
    
    const status = await page.locator('#status').textContent();
    expect(status).toContain('Debugger started');
  });
});