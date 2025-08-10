#!/usr/bin/env node

/**
 * KrakatauWorkspace Demo
 * 
 * This script demonstrates the capabilities of the KrakatauWorkspace API
 * for Java bytecode analysis and refactoring.
 */

const { KrakatauWorkspace, SymbolIdentifier } = require('../src/KrakatauWorkspace');
const path = require('path');

async function runDemo() {
  console.log('🚀 KrakatauWorkspace Demo\n');
  
  try {
    // Create workspace
    console.log('📁 Creating workspace from sources directory...');
    const sourcesPath = path.join(__dirname, '..', 'sources');
    const workspace = await KrakatauWorkspace.create(sourcesPath);
    console.log('✅ Workspace created successfully\n');

    // List all classes
    console.log('📋 Classes in workspace:');
    const classes = workspace.listClasses();
    classes.slice(0, 5).forEach(cls => {
      console.log(`  - ${cls.identifier.className} (${cls.kind})`);
    });
    console.log(`  ... and ${classes.length - 5} more\n`);

    // Analyze TestMethods class
    console.log('🔍 Analyzing TestMethods class:');
    const methods = workspace.listMethods('TestMethods');
    console.log(`  Methods found: ${methods.length}`);
    methods.forEach(method => {
      console.log(`    - ${method.identifier.memberName}${method.descriptor} [${method.flags.join(', ')}]`);
    });
    console.log();

    // Find symbol references
    console.log('🔗 Finding references to publicMethod1:');
    const methodId = new SymbolIdentifier('TestMethods', 'publicMethod1');
    const references = workspace.findReferences(methodId);
    console.log(`  Found ${references.length} references:`);
    references.forEach(ref => {
      console.log(`    - ${ref.className} at ${ref.astPath}`);
    });
    console.log();

    // Analyze dependencies
    console.log('📊 Dependency analysis:');
    const callees = workspace.findCallees(new SymbolIdentifier('TestMethods', 'publicMethod1', '()V'));
    console.log(`  publicMethod1 calls ${callees.length} symbols:`);
    callees.forEach(callee => {
      console.log(`    - ${callee.identifier.className}.${callee.identifier.memberName || '(class)'}`);
    });
    console.log();

    // Show inheritance hierarchy
    console.log('🏗️ Inheritance hierarchy for TestMethods:');
    const superTypes = workspace.getSupertypeHierarchy('TestMethods');
    console.log(`  Supertypes: ${superTypes.length > 0 ? superTypes.map(t => t.identifier.className).join(' -> ') : 'None (extends Object)'}`);
    console.log();

    // Find unused symbols
    console.log('🧹 Finding unused symbols:');
    const unusedSymbols = workspace.findUnusedSymbols();
    console.log(`  Found ${unusedSymbols.length} potentially unused symbols:`);
    unusedSymbols.slice(0, 3).forEach(symbol => {
      console.log(`    - ${symbol.identifier.className}.${symbol.identifier.memberName} (${symbol.kind})`);
    });
    if (unusedSymbols.length > 3) {
      console.log(`    ... and ${unusedSymbols.length - 3} more`);
    }
    console.log();

    // Demonstrate refactoring preparation
    console.log('⚡ Preparing refactoring operation:');
    try {
      const edit = workspace.prepareRename(
        new SymbolIdentifier('TestMethods', 'publicMethod1', '()V'),
        'renamedPublicMethod'
      );
      console.log(`  ✅ Rename operation prepared with ${edit.operations.length} changes`);
      
      // Show what the assembly looks like before changes
      console.log('\n📄 Current TestMethods assembly (first 10 lines):');
      const assembly = workspace.toKrakatauAssembly('TestMethods');
      const lines = assembly.split('\n').slice(0, 10);
      lines.forEach((line, index) => {
        console.log(`  ${String(index + 1).padStart(2)}: ${line}`);
      });
      console.log('  ... (output truncated)');
      
    } catch (error) {
      console.log(`  ⚠️  Refactoring preparation encountered an issue: ${error.message}`);
    }
    console.log();

    // Workspace validation
    console.log('✅ Workspace validation:');
    const diagnostics = workspace.validateWorkspace();
    if (diagnostics.length === 0) {
      console.log('  No issues found');
    } else {
      console.log(`  Found ${diagnostics.length} issues:`);
      diagnostics.slice(0, 3).forEach(diagnostic => {
        console.log(`    - ${diagnostic.severity}: ${diagnostic.message}`);
      });
    }
    console.log();

    console.log('🎉 Demo completed successfully!');
    console.log('\nThe KrakatauWorkspace provides a comprehensive API for:');
    console.log('  • Loading and analyzing Java bytecode');
    console.log('  • Finding symbol definitions and references');
    console.log('  • Analyzing dependencies and call graphs');
    console.log('  • Preparing refactoring operations');
    console.log('  • Validating workspace integrity');
    console.log('  • Converting between AST and assembly formats');

  } catch (error) {
    console.error('❌ Demo failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  runDemo();
}

module.exports = { runDemo };