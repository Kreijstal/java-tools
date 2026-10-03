// pop2 discards one category-2 value (a BigInt long, or a double, which both
// take one slot here) or two category-1 values. The verified operand widths
// decide, in the same analysis dup2 already relies on; both the structured
// renderer and the baseline runner honour it.
'use strict';
const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const frontend = require('../src/java-frontend');

function makeMethod(name, descriptor, instructions, localsSize) {
  return { name, descriptor, flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: instructions.map((instruction, index) => ({ labelDef: `L${index}:`, instruction })),
      localsSize: String(localsSize), stackSize: '4', exceptionTable: [],
    } }] };
}

const cases = [
  { name: 'long', method: makeMethod('keepLong', '(J)J', ['lload_0', 'lload_0', 'pop2', 'lreturn'], 2),
    locals: [77n, undefined], expected: 77n },
  { name: 'double', method: makeMethod('afterDouble', '(D)I', ['dload_0', 'pop2', { op: 'bipush', arg: 5 }, 'ireturn'], 2),
    locals: [2.5, undefined], expected: 5 },
  { name: 'two ints', method: makeMethod('secondInt', '(II)I', ['iload_0', 'iload_1', 'iload_0', 'iload_1', 'pop2', 'pop2', 'iload_1', 'ireturn'], 2),
    locals: [3, 9], expected: 9 },
];

function runGenerated(jvm, generated, method, locals) {
  const frame = new Frame(method);
  locals.forEach((value, index) => { frame.locals[index] = value; });
  const stack = new Stack();
  stack.push(frame);
  return generated(frame, { status: 'runnable', callStack: stack }, jvm.jit, false);
}

test('structured SSA and the baseline runner discard pop2 operands by verified width', (t) => {
  for (const {name, method, locals, expected} of cases) {
    const jvm = new JVM({ jit: {compileWorker: false, structuredSsa: true, profileMethods: false} });
    const structured = jvm.jit.structuredSsa.compile(method);
    t.ok(structured?.jvmStructuredSsa, `${name}: structured body (${jvm.jit.structuredSsa.lastRejectionReason || 'ok'})`);
    const result = runGenerated(jvm, structured, method, locals);
    t.ok(result?.returned && result.value === expected, `${name}: structured returns ${String(expected)} (${JSON.stringify(result, (k, v) => typeof v === 'bigint' ? String(v) + 'n' : v)})`);
    const baseline = jvm.jit.compileBaselineMethod(method);
    t.ok(baseline, `${name}: baseline body`);
    const baselineResult = runGenerated(jvm, baseline, method, locals);
    t.ok(baselineResult?.returned && baselineResult.value === expected, `${name}: baseline returns ${String(expected)}`);
  }
  t.end();
});

test('a javac-discarded long result compiles and prepares', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pop2-'));
  t.teardown(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(dir, 'Main.java'), [
    'public class Main {',
    '  static long calls;',
    '  static long tick(int i) { calls += 1; return calls * 1000000007L + i; }',
    // the first tick's long result is discarded: javac emits pop2
    '  static long twice(int i) { tick(i); return tick(i) - (long) i; }',
    '  static long result;',
    '  public static void main(String[] args) { long s = 0; for (int i = 0; i < 50; i++) s += twice(i); result = s; }',
    '}',
  ].join('\n'));
  frontend.compileJavaFile(path.join(dir, 'Main.java'), {outputDir: dir, sourceFileName: 'Main.java'});
  const jvm = new JVM({classpath: dir, jit: {compileWorker: false}});
  await jvm.run('Main');
  let expectedResult = 0n, calls = 0n;
  for (let i = 0; i < 50; i++) { calls += 1n; calls += 1n; expectedResult += calls * 1000000007n; }
  t.equal(jvm.classes.Main.staticFields.get('result:J'), expectedResult, 'correct result');
  const twice = jvm.classes.Main.ast.classes[0].items.find((item) => item.type === 'method' && item.method.name === 'twice').method;
  const items = jvm.jit.getCodeItems(twice);
  t.ok(items.some((item) => (item?.instruction?.op || item?.instruction) === 'pop2'), 'the fixture really contains pop2');
  t.ok(jvm.jit.hasPublishedSynchronousBody(twice), 'the pop2-bearing method was prepared with a synchronous body');
  t.end();
});
