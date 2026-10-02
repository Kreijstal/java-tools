'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {treeToStatements, emitStatements, promoteBooleanStackCarriers, factorCommonBranchTails} = require('../src/decompiler/javaAstEmitter');
const {printTree} = require('../src/decompiler/structurer');
const {JavaParser} = require('../src/java-frontend/parser');
const {decompileClassFile, assertNoFallback} = require('../src/decompiler/cfr');

const seq = (...body) => ({t: 'seq', body});
const straight = block => ({t: 'straight', block});
const jump = (t, label) => ({t, label});
function candidate(exitTree, trailing = false) {
  return {t: 'loop', label: 'Outer', body: seq(straight(0), {
    t: 'if', block: 0, then: trailing ? seq() : exitTree,
    els: seq(straight(2), jump('continue', 'Outer')),
  }, ...(trailing ? [exitTree] : []))};
}
const render = {
  straight: block => ({0: [], 1: ["trace.append('i'); count++;"],
    2: ["trace.append('o'); if (++count > limit + 10) return count+\":\"+trace;"],
    3: ["trace.append('t'); if ((count & 1) == 0) throw new IllegalArgumentException();"],
    4: ['return count+":"+trace;'], 5: ["trace.append('c');"]}[block]),
  cond: () => 'count < limit',
  condInverted: () => 'count >= limit',
  blockTerminates: block => block === 4,
};
const emitted = tree => emitStatements(treeToStatements(tree, render));

for (const kind of ['loop', 'block']) {
  test(`a break consumed by an inner ${kind} cannot justify rotating an outer exit`, () => {
    const exit = {t: kind, label: 'Inner', body: seq(straight(1), jump('break', 'Inner'))};
    assert.match(emitted(candidate(exit)), /Outer: while \(true\)/);
  });
}

test('a conditional break from an inner loop still allows normal completion', () => {
  const exit = {t: 'loop', label: 'Inner', body: seq(straight(1), {
    t: 'if', block: 0, then: jump('break', 'Inner'), els: jump('continue', 'Inner'),
  })};
  assert.match(emitted(candidate(exit)), /Outer: while \(true\)/);
});

test('normally completing trailing statements remain inside the outer loop', () => {
  const exit = {t: 'loop', label: 'Inner', body: seq(straight(1), jump('break', 'Inner'))};
  assert.match(emitted(candidate(exit, true)), /Outer: while \(true\)/);
});

test('breaks in catch and synchronized bodies stay bound to their inner loop', () => {
  for (const guarded of [
    {t: 'try', body: straight(3), catches: [{types: ['IllegalArgumentException'],
      varName: 'error', body: jump('break', 'Inner')}]},
    {t: 'synchronized', lockLocal: 0, body: jump('break', 'Inner')},
  ]) {
    const exit = {t: 'loop', label: 'Inner', body: seq(straight(1), guarded)};
    assert.match(emitted(candidate(exit)), /Outer: while \(true\)/);
  }
});

test('real returns and loops without an internal break still permit rotation', () => {
  for (const exit of [straight(4),
    {t: 'loop', label: 'Inner', body: seq(straight(4), jump('continue', 'Inner'))},
    {t: 'block', label: 'Inner', body: jump('break', 'Enclosing')},
  ]) assert.match(emitted({t: 'block', label: 'Enclosing', body: candidate(exit)}),
    /Outer: while \(count >= limit\)/);
});

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

test('emitted nested-loop and protected exits match native Java effect order', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-emitter-loop-exits-'));
  try {
    const variants = [
      {tree: seq(straight(1), jump('break', 'Inner')),
        source: "trace.append('i'); count++; break inner;"},
      {tree: seq(straight(1), {t: 'try', body: straight(3), catches: [
        {types: ['IllegalArgumentException'], varName: 'error',
          body: seq(straight(5), jump('break', 'Inner'))},
      ]}, jump('break', 'Inner')),
        source: `trace.append('i'); count++; try {
          trace.append('t'); if ((count & 1) == 0) throw new IllegalArgumentException(); }
          catch (IllegalArgumentException error) { trace.append('c'); break inner; } break inner;`},
      {tree: {t: 'synchronized', lockLocal: 0,
        body: seq(straight(1), jump('break', 'Inner'))},
        source: "synchronized (lock0) { trace.append('i'); count++; break inner; }"},
      {tree: seq(straight(1), jump('break', 'Inner')), trailing: true,
        source: "trace.append('i'); count++; break inner;"},
    ];
    for (const [index, variant] of variants.entries()) {
      const native = `outer: while (true) { if (count < limit) {
        inner: while (true) { ${variant.source} }
      } else { trace.append('o'); if (++count > limit + 10) return count+":"+trace;
        continue outer; } }`;
      const rebuilt = printTree(candidate({t: 'loop', label: 'Inner', body: variant.tree},
        variant.trailing), render);
      const methods = {original: native, rebuilt};
      const source = `public class LoopExit${index} {
        ${Object.entries(methods).map(([name, body]) => `static String ${name}(int limit) {
          int count = 0; StringBuilder trace = new StringBuilder();
          Object lock0 = new Object(); ${body} }`).join('\n')}
        public static void main(String[] args) {
          for (int limit = -5; limit <= 100; limit++) {
            String expected = original(limit), actual = rebuilt(limit);
            if (!expected.equals(actual)) throw new AssertionError(limit+":"+expected+":"+actual);
            System.out.println(limit+":"+actual);
          }
        }
      }`;
      const javaFile = path.join(temporary, `LoopExit${index}.java`);
      fs.writeFileSync(javaFile, source);
      run('javac', ['--release', '8', '-d', temporary, javaFile], temporary);
      assert.equal(run('java', ['-cp', temporary, `LoopExit${index}`], temporary)
        .trim().split('\n').length, 106);
    }
  } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
});

test('early-exit lowering renders both arms in their original order', () => {
  const calls = [];
  const output = emitStatements(treeToStatements({t: 'if', block: 0,
    then: straight(1), els: straight(2)}, {
    cond: () => { calls.push('condition'); return 'pick()'; },
    straight: id => { calls.push(id); return [id === 1 ? 'work();' : 'return 7;']; },
    condInverted: () => { calls.push('inverse'); return '!pick()'; },
  }));
  assert.deepEqual(calls, ['condition', 1, 2, 'inverse']);
  assert.match(output, /if \(!pick\(\)\) \{\s+return 7;\s+\}\s+work\(\);/);
  assert.doesNotMatch(output, /else/);
});

test('scope and exit proofs parse every statement and reject trailing input', () => {
  const parser = new JavaParser();
  assert.throws(() => parser.parseStatement('{ return 1; } int hidden = 2;',
    {requireComplete: true}), /trailing tokens/);
  // Keep the existing public parser's permissive default for its other users.
  assert.equal(parser.parseStatement('return 1; return 2;').kind, 'ReturnStatement');
  const renderSources = (thenSource, elseSource) => emitStatements(treeToStatements({
    t: 'if', block: 0, then: straight(1), els: straight(2),
  }, {cond: () => 'test', straight: id => [id === 1 ? thenSource : elseSource]}));
  assert.match(renderSources('if (nested)\nreturn 1;', 'work();'), /else/);
  assert.match(renderSources('Inner: { break Inner; }', 'work();'), /else/);
  assert.match(renderSources('return 1;', 'work(); int value = 7; use(value);'),
    /\}\s+\{\s+work\(\); int value = 7;/);
  assert.match(renderSources('return 1;', 'class Value {} use(new Value());'),
    /\}\s+\{\s+class Value/);
  assert.doesNotMatch(renderSources('if (nested) return 1; else return 2;', 'work();'), /\} else \{\s+work/);
  assert.match(renderSources('work();', 'return 2;'), /if \(!\(test\)\)/);
  const shorterGuard = emitStatements(treeToStatements({t: 'if', block: 0,
    then: {t: 'if', block: 1, then: straight(1), els: straight(2)},
    els: straight(3)}, {
    cond: id => id ? 'nested' : 'test',
    straight: id => [`return ${id};`],
  }));
  assert.match(shorterGuard, /^if \(!\(test\)\) \{\s+return 3;\s+\}\s+if \(nested\)/);
});

test('early exits preserve native scopes, effects, NaNs and protected transfers', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-emitter-early-exits-'));
  try {
    const values = [-Infinity, -2147483648, -7, -0, 0, 7, 2147483647, Infinity, NaN];
    const variants = [
      {then: "trace.append('a'); return done(1, trace);",
        els: "trace.append('b');", tail: "trace.append('z'); return done(2, trace);"},
      {then: "trace.append('a');", els: "trace.append('b'); return done(2, trace);",
        tail: "trace.append('z'); return done(1, trace);", invert: true},
      {then: "if (x < -3) { trace.append('n'); return done(1, trace); } else { trace.append('p'); return done(2, trace); }",
        els: "trace.append('b'); return done(3, trace);", tail: ''},
      {then: 'return done(1, trace);', els: "trace.append('b'); int value = 7; trace.append(value);",
        tail: 'int value = 3; trace.append(value); return done(value, trace);', scope: true},
      {then: 'return done(1, trace);',
        els: 'class Value { int get() { return 7; } } trace.append(new Value().get());',
        tail: 'class Value { int get() { return 3; } } trace.append(new Value().get()); return done(3, trace);', scope: true},
      {then: "trace.append('a'); if (x < -3)\nreturn done(1, trace);", els: "trace.append('b');",
        tail: "trace.append('z'); return done(2, trace);", keepsElse: true},
      {then: "Inner: { trace.append('a'); break Inner; }", els: "trace.append('b');",
        tail: "trace.append('z'); return done(2, trace);", keepsElse: true},
      {then: "synchronized (lock0) { if (!Thread.holdsLock(lock0)) throw new AssertionError(); trace.append('a'); return done(1, trace); }",
        els: "if (Thread.holdsLock(lock0)) throw new AssertionError(); trace.append('b');",
        tail: 'return done(2, trace);'},
      {then: "try { trace.append('t'); if (x < -3) throw failure; return done(1, trace); } catch (IllegalArgumentException caught) { if (caught != failure) throw new AssertionError(); trace.append('c'); return done(2, trace); }",
        els: "trace.append('b');", tail: 'return done(3, trace);'},
      {then: "trace.append('t'); throw failure;", els: "trace.append('b');",
        tail: 'return done(3, trace);'},
    ];
    const methods = [];
    variants.forEach((variant, index) => {
      const rebuilt = emitStatements(treeToStatements({t: 'if', block: 0,
        then: straight(1), els: straight(2)}, {
        cond: () => 'pick(x, trace)',
        // This is the exact complement, including NaN; >= is not the
        // complement of a floating-point < comparison.
        condInverted: variant.invert ? () => '!pick(x, trace)' : undefined,
        straight: id => [id === 1 ? variant.then : variant.els],
      }));
      if (variant.keepsElse) assert.match(rebuilt, /else/);
      else assert.doesNotMatch(rebuilt, /^\} else \{/m);
      if (variant.scope) assert.match(rebuilt, /\}\s+\{/);
      if (variant.invert) assert.match(rebuilt, /if \(!pick\(x, trace\)\)/);
      const original = `if (pick(x, trace)) { ${variant.then} } else { ${variant.els} }`;
      for (const [name, body] of [['original', original], ['rebuilt', rebuilt]]) {
        methods.push(`static String ${name}${index}(double x, Object lock0, IllegalArgumentException failure) {
          StringBuilder trace = new StringBuilder();
          try { ${body} ${variant.tail} } catch (IllegalArgumentException caught) {
            if (caught != failure) throw new AssertionError();
            return done(99, trace);
          }
        }`);
      }
    });
    const source = `public class EarlyExits {
      static boolean pick(double x, StringBuilder trace) { trace.append('q'); return x <= 0; }
      static String done(int result, StringBuilder trace) { return result+":"+trace; }
      ${methods.join('\n')}
      public static void main(String[] args) {
        Object lock = new Object(); IllegalArgumentException failure = new IllegalArgumentException();
        double[] values = {Double.NEGATIVE_INFINITY, -2147483648d, -7d, -0d, 0d,
          7d, 2147483647d, Double.POSITIVE_INFINITY, Double.NaN};
        for (double value : values) {
          ${variants.map((_, index) => `{
            String expected = original${index}(value, lock, failure);
            String actual = rebuilt${index}(value, lock, failure);
            if (!expected.equals(actual) || Thread.holdsLock(lock))
              throw new AssertionError(${index}+":"+value+":"+expected+":"+actual);
            System.out.println(${index}+":"+value+":"+actual);
          }`).join('\n')}
        }
      }
    }`;
    const javaFile = path.join(temporary, 'EarlyExits.java');
    fs.writeFileSync(javaFile, source);
    run('javac', ['--release', '8', '-d', temporary, javaFile], temporary);
    assert.equal(run('java', ['-cp', temporary, 'EarlyExits'], temporary)
      .trim().split('\n').length, variants.length * values.length);
  } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
});

test('a retained declaration block does not acquire an unreachable default return', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-emitter-scoped-return-'));
  try {
    const native = path.join(temporary, 'native');
    const rebuilt = path.join(temporary, 'rebuilt');
    fs.mkdirSync(native); fs.mkdirSync(rebuilt);
    const source = `public class ScopedReturn {
      public static int run(int count, boolean early) {
        try {
          if (early) return 52;
          else {
            int total = 0;
            for (int index = 0; index < count; index++) total += 7 / (index - 2);
            return total;
          }
        } catch (RuntimeException failure) { return -99; }
      }
    }`;
    const javaFile = path.join(native, 'ScopedReturn.java');
    fs.writeFileSync(javaFile, source);
    run('javac', ['--release', '8', '-d', native, javaFile], temporary);
    const decompiled = decompileClassFile(path.join(native, 'ScopedReturn.class'));
    assertNoFallback(decompiled);
    fs.writeFileSync(path.join(rebuilt, 'ScopedReturn.java'), decompiled);
    const driver = `class ScopeRunner {
      public static void main(String[] args) {
        for (int count = -5; count <= 15; count++) for (boolean early : new boolean[]{false,true})
          System.out.println(count+":"+early+":"+ScopedReturn.run(count,early));
      }
    }`;
    for (const directory of [native, rebuilt]) {
      fs.writeFileSync(path.join(directory, 'ScopeRunner.java'), driver);
      run('javac', ['--release', '8', '-d', directory,
        path.join(directory, 'ScopedReturn.java'), path.join(directory, 'ScopeRunner.java')], temporary);
    }
    const expected = run('java', ['-cp', native, 'ScopeRunner'], temporary);
    assert.equal(expected.trim().split('\n').length, 42);
    assert.equal(run('java', ['-cp', rebuilt, 'ScopeRunner'], temporary), expected);
  } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
});

test('value-producing branches require identical primitive arms and a proven local type', () => {
  const renderPair = (taken, other, type = 'int') => emitStatements(treeToStatements({
    t: 'if', block: 0, then: straight(1), els: straight(2),
  }, {cond: () => 'pick()', straight: id => [id === 1 ? taken : other],
    localType: name => name === 'value' ? type : null}));
  assert.equal(renderPair('value = 0;', 'value = 1;'), 'value = (pick()) ? 0 : 1;');
  assert.equal(renderPair('value = true;', 'value = false;', 'boolean'),
    'value = (pick()) ? true : false;');
  assert.equal(renderPair('value = -0x8000000000000000L;', 'value = 0b1L;', 'long'),
    'value = (pick()) ? -0x8000000000000000L : 0b1L;');
  // Java allows these separately assigned constants; a conditional expression
  // can introduce narrowing, numeric promotion, rounding, or unboxing.
  for (const [taken, other, type] of [
    ['value = 0;', 'value = 1;', null],
    ['value = 0;', 'value = 1;', 'byte'],
    ['value = 0;', 'value = 65535;', 'char'],
    ['value = 0;', 'value = 1;', 'short'],
    ['value = 16777217;', 'value = 1.0f;', 'double'],
    ['value = 9007199254740993L;', 'value = 1.0;', 'double'],
    ['value = true;', 'value = false;', 'Boolean'],
    ['value = null;', 'value = 1;', 'Integer'],
    ['value = left();', 'value = right();', 'int'],
    ['value += 0;', 'value += 1;', 'int'],
    ['value = 0; work();', 'value = 1;', 'int'],
    ['{ value = 0; }', 'value = 1;', 'int'],
    ['holder.value = 0;', 'holder.value = 1;', 'int'],
    ['array[index()] = 0;', 'array[index()] = 1;', 'int'],
    ['int value = 0;', 'int value = 1;', 'int'],
    ['value = 0;', 'different = 1;', 'int'],
  ]) assert.match(renderPair(taken, other, type), /else/, `${taken} / ${other} / ${type}`);
  const calls = [];
  emitStatements(treeToStatements({t: 'if', block: 0, then: straight(1), els: straight(2)}, {
    cond: () => { calls.push('condition'); return 'pick()'; },
    straight: id => { calls.push(id); return [`value = ${id};`]; },
    localType: name => { calls.push(name); return 'int'; },
    condInverted: () => { throw new Error('value branches need no inverse'); },
  }));
  assert.deepEqual(calls, ['condition', 1, 2, 'value']);
});

test('conditional assignments preserve native bits, unboxing, exceptions and effect order', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-emitter-value-branches-'));
  try {
    const variants = [
      ['int', '0', '1', 'Integer.toString(value)'],
      ['int', '-0x80000000', '0x7fffffff', 'Integer.toString(value)'],
      ['long', '-0x8000000000000000L', '0x7fffffffffffffffL', 'Long.toString(value)'],
      ['long', '9_007_199_254_740_993L', '0b1L', 'Long.toString(value)'],
      ['float', '-0.0f', '0.0f', 'Integer.toString(Float.floatToRawIntBits(value))'],
      ['float', '3.4028235e38f', '1.4e-45f', 'Integer.toString(Float.floatToRawIntBits(value))'],
      ['double', '-0.0', '0.0', 'Long.toString(Double.doubleToRawLongBits(value))'],
      ['double', '1.7976931348623157E308', '4.9E-324', 'Long.toString(Double.doubleToRawLongBits(value))'],
      ['boolean', 'true', 'false', 'Boolean.toString(value)'],
      ['boolean', 'false', 'true', 'Boolean.toString(value)'],
    ];
    const methods = [];
    variants.forEach(([type, taken, other, result], index) => {
      const reconstructed = emitStatements(treeToStatements({t: 'if', block: 0,
        then: straight(1), els: straight(2)}, {
        cond: () => 'pick(x, trace)',
        straight: id => [`value = ${id === 1 ? taken : other};`],
        localType: name => name === 'value' ? type : null,
      }));
      assert.doesNotMatch(reconstructed, /\bif\b|\belse\b/);
      for (const [name, body] of [['original', `if (pick(x, trace)) { value = ${taken}; }
        else { value = ${other}; }`], ['rebuilt', reconstructed]]) {
        methods.push(`static String ${name}${index}(double x) {
          StringBuilder trace = new StringBuilder(); ${type} value;
          try { synchronized (trace) { ${body} trace.append('a'); }
            return receive(trace).done(before(trace), ${result}) + ":" + trace;
          } catch (RuntimeException failure) { return failure.getClass().getName()+":"+trace; }
        }`);
      }
    });
    const source = `public class ValueBranches {
      static Boolean pick(double x, StringBuilder trace) {
        trace.append('q'); if (x == 7) throw new IllegalArgumentException();
        return Double.isNaN(x) ? null : x <= 0;
      }
      static ValueBranches receive(StringBuilder trace) { trace.append('r'); return new ValueBranches(); }
      static int before(StringBuilder trace) { trace.append('b'); return 7; }
      String done(int ignored, String result) { return result; }
      ${methods.join('\n')}
      public static void main(String[] args) {
        double[] values = {Double.NEGATIVE_INFINITY, -2147483648d, -7d, -0d, 0d,
          7d, 2147483647d, Double.POSITIVE_INFINITY, Double.NaN};
        for (double value : values) {
          ${variants.map((_, index) => `{
            String expected = original${index}(value), actual = rebuilt${index}(value);
            if (!expected.equals(actual)) throw new AssertionError(${index}+":"+value+":"+expected+":"+actual);
            System.out.println(${index}+":"+value+":"+actual);
          }`).join('\n')}
        }
      }
    }`;
    const javaFile = path.join(temporary, 'ValueBranches.java');
    fs.writeFileSync(javaFile, source);
    run('javac', ['--release', '8', '-d', temporary, javaFile], temporary);
    assert.equal(run('java', ['-cp', temporary, 'ValueBranches'], temporary)
      .trim().split('\n').length, 90);
  } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
});

test('folding a value branch can shorten an enclosing return guard without reordering effects', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-emitter-nested-value-branches-'));
  try {
    const tree = {t: 'if', block: 0, then: seq(straight(1), straight(2), straight(3), straight(4)),
      els: seq({t: 'if', block: 5, then: straight(6), els: straight(7)}, straight(8))};
    const sources = {1: "trace.append('a');", 2: "trace.append('c');",
      3: "trace.append('d');", 4: 'return done(3 / divisor, trace);',
      6: 'value = 0;', 7: 'value = 1;', 8: 'return done(value / divisor, trace);'};
    const render = {cond: id => id ? 'inner(x, trace)' : 'outer(first, trace)',
      straight: id => [sources[id]], localType: name => name === 'value' ? 'int' : null};
    const folded = emitStatements(treeToStatements(tree, render));
    const previous = emitStatements(treeToStatements(tree, {...render, localType: undefined}));
    assert.match(previous, /^if \(outer\(first, trace\)\)/);
    assert.match(folded, /^if \(!\(outer\(first, trace\)\)\)/);
    assert.match(folded, /value = \(inner\(x, trace\)\) \? 0 : 1;/);
    const source = `public class NestedValueBranches {
      static boolean outer(boolean first, StringBuilder trace) { trace.append('o'); return first; }
      static Boolean inner(double x, StringBuilder trace) {
        trace.append('i'); if (x == 7) throw new IllegalArgumentException();
        return Double.isNaN(x) ? null : x <= 0;
      }
      static String done(int value, StringBuilder trace) { trace.append('r'); return value+":"+trace; }
      ${[['original', previous], ['rebuilt', folded]].map(([name, body]) => `
        static String ${name}(boolean first, double x, int divisor) {
          StringBuilder trace = new StringBuilder(); int value;
          try { ${body} } catch (RuntimeException failure) { return failure.getClass().getName()+":"+trace; }
        }`).join('\n')}
      public static void main(String[] args) {
        double[] values = {Double.NEGATIVE_INFINITY, -2147483648d, -7d, -0d, 0d,
          7d, 2147483647d, Double.POSITIVE_INFINITY, Double.NaN};
        for (boolean first : new boolean[]{false,true}) for (double x : values)
          for (int divisor : new int[]{-1,0,1}) {
            String expected = original(first,x,divisor), actual = rebuilt(first,x,divisor);
            if (!expected.equals(actual)) throw new AssertionError(first+":"+x+":"+divisor+":"+expected+":"+actual);
            System.out.println(first+":"+x+":"+divisor+":"+actual);
          }
      }
    }`;
    const javaFile = path.join(temporary, 'NestedValueBranches.java');
    fs.writeFileSync(javaFile, source);
    run('javac', ['--release', '8', '-d', temporary, javaFile], temporary);
    assert.equal(run('java', ['-cp', temporary, 'NestedValueBranches'], temporary)
      .trim().split('\n').length, 54);
  } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
});

const booleanCarrier = 'stackIn_1_0';
function promote(source, localType = name => name === 'flag' ? 'boolean' : name === 'x' ? 'double' : null) {
  return promoteBooleanStackCarriers(source, [`int ${booleanCarrier} = 0;`],
    new Map([[booleanCarrier, 'int']]), localType);
}

test('Boolean carrier proofs preserve snapshots and inline only a single adjacent pure use', () => {
  const name = booleanCarrier;
  const inline = promote(`${name} = (flag) ? 0 : 1; accept(${name} != 0);`);
  assert.deepEqual(inline.removed, [name]);
  assert.deepEqual(inline.declarations, []);
  assert.equal(inline.source.trim(), 'accept(!flag);');
  const snapshot = promote(`${name} = (pick()) ? 0 : 1; receive().accept(${name} != 0);`);
  assert.deepEqual(snapshot.promoted, [name]);
  assert.match(snapshot.source, /stackIn_1_0 = !\(pick\(\)\); receive\(\)\.accept\(stackIn_1_0\);/);
  assert.deepEqual(snapshot.declarations, ['boolean stackIn_1_0 = false;']);
  for (const source of [
    `${name} = (flag) ? 0 : 1; accept(flag = !flag, ${name} != 0);`,
    `${name} = (flag) ? 0 : 1; flag = !flag; accept(${name} != 0);`,
    `${name} = (flag) ? 0 : 1; while (${name} != 0) { flag = !flag; break; }`,
    `${name} = (flag) ? 0 : 1; accept(${name} != 0, ${name} == 0);`,
    `if (flag) { ${name} = 1; } accept(${name} != 0);`,
  ]) assert.deepEqual(promote(source).promoted, [name], source);
  const boxed = promote(`${name} = (flag) ? 0 : 1; receive().accept(${name} != 0);`,
    () => 'Boolean');
  assert.deepEqual(boxed.promoted, [name]);
  assert.match(boxed.source, /stackIn_1_0 = !\(flag\); receive\(\)\.accept\(stackIn_1_0\)/);
  const literals = promote(`${name} = 1; return 0 == ${name};`);
  assert.equal(literals.source.trim(), 'return false;');
});

test('numeric uses, shadowing, partial parses and textual lookalikes cannot retype a carrier', () => {
  const name = booleanCarrier;
  for (const source of [
    `${name} = 2; return ${name} != 0;`,
    `${name} = (flag) ? 0 : 2; return ${name} != 0;`,
    `${name} = 1; return ${name};`,
    `${name} = 1; return ${name} + 1 != 0;`,
    `${name} = 1; return ${name} != (0 + call());`,
    `${name} = 1; return ${name} != 0 * call();`,
    `${name} = 1; return ${name} != 1;`,
    `${name} = 1; ${name}++; return ${name} != 0;`,
    `accept(${name} = 1); return ${name} != 0;`,
    `if (flag) { int ${name} = 1; accept(${name} != 0); }`,
    `try { ${name} = 1; } catch (Error ${name}) { work(); } return ${name} != 0;`,
    `${name} = 1; accept(holder.${name} != 0);`,
    `${name} = 1; Object x = new Base() { boolean get() { return ${name} != 0; } };`,
    `${name} = 1; Runnable x = () -> accept(${name} != 0);`,
    `${name} = 1; return ${name} != 0; } trailing();`,
    `${name} = 1; String x = "\\u0041"; return ${name} != 0;`,
  ]) {
    const result = promote(source);
    assert.equal(result.source, source, source);
    assert.deepEqual(result.promoted, [], source);
    assert.deepEqual(result.removed, [], source);
  }
  const quoted = promote(`${name} = 1; String message = "${name} != 0"; return ${name} != 0;`);
  assert.deepEqual(quoted.promoted, [name]);
  assert.match(quoted.source, /String message = "stackIn_1_0 != 0"/);
});

test('Boolean snapshots and safe inlining match native values, failure priority and effect order', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-emitter-boolean-carriers-'));
  try {
    const name = booleanCarrier;
    const variants = [
      `${name} = (flag) ? 0 : 1; return accept(${name} != 0, trace);`,
      `${name} = (flag) ? 1 : 0; return accept(0 == ${name}, trace);`,
      `${name} = 1; return accept(${name} == 0, trace);`,
      `${name} = (pick(x, trace)) ? 0 : 1; return receive(trace).done(before(trace), ${name} != 0, trace);`,
      `${name} = (boxed) ? 0 : 1; return receive(trace).done(before(trace), ${name} != 0, trace);`,
      `${name} = (flag) ? 0 : 1; return receive(trace).done(before(trace), (flag = !flag) && ${name} != 0, trace);`,
      `${name} = (flag) ? 0 : 1; flag = !flag; return accept(${name} != 0, trace);`,
      `${name} = (pick(x, trace)) ? 0 : 0; return accept(${name} != 0, trace);`,
      `${name} = (pick(x, trace)) ? 1 : 1; return accept(${name} == 0, trace);`,
      `if (flag) { ${name} = 1; } return accept(${name} != 0, trace);`,
      `${name} = (flag) ? 0 : 1; if (${name} != 0) return accept(true, trace); return accept(${name} == 0, trace);`,
      `${name} = (flag) ? 0 : 1; for (int i=0; i<2 && ${name} != 0; i++) { trace.append(i); flag = !flag; } return accept(flag, trace);`,
      `${name} = (x >= 0d) ? 0 : 1; return receive(trace).done(before(trace), ${name} != 0, trace);`,
      `${name} = (x < -2147483648) ? 0 : 1; return accept(${name} == 0, trace);`,
      `${name} = (x >= -9223372036854775808L) ? 1 : 0; return receive(trace).done(before(trace), (x = 1.0d) > 0 && ${name} != 0, trace);`,
    ];
    const methods = [];
    variants.forEach((original, index) => {
      const rebuilt = promote(original);
      assert.equal(rebuilt.promoted.length + rebuilt.removed.length, 1, original);
      for (const [label, declarations, body] of [['original', [`int ${name} = 0;`], original],
        ['rebuilt', rebuilt.declarations, rebuilt.source]]) {
        methods.push(`static String ${label}${index}(boolean flag,double x,Boolean boxed) {
          StringBuilder trace = new StringBuilder(); ${declarations.join('\n')}
          try { ${body} } catch (RuntimeException failure) { return failure.getClass().getName()+":"+trace; }
        }`);
      }
    });
    const source = `public class BooleanCarriers {
      static int mode;
      static Boolean pick(double x,StringBuilder trace) {
        trace.append('q'); if (x == 7) throw new IllegalArgumentException();
        return Double.isNaN(x) ? null : x <= 0;
      }
      static BooleanCarriers receive(StringBuilder trace) {
        trace.append('r'); if (mode == 1) throw new IllegalStateException(); return new BooleanCarriers();
      }
      static int before(StringBuilder trace) {
        trace.append('b'); if (mode == 2) throw new UnsupportedOperationException(); return 7;
      }
      static String accept(boolean flag,StringBuilder trace) { trace.append('a'); return flag+":"+trace; }
      String done(int ignored,boolean flag,StringBuilder trace) { return accept(flag,trace); }
      ${methods.join('\n')}
      public static void main(String[] args) {
        for (mode=0;mode<3;mode++) for (boolean flag : new boolean[]{false,true})
          for (double x : new double[]{-0d,7d,Double.NaN}) for (Boolean boxed : new Boolean[]{false,true,null}) {
            ${variants.map((_, index) => `{
              String expected=original${index}(flag,x,boxed),actual=rebuilt${index}(flag,x,boxed);
              if (!expected.equals(actual)) throw new AssertionError(${index}+":"+mode+":"+flag+":"+x+":"+boxed+":"+expected+":"+actual);
              System.out.println(${index}+":"+mode+":"+flag+":"+x+":"+boxed+":"+actual);
            }`).join('\n')}
          }
      }
    }`;
    const javaFile=path.join(temporary,'BooleanCarriers.java');fs.writeFileSync(javaFile,source);
    run('javac',['--release','8','-d',temporary,javaFile],temporary);
    assert.equal(run('java',['-cp',temporary,'BooleanCarriers'],temporary).trim().split('\n').length,810);
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});

test('identical branch tails are factored only with complete scope and extent proofs', () => {
  const factor = source => factorCommonBranchTails(source);
  for (const source of [
    'if (pick()) { left(); finish(); return; } else { right(); finish(); return; }',
    'if (pick()) { left(); finish(); return; } right(); finish(); return;',
    'if (pick()) { if (stop()) { return; } left(); finish(); } else { right(); finish(); }',
  ]) {
    const result = factor(source);
    assert.ok(result.branches > 0, source);
    assert.equal((result.source.match(/finish\(\)/g) || []).length, 1, result.source);
  }
  const empty = factor('if (pick()) { finish(); } else { finish(); }');
  assert.match(empty.source, /if \(pick\(\)\) \{\s*\}\s*finish\(\);/);
  for (const source of [
    'if (flag) { int value = 1; use(value); } else { int value = 2; use(value); }',
    'if (flag) { class Value {} use(Value.class); } else { class Value {} use(Value.class); }',
    'if (flag) { synchronized (lock) { finish(); } } else { finish(); }',
    'if (flag) { try { finish(); } catch (RuntimeException error) { caught(); } } else { finish(); }',
    'if (flag) { finish(); } else { changed(); }',
    'if (first) { return false; } if (second) { return false; } work(); return false;',
    'if (flag) { finish(); } else { finish(); } trailing !',
    'if (flag) { finish(); } else { finish(); } // \\u000a',
  ]) assert.deepEqual(factor(source), {source, branches: 0}, source);
  const nested = factor('if (flag) { left(); if (other) { a(); finish(); } else { b(); finish(); } } else { right(); }');
  assert.ok(nested.branches > 0);
  assert.equal((nested.source.match(/finish\(\)/g) || []).length, 1);
});

test('factored tails preserve native conditions, snapshots, scopes and protected effect order', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cfr-emitter-shared-tails-'));
  try {
    const variants = [
      'if (pick(x,boxed,trace)) { trace.append("a"); finish(x,trace); } else { trace.append("b"); finish(x,trace); } return done(trace);',
      'if (pick(x,boxed,trace)) { finish(x,trace); return done(trace); } else { finish(x,trace); return done(trace); }',
      'if (pick(x,boxed,trace)) { trace.append("a"); finish(x,trace); return done(trace); } trace.append("b"); finish(x,trace); return done(trace);',
      'if (pick(x,boxed,trace)) { if (x == 7) { return done(trace); } trace.append("a"); finish(x,trace); } else { trace.append("b"); finish(x,trace); } return done(trace);',
      'if (pick(x,boxed,trace)) { trace.append("a"); x = -x; finish(x,trace); } else { trace.append("b"); x += 1; finish(x,trace); } return done(trace);',
      'if (pick(x,boxed,trace)) { finish(x,trace); } else { finish(x,trace); } return done(trace);',
      'if (pick(x,boxed,trace)) { trace.append("a"); if (x < 0) { synchronized (lock) { locked(x,lock,trace); } } else { trace.append("c"); synchronized (lock) { locked(x,lock,trace); } } } else { trace.append("b"); } return done(trace);',
      'if (pick(x,boxed,trace)) { trace.append("a"); try { finish(x,trace); } catch (IllegalArgumentException failure) { trace.append("c"); } } else { trace.append("b"); try { finish(x,trace); } catch (IllegalArgumentException failure) { trace.append("c"); } } return done(trace);',
      'if (pick(x,boxed,trace)) { trace.append("a"); return done(trace); } else { int value = 2; trace.append(value); return done(trace); }',
      'if (pick(x,boxed,trace)) { trace.append("a"); if (x == x) { trace.append("c"); finish(x,trace); } else { finish(x,trace); } } else { trace.append("b"); } return done(trace);',
      'if (pick(x,boxed,trace)) { trace.append("a"); if (x < 0) { trace.append("c"); finish(x,trace); } else { finish(x,trace); } } else { trace.append("b"); } return done(trace);',
      'Outer: { if (pick(x,boxed,trace)) { trace.append("a"); finish(x,trace); break Outer; } else { trace.append("b"); finish(x,trace); break Outer; } } return done(trace);',
      'for (int i=0;i<2;i++) { if (pick(x,boxed,trace)) { trace.append("a"); finish(x,trace); continue; } else { trace.append("b"); finish(x,trace); continue; } } return done(trace);',
    ];
    const methods = [];
    variants.forEach((original,index) => {
      const result = factorCommonBranchTails(original);
      if (index < 8 || index === 9 || index === 10) assert.ok(result.branches > 0, original);
      // Whole loops/labeled constructs are kept, including their inner tails.
      if (index >= 11) assert.equal(result.source, original);
      for (const [label,body] of [['original',original],['rebuilt',result.source]])
        methods.push(`static String ${label}${index}(double x,Boolean boxed,Object lock) {
          StringBuilder trace = new StringBuilder(); try { ${body} }
          catch (RuntimeException failure) { return failure.getClass().getName()+":"+trace; }
        }`);
    });
    const source = `public class SharedTails {
      static int mode;
      static boolean pick(double x,Boolean boxed,StringBuilder trace) {
        trace.append('q'); if (mode == 1) throw new IllegalStateException();
        return mode == 2 ? boxed : x <= 0;
      }
      static void finish(double x,StringBuilder trace) {
        trace.append('f'); if (x == 7 || Double.isNaN(x)) throw new IllegalArgumentException();
        trace.append(Double.doubleToRawLongBits(x));
      }
      static void locked(double x,Object lock,StringBuilder trace) {
        if (!Thread.holdsLock(lock)) throw new AssertionError(); finish(x,trace);
      }
      static String done(StringBuilder trace) { return trace.toString(); }
      ${methods.join('\n')}
      public static void main(String[] args) {
        Object lock=new Object();
        for (mode=0;mode<3;mode++) for (double x : new double[]{Double.NEGATIVE_INFINITY,-7,-0d,0d,7,Double.POSITIVE_INFINITY,Double.NaN})
          for (Boolean boxed : new Boolean[]{false,true,null}) {
            ${variants.map((_,index)=>`{
              String expected=original${index}(x,boxed,lock),actual=rebuilt${index}(x,boxed,lock);
              if (!expected.equals(actual) || Thread.holdsLock(lock)) throw new AssertionError(${index}+":"+mode+":"+x+":"+boxed+":"+expected+":"+actual);
              System.out.println(${index}+":"+mode+":"+x+":"+boxed+":"+actual);
            }`).join('\n')}
          }
      }
    }`;
    const javaFile=path.join(temporary,'SharedTails.java');fs.writeFileSync(javaFile,source);
    run('javac',['--release','8','-d',temporary,javaFile],temporary);
    assert.equal(run('java',['-cp',temporary,'SharedTails'],temporary).trim().split('\n').length,variants.length*63);
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
});
