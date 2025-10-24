const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('tape');
const { getAST } = require('jvm_parser');
const { convertJson } = require('../src/convert_tree');
const { runOptimizationPipeline } = require('../src/passManager');
const { ensureKrak2Path } = require('../src/utils/krakatau');

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

function listInstructionOps(method) {
  const codeAttr = (method.attributes || []).find(({ type }) => type === 'code');
  if (!codeAttr) {
    throw new Error(`Method ${method.name} has no code attribute.`);
  }
  return codeAttr.code.codeItems
    .filter((item) => item.instruction)
    .map((item) => {
      const { instruction } = item;
      if (typeof instruction === 'string') {
        return instruction;
      }
      return instruction.op;
    });
}

test('pass manager orchestrates inlining and optimization passes', (t) => {
  t.plan(4);
  const krak2Path = ensureKrak2Path();

  withTempDir('pm-inline-', (tempDir) => {
    const callerClassPath = assembleJasminFile(tempDir, krak2Path, 'Caller.j');
    const pureMathClassPath = assembleJasminFile(tempDir, krak2Path, 'PureMath.j');

    const caller = convertClassFromFile(callerClassPath);
    const pureMath = convertClassFromFile(pureMathClassPath);

    const program = { classes: [caller.classItem, pureMath.classItem] };
    const result = runOptimizationPipeline(program);

    t.ok(result.changed, 'optimization pipeline should report changes');

    const firstInlineStage = result.stages.find((stage) => stage.name === 'inline');
    t.ok(firstInlineStage && firstInlineStage.changed, 'inline stage should modify the program');

    const firstConstantFold = result.stages.find((stage) => stage.name === 'constantFold');
    t.ok(firstConstantFold && firstConstantFold.changed, 'constant-fold stage should modify the program');

    const callerClass = program.classes.find((cls) => cls.className === 'Caller');
    const optimizedMethod = findMethod(callerClass, (m) => m.name === 'test');
    t.deepEqual(
      listInstructionOps(optimizedMethod),
      ['bipush', 'ireturn'],
      'pass manager should reduce the Caller.test method to a literal return',
    );
  });
});
