// Cross-class static calls, a constructor reached through a not-yet-initialized
// class, and a JRE static whose result its class initializer stores.
'use strict';
const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JVM } = require('../src/core/jvm');
const frontend = require('../src/java-frontend');

function compileFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-fixed-'));
  t.teardown(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(dir, 'Helper.java'), [
    'public class Helper {',
    '  int v;',
    '  Helper(int x) { v = x * 2 + 1; }', // a linear field initializer: a constructor the JIT admits
    '  static int compute(int x) { return x * 2 + 1; }',
    '  int value() { return v; }',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'Callee.java'), [
    'public class Callee {',
    '  static int work(int i) { Helper h = new Helper(i); return h.value(); }',
    '  static int leaf(int i) { return i & 7; }',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'Caller.java'), [
    'public class Caller {',
    '  static int result;',
    '  static int loop(int n) {',
    '    int s = 0;',
    '    for (int i = 0; i < n; i++) { s += Callee.work(i); s += Callee.leaf(i); }',
    '    return s;',
    '  }',
    '  public static void main(String[] args) { result = loop(200); }',
    '}',
  ].join('\n'));
  for (const name of ['Helper', 'Callee', 'Caller']) {
    frontend.compileJavaFile(path.join(dir, `${name}.java`),
      {outputDir: dir, sourceFileName: `${name}.java`});
  }
  return dir;
}

function expected(n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += (i * 2 + 1) + (i & 7);
  return s;
}

test('static calls across classes and a constructor in a lazily initialized class compute the result', async (t) => {
  const dir = compileFixture(t);
  const jvm = new JVM({classpath: dir});
  await jvm.run('Caller');
  t.equal(jvm.classes.Caller.staticFields.get('result:I'), expected(200), 'correct result');
  t.end();
});

test('Runtime.getRuntime() in a loop always returns the runtime object', async (t) => {
  // Runtime.getRuntime() reads a static that Runtime's <clinit> stores: the
  // first call must initialize the class first.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-clinit-'));
  t.teardown(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(dir, 'RuntimeUser.java'), [
    'public class RuntimeUser {',
    '  static int processors;',
    '  static int probe(int n) {',
    '    int s = 0;',
    '    for (int i = 0; i < n; i++) { Runtime r = Runtime.getRuntime(); if (r != null) s += r.availableProcessors() > 0 ? 1 : 0; }',
    '    return s;',
    '  }',
    '  public static void main(String[] args) { processors = probe(5); }',
    '}',
  ].join('\n'));
  frontend.compileJavaFile(path.join(dir, 'RuntimeUser.java'), {outputDir: dir, sourceFileName: 'RuntimeUser.java'});
  const jvm = new JVM({classpath: dir});
  await jvm.run('RuntimeUser');
  t.equal(jvm.classes.RuntimeUser.staticFields.get('processors:I'), 5,
    'every Runtime.getRuntime() returned the runtime object');
  t.end();
});
