'use strict';

// Regression test: `dup` feeding two stores must duplicate the VALUE, not the
// EXPRESSION.
//
// javac compiles a chained assignment (`a = b = expr`) to a single evaluation
// of expr, a `dup`, and two stores:
//
//     iload_0 / bipush 16 / ishl / dup / istore_0 / istore_1
//
// Rebuilding that as two statements is only sound when re-evaluating the
// expression yields the same result. Here it does not: the first store
// overwrites param0, which the expression reads, so the second evaluation
// shifts an already-shifted value.
//
//     emitted:  param0 = param0 << 16;
//               param1 = param0 << 16;   // shifts twice -> 32 bits -> 0
//     correct:  one shift, one value, stored to both
//
// Found in regression corpus's `oo`, the software rasterizer. Its three triangle-fill
// methods convert coordinates to 16.16 fixed point via chained assignment, and
// the decompiler emitted 18 of these cross-slot re-shifts (6 per method, which
// is exactly the `ishl` count excess over the original class). A doubly
// shifted coordinate is zero, collapsing a vertex to the origin -- on screen,
// large flat triangles smeared across the menu, and interpolation along the
// affected edges running visibly wrong.
//
// Class-level bisection against the original gamepack (437 classes, 9 rounds,
// human oracle) landed on `oo`; splicing the three methods back from the
// original bytecode cleared it; the `ishl` histogram then pinned the
// construct.
//
// STATUS: this test FAILS against the current decompiler. It documents a live
// defect and is expected to go green when the dup-store handling is fixed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('tape');
const { assembleJasminSource } = require('../src/utils/jasminAssembly');
const { decompileClassFile } = require('../src/decompiler/cfr');

function withTempDir(prefix, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function decompileFixture(tempDir, name, source) {
  const classPath = path.join(tempDir, `${name}.class`);
  assembleJasminSource(source, classPath);
  return decompileClassFile(classPath);
}

function methodBody(source, name) {
  const start = source.indexOf(`${name}(`);
  if (start === -1) return '';
  const rest = source.slice(start);
  const end = rest.indexOf('\n    }');
  return end === -1 ? rest : rest.slice(0, end);
}

// `aliased`  -- the defect. The dup'd expression reads param0 and one store
//               writes param0, so re-evaluating it is wrong.
// `distinct` -- the control. The expression reads param2 while the stores
//               target param0/param1, so no store invalidates it. Duplicating
//               the expression here is harmless, and must keep working.
//
// Version 50 matches the gamepack and needs no hand-written StackMapTable.
const DUP_STORE_JASMIN = `.version 50 0
.class public super FixedPoint
.super java/lang/Object

.method public <init> : ()V
    .code stack 1 locals 1
        aload_0
        invokespecial Method java/lang/Object <init> ()V
        return
    .end code
.end method

.method public static sink : (I)V
    .code stack 0 locals 1
        return
    .end code
.end method

.method public static aliased : (III)V
    .code stack 3 locals 3
        iload_0
        bipush 16
        ishl
        dup
        istore_0
        istore_1
        iload_2
        bipush 16
        ishl
        istore_2
        iload_0
        invokestatic Method FixedPoint sink (I)V
        iload_1
        invokestatic Method FixedPoint sink (I)V
        iload_2
        invokestatic Method FixedPoint sink (I)V
        return
    .end code
.end method

.method public static distinct : (III)V
    .code stack 3 locals 3
        iload_2
        bipush 16
        ishl
        dup
        istore_0
        istore_1
        iload_0
        invokestatic Method FixedPoint sink (I)V
        iload_1
        invokestatic Method FixedPoint sink (I)V
        return
    .end code
.end method
.end class
`;

test('CFR-JS does not re-evaluate a dup\'d expression whose operand a store clobbers', (t) => {
  withTempDir('cfr-dup-store-', (tempDir) => {
    const source = decompileFixture(tempDir, 'FixedPoint', DUP_STORE_JASMIN);
    const body = methodBody(source, 'aliased');

    t.ok(body.length > 0, 'the aliased method is emitted');

    // The bytecode shifts once. Two shifts here means the dup'd expression was
    // re-evaluated after its operand had already been overwritten.
    const shifts = (body.match(/<< 16/g) || []).length;
    t.equal(shifts, 2,
      'one shift for the chained assignment plus one for the independent store');

    t.notOk(/param1 = param0 << 16/.test(body),
      'the second store does not re-shift the value the first store just wrote');

    t.end();
  });
});

test('CFR-JS still handles a dup whose stores do not clobber the operand', (t) => {
  withTempDir('cfr-dup-store-control-', (tempDir) => {
    const source = decompileFixture(tempDir, 'FixedPoint', DUP_STORE_JASMIN);
    const body = methodBody(source, 'distinct');

    t.ok(body.length > 0, 'the control method is emitted');
    t.match(body, /<< 16/, 'the control still performs its shift');
    t.notOk(/param2 = param2 << 16/.test(body),
      'the control does not invent a store to the untouched operand');

    t.end();
  });
});
