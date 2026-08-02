'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
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

const STATIC_FIELD_POST_INCREMENT_ARRAY_STORE = `.version 52 0
.class public super StaticFieldPostIncrementArrayStore
.super java/lang/Object

.field public static INDEX I
.field public static VALUES [I

.method public static fill : ()V
    .code stack 3 locals 0
L0: getstatic Field StaticFieldPostIncrementArrayStore VALUES [I
L3: getstatic Field StaticFieldPostIncrementArrayStore INDEX I
L6: dup
L7: iconst_1
L8: iadd
L9: putstatic Field StaticFieldPostIncrementArrayStore INDEX I
L12: bipush 7
L14: iastore
L15: return
    .end code
.end method
.end class
`;

const ARRAY_ELEMENT_POST_INCREMENT_INDEX = `.version 52 0
.class public super ArrayElementPostIncrementIndex
.super java/lang/Object

.method public static add : ([[I[III)V
    .code stack 5 locals 4
        aload_0
        iload_2
        aaload
        aload_1
        iload_2
        dup2
        iaload
        dup_x2
        iconst_1
        iadd
        iastore
        iload_3
        iastore
        return
    .end code
.end method
.end class
`;

const ARRAY_ELEMENT_PREDECREMENT_INDEX = `.version 52 0
.class public super ArrayElementPredecrementIndex
.super java/lang/Object

.method public static put : ([[I[III)V
    .code stack 5 locals 4
        aload_0
        iload_2
        aaload
        aload_1
        iload_2
        dup2
        iaload
        iconst_1
        isub
        dup_x2
        iastore
        iload_3
        iastore
        return
    .end code
.end method
.end class
`;

const INLINE_REFERENCE_ARRAY_ARGUMENT = `.version 52 0
.class public super InlineReferenceArrayArgument
.super java/lang/Object

.method public static consume : ([Ljava/lang/String;)Ljava/lang/String;
    .code stack 2 locals 1
L0: aload_0
L1: iconst_0
L2: aaload
L3: areturn
    .end code
.end method

.method public static call : (Ljava/lang/String;)Ljava/lang/String;
    .code stack 4 locals 1
L10: iconst_1
L11: anewarray java/lang/String
L14: dup
L15: iconst_0
L16: aload_0
L17: aastore
L18: invokestatic Method InlineReferenceArrayArgument consume ([Ljava/lang/String;)Ljava/lang/String;
L21: areturn
    .end code
.end method
.end class
`;

const BRANCHED_REFERENCE_ARRAY_ARGUMENT = `.version 52 0
.class public super BranchedReferenceArrayArgument
.super java/lang/Object

.method public static consume : ([Ljava/lang/String;)Ljava/lang/String;
    .code stack 2 locals 1
L0: aload_0
L1: iconst_0
L2: aaload
L3: areturn
    .end code
.end method

.method public static call : (Z)Ljava/lang/String;
    .code stack 4 locals 1
L10: iconst_1
L11: anewarray java/lang/String
L14: dup
L15: iconst_0
L16: iload_0
L17: ifeq L26
L20: goto L24
L23: athrow
L24: ldc "enabled"
L25: goto L28
L27: athrow
L26: ldc "disabled"
L28: aastore
L29: invokestatic Method BranchedReferenceArrayArgument consume ([Ljava/lang/String;)Ljava/lang/String;
L32: areturn
    .end code
.end method
.end class
`;

const INLINE_PRIMITIVE_ARRAY_STORE = `.version 52 0
.class public super InlinePrimitiveArrayStore
.super java/lang/Object

.field public static TABLE [[I

.method public static initialize : ()V
    .code stack 6 locals 0
L0: getstatic Field InlinePrimitiveArrayStore TABLE [[I
L3: iconst_1
L4: iconst_3
L5: newarray int
L7: dup
L8: iconst_0
L9: iconst_0
L10: iastore
L11: dup
L12: iconst_1
L13: ldc 16777215
L15: iastore
L16: dup
L17: iconst_2
L18: iconst_1
L19: iastore
L20: aastore
L21: return
    .end code
.end method
.end class
`;

const DUP_X2_SHARED_DYNAMIC_ARRAY = `.version 52 0
.class public super DupX2SharedDynamicArray
.super java/lang/Object

.field public static TABLE [[B

.method public static initialize : (I)[B
    .code stack 4 locals 2
L0: getstatic Field DupX2SharedDynamicArray TABLE [[B
L3: iconst_0
L4: iload_0
L5: newarray byte
L7: dup_x2
L8: aastore
L9: astore_1
L10: aload_1
L11: areturn
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

const NULL_THROW = `.version 52 0
.class public super NullThrow
.super java/lang/Object

.method public static fail : ()V
    .code stack 1 locals 0
L0: aconst_null
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

const LOOP_CARRIED_OPERAND = `.version 52 0
.class public super CarrierLoop
.super java/lang/Object

.method public static sum : (I)I
    .code stack 3 locals 2
L0: bipush 5
L2: iconst_0
L3: istore_1
L4: iload_1
L5: iload_0
L6: if_icmpge L15
L9: iload_1
L10: iadd
L11: iinc 1 1
L14: goto L4
L15: ireturn
    .end code
.end method
.end class
`;

const MULTI_VALUE_STACK_BACKEDGE = `.version 52 0
.class public super MultiValueBackedge
.super java/lang/Object

.method public static fill : (I[IZ)V
    .code stack 4 locals 4
        iconst_0
        istore_3
        iload_3
        iload_0
Lcondition:
        if_icmpge Lreturn
        aload_1
        iload_3
        iconst_1
        iastore
        iload_0
        iload_3
        iload_2
        ifne Lcondition
        if_icmplt Lextra
        goto Lincrement
Lextra:
        aload_1
        iload_3
        iconst_2
        iastore
Lincrement:
        iinc 3 1
        iload_3
        iload_0
        goto Lcondition
Lreturn:
        return
    .end code
.end method
.end class
`;

function decompileFixture(tempDir, name, source) {
  const classFile = path.join(tempDir, `${name}.class`);
  assembleJasminSource(source, classFile);
  return decompileClassFile(classFile);
}

test('structured operand joins coalesce redundant edge carriers', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-edge-carrier-'));
  try {
    const source = decompileFixture(tempDir, 'CarrierLoop', LOOP_CARRIED_OPERAND);
    t.notOk(source.includes('stackOut_'),
      'loop edges feed typed stackIn joins without an intermediate stackOut local');
    t.match(source, /stackIn_\d+_0 = (?:5|incrementValue\$\d+);/,
      'direct edge assignment retains the loop-carried operand');

    fs.writeFileSync(path.join(tempDir, 'CarrierLoop.java'), source);
    fs.writeFileSync(path.join(tempDir, 'CarrierLoopRunner.java'),
      'public class CarrierLoopRunner { public static void main(String[] a) {' +
      'System.out.print(CarrierLoop.sum(0) + "," + CarrierLoop.sum(10)); } }');
    execFileSync('javac', ['-g:none', '-d', tempDir,
      path.join(tempDir, 'CarrierLoop.java'), path.join(tempDir, 'CarrierLoopRunner.java')]);
    t.equal(execFileSync('java', ['-cp', tempDir, 'CarrierLoopRunner'], { encoding: 'utf8' }),
      '5,50', 'javac output preserves the loop-carried JVM operand values');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  t.end();
});

test('multi-value operand-stack backedges retain their distinct CFG edges', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-multi-stack-backedge-'));
  try {
    const source = decompileFixture(
      tempDir,
      'MultiValueBackedge',
      MULTI_VALUE_STACK_BACKEDGE,
    );
    t.match(source, /while \(true\) \{\s*switch \(statePc\)/,
      'opaque comparison carriers use the exact CFG state machine');

    fs.writeFileSync(path.join(tempDir, 'MultiValueBackedge.java'), source);
    fs.writeFileSync(path.join(tempDir, 'MultiValueBackedgeRunner.java'),
      'import java.util.Arrays; public class MultiValueBackedgeRunner {' +
      'public static void main(String[] a) { int[] out = new int[4];' +
      'MultiValueBackedge.fill(4, out, false); System.out.print(Arrays.toString(out)); }}');
    execFileSync('javac', ['-g:none', '-d', tempDir,
      path.join(tempDir, 'MultiValueBackedge.java'),
      path.join(tempDir, 'MultiValueBackedgeRunner.java')]);
    t.equal(execFileSync('java', ['-cp', tempDir, 'MultiValueBackedgeRunner'],
      { encoding: 'utf8', timeout: 5000 }), '[1, 1, 1, 1]',
    'the recompiled loop increments and terminates with the original result');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  t.end();
});

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

test('putstatic snapshots an unqualified field index loaded before its update', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-static-field-order-'));
  try {
    const source = decompileFixture(
      tempDir,
      'StaticFieldPostIncrementArrayStore',
      STATIC_FIELD_POST_INCREMENT_ARRAY_STORE,
    );

    t.match(source,
      /int fieldTemp\$\d+ = field_INDEX;\s*field_INDEX = field_INDEX \+ 1;\s*field_VALUES\[fieldTemp\$\d+\] = 7;/,
      'array store retains the field index captured before putstatic');
    t.notOk(/field_INDEX = field_INDEX \+ 1;\s*field_VALUES\[field_INDEX\]/.test(source),
      'array store does not reread the incremented static field');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  t.end();
});

test('dup_x2 snapshots an array element used after its increment', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-array-element-order-'));
  try {
    const source = decompileFixture(
      tempDir,
      'ArrayElementPostIncrementIndex',
      ARRAY_ELEMENT_POST_INCREMENT_INDEX,
    );

    t.match(source,
      /int (dupTemp\$\d+) = param1\[param2\];\s*int\[\] (arrayValue\$\d+) = param0\[param2\];\s*param1\[param2\] = \1 \+ 1;\s*\2\[\1\] = param3;/,
      'the outer store uses the array element value captured before iastore');
    t.notOk(/param1\[param2\] = param1\[param2\] \+ 1;\s*param0\[param2\]\[param1\[param2\]\]/.test(source),
      'the later index does not reread the incremented counter');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  t.end();
});

test('dup_x2 reuses the exact predecremented array index', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-array-predecrement-order-'));
  try {
    const source = decompileFixture(
      tempDir,
      'ArrayElementPredecrementIndex',
      ARRAY_ELEMENT_PREDECREMENT_INDEX,
    );

    t.match(source,
      /int (dupTemp\$\d+) = param1\[param2\] - 1;\s*int\[\] (arrayValue\$\d+) = param0\[param2\];\s*param1\[param2\] = \1;\s*\2\[\1\] = param3;/,
      'the destination uses the same decremented count stored in the counter array');
    t.notOk(/param1\[param2\] = param1\[param2\] - 1;\s*param0\[param2\]\[param1\[param2\] - 1\]/.test(source),
      'the destination does not decrement the already-updated count twice');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  t.end();
});

test('dup-filled reference arrays retain their elements when passed directly to a call', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-inline-array-argument-'));
  try {
    const source = decompileFixture(tempDir, 'InlineReferenceArrayArgument',
      INLINE_REFERENCE_ARRAY_ARGUMENT);

    t.match(source, /consume\(new String\[\]\{param0\}\)/,
      'direct call argument includes the value recorded by aastore');
    t.notOk(/consume\(new String\[1\]\)/.test(source),
      'direct call argument is not emitted as a null-filled allocation');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  t.end();
});

test('dup-filled reference arrays retain identity across a conditional value branch', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-branched-array-argument-'));
  try {
    const source = decompileFixture(tempDir, 'BranchedReferenceArrayArgument',
      BRANCHED_REFERENCE_ARRAY_ARGUMENT);
    const allocations = source.match(/new String(?:\[1\]|\[\]\{)/g) || [];

    t.equal(allocations.length, 1, 'the duplicated operand stack reference is allocated once');
    t.notOk(
      /String\[] ([A-Za-z_$][A-Za-z0-9_$]*) = new String\[1\];[\s\S]*String\[] [A-Za-z_$][A-Za-z0-9_$]* = new String\[1\]/.test(source),
      'the conditional store and following call do not receive separate allocations');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  t.end();
});

test('dup-filled primitive arrays retain elements when stored into an outer array', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-inline-primitive-array-store-'));
  try {
    const source = decompileFixture(tempDir, 'InlinePrimitiveArrayStore',
      INLINE_PRIMITIVE_ARRAY_STORE);

    t.match(source, /field_TABLE\[1\] = new int\[\]\{0, 16777215, 1\};/,
      'outer aastore renders the primitive array initializer recorded by iastore');
    t.notOk(/field_TABLE\[1\] = new int\[3\];/.test(source),
      'outer aastore does not discard primitive array elements');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  t.end();
});

test('dup_x2 preserves one dynamic array allocation across aastore and astore', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-dup-x2-shared-array-'));
  try {
    const source = decompileFixture(tempDir, 'DupX2SharedDynamicArray',
      DUP_X2_SHARED_DYNAMIC_ARRAY);
    const allocations = source.match(/new byte\[param0\]/g) || [];

    t.equal(allocations.length, 1, 'dynamic byte array is allocated exactly once');
    t.match(source, /byte\[] ([A-Za-z_$][A-Za-z0-9_$]*) = new byte\[param0\];\s*field_TABLE\[0\] = \1;/,
      'outer array store consumes the shared allocation temp');
    t.notOk(/field_TABLE\[0\] = new byte\[param0\];[\s\S]*new byte\[param0\]/.test(source),
      'following local store does not allocate a different array');
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

test('null athrow preserves the direct throw site', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-null-throw-'));
  try {
    const source = decompileFixture(tempDir, 'NullThrow', NULL_THROW);
    t.match(source, /static void fail\(\) \{\s*throw null;\s*}/, 'null is thrown directly');
    t.notOk(/\$cfr\$sneakyThrow/.test(source), 'no stack-trace-changing helper is emitted');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  t.end();
});
