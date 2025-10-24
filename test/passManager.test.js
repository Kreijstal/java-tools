const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('tape');
const { getAST } = require('jvm_parser');
const { convertJson } = require('../src/convert_tree');
const { ensureKrak2Path } = require('../src/utils/krakatau');
const { runOptimizationPasses } = require('../src/passManager');

const JASMIN_DIR = path.join(__dirname, '..', 'examples', 'sources', 'jasmin');

function withTempDir(prefix, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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

function listInstructionOps(method) {
  const code = getCodeFromMethod(method);
  return code.codeItems
    .filter((item) => item.instruction)
    .map((item) => {
      const { instruction } = item;
      if (typeof instruction === 'string') {
        return instruction;
      }
      return instruction.op;
    });
}

test('runOptimizationPasses orchestrates the inline/fold/DCE pipeline', (t) => {
  t.plan(6);
  const krak2Path = ensureKrak2Path();

  withTempDir('pm-', (tempDir) => {
    const callerClassPath = assembleJasminFile(tempDir, krak2Path, 'Caller.j');
    const pureMathClassPath = assembleJasminFile(tempDir, krak2Path, 'PureMath.j');

    const caller = convertClassFromFile(callerClassPath);
    const pureMath = convertClassFromFile(pureMathClassPath);

    const program = { classes: [caller.classItem, pureMath.classItem] };

    const { changed, passes } = runOptimizationPasses(program);

    t.ok(changed, 'optimization pipeline should report changes');
    t.deepEqual(
      passes.map((pass) => pass.name),
      [
        'inlinePureMethods',
        'constantFoldCfg',
        'eliminateDeadCodeCfg',
        'inlinePureMethods',
        'constantFoldCfg',
        'eliminateDeadCodeCfg',
      ],
      'passes should run in the expected order',
    );

    const callerClass = program.classes.find((cls) => cls.className === 'Caller');
    const method = findMethod(callerClass, (m) => m.name === 'test');
    const ops = listInstructionOps(method);

    t.deepEqual(ops, ['bipush', 'ireturn'], 'Caller.test should reduce to a literal return');
    const instructionArgs = getCodeFromMethod(method).codeItems
      .filter((item) => item.instruction)
      .map((item) => item.instruction);
    const pushInstruction = instructionArgs[0];
    t.equal(typeof pushInstruction === 'object' ? pushInstruction.arg : null, '42', 'literal should remain 42');

    const inlinePasses = passes.filter((pass) => pass.name === 'inlinePureMethods');
    t.ok(inlinePasses.some((pass) => pass.changed), 'at least one inlining pass should report changes');

    const dcePasses = passes.filter((pass) => pass.name === 'eliminateDeadCodeCfg');
    t.ok(dcePasses.some((pass) => pass.changed), 'at least one DCE pass should report changes');
  });
});
