// multianewarray was on both JIT admission lists but had no emitter case, so
// a prepared body with `new int[a][b]` was compiled, then deopted for good
// at its first allocation ("unsupported generated opcode multianewarray")
// and ran interpreted from then on. Every tier now shares one allocator.
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

function runGenerated(jvm, generated, method, locals) {
  const frame = new Frame(method);
  locals.forEach((value, index) => { frame.locals[index] = value; });
  const stack = new Stack();
  stack.push(frame);
  return generated(frame, { status: 'runnable', callStack: stack }, jvm.jit, false);
}

const grid = makeMethod('grid', '(II)[[I', ['iload_0', 'iload_1', { op: 'multianewarray', arg: ['[[I', 2] }, 'areturn'], 2);
const longs = makeMethod('longs', '(II)[[J', ['iload_0', 'iload_1', { op: 'multianewarray', arg: ['[[J', 2] }, 'areturn'], 2);
const partial = makeMethod('partial', '(I)[[[Ljava/lang/String;', ['iload_0', { op: 'multianewarray', arg: ['[[[Ljava/lang/String;', 1] }, 'areturn'], 1);

function checkGrid(t, label, value) {
  t.equal(value?.length, 3, `${label}: 3 rows`);
  t.equal(value?.type, '[[I', `${label}: outer runtime class`);
  t.equal(value?.[2]?.type, '[I', `${label}: row runtime class`);
  t.equal(value?.[2]?.length, 4, `${label}: row length`);
  t.equal(value?.[1]?.[3], 0, `${label}: int leaves are 0`);
  t.notEqual(value?.[0], value?.[1], `${label}: rows are distinct arrays`);
}

test('generated tiers and the runner allocate multianewarray like the interpreter', async (t) => {
  const jvm = new JVM({ jit: {compileWorker: false, structuredSsa: true, profileMethods: false} });
  const baseline = jvm.jit.compileBaselineMethod(grid);
  t.ok(baseline, 'baseline body for a multianewarray method');
  const result = runGenerated(jvm, baseline, grid, [3, 4]);
  t.ok(result?.returned, `baseline returned (${JSON.stringify(result)})`);
  checkGrid(t, 'baseline', result?.value);

  const structured = jvm.jit.structuredSsa.compile(grid);
  if (structured?.jvmStructuredSsa) {
    const structuredResult = runGenerated(jvm, structured, grid, [3, 4]);
    t.ok(structuredResult?.returned, 'structured returned');
    checkGrid(t, 'structured', structuredResult?.value);
  } else {
    t.comment(`structured tier declined: ${jvm.jit.structuredSsa.lastRejectionReason || '?'}`);
  }

  const longBody = jvm.jit.compileBaselineMethod(longs);
  const longResult = runGenerated(jvm, longBody, longs, [2, 2]);
  t.equal(longResult?.value?.[1]?.[1], 0n, 'long leaves are 0n, as the interpreter allocates them');

  const partialBody = jvm.jit.compileBaselineMethod(partial);
  const partialResult = runGenerated(jvm, partialBody, partial, [2]);
  t.equal(partialResult?.value?.type, '[[[Ljava/lang/String;', 'fewer dimensions than the class: outer tagged');
  t.equal(partialResult?.value?.[1], null, 'unallocated inner dimensions are null');

  let negative = null;
  try { runGenerated(jvm, baseline, grid, [2, -1]); } catch (thrown) { negative = thrown; }
  t.equal(negative?.type, 'java/lang/NegativeArraySizeException', 'a negative count throws NegativeArraySizeException');

  // The runner (the JIT's own interpreter for frames without a body).
  const frame = new Frame(grid);
  frame.locals[0] = 3; frame.locals[1] = 4;
  const callStack = new Stack();
  callStack.push(frame);
  const runner = await jvm.jit.runFrame(frame, { status: 'runnable', callStack });
  t.ok(runner?.returned, 'runner returned');
  checkGrid(t, 'runner', runner?.value);
  t.end();
});

test('a prepared body with new int[a][b] keeps its synchronous body', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multianewarray-'));
  t.teardown(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.writeFileSync(path.join(dir, 'Main.java'), [
    'public class Main {',
    '  static int sum;',
    '  static int[][] grid(int a, int b) { int[][] g = new int[a][b]; g[a - 1][b - 1] = a * b; return g; }',
    '  static long[][][] cube(int n) { return new long[n][n][]; }',
    '  public static void main(String[] args) {',
    '    for (int i = 1; i < 40; i++) { int[][] g = grid(i, 3); sum += g[i - 1][2] + g.length; }',
    '    long[][][] c = cube(5); sum += c.length + (c[4][4] == null ? 1000 : 0);',
    '  }',
    '}',
  ].join('\n'));
  frontend.compileJavaFile(path.join(dir, 'Main.java'), {outputDir: dir, sourceFileName: 'Main.java'});
  const jvm = new JVM({classpath: dir, jit: {compileWorker: false}});
  await jvm.run('Main');
  let expected = 0;
  for (let i = 1; i < 40; i++) expected += i * 3 + i;
  expected += 5 + 1000;
  t.equal(jvm.classes.Main.staticFields.get('sum:I'), expected, 'correct result');
  const items = jvm.classes.Main.ast.classes[0].items;
  for (const name of ['grid', 'cube']) {
    const method = items.find((item) => item.type === 'method' && item.method.name === name).method;
    t.ok(jvm.jit.getCodeItems(method).some((item) => (item?.instruction?.op || item?.instruction) === 'multianewarray'), `${name} really contains multianewarray`);
    t.ok(jvm.jit.hasPublishedSynchronousBody(method), `${name} was prepared with a synchronous body`);
    t.notOk(jvm.jit.deoptedMethods.has(method), `${name} never deopted for good (${jvm.jit.lastMethodDeoptReasons.get(method) || 'no reason'})`);
  }
  const unsupported = [...jvm.jit.preparedCodegenDeopts.keys()].filter((key) => key.includes('unsupported'));
  t.deepEqual(unsupported, [], 'no "unsupported generated opcode" deopt');
  t.end();
});
