'use strict';

const test = require('tape');
const { runPeepholeClean } = require('../src/passes/peepholeClean');

function astWith(codeItems, exceptionTable = []) {
  return {
    classes: [
      {
        className: 'Peephole',
        items: [
          {
            type: 'method',
            method: {
              name: 'f',
              descriptor: '()V',
              attributes: [
                {
                  type: 'code',
                  code: {
                    codeItems,
                    exceptionTable,
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

function code(ast) {
  return ast.classes[0].items[0].method.attributes[0].code;
}

test('peephole clean removes nops and unused labels', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: 'nop' },
    { labelDef: 'L1:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast);
  t.ok(result.changed);
  t.equal(result.details.nops, 1);
  t.equal(result.details.unusedLabels, 2);
  t.deepEqual(
    code(ast).codeItems.map((item) => item.instruction).filter(Boolean),
    ['return'],
  );
  t.end();
});

test('peephole clean removes single-use goto to following label', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'goto', arg: 'L1' } },
    { labelDef: 'L1:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast);
  t.ok(result.changed);
  t.equal(result.details.fallthroughGotos, 1);
  t.deepEqual(
    code(ast).codeItems.map((item) => item.instruction).filter(Boolean),
    ['return'],
  );
  t.end();
});

test('peephole clean threads conditional branches through goto bridges', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: 'iload_1' },
    { instruction: { op: 'ifeq', arg: 'L1' } },
    { instruction: 'return' },
    { labelDef: 'L1:', instruction: { op: 'goto', arg: 'L2' } },
    { labelDef: 'L2:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast);
  t.ok(result.changed);
  t.equal(result.details.threadedBranches, 1);
  t.deepEqual(code(ast).codeItems[1].instruction, { op: 'ifeq', arg: 'L2' });
  t.end();
});

test('peephole clean does not thread through labelled non-bridge blocks', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: 'iload_1' },
    { instruction: { op: 'ifeq', arg: 'L1' } },
    { instruction: 'return' },
    { labelDef: 'L1:' },
    { labelDef: 'Lmid:', instruction: { op: 'goto', arg: 'L2' } },
    { labelDef: 'L2:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast);
  t.equal(result.details.threadedBranches, 0);
  t.deepEqual(code(ast).codeItems[1].instruction, { op: 'ifeq', arg: 'L1' });
  t.end();
});

test('peephole clean does not thread shared goto bridges', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: 'iload_1' },
    { instruction: { op: 'ifeq', arg: 'L1' } },
    { instruction: { op: 'goto', arg: 'L1' } },
    { labelDef: 'L1:', instruction: { op: 'goto', arg: 'L2' } },
    { labelDef: 'L2:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast);
  t.equal(result.details.threadedBranches, 0);
  t.deepEqual(code(ast).codeItems[1].instruction, { op: 'ifeq', arg: 'L1' });
  t.end();
});

test('peephole clean does not thread labels reached by fallthrough', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: 'iload_1' },
    { instruction: { op: 'ifeq', arg: 'L1' } },
    { instruction: 'iconst_0' },
    { labelDef: 'L1:', instruction: { op: 'goto', arg: 'L2' } },
    { labelDef: 'L2:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast);
  t.equal(result.details.threadedBranches, 0);
  t.deepEqual(code(ast).codeItems[1].instruction, { op: 'ifeq', arg: 'L1' });
  t.end();
});

test('peephole clean removes unreachable code after terminal instructions', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: 'iconst_0' },
    { instruction: 'ireturn' },
    { labelDef: 'Ldead:', instruction: { op: 'goto', arg: 'L0' } },
  ]);

  const result = runPeepholeClean(ast);
  t.ok(result.changed);
  t.equal(result.details.unreachableInstructions, 1);
  t.deepEqual(
    code(ast).codeItems.map((item) => item.instruction).filter(Boolean),
    ['iconst_0', 'ireturn'],
  );
  t.end();
});

test('peephole clean keeps reachable labelled code after terminal instructions', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: 'iload_1' },
    { instruction: { op: 'ifeq', arg: 'Llive' } },
    { instruction: 'return' },
    { labelDef: 'Llive:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast);
  t.equal(result.details.unreachableInstructions, 0);
  t.deepEqual(
    code(ast).codeItems.map((item) => item.instruction).filter(Boolean),
    ['iload_1', { op: 'ifeq', arg: 'Llive' }, 'return', 'return'],
  );
  t.end();
});

test('peephole clean keeps handler athrow sentinels by default', (t) => {
  const ast = astWith(
    [
      { pc: 0, labelDef: 'L0:', instruction: { op: 'goto', arg: 'L2' } },
      { pc: 1, labelDef: 'L1:', instruction: 'athrow' },
      { pc: 2, labelDef: 'L2:', instruction: 'return' },
    ],
    [
      {
        start_pc: 0,
        end_pc: 1,
        handler_pc: 1,
        catch_type: 'java/lang/RuntimeException',
        startLbl: 'L0',
        endLbl: 'L1',
        handlerLbl: 'L1',
      },
    ],
  );

  const result = runPeepholeClean(ast, { removeHandlerCode: false });
  t.ok(result.changed);
  t.equal(code(ast).exceptionTable.length, 0);
  t.deepEqual(
    code(ast).codeItems.map((item) => item.instruction).filter(Boolean).map((insn) => (typeof insn === 'string' ? insn : insn.op)),
    ['goto', 'athrow', 'return'],
  );
  t.end();
});

test('peephole clean clones stack-neutral shared forward loop entry', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: 'iload_1' },
    { instruction: { op: 'iflt', arg: 'Lneg' } },
    { instruction: { op: 'goto', arg: 'Lloop' } },
    { labelDef: 'Lneg:', instruction: 'iinc 1 1' },
    { instruction: { op: 'goto', arg: 'Lloop' } },
    { labelDef: 'Lloop:', instruction: 'iload_1' },
    { labelDef: 'Lcond:', instruction: { op: 'ifge', arg: 'Lend' } },
    { instruction: 'iinc 1 1' },
    { instruction: { op: 'goto', arg: 'Lcond' } },
    { labelDef: 'Lend:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast);
  t.ok(result.changed);
  t.equal(result.details.forwardLoopEntryClones, 1);
  t.notDeepEqual(code(ast).codeItems[2].instruction, { op: 'goto', arg: 'Lloop' });
  t.end();
});

test('peephole clean coalesces duplicate loop tail updates', (t) => {
  const ast = astWith([
    { labelDef: 'Lhead:', instruction: 'iload_1' },
    { instruction: { op: 'ifge', arg: 'Lend' } },
    { instruction: 'iload_2' },
    { instruction: { op: 'ifeq', arg: 'Lbody' } },
    { instruction: 'iload_3' },
    { instruction: 'iconst_1' },
    { instruction: 'ishl' },
    { instruction: 'istore_3' },
    { instruction: 'iinc 1 1' },
    { instruction: { op: 'goto', arg: 'Lhead' } },
    { labelDef: 'Lbody:', instruction: 'iinc 4 1' },
    { labelDef: 'Ltail:', instruction: 'iload_3' },
    { instruction: 'iconst_1' },
    { instruction: 'ishl' },
    { instruction: 'istore_3' },
    { instruction: 'iinc 1 1' },
    { instruction: { op: 'goto', arg: 'Lhead' } },
    { labelDef: 'Lend:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast);
  t.ok(result.changed);
  t.equal(result.details.duplicateLoopTails, 1);
  t.ok(code(ast).codeItems.some((item) => item && item.instruction && item.instruction.op === 'goto' && item.instruction.arg === 'Ltail'));
  t.end();
});

test('peephole clean does not clone shared loop entry when branch block has live stack', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: 'iconst_1' },
    { instruction: 'iload_1' },
    { instruction: { op: 'iflt', arg: 'Lneg' } },
    { instruction: { op: 'goto', arg: 'Lloop' } },
    { labelDef: 'Lneg:', instruction: 'pop' },
    { instruction: { op: 'goto', arg: 'Lloop' } },
    { labelDef: 'Lloop:', instruction: 'iload_1' },
    { labelDef: 'Lcond:', instruction: { op: 'ifge', arg: 'Lend' } },
    { instruction: 'iinc 1 1' },
    { instruction: { op: 'goto', arg: 'Lcond' } },
    { labelDef: 'Lend:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast);
  t.equal(result.details.forwardLoopEntryClones, 0);
  t.deepEqual(code(ast).codeItems[3].instruction, { op: 'goto', arg: 'Lloop' });
  t.end();
});
