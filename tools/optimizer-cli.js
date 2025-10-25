#!/usr/bin/env node

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
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
  const raw = Array.isArray(value) ? value : [value];
  const tokens = [];
  for (const entry of raw) {
    if (entry === undefined || entry === null) {
      continue;
    }
    if (typeof entry !== 'string') {
      throw new Error('Pass list entries must be strings.');
    }
    for (const token of entry.split(',')) {
      const trimmed = token.trim();
      if (trimmed.length > 0) {
        tokens.push(trimmed);
      }
    }
  }
  const seen = new Set();
  const result = [];
  for (const token of tokens) {
    const resolved = resolvePassName(token);
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      result.push(resolved);
    }
  }
  return result;
}

function parseArgs(argv) {
  const parser = yargs(hideBin(argv))
    .option('input', {
      alias: ['i', 'inputs'],
      type: 'string',
      array: true,
      description: 'Add a .class file or directory containing classes to optimize.',
    })
    .option('classpath', {
      alias: ['c', 'class-path'],
      type: 'string',
      array: true,
      description: 'Additional directories or JARs containing dependency classes.',
    })
    .option('output', {
      alias: 'o',
      type: 'string',
      description: 'Directory where optimized classes will be written.',
    })
    .option('passes', {
      type: 'string',
      array: true,
      description: 'Comma-separated list of passes to run (default: all).',
    })
    .option('max-instructions', {
      alias: ['maxInstructions', 'max_instructions'],
      type: 'string',
      description: 'Override the constant-folding instruction limit.',
      coerce: (value) => {
        const values = Array.isArray(value) ? value : [value];
        const filtered = values.filter((entry) => entry !== undefined && entry !== null);
        if (filtered.length === 0) {
          return undefined;
        }
        const lastValue = filtered[filtered.length - 1];
        return parseNumericOption(lastValue, '--max-instructions');
      },
    })
    .option('max-iterations', {
      alias: ['maxIterations', 'max_iterations'],
      type: 'string',
      description: 'Override the constant-folding iteration limit.',
      coerce: (value) => {
        const values = Array.isArray(value) ? value : [value];
        const filtered = values.filter((entry) => entry !== undefined && entry !== null);
        if (filtered.length === 0) {
          return undefined;
        }
        const lastValue = filtered[filtered.length - 1];
        return parseNumericOption(lastValue, '--max-iterations');
      },
    })
    .option('max-tracked-values', {
      alias: ['maxTrackedValues', 'max_tracked_values'],
      type: 'string',
      description: 'Override the constant-folding tracked value limit.',
      coerce: (value) => {
        const values = Array.isArray(value) ? value : [value];
        const filtered = values.filter((entry) => entry !== undefined && entry !== null);
        if (filtered.length === 0) {
          return undefined;
        }
        const lastValue = filtered[filtered.length - 1];
        return parseNumericOption(lastValue, '--max-tracked-values');
      },
    })
    .option('list-passes', {
      type: 'boolean',
      description: 'List available passes and exit.',
    })
    .option('help', {
      alias: 'h',
      type: 'boolean',
      description: 'Show this help message.',
    })
    .strict()
    .fail((msg, error) => {
      throw error || new Error(msg);
    });

  const parsed = parser.parse();
  const normalize = (value) => {
    if (value === undefined || value === null) {
      return [];
    }
    return Array.isArray(value) ? value : [value];
  };

  const positionalInputs = (parsed._ || [])
    .map((entry) => String(entry))
    .filter((entry) => entry.length > 0);

  const inputs = [...normalize(parsed.input), ...positionalInputs].filter(Boolean);
  const classpath = normalize(parsed.classpath)
    .flatMap((entry) => splitClasspath(entry))
    .filter(Boolean);
  const passes = parsePassList(parsed.passes);

  const limits = {};
  if (parsed.maxInstructions !== undefined) {
    limits.maxInstructions = parsed.maxInstructions;
  }
  if (parsed.maxIterations !== undefined) {
    limits.maxIterations = parsed.maxIterations;
  }
  if (parsed.maxTrackedValues !== undefined) {
    limits.maxTrackedValues = parsed.maxTrackedValues;
  }

  return {
    inputs,
    classpath,
    output: parsed.output || null,
    limits,
    passes,
    help: Boolean(parsed.help),
    listPasses: Boolean(parsed.listPasses),
  };
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
