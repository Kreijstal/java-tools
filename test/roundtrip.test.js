const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('tape');
const { getAST } = require('jvm_parser');
const { convertJson, unparseDataStructures } = require('../src/convert_tree');
const { convertAstToCfg } = require('../src/ast-to-cfg');
const { reconstructAstFromCfg } = require('../src/cfg-to-ast');
const { eliminateDeadCodeCfg } = require('../src/deadCodeEliminator-cfg');
const { analyzePurityCfg } = require('../src/purityAnalyzer-cfg');

const JASMIN_DIR = path.join(__dirname, '..', 'examples', 'sources', 'jasmin');

function ensureKrak2Path() {
  const krak2Path = path.resolve(
    __dirname,
    '..', 'tools', 'krakatau', 'Krakatau', 'target', 'release', 'krak2',
  );
  if (!fs.existsSync(krak2Path)) {
    throw new Error(`Krakatau binary not found at ${krak2Path}`);
  }
  return krak2Path;
}

function assembleJasminFile(tempDir, krak2Path, jasminFile) {
  const jasminSource = path.join(JASMIN_DIR, jasminFile);
  const className = path.basename(jasminFile, '.j');
  const classOutput = path.join(tempDir, `${className}.class`);
  execFileSync(krak2Path, ['asm', jasminSource, '--out', classOutput]);
  return classOutput;
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

test('AST -> CFG -> AST roundtrip is non-destructive', (t) => {
  t.plan(1);

  const krak2Path = ensureKrak2Path();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roundtrip-test-'));

  try {
    const classPath = assembleJasminFile(tempDir, krak2Path, 'ReturnFirst.j');
    const { classItem: originalAst } = convertClassFromFile(classPath);
    const originalMethod = originalAst.items.find(item => item.type === 'method').method;

    const cfg = convertAstToCfg(originalMethod);
    const roundtrippedMethod = reconstructAstFromCfg(cfg, originalMethod);

    // We only care about the codeItems for this test.
    const originalCode = originalMethod.attributes.find(a => a.type === 'code').code;
    const roundtrippedCode = roundtrippedMethod.attributes.find(a => a.type === 'code').code;

    // Normalize for comparison
    const originalCodeItems = JSON.stringify(originalCode.codeItems);
    const roundtrippedCodeItems = JSON.stringify(roundtrippedCode.codeItems);

    t.equal(roundtrippedCodeItems, originalCodeItems, 'Round-tripped codeItems should be identical');

  } catch (error) {
    t.fail(error.toString());
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    t.end();
  }
});

test('CFG-based purity analysis', (t) => {
  t.plan(4);

  const krak2Path = ensureKrak2Path();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'purity-test-'));

  try {
    // Test case 1: A pure method
    const pureClassPath = assembleJasminFile(tempDir, krak2Path, 'ReturnFirst.j');
    const { classItem: pureClass } = convertClassFromFile(pureClassPath);
    const pureMethod = pureClass.items.find(item => item.type === 'method').method;
    const pureCfg = convertAstToCfg(pureMethod);
    const { isPure: isPureResult, reason: pureReason } = analyzePurityCfg(pureCfg);
    t.ok(isPureResult, 'useAndReturnFirst should be identified as pure');
    t.equal(pureReason, null, 'There should be no reason for impurity for useAndReturnFirst');

    // Test case 2: An impure method
    const impureClassPath = assembleJasminFile(tempDir, krak2Path, 'SideEffects.j');
    const { classItem: impureClass } = convertClassFromFile(impureClassPath);
    const impureMethod = impureClass.items.find(item => item.type === 'method').method;
    const impureCfg = convertAstToCfg(impureMethod);
    const { isPure: isImpureResult, reason: impureReason } = analyzePurityCfg(impureCfg);
    t.notOk(isImpureResult, 'SideEffects.test should be identified as impure');
    t.ok(impureReason.includes('putstatic'), 'Impurity reason should mention putstatic');

  } catch (error) {
    t.fail(error.toString());
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    t.end();
  }
});

test('Optimized code is executable', (t) => {
  t.plan(1);

  const krak2Path = ensureKrak2Path();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'optimized-executable-test-'));

  try {
    const classPath = assembleJasminFile(tempDir, krak2Path, 'ReturnFirst.j');
    const { classItem, constantPool } = convertClassFromFile(classPath);
    const originalMethod = classItem.items.find(item => item.type === 'method').method;

    const cfg = convertAstToCfg(originalMethod);
    const { optimizedCfg } = eliminateDeadCodeCfg(cfg);
    const optimizedMethod = reconstructAstFromCfg(optimizedCfg, originalMethod);

    const methodIndex = classItem.items.findIndex(item => item.type === 'method');
    classItem.items[methodIndex].method = optimizedMethod;

    const newJasmin = unparseDataStructures(classItem, constantPool);
    const newJasminPath = path.join(tempDir, 'ReturnFirst.opt.j');
    fs.writeFileSync(newJasminPath, newJasmin);

    const newClassPath = path.join(tempDir, 'ReturnFirst.opt.class');
    execFileSync(krak2Path, ['asm', newJasminPath, '--out', newClassPath]);

    const JAVA_DIR = path.join(__dirname, '..', 'examples', 'sources', 'java');
    const javaSource = path.join(JAVA_DIR, 'ReturnFirstTest.java');
    const javacBinary = process.env.JAVAC || 'javac';
    execFileSync(javacBinary, ['-d', tempDir, '-cp', tempDir, javaSource]);

    const javaBinary = process.env.JAVA || 'java';
    execFileSync(javaBinary, ['-cp', tempDir, 'ReturnFirstTest']);

    t.pass('Optimized code assembled and executed successfully');

  } catch (error) {
    t.fail(error.toString());
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    t.end();
  }
});

test('CFG-based dead code elimination removes dead code', (t) => {
  t.plan(2);

  const krak2Path = ensureKrak2Path();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dce-test-'));

  try {
    const classPath = assembleJasminFile(tempDir, krak2Path, 'ReturnFirst.j');
    const { classItem } = convertClassFromFile(classPath);
    const method = classItem.items.find(item => item.type === 'method').method;

    const cfg = convertAstToCfg(method);
    const { changed, optimizedCfg } = eliminateDeadCodeCfg(cfg);

    t.ok(changed, 'Should report changes for dead code');

    const instructionCount = optimizedCfg.blocks.get('block_0').instructions.filter(i => i.instruction).length;
    t.equal(instructionCount, 2, 'Should remove dead instructions');

  } catch (error) {
    t.fail(error.toString());
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    t.end();
  }
});

test('Round-tripped code is executable', (t) => {
  t.plan(1);

  const krak2Path = ensureKrak2Path();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'executable-test-'));

  try {
    const classPath = assembleJasminFile(tempDir, krak2Path, 'ReturnFirst.j');
    const { classItem, constantPool } = convertClassFromFile(classPath);
    const originalMethod = classItem.items.find(item => item.type === 'method').method;

    const cfg = convertAstToCfg(originalMethod);
    const roundtrippedMethod = reconstructAstFromCfg(cfg, originalMethod);

    // Replace the method in the class AST
    const methodIndex = classItem.items.findIndex(item => item.type === 'method');
    classItem.items[methodIndex].method = roundtrippedMethod;

    const newJasmin = unparseDataStructures(classItem, constantPool);
    const newJasminPath = path.join(tempDir, 'ReturnFirst.rt.j');
    fs.writeFileSync(newJasminPath, newJasmin);

    // Assemble the new Jasmin file
    const newClassPath = path.join(tempDir, 'ReturnFirst.rt.class');
    execFileSync(krak2Path, ['asm', newJasminPath, '--out', newClassPath]);

    // To execute, we need the test class as well
    const JAVA_DIR = path.join(__dirname, '..', 'examples', 'sources', 'java');
    const javaSource = path.join(JAVA_DIR, 'ReturnFirstTest.java');
    const javacBinary = process.env.JAVAC || 'javac';
    execFileSync(javacBinary, ['-d', tempDir, '-cp', tempDir, javaSource]);

    const javaBinary = process.env.JAVA || 'java';
    execFileSync(javaBinary, ['-cp', tempDir, 'ReturnFirstTest']);

    t.pass('Round-tripped code assembled and executed successfully');

  } catch (error) {
    t.fail(error.toString());
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    t.end();
  }
});
