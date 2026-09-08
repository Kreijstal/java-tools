'use strict';

const test = require('tape');
const fs = require('fs');
const os = require('os');
const path = require('path');
const frontend = require('../src/java-frontend');
const { JVM } = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');

test('handler-only null diagnostics do not disable normal array views', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handler-array-view-'));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'HandlerArrayView.java');
  fs.writeFileSync(file, `public class HandlerArrayView {
    static void required(int[] a, int[] out, int n) {
      try { for (int i=0; i<n; i++) a[i] = a[i] + 7; }
      catch (RuntimeException e) { out[0] = a == null ? 11 : 22; }
    }
    static void optional(int[] a, int[] out, int n) {
      if (a != null) for (int i=0; i<n; i++) a[i] = a[i] + 7;
      out[0] = 33;
    }
    static void sibling(int[] flag, int[] a, int[] out) {
      if (flag != null) a[0] = 7;
      out[0] = 44;
    }
  }`);
  frontend.compileJavaFile(file, { outputDir: dir });
  const cases = [['required', false, 2], ['required', false, 3],
    ['required', true, 2], ['required', true, 0],
    ['optional', true, 2], ['optional', false, 2], ['sibling', true, 0]];
  const expected = [];
  for (const enabled of [false, true]) {
    for (const [caseIndex, [name, nullArray, count]] of cases.entries()) {
      const j = new JVM({ classpath: dir, jit: { enabled, compileWorker: false,
        wasm: false, warmupThreshold: 0, structuredSsa: true,
        normalPathArrayOptionality: true } });
      await j.preloadClasspathClasses();
      j._setClassInitializationState('HandlerArrayView', 'INITIALIZED');
      const descriptor = name === 'sibling' ? '([I[I[I)V' : '([I[II)V';
      const method = j.findMethod(j.classes.HandlerArrayView, name, descriptor);
      if (enabled) {
        const g = j.jit.getGeneratedFunction(method,
          { allowEffectfulCalls: true, compileLocally: true });
        t.ok(g?.jvmStructuredSsa, name + ' compiles');
        const source = g.jvmRestoringDirectPositionalSource || g.jvmStructuredSource;
        if (name === 'required') t.ok(source.includes('ssaEntryArrayData0'),
          'required array keeps its scalar storage view');
        else t.notOk(source.includes('ssaEntryArrayData0'),
          'normal-path optional array stays optional');
        // Transport the same prepared body before running it.
        const rebound = j.jit.materializeGeneratedResult(j.jit.serializeGeneratedResult(g), method);
        t.ok(rebound?.jvmStructuredSsa, 'prepared body transports');
        j.jit.codegenCache.set(method, rebound);
      }
      const a = nullArray ? null : Object.assign([1, 2], {type: '[I'});
      const out = Object.assign([0], {type: '[I'});
      const frame = new Frame(method);
      frame.className = 'HandlerArrayView';
      frame.locals[0] = a;
      frame.locals[1] = name === 'sibling' ? null : out;
      frame.locals[2] = name === 'sibling' ? out : count;
      const thread = { id: 0, name: 'array-view', status: 'runnable',
        pendingException: null, callStack: new Stack() };
      j.threads = [thread]; j.currentThreadIndex = 0;
      thread.callStack.push(frame);
      let ticks = 0;
      while (thread.callStack.size() && ticks++ < 10000) await j.executeTick();
      t.ok(ticks < 10000, 'execution completes without a deopt loop');
      const result = { a: a && [...a], out: [...out], error: thread.pendingException?.type || null };
      if (!enabled) expected.push(result);
      else t.deepEqual(result, expected[caseIndex], 'writes and caught null/bounds behavior match interpreter');
    }
  }
  t.deepEqual(expected.map(r => r.out[0]), [0, 22, 11, 0, 33, 33, 44],
    'fixture exercises catches, zero-trip null, optional and sibling arrays');
  t.end();
});
