const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('tape');
const { getAST } = require('jvm_parser');
const { convertJson, unparseDataStructures } = require('../src/parsing/convert_tree');
const { convertAstToCfg } = require('../src/cfg/ast-to-cfg');
const { reconstructAstFromCfg } = require('../src/cfg/cfg-to-ast');
const { eliminateDeadCodeCfg } = require('../src/passes/deadCodeEliminator-cfg');
const { analyzePurityCfg } = require('../src/analysis/purityAnalyzer-cfg');
const { parseKrak2Assembly } = require('../src/parsing/parse_krak2.js');
const { convertKrak2AstToClassAst } = require('../src/parsing/convert_krak2_ast.js');
const { encodeModifiedUtf8, writeClassAstToClassFile } = require('../src/parsing/classAstToClassFile');
const { assembleJasminFixture } = require('../src/utils/jasminAssembly');

const JASMIN_DIR = path.join(__dirname, '..', 'examples', 'sources', 'jasmin');
const JAVA_DIR = path.join(__dirname, '..', 'examples', 'sources', 'java');

const tempDir = path.join(__dirname, 'temp');
const sourcesDir = path.join(__dirname, '../sources');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

test('class writer encodes JVM modified UTF-8 code units', (t) => {
  t.deepEqual(
    [...encodeModifiedUtf8('\u0000\ud800')],
    [0xc0, 0x80, 0xed, 0xa0, 0x80],
    'NUL and unpaired surrogate are preserved as modified UTF-8 bytes'
  );
  t.end();
});

// Helper functions from feat-cfg-analysis
function assembleJasminFile(tempDir, jasminFile) {
  return assembleJasminFixture(JASMIN_DIR, tempDir, jasminFile);
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
const PER_TEST_TIMEOUT_MS = Number.parseInt(process.env.ROUNDTRIP_CASE_TIMEOUT_MS || '120000', 10);

const roundtripClassFilter = process.env.ROUNDTRIP_CLASS_FILTER
  ? new RegExp(process.env.ROUNDTRIP_CLASS_FILTER)
  : null;
const classNames = fs
  .readdirSync(sourcesDir)
  .filter((fileName) => fileName.endsWith('.class'))
  .map((fileName) => fileName.slice(0, -'.class'.length))
  .filter((className) => !roundtripClassFilter || roundtripClassFilter.test(className))
  .sort((a, b) => a.localeCompare(b));

classNames.forEach(className => {
  test(`Roundtrip test for ${className}.class`, (t) => {
    const classFilePath = path.join(__dirname, `../sources/${className}.class`);
    const jFilePath = path.join(tempDir, `${className}.j`);
    const regeneratedClassFilePath = path.join(tempDir, `${className}.regenerated.class`);

    let timeoutFired = false;
    const timeoutHandle = setTimeout(() => {
      timeoutFired = true;
      t.fail(
        `Roundtrip for ${className}.class exceeded ${PER_TEST_TIMEOUT_MS}ms timeout; ` +
        'set ROUNDTRIP_CASE_TIMEOUT_MS to adjust.',
      );
      t.end();
    }, PER_TEST_TIMEOUT_MS);

    try {
      // 1. Generate .j file from original .class file
      const classFileContent = fs.readFileSync(classFilePath);
      const originalAst = getAST(new Uint8Array(classFileContent));
      const convertedOriginalAst = convertJson(originalAst.ast, originalAst.constantPool);
      const jContent = unparseDataStructures(convertedOriginalAst.classes[0], originalAst.constantPool);
      fs.writeFileSync(jFilePath, jContent);
      t.pass('.j file generated successfully');

      // Path A: .class -> repository disassembler -> Jasmin text.
      const strippedGoldenAst = stripCpIndex(stripLocMetadata(deepClone(convertedOriginalAst)));
      t.pass('Golden classAST generated from repository parser successfully');

      // Path B: Jasmin text -> repository Jasmin parser -> classAST.
      const krak2Ast = parseKrak2Assembly(jContent);
      const newClassAst = convertKrak2AstToClassAst(krak2Ast, { sourceText: jContent });
      const sanitizedNewClassAst = stripCpIndex(stripLocMetadata(deepClone(newClassAst)));
      t.pass('New classAST generated successfully');

      // Verification: the repository disassembler emitted parseable Jasmin for the same class.
      t.equal(
        sanitizedNewClassAst.classes[0].className,
        strippedGoldenAst.classes[0].className,
        'Parsed Jasmin should preserve the class name',
      );

      // Path C: classAST -> repository class writer -> .class -> classAST.
      writeClassAstToClassFile(newClassAst, regeneratedClassFilePath);
      t.pass('Regenerated class using classAstToClassFile assembler');
      const regeneratedClassContent = fs.readFileSync(regeneratedClassFilePath);
      const regeneratedAst = getAST(new Uint8Array(regeneratedClassContent));
      const regeneratedConverted = convertJson(regeneratedAst.ast, regeneratedAst.constantPool);
      const strippedRegenerated = stripCpIndex(stripLocMetadata(deepClone(regeneratedConverted)));
      t.deepEqual(strippedRegenerated, sanitizedNewClassAst, 'Reconstructed class from AST should match the original AST');

      const regeneratedJ = unparseDataStructures(regeneratedConverted.classes[0], regeneratedAst.constantPool);
      const reparsedRegenerated = convertKrak2AstToClassAst(parseKrak2Assembly(regeneratedJ), { sourceText: regeneratedJ });
      const strippedReparsedRegenerated = stripCpIndex(stripLocMetadata(deepClone(reparsedRegenerated)));
      t.deepEqual(
        strippedReparsedRegenerated,
        strippedRegenerated,
        'Regenerated Jasmin should parse back to the same AST',
      );

    } catch (error) {
      t.fail(`Roundtrip test failed with an error: ${error.message}\n${error.stack}`);
    } finally {
      clearTimeout(timeoutHandle);
      // Cleanup temporary files
      if (fs.existsSync(jFilePath)) fs.unlinkSync(jFilePath);
      if (fs.existsSync(regeneratedClassFilePath)) fs.unlinkSync(regeneratedClassFilePath);
      if (!timeoutFired) {
        t.end();
      }
    }
  });
});

// Tests from feat-cfg-analysis branch (CFG transformation tests)
test('AST -> CFG -> AST roundtrip is non-destructive', (t) => {
  t.plan(1);
  withTempDir('roundtrip-', (tempDir) => {
    const classPath = assembleJasminFile(tempDir, 'ReturnFirst.j');
    const { classItem } = convertClassFromFile(classPath);
    const method = findMethod(classItem, () => true);
    assertRoundTripEquality(t, method, 'Round-tripped codeItems should be identical');
  });
});

test('Roundtrip covers empty bodies, exception handlers, and switch control flow', (t) => {
  const fixtures = [
    { file: 'EmptyBody.j', method: (m) => m.name === 'doNothing', label: 'empty body' },
    { file: 'TryCatchFlow.j', method: (m) => m.name === 'withException', label: 'exception handler' },
    { file: 'SwitchFlow.j', method: (m) => m.name === 'dispatch', label: 'tableswitch control flow' },
    { file: 'SwitchFlow.j', method: (m) => m.name === 'lookup', label: 'lookupswitch control flow' },
  ];

  t.plan(fixtures.length);

  fixtures.forEach(({ file, method: predicate, label }) => {
    withTempDir(`roundtrip-${label}-`, (tempDir) => {
      const classPath = assembleJasminFile(tempDir, file);
      const { classItem } = convertClassFromFile(classPath);
      const method = findMethod(classItem, predicate);
      assertRoundTripEquality(t, method, `Roundtrip should preserve ${label} methods`);
    });
  });
});

test('CFG-based purity analysis', (t) => {
  t.plan(4);
  withTempDir('purity-', (tempDir) => {
    const classPath = assembleJasminFile(tempDir, 'ReturnFirst.j');
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

    const sideEffectPath = assembleJasminFile(tempDir, 'SideEffects.j');
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
  withTempDir('optimized-', (tempDir) => {
    const classPath = assembleJasminFile(tempDir, 'ReturnFirst.j');
    const { classItem } = convertClassFromFile(classPath);
    const method = findMethod(classItem, (m) => m.name === 'useAndReturnFirst');

    const cfg = convertAstToCfg(method);
    const { optimizedCfg } = eliminateDeadCodeCfg(cfg);
    const optimizedMethod = reconstructAstFromCfg(optimizedCfg, method);

    const { items } = classItem;
    const methodIndex = items.findIndex((item) => item.type === 'method' && item.method.name === method.name);
    items[methodIndex].method = optimizedMethod;

    const newClassPath = path.join(tempDir, 'ReturnFirst.opt.class');
    writeClassAstToClassFile(classItem, newClassPath);

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
  withTempDir('dce-', (tempDir) => {
    const classPath = assembleJasminFile(tempDir, 'ReturnFirst.j');
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
  withTempDir('roundtrip-exec-', (tempDir) => {
    const classPath = assembleJasminFile(tempDir, 'ReturnFirst.j');
    const { classItem } = convertClassFromFile(classPath);
    const method = findMethod(classItem, (m) => m.name === 'useAndReturnFirst');

    const roundTrippedMethod = roundTripMethod(method);

    const { items } = classItem;
    const methodIndex = items.findIndex((item) => item.type === 'method' && item.method.name === method.name);
    items[methodIndex].method = roundTrippedMethod;

    const classOutput = path.join(tempDir, 'ReturnFirst.rt.class');
    writeClassAstToClassFile(classItem, classOutput);

    const javaSource = path.join(JAVA_DIR, 'ReturnFirstTest.java');
    const javacBinary = process.env.JAVAC || 'javac';
    execFileSync(javacBinary, ['-d', tempDir, '-cp', tempDir, javaSource]);

    const javaBinary = process.env.JAVA || 'java';
    execFileSync(javaBinary, ['-cp', tempDir, 'ReturnFirstTest']);

    t.pass('Round-tripped code assembled and executed successfully');
  });
});
