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
const { ensureKrak2Path } = require('../src/utils/krakatau');

const JASMIN_DIR = path.join(__dirname, '..', 'examples', 'sources', 'jasmin');
const JAVA_DIR = path.join(__dirname, '..', 'examples', 'sources', 'java');

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
  const [classItem] = converted.classes || [];
  if (!classItem) {
    throw new Error(`Failed to convert ${classFilePath} into a class AST.`);
  }
  return { classItem, constantPool: parsed.constantPool };
}

function findMethod(classItem, predicate) {
  const { items = [] } = classItem;
  const methodItem = items.find((item) => item.type === 'method' && predicate(item.method));
  if (!methodItem) {
    throw new Error('Requested method was not found in class.');
  }
  return methodItem.method;
}

function getCodeFromMethod(method) {
  const codeAttr = (method.attributes || []).find(({ type }) => type === 'code');
  if (!codeAttr) {
    throw new Error(`Method ${method.name} has no code attribute.`);
  }
  return codeAttr.code;
}

function roundTripMethod(method) {
  const cfg = convertAstToCfg(method);
  return reconstructAstFromCfg(cfg, method);
}

function assertRoundTripEquality(t, method, message) {
  const roundTripped = roundTripMethod(method);
  const originalCode = getCodeFromMethod(method);
  const roundTrippedCode = getCodeFromMethod(roundTripped);
  const { codeItems: originalItems } = originalCode;
  const { codeItems: roundTripItems } = roundTrippedCode;
  t.equal(JSON.stringify(roundTripItems), JSON.stringify(originalItems), message);
}

function withTempDir(prefix, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('AST -> CFG -> AST roundtrip is non-destructive', (t) => {
  t.plan(1);
  const krak2Path = ensureKrak2Path();

  withTempDir('roundtrip-', (tempDir) => {
    const classPath = assembleJasminFile(tempDir, krak2Path, 'ReturnFirst.j');
    const { classItem } = convertClassFromFile(classPath);
    const method = findMethod(classItem, () => true);
    assertRoundTripEquality(t, method, 'Round-tripped codeItems should be identical');
  });
});

test('Roundtrip covers empty bodies, exception handlers, and switch control flow', (t) => {
  const krak2Path = ensureKrak2Path();

  const fixtures = [
    { file: 'EmptyBody.j', method: (m) => m.name === 'doNothing', label: 'empty body' },
    { file: 'TryCatchFlow.j', method: (m) => m.name === 'withException', label: 'exception handler' },
    { file: 'SwitchFlow.j', method: (m) => m.name === 'dispatch', label: 'tableswitch control flow' },
    { file: 'SwitchFlow.j', method: (m) => m.name === 'lookup', label: 'lookupswitch control flow' },
  ];

  t.plan(fixtures.length);

  fixtures.forEach(({ file, method: predicate, label }) => {
    withTempDir(`roundtrip-${label}-`, (tempDir) => {
      const classPath = assembleJasminFile(tempDir, krak2Path, file);
      const { classItem } = convertClassFromFile(classPath);
      const method = findMethod(classItem, predicate);
      assertRoundTripEquality(t, method, `Roundtrip should preserve ${label} methods`);
    });
  });
});

test('CFG-based purity analysis', (t) => {
  t.plan(4);
  const krak2Path = ensureKrak2Path();

  withTempDir('purity-', (tempDir) => {
    const classPath = assembleJasminFile(tempDir, krak2Path, 'ReturnFirst.j');
    const { classItem } = convertClassFromFile(classPath);
    const pureMethod = findMethod(classItem, (m) => m.name === 'useAndReturnFirst');
    const pureCfg = convertAstToCfg(pureMethod);
    const signature = `${classItem.className}.${pureMethod.name}${pureMethod.descriptor}`;
    const { isPure, reason } = analyzePurityCfg(pureCfg, {
      knownPureCallees: new Set([signature]),
      methodSignature: signature,
    });
    t.ok(isPure, 'useAndReturnFirst should be identified as pure');
    t.equal(reason, null, 'There should be no impurity reason for useAndReturnFirst');

    const sideEffectPath = assembleJasminFile(tempDir, krak2Path, 'SideEffects.j');
    const { classItem: impureClass } = convertClassFromFile(sideEffectPath);
    const impureMethod = findMethod(impureClass, (m) => m.name === 'test');
    const impureCfg = convertAstToCfg(impureMethod);
    const { isPure: impureResult, reason: impureReason } = analyzePurityCfg(impureCfg);
    t.notOk(impureResult, 'SideEffects.test should be identified as impure');
    t.ok(impureReason.includes('putstatic'), 'Impurity reason should mention putstatic');
  });
});

test('Optimized code is executable', (t) => {
  t.plan(1);
  const krak2Path = ensureKrak2Path();

  withTempDir('optimized-', (tempDir) => {
    const classPath = assembleJasminFile(tempDir, krak2Path, 'ReturnFirst.j');
    const { classItem, constantPool } = convertClassFromFile(classPath);
    const method = findMethod(classItem, (m) => m.name === 'useAndReturnFirst');

    const cfg = convertAstToCfg(method);
    const { optimizedCfg } = eliminateDeadCodeCfg(cfg);
    const optimizedMethod = reconstructAstFromCfg(optimizedCfg, method);

    const { items } = classItem;
    const methodIndex = items.findIndex((item) => item.type === 'method' && item.method.name === method.name);
    items[methodIndex].method = optimizedMethod;

    const jasminSource = unparseDataStructures(classItem, constantPool);
    const newJasminPath = path.join(tempDir, 'ReturnFirst.opt.j');
    fs.writeFileSync(newJasminPath, jasminSource);

    const newClassPath = path.join(tempDir, 'ReturnFirst.opt.class');
    execFileSync(krak2Path, ['asm', newJasminPath, '--out', newClassPath]);

    const javaSource = path.join(JAVA_DIR, 'ReturnFirstTest.java');
    const javacBinary = process.env.JAVAC || 'javac';
    execFileSync(javacBinary, ['-d', tempDir, '-cp', tempDir, javaSource]);

    const javaBinary = process.env.JAVA || 'java';
    execFileSync(javaBinary, ['-cp', tempDir, 'ReturnFirstTest']);

    t.pass('Optimized code assembled and executed successfully');
  });
});

test('CFG-based dead code elimination removes dead code', (t) => {
  t.plan(2);
  const krak2Path = ensureKrak2Path();

  withTempDir('dce-', (tempDir) => {
    const classPath = assembleJasminFile(tempDir, krak2Path, 'ReturnFirst.j');
    const { classItem } = convertClassFromFile(classPath);
    const method = findMethod(classItem, (m) => m.name === 'useAndReturnFirst');

    const cfg = convertAstToCfg(method);
    const { changed, optimizedCfg } = eliminateDeadCodeCfg(cfg);

    t.ok(changed, 'Should report changes for dead code');

    const entryBlock = optimizedCfg.blocks.get('block_0');
    const remaining = entryBlock.instructions.filter((instruction) => instruction.instruction);
    t.equal(remaining.length, 2, 'Should remove dead instructions');
  });
});

test('Round-tripped code is executable', (t) => {
  t.plan(1);
  const krak2Path = ensureKrak2Path();

  withTempDir('roundtrip-exec-', (tempDir) => {
    const classPath = assembleJasminFile(tempDir, krak2Path, 'ReturnFirst.j');
    const { classItem, constantPool } = convertClassFromFile(classPath);
    const method = findMethod(classItem, (m) => m.name === 'useAndReturnFirst');

    const roundTrippedMethod = roundTripMethod(method);

    const { items } = classItem;
    const methodIndex = items.findIndex((item) => item.type === 'method' && item.method.name === method.name);
    items[methodIndex].method = roundTrippedMethod;

    const jasminSource = unparseDataStructures(classItem, constantPool);
    const jasminPath = path.join(tempDir, 'ReturnFirst.rt.j');
    fs.writeFileSync(jasminPath, jasminSource);

    const classOutput = path.join(tempDir, 'ReturnFirst.rt.class');
    execFileSync(krak2Path, ['asm', jasminPath, '--out', classOutput]);

    const javaSource = path.join(JAVA_DIR, 'ReturnFirstTest.java');
    const javacBinary = process.env.JAVAC || 'javac';
    execFileSync(javacBinary, ['-d', tempDir, '-cp', tempDir, javaSource]);

    const javaBinary = process.env.JAVA || 'java';
    execFileSync(javaBinary, ['-cp', tempDir, 'ReturnFirstTest']);

    t.pass('Round-tripped code assembled and executed successfully');
  });
});
