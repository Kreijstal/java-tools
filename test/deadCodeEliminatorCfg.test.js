const test = require('tape');
const { convertAstToCfg } = require('../src/ast-to-cfg');
const { eliminateDeadCodeCfg } = require('../src/deadCodeEliminator-cfg');
const { reconstructAstFromCfg } = require('../src/cfg-to-ast');

function buildFakeCatchMethod() {
  return {
    name: 'funnel',
    descriptor: '()V',
    attributes: [
      {
        type: 'code',
        code: {
          stackSize: '2',
          localsSize: '1',
          codeItems: [
            {
              pc: 0,
              labelDef: 'L0:',
              instruction: { op: 'goto', arg: 'L2' },
            },
            {
              pc: 1,
              labelDef: 'L1:',
              instruction: 'athrow',
            },
            {
              pc: 2,
              labelDef: 'L2:',
              instruction: 'return',
            },
          ],
          exceptionTable: [],
          attributes: [],
        },
      },
    ],
  };
}

test('eliminateDeadCodeCfg removes unreachable throw blocks', (t) => {
  t.plan(3);

  const methodAst = buildFakeCatchMethod();
  const cfg = convertAstToCfg(methodAst);
  const { changed, optimizedCfg } = eliminateDeadCodeCfg(cfg);

  t.ok(changed, 'should report changes when pruning unreachable blocks');

  const optimizedMethod = reconstructAstFromCfg(optimizedCfg, methodAst);
  const codeAttr = optimizedMethod.attributes.find((attr) => attr.type === 'code');
  const ops = codeAttr.code.codeItems
    .map((item) => item.instruction)
    .filter(Boolean)
    .map((instr) => (typeof instr === 'string' ? instr : instr.op));

  t.equal(
    ops.filter((op) => op === 'athrow').length,
    0,
    'athrow should be removed when its block becomes unreachable',
  );
  t.deepEqual(ops, ['return'], 'redundant goto should be simplified away');
  t.end();
});

function buildGotoIntoHandlerMethod() {
  return {
    name: 'obfuscated',
    descriptor: '(I)I',
    flags: ['public', 'static'],
    attributes: [
      {
        type: 'code',
        code: {
          stackSize: '3',
          localsSize: '2',
          codeItems: [
            { pc: 0, labelDef: 'L0:', instruction: 'iload_0' },
            { pc: 1, labelDef: 'L1:', instruction: 'iconst_5' },
            { pc: 2, labelDef: 'L2:', instruction: { op: 'if_icmpgt', arg: 'L6' } },
            { pc: 3, labelDef: 'L3:', instruction: { op: 'goto', arg: 'L10' } },
            { pc: 4, labelDef: 'L4:', instruction: 'iconst_1' },
            { pc: 5, labelDef: 'L5:', instruction: 'ireturn' },
            { pc: 6, labelDef: 'L6:', instruction: 'iconst_0' },
            { pc: 7, labelDef: 'L7:', instruction: 'ireturn' },
            { pc: 10, labelDef: 'L10:', instruction: 'astore_1' },
            { pc: 11, labelDef: 'L11:', instruction: 'aload_1' },
            { pc: 12, labelDef: 'L12:', instruction: 'athrow' },
          ],
          exceptionTable: [
            {
              start_pc: 0,
              end_pc: 5,
              handler_pc: 10,
              catch_type: 'java/lang/RuntimeException',
            },
          ],
          attributes: [],
        },
      },
    ],
  };
}

test('eliminateDeadCodeCfg handles handler blocks targeted by direct gotos', (t) => {
  const methodAst = buildGotoIntoHandlerMethod();
  const cfg = convertAstToCfg(methodAst);
  const { optimizedCfg } = eliminateDeadCodeCfg(cfg);

  t.doesNotThrow(() => {
    const optimizedMethod = reconstructAstFromCfg(optimizedCfg, methodAst);
    const codeAttr = optimizedMethod.attributes.find((attr) => attr.type === 'code');
    t.ok(codeAttr, 'optimized method should still have code attribute');
  }, 'reconstruction should not throw when handler has normal predecessors');

  t.end();
});

function buildInductionMethod() {
  return {
    name: 'loop',
    descriptor: '(I)I',
    flags: ['public', 'static'],
    attributes: [
      {
        type: 'code',
        code: {
          stackSize: '2',
          localsSize: '2',
          codeItems: [
            { pc: 0, labelDef: 'L0:', instruction: 'iconst_0' },
            { pc: 1, labelDef: 'L1:', instruction: 'istore_1' },
            { pc: 2, labelDef: 'L2:', instruction: 'iload_1' },
            { pc: 3, labelDef: 'L3:', instruction: 'iload_0' },
            { pc: 4, labelDef: 'L4:', instruction: { op: 'if_icmpge', arg: 'L10' } },
            { pc: 5, labelDef: 'L5:', instruction: { op: 'iinc', varnum: '1', incr: '1' } },
            { pc: 6, labelDef: 'L6:', instruction: { op: 'goto', arg: 'L2' } },
            { pc: 10, labelDef: 'L10:', instruction: 'iload_1' },
            { pc: 11, labelDef: 'L11:', instruction: 'ireturn' },
          ],
          exceptionTable: [],
          attributes: [],
        },
      },
    ],
  };
}

test('eliminateDeadCodeCfg preserves induction-variable updates', (t) => {
  const methodAst = buildInductionMethod();
  const cfg = convertAstToCfg(methodAst);
  const { optimizedCfg } = eliminateDeadCodeCfg(cfg);
  const optimized = reconstructAstFromCfg(optimizedCfg, methodAst);
  const ops = optimized.attributes
    .find((attr) => attr.type === 'code')
    .code.codeItems.map((item) => item.instruction)
    .filter(Boolean)
    .map((instr) => (typeof instr === 'string' ? instr : instr.op));
  t.ok(ops.includes('iinc'), 'iinc instruction should remain live');
  t.deepEqual(
    ops.slice(0, 6),
    ['iconst_0', 'istore_1', 'iload_1', 'iload_0', 'if_icmpge', 'iinc'],
    'loop prologue should stay intact',
  );
  t.end();
});

function buildDeadLoopMethod() {
  return {
    name: 'discardedLoop',
    descriptor: '(I)I',
    flags: ['public', 'static'],
    attributes: [
      {
        type: 'code',
        code: {
          stackSize: '2',
          localsSize: '2',
          codeItems: [
            { pc: 0, labelDef: 'L0:', instruction: 'iconst_0' },
            { pc: 1, labelDef: null, instruction: 'istore_1' },
            { pc: 2, labelDef: 'L2:', instruction: 'iload_1' },
            { pc: 3, labelDef: null, instruction: 'iload_0' },
            { pc: 4, labelDef: null, instruction: { op: 'if_icmpge', arg: 'L10' } },
            { pc: 5, labelDef: null, instruction: { op: 'iinc', varnum: '1', incr: '1' } },
            { pc: 6, labelDef: null, instruction: { op: 'goto', arg: 'L2' } },
            { pc: 10, labelDef: 'L10:', instruction: 'iconst_0' },
            { pc: 11, labelDef: null, instruction: 'ireturn' },
          ],
          exceptionTable: [],
          attributes: [],
        },
      },
    ],
  };
}

test('eliminateDeadCodeCfg removes loops whose result is discarded', (t) => {
  const methodAst = buildDeadLoopMethod();
  const cfg = convertAstToCfg(methodAst);
  const { optimizedCfg } = eliminateDeadCodeCfg(cfg);
  const optimized = reconstructAstFromCfg(optimizedCfg, methodAst);
  const ops = optimized.attributes
    .find((attr) => attr.type === 'code')
    .code.codeItems.map((item) => item.instruction)
    .filter(Boolean)
    .map((instr) => (typeof instr === 'string' ? instr : instr.op));
  t.deepEqual(ops, ['iconst_0', 'ireturn'], 'dead loop should be folded away');
  t.end();
});

function buildPureSumLoopMethod() {
  return {
    name: 'pureLoop',
    descriptor: '(II)I',
    flags: ['public', 'static'],
    attributes: [
      {
        type: 'code',
        code: {
          stackSize: '3',
          localsSize: '3',
          codeItems: [
            { pc: 0, labelDef: 'L0:', instruction: 'iload_0' },
            { pc: 1, labelDef: 'L1:', instruction: 'istore_2' },
            { pc: 2, labelDef: 'L2:', instruction: 'iload_2' },
            { pc: 3, labelDef: 'L3:', instruction: 'iload_1' },
            { pc: 4, labelDef: 'L4:', instruction: { op: 'if_icmpge', arg: 'L10' } },
            { pc: 5, labelDef: 'L5:', instruction: { op: 'iinc', varnum: '2', incr: '1' } },
            { pc: 6, labelDef: 'L6:', instruction: { op: 'goto', arg: 'L2' } },
            { pc: 10, labelDef: 'L10:', instruction: 'iload_0' },
            { pc: 11, labelDef: null, instruction: 'iload_1' },
            { pc: 12, labelDef: null, instruction: 'iadd' },
            { pc: 13, labelDef: null, instruction: 'ireturn' },
          ],
          exceptionTable: [],
          attributes: [],
        },
      },
    ],
  };
}

test('eliminateDeadCodeCfg removes unused pure loops', (t) => {
  const methodAst = buildPureSumLoopMethod();
  const cfg = convertAstToCfg(methodAst);
  const { optimizedCfg } = eliminateDeadCodeCfg(cfg);
  const optimized = reconstructAstFromCfg(optimizedCfg, methodAst);
  const ops = optimized.attributes
    .find((attr) => attr.type === 'code')
    .code.codeItems
    .map((item) => item.instruction)
    .filter(Boolean)
    .map((instr) => (typeof instr === 'string' ? instr : instr.op));
  t.deepEqual(ops, ['iload_0', 'iload_1', 'iadd', 'ireturn'], 'loop replaced with direct addition');
  t.end();
});

function buildConditionalWithLabelGapMethod() {
  return {
    name: 'gap',
    descriptor: '()V',
    flags: ['public', 'static'],
    attributes: [
      {
        type: 'code',
        code: {
          stackSize: '2',
          localsSize: '2',
          codeItems: [
            { pc: 0, labelDef: 'L0:', instruction: 'iconst_0' },
            { pc: 1, labelDef: 'L1:', instruction: 'iconst_1' },
            { pc: 2, labelDef: 'L2:', instruction: { op: 'if_icmpeq', arg: 'L10' } },
            { labelDef: 'Lgap:' },
            { pc: 3, labelDef: 'L3:', instruction: 'iconst_2' },
            { pc: 4, labelDef: 'L4:', instruction: { op: 'goto', arg: 'L20' } },
            { pc: 10, labelDef: 'L10:', instruction: 'iconst_3' },
            { pc: 11, labelDef: 'L11:', instruction: 'ireturn' },
            { pc: 20, labelDef: 'L20:', instruction: 'return' },
          ],
          exceptionTable: [],
          attributes: [],
        },
      },
    ],
  };
}

test('convertAstToCfg records edges for mid-block conditionals', (t) => {
  const methodAst = buildConditionalWithLabelGapMethod();
  const cfg = convertAstToCfg(methodAst);
  const targetBlock = cfg.blocks.get('block_10');
  t.ok(targetBlock, 'target block should exist');
  t.ok(
    targetBlock.predecessors.includes(cfg.entryBlockId),
    'conditional target retains predecessor even when fallthrough label lacks pc',
  );
  t.end();
});
