#!/usr/bin/env node
'use strict';

const path = require('path');
const frontend = require('../src/java-frontend');

function printUsage() {
  console.log(`Usage: node scripts/compileJava.js <file.java> [file2.java ...] [--out <dir>] [--source-level <n>] [--strict]

Compiles Java source files with the repository Java frontend and internal Jasmin/classfile backend.
No host javac backend or fallback is used. By default the CLI emits valid bytecode stubs
for unsupported method bodies so the complete provided source corpus can be built.`);
}

function parseArgs(argv) {
  const options = { outputDir: process.cwd(), tolerant: true, stubUnsupportedMethods: true, fallbackUnsupportedTypes: true };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      return { help: true };
    }
    if (arg === '--out' || arg === '-d') {
      if (i + 1 >= argv.length) {
        throw new Error(`${arg} requires an output directory`);
      }
      options.outputDir = argv[++i];
      continue;
    }
    if (arg === '--strict') {
      options.tolerant = false;
      options.stubUnsupportedMethods = false;
      options.fallbackUnsupportedTypes = false;
      continue;
    }
    if (arg === '--source-level') {
      if (i + 1 >= argv.length) {
        throw new Error('--source-level requires a number');
      }
      options.sourceLevel = Number.parseInt(argv[++i], 10);
      continue;
    }
    positional.push(arg);
  }
  if (positional.length === 0) {
    throw new Error('compileJava requires at least one .java input file');
  }
  return { inputPaths: positional, options };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    printUsage();
    return;
  }
  const options = {
    ...parsed.options,
    sourceFileName: parsed.inputPaths.length === 1 ? path.basename(parsed.inputPaths[0]) : undefined,
  };
  const result = frontend.compileJavaFiles(parsed.inputPaths, options);
  for (const written of result.written) {
    console.log(`Compiled ${written.binaryName} -> ${written.outputPath}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
