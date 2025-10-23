const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('tape');
const { getAST } = require('jvm_parser');
const { convertJson } = require('../src/convert_tree');
const { convertAstToCfg } = require('../src/ast-to-cfg');
const { eliminateDeadCodeCfg } = require('../src/deadCodeEliminator-cfg');
const { analyzePurityCfg } = require('../src/purityAnalyzer-cfg');
const { reconstructAstFromCfg } = require('../src/cfg-to-ast');

const JASMIN_DIR = path.join(__dirname, '..', 'examples', 'sources', 'jasmin');
const GOLDEN_DIR = path.join(__dirname, 'fixtures');

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
  return classItem;
}

function stableJsonStringify(obj) {
  return JSON.stringify(obj, (key, value) => {
    if (value instanceof Object && !(value instanceof Array)) {
      return Object.keys(value)
        .sort()
        .reduce((sorted, key) => {
          sorted[key] = value[key];
          return sorted;
        }, {});
    }
    return value;
  }, 2);
}

test('Golden file test for .j -> AST conversion', (t) => {
  t.plan(1);

  const krak2Path = ensureKrak2Path();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-test-'));

  try {
    const classPath = assembleJasminFile(tempDir, krak2Path, 'ReturnFirst.j');
    const ast = convertClassFromFile(classPath);
    const astJson = stableJsonStringify(ast);

    const goldenFilePath = path.join(GOLDEN_DIR, 'ReturnFirst.ast.golden.json');

    if (fs.existsSync(goldenFilePath)) {
      const goldenContent = fs.readFileSync(goldenFilePath, 'utf8');
      t.equal(astJson, goldenContent, 'Generated AST matches the golden file');
    } else {
      fs.writeFileSync(goldenFilePath, astJson);
      t.pass('Golden file created: ' + goldenFilePath);
    }
  } catch (error) {
    t.fail(error.toString());
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Golden file test for AST -> CFG conversion', (t) => {
  t.plan(1);

  const astGoldenPath = path.join(GOLDEN_DIR, 'ReturnFirst.ast.golden.json');
  if (!fs.existsSync(astGoldenPath)) {
    t.fail('AST golden file does not exist. Run the AST golden test first.');
    t.end();
    return;
  }

  const ast = JSON.parse(fs.readFileSync(astGoldenPath, 'utf8'));
  const method = ast.items.find(item => item.type === 'method' && item.method.name === 'useAndReturnFirst').method;

  const cfg = convertAstToCfg(method);
  const cfgJson = stableJsonStringify(cfg.toJSON());

  const cfgGoldenPath = path.join(GOLDEN_DIR, 'ReturnFirst.cfg.golden.json');

  if (fs.existsSync(cfgGoldenPath)) {
    const goldenContent = fs.readFileSync(cfgGoldenPath, 'utf8');
    t.equal(cfgJson, goldenContent, 'Generated CFG matches the golden file');
  } else {
    fs.writeFileSync(cfgGoldenPath, cfgJson);
    t.pass('Golden file created: ' + cfgGoldenPath);
  }

  t.end();
});

test('Dead code elimination preserves side-effecting instructions', (t) => {
  t.plan(1);

  const krak2Path = ensureKrak2Path();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'side-effects-test-'));

  try {
    const classPath = assembleJasminFile(tempDir, krak2Path, 'SideEffects.j');
    const ast = convertClassFromFile(classPath);
    const method = ast.items.find(item => item.type === 'method').method;
    const cfg = convertAstToCfg(method);

    const { changed } = eliminateDeadCodeCfg(cfg);
    t.notOk(changed, 'Should not report changes for code with side effects');

  } catch (error) {
    t.fail(error.toString());
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    t.end();
  }
});

test('Dead code elimination removes unreachable code', (t) => {
  t.plan(2);

  const krak2Path = ensureKrak2Path();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unreachable-test-'));

  try {
    const classPath = assembleJasminFile(tempDir, krak2Path, 'UnreachableCode.j');
    const ast = convertClassFromFile(classPath);
    const method = ast.items.find(item => item.type === 'method').method;
    const cfg = convertAstToCfg(method);

    const { changed, optimizedCfg } = eliminateDeadCodeCfg(cfg);
    t.ok(changed, 'Should report changes for unreachable code');

    const instructionCount = optimizedCfg.blocks.get('block_0').instructions.length;
    t.equal(instructionCount, 2, 'Should remove unreachable instructions after return');

  } catch (error) {
    t.fail(error.toString());
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    t.end();
  }
});

test('Golden file test for Optimized CFG -> Optimized AST conversion', (t) => {
  t.plan(1);

  const astGoldenPath = path.join(GOLDEN_DIR, 'ReturnFirst.ast.golden.json');
  const optCfgGoldenPath = path.join(GOLDEN_DIR, 'ReturnFirst.opt.cfg.golden.json');

  if (!fs.existsSync(astGoldenPath) || !fs.existsSync(optCfgGoldenPath)) {
    t.fail('Required golden files do not exist. Run previous golden tests first.');
    t.end();
    return;
  }

  const ast = JSON.parse(fs.readFileSync(astGoldenPath, 'utf8'));
  const originalMethod = ast.items.find(item => item.type === 'method' && item.method.name === 'useAndReturnFirst').method;
  const optCfgData = JSON.parse(fs.readFileSync(optCfgGoldenPath, 'utf8'));

  // Reconstruct CFG object from JSON data
  const { CFG, BasicBlock } = require('../src/cfg');
  const optCfg = new CFG(optCfgData.entryBlockId);
  for (const blockId in optCfgData.blocks) {
    const blockData = optCfgData.blocks[blockId];
    const block = new BasicBlock(blockData.id);
    block.instructions = blockData.instructions;
    block.successors = blockData.successors;
    block.predecessors = blockData.predecessors;
    optCfg.addBlock(block);
  }

  const newMethodAst = reconstructAstFromCfg(optCfg, originalMethod);
  const astJson = stableJsonStringify(newMethodAst);

  const optAstGoldenPath = path.join(GOLDEN_DIR, 'ReturnFirst.opt.ast.golden.json');

  if (fs.existsSync(optAstGoldenPath)) {
    const goldenContent = fs.readFileSync(optAstGoldenPath, 'utf8');
    t.equal(astJson, goldenContent, 'Generated optimized AST matches the golden file');
  } else {
    fs.writeFileSync(optAstGoldenPath, astJson);
    t.pass('Optimized AST golden file created: ' + optAstGoldenPath);
  }

  t.end();
});

test('CFG-based purity analysis test', (t) => {
  t.plan(2);

  const cfgGoldenPath = path.join(GOLDEN_DIR, 'ReturnFirst.cfg.golden.json');
  if (!fs.existsSync(cfgGoldenPath)) {
    t.fail('CFG golden file does not exist. Run the CFG golden test first.');
    t.end();
    return;
  }

  const cfgData = JSON.parse(fs.readFileSync(cfgGoldenPath, 'utf8'));

  // Reconstruct CFG object from JSON data
  const { CFG, BasicBlock } = require('../src/cfg');
  const cfg = new CFG(cfgData.entryBlockId);
  for (const blockId in cfgData.blocks) {
    const blockData = cfgData.blocks[blockId];
    const block = new BasicBlock(blockData.id);
    block.instructions = blockData.instructions;
    block.successors = blockData.successors;
    block.predecessors = blockData.predecessors;
    cfg.addBlock(block);
  }

  const { isPure, reason } = analyzePurityCfg(cfg);
  t.ok(isPure, 'useAndReturnFirst should be identified as pure');
  t.equal(reason, null, 'There should be no reason for impurity');

  t.end();
});

test('Golden file test for CFG -> Optimized CFG conversion', (t) => {
  t.plan(2);

  const cfgGoldenPath = path.join(GOLDEN_DIR, 'ReturnFirst.cfg.golden.json');
  if (!fs.existsSync(cfgGoldenPath)) {
    t.fail('CFG golden file does not exist. Run the CFG golden test first.');
    t.end();
    return;
  }

  const cfgData = JSON.parse(fs.readFileSync(cfgGoldenPath, 'utf8'));

  // Reconstruct CFG object from JSON data
  const { CFG, BasicBlock } = require('../src/cfg');
  const cfg = new CFG(cfgData.entryBlockId);
  for (const blockId in cfgData.blocks) {
    const blockData = cfgData.blocks[blockId];
    const block = new BasicBlock(blockData.id);
    block.instructions = blockData.instructions;
    block.successors = blockData.successors;
    block.predecessors = blockData.predecessors;
    cfg.addBlock(block);
  }

  const { changed, optimizedCfg } = eliminateDeadCodeCfg(cfg);
  t.ok(changed, 'Dead code elimination should report changes');

  const optCfgJson = stableJsonStringify(optimizedCfg.toJSON());
  const optCfgGoldenPath = path.join(GOLDEN_DIR, 'ReturnFirst.opt.cfg.golden.json');

  if (fs.existsSync(optCfgGoldenPath)) {
    const goldenContent = fs.readFileSync(optCfgGoldenPath, 'utf8');
    t.equal(optCfgJson, goldenContent, 'Generated optimized CFG matches the golden file');
  } else {
    fs.writeFileSync(optCfgGoldenPath, optCfgJson);
    t.pass('Optimized CFG golden file created: ' + optCfgGoldenPath);
  }

  t.end();
});
