#!/usr/bin/env node
const { KrakatauWorkspace } = require('../src/KrakatauWorkspace');
const fs = require('fs');

async function generateGraph(classPath, outputFile) {
  try {
    console.log(`Initializing workspace for path: ${classPath}`);
    const workspace = await KrakatauWorkspace.create(classPath);
    const allMethods = workspace.getAllMethods();

    const graph = {};
    const allCalledMethods = new Set();

    for (const method of allMethods) {
      const methodName = `${method.class.className}.${method.name}${method.descriptor}`;
      graph[methodName] = {
        calls: [],
      };

      const calledMethods = workspace.getCalledMethods(method);
      for (const called of calledMethods) {
        const calledMethodName = `${called.className}.${called.methodName}${called.descriptor}`;
        graph[methodName].calls.push(calledMethodName);
        allCalledMethods.add(calledMethodName);
      }
    }

    const rootMethods = Object.keys(graph).filter(methodName => !allCalledMethods.has(methodName));
    const leafMethods = [];

    for (const methodName in graph) {
      const methodNode = graph[methodName];
      if (methodNode.calls.length === 0) {
        leafMethods.push(methodName);
      } else {
        const unresolvedCalls = workspace.getUnresolvedCalls(graph[methodName].calls);
        if (unresolvedCalls.length === methodNode.calls.length) {
          leafMethods.push(methodName);
        }
      }
    }

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
