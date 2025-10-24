const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const test = require('tape');
const { getAST } = require('jvm_parser');
const { convertJson } = require('../src/convert_tree');
const { convertAstToCfg } = require('../src/ast-to-cfg');
const { reconstructAstFromCfg } = require('../src/cfg-to-ast');
const { constantFoldCfg } = require('../src/constantFolder-cfg');
const { eliminateDeadCodeCfg } = require('../src/deadCodeEliminator-cfg');
const { inlinePureMethods } = require('../src/inlinePureMethods');
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

test('constant folding collapses constant branches and unlocks DCE', (t) => {
  t.plan(4);
  const krak2Path = ensureKrak2Path();

  withTempDir('cf-branch-', (tempDir) => {
    const classPath = assembleJasminFile(tempDir, krak2Path, 'ConstantBranch.j');
    const { classItem } = convertClassFromFile(classPath);
    const method = findMethod(classItem, (m) => m.name === 'test');

    const cfg = convertAstToCfg(method);
    const { changed: folded } = constantFoldCfg(cfg);
    t.ok(folded, 'constant folder should fold the always-true branch');

    const { changed: eliminated, optimizedCfg } = eliminateDeadCodeCfg(cfg);
    t.ok(eliminated, 'dead-code elimination should remove the unreachable branch');

    const optimizedMethod = reconstructAstFromCfg(optimizedCfg, method);
    const ops = listInstructionOps(optimizedMethod);

    t.notOk(ops.includes('if_icmpeq'), 'conditional branch should be removed');
    t.notOk(ops.includes('iconst_0'), 'dead branch body should be eliminated');
  });
});

test('constant folding reduces arithmetic chains to single pushes', (t) => {
  t.plan(3);
  const krak2Path = ensureKrak2Path();

  withTempDir('cf-arith-', (tempDir) => {
    const classPath = assembleJasminFile(tempDir, krak2Path, 'Arithmetic.j');
    const { classItem } = convertClassFromFile(classPath);
    const method = findMethod(classItem, (m) => m.name === 'test');

    const cfg = convertAstToCfg(method);
    const { changed: folded } = constantFoldCfg(cfg);
    t.ok(folded, 'constant folder should simplify the arithmetic sequence');

    const { optimizedCfg } = eliminateDeadCodeCfg(cfg);
    const optimizedMethod = reconstructAstFromCfg(optimizedCfg, method);
    const ops = listInstructionOps(optimizedMethod);

    t.deepEqual(ops, ['bipush', 'ireturn'], 'arithmetic chain should become a single push and return');
    const codeItems = getCodeFromMethod(optimizedMethod).codeItems.filter((item) => item.instruction);
    t.equal(codeItems.length, 2, 'optimized method should only contain the folded push and return');
  });
});

test('inlining + constant folding collapses pure calls into literals', (t) => {
  t.plan(5);
  const krak2Path = ensureKrak2Path();

  withTempDir('cf-inline-', (tempDir) => {
    const callerClassPath = assembleJasminFile(tempDir, krak2Path, 'Caller.j');
    const pureMathClassPath = assembleJasminFile(tempDir, krak2Path, 'PureMath.j');

    const caller = convertClassFromFile(callerClassPath);
    const pureMath = convertClassFromFile(pureMathClassPath);

    const program = { classes: [caller.classItem, pureMath.classItem] };
    const { changed: inlined } = inlinePureMethods(program);
    t.ok(inlined, 'inlining should replace the PureMath.fn call');

    const callerClass = program.classes.find((cls) => cls.className === 'Caller');
    const method = findMethod(callerClass, (m) => m.name === 'test');

    const cfg = convertAstToCfg(method);
    const { changed: folded } = constantFoldCfg(cfg);
    t.ok(folded, 'constant folder should simplify the inlined branch');

    const { changed: eliminated, optimizedCfg } = eliminateDeadCodeCfg(cfg);
    t.ok(eliminated, 'dead-code elimination should remove the unreachable inline branch');

    const optimizedMethod = reconstructAstFromCfg(optimizedCfg, method);
    const ops = listInstructionOps(optimizedMethod);

    t.deepEqual(ops, ['bipush', 'ireturn'], 'inlined method should reduce to returning the literal');
    const instructionArgs = getCodeFromMethod(optimizedMethod).codeItems
      .filter((item) => item.instruction)
      .map((item) => item.instruction);
    const pushInstruction = instructionArgs[0];
    t.equal(
      typeof pushInstruction === 'object' ? pushInstruction.arg : null,
      '42',
      'the remaining push should load the literal 42',
    );
  });
});

test('constant folding handles extended numeric types', (t) => {
  t.plan(5);
  const krak2Path = ensureKrak2Path();

  withTempDir('cf-extended-', (tempDir) => {
    const classPath = assembleJasminFile(tempDir, krak2Path, 'ExtendedNumbers.j');
    const { classItem } = convertClassFromFile(classPath);

    function optimize(methodName) {
      const method = findMethod(classItem, (m) => m.name === methodName);
      const cfg = convertAstToCfg(method);
      constantFoldCfg(cfg);
      const { optimizedCfg } = eliminateDeadCodeCfg(cfg);
      return reconstructAstFromCfg(optimizedCfg, method);
    }

    const diffZero = optimize('diffZero');
    t.deepEqual(
      listInstructionOps(diffZero),
      ['lconst_0', 'lreturn'],
      'long arithmetic should fold to lconst_0/lreturn',
    );

    const floatPair = optimize('floatPair');
    t.deepEqual(
      listInstructionOps(floatPair),
      ['fconst_1', 'freturn'],
      'float subtraction should fold to fconst_1/freturn',
    );

    const doubleCancel = optimize('doubleCancel');
    t.deepEqual(
      listInstructionOps(doubleCancel),
      ['dconst_0', 'dreturn'],
      'double subtraction should fold to dconst_0/dreturn',
    );

    const compareLongs = optimize('compareLongs');
    const compareOps = listInstructionOps(compareLongs);
    t.equal(
      compareOps.filter((op) => op.startsWith('if')).length,
      0,
      'long comparison should eliminate conditional branches',
    );
    t.deepEqual(
      compareOps.slice(-2),
      ['iconst_1', 'ireturn'],
      'long comparison should end in returning the constant 1',
    );
  });
});

test('constant propagation tracks locals across blocks', (t) => {
  t.plan(7);
  const krak2Path = ensureKrak2Path();

  withTempDir('cf-locals-', (tempDir) => {
    const classPath = assembleJasminFile(tempDir, krak2Path, 'LocalPropagation.j');
    const { classItem } = convertClassFromFile(classPath);

    const computeMethod = findMethod(classItem, (m) => m.name === 'compute');
    const computeCfg = convertAstToCfg(computeMethod);
    const { changed: computeFolded } = constantFoldCfg(computeCfg);
    t.ok(computeFolded, 'compute method should fold constants loaded from locals');
    const { optimizedCfg: computeOptimizedCfg } = eliminateDeadCodeCfg(computeCfg);
    const optimizedCompute = reconstructAstFromCfg(computeOptimizedCfg, computeMethod);
    const computeOps = listInstructionOps(optimizedCompute);
    t.notOk(computeOps.includes('iadd'), 'folded compute method should remove iadd');
    t.ok(
      computeOps.includes('bipush') || computeOps.includes('sipush'),
      'folded compute method should push the summed literal',
    );
    const computeInstructions = getCodeFromMethod(optimizedCompute).codeItems
      .filter((item) => item.instruction)
      .map((item) => item.instruction);
    const literalPush = computeInstructions.find((instr) => instr.op === 'bipush' || instr.op === 'sipush');
    t.equal(
      literalPush && literalPush.arg,
      '12',
      'literal pushed after folding locals should equal 12',
    );

    const branchMethod = findMethod(classItem, (m) => m.name === 'branch');
    const branchCfg = convertAstToCfg(branchMethod);
    const { changed: branchFolded } = constantFoldCfg(branchCfg);
    t.ok(branchFolded, 'branch method should fold constant comparisons across blocks');
    const { optimizedCfg: branchOptimizedCfg } = eliminateDeadCodeCfg(branchCfg);
    const optimizedBranch = reconstructAstFromCfg(branchOptimizedCfg, branchMethod);
    const branchOps = listInstructionOps(optimizedBranch);
    t.equal(
      branchOps.filter((op) => op.startsWith('if')).length,
      0,
      'folded branch method should remove conditional jumps',
    );
    t.deepEqual(
      branchOps.slice(-2),
      ['iconst_1', 'ireturn'],
      'folded branch method should end in returning the constant 1',
    );
  });
});
