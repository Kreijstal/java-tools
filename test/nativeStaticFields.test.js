'use strict';
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const {supportsWasmJsTag}=require('../src/jit/wasmShared');
const compile=require('./javaFixture').makeJavaFixtureCompiler('native-static-fields-');
test('structured static reads and writes execute natively with dynamic accessor fallback',async t=>{
 if(!supportsWasmJsTag()){t.pass('engine retains supported compilation');t.end();return;}
 const classpath=compile(t,'NativeStaticProof',`public class NativeStaticProof {
  static int value;static volatile int ordered;
  static int bump(int by){int before=value;value=before+by;return value;}
  static int readOrdered(){return ordered;}
  static int root(int[] p,int n){for(int i=0;i<n;i++){value+=p[i];}return value;}
 }`);
 const j=new JVM({classpath,wasmHeap:true,jit:{enabled:false,compileWorker:false,retainCompilerDiagnostics:false,
  wasmStructured:true,wasm:{deepInline:false,canonicalDirectCalls:true,canonicalEhLinks:true,
   canonicalLeafCalls:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();const w=j.jit.wasmJit;w.importStatsEnabled=true;
 const prepare=(name,descriptor)=>{const method=j.findMethod(j.classes.NativeStaticProof,name,descriptor),st=w.methodState({method});
  w.compile({method,className:'NativeStaticProof'},st,{asCallee:true});t.equal(st.status,'ready',st.lastCompileError||name+' compiles');return st;};
 const bump=prepare('bump','(I)I'),fields=j.classes.NativeStaticProof.staticFields;
 t.equal(bump.meta.nativeStaticReadSites,1,'actual native reader emitted');t.equal(bump.meta.nativeStaticWriteSites,1,'actual native writer emitted');
 t.equal(bump.meta.canonicalRun(3)[0],-4,'native field preparation does not initialize its owner');
 fields.set('value:I',7);fields.set('ordered:I',11);j.classInitializationState.set('NativeStaticProof','INITIALIZED');
 t.equal(bump.meta.canonicalRun(5)[3],12,'native read/write/read has exact value');t.equal(fields.get('value:I'),12,'Map sees native write');
 t.equal(bump.meta.importStats.get('gs_NativeStaticProof_value'),0,'native read never enters JS getter');t.equal(bump.meta.importStats.get('ps_NativeStaticProof_value'),0,'native write never enters JS setter');
 fields.cell('value:I').value=17;t.equal(bump.meta.canonicalRun(2)[3],19,'generated JS write is visible');
 const ordered=prepare('readOrdered','()I');t.equal(ordered.meta.nativeStaticReadSites,0,'volatile access keeps original path');t.equal(ordered.meta.canonicalRun()[3],11,'volatile value is exact');t.equal(ordered.meta.importStats.get('gs_NativeStaticProof_ordered'),1,'volatile read uses existing import');
 let backing=23,reads=0,writes=0;const cell=fields.cell('value:I');
 Object.defineProperty(cell,'value',{configurable:true,get(){reads++;return backing;},set(value){writes++;backing=value;}});
 t.equal(bump.meta.canonicalRun(3)[3],26,'accessor fallback retains result');t.equal(reads,1,'custom getter executes once');t.equal(writes,1,'custom setter executes once');t.equal(backing,26,'custom setter receives right value');
 Object.defineProperty(cell,'value',{configurable:true,writable:true,value:31});const beforeGet=bump.meta.importStats.get('gs_NativeStaticProof_value'),beforeSet=bump.meta.importStats.get('ps_NativeStaticProof_value');
 t.equal(bump.meta.canonicalRun(6)[3],37,'data descriptor restores native path');t.equal(bump.meta.importStats.get('gs_NativeStaticProof_value'),beforeGet,'restored reader bypasses JS');t.equal(bump.meta.importStats.get('ps_NativeStaticProof_value'),beforeSet,'restored writer bypasses JS');
 const root=prepare('root','([II)I'),array=j.wasmHeap.alloc('[I',3);array.type='[I';array.set([2,3,5]);
 t.equal(root.meta.canonicalRun(array,3)[3],47,'looped native writes remain coherent');t.equal(fields.get('value:I'),47,'host observes final loop value');
 fields.delete('value:I');t.equal(bump.meta.canonicalRun(7)[3],7,'deleted key read and restoring write preserve semantics');t.ok(fields.has('value:I'),'fallback restores membership');
 Object.defineProperty(cell,'value',{writable:false});const failed=bump.meta.canonicalRun(3);t.equal(failed[0],-5,'readonly setter keeps exact native exit protocol');t.ok(failed[2].box.lastThrown instanceof TypeError,'readonly failure is retained');t.equal(cell.value,7,'failed write has no effect');
 const ordinary=new JVM({classpath,wasmHeap:false,jit:{enabled:false,compileWorker:false,wasmStructured:true,
  wasm:{deepInline:false,canonicalDirectCalls:true,canonicalEhLinks:true,canonicalLeafCalls:true,nativeJsExceptionTags:true}}});
 await ordinary.preloadClasspathClasses();ordinary.classInitializationState.set('NativeStaticProof','INITIALIZED');
 ordinary.classes.NativeStaticProof.staticFields.set('value:I',2);
 const plainWasm=ordinary.jit.wasmJit;plainWasm.importStatsEnabled=true;
 const plainMethod=ordinary.findMethod(ordinary.classes.NativeStaticProof,'bump','(I)I'),plain=plainWasm.methodState({method:plainMethod});
 plainWasm.compile({method:plainMethod,className:'NativeStaticProof'},plain,{asCallee:true});
 t.equal(plain.status,'ready',plain.lastCompileError||'no-heap caller compiles');
 t.equal(plain.meta.nativeStaticReadSites,0,'no-heap mode keeps ordinary reads');t.equal(plain.meta.nativeStaticWriteSites,0,'no-heap mode keeps ordinary writes');
 t.equal(plain.meta.canonicalRun(5)[3],7,'no-heap result remains correct');
 t.equal(plain.meta.importStats.get('gs_NativeStaticProof_value'),1,'ordinary read uses original import');t.equal(plain.meta.importStats.get('ps_NativeStaticProof_value'),1,'ordinary write uses original import');
 t.end();
});
