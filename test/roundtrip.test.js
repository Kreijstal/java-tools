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
const { parseKrak2Assembly } = require('../src/parse_krak2.js');
const { convertKrak2AstToClassAst } = require('../src/convert_krak2_ast.js');
const { writeClassAstToClassFile } = require('../src/classAstToClassFile');

const JASMIN_DIR = path.join(__dirname, '..', 'examples', 'sources', 'jasmin');
const JAVA_DIR = path.join(__dirname, '..', 'examples', 'sources', 'java');

const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

const assemblerMode = (process.env.ROUNDTRIP_ASSEMBLER || 'classAst').toLowerCase();
const supportedAssemblerModes = new Set(['classast', 'krak2']);
if (!supportedAssemblerModes.has(assemblerMode)) {
  throw new Error(
    `Unsupported ROUNDTRIP_ASSEMBLER value "${process.env.ROUNDTRIP_ASSEMBLER}". ` +
    'Supported values are: classAst, krak2.'
  );
}

const sourcesDir = path.join(__dirname, '../sources');
const krakatauPath = path.resolve(
  __dirname,
  '../tools/krakatau/Krakatau/target/release/krak2'
);

// Helper functions from feat-cfg-analysis
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

// Helper functions from master
function deepClone(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(deepClone);
  }

  const clone = {};
  for (const key of Object.keys(value)) {
    clone[key] = deepClone(value[key]);
  }
  return clone;
}

function stripCpIndex(obj) {
  if (obj && typeof obj === 'object') {
    if (Array.isArray(obj)) {
      obj.forEach(stripCpIndex);
      return obj;
    }

    for (const key in obj) {
      if (key === 'cp_index' || key === 'pc' || key === 'loc') {
        delete obj[key];
        continue;
      }
      stripCpIndex(obj[key]);
    }

    if ('start_pc' in obj) {
      delete obj.start_pc;
    }
    if ('end_pc' in obj) {
      delete obj.end_pc;
    }
    if ('handler_pc' in obj) {
      delete obj.handler_pc;
    }
    if ('catch_type' in obj && !('catchType' in obj)) {
      obj.catchType = obj.catch_type;
      delete obj.catch_type;
    }
    if ('bootstrapMethods' in obj) {
      delete obj.bootstrapMethods;
    }
    if ('bootstrapMethods' in obj) {
      delete obj.bootstrapMethods;
    }
  }
  return obj;
}

function stripLocMetadata(obj) {
  if (obj && typeof obj === 'object') {
    if (Array.isArray(obj)) {
      obj.forEach(stripLocMetadata);
      return obj;
    }
    if ('loc' in obj) {
      delete obj.loc;
    }
    for (const key in obj) {
      stripLocMetadata(obj[key]);
    }
  }
  return obj;
}

// Tests from master branch (roundtrip tests for all classes in sources/)
const classNames = fs
  .readdirSync(sourcesDir)
  .filter((fileName) => fileName.endsWith('.class'))
  .map((fileName) => fileName.slice(0, -'.class'.length))
  .sort((a, b) => a.localeCompare(b));

classNames.forEach(className => {
  test(`Roundtrip test for ${className}.class`, (t) => {
    const classFilePath = path.join(__dirname, `../sources/${className}.class`);
    const jFilePath = path.join(tempDir, `${className}.j`);
    const tempClassFilePath = path.join(tempDir, `${className}.class`);
    const regeneratedClassFilePath = path.join(tempDir, `${className}.regenerated.class`);

    try {
      // 1. Generate .j file from original .class file
      const classFileContent = fs.readFileSync(classFilePath);
      const originalAst = getAST(new Uint8Array(classFileContent));
      const convertedOriginalAst = convertJson(originalAst.ast, originalAst.constantPool);
      const jContent = unparseDataStructures(convertedOriginalAst.classes[0], originalAst.constantPool);
      fs.writeFileSync(jFilePath, jContent);
      t.pass('.j file generated successfully');

      // Path A: .j -> .class -> classAST (golden)
      execFileSync(krakatauPath, ['asm', jFilePath, '--out', tempClassFilePath]);
      const goldenClassFileContent = fs.readFileSync(tempClassFilePath);
      const goldenAst = getAST(new Uint8Array(goldenClassFileContent));
      const goldenClassAst = convertJson(goldenAst.ast, goldenAst.constantPool);

      const strippedGoldenAst = stripCpIndex(deepClone(goldenClassAst));
      t.pass('Golden classAST generated and stripped successfully');

      // Path B: .j -> krak2AST -> classAST (new)
      const krak2Ast = parseKrak2Assembly(jContent);
      const newClassAst = convertKrak2AstToClassAst(krak2Ast, { sourceText: jContent });
      const sanitizedNewClassAst = stripCpIndex(stripLocMetadata(deepClone(newClassAst)));
      t.pass('New classAST generated successfully');

      // Verification
      t.deepEqual(sanitizedNewClassAst, strippedGoldenAst, "The AST from the new parser should match the golden AST");

      // Path C: classAST -> .class -> classAST (roundtrip check)
      if (assemblerMode === 'krak2') {
        execFileSync(krakatauPath, ['asm', jFilePath, '--out', regeneratedClassFilePath]);
        t.pass('Regenerated class using Krakatau assembler');
      } else {
        writeClassAstToClassFile(newClassAst, regeneratedClassFilePath);
        t.pass('Regenerated class using classAstToClassFile assembler');
      }
      const regeneratedClassContent = fs.readFileSync(regeneratedClassFilePath);
      const regeneratedAst = getAST(new Uint8Array(regeneratedClassContent));
      const regeneratedConverted = convertJson(regeneratedAst.ast, regeneratedAst.constantPool);
      const strippedRegenerated = stripCpIndex(stripLocMetadata(deepClone(regeneratedConverted)));
      t.deepEqual(strippedRegenerated, sanitizedNewClassAst, 'Reconstructed class from AST should match the original AST');

      const regeneratedJ = unparseDataStructures(regeneratedConverted.classes[0], regeneratedAst.constantPool);
      const reparsedRegenerated = convertKrak2AstToClassAst(parseKrak2Assembly(regeneratedJ), { sourceText: regeneratedJ });
      const strippedReparsedRegenerated = stripCpIndex(deepClone(reparsedRegenerated));
      t.deepEqual(
        strippedReparsedRegenerated,
        strippedRegenerated,
        'Regenerated Jasmin should parse back to the same AST',
      );

    } catch (error) {
      t.fail(`Roundtrip test failed with an error: ${error.message}\n${error.stack}`);
    } finally {
      // Cleanup temporary files
      if (fs.existsSync(jFilePath)) fs.unlinkSync(jFilePath);
      if (fs.existsSync(tempClassFilePath)) fs.unlinkSync(tempClassFilePath);
      if (fs.existsSync(regeneratedClassFilePath)) fs.unlinkSync(regeneratedClassFilePath);
      t.end();
    }
  });
});

// Tests from feat-cfg-analysis branch (CFG transformation tests)
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
