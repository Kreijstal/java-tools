#!/usr/bin/env node
'use strict';

const path = require('path');
const frontend = require('../src/java-frontend');
const { createCompileProgressReporter } = require('./compile-progress');

function printUsage() {
  console.log(`Usage: node scripts/compileJava.js <file.java> [file2.java ...] [--out <dir>] [--source-level <n>]
                                   [--incremental|--rebuild] [--progress|--no-progress]

Compiles Java source files with the repository Java frontend and internal Jasmin/classfile backend.
No host javac backend or fallback is used. Unsupported constructs fail fast.

Progress is reported on stderr, one line per file per phase, whenever more than
one input is given; --no-progress silences it and --progress forces it on for a
single file.

--incremental reuses class files from a previous run whose sources have not
changed, so an interrupted batch resumes where it stopped. --rebuild compiles
everything and refreshes that cache.
`);
}

function parseArgs(argv) {
  const options = { outputDir: process.cwd() };
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
    if (arg === '--incremental') {
      options.incremental = true;
      continue;
    }
    if (arg === '--rebuild') {
      options.incremental = { force: true };
      continue;
    }
    if (arg === '--progress') {
      options.progress = true;
      continue;
    }
    if (arg === '--no-progress') {
      options.progress = false;
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
  const showProgress = parsed.options.progress !== undefined
    ? parsed.options.progress
    : parsed.inputPaths.length > 1;
  const options = {
    ...parsed.options,
    sourceFileName: parsed.inputPaths.length === 1 ? path.basename(parsed.inputPaths[0]) : undefined,
    onProgress: showProgress ? createCompileProgressReporter() : undefined,
  };
  delete options.progress;
  const result = frontend.compileJavaFiles(parsed.inputPaths, options);
  for (const written of result.written) {
    console.log(`Compiled ${written.binaryName} -> ${written.outputPath}`);
  }
  if (result.reused > 0) {
    process.stderr.write(`${result.reused} of ${parsed.inputPaths.length} file(s) reused from the build cache\n`);
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
