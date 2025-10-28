#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { getAST } = require('jvm_parser');
const { convertJson, unparseDataStructures } = require('../../src/convert_tree');
const { runOptimizationPasses } = require('../../src/passManager');
const { ensureKrak2Path } = require('../../src/utils/krakatau');

function validatePath(filePath, baseDir) {
  const resolvedPath = path.resolve(filePath);
  const resolvedBase = path.resolve(baseDir);
  if (!resolvedPath.startsWith(resolvedBase)) {
    throw new Error(`Path traversal attempt detected: ${filePath} is outside of ${baseDir}`);
  }
  return resolvedPath;
}

const JASMIN_DIR = path.join(__dirname, '..', 'sources', 'jasmin');
const JAVA_DIR = path.join(__dirname, '..', 'sources', 'java');

function assembleReturnFirst(tempDir, krak2Path) {
  const jasminSource = path.join(JASMIN_DIR, 'ReturnFirst.j');
  const classOutput = validatePath(path.join(tempDir, 'ReturnFirst.class'), tempDir);
  execFileSync(krak2Path, ['asm', jasminSource, '--out', classOutput]);
  return classOutput;
}

function compileReturnFirstTest(tempDir) {
  const javaSource = path.join(JAVA_DIR, 'ReturnFirstTest.java');
  const javacBinary = process.env.JAVAC || 'javac';
  try {
    execFileSync(javacBinary, ['-d', tempDir, '-classpath', tempDir, javaSource], {
      stdio: 'inherit',
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        `Unable to locate the Java compiler (tried executing "${javacBinary}").`,
      );
    }
    throw error;
  }
  return validatePath(path.join(tempDir, 'ReturnFirstTest.class'), tempDir);
}

function convertClassFromFile(classFilePath) {
  const classBytes = fs.readFileSync(classFilePath);
  const parsed = getAST(new Uint8Array(classBytes));
  const converted = convertJson(parsed.ast, parsed.constantPool);
  const classItem = converted.classes && converted.classes[0];
  if (!classItem) {
    throw new Error(`Failed to convert ${classFilePath} into a class AST.`);
  }
  return { classItem, constantPool: parsed.constantPool };
}

function sanitizeAssembly(assembly) {
  return assembly
    .split('\n')
    .filter((line) => line.trim() !== '.sourcefile "null"')
    .filter((line) => !/^L\d+:$/.test(line.trim()))
    .map((line) => line.replace(/^L\d+:\s+/, '    '))
    .join('\n');
}

function writeAssembly(classItem, constantPool, outputPath, baseDir) {
  const validatedPath = validatePath(outputPath, baseDir);
  if (!classItem) {
    throw new Error('Cannot emit assembly for a missing class definition.');
  }
  if (!constantPool) {
    throw new Error(`Constant pool missing for ${classItem.className}.`);
  }
  const disassembly = unparseDataStructures(classItem, constantPool);
  const sanitized = sanitizeAssembly(disassembly);
  fs.writeFileSync(
    validatedPath,
    sanitized.endsWith('\n') ? sanitized : `${sanitized}\n`,
  );
  console.log(
    `Optimized assembly written to ${path.relative(process.cwd(), validatedPath)}`,
  );
}

function main() {
  const krak2Path = ensureKrak2Path();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'returnfirst-'));

  const returnFirstClassPath = assembleReturnFirst(tempDir, krak2Path);
  const returnFirst = convertClassFromFile(returnFirstClassPath);

  const returnFirstTestClassPath = compileReturnFirstTest(tempDir);
  const returnFirstTest = convertClassFromFile(returnFirstTestClassPath);

  const program = {
    classes: [returnFirst.classItem, returnFirstTest.classItem],
  };

  const { passes } = runOptimizationPasses(program);

  const firstInline = passes.find((pass) => pass.name === 'inlinePureMethods' && pass.iteration === 1);
  if (!firstInline || !firstInline.changed) {
    console.warn('Inlining reported no changes for the ReturnFirst demo.');
  }

  const firstDce = passes.find((pass) => pass.name === 'eliminateDeadCodeCfg' && pass.iteration === 3);
  if (!firstDce || !firstDce.changed) {
    console.warn('Dead-code elimination reported no changes after inlining.');
  }

  const outputDir = path.join(__dirname, '..', 'output');
  fs.mkdirSync(outputDir, { recursive: true });

  writeAssembly(
    returnFirst.classItem,
    returnFirst.constantPool,
    path.join(outputDir, 'ReturnFirst.deadcode.j'),
    outputDir,
  );

  writeAssembly(
    returnFirstTest.classItem,
    returnFirstTest.constantPool,
    path.join(outputDir, 'ReturnFirstTest.optimized.j'),
    outputDir,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('Failed to produce optimized assembly:', error);
    process.exit(1);
  }
}

module.exports = { main };
