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
const { processDebugInterfaceTemplate, createSiteReadme } = require('./template-processor');

console.log('🏗️  Building JVM Debug Interface site...');

// Define paths
const distDir = path.join(process.cwd(), 'dist');
const libDir = path.join(distDir, 'lib');
const examplesDir = path.join(process.cwd(), 'examples');
const srcDir = path.join(process.cwd(), 'src');

// Function to copy ACE editor from node_modules
async function setupAceEditor() {
    const aceSourcePath = path.join(process.cwd(), 'node_modules', 'ace-builds', 'src-min-noconflict', 'ace.js');
    const aceFilePath = path.join(libDir, 'ace.js');
    
    // Check if ACE editor already exists
    if (fs.existsSync(aceFilePath)) {
        console.log('  ✓ ACE editor already exists');
        return;
    }
    
    console.log('  📦 Copying ACE editor from node_modules...');
    ensureDirectory(libDir);
    
    if (!fs.existsSync(aceSourcePath)) {
        throw new Error('ACE editor not found in node_modules. Please run: npm install ace-builds');
    }
    
    copyFile(aceSourcePath, aceFilePath);
    console.log('  ✓ ACE editor copied successfully');
}

// Main build function
async function buildSite() {
    // Step 1: Setup and verification
    ensureDirectory(distDir);
    verifyBuildPrerequisites(distDir);

    // Step 2: Setup ACE editor from node_modules
    console.log('📦 Setting up ACE editor...');
    await setupAceEditor();

    // Step 3: Copy browser UI enhancement module to dist for inclusion
    console.log('📋 Copying browser UI enhancements...');
    const browserUISource = path.join(srcDir, 'browser-ui-enhancements.js');
    const browserUITarget = path.join(distDir, 'browser-ui-enhancements.js');
    copyFile(browserUISource, browserUITarget);

    // Step 4: Process and enhance the debug web interface
    console.log('📄 Processing debug interface template...');
    const debugInterfacePath = path.join(examplesDir, 'debug-web-interface.html');
    const indexPath = path.join(distDir, 'index.html');

    const htmlContent = readFile(debugInterfacePath);
    const enhancedHtml = processDebugInterfaceTemplate(htmlContent);
    writeFile(indexPath, enhancedHtml);

    // Step 5: Create README for the GitHub Pages site
    console.log('📝 Creating site README...');
    const readmePath = path.join(distDir, 'README.md');
    const readmeContent = createSiteReadme();
    writeFile(readmePath, readmeContent);

    console.log('✅ Site build complete!');
    console.log('🌐 Ready for deployment to GitHub Pages');
    console.log('📦 Real JVM debug logic is now available in the browser!');
}

// Run the build
buildSite().catch(error => {
    console.error('❌ Build failed:', error.message);
    process.exit(1);
});