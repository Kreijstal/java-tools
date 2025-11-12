#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { getAST } = require('jvm_parser');
const { convertJson, unparseDataStructures } = require('../src/convert_tree');
const { parseKrak2Assembly } = require('../src/parse_krak2');
const { convertKrak2AstToClassAst } = require('../src/convert_krak2_ast');
const { writeClassAstToClassFile } = require('../src/classAstToClassFile');
const { KrakatauWorkspace } = require('../src/KrakatauWorkspace');
const { runDeadCodePass } = require('../src/deadCodePass');
const { renameClassAst, renameMethodAst } = require('../src/astTransforms');
const { inlineSinglePredecessorBlocks } = require('../src/blockInliner');
const { relocateTrivialHandlers } = require('../src/handlerRelocator');
const { formatJasminSource, normalizeNewlines } = require('../src/jasminFormatter');
const { collectExceptionMetadata } = require('../src/exceptionMetadata');
const { collectMethodCallers } = require('../src/callGraphMetadata');
const { collectFieldReferences } = require('../src/fieldReferenceMetadata');
const { computeMethodEffects } = require('../src/methodEffectsAnalyzer');

const HELP_TEXT = `
Usage: node scripts/jvm-cli.js <command> [options]

Commands:
  assemble <file.j> [--out file.class]              Assemble Jasmin to .class
  disassemble <file.class> [--out file.j] [--stdout] [--xref-classpath paths] Disassemble .class to Jasmin
  lint <file.{j|class}> [--fix] [--out file]        Detect dead-code handler tricks; optionally apply fix
  optimize <file.{j|class}> [--out file]            Apply dead-code optimization (alias for lint --fix)
  throws <file.{j|class}> [--json]                  Report declared & implicit exceptions per method
  callers <file.{j|class}> [--json] [--class C --method M --descriptor desc]
                                                  List callers for methods defined in the file
  fieldrefs <file.{j|class}> [--json] [--class C --field F --descriptor desc]
                                                  List references for fields defined in the file
  format <file.j> [--out file.j] [-n]               Reformat Jasmin source via canonical assembler/disassembler
  rename-class <file> --from Old --to New [options] Rename a class within the file
  rename-method <file> --class C --from old --to new [--descriptor desc] [options]
  workspace list-methods <Class> [--classpath dir]
  workspace list-fields <Class> [--classpath dir]
  workspace list-constants <Class> [--classpath dir]
  workspace describe-class <Class> [--classpath dir]
  workspace find-references --class C [--member m] [--descriptor desc] [--classpath dir]

Options (where supported):
  --out <file>     Write results to the given path (defaults to in-place)
  -n, --dry-run    Do not write changes; print unified diff instead
  --classpath <paths>  (lint/optimize/workspace) classpath roots (platform delimiter, default: sources/)
  --help           Show this message

Examples:
  node scripts/jvm-cli.js assemble examples/sources/jasmin/MisplacedCatch.j
  node scripts/jvm-cli.js lint examples/sources/jasmin/MisplacedCatch.j --fix
  node scripts/jvm-cli.js rename-method examples/sources/jasmin/MisplacedCatch.j \\
      --class MisplacedCatch --from funnel --to funnelSafe
  node scripts/jvm-cli.js format examples/sources/jasmin/MisplacedCatch.j
`;

function printHelp() {
  console.log(HELP_TEXT.trim());
}

function parseCommand(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    return { command: 'help', args: [] };
  }
  const [command, ...args] = argv;
  return { command, args };
}

function ensureFileExists(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
}

function defaultOutPath(inputPath, newExt) {
  const dirname = path.dirname(inputPath);
  const basename = path.basename(inputPath, path.extname(inputPath));
  return path.join(dirname, `${basename}${newExt}`);
}

function parseJasminFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const krak2Ast = parseKrak2Assembly(text);
  const classAst = convertKrak2AstToClassAst(krak2Ast, { sourceText: text });
  return { text, classAst };
}

function assembleCommand(args) {
  let outPath = null;
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--out' || arg === '-o') {
      if (i + 1 >= args.length) throw new Error('--out requires a value');
      outPath = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      return;
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 1) {
    throw new Error('assemble requires exactly one input .j file');
  }

  const inputPath = positional[0];
  ensureFileExists(inputPath);
  if (!outPath) {
    outPath = defaultOutPath(inputPath, '.class');
  }

  const text = fs.readFileSync(inputPath, 'utf8');
  const jasminAst = convertKrak2AstToClassAst(parseKrak2Assembly(text), { sourceText: text });
  writeClassAstToClassFile(jasminAst, outPath);
  console.log(`Assembled ${inputPath} -> ${outPath}`);
}

async function disassembleCommand(args) {
  let outPath = null;
  let toStdout = false;
  let xrefClasspathRaw = null;
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--out' || arg === '-o') {
      if (i + 1 >= args.length) throw new Error('--out requires a value');
      outPath = args[++i];
    } else if (arg === '--stdout') {
      toStdout = true;
    } else if (arg === '--xref-classpath') {
      if (i + 1 >= args.length) throw new Error('--xref-classpath requires a value');
      xrefClasspathRaw = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      return;
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 1) {
    throw new Error('disassemble requires exactly one input .class file');
  }

  const inputPath = positional[0];
  ensureFileExists(inputPath);
  if (!outPath && !toStdout) {
    outPath = defaultOutPath(inputPath, '.j');
  }

  const classBytes = fs.readFileSync(inputPath);
  const parsed = getAST(new Uint8Array(classBytes));
  const converted = convertJson(parsed.ast, parsed.constantPool);
  let xrefClasspath = splitClasspath(xrefClasspathRaw);
  if (!xrefClasspath) {
    const defaultSources = path.join(process.cwd(), 'sources');
    if (fs.existsSync(defaultSources)) {
      xrefClasspath = [defaultSources];
    }
  }
  let crossReferenceOptions = null;
  if (xrefClasspath && xrefClasspath.length > 0) {
    try {
      const workspace = await KrakatauWorkspace.create(xrefClasspath);
      const artifactClasses = converted.classes || [];
      const artifactClassNames = new Set(artifactClasses.map((cls) => cls.className));
      let analysisClasses = artifactClasses;
      if (workspace && workspace.workspaceASTs) {
        analysisClasses = artifactClasses.slice();
        Object.values(workspace.workspaceASTs).forEach((entry) => {
          if (!entry || !entry.ast || !entry.ast.classes || !entry.ast.classes.length) return;
          const cls = entry.ast.classes[0];
          if (artifactClassNames.has(cls.className)) {
            return;
          }
          analysisClasses.push(cls);
        });
      }
      const analysisAst =
        analysisClasses === artifactClasses ? converted : { classes: analysisClasses };
      const methodEntries = collectMethodCallers(analysisAst);
      const fieldEntries = collectFieldReferences(analysisAst);
      const crossReferenceIndex = buildCrossReferenceIndex(
        methodEntries,
        fieldEntries,
        artifactClassNames,
      );
      if (crossReferenceIndex && crossReferenceIndex.size > 0) {
        crossReferenceOptions = { crossReferenceIndex };
      }
    } catch (err) {
      console.warn(`Warning: failed to build cross references (${err.message})`);
    }
  }
  const jasmin = generateJasminText(converted, parsed.constantPool, crossReferenceOptions || {});
  if (toStdout || outPath === '-') {
    process.stdout.write(jasmin);
    if (!jasmin.endsWith('\n')) {
      process.stdout.write('\n');
    }
  } else {
    fs.writeFileSync(outPath, jasmin, 'utf8');
    console.log(`Disassembled ${inputPath} -> ${outPath}`);
  }
}

function loadArtifact(inputPath) {
  const ext = path.extname(inputPath).toLowerCase();
  const cleanupTasks = [];
  let astRoot;
  let constantPool;
  let format;
  let originalPath = inputPath;
  let baselineJasmin = null;

  if (ext === '.j') {
    const { text, classAst } = parseJasminFile(inputPath);
    baselineJasmin = text;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-cli-asm-'));
    const tempClass = path.join(tempDir, 'temp.class');
    writeClassAstToClassFile(classAst, tempClass);
    const classBytes = fs.readFileSync(tempClass);
    const parsed = getAST(new Uint8Array(classBytes));
    astRoot = convertJson(parsed.ast, parsed.constantPool);
    constantPool = parsed.constantPool;
    format = 'jasmin';
    cleanupTasks.push(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  } else if (ext === '.class') {
    const classBytes = fs.readFileSync(inputPath);
    const parsed = getAST(new Uint8Array(classBytes));
    astRoot = convertJson(parsed.ast, parsed.constantPool);
    constantPool = parsed.constantPool;
    format = 'class';
    baselineJasmin = generateJasminText(astRoot, constantPool);
  } else {
    throw new Error(`Unsupported file extension: ${ext}`);
  }

  if (baselineJasmin == null) {
    baselineJasmin = fs.readFileSync(inputPath, 'utf8');
  }

  return {
    format,
    astRoot,
    constantPool,
    inputPath: originalPath,
    baselineJasmin,
    cleanup: () => cleanupTasks.forEach((fn) => fn()),
  };
}

function generateJasminText(astRoot, constantPool, options = {}) {
  if (!astRoot || !astRoot.classes) {
    return '';
  }
  const { crossReferenceIndex = null, withComments = false } = options;
  return astRoot.classes
    .map((cls) => {
      const crossReferences =
        crossReferenceIndex && crossReferenceIndex.get(cls.className);
      return unparseDataStructures(cls, constantPool, {
        withComments,
        crossReferences,
      });
    })
    .join('\n');
}

function splitClasspath(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const entries = value.split(path.delimiter).filter(Boolean);
  return entries.length ? entries : null;
}

function resolveInputPath(inputPath, classpathEntries) {
  if (fs.existsSync(inputPath)) {
    return inputPath;
  }
  if (classpathEntries && classpathEntries.length) {
    for (const base of classpathEntries) {
      const candidate = path.join(base, inputPath);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return inputPath;
}

function mergeWithWorkspaceClasses(astRoot, workspace) {
  const artifactClasses = (astRoot && astRoot.classes) || [];
  const merged = artifactClasses.slice();
  const classNames = new Set(artifactClasses.map((cls) => cls.className));
  Object.values(workspace.workspaceASTs || {}).forEach((entry) => {
    if (!entry || !entry.ast || !entry.ast.classes || !entry.ast.classes.length) {
      return;
    }
    entry.ast.classes.forEach((cls) => {
      if (!classNames.has(cls.className)) {
        merged.push(cls);
      }
    });
  });
  return { classes: merged };
}

function compareMethodRefs(a, b) {
  if (a.className !== b.className) {
    return a.className.localeCompare(b.className);
  }
  if (a.methodName !== b.methodName) {
    return a.methodName.localeCompare(b.methodName);
  }
  return (a.descriptor || '').localeCompare(b.descriptor || '');
}

function compareFieldRefs(a, b) {
  if (a.className !== b.className) {
    return a.className.localeCompare(b.className);
  }
  if (a.methodName !== b.methodName) {
    return a.methodName.localeCompare(b.methodName);
  }
  if ((a.descriptor || '') !== (b.descriptor || '')) {
    return (a.descriptor || '').localeCompare(b.descriptor || '');
  }
  return (a.op || '').localeCompare(b.op || '');
}

function ensureCrossReferenceBucket(index, className) {
  let bucket = index.get(className);
  if (!bucket) {
    bucket = { methods: Object.create(null), fields: Object.create(null) };
    index.set(className, bucket);
  }
  return bucket;
}

function buildCrossReferenceIndex(methodEntries, fieldEntries, classFilter) {
  const index = new Map();
  methodEntries.forEach((entry) => {
    if (classFilter && !classFilter.has(entry.className)) {
      return;
    }
    const bucket = ensureCrossReferenceBucket(index, entry.className);
    const key = `${entry.methodName}${entry.descriptor}`;
    const callers = Array.isArray(entry.callers) ? entry.callers.slice() : [];
    callers.sort(compareMethodRefs);
    if (callers.length) {
      bucket.methods[key] = callers;
    }
  });
  fieldEntries.forEach((entry) => {
    if (classFilter && !classFilter.has(entry.className)) {
      return;
    }
    const bucket = ensureCrossReferenceBucket(index, entry.className);
    const key = `${entry.fieldName}:${entry.descriptor}`;
    const refs = Array.isArray(entry.references) ? entry.references.slice() : [];
    refs.sort(compareFieldRefs);
    if (refs.length) {
      bucket.fields[key] = refs;
    }
  });
  return index;
}

function writeArtifact(artifact, outputPath) {
  const targetPath = outputPath || artifact.inputPath;
  const ext = path.extname(targetPath).toLowerCase();
  if (ext === '.j') {
    const text = generateJasminText(artifact.astRoot, artifact.constantPool);
    fs.writeFileSync(targetPath, text, 'utf8');
  } else {
    writeClassAstToClassFile(artifact.astRoot, targetPath);
  }
  console.log(`Wrote ${targetPath}`);
}

function showDiff(beforeText, afterText) {
  if (beforeText === afterText) {
    console.log('No changes.');
    return;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jvm-cli-diff-'));
  const beforePath = path.join(tmpDir, 'before.j');
  const afterPath = path.join(tmpDir, 'after.j');
  fs.writeFileSync(beforePath, beforeText, 'utf8');
  fs.writeFileSync(afterPath, afterText, 'utf8');
  const diff = spawnSync('diff', ['-u', beforePath, afterPath], { encoding: 'utf8' });
  if (diff.stdout) {
    process.stdout.write(diff.stdout);
  } else {
    console.log('Changes detected (diff command unavailable).');
    console.log('--- before');
    console.log(beforeText);
    console.log('+++ after');
    console.log(afterText);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function lintOrOptimizeCommand(args, { applyFix }) {
  let outPath = null;
  let dryRun = false;
  let fix = applyFix;
  let classpathRaw = null;
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--out' || arg === '-o') {
      if (i + 1 >= args.length) throw new Error('--out requires a value');
      outPath = args[++i];
    } else if (arg === '--fix') {
      fix = true;
    } else if (arg === '-n' || arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--classpath' || arg === '-cp') {
      if (i + 1 >= args.length) throw new Error('--classpath requires a value');
      classpathRaw = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      return;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) {
    throw new Error(`${applyFix ? 'optimize' : 'lint'} requires exactly one input file`);
  }
  let classpathEntries = splitClasspath(classpathRaw);
  if (!classpathEntries) {
    const defaultSources = path.join(process.cwd(), 'sources');
    if (fs.existsSync(defaultSources)) {
      classpathEntries = [defaultSources];
    }
  }
  const inputPath = resolveInputPath(positional[0], classpathEntries);
  ensureFileExists(inputPath);
  const artifact = loadArtifact(inputPath);
  try {
    let methodEffects = null;
    if (classpathEntries && classpathEntries.length) {
      try {
        const workspace = await KrakatauWorkspace.create(classpathEntries);
        const mergedAst = mergeWithWorkspaceClasses(artifact.astRoot, workspace);
        methodEffects = computeMethodEffects(mergedAst);
      } catch (err) {
        console.warn(`Warning: failed to load workspace (${err.message}); falling back to file-only analysis.`);
      }
    }
    if (!methodEffects) {
      methodEffects = computeMethodEffects(artifact.astRoot);
    }
    const inlineResult = inlineSinglePredecessorBlocks(artifact.astRoot);
    const inlineDiagnostics = inlineResult.merges.map((merge) => ({
      className: merge.className,
      methodName: merge.methodName,
      descriptor: merge.descriptor,
      message: `Inlined unique-target block ${merge.label} into its predecessor.`,
    }));
    const relocation = relocateTrivialHandlers(artifact.astRoot);
    const relocationDiagnostics = relocation.relocations.map((reloc) => ({
      className: reloc.className,
      methodName: reloc.methodName,
      descriptor: reloc.descriptor,
      message: `Relocated trivial handler ${reloc.handlerLabel} to the method epilogue.`,
    }));
    const { diagnostics: deadCodeDiagnostics, changed: dceChanged } = runDeadCodePass(
      artifact.astRoot,
      { methodEffects },
    );
    const allDiagnostics = inlineDiagnostics
      .concat(relocationDiagnostics)
      .concat(deadCodeDiagnostics);
    if (allDiagnostics.length === 0) {
      console.log('No issues detected.');
    } else {
      allDiagnostics.forEach((diag, index) => {
        console.log(
          `${index + 1}) ${diag.className}.${diag.methodName}${diag.descriptor} - ${diag.message}`,
        );
      });
    }
    const changed = inlineResult.changed || relocation.changed || dceChanged;
    if (!fix || !changed) {
      if (fix && !changed) {
        console.log('No fixes applied.');
      }
      return;
    }
    const newText = generateJasminText(artifact.astRoot, artifact.constantPool);
    if (dryRun) {
      showDiff(artifact.baselineJasmin, newText);
      return;
    }
    writeArtifact(artifact, outPath);
  } finally {
    artifact.cleanup();
  }
}

function throwsMetadataCommand(args) {
  let outputFormat = 'text';
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') {
      outputFormat = 'json';
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      return;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) {
    throw new Error('throws requires exactly one input file');
  }
  const inputPath = positional[0];
  ensureFileExists(inputPath);
  const artifact = loadArtifact(inputPath);
  try {
    const metadata = collectExceptionMetadata(artifact.astRoot);
    if (outputFormat === 'json') {
      process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
      return;
    }
    if (!metadata.length) {
      console.log('No methods found.');
      return;
    }
    metadata.forEach((entry) => {
      console.log(`${entry.className}.${entry.methodName}${entry.descriptor}`);
      const declaredText = entry.declared.length ? entry.declared.join(', ') : '(none)';
      const implicitText = entry.implicit.length ? entry.implicit.join(', ') : '(none)';
      console.log(`  declared: ${declaredText}`);
      console.log(`  implicit: ${implicitText}`);
    });
  } finally {
    artifact.cleanup();
  }
}

async function callersMetadataCommand(args) {
  let outputFormat = 'text';
  let filterClass = null;
  let filterMethod = null;
  let filterDescriptor = null;
  let classpath = null;
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') {
      outputFormat = 'json';
    } else if (arg === '--class') {
      if (i + 1 >= args.length) throw new Error('--class requires a value');
      filterClass = args[++i];
    } else if (arg === '--method') {
      if (i + 1 >= args.length) throw new Error('--method requires a value');
      filterMethod = args[++i];
    } else if (arg === '--descriptor' || arg === '-d') {
      if (i + 1 >= args.length) throw new Error('--descriptor requires a value');
      filterDescriptor = args[++i];
    } else if (arg === '--classpath' || arg === '-cp') {
      if (i + 1 >= args.length) throw new Error('--classpath requires a value');
      classpath = args[++i].split(path.delimiter);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      return;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) {
    throw new Error('callers requires exactly one input file');
  }
  const inputPath = positional[0];
  ensureFileExists(inputPath);
  const artifact = loadArtifact(inputPath);
  try {
    const artifactClasses = artifact.astRoot.classes || [];
    const artifactClassNames = new Set(artifactClasses.map((cls) => cls.className));
    let analysisClasses = artifactClasses;
    if (classpath && classpath.length) {
      analysisClasses = artifactClasses.slice();
      const workspace = await KrakatauWorkspace.create(classpath);
      Object.values(workspace.workspaceASTs || {}).forEach((entry) => {
        if (!entry || !entry.ast || !entry.ast.classes || !entry.ast.classes.length) return;
        const cls = entry.ast.classes[0];
        if (artifactClassNames.has(cls.className)) {
          return;
        }
        analysisClasses.push(cls);
      });
    }
    const analysisAst =
      analysisClasses === artifactClasses
        ? artifact.astRoot
        : { classes: analysisClasses };
    let metadata = collectMethodCallers(analysisAst);
    metadata = metadata.filter((entry) => artifactClassNames.has(entry.className));
    metadata = metadata.filter((entry) => {
      if (filterClass && entry.className !== filterClass) {
        return false;
      }
      if (filterMethod && entry.methodName !== filterMethod) {
        return false;
      }
      if (filterDescriptor && entry.descriptor !== filterDescriptor) {
        return false;
      }
      return true;
    });
    if (outputFormat === 'json') {
      process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
      return;
    }
    if (!metadata.length) {
      console.log('No matching methods.');
      return;
    }
    metadata.forEach((entry) => {
      console.log(`${entry.className}.${entry.methodName}${entry.descriptor}`);
      if (!entry.callers.length) {
        console.log('  callers: (none)');
        return;
      }
      console.log('  callers:');
      entry.callers.forEach((caller) => {
        console.log(
          `    ${caller.className}.${caller.methodName}${caller.descriptor}`,
        );
      });
    });
  } finally {
    artifact.cleanup();
  }
}

async function fieldRefsCommand(args) {
  let outputFormat = 'text';
  let filterClass = null;
  let filterField = null;
  let filterDescriptor = null;
  let classpath = null;
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') {
      outputFormat = 'json';
    } else if (arg === '--class') {
      if (i + 1 >= args.length) throw new Error('--class requires a value');
      filterClass = args[++i];
    } else if (arg === '--field') {
      if (i + 1 >= args.length) throw new Error('--field requires a value');
      filterField = args[++i];
    } else if (arg === '--descriptor' || arg === '-d') {
      if (i + 1 >= args.length) throw new Error('--descriptor requires a value');
      filterDescriptor = args[++i];
    } else if (arg === '--classpath' || arg === '-cp') {
      if (i + 1 >= args.length) throw new Error('--classpath requires a value');
      classpath = args[++i].split(path.delimiter);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      return;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) {
    throw new Error('fieldrefs requires exactly one input file');
  }
  const inputPath = positional[0];
  ensureFileExists(inputPath);
  const artifact = loadArtifact(inputPath);
  try {
    const artifactClasses = artifact.astRoot.classes || [];
    const artifactClassNames = new Set(artifactClasses.map((cls) => cls.className));
    let analysisClasses = artifactClasses;
    if (classpath && classpath.length) {
      analysisClasses = artifactClasses.slice();
      const workspace = await KrakatauWorkspace.create(classpath);
      Object.values(workspace.workspaceASTs || {}).forEach((entry) => {
        if (!entry || !entry.ast || !entry.ast.classes || !entry.ast.classes.length) return;
        const cls = entry.ast.classes[0];
        if (artifactClassNames.has(cls.className)) {
          return;
        }
        analysisClasses.push(cls);
      });
    }
    const analysisAst =
      analysisClasses === artifactClasses
        ? artifact.astRoot
        : { classes: analysisClasses };
    let metadata = collectFieldReferences(analysisAst);
    metadata = metadata.filter((entry) => artifactClassNames.has(entry.className));
    metadata = metadata.filter((entry) => {
      if (filterClass && entry.className !== filterClass) {
        return false;
      }
      if (filterField && entry.fieldName !== filterField) {
        return false;
      }
      if (filterDescriptor && entry.descriptor !== filterDescriptor) {
        return false;
      }
      return true;
    });
    if (outputFormat === 'json') {
      process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
      return;
    }
    if (!metadata.length) {
      console.log('No matching fields.');
      return;
    }
    metadata.forEach((entry) => {
      console.log(`${entry.className}.${entry.fieldName} : ${entry.descriptor}`);
      if (!entry.references.length) {
        console.log('  references: (none)');
        return;
      }
      console.log('  references:');
      entry.references.forEach((ref) => {
        console.log(
          `    ${ref.op} by ${ref.className}.${ref.methodName}${ref.descriptor}`,
        );
      });
    });
  } finally {
    artifact.cleanup();
  }
}

function formatCommand(args) {
  let outPath = null;
  let dryRun = false;
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--out' || arg === '-o') {
      if (i + 1 >= args.length) throw new Error('--out requires a value');
      outPath = args[++i];
    } else if (arg === '-n' || arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      return;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) {
    throw new Error('format requires exactly one input .j file');
  }
  const inputPath = positional[0];
  if (path.extname(inputPath).toLowerCase() !== '.j') {
    throw new Error('format currently supports only .j files');
  }
  if (outPath && path.extname(outPath).toLowerCase() !== '.j') {
    throw new Error('format output must have a .j extension');
  }
  ensureFileExists(inputPath);
  const originalText = fs.readFileSync(inputPath, 'utf8');
  let formatted;
  try {
    formatted = formatJasminSource(originalText);
  } catch (err) {
    throw new Error(`Failed to format ${inputPath}: ${err.message}`);
  }
  const originalNormalized = normalizeNewlines(originalText);
  const formattedNormalized = normalizeNewlines(formatted);
  if (formattedNormalized === originalNormalized) {
    console.log('Already formatted.');
    return;
  }
  if (dryRun) {
    showDiff(originalText, formatted);
    return;
  }
  const targetPath = outPath || inputPath;
  fs.writeFileSync(targetPath, formatted, 'utf8');
  console.log(`Formatted ${inputPath} -> ${targetPath}`);
}

function renameClassCommand(args) {
  let outPath = null;
  let dryRun = false;
  let fromClass = null;
  let toClass = null;
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--from') {
      if (i + 1 >= args.length) throw new Error('--from requires a value');
      fromClass = args[++i];
    } else if (arg === '--to') {
      if (i + 1 >= args.length) throw new Error('--to requires a value');
      toClass = args[++i];
    } else if (arg === '--out' || arg === '-o') {
      if (i + 1 >= args.length) throw new Error('--out requires a value');
      outPath = args[++i];
    } else if (arg === '-n' || arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      return;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) {
    throw new Error('rename-class requires exactly one input file');
  }
  if (!fromClass || !toClass) {
    throw new Error('rename-class requires --from and --to');
  }
  const inputPath = positional[0];
  ensureFileExists(inputPath);
  const artifact = loadArtifact(inputPath);
  try {
    const changed = renameClassAst(artifact.astRoot, fromClass, toClass);
    if (!changed) {
      console.log('No matching class references found.');
      return;
    }
    const newText = generateJasminText(artifact.astRoot, artifact.constantPool);
    if (dryRun) {
      showDiff(artifact.baselineJasmin, newText);
      return;
    }
    writeArtifact(artifact, outPath);
  } finally {
    artifact.cleanup();
  }
}

function renameMethodCommand(args) {
  let outPath = null;
  let dryRun = false;
  let className = null;
  let fromMethod = null;
  let toMethod = null;
  let descriptor = null;
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--class') {
      if (i + 1 >= args.length) throw new Error('--class requires a value');
      className = args[++i];
    } else if (arg === '--from') {
      if (i + 1 >= args.length) throw new Error('--from requires a value');
      fromMethod = args[++i];
    } else if (arg === '--to') {
      if (i + 1 >= args.length) throw new Error('--to requires a value');
      toMethod = args[++i];
    } else if (arg === '--descriptor' || arg === '-d') {
      if (i + 1 >= args.length) throw new Error('--descriptor requires a value');
      descriptor = args[++i];
    } else if (arg === '--out' || arg === '-o') {
      if (i + 1 >= args.length) throw new Error('--out requires a value');
      outPath = args[++i];
    } else if (arg === '-n' || arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      return;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) {
    throw new Error('rename-method requires exactly one input file');
  }
  if (!className || !fromMethod || !toMethod) {
    throw new Error('rename-method requires --class, --from, and --to');
  }
  const inputPath = positional[0];
  ensureFileExists(inputPath);
  const artifact = loadArtifact(inputPath);
  try {
    const changed = renameMethodAst(artifact.astRoot, className, fromMethod, toMethod, descriptor);
    if (!changed) {
      console.log('No matching method references found.');
      return;
    }
    const newText = generateJasminText(artifact.astRoot, artifact.constantPool);
    if (dryRun) {
      showDiff(artifact.baselineJasmin, newText);
      return;
    }
    writeArtifact(artifact, outPath);
  } finally {
    artifact.cleanup();
  }
}

function parseWorkspaceOptions(args) {
  let classpath = ['sources'];
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--classpath' || arg === '-cp') {
      if (i + 1 >= args.length) throw new Error('--classpath requires a value');
      classpath = args[++i].split(path.delimiter);
    } else {
      rest.push(arg);
    }
  }
  return { classpath, rest };
}

async function loadWorkspace(classpath) {
  return await KrakatauWorkspace.create(classpath);
}

async function workspaceCommand(args) {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    return;
  }
  const subcommand = args[0];
  const { classpath, rest } = parseWorkspaceOptions(args.slice(1));
  const workspace = await loadWorkspace(classpath);

  switch (subcommand) {
    case 'list-methods':
      workspaceListMethods(workspace, rest);
      break;
    case 'list-fields':
      workspaceListFields(workspace, rest);
      break;
    case 'list-constants':
      workspaceListConstants(workspace, rest);
      break;
    case 'describe-class':
      workspaceDescribeClass(workspace, rest);
      break;
    case 'find-references':
      workspaceFindReferences(workspace, rest);
      break;
    default:
      throw new Error(`Unknown workspace command: ${subcommand}`);
  }
}

function workspaceListMethods(workspace, args) {
  if (args.length !== 1) {
    throw new Error('workspace list-methods requires <ClassName>');
  }
  const className = args[0];
  const methods = workspace.listMethods(className);
  if (!methods.length) {
    console.log(`No methods found in ${className}`);
    return;
  }
  methods.forEach((method) => {
    const flags = method.flags ? method.flags.join(' ') : '';
    console.log(`${className}.${method.identifier.memberName}${method.descriptor} ${flags}`);
  });
}

function workspaceListFields(workspace, args) {
  if (args.length !== 1) {
    throw new Error('workspace list-fields requires <ClassName>');
  }
  const className = args[0];
  const fields = workspace.listFields(className);
  if (!fields.length) {
    console.log(`No fields found in ${className}`);
    return;
  }
  fields.forEach((field) => {
    const flags = field.flags ? field.flags.join(' ') : '';
    console.log(`${className}.${field.identifier.memberName} : ${field.descriptor} ${flags}`);
  });
}

function workspaceListConstants(workspace, args) {
  if (args.length !== 1) {
    throw new Error('workspace list-constants requires <ClassName>');
  }
  const className = args[0];
  const workspaceEntry = workspace.workspaceASTs[className];
  if (!workspaceEntry || !workspaceEntry.constantPool) {
    console.log(`Class ${className} not loaded in workspace`);
    return;
  }
  workspaceEntry.constantPool.forEach((entry, index) => {
    if (!entry) return;
    console.log(`#${index}: ${JSON.stringify(entry)}`);
  });
}

function workspaceDescribeClass(workspace, args) {
  if (args.length !== 1) {
    throw new Error('workspace describe-class requires <ClassName>');
  }
  const className = args[0];
  const ast = workspace.getClassAST(className);
  const cls = ast.classes[0];
  console.log(`Class: ${cls.className}`);
  console.log(`Flags: ${(cls.flags || []).join(' ')}`);
  console.log(`Super: ${cls.superClassName}`);
  console.log(`Interfaces: ${(cls.interfaces || []).join(', ') || '(none)'}`);
}

function workspaceFindReferences(workspace, args) {
  let className = null;
  let memberName = null;
  let descriptor = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--class') {
      className = args[++i];
    } else if (arg === '--member') {
      memberName = args[++i];
    } else if (arg === '--descriptor' || arg === '-d') {
      descriptor = args[++i];
    } else {
      throw new Error(`Unknown option for find-references: ${arg}`);
    }
  }
  if (!className) {
    throw new Error('find-references requires --class');
  }
  const identifier = new (require('../src/symbols').SymbolIdentifier)(
    className,
    memberName,
    descriptor,
  );
  const refs = workspace.findReferences(identifier);
  if (!refs.length) {
    console.log('No references found.');
    return;
  }
  refs.forEach((ref) => {
    console.log(`${ref.className} :: ${ref.astPath}`);
  });
}
async function main(argv) {
  try {
    const { command, args } = parseCommand(argv);
    switch (command) {
      case 'help':
        printHelp();
        break;
      case 'assemble':
        assembleCommand(args);
        break;
      case 'disassemble':
        await disassembleCommand(args);
        break;
      case 'lint':
        await lintOrOptimizeCommand(args, { applyFix: false });
        break;
      case 'optimize':
        await lintOrOptimizeCommand(args, { applyFix: true });
        break;
      case 'format':
        formatCommand(args);
        break;
      case 'throws':
        throwsMetadataCommand(args);
        break;
      case 'callers':
        await callersMetadataCommand(args);
        break;
      case 'fieldrefs':
        await fieldRefsCommand(args);
        break;
      case 'rename-class':
        renameClassCommand(args);
        break;
      case 'rename-method':
        renameMethodCommand(args);
        break;
      case 'workspace':
        await workspaceCommand(args);
        break;
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
    if (process.env.DEBUG_CLI) {
      console.error(err.stack);
    }
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
    if (process.env.DEBUG_CLI) {
      console.error(err.stack);
    }
  });
}

module.exports = { main };
