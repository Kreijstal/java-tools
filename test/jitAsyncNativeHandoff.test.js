'use strict';
const test = require('tape');
const {JVM} = require('../src/core/jvm');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const fixture = makeJavaFixtureCompiler('jit-async-native-handoff-');

test('prepared native Promise fallback consumes each read exactly once', async t => {
  const classpath = fixture(t, 'NativeReads', `public class NativeReads {
    static native int read();
    static int first, second;
    static int nested() { return read(); }
    public static void main(String[] args) { first = nested(); second = nested(); }
  }`);
  for (const structuredSsa of [false, true]) {
    let reads = 0;
    const jvm = new JVM({classpath, prepareBeforeMain:true, jit:{
      compileWorker:false, structuredSsa, compiledCallChains:true,
      ordinaryAdaptiveFramelessPositional:true,
    }, jreOverrides:{NativeReads:{natives:{applicationFallback:true}, methods:{
      'read()I': () => Promise.resolve(++reads),
    }}}});
    await jvm.run('NativeReads');
    t.equal(reads, 2, `two reads with structured SSA=${structuredSsa}`);
    t.equal(jvm.classes.NativeReads.staticFields.get('first:I'), 1, 'first result survives fallback');
    t.equal(jvm.classes.NativeReads.staticFields.get('second:I'), 2, 'second result survives fallback');
  }
  t.end();
});

test('prepared instance native rejection is delivered once and releases handoff state', async t => {
  const classpath = fixture(t, 'NativeStreamReads', `import java.io.*;
public class NativeStreamReads {
  static native InputStream stream();
  static int first, failure, second;
  static int nested(InputStream stream) throws IOException { return stream.read(); }
  public static void main(String[] args) throws IOException {
    InputStream stream = stream();
    first = nested(stream);
    try { nested(stream); } catch (IOException expected) { failure = 1; }
    second = nested(stream);
  }
}`);
  for (const structuredSsa of [false, true]) {
    let reads = 0;
    const stream = {type:'java/net/SocketInputStream'};
    const jvm = new JVM({classpath, prepareBeforeMain:true, jit:{
      compileWorker:false, structuredSsa, compiledCallChains:true,
      ordinaryAdaptiveFramelessPositional:true,
    }, jreOverrides:{NativeStreamReads:{natives:{applicationFallback:true}, methods:{
      'stream()Ljava/io/InputStream;': () => stream,
    }}}});
    const nativeMethods = jvm.jre['java/net/SocketInputStream'].methods;
    const originalRead = nativeMethods['read()I'];
    const threads = new Set();
    nativeMethods['read()I'] = (_jvm, _receiver, _args, thread) => {
      threads.add(thread);
      const value = ++reads;
      return new Promise((resolve, reject) => setTimeout(() => value === 2
        ? reject({type:'java/io/IOException', message:'read failed'}) : resolve(value), 0));
    };
    try { await jvm.run('NativeStreamReads'); }
    finally { nativeMethods['read()I'] = originalRead; }
    const fields = jvm.classes.NativeStreamReads.staticFields;
    t.equal(reads, 3, `three operations with structured SSA=${structuredSsa}`);
    t.equal(fields.get('first:I'), 1, 'first delayed result');
    t.equal(fields.get('failure:I'), 1, 'rejection reaches the Java exception handler');
    t.equal(fields.get('second:I'), 3, 'next read proceeds after rejection');
    t.ok(threads.size > 0 && [...threads].every(thread => !thread.pendingNativeInvocation), 'no native payload retained on threads');
  }
  t.end();
});
