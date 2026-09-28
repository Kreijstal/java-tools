'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const CallStack = require('../src/core/callStack');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const compile = makeJavaFixtureCompiler('wasm-nested-retirement-');

for (const structured of [false, true]) for (const isStatic of [false, true]) {
  test(`captured ${isStatic ? 'static' : 'instance'} link retires repeated exits (${structured ? 'structured' : 'dispatcher'})`, async t => {
    const previousInline = process.env.JVM_WASM_INLINE;
    process.env.JVM_WASM_INLINE = '0';
    t.teardown(() => {
      if (previousInline === undefined) delete process.env.JVM_WASM_INLINE;
      else process.env.JVM_WASM_INLINE = previousInline;
    });
    const classpath = compile(t, 'NestedRetirement', `
public class NestedRetirement {
  ${isStatic ? 'static ' : ''}int step(int[] values, int i, long seed, double gain) {
    values[0]++;
    if (values[1] != 0) values[0] += "abc".length();
    return values[0] + i + (int) seed + (int) gain;
  }
  ${isStatic ? 'static ' : ''}int hop(int[] values, int i, long seed, double gain) {
    return step(values, i, seed, gain);
  }
  static int drive(NestedRetirement self, int[] values) {
    int sum = 0;
    for (int i = 0; i < 2; i++) sum += 17 + ${isStatic ? '' : 'self.'}hop(values, i, 5L, 1.25);
    return sum;
  }
}`);
    const j = new JVM({classpath, jit: {compileWorker: false, wasm: {structured}}});
    await j.preloadClasspathClasses();
    j._setClassInitializationState('NestedRetirement', 'INITIALIZED');
    const w = j.jit.wasmJit;
    const states = {};
    for (const name of ['step', 'hop', 'drive']) {
      const descriptor = name === 'drive' ? '(LNestedRetirement;[I)I' : '([IIJD)I';
      const method = await j.findMethodInHierarchy('NestedRetirement', name, descriptor);
      const state = w.methodState({method});
      w.compile({className: 'NestedRetirement', method}, state, {asCallee: true});
      states[name] = {method, state};
      t.equal(state.status, 'ready', `${name}: ${state.lastCompileError || 'ready'}`);
    }
    const {method, state} = states.drive;
    t.notOk(states.step.state.meta.normalFlowFullyCompiled, 'fixture exercises a real unsupported island');
    const originalModule = state.meta;
    const values = [0, 1]; values.type = '[I';
    const receiver = {type: 'NestedRetirement', fields: {}, hashCode: 1};
    let mismatches = 0;
    w.compilationFrozen = true;
    for (let iteration = 0; iteration < 300; iteration++) {
      const frame = new Frame(method);
      frame.className = 'NestedRetirement'; frame.locals[0] = receiver; frame.locals[1] = values;
      const thread = {id: 1, status: 'runnable', callStack: new CallStack()};
      thread.callStack.push(frame);
      const result = w.execute(frame, thread, state, 0);
      let returned = result.value, steps = 0;
      while (!thread.callStack.isEmpty() && ++steps < 10000) {
        const f = thread.callStack.peek(), instruction = f.instructions[f.pc++].instruction;
        if ((typeof instruction === 'string' ? instruction : instruction?.op) === 'ireturn' && f === frame) returned = f.stack.peek();
        if (instruction) await j.executeInstruction(instruction, f, thread);
      }
      if (!thread.callStack.isEmpty() || returned !== 16 * iteration + 59) mismatches++;
    }
    t.equal(mismatches, 0, 'return values and the operand under each call survive every handoff');
    t.equal(values[0], 2400, 'side effects before and after the exit run exactly once');
    t.equal(state.meta, originalModule, 'existing caller works without recompilation');
    for (const name of ['step', 'hop']) {
      const nested = states[name].state;
      t.ok(nested.linkVetoed, `${name} retires, including propagated nested exits`);
      t.ok(nested.nestedCalls > 0 && nested.nestedCalls <= 257,
        `${name} stops entering its compiled body after retirement (${nested.nestedCalls})`);
    }
    t.end();
  });
}
