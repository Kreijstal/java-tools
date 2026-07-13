#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { VERSION, decompilePath } = require('../src/decompiler/cfr');

function usage(exitCode) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage: node scripts/runCfr.js [options] <class-or-jar-or-directory>\n\n`);
  stream.write(`Native JavaScript CFR-style decompiler for java-tools.\n\n`);
  stream.write(`Options:\n`);
  stream.write(`  --version                 Print the JavaScript decompiler version\n`);
  stream.write(`  --outputdir <dir>         Write .java files to a directory instead of stdout\n`);
  stream.write(`  --silent                  Accepted for CFR CLI compatibility\n`);
  stream.write(`  --classpath <path>        Classpath used for hierarchy/type resolution\n`);
  stream.write(`  --diagnostics-json <file> Write machine-readable fallback diagnostics\n`);
  stream.write(`  --fail-on-fallback        Exit non-zero on raw flow or expression placeholders\n`);
  stream.write(`  --help, -h                Show this help text\n`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = { outputDir: null, omitHeader: false, classpath: '', diagnosticsJson: '', failOnFallback: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage(0);
    } else if (arg === '--version') {
      console.log(VERSION);
      process.exit(0);
    } else if (arg === '--outputdir' || arg === '--output-dir') {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a directory`);
      options.outputDir = argv[++i];
    } else if (arg.startsWith('--outputdir=')) {
      options.outputDir = arg.slice('--outputdir='.length);
    } else if (arg === '--silent') {
      options.silent = true;
    } else if (arg === '--classpath') {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a path`);
      options.classpath = argv[++i];
    } else if (arg === '--diagnostics-json') {
      if (i + 1 >= argv.length) throw new Error(`${arg} requires a file`);
      options.diagnosticsJson = argv[++i];
    } else if (arg === '--fail-on-fallback') {
      options.failOnFallback = true;
    } else if (arg === '--removeboilerplate') {
      // Compatibility with a common CFR option. The JS implementation omits
      // bytecode boilerplate by default, so this option is intentionally a no-op.
    } else if (arg.startsWith('--extraclasspath')) {
      // Accepted for compatibility with the old jar wrapper; resolution is
      // local to the parsed class for this JavaScript implementation.
      if (arg === '--extraclasspath' && i + 1 < argv.length) i += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unsupported CFR-JS option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) {
    usage(1);
  }
  return { options, inputPath: positional[0] };
}

function collectDiagnostics(outputs) {
  const files = [];
  const totals = { stackUnderflow: 0, rawControlFlow: 0, placeholders: 0 };
  for (const { name, source } of outputs) {
    const counts = {
      stackUnderflow: (source.match(/stack-underflow/g) || []).length,
      rawControlFlow: (source.match(/^\s*\/\/\s*(?:if|goto|tableswitch|lookupswitch)\b/gm) || []).length,
      placeholders: (source.match(/\/\* unsupported condition|\bstmt_\d+\(\);/g) || []).length,
    };
    for (const key of Object.keys(totals)) totals[key] += counts[key];
    if (Object.values(counts).some((count) => count > 0)) files.push({ name, ...counts });
  }
  return {
    version: VERSION,
    generatedFiles: outputs.length,
    hardFailures: Object.values(totals).reduce((sum, count) => sum + count, 0),
    totals,
    files,
  };
}

function writeOutputs(outputs, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  outputs.forEach(({ name, source }) => {
    const target = path.join(outputDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source.endsWith('\n') ? source : `${source}\n`, 'utf8');
  });
}

async function main() {
  const { options, inputPath } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input not found: ${inputPath}`);
  }
  const outputs = await decompilePath(inputPath, options);
  const diagnostics = collectDiagnostics(outputs);
  if (options.diagnosticsJson) {
    fs.mkdirSync(path.dirname(path.resolve(options.diagnosticsJson)), { recursive: true });
    fs.writeFileSync(options.diagnosticsJson, `${JSON.stringify(diagnostics, null, 2)}\n`, 'utf8');
  }
  if (options.outputDir) {
    writeOutputs(outputs, options.outputDir);
    if (!options.silent) {
      console.log(`Wrote ${outputs.length} Java source file(s) to ${options.outputDir}`);
    }
    if (options.failOnFallback && diagnostics.hardFailures > 0) process.exitCode = 1;
    return;
  }

  outputs.forEach(({ source }, index) => {
    if (index > 0) process.stdout.write('\n');
    process.stdout.write(source);
    if (!source.endsWith('\n')) process.stdout.write('\n');
  });
  if (options.failOnFallback && diagnostics.hardFailures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
