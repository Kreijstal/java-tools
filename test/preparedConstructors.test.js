// Ahead-of-main preparation admits a constructor on its resolved call graph:
// every call it can make completes synchronously through a published entry
// (a JRE shim with a synchronous form, a bytecode target with a body from an
// earlier round), so the constructor and the callers that allocate it stop
// handing every `new` back to the scheduler. A constructor that reaches a
// genuinely asynchronous callee stays interpreted, and its callers with it.
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

function findMethod(jvm, className, name, descriptor) {
  return jvm.classes[className].ast.classes[0].items
    .find((item) => item.type === 'method' && item.method.name === name &&
      item.method.descriptor === descriptor).method;
}

async function run(dir, jitOptions = {}) {
  const jvm = new JVM({classpath: dir, jreOverrides: overrides,
    jit: {compileWorker: false, asyncCallCensus: true, ...jitOptions}});
  await jvm.run('Main');
  return jvm;
}

function statics(jvm) {
  const get = (name) => jvm.classes.Main.staticFields.get(`${name}:I`);
  return {result: get('result'), thrown: get('thrown'), naps: get('naps')};
}

test('preparation admits constructors on their resolved call graph', async (t) => {
  const dir = compileFixture(t);
  const jvm = await run(dir);
  const jit = jvm.jit;
  t.deepEqual(statics(jvm), expected(), 'results (instance/static/virtual/super calls, chaining, throwing)');
  const prepared = (cls, name, desc) => jit.preparedCodegenMethods.has(findMethod(jvm, cls, name, desc));
  const published = (cls, name, desc) => jit.hasPublishedSynchronousBody(findMethod(jvm, cls, name, desc));
  for (const [cls, desc] of [['Base', '(I)V'], ['Derived', '(I)V'], ['Thrower', '(I)V']]) {
    t.ok(prepared(cls, '<init>', desc) && published(cls, '<init>', desc),
      `${cls}.<init>${desc} has a prepared synchronous body`);
  }
  t.ok(prepared('Main', 'build', '(I)I'), 'the caller allocating Base/Derived is prepared');
  t.ok(prepared('Main', 'guard', '(I)I'), 'the caller allocating Thrower is prepared');
  t.notOk(prepared('Napper', '<init>', '(I)V'), 'a constructor reaching an asynchronous host operation stays interpreted');
  const note = jit.constructorAdmissionNotes.get(findMethod(jvm, 'Napper', '<init>', '(I)V')) || '';
  t.ok(/Host\.nap\(\)V/.test(note), `the census names the asynchronous callee (${note})`);
  t.notOk(prepared('Main', 'nap', '(I)I'), 'its caller stays interpreted too (constructor without a body)');
  t.ok(jvm.preparationReport.rounds >= 2,
    `the fixed point needed more than one round for the chain (${jvm.preparationReport.rounds})`);
  const census = [...jit.asyncCallCensus.keys()];
  for (const cls of ['Base', 'Derived', 'Thrower']) {
    t.notOk(census.some((key) => key.includes(` ${cls}.<init>(I)V:`)),
      `no scheduler handoff at a ${cls} constructor call site`);
  }
  // Napper is only ever allocated by the interpreted Main.nap, so no
  // synchronous call site exists for it; the census stays silent about it.
  t.end();
});

test('the syntactic constructor rule alone gives the same results', async (t) => {
  const dir = compileFixture(t);
  const jvm = await run(dir, {preparedConstructors: false});
  t.deepEqual(statics(jvm), expected(), 'same results with the admission off');
  t.notOk(jvm.jit.preparedCodegenMethods.has(findMethod(jvm, 'Base', '<init>', '(I)V')),
    'the call-bearing constructor is not prepared under the syntactic rule');
  t.end();
});
