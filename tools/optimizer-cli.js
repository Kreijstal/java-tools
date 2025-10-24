#!/usr/bin/env node

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const JSZip = require('jszip');
const { getAST } = require('jvm_parser');
const { convertJson } = require('../src/convert_tree');
const { runOptimizationPasses } = require('../src/passManager');
const { writeClassAstToClassFile } = require('../src/classAstToClassFile');

const AVAILABLE_PASSES = ['inlinePureMethods', 'constantFoldCfg', 'eliminateDeadCodeCfg'];
const PASS_ALIASES = new Map([
  ['inlinepuremethods', 'inlinePureMethods'],
  ['inline', 'inlinePureMethods'],
  ['inlining', 'inlinePureMethods'],
  ['constantfoldcfg', 'constantFoldCfg'],
  ['constantfold', 'constantFoldCfg'],
  ['fold', 'constantFoldCfg'],
  ['eliminatedeadcodecfg', 'eliminateDeadCodeCfg'],
  ['deadcode', 'eliminateDeadCodeCfg'],
  ['dce', 'eliminateDeadCodeCfg'],
]);

for (const name of AVAILABLE_PASSES) {
  PASS_ALIASES.set(name.toLowerCase(), name);
}

function printUsage() {
  const executable = path.relative(process.cwd(), __filename);
  console.log(`Usage: node ${executable} --input <path> [--input <path> ...] --output <dir> [options]\n\n` +
    'Options:\n' +
    '  --input, -i <path>           Add a .class file or directory containing classes to optimize.\n' +
    '  --classpath, -c <paths>      Additional directories or JARs containing dependency classes.\n' +
    '  --output, -o <dir>           Directory where optimized classes will be written.\n' +
    '  --passes <list>              Comma-separated list of passes to run (default: all).\n' +
    '  --max-instructions <n>       Override the constant-folding instruction limit.\n' +
    '  --max-iterations <n>         Override the constant-folding iteration limit.\n' +
    '  --max-tracked-values <n>     Override the constant-folding tracked value limit.\n' +
    '  --list-passes                List available passes and exit.\n' +
    '  --help, -h                   Show this help message.\n');
}

function splitClasspath(value) {
  if (!value) {
    return [];
  }
  return value
    .split(path.delimiter)
    .flatMap((segment) => segment.split(','))
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function parseNumericOption(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative number for ${flag}, received "${value}".`);
  }
  return parsed;
}

function resolvePassName(raw) {
  if (!raw) {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const resolved = PASS_ALIASES.get(normalized);
  if (!resolved) {
    throw new Error(`Unknown optimization pass "${raw}".`);
  }
  return resolved;
}

function parsePassList(value) {
  if (!value) {
    return [];
  }
  const seen = new Set();
  const result = [];
  for (const token of value.split(',')) {
    const resolved = resolvePassName(token);
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      result.push(resolved);
    }
  }
  return result;
}

function parseArgs(argv) {
  const options = {
    inputs: [],
    classpath: [],
    output: null,
    limits: {},
    passes: [],
    help: false,
    listPasses: false,
  };

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    let arg = args[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--list-passes') {
      options.listPasses = true;
      continue;
    }

    let value = null;
    if (arg.startsWith('--')) {
      const eqIndex = arg.indexOf('=');
      if (eqIndex !== -1) {
        value = arg.slice(eqIndex + 1);
        arg = arg.slice(0, eqIndex);
      } else {
        i += 1;
        if (i >= args.length) {
          throw new Error(`Flag ${arg} expects a value.`);
        }
        value = args[i];
      }
    } else if (arg.startsWith('-')) {
      switch (arg) {
        case '-i':
        case '-c':
        case '-o':
          i += 1;
          if (i >= args.length) {
            throw new Error(`Flag ${arg} expects a value.`);
          }
          value = args[i];
          break;
        default:
          throw new Error(`Unknown flag ${arg}.`);
      }
    }

    switch (arg) {
      case '--input':
      case '--inputs':
      case '-i':
        options.inputs.push(value);
        break;
      case '--classpath':
      case '--class-path':
      case '-c':
        options.classpath.push(...splitClasspath(value));
        break;
      case '--output':
      case '-o':
        options.output = value;
        break;
      case '--passes':
        options.passes = parsePassList(value);
        break;
      case '--max-instructions':
      case '--maxInstructions':
      case '--max_instructions':
        options.limits.maxInstructions = parseNumericOption(value, arg);
        break;
      case '--max-iterations':
      case '--maxIterations':
      case '--max_iterations':
        options.limits.maxIterations = parseNumericOption(value, arg);
        break;
      case '--max-tracked-values':
      case '--maxTrackedValues':
      case '--max_tracked_values':
        options.limits.maxTrackedValues = parseNumericOption(value, arg);
        break;
      default:
        if (arg.startsWith('--')) {
          throw new Error(`Unknown flag ${arg}.`);
        }
        // Positional arguments fall back to inputs
        options.inputs.push(arg);
        break;
    }
  }

  options.inputs = options.inputs.filter((entry) => Boolean(entry));
  options.classpath = options.classpath.filter((entry) => Boolean(entry));

  return options;
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function convertClassBuffer(buffer, sourceLabel) {
  try {
    const parsed = getAST(new Uint8Array(buffer));
    const converted = convertJson(parsed.ast, parsed.constantPool);
    const classItem = converted.classes && converted.classes[0];
    if (!classItem) {
      throw new Error('Converted AST did not contain a class definition.');
    }
    return { classItem, constantPool: parsed.constantPool };
  } catch (error) {
    const wrapped = new Error(`Failed to load class from ${sourceLabel}: ${error.message}`);
    wrapped.cause = error;
    throw wrapped;
  }
}

async function collectClassesFromJar(jarPath, register) {
  const buffer = await fsp.readFile(jarPath);
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.keys(zip.files);
  for (const entryName of entries) {
    const entry = zip.file(entryName);
    if (!entry || entry.dir || !entryName.endsWith('.class')) {
      continue;
    }
    const data = await entry.async('nodebuffer');
    const converted = convertClassBuffer(data, `${jarPath}!${entryName}`);
    register(converted, `${jarPath}!${entryName}`);
  }
}

async function collectClassesFromPath(targetPath, register) {
  const stats = await fsp.stat(targetPath);
  if (stats.isDirectory()) {
    const entries = await fsp.readdir(targetPath);
    for (const entry of entries) {
      await collectClassesFromPath(path.join(targetPath, entry), register);
    }
    return;
  }

  if (!stats.isFile()) {
    return;
  }

  if (targetPath.endsWith('.class')) {
    const buffer = await fsp.readFile(targetPath);
    const converted = convertClassBuffer(buffer, targetPath);
    register(converted, targetPath);
    return;
  }

  if (targetPath.endsWith('.jar')) {
    await collectClassesFromJar(targetPath, register);
  }
}

function resolveClassName(entry, fallbackSource) {
  if (entry.classItem && entry.classItem.className) {
    return entry.classItem.className;
  }
  const base = path.basename(fallbackSource, '.class');
  return base.replace(/\\/g, '/');
}

async function loadProgram(inputs, classpath) {
  const classEntries = new Map();

  const register = (converted, source, primary) => {
    const name = resolveClassName(converted, source);
    const existing = classEntries.get(name);
    if (existing) {
      if (primary && !existing.primary) {
        classEntries.set(name, { ...converted, primary: true, source });
      }
      return;
    }
    classEntries.set(name, { ...converted, primary: Boolean(primary), source });
  };

  for (const inputPath of inputs) {
    const resolved = path.resolve(inputPath);
    await collectClassesFromPath(resolved, (entry, source) => register(entry, source, true));
  }

  for (const supportPath of classpath) {
    const resolved = path.resolve(supportPath);
    await collectClassesFromPath(resolved, (entry, source) => {
      const name = resolveClassName(entry, source);
      if (classEntries.has(name) && classEntries.get(name).primary) {
        return;
      }
      register(entry, source, false);
    });
  }

  const primaryClasses = Array.from(classEntries.values()).filter((entry) => entry.primary);
  if (primaryClasses.length === 0) {
    throw new Error('No classes were loaded from the provided input paths.');
  }

  const program = { classes: Array.from(classEntries.values()).map((entry) => entry.classItem) };
  return { program, entries: classEntries, primaryClasses };
}

function summarizePass(pass) {
  const parts = [];
  const status = pass.changed ? 'changed' : 'no change';
  parts.push(`${pass.name} (iteration ${pass.iteration}): ${status}`);
  if (pass.methods && pass.methods.length > 0) {
    parts.push(`  affected methods: ${pass.methods.length}`);
  }
  if (pass.limitHits && pass.limitHits.length > 0) {
    const reasons = pass.limitHits.map((hit) => `${hit.reason} in ${hit.method}`);
    parts.push(`  limit hits: ${reasons.join('; ')}`);
  }
  if (pass.summary) {
    parts.push(`  summary: ${pass.summary}`);
  }
  return parts.join('\n');
}

async function writeOutputs(outputDir, primaryClasses) {
  const written = [];
  for (const entry of primaryClasses) {
    const className = entry.classItem.className || resolveClassName(entry, entry.source);
    const relativePath = className.replace(/\./g, '/').replace(/\\/g, '/');
    const filePath = path.join(outputDir, `${relativePath}.class`);
    writeClassAstToClassFile(entry.classItem, filePath);
    written.push(filePath);
  }
  return written;
}

async function main(argv = process.argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
    return;
  }

  if (options.help) {
    printUsage();
    return;
  }

  if (options.listPasses) {
    console.log('Available passes:');
    for (const name of AVAILABLE_PASSES) {
      console.log(`  - ${name}`);
    }
    return;
  }

  if (!options.inputs || options.inputs.length === 0) {
    console.error('At least one --input path is required.');
    process.exit(1);
    return;
  }

  const outputDir = path.resolve(options.output || path.join(process.cwd(), 'optimized-classes'));
  ensureDirectory(outputDir);

  let loadResult;
  try {
    loadResult = await loadProgram(options.inputs, options.classpath);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
    return;
  }

  const optimizerOptions = {};
  if (options.passes && options.passes.length > 0) {
    optimizerOptions.passes = options.passes;
  }
  if (options.limits && Object.keys(options.limits).length > 0) {
    optimizerOptions.limits = options.limits;
  }

  const { program, primaryClasses } = loadResult;
  const { changed, passes } = runOptimizationPasses(program, optimizerOptions);

  console.log(`Loaded ${program.classes.length} class(es); optimizing ${primaryClasses.length} primary target(s).`);
  if (options.passes && options.passes.length > 0) {
    console.log(`Selected passes: ${options.passes.join(', ')}`);
  } else {
    console.log('Selected passes: all');
  }

  for (const pass of passes) {
    console.log(summarizePass(pass));
  }
  console.log(`Optimization result: ${changed ? 'changes applied' : 'no changes recorded'}.`);

  let written;
  try {
    written = await writeOutputs(outputDir, primaryClasses);
  } catch (error) {
    console.error(`Failed to write optimized classes: ${error.message}`);
    process.exit(1);
    return;
  }

  console.log('Wrote optimized classes:');
  for (const filePath of written) {
    console.log(`  - ${path.relative(process.cwd(), filePath)}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Optimizer CLI failed:', error);
    process.exit(1);
  });
}

module.exports = { main, parseArgs };
