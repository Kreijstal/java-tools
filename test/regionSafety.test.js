'use strict';

const test = require('tape');
const {
  analyzeRegion,
  canDuplicateRegion,
  classifyInstructionEffects,
  compareLiveInLocals,
  computeLocalLiveness,
  getLocalLivenessAt,
  regionPreservesLiveOut,
} = require('../src/analysis/regionSafety');

function code(codeItems, exceptionTable = []) {
  return { codeItems, exceptionTable };
}

test('region analysis summarizes locals and stack', (t) => {
  const summary = analyzeRegion(code([
    { labelDef: 'L0:', instruction: 'iload_1' },
    { instruction: 'iconst_1' },
    { instruction: 'iadd' },
    { instruction: 'istore_2' },
    { instruction: 'iload_2' },
    { instruction: 'ireturn' },
  ]), 0, 4);

  t.deepEqual([...summary.read].sort(), [1]);
  t.deepEqual([...summary.written].sort(), [2]);
  t.deepEqual([...summary.readBeforeWrite].sort(), [1]);
  t.deepEqual([...summary.writtenAndLiveOut].sort(), [2]);
  t.equal(summary.stack.delta, 0);
  t.equal(summary.stack.maxDepth, 2);
  t.end();
});

test('region duplication rejects effects, throws, branches, and protected labels', (t) => {
  const methodCode = code([
    { pc: 0, labelDef: 'L0:', instruction: 'iload_0' },
    { pc: 1, instruction: { op: 'ifeq', arg: 'L2' } },
    { pc: 2, instruction: { op: 'invokestatic', arg: ['Method', 'Helper', ['touch', '()V']] } },
    { pc: 3, labelDef: 'L2:', instruction: 'return' },
  ], [
    { start_pc: 0, end_pc: 2, handler_pc: 3, catch_type: 'java/lang/RuntimeException' },
  ]);

  const result = canDuplicateRegion(methodCode, 0, 3);
  t.notOk(result.ok);
  t.ok(result.reasons.includes('region touches exception-protected code'));
  t.ok(result.reasons.includes('region contains control flow'));
  t.ok(result.reasons.includes('region has observable side effects'));
  t.ok(result.reasons.includes('region may throw'));
  t.end();
});

test('region analysis detects external branch entries', (t) => {
  const methodCode = code([
    { labelDef: 'L0:', instruction: { op: 'goto', arg: 'Linner' } },
    { labelDef: 'Lstart:', instruction: 'iconst_0' },
    { labelDef: 'Linner:', instruction: 'istore_1' },
    { instruction: 'return' },
  ]);

  const result = canDuplicateRegion(methodCode, 1, 3, { allowMayThrow: true });
  t.notOk(result.ok);
  t.equal(result.summary.inboundBranches.length, 1);
  t.ok(result.reasons.includes('region has external branch entries'));
  t.end();
});

test('region analysis reports CFG-aware live-in and live-out locals', (t) => {
  const methodCode = code([
    { labelDef: 'L0:', instruction: 'iload_1' },
    { instruction: { op: 'ifeq', arg: 'Lelse' } },
    { instruction: 'iload_2' },
    { instruction: 'istore_3' },
    { instruction: { op: 'goto', arg: 'Ljoin' } },
    { labelDef: 'Lelse:', instruction: 'iload_4' },
    { instruction: 'istore_3' },
    { labelDef: 'Ljoin:', instruction: 'iload_3' },
    { instruction: 'ireturn' },
  ]);

  const thenSummary = analyzeRegion(methodCode, 2, 5);
  t.deepEqual([...thenSummary.liveIn].sort(), [2]);
  t.deepEqual([...thenSummary.liveOut].sort(), [3]);
  t.deepEqual([...thenSummary.writtenAndLiveOut].sort(), [3]);

  const ifSummary = analyzeRegion(methodCode, 0, 7);
  t.deepEqual([...ifSummary.liveIn].sort(), [1, 2, 4]);
  t.deepEqual([...ifSummary.liveOut].sort(), [3]);
  t.end();
});

test('local liveness follows exception handler edges conservatively', (t) => {
  const methodCode = code([
    { pc: 0, labelDef: 'L0:', instruction: 'iload_1' },
    { pc: 1, instruction: { op: 'invokestatic', arg: ['Method', 'Helper', ['mayThrow', '()V']] } },
    { pc: 2, instruction: 'return' },
    { pc: 3, labelDef: 'Lhandler:', instruction: 'iload_1' },
    { pc: 4, instruction: 'ireturn' },
  ], [
    { start_pc: 0, end_pc: 2, handler_pc: 3, catch_type: 'java/lang/RuntimeException' },
  ]);

  const liveness = computeLocalLiveness(methodCode);
  t.ok(liveness.liveOut[1].has(1), 'protected instruction keeps handler-read local live');
  t.end();
});

test('entry liveness comparison reports matching and differing live locals', (t) => {
  const methodCode = code([
    { labelDef: 'L0:', instruction: { op: 'goto', arg: 'Lright' } },
    { labelDef: 'Lleft:', instruction: 'iload_1' },
    { instruction: 'ireturn' },
    { labelDef: 'Lright:', instruction: 'iload_2' },
    { instruction: 'ireturn' },
  ]);

  const liveness = getLocalLivenessAt(methodCode, 1);
  t.deepEqual([...liveness.liveIn], [1]);

  const comparison = compareLiveInLocals(methodCode, 1, 3);
  t.notOk(comparison.ok);
  t.deepEqual([...comparison.onlyLeft], [1]);
  t.deepEqual([...comparison.onlyRight], [2]);
  t.end();
});

test('region live-out preservation detects clobbered live locals', (t) => {
  const methodCode = code([
    { instruction: 'iconst_1' },
    { instruction: 'istore_1' },
    { instruction: 'iload_1' },
    { instruction: 'ireturn' },
  ]);

  const result = regionPreservesLiveOut(methodCode, 0, 2);
  t.notOk(result.ok);
  t.deepEqual([...result.clobbered], [1]);
  t.end();
});

test('instruction effect classifier distinguishes arithmetic, array loads, and stores', (t) => {
  t.deepEqual(classifyInstructionEffects('iadd'), {
    hasObservableSideEffect: false,
    mayThrow: false,
  });
  t.deepEqual(classifyInstructionEffects('iaload'), {
    hasObservableSideEffect: false,
    mayThrow: true,
  });
  t.deepEqual(classifyInstructionEffects('iastore'), {
    hasObservableSideEffect: true,
    mayThrow: true,
  });
  t.end();
});
