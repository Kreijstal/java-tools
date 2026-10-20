'use strict';
const test = require('tape');
const { buildSsa } = require('../src/analysis/opgraph/ssa');
const { analyzeReferenceFacts } = require('../src/analysis/opgraph/referenceFacts');

const ins = (op, arg, label) => ({ labelDef: label && label + ':', instruction: arg === undefined ? op : { op, arg } });
function build(items, descriptor, flags = ['static'], exceptionTable = []) {
  const fn = buildSsa({ codeItems: items.map(x => typeof x === 'string' ? ins(x) : x),
    method: { name: 'test', descriptor, flags }, className: 'Owner', exceptionTable });
  if (fn.rejected) throw new Error(fn.rejected);
  return fn;
}

test('shared SSA reference facts preserve verification kinds and wide parameter slots', t => {
  const fn = build(['aload_0', 'areturn'], '(J[ILx/Node;)Ljava/lang/Object;', []);
  const facts = fn.referenceFacts;
  t.equal(fn.referenceFacts, facts, 'consumers share one lazy analysis object');
  t.notOk(Object.keys(fn).includes('referenceFacts'), 'analysis is not transport metadata');
  t.equal(fn.params[0].kind, 'A', 'verification kind stays A');
  t.equal(facts.get(fn.params[0]).nullness, 'nonnull', 'instance this is non-null');
  t.deepEqual(facts.get(fn.params[0]).upperBounds, ['Owner'], 'this has its declaring bound');
  t.equal(fn.params[2].imm.slot, 3, 'wide primitive occupies two slots');
  t.deepEqual(facts.get(fn.params[2]).upperBounds, ['[I'], 'array parameter keeps its descriptor');
  t.equal(facts.get(fn.params[2]).nullness, 'maybe', 'reference parameters remain nullable');
  t.deepEqual(facts.get(fn.params[3]).upperBounds, ['x/Node'], 'reference descriptor uses internal names');
  t.equal(facts.get(fn.params[1]).nullness, 'maybe', 'non-reference values supply no reference proof');
  t.end();
});

test('SSA type facts flow through allocation, casts, aliases, fields, calls and array loads', t => {
  for (const [items, descriptor, type, exact, nullness] of [
    [[ins('new', 'x/Node'), 'areturn'], '()Ljava/lang/Object;', 'x/Node', 'x/Node', 'nonnull'],
    [['iconst_1', ins('newarray', 'int'), 'areturn'], '()[I', '[I', '[I', 'nonnull'],
    [['iconst_1', ins('anewarray', 'x/Node'), 'areturn'], '()[Lx/Node;', '[Lx/Node;', '[Lx/Node;', 'nonnull'],
    [['aload_0', ins('checkcast', 'x/Node'), 'astore_1', 'aload_1', 'areturn'],
      '(Ljava/lang/Object;)Ljava/lang/Object;', 'x/Node', null, 'maybe'],
    [[ins('getstatic', ['Field', 'Fields', ['value', 'Lx/Node;']]), 'areturn'],
      '()Lx/Node;', 'x/Node', null, 'maybe'],
    [[ins('invokestatic', ['Method', 'Factory', ['make', '()Lx/Node;']]), 'areturn'],
      '()Lx/Node;', 'x/Node', null, 'maybe'],
    [['aload_0', 'iconst_0', 'aaload', 'areturn'], '([Lx/Node;)Lx/Node;', 'x/Node', null, 'maybe'],
    [['aload_0', 'iconst_0', 'aaload', 'areturn'], '([[I)[I', '[I', null, 'maybe'],
  ]) {
    const fn = build(items, descriptor), value = fn.blocks.find(b => b.term.insnOp === 'areturn').term.args[0];
    const proof = fn.referenceFacts.get(value);
    t.ok(proof.upperBounds.includes(type), 'bound ' + type + ' for ' + value.op);
    t.equal(proof.exactType, exact, 'exact allocation type only when proven');
    t.equal(proof.nullness, nullness, 'nullable fields, calls and elements are not allocations');
  }
  t.end();
});

test('reference phi joins handle null arms without guessing an exact type', t => {
  const fn = build(['iload_0', ins('ifeq', 'Lnull'), 'aload_1', ins('checkcast', 'x/Node'),
    ins('goto', 'Ljoin'), ins('aconst_null', undefined, 'Lnull'), ins('areturn', undefined, 'Ljoin')],
  '(ZLjava/lang/Object;)Ljava/lang/Object;');
  const phi = fn.blocks.find(b => b.term.insnOp === 'areturn').term.args[0];
  t.equal(phi.op, 'phi', 'actual control-flow join');
  t.equal(fn.referenceFacts.get(phi).nullness, 'maybe', 'null arm remains possible');
  t.ok(fn.referenceFacts.get(phi).upperBounds.includes('x/Node'), 'all non-null arms share the bound');
  t.equal(fn.referenceFacts.get(phi).exactType, null, 'a cast is not an exact-class proof');
  const allNull = build(['iload_0', ins('ifeq', 'Lother'), 'aconst_null', ins('goto', 'Ljoin'),
    ins('aconst_null', undefined, 'Lother'), ins('areturn', undefined, 'Ljoin')], '(Z)Ljava/lang/Object;');
  const result = allNull.blocks.find(b => b.term.insnOp === 'areturn').term.args[0];
  t.equal(allNull.referenceFacts.get(result).nullness, 'null', 'all-null phi is known null');
  t.end();
});

test('dominating null edges are point-specific and do not leak into the other arm', t => {
  const fn = build(['aload_0', ins('ifnonnull', 'Llive'), 'aload_0', ins('checkcast', 'Absent'),
    'pop', 'iconst_0', 'ireturn', ins('aload_0', undefined, 'Llive'), ins('ifnull', 'Limpossible'),
    'iconst_1', 'ireturn', ins('iconst_2', undefined, 'Limpossible'), 'ireturn'], '(Ljava/lang/Object;)I');
  const facts = fn.referenceFacts, cast = fn.values.find(v => v.op === 'checkcast');
  const branch = fn.blocks.find(b => b.term.insnOp === 'ifnull');
  t.equal(facts.get(fn.params[0]).nullness, 'maybe', 'global input stays nullable');
  t.equal(facts.at(fn.params[0], cast).nullness, 'null', 'null edge proves a later cast needs no lookup');
  t.equal(facts.at(fn.params[0], branch.id).nullness, 'nonnull', 'other arm knows the same reference is non-null');
  t.ok(facts.pathComplete, 'normal-edge analysis converges');
  t.end();
});

test('successful dereferences prove later checks, never their own input', t => {
  const fn = build(['aload_0', 'arraylength', 'pop', 'aload_0', ins('ifnull', 'Lnull'),
    'iconst_1', 'ireturn', ins('iconst_0', undefined, 'Lnull'), 'ireturn'], '([I)I');
  const node = fn.values.find(v => v.op === 'arraylength'), facts = fn.referenceFacts;
  t.equal(facts.at(fn.params[0], node).nullness, 'maybe', 'throwing operation still receives a nullable input');
  t.equal(facts.at(fn.params[0], node.block).nullness, 'nonnull', 'normal completion proves the later condition');
  t.end();
});

test('edge facts are joined for phi arguments and checked again on loop backedges', t => {
  const fn = build(['aload_0', ins('ifnull', 'Lnew'), 'aload_0', ins('goto', 'Ljoin'),
    ins('iconst_0', undefined, 'Lnew'), ins('newarray', 'int'), ins('astore_1', undefined, 'Ljoin'),
    'aload_1', ins('ifnull', 'Lnull'), 'iconst_1', 'ireturn', ins('iconst_0', undefined, 'Lnull'), 'ireturn'],
  '(Ljava/lang/Object;)I');
  const block = fn.blocks.find(b => b.phis.some(p => p.kind === 'A')), phi = block.phis.find(p => p.kind === 'A');
  t.equal(fn.referenceFacts.get(phi).nullness, 'maybe', 'global join alone is conservative');
  t.equal(fn.referenceFacts.at(phi, block.id).nullness, 'nonnull', 'each incoming edge supplies a non-null value');

  const loop = build([ins('getstatic', ['Field', 'Fields', ['next', 'Ljava/lang/Object;']], 'Lhead'),
    'dup', 'astore_0', ins('ifnull', 'Ldone'), 'aload_0',
    ins('getfield', ['Field', 'Fields', ['number', 'I']]), 'pop', ins('goto', 'Lhead'),
    ins('return', undefined, 'Ldone')], '()V');
  const fresh = loop.values.find(v => v.op === 'getstatic');
  t.equal(loop.referenceFacts.at(fresh, fresh.block).nullness, 'maybe',
    'previous iteration success cannot prove this iteration fresh field load non-null');
  t.ok(loop.referenceFacts.pathComplete, 'loop reaches a fixed point');
  t.end();
});

test('opaque handler locals do not inherit normal-path facts', t => {
  const fn = build([ins('aconst_null', undefined, 'Ltry'), 'astore_0', 'aload_1', 'arraylength', 'pop',
    'aload_0', 'areturn', ins('nop', undefined, 'Lend'), ins('pop', undefined, 'Lcatch'),
    'aload_0', ins('checkcast', 'Absent'), 'areturn'], '(Ljava/lang/Object;[I)Ljava/lang/Object;', ['static'],
  [{ start: 'Ltry', end: 'Lend', handler: 'Lcatch', catchType: 'java/lang/Throwable' }]);
  const handler = fn.blocks.find(b => b.isHandlerEntry), cast = handler.body.find(v => v.op === 'checkcast');
  t.equal(cast.args[0].op, 'handler_local', 'handler receives an opaque definition');
  t.equal(fn.referenceFacts.at(cast.args[0], cast).nullness, 'maybe', 'try-path null assignment is not a handler proof');
  t.deepEqual(fn.referenceFacts.get(cast.args[0]).upperBounds, [], 'no parameter type leaks into the handler slot');
  t.end();
});

test('reference equality, instanceof and cast aliases supply only their proven edge facts', t => {
  for (const kind of ['equality', 'instanceof', 'cast']) {
    const prefix = kind === 'equality' ? ['aload_0', 'aconst_null', ins('if_acmpne', 'Lyes')]
      : kind === 'instanceof' ? ['aload_0', ins('instanceof', 'Target'), ins('ifne', 'Lyes')]
        : ['aload_0', ins('checkcast', 'Target'), ins('ifnonnull', 'Lyes')];
    const fn = build([...prefix, 'iconst_0', 'ireturn', ins('aload_0', undefined, 'Lyes'),
      ins('ifnull', 'Lbad'), 'iconst_1', 'ireturn', ins('iconst_2', undefined, 'Lbad'), 'ireturn'],
    '(Ljava/lang/Object;)I');
    const block = fn.blocks.find(b => b.term.insnOp === 'ifnull');
    t.equal(fn.referenceFacts.at(fn.params[0], block.id).nullness, 'nonnull', kind + ' proves the original reference non-null');
    t.equal(fn.referenceFacts.get(fn.params[0]).nullness, 'maybe', kind + ' remains point-specific');
  }
  const entryLoop = build([ins('aload_0', undefined, 'Lhead'), ins('ifnull', 'Ldone'),
    'aconst_null', 'astore_0', ins('goto', 'Lhead'), ins('aload_0', undefined, 'Ldone'), 'areturn'],
  '()Ljava/lang/Object;', []);
  const entry = entryLoop.blocks[entryLoop.entry], receiver = entry.term.args[0];
  t.equal(receiver.op, 'phi', 'entry loop joins original this with replacement');
  t.equal(entryLoop.referenceFacts.at(receiver, entry.id).nullness, 'maybe', 'entry seed does not hide a null backedge');
  t.end();
});

test('analysis budgets fall back to unknown rather than publishing partial proofs', t => {
  const fn = build(['aload_0', ins('ifnull', 'Lnull'), 'aload_0', ins('checkcast', 'Target'), 'areturn',
    ins('aconst_null', undefined, 'Lnull'), 'areturn'], '(Ljava/lang/Object;)Ljava/lang/Object;');
  const cast = fn.values.find(v => v.op === 'checkcast');
  const bounded = analyzeReferenceFacts(fn, { maxPathEntries: 0 });
  t.equal(bounded.at(fn.params[0], cast).nullness, 'maybe', 'discarded path proofs supply no optimism');
  t.notOk(bounded.pathComplete, 'budget exhaustion is observable to diagnostics');
  const noValues = analyzeReferenceFacts(fn, { maxValueWork: 0 });
  t.notOk(noValues.valueComplete, 'value budget also has a bounded fallback');
  t.deepEqual(noValues.get(cast).upperBounds, [], 'partial type proofs are discarded');
  t.end();
});

test('long cast chains share identity proofs without quadratic rescanning', t => {
  const count = 1024;
  const fn = build(['aload_0', ...Array.from({ length: count }, () => ins('checkcast', 'Target')),
    ins('ifnull', 'Lnull'), 'iconst_1', 'ireturn', ins('iconst_0', undefined, 'Lnull'), 'ireturn'],
  '(Ljava/lang/Object;)I');
  let reads = 0;
  for (const node of fn.values.filter(v => v.op === 'checkcast')) {
    Object.defineProperty(node, 'op', { get() { reads++; return 'checkcast'; } });
  }
  const facts = fn.referenceFacts, block = fn.blocks[fn.entry];
  t.equal(facts.at(block.term.args[0], block.id).nullness, 'maybe', 'chain does not invent non-nullness');
  t.equal(facts.identity(block.term.args[0]), fn.params[0], 'casts preserve the original reference');
  t.ok(reads < count * 100, 'node visits scale with the chain, not its square (' + reads + ')');
  t.end();
});

test('wide switches obey the same sparse path budget as linear code', t => {
  const labels = Array.from({ length: 64 }, (_, i) => 'Lcase' + i);
  const fn = build(['aload_0', ins('ifnull', 'Lnull'), 'iload_1',
    ins('lookupswitch', { pairs: labels.map((label, i) => [i, label]), defaultLabel: labels[0] }),
    ...labels.flatMap(label => [ins('aload_0', undefined, label), 'areturn']),
    ins('aconst_null', undefined, 'Lnull'), 'areturn'], '(Ljava/lang/Object;I)Ljava/lang/Object;');
  const leaf = fn.blocks.find(b => b.term.insnOp === 'areturn' && b.term.args[0] === fn.params[0]);
  const facts = analyzeReferenceFacts(fn, { maxPathEntries: 4 });
  t.equal(facts.at(fn.params[0], leaf.id).nullness, 'maybe', 'fanout exhaustion discards partially propagated null checks');
  t.notOk(facts.pathComplete, 'bounded fallback is visible');
  t.deepEqual(facts.get(fn.params[0]).upperBounds, ['java/lang/Object'], 'global type facts survive path-budget exhaustion');
  t.end();
});
