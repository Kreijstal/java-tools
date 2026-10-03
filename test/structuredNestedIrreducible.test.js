// A multiple-entry loop nested inside a reducible loop: the enclosing loop has
// one entry (its header) and only the inner component has two, both entered
// from the enclosing body. The dispatch-island transformation has to find
// that inner component (peeling the outer header), not give up because the
// maximal component looks single-entry.
'use strict';
const test = require('tape');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

// locals: 0 = n, 1 = acc, 2 = mode. Outer loop at Louter; inner two-entry
// loop {La, Lb}, entered at La or Lb depending on mode.
const instructions = [
  /* 0 Louter */ { op: 'iinc', varnum: 0, incr: -1 },
  /* 1 */ 'iload_0', /* 2 */ { op: 'ifle', arg: 'Lreturn' },
  /* 3 */ 'iload_2', /* 4 */ { op: 'ifne', arg: 'Lb' },
  /* 5 La */ { op: 'iinc', varnum: 1, incr: 1 }, /* 6 */ 'iload_1',
  /* 7 */ { op: 'bipush', arg: 10 }, /* 8 */ { op: 'if_icmpge', arg: 'Louter' },
  /* 9 */ { op: 'goto', arg: 'Lb' },
  /* 10 Lb */ { op: 'iinc', varnum: 1, incr: 2 }, /* 11 */ 'iload_1',
  /* 12 */ { op: 'bipush', arg: 10 }, /* 13 */ { op: 'if_icmpge', arg: 'Louter' },
  /* 14 */ { op: 'goto', arg: 'La' },
  /* 15 Lreturn */ 'iload_1', /* 16 */ 'ireturn',
];
const labels = {0: 'Louter:', 5: 'La:', 10: 'Lb:', 15: 'Lreturn:'};
const method = {
  name: 'nested', descriptor: '(III)I', flags: ['static'],
  attributes: [{ type: 'code', code: {
    codeItems: instructions.map((instruction, index) =>
      ({ labelDef: labels[index] || `L${index}:`, instruction })),
    localsSize: '3', stackSize: '2', exceptionTable: [],
  } }],
};

function reference(n, acc, mode) {
  for (;;) {
    n -= 1;
    if (n <= 0) return acc;
    let at = mode !== 0 ? 'b' : 'a';
    for (;;) {
      if (at === 'a') { acc += 1; if (acc >= 10) break; at = 'b'; }
      else { acc += 2; if (acc >= 10) break; at = 'a'; }
    }
  }
}

test('structured SSA compiles a multiple-entry loop nested in a reducible loop', (t) => {
  const jvm = new JVM({ jit: {compileWorker: false, structuredSsa: true, profileMethods: false} });
  const generated = jvm.jit.structuredSsa.compile(method);
  t.ok(generated?.jvmStructuredSsa, `compiled (${jvm.jit.structuredSsa.lastRejectionReason || 'ok'})`);
  t.equal(generated?.jvmStructuredDispatchIslands, 1, 'one dispatch island owns the inner entries');
  for (const [n, acc, mode] of [[1, 0, 0], [3, 0, 0], [3, 0, 1], [5, 4, 1], [6, -20, 0], [2, 9, 1], [40, -100, 1]]) {
    const frame = new Frame(method);
    frame.locals[0] = n; frame.locals[1] = acc; frame.locals[2] = mode;
    const stack = new Stack();
    stack.push(frame);
    const result = generated(frame, { status: 'runnable', callStack: stack }, jvm.jit, false);
    t.ok(result?.returned && result.value === reference(n, acc, mode),
      `nested(${n}, ${acc}, ${mode}) = ${reference(n, acc, mode)} (${JSON.stringify(result)})`);
  }
  t.end();
});
