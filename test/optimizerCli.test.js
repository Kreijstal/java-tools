const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('tape');
const { getAST } = require('jvm_parser');
const { convertJson } = require('../src/parsing/convert_tree');
const { assembleJasminFixture } = require('../src/utils/jasminAssembly');

const JASMIN_DIR = path.join(__dirname, '..', 'examples', 'sources', 'jasmin');

function withTempDir(prefix, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function assembleJasminFile(tempDir, jasminFile) {
  return assembleJasminFixture(JASMIN_DIR, tempDir, jasminFile);
}

function convertClassFromFile(classFilePath) {
  const bytes = fs.readFileSync(classFilePath);
  const parsed = getAST(new Uint8Array(bytes));
  const converted = convertJson(parsed.ast, parsed.constantPool);
  const classItem = converted.classes && converted.classes[0];
  if (!classItem) {
    throw new Error(`Failed to convert ${classFilePath} into a class AST.`);
  }
  return classItem;
}

function getMethodInstructions(classItem, methodName) {
  const methodItem = classItem.items.find((item) => item.type === 'method' && item.method && item.method.name === methodName);
  if (!methodItem) {
    throw new Error(`Method ${methodName} not found.`);
  }
  const codeAttr = (methodItem.method.attributes || []).find(({ type }) => type === 'code');
  if (!codeAttr) {
    throw new Error(`Method ${methodName} has no code attribute.`);
  }
  return codeAttr.code.codeItems
    .filter((item) => item.instruction)
    .map((item) => (typeof item.instruction === 'string' ? item.instruction : item.instruction.op));
}

test('optimizer CLI folds caller test class and emits optimized output', (t) => {
  t.plan(4);
  const cliPath = path.join(__dirname, '..', 'tools', 'optimizer-cli.js');
  withTempDir('optimizer-cli-', (tempDir) => {
    const callerClassPath = assembleJasminFile(tempDir, 'Caller.j');
    const pureMathClassPath = assembleJasminFile(tempDir, 'PureMath.j');
    const outputDir = path.join(tempDir, 'optimized');

    const stdout = execFileSync('node', [
      cliPath,
      '--input', callerClassPath,
      '--input', pureMathClassPath,
      '--output', outputDir,
      '--passes', 'constantFoldCfg,eliminateDeadCodeCfg',
      '--max_instructions', '50000',
    ], { encoding: 'utf8' });

    t.ok(/Loaded \d+ class/.test(stdout), 'CLI should report the number of loaded classes');
    const emittedCaller = path.join(outputDir, 'Caller.class');
    const emittedPureMath = path.join(outputDir, 'PureMath.class');
    t.ok(fs.existsSync(emittedCaller), 'Caller.class should be written to the output directory');
    t.ok(fs.existsSync(emittedPureMath), 'PureMath.class should be written to the output directory');

    const optimizedCaller = convertClassFromFile(emittedCaller);
    const ops = getMethodInstructions(optimizedCaller, 'test');
    t.deepEqual(ops, ['bipush', 'ireturn'], 'Caller.test should be folded to a literal return sequence');
  });
});
