'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { structureMethod, verifyRegionExitContracts, verifyRegionFlowContracts } = require('../src/decompiler/exceptionStructurer');
const { printTree } = require('../src/decompiler/structurer');
const {verifyStructuredFlow} = require('../src/decompiler/structuredFlowVerifier');

// Render a method (codeItems + exception table) and return { ok, src, r }.
function run(codeItems, exceptionTable) {
  const r = structureMethod(codeItems, exceptionTable);
  const src = r.ok ? printTree(r.tree, r.render) : null;
  return { ok: r.ok, src, r };
}

function assertGotoFree(src) {
  assert.ok(!/\bgoto\b/.test(src), `expected no goto in:\n${src}`);
}

function multiExitResult() {
  return structureMethod([
    {labelDef: 'L0:', pc: 0, instruction: 'iload_0'},
    {pc: 1, instruction: {op: 'ifeq', arg: 'L12'}},
    {labelDef: 'L4:', pc: 4, instruction: {op: 'goto', arg: 'L16'}},
    {labelDef: 'L7:', pc: 7, instruction: 'astore_1'},
    {pc: 8, instruction: {op: 'goto', arg: 'L12'}},
    {labelDef: 'L12:', pc: 12, instruction: 'return'},
    {labelDef: 'L16:', pc: 16, instruction: 'return'},
  ], [{start_pc: 0, end_pc: 7, handler_pc: 7, catch_type: 'java/lang/Exception'}]);
}

function visitTree(node, visit) {
  if (!node) return;
  visit(node);
  if (node.t === 'seq') node.body.forEach(child => visitTree(child, visit));
  else if (node.t === 'if') { visitTree(node.then, visit); visitTree(node.els, visit); }
  else if (node.t === 'switch') {
    node.cases.forEach(item => visitTree(item.body, visit)); visitTree(node.dflt, visit);
  } else if (['block', 'loop', 'try', 'synchronized'].includes(node.t)) {
    visitTree(node.body, visit);
    (node.catches || []).forEach(item => visitTree(item.body, visit));
  }
}

function regionNode(result) {
  let region;
  visitTree(result.tree, node => { if (node.regionFlowBlock != null) region = node; });
  assert.ok(region);
  return region;
}

function twoHandlerResult() {
  return structureMethod([
    {labelDef: 'L0:', pc: 0, instruction: {op: 'invokestatic', arg: ['Method', 'X', ['work', '()V']]}},
    {labelDef: 'L3:', pc: 3, instruction: {op: 'goto', arg: 'L14'}},
    {labelDef: 'L6:', pc: 6, instruction: 'astore_0'},
    {pc: 7, instruction: {op: 'goto', arg: 'L14'}},
    {labelDef: 'L10:', pc: 10, instruction: 'astore_0'},
    {pc: 11, instruction: {op: 'goto', arg: 'L14'}},
    {labelDef: 'L14:', pc: 14, instruction: 'return'},
  ], [
    {start_pc: 0, end_pc: 3, handler_pc: 6, catch_type: 'java/lang/IllegalArgumentException'},
    {start_pc: 0, end_pc: 3, handler_pc: 10, catch_type: 'java/lang/RuntimeException'},
  ]);
}

test('intact components cannot exchange protected-body and catch-arm positions', () => {
  const result = multiExitResult();
  const region = regionNode(result);
  [region.body, region.catches[0].body] = [region.catches[0].body, region.body];
  // Neither normal component edges nor sink destinations detect this change.
  assert.equal(verifyRegionExitContracts(result.tree, result.regionExitContracts), true);
  assert.equal(verifyStructuredFlow(result.tree, result.regionMethodFlow), true);
  visitTree(result.tree, node => {
    if (node.regionFlowComponent != null) assert.equal(verifyStructuredFlow(node,
      result.regionExitContracts[0].components[node.regionFlowComponent]), true);
  });
  assert.equal(verifyRegionFlowContracts(result.tree, result.regionExitContracts), false);
});

test('catch priority and handler-to-type bindings survive composition', () => {
  for (const mutate of [
    region => region.catches.reverse(),
    region => { [region.catches[0].body, region.catches[1].body] =
      [region.catches[1].body, region.catches[0].body]; },
  ]) {
    const result = twoHandlerResult();
    assert.equal(result.ok, true, result.reason);
    assert.equal(verifyRegionFlowContracts(result.tree, result.regionExitContracts), true);
    mutate(regionNode(result));
    assert.equal(verifyRegionExitContracts(result.tree, result.regionExitContracts), true);
    assert.equal(verifyRegionFlowContracts(result.tree, result.regionExitContracts), false);
  }
});

test('catch-type snapshots are independent of later in-place mutations', () => {
  for (const mutate of [
    types => { types[0] = 'java.lang.Throwable'; },
    types => types.push('java.io.IOException'),
    types => types.pop(),
  ]) {
    const result = multiExitResult();
    const recorded = JSON.stringify(result.regionExitContracts);
    mutate(regionNode(result).catches[0].types);
    assert.equal(JSON.stringify(result.regionExitContracts), recorded);
    assert.equal(verifyRegionFlowContracts(result.tree, result.regionExitContracts), false);
  }
});

test('components cannot escape their owning region or acquire another exception scope', () => {
  const result = multiExitResult();
  const region = regionNode(result);
  const copy = JSON.parse(JSON.stringify(region.body));
  assert.equal(verifyRegionFlowContracts({t: 'seq', body: [result.tree, copy]},
    result.regionExitContracts), false);
  region.body = {t: 'try', body: region.body, catches: []};
  assert.equal(verifyRegionFlowContracts(result.tree, result.regionExitContracts), false);
});

test('valid copies and label/parameter renaming retain exception bindings', () => {
  const result = twoHandlerResult();
  const copy = JSON.parse(JSON.stringify(result.tree));
  visitTree(copy, node => {
    if (node.label) node.label += 'Copy';
    for (const item of node.catches || []) item.varName += 'Copy';
  });
  assert.equal(verifyRegionFlowContracts({t: 'seq', body: [result.tree, copy]},
    result.regionExitContracts), true);
  // Each emitted copy is checked independently.
  let copiedRegion;
  visitTree(copy, node => { if (node.regionFlowBlock != null) copiedRegion = node; });
  copiedRegion.catches.reverse();
  assert.equal(verifyRegionFlowContracts({t: 'seq', body: [result.tree, copy]},
    result.regionExitContracts), false);
});

test('source-flow contracts reject deletion of both sink and transfer despite a valid sibling', () => {
  const result = multiExitResult();
  assert.equal(result.ok, true, result.reason);
  assert.equal(verifyRegionFlowContracts(result.tree, result.regionExitContracts), true);
  let branch;
  visitTree(result.tree, node => { if (node.t === 'if' && node.block === 0) branch = node; });
  assert.ok(branch);
  branch.then = {t: 'seq', body: []};
  // The catch still reaches this sink, so existence/identity alone accepts it.
  assert.equal(verifyRegionExitContracts(result.tree, result.regionExitContracts), true);
  assert.equal(verifyRegionFlowContracts(result.tree, result.regionExitContracts), false);
});

test('source-flow contracts reject exchanged branches with intact sink identities', () => {
  const result = multiExitResult();
  let branch;
  visitTree(result.tree, node => { if (node.t === 'if' && node.block === 0) branch = node; });
  assert.ok(branch);
  [branch.then, branch.els] = [branch.els, branch.then];
  assert.equal(verifyRegionExitContracts(result.tree, result.regionExitContracts), true);
  assert.equal(verifyRegionFlowContracts(result.tree, result.regionExitContracts), false);
});

test('source-flow contracts require every component and reject a damaged duplicate', () => {
  const result = multiExitResult();
  let component;
  visitTree(result.tree, node => { if (node.regionFlowComponent === 0) component = node; });
  assert.ok(component);
  delete component.regionFlowComponent;
  assert.equal(verifyRegionFlowContracts(result.tree, result.regionExitContracts), false);
  component.regionFlowComponent = 0;
  const copy = JSON.parse(JSON.stringify(component));
  copy.body = {t: 'seq', body: []};
  assert.equal(verifyRegionFlowContracts({t: 'seq', body: [result.tree, copy]},
    result.regionExitContracts), false);
});

test('source-flow contracts retain terminal-only try and catch components', () => {
  const result = structureMethod([
    {labelDef: 'L0:', pc: 0, instruction: {op: 'invokestatic', arg: ['Method', 'X', ['work', '()V']]}},
    {pc: 3, instruction: 'return'},
    {labelDef: 'L4:', pc: 4, instruction: 'astore_0'},
    {pc: 5, instruction: 'return'},
  ], [{start_pc: 0, end_pc: 4, handler_pc: 4, catch_type: 'java/lang/Exception'}]);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.regionExitContracts[0].exits, []);
  assert.equal(verifyRegionFlowContracts(result.tree, result.regionExitContracts), true);
  visitTree(result.tree, node => {
    if (node.regionFlowComponent === 0) node.body = [];
  });
  assert.equal(verifyRegionExitContracts(result.tree, result.regionExitContracts), true);
  assert.equal(verifyRegionFlowContracts(result.tree, result.regionExitContracts), false);
});

test('outer selector routing is checked separately from intact component transfers', () => {
  const result = multiExitResult();
  assert.equal(verifyStructuredFlow(result.tree, result.regionMethodFlow), true);
  let routing;
  visitTree(result.tree, node => { if (node.t === 'if' && node.block !== 0) routing = node; });
  assert.ok(routing);
  [routing.then, routing.els] = [routing.els, routing.then];
  assert.equal(verifyRegionExitContracts(result.tree, result.regionExitContracts), true);
  assert.equal(verifyRegionFlowContracts(result.tree, result.regionExitContracts), true);
  assert.equal(verifyStructuredFlow(result.tree, result.regionMethodFlow), false);
});

const regionContract = targets => [{owner: 7,
  exits: targets.map(target => ({sink: target + 10, target}))}];
const regionTransfer = target => ({t: 'break', label: 'Region', regionExitOwner: 7,
  regionExitSink: target + 10, regionExitTarget: target});
const regionExit = target => ({t: 'seq', body: [
  {t: 'straight', block: target + 10}, regionTransfer(target),
]});

test('region exit contracts preserve distinct targets through nested loops', () => {
  const tree = { t: 'block', label: 'Region', regionExitOwner: 7, body: {
    t: 'loop', label: 'Loop', body: { t: 'if', block: 0, then: regionExit(4), els: regionExit(5) },
  } };
  assert.equal(verifyRegionExitContracts(tree, regionContract([4, 5])), true);
  tree.body.body.then.body[1].label = 'Loop';
  assert.equal(verifyRegionExitContracts(tree, regionContract([4, 5])), false);
});

test('region exit contracts refuse missing or unknown continuations', () => {
  const tree = { t: 'block', label: 'Region', regionExitOwner: 7, body: regionExit(4) };
  assert.equal(verifyRegionExitContracts(tree, regionContract([4, 5])), false);
  assert.equal(verifyRegionExitContracts(tree, regionContract([5])), false);
});

test('region exit contracts reject lost identity and changed transfer kinds', () => {
  for (const transfer of [
    {...regionTransfer(4), t: 'continue'},
    {...regionTransfer(4), regionExitOwner: undefined},
    {...regionTransfer(4), regionExitTarget: undefined},
    {...regionTransfer(4), regionExitSink: undefined},
    {t: 'break', label: 'Region'},
  ]) {
    // A valid sibling must not conceal a malformed exit to the same target.
    const tree = {t: 'block', label: 'Region', regionExitOwner: 7, body: {
      t: 'if', block: 0, then: {t: 'seq', body: [{t: 'straight', block: 14}, transfer]},
      els: regionExit(4),
    }};
    assert.equal(verifyRegionExitContracts(tree, regionContract([4])), false);
  }
});

test('region exits cannot exchange sink destinations while preserving the target set', () => {
  const contracts = [{owner: 7, exits: [
    {sink: 10, target: 4}, {sink: 11, target: 5},
  ]}];
  const exit = (sink, target) => ({t: 'seq', body: [
    {t: 'straight', block: sink},
    {t: 'break', label: 'Region', regionExitOwner: 7, regionExitSink: sink,
      regionExitTarget: target},
  ]});
  const tree = {t: 'block', label: 'Region', regionExitOwner: 7, body: {
    t: 'if', block: 0, then: exit(10, 5), els: exit(11, 4),
  }};
  assert.equal(verifyRegionExitContracts(tree, contracts), false);
});

test('region transfers require their own immediately preceding sink', () => {
  for (const body of [
    regionTransfer(4),
    {t: 'seq', body: [{t: 'straight', block: 15}, regionTransfer(4)]},
    {t: 'seq', body: [{t: 'straight', block: 14}, {t: 'straight', block: 0}, regionTransfer(4)]},
    {t: 'seq', body: [{t: 'straight', block: 14}]},
  ]) {
    const tree = {t: 'block', label: 'Region', regionExitOwner: 7, body: {
      t: 'if', block: 0, then: body, els: regionExit(4),
    }};
    assert.equal(verifyRegionExitContracts(tree, regionContract([4])), false);
  }
});

test('contracts reject duplicate owners, shared sinks and destination-only legacy metadata', () => {
  const tree = {t: 'block', label: 'Region', regionExitOwner: 7, body: regionExit(4)};
  for (const contracts of [
    [...regionContract([4]), ...regionContract([4])],
    [{owner: 7, exits: [{sink: 14, target: 4}, {sink: 14, target: 5}]}],
    [...regionContract([4]), {owner: 8, exits: [{sink: 14, target: 4}]}],
    [{owner: 7, targets: [4]}],
  ]) assert.equal(verifyRegionExitContracts(tree, contracts), false);
});

test('a catch retry into the middle of a try body must not restart its setup', () => {
  const invoke = (pc, name) => ({ labelDef: `L${pc}:`, pc,
    instruction: { op: 'invokestatic', arg: ['Method', 'X', [name, '()V']] } });
  const code = [
    invoke(0, 'setup'),
    { pc: 3, instruction: { op: 'goto', arg: 'L4' } },
    invoke(4, 'step'),
    { labelDef: 'L7:', pc: 7, instruction: { op: 'goto', arg: 'L15' } },
    { labelDef: 'L10:', pc: 10, instruction: 'astore_0' },
    { pc: 11, instruction: { op: 'goto', arg: 'L4' } },
    { labelDef: 'L15:', pc: 15, instruction: 'return' },
  ];
  const result = structureMethod(code,
    [{ start_pc: 0, end_pc: 7, handler_pc: 10, catch_type: 'java/lang/RuntimeException' }]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /continuation reenters a different component/);
});

// ---------------------------------------------------------------------------
// (a) A single try/catch with straight-line bodies.
// try body [0,4): aload_0; invokevirtual; goto merge. handler at 7. merge at 10.
// ---------------------------------------------------------------------------
test('single try/catch with straight bodies', () => {
  const code = [
    { labelDef: 'L0:', pc: 0, instruction: 'aload_0' },
    { pc: 1, instruction: { op: 'invokevirtual', arg: ['Method', 'X', ['m', '()V']] } },
    { labelDef: 'L4:', pc: 4, instruction: { op: 'goto', arg: 'L10' } },
    { labelDef: 'L7:', pc: 7, instruction: 'astore_1' },
    { pc: 8, instruction: { op: 'goto', arg: 'L10' } },
    { labelDef: 'L10:', pc: 10, instruction: 'return' },
  ];
  const et = [{ start_pc: 0, end_pc: 4, handler_pc: 7, catch_type: 'java/io/IOException' }];
  const { ok, src } = run(code, et);
  assert.ok(ok, 'should structure');
  assertGotoFree(src);
  assert.match(src, /try \{/);
  assert.match(src, /} catch \(java\.io\.IOException \w+\) \{/);
  // merge code runs after the try/catch
  assert.match(src, /\}\nreturn;/);
});

// ---------------------------------------------------------------------------
// (b) try/catch/catch — one body, two handlers of different types.
// ---------------------------------------------------------------------------
test('try with two catch clauses', () => {
  const code = [
    { labelDef: 'L0:', pc: 0, instruction: 'aload_0' },
    { pc: 1, instruction: { op: 'invokevirtual', arg: ['Method', 'X', ['m', '()V']] } },
    { labelDef: 'L4:', pc: 4, instruction: { op: 'goto', arg: 'L13' } },
    { labelDef: 'L7:', pc: 7, instruction: 'astore_1' },
    { pc: 8, instruction: { op: 'goto', arg: 'L13' } },
    { labelDef: 'L10:', pc: 10, instruction: 'astore_1' },
    { pc: 11, instruction: { op: 'goto', arg: 'L13' } },
    { labelDef: 'L13:', pc: 13, instruction: 'return' },
  ];
  const et = [
    { start_pc: 0, end_pc: 4, handler_pc: 7, catch_type: 'java/io/IOException' },
    { start_pc: 0, end_pc: 4, handler_pc: 10, catch_type: 'java/lang/RuntimeException' },
  ];
  const { ok, src } = run(code, et);
  assert.ok(ok, 'should structure');
  assertGotoFree(src);
  assert.equal((src.match(/\} catch \(/g) || []).length, 2, `two catch clauses:\n${src}`);
  assert.match(src, /catch \(java\.io\.IOException \w+\)/);
  assert.match(src, /catch \(java\.lang\.RuntimeException \w+\)/);
});

test('same handler rows structure as one Java multi-catch', () => {
  const code = [
    { labelDef: 'L0:', pc: 0, instruction: 'aload_0' },
    { pc: 1, instruction: { op: 'invokevirtual', arg: ['Method', 'X', ['m', '()V']] } },
    { labelDef: 'L4:', pc: 4, instruction: { op: 'goto', arg: 'L10' } },
    { labelDef: 'L7:', pc: 7, instruction: 'astore_1' },
    { pc: 8, instruction: { op: 'goto', arg: 'L10' } },
    { labelDef: 'L10:', pc: 10, instruction: 'return' },
  ];
  const et = [
    { start_pc: 0, end_pc: 4, handler_pc: 7, catch_type: 'java/io/IOException' },
    { start_pc: 0, end_pc: 4, handler_pc: 7, catch_type: 'java/sql/SQLException' },
  ];
  const { ok, src } = run(code, et);
  assert.ok(ok, 'should structure');
  assertGotoFree(src);
  assert.equal((src.match(/\} catch \(/g) || []).length, 1, `one multi-catch clause:\n${src}`);
  assert.match(src, /catch \(java\.io\.IOException \| java\.sql\.SQLException \w+\)/);
});

test('handler continuation inside a later protected range does not move the try entry', () => {
  const invoke = (pc, name) => ({ pc, instruction: { op: 'invokevirtual', arg: ['Method', 'X', [name, '()V']] } });
  const code = [
    { labelDef: 'L0:', pc: 0, instruction: { op: 'goto', arg: 'L5' } },
    { labelDef: 'L5:', pc: 5, instruction: 'iload_0' },
    { pc: 6, instruction: { op: 'ifeq', arg: 'L29' } },
    { labelDef: 'L11:', pc: 11, instruction: 'aload_0' },
    invoke(12, 'a'),
    { pc: 15, instruction: { op: 'goto', arg: 'L29' } },
    { labelDef: 'L29:', pc: 29, instruction: 'aload_0' },
    invoke(30, 'b'),
    { pc: 33, instruction: { op: 'goto', arg: 'L152' } },
    { labelDef: 'L151:', pc: 151, instruction: 'nop' },
    { labelDef: 'L152:', pc: 152, instruction: 'nop' },
    { pc: 155, instruction: { op: 'goto', arg: 'L170' } },
    { labelDef: 'L158:', pc: 158, instruction: 'nop' },
    { labelDef: 'L159:', pc: 159, instruction: 'astore_1' },
    { labelDef: 'L160:', pc: 160, instruction: 'aload_0' },
    invoke(161, 'c'),
    { labelDef: 'L170:', pc: 170, instruction: { op: 'goto', arg: 'L180' } },
    { labelDef: 'L171:', pc: 171, instruction: 'aload_0' },
    invoke(172, 'd'),
    { labelDef: 'L178:', pc: 178, instruction: { op: 'goto', arg: 'L180' } },
    { labelDef: 'L179:', pc: 179, instruction: 'astore_2' },
    { labelDef: 'L180:', pc: 180, instruction: 'return' },
  ];
  const et = [
    { start_pc: 5, end_pc: 151, handler_pc: 159, catch_type: 'java/lang/Throwable' },
    { start_pc: 152, end_pc: 158, handler_pc: 159, catch_type: 'java/lang/Throwable' },
    { start_pc: 5, end_pc: 151, handler_pc: 179, catch_type: 'java/lang/RuntimeException' },
    { start_pc: 152, end_pc: 170, handler_pc: 179, catch_type: 'java/lang/RuntimeException' },
    { start_pc: 171, end_pc: 178, handler_pc: 179, catch_type: 'java/lang/RuntimeException' },
  ];

  const { ok, src, r } = run(code, et);
  assert.ok(ok, r.reason || 'overlapping logical handlers should structure');
  assertGotoFree(src);
  assert.match(src, /catch \(java\.lang\.Throwable/);
  assert.match(src, /catch \(java\.lang\.RuntimeException/);
});

test('catch fallthrough into an enclosing protected tail does not become a retry loop', () => {
  const code = [
    { labelDef: 'L0:', pc: 0, instruction: 'iconst_0' },
    { pc: 1, instruction: 'istore_0' },
    { labelDef: 'L5:', pc: 5, instruction: 'aload_0' },
    { pc: 6, instruction: { op: 'invokevirtual', arg: ['Method', 'X', ['read', '()I']] } },
    { pc: 9, instruction: { op: 'ifeq', arg: 'L103' } },
    { pc: 12, instruction: 'aconst_null' },
    { pc: 13, instruction: 'areturn' },
    { labelDef: 'L95:', pc: 95, instruction: 'iinc 0 1' },
    { pc: 98, instruction: { op: 'goto', arg: 'L5' } },
    { labelDef: 'L101:', pc: 101, instruction: 'nop' },
    { labelDef: 'L102:', pc: 102, instruction: 'astore_1' },
    { labelDef: 'L103:', pc: 103, instruction: 'aconst_null' },
    { pc: 104, instruction: 'areturn' },
    { labelDef: 'L105:', pc: 105, instruction: 'astore_2' },
    { pc: 106, instruction: 'aload_2' },
    { pc: 107, instruction: 'athrow' },
  ];
  const et = [
    { start_pc: 5, end_pc: 94, handler_pc: 102, catch_type: 'java/lang/Throwable' },
    { start_pc: 95, end_pc: 101, handler_pc: 102, catch_type: 'java/lang/Throwable' },
    { start_pc: 5, end_pc: 94, handler_pc: 105, catch_type: 'java/lang/RuntimeException' },
    { start_pc: 95, end_pc: 104, handler_pc: 105, catch_type: 'java/lang/RuntimeException' },
  ];

  const { ok, src, r } = run(code, et);
  assert.ok(ok, r.reason || 'nested handler ranges should structure');
  assertGotoFree(src);
  assert.equal((src.match(/try \{/g) || []).length, 2, `expected nested tries:\n${src}`);
  assert.match(src, /catch \(java\.lang\.Throwable[^]*?areturn;/);
  assert.doesNotMatch(src, /decompiledRegionSelector/);
});

// ---------------------------------------------------------------------------
// (c) A catch-all clause (catch_type 0) renders as java.lang.Throwable.
// ---------------------------------------------------------------------------
test('catch-all clause renders java.lang.Throwable', () => {
  const code = [
    { labelDef: 'L0:', pc: 0, instruction: 'aload_0' },
    { pc: 1, instruction: { op: 'invokevirtual', arg: ['Method', 'X', ['m', '()V']] } },
    { labelDef: 'L4:', pc: 4, instruction: { op: 'goto', arg: 'L10' } },
    { labelDef: 'L7:', pc: 7, instruction: 'astore_1' },
    { pc: 8, instruction: { op: 'goto', arg: 'L10' } },
    { labelDef: 'L10:', pc: 10, instruction: 'return' },
  ];
  const et = [{ start_pc: 0, end_pc: 4, handler_pc: 7, catch_type: 0 }];
  const { ok, src } = run(code, et);
  assert.ok(ok, 'should structure');
  assertGotoFree(src);
  assert.match(src, /catch \(java\.lang\.Throwable \w+\)/);
});

// ---------------------------------------------------------------------------
// (d) A loop inside the try body. Block 0 is both the try entry and a self-loop
// header; the structured try body must contain a while(true)/continue.
// ---------------------------------------------------------------------------
test('control flow (a loop) inside the try body', () => {
  const code = [
    { labelDef: 'L0:', pc: 0, instruction: 'iload_0' },
    { pc: 1, instruction: { op: 'ifne', arg: 'L0' } }, // back edge to the header
    { labelDef: 'L4:', pc: 4, instruction: { op: 'goto', arg: 'L10' } },
    { labelDef: 'L7:', pc: 7, instruction: 'astore_1' },
    { pc: 8, instruction: { op: 'goto', arg: 'L10' } },
    { labelDef: 'L10:', pc: 10, instruction: 'return' },
  ];
  const et = [{ start_pc: 0, end_pc: 7, handler_pc: 7, catch_type: 'java/lang/Exception' }];
  const { ok, src } = run(code, et);
  assert.ok(ok, 'should structure');
  assertGotoFree(src);
  assert.match(src, /try \{/);
  assert.match(src, /while \(true\) \{/);   // the loop survives inside the try
  assert.match(src, /continue L\d+;/);
});

test('trailing synchronized glue does not absorb the next loop lock setup', () => {
  // monitorenter/monitorexit have already been lowered to nop/pop, matching
  // the input that cfr.js gives the exception structurer.
  const code = [
    { labelDef: 'L0:', pc: 0, instruction: 'aload_0' },
    { pc: 1, instruction: 'astore_1' },
    { pc: 2, instruction: 'nop' },
    { labelDef: 'Lbody:', pc: 3, instruction: 'aload_0' },
    { pc: 4, instruction: { op: 'invokevirtual', arg: ['Method', 'X', ['work', '()V']] } },
    { labelDef: 'Lrelease:', pc: 7, instruction: 'aload_1' },
    { pc: 8, instruction: 'pop' },
    { pc: 9, instruction: { op: 'goto', arg: 'L0' } },
    { labelDef: 'Lhandler:', pc: 12, instruction: 'astore_2' },
    { pc: 13, instruction: 'aload_2' },
    { pc: 14, instruction: 'athrow' },
  ];
  const et = [{ start_pc: 3, end_pc: 7, handler_pc: 12, catch_type: 'any' }];
  const r = structureMethod(code, et, {
    syncHandlers: new Map([[12, { lockLocal: 1, lockPc: 2 }]]),
  });
  assert.ok(r.ok, r.reason || 'synchronized loop should structure');
  const src = printTree(r.tree, r.render);
  assertGotoFree(src);
  assert.match(src, /aload_0;\s*astore_1;\s*nop;\s*synchronized \(lv1\)/,
    `the next iteration prepares its lock before entering synchronized:\n${src}`);
  const syncBody = src.match(/synchronized \(lv1\) \{([^]*?)\n\}/);
  assert.ok(syncBody, `expected synchronized body:\n${src}`);
  assert.doesNotMatch(syncBody[1], /astore_1/,
    `lock setup must not rotate into the previous iteration's body:\n${src}`);
  for (const field of ['lockLocal', 'lockPc']) {
    const copy = JSON.parse(JSON.stringify(r.tree));
    visitTree(copy, node => { if (node.t === 'synchronized') node[field]++; });
    assert.equal(verifyRegionFlowContracts(copy, r.regionExitContracts), false,
      `synchronized bindings retain ${field}`);
  }
});

// ---------------------------------------------------------------------------
// (e) A nested try: an inner try/catch inside an outer try/catch. Innermost is
// collapsed first, then absorbed into the outer body as a single super-block.
// ---------------------------------------------------------------------------
test('nested try/catch', () => {
  const code = [
    { labelDef: 'L0:', pc: 0, instruction: 'aload_0' },
    { pc: 1, instruction: { op: 'invokevirtual', arg: ['Method', 'X', ['a', '()V']] } },
    { labelDef: 'L4:', pc: 4, instruction: { op: 'goto', arg: 'L10' } },   // inner normal exit
    { labelDef: 'L7:', pc: 7, instruction: 'astore_1' },                   // inner handler
    { pc: 8, instruction: { op: 'goto', arg: 'L10' } },
    { labelDef: 'L10:', pc: 10, instruction: 'iconst_0' },                 // outer body continues
    { pc: 11, instruction: { op: 'goto', arg: 'L16' } },
    { labelDef: 'L13:', pc: 13, instruction: 'astore_2' },                 // outer handler
    { pc: 14, instruction: { op: 'goto', arg: 'L16' } },
    { labelDef: 'L16:', pc: 16, instruction: 'return' },                   // outer merge
  ];
  const et = [
    { start_pc: 0, end_pc: 4, handler_pc: 7, catch_type: 'java/lang/RuntimeException' },
    { start_pc: 0, end_pc: 13, handler_pc: 13, catch_type: 'java/lang/Exception' },
  ];
  const { ok, src } = run(code, et);
  assert.ok(ok, 'should structure');
  assertGotoFree(src);
  assert.equal((src.match(/try \{/g) || []).length, 2, `two nested try blocks:\n${src}`);
  assert.match(src, /catch \(java\.lang\.RuntimeException \w+\)/);
  assert.match(src, /catch \(java\.lang\.Exception \w+\)/);
});

// ---------------------------------------------------------------------------
// (f) A try body with two distinct external exits structures via a selector: the
// try/handler set a synthetic selector local at each exit and an if/else chain
// after the try dispatches to the right join. (No goto, valid Java.)
// ---------------------------------------------------------------------------
test('multi-exit try structures via a selector dispatch', () => {
  const code = [
    { labelDef: 'L0:', pc: 0, instruction: 'iload_0' },
    { pc: 1, instruction: { op: 'ifeq', arg: 'L12' } },  // exit target #1
    { labelDef: 'L4:', pc: 4, instruction: { op: 'goto', arg: 'L16' } }, // exit target #2
    { labelDef: 'L7:', pc: 7, instruction: 'astore_1' },
    { pc: 8, instruction: { op: 'goto', arg: 'L12' } },
    { labelDef: 'L12:', pc: 12, instruction: 'return' },
    { labelDef: 'L16:', pc: 16, instruction: 'iconst_0' },
    { pc: 17, instruction: 'return' },
  ];
  const et = [{ start_pc: 0, end_pc: 7, handler_pc: 7, catch_type: 'java/lang/Exception' }];
  const r = structureMethod(code, et);
  assert.ok(r.ok, 'should structure');
  r.render.synthetic = r.synthetic;
  const src = printTree(r.tree, r.render);
  assertGotoFree(src);
  assert.match(src, /try \{/);
  assert.match(src, /catch \(java\.lang\.Exception \w+\)/);
  // A selector is assigned inside the try and both handler, and tested after.
  const selector = (src.match(/decompiledRegionSelector\d+/) || [])[0];
  assert.ok(selector, `expected a selector variable:\n${src}`);
  assert.ok((src.match(new RegExp(`${selector} = \\d+;`, 'g')) || []).length >= 2,
    `selector assigned at each exit:\n${src}`);
  assert.match(src, new RegExp(`if \\(${selector} == \\d+\\)`), 'dispatch on the selector');
});

// ---------------------------------------------------------------------------
// A method with no exception table just structures normally.
// ---------------------------------------------------------------------------
test('no exception table structures as a plain method', () => {
  const code = [
    { labelDef: 'L0:', pc: 0, instruction: 'iload_0' },
    { pc: 1, instruction: { op: 'ifeq', arg: 'L6' } },
    { labelDef: 'L4:', pc: 4, instruction: 'iconst_1' },
    { pc: 5, instruction: 'ireturn' },
    { labelDef: 'L6:', pc: 6, instruction: 'iconst_0' },
    { pc: 7, instruction: 'ireturn' },
  ];
  const { ok, src } = run(code, []);
  assert.ok(ok);
  assertGotoFree(src);
  assert.doesNotMatch(src, /try \{/);
});

// ---------------------------------------------------------------------------
// (g) normalizeTable must never fuse a synchronized monitor handler with a real
// catch that shares a protected range: doing so emits an invalid
// `catch (Throwable) … catch (RuntimeException)` two-catch try. The sync handler
// belongs in its own group so it structures as a nested `synchronized` block.
// ---------------------------------------------------------------------------
test('sync handler and real catch on a shared range split into separate groups', () => {
  const { normalizeTable } = require('../src/decompiler/exceptionStructurer');
  const et = [
    { start_pc: 8, end_pc: 43, handler_pc: 79, catch_type: 'any' },
    { start_pc: 44, end_pc: 78, handler_pc: 79, catch_type: 'any' },
    { start_pc: 0, end_pc: 43, handler_pc: 87, catch_type: 'java/lang/RuntimeException' },
    { start_pc: 44, end_pc: 78, handler_pc: 87, catch_type: 'java/lang/RuntimeException' },
  ];
  const syncHandlers = new Map([[79, { lockLocal: 5, lockPc: 7 }]]);
  const { groups } = normalizeTable(et, syncHandlers);
  // Two groups, never one fused two-catch group.
  assert.equal(groups.length, 2, `expected two groups:\n${JSON.stringify(groups, null, 1)}`);
  for (const g of groups) {
    assert.equal(g.catches.length, 1, `each group has a single handler:\n${JSON.stringify(g)}`);
  }
  const handlers = groups.map((g) => g.catches[0].handler_pc).sort((a, b) => a - b);
  assert.deepEqual(handlers, [79, 87]);
  // Even without the synchronized-handler hint, the handlers have different
  // complete protected-range sets and therefore remain nested groups.
  const nested = normalizeTable(et).groups;
  assert.equal(nested.length, 2);
  assert.ok(nested.every((g) => g.catches.length === 1));
});

test('same-handler multi-catch drops alternatives covered by a broader type', () => {
  const { normalizeTable } = require('../src/decompiler/exceptionStructurer');
  const et = [
    { start_pc: 0, end_pc: 4, handler_pc: 8, catch_type: 'Child' },
    { start_pc: 0, end_pc: 4, handler_pc: 8, catch_type: 'Parent' },
    { start_pc: 0, end_pc: 4, handler_pc: 8, catch_type: 'Unrelated' },
  ];
  const isAssignable = (subtype, supertype) => subtype === supertype
    || (subtype === 'Child' && supertype === 'Parent');
  const { groups } = normalizeTable(et, null, isAssignable);
  assert.deepEqual(groups[0].catches[0].catch_type, ['Parent', 'Unrelated']);
});
