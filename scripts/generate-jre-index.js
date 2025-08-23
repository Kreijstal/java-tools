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
        const className = `${prefix}${file.slice(0, -3)}`; // Remove .js extension
        const relativePath = `./${prefix}${file}`;

        // Skip if this looks like an index file (contains 'index')
        if (!className.includes('index')) {
          jreClasses[className] = relativePath;
        }
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
    .sort(([a], [b]) => a.localeCompare(b)) // Sort for consistent output
    .map(([className, relativePath]) => `  '${className}': require('${relativePath}')`)
    .join(',\n');

  const fileContent = `// NOTE: This file is GENERATED at build time by scripts/generate-jre-index.js
// DO NOT EDIT MANUALLY - run \`npm run generate-jre-index\` to regenerate
// This file is .gitignored and regenerated during builds for browser compatibility

const jreClasses = {
${classEntries}
};

module.exports = jreClasses;
`;

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