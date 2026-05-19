'use strict';

const test = require('tape');
const { runPeepholeClean, normalizeDupStoreCompareBranches } = require('../src/passes/peepholeClean');

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

  const result = runPeepholeClean(ast, { removeDeadGotoIslands: true });
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

  const result = runPeepholeClean(ast, { removeDeadGotoIslands: true });
  t.ok(result.changed);
  t.equal(result.details.fallthroughGotos, 1);
  t.deepEqual(
    code(ast).codeItems.map((item) => item.instruction).filter(Boolean),
    ['return'],
  );
  t.end();
});

test('peephole clean removes multi-use goto to following label', (t) => {
  const ast = astWith([
    { instruction: 'iload_1' },
    { instruction: { op: 'ifeq', arg: 'L1' } },
    { instruction: 'iconst_0' },
    { instruction: 'pop' },
    { instruction: { op: 'goto', arg: 'L1' } },
    { labelDef: 'L1:', instruction: 'return' },
  ]);
  ast.classes[0].items[0].method.name = '<init>';

  const result = runPeepholeClean(ast);
  t.ok(result.changed);
  t.equal(result.details.fallthroughGotos, 1);
  t.deepEqual(
    code(ast).codeItems.map((item) => item.instruction).filter(Boolean),
    ['iload_1', { op: 'ifeq', arg: 'L1' }, 'iconst_0', 'pop', 'return'],
  );
  t.end();
});

test('peephole clean keeps multi-use goto to following label outside constructors', (t) => {
  const ast = astWith([
    { instruction: 'iload_1' },
    { instruction: { op: 'ifeq', arg: 'L1' } },
    { instruction: 'iconst_0' },
    { instruction: 'pop' },
    { instruction: { op: 'goto', arg: 'L1' } },
    { labelDef: 'L1:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast);
  t.equal(result.details.fallthroughGotos, 0);
  t.ok(code(ast).codeItems.some((item) => item.instruction && item.instruction.op === 'goto'));
  t.end();
});

test('peephole clean inverts conditional over goto in ordinary methods', (t) => {
  const ast = astWith([
    { instruction: 'iload_1' },
    { instruction: { op: 'iflt', arg: 'Lbody' } },
    { instruction: { op: 'goto', arg: 'Lexit' } },
    { labelDef: 'Lbody:', instruction: 'iconst_0' },
    { instruction: 'pop' },
    { labelDef: 'Lexit:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast, { invertConditionalsOverGoto: true });
  t.ok(result.changed);
  t.equal(result.details.invertedFallthroughGotos, 1);
  t.deepEqual(code(ast).codeItems[1].instruction, { op: 'ifge', arg: 'Lexit' });
  t.equal(code(ast).codeItems.some((item) => item.instruction && item.instruction.op === 'goto' && item.instruction.arg === 'Lexit'), false);
  t.end();
});

test('peephole clean can clone shared fallthrough join for goto path', (t) => {
  const ast = astWith([
    { instruction: 'aload_1' },
    { instruction: { op: 'ifnonnull', arg: 'Ljoin' } },
    { instruction: 'aload_2' },
    { instruction: { op: 'ifnull', arg: 'Lnext' } },
    { instruction: 'aload_0' },
    { instruction: 'aload_2' },
    { instruction: 'putfield Field Example f Ljava/lang/Object;' },
    { instruction: { op: 'goto', arg: 'Ljoin' } },
    { labelDef: 'Ljoin:', instruction: 'iload_3' },
    { instruction: { op: 'ifne', arg: 'Lnext' } },
    { instruction: 'iconst_0' },
    { instruction: 'istore_3' },
    { labelDef: 'Lnext:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast, { cloneSharedFallthroughJoins: true });
  t.ok(result.changed);
  t.equal(result.details.sharedFallthroughJoinClones, 1);
  t.equal(code(ast).codeItems.some((item) => item.instruction && item.instruction.op === 'goto' && item.instruction.arg === 'Ljoin'), false);
  t.ok(code(ast).codeItems.some((item) => item.instruction && item.instruction.op === 'goto' && item.instruction.arg === 'Lnext'));
  t.deepEqual(code(ast).codeItems[1].instruction, { op: 'ifnonnull', arg: 'Ljoin' });
  t.end();
});

test('peephole clean can clone conditional shared join for one predecessor', (t) => {
  const ast = astWith([
    { instruction: 'aload_1' },
    { instruction: 'ifnull Ljoin' },
    { instruction: 'iconst_0' },
    { instruction: 'istore_2' },
    { instruction: { op: 'ifeq', arg: 'Ljoin' } },
    { instruction: 'iconst_1' },
    { instruction: 'istore_3' },
    { instruction: { op: 'goto', arg: 'Lnext' } },
    { labelDef: 'Ljoin:', instruction: 'iconst_m1' },
    { instruction: 'istore_3' },
    { labelDef: 'Lnext:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast, { cloneConditionalSharedJoins: true });
  t.ok(result.changed);
  t.equal(result.details.conditionalSharedJoinClones, 1);
  t.notEqual(code(ast).codeItems[1].instruction, 'ifnull Ljoin');
  t.ok(code(ast).codeItems.some((item) => item.labelDef && /^Lcsj/.test(item.labelDef)));
  t.ok(code(ast).codeItems.some((item) => item.instruction && item.instruction.op === 'goto' && item.instruction.arg === 'Lnext'));
  t.end();
});

test('peephole clean can materialize nullable shared join guards', (t) => {
  const ast = astWith([
    { instruction: 'aload 11' },
    { instruction: { op: 'ifnonnull', arg: 'Ljoin' } },
    { instruction: 'invokestatic Method Loader load ()Ljava/lang/Object;' },
    { instruction: 'astore 11' },
    { instruction: 'aconst_null' },
    { instruction: 'aload 11' },
    { instruction: { op: 'if_acmpne', arg: 'Lnonnull' } },
    { instruction: 'iconst_0' },
    { instruction: 'istore 6' },
    { instruction: { op: 'goto', arg: 'Lexit' } },
    { labelDef: 'Lnonnull:', instruction: 'aload_0' },
    { instruction: 'aload 11' },
    { instruction: 'putfield Field Example f Ljava/lang/Object;' },
    { instruction: { op: 'goto', arg: 'Ljoin' } },
    { labelDef: 'Ljoin:', instruction: 'aload 11' },
    { instruction: 'invokevirtual Method Obj use ()Z' },
    { instruction: { op: 'ifne', arg: 'Lexit' } },
    { instruction: 'iconst_0' },
    { instruction: 'istore 6' },
    { labelDef: 'Lexit:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast, { materializeNullableSharedJoinGuards: true });
  const items = code(ast).codeItems;
  const joinIdx = items.findIndex((item) => item.labelDef === 'Ljoin:');

  t.ok(result.changed);
  t.equal(result.details.nullableSharedJoinGuards, 1);
  t.deepEqual(items[joinIdx].instruction, { op: 'aload', arg: '11' });
  t.deepEqual(items[joinIdx + 1].instruction, { op: 'ifnull', arg: 'Lexit' });
  t.deepEqual(items[9].instruction, { op: 'goto', arg: 'Ljoin' });
  t.end();
});

test('peephole clean can clone small terminal shared forward blocks', (t) => {
  const ast = astWith([
    { instruction: 'iload_1' },
    { instruction: { op: 'ifeq', arg: 'Lbody' } },
    { instruction: { op: 'goto', arg: 'Ljoin' } },
    { labelDef: 'Lbody:', instruction: 'aload_0' },
    { instruction: 'iconst_0' },
    { instruction: { op: 'putfield', arg: 'Field Example f I' } },
    { instruction: { op: 'goto', arg: 'Ljoin' } },
    { labelDef: 'Ljoin:', instruction: 'aload_0' },
    { instruction: 'iconst_2' },
    { instruction: { op: 'putfield', arg: 'Field Example f I' } },
    { instruction: { op: 'goto', arg: 'Lexit' } },
    { labelDef: 'Lexit:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast, { cloneSmallTerminalSharedForwardBlocks: true });
  const items = code(ast).codeItems;

  t.ok(result.changed);
  t.equal(result.details.smallTerminalSharedBlockClones, 2);
  t.equal(items.some((item, index) =>
    index < 7 && item.instruction && item.instruction.op === 'goto' && item.instruction.arg === 'Ljoin'), false);
  t.equal(items.filter((item) => item.instruction && item.instruction.op === 'putfield').length, 4);
  t.end();
});

test('peephole clean removes dead goto islands after terminals', (t) => {
  const ast = astWith([
    { instruction: 'iload_1' },
    { instruction: { op: 'ifeq', arg: 'Lused' } },
    { instruction: { op: 'goto', arg: 'Lexit' } },
    { labelDef: 'Ldead1:', instruction: { op: 'goto', arg: 'LdeadBody' } },
    { labelDef: 'Ldead2:', instruction: { op: 'goto', arg: 'LdeadBody2' } },
    { labelDef: 'Lused:', instruction: 'iconst_0' },
    { instruction: 'pop' },
    { instruction: { op: 'goto', arg: 'Lexit' } },
    { labelDef: 'LdeadBody:', instruction: 'iconst_1' },
    { instruction: 'pop' },
    { instruction: { op: 'goto', arg: 'Lexit' } },
    { labelDef: 'LdeadBody2:', instruction: 'iconst_2' },
    { instruction: 'pop' },
    { instruction: { op: 'goto', arg: 'Lexit' } },
    { labelDef: 'Lexit:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast, { removeDeadGotoIslands: true });

  t.ok(result.changed);
  t.equal(result.details.deadGotoIslands, 2);
  t.equal(code(ast).codeItems.some((item) => item.instruction && item.instruction.arg === 'LdeadBody'), false);
  t.equal(code(ast).codeItems.some((item) => item.instruction && item.instruction.arg === 'LdeadBody2'), false);
  t.end();
});

test('peephole clean can clone conditional shared loop tail for one predecessor', (t) => {
  const ast = astWith([
    { labelDef: 'Lhead:', instruction: 'aload_1' },
    { instruction: 'ifnull Ltail' },
    { instruction: 'iload_2' },
    { instruction: { op: 'ifeq', arg: 'Ltail' } },
    { instruction: 'iconst_1' },
    { instruction: 'istore_3' },
    { instruction: { op: 'goto', arg: 'Lnext' } },
    { labelDef: 'Ltail:', instruction: 'iconst_m1' },
    { instruction: 'istore_3' },
    ...Array.from({ length: 100 }, () => ({ instruction: 'iinc 2 1' })),
    { instruction: 'iinc 2 1' },
    { instruction: { op: 'goto', arg: 'Lhead' } },
    { labelDef: 'Lnext:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast, { cloneConditionalSharedLoopTails: true });
  t.ok(result.changed);
  t.equal(result.details.conditionalSharedLoopTailClones, 1);
  t.notEqual(code(ast).codeItems[1].instruction, 'ifnull Ltail');
  t.ok(code(ast).codeItems.some((item) => item.labelDef && /^Lctl/.test(item.labelDef)));
  t.end();
});

test('peephole clean keeps class initializer conditional-goto shape', (t) => {
  const ast = astWith([
    { instruction: 'iload_1' },
    { instruction: { op: 'iflt', arg: 'Lbody' } },
    { instruction: { op: 'goto', arg: 'Lexit' } },
    { labelDef: 'Lbody:', instruction: 'iconst_0' },
    { instruction: 'pop' },
    { labelDef: 'Lexit:', instruction: 'return' },
  ]);
  ast.classes[0].items[0].method.name = '<clinit>';

  const result = runPeepholeClean(ast);
  t.equal(result.details.invertedFallthroughGotos, 0);
  t.deepEqual(code(ast).codeItems[1].instruction, { op: 'iflt', arg: 'Lbody' });
  t.deepEqual(code(ast).codeItems[2].instruction, { op: 'goto', arg: 'Lexit' });
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
  t.equal(result.details.unreachableInstructions + result.details.deadGotoIslands, 1);
  t.deepEqual(
    code(ast).codeItems.map((item) => item.instruction).filter(Boolean),
    ['iconst_0', 'ireturn'],
  );
  t.end();
});

test('peephole clean removes unreachable labelled code before used label when enabled', (t) => {
  const ast = astWith([
    { instruction: { op: 'goto', arg: 'Lend' } },
    { labelDef: 'Ldead:', instruction: 'iconst_0' },
    { instruction: 'istore_1' },
    { labelDef: 'Lend:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast, { removeUnreachableUntilUsedLabels: true });
  t.ok(result.changed);
  t.equal(result.details.unreachableInstructions, 2);
  t.deepEqual(
    code(ast).codeItems.map((item) => item.instruction).filter(Boolean),
    ['return'],
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

test('peephole clean clones conditional forward entry into loop with skip arm', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: 'iload_1' },
    { instruction: { op: 'ifge', arg: 'Lloop' } },
    { instruction: 'iload_2' },
    { instruction: { op: 'ifge', arg: 'Lclamp' } },
    { instruction: { op: 'iinc', varnum: '1', incr: '1' } },
    { instruction: { op: 'goto', arg: 'Lafter' } },
    { labelDef: 'Lclamp:', instruction: { op: 'iinc', varnum: '1', incr: '2' } },
    { labelDef: 'Lloop:', instruction: 'iload_1' },
    { instruction: { op: 'ifge', arg: 'Lafter' } },
    { instruction: { op: 'iinc', varnum: '1', incr: '1' } },
    { instruction: { op: 'goto', arg: 'Lloop' } },
    { labelDef: 'Lafter:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast);
  t.ok(result.changed);
  t.equal(result.details.conditionalForwardLoopEntryClones, 1);
  const branch = code(ast).codeItems[1].instruction;
  t.equal(branch.op, 'ifge');
  t.notEqual(branch.arg, 'Lloop', 'conditional entry retargeted to clone');
  t.ok(code(ast).codeItems.some((item) => item && item.instruction && item.instruction.op === 'goto' && item.instruction.arg === 'Lloop'), 'guard preserves original fallthrough target');
  t.end();
});

test('peephole clean does not clone conditional loop entry without skip arm', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: 'iload_1' },
    { instruction: { op: 'ifge', arg: 'Lloop' } },
    { instruction: { op: 'iinc', varnum: '1', incr: '2' } },
    { labelDef: 'Lloop:', instruction: 'iload_1' },
    { instruction: { op: 'ifge', arg: 'Lafter' } },
    { instruction: { op: 'iinc', varnum: '1', incr: '1' } },
    { instruction: { op: 'goto', arg: 'Lloop' } },
    { labelDef: 'Lafter:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast);
  t.equal(result.details.conditionalForwardLoopEntryClones, 0);
  t.deepEqual(code(ast).codeItems[1].instruction, { op: 'ifge', arg: 'Lloop' });
  t.end();
});

test('peephole clean clones conditional forward tail and shared assignment blocks', (t) => {
  const ast = astWith([
    { labelDef: 'Lhead:', instruction: 'iload_1' },
    { instruction: { op: 'ifge', arg: 'Ltail' } },
    { instruction: 'iload_2' },
    { instruction: { op: 'ifeq', arg: 'Ltail' } },
    { instruction: 'iload_2' },
    { instruction: { op: 'iflt', arg: 'Ltail' } },
    { instruction: 'iload_2' },
    { instruction: { op: 'ifgt', arg: 'Ltail' } },
    { instruction: { op: 'iinc', varnum: '2', incr: '1' } },
    { instruction: { op: 'goto', arg: 'Lnext' } },
    { labelDef: 'Ltail:', instruction: { op: 'goto', arg: 'Ls0' } },
    { labelDef: 'Ls0:', instruction: { op: 'goto', arg: 'Ls1' } },
    { labelDef: 'Ls1:', instruction: { op: 'goto', arg: 'Ls2' } },
    { labelDef: 'Ls2:', instruction: { op: 'goto', arg: 'Ls3' } },
    { labelDef: 'Ls3:', instruction: { op: 'goto', arg: 'Ls4' } },
    { labelDef: 'Ls4:', instruction: { op: 'goto', arg: 'Ls5' } },
    { labelDef: 'Ls5:', instruction: { op: 'goto', arg: 'Ls6' } },
    { labelDef: 'Ls6:', instruction: { op: 'goto', arg: 'Ls7' } },
    { labelDef: 'Ls7:', instruction: 'iload_2' },
    { instruction: { op: 'ifne', arg: 'Lassign' } },
    { instruction: { op: 'iinc', varnum: '2', incr: '1' } },
    { instruction: 'aload_0' },
    { instruction: 'iload_3' },
    { instruction: 'iconst_0' },
    { instruction: 'iastore' },
    { instruction: { op: 'goto', arg: 'Lassign' } },
    { labelDef: 'Lassign:', instruction: 'aload_0' },
    { instruction: 'iload_3' },
    { instruction: 'iconst_0' },
    { instruction: 'iastore' },
    { labelDef: 'Lnext:', instruction: { op: 'iinc', varnum: '1', incr: '1' } },
    { instruction: { op: 'goto', arg: 'Lhead' } },
    { labelDef: 'Lend:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast, { cloneForwardTails: true });
  t.ok(result.changed);
  t.equal(result.details.conditionalForwardTailClones, 1);
  t.ok(result.details.sharedFallthroughBlockClones >= 2);
  t.notEqual(code(ast).codeItems[1].instruction.arg, 'Ltail');
  t.end();
});

test('peephole clean leaves aggressive forward tail cloning disabled by default', (t) => {
  const ast = astWith([
    { labelDef: 'Lhead:', instruction: 'iload_1' },
    { instruction: { op: 'ifge', arg: 'Ltail' } },
    { instruction: 'iload_2' },
    { instruction: { op: 'ifeq', arg: 'Ltail' } },
    { instruction: 'iload_2' },
    { instruction: { op: 'iflt', arg: 'Ltail' } },
    { instruction: 'iload_2' },
    { instruction: { op: 'ifgt', arg: 'Ltail' } },
    { instruction: { op: 'iinc', varnum: '2', incr: '1' } },
    { instruction: { op: 'goto', arg: 'Lnext' } },
    { labelDef: 'Ltail:', instruction: { op: 'goto', arg: 'Ls0' } },
    { labelDef: 'Ls0:', instruction: { op: 'goto', arg: 'Ls1' } },
    { labelDef: 'Ls1:', instruction: { op: 'goto', arg: 'Ls2' } },
    { labelDef: 'Ls2:', instruction: { op: 'goto', arg: 'Ls3' } },
    { labelDef: 'Ls3:', instruction: { op: 'goto', arg: 'Ls4' } },
    { labelDef: 'Ls4:', instruction: { op: 'goto', arg: 'Ls5' } },
    { labelDef: 'Ls5:', instruction: { op: 'goto', arg: 'Ls6' } },
    { labelDef: 'Ls6:', instruction: { op: 'goto', arg: 'Ls7' } },
    { labelDef: 'Ls7:', instruction: 'iload_2' },
    { instruction: { op: 'ifne', arg: 'Lassign' } },
    { instruction: { op: 'iinc', varnum: '2', incr: '1' } },
    { instruction: 'aload_0' },
    { instruction: 'iload_3' },
    { instruction: 'iconst_0' },
    { instruction: 'iastore' },
    { instruction: { op: 'goto', arg: 'Lassign' } },
    { labelDef: 'Lassign:', instruction: 'aload_0' },
    { instruction: 'iload_3' },
    { instruction: 'iconst_0' },
    { instruction: 'iastore' },
    { labelDef: 'Lnext:', instruction: { op: 'iinc', varnum: '1', incr: '1' } },
    { instruction: { op: 'goto', arg: 'Lhead' } },
    { labelDef: 'Lend:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast);
  t.equal(result.details.conditionalForwardTailClones, 0);
  t.equal(result.details.sharedFallthroughBlockClones, 0);
  t.equal(code(ast).codeItems[1].instruction.arg, 'Ltail');
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

test('peephole clean coalesces loop producer bridge', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: 'bipush 6' },
    { instruction: { op: 'goto', arg: 'Lcond' } },
    { labelDef: 'Lbody:', instruction: 'iinc 1 1' },
    { labelDef: 'Lbound:', instruction: 'bipush 6' },
    { labelDef: 'Lcond:', instruction: 'iload_1' },
    { instruction: { op: 'if_icmple', arg: 'Lend' } },
    { instruction: { op: 'goto', arg: 'Lbound' } },
    { labelDef: 'Lend:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast);
  t.ok(result.changed);
  t.equal(result.details.loopProducerBridges, 1);
  t.deepEqual(code(ast).codeItems[0].instruction, { op: 'goto', arg: 'Lbound' });
  t.end();
});

test('peephole clean gates protected loop producer bridge', (t) => {
  const items = [
    { labelDef: 'L0:', instruction: 'iconst_0' },
    { instruction: { op: 'goto', arg: 'Lcond' } },
    { labelDef: 'Lbody:', instruction: 'iinc 1 1' },
    { labelDef: 'Lbound:', instruction: 'iconst_0' },
    { labelDef: 'Lcond:', instruction: 'iload_1' },
    { instruction: { op: 'if_icmpgt', arg: 'Lend' } },
    { instruction: { op: 'goto', arg: 'Lbound' } },
    { labelDef: 'Lend:', instruction: 'return' },
  ];
  const exceptionTable = [{ startLbl: 'Lbound', endLbl: 'Lend', handlerLbl: 'Lend', catchType: 'java/lang/Throwable' }];

  const defaultAst = astWith(items.map((item) => ({ ...item })), exceptionTable);
  const defaultResult = runPeepholeClean(defaultAst);
  t.equal(defaultResult.details.loopProducerBridges, 0);
  t.equal(code(defaultAst).codeItems[0].instruction, 'iconst_0');

  const safeAst = astWith(items.map((item) => ({ ...item })), exceptionTable);
  const safeResult = runPeepholeClean(safeAst, { coalesceProtectedLoopProducerBridges: true });
  t.equal(safeResult.details.loopProducerBridges, 1);
  t.deepEqual(code(safeAst).codeItems[0].instruction, { op: 'goto', arg: 'Lbound' });
  t.end();
});

test('peephole clean clones stack-consuming conditional targets', (t) => {
  const ast = astWith([
    { instruction: 'iconst_0' },
    { instruction: 'iload_1' },
    { instruction: { op: 'ifne', arg: 'Lcmp' } },
    { instruction: { op: 'if_icmpne', arg: 'Lbreak' } },
    { instruction: 'return' },
    { labelDef: 'Lcmp:', instruction: { op: 'if_icmple', arg: 'Lbreak' } },
    { instruction: 'iinc 1 1' },
    { instruction: 'return' },
    { labelDef: 'Lbreak:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast, { cloneStackConditionalTargets: true });
  t.equal(result.details.stackConditionalTargetClones, 1);
  const instructions = code(ast).codeItems.map((item) => item.instruction).filter(Boolean);
  t.equal(instructions[2].op, 'ifeq');
  t.ok(/^Lscf\d+_0$/.test(instructions[2].arg));
  t.deepEqual(instructions[3], { op: 'if_icmple', arg: 'Lbreak' });
  t.equal(instructions[4].op, 'goto');
  t.ok(/^Lsct\d+_0$/.test(instructions[4].arg));
  t.end();
});

test('peephole clean clones shared forward terminal goto tail', (t) => {
  const ast = astWith([
    { instruction: { op: 'ifeq', arg: 'Ltail' } },
    { instruction: { op: 'goto', arg: 'Ltail' } },
    { labelDef: 'Ltail:', instruction: 'iconst_0' },
    { instruction: { op: 'ifeq', arg: 'Lret' } },
    { instruction: 'iconst_1' },
    { instruction: 'istore_1' },
    { labelDef: 'Lret:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast, {
    cloneForwardTerminalGotoTails: true,
    cloneForwardTerminalGotoTailMaxInsns: 20,
  });
  t.equal(result.details.forwardTerminalGotoTailClones, 1);
  t.notEqual(code(ast).codeItems[1].instruction.op, 'goto');
  t.end();
});

test('peephole clean clones shared forward conditional terminal tail', (t) => {
  const ast = astWith([
    { instruction: 'iload_1' },
    { instruction: { op: 'ifeq', arg: 'Ltail' } },
    { instruction: 'iinc 2 1' },
    { instruction: { op: 'ifne', arg: 'Ltail' } },
    { instruction: 'return' },
    { labelDef: 'Ltail:', instruction: 'iload_2' },
    { instruction: { op: 'ifne', arg: 'Lret' } },
    { instruction: 'return' },
    { labelDef: 'Lret:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast, {
    cloneConditionalTerminalTails: true,
    cloneConditionalTerminalTailMaxInsns: 20,
  });
  t.equal(result.details.conditionalTerminalTailClones, 1);
  t.ok(code(ast).codeItems.some((item) => /^Lctf\d+_0:$/.test(item.labelDef || '')));
  t.end();
});

test('peephole clean materializes dup-store compare locals', (t) => {
  const ast = astWith([
    { instruction: 'iload_1' },
    { instruction: 'ineg' },
    { instruction: 'dup' },
    { instruction: 'istore 4' },
    { instruction: 'iconst_0' },
    { instruction: { op: 'if_icmplt', arg: 'Lneg' } },
    { instruction: 'return' },
    { labelDef: 'Lneg:', instruction: 'return' },
  ]);

  const result = normalizeDupStoreCompareBranches(code(ast));
  t.equal(result, 1);
  t.deepEqual(code(ast).codeItems.slice(2, 5).map((item) => item.instruction), [
    'istore 4',
    { op: 'iinc', varnum: '4', incr: '0' },
    { op: 'iload', arg: '4' },
  ]);
  t.end();
});

test('peephole clean materializes dup-store compare locals with args arrays', (t) => {
  const ast = astWith([
    { instruction: 'iload_1' },
    { instruction: 'dup' },
    { instruction: { op: 'istore', args: ['47'] } },
    { instruction: 'iconst_0' },
    { instruction: { op: 'if_icmpge', arg: 'Lge' } },
    { instruction: 'return' },
    { labelDef: 'Lge:', instruction: 'return' },
  ]);

  const result = normalizeDupStoreCompareBranches(code(ast));
  t.equal(result, 1);
  t.deepEqual(code(ast).codeItems.slice(1, 4).map((item) => item.instruction), [
    { op: 'istore', args: ['47'] },
    { op: 'iinc', varnum: '47', incr: '0' },
    { op: 'iload', arg: '47' },
  ]);
  t.end();
});

test('peephole clean can clone lcmp conditional shared joins', (t) => {
  const ast = astWith([
    { instruction: 'lload_1' },
    { instruction: 'lload_3' },
    { instruction: 'lcmp' },
    { instruction: { op: 'ifge', arg: 'Join' } },
    { instruction: 'aload_0' },
    { instruction: { op: 'goto', arg: 'Exit' } },
    { instruction: { op: 'goto', arg: 'Join' } },
    { labelDef: 'Join:', instruction: 'aload_1' },
    { instruction: 'iconst_1' },
    { instruction: 'iadd' },
    { instruction: { op: 'istore', arg: '5' } },
    { labelDef: 'Exit:', instruction: 'return' },
  ]);

  const result = runPeepholeClean(ast, { cloneLongCompareSharedJoins: true });
  t.ok(result.changed);
  t.equal(result.details.longCompareSharedJoinClones, 1);
  const branch = code(ast).codeItems.find((item) => item && item.instruction && item.instruction.op === 'ifge');
  t.ok(branch.instruction.arg !== 'Join');
  const clone = code(ast).codeItems.find((item) => item && item.labelDef === `${branch.instruction.arg}:`);
  t.ok(clone, 'branch points at cloned join');
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
