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

const DUP_ARRAY_PATTERNS = `.version 52 0
.class public super DupArray
.super java/lang/Object

.method public static native consume : ([Ljava/lang/String;)V
.end method

.field public values [I

.method public shareLocalAndField : (I)[I
    .code stack 3 locals 3
L0: aload_0
L1: iload_1
L2: iconst_2
L3: imul
L4: newarray int
L6: dup
L7: astore_2
L8: putfield Field DupArray values [I
L11: aload_2
L12: areturn
    .end code
.end method

.method public shareFieldAndReturn : (I)[I
    .code stack 3 locals 2
L20: aload_0
L21: iload_1
L22: newarray int
L24: dup_x1
L25: putfield Field DupArray values [I
L28: areturn
    .end code
.end method

.method public static shareDynamic : ([[BI)[B
    .code stack 4 locals 3
L0: aload_0
L1: iconst_0
L2: iload_1
L3: newarray byte
L5: dup_x2
L6: aastore
L7: astore_2
L8: aload_2
L9: iconst_0
L10: bipush 7
L12: bastore
L13: aload_2
L14: areturn
    .end code
.end method

.method public static passReferenceLiteral : ()V
    .code stack 4 locals 0
L20: iconst_2
L21: anewarray java/lang/String
L24: dup
L25: iconst_0
L26: ldc "left"
L28: aastore
L29: dup
L30: iconst_1
L31: ldc "right"
L33: aastore
L34: invokestatic Method DupArray consume ([Ljava/lang/String;)V
L37: return
    .end code
.end method

.method public static nestedPrimitiveLiteral : ()[[I
    .code stack 6 locals 0
L40: iconst_1
L41: anewarray [I
L44: dup
L45: iconst_0
L46: iconst_3
L47: newarray int
L49: dup
L50: iconst_0
L51: iconst_0
L52: iastore
L53: dup
L54: iconst_1
L55: ldc 16777215
L57: iastore
L58: dup
L59: iconst_2
L60: iconst_1
L61: iastore
L62: aastore
L63: areturn
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

test('dup array patterns preserve allocation identity and recorded elements', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-dup-array-'));
  try {
    const source = decompileFixture(tempDir, 'DupArray', DUP_ARRAY_PATTERNS);
    const dynamicMethod = /public static byte\[\] shareDynamic[\s\S]*?\n    }/.exec(source);
    t.ok(dynamicMethod, 'dynamic shared-array method is emitted');
    const dynamicSource = dynamicMethod ? dynamicMethod[0] : source;
    t.equal((dynamicSource.match(/new byte\[param1\]/g) || []).length, 1,
      'dynamic byte array is allocated exactly once');
    const spill = /byte\[\] (\w+\$\d+) = new byte\[param1\];/.exec(dynamicSource);
    t.ok(spill, 'dynamic allocation is spilled to a shared local');
    if (spill) {
      const escaped = spill[1].replace(/\$/g, '\\$');
      t.match(dynamicSource, new RegExp(`param0\\[0\\] = ${escaped};`),
        'outer array stores the shared allocation');
      t.match(dynamicSource, new RegExp(`byte\\[\\] var2 = ${escaped};`),
        'local stores the same allocation');
    }
    const localAndFieldMethod = /public int\[\] shareLocalAndField[\s\S]*?\n    }/.exec(source);
    t.ok(localAndFieldMethod, 'local-and-field shared-array method is emitted');
    const localAndFieldSource = localAndFieldMethod ? localAndFieldMethod[0] : source;
    t.equal((localAndFieldSource.match(/new int\[/g) || []).length, 1,
      'local and field share one int-array allocation');
    const fieldSpill = /int\[\] (\w+\$\d+) = new int\[param0 \* 2\];/.exec(localAndFieldSource);
    t.ok(fieldSpill, 'local-and-field allocation is spilled once');
    if (fieldSpill) {
      const escaped = fieldSpill[1].replace(/\$/g, '\\$');
      t.match(localAndFieldSource, new RegExp(`int\\[\\] var2 = ${escaped};`),
        'local stores the shared int array');
      t.match(localAndFieldSource, new RegExp(`field_values = ${escaped};`),
        'field stores the shared int array');
    }
    const fieldAndReturnMethod = /public int\[\] shareFieldAndReturn[\s\S]*?\n    }/.exec(source);
    t.ok(fieldAndReturnMethod, 'dup_x1 field-and-return shared-array method is emitted');
    const fieldAndReturnSource = fieldAndReturnMethod ? fieldAndReturnMethod[0] : source;
    t.equal((fieldAndReturnSource.match(/new int\[/g) || []).length, 1,
      'dup_x1 preserves one allocation for the field and return value');
    const returnSpill = /int\[\] (\w+\$\d+) = new int\[param0\];/.exec(fieldAndReturnSource);
    t.ok(returnSpill, 'dup_x1 allocation is spilled once');
    if (returnSpill) {
      const escaped = returnSpill[1].replace(/\$/g, '\\$');
      t.match(fieldAndReturnSource, new RegExp(`field_values = ${escaped};`),
        'field stores the shared dup_x1 array');
      t.match(fieldAndReturnSource, new RegExp(`return ${escaped};`),
        'method returns the shared dup_x1 array');
    }
    t.match(source, /DupArray\.consume\(new String\[\]\{"left", "right"\}\);/,
      'inline reference-array call retains its elements');
    t.match(source, /return new int\[\]\[\]\{new int\[\]\{0, 16777215, 1\}\};/,
      'primitive inner-array values survive the outer array store');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  t.end();
});
