'use strict';

const test = require('tape');
const fs = require('fs');
const path = require('path');
const { buildSsa } = require('../src/analysis/opgraph/ssa');
const { buildOp02Graph } = require('../src/analysis/opgraph/op02');

const STATIC_II_I = { name: 'f', descriptor: '(II)I', flags: ['static'] };

function build(codeItems, method = STATIC_II_I, exceptionTable = []) {
  return buildSsa({ codeItems, exceptionTable, method });
}

test('ssa builds a straight-line body with params as defs', (t) => {
  const fn = build([
    { pc: 0, instruction: 'iload_0' },
    { pc: 1, instruction: 'iload_1' },
    { pc: 2, instruction: 'iadd' },
    { pc: 3, instruction: 'ireturn' },
  ]);
  t.notOk(fn.rejected, 'accepted');
  t.equal(fn.params.length, 2);
  t.equal(fn.params[0].kind, 'I');
  const block = fn.blocks[0];
  t.equal(block.term.insnOp, 'ireturn');
  t.equal(block.term.args.length, 1);
  const result = block.term.args[0];
  t.equal(result.op, 'iadd');
  t.deepEqual(result.args.map((a) => a.op), ['param', 'param']);
  t.equal(result.kind, 'I');
  t.equal(block.phis.length, 0, 'no phis in straight line');
  t.end();
});

test('ssa dissolves dup into value aliasing, no copy node', (t) => {
  const fn = build([
    { pc: 0, instruction: 'iload_0' },
    { pc: 1, instruction: 'dup' },
    { pc: 2, instruction: 'imul' },
    { pc: 3, instruction: 'ireturn' },
  ], { name: 'sq', descriptor: '(I)I', flags: ['static'] });
  t.notOk(fn.rejected, 'accepted');
  const mul = fn.blocks[0].term.args[0];
  t.equal(mul.op, 'imul');
  t.equal(mul.args[0], mul.args[1], 'both operands are the same IrValue');
  t.equal(mul.args[0].op, 'param');
  t.end();
});

test('ssa inserts and kinds phis at a diamond join (stack join)', (t) => {
  const fn = build([
    { pc: 0, instruction: 'iload_0' },
    { pc: 1, instruction: { op: 'ifeq', arg: 'Lelse' } },
    { pc: 2, instruction: 'iconst_1' },
    { pc: 3, instruction: { op: 'goto', arg: 'Ljoin' } },
    { pc: 4, labelDef: 'Lelse:', instruction: 'iconst_2' },
    { pc: 5, labelDef: 'Ljoin:', instruction: 'ireturn' },
  ], { name: 'g', descriptor: '(I)I', flags: ['static'] });
  t.notOk(fn.rejected, 'accepted');
  const join = fn.blocks.find((b) => b.phis.length > 0);
  t.ok(join, 'join block has a phi');
  const phi = join.phis[0];
  t.equal(phi.kind, 'I');
  t.equal(phi.args.length, 2);
  t.deepEqual(phi.args.map((a) => a.op).sort(), ['iconst_1', 'iconst_2']);
  t.equal(join.term.args[0], phi, 'return consumes the phi');
  t.end();
});

test('ssa local phi in a counting loop, iinc threads the def chain', (t) => {
  const fn = build([
    { pc: 0, instruction: 'iconst_0' },
    { pc: 1, instruction: 'istore_1' },
    { pc: 2, labelDef: 'Lhead:', instruction: 'iload_1' },
    { pc: 3, instruction: 'iload_0' },
    { pc: 4, instruction: { op: 'if_icmpge', arg: 'Ldone' } },
    { pc: 5, instruction: { op: 'iinc', arg: [1, 1] } },
    { pc: 6, instruction: { op: 'goto', arg: 'Lhead' } },
    { pc: 7, labelDef: 'Ldone:', instruction: 'iload_1' },
    { pc: 8, instruction: 'ireturn' },
  ], { name: 'count', descriptor: '(I)I', flags: ['static'] });
  t.notOk(fn.rejected, 'accepted');
  const header = fn.blocks.find((b) => b.phis.length > 0);
  t.ok(header, 'loop header has phis');
  const phi = header.phis.find((p) => p.origin && p.origin.slot === 1);
  t.ok(phi, 'phi for slot 1');
  t.equal(phi.kind, 'I');
  const ops = phi.args.map((a) => a.op).sort();
  t.deepEqual(ops, ['iconst_0', 'iinc'], 'phi joins init and increment');
  const inc = phi.args.find((a) => a.op === 'iinc');
  t.equal(inc.args[0], phi, 'iinc consumes the phi (loop-carried)');
  t.end();
});

test('ssa prunes trivial phis (single-def slot across a diamond)', (t) => {
  const fn = build([
    { pc: 0, instruction: 'iload_0' },
    { pc: 1, instruction: { op: 'ifeq', arg: 'Ljoin' } },
    { pc: 2, instruction: { op: 'goto', arg: 'Ljoin' } },
    { pc: 3, labelDef: 'Ljoin:', instruction: 'iload_1' },
    { pc: 4, instruction: 'ireturn' },
  ]);
  t.notOk(fn.rejected, 'accepted');
  const join = fn.blocks.find((b) => b.id !== 0 && b.term && b.term.insnOp === 'ireturn');
  t.ok(join, 'found join');
  t.equal(join.phis.length, 0, 'trivial phis pruned');
  t.equal(join.term.args[0].op, 'param', 'return reads the parameter directly');
  t.end();
});

test('ssa supports switch terms with selector arg', (t) => {
  const fn = build([
    { pc: 0, instruction: 'iload_0' },
    { pc: 1, instruction: { op: 'lookupswitch', arg: { pairs: [[1, 'La'], [5, 'Lb']], defaultLabel: 'Ld' } } },
    { pc: 2, labelDef: 'La:', instruction: 'iconst_1' },
    { pc: 3, instruction: 'ireturn' },
    { pc: 4, labelDef: 'Lb:', instruction: 'iconst_2' },
    { pc: 5, instruction: 'ireturn' },
    { pc: 6, labelDef: 'Ld:', instruction: 'iconst_0' },
    { pc: 7, instruction: 'ireturn' },
  ], { name: 's', descriptor: '(I)I', flags: ['static'] });
  t.notOk(fn.rejected, 'accepted');
  const entry = fn.blocks[0];
  t.equal(entry.term.kind, 'switch');
  t.equal(entry.term.args.length, 1);
  t.equal(entry.term.args[0].op, 'param');
  t.equal(entry.term.cases.length, 2);
  t.end();
});

test('ssa long/double widths thread through stack and locals', (t) => {
  const fn = build([
    { pc: 0, instruction: 'lload_0' },
    { pc: 1, instruction: { op: 'ldc2_w', arg: 2n } },
    { pc: 2, instruction: 'lmul' },
    { pc: 3, instruction: 'lstore_2' },
    { pc: 4, instruction: 'lload_2' },
    { pc: 5, instruction: 'lreturn' },
  ], { name: 'dbl', descriptor: '(J)J', flags: ['static'] });
  t.notOk(fn.rejected, 'accepted');
  const term = fn.blocks[0].term;
  t.equal(term.args[0].op, 'lmul');
  t.equal(term.args[0].kind, 'J');
  t.equal(term.args[0].args[1].kind, 'J', 'ldc2_w bigint is J');
  t.end();
});

test('ssa handler entry is opaque: caught_exception + handler_local', (t) => {
  const fn = build([
    { pc: 0, labelDef: 'Ltry:', instruction: 'iload_0' },
    { pc: 1, instruction: 'istore_1' },
    { pc: 2, instruction: 'iload_1' },
    { pc: 3, instruction: 'ireturn' },
    { pc: 4, labelDef: 'Lend:', instruction: 'nop' },
    { pc: 5, labelDef: 'Lcatch:', instruction: 'pop' },
    { pc: 6, instruction: 'iload_1' },
    { pc: 7, instruction: 'ireturn' },
  ], { name: 'h', descriptor: '(I)I', flags: ['static'] },
  [{ startLbl: 'Ltry', endLbl: 'Lend', handlerLbl: 'Lcatch', catchType: 'java/lang/Exception' }]);
  t.notOk(fn.rejected, `accepted (${fn.rejected})`);
  const handler = fn.blocks.find((b) => b.isHandlerEntry);
  t.ok(handler, 'handler block found');
  t.equal(handler.entryStack.length, 1);
  t.equal(handler.entryStack[0].op, 'caught_exception');
  t.equal(handler.entryStack[0].kind, 'A');
  t.equal(handler.term.args[0].op, 'handler_local', 'handler reads opaque local');
  t.equal(handler.term.args[0].kind, 'I', 'load imposed I on the opaque local');
  t.end();
});

test('ssa rejects subroutines, unsupported ops, and stack mismatches', (t) => {
  t.ok(build([
    { pc: 0, instruction: { op: 'jsr', arg: 'Lsub' } },
    { pc: 1, instruction: 'return' },
    { pc: 2, labelDef: 'Lsub:', instruction: 'astore_1' },
    { pc: 3, instruction: { op: 'ret', arg: 1 } },
  ], { name: 'j', descriptor: '()V', flags: ['static'] }).rejected, 'jsr/ret rejected');
  t.ok(build([
    { pc: 0, instruction: 'iconst_0' },
    { pc: 1, instruction: { op: 'ifeq', arg: 'Ljoin' } },
    { pc: 2, instruction: 'iconst_1' },
    { pc: 3, labelDef: 'Ljoin:', instruction: 'return' },
  ], { name: 'm', descriptor: '()V', flags: ['static'] }).rejected, 'depth mismatch rejected');
  t.ok(build([
    { pc: 0, instruction: 'iload_0' },
    { pc: 1, instruction: 'ireturn' },
  ], { name: 'u', descriptor: '()I', flags: ['static'] }).rejected, 'undefined local load rejected');
  t.end();
});

test('ssa dominance invariant: every non-phi arg is defined before use in RPO', (t) => {
  const fn = build([
    { pc: 0, instruction: 'iconst_0' },
    { pc: 1, instruction: 'istore_1' },
    { pc: 2, labelDef: 'Lhead:', instruction: 'iload_1' },
    { pc: 3, instruction: 'iload_0' },
    { pc: 4, instruction: { op: 'if_icmpge', arg: 'Ldone' } },
    { pc: 5, instruction: { op: 'iinc', arg: [1, 1] } },
    { pc: 6, instruction: { op: 'goto', arg: 'Lhead' } },
    { pc: 7, labelDef: 'Ldone:', instruction: 'iload_1' },
    { pc: 8, instruction: 'ireturn' },
  ], { name: 'count', descriptor: '(I)I', flags: ['static'] });
  t.notOk(fn.rejected, 'accepted');
  const seen = new Set(fn.params.map((p) => p.id));
  for (const block of fn.blocks) {
    for (const phi of block.phis) seen.add(phi.id);
  }
  for (const block of fn.blocks) {
    for (const node of block.body) {
      for (const arg of node.args) {
        t.ok(seen.has(arg.id) || arg.op === 'phi' || arg.op === 'undef',
          `arg ${arg.id} (${arg.op}) of ${node.op} defined before use`);
      }
      seen.add(node.id);
    }
  }
  t.end();
});

// Whole-jar differential: SSA per-instruction stack depths must agree with
// op02's independent fixpoint on every method both accept. Heavy, so gated:
// SSA_JAR_CLASSES=/path/to/classes dir of .class files.
test('ssa whole-jar depth differential vs op02', async (t) => {
  const classesDir = process.env.SSA_JAR_CLASSES;
  if (!classesDir || !fs.existsSync(classesDir)) {
    t.skip('SSA_JAR_CLASSES not set');
    t.end();
    return;
  }
  const { JVM } = require('../src/core/jvm');
  const jvm = new JVM({ classpath: [classesDir] });
  const names = fs.readdirSync(classesDir).filter((f) => f.endsWith('.class'))
    .map((f) => f.replace(/\.class$/, ''));
  for (const n of names) await jvm.loadClassByName(n).catch(() => null);

  let accepted = 0; let rejectedCount = 0; let compared = 0; let mismatches = 0;
  let total = 0;
  const rejectReasons = new Map();
  for (const n of names) {
    const cd = jvm.classes[n];
    const cls = cd && cd.ast && cd.ast.classes[0];
    if (!cls) continue;
    for (const item of cls.items) {
      if (item.type !== 'method') continue;
      const code = (item.method.attributes || []).find((a) => a.type === 'code');
      if (!code || !code.code) continue;
      total += 1;
      const fn = buildSsa({
        codeItems: code.code.codeItems || [],
        exceptionTable: code.code.exceptionTable || [],
        method: item.method,
        cls,
      });
      if (fn.rejected) {
        rejectedCount += 1;
        const key = String(fn.rejected).slice(0, 60);
        rejectReasons.set(key, (rejectReasons.get(key) || 0) + 1);
        continue;
      }
      accepted += 1;
      let graph;
      try {
        // op02's merge-identity worklist can blow up on obfuscated CFGs;
        // budget it and skip those methods (buildSsa itself is bounded).
        graph = buildOp02Graph(code.code, { maxSteps: 20000 });
      } catch (_) { continue; }
      for (const node of graph.nodes) {
        const ssaDepth = fn.depthBefore.get(node.itemIndex);
        if (ssaDepth === undefined || node.stackDepthBefore === null) continue;
        compared += 1;
        if (ssaDepth !== node.stackDepthBefore) {
          mismatches += 1;
          if (mismatches <= 5) {
            t.comment(`depth mismatch ${n}.${item.method.name} item ${node.itemIndex}: ssa ${ssaDepth} vs op02 ${node.stackDepthBefore}`);
          }
        }
      }
    }
  }
  const top = [...rejectReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  t.comment(`methods: ${total}, ssa-accepted: ${accepted} (${(100 * accepted / Math.max(1, total)).toFixed(1)}%), rejected: ${rejectedCount}`);
  for (const [reason, count] of top) t.comment(`  reject ${count}x: ${reason}`);
  t.comment(`depth comparisons: ${compared}`);
  t.equal(mismatches, 0, 'no per-instruction stack-depth mismatches vs op02');
  t.ok(accepted > 0, 'accepts a nonzero share of the jar');
  t.end();
});
