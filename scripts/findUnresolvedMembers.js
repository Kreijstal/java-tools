#!/usr/bin/env node
const { KrakatauWorkspace } = require('../src/KrakatauWorkspace');

async function findUnresolved(classPath) {
  try {
    console.log(`Initializing workspace for path: ${classPath}`);
    const workspace = await KrakatauWorkspace.create(classPath);

    console.log('Finding unresolved members...');
    const unresolvedMethods = workspace.findUnresolvedMethods();
    const unresolvedFields = workspace.findUnresolvedFields();

    if (unresolvedMethods.length === 0 && unresolvedFields.length === 0) {
      console.log('No unresolved members found.');
      return;
    }

    const unresolvedByClass = {};

    for (const method of unresolvedMethods) {
      if (!unresolvedByClass[method.className]) {
        unresolvedByClass[method.className] = { methods: [], fields: [] };
      }
      unresolvedByClass[method.className].methods.push(method);
    }

    for (const field of unresolvedFields) {
      if (!unresolvedByClass[field.className]) {
        unresolvedByClass[field.className] = { methods: [], fields: [] };
      }
      unresolvedByClass[field.className].fields.push(field);
    }

    console.log('Unresolved members found:');

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

      const { methods, fields } = unresolvedByClass[className];

      if (methods.length > 0) {
        console.log('    Unresolved Methods:');
        for (const method of methods) {
          const staticLabel = method.isStatic ? ' (static)' : '';
          console.log(`      - ${method.memberName}${method.descriptor}${staticLabel}`);
        }
      }

      if (fields.length > 0) {
        console.log('    Unresolved Fields:');
        for (const field of fields) {
          console.log(`      - ${field.memberName} ${field.descriptor}`);
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
    console.error('Usage: node scripts/findUnresolvedMembers.js <classPath>');
    process.exit(1);
  }

  const classPath = args[0];
  findUnresolved(classPath);
}

main();
