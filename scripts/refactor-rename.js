#!/usr/bin/env node
const { KrakatauWorkspace } = require('../src/KrakatauWorkspace');
const { SymbolIdentifier } = require('../src/symbols');

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 5) {
    console.error('Usage: node scripts/refactor-rename.js <classPath> <className> <oldMethodName> <newMethodName> <outputDir>');
    console.error('Example: node scripts/refactor-rename.js ./build/classes Example oldMethod newMethod ./output');
    process.exit(1);
  }

  const [classPath, className, oldMethodName, newMethodName, outputDir] = args;

  try {
    // Create workspace and load classes
    const workspace = await KrakatauWorkspace.create(classPath);
    
    // Create symbol identifier for the method to rename
    const symbolIdentifier = new SymbolIdentifier(className, oldMethodName);
    
    // Apply the rename operation and save
    workspace.applyRenameAndSave(symbolIdentifier, newMethodName, outputDir);
    
    console.log('Refactoring completed successfully.');
  } catch (error) {
    console.error(`Refactoring failed: ${error.message}`);
    process.exit(1);
  }
}

main();