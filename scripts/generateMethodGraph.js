#!/usr/bin/env node
const { KrakatauWorkspace } = require('../src/KrakatauWorkspace');
const fs = require('fs');

async function generateGraph(classPath, outputFile) {
  try {
    console.log(`Initializing workspace for path: ${classPath}`);
    const workspace = await KrakatauWorkspace.create(classPath);
    const allMethods = workspace.getAllMethods();
    const methodIds = new Set(allMethods.map(method =>
      `${method.class.className}.${method.name}${method.descriptor}`
    ));

    const graph = {};
    const allCalledInternalMethods = new Set();

    for (const method of allMethods) {
      const methodName = `${method.class.className}.${method.name}${method.descriptor}`;
      graph[methodName] = {
        calls: [],
        internalCalls: [],
        externalCalls: [],
      };

      const calledMethods = workspace.getCalledMethods(method);
      for (const called of calledMethods) {
        const calledMethodName = `${called.className}.${called.methodName}${called.descriptor}`;
        graph[methodName].calls.push(calledMethodName);
        if (methodIds.has(calledMethodName)) {
          graph[methodName].internalCalls.push(calledMethodName);
          allCalledInternalMethods.add(calledMethodName);
        } else {
          graph[methodName].externalCalls.push(calledMethodName);
        }
      }
    }

    const rootMethods = Object.keys(graph).filter(methodName => !allCalledInternalMethods.has(methodName));
    const leafMethods = Object.keys(graph).filter(methodName => graph[methodName].internalCalls.length === 0);

    const output = {
      graph,
      rootMethods,
      leafMethods,
    };

    fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
    console.log(`Method graph written to ${outputFile}`);

  } catch (error) {
    console.error('An error occurred:', error);
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error('Usage: node scripts/generateMethodGraph.js <classPath> <outputFile>');
    process.exit(1);
  }

  const [classPath, outputFile] = args;
  generateGraph(classPath, outputFile);
}

main();
