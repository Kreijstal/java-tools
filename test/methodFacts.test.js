'use strict';

const test = require('tape');
const { createMethodFacts } = require('../src/analysis/methodFacts');

test('method facts indexes labels and branch references lazily', (t) => {
  const code = {
    codeItems: [
      { labelDef: 'L0:', instruction: { op: 'ifeq', arg: 'L2' } },
      { instruction: { op: 'goto', arg: 'L2' } },
      { pc: 8, labelDef: 'L1:', instruction: 'return' },
      { pc: 12, labelDef: 'L2:', instruction: 'return' },
    ],
    exceptionTable: [],
  };
  const facts = createMethodFacts(code, {
    opcodeMnemonic(insn) {
      if (!insn) return null;
      return typeof insn === 'string' ? insn.split(/\s+/)[0] : insn.op;
    },
    isTerminalOpcode(opcode) {
      return opcode === 'return' || opcode === 'goto';
    },
  });

  t.equal(facts.labelIndex().get('L2'), 3);
  t.equal(facts.pcIndex().get(12), 3);
  t.equal(facts.pcLabelIndex().get(12), 'L2');
  t.equal(facts.instructionLabelReferenceCounts().get('L2'), 2);
  t.equal(facts.branchRefsByLabel().get('L2').length, 2);
  t.equal(facts.countInstructions(0, 4), 4);
  t.equal(facts.rangeContainsTerminal(0, 2), true);
  t.end();
});

test('method facts invalidates cached indexes after mutation', (t) => {
  const code = {
    codeItems: [
      { labelDef: 'L0:', instruction: { op: 'goto', arg: 'L1' } },
      { labelDef: 'L1:', instruction: 'return' },
    ],
    exceptionTable: [],
  };
  const facts = createMethodFacts(code);
  t.equal(facts.labelIndex().get('L1'), 1);

  code.codeItems.unshift({ labelDef: 'Lx:', instruction: 'nop' });
  t.equal(facts.labelIndex().get('L1'), 1, 'cached value is stable before invalidation');
  facts.invalidate();
  t.equal(facts.labelIndex().get('L1'), 2);
  t.end();
});

test('method facts caches region analysis hooks', (t) => {
  let calls = 0;
  const code = { codeItems: [{ instruction: 'return' }], exceptionTable: [] };
  const facts = createMethodFacts(code, {
    analyzeRegion(_code, start, end, options) {
      calls += 1;
      return { start, end, options };
    },
    regionTouchesProtectedLabel() {
      calls += 1;
      return false;
    },
  });

  t.equal(facts.analyzeRegion(0, 1, { allowControlFlow: true }), facts.analyzeRegion(0, 1, { allowControlFlow: true }));
  t.equal(facts.regionTouchesProtectedLabel(0, 1), false);
  t.equal(facts.regionTouchesProtectedLabel(0, 1), false);
  t.equal(calls, 2);
  t.end();
});
