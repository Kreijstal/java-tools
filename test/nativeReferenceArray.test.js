'use strict';
// Tests a JS or partial-Wasm tier: the closed-world module would take its methods.
process.env.JVM_CLOSED_WORLD = '0';
const test=require('tape');
const {JVM}=require('../src/core/jvm');
const {makeNativeReferenceArray,nativeReferenceArrayStorageOf}=require('../src/core/nativeReferenceArray');
const {getNativeObjectStorageOps}=require('../src/core/nativeObjectStorage');
const ops=getNativeObjectStorageOps();
const fresh=(j,n)=>{const a=new Array(n).fill(null);a.type='[Ljava/lang/Object;';a.elementType='java/lang/Object';return makeNativeReferenceArray(j,a);};

test('native reference array mirror retains exact values and revokes custom properties',t=>{
 if(!ops){t.pass('engine keeps ordinary arrays');t.end();return;}
 const j=new JVM({wasmHeap:true,wasmFields:true,jit:{compileWorker:false}}),a=fresh(j,3);
 const s=nativeReferenceArrayStorageOf(a,j.wasmHeap.memory),base=-ops.base(s)-2,first={},second={};
 t.ok(Array.isArray(a),'public representation remains an array');t.deepEqual([...a],[null,null,null],'default values are unchanged');
 a[1]=first;t.equal(ops.reference(s,1),first,'native mirror sees original object');a[1]=second;
 t.equal(a[1],second,'host sees replacement');t.equal(ops.reference(s,1),second,'native mirror sees replacement');
 t.equal(j.wasmHeap.i32[base>>2],1,'ordinary array keeps native capability');
 t.equal(nativeReferenceArrayStorageOf(a,new WebAssembly.Memory({initial:1})),null,'foreign memory cannot own reference array metadata');
 let calls=0;Object.defineProperty(a,1,{configurable:true,get(){calls++;return first;}});
 t.equal(calls,0,'descriptor customization executes no getter early');t.equal(j.wasmHeap.i32[base>>2],0,'descriptor customization revokes native reads');
 t.equal(ops.reference(s,1),null,'revoked mirror releases retired references');t.equal(a[1],first,'custom getter retains exact return value');t.equal(calls,1,'custom getter executes once');
 const b=fresh(j,2),bs=nativeReferenceArrayStorageOf(b,j.wasmHeap.memory);b[0]=first;delete b[0];
 t.equal(0 in b,false,'host deletion retains holes');t.equal(j.wasmHeap.i32[(-ops.base(bs)-2)>>2],0,'deletion revokes native reads');
 const c=fresh(j,2),cs=nativeReferenceArrayStorageOf(c,j.wasmHeap.memory);c.length=0;
 t.equal(c.length,0,'host length mutation retains behavior');t.equal(j.wasmHeap.i32[(-ops.base(cs)-2)>>2],0,'length mutation revokes native reads');
 const legacy=fresh(new JVM({jit:{compileWorker:false}}),2);t.equal(nativeReferenceArrayStorageOf(legacy,j.wasmHeap.memory),null,'heap-disabled arrays keep legacy behavior');
 t.end();
});

test('native reference arrays collect cyclic graphs and release capability extents',async t=>{
 if(!ops||!global.gc){t.pass('needs native GC and forced collection');t.end();return;}
 const j=new JVM({wasmHeap:true,wasmFields:true,jit:{compileWorker:false}});
 const make=()=>{const a=fresh(j,1);a[0]=a;const s=nativeReferenceArrayStorageOf(a,j.wasmHeap.memory);return {a:new WeakRef(a),s:new WeakRef(s),base:-ops.base(s)-2};};
 const weak=make();for(let i=0;i<12;i++){await new Promise(setImmediate);global.gc();}
 // A final GC may collect the graph on this turn; let its queued finalizer run.
 await new Promise(setImmediate);
 t.equal(weak.a.deref(),undefined,'self-referencing wrapper is collectible');t.equal(weak.s.deref(),undefined,'native self-cycle is collectible');
 t.equal(j.wasmHeap.objectAllocations.has(weak.base),false,'dead reference array releases its capability extent');t.end();
});

test('compiled reference-array reads use captured native storage with checked fallbacks',async t=>{
 if(!ops || !require('../src/jit/wasmShared').supportsWasmJsTag()){t.pass('engine keeps checked array imports');t.end();return;}
 const compile=require('./javaFixture').makeJavaFixtureCompiler('native-reference-array-');
 const classpath=compile(t,'ReferenceArrayKernels',`
class ReferenceArrayHolder {
 int[][] rows; int[] direct; Object[] objects;
 int[] row(int i){return rows[i];}
 int[] opaque(){return (int[])objects[0];}
 int[] relay(int i){return row(i);}
 int[] recursive(int i,int depth){return depth==0?row(i):recursive(i,depth-1);}
}
class DerivedArrayHolder extends ReferenceArrayHolder { Object[] other; }
public class ReferenceArrayKernels {
 static void copyField(ReferenceArrayHolder h,int[] target){System.arraycopy(h.direct,0,target,0,1);}
 static void copyElement(ReferenceArrayHolder h,int[] target){System.arraycopy(h.rows[0],0,target,0,1);}
 static void copyReturned(ReferenceArrayHolder h,int[] target){System.arraycopy(h.row(0),0,target,0,1);}
 static int ignore(ReferenceArrayHolder h){h.opaque();return 5;}
 static int via(ReferenceArrayHolder h,int i,int column){return h.row(i)[column];}
 static int relay(ReferenceArrayHolder h,int i,int column){return h.relay(i)[column];}
 static int recursive(ReferenceArrayHolder h,int depth){return h.recursive(1,depth)[1];}
 static int capturedRow(ReferenceArrayHolder h,int[] replacement){int[] old=h.rows[0];h.rows[0]=replacement;return old[0]+h.rows[0][0];}
 static int alternate(ReferenceArrayHolder h,int[][] a,int[][] b){int sum=0;for(int i=0;i<4;i++){h.rows=(i&1)==0?a:b;sum+=h.rows[0][0];}return sum;}
 static int get(ReferenceArrayHolder h,int i,int column){return h.rows[i][column];}
 static int sumRows(ReferenceArrayHolder h){int sum=0;for(int i=0;i<4;i++)sum+=h.rows[0][0];return sum;}
 static Object item(Object[] values,int i){return values[i];}
 static void put(Object[] values,int i,Object value){values[i]=value;}
 static void replace(ReferenceArrayHolder h,int[][] rows){h.rows=rows;}
 static int captured(ReferenceArrayHolder h,int[][] rows){int[][] old=h.rows;replace(h,rows);return old[0][0]+h.rows[0][0];}
}`);
 const j=new JVM({classpath,wasmHeap:true,wasmFields:true,jit:{compileWorker:false,wasmStructured:true,retainCompilerDiagnostics:false,
  wasm:{heapBulkCopy:true,checkcast:true,deepInline:false,maxInlineCalleeItems:1,inlineBudget:1,canonicalDirectCalls:true,canonicalEhLinks:true,nativeJsExceptionTags:true}}});
 await j.preloadClasspathClasses();for(const owner of ['ReferenceArrayKernels','ReferenceArrayHolder','DerivedArrayHolder'])j._markClassInitialized(owner);
 j._markClassInitialized('java/lang/System');
 const w=j.jit.wasmJit;w.importStatsEnabled=true;
 const prepare=(name,desc,owner='ReferenceArrayKernels')=>{const method=j.findMethod(j.classes[owner],name,desc),state=w.methodState({method});
  w.compile({method,className:owner},state,{asCallee:true});t.equal(state.status,'ready',state.lastCompileError||name+' compiles');return state;};
 prepare('row','(I)[I','ReferenceArrayHolder');prepare('opaque','()[I','ReferenceArrayHolder');prepare('relay','(I)[I','ReferenceArrayHolder');prepare('recursive','(II)[I','ReferenceArrayHolder');
 const copies=['copyField','copyElement','copyReturned'].map(name=>prepare(name,'(LReferenceArrayHolder;[I)V'));
 const ignore=prepare('ignore','(LReferenceArrayHolder;)I');
 const via=prepare('via','(LReferenceArrayHolder;II)I'),relay=prepare('relay','(LReferenceArrayHolder;II)I'),recursive=prepare('recursive','(LReferenceArrayHolder;I)I');
 const capturedRow=prepare('capturedRow','(LReferenceArrayHolder;[I)I');
 const alternate=prepare('alternate','(LReferenceArrayHolder;[[I[[I)I');
 const get=prepare('get','(LReferenceArrayHolder;II)I'),item=prepare('item','([Ljava/lang/Object;I)Ljava/lang/Object;'),put=prepare('put','([Ljava/lang/Object;ILjava/lang/Object;)V');
 const sumRows=prepare('sumRows','(LReferenceArrayHolder;)I');
 prepare('replace','(LReferenceArrayHolder;[[I)V');const captured=prepare('captured','(LReferenceArrayHolder;[[I)I');
 const {allocMultiArray,allocReferenceArray}=require('../src/instructions/object');
 const {newFields,makeObjectRef,writeField}=require('../src/core/objectModel');
 const rows=allocMultiArray(j,'[[I',[2,2]),next=allocMultiArray(j,'[[I',[2,2]);rows[0][0]=1;rows[1][1]=7;next[0][0]=10;
 const holder=makeObjectRef(j,'DerivedArrayHolder',newFields(j,'DerivedArrayHolder'));writeField(holder.fields,'ReferenceArrayHolder.rows',rows);
 writeField(holder.fields,'ReferenceArrayHolder.direct',rows[0]);
 const run=(state,args)=>{const Frame=require('../src/core/frame'),Stack=require('../src/core/stack'),f=new Frame(state.method);f.className='ReferenceArrayKernels';
  args.forEach((arg,index)=>f.locals[index]=arg);const thread={id:0,status:'runnable',callStack:new Stack()};thread.callStack.push(f);return w.execute(f,thread,state,0).value;};
 w.freezeCompilation();j.jit._syncCompileEnvironment={trace:false,assert:true};j.jit.markMainStarted();
 t.equal(run(get,[holder,1,1]),7,'native reference row plus primitive element returns exact value');
 for(const state of copies){
  const target=j.wasmHeap.alloc('[I',1);run(state,[holder,target]);
  t.equal(target[0],1,'header-fed bulk copy preserves data through '+state.method.name);
  t.equal(state.meta.importStats.get('arraycopy_heap_kind'),2,'both source and target representation are checked');
  t.equal(state.meta.importStats.get('sys_arraycopy')||0,0,'validated matching representations copy inside Wasm');
 }
 for(const state of [via,relay]){
  t.equal(run(state,[holder,1,1]),7,'native returned array keeps exact data through '+state.method.name);
  t.equal(state.meta.importStats.get('abase')||0,0,'returned array base needs no host lookup');
  t.equal(state.meta.importStats.get('alen0')||0,0,'returned array length needs no host lookup');
 }
 t.equal(run(recursive,[holder,12]),7,'recursive array returns preserve invocation-local metadata');
 t.ok([...w.nativeArrayResults.values()].every(r=>r.base.value===-2 && r.length.value===0 && r.owned.value===0),'native consumers clear every returned payload');
 const rowState=w.state.get(j.findMethod(j.classes.ReferenceArrayHolder,'row','(I)[I'));
 w.canonicalDirectLinks.withdraw(rowState.key);
 t.equal(run(via,[holder,1,1]),7,'withdrawn target retains existing JavaScript bridge');
 t.equal(via.meta.importStats.get('abase'),1,'bridge result retains checked metadata query');
 t.equal(w.nativeArrayResults.get(rowState.key).base.value,-2,'bridge clears any metadata its nested native call produced');
 w.canonicalDirectLinks.publish(rowState);
 let lengths=0;const opaque={type:'[I',get length(){lengths++;return 1;}},opaqueValues=allocReferenceArray(j,'java/lang/Object',1);opaqueValues[0]=opaque;
 writeField(holder.fields,'ReferenceArrayHolder.objects',opaqueValues);
 t.equal(run(ignore,[holder]),5,'unused opaque return remains legal');t.equal(lengths,0,'return transport never queries an unused host length getter');
 t.ok(get.meta.nativeReferenceArraySites>0,'module emits native reference-array reads');
 t.equal(get.meta.importStats.get('object_storage'),1,'parent storage lookup also supplies reference-array metadata');
 t.equal(get.meta.importStats.get('aget_r')||0,0,'native row read invokes no host element getter');
 t.equal(get.meta.importStats.get('abase')||0,0,'native element header supplies primitive row base');
 t.equal(get.meta.importStats.get('alen0')||0,0,'native element header supplies primitive row length');
 let fieldReads=0;const hostHolder={type:'ReferenceArrayHolder',fields:{get 'ReferenceArrayHolder.rows'(){fieldReads++;return rows;}}};
 t.equal(run(sumRows,[hostHolder]),4,'checked field-cache hits preserve native storage discovered by array reads');
 t.equal(fieldReads,1,'field-cache hits do not repeat the checked host getter');
 const oldRow=rows[0];t.equal(run(capturedRow,[holder,next[0]]),11,'captured element headers survive replacement of the same row');rows[0]=oldRow;
 t.equal(run(captured,[holder,next]),11,'captured old array survives aliasing replacement');
 t.equal(run(alternate,[holder,rows,next]),22,'in-loop field replacement refreshes native array metadata');
 rows[0]=next[0];writeField(holder.fields,'ReferenceArrayHolder.rows',rows);t.equal(run(get,[holder,0,0]),10,'host element write updates native mirror');
 const expect=(state,args,type)=>{let error;try{run(state,args);}catch(e){error=e;}t.equal(error?.type,type,'exact guest '+type);};
 expect(get,[holder,-1,0],'java/lang/ArrayIndexOutOfBoundsException');expect(get,[holder,2,0],'java/lang/ArrayIndexOutOfBoundsException');
 writeField(holder.fields,'ReferenceArrayHolder.rows',null);expect(get,[holder,0,0],'java/lang/NullPointerException');
 writeField(holder.fields,'ReferenceArrayHolder.rows',rows);let getters=0;
 Object.defineProperty(rows,0,{configurable:true,get(){getters++;return next[0];}});
 t.equal(getters,0,'array customization executes no getter at publication');t.equal(run(get,[holder,0,0]),10,'revoked native read uses host getter');t.equal(getters,1,'custom getter executes once at the read');
 const objects=allocReferenceArray(j,'java/lang/Object',2),marker=makeObjectRef(j,'ReferenceArrayHolder',newFields(j,'ReferenceArrayHolder'));
 run(put,[objects,1,marker]);t.equal(run(item,[objects,1]),marker,'guest reference stores update native reads with exact identity');
 const strings=allocReferenceArray(j,'java/lang/String',1);expect(put,[strings,1,marker],'java/lang/ArrayIndexOutOfBoundsException');t.equal(strings[0],null,'rejected store changes no element');
 const foreign=new JVM({wasmHeap:true,wasmFields:true,jit:{compileWorker:false}}),foreignArray=allocReferenceArray(foreign,'java/lang/Object',1);foreignArray[0]=marker;
 t.equal(run(item,[foreignArray,0]),marker,'foreign memory follows checked array import');
 t.equal(run(item,[[marker],0]),marker,'ordinary host arrays retain checked reads');
 t.equal(j.jit.syncCompileCensus().postMainSyncCompileCount,0,'all array paths execute without compilation');
 t.end();
});


test('canonical JavaScript fallback cannot publish nested array metadata as its result',t=>{
 if(!require('../src/jit/wasmShared').supportsWasmTryTable()){t.pass('engine keeps old call bridge');t.end();return;}
 const {CanonicalDirectLinks}=require('../src/jit/CanonicalDirectFrames'),{T}=require('../src/jit/wasmShared');
 const links=new CanonicalDirectLinks(),a=new Int32Array([3]),b=new Int32Array([7]);
 const payload={base:new WebAssembly.Global({value:'i32',mutable:true},-2),length:new WebAssembly.Global({value:'i32',mutable:true},0),owned:new WebAssembly.Global({value:'i32',mutable:true},0)};
 const fallback=()=>{payload.base.value=4096;payload.length.value=1;payload.owned.value=1;return b;};
 const slot=links.allocate(Symbol('array fallback'),[T.ref],[T.ref],fallback,[],true,[],payload);
 const result=links.table.get(slot)(a);
 t.equal(result[0],-6,'fallback retains old deopt status');t.equal(result[1],b,'fallback returns its final exact Java reference');
 t.equal(payload.base.value,-2,'nested base cannot escape as final metadata');t.equal(payload.length.value,0,'nested length is cleared');t.equal(payload.owned.value,0,'nested ownership certificate is cleared');
 const legacy={base:new WebAssembly.Global({value:'i32',mutable:true},-2),length:new WebAssembly.Global({value:'i32',mutable:true},0)};
 const oldSlot=links.allocate(Symbol('legacy array fallback'),[T.ref],[T.ref],()=>{legacy.base.value=8192;legacy.length.value=2;return a;},[],true,[],legacy);
 const oldResult=links.table.get(oldSlot)(b);
 t.equal(oldResult[0],-6,'legacy two-word return transport retains its status');t.equal(oldResult[1],a,'legacy bridge preserves its actual reference');
 t.equal(legacy.base.value,-2,'legacy base is still cleared');t.equal(legacy.length.value,0,'legacy length is still cleared');
 links.release([slot,oldSlot]);t.end();
});
