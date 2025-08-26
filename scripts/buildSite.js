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
    
    // Check if ACE editor already exists
    if (fs.existsSync(aceFilePath)) {
        console.log('  ✓ ACE editor already exists');
        return;
    }
    
    console.log('  📦 Copying ACE editor and dependencies from node_modules...');
    ensureDirectory(libDir);
    
    if (!fs.existsSync(aceSourceDir)) {
        throw new Error('ACE editor not found in node_modules. Please run: npm install ace-builds');
    }
    
    // Copy main ACE editor file
    copyFile(path.join(aceSourceDir, 'ace.js'), aceFilePath);
    
    // Copy theme files that ACE editor dynamically loads
    const themeFiles = ['theme-monokai.js', 'theme-github.js', 'theme-textmate.js'];
    for (const themeFile of themeFiles) {
        const themeSourcePath = path.join(aceSourceDir, themeFile);
        const themeTargetPath = path.join(libDir, themeFile);
        if (fs.existsSync(themeSourcePath)) {
            copyFile(themeSourcePath, themeTargetPath);
        }
    }
    
    // Copy mode files that might be needed
    const modeFiles = ['mode-text.js', 'mode-java.js'];
    for (const modeFile of modeFiles) {
        const modeSourcePath = path.join(aceSourceDir, modeFile);
        const modeTargetPath = path.join(libDir, modeFile);
        if (fs.existsSync(modeSourcePath)) {
            copyFile(modeSourcePath, modeTargetPath);
        }
    }
    
    console.log('  ✓ ACE editor and dependencies copied successfully');
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

    // Step 2: Setup ACE editor from node_modules
    console.log('📦 Setting up ACE editor...');
    await setupAceEditor();
    
    // Step 2.5: Setup XTerm.js from node_modules
    console.log('📦 Setting up XTerm.js...');
    await setupXtermLibrary();

    // Step 3: Copy browser UI enhancement module to dist for inclusion
    console.log('📋 Copying browser UI enhancements...');
    const browserUISource = path.join(srcDir, 'browser-ui-enhancements.js');
    const browserUITarget = path.join(distDir, 'browser-ui-enhancements.js');
    copyFile(browserUISource, browserUITarget);

    // Step 3.5: Copy AWT framework to dist for browser usage
    console.log('🎨 Copying AWT framework...');
    const awtSource = path.join(srcDir, 'awt.js');
    const awtTarget = path.join(distDir, 'awt.js');
    copyFile(awtSource, awtTarget);


    // Step 4: Process and enhance the debug web interface
    console.log('📄 Processing debug interface template...');
    const debugInterfacePath = path.join(examplesDir, 'debug-web-interface.html');
    const indexPath = path.join(distDir, 'index.html');

    const htmlContent = readFile(debugInterfacePath);
    const enhancedHtml = processDebugInterfaceTemplate(htmlContent);
    writeFile(indexPath, enhancedHtml);


    console.log('✅ Site build complete!');
    console.log('🌐 Ready for deployment to GitHub Pages');
    console.log('📦 Real JVM debug logic is now available in the browser!');
}

// Run the build
buildSite().catch(error => {
    console.error('❌ Build failed:', error.message);
    process.exit(1);
});
