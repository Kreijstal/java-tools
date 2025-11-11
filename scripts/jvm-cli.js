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
const { convertAstToCfg } = require('../src/ast-to-cfg');
const { eliminateDeadCodeCfg } = require('../src/deadCodeEliminator-cfg');
const { reconstructAstFromCfg } = require('../src/cfg-to-ast');
const { writeClassAstToClassFile } = require('../src/classAstToClassFile');

const HELP_TEXT = `
Usage: node scripts/jvm-cli.js <command> [options]

Commands:
  assemble <file.j> [--out file.class]              Assemble Jasmin to .class
  disassemble <file.class> [--out file.j]           Disassemble .class to Jasmin
  lint <file.{j|class}> [--fix] [--out file]        Detect dead-code handler tricks; optionally apply fix
  optimize <file.{j|class}> [--out file]            Apply dead-code optimization (alias for lint --fix)
  rename-class <file> --from Old --to New [options] Rename a class within the file
  rename-method <file> --class C --from old --to new [--descriptor desc] [options]

Options (where supported):
  --out <file>     Write results to the given path (defaults to in-place)
  -n, --dry-run    Do not write changes; print unified diff instead
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

function applyDeadCode(astRoot) {
  const diagnostics = [];
  let changed = false;

  for (const classItem of astRoot.classes || []) {
    const className = classItem.className || 'UnknownClass';
    for (const item of classItem.items || []) {
      if (!item || item.type !== 'method' || !item.method) {
        continue;
      }
      const cfg = convertAstToCfg(item.method);
      if (!cfg) {
        continue;
      }
      const result = eliminateDeadCodeCfg(cfg);
      if (!result.changed) {
        continue;
      }
      const optimizedMethod = reconstructAstFromCfg(result.optimizedCfg, item.method);
      item.method = optimizedMethod;
      diagnostics.push({
        className,
        methodName: optimizedMethod.name,
        descriptor: optimizedMethod.descriptor,
        message: 'Dead handler/jump detected; handler body can be simplified.',
      });
      changed = true;
    }
  }

  return { diagnostics, changed };
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
    const { diagnostics, changed } = applyDeadCode(artifact.astRoot);
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

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceDescriptor(descriptor, oldClass, newClass) {
  if (!descriptor || typeof descriptor !== 'string') {
    return descriptor;
  }
  const pattern = new RegExp(`L${escapeRegex(oldClass)};`, 'g');
  return descriptor.replace(pattern, `L${newClass};`);
}

function renameClassAst(astRoot, fromClass, toClass) {
  let changed = false;
  for (const classItem of astRoot.classes || []) {
    if (classItem.className === fromClass) {
      classItem.className = toClass;
      changed = true;
    }
    if (classItem.superClassName === fromClass) {
      classItem.superClassName = toClass;
      changed = true;
    }
    if (Array.isArray(classItem.interfaces)) {
      classItem.interfaces = classItem.interfaces.map((iface) =>
        iface === fromClass ? toClass : iface,
      );
    }
    for (const item of classItem.items || []) {
      if (item.type === 'field' && item.field) {
        const newDesc = replaceDescriptor(item.field.descriptor, fromClass, toClass);
        if (newDesc !== item.field.descriptor) {
          item.field.descriptor = newDesc;
          changed = true;
        }
      } else if (item.type === 'method' && item.method) {
        const method = item.method;
        const newDesc = replaceDescriptor(method.descriptor, fromClass, toClass);
        if (newDesc !== method.descriptor) {
          method.descriptor = newDesc;
          changed = true;
        }
        for (const attr of method.attributes || []) {
          if (attr.type !== 'code' || !attr.code) continue;
          for (const codeItem of attr.code.codeItems || []) {
            if (!codeItem || !codeItem.instruction) continue;
            const instr = codeItem.instruction;
            const op = instr.op;
            if (!op) continue;
            if (
              ['new', 'checkcast', 'instanceof', 'anewarray'].includes(op) &&
              instr.arg === fromClass
            ) {
              instr.arg = toClass;
              changed = true;
            } else if (op.startsWith('invoke') || op.startsWith('get') || op.startsWith('put')) {
              changed = updateMemberInstruction(instr, fromClass, toClass) || changed;
            }
          }
        }
      } else if (item.attribute && item.attribute.type === 'sourcefile') {
        const expected = `"${fromClass}.java"`;
        if (item.attribute.value === expected) {
          item.attribute.value = `"${toClass}.java"`;
          changed = true;
        }
      }
    }
  }
  return changed;
}

function updateMemberInstruction(instr, fromClass, toClass) {
  if (!instr || !instr.arg) return false;
  const arg = instr.arg;
  if (Array.isArray(arg) && arg.length >= 2) {
    let modified = false;
    if (arg[1] === fromClass) {
      arg[1] = toClass;
      modified = true;
    }
    if (Array.isArray(arg[2]) && arg[2].length >= 2 && typeof arg[2][1] === 'string') {
      const newDesc = replaceDescriptor(arg[2][1], fromClass, toClass);
      if (newDesc !== arg[2][1]) {
        arg[2][1] = newDesc;
        modified = true;
      }
    }
    return modified;
  }
  return false;
}

function renameMethodAst(astRoot, className, oldName, newName, descriptor) {
  let changed = false;
  for (const classItem of astRoot.classes || []) {
    if (classItem.className !== className) {
      continue;
    }
    for (const item of classItem.items || []) {
      if (item.type === 'method' && item.method) {
        const method = item.method;
        if (
          method.name === oldName &&
          (!descriptor || descriptor === method.descriptor)
        ) {
          method.name = newName;
          changed = true;
        }
        for (const attr of method.attributes || []) {
          if (attr.type !== 'code' || !attr.code) {
            continue;
          }
          for (const codeItem of attr.code.codeItems || []) {
            if (!codeItem || !codeItem.instruction) continue;
            const instr = codeItem.instruction;
            if (!instr.op || !instr.op.startsWith('invoke')) continue;
            const arg = instr.arg;
            if (Array.isArray(arg) && arg.length >= 3) {
              const owner = arg[1];
              if (owner !== className) continue;
              const nameAndType = arg[2];
              if (!Array.isArray(nameAndType)) continue;
              const name = nameAndType[0];
              const desc = nameAndType[1];
              if (name === oldName && (!descriptor || descriptor === desc)) {
                nameAndType[0] = newName;
                changed = true;
              }
            }
          }
        }
      }
    }
  }
  return changed;
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
