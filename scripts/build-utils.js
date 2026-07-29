/**
 * Build utilities for static site generation
 */

const fs = require('fs');
const path = require('path');

/**
 * Verify that required files exist before proceeding with build
 */
function verifyBuildPrerequisites(distDir) {
    console.log('📦 Verifying build prerequisites...');
    
    const bundlePath = path.join(distDir, 'jvm-debug.js');
    if (!fs.existsSync(bundlePath)) {
        console.error('❌ Bundle not found! Run npm run build:bundle first');
        process.exit(1);
    }
    console.log('  ✓ Browser bundle found');
    
    const manifestPath = path.join(distDir, 'data', 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        console.error('❌ Sample data manifest not found! Run npm run generate first');
        process.exit(1);
    }
    console.log('  ✓ Sample data manifest found');
    
    return true;
}

/**
 * Ensure directory exists, create if needed
 */
function ensureDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        console.log(`  ✓ Created directory: ${dirPath}`);
    }
    return dirPath;
}

/**
 * Copy a file from source to destination
 */
function copyFile(source, destination) {
    if (!fs.existsSync(source)) {
        throw new Error(`Source file does not exist: ${source}`);
    }
    
    fs.copyFileSync(source, destination);
    console.log(`  ✓ Copied: ${path.basename(source)}`);
}

/**
 * Read file with error handling
 */
function readFile(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        throw new Error(`Failed to read file ${filePath}: ${error.message}`);
    }
}

/**
 * Write file with error handling
 */
function writeFile(filePath, content) {
    try {
        fs.writeFileSync(filePath, content);
        console.log(`  ✓ Created: ${path.basename(filePath)}`);
    } catch (error) {
        throw new Error(`Failed to write file ${filePath}: ${error.message}`);
    }
}

module.exports = {
    verifyBuildPrerequisites,
    ensureDirectory,
    copyFile,
    readFile,
    writeFile
};