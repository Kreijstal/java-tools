'use strict';
const test = require('tape');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

test('outlined scalar spills preserve safe points, exceptions, and transport', t => {
  const items = [];
  const emit = (instruction, labelDef) => items.push({instruction, labelDef});
  for (let slot = 4; slot < 12; slot++) {
    emit({op: 'bipush', arg: String(100 + slot)});
    emit({op: 'istore', arg: String(slot)});
  }
  emit('iconst_0'); emit('istore_3');
  const loopPc = items.length;
  emit('iload_3', 'Lloop:'); emit('iload_0');
  emit({op: 'if_icmpge', arg: 'Lreturn'});
  emit('iload_1'); emit('iload_3'); emit('iadd'); emit('istore_1');
  emit('iload_1'); emit('iload_2');
  const divisionPc = items.length;
  emit('idiv'); emit('pop');
  emit({op: 'iinc', varnum: '3', incr: '1'});
  emit({op: 'goto', arg: 'Lloop'});
  emit('iload_1', 'Lreturn:'); emit('ireturn');
  const method = {className: 'ScalarSpillHarness', name: 'sum',
    descriptor: '(III)I', flags: ['static'], attributes: [{type: 'code', code: {
      codeItems: items, localsSize: '12', stackSize: '2', exceptionTable: [],
    }}]};
  const jvm = new JVM({jit: {compileWorker: false}});
  jvm._nextEventLoopYieldAt = 0;
  const generated = jvm.jit.compileScalarIntegerLoop(method);
  t.ok(generated?.jvmHoistedSource?.includes('function scalarSpillLocals'),
    'the spill helper lives outside the scalar activation');
  t.notOk(generated.jvmGeneratedSource.includes('locals[11] = local11;'),
    'exceptional edges do not duplicate the local assignments');
  const rebound = jvm.jit.materializeGeneratedResult(
    jvm.jit.serializeGeneratedResult(generated), method);
  t.ok(rebound, 'the existing compiled-code protocol carries the helper');
  for (const body of [generated, rebound]) {
    const frame = new Frame(method);
    frame.locals.splice(0, 3, 10001, 7, 1);
    const thread = {status: 'runnable', callStack: new Stack()};
    thread.callStack.push(frame);
    const pause = body(frame, thread, jvm.jit, false);
    t.equal(pause.deopt, true, 'the long loop yields');
    t.equal(frame.pc, loopPc, 'the exact resume PC is preserved');
    t.deepEqual(frame.locals.slice(0, 12),
      [10001, 49995007, 1, 10000, 104, 105, 106, 107, 108, 109, 110, 111],
      'every scalar local survives the outlined spill');
    delete frame.jitSkipOnce;
    t.equal(body(frame, thread, jvm.jit, false).value, 50005007,
      'resumption produces the exact integer result');
    const throwing = new Frame(method);
    throwing.locals.splice(0, 3, 1, 7, 0);
    thread.callStack.push(throwing);
    let error;
    try { body(throwing, thread, jvm.jit, false); } catch (caught) { error = caught; }
    t.equal(error?.type, 'java/lang/ArithmeticException', 'Java exceptions are preserved');
    t.equal(throwing.pc, divisionPc, 'the throwing bytecode PC is preserved');
    t.deepEqual(throwing.stack.items, [7, 0], 'throwing operands are preserved');
    t.equal(throwing.locals[11], 111, 'exceptional spills preserve high local slots');
  }
  t.end();
});
