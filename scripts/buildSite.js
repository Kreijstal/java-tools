#!/usr/bin/env node

/**
 * Build the static site for GitHub Pages deployment
 * 
 * Now refactored to be smaller, focused, and modular instead of a monolithic hack.
 * Uses separate modules for utilities and template processing.
 */

const path = require('path');
const fs = require('fs');
const { verifyBuildPrerequisites, ensureDirectory, readFile, writeFile, copyFile } = require('./build-utils');
const { processDebugInterfaceTemplate } = require('./template-processor');

console.log('🏗️  Building JVM Debug Interface site...');

// Define paths
const distDir = path.join(process.cwd(), 'dist');
const libDir = path.join(distDir, 'lib');
const examplesDir = path.join(process.cwd(), 'examples');
const srcDir = path.join(process.cwd(), 'src');

// Function to copy ACE editor from node_modules
async function setupAceEditor() {
    const aceSourceDir = path.join(process.cwd(), 'node_modules', 'ace-builds', 'src-min-noconflict');
    const aceFilePath = path.join(libDir, 'ace.js');
    
    const themeFiles = ['theme-monokai.js', 'theme-github.js', 'theme-textmate.js'];
    const modeFiles = ['mode-text.js', 'mode-java.js'];
    const themeTargets = themeFiles.map((themeFile) => path.join(libDir, themeFile));
    const modeTargets = modeFiles.map((modeFile) => path.join(libDir, modeFile));
    const allAceAssetsExist =
        fs.existsSync(aceFilePath) &&
        themeTargets.every((target) => fs.existsSync(target)) &&
        modeTargets.every((target) => fs.existsSync(target));

    if (allAceAssetsExist) {
        console.log('  ✓ ACE editor already exists');
        return;
    }
    
    console.log('  📦 Copying ACE editor and dependencies from node_modules...');
    ensureDirectory(libDir);
    
    if (!fs.existsSync(aceSourceDir)) {
        throw new Error('ACE editor not found in node_modules. Please run: npm install ace-builds');
    }
    
    // Copy main ACE editor file if needed
    if (!fs.existsSync(aceFilePath)) {
        copyFile(path.join(aceSourceDir, 'ace.js'), aceFilePath);
    }

    // Copy theme files that ACE editor dynamically loads
    for (const themeFile of themeFiles) {
        const themeSourcePath = path.join(aceSourceDir, themeFile);
        const themeTargetPath = path.join(libDir, themeFile);
        if (!fs.existsSync(themeTargetPath) && fs.existsSync(themeSourcePath)) {
            copyFile(themeSourcePath, themeTargetPath);
        }
    }

    // Copy mode files that might be needed
    for (const modeFile of modeFiles) {
        const modeSourcePath = path.join(aceSourceDir, modeFile);
        const modeTargetPath = path.join(libDir, modeFile);
        if (!fs.existsSync(modeTargetPath) && fs.existsSync(modeSourcePath)) {
            copyFile(modeSourcePath, modeTargetPath);
        }
    }
    
    console.log('  ✓ ACE editor and dependencies copied successfully');
}

// Function to copy GoldenLayout css from node_modules (js is bundled into ide-ui.js)
async function setupGoldenLayoutAssets() {
    const glCssDir = path.join(process.cwd(), 'node_modules', 'golden-layout', 'dist', 'css');
    const targets = [
        ['goldenlayout-base.css', path.join(glCssDir, 'goldenlayout-base.css')],
        ['goldenlayout-dark-theme.css', path.join(glCssDir, 'themes', 'goldenlayout-dark-theme.css')],
    ];
    ensureDirectory(libDir);
    for (const [name, source] of targets) {
        const target = path.join(libDir, name);
        if (!fs.existsSync(source)) {
            throw new Error(`GoldenLayout asset missing: ${source}. Please run: npm install golden-layout`);
        }
        if (!fs.existsSync(target)) {
            copyFile(source, target);
        }
    }
    // The dark theme references ../img/lm_*.png icons relative to the page.
    const glImgDir = path.join(process.cwd(), 'node_modules', 'golden-layout', 'dist', 'img');
    const imgTargetDir = path.join(distDir, 'img');
    ensureDirectory(imgTargetDir);
    for (const imageName of fs.readdirSync(glImgDir)) {
        const target = path.join(imgTargetDir, imageName);
        if (!fs.existsSync(target)) {
            copyFile(path.join(glImgDir, imageName), target);
        }
    }
    console.log('  ✓ GoldenLayout css + icons ready');
}

// Function to copy XTerm.js from node_modules
async function setupXtermLibrary() {
    const xtermCSS = path.join(process.cwd(), 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css');
    const xtermJS = path.join(process.cwd(), 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js');
    const fitAddonJS = path.join(process.cwd(), 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js');
    
    const xtermCSSTarget = path.join(libDir, 'xterm.css');
    const xtermJSTarget = path.join(libDir, 'xterm.js');
    const fitAddonJSTarget = path.join(libDir, 'addon-fit.js');
    
    // Check if XTerm files already exist
    if (fs.existsSync(xtermCSSTarget) && fs.existsSync(xtermJSTarget) && fs.existsSync(fitAddonJSTarget)) {
        console.log('  ✓ XTerm.js files already exist');
        return;
    }
    
    console.log('  📦 Copying XTerm.js and FitAddon from node_modules...');
    
    if (!fs.existsSync(xtermCSS) || !fs.existsSync(xtermJS) || !fs.existsSync(fitAddonJS)) {
        console.log('  ⚠️  XTerm.js or FitAddon not found in node_modules - skipping (XTerm features will be disabled)');
        return;
    }
    
    // Copy XTerm files
    copyFile(xtermCSS, xtermCSSTarget);
    copyFile(xtermJS, xtermJSTarget);
    copyFile(fitAddonJS, fitAddonJSTarget);
    console.log('  ✓ Copied: xterm.css');
    console.log('  ✓ Copied: xterm.js');
    console.log('  ✓ Copied: addon-fit.js');
    console.log('  ✓ XTerm.js and FitAddon copied successfully');
}

// Main build function
async function buildSite() {
    // Step 1: Setup and verification
    ensureDirectory(distDir);
    verifyBuildPrerequisites(distDir);

    // Step 1.5: Publish the production bundle name. Downstream embedders
    // (e.g. the blank-github-cloner console) load jvm.js; keep jvm-debug.js
    // for the IDE so both names serve identical bytes.
    const debugBundle = path.join(distDir, 'jvm-debug.js');
    const prodBundle = path.join(distDir, 'jvm.js');
    fs.copyFileSync(debugBundle, prodBundle);
    for (const suffix of ['.map', '.LICENSE.txt']) {
        const sidecar = debugBundle + suffix;
        if (fs.existsSync(sidecar)) {
            fs.copyFileSync(sidecar, prodBundle + suffix);
        }
    }
    console.log('  ✓ Published jvm.js alias of jvm-debug.js');

    // Step 2: Setup ACE editor from node_modules
    console.log('📦 Setting up ACE editor...');
    await setupAceEditor();
    
    // Step 2.5: Setup XTerm.js from node_modules
    console.log('📦 Setting up XTerm.js...');
    await setupXtermLibrary();

    // Step 2.6: Setup GoldenLayout css for the IDE shell
    console.log('📦 Setting up GoldenLayout...');
    await setupGoldenLayoutAssets();

    // Step 3: Copy browser UI enhancement module to dist for inclusion
    console.log('📋 Copying browser UI enhancements...');
    const browserUISource = path.join(srcDir, 'platform', 'browser-ui-enhancements.js');
    const browserUITarget = path.join(distDir, 'browser-ui-enhancements.js');
    copyFile(browserUISource, browserUITarget);

    console.log('📋 Copying workbench interface...');
    copyFile(
        path.join(srcDir, 'platform', 'workbench-ui.js'),
        path.join(distDir, 'workbench-ui.js')
    );
    copyFile(
        path.join(srcDir, 'platform', 'workbench.css'),
        path.join(distDir, 'workbench.css')
    );

    // Step 3.5: Copy AWT framework to dist for browser usage
    console.log('🎨 Copying AWT framework...');
    const awtSource = path.join(srcDir, 'platform', 'awt.js');
    const awtTarget = path.join(distDir, 'awt.js');
    copyFile(awtSource, awtTarget);

    // Step 3.6: Copy browser audio backend to dist for browser injection
    console.log('🔊 Copying WebAudio backend...');
    const webAudioSource = path.join(srcDir, 'platform', 'web-audio.js');
    const webAudioTarget = path.join(distDir, 'web-audio.js');
    copyFile(webAudioSource, webAudioTarget);

    // Step 3.7: Copy browser legacy API backend to dist for browser injection
    console.log('Copying browser legacy API backend...');
    const webLegacySource = path.join(srcDir, 'platform', 'web-legacy.js');
    const webLegacyTarget = path.join(distDir, 'web-legacy.js');
    copyFile(webLegacySource, webLegacyTarget);

    // Step 3.8: Copy the IDE shell page and styles. The webpack build emits
    // dist/ide-ui.js (see webpack.config.js).
    console.log('🖥️  Copying IDE shell...');
    copyFile(
        path.join(srcDir, 'platform', 'ide.html'),
        path.join(distDir, 'index.html')
    );
    copyFile(
        path.join(srcDir, 'platform', 'ide.css'),
        path.join(distDir, 'ide.css')
    );
    if (!fs.existsSync(path.join(distDir, 'ide-ui.js'))) {
        console.log('  ⚠️  dist/ide-ui.js not found - run "npm run build:bundle" (webpack) to build the IDE bundle');
    }

    // Step 4: Process and enhance the classic debug web interface.
    // The IDE is the primary page (index.html); the previous workbench stays
    // available as classic.html.
    console.log('📄 Processing classic debug interface template...');
    const debugInterfacePath = path.join(examplesDir, 'debug-web-interface.html');
    const classicPath = path.join(distDir, 'classic.html');

    const htmlContent = readFile(debugInterfacePath);
    const enhancedHtml = processDebugInterfaceTemplate(htmlContent);
    writeFile(classicPath, enhancedHtml);


    console.log('✅ Site build complete!');
    console.log('🌐 Ready for deployment to GitHub Pages');
    console.log('📦 Real JVM debug logic is now available in the browser!');
}

// Run the build
buildSite().catch(error => {
    console.error('❌ Build failed:', error.message);
    process.exit(1);
});
