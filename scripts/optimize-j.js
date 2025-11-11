#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { getAST } = require('jvm_parser');
const { convertJson, unparseDataStructures } = require('../src/convert_tree');
const { convertAstToCfg } = require('../src/ast-to-cfg');
const { reconstructAstFromCfg } = require('../src/cfg-to-ast');
const { eliminateDeadCodeCfg } = require('../src/deadCodeEliminator-cfg');
const { ensureKrak2Path } = require('../src/utils/krakatau');

function printUsage() {
  console.error('Usage: node scripts/optimize-j.js <input.j> [output.j]');
  process.exit(1);
}

function optimizeMethod(method) {
  const cfg = convertAstToCfg(method);
  if (!cfg) {
    return null;
  }
  const { changed, optimizedCfg } = eliminateDeadCodeCfg(cfg);
  if (!changed) {
    return null;
  }
  return reconstructAstFromCfg(optimizedCfg, method);
}

function optimizeClassItem(classItem) {
  let changed = false;
  const { items = [] } = classItem;
  for (const item of items) {
    if (!item || item.type !== 'method' || !item.method) {
      continue;
    }
    const optimizedMethod = optimizeMethod(item.method);
    if (optimizedMethod) {
      item.method = optimizedMethod;
      changed = true;
    }
  }
  return changed;
}

function main() {
  const [inputPath, outputArg] = process.argv.slice(2);
  if (!inputPath) {
    printUsage();
  }

  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const outputPath =
    outputArg ||
    inputPath.replace(/\.j$/i, '.optimized.j');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opt-j-'));
  const tempClassFile = path.join(tempDir, 'input.class');
  const krak2Path = ensureKrak2Path();

  try {
    execFileSync(krak2Path, ['asm', inputPath, '--out', tempClassFile], {
      stdio: 'inherit',
    });
    const classBytes = fs.readFileSync(tempClassFile);
    const parsed = getAST(new Uint8Array(classBytes));
    const converted = convertJson(parsed.ast, parsed.constantPool);

    let changed = false;
    const outputChunks = [];

    for (const classItem of converted.classes || []) {
      if (optimizeClassItem(classItem)) {
        changed = true;
      }
      outputChunks.push(unparseDataStructures(classItem, parsed.constantPool));
    }

    const outputContent = outputChunks.join('\n');
    fs.writeFileSync(outputPath, outputContent, 'utf8');

    if (!changed) {
      console.warn('No optimizations applied; output matches input semantics.');
    } else {
      console.log(`Optimized Jasmin written to ${outputPath}`);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main();
