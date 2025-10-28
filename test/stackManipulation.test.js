const test = require('tape');
const { convertAstToCfg } = require('../src/ast-to-cfg');
const { constantFoldCfg } = require('../src/constantFolder-cfg');
const { eliminateDeadCodeCfg } = require('../src/deadCodeEliminator-cfg');
const { reconstructAstFromCfg } = require('../src/cfg-to-ast');

function createStackManipulationProgram() {
  return {
    classes: [
      {
        className: 'StackOps',
        items: [
          {
            type: 'method',
            method: {
              name: 'manipulate',
              descriptor: '()V',
              flags: ['public', 'static'],
              attributes: [
                {
                  type: 'code',
                  code: {
                    stackSize: '8',
                    localsSize: '1',
                    codeItems: [
                      { instruction: 'iconst_1' },
                      { instruction: 'iconst_2' },
                      { instruction: 'dup_x1' },
                      { instruction: 'pop' },
                      { instruction: 'pop' },
                      { instruction: 'pop' },

                      { instruction: 'iconst_1' },
                      { instruction: 'iconst_2' },
                      { instruction: 'iconst_3' },
                      { instruction: 'dup_x2' },
                      { instruction: 'pop' },
                      { instruction: 'pop' },
                      { instruction: 'pop' },
                      { instruction: 'pop' },

                      { instruction: { op: 'ldc2_w', arg: 1n } },
                      { instruction: 'iconst_4' },
                      { instruction: 'dup_x2' },
                      { instruction: 'pop' },
                      { instruction: 'pop2' },
                      { instruction: 'pop' },

                      { instruction: 'iconst_1' },
                      { instruction: 'iconst_2' },
                      { instruction: 'dup2' },
                      { instruction: 'pop' },
                      { instruction: 'pop' },
                      { instruction: 'pop' },
                      { instruction: 'pop' },

                      { instruction: { op: 'ldc2_w', arg: 2n } },
                      { instruction: 'dup2' },
                      { instruction: 'pop2' },
                      { instruction: 'pop2' },

                      { instruction: 'iconst_1' },
                      { instruction: 'iconst_2' },
                      { instruction: 'iconst_3' },
                      { instruction: 'dup2_x1' },
                      { instruction: 'pop' },
                      { instruction: 'pop' },
                      { instruction: 'pop' },
                      { instruction: 'pop' },
                      { instruction: 'pop' },

                      { instruction: 'iconst_5' },
                      { instruction: { op: 'ldc2_w', arg: 3n } },
                      { instruction: 'dup2_x1' },
                      { instruction: 'pop2' },
                      { instruction: 'pop' },
                      { instruction: 'pop2' },

                      { instruction: 'iconst_1' },
                      { instruction: 'iconst_2' },
                      { instruction: 'iconst_3' },
                      { instruction: 'iconst_4' },
                      { instruction: 'dup2_x2' },
                      { instruction: 'pop' },
                      { instruction: 'pop' },
                      { instruction: 'pop' },
                      { instruction: 'pop' },
                      { instruction: 'pop' },
                      { instruction: 'pop' },

                      { instruction: 'iconst_6' },
                      { instruction: 'iconst_7' },
                      { instruction: { op: 'ldc2_w', arg: 4n } },
                      { instruction: 'dup2_x2' },
                      { instruction: 'pop2' },
                      { instruction: 'pop' },
                      { instruction: 'pop' },
                      { instruction: 'pop2' },

                      { instruction: { op: 'ldc2_w', arg: 5n } },
                      { instruction: 'iconst_8' },
                      { instruction: 'iconst_9' },
                      { instruction: 'dup2_x2' },
                      { instruction: 'pop' },
                      { instruction: 'pop' },
                      { instruction: 'pop2' },
                      { instruction: 'pop' },
                      { instruction: 'pop' },

                      { instruction: { op: 'ldc2_w', arg: 6n } },
                      { instruction: { op: 'ldc2_w', arg: 7n } },
                      { instruction: 'dup2_x2' },
                      { instruction: 'pop2' },
                      { instruction: 'pop2' },
                      { instruction: 'pop2' },

                      { instruction: 'iconst_1' },
                      { instruction: 'iconst_2' },
                      { instruction: 'swap' },
                      { instruction: 'pop' },
                      { instruction: 'pop' },

                      { instruction: 'return' },
                    ],
                    exceptionTable: [],
                    attributes: [],
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function createStoreLoadProgram() {
  return {
    classes: [
      {
        className: 'StoreLoad',
        items: [
          {
            type: 'method',
            method: {
              name: 'test',
              descriptor: '()V',
              flags: ['public', 'static'],
              attributes: [
                {
                  type: 'code',
                  code: {
                    stackSize: '4',
                    localsSize: '8',
                    codeItems: [
                      { instruction: { op: 'ldc2_w', arg: 42n } },
                      { instruction: 'lstore_1' },
                      { instruction: 'lload_1' },
                      { instruction: 'pop2' },

                      { instruction: { op: 'ldc', arg: { value: 1.75, type: 'Float' } } },
                      { instruction: 'fstore_3' },
                      { instruction: 'fload_3' },
                      { instruction: 'pop' },

                      { instruction: { op: 'ldc2_w', arg: { value: 2.5, type: 'Double' } } },
                      { instruction: { op: 'dstore', arg: '4' } },
                      { instruction: { op: 'dload', arg: '4' } },
                      { instruction: 'pop2' },

                      { instruction: 'aconst_null' },
                      { instruction: { op: 'astore', arg: '6' } },
                      { instruction: { op: 'aload', arg: '6' } },
                      { instruction: 'pop' },

                      { instruction: 'return' },
                    ],
                    exceptionTable: [],
                    attributes: [],
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function createLargeIntFoldProgram() {
  return {
    classes: [
      {
        className: 'LargeInt',
        items: [
          {
            type: 'method',
            method: {
              name: 'compute',
              descriptor: '()I',
              flags: ['public', 'static'],
              attributes: [
                {
                  type: 'code',
                  code: {
                    stackSize: '2',
                    localsSize: '0',
                    codeItems: [
                      { instruction: { op: 'sipush', arg: '30000' } },
                      { instruction: { op: 'sipush', arg: '30000' } },
                      { instruction: 'iadd' },
                      { instruction: 'ireturn' },
                    ],
                    exceptionTable: [],
                    attributes: [],
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function collectUnsupported(cfg) {
  const unsupported = [];
  for (const block of cfg.blocks.values()) {
    for (const instr of block.instructions) {
      if (instr && instr.unsupported) {
        unsupported.push(instr);
      }
    }
  }
  return unsupported;
}

function getCodeFromMethod(method) {
  const codeAttr = (method.attributes || []).find(({ type }) => type === 'code');
  if (!codeAttr) {
    throw new Error('Method is missing code attribute');
  }
  return codeAttr.code;
}

function listInstructionOps(method) {
  return getCodeFromMethod(method).codeItems
    .filter((item) => item.instruction)
    .map((item) => {
      const { instruction } = item;
      if (typeof instruction === 'string') {
        return instruction;
      }
      return instruction.op;
    });
}

test('CFG passes support advanced stack manipulation opcodes', (t) => {
  const program = createStackManipulationProgram();
  const method = program.classes[0].items[0].method;
  const cfg = convertAstToCfg(method);

  constantFoldCfg(cfg);
  const unsupportedAfterFold = collectUnsupported(cfg);
  t.equal(unsupportedAfterFold.length, 0, 'constant folding should accept stack manipulation opcodes');

  const { optimizedCfg } = eliminateDeadCodeCfg(cfg);
  const unsupportedAfterDce = collectUnsupported(optimizedCfg);
  t.equal(unsupportedAfterDce.length, 0, 'dead code elimination should accept stack manipulation opcodes');

  t.end();
});

test('store/load peephole supports wide and reference constants', (t) => {
  const program = createStoreLoadProgram();
  const method = program.classes[0].items[0].method;
  const cfg = convertAstToCfg(method);

  constantFoldCfg(cfg);
  const optimizedMethod = reconstructAstFromCfg(cfg, method);
  const optimizedOps = listInstructionOps(optimizedMethod);

  t.notOk(optimizedOps.includes('lload_1'), 'should replace long load with constant');
  t.notOk(optimizedOps.includes('fload_3'), 'should replace float load with constant');
  t.notOk(optimizedOps.includes('dload'), 'should replace double load with constant');
  t.notOk(optimizedOps.includes('aload'), 'should replace reference load with constant');

  const nopCount = optimizedOps.filter((op) => op === 'nop').length;
  t.ok(nopCount >= 4, 'should eliminate redundant store/load pairs');
  t.ok(optimizedOps.includes('return'), 'should preserve method return');

  t.end();
});

test('constant folding emits ldc for large int results', (t) => {
  const program = createLargeIntFoldProgram();
  const method = program.classes[0].items[0].method;
  const cfg = convertAstToCfg(method);

  constantFoldCfg(cfg);
  const optimizedMethod = reconstructAstFromCfg(cfg, method);
  const optimizedCode = getCodeFromMethod(optimizedMethod);
  const optimizedInstructions = optimizedCode.codeItems
    .map((item) => item.instruction)
    .filter(Boolean);

  const ldcInstruction = optimizedInstructions.find(
    (instruction) => typeof instruction === 'object' && instruction.op === 'ldc'
  );

  t.ok(ldcInstruction, 'should produce ldc for large integer constants');
  t.equal(ldcInstruction.arg, 60000, 'should embed folded constant value');
  t.equal(
    optimizedInstructions.filter((instruction) => instruction === 'iadd').length,
    0,
    'should eliminate redundant addition'
  );

  t.end();
});
