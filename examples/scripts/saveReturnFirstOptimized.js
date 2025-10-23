#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { getAST } = require('jvm_parser');
const { convertJson, unparseDataStructures } = require('../../src/convert_tree');
const { eliminateDeadCode } = require('../../src/deadCodeEliminator');
const { inlinePureMethods } = require('../../src/inlinePureMethods');

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

function ensureKrak2Path() {
  const krak2Path = path.resolve(
    __dirname,
    '../../tools/krakatau/Krakatau/target/release/krak2',
  );
  if (!fs.existsSync(krak2Path)) {
    throw new Error(`Krakatau binary not found at ${krak2Path}`);
  }
  return krak2Path;
}

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

  const { changed: inlined } = inlinePureMethods(program);
  if (!inlined) {
    console.warn('Inlining reported no changes for the ReturnFirst demo.');
  }

  const { changed: eliminated } = eliminateDeadCode(program);
  if (!eliminated) {
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
