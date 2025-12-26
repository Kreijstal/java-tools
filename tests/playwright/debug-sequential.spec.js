const { test, expect } = require('@playwright/test');

test('debug sequential loading issue', async ({ page }) => {
  await page.goto('/dist/index.html', { timeout: 10000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 });
  await page.waitForSelector('#sampleClassSelect', { timeout: 10000 });
  await page.waitForTimeout(3000);

  console.log('=== Loading Calculator.class ===');
  await page.selectOption('#sampleClassSelect', 'Calculator.class');
  await page.click('#loadBtn');
  await page.waitForTimeout(2000);

  const output = await page.locator('#output').textContent();
  console.log('Console output after loading Calculator:');
  console.log(output);

  const debugBtnDisabled = await page.locator('#debugBtn').getAttribute('disabled');
  console.log(`Debug button disabled: ${debugBtnDisabled}`);

  const selectedValue = await page.locator('#sampleClassSelect').inputValue();
  console.log(`Dropdown selected value: ${selectedValue}`);

  console.log('\n=== Clicking Start Debugging ===');
  await page.click('#debugBtn');
  await page.waitForTimeout(3000);

  const status = await page.locator('#status').textContent();
  console.log(`Final status: ${status}`);
  
  const finalOutput = await page.locator('#output').textContent();
  console.log('\nFinal console output:');
  console.log(finalOutput);
});