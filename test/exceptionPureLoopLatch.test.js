'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {structureMethod, verifyRegionFlowContracts} = require('../src/decompiler/exceptionStructurer');
const {printTree, buildCfgFromCode} = require('../src/decompiler/structurer');

function protectedCopies(tree, block, protectedBody = false, found = []) {
  if (!tree) return found;
  if (tree.t === 'straight' && tree.block === block) found.push(protectedBody);
  if (tree.t === 'seq') tree.body.forEach(child => protectedCopies(child, block, protectedBody, found));
  else if (tree.t === 'if') {
    protectedCopies(tree.then, block, protectedBody, found); protectedCopies(tree.els, block, protectedBody, found);
  } else if (tree.t === 'switch') {
    tree.cases.forEach(item => protectedCopies(item.body, block, protectedBody, found));
    protectedCopies(tree.dflt, block, protectedBody, found);
  } else if (['block', 'loop', 'try', 'synchronized'].includes(tree.t)) {
    protectedCopies(tree.body, block, protectedBody || tree.t === 'try', found);
    (tree.catches || []).forEach(item => protectedCopies(item.body, block, protectedBody, found));
  }
  return found;
}

function fixture(opcode = {op: 'iinc', varnum: '0', incr: '-1'}, externalEntry = false) {
  return [
    {labelDef:'L0:',pc:0,instruction:{op:'invokestatic',arg:['Method','Example',['setup','()V']]}},
    {labelDef:'L3:',pc:3,instruction:{op:'invokestatic',arg:['Method','Example',['work','()V']]}},
    {pc:6,instruction:'iload_0'},
    {pc:7,instruction:{op:'ifle',arg:'L20'}},
    {labelDef:'L10:',pc:10,instruction:{op:'goto',arg:'L13'}},
    {labelDef:'L13:',pc:13,instruction:opcode},
    {pc:16,instruction:{op:'goto',arg:'L3'}},
    {labelDef:'L19:',pc:19,instruction:'return'},
    {labelDef:'L20:',pc:20,instruction:externalEntry?{op:'goto',arg:'L13'}:'return'},
    {labelDef:'L23:',pc:23,instruction:'astore_1'},
    {pc:24,instruction:'return'},
  ];
}
const table = [{start_pc:0,end_pc:13,handler_pc:23,catch_type:'java/lang/RuntimeException'}];

test('a pure boundary latch becomes part of its protected loop with original-flow proofs', () => {
  const code = fixture(), original = structuredClone(code), originalTable = structuredClone(table);
  const result = structureMethod(code, table);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.regionExitsVerified, true);
  assert.equal(verifyRegionFlowContracts(result.tree, result.regionExitContracts), true);
  const cfg = buildCfgFromCode(code), latch = cfg.blocks.find(b => code[b.insns[0]].pc === 13).id;
  assert.deepEqual(protectedCopies(result.tree, latch), [true], 'the middle-entry latch belongs inside the protected loop');
  assert.match(printTree(result.tree, result.render), /loop|while/);
  assert.deepEqual(code, original);
  assert.deepEqual(table, originalTable);
});

test('throwing, unknown and monitor operations outside a try never gain catch coverage', () => {
  for (const opcode of ['idiv','ldiv','aaload','monitorenter','monitorexit','athrow','unknown_instruction',
    {op:'invokevirtual',arg:['Method','Example',['outside','()V']]}]) {
    const code = fixture(opcode), result = structureMethod(code, table);
    if (result.ok) {
      const cfg = buildCfgFromCode(code), latch = cfg.blocks.find(b => code[b.insns[0]].pc === 13).id;
      const copies = protectedCopies(result.tree, latch);
      assert.ok(copies.length, 'throwing latch must remain present');
      assert.ok(copies.every(inside => !inside), 'an originally unprotected throw must stay outside the catch');
      assert.equal(verifyRegionFlowContracts(result.tree, result.regionExitContracts), true);
    }
  }
});

test('another normal entry cannot lose its original control-flow path', () => {
  const result = structureMethod(fixture(undefined, true), table);
  if (result.ok) assert.equal(verifyRegionFlowContracts(result.tree, result.regionExitContracts), true);
});

test('a boundary handler entry is never absorbed as normal loop glue', () => {
  const result = structureMethod(fixture(), [{...table[0], handler_pc:13}]);
  assert.equal(result.ok, false, JSON.stringify(result));
});
