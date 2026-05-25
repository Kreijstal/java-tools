'use strict';

const test = require('tape');
const frontend = require('../src/java-frontend');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { JVM } = require('../src/core/jvm');
const { CONSTANTS_ICONST_PREFIX, expectedOutputForClass } = require('./fixtures/runtimeExpectations');

const SOURCE = `
public class Example {
  public static void main(String[] args) {
    int value = 3;
    System.out.println(value);
  }
}
`;

const HELLO_SOURCE = `
public class Hello {
  public static void main(String[] args) {
    System.out.println("Hello, World!");
  }
}
`;

const ARRAY_SMOKE_SOURCE = `
public class ArraySmoke {
  public static void main(String[] args) {
    int[] a = new int[2];
    a[0] = 7;
    System.out.println(a[0]);
  }
}
`;

const REF_ARRAY_SMOKE_SOURCE = `
public class RefArraySmoke {
  public static void main(String[] args) {
    String[] s = new String[2];
    s[0] = "x";
    System.out.println(s[0]);
  }
}
`;

const ARRAY_INITIALIZER_SMOKE_SOURCE = `
public class ArrayInitializerSmoke {
  public static void main(String[] args) {
    byte[] bytes = {(byte)0xf3, (byte)0x48, (byte)0xcd};
    int[] ints = new int[]{1, 2, 3};
    Object obj = new int[]{4, 5};
    int[] nullable = null;
    System.out.println(bytes[0]);
    System.out.println(bytes[1]);
    System.out.println(ints[2]);
    System.out.println(obj instanceof Object);
    System.out.println(nullable == null);
  }
}
`;

const NARROW_PRIMITIVE_SMOKE_SOURCE = `
public class NarrowPrimitiveSmoke {
  public static void main(String[] args) {
    byte b = (byte) 130;
    short s = (short) 32000;
    char c = 'A';
    System.out.println(b);
    System.out.println(s);
    System.out.println(c);
  }
}
`;

const REF_CAST_SMOKE_SOURCE = `
public class RefCastSmoke {
  public static void main(String[] args) {
    Object obj = "Hello";
    String str = (String) obj;
    System.out.println(str);
    Object nullObj = null;
    String nullStr = (String) nullObj;
    System.out.println(nullStr);
  }
}
`;

const WRAPPER_TYPES_SMOKE_SOURCE = `
public class WrapperTypesSmoke {
  public static void main(String[] args) {
    Boolean bool = true;
    boolean z = bool;
    Byte by = (byte) 130;
    byte b = by;
    Short sh = (short) 32000;
    short s = sh;
    Integer i = 42;
    int j = i;
    Long l = 12345678901L;
    long m = l;
    Float f = 1.5f;
    float g = f;
    Double d = 2.5;
    double e = d;
    Character c = 'A';
    char h = c;
    System.out.println("z=" + z);
    System.out.println("b=" + b);
    System.out.println("s=" + s);
    System.out.println("j=" + j);
    System.out.println("m=" + m);
    System.out.println("g=" + g);
    System.out.println("e=" + e);
    System.out.println("h=" + h);
  }
}
`;

const REASSIGNMENT_CONVERSION_SMOKE_SOURCE = `
public class ReassignmentConversionSmoke {
  public static void main(String[] args) {
    int i = 42;
    long l = i;
    float f = i;
    double d = i;
    l = 12345678901L;
    i = (int) l;
    f = l;
    d = l;
    f = 3.14f;
    i = (int) f;
    l = (long) f;
    d = f;
    d = 2.718;
    i = (int) d;
    l = (long) d;
    f = (float) d;
    System.out.println("done");
  }
}
`;

const STRING_EXTRA_SMOKE_SOURCE = `
public class StringExtraSmoke {
  public static void main(String[] args) {
    String s = new String("abc");
    String interned = s.intern();
    String num = Integer.toString(123);
    byte[] bytes = s.getBytes();
    System.out.println(interned);
    System.out.println(num);
    System.out.println(bytes.length);
  }
}
`;

const STRING_COMPARE_SMOKE_SOURCE = `
public class StringCompareSmoke {
  public static void main(String[] args) {
    String a = "x";
    String b = "x";
    String c = new String("x");
    System.out.println("lit eq: " + (a == b));
    System.out.println("new eq: " + (a == c));
    System.out.println("neq: " + (a != c));
  }
}
`;

const STRING_CONCAT_SEMANTICS_SMOKE_SOURCE = `
public class StringConcatSemanticsSmoke {
  public static void main(String[] args) {
    String folded1 = "hel" + "lo";
    String folded2 = "he" + "llo";
    String prefix = "hel";
    String runtime1 = prefix + "lo";
    String runtime2 = prefix + "lo";
    System.out.println(folded1 == folded2);
    System.out.println(folded1 == "hello");
    System.out.println(runtime1 == runtime2);
    System.out.println(runtime1.intern() == folded1);
    System.out.println("n=" + 3);
    System.out.println("b=" + true);
    System.out.println("z=" + null);
  }
}
`;

const CLASS_INSTANCE_SMOKE_SOURCE = `
public class ClassInstanceSmoke {
  public static void main(String[] args) {
    Class<?> intClass = int.class;
    Class<?> stringClass = String.class;
    Class<?> arrayClass = int[].class;
    System.out.println(intClass.getName());
    System.out.println(stringClass.getName());
    System.out.println(arrayClass.getName());
    Object s = "x";
    System.out.println(s instanceof String);
    System.out.println(s instanceof Object);
  }
}
`;

const ARRAY_TYPE_SMOKE_SOURCE = `
public class ArrayTypeSmoke {
  public static void main(String[] args) {
    int[] a = {1, 2, 3};
    System.out.println(a[1]);
    int[][] m = new int[2][3];
    m[0][1] = 7;
    System.out.println(m[0][1]);
    int[][] jag = new int[2][];
    jag[0] = new int[]{4, 5};
    System.out.println(jag[0][1]);
    String[][] ss = new String[1][];
    ss[0] = new String[]{"x", "y"};
    System.out.println(ss[0][0]);
  }
}
`;

const GENERIC_ERASURE_SMOKE_SOURCE = `
public class GenericErasureSmoke {
  public static <T> T id(T value) {
    return value;
  }

  public static <T extends Comparable<T>> T first(T value) {
    return value;
  }

  public static void main(String[] args) {
    java.util.List<String> list = new java.util.ArrayList<String>();
    Object box = id("generic");
    Comparable c = first("bound");
    System.out.println(box);
    System.out.println(c);
  }
}
`;

const CLASS_ATTRIBUTES_SMOKE_SOURCE = `
public class ClassAttributesSmoke<T> {
  T value;
  public T id(T value) {
    return value;
  }
}
`;

const IF_SMOKE_SOURCE = `
public class IfSmoke {
  public static void main(String[] args) {
    int a = 3;
    int b = 5;
    if (a < b) System.out.println("int lt");
    if (a > b) System.out.println("bad");
    if (a <= 3) {
      System.out.println("int le");
    } else {
      System.out.println("bad");
    }
    long l = 10L;
    long m = 9L;
    if (l >= m) System.out.println("long ge");
    double d = 2.0;
    double e = 3.0;
    if (d != e) System.out.println("double ne");
    boolean ok = true;
    if (ok) System.out.println("bool");
  }
}
`;

const FOR_SMOKE_SOURCE = `
public class ForSmoke {
  public static void main(String[] args) {
    int sum = 0;
    for (int i = 1; i <= 4; i++) {
      sum = sum + i;
    }
    System.out.println(sum);
    for (int j = 3; j > 0; j--) {
      System.out.println(j);
    }
  }
}
`;

const WHILE_SMOKE_SOURCE = `
public class WhileSmoke {
  public static void main(String[] args) {
    int i = 0;
    int sum = 0;
    while (i < 5) {
      sum = sum + i;
      i++;
    }
    System.out.println(sum);
    int j = 3;
    while (j > 0) {
      System.out.println(j);
      j--;
    }
  }
}
`;

const DO_WHILE_SMOKE_SOURCE = `
public class DoWhileSmoke {
  public static void main(String[] args) {
    int i = 0;
    int sum = 0;
    do {
      sum = sum + i;
      i++;
    } while (i < 5);
    System.out.println(sum);
    int j = 0;
    do {
      System.out.println(j);
      j--;
    } while (j > 0);
  }
}
`;

const METHOD_CALL_SMOKE_SOURCE = `
public class MethodCallSmoke {
  int base;

  public MethodCallSmoke(int base) {
    this.base = base;
  }

  public int add(int value) {
    return base + value;
  }

  public int twice(int value) {
    int first = add(value);
    int second = add(value);
    return first + second;
  }

  public void printTwice() {
    System.out.println(twice(3));
  }

  public static int plus(int left, int right) {
    return left + right;
  }

  public static int callStatic(int value) {
    return plus(value, 1);
  }

  public static void main(String[] args) {
    MethodCallSmoke smoke = new MethodCallSmoke(10);
    System.out.println(smoke.add(5));
    smoke.printTwice();
    System.out.println(MethodCallSmoke.plus(2, 4));
    System.out.println(callStatic(7));
  }
}
`;

const SUPER_SMOKE_SOURCE = `
class SuperBaseSmoke {
  int base;

  public SuperBaseSmoke(int base) {
    this.base = base;
  }

  public int value() {
    return base;
  }
}

public class SuperSmoke extends SuperBaseSmoke {
  public SuperSmoke() {
    super(7);
  }

  public int value() {
    return super.value() + 1;
  }

  public static void main(String[] args) {
    SuperSmoke smoke = new SuperSmoke();
    System.out.println(smoke.value());
  }
}
`;

const CONSTRUCTOR_SMOKE_SOURCE = `
class ConstructorBaseSmoke {
  int base;

  public ConstructorBaseSmoke() {
    this(2);
  }

  public ConstructorBaseSmoke(int base) {
    this.base = base;
  }

  public int value() {
    return base;
  }
}

public class ConstructorSmoke extends ConstructorBaseSmoke {
  int extra;

  public ConstructorSmoke() {
    this(3);
  }

  public ConstructorSmoke(int extra) {
    super(4);
    this.extra = extra;
  }

  public int total() {
    return super.value() + extra;
  }

  public static void main(String[] args) {
    ConstructorBaseSmoke base = new ConstructorBaseSmoke();
    ConstructorSmoke smoke = new ConstructorSmoke();
    System.out.println(base.value());
    System.out.println(smoke.total());
  }
}
`;

const SWITCH_SMOKE_SOURCE = `
public class SwitchSmoke {
  public static void test(int value) {
    switch (value) {
      case 1:
        System.out.println("one");
        break;
      case 2:
      case 3:
        System.out.println("two-three");
        break;
      case 4:
        System.out.println("fall");
      case 5:
        System.out.println("through");
        break;
      default:
        System.out.println("other");
    }
  }

  public static void main(String[] args) {
    test(1);
    test(2);
    test(4);
    test(9);
  }
}
`;

const UNARY_SMOKE_SOURCE = `
public class UnarySmoke {
  public static void main(String[] args) {
    int i = 5;
    long l = 10L;
    boolean flag = false;
    System.out.println(!flag);
    System.out.println(~i);
    System.out.println(~l);
    System.out.println(-i);
    if (!flag) {
      System.out.println("not");
    }
  }
}
`;

const TRY_CATCH_SMOKE_SOURCE = `
public class TryCatchSmoke {
  public static void main(String[] args) {
    try {
      throw new IllegalArgumentException();
    } catch (IllegalArgumentException e) {
      System.out.println("caught");
    }
    System.out.println("after");
  }
}
`;

const TRY_CATCH_RETURN_SMOKE_SOURCE = `
public class TryCatchReturnSmoke {
  public static int safeDivide(int a, int b) {
    try {
      return a / b;
    } catch (ArithmeticException ex) {
      return Integer.MIN_VALUE;
    }
  }

  public static void main(String[] args) {
    System.out.println(safeDivide(10, 2));
    System.out.println(safeDivide(10, 0));
  }
}
`;

test('Java IR document lowers from AST, validates, and serializes', (t) => {
  const astDocument = frontend.parseJava(SOURCE, { sourceLevel: 8 });
  const javaIr = frontend.lowerAstToJavaIr(astDocument);

  t.equal(javaIr.schema, frontend.JAVA_IR_SCHEMA_ID, 'Java IR schema is set');
  t.equal(javaIr.classes.length, 1, 'one class is lowered');
  t.equal(javaIr.classes[0].internalName, 'Example', 'class internal name is lowered');
  t.equal(javaIr.classes[0].methods[0].descriptor, '([Ljava/lang/String;)V', 'method descriptor is lowered');
  t.equal(javaIr.classes[0].methods[0].blocks[0].ops[0].op, 'declareLocal', 'local declaration is represented as an IR op');
  t.doesNotThrow(() => frontend.validateJavaIrDocument(javaIr), 'Java IR validates');

  const restored = frontend.deserializeJavaIr(frontend.serializeJavaIr(javaIr));
  t.deepEqual(restored, frontend.toJavaIrJson(javaIr), 'Java IR serialization is stable');
  t.end();
});

test('Java IR can attach to AST metadata and survive AST serialization', (t) => {
  const astDocument = frontend.parseJava(SOURCE, { sourceLevel: 8 });
  const javaIr = frontend.lowerAstToJavaIr(astDocument);
  frontend.attachJavaIrDocument(astDocument, javaIr);

  const attached = frontend.getAttachedJavaIrDocument(astDocument);
  t.deepEqual(attached, frontend.toJavaIrJson(javaIr), 'attached Java IR can be read back');

  const restoredAst = frontend.deserializeAst(frontend.serializeAst(astDocument));
  const restoredIr = frontend.getAttachedJavaIrDocument(restoredAst);
  t.deepEqual(restoredIr, frontend.toJavaIrJson(javaIr), 'attached Java IR survives AST serialization');
  t.end();
});

test('JVM bytecode IR lowers supported Java IR and serializes', (t) => {
  const astDocument = frontend.parseJava(SOURCE, { sourceLevel: 8 });
  const javaIr = frontend.lowerAstToJavaIr(astDocument);
  const bytecodeIr = frontend.javaIrToJvmBytecodeIr(javaIr);
  const main = bytecodeIr.classes[0].methods.find((method) => method.name === 'main');

  t.equal(bytecodeIr.schema, frontend.JVM_BYTECODE_IR_SCHEMA_ID, 'JVM bytecode IR schema is set');
  t.equal(bytecodeIr.status, 'complete', 'supported Java IR stack lowering is complete');
  t.ok(main.instructions.some((instruction) => instruction.opcode === 'istore'), 'local store is emitted');
  t.ok(main.instructions.some((instruction) => instruction.opcode === 'iload'), 'local load is emitted');
  t.doesNotThrow(() => frontend.validateJvmBytecodeIrDocument(bytecodeIr), 'JVM bytecode IR validates');

  const restored = frontend.deserializeJvmBytecodeIr(frontend.serializeJvmBytecodeIr(bytecodeIr));
  t.deepEqual(restored, frontend.toJvmBytecodeIrJson(bytecodeIr), 'JVM bytecode IR serialization is stable');
  t.end();
});

test('Hello World lowers through Java IR to complete JVM bytecode IR', (t) => {
  const astDocument = frontend.parseJava(HELLO_SOURCE, { sourceLevel: 8 });
  const javaIr = frontend.lowerAstToJavaIr(astDocument);
  const bytecodeIr = frontend.javaIrToJvmBytecodeIr(javaIr);
  const main = bytecodeIr.classes[0].methods.find((method) => method.name === 'main');

  t.equal(javaIr.classes[0].methods[0].blocks[0].ops[0].op, 'println', 'println literal is represented in Java IR');
  t.equal(bytecodeIr.status, 'complete', 'Hello World stack lowering is complete');
  t.ok(main.instructions.some((instruction) => instruction.opcode === 'ldc' && instruction.operands[0] === '"Hello, World!"'), 'literal load is emitted from IR');
  t.ok(main.instructions.some((instruction) => instruction.opcode === 'invokevirtual'), 'println invocation is emitted from IR');
  t.end();
});

test('simple local arithmetic source files compile through IR', (t) => {
  const repoRoot = path.resolve(__dirname, '..');
  const files = [
    ['sources/VerySimple.java', ['istore', 'iload', 'isub']],
    ['sources/SimpleArithmetic.java', ['iadd', 'isub', 'imul']],
    ['sources/ArithmeticTest.java', ['iadd', 'idiv', 'irem', 'dadd', 'fadd']],
    ['sources/WorkingArithmetic.java', ['iadd', 'isub', 'imul']],
    ['sources/SipushTest.java', ['sipush', 'istore', 'iload']],
    ['sources/ConstantsTest.java', ['iconst_0', 'iconst_1', 'iconst_3', 'iconst_5', 'iconst_m1']],
    ['sources/SimplestSipushCrash.java', ['sipush', 'new', 'dup']],
    ['sources/SimpleStringConcat.java', ['ldc', 'astore']],
    ['sources/StringConcat.java', ['new', 'dup', 'invokevirtual']],
    ['sources/StringConcatMethod.java', ['invokevirtual', 'astore', 'aload']],
    ['sources/StringBuilderConcat.java', ['new', 'dup', 'pop', 'invokevirtual']],
    ['sources/StringMethodsTest.java', ['invokevirtual', 'astore', 'aload']],
    ['sources/InvokeVirtualTest.java', ['invokevirtual', 'astore', 'aload']],
    ['sources/SimplestCrash.java', ['newarray', 'astore']],
    ['sources/SimpleStringTest.java', ['new', 'dup', 'invokespecial']],
    ['sources/MethodInvocationValidationTest.java', ['new', 'dup', 'invokevirtual']],
    ['sources/StaticVsInstanceTest.java', ['new', 'dup', 'invokevirtual']],
    ['sources/LongArithmeticTest.java', ['lstore', 'lload', 'ladd', 'lsub', 'lmul', 'ldiv']],
    ['sources/ConversionTest.java', ['lstore', 'lload', 'l2i', 'istore']],
    ['sources/TypeConversionTest.java', ['i2l', 'i2f', 'i2d', 'lstore', 'fstore', 'dstore']],
    ['sources/ObscureNumbers.java', ['ldc2_w', 'lstore', 'lload']],
    ['sources/ObscureUnicode.java', ['ldc2_w', 'dstore', 'dload', 'invokevirtual']],
    ['sources/BitwiseOperationsTest.java', ['ishr', 'iushr', 'iand', 'ior', 'ixor']],
    ['sources/LongBitwiseTest.java', ['land', 'lor', 'lxor', 'lshl', 'lshr', 'lushr']],
    ['sources/MathInstructions.java', ['lrem', 'frem', 'drem', 'ineg', 'lneg', 'iushr', 'lushr']],
    ['sources/ComparisonInstructions.java', ['lcmp', 'fcmpg', 'fcmpl', 'dcmpg', 'dcmpl']],
    ['sources/DoubleComparisonTest.java', ['dcmpg', 'dcmpl', 'goto']],
    ['sources/ExceptionTest.java', ['invokestatic', 'new', 'athrow', 'astore']],
    ['sources/FinallyTest.java', ['athrow', 'astore', 'aload']],
    ['sources/TryWithResourcesTest.java', ['invokevirtual', 'athrow', 'astore', 'aload']],
    ['sources/MultiCatchTest.java', ['athrow', 'astore', 'aload']],
    ['sources/JaggedArrayTest.java', ['anewarray', 'newarray', 'aaload', 'aastore', 'iaload', 'iastore']],
    ['sources/FizzBuzz.java', ['irem', 'if_icmpne', 'goto']],
    ['sources/ObjectCreationTest.java', ['putfield', 'getfield', 'invokevirtual']],
    ['sources/ConstructorPrinter.java', ['new', 'invokespecial', 'return']],
    ['sources/NestedClassPrivateAccessTest.java', ['getfield', 'putfield', 'invokevirtual']],
    ['sources/NewLambdaCrash.java', ['new', 'checkcast', 'invokeinterface']],
    ['sources/LambdaCrash.java', ['new', 'checkcast', 'invokeinterface']],
    ['sources/InvokeDynamicTest.java', ['ldc', 'invokeinterface']],
    ['sources/PotentialCrash1.java', ['monitorenter', 'monitorexit']],
    ['sources/ConcurrencyCrash.java', ['putstatic', 'invokestatic', 'invokevirtual']],
    ['sources/ReflectionCrash.java', ['invokestatic', 'invokevirtual', 'arraylength']],
    ['sources/ReflectionTest.java', ['invokevirtual', 'aaload']],
    ['sources/ReflectionCrashTest.java', ['invokevirtual', 'checkcast', 'invokespecial']],
    ['sources/AnnotationReflectionTest.java', ['invokevirtual', 'checkcast', 'invokestatic']],
  ];

  for (const [file, expectedOpcodes] of files) {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    const result = frontend.compileJavaSource(source, { sourceFileName: path.basename(file) });
    const main = result.bytecodeIr.classes[0].methods.find((method) => method.name === 'main');
    const opcodes = result.bytecodeIr.classes.flatMap((classIr) => (
      classIr.methods.flatMap((method) => method.instructions.map((instruction) => instruction.opcode))
    ));
    t.equal(result.bytecodeIr.status, 'complete', `${file} compiles completely`);
    for (const opcode of expectedOpcodes) {
      t.ok(opcodes.includes(opcode), `${file} emits ${opcode}`);
    }
    t.ok(opcodes.includes('invokevirtual'), `${file} emits println invocation`);
  }
  t.end();
});

test('simple non-void returns and same-class static calls compile through IR', (t) => {
  const repoRoot = path.resolve(__dirname, '..');
  const files = [
    ['sources/A.java', ['areturn']],
    ['sources/B.java', ['areturn']],
    ['sources/RuntimeArithmetic.java', ['ireturn', 'invokestatic', 'iadd', 'isub', 'imul']],
    ['sources/SmallDivisionTest.java', ['ireturn', 'invokestatic', 'idiv', 'irem']],
    ['sources/TryCatchSample.java', ['ireturn', 'idiv', 'getstatic']],
    ['sources/TryCatchFinallyTest.java', ['ireturn', 'athrow', 'astore', 'aload']],
    ['sources/TryWithResourcesTest.java', ['arraylength', 'aaload', 'astore', 'aload']],
  ];

  for (const [file, expectedOpcodes] of files) {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    const result = frontend.compileJavaSource(source, { sourceFileName: path.basename(file) });
    const opcodes = result.bytecodeIr.classes.flatMap((classIr) => (
      classIr.methods.flatMap((method) => method.instructions.map((instruction) => instruction.opcode))
    ));
    t.equal(result.bytecodeIr.status, 'complete', `${file} compiles completely`);
    for (const opcode of expectedOpcodes) {
      t.ok(opcodes.includes(opcode), `${file} emits ${opcode}`);
    }
  }
  t.end();
});

test('simple interfaces compile through IR without method code blocks', (t) => {
  const repoRoot = path.resolve(__dirname, '..');
  const files = [
    ['sources/I.java', 'I', 'myMethod'],
    ['sources/RenameableInterface.java', 'RenameableInterface', 'methodToRename'],
  ];

  for (const [file, internalName, methodName] of files) {
    const result = frontend.compileJavaFile(path.join(repoRoot, file), {
      sourceFileName: path.basename(file),
    });
    const classIr = result.bytecodeIr.classes[0];
    const method = classIr.methods.find((entry) => entry.name === methodName);
    t.equal(result.bytecodeIr.status, 'complete', `${file} compiles completely`);
    t.equal(classIr.internalName, internalName, `${file} emits the interface`);
    t.ok(classIr.access.includes('interface'), `${file} has interface access`);
    t.ok(method.access.includes('abstract'), `${file} method is abstract`);
    t.deepEqual(method.instructions, [], `${file} abstract method has no code`);
  }
  t.end();
});

test('main args array length compiles through IR', (t) => {
  const repoRoot = path.resolve(__dirname, '..');
  const result = frontend.compileJavaFile(path.join(repoRoot, 'sources/ArgsLengthTest.java'), {
    sourceFileName: 'ArgsLengthTest.java',
  });
  const main = result.bytecodeIr.classes[0].methods.find((method) => method.name === 'main');
  const opcodes = main.instructions.map((instruction) => instruction.opcode);

  t.equal(result.bytecodeIr.status, 'complete', 'ArgsLengthTest compiles completely');
  t.ok(opcodes.includes('aload'), 'args local load is emitted');
  t.ok(opcodes.includes('arraylength'), 'arraylength is emitted');
  t.ok(opcodes.includes('invokevirtual'), 'println invocation is emitted');
  t.end();
});

test('array load and store compile through IR', (t) => {
  const intResult = frontend.compileJavaSource(ARRAY_SMOKE_SOURCE, { sourceFileName: 'ArraySmoke.java' });
  const refResult = frontend.compileJavaSource(REF_ARRAY_SMOKE_SOURCE, { sourceFileName: 'RefArraySmoke.java' });
  const initializerResult = frontend.compileJavaSource(ARRAY_INITIALIZER_SMOKE_SOURCE, { sourceFileName: 'ArrayInitializerSmoke.java' });
  const intOpcodes = intResult.bytecodeIr.classes[0].methods.find((method) => method.name === 'main').instructions.map((instruction) => instruction.opcode);
  const refOpcodes = refResult.bytecodeIr.classes[0].methods.find((method) => method.name === 'main').instructions.map((instruction) => instruction.opcode);
  const initializerOpcodes = initializerResult.bytecodeIr.classes[0].methods.find((method) => method.name === 'main').instructions.map((instruction) => instruction.opcode);

  t.equal(intResult.bytecodeIr.status, 'complete', 'int array smoke compiles completely');
  t.ok(intOpcodes.includes('newarray'), 'int array creation is emitted');
  t.ok(intOpcodes.includes('iastore'), 'int array store is emitted');
  t.ok(intOpcodes.includes('iaload'), 'int array load is emitted');
  t.equal(refResult.bytecodeIr.status, 'complete', 'reference array smoke compiles completely');
  t.ok(refOpcodes.includes('anewarray'), 'reference array creation is emitted');
  t.ok(refOpcodes.includes('aastore'), 'reference array store is emitted');
  t.ok(refOpcodes.includes('aaload'), 'reference array load is emitted');
  t.equal(initializerResult.bytecodeIr.status, 'complete', 'array initializer smoke compiles completely');
  t.ok(initializerOpcodes.includes('bastore'), 'byte array initializer stores are emitted');
  t.ok(initializerOpcodes.includes('iastore'), 'int array initializer stores are emitted');
  t.ok(initializerOpcodes.includes('checkcast'), 'array-to-reference assignment coercion is emitted');
  t.end();
});

test('narrow primitives and reference casts compile through IR', (t) => {
  const narrowResult = frontend.compileJavaSource(NARROW_PRIMITIVE_SMOKE_SOURCE, { sourceFileName: 'NarrowPrimitiveSmoke.java' });
  const castResult = frontend.compileJavaSource(REF_CAST_SMOKE_SOURCE, { sourceFileName: 'RefCastSmoke.java' });
  const wrapperResult = frontend.compileJavaSource(WRAPPER_TYPES_SMOKE_SOURCE, { sourceFileName: 'WrapperTypesSmoke.java' });
  const reassignmentResult = frontend.compileJavaSource(REASSIGNMENT_CONVERSION_SMOKE_SOURCE, { sourceFileName: 'ReassignmentConversionSmoke.java' });
  const stringExtraResult = frontend.compileJavaSource(STRING_EXTRA_SMOKE_SOURCE, { sourceFileName: 'StringExtraSmoke.java' });
  const stringCompareResult = frontend.compileJavaSource(STRING_COMPARE_SMOKE_SOURCE, { sourceFileName: 'StringCompareSmoke.java' });
  const stringConcatSemanticsResult = frontend.compileJavaSource(STRING_CONCAT_SEMANTICS_SMOKE_SOURCE, { sourceFileName: 'StringConcatSemanticsSmoke.java' });
  const classInstanceResult = frontend.compileJavaSource(CLASS_INSTANCE_SMOKE_SOURCE, { sourceFileName: 'ClassInstanceSmoke.java' });
  const arrayTypeResult = frontend.compileJavaSource(ARRAY_TYPE_SMOKE_SOURCE, { sourceFileName: 'ArrayTypeSmoke.java' });
  const genericResult = frontend.compileJavaSource(GENERIC_ERASURE_SMOKE_SOURCE, { sourceFileName: 'GenericErasureSmoke.java' });
  const ifResult = frontend.compileJavaSource(IF_SMOKE_SOURCE, { sourceFileName: 'IfSmoke.java' });
  const forResult = frontend.compileJavaSource(FOR_SMOKE_SOURCE, { sourceFileName: 'ForSmoke.java' });
  const whileResult = frontend.compileJavaSource(WHILE_SMOKE_SOURCE, { sourceFileName: 'WhileSmoke.java' });
  const doWhileResult = frontend.compileJavaSource(DO_WHILE_SMOKE_SOURCE, { sourceFileName: 'DoWhileSmoke.java' });
  const methodCallResult = frontend.compileJavaSource(METHOD_CALL_SMOKE_SOURCE, { sourceFileName: 'MethodCallSmoke.java' });
  const superResult = frontend.compileJavaSource(SUPER_SMOKE_SOURCE, { sourceFileName: 'SuperSmoke.java' });
  const constructorResult = frontend.compileJavaSource(CONSTRUCTOR_SMOKE_SOURCE, { sourceFileName: 'ConstructorSmoke.java' });
  const switchResult = frontend.compileJavaSource(SWITCH_SMOKE_SOURCE, { sourceFileName: 'SwitchSmoke.java' });
  const unaryResult = frontend.compileJavaSource(UNARY_SMOKE_SOURCE, { sourceFileName: 'UnarySmoke.java' });
  const tryCatchResult = frontend.compileJavaSource(TRY_CATCH_SMOKE_SOURCE, { sourceFileName: 'TryCatchSmoke.java' });
  const tryCatchReturnResult = frontend.compileJavaSource(TRY_CATCH_RETURN_SMOKE_SOURCE, { sourceFileName: 'TryCatchReturnSmoke.java' });
  const narrowOpcodes = narrowResult.bytecodeIr.classes[0].methods.find((method) => method.name === 'main').instructions.map((instruction) => instruction.opcode);
  const castOpcodes = castResult.bytecodeIr.classes[0].methods.find((method) => method.name === 'main').instructions.map((instruction) => instruction.opcode);
  const reassignmentOpcodes = reassignmentResult.bytecodeIr.classes[0].methods.find((method) => method.name === 'main').instructions.map((instruction) => instruction.opcode);
  const stringExtraInstructions = stringExtraResult.bytecodeIr.classes[0].methods.find((method) => method.name === 'main').instructions;
  const stringCompareOpcodes = stringCompareResult.bytecodeIr.classes[0].methods.find((method) => method.name === 'main').instructions.map((instruction) => instruction.opcode);
  const stringConcatSemanticsInstructions = stringConcatSemanticsResult.bytecodeIr.classes[0].methods.find((method) => method.name === 'main').instructions;
  const stringConcatSemanticsOpcodes = stringConcatSemanticsInstructions.map((instruction) => instruction.opcode);
  const stringConcatSemanticsLdc = stringConcatSemanticsInstructions
    .filter((instruction) => instruction.opcode === 'ldc')
    .map((instruction) => instruction.operands.join(' '));
  const classInstanceInstructions = classInstanceResult.bytecodeIr.classes[0].methods.find((method) => method.name === 'main').instructions;
  const classInstanceOpcodes = classInstanceInstructions.map((instruction) => instruction.opcode);
  const arrayTypeOpcodes = arrayTypeResult.bytecodeIr.classes[0].methods.find((method) => method.name === 'main').instructions.map((instruction) => instruction.opcode);
  const genericClass = genericResult.bytecodeIr.classes[0];
  const genericMain = genericClass.methods.find((method) => method.name === 'main');
  const genericOpcodes = genericMain.instructions.map((instruction) => instruction.opcode);
  const genericIrClass = genericResult.javaIr.classes[0];
  const genericId = genericIrClass.methods.find((method) => method.name === 'id');
  const genericFirst = genericIrClass.methods.find((method) => method.name === 'first');
  const genericListLocal = genericIrClass.methods.find((method) => method.name === 'main').locals.find((local) => local.name === 'list');
  const ifOpcodes = ifResult.bytecodeIr.classes[0].methods.find((method) => method.name === 'main').instructions.map((instruction) => instruction.opcode);
  const forOpcodes = forResult.bytecodeIr.classes[0].methods.find((method) => method.name === 'main').instructions.map((instruction) => instruction.opcode);
  const whileOpcodes = whileResult.bytecodeIr.classes[0].methods.find((method) => method.name === 'main').instructions.map((instruction) => instruction.opcode);
  const doWhileOpcodes = doWhileResult.bytecodeIr.classes[0].methods.find((method) => method.name === 'main').instructions.map((instruction) => instruction.opcode);
  const methodCallInstructions = methodCallResult.bytecodeIr.classes[0].methods.flatMap((method) => method.instructions);
  const methodCallOpcodes = methodCallInstructions.map((instruction) => instruction.opcode);
  const methodCallOperands = methodCallInstructions.map((instruction) => instruction.operands.join(' '));
  const superClass = superResult.javaIr.classes.find((irClass) => irClass.name === 'SuperSmoke');
  const superInstructions = superResult.bytecodeIr.classes.flatMap((irClass) => irClass.methods.flatMap((method) => method.instructions));
  const superOpcodes = superInstructions.map((instruction) => instruction.opcode);
  const superOperands = superInstructions.map((instruction) => instruction.operands.join(' '));
  const constructorInstructions = constructorResult.bytecodeIr.classes.flatMap((irClass) => irClass.methods.flatMap((method) => method.instructions));
  const constructorOpcodes = constructorInstructions.map((instruction) => instruction.opcode);
  const constructorOperands = constructorInstructions.map((instruction) => instruction.operands.join(' '));
  const switchOpcodes = switchResult.bytecodeIr.classes[0].methods.find((method) => method.name === 'test').instructions.map((instruction) => instruction.opcode);
  const unaryOpcodes = unaryResult.bytecodeIr.classes[0].methods.find((method) => method.name === 'main').instructions.map((instruction) => instruction.opcode);
  const tryCatchMethod = tryCatchResult.bytecodeIr.classes[0].methods.find((method) => method.name === 'main');
  const tryCatchOpcodes = tryCatchMethod.instructions.map((instruction) => instruction.opcode);
  const tryCatchReturnMethod = tryCatchReturnResult.bytecodeIr.classes[0].methods.find((method) => method.name === 'safeDivide');
  const tryCatchReturnOpcodes = tryCatchReturnMethod.instructions.map((instruction) => instruction.opcode);
  const classInstanceCalls = classInstanceInstructions
    .filter((instruction) => instruction.opcode === 'ldc' || instruction.opcode === 'getstatic')
    .map((instruction) => instruction.operands.join(' '));
  const stringExtraCalls = stringExtraInstructions
    .filter((instruction) => instruction.opcode === 'invokevirtual' || instruction.opcode === 'invokestatic')
    .map((instruction) => instruction.operands.join(' '));
  const wrapperInstructions = wrapperResult.bytecodeIr.classes[0].methods.find((method) => method.name === 'main').instructions;
  const wrapperOpcodes = wrapperInstructions.map((instruction) => instruction.opcode);
  const wrapperCalls = wrapperInstructions
    .filter((instruction) => instruction.opcode === 'invokestatic' || instruction.opcode === 'invokevirtual')
    .map((instruction) => instruction.operands.join(' '));

  t.equal(narrowResult.bytecodeIr.status, 'complete', 'narrow primitive smoke compiles completely');
  t.ok(narrowOpcodes.includes('i2b'), 'byte narrowing conversion is emitted');
  t.ok(narrowOpcodes.includes('i2s'), 'short narrowing conversion is emitted');
  t.ok(narrowOpcodes.includes('invokevirtual'), 'narrow primitive println calls are emitted');
  t.equal(castResult.bytecodeIr.status, 'complete', 'reference cast smoke compiles completely');
  t.ok(castOpcodes.includes('checkcast'), 'reference checkcast is emitted');
  t.ok(castOpcodes.includes('aconst_null'), 'null literal is emitted');
  t.equal(wrapperResult.bytecodeIr.status, 'complete', 'wrapper type smoke compiles completely');
  t.ok(wrapperOpcodes.includes('invokestatic'), 'wrapper boxing calls are emitted');
  t.ok(wrapperOpcodes.includes('invokevirtual'), 'wrapper unboxing calls are emitted');
  t.ok(wrapperCalls.some((call) => call.includes('java/lang/Integer valueOf')), 'Integer boxing is emitted');
  t.ok(wrapperCalls.some((call) => call.includes('java/lang/Character charValue')), 'Character unboxing is emitted');
  t.equal(reassignmentResult.bytecodeIr.status, 'complete', 'reassignment conversion smoke compiles completely');
  for (const opcode of ['l2i', 'l2f', 'l2d', 'f2i', 'f2l', 'f2d', 'd2i', 'd2l', 'd2f']) {
    t.ok(reassignmentOpcodes.includes(opcode), `reassignment conversion emits ${opcode}`);
  }
  t.equal(stringExtraResult.bytecodeIr.status, 'complete', 'extra string smoke compiles completely');
  t.ok(stringExtraCalls.some((call) => call.includes('java/lang/String intern')), 'String.intern call is emitted');
  t.ok(stringExtraCalls.some((call) => call.includes('java/lang/Integer toString')), 'Integer.toString call is emitted');
  t.ok(stringExtraCalls.some((call) => call.includes('java/lang/String getBytes')), 'String.getBytes call is emitted');
  t.equal(stringCompareResult.bytecodeIr.status, 'complete', 'string comparison smoke compiles completely');
  t.ok(stringCompareOpcodes.includes('if_acmpeq'), 'reference equality comparison is emitted');
  t.ok(stringCompareOpcodes.includes('if_acmpne'), 'reference inequality comparison is emitted');
  t.equal(stringConcatSemanticsResult.bytecodeIr.status, 'complete', 'string concatenation semantics smoke compiles completely');
  t.ok(stringConcatSemanticsLdc.includes('"hello"'), 'literal-only string concatenation folds to an interned ldc');
  t.ok(stringConcatSemanticsOpcodes.includes('new'), 'runtime string concatenation still uses StringBuilder allocation');
  t.ok(stringConcatSemanticsOpcodes.includes('invokevirtual'), 'string concatenation append/toString calls are emitted');
  t.equal(classInstanceResult.bytecodeIr.status, 'complete', 'class literal and instanceof smoke compiles completely');
  t.ok(classInstanceOpcodes.includes('instanceof'), 'instanceof is emitted');
  t.ok(classInstanceCalls.some((call) => call.includes('Class java/lang/String')), 'reference class literal is emitted');
  t.ok(classInstanceCalls.some((call) => call.includes('java/lang/Integer TYPE')), 'primitive class literal TYPE field is emitted');
  t.equal(arrayTypeResult.bytecodeIr.status, 'complete', 'array type smoke compiles completely');
  t.ok(arrayTypeOpcodes.includes('multianewarray'), 'rectangular multidimensional array creation is emitted');
  t.ok(arrayTypeOpcodes.includes('anewarray'), 'jagged/reference subarray creation is emitted');
  t.ok(arrayTypeOpcodes.includes('iastore'), 'nested primitive array store is emitted');
  t.ok(arrayTypeOpcodes.includes('aaload'), 'nested reference array load is emitted');
  t.equal(genericResult.bytecodeIr.status, 'complete', 'generic erasure smoke compiles completely');
  t.equal(genericId.descriptor, '(Ljava/lang/Object;)Ljava/lang/Object;', 'unbounded method type parameter erases to Object');
  t.equal(genericFirst.descriptor, '(Ljava/lang/Comparable;)Ljava/lang/Comparable;', 'bounded method type parameter erases to first bound');
  t.equal(genericListLocal.descriptor, 'Ljava/util/List;', 'parameterized local type erases to raw owner');
  t.equal(genericListLocal.meta.signature, 'Ljava/util/List<Ljava/lang/String;>;', 'parameterized local signature is preserved in IR metadata');
  t.ok(genericOpcodes.includes('checkcast'), 'generic reference erasure emits required casts');
  t.equal(ifResult.bytecodeIr.status, 'complete', 'if smoke compiles completely');
  t.ok(ifOpcodes.includes('if_icmpge'), 'int relational false branch is emitted');
  t.ok(ifOpcodes.includes('lcmp'), 'long comparison is emitted');
  t.ok(ifOpcodes.includes('dcmpg'), 'double comparison is emitted');
  t.ok(ifOpcodes.includes('ifeq'), 'boolean false branch is emitted');
  t.equal(forResult.bytecodeIr.status, 'complete', 'for smoke compiles completely');
  t.ok(forOpcodes.includes('goto'), 'for loop back-edge is emitted');
  t.ok(forOpcodes.includes('if_icmpgt'), 'for loop exit branch is emitted');
  t.equal(whileResult.bytecodeIr.status, 'complete', 'while smoke compiles completely');
  t.ok(whileOpcodes.includes('goto'), 'while loop back-edge is emitted');
  t.ok(whileOpcodes.includes('if_icmpge'), 'while loop exit branch is emitted');
  t.equal(doWhileResult.bytecodeIr.status, 'complete', 'do while smoke compiles completely');
  t.ok(doWhileOpcodes.includes('goto'), 'do while loop back-edge is emitted');
  t.ok(doWhileOpcodes.includes('if_icmpge'), 'do while loop exit branch is emitted');
  t.equal(methodCallResult.bytecodeIr.status, 'complete', 'method call smoke compiles completely');
  t.ok(methodCallOpcodes.includes('invokevirtual'), 'instance method calls are emitted');
  t.ok(methodCallOpcodes.includes('invokestatic'), 'static method calls are emitted');
  t.ok(methodCallOperands.some((operand) => operand.includes('MethodCallSmoke add')), 'user instance method target is emitted');
  t.ok(methodCallOperands.some((operand) => operand.includes('MethodCallSmoke plus')), 'user static method target is emitted');
  t.equal(superResult.bytecodeIr.status, 'complete', 'super smoke compiles completely');
  t.equal(superClass.superName, 'SuperBaseSmoke', 'superclass is preserved in Java IR');
  t.ok(superOpcodes.includes('invokespecial'), 'super invokespecial calls are emitted');
  t.ok(superOperands.some((operand) => operand.includes('SuperBaseSmoke <init> (I)V')), 'super constructor target is emitted');
  t.ok(superOperands.some((operand) => operand.includes('SuperBaseSmoke value ()I')), 'super method target is emitted');
  t.equal(constructorResult.bytecodeIr.status, 'complete', 'constructor smoke compiles completely');
  t.ok(constructorOpcodes.includes('invokespecial'), 'constructor delegation emits invokespecial');
  t.ok(constructorOperands.some((operand) => operand.includes('ConstructorBaseSmoke <init> (I)V')), 'explicit super constructor target is emitted');
  t.ok(constructorOperands.some((operand) => operand.includes('ConstructorSmoke <init> (I)V')), 'this constructor delegation target is emitted');
  t.ok(constructorOperands.some((operand) => operand.includes('java/lang/Object <init> ()V')), 'implicit super constructor target is emitted');
  t.equal(switchResult.bytecodeIr.status, 'complete', 'switch smoke compiles completely');
  t.ok(switchOpcodes.includes('if_icmpeq'), 'switch case dispatch branches are emitted');
  t.ok(switchOpcodes.includes('goto'), 'switch break/default branches are emitted');
  t.equal(unaryResult.bytecodeIr.status, 'complete', 'unary smoke compiles completely');
  t.ok(unaryOpcodes.includes('ifeq'), 'logical not branch is emitted');
  t.ok(unaryOpcodes.includes('ixor'), 'int bitwise complement is emitted');
  t.ok(unaryOpcodes.includes('lxor'), 'long bitwise complement is emitted');
  t.ok(unaryOpcodes.includes('ineg'), 'int negation is emitted');
  t.equal(tryCatchResult.bytecodeIr.status, 'complete', 'try/catch smoke compiles completely');
  t.ok(tryCatchOpcodes.includes('athrow'), 'throw is emitted');
  t.equal(tryCatchMethod.exceptionTable.length, 1, 'try/catch exception table is emitted');
  t.equal(tryCatchReturnResult.bytecodeIr.status, 'complete', 'try/catch return smoke compiles completely');
  t.ok(tryCatchReturnOpcodes.includes('ireturn'), 'try/catch non-void return is emitted');
  t.ok(tryCatchReturnOpcodes.includes('getstatic'), 'try/catch catch return static constant is emitted');
  t.end();
});

function setupIntegerPrintCapture(jvm) {
  let output = '';
  jvm.registerJreMethods({
    'java/io/PrintStream': {
      'println(I)V': (jvmInstance, obj, args) => {
        output += `${args[0]}\n`;
      },
    },
  });
  return () => output;
}

test('IR-generated classes execute on the repo JVM', async (t) => {
  execFileSync('node', ['scripts/generate-jre-index.js'], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'ignore',
  });
  const { runTest } = require('./test-helpers');
  const repoRoot = path.resolve(__dirname, '..');
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'java-frontend-ir-jvm-'));
  const cases = [
    ['sources/Hello.java', 'Hello', 'Hello, World!'],
    ['sources/VerySimple.java', 'VerySimple', expectedOutputForClass('VerySimple')],
    ['sources/SimpleArithmetic.java', 'SimpleArithmetic', expectedOutputForClass('SimpleArithmetic')],
    ['sources/ArithmeticTest.java', 'ArithmeticTest', expectedOutputForClass('ArithmeticTest')],
    ['sources/WorkingArithmetic.java', 'WorkingArithmetic', expectedOutputForClass('WorkingArithmetic')],
    ['sources/SipushTest.java', 'SipushTest', expectedOutputForClass('SipushTest')],
    ['sources/RuntimeArithmetic.java', 'RuntimeArithmetic', expectedOutputForClass('RuntimeArithmetic')],
    ['sources/SmallDivisionTest.java', 'SmallDivisionTest', expectedOutputForClass('SmallDivisionTest')],
    ['sources/SimpleStringConcat.java', 'SimpleStringConcat', expectedOutputForClass('SimpleStringConcat')],
    ['sources/StringConcat.java', 'StringConcat', expectedOutputForClass('StringConcat')],
    ['sources/StringConcatMethod.java', 'StringConcatMethod', expectedOutputForClass('StringConcatMethod')],
    ['sources/StringBuilderConcat.java', 'StringBuilderConcat', expectedOutputForClass('StringBuilderConcat')],
    ['sources/StringMethodsTest.java', 'StringMethodsTest', expectedOutputForClass('StringMethodsTest')],
    ['sources/InvokeVirtualTest.java', 'InvokeVirtualTest', expectedOutputForClass('InvokeVirtualTest')],
    ['sources/SimplestCrash.java', 'SimplestCrash', expectedOutputForClass('SimplestCrash')],
    ['sources/SimpleStringTest.java', 'SimpleStringTest', expectedOutputForClass('SimpleStringTest')],
    ['sources/MethodInvocationValidationTest.java', 'MethodInvocationValidationTest', expectedOutputForClass('MethodInvocationValidationTest')],
    ['sources/StaticVsInstanceTest.java', 'StaticVsInstanceTest', expectedOutputForClass('StaticVsInstanceTest')],
    ['sources/LongArithmeticTest.java', 'LongArithmeticTest', expectedOutputForClass('LongArithmeticTest')],
    ['sources/ConversionTest.java', 'ConversionTest', expectedOutputForClass('ConversionTest')],
    ['sources/TypeConversionTest.java', 'TypeConversionTest', expectedOutputForClass('TypeConversionTest')],
    ['sources/ObscureNumbers.java', 'ObscureNumbers', expectedOutputForClass('ObscureNumbers')],
    ['sources/ObscureUnicode.java', 'ObscureUnicode', expectedOutputForClass('ObscureUnicode')],
    ['sources/BitwiseOperationsTest.java', 'BitwiseOperationsTest', expectedOutputForClass('BitwiseOperationsTest')],
    ['sources/LongBitwiseTest.java', 'LongBitwiseTest', expectedOutputForClass('LongBitwiseTest')],
    ['sources/MathInstructions.java', 'MathInstructions', expectedOutputForClass('MathInstructions')],
    ['sources/ComparisonInstructions.java', 'ComparisonInstructions', expectedOutputForClass('ComparisonInstructions')],
    ['sources/DoubleComparisonTest.java', 'DoubleComparisonTest', expectedOutputForClass('DoubleComparisonTest')],
    ['sources/ExceptionTest.java', 'ExceptionTest', expectedOutputForClass('ExceptionTest')],
    ['sources/FinallyTest.java', 'FinallyTest', expectedOutputForClass('FinallyTest')],
    ['sources/MultiCatchTest.java', 'MultiCatchTest', expectedOutputForClass('MultiCatchTest')],
    ['sources/JaggedArrayTest.java', 'JaggedArrayTest', expectedOutputForClass('JaggedArrayTest')],
    ['sources/FizzBuzz.java', 'FizzBuzz', expectedOutputForClass('FizzBuzz')],
    ['sources/ObjectCreationTest.java', 'ObjectCreationTest', expectedOutputForClass('ObjectCreationTest')],
    ['sources/ConstructorPrinter.java', 'ConstructorPrinter', expectedOutputForClass('ConstructorPrinter')],
    ['sources/NestedClassPrivateAccessTest.java', 'NestedClassPrivateAccessTest', expectedOutputForClass('NestedClassPrivateAccessTest')],
    ['sources/EnumTest.java', 'EnumTest', expectedOutputForClass('EnumTest')],
    ['sources/EnumSwitchCrash.java', 'EnumSwitchCrash', expectedOutputForClass('EnumSwitchCrash')],
    ['sources/EnumSwitchTest.java', 'EnumSwitchTest', expectedOutputForClass('EnumSwitchTest')],
    ['sources/NewLambdaCrash.java', 'NewLambdaCrash', expectedOutputForClass('NewLambdaCrash')],
    ['sources/LambdaCrash.java', 'LambdaCrash', expectedOutputForClass('LambdaCrash')],
    ['sources/InvokeDynamicTest.java', 'InvokeDynamicTest', expectedOutputForClass('InvokeDynamicTest')],
    ['sources/PotentialCrash1.java', 'PotentialCrash1', expectedOutputForClass('PotentialCrash1')],
    ['sources/ConcurrencyCrash.java', 'ConcurrencyCrash', expectedOutputForClass('ConcurrencyCrash')],
    ['sources/ReflectionCrash.java', 'ReflectionCrash', expectedOutputForClass('ReflectionCrash')],
    ['sources/ReflectionCrashTest.java', 'ReflectionCrashTest', expectedOutputForClass('ReflectionCrashTest')],
    ['sources/AnnotationReflectionTest.java', 'AnnotationReflectionTest', expectedOutputForClass('AnnotationReflectionTest')],
    ['sources/SimplestSipushCrash.java', 'SimplestSipushCrash', expectedOutputForClass('SimplestSipushCrash')],
    ['sources/TryCatchFinallyTest.java', 'TryCatchFinallyTest', expectedOutputForClass('TryCatchFinallyTest')],
    ['sources/TryWithResourcesTest.java', 'TryWithResourcesTest', expectedOutputForClass('TryWithResourcesTest')],
  ];

  try {
    for (const [file] of cases) {
      frontend.compileJavaFile(path.join(repoRoot, file), {
        outputDir,
        sourceFileName: path.basename(file),
      });
    }
    frontend.compileJavaFile(path.join(repoRoot, 'sources/ConstantsTest.java'), {
      outputDir,
      sourceFileName: 'ConstantsTest.java',
    });
    frontend.compileJavaFile(path.join(repoRoot, 'sources/ArgsLengthTest.java'), {
      outputDir,
      sourceFileName: 'ArgsLengthTest.java',
    });
    frontend.compileJavaSource(ARRAY_SMOKE_SOURCE, {
      outputDir,
      sourceFileName: 'ArraySmoke.java',
    });
    frontend.compileJavaSource(REF_ARRAY_SMOKE_SOURCE, {
      outputDir,
      sourceFileName: 'RefArraySmoke.java',
    });
    frontend.compileJavaSource(ARRAY_INITIALIZER_SMOKE_SOURCE, {
      outputDir,
      sourceFileName: 'ArrayInitializerSmoke.java',
    });
    frontend.compileJavaSource(NARROW_PRIMITIVE_SMOKE_SOURCE, {
      outputDir,
      sourceFileName: 'NarrowPrimitiveSmoke.java',
    });
    frontend.compileJavaSource(REF_CAST_SMOKE_SOURCE, {
      outputDir,
      sourceFileName: 'RefCastSmoke.java',
    });
    frontend.compileJavaSource(WRAPPER_TYPES_SMOKE_SOURCE, {
      outputDir,
      sourceFileName: 'WrapperTypesSmoke.java',
    });
    frontend.compileJavaSource(REASSIGNMENT_CONVERSION_SMOKE_SOURCE, {
      outputDir,
      sourceFileName: 'ReassignmentConversionSmoke.java',
    });
    frontend.compileJavaSource(STRING_EXTRA_SMOKE_SOURCE, {
      outputDir,
      sourceFileName: 'StringExtraSmoke.java',
    });
    frontend.compileJavaSource(STRING_COMPARE_SMOKE_SOURCE, {
      outputDir,
      sourceFileName: 'StringCompareSmoke.java',
    });
    frontend.compileJavaSource(STRING_CONCAT_SEMANTICS_SMOKE_SOURCE, {
      outputDir,
      sourceFileName: 'StringConcatSemanticsSmoke.java',
    });
    frontend.compileJavaSource(CLASS_INSTANCE_SMOKE_SOURCE, {
      outputDir,
      sourceFileName: 'ClassInstanceSmoke.java',
    });
    frontend.compileJavaSource(ARRAY_TYPE_SMOKE_SOURCE, {
      outputDir,
      sourceFileName: 'ArrayTypeSmoke.java',
    });
    frontend.compileJavaSource(GENERIC_ERASURE_SMOKE_SOURCE, {
      outputDir,
      sourceFileName: 'GenericErasureSmoke.java',
    });
    frontend.compileJavaSource(IF_SMOKE_SOURCE, {
      outputDir,
      sourceFileName: 'IfSmoke.java',
    });
    frontend.compileJavaSource(FOR_SMOKE_SOURCE, {
      outputDir,
      sourceFileName: 'ForSmoke.java',
    });
    frontend.compileJavaSource(WHILE_SMOKE_SOURCE, {
      outputDir,
      sourceFileName: 'WhileSmoke.java',
    });
    frontend.compileJavaSource(DO_WHILE_SMOKE_SOURCE, {
      outputDir,
      sourceFileName: 'DoWhileSmoke.java',
    });
    frontend.compileJavaSource(METHOD_CALL_SMOKE_SOURCE, {
      outputDir,
      sourceFileName: 'MethodCallSmoke.java',
    });
    frontend.compileJavaSource(SUPER_SMOKE_SOURCE, {
      outputDir,
      sourceFileName: 'SuperSmoke.java',
    });
    frontend.compileJavaSource(CONSTRUCTOR_SMOKE_SOURCE, {
      outputDir,
      sourceFileName: 'ConstructorSmoke.java',
    });
    frontend.compileJavaSource(SWITCH_SMOKE_SOURCE, {
      outputDir,
      sourceFileName: 'SwitchSmoke.java',
    });
    frontend.compileJavaSource(UNARY_SMOKE_SOURCE, {
      outputDir,
      sourceFileName: 'UnarySmoke.java',
    });
    frontend.compileJavaSource(TRY_CATCH_SMOKE_SOURCE, {
      outputDir,
      sourceFileName: 'TryCatchSmoke.java',
    });
    frontend.compileJavaSource(TRY_CATCH_RETURN_SMOKE_SOURCE, {
      outputDir,
      sourceFileName: 'TryCatchReturnSmoke.java',
    });
    for (const [, className, expected] of cases) {
      const result = await runTest(className, expected, null, {
        classpath: outputDir,
        timeout: 3000,
        silent: true,
      });
      t.ok(result.success, `${className} runs on repo JVM`);
      t.equal(result.output.trim(), expected, `${className} repo JVM output matches`);
    }
    const constants = await runTest('ConstantsTest', undefined, null, {
      classpath: outputDir,
      timeout: 3000,
      silent: true,
    });
    const constantsLines = constants.output.trim().split('\n');
    t.ok(constants.success, 'ConstantsTest runs on repo JVM');
    t.equal(constantsLines[0], CONSTANTS_ICONST_PREFIX[0], 'ConstantsTest iconst_0 output matches');
    t.equal(constantsLines[1], CONSTANTS_ICONST_PREFIX[1], 'ConstantsTest iconst_1 output matches');
    t.equal(constantsLines[2], CONSTANTS_ICONST_PREFIX[2], 'ConstantsTest iconst_3 output matches');

    const arraySmoke = await runTest('ArraySmoke', '7', null, {
      classpath: outputDir,
      timeout: 3000,
      silent: true,
    });
    t.ok(arraySmoke.success, 'ArraySmoke runs on repo JVM');
    t.equal(arraySmoke.output.trim(), '7', 'ArraySmoke repo JVM output matches');

    const refArraySmoke = await runTest('RefArraySmoke', 'x', null, {
      classpath: outputDir,
      timeout: 3000,
      silent: true,
    });
    t.ok(refArraySmoke.success, 'RefArraySmoke runs on repo JVM');
    t.equal(refArraySmoke.output.trim(), 'x', 'RefArraySmoke repo JVM output matches');

    const arrayInitializerSmoke = await runTest('ArrayInitializerSmoke', '-13\n72\n3\ntrue\ntrue', null, {
      classpath: outputDir,
      timeout: 3000,
      silent: true,
    });
    t.ok(arrayInitializerSmoke.success, 'ArrayInitializerSmoke runs on repo JVM');
    t.equal(arrayInitializerSmoke.output.trim(), '-13\n72\n3\ntrue\ntrue', 'ArrayInitializerSmoke repo JVM output matches');

    const narrowPrimitiveSmoke = await runTest('NarrowPrimitiveSmoke', '-126\n32000\nA', null, {
      classpath: outputDir,
      timeout: 3000,
      silent: true,
    });
    t.ok(narrowPrimitiveSmoke.success, 'NarrowPrimitiveSmoke runs on repo JVM');
    t.equal(narrowPrimitiveSmoke.output.trim(), '-126\n32000\nA', 'NarrowPrimitiveSmoke repo JVM output matches');

    const refCastSmoke = await runTest('RefCastSmoke', 'Hello\nnull', null, {
      classpath: outputDir,
      timeout: 3000,
      silent: true,
    });
    t.ok(refCastSmoke.success, 'RefCastSmoke runs on repo JVM');
    t.equal(refCastSmoke.output.trim(), 'Hello\nnull', 'RefCastSmoke repo JVM output matches');

    const wrapperTypesSmoke = await runTest('WrapperTypesSmoke', 'z=true\nb=-126\ns=32000\nj=42\nm=12345678901\ng=1.5\ne=2.5\nh=A', null, {
      classpath: outputDir,
      timeout: 3000,
      silent: true,
    });
    t.ok(wrapperTypesSmoke.success, 'WrapperTypesSmoke runs on repo JVM');
    t.equal(wrapperTypesSmoke.output.trim(), 'z=true\nb=-126\ns=32000\nj=42\nm=12345678901\ng=1.5\ne=2.5\nh=A', 'WrapperTypesSmoke repo JVM output matches');

    const reassignmentConversionSmoke = await runTest('ReassignmentConversionSmoke', 'done', null, {
      classpath: outputDir,
      timeout: 3000,
      silent: true,
    });
    t.ok(reassignmentConversionSmoke.success, 'ReassignmentConversionSmoke runs on repo JVM');
    t.equal(reassignmentConversionSmoke.output.trim(), 'done', 'ReassignmentConversionSmoke repo JVM output matches');

    const stringExtraSmoke = await runTest('StringExtraSmoke', 'abc\n123\n3', null, {
      classpath: outputDir,
      timeout: 3000,
      silent: true,
    });
    t.ok(stringExtraSmoke.success, 'StringExtraSmoke runs on repo JVM');
    t.equal(stringExtraSmoke.output.trim(), 'abc\n123\n3', 'StringExtraSmoke repo JVM output matches');

    const stringCompareSmoke = await runTest('StringCompareSmoke', 'lit eq: true\nnew eq: false\nneq: true', null, {
      classpath: outputDir,
      timeout: 3000,
      silent: true,
    });
    t.ok(stringCompareSmoke.success, 'StringCompareSmoke runs on repo JVM');
    t.equal(stringCompareSmoke.output.trim(), 'lit eq: true\nnew eq: false\nneq: true', 'StringCompareSmoke repo JVM output matches');

    const stringConcatSemanticsSmoke = await runTest('StringConcatSemanticsSmoke', 'true\ntrue\nfalse\ntrue\nn=3\nb=true\nz=null', null, {
      classpath: outputDir,
      timeout: 3000,
      silent: true,
    });
    t.ok(stringConcatSemanticsSmoke.success, 'StringConcatSemanticsSmoke runs on repo JVM');
    t.equal(stringConcatSemanticsSmoke.output.trim(), 'true\ntrue\nfalse\ntrue\nn=3\nb=true\nz=null', 'StringConcatSemanticsSmoke repo JVM output matches');

    const classInstanceSmoke = await runTest('ClassInstanceSmoke', 'int\njava.lang.String\n[I\ntrue\ntrue', null, {
      classpath: outputDir,
      timeout: 3000,
      silent: true,
    });
    t.ok(classInstanceSmoke.success, 'ClassInstanceSmoke runs on repo JVM');
    t.equal(classInstanceSmoke.output.trim(), 'int\njava.lang.String\n[I\ntrue\ntrue', 'ClassInstanceSmoke repo JVM output matches');

    const arrayTypeSmoke = await runTest('ArrayTypeSmoke', '2\n7\n5\nx', null, {
      classpath: outputDir,
      timeout: 3000,
      silent: true,
    });
    t.ok(arrayTypeSmoke.success, 'ArrayTypeSmoke runs on repo JVM');
    t.equal(arrayTypeSmoke.output.trim(), '2\n7\n5\nx', 'ArrayTypeSmoke repo JVM output matches');

    const genericErasureSmoke = await runTest('GenericErasureSmoke', 'generic\nbound', null, {
      classpath: outputDir,
      timeout: 3000,
      silent: true,
    });
    t.ok(genericErasureSmoke.success, 'GenericErasureSmoke runs on repo JVM');
    t.equal(genericErasureSmoke.output.trim(), 'generic\nbound', 'GenericErasureSmoke repo JVM output matches');

    const ifSmoke = await runTest('IfSmoke', 'int lt\nint le\nlong ge\ndouble ne\nbool', null, {
      classpath: outputDir,
      timeout: 3000,
      silent: true,
    });
    t.ok(ifSmoke.success, 'IfSmoke runs on repo JVM');
    t.equal(ifSmoke.output.trim(), 'int lt\nint le\nlong ge\ndouble ne\nbool', 'IfSmoke repo JVM output matches');

    const forSmoke = await runTest('ForSmoke', '10\n3\n2\n1', null, {
      classpath: outputDir,
      timeout: 3000,
      silent: true,
    });
    t.ok(forSmoke.success, 'ForSmoke runs on repo JVM');
    t.equal(forSmoke.output.trim(), '10\n3\n2\n1', 'ForSmoke repo JVM output matches');

    const whileSmoke = await runTest('WhileSmoke', '10\n3\n2\n1', null, {
      classpath: outputDir,
      timeout: 3000,
      silent: true,
    });
    t.ok(whileSmoke.success, 'WhileSmoke runs on repo JVM');
    t.equal(whileSmoke.output.trim(), '10\n3\n2\n1', 'WhileSmoke repo JVM output matches');

    const doWhileSmoke = await runTest('DoWhileSmoke', '10\n0', null, {
      classpath: outputDir,
      timeout: 3000,
      silent: true,
    });
    t.ok(doWhileSmoke.success, 'DoWhileSmoke runs on repo JVM');
    t.equal(doWhileSmoke.output.trim(), '10\n0', 'DoWhileSmoke repo JVM output matches');

    const methodCallSmoke = await runTest('MethodCallSmoke', '15\n26\n6\n8', null, {
      classpath: outputDir,
      timeout: 3000,
      silent: true,
    });
    t.ok(methodCallSmoke.success, 'MethodCallSmoke runs on repo JVM');
    t.equal(methodCallSmoke.output.trim(), '15\n26\n6\n8', 'MethodCallSmoke repo JVM output matches');

    const superSmoke = await runTest('SuperSmoke', '8', null, {
      classpath: outputDir,
      timeout: 3000,
      silent: true,
    });
    t.ok(superSmoke.success, 'SuperSmoke runs on repo JVM');
    t.equal(superSmoke.output.trim(), '8', 'SuperSmoke repo JVM output matches');

    const constructorSmoke = await runTest('ConstructorSmoke', '2\n7', null, {
      classpath: outputDir,
      timeout: 3000,
      silent: true,
    });
    t.ok(constructorSmoke.success, 'ConstructorSmoke runs on repo JVM');
    t.equal(constructorSmoke.output.trim(), '2\n7', 'ConstructorSmoke repo JVM output matches');

    const switchSmoke = await runTest('SwitchSmoke', 'one\ntwo-three\nfall\nthrough\nother', null, {
      classpath: outputDir,
      timeout: 3000,
      silent: true,
    });
    t.ok(switchSmoke.success, 'SwitchSmoke runs on repo JVM');
    t.equal(switchSmoke.output.trim(), 'one\ntwo-three\nfall\nthrough\nother', 'SwitchSmoke repo JVM output matches');

    const unarySmoke = await runTest('UnarySmoke', 'true\n-6\n-11\n-5\nnot', null, {
      classpath: outputDir,
      timeout: 3000,
      silent: true,
    });
    t.ok(unarySmoke.success, 'UnarySmoke runs on repo JVM');
    t.equal(unarySmoke.output.trim(), 'true\n-6\n-11\n-5\nnot', 'UnarySmoke repo JVM output matches');

    const tryCatchSmoke = await runTest('TryCatchSmoke', 'caught\nafter', null, {
      classpath: outputDir,
      timeout: 3000,
      silent: true,
    });
    t.ok(tryCatchSmoke.success, 'TryCatchSmoke runs on repo JVM');
    t.equal(tryCatchSmoke.output.trim(), 'caught\nafter', 'TryCatchSmoke repo JVM output matches');

    const tryCatchReturnSmoke = await runTest('TryCatchReturnSmoke', '5\n-2147483648', null, {
      classpath: outputDir,
      timeout: 3000,
      silent: true,
    });
    t.ok(tryCatchReturnSmoke.success, 'TryCatchReturnSmoke runs on repo JVM');
    t.equal(tryCatchReturnSmoke.output.trim(), '5\n-2147483648', 'TryCatchReturnSmoke repo JVM output matches');

    const argsJvm = new JVM({ classpath: outputDir });
    const getArgsOutput = setupIntegerPrintCapture(argsJvm);
    await argsJvm.run('ArgsLengthTest', { args: ['alpha', 'beta', 'gamma'] });
    t.equal(getArgsOutput().trim(), '3', 'ArgsLengthTest repo JVM output matches explicit args');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  t.end();
});

test('IR passes attach Java IR and optional JVM bytecode IR sidecars', (t) => {
  const astDocument = frontend.parseJava(SOURCE, { sourceLevel: 8 });
  const result = frontend.runAstPasses(astDocument, [
    frontend.createLowerAstToJavaIrPass(),
    frontend.createEmitJvmBytecodeIrPass({ fromJavaIr: true }),
  ]);

  t.ok(frontend.getAttachedJavaIrDocument(result), 'Java IR sidecar is attached');
  t.ok(frontend.getAttachedJvmBytecodeIrDocument(result), 'JVM bytecode IR sidecar is attached');
  t.doesNotThrow(() => frontend.serializeAst(result), 'AST with IR sidecars is serializable');
  t.end();
});

test('frontend classfile model carries class attributes', (t) => {
  const result = frontend.compileJavaSource(CLASS_ATTRIBUTES_SMOKE_SOURCE, { sourceFileName: 'ClassAttributesSmoke.java' });
  const classModel = result.classFileModel.classes.find((entry) => entry.internalName === 'ClassAttributesSmoke');
  const idMethod = classModel.methods.find((method) => method.name === 'id');
  const valueField = classModel.fields.find((field) => field.name === 'value');

  t.equal(result.bytecodeIr.status, 'complete', 'class attributes smoke compiles completely');
  t.ok(classModel.attributes.some((attribute) => attribute.type === 'SourceFile' && attribute.value === 'ClassAttributesSmoke.java'), 'SourceFile class attribute is modeled');
  t.ok(classModel.attributes.some((attribute) => attribute.type === 'Signature' && attribute.value.includes('<T:')), 'generic Signature class attribute is modeled');
  t.ok(valueField.attributes.some((attribute) => attribute.type === 'Signature' && attribute.value === 'TT;'), 'field Signature attribute is modeled');
  t.ok(idMethod.attributes.some((attribute) => attribute.type === 'Signature' && attribute.value === '(TT;)TT;'), 'method Signature attribute is modeled');
  t.end();
});
