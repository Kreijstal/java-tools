'use strict';

const test = require('tape');
const { buildOp02Graph } = require('../src/analysis/opgraph/op02');

function ids(nodes) {
  return nodes.map((node) => node && node.id);
}

test('op02 builds normal edges and symbolic stack values', (t) => {
  const graph = buildOp02Graph({
    codeItems: [
      { pc: 0, labelDef: 'L0:', instruction: 'iconst_1' },
      { pc: 1, instruction: 'iconst_2' },
      { pc: 2, instruction: 'iadd' },
      { pc: 3, instruction: 'ireturn' },
    ],
    exceptionTable: [],
  });

  t.equal(graph.nodes.length, 4);
  t.deepEqual(ids(graph.nodes[0].targets), [1]);
  t.deepEqual(ids(graph.nodes[1].targets), [2]);
  t.deepEqual(ids(graph.nodes[2].targets), [3]);
  t.deepEqual(ids(graph.nodes[3].targets), []);
  t.equal(graph.nodes[2].stackConsumed.length, 2);
  t.equal(graph.nodes[2].stackProduced.length, 1);
  t.equal(graph.nodes[3].stackConsumed.length, 1);
  t.equal(graph.nodes[3].stackDepthAfter, 0);
  t.end();
});

test('op02 merges stack values at branch joins', (t) => {
  const graph = buildOp02Graph({
    codeItems: [
      { pc: 0, labelDef: 'L0:', instruction: 'iconst_0' },
      { pc: 1, instruction: { op: 'ifeq', arg: 'Lelse' } },
      { pc: 2, instruction: 'iconst_1' },
      { pc: 3, instruction: { op: 'goto', arg: 'Ljoin' } },
      { pc: 4, labelDef: 'Lelse:', instruction: 'iconst_2' },
      { pc: 5, labelDef: 'Ljoin:', instruction: 'istore_1' },
      { pc: 6, instruction: 'return' },
    ],
    exceptionTable: [],
  });

  const branch = graph.nodes[1];
  const join = graph.labelToNode.get('Ljoin');

  t.deepEqual(ids(branch.targets).sort((a, b) => a - b), [2, 4]);
  t.equal(join.stackDepthBefore, 1);
  t.equal(join.stackBeforeValues.length, 1);
  t.equal(join.stackBeforeValues[0].kind, 'merge');
  t.equal(join.stackBeforeValues[0].mergedFrom.length, 2);
  t.equal(join.stackConsumed[0].kind, 'merge');
  t.end();
});

test('op02 adds exception edges with handler exception stack value', (t) => {
  const graph = buildOp02Graph({
    codeItems: [
      { pc: 0, labelDef: 'L0:', instruction: { op: 'invokestatic', arg: ['Method', 'Example', ['mayThrow', '()V']] } },
      { pc: 1, labelDef: 'L1:', instruction: 'return' },
      { pc: 2, labelDef: 'H:', instruction: 'astore_1' },
      { pc: 3, instruction: 'return' },
    ],
    exceptionTable: [
      { start_pc: 0, end_pc: 1, handler_pc: 2, catch_type: 'java/lang/RuntimeException' },
    ],
  });

  const protectedNode = graph.nodes[0];
  const handler = graph.labelToNode.get('H');

  t.deepEqual(ids(protectedNode.exceptionTargets), [handler.id]);
  t.equal(handler.stackDepthBefore, 1);
  t.equal(handler.stackConsumed[0].kind, 'exception');
  t.end();
});
