'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('tape');
const { assembleJasminSource } = require('../src/utils/jasminAssembly');
const { decompileClassFile } = require('../src/decompiler/cfr');

const POST_INCREMENT_ARRAY_STORE = `.version 52 0
.class public super PostIncrementArrayStore
.super java/lang/Object

.method public static fill : ([BIB)V
    .code stack 3 locals 3
L0: aload_0
L1: iload_1
L2: iinc 1 1
L5: iload_2
L6: bastore
L7: return
    .end code
.end method
.end class
`;

const REUSED_REFERENCE_SLOT = `.version 52 0
.class public super ReusedReferenceSlot
.super java/lang/Object

.field public static THREAD Ljava/lang/Thread;

.method public static use : ()I
    .code stack 1 locals 1
L0: getstatic Field ReusedReferenceSlot THREAD Ljava/lang/Thread;
L3: astore_0
L4: aload_0
L5: invokevirtual Method java/lang/Thread start ()V
L8: ldc "value"
L10: astore_0
L11: aload_0
L12: invokevirtual Method java/lang/String length ()I
L15: ireturn
    .end code
.end method
.end class
`;

const BROAD_RETHROW = `.version 52 0
.class public super BroadRethrow
.super java/lang/Object

.method public static rethrow : (Ljava/lang/Throwable;)V
    .code stack 1 locals 1
L0: aload_0
L1: athrow
    .end code
.end method
.end class
`;

const REFERENCE_BRANCH_JOIN = `.version 52 0
.class public super ReferenceBranchJoin
.super java/lang/Object

.method public static wrap : (Ljava/lang/RuntimeException;Z)Ljava/lang/RuntimeException;
    .code stack 3 locals 3
L0: iload_1
L1: ifeq L9
L4: aload_0
L5: astore_2
L6: goto L17
L9: new java/lang/RuntimeException
L12: dup
L13: invokespecial Method java/lang/RuntimeException <init> ()V
L16: astore_2
L17: aload_2
L18: areturn
    .end code
.end method
.end class
`;

function decompileFixture(tempDir, name, source) {
  const classFile = path.join(tempDir, `${name}.class`);
  assembleJasminSource(source, classFile);
  return decompileClassFile(classFile);
}

test('iinc snapshots operand-stack values loaded before the increment', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-stack-order-'));
  try {
    const source = decompileFixture(tempDir, 'PostIncrementArrayStore', POST_INCREMENT_ARRAY_STORE);

    t.match(source, /int incrementValue\$\d+ = param1;\s*param1\+\+;\s*param0\[incrementValue\$\d+\] = param2;/,
      'array index uses the value captured before iinc');
    t.notOk(/param1\+\+;\s*param0\[param1\]/.test(source),
      'array store does not reread the incremented local');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  t.end();
});

test('reference locals reused with incompatible descriptor types stay separate', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-reference-slot-'));
  try {
    const source = decompileFixture(tempDir, 'ReusedReferenceSlot', REUSED_REFERENCE_SLOT);
    t.match(source, /Thread \w+ = field_THREAD;[\s\S]*?\.start\(\);/, 'Thread value retains its descriptor type');
    t.match(source, /String \w+ = "value";[\s\S]*?\.length\(\)/, 'String value uses a separate local binding');
    t.notOk(/\(String\) \(Object\).*THREAD/.test(source), 'descriptor-proven Thread is not cast to String');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  t.end();
});

test('reference local written by both branches is returned from the joined binding', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-reference-join-'));
  try {
    const source = decompileFixture(tempDir, 'ReferenceBranchJoin', REFERENCE_BRANCH_JOIN);
    const assignments = [...source.matchAll(/(var\d+(?:_ref\d*)?) = /g)].map((match) => match[1]);
    const returned = /return (var\d+(?:_ref\d*)?);/.exec(source);
    t.ok(returned, 'joined reference local is returned');
    t.ok(assignments.length >= 2, 'both branches assign the joined local');
    t.ok(returned && assignments.every((name) => name === returned[1]), 'both branches and return use one binding');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  t.end();
});

test('broad athrow preserves the original Throwable without a runtime downcast', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-broad-rethrow-'));
  try {
    const source = decompileFixture(tempDir, 'BroadRethrow', BROAD_RETHROW);
    t.match(source, /throw BroadRethrow\.<RuntimeException>\$cfr\$sneakyThrow\(param0\);/,
      'athrow uses type-erasure rethrow');
    t.match(source, /private static <T extends Throwable> RuntimeException \$cfr\$sneakyThrow/,
      'class contains the generic rethrow helper');
    t.notOk(/throw \(RuntimeException\)/.test(source), 'no unconditional RuntimeException cast is emitted');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  t.end();
});
