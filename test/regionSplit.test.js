'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { listRegionSplitCandidates, applyRegionSplit } = require('../src/passes/regionSplit');
const { methodIrreducibility } = require('../src/analysis/cfgReducibility');

function astWith(codeItems, exceptionTable = []) {
  return {
    classes: [{
      className: 'Target',
      items: [{
        type: 'method',
        method: {
          name: 'm', descriptor: '()V',
          attributes: [{ type: 'code', code: { codeItems, exceptionTable, attributes: [] } }],
        },
      }],
    }],
  };
}

function codeItems(ast) {
  return ast.classes[0].items[0].method.attributes[0].code.codeItems;
}

// Classic two-entry irreducible loop: block A (LA) and block B (LB) form a loop
// (A -> B and B -> A). The start block S enters A by fall-through and B by an
// explicit jump, so the loop has two entries and is irreducible.
function irreducibleLoop() {
  return [
    { labelDef: 'L0:', instruction: 'iload_0' },
    { instruction: { op: 'ifne', arg: 'LB' } }, // S -> B (external jump), else fall to A
    { labelDef: 'LA:', instruction: { op: 'iinc', arg: '1 1' } }, // A
    { instruction: 'iload_0' },
    { instruction: { op: 'ifeq', arg: 'LB' } }, // A -> B (internal), else fall to A-exit
    { instruction: 'return' },
    { labelDef: 'LB:', instruction: { op: 'iinc', arg: '1 1' } }, // B
    { instruction: 'iload_0' },
    { instruction: { op: 'ifeq', arg: 'LA' } }, // B -> A (internal back-edge), else fall to B-exit
    { instruction: 'return' },
  ];
}

test('detects a two-entry irreducible loop as a region-split candidate', () => {
  const ast = astWith(irreducibleLoop());
  assert.equal(methodIrreducibility(codeItems(ast)), 1);
  const cands = listRegionSplitCandidates(ast);
  assert.equal(cands.length, 1);
  const c = cands[0];
  assert.equal(c.entries, 2);
  assert.equal(c.regionBlocks, 2);
  // A is entered by fall-through (forced primary); B is the redirectable secondary.
  assert.equal(c.header, 'LA');
  assert.deepEqual(c.secondaryLabels, ['LB']);
});

test('splitting the region removes the irreducibility', () => {
  const ast = astWith(irreducibleLoop());
  const before = methodIrreducibility(codeItems(ast));
  assert.equal(before, 1);

  const c = listRegionSplitCandidates(ast)[0];
  const result = applyRegionSplit(ast, c);
  assert.equal(result.changed, true);
  assert.equal(result.clonedRegions, 1);

  // CFG is now reducible.
  assert.equal(methodIrreducibility(codeItems(ast)), 0);

  // The start block's external jump was redirected off the original LB into a
  // fresh clone label; the original internal back-edge to LB is untouched.
  const items = codeItems(ast);
  const startJump = items[1].instruction;
  assert.notEqual(startJump.arg, 'LB');
  assert.match(startJump.arg, /^L98\d+$/);
  // A clone entry label for the redirected target now exists.
  assert.ok(items.some((it) => it.labelDef === `${startJump.arg}:`));
});

test('redirects switch predecessors when splitting a secondary loop entry', () => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: 'iload_0' },
    { instruction: { op: 'ifeq', arg: 'LSW' } },
    { labelDef: 'LA:', instruction: 'iload_0' },
    { instruction: { op: 'ifeq', arg: 'LB' } },
    { instruction: 'return' },
    { labelDef: 'LB:', instruction: 'iload_0' },
    { instruction: { op: 'ifeq', arg: 'LA' } },
    { instruction: 'return' },
    { labelDef: 'LSW:', instruction: 'iload_0' },
    { instruction: { op: 'lookupswitch', arg: { pairs: [[0, 'LB']], defaultLabel: 'LEXIT' } } },
    { labelDef: 'LEXIT:', instruction: 'return' },
  ]);

  const candidate = listRegionSplitCandidates(ast)[0];
  assert.ok(candidate);
  assert.deepEqual(candidate.secondaryLabels, ['LB']);
  const result = applyRegionSplit(ast, candidate);
  assert.equal(result.changed, true);
  const switchInstruction = codeItems(ast)[9].instruction;
  assert.notEqual(switchInstruction.arg.pairs[0][1], 'LB');
  assert.match(switchInstruction.arg.pairs[0][1], /^L98\d+$/);
});

test('refuses a region that overlaps an exception range', () => {
  const items = irreducibleLoop();
  // Cover the loop body with a try range: cloning to method end would drop it
  // out of the range, so the pass must refuse.
  const ast = astWith(items, [
    { startLbl: 'LA', endLbl: 'LB', handlerLbl: 'LB', catchType: 'java/lang/Throwable' },
  ]);
  assert.equal(listRegionSplitCandidates(ast).length, 0);
});

test('does not flag a reducible single-entry loop', () => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: 'iload_0' },
    { labelDef: 'LH:', instruction: { op: 'iinc', arg: '1 -1' } }, // single header
    { instruction: 'iload_0' },
    { instruction: { op: 'ifne', arg: 'LH' } }, // back-edge only
    { instruction: 'return' },
  ]);
  assert.equal(methodIrreducibility(codeItems(ast)), 0);
  assert.equal(listRegionSplitCandidates(ast).length, 0);
});
