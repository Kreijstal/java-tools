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

for(const policy of [
 {codegen:false},
 {structuredSsa:false},
 {structuredSsa:true},
 {structuredSsa:true,prepareColdIntegerInlines:true},
])test(`an async override of a bytecode method wins on every call ${JSON.stringify(policy)}`,async t=>{
 const classpath=fixture(t,'BytecodeOverride',`public class BytecodeOverride {
   static int first,second;
   static int read(){return -99;}
   static int nested(){return read();}
   static int outer(){return nested();}
   public static void main(String[] args){first=outer();second=outer();}
 }`);
 let reads=0;
 const j=new JVM({classpath,prepareBeforeMain:true,jit:{compileWorker:false,
   compiledCallChains:true,ordinaryAdaptiveFramelessPositional:true,...policy},
   jreOverrides:{BytecodeOverride:{natives:{applicationFallback:true},
     methods:{'read()I':async()=>++reads}}}});
 await j.run('BytecodeOverride');
 t.equal(reads,2,'every call reaches the registered override');
 t.equal(j.classes.BytecodeOverride.staticFields.get('first:I'),1,'first native result retained');
 t.equal(j.classes.BytecodeOverride.staticFields.get('second:I'),2,'later native result retained');
 const method=await j.findMethodInHierarchy('BytecodeOverride','read','()I');
 t.equal(j.jit.getGeneratedFunction(method),null,'original body is not published');
 t.equal(j.jit.getInlineIntegerPlan(method,[],'int',true),null,'original integer leaf is not inlined');
 t.end();
});

test('ready Wasm bodies and static inlining cannot bypass a native override',async t=>{
 const classpath=fixture(t,'OverrideLinks',`public class OverrideLinks {
   static int read(){return -99;}
   int instanceRead(){return -77;}
   static int call(){return read();}
 }`);
 const j=new JVM({classpath,prepareBeforeMain:false,jit:{compileWorker:false,
   wasmStructured:true},jreOverrides:{OverrideLinks:{natives:{applicationFallback:true},
   methods:{'read()I':async()=>1,'instanceRead()I':async()=>2}}}});
 await j.preloadClasspathClasses();j.classInitializationState.set('OverrideLinks','INITIALIZED');
 const w=j.jit.wasmJit;w.enabled=true;
 for(const [name,isStatic] of [['read',true],['instanceRead',false]]){
   const method=await j.findMethodInHierarchy('OverrideLinks',name,'()I');
   const state=w.methodState({method});
   w.compile({method,className:'OverrideLinks'},state,{asCallee:true});
   t.equal(state.status,'ready','an original body is deliberately available for the stale-link test');
   t.equal(isStatic?w.findReadyStatic('OverrideLinks',name,'()I'):
     w.findReadyInstance('OverrideLinks',name,'()I'),null,'the native override withholds the original module link');
 }
 const method=await j.findMethodInHierarchy('OverrideLinks','call','()I');
 const code=method.attributes.find(a=>a.type==='code');
 const {inlineCalls}=require('../src/jit/wasmInline');
 t.equal(inlineCalls(j,code,{deepInline:true}),null,'static Wasm inlining preserves the native invoke');
 t.end();
});
