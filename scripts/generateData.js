#!/usr/bin/env node

/**
 * Generate data for the JVM Debug Interface GitHub Pages site
 * This script prepares sample class files and creates metadata for the web interface
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('🔧 Generating data for JVM Debug Interface...');

// Ensure sources are compiled
console.log('📁 Compiling Java sources...');
try {
    execSync('npm run build:java', { stdio: 'inherit' });
} catch (error) {
    console.error('❌ Failed to compile Java sources:', error.message);
    process.exit(1);
}

// Ensure dist directory exists
const distDir = path.join(process.cwd(), 'dist');
if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
}

// Create data directory in dist
const dataDir = path.join(distDir, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// Copy compiled class files to data directory
console.log('📄 Copying class files...');
const sourcesDir = path.join(process.cwd(), 'sources');
const classFiles = fs.readdirSync(sourcesDir).filter(file => file.endsWith('.class'));

const classMetadata = [];

classFiles.forEach(file => {
    const srcPath = path.join(sourcesDir, file);
    const destPath = path.join(dataDir, file);
    
    fs.copyFileSync(srcPath, destPath);
    
    // Get file stats for metadata
    const stats = fs.statSync(srcPath);
    const className = file.replace('.class', '');
    
    classMetadata.push({
        name: className,
        filename: file,
        size: stats.size,
        description: getClassDescription(className)
    });
    
    console.log(`  ✓ ${file} (${stats.size} bytes)`);
});

// Generate metadata file
const metadata = {
    generated: new Date().toISOString(),
    classes: classMetadata,
    totalFiles: classFiles.length,
    totalSize: classMetadata.reduce((sum, cls) => sum + cls.size, 0)
};

fs.writeFileSync(
    path.join(dataDir, 'metadata.json'), 
    JSON.stringify(metadata, null, 2)
);

// Create a zip file containing all class files for easy download
console.log('📦 Creating data.zip...');
try {
    const zipPath = path.join(distDir, 'data.zip');
    execSync(`cd "${dataDir}" && zip -r "${zipPath}" *.class metadata.json`, { stdio: 'pipe' });
    console.log(`  ✓ Created data.zip (${fs.statSync(zipPath).size} bytes)`);
} catch (error) {
    console.warn('⚠️  Warning: Could not create data.zip (zip command not available)');
}

console.log(`✅ Generated data for ${classFiles.length} class files`);
console.log(`📊 Total size: ${metadata.totalSize} bytes`);

function getClassDescription(className) {
    const descriptions = {
        'Hello': 'Simple Hello World program demonstrating basic output',
        'VerySimple': 'Basic arithmetic demonstration (3-2=1)',
        'RuntimeArithmetic': 'Comprehensive arithmetic operations showcase',
        'Calculator': 'Static method calls with parameters',
        'StringConcatMethod': 'String concatenation using String.concat() method',
        'SimpleStringConcat': 'Compile-time optimized string concatenation',
        'ConstantsTest': 'Integer constant instructions (iconst_0 through iconst_5)',
        'SmallDivisionTest': 'Integer division and remainder operations',
        'ExceptionTest': 'Exception handling demonstration',
        'TestMethods': 'Various method patterns for testing',
        'InvokeVirtualTest': 'Virtual method invocation examples'
    };
    
    return descriptions[className] || `${className} class file for JVM execution`;
}