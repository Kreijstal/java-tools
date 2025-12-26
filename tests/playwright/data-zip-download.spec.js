const { test, expect } = require('@playwright/test');

test('download data.zip from debug interface', async ({ page }) => {
  // Navigate to the debug interface
  await page.goto('/dist/index.html');

  // Wait for the page to load
  await page.waitForLoadState('networkidle');

  // The download link is inside a collapsible details element
  // First expand it by clicking the summary
  const downloadSection = page.locator('details.sample-download');
  await expect(downloadSection).toBeVisible();
  await downloadSection.locator('summary').click();

  // Now check that the download link is visible
  const downloadLink = page.locator('a[href="./data.zip"]');
  await expect(downloadLink).toBeVisible();
  await expect(downloadLink).toContainText('data.zip');

  // Test the download link href attribute
  const href = await downloadLink.getAttribute('href');
  expect(href).toBe('./data.zip');

  // Test that the download attribute is set correctly
  const downloadAttr = await downloadLink.getAttribute('download');
  expect(downloadAttr).toBe('java-class-samples.zip');
});

test('data.zip file is accessible via HTTP', async ({ page }) => {
  // Test that the data.zip file can be accessed directly
  const response = await page.request.get('/dist/data.zip');
  
  // Should return 200 OK
  expect(response.status()).toBe(200);
  
  // Should be a reasonable size (around 13KB)
  const buffer = await response.body();
  expect(buffer.length).toBeGreaterThan(10000);
  
  // Should have zip file signature
  const zipSignature = buffer.subarray(0, 4);
  expect(zipSignature[0]).toBe(0x50); // 'P'
  expect(zipSignature[1]).toBe(0x4B); // 'K'
});