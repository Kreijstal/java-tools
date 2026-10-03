// The JIT runner (runFrame, the interpreter for frames the JIT owns without
// a generated body) lacked ordinary opcodes the generated tier has always
// had: long constants/loads/stores/arithmetic, pop2, dup_x2, dup2_x2, i2c,
// i2s, instanceof, tableswitch, lookupswitch. A prepared frame resumed there
// after a transient deopt then deopted for good at the first of them
// ("unsupported opcode lconst_0 in en.<init>") and ran interpreted forever.
'use strict';
const test = require('tape');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

function makeMethod(name, descriptor, instructions, localsSize) {
  return { name, descriptor, flags: ['static'],
    attributes: [{ type: 'code', code: {
      codeItems: instructions.map((instruction, index) => ({ labelDef: `L${index}:`, instruction })),
      localsSize: String(localsSize), stackSize: '6', exceptionTable: [],
    } }] };
}

async function run(jvm, method, locals) {
  const frame = new Frame(method);
  locals.forEach((value, index) => { frame.locals[index] = value; });
  const callStack = new Stack();
  callStack.push(frame);
  return jvm.jit.runFrame(frame, { status: 'runnable', callStack });
}

const cases = [
  { name: 'long arithmetic', locals: [5n, undefined, 3n, undefined], expected: BigInt.asIntN(64, ((5n + 3n) * 1n - 0n) << 2n | 1n),
    method: makeMethod('longs', '(JJ)J', ['lload_0', 'lload_2', 'ladd', 'lconst_1', 'lmul', 'lconst_0', 'lsub', 'iconst_2', 'lshl', 'lconst_1', 'lor', 'lstore_0', 'lload_0', 'lreturn'], 4) },
  { name: 'lrem/lneg/land/lushr', locals: [-17n, undefined], expected: BigInt.asIntN(64, ((BigInt.asUintN(64, -17n) >> 60n) & 0xfn) + (-((-17n) % 5n))),
    method: makeMethod('mix', '(J)J', ['lload_0', { op: 'bipush', arg: 60 }, 'lushr', { op: 'ldc2_w', arg: 15n }, 'land', 'lload_0', { op: 'ldc2_w', arg: 5n }, 'lrem', 'lneg', 'ladd', 'lreturn'], 2) },
  { name: 'pop2 of a long', locals: [7n, undefined, 9], expected: 9,
    method: makeMethod('popLong', '(JI)I', ['iload_2', 'lload_0', 'pop2', 'ireturn'], 3) },
  { name: 'pop2 of two ints', locals: [1, 2, 3], expected: 3,
    method: makeMethod('popInts', '(III)I', ['iload_2', 'iload_0', 'iload_1', 'pop2', 'ireturn'], 3) },
  { name: 'dup_x2 over two ints', locals: [1, 2, 3], expected: 5, // a b c -> c a b c; isub: b - c = -1; isub: a - (-1) = 2; iadd: c + 2 = 5
    method: makeMethod('dupX2', '(III)I', ['iload_0', 'iload_1', 'iload_2', 'dup_x2', 'isub', 'isub', 'iadd', 'ireturn'], 3) },
  { name: 'dup2_x2 form 4 (long over long)', locals: [2n, undefined, 10n, undefined], expected: 10n - (2n - 10n),
    method: makeMethod('dup2X2', '(JJ)J', ['lload_0', 'lload_2', 'dup2_x2', 'lsub', 'lsub', 'lreturn'], 4) },
  { name: 'i2c / i2s', locals: [0x1ffff], expected: (0xffff << 16 >> 16),
    method: makeMethod('narrow', '(I)I', ['iload_0', 'i2c', 'i2s', 'ireturn'], 1) },
  { name: 'tableswitch', locals: [2], expected: 22,
    method: makeMethod('table', '(I)I', ['iload_0', { op: 'tableswitch', low: 1, labels: ['L3', 'L5'], defaultLbl: 'L7' }, 'nop', { op: 'bipush', arg: 11 }, 'ireturn', { op: 'bipush', arg: 22 }, 'ireturn', { op: 'bipush', arg: 99 }, 'ireturn'], 1) },
  { name: 'tableswitch default', locals: [9], expected: 99,
    method: makeMethod('tableDefault', '(I)I', ['iload_0', { op: 'tableswitch', low: 1, labels: ['L3', 'L5'], defaultLbl: 'L7' }, 'nop', { op: 'bipush', arg: 11 }, 'ireturn', { op: 'bipush', arg: 22 }, 'ireturn', { op: 'bipush', arg: 99 }, 'ireturn'], 1) },
  { name: 'lookupswitch', locals: [500], expected: 5,
    method: makeMethod('lookup', '(I)I', ['iload_0', { op: 'lookupswitch', arg: { pairs: [[100, 'L3'], [500, 'L5']], defaultLabel: 'L7' } }, 'nop', 'iconst_1', 'ireturn', 'iconst_5', 'ireturn', 'iconst_m1', 'ireturn'], 1) },
  { name: 'instanceof null', locals: [null], expected: 0,
    method: makeMethod('inst', '(Ljava/lang/Object;)I', ['aload_0', { op: 'instanceof', arg: 'java/lang/String' }, 'ireturn'], 1) },
];

test('the JIT runner executes the ordinary opcodes the generated tier has', async (t) => {
  const jvm = new JVM({ jit: {compileWorker: false, profileMethods: false} });
  for (const {name, method, locals, expected} of cases) {
    const result = await run(jvm, method, locals);
    t.ok(result?.returned, `${name}: returned (${JSON.stringify(result, (k, v) => typeof v === 'bigint' ? String(v) + 'n' : v)})`);
    t.equal(result?.value, expected, `${name}: value ${String(expected)}`);
  }
  t.end();
});
