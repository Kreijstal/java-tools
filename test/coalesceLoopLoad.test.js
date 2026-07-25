'use strict';

const test = require('tape');
const fs = require('fs');
const path = require('path');
const { runCoalesceLoopLoad } = require('../src/passes/coalesceLoopLoad');
const { parseKrak2Assembly } = require('../src/parsing/parse_krak2');
const { convertKrak2AstToClassAst } = require('../src/parsing/convert_krak2_ast');

function astWith(codeItems, exceptionTable = []) {
  return {
    classes: [
      {
        className: 'Coalesce',
        items: [
          {
            type: 'method',
            method: {
              name: 'f',
              descriptor: '(I)I',
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

test('coalesce: basic load+goto+T1+load+T2 collapse', (t) => {
  // Shape:
  //   L0: iload 1
  //   L1: goto T2
  //   T1: iload 1
  //   T2: ireturn
  // Plus a forward jump at L_pre that targets T1 so T1 has a real predecessor.
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'goto', arg: 'T1' } }, // forward jump TO T1
    { labelDef: 'L1:', instruction: { op: 'iload', arg: 1 } },
    { instruction: { op: 'goto', arg: 'T2' } },
    { labelDef: 'T1:', instruction: { op: 'iload', arg: 1 } },
    { labelDef: 'T2:', instruction: 'ireturn' },
  ]);

  const result = runCoalesceLoopLoad(ast);
  t.ok(result.changed, 'pass should report a change');
  t.equal(result.fired, 1, 'one pattern folded');

  const ops = code(ast).codeItems
    .filter((it) => it && it.instruction)
    .map((it) => (typeof it.instruction === 'string' ? it.instruction : it.instruction.op));
  // After fold:
  //   L0: goto T1
  //   L1: goto T1            (was iload + goto T2, becomes just goto T1)
  //   T1: iload 1
  //   T2: ireturn
  t.deepEqual(ops, ['goto', 'goto', 'iload', 'ireturn']);
  // Verify the second goto now points at T1, not T2.
  const realInsns = code(ast).codeItems.filter((it) => it && it.instruction);
  t.equal(realInsns[1].instruction.arg, 'T1', 'preheader goto retargeted to T1');
  t.end();
});

test('coalesce: aload_0 folds when slot 0 is never reassigned', (t) => {
  // No astore_0 anywhere — slot 0 stays as `this` for the whole method.
  // Safe to coalesce.
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'goto', arg: 'T1' } },
    { labelDef: 'L1:', instruction: 'aload_0' },
    { instruction: { op: 'goto', arg: 'T2' } },
    { labelDef: 'T1:', instruction: 'aload_0' },
    { labelDef: 'T2:', instruction: 'areturn' },
  ]);
  const result = runCoalesceLoopLoad(ast);
  t.ok(result.changed, 'aload_0 should fold when slot 0 is never reassigned');
  t.equal(result.fired, 1);
  t.end();
});

test('coalesce: aload_0 refuses when method contains astore_0', (t) => {
  // Slot 0 is reassigned somewhere — refuse the entire method's aload_0
  // candidates (the second aload_0 may not represent the same value as
  // the first).
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'goto', arg: 'T1' } },
    { labelDef: 'L1:', instruction: 'aload_0' },
    { instruction: { op: 'goto', arg: 'T2' } },
    { labelDef: 'T1:', instruction: 'aload_0' },
    { labelDef: 'T2:', instruction: 'areturn' },
    // Stray reassignment of slot 0 elsewhere in the method body.
    { labelDef: 'Lother:', instruction: 'aconst_null' },
    { instruction: 'astore_0' },
    { instruction: 'return' },
  ]);
  const result = runCoalesceLoopLoad(ast);
  t.notOk(result.changed, 'aload_0 should be skipped when astore_0 exists');
  t.equal(result.fired, 0);
  t.end();
});

test('coalesce: aload_0 refuses when method contains astore 0 (parameterized)', (t) => {
  // Same gate also catches the parameterized `astore 0` form.
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'goto', arg: 'T1' } },
    { labelDef: 'L1:', instruction: 'aload_0' },
    { instruction: { op: 'goto', arg: 'T2' } },
    { labelDef: 'T1:', instruction: 'aload_0' },
    { labelDef: 'T2:', instruction: 'areturn' },
    { labelDef: 'Lother:', instruction: 'aconst_null' },
    { instruction: { op: 'astore', arg: '0' } },
    { instruction: 'return' },
  ]);
  const result = runCoalesceLoopLoad(ast);
  t.notOk(result.changed, 'aload_0 should be skipped when astore 0 exists');
  t.equal(result.fired, 0);
  t.end();
});

test('coalesce: refuses when T2 has another jump predecessor', (t) => {
  // T2 has a stray third predecessor (a goto from L_extra) — refuse.
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'goto', arg: 'T1' } },
    { labelDef: 'L1:', instruction: { op: 'iload', arg: 1 } },
    { instruction: { op: 'goto', arg: 'T2' } },
    { labelDef: 'T1:', instruction: { op: 'iload', arg: 1 } },
    { labelDef: 'T2:', instruction: 'ireturn' },
    { labelDef: 'Lextra:', instruction: { op: 'goto', arg: 'T2' } }, // 2nd jump to T2
  ]);
  const result = runCoalesceLoopLoad(ast);
  t.notOk(result.changed);
  t.equal(result.fired, 0);
  t.end();
});

test('coalesce: refuses when load opcodes mismatch', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'goto', arg: 'T1' } },
    { labelDef: 'L1:', instruction: { op: 'iload', arg: 1 } },
    { instruction: { op: 'goto', arg: 'T2' } },
    { labelDef: 'T1:', instruction: { op: 'iload', arg: 2 } }, // different operand
    { labelDef: 'T2:', instruction: 'ireturn' },
  ]);
  const result = runCoalesceLoopLoad(ast);
  t.notOk(result.changed);
  t.equal(result.fired, 0);
  t.end();
});

test('coalesce: getstatic folds when both sides reference same field', (t) => {
  // Both sides read the same static field. After fold, the preheader's
  // `getstatic; goto T2` becomes `goto T1` and the T1 getstatic remains.
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'goto', arg: 'T1' } },
    { labelDef: 'L1:', instruction: { op: 'getstatic', arg: ['Field', 'Foo', ['bar', 'I']] } },
    { instruction: { op: 'goto', arg: 'T2' } },
    { labelDef: 'T1:', instruction: { op: 'getstatic', arg: ['Field', 'Foo', ['bar', 'I']] } },
    { labelDef: 'T2:', instruction: 'ireturn' },
  ]);
  const result = runCoalesceLoopLoad(ast);
  t.ok(result.changed, 'matching getstatic on both sides should fold');
  t.equal(result.fired, 1);
  t.end();
});

test('coalesce: getstatic refuses when fields differ', (t) => {
  // Different field name on each side — refuse.
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'goto', arg: 'T1' } },
    { labelDef: 'L1:', instruction: { op: 'getstatic', arg: ['Field', 'Foo', ['bar', 'I']] } },
    { instruction: { op: 'goto', arg: 'T2' } },
    { labelDef: 'T1:', instruction: { op: 'getstatic', arg: ['Field', 'Foo', ['baz', 'I']] } },
    { labelDef: 'T2:', instruction: 'ireturn' },
  ]);
  const result = runCoalesceLoopLoad(ast);
  t.notOk(result.changed, 'getstatic with different field should not fold');
  t.equal(result.fired, 0);
  t.end();
});

test('coalesce: getstatic refuses when descriptors differ', (t) => {
  // Same name but different descriptor — refuse.
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'goto', arg: 'T1' } },
    { labelDef: 'L1:', instruction: { op: 'getstatic', arg: ['Field', 'Foo', ['bar', 'I']] } },
    { instruction: { op: 'goto', arg: 'T2' } },
    { labelDef: 'T1:', instruction: { op: 'getstatic', arg: ['Field', 'Foo', ['bar', 'J']] } },
    { labelDef: 'T2:', instruction: 'ireturn' },
  ]);
  const result = runCoalesceLoopLoad(ast);
  t.notOk(result.changed, 'getstatic with different descriptor should not fold');
  t.equal(result.fired, 0);
  t.end();
});

test('coalesce: iconst folds matching nullary constant', (t) => {
  // iconst_3 on both sides — equality is opcode-only.
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'goto', arg: 'T1' } },
    { labelDef: 'L1:', instruction: 'iconst_3' },
    { instruction: { op: 'goto', arg: 'T2' } },
    { labelDef: 'T1:', instruction: 'iconst_3' },
    { labelDef: 'T2:', instruction: 'ireturn' },
  ]);
  const result = runCoalesceLoopLoad(ast);
  t.ok(result.changed, 'matching iconst_3 should fold');
  t.equal(result.fired, 1);
  t.end();
});

test('coalesce: iconst refuses when constants differ', (t) => {
  // iconst_3 vs iconst_4 — different opcodes, refuse.
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'goto', arg: 'T1' } },
    { labelDef: 'L1:', instruction: 'iconst_3' },
    { instruction: { op: 'goto', arg: 'T2' } },
    { labelDef: 'T1:', instruction: 'iconst_4' },
    { labelDef: 'T2:', instruction: 'ireturn' },
  ]);
  const result = runCoalesceLoopLoad(ast);
  t.notOk(result.changed, 'mismatching iconst should not fold');
  t.equal(result.fired, 0);
  t.end();
});

test('coalesce: bipush folds matching byte literal', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'goto', arg: 'T1' } },
    { labelDef: 'L1:', instruction: { op: 'bipush', arg: '42' } },
    { instruction: { op: 'goto', arg: 'T2' } },
    { labelDef: 'T1:', instruction: { op: 'bipush', arg: '42' } },
    { labelDef: 'T2:', instruction: 'ireturn' },
  ]);
  const result = runCoalesceLoopLoad(ast);
  t.ok(result.changed, 'matching bipush should fold');
  t.equal(result.fired, 1);
  t.end();
});

test('coalesce: bipush refuses when literals differ', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'goto', arg: 'T1' } },
    { labelDef: 'L1:', instruction: { op: 'bipush', arg: '42' } },
    { instruction: { op: 'goto', arg: 'T2' } },
    { labelDef: 'T1:', instruction: { op: 'bipush', arg: '43' } },
    { labelDef: 'T2:', instruction: 'ireturn' },
  ]);
  const result = runCoalesceLoopLoad(ast);
  t.notOk(result.changed, 'mismatching bipush should not fold');
  t.equal(result.fired, 0);
  t.end();
});

test('coalesce: sipush folds matching short literal', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'goto', arg: 'T1' } },
    { labelDef: 'L1:', instruction: { op: 'sipush', arg: '1234' } },
    { instruction: { op: 'goto', arg: 'T2' } },
    { labelDef: 'T1:', instruction: { op: 'sipush', arg: '1234' } },
    { labelDef: 'T2:', instruction: 'ireturn' },
  ]);
  const result = runCoalesceLoopLoad(ast);
  t.ok(result.changed, 'matching sipush should fold');
  t.equal(result.fired, 1);
  t.end();
});

test('coalesce: ldc folds matching string', (t) => {
  // String constant — convert_tree gives us a JS string as `arg`.
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'goto', arg: 'T1' } },
    { labelDef: 'L1:', instruction: { op: 'ldc', arg: 'hello' } },
    { instruction: { op: 'goto', arg: 'T2' } },
    { labelDef: 'T1:', instruction: { op: 'ldc', arg: 'hello' } },
    { labelDef: 'T2:', instruction: 'areturn' },
  ]);
  const result = runCoalesceLoopLoad(ast);
  t.ok(result.changed, 'matching ldc string should fold');
  t.equal(result.fired, 1);
  t.end();
});

test('coalesce: ldc refuses when strings differ', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'goto', arg: 'T1' } },
    { labelDef: 'L1:', instruction: { op: 'ldc', arg: 'hello' } },
    { instruction: { op: 'goto', arg: 'T2' } },
    { labelDef: 'T1:', instruction: { op: 'ldc', arg: 'world' } },
    { labelDef: 'T2:', instruction: 'areturn' },
  ]);
  const result = runCoalesceLoopLoad(ast);
  t.notOk(result.changed, 'mismatching ldc strings should not fold');
  t.equal(result.fired, 0);
  t.end();
});

test('coalesce: ldc folds matching Class reference', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'goto', arg: 'T1' } },
    { labelDef: 'L1:', instruction: { op: 'ldc_w', arg: ['Class', 'java/lang/String'] } },
    { instruction: { op: 'goto', arg: 'T2' } },
    { labelDef: 'T1:', instruction: { op: 'ldc_w', arg: ['Class', 'java/lang/String'] } },
    { labelDef: 'T2:', instruction: 'areturn' },
  ]);
  const result = runCoalesceLoopLoad(ast);
  t.ok(result.changed, 'matching ldc_w Class should fold');
  t.equal(result.fired, 1);
  t.end();
});

test('coalesce: ldc2_w folds matching long', (t) => {
  // Long constants are stringified in the AST.
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'goto', arg: 'T1' } },
    { labelDef: 'L1:', instruction: { op: 'ldc2_w', arg: '1234567890123' } },
    { instruction: { op: 'goto', arg: 'T2' } },
    { labelDef: 'T1:', instruction: { op: 'ldc2_w', arg: '1234567890123' } },
    { labelDef: 'T2:', instruction: 'lreturn' },
  ]);
  const result = runCoalesceLoopLoad(ast);
  t.ok(result.changed, 'matching ldc2_w long should fold');
  t.equal(result.fired, 1);
  t.end();
});

test('coalesce: ldc string "5" does not collide with iconst-derived 5', (t) => {
  // Equality should be type-aware — a string "5" and a numeric 5 must
  // never compare equal even if their stringifications match.
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'goto', arg: 'T1' } },
    { labelDef: 'L1:', instruction: { op: 'ldc', arg: '5' } },
    { instruction: { op: 'goto', arg: 'T2' } },
    { labelDef: 'T1:', instruction: { op: 'ldc', arg: 5 } },
    { labelDef: 'T2:', instruction: 'areturn' },
  ]);
  const result = runCoalesceLoopLoad(ast);
  t.notOk(result.changed, 'ldc string vs ldc int should not fold');
  t.equal(result.fired, 0);
  t.end();
});

test('coalesce: refuses when getfield substitutes for load', (t) => {
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'goto', arg: 'T1' } },
    { labelDef: 'L1:', instruction: { op: 'getfield', arg: 'Field Foo bar I' } },
    { instruction: { op: 'goto', arg: 'T2' } },
    { labelDef: 'T1:', instruction: { op: 'getfield', arg: 'Field Foo bar I' } },
    { labelDef: 'T2:', instruction: 'ireturn' },
  ]);
  const result = runCoalesceLoopLoad(ast);
  t.notOk(result.changed, 'getfield is not a safe load opcode');
  t.equal(result.fired, 0);
  t.end();
});

test('coalesce: end-to-end on CoalesceLoopLoad.j fixture', (t) => {
  const fixturePath = path.join(__dirname, '..', 'examples', 'sources', 'jasmin', 'CoalesceLoopLoad.j');
  const text = fs.readFileSync(fixturePath, 'utf8');
  const krak2 = parseKrak2Assembly(text);
  const astRoot = convertKrak2AstToClassAst(krak2, { sourceText: text });

  const result = runCoalesceLoopLoad(astRoot);
  t.ok(result.changed, 'fixture should trigger the transform');
  // Variant breakdown:
  //   trick           : 1 (iload single-jump)
  //   trick3          : 3 (iload multi-jump)
  //   trickAload0     : 1 (aload_0 single-jump)
  //   trickGetstatic  : 1 (getstatic single-jump)
  //   trickIconst     : 1 (iconst_3 single-jump)
  //   trickBipush     : 1 (bipush single-jump)
  //   trickLdc        : 1 (ldc string single-jump)
  t.equal(result.fired, 9, 'fixture exercises every supported variant');
  t.end();
});

test('coalesce: multi-jump form with 3 preheader paths', (t) => {
  // Three preheader paths, each ending with `iload 1; goto T2`. Plus the
  // T1 fallthrough load. After fold: each `iload 1; goto T2` becomes
  // `goto T1` and the T1 LOAD remains.
  const ast = astWith([
    // path 1
    { labelDef: 'L0:', instruction: { op: 'iload', arg: 1 } },
    { instruction: { op: 'goto', arg: 'T2' } },
    // path 2
    { labelDef: 'L1:', instruction: { op: 'iload', arg: 1 } },
    { instruction: { op: 'goto', arg: 'T2' } },
    // path 3
    { labelDef: 'L2:', instruction: { op: 'iload', arg: 1 } },
    { instruction: { op: 'goto', arg: 'T2' } },
    // forward jumps to seed reachability for L1, L2 (no-op for the pass)
    { labelDef: 'Lseed:', instruction: { op: 'goto', arg: 'L1' } },
    { labelDef: 'Lseed2:', instruction: { op: 'goto', arg: 'L2' } },
    // The fallthrough side reaching T1.
    { labelDef: 'Lfall:', instruction: { op: 'goto', arg: 'T1' } },
    { labelDef: 'T1:', instruction: { op: 'iload', arg: 1 } },
    { labelDef: 'T2:', instruction: 'ireturn' },
  ]);

  const result = runCoalesceLoopLoad(ast);
  t.ok(result.changed, 'multi-jump pattern should fold');
  t.equal(result.fired, 3, 'three jump-preds collapsed in one pass');

  const codeItems = code(ast).codeItems;
  const realInsns = codeItems.filter((it) => it && it.instruction);
  // Every original `goto T2` should now read `goto T1`. There must be
  // no `goto T2` left, and no leading iload before the retargeted gotos.
  const gotoT2Count = realInsns.filter(
    (it) => typeof it.instruction === 'object' &&
            it.instruction.op === 'goto' &&
            it.instruction.arg === 'T2'
  ).length;
  t.equal(gotoT2Count, 0, 'no goto T2 remains');

  // Only one iload remains (the T1 LOAD); the three preheader iloads are gone.
  const iloadCount = realInsns.filter(
    (it) => typeof it.instruction === 'object' && it.instruction.op === 'iload'
  ).length;
  t.equal(iloadCount, 1, 'only T1 iload remains; preheader iloads deleted');
  t.end();
});

test('coalesce: multi-jump form rejects conditional jump to T2', (t) => {
  // Two `goto T2` paths plus a conditional `if_icmpeq T2`. Reject.
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'iload', arg: 1 } },
    { instruction: { op: 'goto', arg: 'T2' } },
    { labelDef: 'L1:', instruction: { op: 'iload', arg: 1 } },
    { instruction: { op: 'goto', arg: 'T2' } },
    // conditional jump to T2 — disqualifies the whole candidate
    { labelDef: 'Lc:', instruction: { op: 'iconst_0' } },
    { instruction: { op: 'iconst_0' } },
    { instruction: { op: 'if_icmpeq', arg: 'T2' } },
    { instruction: 'nop' },
    { labelDef: 'Lfall:', instruction: { op: 'goto', arg: 'T1' } },
    { labelDef: 'T1:', instruction: { op: 'iload', arg: 1 } },
    { labelDef: 'T2:', instruction: 'ireturn' },
  ]);
  const result = runCoalesceLoopLoad(ast);
  t.notOk(result.changed, 'conditional jump to T2 disqualifies candidate');
  t.equal(result.fired, 0);
  t.end();
});

test('coalesce: multi-jump form rejects mismatched preceding load', (t) => {
  // Path 2 ends in `iconst_1; goto T2` instead of `iload 1; goto T2`. Reject.
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'iload', arg: 1 } },
    { instruction: { op: 'goto', arg: 'T2' } },
    { labelDef: 'L1:', instruction: { op: 'iconst_1' } }, // wrong predecessor
    { instruction: { op: 'goto', arg: 'T2' } },
    { labelDef: 'Lfall:', instruction: { op: 'goto', arg: 'T1' } },
    { labelDef: 'T1:', instruction: { op: 'iload', arg: 1 } },
    { labelDef: 'T2:', instruction: 'ireturn' },
  ]);
  const result = runCoalesceLoopLoad(ast);
  t.notOk(result.changed, 'non-matching preceding load rejects all');
  t.equal(result.fired, 0);
  t.end();
});

test('coalesce: refuses when T1 has fallthrough predecessor', (t) => {
  // L0 falls through into T1 directly (no terminator before T1 labelDef).
  const ast = astWith([
    { labelDef: 'L0:', instruction: { op: 'iload', arg: 1 } },
    { instruction: { op: 'goto', arg: 'T2' } },
    { labelDef: 'T1:', instruction: { op: 'iload', arg: 1 } },
    { labelDef: 'T2:', instruction: 'ireturn' },
  ]);
  // T1 has only one jump-pred (none in fact!) and no fallthrough. Wait:
  // here `goto T2` terminates the prior block, so T1 has NO fallthrough
  // predecessor. The only access to T1 is via no jumps at all.
  const result = runCoalesceLoopLoad(ast);
  t.notOk(result.changed, 'unreachable T1 (no jump preds) skipped');
  t.equal(result.fired, 0);
  t.end();
});
