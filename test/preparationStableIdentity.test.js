// A class supplied both as an applicationFallback override stub and as a real
// class file: the real bytecode runs, the override replaces its one method,
// and the class initializer runs once, at its Java-visible point.
'use strict';
const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JVM } = require('../src/core/jvm');
const frontend = require('../src/java-frontend');

function compileFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-identity-'));
  t.teardown(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(dir, 'FallbackTarget.java'), [
    'public class FallbackTarget {',
    '  static int counter;',
    '  static int[] table;',
    '  static int initRuns;',
    '  static { initRuns++; counter = 100; table = new int[4]; table[3] = 7; }',
    '  int field;',
    '  FallbackTarget(int v) { field = v; }',
    '  static int bump(int d) { counter += d; return counter; }',
    '  int get() { return field + table[3]; }',
    '  static int host(int x) { return -1; }', // replaced by the override
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'FallbackUser.java'), [
    'public class FallbackUser {',
    '  static int result;',
    '  static int initSeen;',
    '  static int probe(int n, FallbackTarget[] ts) {',
    '    int s = 0;',
    '    for (int i = 0; i < n; i++) {',
    '      FallbackTarget.counter += 1;',
    '      FallbackTarget t = ts[i];',
    '      s += t.get();',
    '      s += FallbackTarget.bump(1);',
    '      s += FallbackTarget.host(i);',
    '      if (t instanceof FallbackTarget) s += 1;',
    '      Class c = FallbackTarget.class;',
    '      if (c != null) s += 1;',
    '    }',
    '    return s;',
    '  }',
    '  static FallbackTarget[] make(int n) {',
    '    FallbackTarget[] ts = new FallbackTarget[n];',
    '    for (int i = 0; i < n; i++) ts[i] = new FallbackTarget(i);',
    '    return ts;',
    '  }',
    '  public static void main(String[] args) {',
    '    FallbackTarget[] ts = make(10);',
    '    initSeen = FallbackTarget.initRuns;',
    '    result = probe(10, ts);',
    '  }',
    '}',
  ].join('\n'));
  for (const name of ['FallbackTarget', 'FallbackUser']) {
    frontend.compileJavaFile(path.join(dir, `${name}.java`),
      {outputDir: dir, sourceFileName: `${name}.java`});
  }
  return dir;
}

// What the program computes, worked out here rather than trusted from a run.
function expected(n) {
  let counter = 100, s = 0;
  for (let i = 0; i < n; i++) {
    counter += 1;
    s += i + 7;             // t.get(): field + table[3]
    counter += 1; s += counter;
    s += i * 2;             // host(i) via the override
    s += 1;                 // instanceof
    s += 1;                 // class literal
  }
  return {result: s, counter};
}

const overrides = {
  FallbackTarget: {
    natives: {applicationFallback: true},
    methods: {'host(I)I': (jvm, _, args) => (args[0] | 0) * 2},
  },
};

test('an override-stubbed class runs its real bytecode, its override, and its initializer once', async (t) => {
  const dir = compileFixture(t);
  const jvm = new JVM({classpath: dir, jreOverrides: overrides});
  await jvm.run('FallbackUser');
  const want = expected(10);
  t.equal(jvm.classes.FallbackUser.staticFields.get('result:I'), want.result,
    'correct result through statics, constructor, virtual, static, override, instanceof and class literal');
  t.equal(jvm.classes.FallbackTarget.staticFields.get('initRuns:I'), 1, '<clinit> ran exactly once');
  t.equal(jvm.classes.FallbackUser.staticFields.get('initSeen:I'), 1, '<clinit> ran by its first active use in main()');
  t.end();
});
