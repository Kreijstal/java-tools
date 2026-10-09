'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {decompileClassFile, assertNoFallback, _internals: ir} = require('../src/decompiler/cfr');

const value = (code, type = 'int') => ({code, type, precedence: 100});
function withoutExperimental(action) {
  const previous = process.env.PIPELINE_EXPERIMENTAL_INTERCLASS_DCE;
  delete process.env.PIPELINE_EXPERIMENTAL_INTERCLASS_DCE;
  try { return action(); }
  finally {
    if (previous === undefined) delete process.env.PIPELINE_EXPERIMENTAL_INTERCLASS_DCE;
    else process.env.PIPELINE_EXPERIMENTAL_INTERCLASS_DCE = previous;
  }
}

test('typed complements simplify by default without enabling identity folding', () => withoutExperimental(() => {
  const complemented = ir.binaryExpr(value('readValue()'), '^', value('-1'), 'int');
  assert.equal(complemented.code, '~readValue()');
  assert.equal(ir.simplifyBitwiseComplementComparison(complemented, '<=', value('-129')).code,
    'readValue() >= 128');
  assert.equal(ir.simplifyBitwiseComplementComparison(value('-161'), '<', complemented).code,
    'readValue() < 160');
  const wide = ir.binaryExpr(value('-1L', 'long'), '^', value('readWide()', 'long'), 'long');
  assert.equal(ir.simplifyBitwiseComplementComparison(wide, '==',
    value('-9223372036854775808L', 'long')).code, 'readWide() == 9223372036854775807L');
  assert.equal(ir.binaryExpr(value('readValue()'), '+', value('0'), 'int').code, 'readValue() + 0');
}));

test('complement reconstruction refuses effects, narrowing, wrong widths and other XOR masks', () => withoutExperimental(() => {
  const complemented = ir.binaryExpr(value('x'), '^', value('-1'), 'int');
  for (const constant of [value('readConstant()'), {...value('readConstant()'), constantValue: 5},
    value('5L', 'long'), value('5.0f', 'float'), value('4294967295'), value('010'), value('true', 'boolean')])
    assert.equal(ir.simplifyBitwiseComplementComparison(complemented, '<', constant), null);
  assert.equal(ir.simplifyBitwiseComplementComparison(complemented, '+', value('5')), null);
  assert.equal(ir.simplifyBitwiseComplementComparison(value('(byte) ~x', 'byte'), '<', value('5')), null);
  assert.equal(ir.binaryExpr(value('x'), '^', {...value('readMask()'), constantValue: -1}, 'int').code,
    'x ^ readMask()');
  assert.equal(ir.binaryExpr(value('x'), '^', value('85'), 'int').code, 'x ^ 85');
  assert.equal(ir.binaryExpr(value('flag', 'boolean'), '^', value('true', 'boolean'), 'boolean').code,
    'flag ^ true');
  const wide = ir.binaryExpr(value('wide', 'long'), '^', value('-1L', 'long'), 'long');
  assert.equal(ir.simplifyBitwiseComplementComparison(wide, '<',
    value('9223372036854775808L', 'long')), null);
  assert.equal(ir.binaryExpr(value('fraction', 'float'), '^', value('-1'), 'int').bitwiseComplement, undefined);
}));

function run(command, args, directory) {
  const files = ['stdout', 'stderr'].map(name => path.join(directory, name));
  const fds = files.map(file => fs.openSync(file, 'w'));
  try {
    const result = spawnSync(command, args, {stdio: ['ignore', ...fds], timeout: 30000,
      env: {...process.env, JAVA_TOOL_OPTIONS: '-XX:-UsePerfData'}});
    if (result.error) throw result.error;
    assert.equal(result.status, 0, fs.readFileSync(files[1], 'utf8'));
    return fs.readFileSync(files[0], 'utf8');
  } finally { fds.forEach(fd => fs.closeSync(fd)); }
}

test('original JVM and rebuilt complements match signed boundaries, calls and exceptions', () => withoutExperimental(() => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-complements-'));
  const previous = process.env.CFR_JS_FORCE_STATE_MACHINE;
  try {
    const constants = ['MIN_VALUE', '-129', '-1', '0', '1', '5', '127', '128', 'MAX_VALUE'];
    const operators = ['==', '!=', '<', '<=', '>', '>='];
    const methods = [];
    for (const type of ['int', 'long']) for (const [index, token] of constants.entries())
      for (const [opIndex, operator] of operators.entries()) for (const first of [false, true]) {
        const constant = token.endsWith('_VALUE') ? `${type === 'int' ? 'Integer' : 'Long'}.${token}`
          : token + (type === 'long' ? 'L' : '');
        const complement = `(Effects.${type}Value(x) ^ ${type === 'long' ? '-1L' : '-1'})`;
        methods.push(`public static int ${type}_${index}_${opIndex}_${first}(${type} x) {
          return ${first ? `${constant} ${operator} ${complement}` : `${complement} ${operator} ${constant}`} ? 1 : 0;
        }`);
      }
    methods.push(`public static int narrowed(int x) { return (byte)(Effects.intValue(x) ^ -1) < 5 ? 1 : 0; }`,
      `public static int mask(int x) { return (Effects.intValue(x) ^ 85) >= -129 ? 1 : 0; }`,
      `public static int both(int x) { return (Effects.intValue(x) ^ -1) < (Effects.intValue(x+1) ^ -1) ? 1 : 0; }`,
      `public static int identity(int x) { return Effects.intValue(x) + 0; }`);
    const effects = `class Effects {
      static StringBuilder trace; static boolean fail;
      static int intValue(int x) { trace.append("i:").append(x).append(',');
        if(fail) throw new IllegalArgumentException(); return x; }
      static long longValue(long x) { trace.append("l:").append(x).append(',');
        if(fail) throw new IllegalArgumentException(); return x; }
    }`;
    const driver = `import java.lang.reflect.*; import java.util.*;
    class ComplementRunner { public static void main(String[] args) throws Exception {
      Method[] methods=ComplementCases.class.getDeclaredMethods();
      Arrays.sort(methods, Comparator.comparing(Method::getName));
      for(Method method:methods) {
        boolean wide=method.getParameterTypes()[0]==long.class;
        long[] inputs={wide?Long.MIN_VALUE:Integer.MIN_VALUE, wide?Long.MIN_VALUE+1:Integer.MIN_VALUE+1,
          -161,-160,-129,-128,-1,0,1,5,126,127,128,129,wide?Long.MAX_VALUE:Integer.MAX_VALUE};
        for(int n=0;n<=inputs.length;n++) {
          Effects.trace=new StringBuilder(); Effects.fail=n==inputs.length;
          long input=inputs[n%inputs.length]; Object argument;
          if(wide) argument=Long.valueOf(input); else argument=Integer.valueOf((int)input);
          String result;
          try { result=""+method.invoke(null,argument); }
          catch(InvocationTargetException error) { result=error.getCause().getClass().getSimpleName(); }
          System.out.println(method.getName()+":"+input+":"+result+":"+Effects.trace);
        }
      }
    } }`;
    const native = path.join(temporary, 'native'); fs.mkdirSync(native);
    fs.writeFileSync(path.join(native, 'ComplementCases.java'),
      `public class ComplementCases { ${methods.join('\n')} }`);
    fs.writeFileSync(path.join(native, 'Effects.java'), effects);
    fs.writeFileSync(path.join(native, 'ComplementRunner.java'), driver);
    run('javac', ['--release', '8', '-d', native, ...['ComplementCases','Effects','ComplementRunner']
      .map(name => path.join(native, name+'.java'))], native);
    const expected = run('java', ['-cp', native, 'ComplementRunner'], native);
    assert.equal(expected.trim().split('\n').length, 220 * 16);
    assert.match(expected, /IllegalArgumentException/);
    for (const forced of [false, true]) {
      if (forced) process.env.CFR_JS_FORCE_STATE_MACHINE = '1'; else delete process.env.CFR_JS_FORCE_STATE_MACHINE;
      const source = decompileClassFile(path.join(native, 'ComplementCases.class'));
      assertNoFallback(source);
      assert.doesNotMatch(source, /\^ -1(?:L)?\b/);
      assert.match(source, /Effects\.intValue\(\w+\) \+ 0/);
      const rebuilt = path.join(temporary, forced ? 'forced' : 'structured'); fs.mkdirSync(rebuilt);
      fs.writeFileSync(path.join(rebuilt, 'ComplementCases.java'), source);
      fs.writeFileSync(path.join(rebuilt, 'Effects.java'), effects);
      fs.writeFileSync(path.join(rebuilt, 'ComplementRunner.java'), driver);
      run('javac', ['--release', '8', '-d', rebuilt, ...['ComplementCases','Effects','ComplementRunner']
        .map(name => path.join(rebuilt, name+'.java'))], rebuilt);
      assert.equal(run('java', ['-cp', rebuilt, 'ComplementRunner'], rebuilt), expected);
    }
  } finally {
    if (previous === undefined) delete process.env.CFR_JS_FORCE_STATE_MACHINE;
    else process.env.CFR_JS_FORCE_STATE_MACHINE = previous;
    fs.rmSync(temporary, {recursive:true, force:true});
  }
}));
