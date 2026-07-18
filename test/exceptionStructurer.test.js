'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { structureMethod } = require('../src/decompiler/exceptionStructurer');
const { printTree } = require('../src/decompiler/structurer');

// Render a method (codeItems + exception table) and return { ok, src, r }.
function run(codeItems, exceptionTable) {
  const r = structureMethod(codeItems, exceptionTable);
  const src = r.ok ? printTree(r.tree, r.render) : null;
  return { ok: r.ok, src, r };
}

function assertGotoFree(src) {
  assert.ok(!/\bgoto\b/.test(src), `expected no goto in:\n${src}`);
}

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
  // Without syncHandlers, the old fused behavior is preserved (a single group
  // whose catches include both handlers) — the split is sync-specific.
  const fused = normalizeTable(et).groups;
  assert.ok(fused.some((g) => g.catches.length === 2), 'non-sync grouping still fuses shared ranges');
});
