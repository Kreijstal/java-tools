// Constructors that make instance, static, virtual (overridden, called while a
// subclass field is still 0) and super calls, throw, or reach an asynchronous
// host native all produce the same Java-visible results.
'use strict';
const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JVM } = require('../src/core/jvm');
const frontend = require('../src/java-frontend');

function compileFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-ctor-'));
  t.teardown(() => fs.rmSync(dir, {recursive: true, force: true}));
  const sources = {
    Util: ['public class Util {', '  static int twice(int v) { return v * 2; }', '}'],
    Base: [
      'public class Base {',
      '  int a, b, kind; static int made;',
      // instance call, static call, and a virtual call that a subclass overrides
      '  Base(int x) { a = seed(x); b = Util.twice(a); kind = describe(); made += 1; }',
      '  int seed(int x) { return x + 1; }',
      '  int describe() { return 1; }',
      '  int sum() { return a + b + kind; }',
      '}'],
    Derived: [
      'public class Derived extends Base {',
      '  int c = 7;',
      '  Derived(int x) { super(x); c += tag(); }',
      // invokevirtual from Base's constructor lands here while c is still 0;
      // super.describe() is an invokespecial that must reach Base's version.
      '  int describe() { return 100 + c + super.describe(); }',
      '  int tag() { return a * 10; }',
      '}'],
    Thrower: [
      'public class Thrower {',
      '  int v;',
      '  Thrower(int x) { if (x < 0) throw new IllegalArgumentException("negative"); v = x; }',
      '}'],
    Host: ['public class Host {', '  static native void nap();', '}'],
    Napper: ['public class Napper {', '  int v;', '  Napper(int x) { v = x; Host.nap(); }', '}'],
    Main: [
      'public class Main {',
      '  static int result, thrown, naps;',
      '  static int build(int n) {',
      '    int s = 0;',
      '    for (int i = 0; i < n; i++) { Base b = (i & 1) == 0 ? new Base(i) : new Derived(i); s += b.sum() + b.kind; }',
      '    return s;',
      '  }',
      '  static int guard(int n) {',
      '    int s = 0;',
      '    for (int i = -2; i < n; i++) { try { s += new Thrower(i).v; } catch (IllegalArgumentException e) { thrown += 1; } }',
      '    return s;',
      '  }',
      '  static int nap(int n) { int s = 0; for (int i = 0; i < n; i++) s += new Napper(i).v; return s; }',
      '  public static void main(String[] args) { result = build(64) + guard(8); naps = nap(4); }',
      '}'],
  };
  for (const [name, lines] of Object.entries(sources)) {
    fs.writeFileSync(path.join(dir, `${name}.java`), lines.join('\n'));
  }
  for (const name of Object.keys(sources)) {
    frontend.compileJavaFile(path.join(dir, `${name}.java`),
      {outputDir: dir, sourceFileName: `${name}.java`});
  }
  return dir;
}

function expected() {
  let s = 0;
  for (let i = 0; i < 64; i++) {
    const a = i + 1, b = 2 * a;
    // Derived.describe() runs from Base's constructor with c still 0.
    const kind = (i & 1) === 0 ? 1 : 100 + 0 + 1;
    s += (a + b + kind) + kind;
  }
  for (let i = 0; i < 8; i++) s += i; // guard(): -2 and -1 throw
  return {result: s, thrown: 2, naps: 0 + 1 + 2 + 3};
}

const overrides = {
  Host: {
    natives: {applicationFallback: true},
    // A genuinely asynchronous host operation.
    methods: {'nap()V': async () => { await new Promise((resolve) => setTimeout(resolve, 1)); }},
  },
};

async function run(dir) {
  const jvm = new JVM({classpath: dir, jreOverrides: overrides});
  await jvm.run('Main');
  return jvm;
}

function statics(jvm) {
  const get = (name) => jvm.classes.Main.staticFields.get(`${name}:I`);
  return {result: get('result'), thrown: get('thrown'), naps: get('naps')};
}

test('constructors with calls, chaining, throws, and async natives give Java results', async (t) => {
  const dir = compileFixture(t);
  const jvm = await run(dir);
  t.deepEqual(statics(jvm), expected(), 'results (instance/static/virtual/super calls, chaining, throwing, async native)');
  t.end();
});
