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

const HELP_TEXT = `
Usage: node scripts/jvm-cli.js <command> [options]

Commands:
  assemble <file.j> [--out file.class]              Assemble Jasmin to .class
  disassemble <file.class> [--out file.j]           Disassemble .class to Jasmin
  lint <file.{j|class}> [--fix] [--out file]        Detect dead-code handler tricks; optionally apply fix
  optimize <file.{j|class}> [--out file]            Apply dead-code optimization (alias for lint --fix)
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
  --classpath <dir>  (workspace commands) root containing .class files (default: sources/)
  --help           Show this message

Examples:
  node scripts/jvm-cli.js assemble examples/sources/jasmin/MisplacedCatch.j
  node scripts/jvm-cli.js lint examples/sources/jasmin/MisplacedCatch.j --fix
  node scripts/jvm-cli.js rename-method examples/sources/jasmin/MisplacedCatch.j \\
      --class MisplacedCatch --from funnel --to funnelSafe
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

function disassembleCommand(args) {
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
    throw new Error('disassemble requires exactly one input .class file');
  }

  const inputPath = positional[0];
  ensureFileExists(inputPath);
  if (!outPath) {
    outPath = defaultOutPath(inputPath, '.j');
  }

  const classBytes = fs.readFileSync(inputPath);
  const parsed = getAST(new Uint8Array(classBytes));
  const converted = convertJson(parsed.ast, parsed.constantPool);
  const jasmin = generateJasminText(converted, parsed.constantPool);
  fs.writeFileSync(outPath, jasmin, 'utf8');
  console.log(`Disassembled ${inputPath} -> ${outPath}`);
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

function generateJasminText(astRoot, constantPool) {
  if (!astRoot || !astRoot.classes) {
    return '';
  }
  return astRoot.classes
    .map((cls) => unparseDataStructures(cls, constantPool))
    .join('\n');
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

function lintOrOptimizeCommand(args, { applyFix }) {
  let outPath = null;
  let dryRun = false;
  let fix = applyFix;
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
  const inputPath = positional[0];
  ensureFileExists(inputPath);
  const artifact = loadArtifact(inputPath);
  try {
    const { diagnostics, changed } = runDeadCodePass(artifact.astRoot);
    if (diagnostics.length === 0) {
      console.log('No issues detected.');
    } else {
      diagnostics.forEach((diag, index) => {
        console.log(
          `${index + 1}) ${diag.className}.${diag.methodName}${diag.descriptor} - ${diag.message}`,
        );
      });
    }
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
function main(argv) {
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
        disassembleCommand(args);
        break;
      case 'lint':
        lintOrOptimizeCommand(args, { applyFix: false });
        break;
      case 'optimize':
        lintOrOptimizeCommand(args, { applyFix: true });
        break;
      case 'rename-class':
        renameClassCommand(args);
        break;
      case 'rename-method':
        renameMethodCommand(args);
        break;
      case 'workspace':
        workspaceCommand(args);
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
  main(process.argv.slice(2));
}

module.exports = { main };
