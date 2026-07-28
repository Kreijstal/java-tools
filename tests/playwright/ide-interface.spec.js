const { test, expect } = require('@playwright/test');

// The IDE shell at dist/index.html: GoldenLayout layout, file explorer,
// per-file editor tabs, javac-style compile placement, terminal runs.
test.describe('Java tools IDE', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dist/index.html', { timeout: 10000 });
    // Boot is complete when the workspace exists and the seed file is open.
    await page.waitForFunction(
      () => window.javaToolsIde
        && window.javaToolsIde.context.workspace
        && window.javaToolsIde.documents.getActiveDocument(),
      null,
      { timeout: 30000 },
    );
  });

  test('boots the layout with explorer, panels, and a seeded Main.java tab', async ({ page }) => {
    await expect(page.locator('#explorerTree .tree-row[data-path="/src/Main.java"]')).toBeVisible();
    await expect(page.locator('.lm_tab')).toContainText(['Welcome', 'Main.java']);
    await expect(page.locator('.lm_tab')).toContainText(['Terminal', 'Output', 'Display', 'Debug', 'Bytecode']);
    const activePath = await page.evaluate(
      () => window.javaToolsIde.documents.getActiveDocument().path,
    );
    expect(activePath).toBe('/src/Main.java');
  });

  test('collapses and expands directories in the explorer', async ({ page }) => {
    const srcRow = page.locator('#explorerTree .tree-row[data-path="/src"]');
    const mainRow = page.locator('#explorerTree .tree-row[data-path="/src/Main.java"]');
    await expect(mainRow).toBeVisible();
    await srcRow.click();
    await expect(mainRow).toHaveCount(0);
    await srcRow.click();
    await expect(mainRow).toBeVisible();
  });

  test('creates a new file through the explorer and opens it in its own tab', async ({ page }) => {
    await page.locator('#explorerNewFileBtn').click();
    await page.locator('#promptDialogInput').fill('Scratch.java');
    await page.locator('#promptDialogOk').click();
    await expect(page.locator('#explorerTree .tree-row[data-path="/src/Scratch.java"]')).toBeVisible();
    await expect(page.locator('.lm_tab')).toContainText(['Scratch.java']);
    const exists = await page.evaluate(
      () => window.javaToolsIde.context.workspace.existsSync('/src/Scratch.java'),
    );
    expect(exists).toBe(true);
  });

  test('compiling a .java places the .class next to the source (javac semantics)', async ({ page }) => {
    await page.evaluate(() => window.javaToolsIde.actions.compileJavaFile('/src/Main.java'));
    const exists = await page.evaluate(
      () => window.javaToolsIde.context.workspace.existsSync('/src/Main.class'),
    );
    expect(exists).toBe(true);
    await page.locator('#explorerRefreshBtn').click();
    await expect(page.locator('#explorerTree .tree-row[data-path="/src/Main.class"]')).toBeVisible();
  });

  test('.java and .j are distinct files with distinct tabs', async ({ page }) => {
    await page.evaluate(() => window.javaToolsIde.actions.compileJavaFile('/src/Main.java'));
    await page.evaluate(() => window.javaToolsIde.actions.disassembleClassFile('/src/Main.class'));
    const jExists = await page.evaluate(
      () => window.javaToolsIde.context.workspace.existsSync('/src/Main.j'),
    );
    expect(jExists).toBe(true);

    // Open the .java as well; both tabs must coexist with their own names.
    await page.evaluate(() => window.javaToolsIde.documents.openFile('/src/Main.java'));
    const openPaths = await page.evaluate(() => {
      const documents = window.javaToolsIde.documents;
      return ['/src/Main.java', '/src/Main.j']
        .map((path) => (documents.getDocument(path) ? path : null))
        .filter(Boolean);
    });
    expect(openPaths).toEqual(['/src/Main.java', '/src/Main.j']);
    await expect(page.locator('.lm_tab[title="Main.j"]')).toBeVisible();
    await expect(page.locator('.lm_tab[title="Main.java"]')).toBeVisible();
  });

  test('runs the seeded Main.java and prints to the terminal', async ({ page }) => {
    await page.evaluate(() => window.javaToolsIde.actions.runPath('/src/Main.java'));
    await page.waitForFunction(
      () => {
        const terminal = document.querySelector('#xterm-container');
        return terminal && terminal.textContent.includes('Hello from the Java Tools IDE!');
      },
      null,
      { timeout: 20000 },
    );
  });

  test('loads a built-in sample from the toolbar into the bytecode view', async ({ page }) => {
    await page.waitForFunction(
      () => document.querySelectorAll('#sampleClassSelect option').length > 2,
      null,
      { timeout: 15000 },
    );
    await page.selectOption('#sampleClassSelect', 'Hello.class');
    await page.locator('#loadSampleBtn').click();
    await page.waitForFunction(
      () => window.aceEditor && window.aceEditor.getValue().includes('.class'),
      null,
      { timeout: 10000 },
    );
  });

  test('boots without console errors', async ({ page }) => {
    const errors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.reload();
    await page.waitForFunction(
      () => window.javaToolsIde && window.javaToolsIde.context.workspace,
      null,
      { timeout: 30000 },
    );
    expect(errors).toEqual([]);
  });
});

// On phones GoldenLayout is replaced by a one-view-at-a-time layout.
test.describe('Java tools IDE (mobile)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test.beforeEach(async ({ page }) => {
    await page.goto('/dist/index.html', { timeout: 10000 });
    await page.waitForFunction(
      () => window.javaToolsIde
        && window.javaToolsIde.context.workspace
        && window.javaToolsIde.documents.getActiveDocument(),
      null,
      { timeout: 30000 },
    );
  });

  test('uses the mobile view switcher instead of GoldenLayout', async ({ page }) => {
    await expect(page.locator('.ide-mobile-viewbar')).toBeVisible();
    await expect(page.locator('.lm_goldenlayout')).toHaveCount(0);
    // Boot opens Main.java, which switches to the Editor view.
    await expect(page.locator('.ide-mobile-viewbar button.active')).toHaveText('Editor');
    await expect(page.locator('.ide-mobile-editortab.active')).toContainText('Main.java');
  });

  test('switches views and opens files from the explorer', async ({ page }) => {
    await page.locator('.ide-mobile-viewbar button[data-view="explorer"]').click();
    await expect(page.locator('#explorerTree .tree-row[data-path="/src/Main.java"]')).toBeVisible();
    await page.locator('#explorerTree .tree-row[data-path="/src/Main.java"]').click();
    await expect(page.locator('.ide-mobile-view[data-view="editor"]')).toHaveClass(/active/);
    await page.locator('.ide-mobile-viewbar button[data-view="terminal"]').click();
    await expect(page.locator('#xterm-container')).toBeVisible();
  });

  test('runs Main.java and lands on the terminal view', async ({ page }) => {
    await page.evaluate(() => window.javaToolsIde.actions.runPath('/src/Main.java'));
    await page.waitForFunction(
      () => {
        const terminal = document.querySelector('#xterm-container');
        return terminal && terminal.textContent.includes('Hello from the Java Tools IDE!');
      },
      null,
      { timeout: 20000 },
    );
    await expect(page.locator('.ide-mobile-viewbar button.active')).toHaveText('Terminal');
  });
});
