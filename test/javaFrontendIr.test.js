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
    ['sources/SimpleStringConcat.java', ['new', 'dup', 'invokevirtual']],
    ['sources/StringConcat.java', ['new', 'dup', 'invokevirtual']],
    ['sources/SimplestCrash.java', ['newarray', 'astore']],
    ['sources/SimpleStringTest.java', ['new', 'dup', 'invokespecial']],
    ['sources/MethodInvocationValidationTest.java', ['new', 'dup', 'invokevirtual']],
    ['sources/StaticVsInstanceTest.java', ['new', 'dup', 'invokevirtual']],
    ['sources/LongArithmeticTest.java', ['lstore', 'lload', 'ladd', 'lsub', 'lmul', 'ldiv']],
    ['sources/ConversionTest.java', ['lstore', 'lload', 'l2i', 'istore']],
    ['sources/TypeConversionTest.java', ['i2l', 'i2f', 'i2d', 'lstore', 'fstore', 'dstore']],
    ['sources/ObscureNumbers.java', ['ldc2_w', 'lstore', 'lload']],
    ['sources/BitwiseOperationsTest.java', ['ishr', 'iushr', 'iand', 'ior', 'ixor']],
    ['sources/LongBitwiseTest.java', ['land', 'lor', 'lxor', 'lshl', 'lshr', 'lushr']],
    ['sources/ObjectCreationTest.java', ['putfield', 'getfield', 'invokevirtual']],
  ];

  for (const [file, expectedOpcodes] of files) {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    const result = frontend.compileJavaSource(source, { sourceFileName: path.basename(file) });
    const main = result.bytecodeIr.classes[0].methods.find((method) => method.name === 'main');
    const opcodes = result.bytecodeIr.classes[0].methods.flatMap((method) => method.instructions.map((instruction) => instruction.opcode));
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
  ];

  for (const [file, expectedOpcodes] of files) {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    const result = frontend.compileJavaSource(source, { sourceFileName: path.basename(file) });
    const opcodes = result.bytecodeIr.classes[0].methods.flatMap((method) => method.instructions.map((instruction) => instruction.opcode));
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
  const intOpcodes = intResult.bytecodeIr.classes[0].methods.find((method) => method.name === 'main').instructions.map((instruction) => instruction.opcode);
  const refOpcodes = refResult.bytecodeIr.classes[0].methods.find((method) => method.name === 'main').instructions.map((instruction) => instruction.opcode);

  t.equal(intResult.bytecodeIr.status, 'complete', 'int array smoke compiles completely');
  t.ok(intOpcodes.includes('newarray'), 'int array creation is emitted');
  t.ok(intOpcodes.includes('iastore'), 'int array store is emitted');
  t.ok(intOpcodes.includes('iaload'), 'int array load is emitted');
  t.equal(refResult.bytecodeIr.status, 'complete', 'reference array smoke compiles completely');
  t.ok(refOpcodes.includes('anewarray'), 'reference array creation is emitted');
  t.ok(refOpcodes.includes('aastore'), 'reference array store is emitted');
  t.ok(refOpcodes.includes('aaload'), 'reference array load is emitted');
  t.end();
});

test('narrow primitives and reference casts compile through IR', (t) => {
  const narrowResult = frontend.compileJavaSource(NARROW_PRIMITIVE_SMOKE_SOURCE, { sourceFileName: 'NarrowPrimitiveSmoke.java' });
  const castResult = frontend.compileJavaSource(REF_CAST_SMOKE_SOURCE, { sourceFileName: 'RefCastSmoke.java' });
  const wrapperResult = frontend.compileJavaSource(WRAPPER_TYPES_SMOKE_SOURCE, { sourceFileName: 'WrapperTypesSmoke.java' });
  const reassignmentResult = frontend.compileJavaSource(REASSIGNMENT_CONVERSION_SMOKE_SOURCE, { sourceFileName: 'ReassignmentConversionSmoke.java' });
  const narrowOpcodes = narrowResult.bytecodeIr.classes[0].methods.find((method) => method.name === 'main').instructions.map((instruction) => instruction.opcode);
  const castOpcodes = castResult.bytecodeIr.classes[0].methods.find((method) => method.name === 'main').instructions.map((instruction) => instruction.opcode);
  const reassignmentOpcodes = reassignmentResult.bytecodeIr.classes[0].methods.find((method) => method.name === 'main').instructions.map((instruction) => instruction.opcode);
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
    ['sources/SimplestCrash.java', 'SimplestCrash', expectedOutputForClass('SimplestCrash')],
    ['sources/SimpleStringTest.java', 'SimpleStringTest', expectedOutputForClass('SimpleStringTest')],
    ['sources/MethodInvocationValidationTest.java', 'MethodInvocationValidationTest', expectedOutputForClass('MethodInvocationValidationTest')],
    ['sources/StaticVsInstanceTest.java', 'StaticVsInstanceTest', expectedOutputForClass('StaticVsInstanceTest')],
    ['sources/LongArithmeticTest.java', 'LongArithmeticTest', expectedOutputForClass('LongArithmeticTest')],
    ['sources/ConversionTest.java', 'ConversionTest', expectedOutputForClass('ConversionTest')],
    ['sources/TypeConversionTest.java', 'TypeConversionTest', expectedOutputForClass('TypeConversionTest')],
    ['sources/ObscureNumbers.java', 'ObscureNumbers', expectedOutputForClass('ObscureNumbers')],
    ['sources/BitwiseOperationsTest.java', 'BitwiseOperationsTest', expectedOutputForClass('BitwiseOperationsTest')],
    ['sources/LongBitwiseTest.java', 'LongBitwiseTest', expectedOutputForClass('LongBitwiseTest')],
    ['sources/ObjectCreationTest.java', 'ObjectCreationTest', expectedOutputForClass('ObjectCreationTest')],
    ['sources/SimplestSipushCrash.java', 'SimplestSipushCrash', expectedOutputForClass('SimplestSipushCrash')],
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
