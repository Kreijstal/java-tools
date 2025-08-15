#!/usr/bin/env node
const { KrakatauWorkspace } = require('../src/KrakatauWorkspace');

async function findUnresolved(classPath) {
  try {
    console.log(`Initializing workspace for path: ${classPath}`);
    const workspace = await KrakatauWorkspace.create(classPath);

    console.log('Finding unresolved methods...');
    const unresolvedMethods = workspace.findUnresolvedMethods();

    if (unresolvedMethods.length === 0) {
      console.log('No unresolved methods found.');
    } else {
      console.log('Unresolved methods found:');
      const unresolvedByClass = {};
      for (const method of unresolvedMethods) {
          if (!unresolvedByClass[method.className]) {
              unresolvedByClass[method.className] = [];
          }
          unresolvedByClass[method.className].push(method);
      }

      for (const className in unresolvedByClass) {
          console.log(`\n  In class ${className}:`);
          const hierarchy = workspace.getSupertypeHierarchy(className);
          if (hierarchy.length > 0) {
              const hierarchyString = hierarchy.map(def => {
                  const status = workspace.workspaceASTs[def.identifier.className] ? '' : ' [not in workspace]';
                  return `${def.identifier.className}${status}`;
              }).join(' -> ');
              console.log(`      Hierarchy: ${className} -> ${hierarchyString}`);
          }

          for (const method of unresolvedByClass[className]) {
              console.log(`    - ${method.memberName}${method.descriptor}`);
          }
      }
    }
  } catch (error) {
    console.error('An error occurred:', error);
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('Usage: node scripts/findUnresolvedMethods.js <classPath>');
    process.exit(1);
  }

  const classPath = args[0];
  findUnresolved(classPath);
}

main();
