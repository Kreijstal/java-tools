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
const { runOptimizationPasses } = require('../src/passManager');
const { ensureKrak2Path } = require('../src/utils/krakatau');

const JASMIN_DIR = path.join(__dirname, '..', 'examples', 'sources', 'jasmin');
const JAVA_DIR = path.join(__dirname, '..', 'examples', 'sources', 'java');

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

test('constant folding evaluates long, float, and double arithmetic', (t) => {
  t.plan(9);
  const krak2Path = ensureKrak2Path();

  withTempDir('cf-wide-', (tempDir) => {
    const classPath = assembleJasminFile(tempDir, krak2Path, 'NumericWide.j');
    const { classItem } = convertClassFromFile(classPath);

    const sumAll = findMethod(classItem, (m) => m.name === 'sumAll');
    const mixFloat = findMethod(classItem, (m) => m.name === 'mixFloat');
    const mixDouble = findMethod(classItem, (m) => m.name === 'mixDouble');

    const sumCfg = convertAstToCfg(sumAll);
    const floatCfg = convertAstToCfg(mixFloat);
    const doubleCfg = convertAstToCfg(mixDouble);

    t.ok(constantFoldCfg(sumCfg).changed, 'long arithmetic should fold');
    t.ok(constantFoldCfg(floatCfg).changed, 'float arithmetic should fold');
    t.ok(constantFoldCfg(doubleCfg).changed, 'double arithmetic should fold');

    const optimizedLong = reconstructAstFromCfg(eliminateDeadCodeCfg(sumCfg).optimizedCfg, sumAll);
    const optimizedFloat = reconstructAstFromCfg(eliminateDeadCodeCfg(floatCfg).optimizedCfg, mixFloat);
    const optimizedDouble = reconstructAstFromCfg(eliminateDeadCodeCfg(doubleCfg).optimizedCfg, mixDouble);

    const longOps = listInstructionOps(optimizedLong);
    const floatOps = listInstructionOps(optimizedFloat);
    const doubleOps = listInstructionOps(optimizedDouble);

    t.deepEqual(longOps, ['ldc2_w', 'lreturn'], 'long method should reduce to a single constant and return');
    t.notOk(longOps.includes('ladd'), 'long addition should be removed');

    t.deepEqual(floatOps, ['fconst_2', 'freturn'], 'float method should collapse to fconst_2');
    t.notOk(floatOps.includes('fadd') || floatOps.includes('fsub'), 'float operations should be removed');

    t.deepEqual(doubleOps, ['ldc2_w', 'dreturn'], 'double method should reduce to a single constant and return');
    t.notOk(doubleOps.includes('dadd'), 'double addition should be removed');
  });
});

test('constant folding respects configured instruction limits', (t) => {
  t.plan(2);
  const krak2Path = ensureKrak2Path();

  withTempDir('cf-limit-', (tempDir) => {
    const classPath = assembleJasminFile(tempDir, krak2Path, 'Arithmetic.j');
    const { classItem } = convertClassFromFile(classPath);
    const method = findMethod(classItem, (m) => m.name === 'test');

    const cfg = convertAstToCfg(method);
    const result = constantFoldCfg(cfg, { limits: { maxInstructions: 0 } });

    t.notOk(result.changed, 'constant folder should not change code when the limit is exceeded');
    t.equal(result.limited, 'instructionLimit', 'limit metadata should report the instruction limit');
  });
});

test('pure invocation folding obeys evaluation limits for recursive callees', (t) => {
  t.plan(4);
  const krak2Path = ensureKrak2Path();
  const javacBinary = process.env.JAVAC || 'javac';

  withTempDir('cf-eval-', (tempDir) => {
    const fibClassPath = assembleJasminFile(tempDir, krak2Path, 'Fib.j');
    const ackClassPath = assembleJasminFile(tempDir, krak2Path, 'Ackermann.j');

    const javaSource = path.join(JAVA_DIR, 'OptimizerTimeoutTest.java');
    execFileSync(javacBinary, ['-d', tempDir, '-cp', tempDir, javaSource]);

    const optimizerClassPath = path.join(tempDir, 'OptimizerTimeoutTest.class');

    const fibClass = convertClassFromFile(fibClassPath);
    const ackClass = convertClassFromFile(ackClassPath);
    const optimizerClass = convertClassFromFile(optimizerClassPath);

    const program = {
      classes: [optimizerClass.classItem, fibClass.classItem, ackClass.classItem],
    };

    runOptimizationPasses(program);

    const optimized = program.classes.find((cls) => cls.className === 'OptimizerTimeoutTest');
    const fibMethod = findMethod(optimized, (m) => m.name === 'fib');
    const ackMethod = findMethod(optimized, (m) => m.name === 'ack');

    const fibOps = listInstructionOps(fibMethod);
    const ackOps = listInstructionOps(ackMethod);

    t.ok(fibOps.includes('ldc2_w'), 'fib helper should fold into a long constant');
    t.notOk(fibOps.includes('invokestatic'), 'fib helper should not invoke Fib.test after folding');
    t.ok(ackOps.includes('invokestatic'), 'ack helper should retain the Ackermann invocation when evaluation exceeds limits');
    t.notOk(ackOps.includes('ldc2_w'), 'ack helper should not reduce to a folded constant');
  });
});

test('constant propagation through locals enables folding and branch removal', (t) => {
  t.plan(6);
  const krak2Path = ensureKrak2Path();

  withTempDir('cf-locals-', (tempDir) => {
    const classPath = assembleJasminFile(tempDir, krak2Path, 'LocalPropagation.j');
    const { classItem } = convertClassFromFile(classPath);

    const sumMethod = findMethod(classItem, (m) => m.name === 'sum');
    const branchMethod = findMethod(classItem, (m) => m.name === 'branch');

    const sumCfg = convertAstToCfg(sumMethod);
    const branchCfg = convertAstToCfg(branchMethod);

    t.ok(constantFoldCfg(sumCfg).changed, 'local constant propagation should fold arithmetic');
    t.ok(constantFoldCfg(branchCfg).changed, 'local constant propagation should fold comparisons');

    const optimizedSum = reconstructAstFromCfg(eliminateDeadCodeCfg(sumCfg).optimizedCfg, sumMethod);
    const optimizedBranch = reconstructAstFromCfg(eliminateDeadCodeCfg(branchCfg).optimizedCfg, branchMethod);

    const sumOps = listInstructionOps(optimizedSum);
    const branchOps = listInstructionOps(optimizedBranch);

    t.notOk(sumOps.includes('iadd'), 'sum method should not contain iadd after folding');
    t.ok(sumOps.includes('bipush'), 'sum method should load a literal result');

    t.notOk(branchOps.includes('if_icmpne'), 'branch method should eliminate the comparison');
    const branchInstructions = getCodeFromMethod(optimizedBranch).codeItems
      .filter((item) => item.instruction)
      .map((item) => item.instruction);
    const literalInstruction = branchInstructions.find(
      (instruction) =>
        typeof instruction === 'object' &&
        (instruction.op === 'bipush' || instruction.op === 'sipush'),
    );
    t.equal(literalInstruction ? literalInstruction.arg : null, '7', 'branch method should retain the then-branch literal');
  });
});
