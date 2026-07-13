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
  assert.match(src, /\} catch \(java\.io\.IOException e\) \{/);
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
  assert.match(src, /catch \(java\.io\.IOException e\)/);
  assert.match(src, /catch \(java\.lang\.RuntimeException e\)/);
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
  assert.match(src, /catch \(java\.lang\.Throwable e\)/);
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
  assert.match(src, /catch \(java\.lang\.RuntimeException e\)/);
  assert.match(src, /catch \(java\.lang\.Exception e\)/);
});

// ---------------------------------------------------------------------------
// (f) A try body with two distinct external exits is out of v1 scope: it must
// bail gracefully (never emit wrong Java).
// ---------------------------------------------------------------------------
test('multi-exit try bails gracefully', () => {
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
  assert.equal(r.ok, false, 'should bail');
  assert.match(r.reason, /external exit/);
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
