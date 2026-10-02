'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {assembleJasminSource} = require('../src/utils/jasminAssembly');
const {decompileClassFile, assertNoFallback, _internals} = require('../src/decompiler/cfr');

function run(command, args, directory) {
  const files = ['stdout', 'stderr'].map(name => path.join(directory, name));
  const fds = files.map(file => fs.openSync(file, 'w'));
  try {
    const result = spawnSync(command, args, {stdio: ['ignore', ...fds], timeout: 15000,
      env: {...process.env, JAVA_TOOL_OPTIONS: '-XX:-UsePerfData'}});
    if (result.error) throw result.error;
    assert.equal(result.status, 0, fs.readFileSync(files[1], 'utf8'));
    return fs.readFileSync(files[0], 'utf8');
  } finally { fds.forEach(fd => fs.closeSync(fd)); }
}

const comparisons = [
  ['fcmpl', 'F', 'f', 1], ['fcmpg', 'F', 'f', 1],
  ['dcmpl', 'D', 'd', 2], ['dcmpg', 'D', 'd', 2], ['lcmp', 'J', 'l', 2],
];
const effects = `class Effects {
  static StringBuilder trace; static int failAt, calls; static Throwable failed;
  static void touch(char side) {
    trace.append(side); calls++;
    if (calls == failAt) { failed = new IllegalArgumentException(); throw (IllegalArgumentException) failed; }
  }
  static float leftF(float value) { touch('L'); return value; }
  static float rightF(float value) { touch('R'); return value; }
  static double leftD(double value) { touch('L'); return value; }
  static double rightD(double value) { touch('R'); return value; }
  static long leftJ(long value) { touch('L'); return value; }
  static long rightJ(long value) { touch('R'); return value; }
  static int accept(int value) { trace.append('A'); return value * 31; }
}`;

function assembly(stored, interfaceClass = false) {
  const name = interfaceClass ? 'ComparisonInterface' : 'ComparisonCases';
  let text = `.version ${interfaceClass ? 52 : 49} 0
    .class public ${interfaceClass ? 'interface abstract' : 'super'} ${name}
    .super java/lang/Object\n`;
  for (const [opcode, descriptor, load, slots] of comparisons) {
    const operands = `${load}load_0\n${load}load ${slots}\n${opcode}`;
    const effectOperands = `${load}load_0\ninvokestatic Method Effects left${descriptor} (${descriptor})${descriptor}
      ${load}load ${slots}\ninvokestatic Method Effects right${descriptor} (${descriptor})${descriptor}\n${opcode}`;
    const method = (suffix, body) => {
      text += `.method public static case_${opcode}_${suffix} : (${descriptor}${descriptor})I
        .code stack ${slots * 2 + 2} locals ${slots * 2 + 1}
        ${body}
        .end code
      .end method\n`;
    };
    if (stored) {
      method('stored', `${operands}\nistore ${slots * 2}\niload ${slots * 2}\nireturn`);
      method('arithmetic', `${operands}\niconst_2\nimul\nireturn`);
      method('argument', `${operands}\ninvokestatic Method Effects accept (I)I\nireturn`);
      method('effects', `${effectOperands}\nistore ${slots * 2}\niload ${slots * 2}\nireturn`);
      method('duplicate', `${effectOperands}\ndup\nistore ${slots * 2}\niload ${slots * 2}\niadd\nireturn`);
      // Generated helper names must not override pre-existing JVM methods.
      text += `.method public static $cfr$${opcode} : (${descriptor}${descriptor})I
        .code stack 1 locals ${slots * 2}
        bipush 99
        ireturn
        .end code
      .end method\n`;
    } else for (const branch of ['ifeq', 'ifne', 'iflt', 'ifle', 'ifgt', 'ifge']) {
      method(branch, `${operands}\n${branch} Ltrue\niconst_0\nireturn\nLtrue:\niconst_1\nireturn`);
      method(branch + '_inverted', `${operands}\n${branch} Lfalse\niconst_1\nireturn\nLfalse:\niconst_0\nireturn`);
      method(branch + '_materialized', `${operands}\n${branch} Ltrue\niconst_0\ngoto Ljoin
        Ltrue:\niconst_1\nLjoin:\nifeq Lfalse\nbipush 7\nireturn\nLfalse:\nbipush 11\nireturn`);
      method(branch + '_nested', `${operands}\n${branch} LfirstFalse\niconst_1\ngoto Ljoin
        LfirstFalse:\n${operands}\nifeq LsecondTrue\niconst_0\ngoto Ljoin
        LsecondTrue:\niconst_1\nLjoin:\nifeq Lfalse\nbipush 7\nireturn\nLfalse:\nbipush 11\nireturn`);
      method(branch + '_effects', `${effectOperands}\n${branch} Ltrue\niconst_0\nireturn\nLtrue:\niconst_1\nireturn`);
    }
  }
  return text + '.end class\n';
}

function driver(className) {
  return `import java.lang.reflect.*; import java.util.*;
    class ComparisonRunner { public static void main(String[] args) throws Exception {
      Method[] methods = ${className}.class.getDeclaredMethods();
      Arrays.sort(methods, Comparator.comparing(Method::getName));
      for (Method method : methods) {
        if (!method.getName().startsWith("case_")) continue;
        Class<?> type = method.getParameterTypes()[0];
        List<Object> values = new ArrayList<>();
        if (type == float.class) for (int bits : new int[]{0,0x80000000,1,0x80000001,
          0x3f800000,0xbf800000,0x7f7fffff,0xff7fffff,0x7f800000,0xff800000,0x7fc01234,0xffc05678})
          values.add(Float.intBitsToFloat(bits));
        else if (type == double.class) for (long bits : new long[]{0,0x8000000000000000L,1,0x8000000000000001L,
          0x3ff0000000000000L,0xbff0000000000000L,0x7fefffffffffffffL,0xffefffffffffffffL,
          0x7ff0000000000000L,0xfff0000000000000L,0x7ff8000000001234L,0xfff8000000005678L})
          values.add(Double.longBitsToDouble(bits));
        else for (long value : new long[]{Long.MIN_VALUE,Long.MIN_VALUE+1,-1,0,1,Long.MAX_VALUE-1,Long.MAX_VALUE})
          values.add(value);
        for (int i = 0; i < values.size(); i++) for (int j = 0; j < values.size(); j++)
          for (int failAt = 0; failAt <= (method.getName().contains("effects") || method.getName().contains("duplicate") ? 2 : 0); failAt++) {
            Effects.trace = new StringBuilder(); Effects.calls = 0; Effects.failAt = failAt; Effects.failed = null;
            String result;
            try { result = "" + method.invoke(null, values.get(i), values.get(j)); }
            catch (InvocationTargetException error) { Throwable cause = error.getCause();
              result = cause.getClass().getSimpleName()+":"+(cause == Effects.failed); }
            System.out.println(method.getName()+":"+i+":"+j+":"+failAt+":"+result+":"+Effects.trace);
          }
      }
    } }`;
}

for (const [stored, interfaceClass] of [[false, false], [true, false], [true, true]]) {
  test(`JVM comparison ${stored ? 'stored values' : 'branches'} preserve NaN, zero and effects${interfaceClass ? ' in interfaces' : ''}`, () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-floating-comparisons-'));
    const previous = process.env.CFR_JS_FORCE_STATE_MACHINE;
    try {
      const native = path.join(temporary, 'native'); fs.mkdirSync(native);
      const name = interfaceClass ? 'ComparisonInterface' : 'ComparisonCases';
      const classFile = path.join(native, name + '.class');
      assembleJasminSource(assembly(stored, interfaceClass), classFile);
      const runner = driver(name);
      for (const [file, source] of Object.entries({Effects: effects, ComparisonRunner: runner}))
        fs.writeFileSync(path.join(native, file + '.java'), source);
      run('javac', ['--release', '8', '-classpath', native, '-d', native,
        path.join(native, 'Effects.java'), path.join(native, 'ComparisonRunner.java')], native);
      const expected = run('java', ['-cp', native, 'ComparisonRunner'], native);
      assert.equal(expected.trim().split('\n').length, (4 * 144 + 49) * (stored ? 9 : 42));
      assert.match(expected, /IllegalArgumentException:true:L\n/);
      assert.match(expected, /IllegalArgumentException:true:LR\n/);
      for (const forced of [false, true]) {
        if (forced) process.env.CFR_JS_FORCE_STATE_MACHINE = '1'; else delete process.env.CFR_JS_FORCE_STATE_MACHINE;
        const source = decompileClassFile(classFile); assertNoFallback(source);
        const rebuilt = path.join(temporary, forced ? 'forced' : 'structured'); fs.mkdirSync(rebuilt);
        for (const [file, text] of Object.entries({[name]: source, Effects: effects, ComparisonRunner: runner}))
          fs.writeFileSync(path.join(rebuilt, file + '.java'), text);
        run('javac', ['--release', '8', '-d', rebuilt,
          ...[name, 'Effects', 'ComparisonRunner'].map(file => path.join(rebuilt, file + '.java'))], rebuilt);
        const actual = run('java', ['-cp', rebuilt, 'ComparisonRunner'], rebuilt);
        const expectedLines = expected.trim().split('\n'), actualLines = actual.trim().split('\n');
        assert.equal(actualLines.length, expectedLines.length);
        expectedLines.forEach((line, index) => assert.equal(actualLines[index], line,
          `${name}, forced=${forced}, comparison=${index}`));
        if (stored) for (const [opcode] of comparisons) {
          assert.match(source, new RegExp('static int \\$cfr\\$' + opcode + '\\$1\\('));
          assert.equal((source.match(new RegExp('static int \\$cfr\\$' + opcode + '\\$1\\(', 'g')) || []).length, 1);
        }
      }
    } finally {
      if (previous === undefined) delete process.env.CFR_JS_FORCE_STATE_MACHINE;
      else process.env.CFR_JS_FORCE_STATE_MACHINE = previous;
      fs.rmSync(temporary, {recursive: true, force: true});
    }
  });
}

test('negating a comparison without integral type evidence preserves logical negation', () => {
  assert.equal(_internals.negateBooleanExpression({code: 'left < right', type: 'boolean', precedence: 60}).code,
    '!(left < right)');
});
