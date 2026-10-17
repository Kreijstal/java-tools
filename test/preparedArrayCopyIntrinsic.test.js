'use strict';
const test = require('tape');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const {JVM} = require('../src/core/jvm');
const Frame = require('../src/core/frame');
const Stack = require('../src/core/stack');
const compile = makeJavaFixtureCompiler('prepared-copy-intrinsic-');
const source = `public class CopyCaller {
  static int events, result;
  static int call(int[] src, int[] out, int n) {
    events = events * 10 + 1;
    out[0] = 7;
    ColdCopy.copy(src, 0, out, 1, n);
    return out[1];
  }
  public static void main(String[] args) {
    int[] src = {42}; int[] out = new int[2];
    result = call(src, out, 1) + call(src, out, 1);
  }
}
class ColdCopy {
  static int stamp = initialize();
  static int initialize() { CopyCaller.events = CopyCaller.events * 10 + 2; return 123; }
  static void copy(int[] src, int s, int[] dst, int d, int n) {
    if (src == dst && s == d) return;
    if (src == dst && d > s && d < s + n) {
      s += n; d += n;
      while (n >= 4) { ${'dst[--d] = src[--s];'.repeat(4)} n -= 4; }
      while (n-- > 0) dst[--d] = src[--s];
    } else {
      while (n >= 4) { ${'dst[d++] = src[s++];'.repeat(4)} n -= 4; }
      while (n-- > 0) dst[d++] = src[s++];
    }
  }
}`;

test('cold copy intrinsic retains the invoke initialization boundary and transports', async t => {
  const classpath = compile(t, 'CopyCaller', source);
  const j = new JVM({classpath, jit:{compileWorker:false, structuredSsa:true}});
  await j.preloadClasspathClasses();
  j._setClassInitializationState('CopyCaller', 'INITIALIZED');
  const method = j.findMethod(j.classes.CopyCaller, 'call', '([I[II)I');
  const generated = j.jit.structuredSsa.compile(method);
  t.ok(generated, 'caller compiles while target is cold');
  if (!generated) {t.end(); return;}
  t.ok(generated.jvmGeneratedSource.includes('helpers.primitiveArrayCopyDirect('),
    'copy skips generic invoke dispatch');
  const restored = j.jit.materializeGeneratedResult(j.jit.serializeGeneratedResult(generated), method);
  t.ok(restored, 'cold-owner token survives worker/cache transport');
  for (const body of [generated, restored]) {
    for (const state of [undefined, 'INITIALIZING', 'ERRONEOUS', 'INITIALIZED']) {
      j._setClassInitializationState('ColdCopy', state);
      j.classes.CopyCaller.staticFields.set('events:I', 0);
      const src = new Int32Array([42]), out = new Int32Array(2);
      const frame = new Frame(method);frame.className = 'CopyCaller';
      frame.locals.splice(0, 3, src, out, 1);
      const thread = {status:'runnable', callStack:new Stack()};thread.callStack.push(frame);
      const result = body(frame, thread, j.jit, false);
      t.equal(out[0], 7, 'effect before invoke survives: '+state);
      t.equal(j.classes.CopyCaller.staticFields.get('events:I'), 1, 'caller effect runs exactly once');
      if (state === 'INITIALIZED') {
        t.equal(result.value, 42, 'prepared body uses direct copy when initialized');
        t.deepEqual([...out], [7, 42], 'copy result');
      } else {
        t.ok(result.deopt, 'unready/failed target follows canonical initialization');
        t.equal(frame.instructions[frame.pc].instruction.op, 'invokestatic', 'fallback is at invoke');
        t.deepEqual(frame.stack.items, [src, 0, out, 1, 1], 'invoke operands are intact');
        t.equal(out[1], 0, 'copy did not run before initialization');
      }
    }
    for (const [src, count, type] of [
      [null, 1, 'java/lang/NullPointerException'],
      [new Int32Array([42]), 2, 'java/lang/ArrayIndexOutOfBoundsException'],
    ]) {
      const out = new Int32Array(2), frame = new Frame(method);
      frame.className = 'CopyCaller';frame.locals.splice(0, 3, src, out, count);
      const thread = {status:'runnable', callStack:new Stack()};thread.callStack.push(frame);
      t.throws(() => body(frame, thread, j.jit, false), error => error.type === type,
        'copy exception is preserved: '+type);
      t.equal(out[0], 7, 'preceding effect survives copy exception');
      t.equal(frame.instructions[frame.pc].instruction.op, 'invokestatic', 'exception materializes original call PC');
      t.deepEqual(frame.stack.items, [src, 0, out, 1, count], 'exception materializes original operands');
    }
  }
  const copy = j.findMethod(j.classes.ColdCopy, 'copy', '([II[III)V');
  const instruction = {op:'invokestatic', arg:['Method', 'ColdCopy', ['copy', copy.descriptor]]};
  const flags = copy.flags;
  for (const flag of ['synchronized', 'native', 'abstract']) {
    copy.flags = [...flags, flag];
    t.equal(j.jit.getCompileTimeSynchronousIntrinsic(instruction), null, flag+' target is not bypassed');
  }
  copy.flags = flags;
  t.notEqual(j.classes.ColdCopy.staticFields.get('stamp:I'), 123, 'planning never executes initializer');
  t.end();
});

test('prepared copy runs real initialization once in guest effect order', async t => {
  const classpath = compile(t, 'CopyCaller', source);
  const j = new JVM({classpath, prepareBeforeMain:true, jit:{compileWorker:false, structuredSsa:true}});
  await j.run('CopyCaller');
  t.equal(j.classes.CopyCaller.staticFields.get('events:I'), 121, 'initializer runs between caller effects');
  t.equal(j.classes.CopyCaller.staticFields.get('result:I'), 84, 'both calls return copied values');
  t.equal(j.classes.ColdCopy.staticFields.get('stamp:I'), 123, 'initializer completes');
  t.end();
});
