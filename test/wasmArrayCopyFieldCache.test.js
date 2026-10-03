'use strict';
const test = require('tape');
const {makeJavaFixtureCompiler} = require('./javaFixture');
const {JVM} = require('../src/core/jvm');
const Compiler = require('../src/jit/StructuredWasmCompiler');
const compile = makeJavaFixtureCompiler('copy-field-cache-');

test('only built-in arraycopy preserves cached guest field values', async t => {
  const classpath = compile(t, 'CopyFieldCache', `public class CopyFieldCache {
    static int value;
    public static int run(int[] source, int[] target, int n) {
      int sum=0;
      for(int i=0;i<n;i++) {
        sum+=value;
        System.arraycopy(source,0,target,0,1);
        sum+=value;
      }
      return sum;
    }
  }`);
  for (const heapBulkCopy of [false,true]) {
    const jvm = new JVM({classpath,wasmHeap:true,
      jit:{compileWorker:false,wasmStructured:true,wasm:{heapBulkCopy}}});
    await jvm.preloadClasspathClasses();
    for(const name of ['java/lang/System','CopyFieldCache'])jvm.classInitializationState.set(name,'INITIALIZED');
    const method=await jvm.findMethodInHierarchy('CopyFieldCache','run','([I[II)I');
    const fields=jvm.classes.CopyFieldCache.staticFields;
    const source=jvm.wasmHeap.alloc('[I',1),target=jvm.wasmHeap.alloc('[I',1);source[0]=42;
    const natives=jvm.jre['java/lang/System'].staticMethods;
    const key='arraycopy(Ljava/lang/Object;ILjava/lang/Object;II)V',native=natives[key];
    const positional=native.jvmPositionalBody;
    for(const mode of ['builtin','native-override','positional-override']) {
      let copies=0,reads=0;
      const replacement=(src,from,dst,to,count)=>{
        copies++;fields.set('value:I',fields.get('value:I')+1);
        return positional(src,from,dst,to,count);
      };
      try {
        fields.set('value:I',mode==='builtin'?7:0);target[0]=0;
        if(mode==='native-override')natives[key]=(j,receiver,args)=>replacement(...args);
        if(mode==='positional-override')native.jvmPositionalBody=replacement;
        const meta=new Compiler(jvm,method,'CopyFieldCache',jvm.jit.wasmJit).translate();
        const env=meta.importObject.env,name='gs_CopyFieldCache_value',read=env[name];
        t.equal(typeof read,'function',`${mode}: fixture uses the intended field import`);
        env[name]=()=>{reads++;return read();};
        const {run}=new WebAssembly.Instance(new WebAssembly.Module(meta.bytes),meta.importObject).exports;
        t.equal(run(source,target,5,0,1000000),-1,`${mode}: compiled loop completes`);
        t.equal(meta.box.ret,mode==='builtin'?70:25,`${mode}: field reads observe native side effects`);
        t.equal(target[0],42,`${mode}: array elements are still copied`);
        if(mode==='builtin') {
          t.equal(reads,1,'built-in copy preserves the field cache across iterations');
          t.equal(meta.heapCopyArrayCount,heapBulkCopy?2:0,'both native and heap paths preserve the cache');
        } else {
          t.equal(copies,5,'every custom copy executes');
          t.ok(reads>1,'custom side effects force field cache reloads');
          t.equal(meta.heapCopyArrayCount,0,'custom body never selects the raw path');
        }
      } finally {natives[key]=native;native.jvmPositionalBody=positional;}
    }
  }
  t.end();
});
