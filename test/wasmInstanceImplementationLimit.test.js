'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const CallStack = require('../src/core/callStack');
const {newFields, makeObjectRef, readField} = require('../src/core/objectModel');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const compile = makeJavaFixtureCompiler('wasm-dispatch-limit-');
const source = `
public class DispatchLimit {
  static abstract class Base { int calls; abstract int value(int i); }
  ${Array.from({length: 6}, (_, i) => `static class Voice${i} extends Base {
    int value(int i) { calls++; return i + ${i}; }
  }`).join('\n')}
  static int mix(Base voice, int count) {
    int sum = 0;
    for (int i = 0; i < count; i++) sum += voice.value(i);
    return sum;
  }
}`;

for (const structured of [false, true]) {
  test(`bounded instance dispatch configuration (${structured ? 'structured' : 'dispatcher'})`, async t => {
    const saved = process.env.JVM_WASM_INLINE;
    process.env.JVM_WASM_INLINE = '0';
    t.teardown(() => {
      if (saved === undefined) delete process.env.JVM_WASM_INLINE;
      else process.env.JVM_WASM_INLINE = saved;
    });
    const classpath = compile(t, 'DispatchLimit', source);
    for (const limit of [4, 8]) {
      const j = new JVM({classpath, jit: {compileWorker: false, wasm: {
        structured, maxInstanceImplementations: limit,
      }}});
      await j.preloadClasspathClasses();
      for (const name of Object.keys(j.classes)) j._setClassInitializationState(name, 'INITIALIZED');
      const w = j.jit.wasmJit;
      for (let i = 0; i < 6; i++) {
        const owner = `DispatchLimit$Voice${i}`;
        const method = await j.findMethodInHierarchy(owner, 'value', '(I)I');
        w.compile({method, className: owner}, w.methodState({method}), {asCallee: true});
      }
      const method = await j.findMethodInHierarchy('DispatchLimit', 'mix', '(LDispatchLimit$Base;I)I');
      const state = w.methodState({method});
      w.compile({method, className: 'DispatchLimit'}, state);
      t.equal(state.status, limit === 8 ? 'ready' : 'failed', 'only the admitted dispatch cone compiles');
      t.equal(Boolean(state.meta?.fullyCompiled), limit === 8, 'configured bound controls coverage');
      for (let i = 0; i < 6; i++) {
        const owner = `DispatchLimit$Voice${i}`;
        const voice = makeObjectRef(j, owner, newFields(j, owner));
        const frame = new Frame(method);
        frame.className = 'DispatchLimit'; frame.locals[0] = voice; frame.locals[1] = 12;
        const thread = {id: 1, status: 'runnable', callStack: new CallStack()};
        thread.callStack.push(frame);
        const result = state.status === 'ready' ? w.execute(frame, thread, state, 0) : {};
        let returned = result.value, steps = 0;
        while (!thread.callStack.isEmpty() && ++steps < 10000) {
          const f = thread.callStack.peek(), instruction = f.instructions[f.pc++].instruction;
          if ((typeof instruction === 'string' ? instruction : instruction?.op) === 'ireturn' && f === frame) returned = f.stack.peek();
          if (instruction) await j.executeInstruction(instruction, f, thread);
        }
        t.ok(thread.callStack.isEmpty(), 'compiled execution or fallback completes');
        t.equal(returned, 66 + 12 * i, 'receiver dispatch produces the exact result');
        t.equal(readField(voice.fields, 'DispatchLimit$Base.calls'), 12, 'fallback never replays side effects');
        if (limit === 8) t.ok(result.returned, 'admitted receiver finishes without interpreter exits');
      }
    }
    t.end();
  });
}

test('instance dispatch bounds validate options and remain local to one JVM', t => {
  for (const value of [0, -1, 1.5, Infinity, NaN, '8', null]) {
    t.throws(() => new JVM({jit: {wasm: {maxInstanceImplementations: value}}}), /maxInstanceImplementations/);
  }
  const configured = new JVM({jit: {wasm: {maxInstanceImplementations: 8}}});
  const ordinary = new JVM();
  t.equal(configured.jit.wasmJit.maxInstanceImplementations, 8);
  t.equal(ordinary.jit.wasmJit.maxInstanceImplementations, undefined, 'default remains environment/default controlled');
  t.end();
});
