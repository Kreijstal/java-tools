#!/usr/bin/env node

/**
 * Build the static site for GitHub Pages deployment
 * 
 * Now refactored to be smaller, focused, and modular instead of a monolithic hack.
 * Uses separate modules for utilities and template processing.
 */

const path = require('path');
const { verifyBuildPrerequisites, ensureDirectory, readFile, writeFile, copyFile } = require('./build-utils');
const { processDebugInterfaceTemplate, createSiteReadme } = require('./template-processor');

console.log('🏗️  Building JVM Debug Interface site...');

// Define paths
const distDir = path.join(process.cwd(), 'dist');
const examplesDir = path.join(process.cwd(), 'examples');
const srcDir = path.join(process.cwd(), 'src');

// Step 1: Setup and verification
ensureDirectory(distDir);
verifyBuildPrerequisites(distDir);

// Step 2: Copy browser UI enhancement module to dist for inclusion
console.log('📋 Copying browser UI enhancements...');
const browserUISource = path.join(srcDir, 'browser-ui-enhancements.js');
const browserUITarget = path.join(distDir, 'browser-ui-enhancements.js');
copyFile(browserUISource, browserUITarget);

// Step 3: Process and enhance the debug web interface
console.log('📄 Processing debug interface template...');
const debugInterfacePath = path.join(examplesDir, 'debug-web-interface.html');
const indexPath = path.join(distDir, 'index.html');

const htmlContent = readFile(debugInterfacePath);
const enhancedHtml = processDebugInterfaceTemplate(htmlContent);
writeFile(indexPath, enhancedHtml);

// Step 4: Create README for the GitHub Pages site
console.log('📝 Creating site README...');
const readmePath = path.join(distDir, 'README.md');
const readmeContent = createSiteReadme();
writeFile(readmePath, readmeContent);

console.log('✅ Site build complete!');
console.log('🌐 Ready for deployment to GitHub Pages');
console.log('📦 Real JVM debug logic is now available in the browser!');