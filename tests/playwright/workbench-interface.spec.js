const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

test.describe('Java tools workbench', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dist/classic.html');
    await page.waitForFunction(
      () => document.querySelectorAll('#sampleClassSelect option').length > 2,
      null,
      { timeout: 15000 },
    );
  });

  test('opens on a file-centric Java document with compact tool views', async ({ page }) => {
    const tabs = page.locator('.workspace-tab');
    await expect(tabs).toHaveCount(4);
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#workspace-compile')).toBeVisible();
    await expect(page.locator('#workspace-disassemble')).toBeHidden();
    await expect(page.locator('[data-workspace="decompile"]')).toHaveCount(0);
    await expect(page.locator('.document-tab')).toHaveCount(1);
    await expect(page.locator('.document-tab')).toContainText('HelloWorkbench.java');
    await expect(page.locator('#activeDocumentPath')).toContainText('HelloWorkbench.java');
    await expect(page.locator('#fileMenu')).toBeVisible();

    await tabs.nth(1).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#workspace-disassemble')).toBeVisible();
  });

  test('groups built-in samples and exposes only runnable main classes', async ({ page }) => {
    const options = await page.locator('#sampleClassSelect option').evaluateAll(
      (items) => items.map((item) => item.value).filter(Boolean),
    );
    expect(options.length).toBeGreaterThan(10);
    expect(options).toContain('Hello.class');
    expect(options).toContain('PyramidApplet.class');
    expect(options).not.toContain('Animal.class');

    const invalidTargets = await page.evaluate(async (classPaths) => {
      const invalid = [];
      for (const classPath of classPaths) {
        const launchInfo = await window.jvmDebug.getClassLaunchInfo(classPath);
        if (!launchInfo.launchMode) invalid.push(classPath);
      }
      return invalid;
    }, options);
    expect(invalidTargets).toEqual([]);

    await page.locator('#sampleCatalog > summary').click();
    expect(await page.locator('.sample-category').count()).toBeGreaterThanOrEqual(4);
    await page.locator('.sample-category').first().locator('summary').click();
    const firstChoice = page.locator('.sample-choices button').first();
    const classPath = await firstChoice.getAttribute('data-sample-path');
    await firstChoice.click();
    await expect(page.locator('#sampleClassSelect')).toHaveValue(classPath);
  });

  test('compiles, loads, and opens the class Java representation', async ({ page }) => {
    await page.click('[data-workspace="compile"]');
    await expect.poll(() => page.evaluate(
      () => window.ace.edit('java-source-editor').session.$modeId,
    )).toBe('ace/mode/java');
    await expect(page.locator('#java-source-editor .ace_keyword').first())
      .toContainText('public');
    await page.click('#compileBtn');
    await expect(page.locator('#compileStatus')).toHaveClass(/success/);
    await expect(page.locator('#compiler-output'))
      .toContainText('.class public final super HelloWorkbench');
    await expect(page.locator('#loadCompiledBtn')).toBeEnabled();
    const workspaceFiles = await page.evaluate(
      () => window.jvmDebug.getFileProvider().getWorkspaceFileSystem().listFiles(),
    );
    expect(workspaceFiles).toContain('src/HelloWorkbench.java');
    expect(workspaceFiles).toContain('classes/HelloWorkbench.class');

    await page.click('#loadCompiledBtn');
    await expect(page.locator('#status')).toContainText('HelloWorkbench');
    await expect(page.locator('#workspace-disassemble')).toBeVisible();

    await page.click('[data-workspace="compile"]');
    await expect(page.locator('.document-tab[aria-selected="true"]'))
      .toContainText('HelloWorkbench.java');
    await expect(page.locator('#java-source-editor'))
      .toContainText('class HelloWorkbench');
  });

  test('shows the Java representation belonging to the active class', async ({ page }) => {
    await page.selectOption('#sampleClassSelect', 'Hello.class');
    await page.click('#loadBtn');
    await expect(page.locator('.document-tab[aria-selected="true"]'))
      .toContainText('Hello.j');
    await expect(page.locator('.document-tab')).toHaveCount(2);

    await page.click('[data-workspace="compile"]');
    await expect(page.locator('.document-tab[aria-selected="true"]'))
      .toContainText('Hello.java');
    await expect(page.locator('.document-tab')).toHaveCount(2);
    await expect(page.locator('#java-source-editor')).toContainText('class Hello');
    await expect(page.locator('#java-source-editor')).not.toContainText('HelloWorkbench');

    await page.click('[data-workspace="disassemble"]');
    await page.selectOption('#sampleClassSelect', 'PyramidApplet.class');
    await page.click('#loadBtn');
    await expect(page.locator('.document-tab[aria-selected="true"]'))
      .toContainText('PyramidApplet.j');
    await expect(page.locator('.document-tab')).toHaveCount(3);

    await page.click('[data-workspace="compile"]');
    await expect(page.locator('.document-tab[aria-selected="true"]'))
      .toContainText('PyramidApplet.java');
    await expect(page.locator('.document-tab')).toHaveCount(3);
    await page.click('[data-workspace="compile"]');
    await expect(page.locator('.document-tab')).toHaveCount(3);
    await expect(page.locator('#java-source-editor')).toContainText('class PyramidApplet');
    await expect(page.locator('#java-source-editor')).not.toContainText('class Hello');
    await expect(page.locator('#compileStatus'))
      .toContainText('PyramidApplet.j is open as PyramidApplet.java');

    await page.click('.document-tab[aria-selected="true"] .document-close');
    await expect(page.locator('.document-tab')).toHaveCount(2);
    await expect(page.locator('.document-tab', { hasText: 'PyramidApplet' }))
      .toHaveCount(0);
  });

  test('compiles and runs Java source through the fast path', async ({ page }) => {
    await page.click('[data-workspace="compile"]');
    await page.click('#compileRunBtn');

    await expect(page.locator('#workspace-run')).toBeVisible();
    await expect(page.locator('#xterm-container')).toBeVisible();
    await expect(page.locator('#status')).toContainText(
      'Program HelloWorkbench completed',
      { timeout: 15000 },
    );
    await expect(page.locator('#xterm-container')).toContainText('total = 15');
  });

  test('opens class files as .j documents and preserves text only when saved as .j', async ({ page }) => {
    await page.selectOption('#sampleClassSelect', 'Hello.class');
    await page.click('#loadBtn');
    await expect(page.locator('#workspace-disassemble')).toBeVisible();
    await expect(page.locator('.document-tab[aria-selected="true"]'))
      .toContainText('Hello.j');
    await expect(page.locator('#assemblyDocumentLabel')).toContainText('Hello.j');
    await expect(page.locator('#assembleBtn')).toContainText('Save class');
    await expect.poll(() => page.evaluate(
      () => window.aceEditor ? window.aceEditor.getValue() : '',
    )).toContain('.class public super Hello');

    await page.evaluate(() => {
      window.aceEditor.setValue(`${window.aceEditor.getValue()}\n`, -1);
    });
    await expect(page.locator('.document-tab[aria-selected="true"] .document-dirty'))
      .toHaveCount(1);
    await page.keyboard.press('Control+S');
    await expect(page.locator('#assemblyStatus')).toContainText(
      'Hello.class assembled and saved in the workspace',
    );
    await expect(page.locator('#assembleBtn')).toContainText('Save class');

    await page.evaluate(() => {
      window.aceEditor.setValue(
        `${window.aceEditor.getValue()}\n; preserved assembly comment\n`,
        -1,
      );
    });
    await expect(page.locator('.document-tab[aria-selected="true"] .document-dirty'))
      .toHaveCount(1);

    await page.locator('#fileMenu > summary').click();
    await page.click('#saveAsFileBtn');
    await expect(page.locator('#saveAsName')).toHaveValue('Hello.class');
    await page.fill('#saveAsName', 'Hello.j');
    await expect(page.locator('#saveAsHint')).toContainText('preserved exactly');

    const downloadPromise = page.waitForEvent('download');
    await page.click('#confirmSaveAsBtn');
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('Hello.j');
    const downloadPath = await download.path();
    expect(fs.readFileSync(downloadPath, 'utf8')).toContain('preserved assembly comment');
    await expect(page.locator('.document-tab[aria-selected="true"]'))
      .toContainText('Hello.j');
    await expect(page.locator('#assembleBtn')).toContainText('Save .j');
  });

  test('opens and saves Java files through the File menu', async ({ page }) => {
    const chooserPromise = page.waitForEvent('filechooser');
    await page.locator('#fileMenu > summary').click();
    await page.click('#openFileMenuBtn');
    const chooser = await chooserPromise;
    await chooser.setFiles({
      name: 'Scratch.java',
      mimeType: 'text/x-java-source',
      buffer: Buffer.from(
        'public class Scratch { public static void main(String[] args) {} }',
      ),
    });

    await expect(page.locator('.document-tab[aria-selected="true"]'))
      .toContainText('Scratch.java');
    await expect(page.locator('#workspace-compile')).toBeVisible();
    await expect.poll(() => page.evaluate(
      () => window.ace.edit('java-source-editor').getValue(),
    )).toContain('class Scratch');

    await page.keyboard.press('Control+S');
    await expect(page.locator('#compileStatus')).toContainText(
      'Scratch.java saved in the workspace',
    );
    const workspaceSource = await page.evaluate(
      () => window.jvmDebug.readWorkspaceFile('/src/Scratch.java', 'utf8'),
    );
    expect(workspaceSource).toContain('class Scratch');
  });

  test('creates nested workspace folders and shows empty directories', async ({ page }) => {
    await page.locator('#fileMenu > summary').click();
    await page.click('#newFolderBtn');
    await expect(page.locator('#newFolderDialog')).toBeVisible();
    await page.fill('#newFolderPath', '/src/example/model');
    await page.click('#confirmNewFolderBtn');

    await expect(page.locator('#newFolderDialog')).toBeHidden();
    await expect(page.locator('#workspaceExplorer')).toHaveAttribute('open', '');
    await expect(page.locator('#workspaceTreeStatus'))
      .toContainText('Created /src/example/model');
    await page.locator('.workspace-directory > summary', { hasText: 'example' }).click();
    await expect(page.locator('.workspace-directory > summary', { hasText: 'model' }))
      .toBeVisible();
    await page.locator('.workspace-directory > summary', { hasText: 'model' }).click();
    await expect(page.locator('.workspace-empty-directory')).toContainText('Empty folder');

    const directoryState = await page.evaluate(() => {
      const workspace = window.jvmDebug.getFileProvider().getWorkspaceFileSystem();
      return {
        exists: workspace.existsSync('/src/example/model'),
        directory: workspace.statSync('/src/example/model').isDirectory(),
      };
    });
    expect(directoryState).toEqual({ exists: true, directory: true });
  });

  test('recompiles and paints the linked Java representation for PyramidApplet', async ({ page }) => {
    await page.selectOption('#sampleClassSelect', 'PyramidApplet.class');
    await page.click('#loadBtn');
    await expect(page.locator('#status')).toContainText('PyramidApplet');

    await page.click('[data-workspace="compile"]');
    await expect(page.locator('#workspace-compile')).toBeVisible();
    await expect(page.locator('#java-source-editor')).toContainText('class PyramidApplet');

    await page.click('#compileBtn');
    await expect(page.locator('#compileStatus')).toHaveClass(/success/, {
      timeout: 15000,
    });
    await expect(page.locator('#compiler-output'))
      .toContainText('.class public super PyramidApplet');

    await page.click('#compileRunBtn');
    await expect(page.locator('#workspace-run')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#awt-container canvas')).toBeVisible({ timeout: 15000 });
    await expect.poll(
      () => page.locator('#awt-container canvas').evaluate((canvas) => {
        const context = canvas.getContext('2d');
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let paintedSamples = 0;
        for (let index = 0; index < pixels.length; index += 64) {
          if (pixels[index + 3] !== 0) paintedSamples += 1;
        }
        return paintedSamples;
      }),
      { timeout: 15000, message: 'PyramidApplet should paint a non-transparent first frame' },
    ).toBeGreaterThan(100);
    await expect(page.locator('#status')).not.toContainText('Program failed to run');
  });

  test('keeps Run separate and selects the surface from the launch mode', async ({ page }) => {
    await page.selectOption('#sampleClassSelect', 'Hello.class');
    await page.click('#loadBtn');
    await expect(page.locator('#runtimeModeHint')).toContainText('Application detected');
    await page.click('[data-workspace="run"]');
    await expect(page.locator('#xterm-container')).toBeVisible();
    await expect(page.locator('#awt-container')).toBeHidden();

    await page.click('[data-workspace="disassemble"]');
    await page.selectOption('#sampleClassSelect', 'PyramidApplet.class');
    await page.click('#loadBtn');
    await expect(page.locator('#runtimeModeHint')).toContainText('Applet detected');
    await page.click('[data-workspace="run"]');
    await expect(page.locator('#xterm-container')).toBeHidden();
    await expect(page.locator('#awt-container')).toBeVisible();
    await expect(page.locator('[data-runtime-view="canvas"]'))
      .toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#workspace-debug')).toBeHidden();
  });

  test('shows synchronized code inside the separate Debug workspace', async ({ page }) => {
    await page.click('[data-workspace="debug"]');
    await expect(page.locator('#threadSelect')).toBeDisabled();
    await expect(page.locator('#threadSelect')).toHaveValue('');
    await expect(page.locator('#threadSelect option')).toHaveText('No active threads');
    await expect(page.locator('#xterm-container')).toBeVisible();
    await expect(page.locator('#debug-terminal-slot > #xterm-container')).toHaveCount(1);

    await page.selectOption('#sampleClassSelect', 'Hello.class');
    await page.click('#loadBtn');
    await page.click('#debugBtn');

    await expect(page.locator('#workspace-debug')).toBeVisible();
    await expect(page.locator('#workspace-run')).toBeHidden();
    await expect(page.locator('#threadSelect')).toBeEnabled();
    await expect(page.locator('#threadSelect')).not.toHaveValue('');
    await expect(page.locator('#debug-code-editor')).toContainText('getstatic');
    await expect(page.locator('#debugCodeContext')).toContainText('main');
    await expect(page.locator('#debugCodeContext')).toContainText('PC 0');
    await expect(page.locator('#debug-code-editor .ace_execution_line'))
      .toHaveCount(1);

    await page.click('[data-workspace="run"]');
    await expect(page.locator('#run-terminal-slot > #xterm-container')).toHaveCount(1);
  });

  test('opens a JAR, browses and assembles a class, then runs it', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const archive = fs.readFileSync(path.join(__dirname, '../../dist/data.zip'));

    await page.locator('#classFileInput').setInputFiles({
      name: 'sample-program.jar',
      mimeType: 'application/java-archive',
      buffer: archive,
    });
    await page.click('#loadBtn');

    await expect(page.locator('#jarProjectSummary')).toContainText('sample-program.jar');
    await expect(page.locator('#jarProjectSummary')).toContainText('classes');
    await expect(page.locator('#jarMainClassSelect')).toBeVisible();

    await page.selectOption('#jarMainClassSelect', 'Hello.class');
    await expect.poll(() => page.evaluate(() => window.aceEditor.getValue()))
      .toContain('.class public super Hello');
    await expect(page.locator('#assembleBtn')).toBeEnabled();

    await page.click('#assembleBtn');
    await expect(page.locator('#assemblyStatus')).toHaveClass(/success/);
    await expect(page.locator('#assemblyStatus')).toContainText(
      'assembled and saved in the workspace',
    );

    await page.click('[data-workspace="compile"]');
    await expect(page.locator('#java-source-editor')).toContainText('class Hello');

    await page.click('#runBtn');
    await expect(page.locator('#workspace-run')).toBeVisible();
    await expect(page.locator('#status')).toContainText('completed', { timeout: 15000 });
    expect(pageErrors).toEqual([]);
  });
});
