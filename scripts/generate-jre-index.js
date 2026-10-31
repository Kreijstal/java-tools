#!/usr/bin/env node

/**
 * JRE Index Generator
 *
 * This script generates src/jre/index.js at build time by scanning the src/jre/ directory.
 * This ensures browser compatibility since browsers can't use Node.js fs module to discover files.
 *
 * Usage: node scripts/generate-jre-index.js
 */

const fs = require('fs');
const path = require('path');

const JRE_DIR = path.join(__dirname, '..', 'src', 'jre');
const OUTPUT_FILE = path.join(JRE_DIR, 'index.js');

function generateJreIndex() {
  console.log('🔍 Scanning JRE directory for class files...');

  const jreClasses = {};

  // Recursively walk the JRE directory
  function walkDirectory(dir, prefix = '') {
    const files = fs.readdirSync(dir);

    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        // Recursively walk subdirectories
        walkDirectory(fullPath, `${prefix}${file}/`);
      } else if (file.endsWith('.js') && file !== 'index.js') {
        // Found a JRE class file (include nested classes with '$' but exclude index files)
        const definition = require(fullPath);
        const classKeys = ['super', 'methods', 'staticMethods', 'fields', 'staticFields', 'isInterface', 'interfaces'];
        if (!definition || typeof definition !== 'object' ||
            !classKeys.some(key => Object.prototype.hasOwnProperty.call(definition, key))) continue;
        const className = `${prefix}${file.slice(0, -3)}`; // Remove .js extension
        const relativePath = `./${prefix}${file}`;

        // Skip if this looks like an index file (contains 'index')
jreClasses[className] = relativePath;
      }
    }
  }

  try {
    walkDirectory(JRE_DIR);
  } catch (error) {
    console.error('❌ Error walking JRE directory:', error.message);
    process.exit(1);
  }

  // Generate the index.js file content
  const classEntries = Object.entries(jreClasses)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) // Locale-independent output
    .map(([className, relativePath]) => `  '${className}': require('${relativePath}')`)
    .join(',\n');

  const fileContent = `// NOTE: This file is GENERATED at build time by scripts/generate-jre-index.js
// DO NOT EDIT MANUALLY - run \`node scripts/generate-jre-index.js\` to regenerate
// This source manifest is tracked so source-only CDN builds can resolve JRE modules.

const jreClasses = {
${classEntries}
};

module.exports = jreClasses;
`;

  if (process.argv.includes('--check')) {
    if (fs.readFileSync(OUTPUT_FILE, 'utf8').replace(/\r\n/g, '\n') !== fileContent) {
      throw new Error('JRE source manifest is stale. Run node scripts/generate-jre-index.js and commit src/jre/index.js.');
    }
    console.log('JRE source manifest is current');
    return;
  }

  // Write the file
  try {
    fs.writeFileSync(OUTPUT_FILE, fileContent, 'utf8');
    console.log(`✅ Generated JRE index with ${Object.keys(jreClasses).length} classes`);
    console.log(`📁 Output: ${OUTPUT_FILE}`);
  } catch (error) {
    console.error('❌ Error writing JRE index file:', error.message);
    process.exit(1);
  }
}

// Run the generator
generateJreIndex();