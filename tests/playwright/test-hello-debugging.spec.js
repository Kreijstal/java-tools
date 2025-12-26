const { test, expect } = require('@playwright/test');

test.describe('Hello Class Debugging Test', () => {
  test('should load Hello.class, start debugging, and check disassembly content', async ({ page }) => {
    // Navigate to the debug interface
    await page.goto('/dist/index.html', { timeout: 10000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    console.log('=== Starting Hello.class debugging test ===');

    // Wait for the dropdown to be populated
    await page.waitForSelector('#sampleClassSelect', { timeout: 10000 });
    await page.waitForTimeout(3000); // Wait for initialization

    // Check current dropdown options
    const options = await page.locator('#sampleClassSelect option').allTextContents();
    console.log('Available dropdown options:');
    options.forEach((option, index) => {
      console.log(`  ${index}: ${option}`);
    });

    // Select Hello.class
    console.log('\n=== Selecting Hello.class ===');
    await page.selectOption('#sampleClassSelect', 'Hello.class');
    
    // Click Load button
    console.log('Clicking Load button...');
    await page.click('#loadSampleBtn');
    await page.waitForTimeout(2000);

    // Check console output
    const output = await page.locator('#output').textContent();
    console.log('\nConsole output after loading:');
    console.log(output);

    // Check if Start Debugging button is enabled
    const debugBtnDisabled = await page.locator('#debugBtn').getAttribute('disabled');
    console.log(`\nStart Debugging button disabled: ${debugBtnDisabled}`);

    // Check disassembly content before starting debugging
    console.log('\n=== Disassembly content BEFORE starting debugging ===');
    try {
      const disassemblyContentBefore = await page.evaluate(() => {
        const editor = window.aceEditor;
        if (editor) {
          return editor.getValue();
        } else {
          const textarea = document.querySelector('#disassembly-editor textarea');
          return textarea ? textarea.value : 'No editor content found';
        }
      });
      console.log('Disassembly before debugging:');
      console.log(disassemblyContentBefore);
    } catch (error) {
      console.log('Error getting disassembly content before:', error.message);
    }

    // Start debugging
    console.log('\n=== Starting debugging ===');
    await page.click('#debugBtn');
    await page.waitForTimeout(3000); // Wait for debugging to start

    // Check status after starting debugging
    const status = await page.locator('#status').textContent();
    console.log(`\nStatus after starting debugging: ${status}`);

    // Check execution state
    const executionState = await page.locator('#executionState').textContent();
    console.log(`\nExecution state: ${executionState}`);

    // Check disassembly content after starting debugging
    console.log('\n=== Disassembly content AFTER starting debugging ===');
    try {
      const disassemblyContentAfter = await page.evaluate(() => {
        const editor = window.aceEditor;
        if (editor) {
          return editor.getValue();
        } else {
          const textarea = document.querySelector('#disassembly-editor textarea');
          return textarea ? textarea.value : 'No editor content found';
        }
      });
      console.log('Disassembly after debugging:');
      console.log(disassemblyContentAfter);
      
      // Check if the disassembly was actually updated with real bytecode
      const hasRealBytecode = disassemblyContentAfter.includes('getstatic') || 
                             disassemblyContentAfter.includes('invokevirtual') || 
                             disassemblyContentAfter.includes('ldc') ||
                             disassemblyContentAfter.includes('aload_0') ||
                             disassemblyContentAfter.includes('return');
      
      console.log(`\nDisassembly contains real bytecode instructions: ${hasRealBytecode}`);
      
      if (!hasRealBytecode) {
        console.log('WARNING: Disassembly appears to contain mock data instead of real bytecode!');
      }
      
    } catch (error) {
      console.log('Error getting disassembly content after:', error.message);
    }

    // Check if step buttons are enabled
    const stepIntoEnabled = !(await page.locator('#stepIntoBtn').getAttribute('disabled'));
    const stepOverEnabled = !(await page.locator('#stepOverBtn').getAttribute('disabled'));
    const continueEnabled = !(await page.locator('#continueBtn').getAttribute('disabled'));
    
    console.log(`\nStep buttons enabled - StepInto: ${stepIntoEnabled}, StepOver: ${stepOverEnabled}, Continue: ${continueEnabled}`);

    // Let's also check if the JVM debug object is available
    const jvmDebugInfo = await page.evaluate(() => {
      if (typeof jvmDebug !== 'undefined' && jvmDebug) {
        try {
          const state = jvmDebug.getCurrentState();
          return {
            available: true,
            executionState: state.executionState,
            method: state.method ? state.method.name : null,
            pc: state.pc,
            hasDisassemblyView: typeof jvmDebug.getDisassemblyView === 'function'
          };
        } catch (e) {
          return { available: true, error: e.message };
        }
      } else {
        return { available: false };
      }
    });
    
    console.log('\nJVM Debug object info:', JSON.stringify(jvmDebugInfo, null, 2));

    // Basic assertion to ensure test doesn't just pass silently
    expect(status).toContain('Debugger started');
  });
});