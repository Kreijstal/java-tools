'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('tape');
const { assembleJasminSource } = require('../src/utils/jasminAssembly');
const { decompileClassFile } = require('../src/decompiler/cfr');

const DUP_CALL_RESULT = `.version 52 0
.class public super DupCall
.super java/lang/Object

.field public static A J
.field public static B J
.field public static C I
.field public static D I

.method public static native next : ()J
.end method

.method public static native nextInt : ()I
.end method

.method public static storeLong : ()V
    .code stack 4 locals 0
L0: invokestatic Method DupCall next ()J
L3: dup2
L4: putstatic Field DupCall A J
L7: putstatic Field DupCall B J
L10: return
    .end code
.end method

.method public static storeInt : ()V
    .code stack 2 locals 0
L0: invokestatic Method DupCall nextInt ()I
L3: dup
L4: putstatic Field DupCall C I
L7: putstatic Field DupCall D I
L10: return
    .end code
.end method
.end class
`;

const DUP_CONSTRUCTOR_PATTERN = `.version 52 0
.class public super DupNew
.super java/lang/Object

.field public static OUT Ljava/lang/Object;

.method public static make : ()Ljava/lang/Object;
    .code stack 3 locals 0
L0: new java/lang/Object
L3: dup
L4: invokespecial Method java/lang/Object <init> ()V
L7: dup
L8: putstatic Field DupNew OUT Ljava/lang/Object;
L11: areturn
    .end code
.end method
.end class
`;

function decompileFixture(tempDir, name, source) {
  const classFile = path.join(tempDir, `${name}.class`);
  assembleJasminSource(source, classFile);
  return decompileClassFile(classFile);
}

test('dup2 of a category-2 call result evaluates the call once', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-dup-side-effect-'));
  try {
    const source = decompileFixture(tempDir, 'DupCall', DUP_CALL_RESULT);
    const longCalls = (source.match(/DupCall\.next\(\)/g) || []).length;
    t.equal(longCalls, 1, 'long-returning call is rendered exactly once');
    const intCalls = (source.match(/DupCall\.nextInt\(\)/g) || []).length;
    t.equal(intCalls, 1, 'int-returning call is rendered exactly once');
    const longTemp = /long (\w+\$\d+) = DupCall\.next\(\);/.exec(source);
    t.ok(longTemp, 'call result is spilled to a typed local');
    if (longTemp) {
      t.match(source, new RegExp(`field_A = ${longTemp[1].replace(/\$/g, '\\$')};`), 'first consumer reads the spill');
      t.match(source, new RegExp(`field_B = ${longTemp[1].replace(/\$/g, '\\$')};`), 'second consumer reads the spill');
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  t.end();
});

test('new/dup/<init> constructor pattern still allocates exactly once', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-dup-new-'));
  try {
    const source = decompileFixture(tempDir, 'DupNew', DUP_CONSTRUCTOR_PATTERN);
    const allocations = (source.match(/new Object\(\)/g) || []).length;
    t.equal(allocations, 1, 'constructed object is allocated exactly once');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  t.end();
});
