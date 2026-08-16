'use strict';

// Regression test: short-circuit reconstruction must not delete a call.
//
// When a block has two predecessors, the structurer may rebuild the pair as a
// disjunction (`a == x || a == y`). That is only sound when the second
// predecessor reaches the shared block with nothing in between. When it does
// not -- when that path runs a call first -- merging anyway drops the call
// outright. javac stays at zero errors and the class verifies, so the damage is
// visible only in the emitted source.
//
// Found in vertigo2's `qm`, the Jagex account prompt. Its click handler
// dispatches three buttons, and the bytecode gives each its own action:
//
//     E ("Go Back")                -> sd.f(-1)
//     F ("Create a free Account")  -> ff.b(-104)
//     H ("Just play")              -> wq.i(0)
//
// The decompiler emits `if (param1 == field_F || param1 == field_H)
// ff.b(-104);` with `wq.i` absent from the file entirely, so clicking
// "Just play" runs the create-account action.
//
// The trigger is CLEANED control flow, not obfuscated control flow. Handed the
// raw gamepack class -- opaque predicates, dead `athrow` blocks, overlapping
// per-segment RuntimeException rows -- the decompiler bails out to labelled
// blocks and keeps `wq.i(0)`. It is only after the bytecode passes normalize
// that away that the structurer recognizes the shape and mis-merges it. So a
// fixture built from the obfuscated shape passes while the defect is live;
// these fixtures are built from the normalized shape instead.

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

// Three methods, all on one class:
//
//   dispatch -- the minimal reproducer. No exception table, no opaque
//               predicate, no arithmetic guard: the branch topology alone is
//               enough. The `f` test jumps FORWARD past the `h` test to the
//               shared block, so the shared block's two predecessors are not
//               adjacent and the `h` one runs play() on the way.
//   guarded  -- the same topology wearing the gamepack's clothes (opaque
//               predicate, outer RuntimeException wrapper, trailing modulo),
//               matching vertigo2 `qm` after the bytecode passes run. Kept
//               because the extra structure has historically changed which
//               structurer claims a method.
//   plain    -- the control. Here the second predecessor really is empty, so
//               collapsing to a disjunction is correct and must keep working.
//
// Major version 50 matches the gamepack and keeps the class verifiable without
// hand-written StackMapTable frames.
const BRANCH_MERGE_JASMIN = `.version 50 0
.class public super BranchMerge
.super java/lang/Object

.field static opaque Z
.field public e Ljava/lang/Object;
.field public f Ljava/lang/Object;
.field public h Ljava/lang/Object;

.method public <init> : ()V
    .code stack 1 locals 1
        aload_0
        invokespecial Method java/lang/Object <init> ()V
        return
    .end code
.end method

.method public static back : (B)V
    .code stack 0 locals 1
        return
    .end code
.end method

.method public static play : (I)V
    .code stack 0 locals 1
        return
    .end code
.end method

.method public static account : (B)V
    .code stack 0 locals 1
        return
    .end code
.end method

.method public static wrap : (Ljava/lang/RuntimeException;Ljava/lang/String;)Ljava/lang/RuntimeException;
    .code stack 1 locals 2
        aload_0
        areturn
    .end code
.end method

.method public dispatch : (Ljava/lang/Object;)V
    .code stack 3 locals 2
        aload_0
        getfield Field BranchMerge e Ljava/lang/Object;
        aload_1
        if_acmpne Lcheckf
        iconst_m1
        invokestatic Method BranchMerge back (B)V
        goto Lexit
Lcheckf:
        aload_1
        aload_0
        getfield Field BranchMerge f Ljava/lang/Object;
        if_acmpeq Laccount
        aload_1
        aload_0
        getfield Field BranchMerge h Ljava/lang/Object;
        if_acmpne Lexit
        iconst_0
        invokestatic Method BranchMerge play (I)V
        goto Lexit
Laccount:
        bipush -104
        invokestatic Method BranchMerge account (B)V
        goto Lexit
Lexit:
        return
    .end code
.end method

.method public guarded : (ILjava/lang/Object;BII)V
    .code stack 4 locals 8
        .catch java/lang/RuntimeException from Lstart to Lexitend using Lcatch
        getstatic Field BranchMerge opaque Z
        istore 7
Lstart:
        aload_0
        getfield Field BranchMerge e Ljava/lang/Object;
        aload_2
        if_acmpne Lcheckf
        iconst_m1
        invokestatic Method BranchMerge back (B)V
        goto Lexit
Lcheckf:
        aload_2
        aload_0
        getfield Field BranchMerge f Ljava/lang/Object;
        if_acmpeq Laccount
        aload_2
        aload_0
        getfield Field BranchMerge h Ljava/lang/Object;
        if_acmpne Lexit
        iconst_0
        invokestatic Method BranchMerge play (I)V
        goto Lexit
Laccount:
        bipush -104
        invokestatic Method BranchMerge account (B)V
        goto Lexit
Lexit:
        bipush 21
        iload_3
        bipush -63
        isub
        bipush 51
        idiv
        irem
        istore 6
Lexitend:
        goto Lend
Lcatch:
        astore 6
        aload 6
        new java/lang/StringBuilder
        dup
        invokespecial Method java/lang/StringBuilder <init> ()V
        ldc 'BranchMerge.guarded('
        invokevirtual Method java/lang/StringBuilder append (Ljava/lang/String;)Ljava/lang/StringBuilder;
        iload_1
        invokevirtual Method java/lang/StringBuilder append (I)Ljava/lang/StringBuilder;
        bipush 41
        invokevirtual Method java/lang/StringBuilder append (C)Ljava/lang/StringBuilder;
        invokevirtual Method java/lang/StringBuilder toString ()Ljava/lang/String;
        invokestatic Method BranchMerge wrap (Ljava/lang/RuntimeException;Ljava/lang/String;)Ljava/lang/RuntimeException;
        athrow
Lend:
        return
    .end code
.end method

.method public plain : (Ljava/lang/Object;)V
    .code stack 2 locals 2
        aload_1
        aload_0
        getfield Field BranchMerge f Ljava/lang/Object;
        if_acmpeq Laccount
        aload_1
        aload_0
        getfield Field BranchMerge h Ljava/lang/Object;
        if_acmpne Lexit
Laccount:
        bipush -104
        invokestatic Method BranchMerge account (B)V
Lexit:
        return
    .end code
.end method
.end class
`;

function methodBody(source, name) {
  // Slice from the method signature to the start of the next member, so an
  // assertion about one method cannot be satisfied by another method's text.
  const start = source.indexOf(`void ${name}(`);
  if (start === -1) return '';
  const rest = source.slice(start + 1);
  const next = rest.search(/\n {4}(public|private|protected|final|static|void|[A-Za-z_$][\w$]*\s+[\w$]+\()/);
  return next === -1 ? rest : rest.slice(0, next);
}

// Each of the three actions is reachable in the bytecode, so each must appear
// in the source. play() is the one that disappears.
function assertAllThreeActions(t, body, label) {
  t.ok(body.length > 0, `${label}: the method is emitted`);
  t.match(body, /back\(/, `${label}: the first branch keeps its action`);
  t.match(body, /account\(/, `${label}: the shared block is still reached`);
  t.match(body, /play\(/,
    `${label}: the second predecessor keeps its call instead of being merged away`);
  t.notOk(/\|\|/.test(body) && !/play\(/.test(body),
    `${label}: the comparisons are not collapsed into a call-dropping disjunction`);
}

test('CFR-JS keeps a call on the second predecessor of a merged branch target', (t) => {
  withTempDir('cfr-branch-merge-', (tempDir) => {
    const source = decompileFixture(tempDir, 'BranchMerge', BRANCH_MERGE_JASMIN);
    assertAllThreeActions(t, methodBody(source, 'dispatch'), 'dispatch');
    t.end();
  });
});

test('CFR-JS keeps the call when the same shape carries the gamepack guards', (t) => {
  withTempDir('cfr-branch-merge-guarded-', (tempDir) => {
    const source = decompileFixture(tempDir, 'BranchMerge', BRANCH_MERGE_JASMIN);
    assertAllThreeActions(t, methodBody(source, 'guarded'), 'guarded');
    t.end();
  });
});

test('CFR-JS still merges a branch target whose second predecessor is empty', (t) => {
  withTempDir('cfr-branch-merge-control-', (tempDir) => {
    const source = decompileFixture(tempDir, 'BranchMerge', BRANCH_MERGE_JASMIN);
    const plain = methodBody(source, 'plain');

    t.ok(plain.length > 0, 'the control method is emitted');
    t.match(plain, /account\(/, 'the shared block is reached in the control');
    t.notOk(/play\(/.test(plain), 'the control does not gain an unrelated call');

    t.end();
  });
});
